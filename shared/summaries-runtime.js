/**
 * summaries-runtime.js — Resumen individual por fila (pass-through genérico de preguntas).
 *
 * El resumen NO asume qué preguntas hay: toma TODAS las columnas que no son de contrato
 * y las manda al LLM como pares pregunta→respuesta. La estructura de la salida la impone
 * el system-prompt, no las columnas. Ver Docs/workflows/CLEVEL-REPORTS/CLEVEL-REPORTS.md.
 *
 * Sin import/export: runtime de Apps Script. Privados con sufijo "_".
 */

/** Encabezados que NO son preguntas (no entran al pass-through). */
var RESERVED_HEADERS_ = [
  'Marca temporal',
  'Dirección de correo electrónico',
  'Nombre',
  'Correo',
  'Lider',
  'Summary'
];

function esReservado_(header) {
  return RESERVED_HEADERS_.indexOf(String(header).trim()) > -1;
}

/** Determina el tipo de hoja según CONFIG. Devuelve 'daily' | 'weekly' | null. */
function tipoDeHoja_(config, sheetName) {
  if (sheetName === config.sheets.daily) return 'daily';
  if (sheetName === config.sheets.weekly) return 'weekly';
  return null;
}

/**
 * Extrae los pares pregunta→respuesta de una fila: toda columna no reservada con valor.
 * @param {Object} headerMap  { encabezado -> col 1-based }
 * @param {Array}  rowValues  valores de la fila (0-based)
 * @return {Array<{q:string,a:string}>} en orden de columna
 */
function extraerQA_(headerMap, rowValues) {
  return Object.keys(headerMap)
    .filter(function (h) { return !esReservado_(h); })
    .sort(function (a, b) { return headerMap[a] - headerMap[b]; })
    .map(function (h) {
      var val = rowValues[headerMap[h] - 1];
      return { q: h, a: String(val == null ? '' : val).trim() };
    })
    .filter(function (p) { return p.a; });   // ignora respuestas vacías
}

/**
 * Rellena las columnas de identidad `Nombre` y `Correo` de una fila de respuestas.
 *
 * El Form ya no pregunta nada de esto: Google escribe el correo verificado en
 * `Dirección de correo electrónico` y aquí lo cruzamos contra la pestaña `Equipo` para
 * traer el nombre. Crea ambas columnas si faltan (idempotente, van al final de la hoja).
 *
 * Si el correo no está en `Equipo` (alguien de fuera del equipo respondió), se escribe el
 * correo igual y `Nombre` queda vacío — el resumen y el consolidado caen al correo.
 *
 * @param {string} sheetId
 * @param {Object} config   CONFIG (usa sheets.roster)
 * @param {Sheet}  sh       hoja de respuestas (Daily o Weekly)
 * @param {number} row      fila 1-based de la respuesta
 * @return {{nombre:string, correo:string}} identidad resuelta (la usa el prompt del resumen)
 */
function enriquecerFilaConRoster_(sheetId, config, sh, row) {
  var colVerificado = getHeaderMap_(sh)['Dirección de correo electrónico'];
  var correo = colVerificado
    ? String(sh.getRange(row, colVerificado).getValue() || '').trim()
    : '';

  var persona = buscarEnRoster_(sheetId, config.sheets.roster, correo);
  var nombre = (persona && persona.nombre) || '';

  // ensureColumn_ antes de escribir: en una hoja recién enlazada al Form no existen aún.
  var colNombre = ensureColumn_(sh, 'Nombre');
  var colCorreo = ensureColumn_(sh, 'Correo');
  if (nombre) sh.getRange(row, colNombre).setValue(nombre);
  if (correo) sh.getRange(row, colCorreo).setValue(correo);

  return { nombre: nombre, correo: correo };
}

/** Arma el bloque de usuario (solo datos) para el LLM. */
function formatQA_(pairs, meta) {
  var head = 'Persona: ' + (meta.nombre || meta.correo || '(desconocido)') + '\n\n';
  var body = pairs.map(function (p) { return p.q + ': ' + p.a; }).join('\n');
  return head + body;
}

/**
 * Genera y escribe el `Summary` de una fila. Público (lo llama el stub en onFormSubmit).
 *
 * @param {string} sheetId    ID del Spreadsheet del líder.
 * @param {Object} config     CONFIG del workflow (sheets, models, options).
 * @param {string} sheetName  hoja de la fila (Daily o Weekly).
 * @param {number} row        fila 1-based de la respuesta.
 * @return {string} el Summary escrito (o el existente si se saltó por idempotencia).
 */
function generarSummaryFila(sheetId, config, sheetName, row) {
  var tipo = tipoDeHoja_(config, sheetName);
  if (!tipo) return '';   // fila de otra hoja (p.ej. Equipo/Prompts): no aplica

  var sh = getSheet_(sheetId, sheetName);
  var meta = enriquecerFilaConRoster_(sheetId, config, sh, row);   // Nombre + Correo desde Equipo
  ensureColumn_(sh, 'Summary');                       // idempotente
  var headerMap = getHeaderMap_(sh);                  // re-leer tras asegurar las columnas
  var summaryCol = headerMap['Summary'];
  var rowValues = sh.getRange(row, 1, 1, sh.getLastColumn()).getValues()[0];

  // Idempotencia: no regenerar si ya hay Summary, salvo opción explícita.
  var existente = String(rowValues[summaryCol - 1] == null ? '' : rowValues[summaryCol - 1]).trim();
  var regenerar = config.options && config.options.regenerateSummaryIfPresent;
  if (existente && !regenerar) return existente;

  var pairs = extraerQA_(headerMap, rowValues);
  if (!pairs.length) return '';                       // respuesta sin contenido: nada que resumir

  var prompts = getPrompts_(sheetId, config.sheets.prompts);
  var taskField = (tipo === 'daily') ? 'taskSummaryDaily' : 'taskSummaryWeekly';
  var system = composeSystem_(prompts, taskField);
  var user = formatQA_(pairs, meta);

  var summary = callGemini_(config.models.perRow, system, user);
  sh.getRange(row, summaryCol).setValue(summary);
  return summary;
}

/**
 * Genera el Summary de la última fila con Marca temporal. Público — para pruebas manuales
 * desde el stub (onFormSubmit no se puede correr a mano). @return {string}
 */
function resumirUltimaFila(sheetId, config, tipo) {
  var sheetName = (tipo === 'daily') ? config.sheets.daily : config.sheets.weekly;
  var row = ultimaFilaConTimestamp_(getSheet_(sheetId, sheetName));
  if (!row) throw new Error('No hay filas con Marca temporal en ' + sheetName);
  return generarSummaryFila(sheetId, config, sheetName, row);
}
