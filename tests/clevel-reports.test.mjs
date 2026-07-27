/**
 * clevel-reports.test.mjs — Tests de settings-runtime (persistencia + agregación del sidebar).
 * Corre con: npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHarness, httpResponse } from './gas-harness.mjs';

const CONFIG = {
  sheets: { daily: 'Daily', weekly: 'Weekly', roster: 'Equipo', prompts: 'Prompts', settings: 'Ajustes' },
  models: { perRow: 'gemini-3.6-flash', consolidated: 'gemini-3.1-pro-preview' },
  timezone: 'America/Lima',
  dispatchWindowMin: 5,
  options: {}
};

// Spreadsheet base mínimo (una hoja cualquiera para que exista el ID).
const fresh = () => makeHarness({ spreadsheets: { SID: { Daily: [['Marca temporal']] } } });

/**
 * Mock de FormApp para probar configurarFormulario y el acceso (publicación + respondientes).
 * `titulos` acumula el título de cada ítem agregado, para verificar QUÉ preguntas se crean.
 * `opts.soportaPublicacion=false` simula un Form antiguo (sin modelo de publicación).
 * Los forms viven en un registro por ID: openById devuelve el MISMO objeto, para poder
 * verificar la re-sincronización desde guardarEquipo.
 */
function makeFormAppMock(titulos = [], opts = {}) {
  const soporta = opts.soportaPublicacion !== false;
  const yaRecolecta = opts.yaRecolectaCorreo === true;   // simula el default "Verificado" heredado
  const registro = {};
  let idc = 0;
  const chain = () => {
    const i = {
      setTitle: (t) => { titulos.push(t); return i; },
      setChoiceValues: () => i, setBounds: () => i, setRequired: () => i
    };
    return i;
  };
  const makeForm = () => {
    const id = 'FORM' + (++idc);
    const f = {
      _publicado: false, _readers: [], _collectEmail: yaRecolecta, _setCollectEmailCalls: 0,
      addTextItem: chain, addParagraphTextItem: chain, addMultipleChoiceItem: chain,
      addCheckboxItem: chain, addListItem: chain, addScaleItem: chain,
      addDateItem: chain, addTimeItem: chain,
      getItems: () => [], deleteItem: () => {},
      collectsEmail: () => f._collectEmail,
      setCollectEmail: () => { f._collectEmail = true; f._setCollectEmailCalls++; },
      setDestination: () => {}, getId: () => id,
      getPublishedUrl: () => 'https://form/' + id, getEditUrl: () => 'https://edit/' + id,
      // --- modelo de publicación / respondientes ---
      supportsAdvancedResponderPermissions: () => soporta,
      setPublished: (v) => {
        if (!soporta) throw new Error('Form antiguo: no soporta publicación');
        f._publicado = v; return f;
      },
      isPublished: () => f._publicado,
      addPublishedReaders: (correos) => {
        if (!soporta) throw new Error('Form antiguo: no soporta respondientes');
        correos.forEach((c) => { if (!f._readers.includes(c)) f._readers.push(c); });
        return f;
      },
      getPublishedReaders: () => f._readers.slice()
    };
    registro[id] = f;
    return f;
  };
  return {
    create: makeForm,
    openById: (id) => registro[id] || makeForm(),
    _registro: registro,
    DestinationType: { SPREADSHEET: 'SPREADSHEET' }
  };
}

test('getAjustes_ devuelve defaults cuando no hay pestaña Ajustes', () => {
  const h = fresh();
  const aj = h.api.getAjustes_('SID', 'Ajustes');
  assert.equal(aj.schedule.invitesDaily, '08:30');
  assert.equal(aj.schedule.closeDaily, '18:00');
  assert.equal(aj.schedule.closeWeekly, '18:30');
  assert.equal(aj.timezone, 'America/Lima');
  assert.equal(aj.leader.email, '');
});

test('setAjustes_ / getAjustes_ roundtrip', () => {
  const h = fresh();
  h.api.setAjustes_('SID', 'Ajustes', { 'leader.email': 'mille@x.com', 'schedule.closeDaily': '19:00' });
  const aj = h.api.getAjustes_('SID', 'Ajustes');
  assert.equal(aj.leader.email, 'mille@x.com');
  assert.equal(aj.schedule.closeDaily, '19:00');
  assert.equal(aj.schedule.invitesDaily, '08:30');  // no tocado → default
});

