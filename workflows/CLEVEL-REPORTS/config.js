/**
 * config.js — CONFIG estático del workflow (parte NO editable en runtime).
 *
 * La parte editable por el líder (leader, schedule, forms, questions) vive en la pestaña
 * `Ajustes` del Sheet; `getConfig_()` mezcla ambas con CoSLib.construirConfig.
 * Los valores de modelo/timezone se mantienen en sync con cos.config.json en dev.
 *
 * Sin import/export: runtime de Apps Script (namespace global del stub).
 */

var CONFIG_STATIC = {
  sheets: {
    daily:    'Daily',
    weekly:   'Weekly',
    roster:   'Equipo',
    prompts:  'Prompts',
    settings: 'Ajustes'
  },
  models: {
    perRow:       'gemini-3.6-flash',
    consolidated: 'gemini-3.1-pro-preview'
  },
  timezone: 'America/Lima',
  dispatchWindowMin: 5,
  options: {
    regenerateSummaryIfPresent: false,
    weeklyOnlyFriday: true,
    sendEmptyConsolidated: true
  }
};

/** ID del Sheet contenedor (el stub está bound a él). */
function getSheetId_() {
  return SpreadsheetApp.getActive().getId();
}

/** CONFIG completo = estático (código) + editable (pestaña Ajustes). */
function getConfig_() {
  return CoSLib.construirConfig(getSheetId_(), CONFIG_STATIC);
}
