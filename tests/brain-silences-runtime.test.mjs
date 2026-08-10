/**
 * brain-silences-runtime.test.mjs — Change detection: scan de silencios (Fase 2).
 * Cubre: cálculo de días, marcado de entidades estancadas (con dedup por episodio y re-marcado
 * tras actividad), la bitácora, y el enganche 1×/día en runDispatcher detrás de brain.enabled.
 * Corre con: npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHarness } from './gas-harness.mjs';

const CONFIG = {
  sheets: { daily: 'Daily', weekly: 'Weekly', roster: 'Equipo', prompts: 'Prompts', settings: 'Ajustes' },
  models: { perRow: 'gemini-3.6-flash', consolidated: 'gemini-3.1-pro-preview' },
  timezone: 'America/Lima',
  dispatchWindowMin: 5,
  options: {}
};

const plain = (v) => JSON.parse(JSON.stringify(v));
const sub = (folder, name) => { const it = folder.getFoldersByName(name); return it.hasNext() ? it.next() : null; };

function brainHarness() {
  const h = makeHarness({
    scriptProperties: { GEMINI_API_KEY: 'K' },
    spreadsheets: { SID: {
      Ajustes: [['key', 'value'], ['brain.enabled', 'true'], ['brain.silenceDays', '7']],
      Equipo: [['Nombre', 'Correo', 'Rol']]
    } }
  });
  return h;
}
const rootOf = (h) => h.getDrive().getFolderById(h.api.getAjustes_('SID', 'Ajustes').brain.folderId);

// Escribe una página wiki de entidad con el frontmatter dado.
function ponerPagina(h, root, carpeta, file, fm, body) {
  h.api.escribirArchivoBrain_(h.api.carpetaBrain_(root, ['wiki', carpeta]), file, h.api.componerPagina_(fm, body || ''));
}
function leerPagina(h, root, carpeta, file) {
  return h.api.parsearPagina_(h.api.leerArchivoBrain_(h.api.carpetaBrain_(root, ['wiki', carpeta]), file));
}
const logDe = (h, root) => h.api.leerArchivoBrain_(h.api.carpetaBrain_(root, ['wiki']), 'log.md');

// --- días entre fechas ---

test('diasEntreISO_ cuenta días enteros en UTC', () => {
  const h = brainHarness();
  assert.equal(h.api.diasEntreISO_('2026-08-01', '2026-08-20'), 19);
  assert.equal(h.api.diasEntreISO_('2026-08-20', '2026-08-20'), 0);
  assert.equal(h.api.diasEntreISO_('basura', '2026-08-20'), 0);
});

// --- scan ---

test('scanSilencios_ marca lo estancado, respeta lo fresco y registra en el log', () => {
  const h = brainHarness();
  const config = h.api.construirConfig('SID', CONFIG);
  const root = h.api.ensureBrainFolder_('SID', config);

  ponerPagina(h, root, 'people', 'ada.md',
    { page_type: 'person', name: 'Ada', last_updated: '2026-08-01', open_blockers: ['falta legal'] });
  ponerPagina(h, root, 'people', 'bob.md',
    { page_type: 'person', name: 'Bob', last_updated: '2026-08-18', open_blockers: [] });   // fresco
  ponerPagina(h, root, 'projects', 'alpha.md',
    { page_type: 'project', name: 'Proyecto Alpha', last_updated: '2026-07-30', open_blockers: [] });

  const now = new Date(2026, 7, 20);   // 2026-08-20
  const hallazgos = h.api.scanSilencios_('SID', config, now);

  const names = hallazgos.map((x) => x.name).sort();
  assert.deepEqual(plain(names), ['Ada', 'Proyecto Alpha']);   // Bob no (fresco)
  const ada = hallazgos.find((x) => x.name === 'Ada');
  assert.equal(ada.dias, 19);
  assert.deepEqual(plain(ada.open_blockers), ['falta legal']);

  // marca el episodio en el frontmatter
  assert.equal(leerPagina(h, root, 'people', 'ada.md').frontmatter.silence_flagged, '2026-08-01');
  assert.equal(leerPagina(h, root, 'people', 'bob.md').frontmatter.silence_flagged, undefined);

  const log = logDe(h, root);
  assert.match(log, /scan de silencios · 2 estancado/);
  assert.match(log, /🔕 silencio · Ada · 19 días sin actualizar · 1 blocker/);
  assert.match(log, /🔕 silencio · Proyecto Alpha · 21 días sin actualizar\n/);   // sin blockers
});

test('scanSilencios_ no re-marca el mismo episodio (idempotente por last_updated)', () => {
  const h = brainHarness();
  const config = h.api.construirConfig('SID', CONFIG);
  const root = h.api.ensureBrainFolder_('SID', config);
  ponerPagina(h, root, 'people', 'ada.md',
    { page_type: 'person', name: 'Ada', last_updated: '2026-08-01', open_blockers: [] });

  const now = new Date(2026, 7, 20);
  assert.equal(h.api.scanSilencios_('SID', config, now).length, 1);
  const logTras1 = logDe(h, root);

  const now2 = new Date(2026, 7, 21);   // otro día, sigue estancada pero mismo episodio
  assert.equal(h.api.scanSilencios_('SID', config, now2).length, 0);
  assert.equal(logDe(h, root), logTras1, 'no vuelve a escribir en el log');
});

test('scanSilencios_ vuelve a marcar tras actividad (nuevo last_updated)', () => {
  const h = brainHarness();
  const config = h.api.construirConfig('SID', CONFIG);
  const root = h.api.ensureBrainFolder_('SID', config);
  ponerPagina(h, root, 'people', 'ada.md',
    { page_type: 'person', name: 'Ada', last_updated: '2026-08-01', open_blockers: [] });

  assert.equal(h.api.scanSilencios_('SID', config, new Date(2026, 7, 20)).length, 1);

  // simula un reporte nuevo que avanza last_updated (silence_flagged queda desfasado)
  const p = leerPagina(h, root, 'people', 'ada.md');
  p.frontmatter.last_updated = '2026-08-10';
  ponerPagina(h, root, 'people', 'ada.md', p.frontmatter, p.body);

  // vuelve a estancarse semanas después → se marca de nuevo
  assert.equal(h.api.scanSilencios_('SID', config, new Date(2026, 8, 5)).length, 1);
});

// --- enganche en runDispatcher ---

test('runDispatcher corre el scan 1×/día con brain.enabled y no lo repite', () => {
  const h = brainHarness();
  const config = h.api.construirConfig('SID', CONFIG);
  const root = h.api.ensureBrainFolder_('SID', config);
  ponerPagina(h, root, 'people', 'ada.md',
    { page_type: 'person', name: 'Ada', last_updated: '2026-08-01', open_blockers: [] });

  h.api.runDispatcher('SID', config, new Date(2026, 7, 20, 3, 0));
  const log1 = logDe(h, root);
  assert.match(log1, /scan de silencios/);

  h.api.runDispatcher('SID', config, new Date(2026, 7, 20, 3, 5));   // mismo día → guarda anti-dup
  assert.equal(logDe(h, root), log1, 'no repite el scan el mismo día');
});

test('runDispatcher NO corre el scan si brain está apagado', () => {
  const h = makeHarness({
    scriptProperties: { GEMINI_API_KEY: 'K' },
    spreadsheets: { SID: { Ajustes: [['key', 'value']], Equipo: [['Nombre', 'Correo', 'Rol']] } }   // brain.enabled ausente
  });
  const config = h.api.construirConfig('SID', CONFIG);
  h.api.runDispatcher('SID', config, new Date(2026, 7, 20, 3, 0));
  assert.equal(h.api.getAjustes_('SID', 'Ajustes').brain.folderId, '', 'no tocó el brain');
});
