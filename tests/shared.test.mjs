/**
 * shared.test.mjs — Tests de contrato de la librería (shared/*.js).
 * Corre con: npm test  (node --test tests/)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHarness, httpResponse, geminiOk } from './gas-harness.mjs';

const base = () => makeHarness();

// --- sheets-runtime: horas ---

test('toHHMM_ normaliza AM/PM y 24h', () => {
  const { api } = base();
  assert.equal(api.toHHMM_('8:30:00 a. m.'), '08:30');
  assert.equal(api.toHHMM_('6:00:00 p. m.'), '18:00');
  assert.equal(api.toHHMM_('18:00'), '18:00');
  assert.equal(api.toHHMM_('12:00:00 a. m.'), '00:00');
  assert.equal(api.toHHMM_('12:15 p. m.'), '12:15');
  assert.equal(api.toHHMM_('sin hora'), '');
});

test('horaCoincide_ respeta la ventana [t, t+w)', () => {
  const { api } = base();
  assert.equal(api.horaCoincide_('08:30', '08:30', 5), true);
  assert.equal(api.horaCoincide_('08:30', '08:34', 5), true);
  assert.equal(api.horaCoincide_('08:30', '08:35', 5), false);  // superior exclusivo
  assert.equal(api.horaCoincide_('08:30', '08:29', 5), false);
  assert.equal(api.horaCoincide_('', '08:30', 5), false);
});

// --- summaries-runtime: pass-through genérico ---

test('extraerQA_ toma solo columnas no reservadas con valor', () => {
  const { api } = base();
  const headerMap = {
    'Marca temporal': 1,
    'Dirección de correo electrónico': 2,
    '¿Qué vas a lograr hoy?': 3,
    '¿Qué te bloquea?': 4,
    'Nombre': 5,
    'Lider': 6,
    'Summary': 7
  };
  const row = [new Date(), 'ana@x.com', 'Terminar informe', '', 'Ana', 'Mille', ''];
  const qa = api.extraerQA_(headerMap, row);
  assert.equal(qa.length, 1);  // la pregunta vacía se ignora
  assert.equal(qa[0].q, '¿Qué vas a lograr hoy?');
  assert.equal(qa[0].a, 'Terminar informe');
});

test('esReservado_ cubre los encabezados de contrato', () => {
  const { api } = base();
  ['Marca temporal', 'Dirección de correo electrónico', 'Nombre', 'Lider', 'Summary']
    .forEach((h) => assert.equal(api.esReservado_(h), true));
  assert.equal(api.esReservado_('¿Qué lograste?'), false);
});

test('tipoDeHoja_ mapea daily/weekly/null', () => {
  const { api } = base();
  const config = { sheets: { daily: 'Daily', weekly: 'Weekly' } };
  assert.equal(api.tipoDeHoja_(config, 'Daily'), 'daily');
  assert.equal(api.tipoDeHoja_(config, 'Weekly'), 'weekly');
  assert.equal(api.tipoDeHoja_(config, 'Equipo'), null);
});

// --- prompts-runtime: capas + fallback ---

test('composeSystem_ concatena soul+user+task y valida la tarea', () => {
  const { api } = base();
  const prompts = { soul: 'VOZ', user: 'CONTEXTO', taskSummaryDaily: 'TAREA' };
  const s = api.composeSystem_(prompts, 'taskSummaryDaily');
  assert.match(s, /VOZ[\s\S]*CONTEXTO[\s\S]*TAREA/);
  assert.throws(() => api.composeSystem_(prompts, 'taskInexistente'));
});

test('getPrompts_ usa defaults cuando no hay pestaña Prompts', () => {
  const h = makeHarness({ spreadsheets: { SID: { Daily: [['Marca temporal']] } } });
  const p = h.api.getPrompts_('SID', 'Prompts');
  assert.ok(p.soul && p.user && p.taskSummaryDaily && p.taskConsolidatedWeekly);
});

test('getPrompts_ sobrescribe solo las claves con valor', () => {
  const prompts = [
    ['key', 'value'],
    ['soul', 'MI VOZ PERSONALIZADA'],
    ['user', ''],                         // vacío → mantiene default
    ['task.summary.daily', 'MI TAREA DAILY']
  ];
  const h = makeHarness({ spreadsheets: { SID: { Prompts: prompts } } });
  const p = h.api.getPrompts_('SID', 'Prompts');
  assert.equal(p.soul, 'MI VOZ PERSONALIZADA');
  assert.equal(p.taskSummaryDaily, 'MI TAREA DAILY');
  assert.ok(p.user.length > 0);           // cayó al default (no quedó vacío)
});

// --- roster-runtime ---

test('getRoster_ parsea Equipo y salta filas sin correo', () => {
  const equipo = [
    ['Nombre', 'Correo', 'Rol'],
    ['Ana', 'ana@x.com', 'Dev'],
    ['SinCorreo', '', 'X'],
    ['Beto', 'beto@x.com', 'QA']
  ];
  const h = makeHarness({ spreadsheets: { SID: { Equipo: equipo } } });
  const r = h.api.getRoster_('SID', 'Equipo');
  assert.equal(r.length, 2);
  assert.equal(r[0].nombre, 'Ana');
  assert.equal(r[0].correo, 'ana@x.com');
  assert.equal(r[0].rol, 'Dev');
  assert.equal(r[1].correo, 'beto@x.com');
});

test('getRoster_ exige columna Correo', () => {
  const h = makeHarness({ spreadsheets: { SID: { Equipo: [['Nombre', 'Rol'], ['Ana', 'Dev']] } } });
  assert.throws(() => h.api.getRoster_('SID', 'Equipo'), /Correo/);
});

// --- gemini-runtime: parseo + bridge ---

test('extractGeminiText_ maneja éxito, bloqueo y vacío', () => {
  const { api } = base();
  assert.equal(api.extractGeminiText_(geminiOk('hola')), 'hola');
  assert.equal(api.extractGeminiText_(JSON.stringify({ promptFeedback: { blockReason: 'SAFETY' } })), '');
  assert.equal(api.extractGeminiText_(JSON.stringify({ candidates: [] })), '');
  assert.equal(api.extractGeminiText_('no-json'), '');
  const multi = JSON.stringify({ candidates: [{ content: { parts: [{ text: 'a' }, { text: 'b' }] } }] });
  assert.equal(api.extractGeminiText_(multi), 'ab');
});

test('callGemini_ falla rápido si no hay key', () => {
  const h = makeHarness({ scriptProperties: {} });
  assert.throws(() => h.api.callGemini_('m', 's', 'u'), /GEMINI_API_KEY/);
});

test('callGemini_ devuelve texto y pone la key en header (no en URL)', () => {
  const h = makeHarness({
    scriptProperties: { GEMINI_API_KEY: 'k' },
    fetch: () => httpResponse(200, geminiOk('RESUMEN'))
  });
  assert.equal(h.api.callGemini_('gemini-3.6-flash', 'sys', 'user'), 'RESUMEN');
  assert.equal(h.fetchCalls.length, 1);
  assert.equal(h.fetchCalls[0].options.headers['x-goog-api-key'], 'k');
  assert.ok(!h.fetchCalls[0].url.includes('k'));
});

test('callGemini_ NO envía maxOutputTokens por defecto (sin techo)', () => {
  const h = makeHarness({
    scriptProperties: { GEMINI_API_KEY: 'k' },
    fetch: () => httpResponse(200, geminiOk('OK'))
  });
  h.api.callGemini_('m', 's', 'u');
  const body = JSON.parse(h.fetchCalls[0].options.payload);
  assert.equal(body.generationConfig.maxOutputTokens, undefined);
});

test('callGemini_ incluye maxOutputTokens solo si se pide explícito', () => {
  const h = makeHarness({
    scriptProperties: { GEMINI_API_KEY: 'k' },
    fetch: () => httpResponse(200, geminiOk('OK'))
  });
  h.api.callGemini_('m', 's', 'u', { maxOutputTokens: 1234 });
  const body = JSON.parse(h.fetchCalls[0].options.payload);
  assert.equal(body.generationConfig.maxOutputTokens, 1234);
});

test('callGemini_ reintenta en 429 y luego 200', () => {
  let n = 0;
  const h = makeHarness({
    scriptProperties: { GEMINI_API_KEY: 'k' },
    fetch: () => (++n === 1 ? httpResponse(429, 'rate') : httpResponse(200, geminiOk('OK')))
  });
  assert.equal(h.api.callGemini_('m', 's', 'u'), 'OK');
  assert.equal(h.fetchCalls.length, 2);
});

test('callGemini_ NO reintenta en 400', () => {
  const h = makeHarness({
    scriptProperties: { GEMINI_API_KEY: 'k' },
    fetch: () => httpResponse(400, 'bad request')
  });
  assert.throws(() => h.api.callGemini_('m', 's', 'u'), /Gemini falló/);
  assert.equal(h.fetchCalls.length, 1);
});

test('callGemini_ falla si 200 sin texto y no reintenta', () => {
  const h = makeHarness({
    scriptProperties: { GEMINI_API_KEY: 'k' },
    fetch: () => httpResponse(200, JSON.stringify({ promptFeedback: { blockReason: 'SAFETY' } }))
  });
  assert.throws(() => h.api.callGemini_('m', 's', 'u'), /sin texto/);
  assert.equal(h.fetchCalls.length, 1);
});

// --- dispatcher-runtime: guardas ---

test('guardas anti-dup namespaced por sheetId', () => {
  const h = makeHarness();
  const { api } = h;
  assert.equal(api.yaEnviado_('S1', 'daily', 'ana@x', '2026-07-24'), false);
  api.marcarEnviado_('S1', 'daily', 'ana@x', '2026-07-24');
  assert.equal(api.yaEnviado_('S1', 'daily', 'ana@x', '2026-07-24'), true);
  assert.equal(api.yaEnviado_('S2', 'daily', 'ana@x', '2026-07-24'), false);  // otro líder no colisiona

  api.marcarEnviado_('S2', 'daily', 'beto@x', '2026-07-24');
  const borradas = api.limpiarGuardasEnvio('S1');
  assert.equal(borradas, 1);
  assert.equal(api.yaEnviado_('S1', 'daily', 'ana@x', '2026-07-24'), false);
  assert.equal(api.yaEnviado_('S2', 'daily', 'beto@x', '2026-07-24'), true);   // S2 intacto
});

// --- Integración: onFormSubmit → Summary ---

test('generarSummaryFila: crea columna, escribe Summary y es idempotente', () => {
  const daily = [
    ['Marca temporal', 'Dirección de correo electrónico', '¿Qué vas a lograr hoy?', '¿Qué te bloquea?', 'Nombre', 'Lider'],
    [new Date(), 'ana@x.com', 'Terminar informe', 'Falta acceso', 'Ana', 'Mille']
  ];
  const config = {
    sheets: { daily: 'Daily', weekly: 'Weekly', prompts: 'Prompts', roster: 'Equipo' },
    models: { perRow: 'gemini-3.6-flash' },
    options: {}
  };
  const h = makeHarness({
    spreadsheets: { SID: { Daily: daily, Equipo: [['Nombre', 'Correo', 'Rol'], ['Ana', 'ana@x.com', 'Dev']] } },
    scriptProperties: { GEMINI_API_KEY: 'k' },
    fetch: () => httpResponse(200, geminiOk('RESUMEN de Ana'))
  });

  const out = h.api.generarSummaryFila('SID', config, 'Daily', 2);
  assert.equal(out, 'RESUMEN de Ana');
  assert.equal(daily[0][6], 'Correo');           // columna de identidad creada al vuelo
  assert.equal(daily[1][6], 'ana@x.com');
  assert.equal(daily[0][7], 'Summary');          // columna creada
  assert.equal(daily[1][7], 'RESUMEN de Ana');   // valor escrito
  assert.equal(h.fetchCalls.length, 1);

  const again = h.api.generarSummaryFila('SID', config, 'Daily', 2);
  assert.equal(again, 'RESUMEN de Ana');
  assert.equal(h.fetchCalls.length, 1);           // idempotente: no re-llama a Gemini
});

// --- Identidad: el Form no la pregunta, sale del correo verificado + pestaña Equipo ---

test('buscarEnRoster_ cruza por correo sin distinguir mayúsculas', () => {
  const h = makeHarness({
    spreadsheets: { SID: { Equipo: [['Nombre', 'Correo', 'Rol'], ['Ana', 'Ana@X.com', 'Dev']] } }
  });
  assert.equal(h.api.buscarEnRoster_('SID', 'Equipo', 'ana@x.com').nombre, 'Ana');
  assert.equal(h.api.buscarEnRoster_('SID', 'Equipo', '  ANA@X.COM  ').rol, 'Dev');
  assert.equal(h.api.buscarEnRoster_('SID', 'Equipo', 'otro@x.com'), null);
  assert.equal(h.api.buscarEnRoster_('SID', 'Equipo', ''), null);
  assert.equal(h.api.buscarEnRoster_('SID', 'NoExiste', 'ana@x.com'), null);  // tolerante
});

test('generarSummaryFila rellena Nombre y Correo desde Equipo (el Form no los pide)', () => {
  const daily = [
    ['Marca temporal', 'Dirección de correo electrónico', '¿Qué vas a lograr hoy?'],
    [new Date(), 'ana@x.com', 'Terminar informe']
  ];
  const config = {
    sheets: { daily: 'Daily', weekly: 'Weekly', prompts: 'Prompts', roster: 'Equipo' },
    models: { perRow: 'm' },
    options: {}
  };
  const h = makeHarness({
    spreadsheets: { SID: { Daily: daily, Equipo: [['Nombre', 'Correo', 'Rol'], ['Ana', 'ana@x.com', 'Dev']] } },
    scriptProperties: { GEMINI_API_KEY: 'k' },
    fetch: () => httpResponse(200, geminiOk('RESUMEN'))
  });

  h.api.generarSummaryFila('SID', config, 'Daily', 2);

  assert.deepEqual(daily[0].slice(3), ['Nombre', 'Correo', 'Summary']);
  assert.equal(daily[1][3], 'Ana');
  assert.equal(daily[1][4], 'ana@x.com');

  // Nombre/Correo son de contrato: no se mandan al LLM como si fueran preguntas.
  const enviado = JSON.parse(h.fetchCalls[0].options.payload).contents[0].parts[0].text;
  assert.match(enviado, /Persona: Ana/);
  assert.match(enviado, /¿Qué vas a lograr hoy\?: Terminar informe/);
  assert.equal(/^Nombre: /m.test(enviado), false);
  assert.equal(/^Correo: /m.test(enviado), false);
});

test('respondiente fuera de Equipo: guarda el correo y deja Nombre vacío', () => {
  const daily = [
    ['Marca temporal', 'Dirección de correo electrónico', 'Avance'],
    [new Date(), 'externo@otro.com', 'algo']
  ];
  const config = {
    sheets: { daily: 'Daily', weekly: 'Weekly', prompts: 'Prompts', roster: 'Equipo' },
    models: { perRow: 'm' },
    options: {}
  };
  const h = makeHarness({
    spreadsheets: { SID: { Daily: daily, Equipo: [['Nombre', 'Correo', 'Rol'], ['Ana', 'ana@x.com', 'Dev']] } },
    scriptProperties: { GEMINI_API_KEY: 'k' },
    fetch: () => httpResponse(200, geminiOk('RESUMEN'))
  });

  h.api.generarSummaryFila('SID', config, 'Daily', 2);
  const sh = h.getSpreadsheet('SID').getSheetByName('Daily');
  assert.deepEqual(daily[0].slice(3), ['Nombre', 'Correo', 'Summary']);
  assert.equal(sh.getRange(2, 4).getValue(), '');     // Nombre vacío: no está en el equipo
  assert.equal(sh.getRange(2, 5).getValue(), 'externo@otro.com');  // pero queda trazado

  const enviado = JSON.parse(h.fetchCalls[0].options.payload).contents[0].parts[0].text;
  assert.match(enviado, /Persona: externo@otro\.com/);   // cae al correo
});

test('el consolidado cae al Correo cuando Nombre viene vacío', () => {
  const hoy = new Date();
  const daily = [
    ['Marca temporal', 'Nombre', 'Correo', 'Summary'],
    [hoy, '', 'externo@otro.com', 'hizo X'],
    [hoy, 'Ana', 'ana@x.com', 'hizo Y']
  ];
  const config = {
    sheets: { daily: 'Daily', weekly: 'Weekly', prompts: 'Prompts' },
    models: { consolidated: 'm' },
    leader: { email: 'mille@x.com', name: 'Millenny' },
    timezone: 'America/Lima',
    options: {}
  };
  const h = makeHarness({
    spreadsheets: { SID: { Daily: daily } },
    scriptProperties: { GEMINI_API_KEY: 'k' },
    fetch: () => httpResponse(200, geminiOk('CONSOLIDADO'))
  });
  const today = h.api.Utilities.formatDate(hoy, config.timezone, 'yyyy-MM-dd');
  h.api.enviarConsolidado('SID', config, 'daily', today);

  const enviado = JSON.parse(h.fetchCalls[0].options.payload).contents[0].parts[0].text;
  assert.match(enviado, /- externo@otro\.com: hizo X/);
  assert.match(enviado, /- Ana: hizo Y/);
});

test('generarSummaryFila regenera si la opción lo pide', () => {
  const daily = [
    ['Marca temporal', 'Dirección de correo electrónico', 'Avance', 'Nombre', 'Summary'],
    [new Date(), 'ana@x.com', 'algo', 'Ana', 'viejo']
  ];
  const config = {
    sheets: { daily: 'Daily', weekly: 'Weekly', prompts: 'Prompts' },
    models: { perRow: 'm' },
    options: { regenerateSummaryIfPresent: true }
  };
  const h = makeHarness({
    spreadsheets: { SID: { Daily: daily } },
    scriptProperties: { GEMINI_API_KEY: 'k' },
    fetch: () => httpResponse(200, geminiOk('nuevo'))
  });
  assert.equal(h.api.generarSummaryFila('SID', config, 'Daily', 2), 'nuevo');
  assert.equal(daily[1][4], 'nuevo');
  assert.equal(h.fetchCalls.length, 1);
});

// --- Integración: consolidado ---

test('enviarConsolidado junta summaries de HOY y envía al líder', () => {
  const hoy = new Date();
  const daily = [
    ['Marca temporal', 'Nombre', 'Lider', 'Summary'],
    [hoy, 'Ana', 'Mille', 'Ana avanzó X'],
    [new Date('2020-01-01'), 'Beto', 'Mille', 'de otro día'],
    [hoy, 'Cira', 'Mille', 'Cira bloqueada']
  ];
  const config = {
    sheets: { daily: 'Daily', weekly: 'Weekly', prompts: 'Prompts' },
    models: { consolidated: 'gemini-3.1-pro-preview' },
    leader: { email: 'mille@x.com', name: 'Millenny' },
    timezone: 'America/Lima',
    options: {}
  };
  const h = makeHarness({
    spreadsheets: { SID: { Daily: daily } },
    scriptProperties: { GEMINI_API_KEY: 'k' },
    fetch: () => httpResponse(200, geminiOk('CONSOLIDADO'))
  });
  const today = h.api.Utilities.formatDate(hoy, config.timezone, 'yyyy-MM-dd');
  const res = h.api.enviarConsolidado('SID', config, 'daily', today);

  assert.equal(res.enviado, true);
  assert.equal(res.count, 2);                       // solo las de hoy
  assert.equal(h.sentEmails.length, 1);
  assert.equal(h.sentEmails[0].to, 'mille@x.com');
  assert.match(h.sentEmails[0].subject, /Consolidado Diario/);
  assert.equal(h.sentEmails[0].body, 'CONSOLIDADO');
});

test('enviarConsolidado sin datos manda aviso (sin llamar a Gemini)', () => {
  const config = {
    sheets: { daily: 'Daily', weekly: 'Weekly', prompts: 'Prompts' },
    models: { consolidated: 'm' },
    leader: { email: 'mille@x.com', name: 'Millenny' },
    timezone: 'America/Lima',
    options: {}
  };
  const h = makeHarness({
    spreadsheets: { SID: { Weekly: [['Marca temporal', 'Nombre', 'Summary']] } },
    scriptProperties: { GEMINI_API_KEY: 'k' }
  });
  const res = h.api.enviarConsolidado('SID', config, 'weekly', '2026-07-24');
  assert.equal(res.enviado, true);
  assert.equal(h.sentEmails.length, 1);
  assert.match(h.sentEmails[0].body, /no se registraron/);
  assert.equal(h.fetchCalls.length, 0);            // no se llamó a Gemini
});

// --- Integración: dispatcher (reloj inyectado) ---

test('runDispatcher envía invitación Daily a la hora y no duplica', () => {
  const equipo = [['Nombre', 'Correo', 'Rol'], ['Ana', 'ana@x.com', 'Dev']];
  const config = {
    sheets: { daily: 'Daily', weekly: 'Weekly', roster: 'Equipo', prompts: 'Prompts' },
    forms: { dailyUrl: 'https://form/daily', weeklyUrl: 'https://form/weekly' },
    leader: { email: 'mille@x.com', name: 'Millenny' },
    schedule: { invitesDaily: '08:30', invitesWeekly: '16:00', closeDaily: '18:00', closeWeekly: '18:30' },
    models: { perRow: 'f', consolidated: 'p' },
    timezone: 'America/Lima',
    dispatchWindowMin: 5,
    options: {}
  };
  const h = makeHarness({ spreadsheets: { SID: { Equipo: equipo } } });

  const now = new Date(2026, 6, 24, 8, 32);  // 2026-07-24 (viernes) 08:32 → dentro de la ventana Daily
  h.api.runDispatcher('SID', config, now);

  assert.equal(h.sentEmails.length, 1);
  assert.equal(h.sentEmails[0].to, 'ana@x.com');
  assert.match(h.sentEmails[0].subject, /Daily/);

  h.api.runDispatcher('SID', config, now);   // misma ventana → guarda anti-dup
  assert.equal(h.sentEmails.length, 1);
});

test('runDispatcher: consolidado Diario a closeDaily y Semanal a closeWeekly (viernes)', () => {
  const d = new Date(2026, 6, 24);  // fecha base (viernes)
  const config = {
    sheets: { daily: 'Daily', weekly: 'Weekly', roster: 'Equipo', prompts: 'Prompts', settings: 'Ajustes' },
    forms: { dailyUrl: '', weeklyUrl: '' },   // sin URLs → no manda invitaciones
    leader: { email: 'm@x.com', name: 'M' },
    schedule: { invitesDaily: '08:30', invitesWeekly: '16:00', closeDaily: '18:00', closeWeekly: '18:30' },
    models: { perRow: 'f', consolidated: 'p' },
    timezone: 'America/Lima', dispatchWindowMin: 5, options: {}
  };
  const h = makeHarness({
    spreadsheets: { SID: {
      Daily:  [['Marca temporal', 'Nombre', 'Lider', 'Summary'], [d, 'Ana', 'M', 'avance diario']],
      Weekly: [['Marca temporal', 'Nombre', 'Lider', 'Summary'], [d, 'Ana', 'M', 'avance semanal']],
      Equipo: [['Nombre', 'Correo', 'Rol']]
    } },
    scriptProperties: { GEMINI_API_KEY: 'k' },
    fetch: () => httpResponse(200, geminiOk('CONS'))
  });

  h.api.runDispatcher('SID', config, new Date(2026, 6, 24, 18, 2));   // → closeDaily (18:00)
  h.api.runDispatcher('SID', config, new Date(2026, 6, 24, 18, 32));  // → closeWeekly (18:30)

  assert.equal(h.sentEmails.length, 2);
  const subjects = h.sentEmails.map(function (e) { return e.subject; }).join(' | ');
  assert.match(subjects, /Consolidado Diario/);
  assert.match(subjects, /Consolidado Semanal/);
});

// --- Correo HTML (email-runtime) ---

const emailH = () => makeHarness();

test('escapeHtml_ neutraliza marcado en el contenido dinámico', () => {
  const { api } = emailH();
  assert.equal(api.escapeHtml_('<script>alert("x")</script>'),
    '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
  assert.equal(api.escapeHtml_(null), '');
});

test('fechaLegible_ formatea ISO y tolera lo que no lo es', () => {
  const { api } = emailH();
  assert.equal(api.fechaLegible_('2026-07-27'), '27 jul 2026');
  assert.equal(api.fechaLegible_('2026-01-05'), '5 ene 2026');
  assert.equal(api.fechaLegible_('mañana'), 'mañana');
});

test('parseSecciones_ reconoce MAYÚSCULAS, markdown y viñetas', () => {
  const { api } = emailH();
  const s = api.parseSecciones_(
    'LOGROS DE HOY\n- Ana cerró el informe\n- Beto desplegó el fix\n\n' +
    '## Bloqueos activos\n* Cira espera accesos\n\n' +
    '**RIESGOS**\n1. Sin avance en la migración');

  assert.equal(s.length, 3);
  assert.equal(s[0].titulo, 'LOGROS DE HOY');
  assert.equal(s[0].lineas.length, 2);
  assert.equal(s[0].lineas[0].texto, 'Ana cerró el informe');
  assert.equal(s[0].lineas[0].esVineta, true);
  assert.equal(s[1].titulo, 'Bloqueos activos');
  assert.equal(s[2].titulo, 'RIESGOS');
  assert.equal(s[2].lineas[0].texto, 'Sin avance en la migración');
});

test('parseSecciones_ NO confunde una frase normal con encabezado', () => {
  const { api } = emailH();
  const s = api.parseSecciones_('El equipo avanzó bien hoy.\nQuedan dos pendientes.');
  assert.equal(s.length, 1);
  assert.equal(s[0].titulo, '');            // sin encabezado → sección única
  assert.equal(s[0].lineas.length, 2);
});

test('parseo TOLERANTE: texto corrido se degrada a una tarjeta, no rompe', () => {
  const { api } = emailH();
  const html = api.renderConsolidadoHtml_('daily', 'Millenny', '2026-07-27',
    'Hoy el equipo avanzó en varios frentes sin bloqueos relevantes.');

  assert.match(html, /Consolidado Diario/);
  assert.match(html, /Hoy el equipo avanzó/);
  assert.equal(/text-transform:uppercase;padding-bottom:8px/.test(html), false);  // ninguna tarjeta
});

test('renderConsolidadoHtml_ pinta una tarjeta por sección y colorea por tema', () => {
  const { api } = emailH();
  const html = api.renderConsolidadoHtml_('weekly', 'Millenny', '2026-07-27',
    'LOGROS DE LA SEMANA\n- Cerramos Q3\n\nRIESGOS\n- Migración detenida');

  assert.match(html, /Consolidado Semanal/);
  assert.match(html, /Equipo Millenny · 27 jul 2026/);
  assert.match(html, /border-left:4px solid #2e8b5a/);   // verde → logros
  assert.match(html, /border-left:4px solid #d9503b/);   // rojo  → riesgos
  assert.match(html, /<li[^>]*>Cerramos Q3<\/li>/);
});

test('el consolidado escapa el contenido del LLM', () => {
  const { api } = emailH();
  const html = api.renderConsolidadoHtml_('daily', 'M', '2026-07-27',
    'LOGROS\n- <img src=x onerror=alert(1)>');
  assert.equal(html.includes('<img src=x'), false);
  assert.match(html, /&lt;img src=x/);
});

test('enviarConsolidado manda texto plano + htmlBody', () => {
  const hoy = new Date();
  const config = {
    sheets: { daily: 'Daily', weekly: 'Weekly', prompts: 'Prompts' },
    models: { consolidated: 'm' },
    leader: { email: 'mille@x.com', name: 'Millenny' },
    timezone: 'America/Lima', options: {}
  };
  const h = makeHarness({
    spreadsheets: { SID: { Daily: [['Marca temporal', 'Nombre', 'Summary'], [hoy, 'Ana', 'avanzó']] } },
    scriptProperties: { GEMINI_API_KEY: 'k' },
    fetch: () => httpResponse(200, geminiOk('LOGROS DE HOY\n- Ana avanzó'))
  });
  const today = h.api.Utilities.formatDate(hoy, config.timezone, 'yyyy-MM-dd');
  h.api.enviarConsolidado('SID', config, 'daily', today);

  const mail = h.sentEmails[0];
  assert.match(mail.body, /LOGROS DE HOY/);            // fallback de texto plano intacto
  assert.match(mail.html, /^<!DOCTYPE html>/);
  assert.match(mail.html, /Xertica/);
});

test('la invitación lleva botón con la URL y el correo de la persona', () => {
  const h = makeHarness();
  h.api.enviarInvitacion_('daily', { nombre: 'Ana', correo: 'ana@x.com' }, 'Millenny', 'https://form/d');

  const mail = h.sentEmails[0];
  assert.match(mail.body, /https:\/\/form\/d/);        // texto plano: URL a la vista
  assert.match(mail.html, /<a href="https:\/\/form\/d"[^>]*>Llenar mi Daily<\/a>/);
  assert.match(mail.html, /background:#faf338/);       // botón en amarillo de marca
  assert.match(mail.html, /ana@x\.com/);
  assert.match(mail.html, /Hola Ana,/);
});

// --- PDF de impresión del Deep Prep (email-runtime) ---

const EVENTO_PDF = {
  titulo: 'Revisión Alpha', fecha: '2026-08-20', hora: '10:00',
  ubicacion: 'Sala 2', asistentes: ['ada@x.com', 'ben@x.com']
};

test('renderDeepPrepPdfHtml_ arma el PDF de marca: logo, hero, TL;DR y secciones', () => {
  const { api } = emailH();
  const html = api.renderDeepPrepPdfHtml_(EVENTO_PDF, 'Aprobar diseño y desbloquear legal.',
    'CONTEXTO\n- Alpha listo\nRIESGOS\n- Falta legal');

  assert.match(html, /^<!DOCTYPE html>/);
  assert.match(html, /src="data:image\/png;base64,/);      // wordmark embebido como IMAGEN
  assert.match(html, /Briefing pre-reunión/);              // eyebrow del hero
  assert.match(html, /Revisión Alpha/);                    // título de la reunión (hero)
  assert.match(html, /20 ago 2026 · 10:00/);               // metadatos formateados
  assert.match(html, /2 asistentes/);
  assert.match(html, /TL;DR/);
  assert.match(html, /Aprobar diseño y desbloquear legal\./);
  assert.match(html, /border-left:4px solid #d9503b/);     // rojo → RIESGOS (acento por tema)
  assert.match(html, />Deep Prep</);                       // etiqueta del documento en el masthead
});

test('renderDeepPrepPdfHtml_ escapa el contenido del LLM', () => {
  const { api } = emailH();
  const html = api.renderDeepPrepPdfHtml_({ titulo: 'X' },
    '<b>tl</b>', 'CONTEXTO\n- <img src=x onerror=alert(1)>');
  assert.equal(html.includes('<img src=x onerror'), false);
  assert.match(html, /&lt;img src=x/);
  assert.match(html, /&lt;b&gt;tl&lt;\/b&gt;/);
});

test('renderDeepPrepPdfHtml_ tolera un briefing vacío', () => {
  const { api } = emailH();
  const html = api.renderDeepPrepPdfHtml_({ titulo: 'Sync' }, 'ok', '');
  assert.match(html, /Sync/);
  assert.match(html, /Sin briefing disponible/);
});
