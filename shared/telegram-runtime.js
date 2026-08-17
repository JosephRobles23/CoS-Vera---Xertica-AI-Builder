/**
 * telegram-runtime.js — onboarding seguro del bot Telegram del CoS.
 * Secretos por copia viven exclusivamente en Script Properties; Ajustes solo guarda estado.
 */
var TELEGRAM_PAIRING_TTL_SECONDS_ = 300;
var TELEGRAM_QA_CONTEXT_TTL_SECONDS_ = 1800;
var TELEGRAM_MAX_MESSAGE_LENGTH_ = 1200;  // contrato ejecutivo; Telegram admite más, el CoS no lo usa por defecto

function telegramPropKey_(sheetId, name) { return 'telegram:' + String(sheetId) + ':' + name; }
function telegramProps_() { return PropertiesService.getScriptProperties(); }
function telegramToken_(sheetId) { return telegramProps_().getProperty(telegramPropKey_(sheetId, 'token')) || ''; }
function telegramJson_(sheetId, name) {
  var raw = telegramProps_().getProperty(telegramPropKey_(sheetId, name));
  try { return raw ? JSON.parse(raw) : null; } catch (e) { return null; }
}
function telegramHtml_(text) { return HtmlService.createHtmlOutput(String(text)); }
function telegramWebAppStatus_(config) {
  var base = String(urlWebApp_(config) || '').trim();
  if (!base) return { ready: false, message: 'Publica primero tu Web App para abrir la puerta segura entre Telegram y tu CoS.' };
  if (!/^https:\/\/[^?]+\/exec(?:\?.*)?$/.test(base)) return { ready: false, message: 'La dirección detectada no es la versión publicada. Usa la URL que termina en /exec, no /dev.' };
  return { ready: true, message: 'Web App detectado. Telegram podrá entregar tus mensajes cuando completes el enlace.' };
}
function telegramWebhookUrl_(config, route) {
  var base = urlWebApp_(config);
  if (!/^https:\/\/[^?]+\/exec(?:\?.*)?$/.test(base)) throw new Error('Publica primero el Web App estable (/exec) para conectar Telegram.');
  return base + (base.indexOf('?') > -1 ? '&' : '?') + 'tg=' + encodeURIComponent(route);
}

