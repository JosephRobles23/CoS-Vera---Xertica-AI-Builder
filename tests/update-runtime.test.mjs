/**
 * update-runtime.test.mjs — Auto-actualización (shared/update-runtime.js).
 * Corre con: npm test  (node --test tests/)
 *
 * Mockea la Apps Script REST API vía setFetch, enrutando por URL+método.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHarness, httpResponse } from './gas-harness.mjs';

const SELF = 'SELF_SCRIPT_ID';
const API = 'https://script.googleapis.com/v1/projects';

// libraryId real de CoSLib (== el que usa update-runtime.js).
const h0 = makeHarness();
const COSLIB = h0.api.COSLIB_ID_;

/** Manifiesto de la copia con la dependencia CoSLib en `version` (más libs extra opcionales). */
function manifestSource(version, extraLibs = []) {
  return JSON.stringify({
    timeZone: 'America/Lima',
    dependencies: {
      libraries: [
        { userSymbol: 'CoSLib', libraryId: COSLIB, version: String(version) },
        ...extraLibs
      ]
    }
  }, null, 2);
}

/** Content de la copia como lo devuelve projects.getContent. */
function contentBody(version, extraLibs = []) {
  return {
    scriptId: SELF,
    files: [
      { name: 'appsscript', type: 'JSON', source: manifestSource(version, extraLibs),
        functionSet: { values: [] } /* campo output-only que debe descartarse */ },
      { name: 'stub', type: 'SERVER_JS', source: 'function onOpen(){}', lastModifyUser: {} },
      { name: 'Sidebar', type: 'HTML', source: '<html>hola</html>' }
    ]
  };
}

/**
 * Enrutador de fetch. `versionsPages` es un array de páginas; cada página:
 *   { versions: [{versionNumber}], nextPageToken? }
 * Registra el último PUT en `state.put`.
 */
function router(contentVersion, versionsPages, opts = {}) {
  const state = { put: null, getVersionsUrls: [] };
  const pages = versionsPages.slice();
  const fetch = (url, options) => {
    const method = (options.method || 'get').toLowerCase();
    if (url.includes('/' + SELF + '/content') && method === 'get') {
      if (opts.contentError) return opts.contentError;
      return httpResponse(200, contentBody(contentVersion, opts.extraLibs || []));
    }
    if (url.includes('/' + COSLIB + '/versions') && method === 'get') {
      state.getVersionsUrls.push(url);
      if (opts.versionsError) return opts.versionsError;
      const page = pages.shift() || { versions: [] };
      return httpResponse(200, page);
    }
    if (url.includes('/' + SELF + '/content') && method === 'put') {
      state.put = JSON.parse(options.payload);
      if (opts.putError) return opts.putError;
      return httpResponse(200, { scriptId: SELF });
    }
    throw new Error('URL no enrutada: ' + method + ' ' + url);
  };
  return { state, fetch };
}

test('elige la mayor versión aunque lleguen desordenadas', () => {
  const h = makeHarness();
  const { fetch } = router(4, [{ versions: [{ versionNumber: 3 }, { versionNumber: 6 }, { versionNumber: 4 }] }]);
  h.setFetch(fetch);
  const res = h.api.autoActualizar(SELF, 'TOKEN');
  assert.deepEqual({ ...res }, { actualizado: true, de: 4, a: 6 });
});

test('pagina versions siguiendo nextPageToken', () => {
  const h = makeHarness();
  const { state, fetch } = router(6, [
    { versions: [{ versionNumber: 6 }, { versionNumber: 50 }], nextPageToken: 'P2' },
    { versions: [{ versionNumber: 51 }] }
  ]);
  h.setFetch(fetch);
  const res = h.api.autoActualizar(SELF, 'TOKEN');
  assert.equal(res.a, 51);
  assert.equal(state.getVersionsUrls.length, 2);
  assert.match(state.getVersionsUrls[1], /pageToken=P2/);
});

test('el PUT preserva todos los archivos y solo cambia la versión', () => {
  const h = makeHarness();
  const { state, fetch } = router(5, [{ versions: [{ versionNumber: 7 }] }]);
  h.setFetch(fetch);
  h.api.autoActualizar(SELF, 'TOKEN');

  const files = state.put.files;
  assert.equal(files.length, 3);                                   // manifiesto + stub + Sidebar
  files.forEach((f) => assert.deepEqual(Object.keys(f).sort(), ['name', 'source', 'type']));  // sin functionSet, etc.
  assert.equal(files.find((f) => f.name === 'stub').source, 'function onOpen(){}');
  assert.equal(files.find((f) => f.name === 'Sidebar').source, '<html>hola</html>');

  const man = JSON.parse(files.find((f) => f.name === 'appsscript').source);
  assert.equal(man.dependencies.libraries[0].version, '7');       // string, no número
  assert.equal(typeof man.dependencies.libraries[0].version, 'string');
});

