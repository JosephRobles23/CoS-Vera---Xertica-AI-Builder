/**
 * dispatcher-runtime.js — Orquestador por hora (invitaciones + consolidados) y guardas.
 *
 * El stub instala un trigger cada 5 min que solo llama a `CoSLib.runDispatcher(SHEET_ID, CONFIG)`.
 * Toda la lógica (timing, iteración del roster, guardas anti-duplicado) vive aquí, en la
 * librería, para que el stub siga delgado.
 *
 * Guardas anti-duplicado: Script Properties de la LIBRERÍA, namespaced por sheetId del líder:
 *   sent:<sheetId>:<tipo>:<id>:<fecha>
 * Así no hay colisión entre líderes. Ver Docs/testing-and-deploy.md y el playbook.
 *
 * Sin import/export: runtime de Apps Script. Privados con sufijo "_".
 */

/**
 * Punto de entrada del dispatcher. Público (lo llama el stub cada 5 min).
 * @param {string} sheetId      Spreadsheet del líder.
 * @param {Object} config       CONFIG (sheets, forms, leader, schedule, models, timezone,
 *                              dispatchWindowMin, options).
 * @param {Date}   [nowOverride] reloj inyectable para tests; en producción se omite.
 */
function runDispatcher(sheetId, config, nowOverride) {
  var inicioMs = Date.now();   // presupuesto de la pasada (el backfill corre con lo que sobre)
  var tz    = config.timezone;
  var now   = nowOverride || new Date();
  var dow   = parseInt(Utilities.formatDate(now, tz, 'u'), 10);  // 1=lun … 7=dom
  var hhmm  = Utilities.formatDate(now, tz, 'HH:mm');
  var today = Utilities.formatDate(now, tz, 'yyyy-MM-dd');
  var win   = config.dispatchWindowMin || 5;

  var isWeekday = dow >= 1 && dow <= 5;
  var isFriday  = dow === 5;
  var weeklyOnlyFriday = !(config.options && config.options.weeklyOnlyFriday === false);

  // --- 1) Invitaciones (por persona, con guarda anti-dup) ---
  var leaderName = (config.leader && config.leader.name) || 'tu líder';
  var forms = config.forms || {};
  getRoster_(sheetId, config.sheets.roster).forEach(function (p) {
    // Daily: L–V
    if (isWeekday && forms.dailyUrl &&
        horaCoincide_(config.schedule.invitesDaily, hhmm, win) &&
        !yaEnviado_(sheetId, 'daily', p.correo, today)) {
      enviarInvitacion_('daily', p, leaderName, forms.dailyUrl, sheetId, config);
      marcarEnviado_(sheetId, 'daily', p.correo, today);
    }
    // Weekly: viernes (o L–V si weeklyOnlyFriday=false)
    var weeklyOK = weeklyOnlyFriday ? isFriday : isWeekday;
    if (weeklyOK && forms.weeklyUrl &&
        horaCoincide_(config.schedule.invitesWeekly, hhmm, win) &&
        !yaEnviado_(sheetId, 'weekly', p.correo, today)) {
      enviarInvitacion_('weekly', p, leaderName, forms.weeklyUrl, sheetId, config);
      marcarEnviado_(sheetId, 'weekly', p.correo, today);
    }
  });

  // --- 2) Consolidados con horas de cierre SEPARADAS (Daily L–V, Weekly viernes) ---
  var leaderKey = (config.leader && config.leader.email) || 'lider';

  if (isWeekday && horaCoincide_(config.schedule.closeDaily, hhmm, win) &&
      !yaEnviado_(sheetId, 'cons-daily', leaderKey, today)) {
    enviarConsolidado(sheetId, config, 'daily', today);
    marcarEnviado_(sheetId, 'cons-daily', leaderKey, today);
  }
  if (isFriday && horaCoincide_(config.schedule.closeWeekly, hhmm, win) &&
      !yaEnviado_(sheetId, 'cons-weekly', leaderKey, today)) {
    enviarConsolidado(sheetId, config, 'weekly', today);
    marcarEnviado_(sheetId, 'cons-weekly', leaderKey, today);
  }

  // --- 2b) Reportes compartidos por persona (a la misma hora de cierre; anti-dup interno) ---
  // Best-effort: compartir no puede frenar el consolidado del líder.
  if (isWeekday && horaCoincide_(config.schedule.closeDaily, hhmm, win)) {
    try { enviarCompartidos_(sheetId, config, 'daily', today); }
    catch (e) { if (typeof Logger !== 'undefined') Logger.log('compartir: pasada daily falló (%s).', e); }
  }
  if (isFriday && horaCoincide_(config.schedule.closeWeekly, hhmm, win)) {
    try { enviarCompartidos_(sheetId, config, 'weekly', today); }
    catch (e) { if (typeof Logger !== 'undefined') Logger.log('compartir: pasada weekly falló (%s).', e); }
  }

  // --- 2c) Morning Briefing: a la hora/días del líder (hora, día y anti-dup viven adentro) ---
  if (config.briefing && config.briefing.enabled) {
    try {
      runBriefingPass_(sheetId, config, now);
    } catch (e) {
      if (typeof Logger !== 'undefined') Logger.log('briefing: pasada falló (%s).', e);
    }
  }

  // --- 3) Scan de silencios (brain): 1×/día, deja señales estructuradas para notificar() (futuro) ---
  // Suspendido mientras corre el backfill (wiki a medio construir = falsos estancados); como NO se
  // marca la guarda, el scan corre normal en la primera pasada tras terminar el job.
  if (config.brain && config.brain.enabled &&
      !backfillActivo_(sheetId, config) &&
      !yaEnviado_(sheetId, 'brain-scan', 'silencios', today)) {
    try {
      scanSilencios_(sheetId, config, now);
    } catch (e) {
      if (typeof Logger !== 'undefined') Logger.log('brain: scan de silencios falló (%s).', e);
    }
    marcarEnviado_(sheetId, 'brain-scan', 'silencios', today);
  }

  // --- 3a) Higiene diaria: tokens de follow-up vencidos + guardas sent:* viejas (>90 días).
  // Sin gate de brain: las guardas crecen con o sin él. Las claves 'v1' (anti-dup permanente,
  // p.ej. meet-doc) nunca se tocan.
  if (!yaEnviado_(sheetId, 'brain-scan', 'higiene', today)) {
    try {
      purgaHigiene_(sheetId, config, now);
    } catch (e) {
      if (typeof Logger !== 'undefined') Logger.log('higiene: purga falló (%s).', e);
    }
    marcarEnviado_(sheetId, 'brain-scan', 'higiene', today);
  }

  // --- 3a-bis) Higiene diaria de la hoja Tareas: ensure (formato idempotente) + espejo al wiki
  // (historial de cambios) + archivado de Hechas. Antes vivía dentro del envío del briefing:
  // un líder sin briefing no archivaba ni espejaba jamás. Sin gate de brain (el sync ya es no-op
  // sin brain; el archivado aplica igual).
  if (!yaEnviado_(sheetId, 'brain-scan', 'tareas-hig', today)) {
    try {
      runTareasHygiene_(sheetId, config, today);
    } catch (e) {
      if (typeof Logger !== 'undefined') Logger.log('tareas: higiene diaria falló (%s).', e);
    }
    marcarEnviado_(sheetId, 'brain-scan', 'tareas-hig', today);
  }

  // --- 3b) Purga del raw/ por retención (gobernanza): 1×/día, junto al scan ---
  if (config.brain && config.brain.enabled &&
      !yaEnviado_(sheetId, 'brain-scan', 'purga-raw', today)) {
    try {
      purgarRaw_(sheetId, config, now);
    } catch (e) {
      if (typeof Logger !== 'undefined') Logger.log('brain: purga de raw falló (%s).', e);
    }
    marcarEnviado_(sheetId, 'brain-scan', 'purga-raw', today);
  }

  // --- 4) Deep Prep (brain): briefing pre-reunión de las reuniones marcadas que ya entran en la ventana lead ---
  // La anti-dup es por eventId (dentro de runDeepPrepPass_), no 1×/día: cada reunión se prepara una vez.
  if (config.deepPrep && config.deepPrep.enabled && config.brain && config.brain.enabled) {
    try {
      runDeepPrepPass_(sheetId, config, now);
    } catch (e) {
      if (typeof Logger !== 'undefined') Logger.log('deepprep: pasada falló (%s).', e);
    }
  }

  // --- 5) Backfill del histórico (brain): SIEMPRE al final — los envíos por hora tienen prioridad
  // y el lote se time-boxea con el presupuesto que quede de la pasada. No-op si no está running.
  if (config.brain && config.brain.enabled) {
    try {
      runBackfillPass_(sheetId, config, now, inicioMs + BACKFILL_PRESUPUESTO_MS_);
    } catch (e) {
      if (typeof Logger !== 'undefined') Logger.log('backfill: pasada falló (%s).', e);
    }
  }

  // --- 6) Notas de Meet (brain): 1×/hora en régimen; cada pasada durante el import inicial.
  // Comparte el MISMO deadline absoluto que el backfill: entre ambos no exceden el presupuesto.
  if (config.meet && config.meet.enabled && config.brain && config.brain.enabled) {
    try {
      runMeetPass_(sheetId, config, now, inicioMs + BACKFILL_PRESUPUESTO_MS_);
    } catch (e) {
      if (typeof Logger !== 'undefined') Logger.log('meet: pasada falló (%s).', e);
    }
  }
}

