/**
 * settings-runtime.js — Config editable por el líder (pestaña `Ajustes`) + soporte del sidebar.
 *
 * Parte editable en runtime (líder, horarios, forms, preguntas) vive en una pestaña key/value
 * `Ajustes`; el stub arma el CONFIG completo mezclando lo estático (código) con esto.
 * Aquí también viven las funciones que el sidebar invoca (cargar/guardar).
 * Ver Docs/workflows/CLEVEL-REPORTS/sidebar-and-prompts.md.
 *
 * Sin import/export: runtime de Apps Script. Privados con sufijo "_".
 */

/** Claves editables de la pestaña `Ajustes` y sus defaults. */
var AJUSTES_DEFAULTS_ = {
  'leader.email': '',
  'leader.name': '',
  'schedule.invitesDaily': '08:30',
  'schedule.invitesWeekly': '16:00',
  'schedule.closeDaily': '18:00',
  'schedule.closeWeekly': '18:30',
  'timezone': 'America/Lima',
  'forms.dailyUrl': '',
  'forms.weeklyUrl': '',
  'forms.dailyFormId': '',
  'forms.weeklyFormId': '',
  'questions.daily': '',     // JSON; '' → usa DEFAULT_QUESTIONS_.daily
  'questions.weekly': '',
  // Metadatos del Form editables desde el modal (título/descr.) + último prompt generativo por tipo.
  'form.title.daily': '',
  'form.title.weekly': '',
  'form.desc.daily': '',
  'form.desc.weekly': '',
  'prompt.gen.daily': '',
  'prompt.gen.weekly': '',
  // --- Second brain + Deep Prep (feature flags; ver Docs/workflows/SECOND-BRAIN/) ---
  'brain.enabled': 'false',          // 'true' → ingesta al brain en onFormSubmit
  'brain.folderId': '',              // id de la carpeta CoS-Brain/ en Drive (autocreada)
  'brain.retentionMonths': '12',     // retención del raw/ (gobernanza)
  'brain.silenceDays': '7',          // días sin actualizar → el scan marca la entidad como estancada
  'deepPrep.enabled': 'false',       // 'true' → genera Deep Prep (requiere brain.enabled)
  'deepPrep.leadHours': '3',         // horas antes de la reunión para disparar el prep
  'deepPrep.selected': '[]',         // JSON: eventIds del calendario marcados para prep
  // --- Compartir reportes (Fase 1: correos; ver Docs/workflows/CLEVEL-REPORTS/) ---
  'consolidado.cc': '',              // correos extra (coma) que reciben el consolidado COMPLETO
  // --- Notas de Gemini (Meet) → brain (requiere brain.enabled) ---
  'meet.enabled': 'false',           // 'true' → pasada horaria que indexa notas de Meet al wiki
  'meet.lookbackDays': '30',         // días hacia atrás del IMPORT INICIAL (el régimen usa 7 fijo)
  'meet.import.status': 'idle',      // idle | running | done — job de importación inicial
  'meet.import.total': '0',          // docs descubiertos al iniciar (progreso)
  'meet.import.ok': '0',
  'meet.import.sinAcceso': '0',
  'meet.import.errores': '0',
  // --- Morning Briefing (resumen diario por correo; modal propio) ---
  'briefing.enabled': 'false',
  'briefing.hora': '07:30',
  'briefing.dias': '1,2,3,4,5',      // días ISO (1=lun … 7=dom) en que se envía
  'briefing.secciones': '',          // JSON [{id,on}] ordenado; '' → BRIEFING_SECCIONES_DEFAULT_
  'briefing.prompt': '',             // instrucción personal del líder (tono, idioma, reglas)
  // --- Backfill del histórico al brain (job reanudable; lo avanza el dispatcher) ---
  'brain.backfill.status': 'idle',   // idle | running | done
  'brain.backfill.cursorDaily': '2', // próxima fila 1-based a evaluar en la hoja Daily
  'brain.backfill.cursorWeekly': '2',
  'brain.backfill.total': '0',       // filas elegibles al iniciar (para pintar el progreso)
  'brain.backfill.ok': '0',
  'brain.backfill.saltadas': '0',
  'brain.backfill.errores': '0'
};

