/**
 * prompts-runtime.js — Prompts en capas (soul + user + task) con defaults baked-in.
 *
 * El líder edita 6 artefactos en la pestaña `Prompts` (key -> value). Si una celda está
 * vacía, se usa el DEFAULT de la librería, así una copia nueva funciona out-of-the-box.
 * Ver Docs/workflows/CLEVEL-REPORTS/sidebar-and-prompts.md.
 *
 * Sin import/export: runtime de Apps Script. Privados con sufijo "_".
 */

/** Mapa: clave en la pestaña `Prompts` -> campo del objeto de prompts. */
var PROMPT_KEYS_ = {
  'soul':                     'soul',
  'user':                     'user',
  'task.summary.daily':       'taskSummaryDaily',
  'task.summary.weekly':      'taskSummaryWeekly',
  'task.consolidated.daily':  'taskConsolidatedDaily',
  'task.consolidated.weekly': 'taskConsolidatedWeekly'
};

/** Defaults baked-in. El líder los sobrescribe desde el sidebar cuando quiera. */
var DEFAULT_PROMPTS_ = {
  soul:
    'Eres el Chief of Staff AI de un líder C-level en Xertica. Tu voz es ejecutiva, ' +
    'directa y sin relleno: sintetizas, no rellenas. Eres estrictamente factual, nunca ' +
    'inventas datos ni evalúas el desempeño de las personas — solo reportas hechos y ' +
    'patrones observables en la información que recibes.',

  user:
    'Contexto del líder y su equipo: (aún no personalizado). El líder puede editar este ' +
    'texto desde el panel Prompts del sidebar para dar contexto de su área, prioridades y ' +
    'del destinatario C-level de los consolidados.',

  taskSummaryDaily:
    'Redacta un RESUMEN DIARIO detallado (4–7 líneas), en español, de este reporte ' +
    'individual. Trabaja sobre los pares pregunta→respuesta que recibas, sean cuales sean. ' +
    'Organiza la salida en: (1) foco del día / logros previstos, (2) bloqueos y de quién ' +
    'necesita ayuda, (3) señales de riesgo o notas. Factual, sin inventar, sin evaluar ' +
    'desempeño.',

  taskSummaryWeekly:
    'Redacta un RESUMEN SEMANAL detallado (5–8 líneas), en español, de este reporte ' +
    'individual, a partir de los pares pregunta→respuesta que recibas. Agrupa en: logros de ' +
    'la semana, lo no logrado y su motivo, aprendizajes, automatizaciones y carga para la ' +
    'próxima semana (según lo que aparezca en las respuestas). Factual, sin inventar, sin ' +
    'evaluar desempeño.',

  taskConsolidatedDaily:
    'A partir de los resúmenes individuales del día, redacta un CONSOLIDADO DIARIO ejecutivo ' +
    'en español para el líder. Secciones exactas: LOGROS DE HOY, BLOQUEOS ACTIVOS (con quién ' +
    'necesita ayuda), RIESGOS DETECTADOS, COMENTARIOS. Sé factual, sintetiza, no inventes ni ' +
    'evalúes desempeño.',

  taskConsolidatedWeekly:
    'A partir de los resúmenes semanales individuales, redacta un CONSOLIDADO SEMANAL ' +
    'ejecutivo en español para el líder. Secciones exactas: LOGROS DE LA SEMANA, PENDIENTES / ' +
    'NO LOGRADO, APRENDIZAJES, AUTOMATIZACIONES, CARGA PRÓXIMA SEMANA, RIESGOS. Sé factual, ' +
    'sintetiza, no inventes ni evalúes desempeño.'
};

/**
 * Lee la pestaña `Prompts` (key -> value) y la fusiona con los defaults.
 * Toda celda vacía o clave ausente cae al default correspondiente.
 *
 * @param {string} sheetId           ID del Spreadsheet del líder.
 * @param {string} promptsSheetName  Nombre de la pestaña (CONFIG.sheets.prompts, p.ej. 'Prompts').
 * @return {Object} { soul, user, taskSummaryDaily, taskSummaryWeekly, taskConsolidatedDaily, taskConsolidatedWeekly }
 */
function getPrompts_(sheetId, promptsSheetName) {
  var resolved = {};
  Object.keys(DEFAULT_PROMPTS_).forEach(function (f) { resolved[f] = DEFAULT_PROMPTS_[f]; });

  var sh = getSpreadsheet_(sheetId).getSheetByName(promptsSheetName);
  if (!sh || sh.getLastRow() < 2) return resolved;   // sin pestaña o vacía -> solo defaults

  var map = getHeaderMap_(sh);
  var colKey = map['key'];
  var colVal = map['value'];
  if (!colKey || !colVal) return resolved;           // sin contrato key/value -> solo defaults

  var rows = sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).getValues();
  rows.forEach(function (r) {
    var key = String(r[colKey - 1]).trim();
    var val = String(r[colVal - 1] == null ? '' : r[colVal - 1]).trim();
    var field = PROMPT_KEYS_[key];
    if (field && val) resolved[field] = val;          // solo sobrescribe si hay valor
  });

  return resolved;
}

/**
 * Solo lo GUARDADO por el líder (cadena vacía si no lo personalizó). Para el sidebar:
 * el value del textarea va con esto y el placeholder con getDefaultPrompts_.
 */
function getPromptsRaw_(sheetId, promptsSheetName) {
  var raw = {};
  Object.keys(DEFAULT_PROMPTS_).forEach(function (f) { raw[f] = ''; });

  var sh = getSpreadsheet_(sheetId).getSheetByName(promptsSheetName);
  if (!sh || sh.getLastRow() < 2) return raw;
  var map = getHeaderMap_(sh);
  if (!map['key'] || !map['value']) return raw;

  var rows = sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).getValues();
  rows.forEach(function (r) {
    var key = String(r[map['key'] - 1]).trim();
    var val = String(r[map['value'] - 1] == null ? '' : r[map['value'] - 1]).trim();
    var field = PROMPT_KEYS_[key];
    if (field && val) raw[field] = val;
  });
  return raw;
}

/** Copia de los prompts por defecto (para placeholders y "Reestablecer"). */
function getDefaultPrompts_() {
  var d = {};
  Object.keys(DEFAULT_PROMPTS_).forEach(function (f) { d[f] = DEFAULT_PROMPTS_[f]; });
  return d;
}

/**
 * Compone el bloque de sistema de una llamada: soul + user + system-prompt de la tarea.
 * @param {Object} prompts  objeto devuelto por getPrompts_.
 * @param {string} taskField  campo de tarea, p.ej. 'taskSummaryDaily'.
 */
function composeSystem_(prompts, taskField) {
  var task = prompts[taskField];
  if (!task) throw new Error('composeSystem_: tarea desconocida: ' + taskField);
  return [prompts.soul, prompts.user, task]
    .filter(function (x) { return x && String(x).trim(); })
    .join('\n\n---\n\n');
}
