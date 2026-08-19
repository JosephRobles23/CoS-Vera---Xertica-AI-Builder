/**
 * mcp-runtime.js — API privada JSON que consume el Cloudflare Worker de Vera-MCP.
 *
 * El Worker (multi-tenant) resuelve token→tenant y hace POST al /exec de ESTE líder con
 * `?mcp=1` y un body JSON `{ op, secret, args, nonce }`. Aquí se valida el secreto por-tenant
 * y se ejecuta la operación reusando la lógica existente (telegram*_, tareas, wiki). El
 * `sheetId` nunca viaja en el request: es implícito en cuál /exec se llamó → aislamiento.
 *
 * Contrato de salida (siempre HTTP 200 — limitación de Apps Script): ContentService JSON
 * `{ ok:true, … }` o `{ ok:false, error:'…' }`; el Worker lo traduce a errores de tool MCP.
 *
 * El enrutado entra por `webAction` (webapp-runtime.js), no por el stub → llega a los líderes
 * por versión de librería, sin re-copiar stubs.
 *
 * Sin import/export: runtime de Apps Script (namespace global). Privados con sufijo "_".
 */

var MCP_WIKI_BODY_MAX_ = 3000;   // recorte del cuerpo de cada página en search_wiki

// --- Secreto por-tenant (idioma del repo: espejo de telegramProps_/telegramPropKey_) ---
function mcpProps_() { return PropertiesService.getScriptProperties(); }
function mcpPropKey_(sheetId, name) { return 'mcp:' + String(sheetId) + ':' + name; }
function mcpSecret_(sheetId) { return mcpProps_().getProperty(mcpPropKey_(sheetId, 'secret')) || ''; }

/** Genera+guarda el secreto por-tenant si no existe; lo usa el enrollment (futuro) y los tests. */
function ensureMcpSecret_(sheetId) {
  var key = mcpPropKey_(sheetId, 'secret');
  var cur = mcpProps_().getProperty(key);
  if (cur) return cur;
  var secret = String(Utilities.getUuid()).replace(/-/g, '');
  mcpProps_().setProperty(key, secret);
  return secret;
}

function mcpJson_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
function mcpError_(msg) { return mcpJson_({ ok: false, error: String(msg == null ? 'error' : msg) }); }

/**
 * Dispatcher del lado GAS. Entra por webAction cuando `e.parameter.mcp` está presente (POST).
 * @return {ContentService.TextOutput} JSON.
 */
function mcpAction(e, sheetId, config) {
  var body;
  try { body = JSON.parse((e && e.postData && e.postData.contents) || '{}'); }
  catch (err) { return mcpError_('bad-request'); }

  var op = String(body.op || '');
  var args = body.args || {};

  var stored = mcpSecret_(sheetId);
  if (!stored) return mcpError_('not-enrolled');

  // challenge: prueba de enrollment. Firma el nonce con el secreto guardado; el Worker lo
  // verifica con el secreto que recibió en /enroll (challenge-response, sin secreto compartido).
  if (op === 'challenge') {
    var nonce = String(body.nonce || '');
    if (!nonce) return mcpError_('missing-nonce');
    var sig = Utilities.base64Encode(Utilities.computeHmacSha256Signature(nonce, stored));
    return mcpJson_({ ok: true, sig: sig });
  }

  // Resto de ops: exigen el secreto por-tenant (igualdad, como el route-token de Telegram).
  if (String(body.secret || '') !== stored) return mcpError_('unauthorized');

  try {
    switch (op) {
      case 'list_tasks':
        return mcpJson_({ ok: true, tasks: mcpListTasks_(sheetId, config, args) });
      case 'search_wiki':
        return mcpJson_({ ok: true, pages: mcpSearchWiki_(sheetId, config, args) });
      case 'get_catalog':
        var cat = telegramTaskCatalog_(sheetId, config);
        return mcpJson_({ ok: true, people: cat.people, projects: cat.projects });
      case 'create_task':
        return mcpJson_(mcpCreateTaskOp_(sheetId, config, args));
      case 'edit_task':
        return mcpJson_({ ok: true, task: mcpEditTask_(sheetId, config, args) });
      case 'create_calendar_event':
        return mcpJson_({ ok: true, event: mcpCreateEvent_(config, args) });
      case 'edit_calendar_event':
        return mcpJson_({ ok: true, event: mcpEditEvent_(config, args) });
      default:
        return mcpError_('unknown-op');
    }
  } catch (err) {
    return mcpError_(err && err.message ? err.message : err);
  }
}