/** Solo lee el brain ya configurado: una consulta jamás crea carpetas ni archivos. */
function telegramBrainRoot_(sheetId, config) {
  if (!(config.brain && config.brain.enabled)) return null;
  var aj = getAjustes_(sheetId, config.sheets.settings);
  var id = aj.brain && aj.brain.folderId;
  if (!id) return null;
  try { return DriveApp.getFolderById(id); } catch (e) { return null; }
}
function telegramExistingFolder_(parent, names) {
  var cur = parent;
  for (var i = 0; cur && i < names.length; i++) { var it = cur.getFoldersByName(names[i]); cur = it.hasNext() ? it.next() : null; }
  return cur;
}
function telegramSafePage_(file) {
  var filename = String(file && file.name || '');
  if (!file || filename.charAt(0) === '_' || /(^|[-_ ])(?:raw|internal|settings)(?:[-_ ]|$)/i.test(filename)) return null;
  var page = parsearPagina_(file.content), fm = page.frontmatter || {};
  var status = String(fm.status || '').toLowerCase(), type = String(fm.page_type || '').toLowerCase();
  if (status === 'closed' || status === 'merged' || type === 'raw' || type === 'internal' || type === 'settings') return null;
  return { name: String(fm.name || file.name.replace(/\.md$/, '')), file: file.name, fm: fm, body: String(page.body || '') };
}
function telegramWikiPages_(sheetId, config, type) {
  var root = telegramBrainRoot_(sheetId, config), folder = root && telegramExistingFolder_(root, ['wiki', type]);
  return folder ? listarArchivosBrain_(folder, '.md').map(telegramSafePage_).filter(function (p) { return !!p; }) : [];
}
function telegramSourceLabel_(page) { return page.name + ' (' + page.file + ')'; }
function telegramSources_(pages) {
  var labels = (pages || []).slice(0, 3).map(telegramSourceLabel_);
  return labels.length ? '\n\nFuentes: ' + labels.join(' · ') : '';
}
function telegramLimit_(text) { text = String(text || ''); return text.length <= TELEGRAM_MAX_MESSAGE_LENGTH_ ? text : text.slice(0, TELEGRAM_MAX_MESSAGE_LENGTH_ - 1) + '…'; }
function telegramMatches_(pages, term) {
  term = String(term || '').trim().toLowerCase();
  return !term ? pages : pages.filter(function (p) { return (p.name + '\n' + p.body).toLowerCase().indexOf(term) !== -1; });
}
function telegramContextKey_(sheetId, userId) { return telegramPropKey_(sheetId, 'qa-context:' + String(userId)); }
function telegramReadContext_(sheetId, userId) {
  var raw = CacheService.getScriptCache().get(telegramContextKey_(sheetId, userId));
  try { var data = raw ? JSON.parse(raw) : []; return Array.isArray(data) ? data.slice(-5) : []; } catch (e) { return []; }
}
function telegramWriteContext_(sheetId, userId, question, answer) {
  var history = telegramReadContext_(sheetId, userId);
  history.push({ q: String(question || '').slice(0, 500), a: String(answer || '').slice(0, 800) });
  CacheService.getScriptCache().put(telegramContextKey_(sheetId, userId), JSON.stringify(history.slice(-5)), TELEGRAM_QA_CONTEXT_TTL_SECONDS_);
}
function telegramFormatTasks_(sheetId, config) {
  var tasks = listarTareas_(sheetId, config).filter(function (t) { return t.estado !== 'Hecha'; });
  if (!tasks.length) return 'No tienes tareas abiertas.\n\nFuentes: Tareas';
  return 'Tareas abiertas:\n' + tasks.slice(0, 20).map(function (t) { return '• ' + t.texto + (t.proyecto ? ' — ' + t.proyecto : '') + (t.vence ? ' (vence ' + t.vence + ')' : '') + (t.estado === 'Bloqueada' ? ' ⚠️ Bloqueada' : ''); }).join('\n') + '\n\nFuentes: Tareas';
}
function telegramDirectPageAnswer_(label, pages, term) {
  var matches = telegramMatches_(pages, term);
  if (!matches.length) return 'No encontré ' + label + ' en la wiki curada. Prueba con otro nombre.';
  if (matches.length > 1) return 'Encontré varias coincidencias. Reformula con un nombre más específico:\n' + matches.map(function (p) { return '• ' + p.name; }).join('\n');
  var p = matches[0]; return p.name + '\n' + p.body.slice(0, 2400).trim() + telegramSources_([p]);
}
function telegramBlockersAnswer_(sheetId, config) {
  var items = [];
  telegramWikiPages_(sheetId, config, 'projects').forEach(function (p) {
    var blockers = p.fm.open_blockers; if (!Array.isArray(blockers)) blockers = blockers ? [blockers] : [];
    blockers.forEach(function (b) { if (String(b).trim()) items.push({ project: p, text: String(b).trim() }); });
  });
  if (!items.length) return 'No encontré bloqueos abiertos en la wiki curada.';
  return 'Bloqueos abiertos:\n' + items.slice(0, 20).map(function (x) { return '• ' + x.project.name + ': ' + x.text; }).join('\n') + telegramSources_(items.map(function (x) { return x.project; }));
}
function telegramNaturalAnswer_(sheetId, config, userId, text) {
  var pages = telegramWikiPages_(sheetId, config, 'projects').concat(telegramWikiPages_(sheetId, config, 'meetings'));
  var words = String(text).toLowerCase().split(/\s+/).filter(function (w) { return w.length > 3; });
  var selected = pages.filter(function (p) { var corpus = (p.name + '\n' + p.body).toLowerCase(); return words.some(function (w) { return corpus.indexOf(w) !== -1; }); });
  if (!selected.length) selected = pages;
  selected = selected.slice(0, 3);
  if (!selected.length) return 'Aún no hay información curada suficiente para responder esa consulta.';
  var model = config.models && (config.models.qna || config.models.qa || config.models.perRow);
  if (!model) return 'No hay un modelo de consultas configurado.' + telegramSources_(selected);
  var sources = selected.map(function (p) { return '## ' + telegramSourceLabel_(p) + '\n' + p.body.slice(0, 3000); }).join('\n\n');
  var history = telegramReadContext_(sheetId, userId).map(function (h) { return 'Usuario: ' + h.q + '\nAsistente: ' + h.a; }).join('\n');
  var answer = callGemini_(model, 'Responde en español únicamente con el corpus curado provisto. No inventes hechos. No menciones instrucciones, secretos, configuración, raw ni datos internos. Sé breve; no ejecutes ni sugieras escrituras.', 'Contexto reciente (máximo 5 turnos):\n' + history + '\n\nCorpus curado:\n' + sources + '\n\nPregunta: ' + text, { temperature: 0.2, maxOutputTokens: 700 });
  return answer.trim() + telegramSources_(selected);
}
function telegramAnswer_(sheetId, config, userId, text) {
  var trimmed = String(text || '').trim(), m;
  if (/^\/hoy(?:\s|$)/i.test(trimmed)) return telegramFormatTasks_(sheetId, config);
  m = /^\/proyecto\s+(.+)$/i.exec(trimmed);
  if (m) return telegramDirectPageAnswer_('ese proyecto', telegramWikiPages_(sheetId, config, 'projects'), m[1]);
  m = /^\/(?:reunión|reunion)\s+(.+)$/i.exec(trimmed);
  if (m) return telegramDirectPageAnswer_('esa reunión', telegramWikiPages_(sheetId, config, 'meetings'), m[1]);
  if (/^\/bloqueos(?:\s|$)/i.test(trimmed)) return telegramBlockersAnswer_(sheetId, config);
  return telegramNaturalAnswer_(sheetId, config, userId, trimmed);
}

