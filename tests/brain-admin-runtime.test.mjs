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

// --- Reparación del wiki (wikis de versiones viejas vs contrato actual) ---

function wikiViejoHarness() {
  const h = makeHarness({
    scriptProperties: { GEMINI_API_KEY: 'K' },
    spreadsheets: { SID: {
      Ajustes: [['key', 'value'], ['brain.enabled', 'true'], ['leader.email', 'lider@x.com'], ['leader.name', 'Líder A']],
      Equipo: [['Nombre', 'Correo', 'Rol'], ['Elisa Duarte', 'elisa@x.com', 'HR'], ['Marce Gil', 'marce@x.com', 'HR']]
    } }
  });
  const config = h.api.construirConfig('SID', CONFIG);
  const root = h.api.ensureBrainFolder_('SID', config);
  return { h, config, root };
}

test('repararWiki: página externa con nombre del roster se fusiona a la canónica por correo', () => {
  const { h, config, root } = wikiViejoHarness();
  // El matching débil de Meet creó a "Elisa" como EXTERNA con slug de nombre y sin email.
  ponerWiki(h, root, 'people', 'elisa.md',
    { page_type: 'person', name: 'Elisa', external: true, last_updated: '2026-08-12' },
    '## Avances\n- [2026-08-12] Cerró performance\n\n## Pendientes\n- [2026-08-10] Enviar cronograma\n');
  h.api.guardarPersonasExt_(root, { elisa: { name: 'Elisa', aliases: [] } });

  const antes = plain(h.api.diagnosticarWiki('SID', config));
  assert.equal(antes.personas.fusionables, 1, 'el diagnóstico la ve reparable');

  const r = plain(h.api.repararWiki('SID', config));
  assert.equal(r.personasFusionadas, 1);

  const people = h.api.carpetaBrain_(root, ['wiki', 'people']);
  assert.equal(h.api.leerArchivoBrain_(people, 'elisa.md'), null, 'la página vieja se fue');
  const canon = h.api.parsearPagina_(h.api.leerArchivoBrain_(people, 'elisa-x-com.md'));
  assert.equal(canon.frontmatter.email, 'elisa@x.com');
  assert.equal(canon.frontmatter.external, undefined, 'ya no es externa');
  assert.match(canon.body, /Cerró performance/);
  assert.match(canon.body, /Enviar cronograma/, 'los pendientes viajaron (alimentan el Flujo)');
  assert.deepEqual(plain(h.api.cargarPersonasExt_(root)), {}, 'salió de _people.json');
  assert.match(logDe(h, root), /🔧 reparación del wiki · 1 fusionada/);
});

test('repararWiki fusiona con dedup sobre una canónica existente y corrige la mal marcada', () => {
  const { h, config, root } = wikiViejoHarness();
  // Canónica ya existe (reportes daily) + duplicado por nombre (notas de Meet) con una línea repetida.
  ponerWiki(h, root, 'people', 'elisa-x-com.md',
    { page_type: 'person', name: 'Elisa Duarte', email: 'elisa@x.com' },
    '## Avances\n- [2026-08-12] Cerró performance\n');
  ponerWiki(h, root, 'people', 'elisa-duarte.md',
    { page_type: 'person', name: 'Elisa Duarte', external: true },
    '## Avances\n- [2026-08-12] Cerró performance\n- [2026-08-11] Onboarding finanzas\n');
  // Y Marce con archivo canónico pero marcada externa por error.
  ponerWiki(h, root, 'people', 'marce-x-com.md',
    { page_type: 'person', name: 'Marce Gil', email: 'marce@x.com', external: true }, '## Avances\n- [2026-08-12] X\n');

  const r = plain(h.api.repararWiki('SID', config));
  assert.equal(r.personasFusionadas, 1);
  assert.equal(r.personasCorregidas, 1);

  const people = h.api.carpetaBrain_(root, ['wiki', 'people']);
  const canon = h.api.leerArchivoBrain_(people, 'elisa-x-com.md');
  assert.equal((canon.match(/Cerró performance/g) || []).length, 1, 'dedup exacto en el merge');
  assert.match(canon, /Onboarding finanzas/);
  const marce = h.api.parsearPagina_(h.api.leerArchivoBrain_(people, 'marce-x-com.md'));
  assert.equal(marce.frontmatter.external, undefined);

  // Idempotencia: la segunda corrida no toca nada.
  const r2 = plain(h.api.repararWiki('SID', config));
  assert.deepEqual([r2.personasFusionadas, r2.personasCorregidas], [0, 0], 'segunda corrida en ceros');
});

