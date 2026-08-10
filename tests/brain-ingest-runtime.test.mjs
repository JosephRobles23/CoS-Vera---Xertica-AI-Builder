/**
 * brain-ingest-runtime.test.mjs — Ingesta al second brain (Fase 1).
 * Cubre: parseo del JSON piggyback, resolución de proyectos, merge de eventos en secciones,
 * frontmatter merge, y la ingesta end-to-end (raw + páginas + log) incluyendo el enganche en
 * generarSummaryFila. Corre con: npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHarness, httpResponse, geminiOk } from './gas-harness.mjs';

const CONFIG = {
  sheets: { daily: 'Daily', weekly: 'Weekly', roster: 'Equipo', prompts: 'Prompts', settings: 'Ajustes' },
  models: { perRow: 'gemini-3.6-flash', consolidated: 'gemini-3.1-pro-preview' },
  timezone: 'America/Lima',
  dispatchWindowMin: 5,
  options: {}
};

const plain = (v) => JSON.parse(JSON.stringify(v));
const sub = (folder, name) => { const it = folder.getFoldersByName(name); return it.hasNext() ? it.next() : null; };
const file = (folder, name) => { const it = folder.getFilesByName(name); return it.hasNext() ? it.next() : null; };
const countFiles = (folder) => { const it = folder.getFiles(); let n = 0; while (it.hasNext()) { it.next(); n++; } return n; };
const occurrences = (s, sub) => s.split(sub).length - 1;

// Harness con brain activado y una respuesta de Gemini fija (JSON del responseSchema).
function brainHarness(geminiJson) {
  const h = makeHarness({
    scriptProperties: { GEMINI_API_KEY: 'K' },
    spreadsheets: {
      SID: {
        Ajustes: [['key', 'value'], ['brain.enabled', 'true']],
        Equipo: [['Nombre', 'Correo', 'Rol'], ['Ada Lovelace', 'ada@x.com', 'Eng']]
      }
    }
  });
  if (geminiJson !== undefined) {
    h.setFetch(() => httpResponse(200, geminiOk(typeof geminiJson === 'string' ? geminiJson : JSON.stringify(geminiJson))));
  }
  return h;
}
const rootOf = (h) => h.getDrive().getFolderById(h.api.getAjustes_('SID', 'Ajustes').brain.folderId);

// --- parseIngest_ ---

test('parseIngest_ parsea summary + eventos y filtra los inválidos', () => {
  const h = brainHarness();
  const r = h.api.parseIngest_(JSON.stringify({
    summary: 'S', eventos: [{ tipo: 'avance', texto: 'x' }, { tipo: 'blocker' }, { texto: 'sin tipo' }]
  }));
  assert.equal(r.summary, 'S');
  assert.equal(r.eventos.length, 1);
});

test('parseIngest_ tolera JSON inválido: summary = crudo, eventos vacíos', () => {
  const h = brainHarness();
  const r = h.api.parseIngest_('no soy json');
  assert.equal(r.summary, 'no soy json');
  assert.deepEqual(plain(r.eventos), []);
});

// --- resolución de proyectos ---

test('resolverProyecto_ autocrea, reencuentra exacto y matchea difuso con alias', () => {
  const h = brainHarness();
  const root = h.api.ensureBrainFolder_('SID', CONFIG);

  const a = h.api.resolverProyecto_(root, 'Proyecto Alpha');
  assert.deepEqual(plain(a), { slug: 'proyecto-alpha', name: 'Proyecto Alpha' });

  const b = h.api.resolverProyecto_(root, 'Proyecto Alpha');   // exacto
  assert.equal(b.slug, 'proyecto-alpha');

  const c = h.api.resolverProyecto_(root, 'proyecto alpha beta');  // Jaccard 2/3 ≥ 0.6 → mismo
  assert.equal(c.slug, 'proyecto-alpha');

  const d = h.api.resolverProyecto_(root, 'Ventas Q3');  // sin match → nuevo
  assert.equal(d.slug, 'ventas-q3');

  const mapa = h.api.cargarProyectos_(root);
  assert.ok(mapa['proyecto-alpha'].aliases.indexOf('proyecto-alpha-beta') > -1, 'alias persistido');
  assert.ok(mapa['ventas-q3']);
});

test('similitudSlug_ (Jaccard por tokens)', () => {
  const h = brainHarness();
  assert.equal(h.api.similitudSlug_('a-b-c', 'a-b-c'), 1);
  assert.equal(Math.round(h.api.similitudSlug_('a-b-c', 'a-b') * 1000) / 1000, 0.667);
  assert.equal(h.api.similitudSlug_('x', 'y'), 0);
});

// --- secciones del body + frontmatter ---

test('upsert de eventos en secciones (crea, ordena, deduplica)', () => {
  const h = brainHarness();
  let body = h.api.mergearEventosEnBody_('', [
    { tipo: 'avance', texto: 'cerró diseño', _proyectoName: 'Alpha' },
    { tipo: 'blocker', texto: 'falta legal' }
  ], '2026-08-04', true);
  assert.match(body, /## Avances\n- \[2026-08-04\] cerró diseño \(Alpha\)/);
  assert.match(body, /## Blockers\n- \[2026-08-04\] falta legal/);

  // re-ingesta del mismo avance → no duplica
  body = h.api.mergearEventosEnBody_(body, [{ tipo: 'avance', texto: 'cerró diseño', _proyectoName: 'Alpha' }], '2026-08-04', true);
  assert.equal(occurrences(body, 'cerró diseño'), 1);
});

test('mergeFrontmatter_ une arrays y sobrescribe escalares', () => {
  const h = brainHarness();
  const out = h.api.mergeFrontmatter_(
    { sources: ['a'], name: 'X', open_blockers: ['b1'] },
    { sources: ['a', 'b'], name: 'Y', last_updated: '2026-08-04', open_blockers: ['b2'] }
  );
  assert.deepEqual(plain(out.sources), ['a', 'b']);
  assert.equal(out.name, 'Y');
  assert.equal(out.last_updated, '2026-08-04');
  assert.deepEqual(plain(out.open_blockers), ['b1', 'b2']);
});

// --- ingesta end-to-end ---

const EVENTOS = {
  summary: 'Ada cerró el diseño; espera aprobación legal.',
  eventos: [
    { persona: 'Ada', proyecto: 'Proyecto Alpha', tipo: 'avance', texto: 'cerró el diseño', confidence: 0.9 },
    { persona: 'Ada', proyecto: 'Proyecto Alpha', tipo: 'blocker', texto: 'falta aprobación legal', confidence: 0.8 }
  ]
};

test('ingestarFila_ escribe raw + página de persona + página de proyecto + log, y devuelve summary', () => {
  const h = brainHarness(EVENTOS);
  const config = h.api.construirConfig('SID', CONFIG);
  const meta = { nombre: 'Ada Lovelace', correo: 'ada@x.com' };

  const summary = h.api.ingestarFila_('SID', config, 'daily', meta, [{ q: '¿Qué lograste?', a: 'Cerré el diseño' }], 2, 'SYS');
  assert.equal(summary, 'Ada cerró el diseño; espera aprobación legal.');

  const root = rootOf(h);

  // raw inmutable
  const raw = sub(sub(root, 'raw'), 'reports');
  assert.equal(countFiles(raw), 1);

  // página de persona
  const person = h.api.leerArchivoBrain_(sub(sub(root, 'wiki'), 'people'), 'ada-x-com.md');
  assert.match(person, /page_type: person/);
  assert.match(person, /## Avances\n- \[.*\] cerró el diseño \(Proyecto Alpha\)/);
  assert.match(person, /## Blockers\n- \[.*\] falta aprobación legal/);
  assert.match(person, /open_blockers:\n  - falta aprobación legal/);

  // página de proyecto
  const proj = h.api.leerArchivoBrain_(sub(sub(root, 'wiki'), 'projects'), 'proyecto-alpha.md');
  assert.match(proj, /page_type: project/);
  assert.match(proj, /cerró el diseño/);

  // log
  const log = h.api.leerArchivoBrain_(sub(root, 'wiki'), 'log.md');
  assert.match(log, /ingesta daily · Ada Lovelace · 2 eventos/);
});

test('ingestarFila_ es idempotente por fuente: re-ingesta no duplica raw ni bullets', () => {
  const h = brainHarness(EVENTOS);
  const config = h.api.construirConfig('SID', CONFIG);
  const meta = { nombre: 'Ada Lovelace', correo: 'ada@x.com' };

  h.api.ingestarFila_('SID', config, 'daily', meta, [{ q: 'q', a: 'a' }], 2, 'SYS');
  h.api.ingestarFila_('SID', config, 'daily', meta, [{ q: 'q', a: 'a' }], 2, 'SYS');

  const root = rootOf(h);
  assert.equal(countFiles(sub(sub(root, 'raw'), 'reports')), 1, 'raw no duplicado');
  const person = h.api.leerArchivoBrain_(sub(sub(root, 'wiki'), 'people'), 'ada-x-com.md');
  assert.equal(occurrences(person, 'cerró el diseño'), 1, 'bullet no duplicado');
});

test('ingestarFila_ registra contradicciones en el log y en la página', () => {
  const h = brainHarness({
    summary: 'Ada cambió de decisión.',
    eventos: [{ persona: 'Ada', proyecto: 'Proyecto Alpha', tipo: 'contradiccion', texto: 'ahora NO usa Postgres', confidence: 0.7 }]
  });
  const config = h.api.construirConfig('SID', CONFIG);
  const meta = { nombre: 'Ada Lovelace', correo: 'ada@x.com' };
  h.api.ingestarFila_('SID', config, 'daily', meta, [{ q: 'q', a: 'a' }], 3, 'SYS');

  const root = rootOf(h);
  const log = h.api.leerArchivoBrain_(sub(root, 'wiki'), 'log.md');
  assert.match(log, /⚠️ contradicción · Ada Lovelace/);
  const person = h.api.leerArchivoBrain_(sub(sub(root, 'wiki'), 'people'), 'ada-x-com.md');
  assert.match(person, /## Contradicciones\n- \[.*\] ahora NO usa Postgres/);
});

// --- enganche en generarSummaryFila ---

test('generarSummaryFila con brain.enabled escribe Summary y crea el brain', () => {
  const h = brainHarness(EVENTOS);
  h.getSpreadsheet('SID').insertSheet('Daily');
  const daily = h.getSpreadsheet('SID').getSheetByName('Daily');
  daily.getRange(1, 1, 2, 3).setValues([
    ['Marca temporal', 'Dirección de correo electrónico', '¿Qué lograste?'],
    ['2026-08-04 09:00', 'ada@x.com', 'Cerré el diseño']
  ]);
  const config = h.api.construirConfig('SID', CONFIG);

  const out = h.api.generarSummaryFila('SID', config, 'Daily', 2);
  assert.equal(out, 'Ada cerró el diseño; espera aprobación legal.');
  assert.equal(daily.getRange(2, daily.getRange(1, 1, 1, daily.getLastColumn()).getValues()[0].indexOf('Summary') + 1).getValue(),
    'Ada cerró el diseño; espera aprobación legal.');
  assert.ok(h.api.getAjustes_('SID', 'Ajustes').brain.folderId, 'brain creado');
});

test('generarSummaryFila sin brain usa texto plano y NO crea brain', () => {
  const h = makeHarness({
    scriptProperties: { GEMINI_API_KEY: 'K' },
    spreadsheets: {
      SID: {
        Ajustes: [['key', 'value']],   // brain.enabled ausente → false
        Equipo: [['Nombre', 'Correo', 'Rol'], ['Ada Lovelace', 'ada@x.com', 'Eng']],
        Daily: [
          ['Marca temporal', 'Dirección de correo electrónico', '¿Qué lograste?'],
          ['2026-08-04 09:00', 'ada@x.com', 'Cerré el diseño']
        ]
      }
    }
  });
  h.setFetch(() => httpResponse(200, geminiOk('Resumen simple.')));
  const config = h.api.construirConfig('SID', CONFIG);

  const out = h.api.generarSummaryFila('SID', config, 'Daily', 2);
  assert.equal(out, 'Resumen simple.');
  assert.equal(h.api.getAjustes_('SID', 'Ajustes').brain.folderId, '', 'no se creó brain');
});
