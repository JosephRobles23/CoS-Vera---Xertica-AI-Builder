/**
 * briefing-runtime.js — Morning Briefing: el resumen diario del líder por correo.
 *
 * Feature flag `briefing.enabled`. A la hora configurada (briefing.hora, en los días
 * briefing.dias), el dispatcher arma un correo con las secciones elegidas en el modal
 * (orden + on/off en briefing.secciones):
 *   dia         → reuniones de hoy (Calendar: hora, título, asistentes, ¿tiene Deep Prep?).
 *   pendientes  → hoja Tareas (única fuente): estado ≠ Hecha; atrasadas y de hoy primero.
 *   urgente     → señales del brain: tareas Bloqueadas + blockers envejecidos + silencios.
 *   foco        → 1-3 prioridades sugeridas por el LLM.
 *
 * UNA sola llamada Flash redacta el foco y la narrativa de urgente (con la instrucción personal
 * briefing.prompt); las secciones factuales (agenda/tareas) las pinta el código — el LLM no
 * inventa reuniones. Día despejado = correo corto honesto, se envía igual (hábito diario).
 * Antes de armar el correo, archiva las tareas "Hecha" a la pestaña Archivo (1×/día).
 *
 * Público (via dispatch): cargarBriefing, guardarBriefing, enviarBriefingPrueba.
 * Hook del dispatcher: runBriefingPass_. Responder al correo para ajustar el de mañana = Fase 2.
 * Sin import/export: runtime de Apps Script. Privados con sufijo "_".
 */

var BRIEFING_IDS_SECCION_ = { dia: true, pendientes: true, urgente: true, foco: true };

/** responseSchema del call único del briefing (foco + narrativa de urgente). */
var BRIEFING_SCHEMA_ = {
  type: 'object',
  properties: {
    foco:    { type: 'string' },   // 1-3 prioridades sugeridas del día, en viñetas o frases
    urgente: { type: 'string' }    // narrativa corta de lo urgente ('' si no hay nada)
  },
  required: ['foco']
};

// --- API pública (modal via cosRun → dispatch) ---

/**
 * Config + datos de HOY para la vista previa del modal (sin LLM: el foco se muestra como
 * placeholder hasta el envío real). @return {{enabled,hora,dias,secciones,prompt,preview}}
 */
function cargarBriefing(sheetId, config) {
  var aj = getAjustes_(sheetId, config.sheets.settings);
  var now = new Date();
  var today = Utilities.formatDate(now, config.timezone, 'yyyy-MM-dd');
  return {
    enabled: aj.briefing.enabled,
    hora: aj.briefing.hora,
    dias: aj.briefing.dias,
    secciones: aj.briefing.secciones,
    prompt: aj.briefing.prompt,
    preview: datosBriefing_(sheetId, config, now, today)
  };
}

/**
 * Persiste la config del modal. Valida hora (HH:mm), días (1-7, al menos uno) y secciones
 * (ids conocidos). @return {{ok:boolean}}
 */
function guardarBriefing(sheetId, config, data) {
  data = data || {};
  var hora = toHHMM_(String(data.hora == null ? '' : data.hora));
  var hm = /^(\d{2}):(\d{2})$/.exec(hora || '');
  if (!hm || parseInt(hm[1], 10) > 23 || parseInt(hm[2], 10) > 59) {
    throw new Error('Hora inválida: "' + data.hora + '" (usa HH:mm, p.ej. 07:30).');
  }

  var dias = (Array.isArray(data.dias) ? data.dias : [])
    .map(function (d) { return parseInt(d, 10); })
    .filter(function (d) { return d >= 1 && d <= 7; });
  if (!dias.length) throw new Error('Elige al menos un día de envío.');

  var secciones = (Array.isArray(data.secciones) ? data.secciones : [])
    .filter(function (s) { return s && BRIEFING_IDS_SECCION_[s.id]; })
    .map(function (s) { return { id: s.id, on: !!s.on }; });
  if (!secciones.length) throw new Error('El briefing necesita al menos una sección.');

  setAjustes_(sheetId, config.sheets.settings, {
    'briefing.enabled': data.enabled ? 'true' : 'false',
    'briefing.hora': hora,
    'briefing.dias': dias.join(','),
    'briefing.secciones': JSON.stringify(secciones),
    'briefing.prompt': String(data.prompt == null ? '' : data.prompt).trim()
  });
  return { ok: true };
}

/** Envía el briefing YA (ignora hora/días/anti-dup). Para el botón "Enviarme uno de prueba". */
function enviarBriefingPrueba(sheetId, config) {
  var now = new Date();
  var today = Utilities.formatDate(now, config.timezone, 'yyyy-MM-dd');
  return enviarBriefing_(sheetId, config, now, today);
}

// --- Pasada del dispatcher ---