/** Preguntas por defecto (pre-cargan el panel Preguntas en una copia nueva). */
var DEFAULT_QUESTIONS_ = {
  daily: [
    { tipo: 'parrafo', titulo: '¿Qué vas a lograr hoy?' },
    { tipo: 'parrafo', titulo: '¿Qué te bloquea y de quién necesitas ayuda?' },
    { tipo: 'parrafo', titulo: 'Algo más que me quieras contar' }
  ],
  weekly: [
    { tipo: 'parrafo', titulo: '¿Qué logré esta semana?' },
    { tipo: 'parrafo', titulo: '¿Qué no logré y por qué?' },
    { tipo: 'parrafo', titulo: '¿Cuáles fueron mis aprendizajes?' },
    { tipo: 'parrafo', titulo: '¿Qué pude automatizar?' },
    { tipo: 'parrafo', titulo: '¿Qué cargo para la próxima semana?' }
  ]
};

// --- Estilo de tabla (encabezado + zebra) para las pestañas auto-generadas ---

var TABLA_HEADER_BG_ = '#202124';   // encabezado oscuro neutro
var TABLA_HEADER_FG_ = '#ffffff';
var TABLA_BAND_1_    = '#ffffff';   // fila impar
var TABLA_BAND_2_    = '#f4f5f7';   // fila par (zebra)
var TABLA_HEADER_LINE_ = '#c8ccd1';

/**
 * Da formato de tabla a una hoja: encabezado con color, fila 1 congelada, zebra en las filas
 * de datos y anchos de columna. Es best-effort (cosmético): si algo falla, no rompe el guardado.
 * @param {Sheet}  sheet
 * @param {number} nCols
 * @param {Array<number>} [widths]  anchos por columna (px)
 */
function estilizarTabla_(sheet, nCols, widths) {
  try {
    sheet.getRange(1, 1, 1, nCols)
      .setBackground(TABLA_HEADER_BG_).setFontColor(TABLA_HEADER_FG_)
      .setFontWeight('bold').setVerticalAlignment('middle');
    sheet.setFrozenRows(1);
    sheet.setRowHeight(1, 34);

    (widths || []).forEach(function (w, i) { sheet.setColumnWidth(i + 1, w); });

    // Zebra en las filas de datos (quita bandings previos para no chocar al re-guardar).
    (sheet.getBandings() || []).forEach(function (b) { b.remove(); });
    var filas = Math.max(sheet.getMaxRows() - 1, 1);
    sheet.getRange(2, 1, filas, nCols)
      .applyRowBanding(SpreadsheetApp.BandingTheme.LIGHT_GREY, false, false)
      .setFirstRowColor(TABLA_BAND_1_).setSecondRowColor(TABLA_BAND_2_);

    // Línea bajo el encabezado.
    sheet.getRange(1, 1, 1, nCols)
      .setBorder(null, null, true, null, null, null, TABLA_HEADER_LINE_, SpreadsheetApp.BorderStyle.SOLID_MEDIUM);
  } catch (e) {
    if (typeof Logger !== 'undefined') Logger.log('estilizarTabla_ omitido: ' + e);
  }
}

/**
 * Aplica el formato de tabla a las pestañas existentes (Ajustes, Prompts, Equipo).
 * Público — para embellecer pestañas creadas antes de tener el estilo. Idempotente.
 */
function estilizarPestanas(sheetId, config) {
  var ss = getSpreadsheet_(sheetId);
  [config.sheets.settings, config.sheets.prompts].forEach(function (name) {
    var sh = ss.getSheetByName(name);
    if (sh) estilizarTabla_(sh, 2, [230, 560]);
  });
  var eq = ss.getSheetByName(config.sheets.roster);
  if (eq) estilizarTabla_(eq, 3, [200, 300, 160]);
  return { ok: true };
}

// --- Utilidades de pestaña key/value (reutilizadas por Ajustes y Prompts) ---

function ensureKeyValueTab_(sheetId, name) {
  var ss = getSpreadsheet_(sheetId);
  var sh = ss.getSheetByName(name);
  var creada = false;
  if (!sh) { sh = ss.insertSheet(name); creada = true; }
  var map = getHeaderMap_(sh);
  if (!map['key'] || !map['value']) sh.getRange(1, 1, 1, 2).setValues([['key', 'value']]);
  // Fuerza la columna 'value' a TEXTO: evita que Sheets convierta "22:05" en un valor de hora (Date).
  try { sh.getRange(2, 2, Math.max(sh.getMaxRows() - 1, 1), 1).setNumberFormat('@'); } catch (e) {}
  if (creada) estilizarTabla_(sh, 2, [230, 560]);   // solo al crear la pestaña
  return sh;
}