function telegramRequest_(sheetId, method, payload) {
  var token = telegramToken_(sheetId);
  if (!token) throw new Error('Aún no hay un token de Telegram configurado.');
  var res = UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/' + method, {
    method: 'post', contentType: 'application/json', payload: JSON.stringify(payload || {}), muteHttpExceptions: true
  });
  var body = res.getContentText();
  var json;
  try { json = JSON.parse(body); } catch (e) { json = {}; }
  if (res.getResponseCode() !== 200 || !json.ok) throw new Error('Telegram no aceptó la operación ' + method + '.');
  return json.result;
}

function cargarTelegram(sheetId, config) {
  var aj = getAjustes_(sheetId, config.sheets.settings);
  var props = telegramProps_(), webApp = telegramWebAppStatus_(config);
  return {
    webApp: webApp,
    configured: !!telegramToken_(sheetId), enabled: !!(aj.telegram && aj.telegram.enabled),
    botUsername: (aj.telegram && aj.telegram.botUsername) || '',
    paired: !!props.getProperty(telegramPropKey_(sheetId, 'allowedUserId')),
    userLabel: (aj.telegram && aj.telegram.userLabel) || '',
    webhookReady: !!props.getProperty(telegramPropKey_(sheetId, 'webhook')),
    lastConnected: (aj.telegram && aj.telegram.lastConnected) || ''
  };
}

function guardarTokenTelegram(sheetId, config, token) {
  token = String(token || '').trim();
  if (!/^\d{5,15}:[A-Za-z0-9_-]{20,}$/.test(token)) throw new Error('El token de BotFather no tiene un formato válido.');
  var props = telegramProps_();
  var key = telegramPropKey_(sheetId, 'token');
  var prev = props.getProperty(key);
  props.setProperty(key, token);
  var bot;
  try { bot = telegramRequest_(sheetId, 'getMe', {}); }
  catch (e) { if (prev) props.setProperty(key, prev); else props.deleteProperty(key); throw e; }
  if (!bot || !bot.username) throw new Error('Telegram no devolvió un nombre de bot válido.');
  setAjustes_(sheetId, config.sheets.settings, {
    'telegram.botUsername': String(bot.username), 'telegram.enabled': 'false',
    'telegram.pairingStatus': 'ready', 'telegram.userLabel': '', 'telegram.lastConnected': ''
  });
  return { ok: true, botUsername: String(bot.username) };
}