/** Envía el briefing si es la hora/día configurado (anti-dup por fecha). */
function runBriefingPass_(sheetId, config, now) {
  var b = config.briefing || {};
  if (!b.enabled) return false;

  var tz = config.timezone;
  var dow = parseInt(Utilities.formatDate(now, tz, 'u'), 10);
  if ((b.dias || []).indexOf(dow) === -1) return false;

  var hhmm = Utilities.formatDate(now, tz, 'HH:mm');
  if (!horaCoincide_(b.hora, hhmm, config.dispatchWindowMin || 5)) return false;

  var today = Utilities.formatDate(now, tz, 'yyyy-MM-dd');
  var leaderKey = (config.leader && config.leader.email) || 'lider';
  if (yaEnviado_(sheetId, 'briefing', leaderKey, today)) return false;

  enviarBriefing_(sheetId, config, now, today);
  marcarEnviado_(sheetId, 'briefing', leaderKey, today);
  return true;
}

// --- Construcción y envío ---

function enviarBriefing_(sheetId, config, now, today) {
  var leader = (config.leader && config.leader.email) || '';
  if (!leader) throw new Error('Falta config.leader.email para enviar el briefing.');

  // La higiene diaria de la hoja Tareas (ensure + espejo wiki + archivado) YA NO vive aquí:
  // corre en el dispatcher (runTareasHygiene_, 1×/día) para que un líder sin briefing también
  // archive y espeje. El dispatcher pasa antes de cualquier hora de briefing razonable.

  var b = config.briefing || {};
  var datos = datosBriefing_(sheetId, config, now, today);
  var secciones = (b.secciones || []).filter(function (s) { return s.on; });
  var conFoco = secciones.some(function (s) { return s.id === 'foco'; });
  var conUrgente = secciones.some(function (s) { return s.id === 'urgente'; });

  // Foco manual (Mi seguimiento): si el líder escribió el suyo, manda — y no se le pide al LLM.
  var focoManual = str_(b.focoManual);

  // Un solo call Flash para lo narrativo (foco + urgente); lo factual lo pinta el código.
  var ia = { foco: '', urgente: '' };
  if ((conFoco && !focoManual) || (conUrgente && datos.urgentes.length)) {
    try {
      var raw = callGemini_(config.models.perRow, briefingSystem_(b.prompt),
        briefingUser_(today, datos), { responseSchema: BRIEFING_SCHEMA_ });
      ia = parseBriefing_(raw);
    } catch (e) {
      if (typeof Logger !== 'undefined') Logger.log('briefing: narrativa IA falló, va sin ella (%s).', e);
    }
  }
  if (focoManual) ia.foco = focoManual;   // un solo foco manda; el del LLM es el fallback

  var asunto = '☀️ Tu día — ' + fechaLegible_(today);
  var cuerpo = cuerpoPlanoBriefing_(secciones, datos, ia);
  MailApp.sendEmail(leader, asunto, cuerpo, {
    htmlBody: renderBriefingHtml_(today, secciones, datos, ia)
  });
  return { enviado: true, reuniones: datos.reuniones.length, tareas: datos.tareas.length, urgentes: datos.urgentes.length };
}

/** Junta las 3 fuentes factuales del briefing. */
function datosBriefing_(sheetId, config, now, today) {
  return {
    reuniones: reunionesDeHoy_(config, now),
    tareas: (function () {
      try { return tareasPendientesHoy_(sheetId, config, today); } catch (e) { return []; }
    })(),
    urgentes: urgentesDelBrain_(sheetId, config, today)
  };
}

/** Reuniones de hoy del calendario del líder (tolera Calendar vacío/no autorizado). */
function reunionesDeHoy_(config, now) {
  var tz = config.timezone;
  var ini = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0);
  var fin = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59);
  var eventos = [];
  try {
    eventos = CalendarApp.getDefaultCalendar().getEvents(ini, fin) || [];
  } catch (e) { return []; }

  var sel = (config.deepPrep && config.deepPrep.selected) || [];
  return eventos.map(function (ev) {
    var inicio = ev.getStartTime();
    return {
      id: ev.getId(),   // R3: las tareas con EventId se "ligan" a su reunión en Mi seguimiento
      hora: inicio ? Utilities.formatDate(inicio, tz, 'HH:mm') : '',
      titulo: ev.getTitle() || '(sin título)',
      asistentes: (ev.getGuestList() || []).length,
      prep: sel.indexOf(ev.getId()) > -1
    };
  }).sort(function (a, b) { return a.hora < b.hora ? -1 : 1; });
}

/**
 * Señales urgentes: tareas Bloqueadas + blockers envejecidos y silencios del wiki (si el brain
 * está activo). Devuelve strings listos para pintar.
 */
