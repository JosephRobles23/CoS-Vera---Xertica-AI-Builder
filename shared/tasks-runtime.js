/**
 * tasks-runtime.js — Hoja "Tareas" del líder (pendientes con estado por dropdown).
 *
 * Pestaña propia del LÍDER (no del equipo): sus action items. Se autopuebla desde las notas de
 * Meet (eventos `accion` cuyo dueño es el líder) y admite filas manuales. Contrato de columnas:
 *   Tarea · Proyecto · Vence · Prioridad · Estado · Origen · Id
 * "Estado" y "Prioridad" llevan dropdown (validación de datos); los colores de chip se aplican
 * best-effort (el líder puede activar "mostrar como chip" en Sheets para el look completo).
 * Paleta: Pendiente #FEF3C7/#92400E · En curso #DBEAFE/#1E40AF · Bloqueada #FEE2E2/#991B1B ·
 * Hecha #DCFCE7/#166534 (ver Docs/html/morning-briefing-mockups.html).
 *
 * La hoja es la ÚNICA fuente de pendientes del Morning Briefing; el archivado diario mueve las
 * "Hecha" a la pestaña "Archivo". Sin import/export: runtime de Apps Script.
 */

var TAREAS_HEADERS_ = ['Tarea', 'Proyecto', 'Vence', 'Prioridad', 'Estado', 'Origen', 'Id'];
var ESTADOS_TAREA_ = ['Pendiente', 'En curso', 'Bloqueada', 'Hecha'];
var PRIORIDADES_TAREA_ = ['Alta', 'Media', 'Baja'];

/** Nombres con fallback: los stubs viejos no traen estas claves en CONFIG_STATIC.sheets. */
function nombreHojaTareas_(config) { return (config.sheets && config.sheets.tareas) || 'Tareas'; }
function nombreHojaArchivo_(config) { return (config.sheets && config.sheets.archivo) || 'Archivo'; }

/** Asegura la pestaña Tareas con encabezados, estilo y dropdowns. Idempotente. @return {Sheet} */
function ensureTareasSheet_(sheetId, config) {
  var ss = getSpreadsheet_(sheetId);
  var nombre = nombreHojaTareas_(config);
  var sh = ss.getSheetByName(nombre);
  if (!sh) sh = ss.insertSheet(nombre);
  if (sh.getLastRow() < 1) {
    sh.getRange(1, 1, 1, TAREAS_HEADERS_.length).setValues([TAREAS_HEADERS_]);
    estilizarTabla_(sh, TAREAS_HEADERS_.length, [320, 140, 100, 90, 110, 220, 120]);
  }
  aplicarDropdownsTareas_(sh);
  return sh;
}

/** Dropdowns de Estado y Prioridad (validación de datos). Best-effort: cosmético, nunca rompe. */
function aplicarDropdownsTareas_(sh) {
  try {
    var filas = 500;
    sh.getRange(2, 5, filas, 1).setDataValidation(
      SpreadsheetApp.newDataValidation().requireValueInList(ESTADOS_TAREA_, true).setAllowInvalid(false).build());
    sh.getRange(2, 4, filas, 1).setDataValidation(
      SpreadsheetApp.newDataValidation().requireValueInList(PRIORIDADES_TAREA_, true).setAllowInvalid(false).build());
  } catch (e) {
    if (typeof Logger !== 'undefined') Logger.log('tareas: no se pudo aplicar la validación (%s).', e);
  }
}

/** Id determinístico de una tarea (dedup del autopoblado). */
function idTarea_(texto, origen) {
  return slugBrain_(String(origen || '') + ' ' + String(texto || '')).slice(0, 60);
}

/**
 * Agrega una tarea si su Id no existe aún (idempotente: re-ingestar la misma nota no duplica).
 * @param {Object} t  { texto, proyecto?, vence?, prioridad?, estado?, origen? }
 * @return {boolean} true si se agregó
 */
function agregarTarea_(sheetId, config, t) {
  var sh = ensureTareasSheet_(sheetId, config);
  var id = idTarea_(t.texto, t.origen);

  if (sh.getLastRow() > 1) {
    var ids = sh.getRange(2, 7, sh.getLastRow() - 1, 1).getValues();
    for (var i = 0; i < ids.length; i++) {
      if (String(ids[i][0]) === id) return false;
    }
  }
  sh.getRange(sh.getLastRow() + 1, 1, 1, TAREAS_HEADERS_.length).setValues([[
    String(t.texto || '').trim(), t.proyecto || '', t.vence || '',
    t.prioridad || 'Media', t.estado || 'Pendiente', t.origen || '✍️ Manual', id
  ]]);
  return true;
}