// --- Change detection: scan determinista de entidades estancadas (Fase 2) ---
//
// Los silencios NO los detecta el LLM en la ingesta (esa solo ve el reporte presente): son la
// AUSENCIA de reportes, algo que solo se ve mirando el conjunto. Este scan recorre el frontmatter
// de las páginas wiki (last_updated, open_blockers) y marca lo que lleva > brain.silenceDays sin
// moverse, anotándolo en log.md. Deja los hallazgos listos para un futuro notificar() (aún no se
// envía nada). Dedup por episodio: cada página guarda `silence_flagged` con el last_updated con el
// que se marcó, así una entidad estancada se registra una sola vez hasta que un nuevo reporte la
// mueva (avanzando last_updated) y pueda volver a estancarse.

/**
 * Recorre wiki/people y wiki/projects y marca las entidades estancadas. Best-effort.
 * @return {Array<Object>} hallazgos [{tipo,file,name,last_updated,dias,open_blockers}]
 */
function scanSilencios_(sheetId, config, now) {
  var root = ensureBrainFolder_(sheetId, config);
  var tz   = config.timezone;
  var hoy  = Utilities.formatDate(now || new Date(), tz, 'yyyy-MM-dd');
  var umbral = (config.brain && config.brain.silenceDays) || 7;

  var hallazgos = [];
  ['people', 'projects'].forEach(function (carpetaNombre) {
    var carpeta = carpetaBrain_(root, ['wiki', carpetaNombre]);
    listarArchivosBrain_(carpeta, '.md').forEach(function (archivo) {
      var pagina = parsearPagina_(archivo.content);
      var fm = pagina.frontmatter || {};
      if (String(fm.external) === 'true') return;        // externos (Meet) no reportan: sin silencio
      var lu = str_(fm.last_updated);
      if (!lu) return;                                   // sin fecha no hay nada que comparar
      var dias = diasEntreISO_(lu, hoy);
      if (dias <= umbral) return;                        // fresca
      if (str_(fm.silence_flagged) === lu) return;       // ya marcada para este episodio

      var blockers = Array.isArray(fm.open_blockers) ? fm.open_blockers : [];
      hallazgos.push({
        tipo: carpetaNombre === 'people' ? 'person' : 'project',
        file: archivo.name,
        name: str_(fm.name) || archivo.name,
        last_updated: lu,
        dias: dias,
        open_blockers: blockers
      });

      fm.silence_flagged = lu;                           // marca el episodio (estado en frontmatter)
      escribirArchivoBrain_(carpeta, archivo.name, componerPagina_(fm, pagina.body));
    });
  });

  if (hallazgos.length) appendLogSilencios_(root, hoy, hallazgos);
  return hallazgos;
}

