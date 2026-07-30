/**
 * update-runtime.js — Auto-actualización de la copia del líder a la última versión de CoSLib.
 *
 * El líder pulsa "Actualizar CoS a la última versión" en el menú; el stub llama
 * autoActualizar(scriptId, token) con SU propio scriptId y SU token OAuth. La función:
 *   1. lee el contenido de la copia (su manifiesto) → versión actual de CoSLib + libraryId,
 *   2. consulta las versiones publicadas de la librería y elige la mayor,
 *   3. si hay una mayor, reescribe el HEAD de la copia con el manifiesto parcheado. Como
 *      updateContent REEMPLAZA todos los archivos, se reenvían todos verbatim y solo se cambia
 *      el número de versión de la dependencia CoSLib.
 *
 * El token lleva los scopes del STUB (no de la librería), por eso el stub declara
 * `script.projects`. Todo por REST porque Apps Script no expone estas operaciones como servicio.
 * Mismo patrón token + UrlFetchApp que forms-runtime.js.
 *
 * Sin import/export: runtime de Apps Script. Privados con sufijo "_".
 */

var SCRIPT_API_ = 'https://script.googleapis.com/v1/projects';

/** libraryId de CoSLib (== scriptId del proyecto librería). Se usa para ubicar la dependencia
 *  correcta en el manifiesto aunque el líder haya renombrado el userSymbol o tenga más de una. */
var COSLIB_ID_ = '1ywuYbBTxVePDUvbpez6lVyl7W1IW7cBnQQVhw6etOf8eZIXD5zT_wKyx';

// --- Puros (testeables sin red) ---

/** Elige el mayor versionNumber de la lista (la API no garantiza orden). @return {number} */
function elegirVersionObjetivo_(versions) {
  var max = 0;
  (versions || []).forEach(function (v) {
    var n = Number(v && v.versionNumber);
    if (!isNaN(n) && n > max) max = n;
  });
  return max;
}

/** Extrae el file de manifiesto (appsscript.json) del content de la API. */
function manifestFile_(files) {
  var m = null;
  (files || []).forEach(function (f) { if (f.name === 'appsscript' && f.type === 'JSON') m = f; });
  if (!m) throw new Error('La copia no tiene manifiesto (appsscript.json).');
  return m;
}

/** Lee la dependencia CoSLib del manifiesto de la copia (por libraryId). @return {{version:number}} */
function leerVersionActual_(files) {
  var manifest = JSON.parse(manifestFile_(files).source);
  var libs = (manifest.dependencies && manifest.dependencies.libraries) || [];
  for (var i = 0; i < libs.length; i++) {
    if (libs[i].libraryId === COSLIB_ID_) return { version: Number(libs[i].version) };
  }
  throw new Error('El manifiesto de la copia no referencia la librería CoSLib.');
}

/**
 * Parcha el source del manifiesto: fija version=String(nuevaVersion) en la dependencia cuyo
 * libraryId es COSLIB_ID_ (no por userSymbol: el líder pudo renombrarlo). Deja intacto el resto.
 * @return {string} nuevo source JSON
 */
function parcharManifiesto_(manifestSource, nuevaVersion) {
  var manifest = JSON.parse(manifestSource);
  var libs = (manifest.dependencies && manifest.dependencies.libraries) || [];
  var lib = null;
  for (var i = 0; i < libs.length; i++) {
    if (libs[i].libraryId === COSLIB_ID_) { lib = libs[i]; break; }
  }
  if (!lib) throw new Error('El manifiesto de la copia no referencia la librería CoSLib.');
  lib.version = String(nuevaVersion);
  return JSON.stringify(manifest, null, 2);
}

/**
 * Reconstruye el array de files para updateContent: conserva solo {name, type, source} (descarta
 * campos output-only como functionSet/lastModifyUser), reemplazando el source del manifiesto.
 */
function reconstruirFiles_(files, nuevoManifestSource) {
  return (files || []).map(function (f) {
    var esManifiesto = (f.name === 'appsscript' && f.type === 'JSON');
    return { name: f.name, type: f.type, source: esManifiesto ? nuevoManifestSource : f.source };
  });
}

// --- Red (Apps Script REST API) ---