test('getAjustes_ normaliza horas guardadas como Date (coerción de Sheets)', () => {
  // Sheets convierte "22:05" en un valor de hora → getValues devuelve un Date de 1899.
  const ajustes = [['key', 'value'], ['schedule.invitesDaily', new Date(1899, 11, 30, 22, 5, 0)]];
  const h = makeHarness({ spreadsheets: { SID: { Ajustes: ajustes } } });
  const aj = h.api.getAjustes_('SID', 'Ajustes');
  assert.equal(aj.schedule.invitesDaily, '22:05');   // normalizado, no un Date en texto
});

test('construirConfig mezcla estático + Ajustes', () => {
  const h = fresh();
  h.api.setAjustes_('SID', 'Ajustes', { 'leader.email': 'mille@x.com', 'leader.name': 'Millenny', 'timezone': 'America/Mexico_City' });
  const full = h.api.construirConfig('SID', CONFIG);
  assert.equal(full.timezone, 'America/Mexico_City');   // timezone editable por líder
  assert.equal(full.sheets, CONFIG.sheets);          // mismo objeto estático
  assert.equal(full.models, CONFIG.models);
  assert.equal(full.leader.email, 'mille@x.com');
  assert.equal(full.leader.name, 'Millenny');
  assert.equal(full.schedule.invitesDaily, '08:30');
});

test('guardarHorarios normaliza a HH:mm, persiste cierres separados y timezone', () => {
  const h = fresh();
  h.api.guardarHorarios('SID', CONFIG, {
    invitesDaily: '9:00:00 a. m.', invitesWeekly: '5:00:00 p. m.',
    closeDaily: '18:30', closeWeekly: '7:15:00 p. m.', timezone: 'America/Bogota'
  });
  const aj = h.api.getAjustes_('SID', 'Ajustes');
  assert.equal(aj.schedule.invitesDaily, '09:00');
  assert.equal(aj.schedule.invitesWeekly, '17:00');
  assert.equal(aj.schedule.closeDaily, '18:30');
  assert.equal(aj.schedule.closeWeekly, '19:15');
  assert.equal(aj.timezone, 'America/Bogota');
});

test('guardarLeader persiste el líder', () => {
  const h = fresh();
  h.api.guardarLeader('SID', CONFIG, { email: 'mille@x.com', name: 'Millenny' });
  const aj = h.api.getAjustes_('SID', 'Ajustes');
  assert.equal(aj.leader.email, 'mille@x.com');
  assert.equal(aj.leader.name, 'Millenny');
});

test('guardarEquipo sobrescribe la pestaña Equipo', () => {
  const h = fresh();
  h.api.guardarEquipo('SID', CONFIG, [
    { nombre: 'Ana', correo: 'ana@x.com', rol: 'Dev' },
    { nombre: 'Beto', correo: 'beto@x.com', rol: 'QA' }
  ]);
  let r = h.api.getRoster_('SID', 'Equipo');
  assert.equal(r.length, 2);

  h.api.guardarEquipo('SID', CONFIG, [{ nombre: 'Cira', correo: 'cira@x.com', rol: 'PM' }]);
  r = h.api.getRoster_('SID', 'Equipo');
  assert.equal(r.length, 1);               // sobrescribió, no acumuló
  assert.equal(r[0].correo, 'cira@x.com');
});

test('guardarPrompts persiste y getPrompts_ lo refleja', () => {
  const h = fresh();
  h.api.guardarPrompts('SID', CONFIG, { soul: 'MI VOZ', taskSummaryDaily: 'MI TAREA' });
  const p = h.api.getPrompts_('SID', 'Prompts');
  assert.equal(p.soul, 'MI VOZ');
  assert.equal(p.taskSummaryDaily, 'MI TAREA');
  assert.ok(p.user.length > 0);            // no tocado → default
});

test('parseQuestions_ cae a defaults con vacío o JSON inválido', () => {
  const h = fresh();
  assert.equal(h.api.parseQuestions_('', 'daily').length, 3);
  assert.equal(h.api.parseQuestions_('no-json', 'weekly').length, 5);
  const parsed = h.api.parseQuestions_('[{"tipo":"texto","titulo":"X"}]', 'daily');
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].titulo, 'X');
});