function readKeyValueTab_(sh) {
  var out = {};
  if (!sh || sh.getLastRow() < 2) return out;
  var map = getHeaderMap_(sh);
  if (!map['key'] || !map['value']) return out;
  var rows = sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).getValues();
  rows.forEach(function (r) {
    var k = String(r[map['key'] - 1]).trim();
    if (k) out[k] = r[map['value'] - 1];
  });
  return out;
}

function setKeyValueTab_(sh, updates) {
  var map = getHeaderMap_(sh);
  var colK = map['key'], colV = map['value'];
  var existing = {};
  if (sh.getLastRow() >= 2) {
    var rows = sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).getValues();
    for (var i = 0; i < rows.length; i++) existing[String(rows[i][colK - 1]).trim()] = i + 2;
  }
  Object.keys(updates).forEach(function (k) {
    var row = existing[k];
    if (!row) { row = sh.getLastRow() + 1; sh.getRange(row, colK).setValue(k); existing[k] = row; }
    sh.getRange(row, colV).setValue(updates[k]);
  });
}

// --- Ajustes (estructurado) ---

function str_(v) { return v == null ? '' : String(v); }

/** Interpreta un valor de Ajustes como booleano. Solo 'true' (case-insensitive) es verdadero. */
function bool_(v) { return String(v).trim().toLowerCase() === 'true'; }

/** Entero con fallback (para claves numéricas de Ajustes guardadas como texto). */
function int_(v, def) { var n = parseInt(str_(v), 10); return isNaN(n) ? def : n; }

/** Parsea un JSON array guardado en Ajustes; '' o inválido → []. */
function parseJsonArray_(v) {
  var s = str_(v).trim();
  if (!s) return [];
  try { var a = JSON.parse(s); return Array.isArray(a) ? a : []; } catch (e) { return []; }
}

/** Lista de enteros separada por comas ('1,2,3'); vacío/ inválido → def. */
function listaEnteros_(v, def) {
  var out = str_(v).split(',').map(function (s) { return parseInt(s.trim(), 10); })
    .filter(function (n) { return !isNaN(n); });
  return out.length ? out : def.slice();
}

/** Secciones del Morning Briefing: orden + on/off por sección. */
var BRIEFING_SECCIONES_DEFAULT_ = [
  { id: 'dia', on: true }, { id: 'pendientes', on: true },
  { id: 'urgente', on: true }, { id: 'foco', on: true }
];

function seccionesBriefing_(v) {
  var a = parseJsonArray_(v).filter(function (s) { return s && s.id; });
  return a.length ? a : BRIEFING_SECCIONES_DEFAULT_.map(function (s) { return { id: s.id, on: s.on }; });
}

/**
 * Normaliza un valor de hora a "HH:mm". Tolera:
 *  - string "22:05" / "6:00:00 p. m." → toHHMM_
 *  - Date (cuando Sheets convirtió "22:05" en valor de hora) → formatea en la zona del Sheet
 */
function normHora_(v, ss) {
  if (v == null || v === '') return '';
  if (Object.prototype.toString.call(v) === '[object Date]') {
    return Utilities.formatDate(v, ss.getSpreadsheetTimeZone(), 'HH:mm');
  }
  return toHHMM_(v);
}

