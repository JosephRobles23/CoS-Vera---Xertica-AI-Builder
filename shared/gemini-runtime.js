/**
 * gemini-runtime.js — Único puente HTTP con Gemini (Google AI Studio).
 *
 * Contrato (ver Docs/engineering-playbook.md#reglas-del-bridge-de-gemini):
 *  - Nadie más llama a UrlFetchApp para el LLM; todo pasa por callGemini_.
 *  - La API key se lee de Script Properties (GEMINI_API_KEY); si falta, falla rápido.
 *  - El modelo se pasa por parámetro (viene de CONFIG); el bridge NO lo hardcodea.
 *  - Reintento simple ante 429/5xx; 4xx no se reintenta; 200 vacío/bloqueado falla claro.
 *
 * Sin import/export: runtime de Apps Script (namespace global). Privados con sufijo "_".
 */

var GEMINI_ENDPOINT_ = 'https://generativelanguage.googleapis.com/v1beta/models';

/** Lee la API key de las Script Properties de la librería. Falla rápido si no está. */
function getGeminiKey_() {
  var key = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!key) {
    throw new Error('Falta GEMINI_API_KEY en las Script Properties de la librería ' +
      '(Configuración del proyecto → Propiedades del script).');
  }
  return key;
}

/**
 * Llama a models.generateContent y devuelve el texto generado.
 *
 * @param {string} model       ID del modelo, p.ej. 'gemini-2.5-flash' (desde CONFIG).
 * @param {string} systemText  Bloque de sistema ya compuesto (soul + user + task).
 * @param {string} userText    Bloque de usuario (solo datos).
 * @param {Object} [opts]      { maxOutputTokens?:number, temperature?:number, responseSchema?:Object }
 * @return {string} texto generado (no vacío). Con responseSchema, es JSON como string (parsear afuera).
 */
function callGemini_(model, systemText, userText, opts) {
  if (!model) throw new Error('callGemini_: falta el ID de modelo.');
  opts = opts || {};

  var generationConfig = {
    temperature: (opts.temperature == null ? 0.4 : opts.temperature)
  };
  // SIN techo de salida por defecto. Los modelos Gemini 3.x "piensan" (thinking tokens);
  // un maxOutputTokens bajo se consume razonando → HTTP 200 con content vacío y
  // finishReason:MAX_TOKENS. Al omitirlo, el modelo usa su máximo y siempre queda espacio
  // para la respuesta visible. Solo se limita si el caller lo pide explícito.
  if (opts.maxOutputTokens) generationConfig.maxOutputTokens = opts.maxOutputTokens;
  // Salida estructurada: fuerza JSON contra un esquema (subconjunto OpenAPI). El JSON llega
  // como texto en parts[].text (extractGeminiText_ no cambia); el caller hace JSON.parse.
  if (opts.responseSchema) {
    generationConfig.responseMimeType = 'application/json';
    generationConfig.responseSchema = opts.responseSchema;
  }

  var payload = {
    systemInstruction: { parts: [{ text: String(systemText == null ? '' : systemText) }] },
    contents: [{ role: 'user', parts: [{ text: String(userText == null ? '' : userText) }] }],
    generationConfig: generationConfig
  };

  var url = GEMINI_ENDPOINT_ + '/' + encodeURIComponent(model) + ':generateContent';
  var options = {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-goog-api-key': getGeminiKey_() },  // key en header, nunca en la URL/logs
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  var lastErr = '';
  for (var intento = 1; intento <= 2; intento++) {
    var res  = UrlFetchApp.fetch(url, options);
    var code = res.getResponseCode();
    var body = res.getContentText();

    if (code === 200) {
      var text = extractGeminiText_(body);
      if (text) return text;
      // 200 sin texto (bloqueo de seguridad, finishReason:MAX_TOKENS, etc.): reintentar no ayuda.
      lastErr = 'Respuesta 200 sin texto utilizable: ' + resumenCuerpo_(body);
      break;
    }

    lastErr = 'HTTP ' + code + ': ' + resumenCuerpo_(body);
    if (code === 429 || code >= 500) { Utilities.sleep(1500); continue; }  // transitorio
    break;  // 4xx no transitorio (key inválida, modelo inexistente, etc.)
  }

  throw new Error('Gemini falló: ' + lastErr);
}

/** Consulta pública bajo demanda: Google Search, respuesta breve y fuentes verificables. */
function callGeminiGrounded_(model, systemText, userText) {
  if (!model) throw new Error('callGeminiGrounded_: falta el ID de modelo.');
  var payload = {
    systemInstruction: { parts: [{ text: String(systemText == null ? '' : systemText) }] },
    contents: [{ role: 'user', parts: [{ text: String(userText == null ? '' : userText) }] }],
    generationConfig: { temperature: 0.2 },
    tools: [{ googleSearch: {} }]
  };
  var url = GEMINI_ENDPOINT_ + '/' + encodeURIComponent(model) + ':generateContent';
  var res = UrlFetchApp.fetch(url, {
    method: 'post', contentType: 'application/json', headers: { 'x-goog-api-key': getGeminiKey_() },
    payload: JSON.stringify(payload), muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) throw new Error('La investigación web no está disponible en este momento.');
  var result = extractGeminiGrounded_(res.getContentText());
  if (!result.text) throw new Error('La investigación web no devolvió una respuesta utilizable.');
  return result;
}

function extractGeminiGrounded_(body) {
  var json;
  try { json = JSON.parse(body); } catch (e) { return { text: '', sources: [] }; }
  var cand = json.candidates && json.candidates[0], metadata = cand && cand.groundingMetadata;
  var seen = {}, sources = [];
  ((metadata && metadata.groundingChunks) || []).forEach(function (chunk) {
    var web = chunk && chunk.web, url = web && web.uri;
    if (url && !seen[url]) { seen[url] = true; sources.push({ title: String(web.title || url), url: String(url) }); }
  });
  return { text: extractGeminiText_(body), sources: sources.slice(0, 4) };
}

/**
 * Extrae el texto del primer candidate. Devuelve '' si vino bloqueado o sin partes,
 * para que callGemini_ lo trate como fallo claro (nunca escribimos un Summary vacío).
 */
function extractGeminiText_(body) {
  var json;
  try { json = JSON.parse(body); } catch (e) { return ''; }

  if (json.promptFeedback && json.promptFeedback.blockReason) return '';  // prompt bloqueado

  var cand = json.candidates && json.candidates[0];
  if (!cand) return '';

  var parts = cand.content && cand.content.parts;
  if (!parts || !parts.length) return '';

  var text = parts
    .map(function (p) { return (p && p.text) ? p.text : ''; })
    .join('')
    .trim();

  return text;
}

/** Recorta el cuerpo para mensajes de error legibles (evita volcar respuestas enormes). */
function resumenCuerpo_(body) {
  var s = String(body == null ? '' : body);
  return s.length > 300 ? s.slice(0, 300) + '…' : s;
}

/**
 * Smoke test manual — correr A MANO en el proyecto de la librería para verificar key + modelo.
 * Modelo fijo aquí solo por ser un helper de diagnóstico; el runtime real recibe el modelo de CONFIG.
 */
function smokeTestGemini() {
  var out = callGemini_('gemini-3.6-flash',
    'Eres un asistente breve.',
    'Responde solo con: OK CoS v0.5');   // sin techo de tokens → deja espacio tras el "thinking"
  Logger.log('Gemini smoke (%s chars): %s', out.length, out);
}