/**
 * Llama a la Apps Script API. @return {{body:Object}} en éxito, o {{error:Object}} con un
 * resultado listo para el stub. Detecta el 403 de "API no habilitada" para dar un mensaje guía.
 */
function fetchApi_(url, method, token, payload) {
  var options = {
    method: method,
    headers: { Authorization: 'Bearer ' + token },
    muteHttpExceptions: true
  };
  if (payload) { options.contentType = 'application/json'; options.payload = JSON.stringify(payload); }

  var res = UrlFetchApp.fetch(url, options);
  var code = res.getResponseCode();
  var text = res.getContentText();

  if (code === 200) {
    try { return { body: JSON.parse(text) }; }
    catch (e) { return { error: { actualizado: false, motivo: 'error-http', detalle: 'Respuesta no-JSON: ' + resumenCuerpo_(text) } }; }
  }
  if (code === 403 && /has not been used|usersettings|SERVICE_DISABLED|accessNotConfigured|PERMISSION_DENIED/i.test(text)) {
    return { error: { actualizado: false, motivo: 'api-no-habilitada', ayuda: 'script.google.com/home/usersettings' } };
  }
  return { error: { actualizado: false, motivo: 'error-http', detalle: 'HTTP ' + code + ': ' + resumenCuerpo_(text) } };
}

/** Lista TODAS las versiones publicadas de la librería, siguiendo nextPageToken.
 *  @return {{lista:Array}} o {{error:Object}} */
function listarVersiones_(libraryId, token) {
  var lista = [];
  var pageToken = '';
  var base = SCRIPT_API_ + '/' + encodeURIComponent(libraryId) + '/versions';
  do {
    var url = base + (pageToken ? '?pageToken=' + encodeURIComponent(pageToken) : '');
    var res = fetchApi_(url, 'get', token, null);
    if (res.error) return { error: res.error };
    lista = lista.concat(res.body.versions || []);
    pageToken = res.body.nextPageToken || '';
  } while (pageToken);
  return { lista: lista };
}

/**
 * Actualiza la copia del líder a la última versión publicada de CoSLib. Idempotente: si ya está
 * al día (o la última es menor) no escribe nada.
 *
 * @param {string} selfScriptId  ScriptApp.getScriptId() de la copia
 * @param {string} oauthToken    ScriptApp.getOAuthToken() de la copia (scopes del stub)
 * @return {Object} uno de:
 *   { actualizado:true, de:number, a:number }
 *   { actualizado:false, motivo:'ya-al-dia', a:number }
 *   { actualizado:false, motivo:'api-no-habilitada', ayuda:string }
 *   { actualizado:false, motivo:'error-http'|'error', detalle:string }
 */
function autoActualizar(selfScriptId, oauthToken) {
  try {
    // 1. Contenido de la copia → versión actual de CoSLib
    var contentRes = fetchApi_(SCRIPT_API_ + '/' + encodeURIComponent(selfScriptId) + '/content', 'get', oauthToken, null);
    if (contentRes.error) return contentRes.error;
    var files = contentRes.body.files || [];
    var actual = leerVersionActual_(files).version;

    // 2. Versiones publicadas de la librería → mayor
    var versiones = listarVersiones_(COSLIB_ID_, oauthToken);
    if (versiones.error) return versiones.error;
    var objetivo = elegirVersionObjetivo_(versiones.lista);

    // 3. Ya al día / la última es menor → no escribir
    if (!objetivo || objetivo <= actual) {
      return { actualizado: false, motivo: 'ya-al-dia', a: actual };
    }

    // 4. Reescribir HEAD con el manifiesto parcheado (reenviando TODOS los archivos)
    var nuevoManifest = parcharManifiesto_(manifestFile_(files).source, objetivo);
    var putRes = fetchApi_(
      SCRIPT_API_ + '/' + encodeURIComponent(selfScriptId) + '/content',
      'put', oauthToken, { files: reconstruirFiles_(files, nuevoManifest) });
    if (putRes.error) return putRes.error;

    return { actualizado: true, de: actual, a: objetivo };
  } catch (e) {
    return { actualizado: false, motivo: 'error', detalle: e.message };
  }
}
