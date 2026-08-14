/**
 * webapp-runtime.js — Web App de follow-up (Release 2 del seguimiento).
 *
 * Los 4 botones de la sección "📌 Tus compromisos" del correo son links con TOKEN único:
 *   GET  → tarjeta de confirmación (estilo del mockup followup-flujo-mockups.html). NUNCA muta:
 *          los escáneres de seguridad del correo siguen links pero no envían formularios.
 *   POST → valida el token (un solo uso, TTL 7 días) y aplica el efecto DETERMINISTA (cero LLM):
 *          terminado → sufijo "✓ [resuelto FECHA · quién]" en la viñeta
 *          sigo      → re-fecha la viñeta a hoy (no cuenta como abandonada)
 *          bloqueado → agrega el texto a open_blockers (fluye a Urgente/charts)
 *          noaplica  → sufijo "✖ [no aplica FECHA · quién]" + auditoría de extracción en log.md
 *          undo      → revierte la acción original (token fresco emitido tras cada éxito)
 *   Al usarse un token se INVALIDAN sus hermanos (los otros 3 botones del mismo ítem).
 *
 * Tokens en la pestaña oculta `_Tokens` (Script Properties no escala a años de botones);
 * purga diaria de vencidos + purga de guardas sent:* viejas en purgaHigiene_ (dispatcher).
 * El stub expone doGet/doPost → webAction. URL: Ajustes webapp.url (override) o
 * ScriptApp.getService().getUrl(); sin deployment → la invitación sale sin sección (degradación).
 *
 * Sin import/export: runtime de Apps Script. Privados con sufijo "_".
 */

var TOKENS_SHEET_ = '_Tokens';
var TOKENS_HEADERS_ = ['Token', 'Grupo', 'Nombre', 'File', 'Linea', 'Accion', 'Extra', 'Expira', 'CreadoEl', 'UsadoEl'];
var TOKEN_TTL_DIAS_ = 7;
var GUARDAS_TTL_DIAS_ = 90;
var FOLLOWUP_MAX_ITEMS_ = 3;
var FOLLOWUP_ACCIONES_ = ['terminado', 'sigo', 'bloqueado', 'noaplica'];

/** URL base de la Web App: override de Ajustes o la del deployment (vacío si no hay). */
function urlWebApp_(config) {
  var manual = (config.webapp && config.webapp.url) || '';
  if (manual) return manual;
  try {
    return (ScriptApp.getService && ScriptApp.getService().getUrl()) || '';
  } catch (e) { return ''; }
}

// --- Almacén de tokens (pestaña oculta) ---

function ensureTokensSheet_(sheetId) {
  var ss = getSpreadsheet_(sheetId);
  var sh = ss.getSheetByName(TOKENS_SHEET_);
  if (!sh) sh = ss.insertSheet(TOKENS_SHEET_);
  if (sh.getLastRow() < 1) {
    sh.getRange(1, 1, 1, TOKENS_HEADERS_.length).setValues([TOKENS_HEADERS_]);
    try { sh.hideSheet(); } catch (e) { /* cosmético */ }
  }
  return sh;
}

function filaAToken_(r, fila) {
  return {
    fila: fila, token: String(r[0] || ''), grupo: String(r[1] || ''), nombre: String(r[2] || ''),
    file: String(r[3] || ''), linea: String(r[4] || ''), accion: String(r[5] || ''),
    extra: String(r[6] || ''), expira: String(r[7] || ''), creadoEl: String(r[8] || ''),
    usadoEl: String(r[9] || '')
  };
}

function listarTokens_(sheetId) {
  var sh = ensureTokensSheet_(sheetId);
  if (sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, TOKENS_HEADERS_.length).getValues()
    .map(function (r, i) { return filaAToken_(r, i + 2); });
}

function buscarToken_(sheetId, token) {
  if (!token) return null;
  return listarTokens_(sheetId).filter(function (t) { return t.token === token; })[0] || null;
}

/** Emite un token de un solo uso. @return {string} el token */
function crearToken_(sheetId, config, datos) {
  var sh = ensureTokensSheet_(sheetId);
  var hoy = hoyISO_(config);
  var expira = isoDeUTC_(isoAUTC_(hoy) + TOKEN_TTL_DIAS_ * 86400000);
  var token = Utilities.getUuid();
  sh.getRange(sh.getLastRow() + 1, 1, 1, TOKENS_HEADERS_.length).setValues([[
    token, datos.grupo || '', datos.nombre || '', datos.file || '', datos.linea || '',
    datos.accion, datos.extra || '', expira, hoy, ''
  ]]);
  return token;
}