/** Vista pública de una tarea (oculta `fila` interno y campos que el cliente no necesita). */
function mcpTaskView_(t) {
  return {
    id: t.id, texto: t.texto, proyecto: t.proyecto, vence: t.vence,
    prioridad: t.prioridad, estado: t.estado, espera: t.espera, link: t.link,
    origen: t.origen, creada: t.creada
  };
}

// --- Tools ---

function mcpListTasks_(sheetId, config, args) {
  args = args || {};
  var incluirHechas = !!args.incluirHechas;
  var estado = args.estado ? String(args.estado) : '';
  var proyecto = args.proyecto ? String(args.proyecto).toLowerCase() : '';
  var prioridad = args.prioridad ? String(args.prioridad) : '';
  var desde = args.venceDesde ? String(args.venceDesde) : '';
  var hasta = args.venceHasta ? String(args.venceHasta) : '';
  return listarTareas_(sheetId, config).filter(function (t) {
    if (!incluirHechas && t.estado === 'Hecha') return false;
    if (estado && t.estado !== estado) return false;
    if (prioridad && t.prioridad !== prioridad) return false;
    if (proyecto && String(t.proyecto).toLowerCase().indexOf(proyecto) === -1) return false;
    if (desde && (!t.vence || t.vence < desde)) return false;
    if (hasta && (!t.vence || t.vence > hasta)) return false;
    return true;
  }).map(mcpTaskView_);
}

/** Retrieval crudo del wiki curado (NO llama a Gemini: el cliente MCP razona sobre el contexto). */
function mcpSearchWiki_(sheetId, config, args) {
  args = args || {};
  var query = String(args.query || '');
  var tipo = String(args.tipo || 'all');
  var tipos = tipo === 'all' ? ['projects', 'meetings', 'people'] : [tipo];
  var pages = [];
  tipos.forEach(function (tp) { pages = pages.concat(telegramWikiPages_(sheetId, config, tp)); });
  return telegramMatches_(pages, query).slice(0, 8).map(function (p) {
    return { name: p.name, file: p.file, body: String(p.body || '').slice(0, MCP_WIKI_BODY_MAX_) };
  });
}

/** Resuelve contra el catálogo; conserva el valor crudo si no matchea (texto libre, como crearTarea). */
function mcpResolveOrRaw_(value, candidates, label) {
  value = String(value || '').trim();
  if (!value) return '';
  var resolved = telegramResolveCatalog_(value, candidates, label);  // '' si no matchea; throw si ambiguo
  return resolved || value;
}

function mcpCreateTaskOp_(sheetId, config, args) {
  args = args || {};
  var texto = String(args.texto || '').trim();
  if (!texto) throw new Error('Falta el texto de la tarea.');
  var prioridad = ['Alta', 'Media', 'Baja'].indexOf(String(args.prioridad)) >= 0 ? String(args.prioridad) : 'Media';
  var vence = String(args.vence || '').trim();
  if (vence && !/^\d{4}-\d{2}-\d{2}$/.test(vence)) throw new Error('Fecha inválida: usa YYYY-MM-DD o vacío.');

  var catalog = telegramTaskCatalog_(sheetId, config);
  var proyecto = mcpResolveOrRaw_(args.proyecto, catalog.projects, 'el proyecto');
  var espera = mcpResolveOrRaw_(args.espera, catalog.people, 'la persona de quien esperas respuesta');

  var draft = { id: telegramTaskId_(), texto: texto, proyecto: proyecto, espera: espera, vence: vence, prioridad: prioridad };
  var similar = telegramSimilarTask_(sheetId, config, draft);
  if (similar.length && !args.force) {
    return { ok: true, duplicate: true, similar: similar.map(mcpTaskView_) };
  }
  return { ok: true, id: mcpCreateTask_(sheetId, config, draft) };
}

