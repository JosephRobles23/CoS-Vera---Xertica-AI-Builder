/**
 * meet-notes-runtime.test.mjs — Ingesta de Notas de Gemini (Meet) al brain.
 * Cubre la matriz del grill: parseo del título (ejemplos reales + inglés + no-match), cascada de
 * descubrimiento (attachment / título+hora ±60 / standalone), export 403 = sin acceso con
 * reintento al día siguiente, externos con página `external:true` y alias estabilizado, sección
 * Pendientes, merge con el acta del Deep Prep por eventId, anti-dup por docId, guard horario,
 * import inicial (plan, tope por pasada, done, cancelar), scan de silencios que ignora externos,
 * purga del raw de reuniones, gating de flags y ruteo dispatch.
 * Corre con: npm test
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
const NOW = new Date();
const FUTURO = () => Date.now() + 300000;
const hace = (horas) => new Date(NOW.getTime() - horas * 3600000);
const p2 = (n) => (n < 10 ? '0' : '') + n;
const fechaLocal = (d) => d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate());

const EXTRACT_DEFAULT = {
  resumen: 'Se revisaron prioridades y seguridad de infraestructura.',
  asistentes: ['Julio Toloza', 'Carol Diaz'],
  eventos: [
    { persona: 'Julio Toloza', correo: 'julio@x.com', proyecto: 'Classroom', tipo: 'accion', texto: 'Validar Classroom con Carol', confidence: 0.9 },
    { persona: 'Carol Diaz', correo: '', proyecto: 'Classroom', tipo: 'blocker', texto: 'Carga masiva sin responsables', confidence: 0.8 }
  ]
};

function meetHarness(opts = {}) {
  const h = makeHarness({
    scriptProperties: { GEMINI_API_KEY: 'K' },
    spreadsheets: { SID: {
      Ajustes: [
        ['key', 'value'],
        ['brain.enabled', String(opts.brain !== false)],
        ['meet.enabled', String(opts.meet !== false)],
        // leader.email SIEMPRE presente: los tests de runDispatcher usan reloj real y, si la
        // corrida cae en la ventana de cierre, el consolidado lanzaría sin líder (flaky).
        ['leader.email', 'lider@x.com'], ['leader.name', 'Líder'],
        ...(opts.ajustes || [])
      ],
      Equipo: [['Nombre', 'Correo', 'Rol'], ['Julio Toloza', 'julio@x.com', 'Dev'], ['Ada', 'ada@x.com', 'Dev']],
      Daily: [['Marca temporal', 'Summary']],
      Weekly: [['Marca temporal', 'Summary']]
    } }
  });
  const eventos = opts.eventos || [];
  const docs = opts.docs || {};
  const extract = opts.extract || (() => EXTRACT_DEFAULT);
  h.setFetch((url, options) => {
    if (url.indexOf('calendar/v3') > -1) return httpResponse(200, JSON.stringify({ items: eventos }));
    const m = /drive\/v3\/files\/([^/]+)\/export/.exec(url);
    if (m) {
      const d = docs[decodeURIComponent(m[1])];
      if (d == null) return httpResponse(403, 'no access');
      return httpResponse(200, d);
    }
    if (url.indexOf('generativelanguage') > -1) {
      const user = JSON.parse(options.payload).contents[0].parts[0].text;
      return httpResponse(200, geminiOk(JSON.stringify(extract(user))));
    }
    return httpResponse(404, 'ruta no mockeada: ' + url);
  });
  return h;
}

const geminiCalls = (h) => h.fetchCalls.filter((c) => c.url.indexOf('generativelanguage') > -1);
const calendarCalls = (h) => h.fetchCalls.filter((c) => c.url.indexOf('calendar/v3') > -1);
const leerWiki = (h, root, segs, name) => h.api.leerArchivoBrain_(h.api.carpetaBrain_(root, segs), name);
const logDe = (h, root) => leerWiki(h, root, ['wiki'], 'log.md') || '';

// Evento de Calendar (shape REST) con attachment de notas.
const evConNotas = (id, titulo, inicio, docId) => ({
  id, summary: titulo, start: { dateTime: inicio.toISOString() },
  attachments: [{ fileId: docId, title: titulo + ': 2026/07/31 14:29 GMT-03:00 - Notas de Gemini', mimeType: 'application/vnd.google-apps.document' }]
});

// --- Parseo del título ---

test('parsearTituloNotas_ entiende los títulos reales (es/en) y rechaza los ajenos', () => {
  const h = meetHarness();
  const a = plain(h.api.parsearTituloNotas_('AAP - Team: 2026/07/31 14:29 GMT-03:00 - Notas de Gemini'));
  assert.equal(a.titulo, 'AAP - Team');
  assert.equal(a.tsMs, Date.UTC(2026, 6, 31, 17, 29));   // 14:29 -03:00 = 17:29Z

  const b = plain(h.api.parsearTituloNotas_('Despliegue AI First Framework e Implementación: 2026/07/08 17:00 GMT-03:00 - Notas de Gemini'));
  assert.equal(b.titulo, 'Despliegue AI First Framework e Implementación');
  assert.equal(b.tsMs, Date.UTC(2026, 6, 8, 20, 0));

  const c = plain(h.api.parsearTituloNotas_('Weekly Sync: 2026/08/01 09:30 GMT+02:00 - Notes by Gemini'));
  assert.equal(c.titulo, 'Weekly Sync');
  assert.equal(c.tsMs, Date.UTC(2026, 7, 1, 7, 30));

  assert.equal(h.api.parsearTituloNotas_('Minutas del comité (agosto)'), null);
  assert.equal(h.api.esTituloNotas_('AAP - Team: 2026/07/31 14:29 GMT-03:00 - Notas de Gemini'), true);
  assert.equal(h.api.esTituloNotas_('Presupuesto 2026'), false);
});

test('matchEventoPorTitulo_ respeta la tolerancia de ±60 min y el título normalizado', () => {
  const h = meetHarness();
  const ts = Date.UTC(2026, 6, 31, 17, 29);
  const eventos = [
    { id: 'lejos', titulo: 'AAP - Team', inicioMs: ts - 61 * 60000 },
    { id: 'cerca', titulo: '  aap - TEAM ', inicioMs: ts - 59 * 60000 },
    { id: 'otro', titulo: 'Otra reunión', inicioMs: ts }
  ];
  assert.equal(h.api.matchEventoPorTitulo_(eventos, 'AAP - Team', ts).id, 'cerca');
  assert.equal(h.api.matchEventoPorTitulo_([eventos[0]], 'AAP - Team', ts), null, 'a 61 min ya no matchea');
});

// --- Descubrimiento (3 fuentes) ---

test('descubrirNotasMeet_ une attachment, carpeta propia y compartidos, con match en cascada', () => {
  const inicioEv2 = new Date(Date.UTC(2026, 6, 31, 17, 20));   // 9 min antes del ts del título
  const h = meetHarness({
    eventos: [
      evConNotas('ev1', 'Daily Sync', hace(3), 'docAdj'),
      { id: 'ev2', summary: 'AAP - Team', start: { dateTime: inicioEv2.toISOString() } }   // sin attachment
    ]
  });
  const config = h.api.construirConfig('SID', CONFIG);

  // Carpeta propia (estructura jul-2026: "Google Meet" con subcarpeta por reunión).
  const gm = h.getDrive().createFolder('Google Meet');
  gm.createFolder('AAP - Team').createFile('AAP - Team: 2026/07/31 14:29 GMT-03:00 - Notas de Gemini', 'notas');
  // Compartido sin evento en su calendario.
  h.getDrive()._searchResults = [h.getDrive()._makeLooseFile('Retro Ajena: 2026/08/01 10:00 GMT-03:00 - Notas de Gemini', 'notas')];

  const cands = plain(h.api.descubrirNotasMeet_(config, 60, NOW));
  const porTitulo = {};
  cands.forEach((c) => { porTitulo[c.tituloDoc.split(':')[0]] = c; });

  assert.equal(cands.length, 3);
  assert.equal(porTitulo['Daily Sync'].eventId, 'ev1', 'attachment: match directo');
  assert.equal(porTitulo['AAP - Team'].eventId, 'ev2', 'carpeta: match por título+hora');
  assert.equal(porTitulo['Retro Ajena'].eventId, '', 'compartido sin evento: standalone');
});

// --- Ingesta end-to-end ---

test('runMeetPass_ ingesta: raw, acta, roster con Pendientes, externa con external:true, proyecto y log', () => {
  const inicio = hace(2);
  const h = meetHarness({
    eventos: [evConNotas('ev1', 'Transformacion Team - Daily', inicio, 'doc1')],
    docs: { doc1: 'Resumen...\nPróximos pasos: [Julio Cesar Toloza] Validar Classroom' }
  });
  const config = h.api.construirConfig('SID', CONFIG);
  const root = h.api.ensureBrainFolder_('SID', config);
  const fecha = fechaLocal(inicio);

  assert.equal(h.api.runMeetPass_('SID', config, NOW, FUTURO()), 1);

  // El prompt llevó el roster y el texto exportado del Doc.
  const user = JSON.parse(geminiCalls(h)[0].options.payload).contents[0].parts[0].text;
  assert.match(user, /julio@x\.com/);
  assert.match(user, /Validar Classroom/);

  // raw inmutable con la fecha de la reunión.
  const raws = plain(h.api.listarArchivosBrain_(h.api.carpetaBrain_(root, ['raw', 'meetings']), '.md'));
  assert.equal(raws.length, 1);
  const rawFm = h.api.parsearPagina_(raws[0].content).frontmatter;
  assert.equal(rawFm.doc_id, 'doc1');
  assert.equal(String(rawFm.matched), 'true');
  assert.equal(rawFm.date, fecha);

  // Acta con event_id.
  const acta = h.api.parsearPagina_(leerWiki(h, root, ['wiki', 'meetings'], fecha + '_transformacion-team-daily.md'));
  assert.equal(acta.frontmatter.event_id, 'ev1');
  assert.match(acta.body, /Pendientes/);

  // Julio (roster): página por correo, con la acción en Pendientes.
  const julio = h.api.parsearPagina_(leerWiki(h, root, ['wiki', 'people'], 'julio-x-com.md'));
  assert.equal(String(julio.frontmatter.external), 'undefined', 'los del roster no llevan external');
  assert.match(julio.body, /## Pendientes/);
  assert.match(julio.body, new RegExp('- \\[' + fecha + '\\] Validar Classroom con Carol \\(Classroom\\)'));

  // Carol (externa): página propia marcada.
  const carol = h.api.parsearPagina_(leerWiki(h, root, ['wiki', 'people'], 'carol-diaz.md'));
  assert.equal(String(carol.frontmatter.external), 'true');
  assert.match(carol.body, /Carga masiva sin responsables/);

  // Proyecto + log.
  assert.ok(leerWiki(h, root, ['wiki', 'projects'], 'classroom.md'));
  assert.match(logDe(h, root), /🎥 notas de Meet · Transformacion Team - Daily · 2 eventos · 1 pendiente\(s\)/);
});

test('el alias estabiliza a la externa: "Carol" y "Carol Diaz" son la misma página', () => {
  const h = meetHarness({
    eventos: [evConNotas('ev1', 'Sync A', hace(4), 'doc1'), evConNotas('ev2', 'Sync B', hace(2), 'doc2')],
    docs: { doc1: 'notas A', doc2: 'notas B' },
    extract: (user) => ({
      resumen: 'R', asistentes: [],
      eventos: [user.indexOf('notas A') > -1
        ? { persona: 'Carol Diaz', tipo: 'avance', texto: 'Definió la carga', confidence: 1 }
        : { persona: 'Carol', tipo: 'avance', texto: 'Cerró responsables', confidence: 1 }]
    })
  });
  const config = h.api.construirConfig('SID', CONFIG);
  const root = h.api.ensureBrainFolder_('SID', config);
  h.api.runMeetPass_('SID', config, NOW, FUTURO());

  const files = plain(h.api.listarArchivosBrain_(h.api.carpetaBrain_(root, ['wiki', 'people']), '.md'))
    .map((a) => a.name).filter((n) => n.indexOf('carol') === 0);
  assert.deepEqual(files, ['carol-diaz.md'], 'una sola página');
  const carol = h.api.parsearPagina_(leerWiki(h, root, ['wiki', 'people'], 'carol-diaz.md'));
  assert.match(carol.body, /Definió la carga/);
  assert.match(carol.body, /Cerró responsables/);
  const mapa = JSON.parse(leerWiki(h, root, ['wiki', 'people'], '_people.json'));
  assert.ok(mapa['carol-diaz'].aliases.includes('carol'));
});

test('si ya existe el acta del Deep Prep con el mismo eventId, las notas se mergean sin duplicar', () => {
  const inicio = hace(2);
  const fecha = fechaLocal(inicio);
  const h = meetHarness({
    eventos: [evConNotas('ev1', 'Revisión Alpha', inicio, 'doc1')],
    docs: { doc1: 'notas' }
  });
  const config = h.api.construirConfig('SID', CONFIG);
  const root = h.api.ensureBrainFolder_('SID', config);
  // Acta previa del Deep Prep (mismo eventId, nombre distinto al que generaría la nota).
  h.api.escribirArchivoBrain_(h.api.carpetaBrain_(root, ['wiki', 'meetings']), fecha + '_revision-alpha.md',
    h.api.componerPagina_({ page_type: 'meeting', event_id: 'ev1', date: fecha }, '# Revisión Alpha\n\n## Briefing\n- preparado'));

  h.api.runMeetPass_('SID', config, NOW, FUTURO());

  const archivos = plain(h.api.listarArchivosBrain_(h.api.carpetaBrain_(root, ['wiki', 'meetings']), '.md'));
  assert.equal(archivos.length, 1, 'no se creó una segunda acta');
  const acta = h.api.parsearPagina_(archivos[0].content);
  assert.match(acta.body, /## Briefing/, 'conserva lo del Deep Prep');
  assert.match(acta.body, /## Notas \(Gemini\)/);
  assert.match(acta.body, /## Pendientes/);
  assert.equal(acta.frontmatter.doc_id, 'doc1');
});

// --- Guardas: anti-dup, horario, sin acceso ---

test('anti-dup por docId y guard horario: ni re-ingesta ni re-descubre dentro de la misma hora', () => {
  const h = meetHarness({ eventos: [evConNotas('ev1', 'Daily', hace(2), 'doc1')], docs: { doc1: 'n' } });
  const config = h.api.construirConfig('SID', CONFIG);
  h.api.runMeetPass_('SID', config, NOW, FUTURO());
  assert.equal(geminiCalls(h).length, 1);
  const calendarAntes = calendarCalls(h).length;

  // Misma hora → guard horario: ni siquiera consulta el Calendar.
  assert.equal(h.api.runMeetPass_('SID', config, NOW, FUTURO()), 0);
  assert.equal(calendarCalls(h).length, calendarAntes);

  // Una hora después → re-descubre pero el docId ya está marcado: cero Gemini nuevo.
  assert.equal(h.api.runMeetPass_('SID', config, new Date(NOW.getTime() + 3600000), FUTURO()), 0);
  assert.equal(geminiCalls(h).length, 1);
});

test('sin acceso (403): se cuenta y loguea 1×/día, y al compartirse después SÍ se ingesta', () => {
  const docs = {};   // doc1 ausente → 403
  const h = meetHarness({ eventos: [evConNotas('ev1', 'Comité', hace(2), 'doc1')], docs });
  const config = h.api.construirConfig('SID', CONFIG);
  const root = h.api.ensureBrainFolder_('SID', config);

  assert.equal(h.api.runMeetPass_('SID', config, NOW, FUTURO()), 0);
  assert.equal((logDe(h, root).match(/🔒 nota de Meet sin acceso · Comité/g) || []).length, 1);

  // Al día siguiente le comparten el Doc → la ventana lo re-encuentra y lo ingesta.
  docs.doc1 = 'ahora sí';
  const manana = new Date(NOW.getTime() + 24 * 3600000);
  assert.equal(h.api.runMeetPass_('SID', config, manana, FUTURO()), 1);
  assert.equal(geminiCalls(h).length, 1);
});

// --- Import inicial ---

test('iniciarImportNotas exige los flags y calcula el plan; el job procesa por lotes hasta done', () => {
  const eventos = [], docs = {};
  for (let i = 0; i < 12; i++) {
    eventos.push(evConNotas('ev' + i, 'Reunión ' + i, hace(24 * (i + 1)), 'doc' + i));
    docs['doc' + i] = 'notas ' + i;
  }
  const h = meetHarness({ eventos, docs, extract: () => ({ resumen: 'R', asistentes: [], eventos: [] }) });
  const config = h.api.construirConfig('SID', CONFIG);
  const root = h.api.ensureBrainFolder_('SID', config);

  assert.equal(plain(h.api.estadoImportNotas('SID', config, 30)).plan.pendientes, 12);
  const res = plain(h.api.iniciarImportNotas('SID', config, 30));
  assert.equal(res.iniciado, true);
  assert.equal(res.total, 12);

  // Import running → corre en cada pasada (sin guard horario) con tope de 10 docs por pasada.
  h.api.runMeetPass_('SID', config, NOW, FUTURO());
  let st = plain(h.api.estadoImportNotas('SID', config));
  assert.equal(st.ok, 10);
  assert.equal(st.status, 'running');

  h.api.runMeetPass_('SID', config, new Date(NOW.getTime() + 5 * 60000), FUTURO());
  st = plain(h.api.estadoImportNotas('SID', config));
  assert.equal(st.ok, 12);
  assert.equal(st.status, 'done');
  assert.match(logDe(h, root), /✅ import de notas de Meet completado · 12 indexada\(s\)/);
});

test('iniciarImportNotas lanza si falta meet.enabled o brain.enabled', () => {
  const h1 = meetHarness({ meet: false });
  const c1 = h1.api.construirConfig('SID', CONFIG);
  assert.throws(() => h1.api.iniciarImportNotas('SID', c1, 30), /meet\.enabled/);

  const h2 = meetHarness({ brain: false });
  const c2 = h2.api.construirConfig('SID', CONFIG);
  assert.throws(() => h2.api.iniciarImportNotas('SID', c2, 30), /Activa la memoria/);
});

test('cancelarImportNotas pausa y reiniciar no duplica (anti-dup por docId)', () => {
  const eventos = [], docs = {};
  for (let i = 0; i < 12; i++) {
    eventos.push(evConNotas('ev' + i, 'R' + i, hace(24 * (i + 1)), 'doc' + i));
    docs['doc' + i] = 'n' + i;
  }
  const h = meetHarness({ eventos, docs, extract: () => ({ resumen: 'R', asistentes: [], eventos: [] }) });
  const config = h.api.construirConfig('SID', CONFIG);
  h.api.ensureBrainFolder_('SID', config);
  h.api.iniciarImportNotas('SID', config, 30);
  h.api.runMeetPass_('SID', config, NOW, FUTURO());   // 10
  assert.equal(plain(h.api.cancelarImportNotas('SID', config)).status, 'idle');

  h.api.iniciarImportNotas('SID', config, 30);   // re-inicia: el plan ya solo ve 2 pendientes
  assert.equal(plain(h.api.estadoImportNotas('SID', config)).total, 2);
  h.api.runMeetPass_('SID', config, new Date(NOW.getTime() + 5 * 60000), FUTURO());
  assert.equal(geminiCalls(h).length, 12, 'ninguna nota se re-pagó');
  assert.equal(plain(h.api.estadoImportNotas('SID', config)).status, 'done');
});

// --- Interacciones con el resto del brain ---

test('el scan de silencios ignora a los externos', () => {
  const h = meetHarness();
  const config = h.api.construirConfig('SID', CONFIG);
  const root = h.api.ensureBrainFolder_('SID', config);
  const people = h.api.carpetaBrain_(root, ['wiki', 'people']);
  h.api.escribirArchivoBrain_(people, 'ada-x-com.md',
    h.api.componerPagina_({ page_type: 'person', name: 'Ada', last_updated: '2026-01-05' }, 'x'));
  h.api.escribirArchivoBrain_(people, 'carol-diaz.md',
    h.api.componerPagina_({ page_type: 'person', name: 'Carol Diaz', last_updated: '2026-01-05', external: true }, 'x'));

  const hallazgos = plain(h.api.scanSilencios_('SID', config, NOW));
  assert.deepEqual(hallazgos.map((x) => x.name), ['Ada'], 'Carol (externa) no cuenta como silencio');
});

test('la purga por retención también alcanza al raw de reuniones', () => {
  const h = meetHarness({ ajustes: [['brain.retentionMonths', '1']] });
  const config = h.api.construirConfig('SID', CONFIG);
  const root = h.api.ensureBrainFolder_('SID', config);
  const carpeta = h.api.carpetaBrain_(root, ['raw', 'meetings']);
  h.api.escribirArchivoBrain_(carpeta, 'vieja.md',
    h.api.componerPagina_({ page_type: 'meeting-notes', date: '2026-01-10' }, 'x'));
  h.api.escribirArchivoBrain_(carpeta, 'nueva.md',
    h.api.componerPagina_({ page_type: 'meeting-notes', date: fechaLocal(NOW) }, 'x'));

  assert.equal(h.api.purgarRaw_('SID', config, NOW), 1);
  const nombres = plain(h.api.listarArchivosBrain_(carpeta, '.md')).map((a) => a.name);
  assert.deepEqual(nombres, ['nueva.md']);
});

test('runDispatcher no toca Meet con el flag apagado, y sí con ambos encendidos', () => {
  const hOff = meetHarness({ meet: false, eventos: [evConNotas('ev1', 'Daily', hace(2), 'doc1')], docs: { doc1: 'n' } });
  hOff.api.runDispatcher('SID', hOff.api.construirConfig('SID', CONFIG), NOW);
  assert.equal(calendarCalls(hOff).length, 0);

  const hOn = meetHarness({ eventos: [evConNotas('ev1', 'Daily', hace(2), 'doc1')], docs: { doc1: 'n' } });
  hOn.api.runDispatcher('SID', hOn.api.construirConfig('SID', CONFIG), NOW);
  assert.equal(geminiCalls(hOn).length, 1, 'la pasada de Meet corrió dentro del dispatcher');
});

test('dispatch enruta iniciar/estado/cancelar del import de notas', () => {
  const h = meetHarness({ eventos: [evConNotas('ev1', 'Daily', hace(2), 'doc1')], docs: { doc1: 'n' } });
  const config = h.api.construirConfig('SID', CONFIG);
  h.api.ensureBrainFolder_('SID', config);

  assert.equal(plain(h.api.dispatch('estadoImportNotas', [30], 'SID', config)).plan.pendientes, 1);
  assert.equal(plain(h.api.dispatch('iniciarImportNotas', [30], 'SID', config)).iniciado, true);
  assert.equal(plain(h.api.dispatch('cancelarImportNotas', [], 'SID', config)).status, 'idle');
});

test('la ingesta de notas regenera el índice: reunión, externa y persona listadas', () => {
  const inicio = hace(2);
  const h = meetHarness({
    eventos: [evConNotas('ev1', 'Transformacion Team - Daily', inicio, 'doc1')],
    docs: { doc1: 'notas' }
  });
  const config = h.api.construirConfig('SID', CONFIG);
  const root = h.api.ensureBrainFolder_('SID', config);
  h.api.runMeetPass_('SID', config, NOW, FUTURO());

  const idx = h.api.leerArchivoBrain_(h.api.carpetaBrain_(root, ['wiki']), 'index.md');
  assert.match(idx, /## Reuniones \(1\)/);
  assert.match(idx, /\[Transformacion Team - Daily\]\(meetings\//);
  assert.match(idx, /\[Carol Diaz\]\(people\/carol-diaz\.md\) · externa/);
});

// --- Compuerta + enum en la pasada de Meet (bug 2026-08-13: fuga de razonamiento) ---

const MONOLOGO_MEET =
  "AI Academy or Plataforma Web de IA en Xertica. Usaremos 'AI Academy'. No, dejemos el campo " +
  "conciso. Let me clean up and refine actions. proyecto: AI Academy, confidence: 1.0";

test('resolverExterno_ rechaza nombres con fuga: null y sin entrada en _people.json', () => {
  const h = meetHarness();
  const config = h.api.construirConfig('SID', CONFIG);
  const root = h.api.ensureBrainFolder_('SID', config);
  assert.equal(h.api.resolverExterno_(root, MONOLOGO_MEET), null);
  assert.deepEqual(plain(h.api.cargarPersonasExt_(root)), {});
  // un nombre legítimo sigue creando su canónico
  assert.equal(h.api.resolverExterno_(root, 'Carol Diaz').slug, 'carol-diaz');
});

test('runMeetPass_ manda enum del catálogo + temperatura 0, y OTRO basura va al log sin crear página', () => {
  const inicio = hace(2);
  const h = meetHarness({
    eventos: [evConNotas('ev1', 'Transformacion Team - Daily', inicio, 'doc1')],
    docs: { doc1: 'Notas...' },
    extract: () => ({
      resumen: 'R',
      asistentes: ['Julio Toloza'],
      eventos: [
        { persona: 'Julio Toloza', correo: 'julio@x.com', proyecto: 'OTRO', proyecto_nuevo: 'Fénix', tipo: 'avance', texto: 'arrancó Fénix', confidence: 0.9 },
        { persona: 'Julio Toloza', correo: 'julio@x.com', proyecto: 'OTRO', proyecto_nuevo: MONOLOGO_MEET, tipo: 'avance', texto: 'avance huérfano', confidence: 0.9 }
      ]
    })
  });
  const config = h.api.construirConfig('SID', CONFIG);
  const root = h.api.ensureBrainFolder_('SID', config);
  h.api.resolverProyecto_(root, 'Classroom');   // catálogo previo → debe viajar en el enum

  assert.equal(h.api.runMeetPass_('SID', config, NOW, FUTURO()), 1);

  // request: temperatura 0 y proyecto como enum del catálogo
  const gc = JSON.parse(geminiCalls(h)[0].options.payload).generationConfig;
  assert.equal(gc.temperature, 0);
  assert.deepEqual(gc.responseSchema.properties.eventos.items.properties.proyecto.enum,
    ['Classroom', 'OTRO', 'NINGUNO']);
  assert.equal(gc.responseSchema.properties.eventos.items.properties.proyecto_nuevo.type, 'string');

  // OTRO válido creó página; OTRO basura no, y quedó en el log
  assert.ok(leerWiki(h, root, ['wiki', 'projects'], 'fenix.md'), 'Fénix creado');
  const mapa = plain(h.api.cargarProyectos_(root));
  assert.deepEqual(Object.keys(mapa).sort(), ['classroom', 'fenix'], 'nada basura en el catálogo');
  assert.match(logDe(h, root), /⚠️ proyecto rechazado por sanidad · AI Academy or Plataforma Web/);

  // el evento huérfano no se perdió: está en la página de Julio, sin proyecto
  const julio = leerWiki(h, root, ['wiki', 'people'], 'julio-x-com.md');
  assert.match(julio, /avance huérfano/);

  // separación: la viñeta de la página de proyecto lleva el autor (persona del evento)
  const fenix = leerWiki(h, root, ['wiki', 'projects'], 'fenix.md');
  assert.match(fenix, /arrancó Fénix · por Julio Toloza/);
});