function marcarTokenUsado_(sheetId, token, cuando, tambienGrupo) {
  var sh = ensureTokensSheet_(sheetId);
  listarTokens_(sheetId).forEach(function (t) {
    var esMismo = t.token === token;
    var esHermano = tambienGrupo && t.grupo && t.grupo === tambienGrupo && !t.usadoEl && t.accion !== 'undo';
    if (esMismo || esHermano) sh.getRange(t.fila, 10).setValue(cuando);
  });
}

/** Purga de higiene diaria: tokens vencidos + guardas sent:* con fecha vieja ('v1' etc. se quedan). */
function purgaHigiene_(sheetId, config, now) {
  var hoy = Utilities.formatDate(now || new Date(), config.timezone, 'yyyy-MM-dd');
  var hoyUTC = isoAUTC_(hoy);

  var ss = getSpreadsheet_(sheetId);
  var sh = ss.getSheetByName(TOKENS_SHEET_);
  var purgados = 0;
  if (sh && sh.getLastRow() > 1) {
    var vivos = [];
    sh.getRange(2, 1, sh.getLastRow() - 1, TOKENS_HEADERS_.length).getValues().forEach(function (r) {
      var expira = String(r[7] || '');
      var u = isoAUTC_(expira);
      if (u != null && u < hoyUTC) { purgados++; return; }
      vivos.push(r);
    });
    if (purgados) {
      sh.clearContents();
      var values = [TOKENS_HEADERS_].concat(vivos);
      sh.getRange(1, 1, values.length, TOKENS_HEADERS_.length).setValues(values);
    }
  }

  // Guardas anti-dup viejas: solo las que TERMINAN en fecha ISO (las 'v1' — p.ej. meet-doc — son
  // anti-dup permanentes y NUNCA se tocan).
  var corteUTC = hoyUTC - GUARDAS_TTL_DIAS_ * 86400000;
  var props = PropertiesService.getScriptProperties();
  var all = props.getProperties();
  var borradas = 0;
  Object.keys(all).forEach(function (k) {
    if (k.indexOf('sent:' + sheetId) !== 0) return;
    var m = /:(\d{4}-\d{2}-\d{2})(?:-\d{2})?$/.exec(k);
    if (!m) return;
    var u = isoAUTC_(m[1]);
    if (u != null && u < corteUTC) { props.deleteProperty(k); borradas++; }
  });
  return { tokens: purgados, guardas: borradas };
}

// --- Compromisos para la invitación (round-robin + 4 tokens por ítem) ---

/**
 * Los compromisos abiertos de una persona con sus 4 links, listos para el correo. Máximo 3,
 * rotados por antigüedad de último follow-up (los que hace más tiempo no se preguntan, primero;
 * el registro de "cuándo se preguntó" es la creación de tokens del grupo en _Tokens).
 * @return {Array<{texto,fecha,origenIcono,links:{terminado,sigo,bloqueado,noaplica}}>} [] si no aplica
 */
function compromisosParaInvitacion_(sheetId, config, persona) {
  if (!(config.brain && config.brain.enabled)) return [];
  var base = urlWebApp_(config);
  if (!base) return [];   // sin deployment de Web App → la invitación sale como siempre

  var root;
  try { root = ensureBrainFolder_(sheetId, config); } catch (e) { return []; }
  var file = slugBrain_(persona.correo || persona.nombre) + '.md';
  var contenido = leerArchivoBrain_(carpetaBrain_(root, ['wiki', 'people']), file);
  if (!contenido) return [];

  var abiertos = [];
  parseBodySections_(parsearPagina_(contenido).body).sections.forEach(function (s) {
    if (s.name !== 'Pendientes') return;
    s.lines.forEach(function (l) {
      var m = SEG_VINETA_RE_.exec(l.trim());
      if (!m || !esPendienteAbierto_(l)) return;
      abiertos.push({ linea: l.trim(), fecha: m[1], texto: m[2] });
    });
  });
  if (!abiertos.length) return [];

  // Round-robin: última emisión de tokens por grupo (asc); nunca preguntados primero (por fecha asc).
  var ultimaPregunta = {};
  listarTokens_(sheetId).forEach(function (t) {
    if (!t.grupo) return;
    if (!ultimaPregunta[t.grupo] || t.creadoEl > ultimaPregunta[t.grupo]) ultimaPregunta[t.grupo] = t.creadoEl;
  });
  abiertos.forEach(function (it) { it.grupo = grupoDeItem_(file, it.linea); it.preguntado = ultimaPregunta[it.grupo] || ''; });
  abiertos.sort(function (a, b) {
    return a.preguntado === b.preguntado ? a.fecha.localeCompare(b.fecha) : a.preguntado.localeCompare(b.preguntado);
  });

  return abiertos.slice(0, FOLLOWUP_MAX_ITEMS_).map(function (it) {
    var links = {};
    FOLLOWUP_ACCIONES_.forEach(function (accion) {
      var token = crearToken_(sheetId, config, {
        grupo: it.grupo, nombre: persona.nombre || persona.correo,
        file: file, linea: it.linea, accion: accion
      });
      links[accion] = base + (base.indexOf('?') > -1 ? '&' : '?') + 't=' + encodeURIComponent(token);
    });
    return { texto: it.texto, fecha: it.fecha, origenIcono: it.texto.indexOf('(') > -1 ? '' : '', links: links };
  });
}

