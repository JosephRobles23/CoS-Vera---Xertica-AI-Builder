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

test('la ingesta regenera wiki/index.md con personas y proyectos al día', () => {
  const h = brainHarness(EVENTOS);
  const config = h.api.construirConfig('SID', CONFIG);
  h.api.ingestarFila_('SID', config, 'daily', { nombre: 'Ada Lovelace', correo: 'ada@x.com' },
    [{ q: '¿Qué lograste?', a: 'Cerré el diseño' }], 2, 'system');

  const root = h.api.ensureBrainFolder_('SID', config);
  const idx = h.api.parsearPagina_(h.api.leerArchivoBrain_(h.api.carpetaBrain_(root, ['wiki']), 'index.md'));
  assert.equal(idx.frontmatter.page_type, 'index');
  assert.ok(idx.frontmatter.last_updated, 'lleva fecha');
  assert.match(idx.body, /## Personas \(1\)/);
  assert.match(idx.body, /\[Ada Lovelace\]\(people\/ada-x-com\.md\)/);
  assert.match(idx.body, /## Proyectos \(1\)/);
  assert.match(idx.body, /\[Proyecto Alpha\]\(projects\/proyecto-alpha\.md\)/);
});

// --- Compuerta determinista de nombres de entidad (bug 2026-08-13: fuga de razonamiento) ---

// Extracto real del bug: la deliberación del modelo entera como nombre de proyecto.
const MONOLOGO_BUG =
  "AI Academy or Plataforma Web de IA por Gemini en Meet e Inteligencia Artificial en Xertica. " +
  "Posibles valores: 'AI Academy', 'Plataforma Web'. Usaremos 'AI Academy'. No, dejemos el campo " +
  "conciso. Let me clean up and refine actions. proyecto: AI Academy, confidence: 1.0";

test('sanitizarProyecto_: matriz de aceptación/rechazo', () => {
  const h = brainHarness();
  // pasan: nombres reales de iniciativas
  for (const ok of ['AI Academy', 'Plataforma de Adopción', 'Dealflow', 'Plataforma 2.0', 'Google Chat Integration']) {
    assert.equal(h.api.sanitizarProyecto_(ok), ok, `debería pasar: ${ok}`);
  }
  // rechazan: fugas y basura
  const casos = [
    ['monólogo del bug real', MONOLOGO_BUG],
    ['más de 60 chars', 'x'.repeat(61)],
    ['más de 6 palabras', 'uno dos tres cuatro cinco seis siete'],
    ['salto de línea', 'AI\nAcademy'],
    ['marcador confidence:', 'AI Academy, confidence: 1.0'],
    ['marcador proyecto:', "proyecto: 'AI Academy'"],
    ['flecha de action item', 'Joseph -> coordinar reunión'],
    ['comillas dobles', 'usa "AI Academy"'],
    ['dos oraciones', 'Usaremos AI Academy. No, mejor Plataforma.'],
    ['vacío', ''],
    ['solo espacios', '   ']
  ];
  for (const [caso, v] of casos) {
    assert.equal(h.api.sanitizarProyecto_(v), null, `debería rechazar: ${caso}`);
  }
  assert.equal(h.api.sanitizarNombreEntidad_(null), null);
  assert.equal(h.api.sanitizarNombreEntidad_(undefined), null);
});

test('resolverProyecto_ rechazado por la compuerta: null y SIN entidad creada', () => {
  const h = brainHarness();
  const root = h.api.ensureBrainFolder_('SID', CONFIG);
  assert.equal(h.api.resolverProyecto_(root, MONOLOGO_BUG), null);
  assert.deepEqual(plain(h.api.cargarProyectos_(root)), {}, '_projects.json sigue vacío');
});

test('resolverProyecto_ dedup: contención de tokens y stopwords ES/EN', () => {
  const h = brainHarness();
  const root = h.api.ensureBrainFolder_('SID', CONFIG);
  h.api.resolverProyecto_(root, 'AI Academy');

  // contención: "ai-academy" ⊂ "ai-academy-web" (Jaccard 2/3 llegaría, pero 2 tokens de 4 no)
  const a = h.api.resolverProyecto_(root, 'AI Academy Web Platform');
  assert.equal(a.slug, 'ai-academy', 'contención matchea aunque el Jaccard no llegue');

  // stopwords: "Proyecto AI Academy" y "el AI Academy" son el mismo proyecto
  const b = h.api.resolverProyecto_(root, 'Proyecto AI Academy');
  assert.equal(b.slug, 'ai-academy');

  // pero proyectos distintos con un token común NO se fusionan (Jaccard 1/3, sin contención)
  const c = h.api.resolverProyecto_(root, 'Plataforma Web');
  const d = h.api.resolverProyecto_(root, 'Plataforma IA');
  assert.equal(c.slug, 'plataforma-web');
  assert.equal(d.slug, 'plataforma-ia', 'Plataforma IA es un proyecto distinto de Plataforma Web');
});

test('slugComparable_ filtra stopwords y sobrevive a un slug de puras stopwords', () => {
  const h = brainHarness();
  assert.equal(h.api.slugComparable_('proyecto-de-la-ai-academy'), 'ai-academy');
  assert.equal(h.api.slugComparable_('de-la-el'), 'de-la-el', 'todo stopwords → queda igual');
});

// --- Catálogo como enum (schema por llamada) ---

test('schemaConProyectos_ inyecta enum + proyecto_nuevo sin mutar el schema base', () => {
  const h = brainHarness();
  const root = h.api.ensureBrainFolder_('SID', CONFIG);

  // catálogo vacío → enum mínimo ['OTRO','NINGUNO']
  let schema = plain(h.api.schemaConProyectos_(root, h.api.INGEST_SCHEMA_));
  assert.deepEqual(schema.properties.eventos.items.properties.proyecto.enum, ['OTRO', 'NINGUNO']);
  assert.equal(schema.properties.eventos.items.properties.proyecto_nuevo.type, 'string');

  // con proyectos → nombres canónicos + OTRO + NINGUNO
  h.api.resolverProyecto_(root, 'AI Academy');
  h.api.resolverProyecto_(root, 'Dealflow');
  schema = plain(h.api.schemaConProyectos_(root, h.api.INGEST_SCHEMA_));
  assert.deepEqual(schema.properties.eventos.items.properties.proyecto.enum,
    ['AI Academy', 'Dealflow', 'OTRO', 'NINGUNO']);

  // regresión del 400 de la v25: el API rechaza valores vacíos en un enum — jamás emitirlos
  const enumVals = schema.properties.eventos.items.properties.proyecto.enum;
  assert.ok(enumVals.every((v) => typeof v === 'string' && v.length > 0),
    'ningún valor vacío o no-string en el enum');

  // el base NO se mutó
  assert.equal(h.api.INGEST_SCHEMA_.properties.eventos.items.properties.proyecto.enum, undefined);
  assert.equal(h.api.INGEST_SCHEMA_.properties.eventos.items.properties.proyecto_nuevo, undefined);
});

test('nombreProyectoEvento_: canónico directo, OTRO lee proyecto_nuevo, NINGUNO/vacío quedan vacíos', () => {
  const h = brainHarness();
  assert.equal(h.api.nombreProyectoEvento_({ proyecto: 'AI Academy' }), 'AI Academy');
  assert.equal(h.api.nombreProyectoEvento_({ proyecto: 'OTRO', proyecto_nuevo: 'Fénix' }), 'Fénix');
  assert.equal(h.api.nombreProyectoEvento_({ proyecto: 'OTRO' }), '');
  assert.equal(h.api.nombreProyectoEvento_({ proyecto: 'NINGUNO' }), '');
  assert.equal(h.api.nombreProyectoEvento_({ proyecto: '' }), '');
  assert.equal(h.api.nombreProyectoEvento_({}), '');
});

test('ingestarFila_ manda el enum del catálogo y temperatura 0 en el request', () => {
  const h = brainHarness(EVENTOS);
  const config = h.api.construirConfig('SID', CONFIG);
  const root = h.api.ensureBrainFolder_('SID', config);
  h.api.resolverProyecto_(root, 'Proyecto Alpha');

  h.api.ingestarFila_('SID', config, 'daily', { nombre: 'Ada Lovelace', correo: 'ada@x.com' },
    [{ q: 'q', a: 'a' }], 2, 'SYS');

  const call = h.fetchCalls.find((c) => c.url.indexOf('generativelanguage') > -1);
  const gc = JSON.parse(call.options.payload).generationConfig;
  assert.equal(gc.temperature, 0);
  assert.deepEqual(gc.responseSchema.properties.eventos.items.properties.proyecto.enum,
    ['Proyecto Alpha', 'OTRO', 'NINGUNO']);
});

test('ingesta e2e: OTRO válido crea el proyecto; OTRO basura va al log y no crea nada', () => {
  const h = brainHarness({
    summary: 'S',
    eventos: [
      { persona: 'Ada', proyecto: 'OTRO', proyecto_nuevo: 'Fénix', tipo: 'avance', texto: 'arrancó Fénix', confidence: 0.9 },
      { persona: 'Ada', proyecto: 'OTRO', proyecto_nuevo: MONOLOGO_BUG, tipo: 'avance', texto: 'avance sin hogar', confidence: 0.9 }
    ]
  });
  const config = h.api.construirConfig('SID', CONFIG);
  h.api.ingestarFila_('SID', config, 'daily', { nombre: 'Ada Lovelace', correo: 'ada@x.com' },
    [{ q: 'q', a: 'a' }], 2, 'SYS');

  const root = rootOf(h);
  const projects = sub(sub(root, 'wiki'), 'projects');
  assert.ok(file(projects, 'fenix.md'), 'el nombre válido creó su página');
  assert.equal(countFiles(projects), 2, 'solo fenix.md + _projects.json — nada más');

  const log = h.api.leerArchivoBrain_(sub(root, 'wiki'), 'log.md');
  assert.match(log, /⚠️ proyecto rechazado por sanidad · AI Academy or Plataforma Web de IA/);

  // el evento rechazado NO se pierde: vive en la página de la persona, sin proyecto
  const person = h.api.leerArchivoBrain_(sub(sub(root, 'wiki'), 'people'), 'ada-x-com.md');
  assert.match(person, /avance sin hogar/);
  assert.ok(!/avance sin hogar \(/.test(person), 'sin anotación de proyecto');
});

test('separación: la página de PROYECTO lleva autor "· por"; la de persona NO', () => {
  const h = brainHarness(EVENTOS);
  const config = h.api.construirConfig('SID', CONFIG);
  h.api.ingestarFila_('SID', config, 'daily', { nombre: 'Ada Lovelace', correo: 'ada@x.com' },
    [{ q: 'q', a: 'a' }], 2, 'SYS');

  const root = rootOf(h);
  const proj = h.api.leerArchivoBrain_(sub(sub(root, 'wiki'), 'projects'), 'proyecto-alpha.md');
  assert.match(proj, /cerró el diseño · por Ada Lovelace/, 'viñeta de proyecto con autor');
  const person = h.api.leerArchivoBrain_(sub(sub(root, 'wiki'), 'people'), 'ada-x-com.md');
  assert.ok(!/· por /.test(person), 'la página de la persona no se anota a sí misma');
});

// --- Techos defensivos de los campos narrativos ---

test('parseIngest_ trunca texto (300) y summary (600)', () => {
  const h = brainHarness();
  const r = h.api.parseIngest_(JSON.stringify({
    summary: 's'.repeat(700),
    eventos: [{ tipo: 'avance', texto: 't'.repeat(400) }]
  }));
  assert.equal(r.summary.length, 601);   // 600 + '…' del recorte
  assert.equal(r.eventos[0].texto.length, 301);
  assert.match(r.summary, /…$/);
});
