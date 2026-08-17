/**
 * stub.js — Script container-bound (uno por líder). Es un "bootloader" DELGADO y ESTABLE:
 * la UI (menú, sidebar, diálogos) y toda la lógica viven en la librería `CoSLib`. El stub solo
 * expone la superficie que la plataforma exige que resida en el proyecto contenedor:
 *   - onOpen (trigger simple) → delega el menú a la librería,
 *   - un puente genérico cosRun para google.script.run,
 *   - un abridor genérico de diálogos,
 *   - slots de menú pre-provisionados (cosMenu1..5) cuya acción define la librería,
 *   - handlers de activadores y los helpers de prueba del editor.
 * Así casi toda evolución de UI/lógica llega al líder por VERSIÓN de librería, sin re-copiar.
 *
 * Sin import/export: runtime de Apps Script (namespace global del stub).
 */

// --- Menú + sidebar + diálogos (construidos por la librería; el stub solo los muestra) ---

function onOpen() {
  CoSLib.construirMenu(SpreadsheetApp.getUi());
}

function abrirSidebar() {
  SpreadsheetApp.getUi().showSidebar(CoSLib.buildSidebar());
}

// Abridor genérico de diálogos modales. Se invoca desde el sidebar vía google.script.run (que
// SÍ admite argumentos), así un diálogo nuevo se crea en la librería sin tocar el stub.
function abrirDialogo(nombre) {
  var d = CoSLib.buildDialog(nombre);
  SpreadsheetApp.getUi().showModalDialog(d.html, d.titulo);
}

// --- Puente genérico del server-API del sidebar (google.script.run resuelve SIEMPRE en el stub) ---
// Una función de servidor nueva para el sidebar se registra en CoSLib.dispatch y llega al líder
// por versión, sin nuevo wrapper aquí.
function cosRun(fnName, argsJson) {
  return CoSLib.dispatch(fnName, JSON.parse(argsJson || '[]'), getSheetId_(), getConfig_());
}

// --- Slots de menú pre-provisionados (handlers SIN args que el menú puede targetear por nombre) ---
// El menú lo arma la librería (construirMenu); si mapea un ítem a uno de estos slots, su acción
// se define en CoSLib.menuAction — nuevo comportamiento de menú sin tocar el stub.
function cosMenu1() { return CoSLib.menuAction('cosMenu1', getSheetId_(), getConfig_()); }
function cosMenu2() { return CoSLib.menuAction('cosMenu2', getSheetId_(), getConfig_()); }
function cosMenu3() { return CoSLib.menuAction('cosMenu3', getSheetId_(), getConfig_()); }
function cosMenu4() { return CoSLib.menuAction('cosMenu4', getSheetId_(), getConfig_()); }
function cosMenu5() { return CoSLib.menuAction('cosMenu5', getSheetId_(), getConfig_()); }

// --- Web App de follow-up (Release 2 del seguimiento) ---
// Requiere desplegar ESTA copia como Web App ("ejecutar como: yo", "acceso: cualquiera con el
// enlace") — ver Docs/deploy-terminal.md. Sin deployment, los correos salen sin botones (nada
// se rompe). GET pinta la confirmación; solo el POST (Confirmar) muta — anti-escáneres.
function doGet(e)  { return CoSLib.webAction('get', e, getSheetId_(), getConfig_()); }
function doPost(e) {
  if (e && e.parameter && e.parameter.tg) return CoSLib.telegramWebhookAction(e, getSheetId_(), getConfig_());
  return CoSLib.webAction('post', e, getSheetId_(), getConfig_());
}

// --- Activadores (instalados por setupTriggers; NO ejecutar onFormSubmit a mano) ---

function onFormSubmit(e) {
  if (!e || !e.range) {
    throw new Error('onFormSubmit es un ACTIVADOR: se dispara al ENVIAR el Form, no a mano. ' +
      'Para probar usa testResumenUltimaFilaDaily().');
  }
  var config = getConfig_();
  var sheetName = e.range.getSheet().getName();
  return CoSLib.generarSummaryFila(getSheetId_(), config, sheetName, e.range.getRow());
}

function dispatcher() {
  CoSLib.runDispatcher(getSheetId_(), getConfig_());
}

// --- Wrappers del sidebar (google.script.run los invoca; delegan a CoSLib) ---

function cargarConfig()                  { return CoSLib.cargarConfig(getSheetId_(), getConfig_()); }
function configurarFormulario(tipo, qs)  { return CoSLib.configurarFormulario(tipo, qs, getSheetId_(), getConfig_()); }
function guardarPrompts(prompts)         { return CoSLib.guardarPrompts(getSheetId_(), getConfig_(), prompts); }
function guardarHorarios(horarios)       { return CoSLib.guardarHorarios(getSheetId_(), getConfig_(), horarios); }
function guardarEquipo(miembros)         { return CoSLib.guardarEquipo(getSheetId_(), getConfig_(), miembros); }
function guardarLeader(leader)           { return CoSLib.guardarLeader(getSheetId_(), getConfig_(), leader); }

