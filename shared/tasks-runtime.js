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

// Paleta de chips [fondo, texto] — la misma del mockup (morning-briefing-mockups.html).
var COLORES_ESTADO_ = {
  'Pendiente': ['#FEF3C7', '#92400E'],
  'En curso':  ['#DBEAFE', '#1E40AF'],
  'Bloqueada': ['#FEE2E2', '#991B1B'],
  'Hecha':     ['#DCFCE7', '#166534']
};
var COLORES_PRIORIDAD_ = {
  'Alta':  ['#EDE9FE', '#5B21B6'],
  'Media': ['#FEF3C7', '#92400E'],
  'Baja':  ['#F1F3F4', '#5F6368']
};

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

/**
 * Dropdowns (Estado/Prioridad), fecha en Vence (con picker de calendario al editar) y los chips
 * de color por formato condicional. Best-effort: cosmético, nunca rompe.
 */
function aplicarDropdownsTareas_(sh) {
  var filas = 500;
  try {
    sh.getRange(2, 5, filas, 1).setDataValidation(
      SpreadsheetApp.newDataValidation().requireValueInList(ESTADOS_TAREA_, true).setAllowInvalid(false).build());
    sh.getRange(2, 4, filas, 1).setDataValidation(
      SpreadsheetApp.newDataValidation().requireValueInList(PRIORIDADES_TAREA_, true).setAllowInvalid(false).build());
    // Vence: fecha editable — la validación de fecha activa el date-picker de Sheets al editar.
    sh.getRange(2, 3, filas, 1)
      .setDataValidation(SpreadsheetApp.newDataValidation().requireDate().setAllowInvalid(false).build())
      .setNumberFormat('yyyy-mm-dd');
  } catch (e) {
    if (typeof Logger !== 'undefined') Logger.log('tareas: no se pudo aplicar la validación (%s).', e);
  }
  try {
    var reglas = [];
    var agregar = function (col, mapa) {
      Object.keys(mapa).forEach(function (valor) {
        reglas.push(SpreadsheetApp.newConditionalFormatRule()
          .whenTextEqualTo(valor)
          .setBackground(mapa[valor][0]).setFontColor(mapa[valor][1])
          .setRanges([sh.getRange(2, col, filas, 1)])
          .build());
      });
    };
    agregar(5, COLORES_ESTADO_);
    agregar(4, COLORES_PRIORIDAD_);
    sh.setConditionalFormatRules(reglas);
  } catch (e) {
    if (typeof Logger !== 'undefined') Logger.log('tareas: no se pudo aplicar el color (%s).', e);
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

/**
 * Actualiza campos de una tarea por Id (estado/vence/prioridad/proyecto/texto). Valida enums.
 * @return {Object} la tarea actualizada (shape de listarTareas_)
 * @throws si el Id ya no está en la hoja (la fila se borró/archivó a mano): el caller muestra
 *         el error y recarga — la hoja es la fuente de verdad, jamás se recrea en silencio.
 */
function actualizarTarea_(sheetId, config, id, campos) {
  campos = campos || {};
  var t = null;
  var tareas = listarTareas_(sheetId, config);
  for (var i = 0; i < tareas.length; i++) if (tareas[i].id === String(id)) { t = tareas[i]; break; }
  if (!t) throw new Error('La tarea ya no está en la hoja Tareas (¿se borró o archivó?). Recarga el modal.');

  if (campos.estado != null && ESTADOS_TAREA_.indexOf(campos.estado) === -1) {
    throw new Error('Estado inválido: "' + campos.estado + '".');
  }
  if (campos.prioridad != null && PRIORIDADES_TAREA_.indexOf(campos.prioridad) === -1) {
    throw new Error('Prioridad inválida: "' + campos.prioridad + '".');
  }
  if (campos.vence != null && String(campos.vence) !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(String(campos.vence))) {
    throw new Error('Fecha inválida: "' + campos.vence + '" (usa YYYY-MM-DD o vacío).');
  }

  var sh = getSpreadsheet_(sheetId).getSheetByName(nombreHojaTareas_(config));
  if (campos.texto != null && String(campos.texto).trim()) { t.texto = String(campos.texto).trim(); sh.getRange(t.fila, 1).setValue(t.texto); }
  if (campos.proyecto != null) { t.proyecto = String(campos.proyecto).trim(); sh.getRange(t.fila, 2).setValue(t.proyecto); }
  if (campos.vence != null) { t.vence = String(campos.vence); sh.getRange(t.fila, 3).setValue(t.vence); }
  if (campos.prioridad != null) { t.prioridad = campos.prioridad; sh.getRange(t.fila, 4).setValue(t.prioridad); }
  if (campos.estado != null) { t.estado = campos.estado; sh.getRange(t.fila, 5).setValue(t.estado); }
  return t;
}

/**
 * Archiva UNA tarea por Id (cualquier estado: "esto ya no aplica" existe en la vida real).
 * Mueve la fila a Archivo con 'Archivada el' = hoy y anota el espejo del wiki. @return {boolean}
 */
function archivarTarea_(sheetId, config, id, todayISO) {
  var ss = getSpreadsheet_(sheetId);
  var sh = ss.getSheetByName(nombreHojaTareas_(config));
  if (!sh || sh.getLastRow() < 2) throw new Error('La hoja Tareas está vacía.');

  var rows = sh.getRange(2, 1, sh.getLastRow() - 1, TAREAS_HEADERS_.length).getValues();
  var fila = -1, row = null;
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][6]) === String(id)) { fila = i + 2; row = rows[i]; break; }
  }
  if (fila === -1) throw new Error('La tarea ya no está en la hoja Tareas (¿se borró o archivó?). Recarga el modal.');

  var arch = ss.getSheetByName(nombreHojaArchivo_(config));
  if (!arch) arch = ss.insertSheet(nombreHojaArchivo_(config));
  if (arch.getLastRow() < 1) {
    arch.getRange(1, 1, 1, TAREAS_HEADERS_.length + 1).setValues([TAREAS_HEADERS_.concat(['Archivada el'])]);
    estilizarTabla_(arch, TAREAS_HEADERS_.length + 1, [320, 140, 100, 90, 110, 220, 120, 110]);
  }
  arch.getRange(arch.getLastRow() + 1, 1, 1, TAREAS_HEADERS_.length + 1).setValues([row.concat([todayISO])]);
  marcarTareaArchivadaWiki_(sheetId, config, row, todayISO);

  // Quita la fila con el patrón clear + rewrite de archivarHechas_ (idéntico en tests y GAS).
  var vivas = rows.filter(function (r, i) { return i + 2 !== fila && String(r[0] == null ? '' : r[0]).trim(); });
  sh.clearContents();
  var values = [TAREAS_HEADERS_].concat(vivas);
  sh.getRange(1, 1, values.length, TAREAS_HEADERS_.length).setValues(values);
  estilizarTabla_(sh, TAREAS_HEADERS_.length, [320, 140, 100, 90, 110, 220, 120]);
  aplicarDropdownsTareas_(sh);
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
 * Higiene diaria de la hoja Tareas: formato idempotente + espejo al wiki + archivado de Hechas.
 * La llama el dispatcher 1×/día (guarda 'tareas-hig'); antes vivía dentro del envío del briefing.
 */