test('repararWiki: nombre ambiguo NO se fusiona, externa real queda intacta y catalogada', () => {
  const { h, config, root } = wikiViejoHarness();
  h.getSpreadsheet('SID').getSheetByName('Equipo').getRange(4, 1, 1, 3).setValues([['Elisa Prado', 'eprado@x.com', 'Fin']]);
  ponerWiki(h, root, 'people', 'elisa.md', { page_type: 'person', name: 'Elisa', external: true }, '## Avances\n- [2026-08-12] x\n');
  ponerWiki(h, root, 'people', 'carol-torres.md', { page_type: 'person', name: 'Carol Torres', external: true }, '## Avances\n- [2026-08-12] y\n');

  const r = plain(h.api.repararWiki('SID', config));
  assert.equal(r.personasFusionadas, 0, '"Elisa" matchea a 2 miembros → ambigua → no se toca');

  const people = h.api.carpetaBrain_(root, ['wiki', 'people']);
  assert.ok(h.api.leerArchivoBrain_(people, 'elisa.md'), 'ambigua intacta');
  assert.ok(h.api.leerArchivoBrain_(people, 'carol-torres.md'), 'externa real intacta');
  const ext = plain(h.api.cargarPersonasExt_(root));
  assert.ok(ext['carol-torres'], 'la externa real quedó catalogada en _people.json');
});

test('repararWiki cataloga proyectos sin entrada y purga entradas huérfanas (aliases intactos)', () => {
  const { h, config, root } = wikiViejoHarness();
  ponerWiki(h, root, 'projects', 'bamboo-hr.md', { page_type: 'project', name: 'Bamboo HR' }, '# B');
  ponerWiki(h, root, 'projects', 'performance.md', { page_type: 'project', name: 'Performance' }, '# P');
  h.api.guardarProyectos_(root, {
    performance: { name: 'Performance', aliases: ['perf'] },
    fantasma: { name: 'Fantasma', aliases: [] }   // entrada sin página
  });

  const r = plain(h.api.repararWiki('SID', config));
  assert.equal(r.proyectosCatalogados, 1, 'bamboo-hr entró al catálogo');
  assert.equal(r.huerfanosPurgados, 1, 'fantasma salió');

  const mapa = plain(h.api.cargarProyectos_(root));
  assert.deepEqual(Object.keys(mapa).sort(), ['bamboo-hr', 'performance']);
  assert.deepEqual(mapa.performance.aliases, ['perf'], 'aliases preservados');
});