// --- Helpers de prueba manual (SÍ se ejecutan a mano desde el editor) ---

function estilizarPestanas()           { CoSLib.estilizarPestanas(getSheetId_(), getConfig_()); }

/**
 * Diagnóstico: ejecútalo A MANO y revisa Ver → Registro. Muestra por qué el dispatcher
 * (no) envía la invitación en este momento.
 */
function diagnostico() {
  var c = getConfig_();
  var tz = c.timezone;
  var now = new Date();
  var hhmm = Utilities.formatDate(now, tz, 'HH:mm');
  var dow = parseInt(Utilities.formatDate(now, tz, 'u'), 10);
  Logger.log('Zona horaria: %s', tz);
  Logger.log('Ahora (en esa zona): %s  | día=%s  esL-V=%s', hhmm, dow, (dow >= 1 && dow <= 5));
  Logger.log('invitesDaily=%s  invitesWeekly=%s', c.schedule.invitesDaily, c.schedule.invitesWeekly);
  Logger.log('closeDaily=%s  closeWeekly=%s', c.schedule.closeDaily, c.schedule.closeWeekly);
  Logger.log('forms.dailyUrl = %s', c.forms.dailyUrl || '(VACÍO — falta generar el Form Daily)');
  Logger.log('forms.weeklyUrl = %s', c.forms.weeklyUrl || '(VACÍO)');
  Logger.log('leader = %s', JSON.stringify(c.leader));
  var eq = SpreadsheetApp.getActive().getSheetByName(c.sheets.roster);
  Logger.log('Equipo: %s miembros', eq ? Math.max(eq.getLastRow() - 1, 0) : '(pestaña Equipo no existe)');

  // Acceso de los Forms: un Form NO publicado deja al equipo con "necesitas acceso" y falla
  // en silencio (la invitación sale igual). Por eso se revisa aquí.
  [['daily', c.forms.dailyFormId], ['weekly', c.forms.weeklyFormId]].forEach(function (par) {
    if (!par[1]) { Logger.log('Form %s: (no generado)', par[0]); return; }
    try {
      var f = FormApp.openById(par[1]);
      var soporta = f.supportsAdvancedResponderPermissions();
      Logger.log('Form %s: publicado=%s | soporta publicación=%s | respondientes=%s',
        par[0], soporta ? f.isPublished() : '(n/a)', soporta,
        soporta ? f.getPublishedReaders().length : '(n/a)');
    } catch (e) {
      Logger.log('Form %s: no se pudo inspeccionar (%s)', par[0], e.message);
    }
  });
}
function testResumenUltimaFilaDaily()  { Logger.log(CoSLib.resumirUltimaFila(getSheetId_(), getConfig_(), 'daily')); }
function testResumenUltimaFilaWeekly() { Logger.log(CoSLib.resumirUltimaFila(getSheetId_(), getConfig_(), 'weekly')); }

function testConsolidadoDiario() {
  var config = getConfig_();
  var today = Utilities.formatDate(new Date(), config.timezone, 'yyyy-MM-dd');
  Logger.log(JSON.stringify(CoSLib.enviarConsolidado(getSheetId_(), config, 'daily', today)));
}
function testConsolidadoSemanal() {
  var config = getConfig_();
  var today = Utilities.formatDate(new Date(), config.timezone, 'yyyy-MM-dd');
  Logger.log(JSON.stringify(CoSLib.enviarConsolidado(getSheetId_(), config, 'weekly', today)));
}

// --- Second brain (Fases 1–4): smoke manual desde el editor ---

/**
 * Ingesta la última fila Daily en el second brain y lista las páginas de personas resultantes.
 * Requiere brain.enabled (actívalo en el sidebar → Brain). No envía nada al equipo.
 */
function testBrainIngest() {
  var config = getConfig_();
  if (!(config.brain && config.brain.enabled)) {
    Logger.log('brain.enabled = false. Activa la memoria en el sidebar (pestaña Brain) antes de probar la ingesta.');
    return;
  }
  Logger.log('Ingestando la última fila Daily en el brain…');
  Logger.log('Summary: %s', CoSLib.resumirUltimaFila(getSheetId_(), config, 'daily'));
  var personas = CoSLib.listarWikiPaginas(getSheetId_(), config, 'people');
  Logger.log('Páginas de personas (%s): %s', personas.length,
    JSON.stringify(personas.map(function (p) { return p.name; })));
}

/**
 * Genera y envía YA el Deep Prep de la próxima reunión del Calendar (ignora la ventana lead y la
 * anti-dup). Llega al líder como PDF de marca + TL;DR. Requiere deepPrep.enabled y brain.enabled.
 */
function testDeepPrep() {
  Logger.log(JSON.stringify(CoSLib.probarDeepPrep(getSheetId_(), getConfig_())));
}
