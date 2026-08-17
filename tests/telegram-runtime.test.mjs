/** Telegram onboarding contract: secrets stay out of Ajustes; pairing is ephemeral and scoped. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHarness, httpResponse, geminiOk } from './gas-harness.mjs';

const SID = 'SHEET_1';
const BASE = {
  sheets: { settings: 'Ajustes', roster: 'Equipo', daily: 'Daily', weekly: 'Weekly', prompts: 'Prompts' },
  timezone: 'America/Lima', webapp: { url: 'https://script.google.com/macros/s/example/exec' },
  brain: { enabled: true }, models: { perRow: 'gemini-test' }
};
const plain = (v) => JSON.parse(JSON.stringify(v));

function harness() {
  const h = makeHarness({ spreadsheets: { [SID]: { Ajustes: [['key', 'value']] } } });
  h.setFetch(() => httpResponse(200, JSON.stringify({ ok: true, result: { id: 7, username: 'cos_qa_bot' } })));
  return h;
}

test('guardarTokenTelegram valida el bot, guarda el secreto solo en Script Properties y deja estado en Ajustes', () => {
  const h = harness();
  const res = plain(h.api.guardarTokenTelegram(SID, BASE, '123456:abcdefghijklmnopqrstuvwxyz_ABCDE'));
  assert.deepEqual(res, { ok: true, botUsername: 'cos_qa_bot' });
  const props = h.scriptProps;
  assert.equal(props.get('telegram:SHEET_1:token'), '123456:abcdefghijklmnopqrstuvwxyz_ABCDE');
  const ajuste = h.api.getAjustes_(SID, 'Ajustes');
  assert.equal(ajuste.telegram.botUsername, 'cos_qa_bot');
  assert.equal(ajuste.telegram.enabled, false);
  assert.ok(!Object.values(ajuste).join(' ').includes('123456:'), 'el token nunca se escribe en Ajustes');
});

test('iniciarPairingTelegram entrega deep link efímero y no expone token', () => {
  const h = harness();
  h.api.guardarTokenTelegram(SID, BASE, '123456:abcdefghijklmnopqrstuvwxyz_ABCDE');
  const pair = plain(h.api.iniciarPairingTelegram(SID, BASE));
  assert.match(pair.deepLink, /^https:\/\/t\.me\/cos_qa_bot\?start=pair_[A-Za-z0-9_-]+$/);
  assert.equal(pair.expiresInSeconds, 300);
  assert.ok(!JSON.stringify(pair).includes('123456:'), 'la respuesta del modal no filtra el token');
  assert.match(h.scriptProps.get('telegram:SHEET_1:pairing'), /"nonce"/);
  const registration = h.fetchCalls.find((c) => /setWebhook$/.test(c.url));
  assert.ok(registration, 'el pairing registra el webhook en Telegram');
  const payload = JSON.parse(registration.options.payload);
  assert.match(payload.url, /\/exec\?tg=/);
  assert.deepEqual(payload.allowed_updates, ['message']);
});

test('telegramWebhookAction rechaza ruta inválida y solo vincula el usuario que presenta el nonce vigente', () => {
  const h = harness();
  h.api.guardarTokenTelegram(SID, BASE, '123456:abcdefghijklmnopqrstuvwxyz_ABCDE');
  const pair = h.api.iniciarPairingTelegram(SID, BASE);
  const secret = h.scriptProps.get('telegram:SHEET_1:webhook');
  const bad = h.api.telegramWebhookAction({ parameter: { tg: 'incorrecto' }, postData: { contents: '{}' } }, SID, BASE);
  assert.equal(bad.getContent(), 'not found');

  const update = { update_id: 44, message: { chat: { id: 99, type: 'private' }, from: { id: 99, first_name: 'Joseph' }, text: '/start pair_' + pair.deepLink.split('pair_')[1] } };
  const ok = h.api.telegramWebhookAction({ parameter: { tg: secret }, postData: { contents: JSON.stringify(update) } }, SID, BASE);
  assert.equal(ok.getContent(), 'ok');
  const state = plain(h.api.cargarTelegram(SID, BASE));
  assert.equal(state.paired, true);
  assert.equal(state.userLabel, 'Joseph');
  assert.equal(h.scriptProps.get('telegram:SHEET_1:allowedUserId'), '99');
});

test('telegramWebhookAction deduplica updates y no responde preguntas de IDs fuera de allowlist', () => {
  const h = harness();
  h.api.guardarTokenTelegram(SID, BASE, '123456:abcdefghijklmnopqrstuvwxyz_ABCDE');
  h.scriptProps.set('telegram:SHEET_1:webhook', 'nonce');
  h.scriptProps.set('telegram:SHEET_1:allowedUserId', '99');
  const external = { update_id: 10, message: { chat: { id: 42, type: 'private' }, from: { id: 42 }, text: '¿Qué tareas tengo?' } };
  h.api.telegramWebhookAction({ parameter: { tg: 'nonce' }, postData: { contents: JSON.stringify(external) } }, SID, BASE);
  assert.equal(h.fetchCalls.length, 1, 'solo getMe previo; ningún sendMessage a un intruso');
  h.api.telegramWebhookAction({ parameter: { tg: 'nonce' }, postData: { contents: JSON.stringify(external) } }, SID, BASE);
  assert.equal(h.fetchCalls.length, 1, 'update duplicado no genera efectos');
});

function qaHarness(rows = []) {
  const h = makeHarness({ spreadsheets: { [SID]: {
    Ajustes: [['key', 'value']],
    Tareas: [['Tarea', 'Proyecto', 'Vence', 'Prioridad', 'Estado', 'Origen', 'Id', 'Espera de', 'Link', 'EventId', 'Creada el'], ...rows]
  } }, scriptProperties: {
    'telegram:SHEET_1:token': '123456:abcdefghijklmnopqrstuvwxyz_ABCDE',
    'telegram:SHEET_1:webhook': 'nonce',
    'telegram:SHEET_1:allowedUserId': '99',
    GEMINI_API_KEY: 'test-key'
  } });
  h.setFetch((url) => /generateContent/.test(url)
    ? httpResponse(200, geminiOk('Respuesta basada en el corpus.'))
    : httpResponse(200, JSON.stringify({ ok: true, result: true })));
  return h;
}

function ask(h, updateId, text, userId = 99) {
  return h.api.telegramWebhookAction({ parameter: { tg: 'nonce' }, postData: { contents: JSON.stringify({
    update_id: updateId, message: { chat: { id: userId, type: 'private' }, from: { id: userId }, text }
  }) } }, SID, BASE);
}

function lastTelegram(h) {
  const call = h.fetchCalls.filter((c) => /sendMessage$/.test(c.url)).at(-1);
  return JSON.parse(call.options.payload).text;
}

function wikiPage(h, folder, name, fm, body) {
  const root = h.api.ensureBrainFolder_(SID, BASE);
  h.api.escribirArchivoBrain_(h.api.carpetaBrain_(root, ['wiki', folder]), name,
    h.api.componerPagina_(fm, body));
}

test('/hoy responde directamente desde Tareas, sin Gemini, y cita la hoja', () => {
  const h = qaHarness([
    ['Enviar propuesta', 'Alpha', '2026-08-17', 'Alta', 'Pendiente', '✍️ Manual', 't1'],
    ['Terminado', 'Alpha', '2026-08-17', 'Media', 'Hecha', '✍️ Manual', 't2']
  ]);
  ask(h, 101, '/hoy');
  const text = lastTelegram(h);
  assert.match(text, /Enviar propuesta/);
  assert.doesNotMatch(text, /Terminado/);
  assert.match(text, /Fuentes: Tareas/);
  assert.equal(h.fetchCalls.filter((c) => /generateContent/.test(c.url)).length, 0);
});

test('/proyecto excluye páginas cerradas o merged, internas/raw, y pide reformulación ante coincidencias múltiples', () => {
  const h = qaHarness();
  wikiPage(h, 'projects', 'alpha-a.md', { page_type: 'project', name: 'Alpha API', status: 'active', sources: ['daily-1'] }, '# Alpha API\nEstado activo.');
  wikiPage(h, 'projects', 'alpha-b.md', { page_type: 'project', name: 'Alpha Web', status: 'active', sources: ['daily-2'] }, '# Alpha Web\nEstado activo.');
  wikiPage(h, 'projects', 'alpha-old.md', { page_type: 'project', name: 'Alpha Legacy', status: 'closed' }, 'Cerrado.');
  wikiPage(h, 'projects', 'alpha-merged.md', { page_type: 'project', name: 'Alpha Merged', status: 'merged' }, 'Fusionado.');
  wikiPage(h, 'projects', '_internal.md', { page_type: 'project', name: 'Alpha Settings', status: 'active' }, 'secret=never');
  ask(h, 102, '/proyecto alpha');
  const text = lastTelegram(h);
  assert.match(text, /Alpha API/);
  assert.match(text, /Alpha Web/);
  assert.doesNotMatch(text, /Legacy|Merged|Settings|secret/);
  assert.match(text, /reformula/i);
});

test('/bloqueos y /reunión consultan solo wiki curada, citan fuentes y mantienen contexto breve para Gemini', () => {
  const h = qaHarness();
  wikiPage(h, 'projects', 'alpha.md', { page_type: 'project', name: 'Alpha', status: 'active', open_blockers: ['Esperando legal'], sources: ['weekly-7'] }, '## Bloqueos\nEsperando legal.');
  wikiPage(h, 'meetings', 'alpha-sync.md', { page_type: 'meeting', name: 'Sync Alpha', date: '2026-08-16', sources: ['meet-9'] }, '# Sync Alpha\nDecidimos lanzar el viernes.');
  ask(h, 103, '/bloqueos');
  assert.match(lastTelegram(h), /Esperando legal/);
  assert.match(lastTelegram(h), /Fuentes:.*Alpha/);
  ask(h, 104, '/reunión alpha');
  assert.match(lastTelegram(h), /Sync Alpha/);
  assert.match(lastTelegram(h), /Fuentes:.*Sync Alpha/);
  ask(h, 105, '¿Cuál es el estado?');
  const gemini = h.fetchCalls.find((c) => /generateContent/.test(c.url));
  assert.ok(gemini, 'la pregunta natural usa Gemini');
  assert.match(JSON.parse(gemini.options.payload).contents[0].parts[0].text, /Sync Alpha/);
  assert.match(lastTelegram(h), /Fuentes:/);
});
