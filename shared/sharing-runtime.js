/**
 * sharing-runtime.js — Compartir reportes con correos externos al CoS (Fase 1).
 *
 * Caso de negocio: un colaborador reporta a dos jefes → llena UN solo formulario y el segundo
 * jefe recibe su resumen por correo. Dos granularidades (diseño del modal "Compartir reportes"):
 *   - Por persona: columna `Compartir con` en `Equipo` (correos por coma) → al cierre, cada
 *     destinatario recibe SOLO el Summary del día de esa persona (o el aviso de silencio).
 *   - Consolidado completo: clave `consolidado.cc` en Ajustes → esos correos van en CC del
 *     mismo correo de consolidado del líder (todo el equipo).
 *
 * Reglas acordadas (grill ago 2026):
 *   - Envío al CIERRE (closeDaily/closeWeekly), nunca en el camino caliente de onFormSubmit.
 *   - Dedup: quien recibe el consolidado completo NO recibe además los individuales.
 *   - Silencio visible: si la persona no reportó, el destinatario recibe "no envió reporte".
 *   - Transparencia activa: la invitación de la persona dice a quién más llega su reporte
 *     (ver invites/email-runtime), y el correo compartido dice quién lo comparte.
 *   - Cualquier correo válido (sin restricción de dominio); ambos tipos (daily y weekly).
 *
 * Público (via dispatch): cargarCompartir, guardarCompartir. Hook del dispatcher:
 * enviarCompartidos_. Sin import/export: runtime de Apps Script. Privados con sufijo "_".
 */

var CORREO_RE_ = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Parsea una lista de correos separada por comas/;: normaliza a minúsculas y dedup-ea. */
function listaCorreos_(s) {
  var vistos = {};
  return String(s == null ? '' : s)
    .split(/[,;]/)
    .map(function (c) { return c.trim().toLowerCase(); })
    .filter(function (c) {
      if (!c || vistos[c]) return false;
      vistos[c] = true;
      return true;
    });
}

// --- API del modal (via cosRun → dispatch) ---

/**
 * Estado para pintar la matriz del modal: personas con sus destinatarios + cc del consolidado.
 * @return {{personas:Array<{nombre,correo,compartirCon}>, consolidadoCc:string[]}}
 */
function cargarCompartir(sheetId, config) {
  var personas = [];
  try {
    personas = getRoster_(sheetId, config.sheets.roster).map(function (p) {
      return { nombre: p.nombre, correo: p.correo, compartirCon: p.compartirCon };
    });
  } catch (e) { /* sin pestaña Equipo todavía */ }
  var aj = getAjustes_(sheetId, config.sheets.settings);
  return { personas: personas, consolidadoCc: aj.consolidado.cc };
}

/**
 * Persiste la matriz del modal: columna `Compartir con` en Equipo + `consolidado.cc` en Ajustes.
 * Valida cada correo (lanza con el correo ofensor), normaliza, dedup-ea y quita el correo de la
 * propia persona (compartirse consigo misma no significa nada).
 * @param {Object} data  { personas: [{correo, compartirCon[]}], consolidadoCc: [] }
 * @return {{ok:boolean, personas:number, consolidadoCc:number}}
 */
function guardarCompartir(sheetId, config, data) {
  data = data || {};
  var porCorreo = {};
  (data.personas || []).forEach(function (p) {
    var propio = String(p.correo || '').trim().toLowerCase();
    var lista = validarCorreos_(p.compartirCon).filter(function (c) { return c !== propio; });
    porCorreo[propio] = lista;
  });
  var cc = validarCorreos_(data.consolidadoCc);

  // Columna en Equipo (fila por fila, casando por correo; crea la columna si falta).
  var sh = getSheet_(sheetId, config.sheets.roster);
  var col = ensureColumn_(sh, 'Compartir con');
  var map = getHeaderMap_(sh);
  var colCorreo = map['Correo'];
  if (!colCorreo) throw new Error('La pestaña "' + config.sheets.roster + '" no tiene columna "Correo".');
  var n = 0;
  if (sh.getLastRow() > 1) {
    var correos = sh.getRange(2, colCorreo, sh.getLastRow() - 1, 1).getValues();
    correos.forEach(function (r, i) {
      var correo = String(r[0] || '').trim().toLowerCase();
      if (!(correo in porCorreo)) return;
      sh.getRange(i + 2, col).setValue(porCorreo[correo].join(', '));
      if (porCorreo[correo].length) n++;
    });
  }

  setAjustes_(sheetId, config.sheets.settings, { 'consolidado.cc': cc.join(', ') });
  return { ok: true, personas: n, consolidadoCc: cc.length };
}