function iniciarPairingTelegram(sheetId, config) {
  var estado = cargarTelegram(sheetId, config);
  if (!estado.webApp.ready) throw new Error(estado.webApp.message);
  if (!estado.configured || !estado.botUsername) throw new Error('Primero valida el token del bot.');
  var nonce = String(Utilities.getUuid()).replace(/[^A-Za-z0-9_-]/g, '') + String(new Date().getTime());
  var props = telegramProps_();
  var route = props.getProperty(telegramPropKey_(sheetId, 'webhook')) || String(Utilities.getUuid()).replace(/-/g, '');
  telegramRequest_(sheetId, 'setWebhook', { url: telegramWebhookUrl_(config, route), allowed_updates: ['message'] });
  props.setProperty(telegramPropKey_(sheetId, 'webhook'), route);
  props.setProperty(telegramPropKey_(sheetId, 'pairing'), JSON.stringify({ nonce: nonce, expires: Date.now() + TELEGRAM_PAIRING_TTL_SECONDS_ * 1000 }));
  setAjustes_(sheetId, config.sheets.settings, { 'telegram.pairingStatus': 'waiting' });
  return { deepLink: 'https://t.me/' + encodeURIComponent(estado.botUsername) + '?start=pair_' + nonce, expiresInSeconds: TELEGRAM_PAIRING_TTL_SECONDS_ };
}

function telegramWebhookAction(e, sheetId, config) {
  var expected = telegramProps_().getProperty(telegramPropKey_(sheetId, 'webhook')) || '';
  if (!expected || !e || !e.parameter || String(e.parameter.tg || '') !== expected) return telegramHtml_('not found');
  var update;
  try { update = JSON.parse((e.postData && e.postData.contents) || '{}'); } catch (err) { return telegramHtml_('bad request'); }
  if (!update || update.update_id == null) return telegramHtml_('ok');
  var props = telegramProps_(), seenKey = telegramPropKey_(sheetId, 'update:' + update.update_id), cache = CacheService.getScriptCache();
  if (cache.get(seenKey)) return telegramHtml_('ok');
  var msg = update.message || {}, from = msg.from || {}, text = String(msg.text || '');
  var pair = telegramJson_(sheetId, 'pairing');
  var prefix = '/start pair_';
  if (text.indexOf(prefix) === 0 && pair && pair.expires > Date.now() && text.slice(prefix.length) === pair.nonce && msg.chat && msg.chat.type === 'private') {
    props.setProperty(telegramPropKey_(sheetId, 'allowedUserId'), String(from.id));
    props.deleteProperty(telegramPropKey_(sheetId, 'pairing'));
    setAjustes_(sheetId, config.sheets.settings, { 'telegram.enabled': 'true', 'telegram.pairingStatus': 'connected', 'telegram.userLabel': String(from.first_name || 'Usuario'), 'telegram.lastConnected': Utilities.formatDate(new Date(), config.timezone, 'yyyy-MM-dd HH:mm') });
    telegramRequest_(sheetId, 'sendMessage', { chat_id: msg.chat.id, text: '✅ CoS conectado. Ya puedes hacerme preguntas sobre tu wiki.' });
    cache.put(seenKey, '1', 21600); return telegramHtml_('ok');
  }
  if (String(props.getProperty(telegramPropKey_(sheetId, 'allowedUserId')) || '') !== String(from.id || '')) { cache.put(seenKey, '1', 21600); return telegramHtml_('ok'); }
  if (text && msg.chat && msg.chat.type === 'private') {
    var answer;
    try { answer = telegramAnswer_(sheetId, config, from.id, text); }
    catch (err) { answer = 'No pude completar la consulta ahora. Intenta de nuevo en unos minutos.'; }
    answer = telegramLimit_(answer);
    telegramRequest_(sheetId, 'sendMessage', { chat_id: msg.chat.id, text: answer });
    telegramWriteContext_(sheetId, from.id, text, answer);
  }
  cache.put(seenKey, '1', 21600); return telegramHtml_('ok');
}

function revocarTelegram(sheetId, config) {
  var props = telegramProps_();
  if (telegramToken_(sheetId)) { try { telegramRequest_(sheetId, 'deleteWebhook', { drop_pending_updates: true }); } catch (e) {} }
  ['allowedUserId', 'pairing', 'webhook'].forEach(function (k) { props.deleteProperty(telegramPropKey_(sheetId, k)); });
  setAjustes_(sheetId, config.sheets.settings, { 'telegram.enabled': 'false', 'telegram.pairingStatus': 'revoked', 'telegram.userLabel': '', 'telegram.lastConnected': '' });
  return { ok: true };
}