/** Espejo de telegramCreateTask_ con origen propio ('🤖 MCP'). @return {string} id. */
function mcpCreateTask_(sheetId, config, draft) {
  var lock = (typeof LockService !== 'undefined' && LockService.getScriptLock) ? LockService.getScriptLock() : null;
  if (lock) lock.waitLock(5000);
  try {
    var origin = '🤖 MCP ' + draft.id + ' · ' + Utilities.formatDate(new Date(), config.timezone, 'yyyy-MM-dd');
    var added = agregarTarea_(sheetId, config, {
      texto: draft.texto, proyecto: draft.proyecto, vence: draft.vence,
      prioridad: draft.prioridad, origen: origin, espera: draft.espera, link: ''
    });
    if (!added) throw new Error('Esta tarea ya fue creada o coincide exactamente con una existente.');
    var id = idTarea_(draft.texto, origin);
    espejarTareaInmediato_(sheetId, config, id);
    cacheInvalidar_(sheetId, CACHE_MISEGUIMIENTO_);
    return id;
  } finally { if (lock) lock.releaseLock(); }
}

function mcpEditTask_(sheetId, config, args) {
  args = args || {};
  var id = String(args.id || '').trim();
  if (!id) throw new Error('Falta el id de la tarea.');
  var t = actualizarTarea(sheetId, config, id, args.campos || {});  // valida enums/fechas, espeja, invalida cache
  return mcpTaskView_(t);
}

// --- Sidebar: Conectar / Desconectar (funciones del server via dispatch) ---

/** URL base del Worker de Vera-MCP (UNA para todos los tenants). Vive en Script Properties de
 *  la librería (MCP_WORKER_URL), como GEMINI_API_KEY — no es config per-líder. */
function mcpWorkerUrl_() {
  return String(PropertiesService.getScriptProperties().getProperty('MCP_WORKER_URL') || '').trim().replace(/\/+$/, '');
}

/** Estado para el diálogo de conexión. No expone el secreto. */
function cargarMcp(sheetId, config) {
  var workerUrl = mcpWorkerUrl_();
  return {
    webApp: telegramWebAppStatus_(config),                 // reusa la validación de /exec de Telegram
    workerConfigured: !!workerUrl,
    connectorUrl: workerUrl ? workerUrl + '/mcp' : '',      // lo que el CLEVE pega en Claude/ChatGPT
    connected: !!mcpSecret_(sheetId)
  };
}

/**
 * Arranca la conexión: asegura el secreto por-tenant y lo registra en el Worker (/enroll) junto
 * a la webAppUrl. El Worker verifica por challenge-response y devuelve un pairing-code que el
 * CLEVE pega en /authorize. El secreto NUNCA llega al browser (solo viaja en este UrlFetch).
 * @return {{code, expiresInSeconds, connectorUrl}}
 */
function iniciarConexionMcp(sheetId, config) {
  var estado = cargarMcp(sheetId, config);
  if (!estado.webApp.ready) throw new Error(estado.webApp.message);
  if (!estado.workerConfigured) throw new Error('Falta configurar MCP_WORKER_URL en las Script Properties de la librería.');

  var secret = ensureMcpSecret_(sheetId);
  var res = UrlFetchApp.fetch(mcpWorkerUrl_() + '/enroll', {
    method: 'post', contentType: 'application/json',
    payload: JSON.stringify({ webAppUrl: telegramWebAppUrl_(config), secret: secret }),
    muteHttpExceptions: true
  });
  var json;
  try { json = JSON.parse(res.getContentText()); } catch (e) { json = null; }
  if (res.getResponseCode() !== 200 || !json || json.ok !== true || !json.code) {
    throw new Error(json && json.error
      ? 'El servidor MCP rechazó el emparejamiento (' + json.error + ').'
      : 'No se pudo contactar al servidor MCP. Revisa MCP_WORKER_URL y que la Web App esté publicada.');
  }
  return { code: String(json.code), expiresInSeconds: json.expiresInSeconds || 600, connectorUrl: estado.connectorUrl };
}

/** Desconecta: borra el secreto por-tenant → toda llamada Worker→GAS pasa a 'not-enrolled'. */
function desconectarMcp(sheetId, config) {
  mcpProps_().deleteProperty(mcpPropKey_(sheetId, 'secret'));
  return { ok: true };
}
