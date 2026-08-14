/**
 * brain-admin-runtime.test.mjs — Administración y gobernanza del brain (Fase 4).
 * Cubre: visor de la wiki (listar/leer + seguridad de nombre), merge de proyectos (body+frontmatter
 * +alias), toggles de flags, "olvidar persona" (página + raw), y la purga del raw/ por retención
 * (función + enganche 1×/día en runDispatcher). Además el ruteo por dispatch().
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

function adminHarness(extraAjustes = []) {
  return makeHarness({
    scriptProperties: { GEMINI_API_KEY: 'K' },
    spreadsheets: { SID: {
      Ajustes: [['key', 'value'], ['brain.enabled', 'true'], ...extraAjustes],
      Equipo: [['Nombre', 'Correo', 'Rol']]
    } }
  });
}

function ponerWiki(h, root, carpeta, file, fm, body) {
  h.api.escribirArchivoBrain_(h.api.carpetaBrain_(root, ['wiki', carpeta]), file, h.api.componerPagina_(fm, body || ''));
}
function ponerRaw(h, root, file, fm, body) {
  h.api.escribirArchivoBrain_(h.api.carpetaBrain_(root, ['raw', 'reports']), file, h.api.componerPagina_(fm, body || ''));
}
const rawNames = (h, root) =>
  plain(h.api.listarArchivosBrain_(h.api.carpetaBrain_(root, ['raw', 'reports']), '.md')).map((a) => a.name).sort();
const logDe = (h, root) => h.api.leerArchivoBrain_(h.api.carpetaBrain_(root, ['wiki']), 'log.md');

// --- Visor de la wiki ---

test('listarWikiPaginas ordena por last_updated desc, resume y omite internos', () => {
  const h = adminHarness();
  const config = h.api.construirConfig('SID', CONFIG);
  const root = h.api.ensureBrainFolder_('SID', config);
  ponerWiki(h, root, 'projects', 'alpha.md',
    { page_type: 'project', name: 'Alpha', last_updated: '2026-08-01', open_blockers: ['legal'] },
    '# Alpha\n\nDiseño en revisión final.\n\n## Blockers\n- [2026-08-01] legal');
  ponerWiki(h, root, 'projects', 'beta.md',
    { page_type: 'project', name: 'Beta', last_updated: '2026-08-10' }, '# Beta\n\nArranque.');
  h.api.escribirArchivoBrain_(h.api.carpetaBrain_(root, ['wiki', 'projects']), '_projects.json', '{}');

  const lista = plain(h.api.listarWikiPaginas('SID', config, 'projects'));
  assert.deepEqual(lista.map((x) => x.name), ['Beta', 'Alpha']);   // desc por fecha
  const alpha = lista.find((x) => x.name === 'Alpha');
  assert.equal(alpha.resumen, 'Diseño en revisión final.');
  assert.deepEqual(alpha.open_blockers, ['legal']);
  assert.ok(!lista.some((x) => x.file === '_projects.json'), 'omite archivos internos');
});

test('leerWikiPagina devuelve frontmatter+body y rechaza nombres inseguros', () => {
  const h = adminHarness();
  const config = h.api.construirConfig('SID', CONFIG);
  const root = h.api.ensureBrainFolder_('SID', config);
  ponerWiki(h, root, 'people', 'ada-x-com.md', { page_type: 'person', name: 'Ada' }, 'Notas de Ada.');

  const pg = plain(h.api.leerWikiPagina('SID', config, 'people', 'ada-x-com.md'));
  assert.equal(pg.frontmatter.name, 'Ada');
  assert.match(pg.body, /Notas de Ada/);

  assert.throws(() => h.api.leerWikiPagina('SID', config, 'people', '../secretos.md'), /inválido/);
  assert.throws(() => h.api.leerWikiPagina('SID', config, 'people', 'no-existe.md'), /no encontrada/);
});

// --- Merge de proyectos ---

test('mergearProyectos une body+frontmatter, borra el origen y registra el alias', () => {
  const h = adminHarness();
  const config = h.api.construirConfig('SID', CONFIG);
  const root = h.api.ensureBrainFolder_('SID', config);
  ponerWiki(h, root, 'projects', 'alpha.md',
    { page_type: 'project', name: 'Alpha', last_updated: '2026-08-10', sources: ['raw/reports/a.md'], open_blockers: ['legal'] },
    '## Avances\n- [2026-08-10] diseño cerrado');
  ponerWiki(h, root, 'projects', 'proyecto-alpha.md',
    { page_type: 'project', name: 'Proyecto Alpha', last_updated: '2026-08-05', sources: ['raw/reports/b.md'], open_blockers: ['infra'] },
    '## Avances\n- [2026-08-05] kickoff');

  const res = plain(h.api.mergearProyectos('SID', config, 'proyecto-alpha.md', 'alpha.md'));
  assert.equal(res.ok, true);

  // origen a la papelera
  const files = h.api.listarArchivosBrain_(h.api.carpetaBrain_(root, ['wiki', 'projects']), '.md').map((a) => a.name);
  assert.ok(!files.includes('proyecto-alpha.md'));
  assert.ok(files.includes('alpha.md'));

  // destino conserva ambas viñetas y une los arrays de frontmatter
  const d = h.api.parsearPagina_(h.api.leerArchivoBrain_(h.api.carpetaBrain_(root, ['wiki', 'projects']), 'alpha.md'));
  assert.match(d.body, /diseño cerrado/);
  assert.match(d.body, /kickoff/);
  assert.deepEqual(plain(d.frontmatter.sources).sort(), ['raw/reports/a.md', 'raw/reports/b.md']);
  assert.deepEqual(plain(d.frontmatter.open_blockers).sort(), ['infra', 'legal']);

  // alias en _projects.json: el slug viejo apunta al destino
  const mapa = JSON.parse(h.api.leerArchivoBrain_(h.api.carpetaBrain_(root, ['wiki', 'projects']), '_projects.json'));
  assert.ok(mapa.alpha.aliases.includes('proyecto-alpha'));
  assert.equal(mapa['proyecto-alpha'], undefined);
  assert.match(logDe(h, root), /merge de proyecto · proyecto-alpha → alpha/);
});

test('mergearProyectos falla si origen y destino coinciden', () => {
  const h = adminHarness();
  const config = h.api.construirConfig('SID', CONFIG);
  h.api.ensureBrainFolder_('SID', config);
  assert.throws(() => h.api.mergearProyectos('SID', config, 'x.md', 'x.md'), /mismo proyecto/);
});

// --- Flags ---

test('guardarFlags persiste solo claves conocidas, normalizadas', () => {
  const h = adminHarness();
  const config = h.api.construirConfig('SID', CONFIG);

  const res = plain(h.api.guardarFlags('SID', config, {
    'deepPrep.enabled': true, 'deepPrep.leadHours': '6', 'brain.silenceDays': 14,
    'algo.malicioso': 'x'
  }));
  assert.deepEqual(res.aplicados.sort(), ['brain.silenceDays', 'deepPrep.enabled', 'deepPrep.leadHours']);

  const aj = h.api.getAjustes_('SID', 'Ajustes');
  assert.equal(aj.deepPrep.enabled, true);
  assert.equal(aj.deepPrep.leadHours, 6);
  assert.equal(aj.brain.silenceDays, 14);
});

// --- Olvidar persona ---

test('olvidarPersona borra la página y su raw, y deja rastro en el log', () => {
  const h = adminHarness();
  const config = h.api.construirConfig('SID', CONFIG);
  const root = h.api.ensureBrainFolder_('SID', config);
  ponerWiki(h, root, 'people', 'ada-x-com.md', { page_type: 'person', name: 'Ada', email: 'ada@x.com' }, 'Notas.');
  ponerRaw(h, root, '2026-08-01_ada_daily_r2.md', { page_type: 'report', email: 'ada@x.com', date: '2026-08-01' }, 'r1');
  ponerRaw(h, root, '2026-08-02_ada_daily_r3.md', { page_type: 'report', email: 'ada@x.com', date: '2026-08-02' }, 'r2');
  ponerRaw(h, root, '2026-08-02_bob_daily_r4.md', { page_type: 'report', email: 'bob@x.com', date: '2026-08-02' }, 'r3');

  const res = plain(h.api.olvidarPersona('SID', config, 'ada-x-com.md'));
  assert.equal(res.email, 'ada@x.com');
  assert.equal(res.raw_borrados, 2);

  const people = h.api.listarArchivosBrain_(h.api.carpetaBrain_(root, ['wiki', 'people']), '.md').map((a) => a.name);
  assert.ok(!people.includes('ada-x-com.md'));
  assert.deepEqual(rawNames(h, root), ['2026-08-02_bob_daily_r4.md']);   // el de Bob sobrevive
  assert.match(logDe(h, root), /olvidar persona · Ada · 2 raw borrado/);
});

// --- Purga del raw por retención ---

test('purgarRaw_ borra lo anterior al corte y conserva lo reciente', () => {
  const h = adminHarness([['brain.retentionMonths', '1']]);
  const config = h.api.construirConfig('SID', CONFIG);
  const root = h.api.ensureBrainFolder_('SID', config);
  ponerRaw(h, root, 'viejo.md', { page_type: 'report', email: 'a@x.com', date: '2026-06-01' }, 'x');   // > 1 mes
  ponerRaw(h, root, 'nuevo.md', { page_type: 'report', email: 'a@x.com', date: '2026-08-01' }, 'y');   // dentro

  const n = h.api.purgarRaw_('SID', config, new Date(2026, 7, 20));   // corte = 2026-07-20
  assert.equal(n, 1);
  assert.deepEqual(rawNames(h, root), ['nuevo.md']);
  assert.match(logDe(h, root), /purga de raw · 1 reporte\(s\) anteriores a 2026-07-20/);
});

test('runDispatcher corre la purga 1×/día y no la repite', () => {
  const h = adminHarness([['brain.retentionMonths', '1']]);
  const config = h.api.construirConfig('SID', CONFIG);
  const root = h.api.ensureBrainFolder_('SID', config);
  ponerRaw(h, root, 'viejo.md', { page_type: 'report', email: 'a@x.com', date: '2026-06-01' }, 'x');

  h.api.runDispatcher('SID', config, new Date(2026, 7, 20, 3, 0));
  assert.deepEqual(rawNames(h, root), []);   // purgado
  const log1 = logDe(h, root);

  ponerRaw(h, root, 'otro-viejo.md', { page_type: 'report', email: 'a@x.com', date: '2026-06-02' }, 'x');
  h.api.runDispatcher('SID', config, new Date(2026, 7, 20, 3, 5));   // mismo día → no repite
  assert.deepEqual(rawNames(h, root), ['otro-viejo.md'], 'no re-purga el mismo día');
  assert.equal(logDe(h, root), log1);
});

// --- Ruteo por dispatch ---

test('dispatch enruta las funciones de admin del brain', () => {
  const h = adminHarness();
  const config = h.api.construirConfig('SID', CONFIG);
  const root = h.api.ensureBrainFolder_('SID', config);
  ponerWiki(h, root, 'people', 'ada-x-com.md', { page_type: 'person', name: 'Ada' }, 'Notas.');

  const lista = plain(h.api.dispatch('listarWikiPaginas', ['people'], 'SID', config));
  assert.equal(lista[0].name, 'Ada');
  const pg = plain(h.api.dispatch('leerWikiPagina', ['people', 'ada-x-com.md'], 'SID', config));
  assert.equal(pg.frontmatter.name, 'Ada');
  const fl = plain(h.api.dispatch('guardarFlags', [{ 'brain.enabled': false }], 'SID', config));
  assert.deepEqual(fl.aplicados, ['brain.enabled']);
});

test('olvidarPersona y mergearProyectos dejan el índice al día', () => {
  const h = adminHarness();
  const config = h.api.construirConfig('SID', CONFIG);
  const root = h.api.ensureBrainFolder_('SID', config);
  ponerWiki(h, root, 'people', 'ada-x-com.md', { page_type: 'person', name: 'Ada', email: 'ada@x.com' }, 'N.');
  ponerWiki(h, root, 'projects', 'alpha.md', { page_type: 'project', name: 'Alpha', last_updated: '2026-08-10' }, 'A');
  ponerWiki(h, root, 'projects', 'proyecto-alpha.md', { page_type: 'project', name: 'Proyecto Alpha', last_updated: '2026-08-05' }, 'B');

  h.api.mergearProyectos('SID', config, 'proyecto-alpha.md', 'alpha.md');
  let idx = h.api.leerArchivoBrain_(h.api.carpetaBrain_(root, ['wiki']), 'index.md');
  assert.match(idx, /## Proyectos \(1\)/);
  assert.ok(!/proyecto-alpha\.md/.test(idx), 'el origen del merge salió del índice');

  h.api.olvidarPersona('SID', config, 'ada-x-com.md');
  idx = h.api.leerArchivoBrain_(h.api.carpetaBrain_(root, ['wiki']), 'index.md');
  assert.match(idx, /## Personas \(0\)/);
});

// --- olvidarProyecto (gobernanza: entidades basura del bug de títulos / descontinuadas) ---

test('olvidarProyecto borra página + entrada del catálogo (con aliases) y deja rastro', () => {
  const h = adminHarness();
  const config = h.api.construirConfig('SID', CONFIG);
  const root = h.api.ensureBrainFolder_('SID', config);

  // dos proyectos; el segundo tiene al primero como alias (simula un merge previo)
  ponerWiki(h, root, 'projects', 'basura.md', { page_type: 'project', name: 'Basura', last_updated: '2026-08-13' }, '# Basura');
  ponerWiki(h, root, 'projects', 'alpha.md', { page_type: 'project', name: 'Alpha', last_updated: '2026-08-13' }, '# Alpha');
  h.api.guardarProyectos_(root, {
    basura: { name: 'Basura', aliases: ['basura-vieja'] },
    alpha: { name: 'Alpha', aliases: ['basura'] }   // 'basura' también quedó como alias ajeno
  });

  const res = plain(h.api.olvidarProyecto('SID', config, 'basura.md'));
  assert.deepEqual(res, { ok: true, name: 'Basura' });

  // página fuera, catálogo limpio (entrada propia Y alias ajeno purgados), alpha intacto
  assert.equal(h.api.leerArchivoBrain_(h.api.carpetaBrain_(root, ['wiki', 'projects']), 'basura.md'), null);
  const mapa = plain(h.api.cargarProyectos_(root));
  assert.equal(mapa.basura, undefined);
  assert.deepEqual(mapa.alpha, { name: 'Alpha', aliases: [] });

  // rastro en el log + índice al día
  assert.match(logDe(h, root), /🗑️ olvidar proyecto · Basura/);
  const idx = h.api.leerArchivoBrain_(h.api.carpetaBrain_(root, ['wiki']), 'index.md');
  assert.ok(!/basura\.md/.test(idx), 'el proyecto salió del índice');
});

test('olvidarProyecto falla claro si el proyecto no existe y no toca el raw/', () => {
  const h = adminHarness();
  const config = h.api.construirConfig('SID', CONFIG);
  const root = h.api.ensureBrainFolder_('SID', config);
  ponerRaw(h, root, '2026-08-01_ada_daily_r2.md', { page_type: 'report', email: 'ada@x.com' }, 'x');
  assert.throws(() => h.api.olvidarProyecto('SID', config, 'nada.md'), /Proyecto no encontrado/);

  ponerWiki(h, root, 'projects', 'alpha.md', { page_type: 'project', name: 'Alpha' }, '# Alpha');
  h.api.guardarProyectos_(root, { alpha: { name: 'Alpha', aliases: [] } });
  h.api.olvidarProyecto('SID', config, 'alpha.md');
  assert.deepEqual(rawNames(h, root), ['2026-08-01_ada_daily_r2.md'], 'el raw es verdad histórica: intacto');
});

test('dispatch enruta olvidarProyecto', () => {
  const h = adminHarness();
  const config = h.api.construirConfig('SID', CONFIG);
  const root = h.api.ensureBrainFolder_('SID', config);
  ponerWiki(h, root, 'projects', 'alpha.md', { page_type: 'project', name: 'Alpha' }, '# Alpha');
  h.api.guardarProyectos_(root, { alpha: { name: 'Alpha', aliases: [] } });
  const res = plain(h.api.dispatch('olvidarProyecto', ['alpha.md'], 'SID', config));
  assert.equal(res.ok, true);
});