/** Anexa un bloque de silencios detectados a wiki/log.md (una cabecera + una línea por entidad). */
function appendLogSilencios_(root, fecha, hallazgos) {
  var wiki = carpetaBrain_(root, ['wiki']);
  var linea = '- ' + fecha + ' · scan de silencios · ' + hallazgos.length + ' estancado(s)\n';
  hallazgos.forEach(function (h) {
    linea += '  - 🔕 silencio · ' + h.name + ' · ' + h.dias + ' días sin actualizar' +
      (h.open_blockers.length ? ' · ' + h.open_blockers.length + ' blocker(s) abierto(s)' : '') + '\n';
  });
  appendArchivoBrain_(wiki, 'log.md', linea);
}

/** Días enteros entre dos fechas ISO (YYYY-MM-DD), en UTC para no depender de zona. */
function diasEntreISO_(isoA, isoB) {
  var a = isoAUTC_(isoA), b = isoAUTC_(isoB);
  if (a == null || b == null) return 0;
  return Math.floor((b - a) / 86400000);
}

function isoAUTC_(iso) {
  var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(str_(iso));
  return m ? Date.UTC(+m[1], (+m[2]) - 1, +m[3]) : null;
}

// --- Guardas anti-duplicado (Script Properties de la librería, por sheetId) ---

