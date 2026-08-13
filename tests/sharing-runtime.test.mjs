/**
 * sharing-runtime.test.mjs — Compartir reportes (Fase 1: correos).
 * Cubre: columna `Compartir con` en el roster (parseo + preservación en guardarEquipo),
 * guardar/cargar la matriz del modal (validación/normalización), envío individual al cierre
 * (summary del día, silencio, anti-dup, dedup contra consolidado.cc), cc del consolidado,
 * transparencia en la invitación, weekly, y el ruteo por dispatch()/buildDialog.
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

// Jueves 2026-08-13 a las 18:00 locales = hora de cierre daily por defecto ('18:00').
const CIERRE_DAILY = new Date(2026, 7, 13, 18, 0);
// Viernes 2026-08-14 a las 18:30 = cierre weekly por defecto.
const CIERRE_WEEKLY = new Date(2026, 7, 14, 18, 30);
const HOY = '2026-08-13';

const D_HDR = ['Marca temporal', 'Dirección de correo electrónico', 'Nombre', 'Correo', 'Summary'];

function shHarness(opts = {}) {
  const h = makeHarness({
    scriptProperties: { GEMINI_API_KEY: 'K' },
    spreadsheets: { SID: {
      Ajustes: [['key', 'value'], ['leader.email', 'lider@x.com'], ['leader.name', 'Líder A'], ...(opts.ajustes || [])],
      Equipo: [
        ['Nombre', 'Correo', 'Rol', 'Compartir con'],
        ['María Pérez', 'maria@x.com', 'Dev', opts.mariaComp != null ? opts.mariaComp : 'jefe2@x.com, PM@X.com'],
        ['Juan Soto', 'juan@x.com', 'QA', opts.juanComp || '']
      ],
      Daily: [D_HDR, ...(opts.daily || [])],
      Weekly: [D_HDR, ...(opts.weekly || [])]
    } }
  });
  h.setFetch(() => httpResponse(200, geminiOk('CONSOLIDADO-LLM')));
  return h;
}

const filaHoy = (correo, summary) => [new Date(2026, 7, 13, 9, 30), correo, '', correo, summary];
const compartidos = (h) => h.sentEmails.filter((m) => /^Reporte (Daily|Weekly) de /.test(m.subject));

// --- Roster: columna Compartir con ---

test('getRoster_ parsea "Compartir con" normalizando y dedup-eando', () => {
  const h = shHarness({ mariaComp: ' jefe2@x.com ; PM@X.com,, pm@x.com ' });
  const roster = plain(h.api.getRoster_('SID', 'Equipo'));
  assert.deepEqual(roster[0].compartirCon, ['jefe2@x.com', 'pm@x.com']);
  assert.deepEqual(roster[1].compartirCon, []);
});

test('guardarEquipo preserva la columna "Compartir con" al reescribir el roster', () => {
  const h = shHarness();
  const config = h.api.construirConfig('SID', CONFIG);
  h.api.guardarEquipo('SID', config, [
    { nombre: 'María P. (editada)', correo: 'maria@x.com', rol: 'Sr Dev' },
    { nombre: 'Nuevo', correo: 'nuevo@x.com', rol: '' }
  ]);
  const roster = plain(h.api.getRoster_('SID', 'Equipo'));
  assert.deepEqual(roster[0].compartirCon, ['jefe2@x.com', 'pm@x.com'], 'María conserva su compartir');
  assert.deepEqual(roster[1].compartirCon, [], 'el miembro nuevo arranca sin compartir');
});

// --- Modal: guardar / cargar ---

test('guardarCompartir escribe la columna + consolidado.cc, normaliza y quita el propio correo', () => {
  const h = shHarness({ mariaComp: '' });
  const config = h.api.construirConfig('SID', CONFIG);

  const res = plain(h.api.guardarCompartir('SID', config, {
    personas: [{ correo: 'maria@x.com', compartirCon: ['JEFE2@x.com', 'jefe2@x.com', 'maria@x.com'] }],
    consolidadoCc: ['VP@x.com']
  }));
  assert.deepEqual(res, { ok: true, personas: 1, consolidadoCc: 1 });

  const roster = plain(h.api.getRoster_('SID', 'Equipo'));
  assert.deepEqual(roster[0].compartirCon, ['jefe2@x.com'], 'normalizado, dedup y sin el propio');
  assert.deepEqual(plain(h.api.getAjustes_('SID', 'Ajustes').consolidado.cc), ['vp@x.com']);
});

test('guardarCompartir rechaza correos inválidos nombrándolos', () => {
  const h = shHarness();
  const config = h.api.construirConfig('SID', CONFIG);
  assert.throws(
    () => h.api.guardarCompartir('SID', config, { personas: [{ correo: 'maria@x.com', compartirCon: ['no-es-correo'] }], consolidadoCc: [] }),
    /Correo inválido: "no-es-correo"/
  );
});

test('cargarCompartir devuelve la matriz completa (round-trip con guardarCompartir)', () => {
  const h = shHarness({ mariaComp: '' });
  const config = h.api.construirConfig('SID', CONFIG);
  h.api.guardarCompartir('SID', config, {
    personas: [{ correo: 'juan@x.com', compartirCon: ['colead@x.com'] }],
    consolidadoCc: ['vp@x.com']
  });
  const data = plain(h.api.cargarCompartir('SID', config));
  assert.deepEqual(data.consolidadoCc, ['vp@x.com']);
  assert.deepEqual(data.personas.find((p) => p.correo === 'juan@x.com').compartirCon, ['colead@x.com']);
});

// --- Envío al cierre ---

test('al cierre daily el destinatario recibe el summary del día; anti-dup en la misma fecha', () => {
  const h = shHarness({ daily: [filaHoy('maria@x.com', 'Cerró el diseño de Alpha.')] });
  const config = h.api.construirConfig('SID', CONFIG);

  h.api.runDispatcher('SID', config, CIERRE_DAILY);
  const mails = compartidos(h);
  assert.equal(mails.length, 1);
  assert.equal(mails[0].to, 'jefe2@x.com,pm@x.com');
  assert.match(mails[0].subject, /^Reporte Daily de María Pérez — 2026-08-13/);
  assert.match(mails[0].body, /Cerró el diseño de Alpha\./);
  assert.match(mails[0].body, /Compartido por Líder A vía CoS/);
  assert.match(mails[0].html, /Cerró el diseño de Alpha\./);

  h.api.runDispatcher('SID', config, new Date(CIERRE_DAILY.getTime() + 4 * 60000));
  assert.equal(compartidos(h).length, 1, 'no se re-envía el mismo día');
});

test('si la persona no reportó, el destinatario recibe el aviso de silencio', () => {
  const h = shHarness();   // Daily vacío
  const config = h.api.construirConfig('SID', CONFIG);
  h.api.runDispatcher('SID', config, CIERRE_DAILY);

  const mails = compartidos(h);
  assert.equal(mails.length, 1);
  assert.match(mails[0].body, /María Pérez no envió su reporte daily hoy\./);
});

test('dedup: quien recibe el consolidado completo no recibe el individual', () => {
  const h = shHarness({
    daily: [filaHoy('maria@x.com', 'Avance A.')],
    ajustes: [['consolidado.cc', 'jefe2@x.com']]
  });
  const config = h.api.construirConfig('SID', CONFIG);
  h.api.runDispatcher('SID', config, CIERRE_DAILY);

  const mails = compartidos(h);
  assert.equal(mails.length, 1);
  assert.equal(mails[0].to, 'pm@x.com', 'jefe2@ salió de los destinos individuales');

  const consolidado = h.sentEmails.find((m) => /^Consolidado Diario/.test(m.subject));
  assert.equal(consolidado.cc, 'jefe2@x.com', 'y en cambio va en cc del consolidado');
});

test('si TODOS los destinos individuales ya reciben el consolidado, no sale correo individual', () => {
  const h = shHarness({
    mariaComp: 'vp@x.com',
    daily: [filaHoy('maria@x.com', 'Avance A.')],
    ajustes: [['consolidado.cc', 'vp@x.com']]
  });
  const config = h.api.construirConfig('SID', CONFIG);
  h.api.runDispatcher('SID', config, CIERRE_DAILY);
  assert.equal(compartidos(h).length, 0);
});

test('el consolidado del líder sale con cc de consolidado.cc', () => {
  const h = shHarness({
    daily: [filaHoy('juan@x.com', 'QA al día.')],
    ajustes: [['consolidado.cc', 'vp@x.com, asistente@x.com']]
  });
  const config = h.api.construirConfig('SID', CONFIG);
  h.api.runDispatcher('SID', config, CIERRE_DAILY);

  const consolidado = h.sentEmails.find((m) => /^Consolidado Diario/.test(m.subject));
  assert.equal(consolidado.to, 'lider@x.com');
  assert.equal(consolidado.cc, 'vp@x.com,asistente@x.com');
});

test('el cierre weekly (viernes) también comparte por persona', () => {
  const h = shHarness({
    weekly: [[new Date(2026, 7, 14, 10, 0), 'maria@x.com', '', 'maria@x.com', 'Semana: cerró Alpha.']]
  });
  const config = h.api.construirConfig('SID', CONFIG);
  h.api.runDispatcher('SID', config, CIERRE_WEEKLY);

  const mails = compartidos(h);
  assert.equal(mails.length, 1);
  assert.match(mails[0].subject, /^Reporte Weekly de María Pérez/);
  assert.match(mails[0].body, /Semana: cerró Alpha\./);
});

test('una persona sin "Compartir con" no genera correos individuales', () => {
  const h = shHarness({ mariaComp: '', daily: [filaHoy('maria@x.com', 'Avance A.')] });
  const config = h.api.construirConfig('SID', CONFIG);
  h.api.runDispatcher('SID', config, CIERRE_DAILY);
  assert.equal(compartidos(h).length, 0);
  assert.ok(h.sentEmails.some((m) => /^Consolidado Diario/.test(m.subject)), 'el consolidado del líder sale igual');
});

// --- Transparencia en la invitación ---

test('la invitación de una persona compartida dice a quién más llega su reporte', () => {
  const h = shHarness();
  const persona = plain(h.api.getRoster_('SID', 'Equipo'))[0];   // María con 2 destinatarios
  h.api.enviarInvitacion_('daily', persona, 'Líder A', 'https://forms.gle/x');

  const mail = h.sentEmails[0];
  assert.match(mail.body, /Transparencia: tu reporte también llega a jefe2@x\.com, pm@x\.com\./);
  assert.match(mail.html, /tu reporte también llega a jefe2@x\.com, pm@x\.com/);
});

test('la invitación de una persona SIN compartir no menciona transparencia', () => {
  const h = shHarness();
  const persona = plain(h.api.getRoster_('SID', 'Equipo'))[1];   // Juan sin destinatarios
  h.api.enviarInvitacion_('daily', persona, 'Líder A', 'https://forms.gle/x');
  assert.ok(!/también llega a/.test(h.sentEmails[0].body));
});

// --- Ruteo ---

test('dispatch enruta cargarCompartir/guardarCompartir y buildDialog resuelve el modal', () => {
  const h = shHarness({ mariaComp: '' });
  const config = h.api.construirConfig('SID', CONFIG);

  h.api.dispatch('guardarCompartir', [{ personas: [{ correo: 'maria@x.com', compartirCon: ['jefe2@x.com'] }], consolidadoCc: [] }], 'SID', config);
  const data = plain(h.api.dispatch('cargarCompartir', [], 'SID', config));
  assert.deepEqual(data.personas.find((p) => p.correo === 'maria@x.com').compartirCon, ['jefe2@x.com']);

  const d = h.api.buildDialog('compartir');
  assert.equal(d.titulo, 'CoS — Compartir reportes');
});
