/**
 * stub.js — Script container-bound (uno por líder). Delgado: solo menú, activadores y
 * wrappers de google.script.run. Toda la lógica vive en la librería `CoSLib`.
 *
 * Sin import/export: runtime de Apps Script (namespace global del stub).
 */

// --- Menú + sidebar ---

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('CoS')
    .addItem('Configurar', 'abrirSidebar')
    .addToUi();
}

function abrirSidebar() {
  var html = HtmlService.createHtmlOutputFromFile('Sidebar')
    .setTitle('CoS — Configuración');
  SpreadsheetApp.getUi().showSidebar(html);
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
