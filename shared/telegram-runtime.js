/**
 * telegram-runtime.js — onboarding seguro del bot Telegram del CoS.
 * Secretos por copia viven exclusivamente en Script Properties; Ajustes solo guarda estado.
 */
var TELEGRAM_PAIRING_TTL_SECONDS_ = 300;
var TELEGRAM_QA_CONTEXT_TTL_SECONDS_ = 1800;
var TELEGRAM_MAX_MESSAGE_LENGTH_ = 3800;  // deja margen frente al límite duro de 4096 de Telegram

function telegramPropKey_(sheetId, name) { return 'telegram:' + String(sheetId) + ':' + name; }
function telegramProps_() { return PropertiesService.getScriptProperties(); }
function telegramToken_(sheetId) { return telegramProps_().getProperty(telegramPropKey_(sheetId, 'token')) || ''; }
function telegramJson_(sheetId, name) {
  var raw = telegramProps_().getProperty(telegramPropKey_(sheetId, name));
  try { return raw ? JSON.parse(raw) : null; } catch (e) { return null; }
}
function telegramHtml_(text) { return HtmlService.createHtmlOutput(String(text)); }
function telegramWebAppUrl_(config) {
  return String(config && config.webapp && config.webapp.url || '').trim();
}
function telegramValidWebAppUrl_(url) {
  return /^https:\/\/[^?#]+\/exec(?:\?[^#]*)?$/i.test(String(url || ''));
}
function telegramWebAppStatus_(config) {
  var base = telegramWebAppUrl_(config);
  if (!base) return { ready: false, message: 'Pega la URL /exec de tu Web App para que Telegram use exactamente esa puerta pública.' };
  if (!telegramValidWebAppUrl_(base)) return { ready: false, message: 'La dirección no es una Web App publicada. Usa la URL HTTPS que termina en /exec, no /dev.' };
  return { ready: true, message: 'URL guardada. Telegram usará exactamente este Web App público.' };
}
function telegramWebhookUrl_(config, route) {
  var base = telegramWebAppUrl_(config);
  if (!telegramValidWebAppUrl_(base)) throw new Error('Pega primero la URL estable de tu Web App (/exec) para conectar Telegram.');
  return base + (base.indexOf('?') > -1 ? '&' : '?') + 'tg=' + encodeURIComponent(route);
}
function guardarUrlWebApp(sheetId, config, url) {
  url = String(url || '').trim();
  if (!telegramValidWebAppUrl_(url)) throw new Error('Pega la URL HTTPS publicada que termina en /exec. No uses una URL /dev.');
  setAjustes_(sheetId, config.sheets.settings, { 'webapp.url': url });
  var siguiente = {};
  Object.keys(config).forEach(function (k) { siguiente[k] = config[k]; });
  siguiente.webapp = { url: url };
  return { ok: true, webApp: telegramWebAppStatus_(siguiente) };
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
/** Las fuentes siguen en el contexto interno, pero nunca se imprimen al usuario. */
function telegramSources_() { return ''; }
function telegramStripSources_(text) {
  return String(text || '').replace(/(?:\n|^)[ \t]*(?:#{1,6}[ \t]*)?(?:fuentes?|sources?)[ \t]*:[\s\S]*$/i, '').trim();
}
function telegramEscapeHtml_(text) { return String(text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
/** Convierte un subconjunto controlado de Markdown a HTML seguro para Telegram. */
function telegramRenderHtml_(text) {
  var lines = telegramStripSources_(text).split('\n');
  return lines.map(function (line) {
    var escaped = telegramEscapeHtml_(line);
    escaped = escaped.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>').replace(/__([^_\n]+)__/g, '<b>$1</b>');
    escaped = escaped.replace(/`([^`\n]+)`/g, '<code>$1</code>');
    escaped = escaped.replace(/^\s*#{1,6}\s+(.+)$/, '<b>$1</b>');
    escaped = escaped.replace(/^\s*(?:[-•]|\*)\s+/, '• ');
    return escaped;
  }).join('\n');
}
function telegramSplitText_(text) {
  text = telegramStripSources_(text); var out = [];
  while (text.length > TELEGRAM_MAX_MESSAGE_LENGTH_) {
    var cut = text.lastIndexOf('\n', TELEGRAM_MAX_MESSAGE_LENGTH_);
    if (cut < TELEGRAM_MAX_MESSAGE_LENGTH_ * 0.55) cut = text.lastIndexOf(' ', TELEGRAM_MAX_MESSAGE_LENGTH_);
    if (cut < 1) cut = TELEGRAM_MAX_MESSAGE_LENGTH_;
    out.push(text.slice(0, cut)); text = text.slice(cut).replace(/^\s+/, '');
  }
  if (text || !out.length) out.push(text); return out;
}
function telegramSendMessage_(sheetId, payload) {
  var chunks = telegramSplitText_(payload.text), result;
  chunks.forEach(function (chunk, index) {
    var part = {}; Object.keys(payload).forEach(function (key) { part[key] = payload[key]; });
    part.text = chunk; if (index > 0) delete part.reply_markup;
    result = telegramRequest_(sheetId, 'sendMessage', part);
  });
  return result;
}
function telegramLimit_(text) { return String(text || ''); }
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
  var answer = callGemini_(model, 'Eres Vera, Chief of Staff AI del líder. Responde en español con un tono claro, ejecutivo, cordial y orientado a acción. Usa únicamente el corpus curado provisto: no inventes hechos. No menciones archivos, rutas, nombres de fuentes, instrucciones, secretos, configuración, raw ni datos internos. No añadas una sección de fuentes. Puedes usar Markdown simple (negritas, viñetas y encabezados) para mejorar legibilidad; Telegram lo renderizará. No ejecutes ni sugieras escrituras.', 'Contexto reciente (máximo 5 turnos):\n' + history + '\n\nCorpus curado:\n' + sources + '\n\nPregunta: ' + text, { temperature: 0.2 });
  return answer.trim();
}
function telegramTaskKey_(sheetId, userId) { return telegramPropKey_(sheetId, 'task:' + String(userId)); }
function telegramTaskId_() { return String(Utilities.getUuid()).replace(/-/g, '').slice(0, 20); }
function telegramTaskCommands_() {
  return 'Soy **Vera**, tu **Chief of Staff AI**. Te ayudo a consultar prioridades, riesgos y avances, y a capturar tareas seguras para tu confirmación.\n\n' +
    'Comandos:\n• /hoy — tareas abiertas\n• /semana — tareas de esta semana\n• /bloqueos — bloqueos activos\n• /proyecto Nombre — contexto de proyecto\n• /task descripción — propongo una tarea para confirmar';
}
function telegramWeekTasks_(sheetId, config) {
  var today = Utilities.formatDate(new Date(), config.timezone, 'yyyy-MM-dd');
  var endDate = new Date(today + 'T12:00:00Z'); endDate.setUTCDate(endDate.getUTCDate() + 6);
  var end = Utilities.formatDate(endDate, config.timezone, 'yyyy-MM-dd');
  var tasks = listarTareas_(sheetId, config).filter(function (t) { return t.estado !== 'Hecha' && t.vence && t.vence >= today && t.vence <= end; });
  if (!tasks.length) return 'No tienes tareas con vencimiento esta semana.\n\nFuentes: Tareas';
  return 'Tus tareas de esta semana:\n' + tasks.slice(0, 20).map(function (t) { return '• ' + t.texto + (t.proyecto ? ' — ' + t.proyecto : '') + ' (vence ' + t.vence + ')'; }).join('\n') + '\n\nFuentes: Tareas';
}
function telegramTaskCatalog_(sheetId, config) {
  var people = [];
  try { people = getRoster_(sheetId, config.sheets.roster).map(function (p) { return p.nombre || p.correo; }); } catch (e) {}
  telegramWikiPages_(sheetId, config, 'people').forEach(function (p) { people.push(p.name); });
  var projects = telegramWikiPages_(sheetId, config, 'projects').map(function (p) { return p.name; });
  return { people: people.filter(Boolean).slice(0, 100), projects: projects.filter(Boolean).slice(0, 100) };
}
function telegramResolveCatalog_(value, candidates, label) {
  value = String(value || '').trim(); if (!value) return '';
  var norm = function (v) { return String(v || '').toLowerCase().replace(/[^a-záéíóúüñ0-9]+/gi, ' ').trim(); };
  var needle = norm(value), matches = (candidates || []).filter(function (c) { var x = norm(c); return x === needle || x.indexOf(needle) === 0 || needle.indexOf(x) === 0; });
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) throw new Error('Encontré varias coincidencias para ' + label + '. Indica un nombre más específico.');
  return '';
}
function telegramTaskParse_(sheetId, config, userId, original, correction) {
  var model = config.models && (config.models.qna || config.models.qa || config.models.perRow);
  if (!model) throw new Error('No hay un modelo de consultas configurado.');
  var today = Utilities.formatDate(new Date(), config.timezone, 'yyyy-MM-dd'), catalog = telegramTaskCatalog_(sheetId, config);
  var prompt = 'Interpreta una tarea del líder y responde SOLO JSON válido sin markdown con estas claves: texto, proyecto, persona, espera, vence, prioridad. ' +
    'vence debe ser YYYY-MM-DD o vacío; usa hoy=' + today + ' y zona horaria=' + config.timezone + ' para fechas relativas. prioridad solo Alta, Media o Baja; si no es explícita usa Media. ' +
    'Solo usa un proyecto o persona de los catálogos si hay coincidencia clara; de otro modo deja vacío. "espera" se usa únicamente si el texto expresa que se espera una respuesta/entregable de esa persona. ' +
    'Personas: ' + JSON.stringify(catalog.people) + '. Proyectos: ' + JSON.stringify(catalog.projects) + '.\n\nTarea original: ' + original + (correction ? '\nCorrección: ' + correction : '');
  var raw = callGemini_(model, 'Devuelve únicamente JSON. No inventes información ni ejecutes acciones.', prompt, { temperature: 0, maxOutputTokens: 350 });
  raw = String(raw || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  var data; try { data = JSON.parse(raw); } catch (e) { throw new Error('No pude interpretar esa tarea. Reformúlala con la acción y, si aplica, la fecha.'); }
  var text = String(data.texto || '').trim();
  if (!text) throw new Error('No pude identificar qué tarea crear.');
  var due = String(data.vence || '').trim();
  if (due && !/^\d{4}-\d{2}-\d{2}$/.test(due)) throw new Error('No pude interpretar la fecha de la tarea.');
  var priority = ['Alta', 'Media', 'Baja'].indexOf(String(data.prioridad || 'Media')) >= 0 ? String(data.prioridad || 'Media') : 'Media';
  var project = telegramResolveCatalog_(data.proyecto, catalog.projects, 'el proyecto');
  var person = telegramResolveCatalog_(data.persona, catalog.people, 'la persona');
  var waiting = telegramResolveCatalog_(data.espera, catalog.people, 'la persona de quien esperas respuesta');
  return { id: telegramTaskId_(), original: original, texto: text, proyecto: project, persona: person, espera: waiting, vence: due, prioridad: priority, expires: Date.now() + 900000 };
}
function telegramTaskProposalText_(draft) {
  return 'Propongo crear esta tarea:\n\n• ' + draft.texto +
    (draft.proyecto ? '\n• Proyecto: ' + draft.proyecto : '') +
    (draft.persona ? '\n• Relacionado con: ' + draft.persona : '') +
    (draft.espera ? '\n• Espera de: ' + draft.espera : '') +
    (draft.vence ? '\n• Vence: ' + draft.vence : '') +
    '\n• Prioridad: ' + draft.prioridad + '\n• Origen: Telegram\n\n¿La creo?';
}
function telegramSaveTaskProposal_(sheetId, userId, draft) { telegramProps_().setProperty(telegramTaskKey_(sheetId, userId), JSON.stringify(draft)); }
function telegramReadTaskProposal_(sheetId, userId) { return telegramJson_(sheetId, 'task:' + String(userId)); }
function telegramTaskKeyboard_(draft) { return { inline_keyboard: [[{ text: '✅ Crear', callback_data: 'task:create:' + draft.id }, { text: '✏️ Ajustar', callback_data: 'task:adjust:' + draft.id }, { text: '❌ Cancelar', callback_data: 'task:cancel:' + draft.id }]] }; }
function telegramProposeTask_(sheetId, config, userId, original, correction) {
  var draft = telegramTaskParse_(sheetId, config, userId, original, correction); telegramSaveTaskProposal_(sheetId, userId, draft);
  return { text: telegramTaskProposalText_(draft), reply_markup: telegramTaskKeyboard_(draft) };
}
function telegramCreateTask_(sheetId, config, draft) {
  var lock = (typeof LockService !== 'undefined' && LockService.getScriptLock) ? LockService.getScriptLock() : null;
  if (lock) lock.waitLock(5000);
  try {
    var origin = '🤖 Telegram ' + draft.id + ' · ' + Utilities.formatDate(new Date(), config.timezone, 'yyyy-MM-dd');
    var added = agregarTarea_(sheetId, config, { texto: draft.texto, proyecto: draft.proyecto, vence: draft.vence, prioridad: draft.prioridad, origen: origin, espera: draft.espera, link: '' });
    if (!added) throw new Error('Esta propuesta ya fue creada o coincide exactamente con una tarea existente.');
    var id = idTarea_(draft.texto, origin); espejarTareaInmediato_(sheetId, config, id); cacheInvalidar_(sheetId, CACHE_MISEGUIMIENTO_);
    return id;
  } finally { if (lock) lock.releaseLock(); }
}
function telegramSimilarTask_(sheetId, config, draft) {
  var norm = function (v) { return String(v || '').toLowerCase().replace(/[^a-záéíóúüñ0-9]+/gi, ' ').trim(); };
  var wanted = norm(draft.texto);
  return listarTareas_(sheetId, config).filter(function (t) { return t.estado !== 'Hecha' && norm(t.texto) === wanted && (!draft.proyecto || !t.proyecto || norm(t.proyecto) === norm(draft.proyecto)); }).slice(0, 3);
}
function telegramTaskCallback_(sheetId, config, userId, chatId, data) {
  var m = /^task:(create|adjust|cancel|force):([A-Za-z0-9]+)$/.exec(String(data || ''));
  if (!m) return;
  var draft = telegramReadTaskProposal_(sheetId, userId);
  if (!draft || draft.id !== m[2] || !draft.expires || draft.expires < Date.now()) return telegramRequest_(sheetId, 'sendMessage', { chat_id: chatId, text: 'Esta propuesta ya venció. Envía /task nuevamente.' });
  if (m[1] === 'cancel') { telegramProps_().deleteProperty(telegramTaskKey_(sheetId, userId)); return telegramRequest_(sheetId, 'sendMessage', { chat_id: chatId, text: 'Listo, descarté la propuesta.' }); }
  if (m[1] === 'adjust') { draft.adjusting = true; telegramSaveTaskProposal_(sheetId, userId, draft); return telegramRequest_(sheetId, 'sendMessage', { chat_id: chatId, text: '¿Qué deseas ajustar? Por ejemplo: “para el viernes” o “el proyecto es AI Academy”.' }); }
  var similar = telegramSimilarTask_(sheetId, config, draft);
  if (m[1] === 'create' && similar.length) {
    draft.duplicateConfirmed = true; telegramSaveTaskProposal_(sheetId, userId, draft);
    return telegramRequest_(sheetId, 'sendMessage', { chat_id: chatId, text: 'Ya hay una tarea abierta muy similar:\n• ' + similar[0].texto + '\n\n¿Deseas crear otra de todas formas?', reply_markup: { inline_keyboard: [[{ text: '⚠️ Crear de todas formas', callback_data: 'task:force:' + draft.id }, { text: '❌ Cancelar', callback_data: 'task:cancel:' + draft.id }]] } });
  }
  if (m[1] === 'force' && !draft.duplicateConfirmed) return;
  telegramProps_().deleteProperty(telegramTaskKey_(sheetId, userId));
  var id = telegramCreateTask_(sheetId, config, draft);
  return telegramRequest_(sheetId, 'sendMessage', { chat_id: chatId, text: '✅ Tarea creada.\n\n• ' + draft.texto + '\n• Id: ' + id + '\n\nFuentes: Tareas' });
}

function telegramAnswer_(sheetId, config, userId, text) {
  var trimmed = String(text || '').trim(), m;
  var pending = telegramReadTaskProposal_(sheetId, userId);
  if (pending && pending.adjusting && trimmed && trimmed.charAt(0) !== '/') return telegramProposeTask_(sheetId, config, userId, pending.original, trimmed);
  if (/^(?:\/start|\/help)(?:\s|$)|^¿?(?:qué|que) (?:eres|puedes hacer(?: por m[ií])?)\??$/i.test(trimmed)) return telegramTaskCommands_();
  if (/^\/(?:semana|mis_tareas)(?:\s|$)|(?:mis )?tareas?.*(?:esta )?semana|(?:esta )?semana.*tareas?/i.test(trimmed)) return telegramWeekTasks_(sheetId, config);
  m = /^\/task\s+(.+)$/i.exec(trimmed);
  if (m) return telegramProposeTask_(sheetId, config, userId, m[1], '');
  if (/^\/task(?:\s|$)/i.test(trimmed)) return 'Escribe /task seguido de la tarea. Ejemplo: /task Enviar video a Carol mañana.';
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
  if (method === 'sendMessage') {
    var formatted = {}; Object.keys(payload || {}).forEach(function (key) { formatted[key] = payload[key]; });
    formatted.text = telegramRenderHtml_(formatted.text);
    formatted.parse_mode = 'HTML';
    payload = formatted;
  }
  var res = UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/' + method, {
    method: 'post', contentType: 'application/json', payload: JSON.stringify(payload || {}), muteHttpExceptions: true
  });
  var body = res.getContentText();
  var json;
  try { json = JSON.parse(body); } catch (e) { json = {}; }
  if (res.getResponseCode() !== 200 || !json.ok) throw new Error('Telegram no aceptó la operación ' + method + '.');
  return json.result;
}

function telegramConfigureCommands_(sheetId) {
  return telegramRequest_(sheetId, 'setMyCommands', { commands: [
    { command: 'help', description: 'Qué puedo hacer' },
    { command: 'hoy', description: 'Tareas abiertas' },
    { command: 'semana', description: 'Tareas de esta semana' },
    { command: 'bloqueos', description: 'Bloqueos activos' },
    { command: 'proyecto', description: 'Consultar un proyecto' },
    { command: 'task', description: 'Proponer una nueva tarea' }
  ] });
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
  telegramConfigureCommands_(sheetId);
  telegramRequest_(sheetId, 'setWebhook', { url: telegramWebhookUrl_(config, route), allowed_updates: ['message', 'callback_query'] });
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
  var callback = update.callback_query || {};
  var msg = callback.message || update.message || {}, from = callback.from || msg.from || {}, text = String(msg.text || '');
  var pair = telegramJson_(sheetId, 'pairing');
  var prefix = '/start pair_';
  if (!callback.id && text.indexOf(prefix) === 0 && pair && pair.expires > Date.now() && text.slice(prefix.length) === pair.nonce && msg.chat && msg.chat.type === 'private') {
    props.setProperty(telegramPropKey_(sheetId, 'allowedUserId'), String(from.id));
    props.deleteProperty(telegramPropKey_(sheetId, 'pairing'));
    setAjustes_(sheetId, config.sheets.settings, { 'telegram.enabled': 'true', 'telegram.pairingStatus': 'connected', 'telegram.userLabel': String(from.first_name || 'Usuario'), 'telegram.lastConnected': Utilities.formatDate(new Date(), config.timezone, 'yyyy-MM-dd HH:mm') });
    telegramRequest_(sheetId, 'sendMessage', { chat_id: msg.chat.id, text: '✅ CoS conectado.\n\n' + telegramTaskCommands_() });
    cache.put(seenKey, '1', 21600); return telegramHtml_('ok');
  }
  if (String(props.getProperty(telegramPropKey_(sheetId, 'allowedUserId')) || '') !== String(from.id || '') || !msg.chat || msg.chat.type !== 'private') { cache.put(seenKey, '1', 21600); return telegramHtml_('ok'); }
  if (callback.id) {
    try { telegramRequest_(sheetId, 'answerCallbackQuery', { callback_query_id: callback.id }); telegramTaskCallback_(sheetId, config, from.id, msg.chat.id, callback.data); }
    catch (err) { try { telegramRequest_(sheetId, 'sendMessage', { chat_id: msg.chat.id, text: 'No pude crear la tarea. Revisa la propuesta e inténtalo nuevamente.' }); } catch (ignore) {} }
    cache.put(seenKey, '1', 21600); return telegramHtml_('ok');
  }
  if (text) {
    var answer;
    try { answer = telegramAnswer_(sheetId, config, from.id, text); }
    catch (err) { answer = (err && err.message) ? String(err.message) : 'No pude completar la consulta ahora. Intenta de nuevo en unos minutos.'; }
    var payload = typeof answer === 'object' ? answer : { text: telegramLimit_(answer) };
    payload.chat_id = msg.chat.id; payload.text = telegramLimit_(payload.text);
    telegramSendMessage_(sheetId, payload);
    telegramWriteContext_(sheetId, from.id, text, telegramStripSources_(payload.text));
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

/** Borra por completo la conexión local: token, rutas, allowlist y filas telegram.* de Ajustes. */
function restablecerTelegram(sheetId, config) {
  var props = telegramProps_();
  if (telegramToken_(sheetId)) { try { telegramRequest_(sheetId, 'deleteWebhook', { drop_pending_updates: true }); } catch (e) {} }
  var prefix = telegramPropKey_(sheetId, '');
  Object.keys(props.getProperties()).forEach(function (key) { if (key.indexOf(prefix) === 0) props.deleteProperty(key); });

  var sh = ensureKeyValueTab_(sheetId, config.sheets.settings), map = getHeaderMap_(sh);
  var rows = sh.getDataRange().getValues(), keyIndex = map.key - 1;
  var kept = rows.filter(function (row, index) { return index === 0 || String(row[keyIndex] || '').indexOf('telegram.') !== 0; });
  var removed = rows.length - kept.length;
  if (removed) { sh.clearContents(); sh.getRange(1, 1, kept.length, kept[0].length).setValues(kept); }
  return { ok: true, removedSettings: removed };
}
