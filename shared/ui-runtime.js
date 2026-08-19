/**
 * ui-runtime.js — UI de CoS servida desde la librería (menú, sidebar, diálogos) + router
 * genérico del server-API del sidebar.
 *
 * El stub queda como "bootloader": onOpen/abrirSidebar/abrirDialogo/cosRun solo delegan aquí,
 * así que el menú, el HTML del sidebar y los diálogos nuevos viajan por VERSIÓN de la librería
 * sin re-copiar el Sheet padre.
 *
 * Restricciones de plataforma que moldean el diseño:
 *  - Los handlers de ítems de menú y los callbacks de google.script.run SIEMPRE resuelven en el
 *    scope del stub (no admiten CoSLib.fn ni argumentos). Por eso construirMenu apunta a NOMBRES
 *    de funciones del stub, y el server-API pasa por el puente genérico cosRun→dispatch.
 *  - HtmlService.createHtmlOutputFromFile carga el archivo del proyecto que EJECUTA la llamada:
 *    como esto corre en la librería, buildSidebar/buildDialog cargan los .html de la librería.
 *
 * Sin import/export: runtime de Apps Script. Privados con sufijo "_".
 */

// --- Menú (lo construye la librería; los ítems apuntan a funciones del stub por nombre) ---

/**
 * Arma el menú CoS. Lo llama el trigger simple `onOpen` del stub, por eso SOLO puede usar `Ui`
 * (sin servicios que requieran autorización). Para agregar/relabelar/reordenar ítems basta
 * editar esto y publicar versión: el cambio llega al líder sin tocar su copia.
 *
 * Los ítems targetean funciones del stub por nombre: 'abrirSidebar' y los slots
 * pre-provisionados 'cosMenu1'..'cosMenu5' (cuya acción se define en menuAction).
 *
 * 'Formularios' apunta al slot 'cosMenu1', cuya acción (MENU_ACTIONS_) abre el modal de
 * preguntas: los ítems de menú no admiten argumentos, por eso no puede targetear abrirDialogo.
 *
 * @param {Ui} ui  SpreadsheetApp.getUi(), pasado por el stub
 */
// El menú nativo de Sheets solo admite TEXTO en los ítems (sin HTML/SVG/imágenes): los "íconos"
// van como emoji.
function construirMenu(ui) {
  ui.createMenu('CoS')
    .addItem('⚙️ Configurar', 'abrirSidebar')
    .addItem('📝 Formularios', 'cosMenu1')
    .addItem('📤 Compartir reportes', 'cosMenu2')
    .addItem('☀️ Morning Briefing', 'cosMenu3')
    .addItem('👥 Seguimiento del equipo', 'cosMenu4')
    .addItem('🎯 Mi seguimiento', 'cosMenu5')
    .addToUi();
}

// --- Sidebar / diálogos (el HTML vive en la librería) ---

/** Construye el sidebar desde el HTML de la librería (shared/Sidebar.html). */
function buildSidebar() {
  return HtmlService.createHtmlOutputFromFile('Sidebar')
    .setTitle('CoS — Configuración');
}

/** Diálogos modales registrados (además del sidebar). Registrar aquí uno nuevo lo hace llegar
 *  al líder por versión de librería: el stub ya tiene un abridor genérico (abrirDialogo). */