function getAjustes_(sheetId, settingsSheetName) {
  var ss = getSpreadsheet_(sheetId);
  var flat = {};
  Object.keys(AJUSTES_DEFAULTS_).forEach(function (k) { flat[k] = AJUSTES_DEFAULTS_[k]; });

  var sh = ss.getSheetByName(settingsSheetName);
  if (sh) {
    var kv = readKeyValueTab_(sh);
    Object.keys(kv).forEach(function (k) {
      if (k in AJUSTES_DEFAULTS_ && kv[k] !== '' && kv[k] != null) flat[k] = kv[k];   // RAW (puede ser Date)
    });
  }

  return {
    leader:   { email: str_(flat['leader.email']), name: str_(flat['leader.name']) },
    schedule: {
      invitesDaily:  normHora_(flat['schedule.invitesDaily'], ss),
      invitesWeekly: normHora_(flat['schedule.invitesWeekly'], ss),
      closeDaily:    normHora_(flat['schedule.closeDaily'], ss),
      closeWeekly:   normHora_(flat['schedule.closeWeekly'], ss)
    },
    timezone: str_(flat['timezone']),
    forms: {
      dailyUrl:     str_(flat['forms.dailyUrl']),
      weeklyUrl:    str_(flat['forms.weeklyUrl']),
      dailyFormId:  str_(flat['forms.dailyFormId']),
      weeklyFormId: str_(flat['forms.weeklyFormId'])
    },
    questions: { daily: str_(flat['questions.daily']), weekly: str_(flat['questions.weekly']) },
    formMeta: {
      daily: {
        titulo:      str_(flat['form.title.daily']),
        descripcion: str_(flat['form.desc.daily']),
        prompt:      str_(flat['prompt.gen.daily'])
      },
      weekly: {
        titulo:      str_(flat['form.title.weekly']),
        descripcion: str_(flat['form.desc.weekly']),
        prompt:      str_(flat['prompt.gen.weekly'])
      }
    },
    brain: {
      enabled:         bool_(flat['brain.enabled']),
      folderId:        str_(flat['brain.folderId']),
      retentionMonths: int_(flat['brain.retentionMonths'], 12),
      silenceDays:     int_(flat['brain.silenceDays'], 7),
      backfill: {
        status:       str_(flat['brain.backfill.status']) || 'idle',
        cursorDaily:  int_(flat['brain.backfill.cursorDaily'], 2),
        cursorWeekly: int_(flat['brain.backfill.cursorWeekly'], 2),
        total:        int_(flat['brain.backfill.total'], 0),
        ok:           int_(flat['brain.backfill.ok'], 0),
        saltadas:     int_(flat['brain.backfill.saltadas'], 0),
        errores:      int_(flat['brain.backfill.errores'], 0)
      }
    },
    deepPrep: {
      enabled:   bool_(flat['deepPrep.enabled']),
      leadHours: int_(flat['deepPrep.leadHours'], 3),
      selected:  parseJsonArray_(flat['deepPrep.selected'])
    },
    consolidado: {
      cc: listaCorreos_(flat['consolidado.cc'])
    },
    briefing: {
      enabled:   bool_(flat['briefing.enabled']),
      hora:      normHora_(flat['briefing.hora'], ss) || '07:30',
      dias:      listaEnteros_(flat['briefing.dias'], [1, 2, 3, 4, 5]),
      secciones: seccionesBriefing_(flat['briefing.secciones']),
      prompt:    str_(flat['briefing.prompt'])
    },
    meet: {
      enabled:      bool_(flat['meet.enabled']),
      lookbackDays: int_(flat['meet.lookbackDays'], 30),
      import: {
        status:    str_(flat['meet.import.status']) || 'idle',
        total:     int_(flat['meet.import.total'], 0),
        ok:        int_(flat['meet.import.ok'], 0),
        sinAcceso: int_(flat['meet.import.sinAcceso'], 0),
        errores:   int_(flat['meet.import.errores'], 0)
      }
    }
  };
}

function setAjustes_(sheetId, settingsSheetName, updates) {
  setKeyValueTab_(ensureKeyValueTab_(sheetId, settingsSheetName), updates);
}

function parseQuestions_(json, tipo) {
  if (json) {
    try {
      var arr = JSON.parse(json);
      if (Array.isArray(arr) && arr.length) return arr;
    } catch (e) { /* JSON inválido → cae al default */ }
  }
  return DEFAULT_QUESTIONS_[tipo] || [];
}

// --- API pública: el stub arma el CONFIG con esto ---

