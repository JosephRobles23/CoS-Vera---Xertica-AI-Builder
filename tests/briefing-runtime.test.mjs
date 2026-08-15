/**
 * briefing-runtime.test.mjs — Morning Briefing + hoja Tareas.
 * Cubre: creación de la hoja (headers + dropdowns), dedup del autopoblado, orden/flags de
 * pendientes, archivado de Hechas a la pestaña Archivo, el hook desde notas de Meet (acción del
 * líder → fila, sin página de persona para él), la pasada del dispatcher (hora/días/flag/anti-dup),
 * día despejado, foco+urgente en UNA llamada (y cero llamadas si no hacen falta), validaciones de
 * guardarBriefing, preview de cargarBriefing, urgentes del brain y el ruteo dispatch/buildDialog.
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
// Jueves 2026-08-13 a las 07:30 locales = hora default del briefing; día 4 ∈ L-V default.
const NOW = new Date(2026, 7, 13, 7, 30);
const HOY = '2026-08-13';

const T_HDR = ['Tarea', 'Proyecto', 'Vence', 'Prioridad', 'Estado', 'Origen', 'Id'];
const IA = { foco: '1) Cierra Alpha con legal. 2) Destraba la carga masiva.', urgente: 'El blocker legal de Alpha ya urge.' };

function brHarness(opts = {}) {
  const h = makeHarness({
    scriptProperties: { GEMINI_API_KEY: 'K' },
    calendar: opts.calendar || [],
    spreadsheets: { SID: {
      Ajustes: [
        ['key', 'value'],
        ['leader.email', 'lider@x.com'], ['leader.name', 'Líder A'],
        ['briefing.enabled', String(opts.briefing !== false)],
        ...(opts.ajustes || [])
      ],
      Equipo: [['Nombre', 'Correo', 'Rol'], ['Ada', 'ada@x.com', 'Dev']],
      Daily: [['Marca temporal', 'Summary']],
      Weekly: [['Marca temporal', 'Summary']],
      ...(opts.tareas ? { Tareas: [T_HDR, ...opts.tareas] } : {})
    } }
  });
  h.setFetch(() => httpResponse(200, geminiOk(JSON.stringify(opts.ia || IA))));
  return h;
}

const briefings = (h) => h.sentEmails.filter((m) => m.subject.indexOf('☀️ Tu día') === 0);
const tareasDe = (h) => plain(h.api.listarTareas_('SID', h.api.construirConfig('SID', CONFIG)));

// --- Hoja Tareas ---

test('ensureTareasSheet_ crea la pestaña con encabezados y dropdowns de Estado/Prioridad', () => {
  const h = brHarness();
  const config = h.api.construirConfig('SID', CONFIG);
  const sh = h.api.ensureTareasSheet_('SID', config);

  assert.deepEqual(plain(sh.getRange(1, 1, 1, 7).getValues())[0], T_HDR);
  const listas = sh._validations.map((v) => v.rule._list);
  assert.ok(listas.some((l) => l && l.join() === 'Pendiente,En curso,Bloqueada,Hecha'), 'dropdown de Estado');
  assert.ok(listas.some((l) => l && l.join() === 'Alta,Media,Baja'), 'dropdown de Prioridad');
});

test('agregarTarea_ dedup-ea por Id (mismo texto+origen no duplica)', () => {
  const h = brHarness();
  const config = h.api.construirConfig('SID', CONFIG);
  assert.equal(h.api.agregarTarea_('SID', config, { texto: 'Validar Classroom', origen: '🎥 Daily · 2026-08-10' }), true);
  assert.equal(h.api.agregarTarea_('SID', config, { texto: 'Validar Classroom', origen: '🎥 Daily · 2026-08-10' }), false);
  assert.equal(tareasDe(h).length, 1);
});

test('tareasPendientesHoy_ excluye Hechas, marca hoy/atrasada/bloqueada y ordena', () => {
  const h = brHarness({ tareas: [
    ['Normal', '', '2026-08-20', 'Media', 'Pendiente', '', 'id1'],
    ['Para hoy', '', HOY, 'Alta', 'En curso', '', 'id2'],
    ['Atrasada', '', '2026-08-11', 'Alta', 'Bloqueada', '', 'id3'],
    ['Ya salió', '', HOY, 'Baja', 'Hecha', '', 'id4']
  ] });
  const config = h.api.construirConfig('SID', CONFIG);
  const ts = plain(h.api.tareasPendientesHoy_('SID', config, HOY));

  assert.deepEqual(ts.map((t) => t.texto), ['Atrasada', 'Para hoy', 'Normal']);
  assert.equal(ts[0].atrasada, true);
  assert.equal(ts[0].bloqueada, true);
  assert.equal(ts[1].hoy, true);
});

test('archivarHechas_ mueve las Hecha a la pestaña Archivo con fecha y limpia Tareas', () => {
  const h = brHarness({ tareas: [
    ['Viva', '', '', 'Media', 'Pendiente', '', 'id1'],
    ['Terminada', 'Alpha', '', 'Alta', 'Hecha', '✍️ Manual', 'id2']
  ] });
  const config = h.api.construirConfig('SID', CONFIG);

  assert.equal(h.api.archivarHechas_('SID', config, HOY), 1);
  assert.deepEqual(tareasDe(h).map((t) => t.texto), ['Viva']);

  const arch = h.getSpreadsheet('SID').getSheetByName('Archivo');
  const fila = plain(arch.getRange(2, 1, 1, 8).getValues())[0];
  assert.equal(fila[0], 'Terminada');
  assert.equal(fila[7], HOY, 'lleva la fecha de archivado');
});

test('la hoja lleva chips de color (formato condicional) y Vence con fecha + picker', () => {
  const h = brHarness();
  const config = h.api.construirConfig('SID', CONFIG);
  const sh = h.api.ensureTareasSheet_('SID', config);

  const reglas = sh.getConditionalFormatRules();
  const porTexto = {};
  reglas.forEach((r) => { porTexto[r._texto] = r; });
  assert.equal(reglas.length, 7, '4 estados + 3 prioridades');
  assert.equal(porTexto['Pendiente']._bg, '#FEF3C7');
  assert.equal(porTexto['Bloqueada']._fg, '#991B1B');
  assert.equal(porTexto['Hecha']._bg, '#DCFCE7');
  assert.equal(porTexto['Alta']._bg, '#EDE9FE');

  assert.ok(sh._validations.some((v) => v.col === 3 && v.rule._date), 'Vence exige fecha (activa el date-picker)');
});

test('Vence acepta la fecha como Date del picker y el briefing la interpreta bien', () => {
  const h = brHarness({ tareas: [['Con picker', '', new Date(2026, 7, 13, 0, 0), 'Alta', 'Pendiente', '', 'idD']] });
  const config = h.api.construirConfig('SID', CONFIG);
  const ts = plain(h.api.tareasPendientesHoy_('SID', config, HOY));
  assert.equal(ts[0].vence, HOY);
  assert.equal(ts[0].hoy, true);
});

test('una hoja Tareas heredada (sin formato) gana los colores en la higiene diaria del dispatcher', () => {
  // La pestaña existe con datos pero fue creada por una versión vieja: cero reglas de color.
  // La higiene ya NO vive en el briefing: corre en el dispatcher (runTareasHygiene_).
  const h = brHarness({ tareas: [['Vieja', '', '', 'Media', 'Pendiente', '', 'idV']] });
  const config = h.api.construirConfig('SID', CONFIG);
  const sh = h.getSpreadsheet('SID').getSheetByName('Tareas');
  assert.equal(sh.getConditionalFormatRules().length, 0, 'precondición: sin formato');

  h.api.runTareasHygiene_('SID', config, HOY);
  assert.equal(sh.getConditionalFormatRules().length, 7, 'la pasada re-aseguró colores');
  assert.ok(sh._validations.some((v) => v.col === 3 && v.rule._date), 'y el date-picker de Vence');
});

// --- Espejo en el brain: wiki/tasks/ ---

test('sincronizarTareasWiki_ crea la página con frontmatter y anota el historial al cambiar', () => {
  const h = brHarness({
    ajustes: [['brain.enabled', 'true']],
    tareas: [['Validar Classroom', 'Classroom', HOY, 'Alta', 'Pendiente', '🎥 Comité', 'idW']]
  });
  const config = h.api.construirConfig('SID', CONFIG);
  const root = h.api.ensureBrainFolder_('SID', config);
  const tasksDir = h.api.carpetaBrain_(root, ['wiki', 'tasks']);

  assert.equal(h.api.sincronizarTareasWiki_('SID', config, HOY), 1);
  let pg = h.api.parsearPagina_(h.api.leerArchivoBrain_(tasksDir, 'idW.md'));
  assert.equal(pg.frontmatter.page_type, 'task');
  assert.equal(pg.frontmatter.status, 'Pendiente');
  assert.equal(pg.frontmatter.due, HOY);
  assert.match(pg.body, /## Historial/);

  // Sin cambios → no re-escribe; con cambio de estado → línea de historial.
  assert.equal(h.api.sincronizarTareasWiki_('SID', config, HOY), 0);
  h.getSpreadsheet('SID').getSheetByName('Tareas').getRange(2, 5).setValue('En curso');
  assert.equal(h.api.sincronizarTareasWiki_('SID', config, '2026-08-14'), 1);
  pg = h.api.parsearPagina_(h.api.leerArchivoBrain_(tasksDir, 'idW.md'));
  assert.equal(pg.frontmatter.status, 'En curso');
  assert.match(pg.body, /- \[2026-08-14\] estado: Pendiente → En curso/);
});

test('archivar una Hecha deja su página wiki marcada archived con historial', () => {
  const h = brHarness({
    ajustes: [['brain.enabled', 'true']],
    tareas: [['Terminada', '', '', 'Baja', 'Hecha', '', 'idA']]
  });
  const config = h.api.construirConfig('SID', CONFIG);
  const root = h.api.ensureBrainFolder_('SID', config);
  h.api.sincronizarTareasWiki_('SID', config, HOY);   // página existe (status Hecha)
  h.api.archivarHechas_('SID', config, HOY);

  const pg = h.api.parsearPagina_(h.api.leerArchivoBrain_(h.api.carpetaBrain_(root, ['wiki', 'tasks']), 'idA.md'));
  assert.equal(String(pg.frontmatter.archived), 'true');
  assert.match(pg.body, new RegExp('- \\[' + HOY + '\\] archivada'));
});

test('sin brain.enabled la sincronización es un no-op silencioso', () => {
  const h = brHarness({ tareas: [['X', '', '', 'Media', 'Pendiente', '', 'idN']] });
  const config = h.api.construirConfig('SID', CONFIG);
  assert.equal(h.api.sincronizarTareasWiki_('SID', config, HOY), 0);
});

test('la pasada del briefing sincroniza el wiki antes de enviar', () => {
  const h = brHarness({
    ajustes: [['brain.enabled', 'true']],
    tareas: [['Sincronízame', '', '', 'Media', 'Pendiente', '', 'idP']]
  });
  const config = h.api.construirConfig('SID', CONFIG);
  const root = h.api.ensureBrainFolder_('SID', config);
  h.api.runDispatcher('SID', config, NOW);

  assert.equal(briefings(h).length, 1);
  assert.ok(h.api.leerArchivoBrain_(h.api.carpetaBrain_(root, ['wiki', 'tasks']), 'idP.md'),
    'la tarea quedó espejada en wiki/tasks');
});

// --- Hook desde notas de Meet: la acción del líder aterriza en Tareas ---

test('una acción del líder en notas de Meet crea fila en Tareas y NO le crea página de persona', () => {
  const inicio = new Date(NOW.getTime() - 2 * 3600000);
  const h = brHarness({ ajustes: [['brain.enabled', 'true'], ['meet.enabled', 'true']] });
  h.setFetch((url, options) => {
    if (url.indexOf('calendar/v3') > -1) {
      return httpResponse(200, JSON.stringify({ items: [{
        id: 'ev1', summary: 'Comité', start: { dateTime: inicio.toISOString() },
        attachments: [{ fileId: 'doc1', title: 'Comité - Notas de Gemini', mimeType: 'application/vnd.google-apps.document' }]
      }] }));
    }
    if (/drive\/v3\/files\/doc1\/export/.test(url)) return httpResponse(200, 'notas');
    return httpResponse(200, geminiOk(JSON.stringify({
      resumen: 'R', asistentes: [],
      eventos: [{ persona: 'Líder A', correo: 'lider@x.com', proyecto: 'Alpha', tipo: 'accion', texto: 'Aprobar presupuesto Q4', confidence: 1 }]
    })));
  });
  const config = h.api.construirConfig('SID', CONFIG);
  const root = h.api.ensureBrainFolder_('SID', config);
  h.api.runMeetPass_('SID', config, NOW, Date.now() + 300000);

  const ts = tareasDe(h);
  assert.equal(ts.length, 1);
  assert.equal(ts[0].texto, 'Aprobar presupuesto Q4');
  assert.match(ts[0].origen, /🎥 Comité/);
  assert.equal(h.api.leerArchivoBrain_(h.api.carpetaBrain_(root, ['wiki', 'people']), 'lider-x-com.md'), null,
    'el líder no lleva página de persona');
});

// --- Pasada del dispatcher ---

test('a la hora y día configurados envía el briefing completo, con anti-dup por fecha', () => {
  const h = brHarness({
    calendar: [{ id: 'ev1', title: 'Daily Sync', start: new Date(2026, 7, 13, 9, 0), guests: ['a@x.com', 'b@x.com'] }],
    tareas: [['Validar Classroom', 'Classroom', HOY, 'Alta', 'En curso', '🎥', 'id1']]
  });
  const config = h.api.construirConfig('SID', CONFIG);

  h.api.runDispatcher('SID', config, NOW);
  const mails = briefings(h);
  assert.equal(mails.length, 1);
  assert.equal(mails[0].to, 'lider@x.com');
  assert.match(mails[0].body, /09:00 Daily Sync/);
  assert.match(mails[0].body, /Validar Classroom \[hoy\]/);
  assert.match(mails[0].body, /FOCO SUGERIDO\n1\) Cierra Alpha/);
  assert.match(mails[0].html, /Tu día/);

  h.api.runDispatcher('SID', config, new Date(NOW.getTime() + 4 * 60000));
  assert.equal(briefings(h).length, 1, 'anti-dup: no se re-envía el mismo día');
});

test('no envía fuera de los días configurados ni con el flag apagado', () => {
  // Jueves (4), pero solo lunes configurado.
  const h1 = brHarness({ ajustes: [['briefing.dias', '1']] });
  h1.api.runDispatcher('SID', h1.api.construirConfig('SID', CONFIG), NOW);
  assert.equal(briefings(h1).length, 0);

  const h2 = brHarness({ briefing: false });
  h2.api.runDispatcher('SID', h2.api.construirConfig('SID', CONFIG), NOW);
  assert.equal(briefings(h2).length, 0);
});

test('día despejado: el briefing sale igual, corto y honesto', () => {
  const h = brHarness();   // sin calendario, sin tareas
  const config = h.api.construirConfig('SID', CONFIG);
  h.api.runDispatcher('SID', config, NOW);

  const mails = briefings(h);
  assert.equal(mails.length, 1);
  assert.match(mails[0].body, /Sin reuniones: día despejado\./);
  assert.match(mails[0].body, /Nada pendiente\./);
});

test('con foco apagado y sin urgentes, el briefing no gasta ninguna llamada a Gemini', () => {
  const h = brHarness({
    ajustes: [['briefing.secciones', JSON.stringify([{ id: 'dia', on: true }, { id: 'pendientes', on: true }, { id: 'urgente', on: true }, { id: 'foco', on: false }])]]
  });
  const config = h.api.construirConfig('SID', CONFIG);
  h.api.runDispatcher('SID', config, NOW);

  assert.equal(briefings(h).length, 1);
  assert.equal(h.fetchCalls.length, 0, 'cero llamadas LLM');
});

test('enviarBriefingPrueba ignora hora/día; el archivado es de la higiene diaria, no del briefing', () => {
  const h = brHarness({
    ajustes: [['briefing.dias', '1']],   // hoy NO toca…
    tareas: [['Terminada', '', '', 'Baja', 'Hecha', '', 'idH']]
  });
  const config = h.api.construirConfig('SID', CONFIG);
  const res = plain(h.api.enviarBriefingPrueba('SID', config));

  assert.equal(res.enviado, true);
  assert.equal(briefings(h).length, 1);
  assert.ok(!h.getSpreadsheet('SID').getSheetByName('Archivo'), 'el briefing ya no archiva');

  h.api.runTareasHygiene_('SID', config, HOY);
  assert.ok(h.getSpreadsheet('SID').getSheetByName('Archivo'), 'la higiene diaria sí archiva');
});

// --- Config del modal ---

test('guardarBriefing valida hora, días y secciones; cargarBriefing la devuelve con preview', () => {
  // cargarBriefing arma la preview con el RELOJ REAL: el evento debe ser de "hoy real",
  // no de una fecha fija (si no, el test solo pasa ese día).
  const hoyReal = new Date();
  const h = brHarness({ calendar: [{
    id: 'ev1', title: 'Sync', guests: [],
    start: new Date(hoyReal.getFullYear(), hoyReal.getMonth(), hoyReal.getDate(), 10, 0)
  }] });
  const config = h.api.construirConfig('SID', CONFIG);

  assert.throws(() => h.api.guardarBriefing('SID', config, { hora: '25:99', dias: [1], secciones: [{ id: 'dia', on: true }] }), /Hora inválida/);
  assert.throws(() => h.api.guardarBriefing('SID', config, { hora: '08:00', dias: [], secciones: [{ id: 'dia', on: true }] }), /al menos un día/);

  h.api.guardarBriefing('SID', config, {
    enabled: true, hora: '8:15', dias: [2, 4], prompt: 'En inglés, breve.',
    secciones: [{ id: 'foco', on: true }, { id: 'dia', on: true }, { id: 'nope', on: true }]
  });
  const cfg = plain(h.api.cargarBriefing('SID', config));
  assert.equal(cfg.hora, '08:15');
  assert.deepEqual(cfg.dias, [2, 4]);
  assert.deepEqual(cfg.secciones.map((s) => s.id), ['foco', 'dia'], 'ids desconocidos fuera, orden respetado');
  assert.equal(cfg.prompt, 'En inglés, breve.');
  assert.equal(cfg.preview.reuniones.length, 1, 'preview con datos de hoy');
});

// --- Urgentes del brain ---

test('urgentesDelBrain_ junta bloqueadas, blockers envejecidos y silencios; ignora externos', () => {
  const h = brHarness({
    ajustes: [['brain.enabled', 'true'], ['brain.silenceDays', '7']],
    tareas: [['Tarea trabada', '', '', 'Alta', 'Bloqueada', '', 'idB']]
  });
  const config = h.api.construirConfig('SID', CONFIG);
  const root = h.api.ensureBrainFolder_('SID', config);
  const people = h.api.carpetaBrain_(root, ['wiki', 'people']);
  h.api.escribirArchivoBrain_(people, 'ada-x-com.md', h.api.componerPagina_(
    { page_type: 'person', name: 'Ada', last_updated: '2026-08-01', open_blockers: ['legal'] }, 'x'));
  h.api.escribirArchivoBrain_(people, 'ext.md', h.api.componerPagina_(
    { page_type: 'person', name: 'Carol', last_updated: '2026-01-01', open_blockers: ['x'], external: true }, 'x'));

  const urg = plain(h.api.urgentesDelBrain_('SID', config, HOY));
  assert.ok(urg.some((u) => /Tarea trabada/.test(u)));
  assert.ok(urg.some((u) => /Ada arrastra 1 blocker\(s\) hace 12 días: legal/.test(u)));
  assert.ok(!urg.some((u) => /Carol/.test(u)), 'externos fuera');
});

// --- Ruteo ---

test('dispatch enruta cargar/guardar/prueba y buildDialog resuelve el modal', () => {
  const h = brHarness();
  const config = h.api.construirConfig('SID', CONFIG);

  assert.equal(plain(h.api.dispatch('cargarBriefing', [], 'SID', config)).hora, '07:30');
  h.api.dispatch('guardarBriefing', [{ enabled: true, hora: '09:00', dias: [1], secciones: [{ id: 'dia', on: true }] }], 'SID', config);
  assert.equal(plain(h.api.dispatch('cargarBriefing', [], 'SID', config)).hora, '09:00');
  assert.equal(plain(h.api.dispatch('enviarBriefingPrueba', [], 'SID', config)).enviado, true);

  assert.equal(h.api.buildDialog('briefing').titulo, 'CoS — Morning Briefing');
});

test('el sync de tareas y el archivado mantienen la sección "Tareas activas" del índice', () => {
  const h = brHarness({
    ajustes: [['brain.enabled', 'true']],
    tareas: [['Activa', '', '', 'Media', 'Pendiente', '', 'idX'], ['Lista', '', '', 'Baja', 'Hecha', '', 'idY']]
  });
  const config = h.api.construirConfig('SID', CONFIG);
  const root = h.api.ensureBrainFolder_('SID', config);

  h.api.sincronizarTareasWiki_('SID', config, HOY);
  let idx = h.api.leerArchivoBrain_(h.api.carpetaBrain_(root, ['wiki']), 'index.md');
  assert.match(idx, /## Tareas activas \(2\)/);
  assert.match(idx, /\[Activa\]\(tasks\/idX\.md\) · Pendiente/);

  h.api.archivarHechas_('SID', config, HOY);
  idx = h.api.leerArchivoBrain_(h.api.carpetaBrain_(root, ['wiki']), 'index.md');
  assert.match(idx, /## Tareas activas \(1\)/, 'la archivada salió de activas');
});