var DIALOGOS_ = {
  // Editor de preguntas + generación por IA (shared/DialogPreguntas.html).
  preguntas: { archivo: 'DialogPreguntas', titulo: 'CoS — Preguntas y formularios', ancho: 760, alto: 660 },
  // Matriz de compartir reportes: consolidado completo + destinatarios por persona.
  compartir: { archivo: 'DialogCompartir', titulo: 'CoS — Compartir reportes', ancho: 640, alto: 580 },
  // Morning Briefing: config con vista previa en vivo.
  briefing: { archivo: 'DialogBriefing', titulo: 'CoS — Morning Briefing', ancho: 760, alto: 640 },
  // Seguimiento del equipo: salud por persona, timeline y dashboards (solo lectura + cierre de pendientes).
  seguimiento: { archivo: 'DialogSeguimiento', titulo: 'CoS — Seguimiento del equipo', ancho: 760, alto: 680 },
  // Mi seguimiento: las tareas del PROPIO líder (Hoy/Tareas/Tablero + creación) sobre la hoja Tareas.
  miseguimiento: { archivo: 'DialogMiSeguimiento', titulo: 'CoS — Mi seguimiento', ancho: 760, alto: 680 },
  // Guía del CoS: onboarding paso a paso, MODELESS (no bloquea la hoja). Se abre desde el sidebar.
  asistente: { archivo: 'DialogAsistente', titulo: 'CoS — Guía del CoS', ancho: 460, alto: 640, modeless: true },
  // Centro del Brain: curar wiki (renombrar/cerrar/olvidar), fusionar y salud. MODELESS (no bloquea la hoja).
  braincentro: { archivo: 'DialogBrainCentro', titulo: 'CoS — Centro del Brain', ancho: 860, alto: 680, modeless: true },
  // Telegram: guía modeless para onboarding; el token queda en Script Properties y nunca se vuelve a mostrar.
  telegram: { archivo: 'DialogTelegram', titulo: 'CoS — Guía para conectar Telegram', ancho: 540, alto: 720, modeless: true },
  // Vera-MCP: conectar el CoS a Claude/ChatGPT (pairing-code → Worker). MODELESS.
  mcp: { archivo: 'DialogMcp', titulo: 'CoS — Conectar Claude/ChatGPT', ancho: 560, alto: 640, modeless: true }
};

// --- Asistente (Guía del CoS): pasos auto-detectados + apertura de destinos ---

// Pasos 1..8 (los textos viven en DialogAsistente.html). La mayoría se AUTO-detecta del estado
// real de la copia; solo los pasos "de uso" (revisar Horarios, conocer los tableros) se marcan
// a mano y se persisten en Ajustes.
var ASISTENTE_PASOS_MANUALES_ = { 3: true, 8: true };

/** Estado de la guía: qué pasos están hechos (auto-detección honesta contra la copia). Público. */
function cargarAsistente(sheetId, config) {
  var aj = getAjustes_(sheetId, config.sheets.settings);
  var roster = [];
  try { roster = getRoster_(sheetId, config.sheets.roster); } catch (e) { roster = []; }
  var manuales = {};
  (aj.asistente.hechos || []).forEach(function (n) { manuales[n] = true; });
  var auto = {
    1: roster.length > 0,                                     // equipo con al menos una persona
    2: !!(aj.forms.dailyUrl && aj.forms.weeklyUrl),           // ambos formularios creados
    4: !!(aj.leader && aj.leader.email),                      // líder con correo
    5: aj.brain.enabled,                                      // memoria activada
    6: aj.meet.enabled,                                       // notas de Meet activadas
    7: aj.briefing.enabled                                    // briefing activado
  };
  var pasos = [];
  for (var id = 1; id <= 8; id++) {
    pasos.push({
      id: id,
      manual: !!ASISTENTE_PASOS_MANUALES_[id],
      hecho: ASISTENTE_PASOS_MANUALES_[id] ? !!manuales[id] : !!auto[id]
    });
  }
  return { pasos: pasos };
}

/** Marca/desmarca un paso MANUAL de la guía (los auto-detectados no se pueden fingir). Público. */
function marcarPasoAsistente(sheetId, config, id, hecho) {
  var n = parseInt(id, 10);
  if (!ASISTENTE_PASOS_MANUALES_[n]) {
    throw new Error('Ese paso se marca solo cuando lo completes de verdad.');
  }
  var aj = getAjustes_(sheetId, config.sheets.settings);
  var set = {};
  (aj.asistente.hechos || []).forEach(function (x) { set[x] = true; });
  if (hecho) set[n] = true; else delete set[n];
  setAjustes_(sheetId, config.sheets.settings, {
    'asistente.hechos': Object.keys(set).map(Number).sort().join(',')
  });
  return { ok: true };
}

/** Abre la Guía como diálogo MODELESS: el líder puede seguir usando la hoja. Público. */
function abrirGuia(sheetId, config) {
  var d = buildDialog('asistente');
  SpreadsheetApp.getUi().showModelessDialog(d.html, d.titulo);
  return { ok: true };
}