/** Mezcla el CONFIG estático (código) con la parte editable (pestaña Ajustes). */
function construirConfig(sheetId, staticConfig) {
  var aj = getAjustes_(sheetId, staticConfig.sheets.settings);
  return {
    sheets: staticConfig.sheets,
    models: staticConfig.models,
    timezone: aj.timezone || staticConfig.timezone,   // editable por líder (fallback al estático)
    dispatchWindowMin: staticConfig.dispatchWindowMin,
    options: staticConfig.options || {},
    leader: aj.leader,
    schedule: aj.schedule,
    forms: aj.forms,
    brain: aj.brain,          // feature flag + carpeta del second brain
    deepPrep: aj.deepPrep,    // feature flag + selección/timing del Deep Prep
    consolidado: aj.consolidado,  // cc del consolidado completo (compartir reportes)
    meet: aj.meet,            // feature flag + import inicial de Notas de Gemini
    briefing: aj.briefing     // Morning Briefing (flag, hora, días, secciones, prompt personal)
  };
}

// --- API pública: la consume el sidebar (vía wrappers del stub) ---

/** Estado agregado para pintar los 4 paneles del sidebar. Tolera pestañas ausentes. */
function cargarConfig(sheetId, config) {
  var aj = getAjustes_(sheetId, config.sheets.settings);
  var equipo = [];
  try { equipo = getRoster_(sheetId, config.sheets.roster); } catch (e) { equipo = []; }
  return {
    prompts: getPromptsRaw_(sheetId, config.sheets.prompts),   // valores guardados ('' si no)
    promptDefaults: getDefaultPrompts_(),                       // para placeholders / reset
    equipo: equipo,
    horarios: aj.schedule,
    timezone: aj.timezone || config.timezone,
    leader: aj.leader,
    forms: { dailyUrl: aj.forms.dailyUrl, weeklyUrl: aj.forms.weeklyUrl },
    preguntas: {
      daily: parseQuestions_(aj.questions.daily, 'daily'),
      weekly: parseQuestions_(aj.questions.weekly, 'weekly')
    },
    formMeta: aj.formMeta,   // { daily:{titulo,descripcion,prompt}, weekly:{...} } para el modal
    // Feature flags para los paneles Prep/Brain del sidebar (sin exponer folderId).
    flags: {
      brainEnabled:    aj.brain.enabled,
      silenceDays:     aj.brain.silenceDays,
      retentionMonths: aj.brain.retentionMonths,
      deepPrepEnabled: aj.deepPrep.enabled,
      leadHours:       aj.deepPrep.leadHours,
      meetEnabled:     aj.meet.enabled,
      meetLookbackDays: aj.meet.lookbackDays
    }
  };
}

/** Genera/edita el Form del líder y persiste su URL/ID/preguntas en Ajustes. @return {string} url */
function configurarFormulario(tipo, preguntas, sheetId, config) {
  var aj = getAjustes_(sheetId, config.sheets.settings);
  var existingId = (tipo === 'daily') ? aj.forms.dailyFormId : aj.forms.weeklyFormId;
  var res = generarFormulario(tipo, preguntas, sheetId, config, existingId || null);

  var updates = {};
  if (tipo === 'daily') {
    updates['forms.dailyUrl'] = res.publishedUrl;
    updates['forms.dailyFormId'] = res.formId;
    updates['questions.daily'] = JSON.stringify(preguntas || []);
  } else {
    updates['forms.weeklyUrl'] = res.publishedUrl;
    updates['forms.weeklyFormId'] = res.formId;
    updates['questions.weekly'] = JSON.stringify(preguntas || []);
  }
  setAjustes_(sheetId, config.sheets.settings, updates);
  return res.publishedUrl;
}

/**
 * Genera/edita el Form desde el MODAL y persiste todo su estado en Ajustes: preguntas (con
 * obligatoriedad/ayuda), URL/ID, título/descripción del Form y el último prompt generativo.
 * Reescribe el MISMO Form si ya existe (conserva URL/ID/acceso/correo verificado).
 *
 * @param {string} tipo    'daily' | 'weekly'
 * @param {Object} payload { preguntas:Array, titulo?:string, descripcion?:string, prompt?:string }
 * @return {string} publishedUrl
 */