function runTareasHygiene_(sheetId, config, todayISO) {
  ensureTareasSheet_(sheetId, config);
  try { sincronizarTareasWiki_(sheetId, config, todayISO); } catch (e) {
    if (typeof Logger !== 'undefined') Logger.log('tareas: sync al wiki falló (%s).', e);
  }
  archivarHechas_(sheetId, config, todayISO);
}

// --- Espejo en el brain: wiki/tasks/ (trazabilidad de las tareas del líder) ---

/**
 * Sincroniza la hoja Tareas hacia wiki/tasks/ (una página por tarea, frontmatter con el estado
 * actual y una sección "## Historial" append-only con cada cambio de estado/vencimiento). El
 * briefing sigue leyendo la HOJA (fuente editable); el wiki es la memoria trazable que el brain
 * puede cruzar. Requiere brain.enabled; sin brain es un no-op silencioso.
 * @return {number} páginas creadas o actualizadas
 */
function sincronizarTareasWiki_(sheetId, config, todayISO) {
  if (!(config.brain && config.brain.enabled)) return 0;
  var root;
  try { root = ensureBrainFolder_(sheetId, config); } catch (e) { return 0; }
  var carpeta = carpetaBrain_(root, ['wiki', 'tasks']);

  var cambios = 0;
  listarTareas_(sheetId, config).forEach(function (t) {
    if (upsertTareaWiki_(carpeta, t, todayISO)) cambios++;
  });
  if (cambios) regenerarIndexBrain_(root, todayISO);
  return cambios;
}

