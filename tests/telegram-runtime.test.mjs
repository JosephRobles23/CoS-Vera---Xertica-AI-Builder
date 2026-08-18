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

test('guardarUrlWebApp crea webapp.url en Ajustes, acepta solo la URL /exec y la usa como fuente explícita', () => {
  const h = harness();
  const config = plain(BASE); config.webapp.url = '';
  const url = 'https://script.google.com/a/macros/example.com/s/deployment/exec';

  const result = h.api.guardarUrlWebApp(SID, config, url);
  const rows = h.getSpreadsheet(SID).getSheetByName('Ajustes').getDataRange().getValues();
  assert.equal(result.webApp.ready, true);
  assert.equal(rows.some(([key, value]) => key === 'webapp.url' && value === url), true);
  assert.throws(() => h.api.guardarUrlWebApp(SID, config, 'https://script.google.com/macros/s/dev'), /\/exec/);
});

test('cargarTelegram expone el preflight del Web App sin revelar URL ni secretos', () => {
  const h = harness();
  const ready = plain(h.api.cargarTelegram(SID, BASE));
  assert.equal(ready.webApp.ready, true);
  assert.match(ready.webApp.message, /URL guardada/i);
  assert.ok(!JSON.stringify(ready).includes('/exec'), 'el estado visible no expone la URL del Web App');

  const missing = plain(h.api.cargarTelegram(SID, { ...BASE, webapp: {} }));
  assert.equal(missing.webApp.ready, false);
  assert.match(missing.webApp.message, /Pega la URL/i);
});

test('iniciarPairingTelegram exige un Web App de producción antes de registrar el webhook', () => {
  const h = harness();
  h.api.guardarTokenTelegram(SID, BASE, '123456:abcdefghijklmnopqrstuvwxyz_ABCDE');
  assert.throws(() => h.api.iniciarPairingTelegram(SID, { ...BASE, webapp: { url: 'https://script.google.com/macros/s/example/dev' } }), /\/exec/i);
  assert.equal(h.fetchCalls.filter((c) => /setWebhook$/.test(c.url)).length, 0);
});

test('restablecerTelegram borra secretos, webhook remoto y filas telegram.* de Ajustes sin tocar los demás ajustes', () => {
  const h = makeHarness({ spreadsheets: { [SID]: { Ajustes: [['key', 'value'], ['leader.name', 'Ada'], ['telegram.enabled', 'true'], ['telegram.botUsername', 'old_bot'], ['telegram.pairingStatus', 'connected']] } } });
  h.setFetch(() => httpResponse(200, JSON.stringify({ ok: true, result: true })));
  h.scriptProps.set('telegram:SHEET_1:token', '123456:abcdefghijklmnopqrstuvwxyz_ABCDE');
  h.scriptProps.set('telegram:SHEET_1:webhook', 'nonce');
  h.scriptProps.set('telegram:SHEET_1:allowedUserId', '99');
  h.scriptProps.set('telegram:SHEET_1:pairing', '{"nonce":"x"}');

  const out = plain(h.api.restablecerTelegram(SID, BASE));
  assert.deepEqual(out, { ok: true, removedSettings: 3 });
  assert.equal(h.scriptProps.has('telegram:SHEET_1:token'), false);
  assert.equal(h.scriptProps.has('telegram:SHEET_1:webhook'), false);
  assert.equal(h.fetchCalls.filter((c) => /deleteWebhook$/.test(c.url)).length, 1);
  const rows = h.getSpreadsheet(SID).getSheetByName('Ajustes').getDataRange().getValues();
  assert.deepEqual(rows, [['key', 'value'], ['leader.name', 'Ada']]);
});

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
  assert.deepEqual(payload.allowed_updates, ['message', 'callback_query']);
  const commands = h.fetchCalls.find((c) => /setMyCommands$/.test(c.url));
  assert.ok(commands, 'el pairing registra el menú de comandos nativo');
  assert.ok(JSON.parse(commands.options.payload).commands.some((c) => c.command === 'task'));
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

