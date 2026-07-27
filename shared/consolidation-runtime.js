/**
 * consolidation-runtime.js — Consolidados ejecutivos al líder (diario / semanal).
 *
 * Junta los `Summary` de hoy, pide a Gemini (modelo Pro) un consolidado y lo envía al
 * correo del líder. El Consolidado Diario y el Semanal van en correos separados.
 * Ver Docs/workflows/CLEVEL-REPORTS/CLEVEL-REPORTS.md.
 *
 * Sin import/export: runtime de Apps Script. Privados con sufijo "_".
 */

/**
 * Devuelve [{ nombre, summary }] de la hoja dada cuyo `Marca temporal` sea hoy.
 * @param {string} sheetId
 * @param {string} sheetName
 * @param {string} today      'yyyy-MM-dd' en la zona del líder
 * @param {string} timezone
 */
function getSummariesDeHoy_(sheetId, sheetName, today, timezone) {
  var sh = getSheet_(sheetId, sheetName);
  if (sh.getLastRow() < 2) return [];

  var map = getHeaderMap_(sh);
  var colTs      = map['Marca temporal'];
  var colSummary = map['Summary'];
  var colNombre  = map['Nombre'];
  // Correo: columna que rellenamos desde `Equipo`; el otro es el correo verificado de Google.
  var colEmail   = map['Correo'] || map['Dirección de correo electrónico'];
  if (!colTs || !colSummary) return [];

  var rows = sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).getValues();
  var out = [];
  rows.forEach(function (r) {
    var ts = r[colTs - 1];
    if (!(ts instanceof Date)) return;                                  // fila sin timestamp real
    if (Utilities.formatDate(ts, timezone, 'yyyy-MM-dd') !== today) return;
    var sum = r[colSummary - 1];
    if (sum && String(sum).trim()) {
      // La columna `Nombre` puede existir pero venir vacía (respondiente fuera de `Equipo`):
      // por eso se evalúa el valor, no solo la presencia de la columna.
      var nombre = colNombre ? String(r[colNombre - 1]).trim() : '';
      if (!nombre && colEmail) nombre = String(r[colEmail - 1]).trim();
      out.push({ nombre: nombre || '(sin nombre)', summary: String(sum).trim() });
    }
  });
  return out;
}

/** Pide a Gemini el texto del consolidado a partir de los resúmenes individuales. */
function consolidar_(model, prompts, tipo, today, leaderName, resumenes) {
  var taskField = (tipo === 'daily') ? 'taskConsolidatedDaily' : 'taskConsolidatedWeekly';
  var system = composeSystem_(prompts, taskField);
  var lista = resumenes
    .map(function (x) { return '- ' + x.nombre + ': ' + x.summary; })
    .join('\n');
  var user = 'Equipo de ' + leaderName + ' — ' + today + '\n\nResúmenes individuales:\n' + lista;
  return callGemini_(model, system, user);
}

/**
 * Genera y ENVÍA el consolidado al líder. Público (lo llama el dispatcher).
 * @param {string} sheetId
 * @param {Object} config   CONFIG (sheets, models, leader, timezone, options)
 * @param {string} tipo     'daily' | 'weekly'
 * @param {string} today    'yyyy-MM-dd'
 * @return {{enviado:boolean, count?:number, motivo?:string}}
 */
function enviarConsolidado(sheetId, config, tipo, today) {
  var leaderEmail = config.leader && config.leader.email;
  if (!leaderEmail) throw new Error('Falta config.leader.email para enviar el consolidado.');
  var leaderName = (config.leader && config.leader.name) || 'tu equipo';

  var sheetName = (tipo === 'daily') ? config.sheets.daily : config.sheets.weekly;
  var resumenes = getSummariesDeHoy_(sheetId, sheetName, today, config.timezone);

  var etiqueta = (tipo === 'daily') ? 'Diario' : 'Semanal';
  var asunto = 'Consolidado ' + etiqueta + ' — Equipo ' + leaderName + ' — ' + today;

  var cuerpo;
  if (resumenes.length) {
    var prompts = getPrompts_(sheetId, config.sheets.prompts);
    cuerpo = consolidar_(config.models.consolidated, prompts, tipo, today, leaderName, resumenes);
  } else {
    // Sin datos: enviar aviso salvo que la opción lo desactive.
    if (config.options && config.options.sendEmptyConsolidated === false) {
      return { enviado: false, motivo: 'sin datos' };
    }
    cuerpo = 'Hoy no se registraron reportes ' + (tipo === 'daily' ? 'Daily' : 'Weekly') +
             ' con Summary para tu equipo.';
  }

  // El LLM devuelve TEXTO; el HTML lo arma email-runtime a partir de ese texto (nunca se le
  // pide marcado al modelo). El texto plano va como fallback.
  MailApp.sendEmail(leaderEmail, asunto, cuerpo, {
    htmlBody: renderConsolidadoHtml_(tipo, leaderName, today, cuerpo)
  });
  return { enviado: true, count: resumenes.length };
}