/** Abre el Centro del Brain como diálogo MODELESS: curar la wiki sin bloquear la hoja. Público. */
function abrirBrainCentro(sheetId, config) {
  var d = buildDialog('braincentro');
  SpreadsheetApp.getUi().showModelessDialog(d.html, d.titulo);
  return { ok: true };
}

/** Abre la guía de conexión Telegram sin bloquear la hoja. Público. */
function abrirTelegram(sheetId, config) {
  var d = buildDialog('telegram');
  SpreadsheetApp.getUi().showModelessDialog(d.html, d.titulo);
  return { ok: true };
}

/** Abre la guía para conectar el CoS a Claude/ChatGPT (Vera-MCP) sin bloquear la hoja. Público. */
function abrirMcp(sheetId, config) {
  var d = buildDialog('mcp');
  SpreadsheetApp.getUi().showModelessDialog(d.html, d.titulo);
  return { ok: true };
}

/**
 * "Llévame ahí" de la guía: abre el sidebar o un modal registrado. OJO: Sheets solo permite un
 * diálogo a la vez — abrir un modal cierra la guía (el sidebar sí convive). Público.
 */
function abrirDesdeAsistente(sheetId, config, destino) {
  var ui = SpreadsheetApp.getUi();
  if (destino === 'sidebar') { ui.showSidebar(buildSidebar()); return { ok: true }; }
  var d = buildDialog(destino);
  ui.showModalDialog(d.html, d.titulo);
  return { ok: true };
}

/**
 * Construye un diálogo modal por nombre. El stub lo muestra con showModalDialog.
 * @param {string} nombre  clave en DIALOGOS_
 * @return {{html:HtmlOutput, titulo:string}}
 */
function buildDialog(nombre) {
  var d = DIALOGOS_[nombre];
  if (!d) throw new Error('Diálogo desconocido: ' + nombre);
  return {
    html: HtmlService.createHtmlOutputFromFile(d.archivo)
      .setWidth(d.ancho || 600).setHeight(d.alto || 400),
    titulo: d.titulo || 'CoS'
  };
}

// --- Acciones de los slots de menú pre-provisionados ---

/** Acciones registradas para los slots 'cosMenu1'..'cosMenu5' que el stub reserva. Vacío por
 *  ahora: asignar aquí una acción la hace llegar al líder por versión (sin tocar su copia). */
var MENU_ACTIONS_ = {
  // 'Formularios' → abre el modal de preguntas. Mostrar el diálogo desde la librería funciona
  // porque la acción se ejecuta en el contexto del contenedor (invocada por el ítem de menú).
  cosMenu1: function (sheetId, config) {
    var d = buildDialog('preguntas');
    SpreadsheetApp.getUi().showModalDialog(d.html, d.titulo);
  },
  // 'Compartir reportes' → matriz de destinatarios (consolidado + por persona).
  cosMenu2: function (sheetId, config) {
    var d = buildDialog('compartir');
    SpreadsheetApp.getUi().showModalDialog(d.html, d.titulo);
  },
  // 'Morning Briefing' → config con vista previa.
  cosMenu3: function (sheetId, config) {
    var d = buildDialog('briefing');
    SpreadsheetApp.getUi().showModalDialog(d.html, d.titulo);
  },
  // 'Seguimiento del equipo' → salud/timeline/dashboards.
  cosMenu4: function (sheetId, config) {
    var d = buildDialog('seguimiento');
    SpreadsheetApp.getUi().showModalDialog(d.html, d.titulo);
  },
  // 'Mi seguimiento' → tareas del líder (Hoy/Tareas/Tablero + creación híbrida).
  cosMenu5: function (sheetId, config) {
    var d = buildDialog('miseguimiento');
    SpreadsheetApp.getUi().showModalDialog(d.html, d.titulo);
  }
};

/**
 * Ejecuta la acción asignada a un slot de menú pre-provisionado.
 * @param {string} slot     'cosMenu1'..'cosMenu5'
 * @param {string} sheetId
 * @param {Object} config
 */
function menuAction(slot, sheetId, config) {
  var fn = MENU_ACTIONS_[slot];
  if (!fn) throw new Error('Acción de menú no asignada: ' + slot);
  return fn(sheetId, config);
}

