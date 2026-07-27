/**
 * triggers.js — Instalación de activadores. Ejecuta setupTriggers() UNA vez a mano
 * (pedirá autorizar permisos). Cambiar horarios NO requiere reinstalar: el dispatcher
 * corre cada 5 min y lee los horarios de la pestaña Ajustes en cada corrida.
 *
 * Sin import/export: runtime de Apps Script (namespace global del stub).
 */

function setupTriggers() {
  // Limpia previos de estas funciones (idempotente).
  ScriptApp.getProjectTriggers().forEach(function (t) {
    var fn = t.getHandlerFunction();
    if (fn === 'onFormSubmit' || fn === 'dispatcher') ScriptApp.deleteTrigger(t);
  });

  var ss = SpreadsheetApp.getActive();

  // 1) onFormSubmit (instalable, a nivel Sheet) — cubre Daily y Weekly.
  ScriptApp.newTrigger('onFormSubmit').forSpreadsheet(ss).onFormSubmit().create();

  // 2) dispatcher cada 5 min — invitaciones + consolidados según hora de Ajustes.
  ScriptApp.newTrigger('dispatcher').timeBased().everyMinutes(5).create();
}

/** Limpia las guardas anti-duplicado de este Sheet (para re-probar el flujo por hora). */
function limpiarGuardas() {
  Logger.log('Guardas borradas: %s', CoSLib.limpiarGuardasEnvio(getSheetId_()));
}