function claveEnvio_(sheetId, tipo, id, fecha) {
  return 'sent:' + sheetId + ':' + tipo + ':' + id + ':' + fecha;
}

function yaEnviado_(sheetId, tipo, id, fecha) {
  return PropertiesService.getScriptProperties()
    .getProperty(claveEnvio_(sheetId, tipo, id, fecha)) === '1';
}

function marcarEnviado_(sheetId, tipo, id, fecha) {
  PropertiesService.getScriptProperties()
    .setProperty(claveEnvio_(sheetId, tipo, id, fecha), '1');
}

/**
 * Borra las guardas de un líder (para re-probar el flujo por hora el mismo día).
 * Público: lo llama el stub. @return {number} claves borradas.
 */
/**
 * Borra SOLO las guardas de notas de Meet ('meet-doc' y 'meet-noaccess') de un líder, para
 * reintentar la ingesta de notas que fallaron (p.ej. tras corregir un bug). No toca las guardas
 * de correos del día. La re-ingesta de un doc ya indexado es idempotente (dedup por fuente);
 * solo cuesta la llamada a Gemini. Público (sidebar via cosRun → dispatch).
 * @return {number} claves borradas.
 */
function limpiarGuardasMeet(sheetId) {
  var props = PropertiesService.getScriptProperties();
  var all = props.getProperties();
  var prefijos = ['sent:' + sheetId + ':meet-doc:', 'sent:' + sheetId + ':meet-noaccess:'];
  var n = 0;
  Object.keys(all).forEach(function (k) {
    for (var i = 0; i < prefijos.length; i++) {
      if (k.indexOf(prefijos[i]) === 0) { props.deleteProperty(k); n++; break; }
    }
  });
  return n;
}

function limpiarGuardasEnvio(sheetId) {
  var props = PropertiesService.getScriptProperties();
  var all = props.getProperties();
  var prefijo = 'sent:' + (sheetId || '');
  var n = 0;
  Object.keys(all).forEach(function (k) {
    if (k.indexOf(prefijo) === 0) { props.deleteProperty(k); n++; }
  });
  return n;
}