/** Identidad estable del ítem: SIN la fecha ni el sufijo — sobrevive a la re-fecha de "sigo". */
function grupoDeItem_(file, linea) {
  var texto = String(linea || '').replace(/^-\s*\[[^\]]*\]\s*/, '').replace(SEG_SUFIJO_RE_, '');
  return slugBrain_(file + ' ' + texto).slice(0, 80);
}

// --- Router de la Web App (doGet/doPost del stub) ---

/**
 * Punto de entrada único de la Web App. Público (lo llama el stub).
 * @param {string} metodo  'get' | 'post'
 * @return {HtmlOutput}
 */
function webAction(metodo, e, sheetId, config) {
  var token = (e && e.parameter && e.parameter.t) || '';
  var tok = null;
  try { tok = buscarToken_(sheetId, token); } catch (err) { tok = null; }
  var hoy = hoyISO_(config);

  if (!tok) return paginaWebApp_(paginaResultado_('invalido', {}));
  if (tok.usadoEl) return paginaWebApp_(paginaResultado_('usado', { cuando: tok.usadoEl }));
  if (isoAUTC_(tok.expira) != null && isoAUTC_(tok.expira) < isoAUTC_(hoy)) {
    return paginaWebApp_(paginaResultado_('vencido', {}));
  }

  if (metodo !== 'post') {
    // GET: SOLO la tarjeta de confirmación. Jamás muta (anti-escáneres).
    return paginaWebApp_(paginaConfirmacion_(tok, urlWebApp_(config)));
  }

  var resultado = aplicarAccion_(sheetId, config, tok, hoy);
  marcarTokenUsado_(sheetId, tok.token, hoy + ' ' + Utilities.formatDate(new Date(), config.timezone, 'HH:mm'), tok.grupo);
  return paginaWebApp_(paginaResultado_('exito', resultado));
}

// --- Efectos (deterministas) ---

function aplicarAccion_(sheetId, config, tok, hoy) {
  var root = ensureBrainFolder_(sheetId, config);
  var carpeta = carpetaBrain_(root, ['wiki', 'people']);
  var name = nombreArchivoSeguro_(tok.file);
  var contenido = leerArchivoBrain_(carpeta, name);
  if (!contenido) throw new Error('Página no encontrada: ' + name);

  var page = parsearPagina_(contenido);
  var ps = parseBodySections_(page.body);
  var quien = tok.nombre || 'miembro';
  var textoItem = tok.linea.replace(/^-\s*\[[^\]]*\]\s*/, '').replace(SEG_SUFIJO_RE_, '');
  var lineaNueva = tok.linea, fm = page.frontmatter || {};

  if (tok.accion === 'undo') {
    var extra = JSON.parse(tok.extra || '{}');
    lineaNueva = reemplazarLinea_(ps, extra.lineaDespues, extra.lineaAntes);
    if (extra.accion === 'bloqueado') fm = quitarBlocker_(fm, textoItem);
    escribirPagina_(carpeta, name, fm, ps);
    logWebApp_(root, hoy, '↩ deshecho (' + extra.accion + ') · ' + quien + ' · ' + recorteTexto_(textoItem, 100));
    return { accion: 'undo', texto: textoItem, quien: quien };
  }

  if (tok.accion === 'terminado') {
    lineaNueva = reemplazarLinea_(ps, tok.linea,
      tok.linea.replace(SEG_SUFIJO_RE_, '') + ' ✓ [resuelto ' + hoy + ' · ' + quien + ']');
    logWebApp_(root, hoy, '✓ compromiso terminado · ' + quien + ' · ' + recorteTexto_(textoItem, 100));
  } else if (tok.accion === 'sigo') {
    lineaNueva = reemplazarLinea_(ps, tok.linea, tok.linea.replace(/^-\s*\[[^\]]*\]/, '- [' + hoy + ']'));
    logWebApp_(root, hoy, '⏳ sigue en curso · ' + quien + ' · ' + recorteTexto_(textoItem, 100));
  } else if (tok.accion === 'bloqueado') {
    var blockers = Array.isArray(fm.open_blockers) ? fm.open_blockers.slice() : [];
    if (blockers.indexOf(textoItem) === -1) blockers.push(textoItem);
    fm = mergeFrontmatter_(fm, { open_blockers: blockers });
    logWebApp_(root, hoy, '🚧 compromiso bloqueado · ' + quien + ' · ' + recorteTexto_(textoItem, 100));
  } else if (tok.accion === 'noaplica') {
    lineaNueva = reemplazarLinea_(ps, tok.linea,
      tok.linea.replace(SEG_SUFIJO_RE_, '') + ' ✖ [no aplica ' + hoy + ' · ' + quien + ']');
    logWebApp_(root, hoy, '⛔ no-aplica · ' + quien + ' · "' + recorteTexto_(textoItem, 100) +
      '" · revisar extracción de Meet');
  } else {
    throw new Error('Acción desconocida: ' + tok.accion);
  }

  escribirPagina_(carpeta, name, fm, ps);
  regenerarIndexBrain_(root, hoy);

  // Token de deshacer (un solo uso, mismo TTL): revierte exactamente lo aplicado.
  var undoToken = crearToken_(sheetId, config, {
    grupo: '', nombre: quien, file: tok.file, linea: lineaNueva, accion: 'undo',
    extra: JSON.stringify({ accion: tok.accion, lineaAntes: tok.linea, lineaDespues: lineaNueva })
  });
  var base = urlWebApp_(config);
  return {
    accion: tok.accion, texto: textoItem, quien: quien,
    undoUrl: base ? base + (base.indexOf('?') > -1 ? '&' : '?') + 't=' + encodeURIComponent(undoToken) : ''
  };
}