test('/hoy responde directamente desde Tareas, sin Gemini y sin exponer fuentes internas', () => {
  const h = qaHarness([
    ['Enviar propuesta', 'Alpha', '2026-08-17', 'Alta', 'Pendiente', '✍️ Manual', 't1'],
    ['Terminado', 'Alpha', '2026-08-17', 'Media', 'Hecha', '✍️ Manual', 't2']
  ]);
  ask(h, 101, '/hoy');
  const text = lastTelegram(h);
  assert.match(text, /Enviar propuesta/);
  assert.doesNotMatch(text, /Terminado/);
  assert.doesNotMatch(text, /Fuentes:/);
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

test('/bloqueos y /reunión consultan solo wiki curada, sin revelar fuentes y mantienen contexto breve para Gemini', () => {
  const h = qaHarness();
  wikiPage(h, 'projects', 'alpha.md', { page_type: 'project', name: 'Alpha', status: 'active', open_blockers: ['Esperando legal'], sources: ['weekly-7'] }, '## Bloqueos\nEsperando legal.');
  wikiPage(h, 'meetings', 'alpha-sync.md', { page_type: 'meeting', name: 'Sync Alpha', date: '2026-08-16', sources: ['meet-9'] }, '# Sync Alpha\nDecidimos lanzar el viernes.');
  ask(h, 103, '/bloqueos');
  assert.match(lastTelegram(h), /Esperando legal/);
  assert.doesNotMatch(lastTelegram(h), /Fuentes:|\.md\b/);
  ask(h, 104, '/reunión alpha');
  assert.match(lastTelegram(h), /Sync Alpha/);
  assert.doesNotMatch(lastTelegram(h), /Fuentes:|\.md\b/);
  ask(h, 105, '¿Cuál es el estado?');
  const gemini = h.fetchCalls.find((c) => /generateContent/.test(c.url));
  assert.ok(gemini, 'la pregunta natural usa Gemini');
  assert.match(JSON.parse(gemini.options.payload).contents[0].parts[0].text, /Sync Alpha/);
  assert.doesNotMatch(lastTelegram(h), /Fuentes:|\.md\b/);
});

test('Telegram renders HTML safely, oculta fuentes internas y no limita la respuesta natural a 700 tokens ni 1200 caracteres', () => {
  const h = qaHarness();
  wikiPage(h, 'projects', 'alpha.md', { page_type: 'project', name: 'Alpha', status: 'active' }, 'Estado activo.');
  const longAnswer = '**Vera**\n- Primer avance\n- Segundo avance\n\n' + 'detalle '.repeat(220) + '\nFuentes: Alpha (alpha.md)';
  h.setFetch((url) => /generateContent/.test(url)
    ? httpResponse(200, geminiOk(longAnswer))
    : httpResponse(200, JSON.stringify({ ok: true, result: true })));

  ask(h, 1060, 'Dame el estado de Alpha');
  const sent = h.fetchCalls.filter((c) => /sendMessage$/.test(c.url));
  const payload = JSON.parse(sent.at(-1).options.payload);
  assert.equal(payload.parse_mode, 'HTML');
  assert.match(payload.text, /<b>Vera<\/b>/);
  assert.match(payload.text, /• Primer avance/);
  assert.doesNotMatch(payload.text, /Fuentes:|alpha\.md/);
  assert.match(payload.text, /detalle detalle/, 'la respuesta no se trunca al límite ejecutivo anterior');
  assert.equal(JSON.parse(h.fetchCalls.find((c) => /generateContent/.test(c.url)).options.payload).generationConfig.maxOutputTokens, undefined);
});

test('Telegram se presenta, explica comandos y entiende la consulta conversacional de tareas semanales sin Gemini', () => {
  const h = qaHarness([
    ['Preparar demo', 'AI Platform', '2026-08-18', 'Media', 'Pendiente', '✍️ Manual', 't1'],
    ['Cerrar reporte', 'AI Academy', '2026-09-30', 'Media', 'Pendiente', '✍️ Manual', 't2']
  ]);
  ask(h, 106, '¿Qué eres?');
  assert.match(lastTelegram(h), /Vera|Chief of Staff AI/i);
  assert.match(lastTelegram(h), /\/task/);
  ask(h, 107, 'Dime mis tareas para esta semana');
  assert.match(lastTelegram(h), /Preparar demo/);
  assert.doesNotMatch(lastTelegram(h), /Cerrar reporte/);
  assert.equal(h.fetchCalls.filter((c) => /generateContent/.test(c.url)).length, 0);
});

test('/task propone, espera confirmación callback y crea una sola tarea con origen Telegram', () => {
  const h = qaHarness();
  h.setFetch((url) => /generateContent/.test(url)
    ? httpResponse(200, geminiOk(JSON.stringify({ texto: 'Enviar video a Carol sobre AI Platform', proyecto: 'AI Platform', persona: 'Carol', vence: '2026-08-19', prioridad: 'Media' })))
    : httpResponse(200, JSON.stringify({ ok: true, result: true })));
  ask(h, 108, '/task Envíale a Carol el video de AI Platform para mañana');
  const geminiRequest = JSON.parse(h.fetchCalls.find((c) => /generateContent/.test(c.url)).options.payload);
  assert.equal(geminiRequest.generationConfig.responseMimeType, 'application/json');
  assert.ok(geminiRequest.generationConfig.responseSchema.properties.texto);
  assert.equal(geminiRequest.generationConfig.maxOutputTokens, undefined);
  const proposed = h.fetchCalls.filter((c) => /sendMessage$/.test(c.url)).at(-1);
  const proposal = JSON.parse(proposed.options.payload);
  assert.match(proposal.text, /Propongo crear esta tarea/i);
  assert.equal(h.getSpreadsheet(SID).getSheetByName('Tareas').getLastRow(), 1, 'todavía no escribe');
  const createData = proposal.reply_markup.inline_keyboard[0][0].callback_data;
  const callback = { update_id: 109, callback_query: { id: 'cb-1', from: { id: 99 }, data: createData, message: { chat: { id: 99, type: 'private' }, message_id: 5 } } };
  h.api.telegramWebhookAction({ parameter: { tg: 'nonce' }, postData: { contents: JSON.stringify(callback) } }, SID, BASE);
  const rows = h.getSpreadsheet(SID).getSheetByName('Tareas').getDataRange().getValues();
  assert.equal(rows.length, 2);
  assert.match(rows[1][0], /Enviar video a Carol/);
  assert.match(rows[1][5], /Telegram/);
  const duplicateTap = { ...callback, update_id: 110, callback_query: { ...callback.callback_query, id: 'cb-2' } };
  h.api.telegramWebhookAction({ parameter: { tg: 'nonce' }, postData: { contents: JSON.stringify(duplicateTap) } }, SID, BASE);
  assert.equal(h.getSpreadsheet(SID).getSheetByName('Tareas').getLastRow(), 2, 'la propuesta es de un solo uso');
});
