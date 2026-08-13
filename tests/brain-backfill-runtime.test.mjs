/**
 * brain-backfill-runtime.test.mjs — Importación del histórico Daily/Weekly al brain.
 * Cubre la matriz acordada en el grill: selección/conteo (retención, roster, vacías), merge
 * cronológico entre hojas, fechado por fila (y su interacción con la purga), time-box + tope por
 * pasada, idempotencia (raw existente, cancelar/reanudar), errores por fila con auditoría,
 * suspensión del scan de silencios durante el job, relleno de Summary solo-si-vacío, convivencia
 * con la ingesta viva, gating por brain.enabled y el ruteo por dispatch().
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

// Reloj de la pasada: 2026-08-20 a media tarde UTC (media mañana en Lima; lejos de bordes de día).
const NOW = new Date(2026, 7, 20, 15, 0);
const FUTURO = () => Date.now() + 300000;   // deadline generoso (5 min)
const ts = (y, m, d) => new Date(y, m - 1, d, 15, 0);   // timestamps de fila, misma hora segura

const D_HDR = ['Marca temporal', 'Dirección de correo electrónico', '¿Qué haces hoy?', 'Summary'];
const W_HDR = ['Marca temporal', 'Dirección de correo electrónico', '¿Qué lograste?', 'Summary'];
const fila = (t, correo, resp, sum) => [t, correo, resp, sum || ''];

function bfHarness(opts = {}) {
  const h = makeHarness({
    scriptProperties: { GEMINI_API_KEY: 'K' },
    spreadsheets: { SID: {
      Ajustes: [
        ['key', 'value'],
        ['brain.enabled', String(opts.brain !== false)],
        ['leader.email', 'jefe@x.com'],
        ...(opts.ajustes || [])
      ],
      Equipo: [['Nombre', 'Correo', 'Rol'], ['Ada', 'ada@x.com', 'Dev'], ['Bob', 'bob@x.com', 'Dev']],
      Daily: [D_HDR, ...(opts.daily || [])],
      Weekly: [W_HDR, ...(opts.weekly || [])]
    } }
  });
  h.setFetch(() => httpResponse(200, geminiOk(JSON.stringify(
    { summary: 'S', eventos: [{ tipo: 'avance', texto: 'evento', confidence: 1 }] }))));
  return h;
}

const userTexts = (h) => h.fetchCalls.map((c) => JSON.parse(c.options.payload).contents[0].parts[0].text);
const rawNames = (h, root) =>
  plain(h.api.listarArchivosBrain_(h.api.carpetaBrain_(root, ['raw', 'reports']), '.md')).map((a) => a.name).sort();
const logDe = (h, root) => h.api.leerArchivoBrain_(h.api.carpetaBrain_(root, ['wiki']), 'log.md') || '';
const estadoDe = (h) => plain(h.api.getAjustes_('SID', 'Ajustes').brain.backfill);

// --- Selección y conteo (plan previo al confirm) ---

test('estadoBackfill clasifica el histórico: elegibles, fuera de retención, fuera de roster y vacías', () => {
  const h = bfHarness({
    daily: [
      fila(ts(2026, 8, 10), 'ada@x.com', 'Avance A'),
      fila(ts(2024, 1, 5), 'ada@x.com', 'viejísimo'),        // > 12 meses
      fila(ts(2026, 8, 11), 'zoe@x.com', 'de una ex'),       // no está en Equipo
      fila(ts(2026, 8, 12), 'ada@x.com', '')                 // sin contenido
    ],
    weekly: [fila(ts(2026, 8, 14), 'bob@x.com', 'Logro B')]
  });
  const config = h.api.construirConfig('SID', CONFIG);

  const st = plain(h.api.estadoBackfill('SID', config));
  assert.equal(st.status, 'idle');
  assert.deepEqual(st.plan, { elegibles: 2, fueraRetencion: 1, fueraRoster: 1, vacias: 1 });
});

test('sin histórico (solo encabezados) el plan es 0 e iniciarBackfill no arranca nada', () => {
  const h = bfHarness();
  const config = h.api.construirConfig('SID', CONFIG);

  assert.equal(h.api.estadoBackfill('SID', config).plan.elegibles, 0);
  const res = plain(h.api.iniciarBackfill('SID', config));
  assert.equal(res.iniciado, false);
  assert.equal(estadoDe(h).status, 'idle');
  assert.equal(h.fetchCalls.length, 0);
});

// --- Orden y fechado ---

test('procesa Daily y Weekly mezcladas en orden cronológico por Marca temporal', () => {
  const h = bfHarness({
    daily: [fila(ts(2026, 8, 10), 'ada@x.com', 'RESP-D10'), fila(ts(2026, 8, 12), 'ada@x.com', 'RESP-D12')],
    weekly: [fila(ts(2026, 8, 5), 'ada@x.com', 'RESP-W05')]
  });
  const config = h.api.construirConfig('SID', CONFIG);
  h.api.iniciarBackfill('SID', config);
  h.api.runBackfillPass_('SID', config, NOW, FUTURO());

  const orden = userTexts(h).map((t) => /RESP-(\w+)/.exec(t)[1]);
  assert.deepEqual(orden, ['W05', 'D10', 'D12']);

  const root = h.api.ensureBrainFolder_('SID', config);
  const pg = h.api.parsearPagina_(h.api.leerArchivoBrain_(h.api.carpetaBrain_(root, ['wiki', 'people']), 'ada-x-com.md'));
  assert.equal(pg.frontmatter.last_updated, '2026-08-12');   // terminó en la más nueva
});

test('los eventos y el raw se fechan con la Marca temporal de la fila, no con hoy', () => {
  const h = bfHarness({ daily: [fila(ts(2026, 8, 10), 'ada@x.com', 'Avance A')] });
  const config = h.api.construirConfig('SID', CONFIG);
  h.api.iniciarBackfill('SID', config);
  h.api.runBackfillPass_('SID', config, NOW, FUTURO());

  const root = h.api.ensureBrainFolder_('SID', config);
  assert.deepEqual(rawNames(h, root), ['2026-08-10_ada-x-com_daily_r2.md']);
  const raw = h.api.parsearPagina_(h.api.leerArchivoBrain_(h.api.carpetaBrain_(root, ['raw', 'reports']), '2026-08-10_ada-x-com_daily_r2.md'));
  assert.equal(raw.frontmatter.date, '2026-08-10');

  const pg = h.api.parsearPagina_(h.api.leerArchivoBrain_(h.api.carpetaBrain_(root, ['wiki', 'people']), 'ada-x-com.md'));
  assert.equal(pg.frontmatter.last_updated, '2026-08-10');
  assert.match(pg.body, /- \[2026-08-10\] evento/);
});

test('el raw histórico fechado por fila SÍ cae en la purga por retención', () => {
  const h = bfHarness({ daily: [fila(ts(2026, 6, 1), 'ada@x.com', 'Avance viejo')] });
  const config = h.api.construirConfig('SID', CONFIG);
  h.api.iniciarBackfill('SID', config);
  h.api.runBackfillPass_('SID', config, NOW, FUTURO());
  const root = h.api.ensureBrainFolder_('SID', config);
  assert.equal(rawNames(h, root).length, 1);

  // El líder baja la retención a 1 mes → la purga alcanza al raw de junio.
  h.api.setAjustes_('SID', 'Ajustes', { 'brain.retentionMonths': '1' });
  const config2 = h.api.construirConfig('SID', CONFIG);
  assert.equal(h.api.purgarRaw_('SID', config2, NOW), 1);
  assert.deepEqual(rawNames(h, root), []);
});

// --- Lotes: time-box y tope por pasada ---

test('con el deadline vencido la pasada no ingesta nada y el cursor no se mueve', () => {
  const h = bfHarness({ daily: [fila(ts(2026, 8, 10), 'ada@x.com', 'A'), fila(ts(2026, 8, 11), 'ada@x.com', 'B')] });
  const config = h.api.construirConfig('SID', CONFIG);
  h.api.iniciarBackfill('SID', config);

  assert.equal(h.api.runBackfillPass_('SID', config, NOW, Date.now() - 1), 0);
  assert.equal(h.fetchCalls.length, 0);
  let st = estadoDe(h);
  assert.equal(st.status, 'running');
  assert.equal(st.cursorDaily, 2);

  assert.equal(h.api.runBackfillPass_('SID', config, NOW, FUTURO()), 2);
  assert.equal(estadoDe(h).status, 'done');
});

test('tope de 30 filas por pasada; la siguiente pasada retoma y completa', () => {
  const daily = [];
  for (let i = 0; i < 35; i++) daily.push(fila(new Date(2026, 7, 1, 15, i), 'ada@x.com', 'R' + i));
  const h = bfHarness({ daily });
  const config = h.api.construirConfig('SID', CONFIG);
  h.api.iniciarBackfill('SID', config);

  assert.equal(h.api.runBackfillPass_('SID', config, NOW, FUTURO()), 30);
  let st = estadoDe(h);
  assert.equal(st.status, 'running');
  assert.equal(st.ok, 30);
  assert.equal(st.cursorDaily, 32);   // 2 + 30 procesadas

  assert.equal(h.api.runBackfillPass_('SID', config, NOW, FUTURO()), 5);
  st = estadoDe(h);
  assert.equal(st.status, 'done');
  assert.equal(st.ok, 35);
  assert.equal(h.fetchCalls.length, 35);
});

// --- Integración con el dispatcher ---

test('el backfill corre al final de la pasada: las invitaciones salen igual', () => {
  // El formatDate del harness usa getters locales del Date, así que NOW (15:00) rinde '15:00'.
  const hhmm = '15:00';
  const h = bfHarness({
    daily: [fila(ts(2026, 8, 10), 'ada@x.com', 'histórico')],
    ajustes: [['schedule.invitesDaily', hhmm], ['forms.dailyUrl', 'https://forms.gle/x']]
  });
  const config = h.api.construirConfig('SID', CONFIG);
  h.api.iniciarBackfill('SID', config);

  h.api.runDispatcher('SID', config, NOW);
  const invitaciones = h.sentEmails.filter((m) => m.to === 'ada@x.com' || m.to === 'bob@x.com');
  assert.equal(invitaciones.length, 2, 'las invitaciones del roster salieron en la misma pasada');
  assert.equal(estadoDe(h).ok, 1, 'y el backfill avanzó igual');
});

test('al terminar deja línea de cierre en el log y las pasadas siguientes no reprocesan', () => {
  const h = bfHarness({ daily: [fila(ts(2026, 8, 10), 'ada@x.com', 'A'), fila(ts(2026, 8, 11), 'ada@x.com', 'B')] });
  const config = h.api.construirConfig('SID', CONFIG);
  h.api.iniciarBackfill('SID', config);
  h.api.runBackfillPass_('SID', config, NOW, FUTURO());

  const root = h.api.ensureBrainFolder_('SID', config);
  const cierre = logDe(h, root).match(/✅ backfill completado · 2 ingestada\(s\) · 0 saltada\(s\) · 0 error\(es\)/g);
  assert.equal((cierre || []).length, 1);

  assert.equal(h.api.runBackfillPass_('SID', config, NOW, FUTURO()), 0);
  assert.equal(h.fetchCalls.length, 2, 'no hubo llamadas nuevas');
  assert.equal((logDe(h, root).match(/backfill completado/g) || []).length, 1, 'sin doble cierre');
});

// --- Idempotencia y errores ---

test('un raw ya existente para esa fila no se re-escribe (inmutable)', () => {
  const h = bfHarness({ daily: [fila(ts(2026, 8, 10), 'ada@x.com', 'Avance A')] });
  const config = h.api.construirConfig('SID', CONFIG);
  const root = h.api.ensureBrainFolder_('SID', config);
  h.api.escribirArchivoBrain_(h.api.carpetaBrain_(root, ['raw', 'reports']),
    '2026-08-10_ada-x-com_daily_r2.md', 'ORIGINAL-INTOCABLE');

  h.api.iniciarBackfill('SID', config);
  h.api.runBackfillPass_('SID', config, NOW, FUTURO());

  assert.equal(estadoDe(h).ok, 1);
  const raw = h.api.leerArchivoBrain_(h.api.carpetaBrain_(root, ['raw', 'reports']), '2026-08-10_ada-x-com_daily_r2.md');
  assert.equal(raw, 'ORIGINAL-INTOCABLE');
});

test('una fila que falla en Gemini avanza el cursor, cuenta el error y queda en el log', () => {
  const h = bfHarness({
    daily: [fila(ts(2026, 8, 10), 'ada@x.com', 'RESP-BAD'), fila(ts(2026, 8, 12), 'ada@x.com', 'RESP-OK')]
  });
  h.setFetch((_url, options) => {
    const user = JSON.parse(options.payload).contents[0].parts[0].text;
    if (user.indexOf('RESP-BAD') > -1) return httpResponse(500, 'boom');
    return httpResponse(200, geminiOk(JSON.stringify({ summary: 'S', eventos: [] })));
  });
  const config = h.api.construirConfig('SID', CONFIG);
  h.api.iniciarBackfill('SID', config);
  h.api.runBackfillPass_('SID', config, NOW, FUTURO());

  const st = estadoDe(h);
  assert.equal(st.status, 'done');
  assert.equal(st.errores, 1);
  assert.equal(st.ok, 1);
  const root = h.api.ensureBrainFolder_('SID', config);
  assert.match(logDe(h, root), /⚠️ backfill · fila 2 de Daily falló/);
});

test('cancelar pausa conservando cursores y reanudar no repite ninguna llamada', () => {
  const daily = [];
  for (let i = 0; i < 35; i++) daily.push(fila(new Date(2026, 7, 1, 15, i), 'ada@x.com', 'R' + i));
  const h = bfHarness({ daily });
  const config = h.api.construirConfig('SID', CONFIG);
  h.api.iniciarBackfill('SID', config);
  h.api.runBackfillPass_('SID', config, NOW, FUTURO());   // 30 filas
  assert.equal(h.fetchCalls.length, 30);

  const c = plain(h.api.cancelarBackfill('SID', config));
  assert.equal(c.status, 'idle');
  assert.equal(h.api.runBackfillPass_('SID', config, NOW, FUTURO()), 0, 'pausado: no procesa');

  const r = plain(h.api.iniciarBackfill('SID', config));
  assert.equal(r.iniciado, true);
  assert.equal(r.ok, 30, 'reanuda conservando el avance');
  h.api.runBackfillPass_('SID', config, NOW, FUTURO());
  assert.equal(h.fetchCalls.length, 35, 'solo las 5 pendientes: nada se re-llamó');
  assert.equal(estadoDe(h).status, 'done');
});

// --- Interacciones ---

test('el scan de silencios se suspende durante el backfill y corre tras terminar', () => {
  const h = bfHarness({ daily: [fila(ts(2026, 8, 10), 'ada@x.com', 'A')] });
  const config = h.api.construirConfig('SID', CONFIG);
  const root = h.api.ensureBrainFolder_('SID', config);
  // Página estancada sembrada (Zoe no se toca en el backfill).
  h.api.escribirArchivoBrain_(h.api.carpetaBrain_(root, ['wiki', 'people']), 'zoe-x-com.md',
    h.api.componerPagina_({ page_type: 'person', name: 'Zoe', last_updated: '2026-08-01' }, 'Vieja.'));

  h.api.iniciarBackfill('SID', config);
  h.api.runDispatcher('SID', config, NOW);   // backfill running al entrar → scan suprimido
  assert.ok(!/scan de silencios/.test(logDe(h, root)), 'sin scan durante el job');

  // El job quedó done dentro de esa misma pasada; la siguiente ya escanea.
  assert.equal(estadoDe(h).status, 'done');
  h.api.runDispatcher('SID', config, new Date(NOW.getTime() + 5 * 60000));
  assert.match(logDe(h, root), /scan de silencios/);
  const zoe = h.api.parsearPagina_(h.api.leerArchivoBrain_(h.api.carpetaBrain_(root, ['wiki', 'people']), 'zoe-x-com.md'));
  assert.equal(zoe.frontmatter.silence_flagged, '2026-08-01');
});

test('rellena el Summary solo cuando la celda está vacía', () => {
  const h = bfHarness({
    daily: [
      fila(ts(2026, 8, 10), 'ada@x.com', 'sin summary', ''),
      fila(ts(2026, 8, 11), 'bob@x.com', 'con summary', 'YA-LEIDO-POR-EL-LIDER')
    ]
  });
  const config = h.api.construirConfig('SID', CONFIG);
  h.api.iniciarBackfill('SID', config);
  h.api.runBackfillPass_('SID', config, NOW, FUTURO());

  const sh = h.api.getSheet_('SID', 'Daily');
  assert.equal(sh.getRange(2, 4).getValue(), 'S', 'la vacía se rellenó');
  assert.equal(sh.getRange(3, 4).getValue(), 'YA-LEIDO-POR-EL-LIDER', 'la existente quedó intacta');
});

test('una fila fuera del roster no crea página ni raw ni llama a Gemini', () => {
  const h = bfHarness({ daily: [fila(ts(2026, 8, 10), 'zoe@x.com', 'de una ex-integrante')] });
  const config = h.api.construirConfig('SID', CONFIG);
  h.api.iniciarBackfill('SID', config);   // plan: 0 elegibles, no arranca…
  assert.equal(estadoDe(h).status, 'idle');
  assert.equal(h.fetchCalls.length, 0);

  const root = h.api.ensureBrainFolder_('SID', config);
  assert.deepEqual(rawNames(h, root), []);
  assert.equal(h.api.leerArchivoBrain_(h.api.carpetaBrain_(root, ['wiki', 'people']), 'zoe-x-com.md'), null);
});

test('convive con la ingesta viva: sin raw duplicado y el evento aparece una sola vez', () => {
  const hoy = new Date();
  const h = bfHarness({ daily: [fila(hoy, 'ada@x.com', 'reporte de hoy', '')] });
  const config = h.api.construirConfig('SID', CONFIG);

  // Ingesta viva primero (onFormSubmit): fecha = hoy, escribe Summary y raw r2.
  h.api.generarSummaryFila('SID', config, 'Daily', 2);
  const root = h.api.ensureBrainFolder_('SID', config);
  assert.equal(rawNames(h, root).length, 1);

  // Luego el backfill pasa por la misma fila (misma fecha → mismo nombre de raw).
  h.api.iniciarBackfill('SID', config);
  h.api.runBackfillPass_('SID', config, hoy, FUTURO());

  assert.equal(rawNames(h, root).length, 1, 'el raw no se duplicó');
  const pg = h.api.parsearPagina_(h.api.leerArchivoBrain_(h.api.carpetaBrain_(root, ['wiki', 'people']), 'ada-x-com.md'));
  assert.equal((pg.body.match(/\] evento/g) || []).length, 1, 'el bullet dedup-eó');
  assert.equal(h.api.getSheet_('SID', 'Daily').getRange(2, 4).getValue(), 'S', 'el Summary vivo no se pisó');
});

// --- Gating y ruteo ---

test('iniciarBackfill exige brain.enabled', () => {
  const h = bfHarness({ brain: false, daily: [fila(ts(2026, 8, 10), 'ada@x.com', 'A')] });
  const config = h.api.construirConfig('SID', CONFIG);
  assert.throws(() => h.api.iniciarBackfill('SID', config), /Activa la memoria/);
});

test('dispatch enruta iniciar/estado/cancelar del backfill', () => {
  const h = bfHarness({ daily: [fila(ts(2026, 8, 10), 'ada@x.com', 'A')] });
  const config = h.api.construirConfig('SID', CONFIG);

  assert.equal(plain(h.api.dispatch('estadoBackfill', [], 'SID', config)).plan.elegibles, 1);
  assert.equal(plain(h.api.dispatch('iniciarBackfill', [], 'SID', config)).iniciado, true);
  assert.equal(plain(h.api.dispatch('cancelarBackfill', [], 'SID', config)).status, 'idle');
});