test('con dos dependencias, parcha solo CoSLib (por libraryId)', () => {
  const h = makeHarness();
  const otra = { userSymbol: 'Otra', libraryId: 'OTRA_LIB_ID', version: '2' };
  const { state, fetch } = router(6, [{ versions: [{ versionNumber: 9 }] }], { extraLibs: [otra] });
  h.setFetch(fetch);
  const res = h.api.autoActualizar(SELF, 'TOKEN');
  assert.equal(res.a, 9);

  const libs = JSON.parse(state.put.files.find((f) => f.name === 'appsscript').source).dependencies.libraries;
  assert.equal(libs.find((l) => l.libraryId === COSLIB).version, '9');
  assert.equal(libs.find((l) => l.libraryId === 'OTRA_LIB_ID').version, '2');   // intacta
});

test('ya al día (misma versión) → no hace PUT', () => {
  const h = makeHarness();
  const { state, fetch } = router(6, [{ versions: [{ versionNumber: 6 }] }]);
  h.setFetch(fetch);
  const res = h.api.autoActualizar(SELF, 'TOKEN');
  assert.deepEqual({ ...res }, { actualizado: false, motivo: 'ya-al-dia', a: 6 });
  assert.equal(state.put, null);
});

test('la última publicada es menor (downgrade) → no hace PUT', () => {
  const h = makeHarness();
  const { state, fetch } = router(6, [{ versions: [{ versionNumber: 5 }] }]);
  h.setFetch(fetch);
  const res = h.api.autoActualizar(SELF, 'TOKEN');
  assert.equal(res.motivo, 'ya-al-dia');
  assert.equal(res.a, 6);
  assert.equal(state.put, null);
});

test('sin dependencia CoSLib en el manifiesto → error, sin PUT', () => {
  const h = makeHarness();
  const state = { put: null };
  h.setFetch((url, options) => {
    const method = (options.method || 'get').toLowerCase();
    if (url.includes('/content') && method === 'get') {
      return httpResponse(200, {
        scriptId: SELF,
        files: [{ name: 'appsscript', type: 'JSON', source: JSON.stringify({ dependencies: { libraries: [] } }) }]
      });
    }
    if (method === 'put') { state.put = true; return httpResponse(200, {}); }
    throw new Error('no enrutado: ' + url);
  });
  const res = h.api.autoActualizar(SELF, 'TOKEN');
  assert.equal(res.actualizado, false);
  assert.equal(res.motivo, 'error');
  assert.match(res.detalle, /CoSLib/);
  assert.equal(state.put, null);
});

test('403 de API no habilitada → motivo api-no-habilitada con ayuda', () => {
  const h = makeHarness();
  h.setFetch(() => httpResponse(403,
    { error: { status: 'PERMISSION_DENIED', message: 'Apps Script API has not been used in project ... usersettings' } }));
  const res = h.api.autoActualizar(SELF, 'TOKEN');
  assert.equal(res.actualizado, false);
  assert.equal(res.motivo, 'api-no-habilitada');
  assert.match(res.ayuda, /usersettings/);
});

test('PUT con error HTTP → motivo error-http, sin marcar actualizado', () => {
  const h = makeHarness();
  const { fetch } = router(5, [{ versions: [{ versionNumber: 7 }] }],
    { putError: httpResponse(500, { error: { message: 'boom' } }) });
  h.setFetch(fetch);
  const res = h.api.autoActualizar(SELF, 'TOKEN');
  assert.equal(res.actualizado, false);
  assert.equal(res.motivo, 'error-http');
  assert.match(res.detalle, /500/);
});

test('orden de llamadas y header Authorization', () => {
  const h = makeHarness();
  const { fetch } = router(5, [{ versions: [{ versionNumber: 7 }] }]);
  h.setFetch(fetch);
  h.api.autoActualizar(SELF, 'TOKEN');

  const calls = h.fetchCalls;
  assert.match(calls[0].url, new RegExp('/' + SELF + '/content'));   // GET content
  assert.equal((calls[0].options.method || 'get').toLowerCase(), 'get');
  assert.match(calls[1].url, new RegExp('/' + COSLIB + '/versions')); // GET versions
  assert.match(calls[2].url, new RegExp('/' + SELF + '/content'));    // PUT content
  assert.equal(calls[2].options.method.toLowerCase(), 'put');
  calls.forEach((c) => assert.equal(c.options.headers.Authorization, 'Bearer TOKEN'));
});

test('coerción de versión: manifiesto "6" (string) vs API 7 (número) actualiza', () => {
  const h = makeHarness();
  const { fetch } = router('6', [{ versions: [{ versionNumber: 7 }] }]);
  h.setFetch(fetch);
  const res = h.api.autoActualizar(SELF, 'TOKEN');
  assert.deepEqual({ ...res }, { actualizado: true, de: 6, a: 7 });
});