function reemplazarLinea_(ps, vieja, nueva) {
  var buscada = String(vieja || '').trim();
  for (var i = 0; i < ps.sections.length; i++) {
    var s = ps.sections[i];
    for (var j = 0; j < s.lines.length; j++) {
      if (s.lines[j].trim() === buscada) { s.lines[j] = nueva; return nueva; }
    }
  }
  throw new Error('No se encontró el compromiso en la página (¿ya cambió de estado?).');
}

function quitarBlocker_(fm, texto) {
  var blockers = (Array.isArray(fm.open_blockers) ? fm.open_blockers : [])
    .filter(function (b) { return String(b) !== texto; });
  var out = {};
  Object.keys(fm).forEach(function (k) { out[k] = fm[k]; });
  out.open_blockers = blockers;
  return out;
}

function escribirPagina_(carpeta, name, fm, ps) {
  escribirArchivoBrain_(carpeta, name, componerPagina_(fm, renderBodySections_(ps)));
}

function logWebApp_(root, fecha, texto) {
  appendArchivoBrain_(carpetaBrain_(root, ['wiki']), 'log.md', '- ' + fecha + ' · ' + texto + '\n');
}

// --- Páginas HTML (calcadas del mockup followup-flujo-mockups.html) ---

var WEBAPP_ACCION_META_ = {
  terminado: { color: '#16A34A', titulo: 'Marcar como terminado', verbo: 'Vas a registrar que completaste:',
    nota: '', boton: 'Confirmar ✓', hecho: 'quedó marcada como terminada. Tu líder lo verá en su próximo briefing.' },
  sigo: { color: '#1E40AF', titulo: 'Sigue en curso', verbo: 'Vas a registrar que sigues trabajando en:',
    nota: 'Se re-fecha: no contará como abandonada.', boton: 'Confirmar ⏳', hecho: 'quedó registrada como en curso.' },
  bloqueado: { color: '#DC2626', titulo: 'Reportar bloqueo', verbo: 'Vas a marcar como bloqueada:',
    nota: 'Tu líder lo verá en 🚨 Urgente de su briefing.', boton: 'Confirmar 🚧', hecho: 'quedó marcada como bloqueada. Tu líder lo verá en Urgente.' },
  noaplica: { color: '#6B7280', titulo: 'No es una tarea tuya', verbo: 'Vas a descartar:',
    nota: '¿Se extrajo mal de la reunión? Esto ayuda a mejorar la detección.', boton: 'Confirmar ⛔', hecho: 'quedó descartada. Gracias — esto mejora la detección.' },
  undo: { color: '#6B7280', titulo: 'Deshacer', verbo: 'Vas a REVERTIR tu última acción sobre:',
    nota: 'El compromiso vuelve a su estado anterior.', boton: 'Deshacer ↩', hecho: 'volvió a su estado anterior.' }
};