test('cargarConfig en copia nueva: prompts crudos vacíos + defaults presentes', () => {
  const h = fresh();
  const cfg = h.api.cargarConfig('SID', CONFIG);
  assert.equal(cfg.prompts.soul, '');                 // sin personalizar → value vacío
  assert.ok(cfg.promptDefaults.soul.length > 0);       // default para el placeholder
  assert.ok(cfg.promptDefaults.taskConsolidatedWeekly.length > 0);
  assert.equal(cfg.equipo.length, 0);
  assert.equal(cfg.horarios.invitesDaily, '08:30');
  assert.equal(cfg.horarios.closeWeekly, '18:30');
  assert.equal(cfg.timezone, 'America/Lima');
  assert.equal(cfg.leader.email, '');
  assert.equal(cfg.preguntas.daily.length, 3);
  assert.equal(cfg.preguntas.weekly.length, 5);
});

test('getPromptsRaw_ devuelve solo lo guardado; getDefaultPrompts_ trae los 6 defaults', () => {
  const h = fresh();
  let raw = h.api.getPromptsRaw_('SID', 'Prompts');
  assert.equal(raw.soul, '');                          // nada guardado aún
  h.api.guardarPrompts('SID', CONFIG, { soul: 'VOZ' });
  raw = h.api.getPromptsRaw_('SID', 'Prompts');
  assert.equal(raw.soul, 'VOZ');
  assert.equal(raw.user, '');                          // no tocado → sigue vacío en crudo
  const def = h.api.getDefaultPrompts_();
  assert.equal(Object.keys(def).length, 6);
  assert.ok(def.soul.length > 0);
});

test('cargarConfig refleja lo guardado', () => {
  const h = fresh();
  h.api.guardarEquipo('SID', CONFIG, [{ nombre: 'Ana', correo: 'ana@x.com', rol: 'Dev' }]);
  h.api.guardarPrompts('SID', CONFIG, { soul: 'VOZ X' });
  h.api.guardarHorarios('SID', CONFIG, { invitesDaily: '07:45', invitesWeekly: '16:00', closeDaily: '18:00', closeWeekly: '18:30', timezone: 'America/Santiago' });
  const cfg = h.api.cargarConfig('SID', CONFIG);
  assert.equal(cfg.equipo.length, 1);
  assert.equal(cfg.equipo[0].correo, 'ana@x.com');
  assert.equal(cfg.prompts.soul, 'VOZ X');
  assert.equal(cfg.horarios.invitesDaily, '07:45');
  assert.equal(cfg.horarios.closeWeekly, '18:30');
  assert.equal(cfg.timezone, 'America/Santiago');
});

test('estilizarPestanas aplica formato sin romper (idempotente)', () => {
  const h = fresh();
  h.api.guardarEquipo('SID', CONFIG, [{ nombre: 'Ana', correo: 'ana@x.com', rol: 'Dev' }]);
  h.api.guardarPrompts('SID', CONFIG, { soul: 'x' });   // crea Prompts
  h.api.setAjustes_('SID', 'Ajustes', { 'leader.name': 'M' }); // crea Ajustes
  const r = h.api.estilizarPestanas('SID', CONFIG);
  assert.equal(r.ok, true);
  // el equipo sigue legible tras el formato
  assert.equal(h.api.getRoster_('SID', 'Equipo').length, 1);
});

