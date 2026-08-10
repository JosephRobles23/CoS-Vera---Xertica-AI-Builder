/**
 * deepprep-runtime.test.mjs — Deep Prep: briefing pre-reunión (Fase 3).
 * Cubre: listar/marcar reuniones desde el sidebar, la generación end-to-end (contexto del brain →
 * Gemini → PDF de marca + correo al líder → archivo en wiki/meetings/), la anti-dup por reunión,
 * el enganche en runDispatcher y el ruteo por dispatch().
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
const PREP_JSON = { tldr: 'Aprobar el diseño de Alpha y desbloquear legal.', briefing: 'CONTEXTO\n- Alpha lista para revisión\nASISTENTES\n- Ada: en progreso, espera legal' };

// Un evento de calendario que arranca a las 10:00 del 2026-08-20 (ventana lead de 3h desde las 08:00).
const EVENTO = {
  id: 'ev-alpha',
  title: 'Revisión Alpha',
  start: new Date(2026, 7, 20, 10, 0),
  end: new Date(2026, 7, 20, 11, 0),
  location: 'Sala 2',
  description: 'Revisión del diseño',
  guests: ['ada@x.com']
};

function prepHarness(extraAjustes = [], calendar = [EVENTO]) {
  const h = makeHarness({
    scriptProperties: { GEMINI_API_KEY: 'K' },
    calendar,
    spreadsheets: { SID: {
      Ajustes: [
        ['key', 'value'],
        ['brain.enabled', 'true'],
        ['deepPrep.enabled', 'true'],
        ['leader.email', 'jefe@x.com'],
        ['leader.name', 'Jefe'],
        ...extraAjustes
      ],
      Equipo: [['Nombre', 'Correo', 'Rol']]
    } }
  });
  h.setFetch(() => httpResponse(200, geminiOk(JSON.stringify(PREP_JSON))));
  return h;
}

// Siembra en el brain una persona (con un proyecto) y la página de ese proyecto.
function sembrarContexto(h, root) {
  const people = h.api.carpetaBrain_(root, ['wiki', 'people']);
  const projects = h.api.carpetaBrain_(root, ['wiki', 'projects']);
  h.api.escribirArchivoBrain_(people, 'ada-x-com.md',
    h.api.componerPagina_({ page_type: 'person', name: 'Ada', projects: ['Proyecto Alpha'] }, 'Cerró el diseño; espera legal.'));
  h.api.escribirArchivoBrain_(projects, 'proyecto-alpha.md',
    h.api.componerPagina_({ page_type: 'project', name: 'Proyecto Alpha' }, 'Diseño en revisión final.'));
}

const ultimoUserText = (h) => JSON.parse(h.fetchCalls[h.fetchCalls.length - 1].options.payload).contents[0].parts[0].text;
const leerMeeting = (h, root, file) => h.api.leerArchivoBrain_(h.api.carpetaBrain_(root, ['wiki', 'meetings']), file);

// --- Sidebar: listar / marcar ---

test('listarReunionesProximas devuelve los eventos y marca los seleccionados', () => {
  const manana = new Date(Date.now() + 24 * 3600000);
  const ev = { id: 'ev1', title: 'Sync', start: manana, guests: ['a@x.com', 'b@x.com'] };
  const h = prepHarness([['deepPrep.selected', '["ev1"]']], [ev]);
  const config = h.api.construirConfig('SID', CONFIG);

  const lista = plain(h.api.listarReunionesProximas('SID', config, 7));
  assert.equal(lista.length, 1);
  assert.equal(lista[0].id, 'ev1');
  assert.equal(lista[0].titulo, 'Sync');
  assert.deepEqual(lista[0].asistentes, ['a@x.com', 'b@x.com']);
  assert.equal(lista[0].seleccionado, true);
});

test('listarReunionesProximas tolera un calendario vacío', () => {
  const h = prepHarness([], []);
  const config = h.api.construirConfig('SID', CONFIG);
  assert.deepEqual(plain(h.api.listarReunionesProximas('SID', config, 7)), []);
});

test('toggleReunionPrep marca y desmarca, persistiendo en Ajustes', () => {
  const h = prepHarness();
  const config = h.api.construirConfig('SID', CONFIG);

  assert.deepEqual(plain(h.api.toggleReunionPrep('SID', config, 'ev-alpha', true).selected), ['ev-alpha']);
  assert.deepEqual(plain(h.api.getAjustes_('SID', 'Ajustes').deepPrep.selected), ['ev-alpha']);

  // alterna sin argumento → lo quita
  assert.deepEqual(plain(h.api.toggleReunionPrep('SID', config, 'ev-alpha').selected), []);
  assert.deepEqual(plain(h.api.getAjustes_('SID', 'Ajustes').deepPrep.selected), []);
});

// --- Generación end-to-end ---

test('generarDeepPrep_ arma contexto del brain, manda PDF + TL;DR y archiva la reunión', () => {
  const h = prepHarness();
  const config = h.api.construirConfig('SID', CONFIG);
  const root = h.api.ensureBrainFolder_('SID', config);
  sembrarContexto(h, root);

  const res = plain(h.api.generarDeepPrep_('SID', config, 'ev-alpha'));

  // el prompt recibió el contexto del brain (persona + su proyecto)
  const userText = ultimoUserText(h);
  assert.match(userText, /Persona: Ada/);
  assert.match(userText, /Proyecto: Proyecto Alpha/);
  assert.match(userText, /Revisión Alpha/);

  // correo al líder: cuerpo = TL;DR, adjunto = PDF
  assert.equal(h.sentEmails.length, 1);
  const mail = h.sentEmails[0];
  assert.equal(mail.to, 'jefe@x.com');
  assert.match(mail.subject, /Deep Prep — Revisión Alpha/);
  assert.equal(mail.body, PREP_JSON.tldr);
  assert.equal(mail.attachments.length, 1);
  assert.equal(mail.attachments[0].getContentType(), 'application/pdf');
  assert.match(mail.attachments[0].getName(), /Revisión Alpha\.pdf$/);

  // el adjunto es el PDF de marca (masthead con wordmark embebido), distinto del cuerpo del correo
  const pdfHtml = mail.attachments[0].getDataAsString();
  assert.match(pdfHtml, /src="data:image\/png;base64,/);
  assert.match(pdfHtml, /Revisión Alpha/);
  assert.match(pdfHtml, /Briefing pre-reunión/);
  assert.notEqual(pdfHtml, mail.html);

  // archivado en wiki/meetings/ con frontmatter de reunión
  assert.equal(res.archivo, 'wiki/meetings/2026-08-20_revision-alpha.md');
  const pg = h.api.parsearPagina_(leerMeeting(h, root, '2026-08-20_revision-alpha.md'));
  assert.equal(pg.frontmatter.page_type, 'meeting');
  assert.equal(pg.frontmatter.event_id, 'ev-alpha');
  assert.deepEqual(plain(pg.frontmatter.attendees), ['ada@x.com']);
  assert.match(pg.body, /CONTEXTO/);
});

test('generarDeepPrep_ tolera un brain sin notas de los asistentes', () => {
  const h = prepHarness();
  const config = h.api.construirConfig('SID', CONFIG);
  h.api.ensureBrainFolder_('SID', config);   // sin sembrar páginas

  h.api.generarDeepPrep_('SID', config, 'ev-alpha');
  assert.match(ultimoUserText(h), /No hay notas en la memoria/);
  assert.equal(h.sentEmails.length, 1);
});

test('probarDeepPrep toma la próxima reunión y la genera (smoke del stub)', () => {
  const manana = new Date(Date.now() + 24 * 3600000);
  const ev = { id: 'ev-smoke', title: 'Sync Smoke', start: manana, end: manana, guests: ['a@x.com'] };
  const h = prepHarness([], [ev]);
  const config = h.api.construirConfig('SID', CONFIG);
  h.api.ensureBrainFolder_('SID', config);

  const res = plain(h.api.probarDeepPrep('SID', config));   // sin eventId → primera del calendario
  assert.equal(res.eventId, 'ev-smoke');
  assert.equal(h.sentEmails.length, 1);
  assert.match(h.sentEmails[0].subject, /Deep Prep — Sync Smoke/);
});

test('probarDeepPrep lanza si no hay reuniones próximas', () => {
  const h = prepHarness([], []);
  const config = h.api.construirConfig('SID', CONFIG);
  h.api.ensureBrainFolder_('SID', config);
  assert.throws(() => h.api.probarDeepPrep('SID', config), /No hay reuniones/);
});

test('parseDeepPrep_ es tolerante ante texto no-JSON', () => {
  const h = prepHarness();
  const prep = plain(h.api.parseDeepPrep_('esto no es json'));
  assert.equal(prep.briefing, 'esto no es json');
  assert.ok(prep.tldr.length > 0);
});

// --- Pasada del dispatcher (ventana lead + anti-dup) ---

test('runDeepPrepPass_ prepara solo lo que entra en la ventana lead y no repite', () => {
  const h = prepHarness([['deepPrep.selected', '["ev-alpha"]']]);
  const config = h.api.construirConfig('SID', CONFIG);
  h.api.ensureBrainFolder_('SID', config);

  // aún fuera de la ventana (faltan 5h > leadHours=3) → no prepara
  h.api.runDeepPrepPass_('SID', config, new Date(2026, 7, 20, 5, 0));
  assert.equal(h.sentEmails.length, 0);

  // dentro de la ventana (faltan 2h) → prepara una vez
  h.api.runDeepPrepPass_('SID', config, new Date(2026, 7, 20, 8, 0));
  assert.equal(h.sentEmails.length, 1);

  // segunda pasada el mismo día → anti-dup por eventId
  h.api.runDeepPrepPass_('SID', config, new Date(2026, 7, 20, 9, 0));
  assert.equal(h.sentEmails.length, 1);
});

test('runDispatcher corre la pasada de Deep Prep con los flags encendidos', () => {
  const h = prepHarness([['deepPrep.selected', '["ev-alpha"]']]);
  const config = h.api.construirConfig('SID', CONFIG);

  h.api.runDispatcher('SID', config, new Date(2026, 7, 20, 8, 0));
  assert.equal(h.sentEmails.length, 1);
  assert.match(h.sentEmails[0].subject, /Deep Prep/);
});

test('runDispatcher NO corre Deep Prep si el flag está apagado', () => {
  const h = prepHarness([['deepPrep.enabled', 'false'], ['deepPrep.selected', '["ev-alpha"]']]);
  const config = h.api.construirConfig('SID', CONFIG);
  h.api.runDispatcher('SID', config, new Date(2026, 7, 20, 8, 0));
  assert.equal(h.sentEmails.length, 0);
});

// --- Ruteo por dispatch (puente cosRun del sidebar) ---

test('dispatch enruta listarReunionesProximas y toggleReunionPrep', () => {
  const manana = new Date(Date.now() + 24 * 3600000);
  const h = prepHarness([], [{ id: 'evX', title: 'Demo', start: manana, guests: [] }]);
  const config = h.api.construirConfig('SID', CONFIG);

  const lista = plain(h.api.dispatch('listarReunionesProximas', [7], 'SID', config));
  assert.equal(lista[0].id, 'evX');

  const sel = plain(h.api.dispatch('toggleReunionPrep', ['evX', true], 'SID', config).selected);
  assert.deepEqual(sel, ['evX']);
});