/** Crea/actualiza la página de UNA tarea; anota el historial solo cuando algo cambió. */
function upsertTareaWiki_(carpeta, t, todayISO) {
  var name = t.id + '.md';
  var prev = leerArchivoBrain_(carpeta, name);

  if (!prev) {
    var fm = {
      page_type: 'task', name: t.texto, project: t.proyecto, due: t.vence,
      priority: t.prioridad, status: t.estado, origin: t.origen,
      created: todayISO, last_updated: todayISO
    };
    var body = '# ' + t.texto + '\n\n## Historial\n- [' + todayISO + '] creada (' + t.estado +
      (t.vence ? ', vence ' + t.vence : '') + ')\n';
    escribirArchivoBrain_(carpeta, name, componerPagina_(fm, body));
    return true;
  }

  var page = parsearPagina_(prev);
  var f = page.frontmatter || {};
  var lineas = [];
  if (str_(f.status) !== t.estado) lineas.push('estado: ' + (str_(f.status) || '?') + ' → ' + t.estado);
  if (str_(f.due) !== t.vence) lineas.push('vence: ' + (str_(f.due) || '—') + ' → ' + (t.vence || '—'));
  if (str_(f.priority) !== t.prioridad) lineas.push('prioridad: ' + (str_(f.priority) || '?') + ' → ' + t.prioridad);
  if (!lineas.length) return false;

  var fm2 = mergeFrontmatter_(f, {
    status: t.estado, due: t.vence, priority: t.prioridad, project: t.proyecto, last_updated: todayISO
  });
  var body2 = page.body + lineas.map(function (l) { return '- [' + todayISO + '] ' + l + '\n'; }).join('');
  escribirArchivoBrain_(carpeta, name, componerPagina_(fm2, body2));
  return true;
}

/** Marca en el wiki que la tarea se archivó (status Hecha + archived). Best-effort. */
function marcarTareaArchivadaWiki_(sheetId, config, fila, todayISO) {
  if (!(config.brain && config.brain.enabled)) return;
  try {
    var root = ensureBrainFolder_(sheetId, config);
    var carpeta = carpetaBrain_(root, ['wiki', 'tasks']);
    var name = String(fila[6] || '') + '.md';
    var prev = leerArchivoBrain_(carpeta, name);
    if (!prev) return;
    var page = parsearPagina_(prev);
    var fm = mergeFrontmatter_(page.frontmatter, { status: 'Hecha', archived: true, last_updated: todayISO });
    escribirArchivoBrain_(carpeta, name,
      componerPagina_(fm, page.body + '- [' + todayISO + '] archivada\n'));
    regenerarIndexBrain_(root, todayISO);   // la tarea sale de "activas" en el índice
  } catch (e) {
    if (typeof Logger !== 'undefined') Logger.log('tareas: no se pudo marcar el archivo en el wiki (%s).', e);
  }
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
  hechas.forEach(function (r) { marcarTareaArchivadaWiki_(sheetId, config, r, todayISO); });

  // Reescribe Tareas solo con las vivas (patrón guardarEquipo: clear + headers + filas).
  sh.clearContents();
  var values = [TAREAS_HEADERS_].concat(vivas);
  sh.getRange(1, 1, values.length, TAREAS_HEADERS_.length).setValues(values);
  estilizarTabla_(sh, TAREAS_HEADERS_.length, [320, 140, 100, 90, 110, 220, 120]);
  aplicarDropdownsTareas_(sh);
  return hechas.length;
}