// --- Router genérico del server-API del sidebar (puente cosRun del stub) ---

/**
 * Adaptadores nombre→función para las llamadas del sidebar. El stub expone UN solo puente
 * `cosRun(fnName, argsJson)`; así una función de servidor nueva para el sidebar se registra
 * aquí y llega al líder por versión, sin nuevo wrapper en el stub.
 *
 * Las 6 funciones actuales conservan además su wrapper nombrado en el stub (compatibilidad con
 * el Sidebar.html vigente). Convención para funciones NUEVAS: fn(sheetId, config, ...args).
 */
var DISPATCH_ = {
  cargarConfig:         function (sid, cfg, a) { return cargarConfig(sid, cfg); },
  configurarFormulario: function (sid, cfg, a) { return configurarFormulario(a[0], a[1], sid, cfg); },
  guardarPrompts:       function (sid, cfg, a) { return guardarPrompts(sid, cfg, a[0]); },
  guardarHorarios:      function (sid, cfg, a) { return guardarHorarios(sid, cfg, a[0]); },
  guardarEquipo:        function (sid, cfg, a) { return guardarEquipo(sid, cfg, a[0]); },
  guardarLeader:        function (sid, cfg, a) { return guardarLeader(sid, cfg, a[0]); },
  // Modal de preguntas (convención nueva fn(sheetId, config, ...args)):
  generarPreguntasIA:   function (sid, cfg, a) { return generarPreguntasIA(sid, cfg, a[0], a[1]); },
  guardarFormulario:    function (sid, cfg, a) { return guardarFormulario(sid, cfg, a[0], a[1]); },
  // Deep Prep: listar reuniones próximas del calendario y marcarlas para prep.
  listarReunionesProximas: function (sid, cfg, a) { return listarReunionesProximas(sid, cfg, a[0]); },
  toggleReunionPrep:       function (sid, cfg, a) { return toggleReunionPrep(sid, cfg, a[0], a[1]); },
  // Brain admin/gobernanza: visor de la wiki, merge de proyectos, flags y "olvidar".
  listarWikiPaginas:       function (sid, cfg, a) { return listarWikiPaginas(sid, cfg, a[0]); },
  leerWikiPagina:          function (sid, cfg, a) { return leerWikiPagina(sid, cfg, a[0], a[1]); },
  mergearProyectos:        function (sid, cfg, a) { return mergearProyectos(sid, cfg, a[0], a[1]); },
  guardarFlags:            function (sid, cfg, a) { return guardarFlags(sid, cfg, a[0]); },
  olvidarPersona:          function (sid, cfg, a) { return olvidarPersona(sid, cfg, a[0]); },
  olvidarProyecto:         function (sid, cfg, a) { return olvidarProyecto(sid, cfg, a[0]); },
  renombrarProyecto:       function (sid, cfg, a) { return renombrarProyecto(sid, cfg, a[0], a[1]); },
  cerrarProyecto:          function (sid, cfg, a) { return cerrarProyecto(sid, cfg, a[0], a[1]); },
  abrirBrainCentro:        function (sid, cfg, a) { return abrirBrainCentro(sid, cfg); },
  abrirTelegram:           function (sid, cfg, a) { return abrirTelegram(sid, cfg); },
  abrirMcp:                function (sid, cfg, a) { return abrirMcp(sid, cfg); },
  cargarTelegram:          function (sid, cfg, a) { return cargarTelegram(sid, cfg); },
  guardarUrlWebApp:        function (sid, cfg, a) { return guardarUrlWebApp(sid, cfg, a[0]); },
  guardarTokenTelegram:    function (sid, cfg, a) { return guardarTokenTelegram(sid, cfg, a[0]); },
  iniciarPairingTelegram:  function (sid, cfg, a) { return iniciarPairingTelegram(sid, cfg); },
  revocarTelegram:         function (sid, cfg, a) { return revocarTelegram(sid, cfg); },
  restablecerTelegram:     function (sid, cfg, a) { return restablecerTelegram(sid, cfg); },
  limpiarGuardasMeet:      function (sid, cfg, a) { return limpiarGuardasMeet(sid); },
  diagnosticarWiki:        function (sid, cfg, a) { return diagnosticarWiki(sid, cfg); },
  repararWiki:             function (sid, cfg, a) { return repararWiki(sid, cfg); },
  // Guía del CoS (onboarding modeless)
  cargarAsistente:         function (sid, cfg, a) { return cargarAsistente(sid, cfg); },
  marcarPasoAsistente:     function (sid, cfg, a) { return marcarPasoAsistente(sid, cfg, a[0], a[1]); },
  abrirGuia:               function (sid, cfg, a) { return abrirGuia(sid, cfg); },
  abrirDesdeAsistente:     function (sid, cfg, a) { return abrirDesdeAsistente(sid, cfg, a[0]); },
  // Mi seguimiento (modal del líder): lectura + mutadores de la hoja Tareas + foco manual.
  cargarMiSeguimiento:     function (sid, cfg, a) { return cargarMiSeguimiento(sid, cfg); },
  crearTarea:              function (sid, cfg, a) { return crearTarea(sid, cfg, a[0]); },
  actualizarTarea:         function (sid, cfg, a) { return actualizarTarea(sid, cfg, a[0], a[1]); },
  archivarTarea:           function (sid, cfg, a) { return archivarTarea(sid, cfg, a[0]); },
  guardarFoco:             function (sid, cfg, a) { return guardarFoco(sid, cfg, a[0]); },
  cargarTendencia:         function (sid, cfg, a) { return cargarTendencia(sid, cfg); },
  // Backfill del histórico al brain (job reanudable; lo avanza el dispatcher).
  iniciarBackfill:         function (sid, cfg) { return iniciarBackfill(sid, cfg); },
  estadoBackfill:          function (sid, cfg) { return estadoBackfill(sid, cfg); },
  cancelarBackfill:        function (sid, cfg) { return cancelarBackfill(sid, cfg); },
  // Compartir reportes (modal matriz): consolidado completo + destinatarios por persona.
  cargarCompartir:         function (sid, cfg) { return cargarCompartir(sid, cfg); },
  guardarCompartir:        function (sid, cfg, a) { return guardarCompartir(sid, cfg, a[0]); },
  // Notas de Meet (import inicial + estado).
  iniciarImportNotas:      function (sid, cfg, a) { return iniciarImportNotas(sid, cfg, a[0]); },
  estadoImportNotas:       function (sid, cfg, a) { return estadoImportNotas(sid, cfg, a[0]); },
  cancelarImportNotas:     function (sid, cfg) { return cancelarImportNotas(sid, cfg); },
  // Morning Briefing (modal con vista previa).
  cargarBriefing:          function (sid, cfg) { return cargarBriefing(sid, cfg); },
  guardarBriefing:         function (sid, cfg, a) { return guardarBriefing(sid, cfg, a[0]); },
  enviarBriefingPrueba:    function (sid, cfg) { return enviarBriefingPrueba(sid, cfg); },
  // Seguimiento del equipo (modal 3 tabs + cierre de pendientes).
  cargarSeguimiento:       function (sid, cfg, a) { return cargarSeguimiento(sid, cfg, a[0]); },
  resolverPendiente:       function (sid, cfg, a) { return resolverPendiente(sid, cfg, a[0], a[1], a[2]); },
  // Vera-MCP: conectar/desconectar el CoS a Claude/ChatGPT (pairing-code → Worker /enroll).
  cargarMcp:               function (sid, cfg) { return cargarMcp(sid, cfg); },
  iniciarConexionMcp:      function (sid, cfg) { return iniciarConexionMcp(sid, cfg); },
  desconectarMcp:          function (sid, cfg) { return desconectarMcp(sid, cfg); }
};

/**
 * Enruta una llamada del sidebar a la función de la librería correspondiente.
 * @param {string} fnName   clave en DISPATCH_
 * @param {Array}  args     argumentos deserializados del cliente
 * @param {string} sheetId
 * @param {Object} config
 */
function dispatch(fnName, args, sheetId, config) {
  var fn = DISPATCH_[fnName];
  if (!fn) throw new Error('Función no permitida vía cosRun: ' + fnName);
  return fn(sheetId, config, args || []);
}