/** Valida una lista de correos; lanza nombrando el primero inválido. @return {string[]} */
function validarCorreos_(lista) {
  var limpios = listaCorreos_((lista || []).join(','));
  limpios.forEach(function (c) {
    if (!CORREO_RE_.test(c)) throw new Error('Correo inválido: "' + c + '"');
  });
  return limpios;
}

// --- Envío al cierre (lo invoca runDispatcher junto al consolidado) ---

/**
 * Envía a cada destinatario individual el Summary del día de su persona (o el aviso de
 * silencio). Anti-dup por persona+tipo+fecha; dedup contra consolidado.cc; best-effort por
 * persona (una que falle no frena a las demás).
 * @return {number} correos individuales enviados
 */
function enviarCompartidos_(sheetId, config, tipo, today) {
  var roster;
  try { roster = getRoster_(sheetId, config.sheets.roster); } catch (e) { return 0; }

  var enCc = {};
  ((config.consolidado && config.consolidado.cc) || []).forEach(function (c) { enCc[c] = true; });

  var sheetName = (tipo === 'daily') ? config.sheets.daily : config.sheets.weekly;
  var leaderName = (config.leader && config.leader.name) || 'tu líder';
  var enviados = 0;

  roster.forEach(function (p) {
    if (!p.compartirCon.length) return;
    // Dedup: quien ya recibe el consolidado completo no necesita el individual.
    var destinos = p.compartirCon.filter(function (c) { return !enCc[c] && c !== p.correo.toLowerCase(); });
    if (!destinos.length) return;
    if (yaEnviado_(sheetId, 'share-' + tipo, p.correo, today)) return;

    try {
      var resumen = resumenDelDia_(sheetId, sheetName, p.correo, today, config.timezone);
      var etiqueta = (tipo === 'daily') ? 'Daily' : 'Weekly';
      var asunto = 'Reporte ' + etiqueta + ' de ' + (p.nombre || p.correo) + ' — ' + today;
      var esSilencio = !resumen;
      var texto = esSilencio
        ? ((p.nombre || p.correo) + ' no envió su reporte ' + etiqueta.toLowerCase() +
           (tipo === 'daily' ? ' hoy.' : ' esta semana.'))
        : resumen;
      var cuerpo = texto + '\n\n— Compartido por ' + leaderName + ' vía CoS. ' +
        (p.nombre || 'La persona') + ' sabe que este reporte se comparte contigo.';

      MailApp.sendEmail(destinos.join(','), asunto, cuerpo, {
        htmlBody: renderReporteCompartidoHtml_(tipo, p, today, texto, leaderName, esSilencio)
      });
      marcarEnviado_(sheetId, 'share-' + tipo, p.correo, today);
      enviados++;
    } catch (e) {
      if (typeof Logger !== 'undefined') {
        Logger.log('compartir: falló el envío de %s (%s).', p.correo, e);
      }
    }
  });
  return enviados;
}

/**
 * Summary del día de UNA persona (por correo, casando `Correo` o el verificado de Google).
 * Si reportó más de una vez, concatena. @return {string} '' si no reportó.
 */
function resumenDelDia_(sheetId, sheetName, correo, today, timezone) {
  var sh;
  try { sh = getSheet_(sheetId, sheetName); } catch (e) { return ''; }
  if (sh.getLastRow() < 2) return '';

  var map = getHeaderMap_(sh);
  var colTs = map['Marca temporal'];
  var colSummary = map['Summary'];
  var colCorreo = map['Correo'];
  var colVer = map['Dirección de correo electrónico'];
  if (!colTs || !colSummary) return '';

  var buscado = String(correo || '').trim().toLowerCase();
  var rows = sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).getValues();
  var partes = [];
  rows.forEach(function (r) {
    var ts = r[colTs - 1];
    if (!(ts instanceof Date)) return;
    if (Utilities.formatDate(ts, timezone, 'yyyy-MM-dd') !== today) return;
    var quien = String((colCorreo && r[colCorreo - 1]) || (colVer && r[colVer - 1]) || '').trim().toLowerCase();
    if (quien !== buscado) return;
    var sum = String(r[colSummary - 1] == null ? '' : r[colSummary - 1]).trim();
    if (sum) partes.push(sum);
  });
  return partes.join('\n\n');
}
