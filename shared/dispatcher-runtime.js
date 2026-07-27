/**
 * dispatcher-runtime.js — Orquestador por hora (invitaciones + consolidados) y guardas.
 *
 * El stub instala un trigger cada 5 min que solo llama a `CoSLib.runDispatcher(SHEET_ID, CONFIG)`.
 * Toda la lógica (timing, iteración del roster, guardas anti-duplicado) vive aquí, en la
 * librería, para que el stub siga delgado.
 *
 * Guardas anti-duplicado: Script Properties de la LIBRERÍA, namespaced por sheetId del líder:
 *   sent:<sheetId>:<tipo>:<id>:<fecha>
 * Así no hay colisión entre líderes. Ver Docs/testing-and-deploy.md y el playbook.
 *
 * Sin import/export: runtime de Apps Script. Privados con sufijo "_".
 */

/**
 * Punto de entrada del dispatcher. Público (lo llama el stub cada 5 min).
 * @param {string} sheetId      Spreadsheet del líder.
 * @param {Object} config       CONFIG (sheets, forms, leader, schedule, models, timezone,
 *                              dispatchWindowMin, options).
 * @param {Date}   [nowOverride] reloj inyectable para tests; en producción se omite.
 */
function runDispatcher(sheetId, config, nowOverride) {
  var tz    = config.timezone;
  var now   = nowOverride || new Date();
  var dow   = parseInt(Utilities.formatDate(now, tz, 'u'), 10);  // 1=lun … 7=dom
  var hhmm  = Utilities.formatDate(now, tz, 'HH:mm');
  var today = Utilities.formatDate(now, tz, 'yyyy-MM-dd');
  var win   = config.dispatchWindowMin || 5;

  var isWeekday = dow >= 1 && dow <= 5;
  var isFriday  = dow === 5;
  var weeklyOnlyFriday = !(config.options && config.options.weeklyOnlyFriday === false);

  // --- 1) Invitaciones (por persona, con guarda anti-dup) ---
  var leaderName = (config.leader && config.leader.name) || 'tu líder';
  var forms = config.forms || {};
  getRoster_(sheetId, config.sheets.roster).forEach(function (p) {
    // Daily: L–V
    if (isWeekday && forms.dailyUrl &&
        horaCoincide_(config.schedule.invitesDaily, hhmm, win) &&
        !yaEnviado_(sheetId, 'daily', p.correo, today)) {
      enviarInvitacion_('daily', p, leaderName, forms.dailyUrl);
      marcarEnviado_(sheetId, 'daily', p.correo, today);
    }
    // Weekly: viernes (o L–V si weeklyOnlyFriday=false)
    var weeklyOK = weeklyOnlyFriday ? isFriday : isWeekday;
    if (weeklyOK && forms.weeklyUrl &&
        horaCoincide_(config.schedule.invitesWeekly, hhmm, win) &&
        !yaEnviado_(sheetId, 'weekly', p.correo, today)) {
      enviarInvitacion_('weekly', p, leaderName, forms.weeklyUrl);
      marcarEnviado_(sheetId, 'weekly', p.correo, today);
    }
  });

  // --- 2) Consolidados con horas de cierre SEPARADAS (Daily L–V, Weekly viernes) ---
  var leaderKey = (config.leader && config.leader.email) || 'lider';

  if (isWeekday && horaCoincide_(config.schedule.closeDaily, hhmm, win) &&
      !yaEnviado_(sheetId, 'cons-daily', leaderKey, today)) {
    enviarConsolidado(sheetId, config, 'daily', today);
    marcarEnviado_(sheetId, 'cons-daily', leaderKey, today);
  }
  if (isFriday && horaCoincide_(config.schedule.closeWeekly, hhmm, win) &&
      !yaEnviado_(sheetId, 'cons-weekly', leaderKey, today)) {
    enviarConsolidado(sheetId, config, 'weekly', today);
    marcarEnviado_(sheetId, 'cons-weekly', leaderKey, today);
  }
}

// --- Guardas anti-duplicado (Script Properties de la librería, por sheetId) ---

function claveEnvio_(sheetId, tipo, id, fecha) {
  return 'sent:' + sheetId + ':' + tipo + ':' + id + ':' + fecha;
}

function yaEnviado_(sheetId, tipo, id, fecha) {
  return PropertiesService.getScriptProperties()
    .getProperty(claveEnvio_(sheetId, tipo, id, fecha)) === '1';
}

function marcarEnviado_(sheetId, tipo, id, fecha) {
  PropertiesService.getScriptProperties()
    .setProperty(claveEnvio_(sheetId, tipo, id, fecha), '1');
}

/**
 * Borra las guardas de un líder (para re-probar el flujo por hora el mismo día).
 * Público: lo llama el stub. @return {number} claves borradas.
 */
function limpiarGuardasEnvio(sheetId) {
  var props = PropertiesService.getScriptProperties();
  var all = props.getProperties();
  var prefijo = 'sent:' + (sheetId || '');
  var n = 0;
  Object.keys(all).forEach(function (k) {
    if (k.indexOf(prefijo) === 0) { props.deleteProperty(k); n++; }
  });
  return n;
}