test('dispatch enruta diagnosticarWiki y repararWiki', () => {
  const { h, config, root } = wikiViejoHarness();
  ponerWiki(h, root, 'people', 'elisa.md', { page_type: 'person', name: 'Elisa Duarte', external: true }, '## Avances\n- [2026-08-12] x\n');
  const d = plain(h.api.dispatch('diagnosticarWiki', [], 'SID', config));
  assert.equal(d.personas.fusionables, 1);
  const r = plain(h.api.dispatch('repararWiki', [], 'SID', config));
  assert.equal(r.personasFusionadas, 1);
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

// --- renombrarProyecto (rename COMPLETO: name + slug + archivo + catálogo + tareas) ---

function renameHarness() {
  const h = makeHarness({
    scriptProperties: { GEMINI_API_KEY: 'K' },
    spreadsheets: { SID: {
      Ajustes: [['key', 'value'], ['brain.enabled', 'true']],
      Equipo: [['Nombre', 'Correo', 'Rol']],
      Tareas: [
        ['Tarea', 'Proyecto', 'Vence', 'Prioridad', 'Estado', 'Origen', 'Id', 'Espera de', 'Link', 'EventId', 'Creada el'],
        ['Cerrar propuesta', 'AI Platform', '', 'Alta', 'Pendiente', '', 't1', '', '', '', '2026-08-01'],
        ['Otra cosa', 'Discovery', '', 'Media', 'Pendiente', '', 't2', '', '', '', '2026-08-01']
      ]
    } }
  });
  const config = h.api.construirConfig('SID', CONFIG);
  const root = h.api.ensureBrainFolder_('SID', config);
  return { h, config, root };
}

test('renombrarProyecto cambia name, slug y archivo; el slug viejo queda como alias', () => {
  const { h, config, root } = renameHarness();
  ponerWiki(h, root, 'projects', 'ai-platform.md',
    { page_type: 'project', name: 'AI Platform', last_updated: '2026-08-04' }, '# AI Platform\n\nDiscovery técnico.');
  h.api.guardarProyectos_(root, { 'ai-platform': { name: 'AI Platform', aliases: ['plataforma-ia'] } });

  const res = plain(h.api.renombrarProyecto('SID', config, 'ai-platform.md', 'Plataforma de Agentes'));
  assert.equal(res.ok, true);
  assert.equal(res.name, 'Plataforma de Agentes');
  assert.equal(res.file, 'plataforma-de-agentes.md');
  assert.equal(res.slugChanged, true);

  const carpeta = h.api.carpetaBrain_(root, ['wiki', 'projects']);
  assert.equal(h.api.leerArchivoBrain_(carpeta, 'ai-platform.md'), null, 'el archivo viejo se movió');
  const nueva = h.api.parsearPagina_(h.api.leerArchivoBrain_(carpeta, 'plataforma-de-agentes.md'));
  assert.equal(nueva.frontmatter.name, 'Plataforma de Agentes');
  assert.match(nueva.body, /Discovery técnico/, 'el body se conserva');

  const mapa = plain(h.api.cargarProyectos_(root));
  assert.equal(mapa['ai-platform'], undefined, 'el canónico viejo ya no está');
  assert.equal(mapa['plataforma-de-agentes'].name, 'Plataforma de Agentes');
  assert.ok(mapa['plataforma-de-agentes'].aliases.indexOf('ai-platform') > -1, 'slug viejo como alias');
  assert.ok(mapa['plataforma-de-agentes'].aliases.indexOf('plataforma-ia') > -1, 'aliases previos preservados');
});

test('renombrarProyecto reetiqueta las tareas que referencian el proyecto por nombre', () => {
  const { h, config, root } = renameHarness();
  ponerWiki(h, root, 'projects', 'ai-platform.md', { page_type: 'project', name: 'AI Platform' }, '# AI Platform');
  h.api.guardarProyectos_(root, { 'ai-platform': { name: 'AI Platform', aliases: [] } });
  // espejo en wiki/tasks de la tarea t1 (referencia por nombre)
  ponerWiki(h, root, 'tasks', 't1.md',
    { task_id: 't1', project: 'AI Platform', priority: 'Alta', status: 'Pendiente' },
    '## Historial\n- [2026-08-01] creada');

  const res = plain(h.api.renombrarProyecto('SID', config, 'ai-platform.md', 'Plataforma de Agentes'));
  assert.equal(res.tareas, 1, 'una tarea de la hoja reetiquetada');

  const tareas = plain(h.api.listarTareas_('SID', config));
  const t1 = tareas.find((t) => t.id === 't1');
  const t2 = tareas.find((t) => t.id === 't2');
  assert.equal(t1.proyecto, 'Plataforma de Agentes', 'la tarea del proyecto cambió');
  assert.equal(t2.proyecto, 'Discovery', 'las otras tareas no se tocan');

  const tp = h.api.parsearPagina_(h.api.leerArchivoBrain_(h.api.carpetaBrain_(root, ['wiki', 'tasks']), 't1.md'));
  assert.equal(tp.frontmatter.project, 'Plataforma de Agentes', 'el espejo wiki/tasks también');
  const idx = plain(h.api.cargarIndiceTareas_(root));
  assert.equal(idx.t1.proyecto, 'Plataforma de Agentes', '_tasks.json reconstruido');
});

test('renombrarProyecto sin cambiar el slug solo actualiza el name visible', () => {
  const { h, config, root } = renameHarness();
  ponerWiki(h, root, 'projects', 'discovery.md', { page_type: 'project', name: 'Discovery' }, '# Discovery');
  h.api.guardarProyectos_(root, { discovery: { name: 'Discovery', aliases: [] } });

  const res = plain(h.api.renombrarProyecto('SID', config, 'discovery.md', 'Discovery'));   // mismo slug
  assert.equal(res.slugChanged, false);
  const carpeta = h.api.carpetaBrain_(root, ['wiki', 'projects']);
  assert.ok(h.api.leerArchivoBrain_(carpeta, 'discovery.md') != null, 'el archivo sigue');
  const mapa = plain(h.api.cargarProyectos_(root));
  assert.deepEqual(Object.keys(mapa), ['discovery']);
  assert.deepEqual(mapa.discovery.aliases, [], 'no se autoañade como alias de sí mismo');
});

test('renombrarProyecto se niega si el slug destino ya existe (evita fusión encubierta)', () => {
  const { h, config, root } = renameHarness();
  ponerWiki(h, root, 'projects', 'ai-platform.md', { page_type: 'project', name: 'AI Platform' }, '# AI Platform');
  ponerWiki(h, root, 'projects', 'discovery.md', { page_type: 'project', name: 'Discovery' }, '# Discovery');
  assert.throws(() => h.api.renombrarProyecto('SID', config, 'ai-platform.md', 'Discovery'), /Fusionar/);
  // el original quedó intacto
  assert.ok(h.api.leerArchivoBrain_(h.api.carpetaBrain_(root, ['wiki', 'projects']), 'ai-platform.md') != null);
});

test('renombrarProyecto rechaza nombre vacío', () => {
  const { h, config, root } = renameHarness();
  ponerWiki(h, root, 'projects', 'ai-platform.md', { page_type: 'project', name: 'AI Platform' }, '# AI Platform');
  assert.throws(() => h.api.renombrarProyecto('SID', config, 'ai-platform.md', '   '), /vacío/);
});

// --- cerrarProyecto (archivar/reabrir: silencia alertas sin perder historial) ---

test('cerrarProyecto marca status closed + closed_on y reabrir lo revierte', () => {
  const h = adminHarness();
  const config = h.api.construirConfig('SID', CONFIG);
  const root = h.api.ensureBrainFolder_('SID', config);
  ponerWiki(h, root, 'projects', 'onboarding.md',
    { page_type: 'project', name: 'Onboarding Q2', last_updated: '2026-06-30' }, '# Onboarding Q2\n\nEntregado.');
  const carpeta = h.api.carpetaBrain_(root, ['wiki', 'projects']);

  const c = plain(h.api.cerrarProyecto('SID', config, 'onboarding.md', true));
  assert.deepEqual({ ok: c.ok, name: c.name, cerrado: c.cerrado }, { ok: true, name: 'Onboarding Q2', cerrado: true });
  let fm = h.api.parsearPagina_(h.api.leerArchivoBrain_(carpeta, 'onboarding.md')).frontmatter;
  assert.equal(fm.status, 'closed');
  assert.ok(fm.closed_on, 'registra la fecha de cierre');
  assert.match(logDe(h, root), /✅ cerrar proyecto · Onboarding Q2/);

  const r = plain(h.api.cerrarProyecto('SID', config, 'onboarding.md', false));
  assert.equal(r.cerrado, false);
  fm = h.api.parsearPagina_(h.api.leerArchivoBrain_(carpeta, 'onboarding.md')).frontmatter;
  assert.equal(fm.status, 'active');
  assert.equal(fm.closed_on, undefined, 'reabrir borra closed_on');
  assert.match(logDe(h, root), /↩ reabrir proyecto · Onboarding Q2/);
});

test('cerrarProyecto falla claro si el proyecto no existe', () => {
  const h = adminHarness();
  const config = h.api.construirConfig('SID', CONFIG);
  h.api.ensureBrainFolder_('SID', config);
  assert.throws(() => h.api.cerrarProyecto('SID', config, 'nada.md', true), /no encontrado/);
});

test('dispatch enruta renombrarProyecto y cerrarProyecto', () => {
  const h = adminHarness();
  const config = h.api.construirConfig('SID', CONFIG);
  const root = h.api.ensureBrainFolder_('SID', config);
  ponerWiki(h, root, 'projects', 'alpha.md', { page_type: 'project', name: 'Alpha' }, '# Alpha');
  h.api.guardarProyectos_(root, { alpha: { name: 'Alpha', aliases: [] } });

  const cr = plain(h.api.dispatch('cerrarProyecto', ['alpha.md', true], 'SID', config));
  assert.equal(cr.cerrado, true);
  const rn = plain(h.api.dispatch('renombrarProyecto', ['alpha.md', 'Alpha 2'], 'SID', config));
  assert.equal(rn.name, 'Alpha 2');
});