function urgentesDelBrain_(sheetId, config, today) {
  var out = [];
  try {
    tareasPendientesHoy_(sheetId, config, today).forEach(function (t) {
      if (t.bloqueada) out.push('Tu tarea "' + t.texto + '" está bloqueada.');
    });
  } catch (e) { /* sin hoja Tareas aún */ }

  if (!(config.brain && config.brain.enabled)) return out;
  var root;
  try { root = ensureBrainFolder_(sheetId, config); } catch (e) { return out; }

  var umbral = (config.brain && config.brain.silenceDays) || 7;
  ['people', 'projects'].forEach(function (tipo) {
    listarArchivosBrain_(carpetaBrain_(root, ['wiki', tipo]), '.md').forEach(function (a) {
      if (a.name.charAt(0) === '_') return;
      var fm = parsearPagina_(a.content).frontmatter || {};
      if (String(fm.external) === 'true') return;
      if (String(fm.status) === 'closed') return;   // proyecto archivado: fuera de alertas de silencio
      var nombre = str_(fm.name) || a.name;
      var dias = fm.last_updated ? diasEntreISO_(str_(fm.last_updated), today) : 0;
      var blockers = Array.isArray(fm.open_blockers) ? fm.open_blockers : [];
      if (blockers.length && dias >= umbral) {
        out.push((tipo === 'people' ? nombre : 'El proyecto ' + nombre) + ' arrastra ' +
          blockers.length + ' blocker(s) hace ' + dias + ' días: ' + blockers[0]);
      } else if (str_(fm.silence_flagged) && str_(fm.silence_flagged) === str_(fm.last_updated)) {
        out.push(nombre + ' lleva ' + dias + ' días sin novedades.');
      }
    });
  });
  return out;
}

// --- Prompt del call único ---

function briefingSystem_(promptPersonal) {
  var base = [
    'Eres el Chief of Staff del líder y redactas la parte narrativa de su briefing matutino.',
    'Devuelve SOLO un JSON con:',
    '- "foco": 1 a 3 prioridades concretas para HOY (frases cortas, accionables), elegidas',
    '  cruzando agenda, tareas y señales urgentes. Sin relleno motivacional.',
    '- "urgente": si hay señales urgentes, un párrafo corto que las hile con contexto; si no, "".',
    'No inventes reuniones ni tareas: usa solo los datos dados.'
  ].join('\n');
  var p = String(promptPersonal == null ? '' : promptPersonal).trim();
  return p ? base + '\n\nINSTRUCCIÓN PERSONAL DEL LÍDER (respétala):\n' + p : base;
}

function briefingUser_(today, datos) {
  return 'FECHA: ' + today + '\n\n' +
    'AGENDA DE HOY:\n' + (datos.reuniones.map(function (r) {
      return '- ' + r.hora + ' ' + r.titulo + ' (' + r.asistentes + ' asistentes)';
    }).join('\n') || '- (sin reuniones)') + '\n\n' +
    'TAREAS PENDIENTES:\n' + (datos.tareas.map(function (t) {
      return '- ' + t.texto + (t.atrasada ? ' [ATRASADA]' : (t.hoy ? ' [HOY]' : '')) +
        (t.bloqueada ? ' [BLOQUEADA]' : '') + (t.proyecto ? ' · ' + t.proyecto : '');
    }).join('\n') || '- (sin pendientes)') + '\n\n' +
    'SEÑALES URGENTES:\n' + (datos.urgentes.map(function (u) { return '- ' + u; }).join('\n') || '- (ninguna)');
}

function parseBriefing_(text) {
  var t = String(text == null ? '' : text).trim();
  try {
    var o = JSON.parse(t);
    return { foco: str_(o.foco), urgente: str_(o.urgente) };
  } catch (e) {
    return { foco: t, urgente: '' };
  }
}

/** Cuerpo de texto plano (fallback de clientes sin HTML). */
function cuerpoPlanoBriefing_(secciones, datos, ia) {
  var partes = [];
  secciones.forEach(function (s) {
    if (s.id === 'dia') {
      partes.push('TU DÍA (' + datos.reuniones.length + ' reuniones)\n' + (datos.reuniones.map(function (r) {
        return '· ' + r.hora + ' ' + r.titulo + (r.prep ? ' (tienes Deep Prep)' : '');
      }).join('\n') || '· Sin reuniones: día despejado.'));
    } else if (s.id === 'pendientes') {
      partes.push('PENDIENTES\n' + (datos.tareas.map(function (t) {
        return '· ' + t.texto + (t.atrasada ? ' [atrasada]' : (t.hoy ? ' [hoy]' : ''));
      }).join('\n') || '· Nada pendiente.'));
    } else if (s.id === 'urgente' && (ia.urgente || datos.urgentes.length)) {
      partes.push('URGENTE\n' + (ia.urgente || datos.urgentes.map(function (u) { return '· ' + u; }).join('\n')));
    } else if (s.id === 'foco' && ia.foco) {
      partes.push('FOCO SUGERIDO\n' + ia.foco);
    }
  });
  return partes.join('\n\n') + '\n\n— Vera, tu Chief of Staff';
}