test('configurarFormulario genera el Form y persiste URL + preguntas', () => {
  const h = makeHarness({
    spreadsheets: { SID: { Daily: [['Marca temporal']] } },
    FormApp: makeFormAppMock(),
    fetch: () => httpResponse(200, '{}')          // batchUpdate del correo verificado
  });
  const preguntas = [{ tipo: 'texto', titulo: '¿Avance?' }];
  const url = h.api.configurarFormulario('daily', preguntas, 'SID', CONFIG);
  assert.match(url, /^https:\/\/form\//);

  const aj = h.api.getAjustes_('SID', 'Ajustes');
  assert.equal(aj.forms.dailyUrl, url);
  assert.ok(aj.forms.dailyFormId);
  const savedQs = JSON.parse(aj.questions.daily);
  assert.equal(savedQs[0].titulo, '¿Avance?');
});

test('el Form solo lleva las preguntas del líder: sin casilla Nombre ni Correo', () => {
  const titulos = [];
  const h = makeHarness({
    spreadsheets: { SID: { Daily: [['Marca temporal']] } },
    FormApp: makeFormAppMock(titulos),
    fetch: () => httpResponse(200, '{}')
  });
  h.api.configurarFormulario('daily', [{ tipo: 'parrafo', titulo: '¿Qué vas a lograr hoy?' }], 'SID', CONFIG);

  assert.deepEqual(titulos, ['¿Qué vas a lograr hoy?']);   // nada de 'Nombre'
  assert.equal(titulos.includes('Nombre'), false);
  assert.equal(titulos.includes('Correo'), false);
});

test('setCorreoVerificado_ pide emailCollectionType=VERIFIED a la Forms API', () => {
  const h = makeHarness({
    spreadsheets: { SID: { Daily: [['Marca temporal']] } },
    FormApp: makeFormAppMock(),
    fetch: () => httpResponse(200, '{}')
  });
  h.api.configurarFormulario('daily', [{ tipo: 'texto', titulo: 'X' }], 'SID', CONFIG);

  const call = h.fetchCalls.find((c) => c.url.includes('forms.googleapis.com'));
  assert.ok(call, 'debió llamar a la Forms API');
  assert.match(call.url, /:batchUpdate$/);
  assert.equal(call.options.headers.Authorization, 'Bearer TEST_OAUTH_TOKEN');
  const body = JSON.parse(call.options.payload);
  assert.equal(body.requests[0].updateSettings.settings.emailCollectionType, 'VERIFIED');
  assert.equal(body.requests[0].updateSettings.updateMask, 'emailCollectionType');
});

// --- Acceso: publicación + respondientes desde `Equipo` ---

test('al generar el Form: lo publica y da acceso al Equipo (no como editores)', () => {
  const FormAppMock = makeFormAppMock();
  const h = makeHarness({
    spreadsheets: {
      SID: {
        Daily: [['Marca temporal']],
        Equipo: [['Nombre', 'Correo', 'Rol'], ['Ana', 'ana@x.com', 'Dev'], ['Beto', 'beto@x.com', 'QA']]
      }
    },
    FormApp: FormAppMock,
    fetch: () => httpResponse(200, '{}')
  });
  h.api.configurarFormulario('daily', [{ tipo: 'texto', titulo: 'X' }], 'SID', CONFIG);

  const form = FormAppMock._registro['FORM1'];
  assert.equal(form.isPublished(), true);
  assert.deepEqual(form.getPublishedReaders(), ['ana@x.com', 'beto@x.com']);
});

test('guardarEquipo re-sincroniza el acceso de los Forms ya generados', () => {
  const FormAppMock = makeFormAppMock();
  const h = makeHarness({
    spreadsheets: { SID: { Daily: [['Marca temporal']], Equipo: [['Nombre', 'Correo', 'Rol'], ['Ana', 'ana@x.com', 'Dev']] } },
    FormApp: FormAppMock,
    fetch: () => httpResponse(200, '{}')
  });
  h.api.configurarFormulario('daily', [{ tipo: 'texto', titulo: 'X' }], 'SID', CONFIG);
  const form = FormAppMock._registro['FORM1'];
  assert.deepEqual(form.getPublishedReaders(), ['ana@x.com']);

  // Entra alguien nuevo DESPUÉS de generar el Form: no debería quedarse sin acceso.
  const res = h.api.guardarEquipo('SID', CONFIG, [
    { nombre: 'Ana', correo: 'ana@x.com', rol: 'Dev' },
    { nombre: 'Cira', correo: 'cira@x.com', rol: 'PM' }
  ]);
  assert.deepEqual(form.getPublishedReaders(), ['ana@x.com', 'cira@x.com']);
  assert.equal(res.acceso.daily.responders, 2);
  assert.equal(res.acceso.weekly, null);          // Weekly no generado aún
});

test('guardarEquipo NO quita acceso a quien sale del equipo', () => {
  const FormAppMock = makeFormAppMock();
  const h = makeHarness({
    spreadsheets: { SID: { Daily: [['Marca temporal']], Equipo: [['Nombre', 'Correo', 'Rol'], ['Ana', 'ana@x.com', 'Dev']] } },
    FormApp: FormAppMock,
    fetch: () => httpResponse(200, '{}')
  });
  h.api.configurarFormulario('daily', [{ tipo: 'texto', titulo: 'X' }], 'SID', CONFIG);

  h.api.guardarEquipo('SID', CONFIG, [{ nombre: 'Cira', correo: 'cira@x.com', rol: 'PM' }]);
  // Ana sigue teniendo acceso: quitarlo es una decisión destructiva, se deja manual.
  assert.deepEqual(FormAppMock._registro['FORM1'].getPublishedReaders(), ['ana@x.com', 'cira@x.com']);
});

test('Form antiguo (sin modelo de publicación): no se toca y no rompe', () => {
  const FormAppMock = makeFormAppMock([], { soportaPublicacion: false });
  const h = makeHarness({
    spreadsheets: { SID: { Daily: [['Marca temporal']], Equipo: [['Nombre', 'Correo', 'Rol'], ['Ana', 'ana@x.com', 'Dev']] } },
    FormApp: FormAppMock,
    fetch: () => httpResponse(200, '{}')
  });
  const url = h.api.configurarFormulario('daily', [{ tipo: 'texto', titulo: 'X' }], 'SID', CONFIG);
  assert.match(url, /^https:\/\/form\//);          // se generó igual
  assert.equal(FormAppMock._registro['FORM1'].isPublished(), false);
  assert.deepEqual(FormAppMock._registro['FORM1'].getPublishedReaders(), []);
});

test('sin pestaña Equipo: publica el Form igual y no falla', () => {
  const FormAppMock = makeFormAppMock();
  const h = makeHarness({
    spreadsheets: { SID: { Daily: [['Marca temporal']] } },   // sin Equipo
    FormApp: FormAppMock,
    fetch: () => httpResponse(200, '{}')
  });
  h.api.configurarFormulario('daily', [{ tipo: 'texto', titulo: 'X' }], 'SID', CONFIG);
  const form = FormAppMock._registro['FORM1'];
  assert.equal(form.isPublished(), true);          // publicado aunque no haya a quién invitar
  assert.deepEqual(form.getPublishedReaders(), []);
});

test('si el Form ya recolecta correo (default del líder), NO se degrada el modo', () => {
  const FormAppMock = makeFormAppMock([], { yaRecolectaCorreo: true });
  const h = makeHarness({
    spreadsheets: { SID: { Daily: [['Marca temporal']] } },
    FormApp: FormAppMock,
    fetch: () => httpResponse(403, 'Forms API has not been used in project')
  });
  h.api.configurarFormulario('daily', [{ tipo: 'texto', titulo: 'X' }], 'SID', CONFIG);

  // setCollectEmail(true) pone modo "entrada del encuestado": llamarlo aquí degradaría un
  // Form que ya venía en "Verificado" por la Configuración predeterminada del líder.
  assert.equal(FormAppMock._registro['FORM1']._setCollectEmailCalls, 0);
});

test('si el Form NO recolecta correo, se activa la recolección', () => {
  const FormAppMock = makeFormAppMock();
  const h = makeHarness({
    spreadsheets: { SID: { Daily: [['Marca temporal']] } },
    FormApp: FormAppMock,
    fetch: () => httpResponse(200, '{}')
  });
  h.api.configurarFormulario('daily', [{ tipo: 'texto', titulo: 'X' }], 'SID', CONFIG);
  assert.equal(FormAppMock._registro['FORM1']._setCollectEmailCalls, 1);
  assert.equal(FormAppMock._registro['FORM1'].collectsEmail(), true);
});

test('si la Forms API falla, el Form igual se genera (best-effort)', () => {
  const h = makeHarness({
    spreadsheets: { SID: { Daily: [['Marca temporal']] } },
    FormApp: makeFormAppMock(),
    fetch: () => httpResponse(403, 'Forms API has not been used in project')
  });
  const url = h.api.configurarFormulario('daily', [{ tipo: 'texto', titulo: 'X' }], 'SID', CONFIG);
  assert.match(url, /^https:\/\/form\//);              // no rompió
  assert.ok(h.logs.some((l) => String(l[0]).includes('VERIFICADO')));
});