function cssWebApp_() {
  return '<style>*{box-sizing:border-box;margin:0}body{font-family:Inter,-apple-system,system-ui,sans-serif;' +
    'background:#f4f5f7;color:#1a1a1a;font-size:14px;line-height:1.5;display:flex;justify-content:center;padding:26px 14px}' +
    '.card{background:#fff;border:1px solid #e5e7eb;border-radius:16px;box-shadow:0 4px 16px -4px rgba(0,0,0,.18);' +
    'max-width:380px;width:100%;padding:26px 22px;text-align:center}' +
    '.logo{width:42px;height:42px;border-radius:12px;background:#1a1a1a;color:#fff;display:grid;place-items:center;' +
    'font-size:20px;margin:0 auto 14px}' +
    'h1{font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;margin-bottom:8px}' +
    '.accion{font-size:13px;color:#6b7280}.accion b{display:block;color:#1a1a1a;font-size:15px;margin:8px 0 2px;line-height:1.35}' +
    '.origen{font-size:11px;color:#6b7280;margin-top:6px}' +
    'button{margin-top:22px;width:100%;border:0;border-radius:12px;padding:13px;font:inherit;font-size:14px;' +
    'font-weight:700;color:#fff;cursor:pointer}' +
    '.cancel{margin-top:10px;font-size:12px;color:#6b7280}' +
    '.sello{width:62px;height:62px;border-radius:50%;display:grid;place-items:center;font-size:30px;color:#fff;margin:6px auto 14px}' +
    '.listo{font-size:16px;font-weight:700}.sub{font-size:12.5px;color:#6b7280;margin-top:6px}' +
    'a{color:#6b7280}</style>';
}

function paginaConfirmacion_(tok, base) {
  var m = WEBAPP_ACCION_META_[tok.accion] || WEBAPP_ACCION_META_.undo;
  var texto = tok.linea.replace(/^-\s*\[[^\]]*\]\s*/, '').replace(SEG_SUFIJO_RE_, '');
  var accion = base + (base.indexOf('?') > -1 ? '&' : '?') + 't=' + encodeURIComponent(tok.token);
  return cssWebApp_() + '<div class="card"><div class="logo">☀️</div>' +
    '<h1 style="color:' + m.color + '">' + m.titulo + '</h1>' +
    '<div class="accion">' + m.verbo + '<b>“' + escapeHtml_(texto) + '”</b>' +
    (m.nota ? '<div class="origen">' + m.nota + '</div>' : '') + '</div>' +
    '<form method="post" action="' + accion + '">' +
    '<button type="submit" style="background:' + m.color + '">' + m.boton + '</button></form>' +
    '<div class="cancel">Si no eras tú, cierra esta página: nada se registra sin confirmar.</div></div>';
}

function paginaResultado_(tipo, datos) {
  if (tipo === 'exito') {
    var m = WEBAPP_ACCION_META_[datos.accion] || WEBAPP_ACCION_META_.undo;
    return cssWebApp_() + '<div class="card"><div class="sello" style="background:' + m.color + '">✓</div>' +
      '<div class="listo">Registrado</div>' +
      '<div class="sub">“' + escapeHtml_(datos.texto || '') + '” ' + m.hecho + '</div>' +
      (datos.undoUrl ? '<div class="cancel">¿Fue un error? <a href="' + datos.undoUrl + '">Deshacer</a></div>' : '') +
      '</div>';
  }
  if (tipo === 'usado') {
    return cssWebApp_() + '<div class="card"><div class="sello" style="background:#D97706">!</div>' +
      '<div class="listo">Ya registrado</div>' +
      '<div class="sub">Esta acción ya se registró' + (datos.cuando ? ' el ' + escapeHtml_(datos.cuando) : '') +
      '. Cada botón funciona una sola vez; usa los de tu próximo correo.</div></div>';
  }
  if (tipo === 'vencido') {
    return cssWebApp_() + '<div class="card"><div class="sello" style="background:#6B7280">⌛</div>' +
      '<div class="listo">Enlace vencido</div>' +
      '<div class="sub">Este botón era de un correo de hace más de ' + TOKEN_TTL_DIAS_ +
      ' días. Tu próxima invitación traerá botones frescos.</div></div>';
  }
  return cssWebApp_() + '<div class="card"><div class="sello" style="background:#6B7280">?</div>' +
    '<div class="listo">Enlace no válido</div>' +
    '<div class="sub">Este enlace no corresponde a ninguna acción pendiente.</div></div>';
}

function paginaWebApp_(html) {
  return HtmlService.createHtmlOutput(html).setTitle('CoS');
}
