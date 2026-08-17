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

// R3: 'Espera de' (de quién depende), 'Link' (doc/PR) y 'EventId' (Calendar, ligadas exactas).
// La migración de hojas existentes es idempotente por encabezado (migrarHeadersTareas_).
var TAREAS_HEADERS_ = ['Tarea', 'Proyecto', 'Vence', 'Prioridad', 'Estado', 'Origen', 'Id', 'Espera de', 'Link', 'EventId', 'Creada el'];
var ANCHOS_TAREAS_ = [320, 140, 100, 90, 110, 220, 120, 110, 180, 120, 100];

/**
 * Fecha REAL de creación desde el sufijo del Origen ('🎥 Título · YYYY-MM-DD'), determinista.
 * El sufijo lo escribe nuestro código, por eso la regex va ANCLADA al final: una fecha dentro
 * del título del doc (otro formato) no matchea. '' si el origen no trae sufijo.
 */
function fechaDeOrigen_(origen) {
  var m = /·\s*(\d{4}-\d{2}-\d{2})\s*$/.exec(String(origen == null ? '' : origen));
  return m ? m[1] : '';
}
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
    estilizarTabla_(sh, TAREAS_HEADERS_.length, ANCHOS_TAREAS_);
  } else {
    migrarHeadersTareas_(sh);
  }
  var roster = [];
  try { roster = getRoster_(sheetId, config.sheets.roster).map(function (p) { return p.nombre || p.correo; }); } catch (e) { roster = []; }
  aplicarDropdownsTareas_(sh, roster);
  return sh;
}

/**
 * Migración R3 idempotente por nombre de encabezado: si la fila 1 no coincide con el contrato
 * (hoja creada por una versión vieja de 7 columnas), reescribe SOLO los encabezados — los datos
 * quedan intactos y las columnas nuevas nacen vacías. Corre en cada ensure (higiene diaria).
 */
function migrarHeadersTareas_(sh) {
  var actuales = sh.getRange(1, 1, 1, TAREAS_HEADERS_.length).getValues()[0]
    .map(function (v) { return String(v == null ? '' : v).trim(); });
  var iguales = TAREAS_HEADERS_.every(function (hdr, i) { return actuales[i] === hdr; });
  if (iguales) return false;
  sh.getRange(1, 1, 1, TAREAS_HEADERS_.length).setValues([TAREAS_HEADERS_]);
  estilizarTabla_(sh, TAREAS_HEADERS_.length, ANCHOS_TAREAS_);
  return true;
}

/**
 * Dropdowns (Estado/Prioridad), fecha en Vence (con picker de calendario al editar) y los chips
 * de color por formato condicional. Best-effort: cosmético, nunca rompe.
 */
