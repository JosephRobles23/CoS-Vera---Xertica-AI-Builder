/**
 * miseguimiento-runtime.js — Modal "Mi seguimiento" (R1): la gestión personal del líder sobre su
 * hoja Tareas, con UI (tabs Hoy / Tareas / Tablero + creación híbrida) en DialogMiSeguimiento.html.
 *
 * Principios (grill ago 2026, ver Docs/workflows/MI-SEGUIMIENTO.md):
 *  - La HOJA Tareas sigue siendo la única fuente de verdad: el modal lee y escribe encima
 *    (mutadores por Id); si una fila desapareció, error claro y recarga — jamás recrear.
 *  - Todo `cargarMiSeguimiento` es DETERMINISTA (0 LLM), como el Seguimiento del equipo.
 *  - Nivel 0: prioridad/Bloqueada (hoja) + edad/posp/historial (wiki/tasks) — solo lectura.
 *  - Cada mutación espeja el wiki DE INMEDIATO (best-effort): el historial es la fuente del
 *    futuro tab Tendencia (R2); si Drive falla, la hoja quedó bien y el sync diario repara.
 *  - El foco manual vive en Ajustes (briefing.focoManual) y manda sobre el foco del LLM.
 *  - R2 (Tendencia + _tasks.json) y R3 (Espera de / Link / eventId) NO viven aquí todavía.
 *
 * Público (via dispatch): cargarMiSeguimiento, crearTarea, actualizarTarea, archivarTarea,
 * guardarFoco. Sin import/export: runtime de Apps Script. Privados con sufijo "_".
 */

var MISEG_HIST_MAX_ = 10;   // líneas de historial que viajan al modal por tarea

// --- API pública ---

/**
 * Datos completos del modal. @return {{hoy, brainEnabled, foco, agenda, proyectos, tareas}}
 */
function cargarMiSeguimiento(sheetId, config) {
  // Cache (TTL 55s, bajo el poll de 60s): los mutadores del modal y agregarTarea_/archivado
  // invalidan, así el líder siempre ve su propia escritura al instante.
  var hit = cacheGetJson_(sheetId, 'miseg');
  if (hit) return hit;

  var now = new Date();
  var hoy = Utilities.formatDate(now, config.timezone, 'yyyy-MM-dd');
  var brainOn = !!(config.brain && config.brain.enabled);

  var tareas = listarTareas_(sheetId, config).map(function (t) {
    t.hoy = !!t.vence && t.vence === hoy;
    t.atrasada = !!t.vence && t.vence < hoy && t.estado !== 'Hecha';
    t.bloqueada = t.estado === 'Bloqueada';
    // Edad honesta: 'Creada el' (o el sufijo del Origen) manda; el wiki es el fallback.
    var creadaReal = t.creada || fechaDeOrigen_(t.origen);
    t.edad = creadaReal ? Math.max(0, Math.round((isoAUTC_(hoy) - isoAUTC_(creadaReal)) / 86400000)) : null;
    t.posp = 0; t.hist = []; t.esperaDias = null;
    return t;
  });

  // Nivel 0 desde el espejo wiki/tasks: edad (created), historial y "pospuesta ×N".
  var root = null;
  if (brainOn) {
    try { root = ensureBrainFolder_(sheetId, config); } catch (e) { root = null; }
  }
  if (root) {
    var carpeta = carpetaBrain_(root, ['wiki', 'tasks']);
    tareas.forEach(function (t) { enriquecerDesdeWiki_(carpeta, t, hoy); });
  }

  var roster = [];
  try {
    roster = getRoster_(sheetId, config.sheets.roster).map(function (p) {
      return { nombre: p.nombre || p.correo, correo: p.correo };
    });
  } catch (e) { roster = []; }

  var out = {
    hoy: hoy,
    brainEnabled: brainOn,
    foco: str_(config.briefing && config.briefing.focoManual),
    agenda: reunionesDeHoy_(config, now),
    // Catálogo canónico para los chips de creación (misma fuente que el enum de ingesta);
    // null = sin brain → la UI degrada a campo de texto libre.
    proyectos: root ? nombresProyectosCanonicos_(root) : null,
    roster: roster,   // R3: dropdown "Espera de" + correo del follow-up
    tareas: tareas
  };
  cachePutJson_(sheetId, 'miseg', out);
  return out;
}

/**
 * Crea una tarea manual (panel ➕ Nueva o captura rápida del Tablero). @return {{ok, id}}
 */
function crearTarea(sheetId, config, data) {
  data = data || {};
  var texto = str_(data.texto);
  if (!texto) throw new Error('Escribe qué hay que hacer.');
  if (data.prioridad && PRIORIDADES_TAREA_.indexOf(data.prioridad) === -1) {
    throw new Error('Prioridad inválida: "' + data.prioridad + '".');
  }
  if (data.vence && !/^\d{4}-\d{2}-\d{2}$/.test(String(data.vence))) {
    throw new Error('Fecha inválida: "' + data.vence + '" (usa YYYY-MM-DD o vacío).');
  }

  var agregada = agregarTarea_(sheetId, config, {
    texto: texto, proyecto: str_(data.proyecto), vence: str_(data.vence),
    prioridad: data.prioridad || 'Media', origen: '✍️ Manual',
    espera: str_(data.espera), link: str_(data.link)
  });
  if (!agregada) throw new Error('Ya existe una tarea igual (mismo texto y origen).');

  var id = idTarea_(texto, '✍️ Manual');
  espejarTareaInmediato_(sheetId, config, id);
  return { ok: true, id: id };
}