function guardarFormulario(sheetId, config, tipo, payload) {
  payload = payload || {};
  var preguntas = payload.preguntas || [];
  var meta = { titulo: payload.titulo || '', descripcion: payload.descripcion || '' };

  var aj = getAjustes_(sheetId, config.sheets.settings);
  var existingId = (tipo === 'daily') ? aj.forms.dailyFormId : aj.forms.weeklyFormId;
  var res = generarFormulario(tipo, preguntas, sheetId, config, existingId || null, meta);

  var suf = (tipo === 'daily') ? 'daily' : 'weekly';
  var updates = {};
  updates['forms.' + suf + 'Url']  = res.publishedUrl;
  updates['forms.' + suf + 'FormId'] = res.formId;
  updates['questions.' + suf]       = JSON.stringify(preguntas);
  updates['form.title.' + suf]      = meta.titulo;
  updates['form.desc.' + suf]       = meta.descripcion;
  updates['prompt.gen.' + suf]      = payload.prompt || '';
  setAjustes_(sheetId, config.sheets.settings, updates);
  return res.publishedUrl;
}

/** Guarda los prompts editados (objeto por campo) en la pestaña Prompts. */
function guardarPrompts(sheetId, config, prompts) {
  var invByField = {};
  Object.keys(PROMPT_KEYS_).forEach(function (k) { invByField[PROMPT_KEYS_[k]] = k; });
  var updates = {};
  Object.keys(prompts || {}).forEach(function (field) {
    if (invByField[field]) updates[invByField[field]] = prompts[field];
  });
  setKeyValueTab_(ensureKeyValueTab_(sheetId, config.sheets.prompts), updates);
  return { ok: true };
}

/** Guarda los horarios (normaliza a HH:mm) en Ajustes. */
function guardarHorarios(sheetId, config, horarios) {
  var updates = {
    'schedule.invitesDaily':  toHHMM_(horarios.invitesDaily)  || horarios.invitesDaily || '',
    'schedule.invitesWeekly': toHHMM_(horarios.invitesWeekly) || horarios.invitesWeekly || '',
    'schedule.closeDaily':    toHHMM_(horarios.closeDaily)    || horarios.closeDaily || '',
    'schedule.closeWeekly':   toHHMM_(horarios.closeWeekly)   || horarios.closeWeekly || ''
  };
  if (horarios.timezone) updates['timezone'] = horarios.timezone;   // zona horaria por líder
  setAjustes_(sheetId, config.sheets.settings, updates);
  return { ok: true };
}

/** Guarda el líder (destinatario de los consolidados) en Ajustes. */
function guardarLeader(sheetId, config, leader) {
  setAjustes_(sheetId, config.sheets.settings, {
    'leader.email': (leader && leader.email) || '',
    'leader.name':  (leader && leader.name) || ''
  });
  return { ok: true };
}

/**
 * Sobrescribe la pestaña Equipo con la lista dada y re-sincroniza el acceso a los Forms.
 *
 * La sincronización va aquí (y no solo al generar el Form) porque el equipo cambia después:
 * quien entra más tarde necesita acceso de respondiente sin tener que regenerar los Forms.
 */
function guardarEquipo(sheetId, config, miembros) {
  var ss = getSpreadsheet_(sheetId);
  var sh = ss.getSheetByName(config.sheets.roster) || ss.insertSheet(config.sheets.roster);

  // Preservar `Compartir con` (la escribe el modal Compartir, no este editor): se re-asocia por
  // correo tras el clearContents. Si el correo de una persona cambia, su compartir se pierde.
  var compartirPrevio = {};
  try {
    getRoster_(sheetId, config.sheets.roster).forEach(function (p) {
      if (p.compartirCon.length) compartirPrevio[p.correo.toLowerCase()] = p.compartirCon.join(', ');
    });
  } catch (e) { /* pestaña nueva o sin contrato: nada que preservar */ }

  sh.clearContents();
  var values = [['Nombre', 'Correo', 'Rol', 'Compartir con']];
  (miembros || []).forEach(function (m) {
    var correo = String(m.correo || '').trim();
    values.push([m.nombre || '', correo, m.rol || '', compartirPrevio[correo.toLowerCase()] || '']);
  });
  sh.getRange(1, 1, values.length, 4).setValues(values);
  estilizarTabla_(sh, 4, [200, 300, 160, 300]);   // formato de tabla (encabezado + zebra)

  // Best-effort: guardar el equipo no debe fallar porque un Form no se deje sincronizar.
  var acceso = null;
  try {
    acceso = sincronizarAccesoForms(sheetId, config);
  } catch (e) {
    Logger.log('No se pudo sincronizar el acceso a los Forms tras guardar el equipo (%s).', e.message);
  }
  return { ok: true, count: (miembros || []).length, acceso: acceso };
}