function aplicarDropdownsTareas_(sh, rosterNombres) {
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
    // R3 · Espera de: dropdown con el roster pero PERMISIVO (allowInvalid) — un externo o un
    // área ("Finanzas") también son esperas legítimas.
    if (rosterNombres && rosterNombres.length) {
      sh.getRange(2, 8, filas, 1).setDataValidation(
        SpreadsheetApp.newDataValidation().requireValueInList(rosterNombres, true).setAllowInvalid(true).build());
    }
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

/** Asegura/migra el encabezado de Archivo (contrato Tareas + 'Archivada el'). Idempotente. */
function migrarHeadersArchivo_(arch) {
  var headers = TAREAS_HEADERS_.concat(['Archivada el']);
  if (arch.getLastRow() < 1) {
    arch.getRange(1, 1, 1, headers.length).setValues([headers]);
    estilizarTabla_(arch, headers.length, ANCHOS_TAREAS_.concat([110]));
    return;
  }
  var actuales = arch.getRange(1, 1, 1, headers.length).getValues()[0]
    .map(function (v) { return String(v == null ? '' : v).trim(); });
  if (!headers.every(function (h, i) { return actuales[i] === h; })) {
    arch.getRange(1, 1, 1, headers.length).setValues([headers]);
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
  // 'Creada el': explícita > fecha del sufijo del Origen (reunión real) > hoy.
  var creada = t.creada || fechaDeOrigen_(t.origen || '') || hoyISO_(config);
  sh.getRange(sh.getLastRow() + 1, 1, 1, TAREAS_HEADERS_.length).setValues([[
    String(t.texto || '').trim(), t.proyecto || '', t.vence || '',
    t.prioridad || 'Media', t.estado || 'Pendiente', t.origen || '✍️ Manual', id,
    t.espera || '', t.link || '', t.eventId || '', creada
  ]]);
  cacheInvalidar_(sheetId, CACHE_MISEGUIMIENTO_);
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
  if (campos.espera != null) { t.espera = String(campos.espera).trim(); sh.getRange(t.fila, 8).setValue(t.espera); }
  if (campos.link != null) { t.link = String(campos.link).trim(); sh.getRange(t.fila, 9).setValue(t.link); }
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
  migrarHeadersArchivo_(arch);
  arch.getRange(arch.getLastRow() + 1, 1, 1, TAREAS_HEADERS_.length + 1).setValues([row.concat([todayISO])]);
  marcarTareaArchivadaWiki_(sheetId, config, row, todayISO);

  // Quita la fila con el patrón clear + rewrite de archivarHechas_ (idéntico en tests y GAS).
  var vivas = rows.filter(function (r, i) { return i + 2 !== fila && String(r[0] == null ? '' : r[0]).trim(); });
  sh.clearContents();
  var values = [TAREAS_HEADERS_].concat(vivas);
  sh.getRange(1, 1, values.length, TAREAS_HEADERS_.length).setValues(values);
  estilizarTabla_(sh, TAREAS_HEADERS_.length, ANCHOS_TAREAS_);
  aplicarDropdownsTareas_(sh);
  cacheInvalidar_(sheetId, CACHE_MISEGUIMIENTO_);
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
      id: String(r[6] == null ? '' : r[6]).trim(),
      espera: String(r[7] == null ? '' : r[7]).trim(),
      link: String(r[8] == null ? '' : r[8]).trim(),
      eventId: String(r[9] == null ? '' : r[9]).trim(),
      creada: normFechaTarea_(r[10])
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

// --- Índice _tasks.json (R2): agregados de Tendencia en 1 lectura de Drive ---
//
// Índice CRUDO por tarea (decisión del grill: campos mínimos, las series se agregan al cargar):
//   id → { proyecto, prioridad, origen, estado, vence, created, hecha, archivada, posp }
// Se actualiza en el sync diario, en cada mutación del modal y al archivar. Si falta o se
// corrompe, se reconstruye desde las páginas de wiki/tasks (N lecturas, una sola vez).

function cargarIndiceTareas_(root) {
  var raw = leerArchivoBrain_(carpetaBrain_(root, ['wiki', 'tasks']), '_tasks.json');
  if (!raw) return null;
  try { var o = JSON.parse(raw); return (o && typeof o === 'object') ? o : null; } catch (e) { return null; }
}

function guardarIndiceTareas_(root, mapa) {
  escribirArchivoBrain_(carpetaBrain_(root, ['wiki', 'tasks']), '_tasks.json', JSON.stringify(mapa, null, 2));
}

/** Upsert de N tareas en el índice (carga 1 vez, aplica todas, guarda 1 vez). */
function indexarTareas_(root, tareas, todayISO) {
  var mapa = cargarIndiceTareas_(root) || {};
  (tareas || []).forEach(function (t) {
    var creadaReal = t.creada || fechaDeOrigen_(t.origen) || todayISO;
    var e = mapa[t.id];
    if (!e) e = mapa[t.id] = { created: creadaReal, hecha: '', archivada: '', posp: 0, vence: '', estado: '' };
    if (creadaReal < e.created) e.created = creadaReal;                 // autocuración retroactiva
    if (e.vence && t.vence !== e.vence) e.posp++;                       // re-fecha = pospuesta
    if (t.estado === 'Hecha' && e.estado !== 'Hecha') e.hecha = todayISO;
    if (t.estado !== 'Hecha' && e.estado === 'Hecha') e.hecha = '';     // reabierta
    e.proyecto = t.proyecto; e.prioridad = t.prioridad; e.origen = t.origen;
    e.estado = t.estado; e.vence = t.vence;
  });
  guardarIndiceTareas_(root, mapa);
}

/** Marca la fecha de archivado (la tarea sale de "abiertas" en las series desde ese día). */
function indexarArchivada_(root, id, todayISO) {
  var mapa = cargarIndiceTareas_(root) || {};
  var e = mapa[String(id)];
  if (!e) return;
  e.archivada = todayISO;
  if (e.estado === 'Hecha' && !e.hecha) e.hecha = todayISO;
  guardarIndiceTareas_(root, mapa);
}

/**
 * Reconstruye el índice desde las páginas de wiki/tasks (fallback: _tasks.json ausente o roto).
 * created/estado/etc. salen del frontmatter; posp y la fecha de Hecha, del ## Historial.
 * @return {Object} el mapa reconstruido (ya persistido)
 */
function reconstruirIndiceTareas_(root) {
  var mapa = {};
  listarArchivosBrain_(carpetaBrain_(root, ['wiki', 'tasks']), '.md').forEach(function (a) {
    if (a.name.charAt(0) === '_') return;
    var page = parsearPagina_(a.content);
    var fm = page.frontmatter || {};
    var id = a.name.replace(/\.md$/, '');
    var hecha = '', archivada = '', posp = 0;
    parseBodySections_(page.body).sections.forEach(function (s) {
      if (s.name !== 'Historial') return;
      s.lines.forEach(function (l) {
        var f = /^-\s*\[(\d{4}-\d{2}-\d{2})\]\s*(.*)$/.exec(l.trim());
        if (!f) return;
        if (/^vence:/.test(f[2])) posp++;
        if (/→\s*Hecha/.test(f[2])) hecha = f[1];
        if (/^archivada/.test(f[2])) archivada = f[1];
      });
    });
    mapa[id] = {
      proyecto: str_(fm.project), prioridad: str_(fm.priority) || 'Media',
      origen: str_(fm.origin), estado: str_(fm.status) || 'Pendiente', vence: str_(fm.due),
      created: str_(fm.created), hecha: hecha, archivada: archivada, posp: posp
    };
  });
  guardarIndiceTareas_(root, mapa);
  return mapa;
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
  var tareas = listarTareas_(sheetId, config);
  tareas.forEach(function (t) {
    if (upsertTareaWiki_(carpeta, t, todayISO)) cambios++;
  });
  // Índice de Tendencia (R2): 1 carga + 1 escritura por pasada, pase lo que pase con `cambios`
  // (las tareas nuevas necesitan su entrada aunque su página también sea nueva).
  try { indexarTareas_(root, tareas, todayISO); } catch (e) {
    if (typeof Logger !== 'undefined') Logger.log('tareas: índice _tasks.json falló (%s).', e);
  }
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
      waiting_on: t.espera || '', link: t.link || '', event_id: t.eventId || '',
      created: t.creada || fechaDeOrigen_(t.origen) || todayISO, last_updated: todayISO
    };
    var body = '# ' + t.texto + '\n\n## Historial\n- [' + todayISO + '] creada (' + t.estado +
      (t.vence ? ', vence ' + t.vence : '') + ')\n' +
      (t.espera ? '- [' + todayISO + '] espera de: ' + t.espera + '\n' : '');
    escribirArchivoBrain_(carpeta, name, componerPagina_(fm, body));
    return true;
  }

  var page = parsearPagina_(prev);
  var f = page.frontmatter || {};
  var lineas = [];
  if (str_(f.status) !== t.estado) lineas.push('estado: ' + (str_(f.status) || '?') + ' → ' + t.estado);
  if (str_(f.due) !== t.vence) lineas.push('vence: ' + (str_(f.due) || '—') + ' → ' + (t.vence || '—'));
  if (str_(f.priority) !== t.prioridad) lineas.push('prioridad: ' + (str_(f.priority) || '?') + ' → ' + t.prioridad);
  // R3 · Espera de: la línea del historial es la fuente de los días del pill "⏳ · Nd".
  if (str_(f.waiting_on) !== (t.espera || '')) lineas.push('espera de: ' + (t.espera || '—'));
  // Autocuración del created: páginas nacidas en el primer sync llevan la fecha del sync, no la
  // real de la tarea ('Creada el' / sufijo del Origen). Se corrige sin línea de historial.
  var creadaReal = t.creada || fechaDeOrigen_(t.origen);
  var fixCreated = !!(creadaReal && (!str_(f.created) || creadaReal < str_(f.created)));
  if (!lineas.length && !fixCreated) return false;

  var fm2 = mergeFrontmatter_(f, {
    status: t.estado, due: t.vence, priority: t.prioridad, project: t.proyecto,
    waiting_on: t.espera || '', link: t.link || '', last_updated: todayISO
  });
  if (fixCreated) fm2.created = creadaReal;
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
    indexarArchivada_(root, String(fila[6] || ''), todayISO);   // Tendencia: sale de "abiertas"
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
  migrarHeadersArchivo_(arch);
  var destino = hechas.map(function (r) { return r.concat([todayISO]); });
  arch.getRange(arch.getLastRow() + 1, 1, 1 * destino.length, TAREAS_HEADERS_.length + 1).setValues(destino);
  hechas.forEach(function (r) { marcarTareaArchivadaWiki_(sheetId, config, r, todayISO); });

  // Reescribe Tareas solo con las vivas (patrón guardarEquipo: clear + headers + filas).
  sh.clearContents();
  var values = [TAREAS_HEADERS_].concat(vivas);
  sh.getRange(1, 1, values.length, TAREAS_HEADERS_.length).setValues(values);
  estilizarTabla_(sh, TAREAS_HEADERS_.length, ANCHOS_TAREAS_);
  aplicarDropdownsTareas_(sh);
  cacheInvalidar_(sheetId, CACHE_MISEGUIMIENTO_);
  return hechas.length;
}