/**
 * Actualiza estado/vence/prioridad/proyecto/texto de una tarea por Id (completar, posponer,
 * mover de columna, edición inline). @return la tarea actualizada.
 */
function actualizarTarea(sheetId, config, id, campos) {
  var t = actualizarTarea_(sheetId, config, id, campos);
  espejarTareaInmediato_(sheetId, config, t.id);
  cacheInvalidar_(sheetId, CACHE_MISEGUIMIENTO_);
  return t;
}

/** Archiva UNA tarea ("esto ya no aplica"), cualquiera sea su estado. @return {{ok:boolean}} */
function archivarTarea(sheetId, config, id) {
  archivarTarea_(sheetId, config, id, hoyISO_(config));
  cacheInvalidar_(sheetId, CACHE_MISEGUIMIENTO_);
  return { ok: true };
}

/** Persiste el foco manual del líder (vacío = vuelve el foco sugerido por el LLM). */
function guardarFoco(sheetId, config, texto) {
  setAjustes_(sheetId, config.sheets.settings, { 'briefing.focoManual': str_(texto) });
  cacheInvalidar_(sheetId, CACHE_MISEGUIMIENTO_);
  return { ok: true };
}

// --- Nivel 0: lectura del espejo wiki/tasks ---

/** Completa edad/posp/hist de una tarea desde su página wiki (best-effort, por tarea). */
function enriquecerDesdeWiki_(carpeta, t, hoy) {
  var raw = null;
  try { raw = leerArchivoBrain_(carpeta, t.id + '.md'); } catch (e) { raw = null; }
  if (!raw) return;

  var page = parsearPagina_(raw);
  var created = str_((page.frontmatter || {}).created);
  if (t.edad == null && /^\d{4}-\d{2}-\d{2}$/.test(created)) {   // fallback: sin 'Creada el'/Origen
    t.edad = Math.max(0, Math.round((isoAUTC_(hoy) - isoAUTC_(created)) / 86400000));
  }
  var lineas = [];
  parseBodySections_(page.body).sections.forEach(function (s) {
    if (s.name !== 'Historial') return;
    s.lines.forEach(function (l) { if (l.trim()) lineas.push(l.trim().replace(/^-\s*/, '')); });
  });
  t.hist = lineas.slice(-MISEG_HIST_MAX_);
  // "Pospuesta ×N" = re-fechas del historial (líneas de cambio 'vence: a → b', no la de creación).
  t.posp = lineas.filter(function (l) { return /\]\s*vence:/.test(l); }).length;
  // R3 · "⏳ espera de X · Nd": los días salen de la ÚLTIMA línea 'espera de:' del historial.
  // Columna editada a mano sin línea (o wiki apagado) → pill sin días (degradación honesta).
  if (t.espera) {
    for (var i = lineas.length - 1; i >= 0; i--) {
      var m = /^\[(\d{4}-\d{2}-\d{2})\]\s*espera de:/.exec(lineas[i]);
      if (m) { t.esperaDias = Math.max(0, Math.round((isoAUTC_(hoy) - isoAUTC_(m[1])) / 86400000)); break; }
    }
  }
}

/** Nombres canónicos del catálogo de proyectos (para los chips del panel de creación). */
function nombresProyectosCanonicos_(root) {
  var mapa = cargarProyectos_(root);
  return Object.keys(mapa).map(function (s) { return mapa[s].name; }).filter(Boolean).sort();
}

// --- Espejo inmediato (fidelidad del historial para Tendencia/R2) ---

/** Upsert de la página wiki de UNA tarea tras una mutación. Best-effort: jamás rompe la acción. */
function espejarTareaInmediato_(sheetId, config, id) {
  if (!(config.brain && config.brain.enabled)) return;
  try {
    var root = ensureBrainFolder_(sheetId, config);
    var carpeta = carpetaBrain_(root, ['wiki', 'tasks']);
    var tareas = listarTareas_(sheetId, config);
    for (var i = 0; i < tareas.length; i++) {
      if (tareas[i].id === String(id)) {
        upsertTareaWiki_(carpeta, tareas[i], hoyISO_(config));
        indexarTareas_(root, [tareas[i]], hoyISO_(config));   // Tendencia al minuto (R2)
        return;
      }
    }
  } catch (e) {
    if (typeof Logger !== 'undefined') Logger.log('miseguimiento: espejo inmediato falló (%s).', e);
  }
}

// --- Tendencia (R2): el índice viaja entero; los filtros recalculan en el cliente ---

/**
 * Índice crudo para el tab Tendencia. Con _tasks.json ausente/roto lo reconstruye desde las
 * páginas (una sola vez, N lecturas). @return {{hoy, brainEnabled, indice:Array}}
 */
function cargarTendencia(sheetId, config) {
  var hoy = hoyISO_(config);
  if (!(config.brain && config.brain.enabled)) return { hoy: hoy, brainEnabled: false, indice: [] };

  var root;
  try { root = ensureBrainFolder_(sheetId, config); } catch (e) {
    return { hoy: hoy, brainEnabled: false, indice: [] };
  }
  var mapa = cargarIndiceTareas_(root);
  if (!mapa) mapa = reconstruirIndiceTareas_(root);

  var indice = Object.keys(mapa).map(function (id) {
    var e = mapa[id];
    return { id: id, proyecto: e.proyecto || '', prioridad: e.prioridad || 'Media',
      origen: e.origen || '', estado: e.estado || '', vence: e.vence || '',
      created: e.created || '', hecha: e.hecha || '', archivada: e.archivada || '',
      posp: e.posp || 0 };
  });
  return { hoy: hoy, brainEnabled: true, indice: indice };
}
