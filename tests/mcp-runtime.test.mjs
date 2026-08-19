/**
 * mcp-runtime.test.mjs — API JSON del lado GAS de Vera-MCP (shared/mcp-runtime.js).
 * El Worker de Cloudflare entra por webAction con ?mcp=1; aquí se prueba mcpAction directo.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { makeHarness, httpResponse } from './gas-harness.mjs';

const SID = 'SHEET_1';
const SECRET = 'S3CRET';
const CONFIG = {
  sheets: { roster: 'Equipo', settings: 'Ajustes' },
  timezone: 'America/Lima',
  brain: { enabled: false }   // sin Drive: telegramWikiPages_ → [] y espejarTareaInmediato_ → no-op
};
const HEADERS = ['Tarea', 'Proyecto', 'Vence', 'Prioridad', 'Estado', 'Origen', 'Id', 'Espera de', 'Link', 'EventId', 'Creada el'];

function row(texto, extra = {}) {
  return [
    texto, extra.proyecto || '', extra.vence || '', extra.prioridad || 'Media',
    extra.estado || 'Pendiente', extra.origen || '✍️ Manual', extra.id || ('id-' + texto.length),
    extra.espera || '', extra.link || '', '', extra.creada || ''
  ];
}

function harness(tareas = [], opts = {}) {
  const h = makeHarness({
    spreadsheets: { [SID]: {
      Tareas: [HEADERS, ...tareas],
      Equipo: [['Nombre', 'Correo', 'Rol'], ['Ada Lovelace', 'ada@x.com', 'Eng']]
    } },
    scriptProperties: opts.noSecret ? {} : { ['mcp:' + SID + ':secret']: SECRET }
  });
  return h;
}

function call(h, op, extra = {}, cfg = CONFIG) {
  const body = Object.assign({ op }, extra);
  const e = { parameter: { mcp: '1' }, postData: { contents: JSON.stringify(body) } };
  return JSON.parse(h.api.mcpAction(e, SID, cfg).getContent());
}

// --- Auth ---

test('sin secreto guardado → not-enrolled', () => {
  const h = harness([], { noSecret: true });
  assert.deepEqual(call(h, 'get_catalog', { secret: 'x' }), { ok: false, error: 'not-enrolled' });
});

test('secreto que no cuadra → unauthorized', () => {
  const h = harness();
  assert.deepEqual(call(h, 'get_catalog', { secret: 'wrong' }), { ok: false, error: 'unauthorized' });
});

// --- challenge (enrollment) ---

test('challenge firma el nonce con el secreto guardado (determinista, sin secret en el request)', () => {
  const h = harness();
  const r1 = call(h, 'challenge', { nonce: 'nonce-123' });
  const r2 = call(h, 'challenge', { nonce: 'nonce-123' });
  const expected = Buffer.from(crypto.createHmac('sha256', SECRET).update('nonce-123').digest()).toString('base64');
  assert.equal(r1.ok, true);
  assert.equal(r1.sig, expected);
  assert.equal(r2.sig, expected);            // determinista
  assert.notEqual(call(h, 'challenge', { nonce: 'otro' }).sig, expected);
});

test('challenge sin nonce → error', () => {
  assert.deepEqual(call(harness(), 'challenge', {}), { ok: false, error: 'missing-nonce' });
});

// --- list_tasks ---

test('list_tasks excluye Hecha por defecto y filtra por estado/proyecto', () => {
  const h = harness([
    row('Enviar informe', { id: 'id-a', proyecto: 'AI Academy', estado: 'Pendiente' }),
    row('Cosa vieja', { id: 'id-b', estado: 'Hecha' }),
    row('Revisar demo', { id: 'id-c', proyecto: 'Helios', estado: 'En curso' })
  ]);
  const abiertas = call(h, 'list_tasks', { secret: SECRET, args: {} });
  assert.equal(abiertas.ok, true);
  assert.deepEqual(abiertas.tasks.map((t) => t.id).sort(), ['id-a', 'id-c']);
  assert.equal(abiertas.tasks[0].fila, undefined);   // no filtra internos

  const soloAcademy = call(h, 'list_tasks', { secret: SECRET, args: { proyecto: 'academy' } });
  assert.deepEqual(soloAcademy.tasks.map((t) => t.id), ['id-a']);

  const conHechas = call(h, 'list_tasks', { secret: SECRET, args: { incluirHechas: true } });
  assert.equal(conHechas.tasks.length, 3);
});

// --- get_catalog ---

test('get_catalog devuelve people del roster (projects vacío sin brain)', () => {
  const r = call(harness(), 'get_catalog', { secret: SECRET });
  assert.equal(r.ok, true);
  assert.ok(r.people.includes('Ada Lovelace'));
  assert.deepEqual(r.projects, []);
});

// --- create_task ---

test('create_task crea; segundo idéntico sin force → duplicate; con force → crea otra', () => {
  const h = harness();
  const first = call(h, 'create_task', { secret: SECRET, args: { texto: 'Preparar board deck', prioridad: 'Alta' } });
  assert.equal(first.ok, true);
  assert.ok(first.id);
  assert.equal(first.duplicate, undefined);

  const dup = call(h, 'create_task', { secret: SECRET, args: { texto: 'Preparar board deck' } });
  assert.equal(dup.duplicate, true);
  assert.equal(dup.similar.length, 1);
  assert.equal(dup.similar[0].texto, 'Preparar board deck');

  const forced = call(h, 'create_task', { secret: SECRET, args: { texto: 'Preparar board deck', force: true } });
  assert.equal(forced.ok, true);
  assert.ok(forced.id);

  const rows = h.getSpreadsheet(SID).getSheetByName('Tareas').getDataRange().getValues();
  assert.equal(rows.length, 3);   // header + 2 tareas
});

test('create_task sin texto → error; fecha inválida → error', () => {
  const h = harness();
  assert.equal(call(h, 'create_task', { secret: SECRET, args: {} }).ok, false);
  assert.equal(call(h, 'create_task', { secret: SECRET, args: { texto: 'X', vence: '20-08-2026' } }).ok, false);
});

// --- edit_task ---

test('edit_task cambia estado/vence y preserva el id (col 7)', () => {
  const h = harness([row('Preparar demo', { id: 'id-edit', vence: '2026-08-21' })]);
  const r = call(h, 'edit_task', { secret: SECRET, args: { id: 'id-edit', campos: { estado: 'Hecha', vence: '2026-08-25' } } });
  assert.equal(r.ok, true);
  assert.equal(r.task.id, 'id-edit');
  assert.equal(r.task.estado, 'Hecha');
  assert.equal(r.task.vence, '2026-08-25');
});

test('edit_task con id inexistente → ok:false con error', () => {
  const r = call(harness(), 'edit_task', { secret: SECRET, args: { id: 'no-existe', campos: { estado: 'Hecha' } } });
  assert.equal(r.ok, false);
  assert.match(r.error, /Tareas/);
});

// --- routing por webAction ---

test('webAction enruta ?mcp=1 (POST) a mcpAction', () => {
  const h = harness();
  const e = { parameter: { mcp: '1' }, postData: { contents: JSON.stringify({ op: 'get_catalog', secret: SECRET }) } };
  const out = JSON.parse(h.api.webAction('post', e, SID, CONFIG).getContent());
  assert.equal(out.ok, true);
  assert.ok(Array.isArray(out.people));
});

test('op desconocida → unknown-op', () => {
  assert.deepEqual(call(harness(), 'nope', { secret: SECRET }), { ok: false, error: 'unknown-op' });
});

// --- Sidebar: cargarMcp / iniciarConexionMcp / desconectarMcp ---

const CONFIG_WEB = Object.assign({}, CONFIG, { webapp: { url: 'https://script.google.com/macros/s/dep/exec' } });
const WORKER = 'https://vera-mcp.test.workers.dev';

function sidebarHarness(opts = {}) {
  const props = {};
  if (!opts.noWorker) props['MCP_WORKER_URL'] = WORKER;
  if (opts.secret) props['mcp:' + SID + ':secret'] = opts.secret;
  return makeHarness({
    spreadsheets: { [SID]: { Tareas: [HEADERS], Equipo: [['Nombre', 'Correo', 'Rol']] } },
    scriptProperties: props
  });
}

test('cargarMcp refleja worker configurado, connectorUrl y estado de conexión', () => {
  const h = sidebarHarness();
  const s1 = h.api.cargarMcp(SID, CONFIG_WEB);
  assert.equal(s1.workerConfigured, true);
  assert.equal(s1.connectorUrl, WORKER + '/mcp');
  assert.equal(s1.connected, false);
  assert.equal(s1.webApp.ready, true);

  const h2 = sidebarHarness({ secret: SECRET });
  assert.equal(h2.api.cargarMcp(SID, CONFIG_WEB).connected, true);
});

test('iniciarConexionMcp registra en /enroll, crea el secreto y devuelve el code sin filtrarlo', () => {
  const h = sidebarHarness();
  h.setFetch((url, options) => {
    assert.match(url, /\/enroll$/);
    const body = JSON.parse(options.payload);
    assert.equal(body.webAppUrl, 'https://script.google.com/macros/s/dep/exec');
    assert.ok(body.secret && body.secret.length > 0);       // el secreto viaja al Worker...
    return httpResponse(200, JSON.stringify({ ok: true, code: 'PAIR1234', expiresInSeconds: 600 }));
  });
  const out = h.api.iniciarConexionMcp(SID, CONFIG_WEB);
  assert.equal(out.code, 'PAIR1234');
  assert.equal(out.connectorUrl, WORKER + '/mcp');
  assert.equal(out.secret, undefined);                       // ...pero NO al browser
  assert.ok(h.scriptProps.get('mcp:' + SID + ':secret'));    // secreto persistido
  assert.equal(h.fetchCalls.length, 1);
});

test('iniciarConexionMcp falla claro sin MCP_WORKER_URL o con Web App inválida', () => {
  assert.throws(() => sidebarHarness({ noWorker: true }).api.iniciarConexionMcp(SID, CONFIG_WEB), /MCP_WORKER_URL/);
  const noWeb = Object.assign({}, CONFIG, { webapp: { url: '' } });
  assert.throws(() => sidebarHarness().api.iniciarConexionMcp(SID, noWeb), /Web App|exec/i);
});

test('iniciarConexionMcp propaga el rechazo del Worker (challenge-failed)', () => {
  const h = sidebarHarness();
  h.setFetch(() => httpResponse(400, JSON.stringify({ ok: false, error: 'challenge-failed' })));
  assert.throws(() => h.api.iniciarConexionMcp(SID, CONFIG_WEB), /challenge-failed/);
});

test('desconectarMcp borra el secreto → cargarMcp queda desconectado', () => {
  const h = sidebarHarness({ secret: SECRET });
  assert.equal(h.api.desconectarMcp(SID, CONFIG_WEB).ok, true);
  assert.equal(h.scriptProps.has('mcp:' + SID + ':secret'), false);
  assert.equal(h.api.cargarMcp(SID, CONFIG_WEB).connected, false);
});

// --- Calendar (Fase B): create_calendar_event / edit_calendar_event ---

const LIDER = 'lider@x.com';
const CONFIG_CAL = Object.assign({}, CONFIG, { leader: { email: LIDER } });

function calHarness(events = []) {
  return makeHarness({
    spreadsheets: { [SID]: { Tareas: [HEADERS], Equipo: [['Nombre', 'Correo', 'Rol']] } },
    scriptProperties: { ['mcp:' + SID + ':secret']: SECRET },
    calendar: events,
    calendarOwner: LIDER
  });
}

test('create_calendar_event crea el evento (fechas ISO) y lo persiste', () => {
  const h = calHarness();
  const r = call(h, 'create_calendar_event', { secret: SECRET, args: {
    titulo: 'Sync Helios', inicio: '2026-08-20T15:00:00-05:00', fin: '2026-08-20T16:00:00-05:00',
    ubicacion: 'Meet', invitados: ['ana@x.com']
  } }, CONFIG_CAL);
  assert.equal(r.ok, true);
  assert.equal(r.event.titulo, 'Sync Helios');
  assert.deepEqual(r.event.invitados, ['ana@x.com']);
  assert.ok(r.event.id);
  assert.equal(h.getCalendar()._events.length, 1);
});

test('create_calendar_event rechaza fecha inválida y fin<=inicio', () => {
  const h = calHarness();
  assert.equal(call(h, 'create_calendar_event', { secret: SECRET, args: { titulo: 'X', inicio: 'no-fecha', fin: '2026-08-20T16:00:00-05:00' } }, CONFIG_CAL).ok, false);
  assert.equal(call(h, 'create_calendar_event', { secret: SECRET, args: { titulo: 'X', inicio: '2026-08-20T16:00:00-05:00', fin: '2026-08-20T15:00:00-05:00' } }, CONFIG_CAL).ok, false);
});

test('edit_calendar_event edita si eres organizador y rechaza si no', () => {
  const own = { id: 'ev-own', title: 'Antiguo', start: new Date('2026-08-20T15:00:00-05:00'), end: new Date('2026-08-20T16:00:00-05:00'), creators: [LIDER] };
  const ajeno = { id: 'ev-ajeno', title: 'Ajeno', start: new Date('2026-08-21T10:00:00-05:00'), end: new Date('2026-08-21T11:00:00-05:00'), creators: ['jefe@x.com'] };
  const h = calHarness([own, ajeno]);

  const ok = call(h, 'edit_calendar_event', { secret: SECRET, args: { id: 'ev-own', campos: { titulo: 'Nuevo título', ubicacion: 'Sala 2' } } }, CONFIG_CAL);
  assert.equal(ok.ok, true);
  assert.equal(ok.event.titulo, 'Nuevo título');
  assert.equal(ok.event.ubicacion, 'Sala 2');

  const rej = call(h, 'edit_calendar_event', { secret: SECRET, args: { id: 'ev-ajeno', campos: { titulo: 'Hack' } } }, CONFIG_CAL);
  assert.equal(rej.ok, false);
  assert.match(rej.error, /organizador/i);

  const noExiste = call(h, 'edit_calendar_event', { secret: SECRET, args: { id: 'nope', campos: { titulo: 'X' } } }, CONFIG_CAL);
  assert.equal(noExiste.ok, false);
});
