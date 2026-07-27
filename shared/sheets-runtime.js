/**
 * sheets-runtime.js — Acceso a hojas/columnas y utilidades de hora.
 *
 * El código lee por NOMBRE de encabezado (fila 1), no por posición, porque el líder
 * personaliza las preguntas del Form. Ver Docs/engineering-playbook.md.
 *
 * Sin import/export: runtime de Apps Script. Privados con sufijo "_".
 */

/** Abre el Spreadsheet del líder por su ID. */
function getSpreadsheet_(sheetId) {
  if (!sheetId) throw new Error('getSpreadsheet_: falta sheetId.');
  return SpreadsheetApp.openById(sheetId);
}

/** Devuelve la hoja `name` del Spreadsheet `sheetId`. Falla si no existe. */
function getSheet_(sheetId, name) {
  var sh = getSpreadsheet_(sheetId).getSheetByName(name);
  if (!sh) throw new Error('No existe la hoja: ' + name);
  return sh;
}

/** Mapa { encabezado -> columna 1-based } usando la fila 1. */
function getHeaderMap_(sheet) {
  var lastCol = sheet.getLastColumn();
  if (lastCol < 1) return {};
  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  var map = {};
  headers.forEach(function (h, i) {
    var key = String(h).trim();
    if (key) map[key] = i + 1;
  });
  return map;
}

/**
 * Garantiza que exista la columna `headerName` (la crea al final si falta).
 * Idempotente. Devuelve el índice de columna 1-based.
 */
function ensureColumn_(sheet, headerName) {
  var map = getHeaderMap_(sheet);
  if (map[headerName]) return map[headerName];
  var col = sheet.getLastColumn() + 1;
  sheet.getRange(1, col).setValue(headerName);
  return col;
}

// --- Utilidades de hora (para el dispatcher) ---

function pad2_(n) { return (n < 10 ? '0' : '') + n; }

/** Normaliza "8:30:00 a. m." / "6:00:00 p. m." / "18:00" -> "HH:mm" (24h). '' si no parsea. */
function toHHMM_(v) {
  var s = String(v == null ? '' : v).trim().toLowerCase();
  var m = s.match(/(\d{1,2}):(\d{2})/);
  if (!m) return '';
  var h = parseInt(m[1], 10);
  var min = m[2];
  var flat = s.replace(/[\s.]/g, '');          // "8:30:00 a. m." -> "8:30:00am"
  if (flat.indexOf('pm') > -1 && h < 12) h += 12;
  if (flat.indexOf('am') > -1 && h === 12) h = 0;
  return pad2_(h) + ':' + min;
}

/** "HH:mm" -> minutos desde medianoche. */
function hhmmToMin_(s) {
  var p = String(s).split(':');
  return parseInt(p[0], 10) * 60 + parseInt(p[1], 10);
}

/** ¿`nowHHMM` cae dentro de [target, target + windowMin)? */
function horaCoincide_(targetHHMM, nowHHMM, windowMin) {
  if (!targetHHMM) return false;
  var t = hhmmToMin_(targetHHMM);
  var n = hhmmToMin_(nowHHMM);
  var w = windowMin || 5;
  return n >= t && n < t + w;
}

/**
 * Última fila que REALMENTE tiene "Marca temporal" (una respuesta del Form).
 * OJO: NO uses getLastRow() para esto — cuenta filas basura. Devuelve 0 si no hay.
 */
function ultimaFilaConTimestamp_(sheet) {
  var col = getHeaderMap_(sheet)['Marca temporal'];
  if (!col || sheet.getLastRow() < 2) return 0;
  var vals = sheet.getRange(2, col, sheet.getLastRow() - 1, 1).getValues();
  for (var i = vals.length - 1; i >= 0; i--) {
    if (vals[i][0] !== '' && vals[i][0] != null) return i + 2;  // nº de fila real
  }
  return 0;
}
