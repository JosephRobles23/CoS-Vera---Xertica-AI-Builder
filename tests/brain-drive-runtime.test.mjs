/**
 * brain-drive-runtime.test.mjs — Sustrato en Drive del second brain (Fase 0).
 * Cubre: flags en config, carpeta CoS-Brain/ idempotente, I/O de archivos y (de)serialización
 * de markdown + frontmatter YAML. Corre con: npm test
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

const fresh = () => makeHarness({ spreadsheets: { SID: { Daily: [['Marca temporal']] } } });

// Los valores devueltos por el sandbox vm tienen prototipos de OTRO realm; assert/strict compara
// prototipos, así que normalizamos al realm de Node antes de deepEqual.
const plain = (v) => JSON.parse(JSON.stringify(v));

// Helpers para recorrer el Drive mock.
const sub = (folder, name) => { const it = folder.getFoldersByName(name); return it.hasNext() ? it.next() : null; };
const file = (folder, name) => { const it = folder.getFilesByName(name); return it.hasNext() ? it.next() : null; };

// --- Config: flags nuevos ---

test('getAjustes_ expone defaults de brain y deepPrep', () => {
  const h = fresh();
  const aj = h.api.getAjustes_('SID', 'Ajustes');
  assert.equal(aj.brain.enabled, false);
  assert.equal(aj.brain.folderId, '');
  assert.equal(aj.brain.retentionMonths, 12);
  assert.equal(aj.deepPrep.enabled, false);
  assert.equal(aj.deepPrep.leadHours, 3);
  assert.deepEqual(plain(aj.deepPrep.selected), []);
});

test('flags booleanos: solo "true" es verdadero', () => {
  const h = fresh();
  h.api.setAjustes_('SID', 'Ajustes', { 'brain.enabled': 'true', 'deepPrep.enabled': 'TRUE' });
  const aj = h.api.getAjustes_('SID', 'Ajustes');
  assert.equal(aj.brain.enabled, true);
  assert.equal(aj.deepPrep.enabled, true);
});

test('deepPrep.selected parsea el JSON de eventIds', () => {
  const h = fresh();
  h.api.setAjustes_('SID', 'Ajustes', { 'deepPrep.selected': JSON.stringify(['ev1', 'ev2']) });
  assert.deepEqual(plain(h.api.getAjustes_('SID', 'Ajustes').deepPrep.selected), ['ev1', 'ev2']);
});

test('deepPrep.selected inválido → []', () => {
  const h = fresh();
  h.api.setAjustes_('SID', 'Ajustes', { 'deepPrep.selected': 'no-json' });
  assert.deepEqual(plain(h.api.getAjustes_('SID', 'Ajustes').deepPrep.selected), []);
});

test('construirConfig incluye brain y deepPrep', () => {
  const h = fresh();
  h.api.setAjustes_('SID', 'Ajustes', { 'brain.enabled': 'true', 'brain.retentionMonths': '6' });
  const full = h.api.construirConfig('SID', CONFIG);
  assert.equal(full.brain.enabled, true);
  assert.equal(full.brain.retentionMonths, 6);
  assert.equal(full.deepPrep.enabled, false);
});

// --- Carpeta CoS-Brain/ ---

test('ensureBrainFolder_ crea la estructura de capas y persiste folderId', () => {
  const h = fresh();
  const root = h.api.ensureBrainFolder_('SID', CONFIG);

  assert.equal(root.getName(), 'CoS-Brain');
  // folderId persistido en Ajustes
  assert.equal(h.api.getAjustes_('SID', 'Ajustes').brain.folderId, root.getId());

  // capas
  const raw = sub(root, 'raw');
  assert.ok(raw && sub(raw, 'reports'), 'raw/reports/');
  const wiki = sub(root, 'wiki');
  assert.ok(wiki, 'wiki/');
  assert.ok(sub(wiki, 'people') && sub(wiki, 'projects') && sub(wiki, 'meetings'), 'wiki/{people,projects,meetings}');

  // archivos semilla
  assert.ok(file(root, '_schema.md'), '_schema.md');
  assert.ok(file(wiki, 'index.md'), 'wiki/index.md');
  assert.ok(file(wiki, 'log.md'), 'wiki/log.md');
});

test('ensureBrainFolder_ es idempotente: reutiliza la carpeta, no duplica', () => {
  const h = fresh();
  const root1 = h.api.ensureBrainFolder_('SID', CONFIG);
  const root2 = h.api.ensureBrainFolder_('SID', CONFIG);

  assert.equal(root1.getId(), root2.getId(), 'mismo folderId');
  // una sola raíz CoS-Brain viva en todo el Drive
  const roots = Object.values(h.getDrive()._byId)
    .filter((n) => n._kind === 'folder' && n._name === 'CoS-Brain' && !n._trashed);
  assert.equal(roots.length, 1);
  // una sola index.md (no re-sembrada)
  const wiki = sub(root2, 'wiki');
  const idx = wiki.getFilesByName('index.md');
  idx.next();
  assert.equal(idx.hasNext(), false, 'index.md no duplicada');
});

test('ensureBrainFolder_ recrea la raíz si el folderId guardado ya no existe', () => {
  const h = fresh();
  h.api.setAjustes_('SID', 'Ajustes', { 'brain.folderId': 'folder-fantasma' });
  const root = h.api.ensureBrainFolder_('SID', CONFIG);
  assert.equal(root.getName(), 'CoS-Brain');
  assert.equal(h.api.getAjustes_('SID', 'Ajustes').brain.folderId, root.getId());
});

// --- I/O de archivos ---

test('escribir / leer / append de archivos', () => {
  const h = fresh();
  const root = h.api.ensureBrainFolder_('SID', CONFIG);

  assert.equal(h.api.leerArchivoBrain_(root, 'nota.md'), null, 'inexistente → null');

  h.api.escribirArchivoBrain_(root, 'nota.md', 'uno');
  assert.equal(h.api.leerArchivoBrain_(root, 'nota.md'), 'uno');

  h.api.escribirArchivoBrain_(root, 'nota.md', 'dos');   // sobrescribe (sin duplicar)
  assert.equal(h.api.leerArchivoBrain_(root, 'nota.md'), 'dos');
  const it = root.getFilesByName('nota.md'); it.next();
  assert.equal(it.hasNext(), false, 'no quedan duplicados vivos');

  h.api.appendArchivoBrain_(root, 'log.txt', 'a\n');
  h.api.appendArchivoBrain_(root, 'log.txt', 'b\n');
  assert.equal(h.api.leerArchivoBrain_(root, 'log.txt'), 'a\nb\n');
});

test('ensureArchivoBrain_ no pisa contenido existente', () => {
  const h = fresh();
  const root = h.api.ensureBrainFolder_('SID', CONFIG);
  h.api.escribirArchivoBrain_(root, 'x.md', 'original');
  h.api.ensureArchivoBrain_(root, 'x.md', 'semilla');
  assert.equal(h.api.leerArchivoBrain_(root, 'x.md'), 'original');
});

test('carpetaBrain_ navega/crea rutas anidadas idempotentemente', () => {
  const h = fresh();
  const root = h.api.ensureBrainFolder_('SID', CONFIG);
  const p1 = h.api.carpetaBrain_(root, ['wiki', 'people']);
  const p2 = h.api.carpetaBrain_(root, ['wiki', 'people']);
  assert.equal(p1.getId(), p2.getId());
});

// --- Slugs ---

test('slugBrain_ normaliza acentos y espacios', () => {
  const h = fresh();
  assert.equal(h.api.slugBrain_('Ada Lovelace'), 'ada-lovelace');
  assert.equal(h.api.slugBrain_('Proyecto Ñandú 3'), 'proyecto-nandu-3');
  assert.equal(h.api.slugBrain_('  —  '), 'sin-nombre');
});

// --- Frontmatter + página ---

test('frontmatter roundtrip: escalares y arrays', () => {
  const h = fresh();
  const fm = {
    page_type: 'person', name: 'Ada Lovelace', last_updated: '2026-08-04',
    confidence: 0.8, tags: ['eng', 'lead'], sources: [], open_blockers: ['espera aprobación']
  };
  const parsed = h.api.parsearYamlPlano_(h.api.serializarFrontmatter_(fm).replace(/^---\n|\n---$/g, ''));
  assert.equal(parsed.page_type, 'person');
  assert.equal(parsed.name, 'Ada Lovelace');
  assert.equal(parsed.last_updated, '2026-08-04');
  assert.equal(parsed.confidence, '0.8');
  assert.deepEqual(plain(parsed.tags), ['eng', 'lead']);
  assert.deepEqual(plain(parsed.sources), []);
  assert.deepEqual(plain(parsed.open_blockers), ['espera aprobación']);
});

test('frontmatter entrecomilla valores con caracteres ambiguos', () => {
  const h = fresh();
  const yaml = h.api.serializarFrontmatter_({ name: 'Proyecto: Alpha' });
  assert.match(yaml, /name: "Proyecto: Alpha"/);
  const { frontmatter } = h.api.parsearPagina_(yaml + '\n\ncuerpo');
  assert.equal(frontmatter.name, 'Proyecto: Alpha');
});

test('componerPagina_ / parsearPagina_ roundtrip limpio', () => {
  const h = fresh();
  const fm = { page_type: 'project', name: 'Alpha', tags: ['x'] };
  const body = '# Alpha\n\nEstado: en curso.';
  const page = h.api.componerPagina_(fm, body);
  const parsed = h.api.parsearPagina_(page);
  assert.equal(parsed.frontmatter.page_type, 'project');
  assert.deepEqual(plain(parsed.frontmatter.tags), ['x']);
  assert.equal(parsed.body, body);
});

test('parsearPagina_ sin frontmatter → body completo', () => {
  const h = fresh();
  const parsed = h.api.parsearPagina_('solo cuerpo, sin YAML');
  assert.deepEqual(plain(parsed.frontmatter), {});
  assert.equal(parsed.body, 'solo cuerpo, sin YAML');
});
