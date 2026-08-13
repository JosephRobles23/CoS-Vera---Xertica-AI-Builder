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
function construirMenu(ui) {
  ui.createMenu('CoS')
    .addItem('Configurar', 'abrirSidebar')
    .addItem('Formularios', 'cosMenu1')
    .addItem('Compartir reportes', 'cosMenu2')
    .addItem('Morning Briefing', 'cosMenu3')
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
  briefing: { archivo: 'DialogBriefing', titulo: 'CoS — Morning Briefing', ancho: 760, alto: 640 }
};

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
  enviarBriefingPrueba:    function (sid, cfg) { return enviarBriefingPrueba(sid, cfg); }
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