/** Todas las filas de Tareas como objetos (fila 1-based incluida para escrituras). */
function listarTareas_(sheetId, config) {
  var ss = getSpreadsheet_(sheetId);
  var sh = ss.getSheetByName(nombreHojaTareas_(config));
  if (!sh || sh.getLastRow() < 2) return [];
  var rows = sh.getRange(2, 1, sh.getLastRow() - 1, TAREAS_HEADERS_.length).getValues();
  return rows.map(function (r, i) {
    return {
      fila: i + 2,
      texto: String(r[0] == null ? '' : r[0]).trim(),
      proyecto: String(r[1] == null ? '' : r[1]).trim(),
      vence: normFechaTarea_(r[2]),
      prioridad: String(r[3] == null ? '' : r[3]).trim() || 'Media',
      estado: String(r[4] == null ? '' : r[4]).trim() || 'Pendiente',
      origen: String(r[5] == null ? '' : r[5]).trim(),
      id: String(r[6] == null ? '' : r[6]).trim()
    };
  }).filter(function (t) { return t.texto; });
}

/** Normaliza la celda Vence a YYYY-MM-DD ('' si vacía). Acepta Date o texto ISO. */
function normFechaTarea_(v) {
  if (v instanceof Date) {
    var p2 = function (n) { return (n < 10 ? '0' : '') + n; };
    return v.getFullYear() + '-' + p2(v.getMonth() + 1) + '-' + p2(v.getDate());
  }
  var s = String(v == null ? '' : v).trim();
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : '';
}

/**
 * Pendientes para el briefing: estado ≠ Hecha, ordenadas atrasadas → hoy → resto.
 * Marca `hoy`, `atrasada` y `bloqueada` (esta última sube a la sección Urgente).
 */
function tareasPendientesHoy_(sheetId, config, todayISO) {
  var tareas = listarTareas_(sheetId, config)
    .filter(function (t) { return t.estado !== 'Hecha'; })
    .map(function (t) {
      t.hoy = !!t.vence && t.vence === todayISO;
      t.atrasada = !!t.vence && t.vence < todayISO;
      t.bloqueada = t.estado === 'Bloqueada';
      return t;
    });
  var peso = function (t) { return t.atrasada ? 0 : (t.hoy ? 1 : 2); };
  tareas.sort(function (a, b) { return peso(a) - peso(b); });
  return tareas;
}

/**
 * Mueve las filas "Hecha" a la pestaña Archivo (misma estructura + fecha de archivado).
 * Corre 1×/día dentro de la pasada del briefing. @return {number} filas archivadas
 */
function archivarHechas_(sheetId, config, todayISO) {
  var ss = getSpreadsheet_(sheetId);
  var sh = ss.getSheetByName(nombreHojaTareas_(config));
  if (!sh || sh.getLastRow() < 2) return 0;

  var rows = sh.getRange(2, 1, sh.getLastRow() - 1, TAREAS_HEADERS_.length).getValues();
  var vivas = [], hechas = [];
  rows.forEach(function (r) {
    if (!String(r[0] == null ? '' : r[0]).trim()) return;   // filas vacías se descartan
    if (String(r[4]).trim() === 'Hecha') hechas.push(r);
    else vivas.push(r);
  });
  if (!hechas.length) return 0;

  var arch = ss.getSheetByName(nombreHojaArchivo_(config));
  if (!arch) arch = ss.insertSheet(nombreHojaArchivo_(config));
  if (arch.getLastRow() < 1) {
    arch.getRange(1, 1, 1, TAREAS_HEADERS_.length + 1).setValues([TAREAS_HEADERS_.concat(['Archivada el'])]);
    estilizarTabla_(arch, TAREAS_HEADERS_.length + 1, [320, 140, 100, 90, 110, 220, 120, 110]);
  }
  var destino = hechas.map(function (r) { return r.concat([todayISO]); });
  arch.getRange(arch.getLastRow() + 1, 1, 1 * destino.length, TAREAS_HEADERS_.length + 1).setValues(destino);

  // Reescribe Tareas solo con las vivas (patrón guardarEquipo: clear + headers + filas).
  sh.clearContents();
  var values = [TAREAS_HEADERS_].concat(vivas);
  sh.getRange(1, 1, values.length, TAREAS_HEADERS_.length).setValues(values);
  estilizarTabla_(sh, TAREAS_HEADERS_.length, [320, 140, 100, 90, 110, 220, 120]);
  aplicarDropdownsTareas_(sh);
  return hechas.length;
}
