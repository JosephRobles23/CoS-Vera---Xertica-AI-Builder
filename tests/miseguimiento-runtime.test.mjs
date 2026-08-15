/**
 * miseguimiento-runtime.test.mjs — Modal "Mi seguimiento" (R1).
 * Cubre: carga (flags de urgencia, foco de Ajustes, agenda de Calendar, catálogo de proyectos y
 * degradación sin brain), Nivel 0 desde wiki/tasks (edad, historial, pospuesta ×N), mutadores
 * (crear con validaciones y dup, actualizar por Id con enums y error de fila desaparecida,
 * archivar UNA fila), espejo inmediato del wiki en cada mutación, foco manual (persistencia +
 * prioridad sobre el LLM en el briefing), higiene diaria en el dispatcher (1×/día) y el ruteo
 * dispatch/buildDialog/menú. Corre con: npm test
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
const p2 = (n) => (n < 10 ? '0' : '') + n;
const iso = (d) => d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate());
// Fechas RELATIVAS al reloj real: cargarMiSeguimiento usa new Date() (regla del harness).
const HOY = iso(new Date());
const AYER = iso(new Date(Date.now() - 86400000));
const MANANA = iso(new Date(Date.now() + 86400000));
const HACE = (dias) => iso(new Date(Date.now() - dias * 86400000));

const T_HDR = ['Tarea', 'Proyecto', 'Vence', 'Prioridad', 'Estado', 'Origen', 'Id', 'Espera de', 'Link', 'EventId'];

function msHarness(opts = {}) {
  const h = makeHarness({
    scriptProperties: { GEMINI_API_KEY: 'K' },
    calendar: opts.calendar || [],
    spreadsheets: { SID: {
      Ajustes: [
        ['key', 'value'],
        ['leader.email', 'lider@x.com'], ['leader.name', 'Líder A'],
        ...(opts.brain === false ? [] : [['brain.enabled', 'true']]),
        ...(opts.ajustes || [])
      ],
      Equipo: [['Nombre', 'Correo', 'Rol'], ['Ada', 'ada@x.com', 'Dev']],
      Daily: [['Marca temporal', 'Summary']],
      Weekly: [['Marca temporal', 'Summary']],
      ...(opts.tareas ? { Tareas: [T_HDR, ...opts.tareas] } : {})
    } }
  });
  h.setFetch(() => httpResponse(200, geminiOk('{}')));
  return h;
}
const cfg = (h) => h.api.construirConfig('SID', CONFIG);
const cargar = (h) => plain(h.api.cargarMiSeguimiento('SID', cfg(h)));
const tareaDe = (d, id) => d.tareas.find((t) => t.id === id);

// --- Carga ---

test('cargarMiSeguimiento: flags hoy/atrasada/bloqueada, foco de Ajustes y agenda de Calendar', () => {
  const hoyReal = new Date();
  const h = msHarness({
    ajustes: [['briefing.focoManual', 'Cerrar la matriz de permisos']],
    calendar: [{ id: 'ev1', title: 'Comité', guests: ['a@x.com'],
      start: new Date(hoyReal.getFullYear(), hoyReal.getMonth(), hoyReal.getDate(), 11, 0) }],
    tareas: [
      ['Atrasada', 'Alpha', AYER, 'Alta', 'Pendiente', '', 'id1'],
      ['De hoy', '', HOY, 'Media', 'En curso', '', 'id2'],
      ['Trabada', '', AYER, 'Alta', 'Bloqueada', '', 'id3'],
      ['Cerrada', '', HOY, 'Baja', 'Hecha', '', 'id4']
    ]
  });
  const d = cargar(h);

  assert.equal(d.hoy, HOY);
  assert.equal(d.brainEnabled, true);
  assert.equal(d.foco, 'Cerrar la matriz de permisos');
  assert.equal(d.agenda.length, 1);
  assert.equal(d.agenda[0].titulo, 'Comité');
  assert.match(d.agenda[0].hora, /^\d{2}:\d{2}$/);

  assert.deepEqual(
    ['id1', 'id2', 'id3', 'id4'].map((i) => { const t = tareaDe(d, i); return [t.atrasada, t.hoy, t.bloqueada]; }),
    [[true, false, false], [false, true, false], [true, false, true], [false, true, false]],
    'flags por tarea (la Hecha no cuenta como atrasada)');
});

test('cargarMiSeguimiento: catálogo canónico con brain; null (texto libre) sin brain', () => {
  const h = msHarness({ tareas: [['T', '', '', 'Media', 'Pendiente', '', 'id1']] });
  const root = h.api.ensureBrainFolder_('SID', cfg(h));
  h.api.resolverProyecto_(root, 'AI Academy');
  h.api.resolverProyecto_(root, 'Dealflow');
  assert.deepEqual(cargar(h).proyectos, ['AI Academy', 'Dealflow'], 'ordenado, mismos canónicos del enum');

  const h2 = msHarness({ brain: false, tareas: [['T', '', '', 'Media', 'Pendiente', '', 'id1']] });
  assert.equal(cargar(h2).proyectos, null, 'sin brain no hay catálogo: la UI degrada a texto libre');
});

// --- Nivel 0 desde wiki/tasks ---

test('Nivel 0: edad desde created, historial recortado y pospuesta ×N desde las re-fechas', () => {
  const h = msHarness({ tareas: [['Vieja', '', '', 'Media', 'Pendiente', '', 'idN']] });
  const config = cfg(h);
  const root = h.api.ensureBrainFolder_('SID', config);
  const dir = h.api.carpetaBrain_(root, ['wiki', 'tasks']);
  h.api.escribirArchivoBrain_(dir, 'idN.md', h.api.componerPagina_(
    { page_type: 'task', name: 'Vieja', status: 'Pendiente', created: HACE(34) },
    '# Vieja\n\n## Historial\n' +
    '- [' + HACE(34) + '] creada (Pendiente)\n' +
    '- [' + HACE(20) + '] vence: — → ' + HACE(10) + '\n' +
    '- [' + HACE(9) + '] vence: ' + HACE(10) + ' → ' + AYER + '\n'));

  const t = tareaDe(cargar(h), 'idN');
  assert.equal(t.edad, 34);
  assert.equal(t.posp, 2, 'solo las líneas de re-fecha, no la de creación');
  assert.equal(t.hist.length, 3);
  assert.match(t.hist[0], /creada/);
});

test('Nivel 0 degrada limpio: sin brain o sin página, edad null / hist vacío / posp 0', () => {
  const h = msHarness({ brain: false, tareas: [['T', '', '', 'Media', 'Pendiente', '', 'id1']] });
  const t = tareaDe(cargar(h), 'id1');
  assert.equal(t.edad, null);
  assert.deepEqual(t.hist, []);
  assert.equal(t.posp, 0);
});

// --- Mutadores ---

test('crearTarea: origen ✍️ Manual + espejo inmediato; duplicada y validaciones lanzan', () => {
  const h = msHarness({ tareas: [] });
  const config = cfg(h);
  const res = plain(h.api.crearTarea('SID', config, { texto: 'Preparar agenda', proyecto: 'Alpha', prioridad: 'Alta', vence: MANANA }));
  assert.equal(res.ok, true);

  const t = h.api.listarTareas_('SID', config)[0];
  assert.equal(t.texto, 'Preparar agenda');
  assert.equal(t.origen, '✍️ Manual');
  assert.equal(t.prioridad, 'Alta');
  assert.equal(t.vence, MANANA);

  // espejo inmediato: la página wiki nació con la creación, sin esperar el sync diario
  const root = h.api.ensureBrainFolder_('SID', config);
  const pg = h.api.leerArchivoBrain_(h.api.carpetaBrain_(root, ['wiki', 'tasks']), res.id + '.md');
  assert.ok(pg, 'página wiki creada al instante');
  assert.match(pg, /created: /);

  assert.throws(() => h.api.crearTarea('SID', config, { texto: 'Preparar agenda' }), /Ya existe/);
  assert.throws(() => h.api.crearTarea('SID', config, { texto: '' }), /Escribe/);
  assert.throws(() => h.api.crearTarea('SID', config, { texto: 'X', prioridad: 'Urgente' }), /Prioridad inválida/);
  assert.throws(() => h.api.crearTarea('SID', config, { texto: 'X', vence: '14/08/2026' }), /Fecha inválida/);
});

test('actualizarTarea: escribe la hoja, anota el historial AL INSTANTE y valida enums', () => {
  const h = msHarness({ tareas: [['Validar GCP', '', AYER, 'Media', 'En curso', '', 'idU']] });
  const config = cfg(h);
  const root = h.api.ensureBrainFolder_('SID', config);
  const dir = h.api.carpetaBrain_(root, ['wiki', 'tasks']);
  h.api.sincronizarTareasWiki_('SID', config, AYER);   // página base

  const t = plain(h.api.actualizarTarea('SID', config, 'idU', { estado: 'Bloqueada', vence: MANANA }));
  assert.equal(t.estado, 'Bloqueada');
  assert.equal(t.vence, MANANA);
  assert.equal(h.api.listarTareas_('SID', config)[0].estado, 'Bloqueada', 'la hoja quedó escrita');

  const pg = h.api.leerArchivoBrain_(dir, 'idU.md');
  assert.match(pg, /estado: En curso → Bloqueada/, 'historial inmediato, sin esperar el sync diario');
  assert.match(pg, new RegExp('vence: ' + AYER + ' → ' + MANANA));

  assert.throws(() => h.api.actualizarTarea('SID', config, 'idU', { estado: 'Terminada' }), /Estado inválido/);
  assert.throws(() => h.api.actualizarTarea('SID', config, 'idU', { prioridad: 'Máxima' }), /Prioridad inválida/);
  assert.throws(() => h.api.actualizarTarea('SID', config, 'idU', { vence: 'mañana' }), /Fecha inválida/);
});

test('actualizarTarea con Id desaparecido: error claro, jamás recrea la fila', () => {
  const h = msHarness({ tareas: [['Única', '', '', 'Media', 'Pendiente', '', 'idX']] });
  const config = cfg(h);
  assert.throws(() => h.api.actualizarTarea('SID', config, 'no-existe', { estado: 'Hecha' }), /ya no está en la hoja/);
  assert.equal(h.api.listarTareas_('SID', config).length, 1, 'la hoja quedó intacta');
});

test('archivarTarea: mueve SOLO esa fila a Archivo (cualquier estado) y las demás quedan', () => {
  const h = msHarness({ tareas: [
    ['Nació mal de una nota', '', '', 'Baja', 'Pendiente', '🎥 Comité', 'idA'],
    ['Sigue viva', '', '', 'Alta', 'En curso', '', 'idB']
  ] });
  const config = cfg(h);
  assert.deepEqual(plain(h.api.archivarTarea('SID', config, 'idA')), { ok: true });

  const vivas = h.api.listarTareas_('SID', config);
  assert.deepEqual(vivas.map((t) => t.id), ['idB'], 'solo se fue la archivada');

  const arch = h.getSpreadsheet('SID').getSheetByName('Archivo');
  const fila = arch.getRange(2, 1, 1, T_HDR.length + 1).getValues()[0];
  assert.equal(fila[0], 'Nació mal de una nota');
  assert.equal(String(fila[4]), 'Pendiente', 'se archiva SIN marcarla Hecha');
  assert.equal(String(fila[T_HDR.length]).slice(0, 10), HOY, "con 'Archivada el' = hoy");

  assert.throws(() => h.api.archivarTarea('SID', config, 'idA'), /ya no está en la hoja/);
});

// --- Foco manual ---

test('guardarFoco persiste; con foco manual el briefing lo usa y NO le pide foco al LLM', () => {
  const h = msHarness({
    ajustes: [['briefing.enabled', 'true']],
    tareas: [['Pend', '', '', 'Media', 'Pendiente', '', 'idF']]
  });
  h.api.guardarFoco('SID', cfg(h), 'Mi foco manda');
  assert.equal(cargar(h).foco, 'Mi foco manda');

  // Briefing con SOLO secciones factuales + foco: con manual no hay nada que pedirle al LLM.
  const config = cfg(h);   // reconstruye: lee briefing.focoManual recién guardado
  h.api.enviarBriefingPrueba('SID', config);
  const mail = h.sentEmails.filter((m) => m.subject.indexOf('☀️ Tu día') === 0)[0];
  assert.ok(mail, 'briefing enviado');
  assert.match(mail.body, /Mi foco manda/, 'el foco del correo es el manual');
  assert.equal(h.fetchCalls.filter((c) => c.url.indexOf('generativelanguage') > -1).length, 0,
    'cero llamadas LLM: el foco manual apaga la narrativa');

  // Borrarlo devuelve el fallback al LLM (el campo queda vacío en la carga).
  h.api.guardarFoco('SID', config, '');
  assert.equal(cargar(h).foco, '');
});

// --- Higiene diaria en el dispatcher ---

test('runDispatcher corre la higiene de Tareas 1×/día: archiva Hechas aunque el briefing esté apagado', () => {
  const h = msHarness({
    ajustes: [['briefing.enabled', 'false']],
    tareas: [['Terminada', '', '', 'Baja', 'Hecha', '', 'idH']]
  });
  const config = cfg(h);
  h.api.runDispatcher('SID', config, new Date());
  assert.ok(h.getSpreadsheet('SID').getSheetByName('Archivo'), 'archivó sin briefing');
  assert.equal(h.api.listarTareas_('SID', config).length, 0);

  // segunda pasada del mismo día: la guarda evita repetir (no truena ni duplica)
  const filas = h.getSpreadsheet('SID').getSheetByName('Archivo').getLastRow();
  h.api.runDispatcher('SID', config, new Date());
  assert.equal(h.getSpreadsheet('SID').getSheetByName('Archivo').getLastRow(), filas, 'anti-dup 1×/día');
});

// --- R3: columnas nuevas (Espera de / Link / EventId) ---

test('migración R3: una hoja vieja de 7 columnas gana los encabezados nuevos sin tocar datos', () => {
  const h = makeHarness({
    scriptProperties: { GEMINI_API_KEY: 'K' },
    spreadsheets: { SID: {
      Ajustes: [['key', 'value'], ['leader.email', 'lider@x.com']],
      Equipo: [['Nombre', 'Correo', 'Rol'], ['Ada', 'ada@x.com', 'Dev']],
      // Contrato VIEJO: solo 7 encabezados (copia pre-R3)
      Tareas: [
        ['Tarea', 'Proyecto', 'Vence', 'Prioridad', 'Estado', 'Origen', 'Id'],
        ['Vieja', 'Alpha', '', 'Media', 'Pendiente', '', 'idV']
      ]
    } }
  });
  const config = h.api.construirConfig('SID', CONFIG);
  const sh = h.api.ensureTareasSheet_('SID', config);

  assert.deepEqual(plain(sh.getRange(1, 1, 1, T_HDR.length).getValues())[0], T_HDR, 'encabezados migrados');
  const t = h.api.listarTareas_('SID', config)[0];
  assert.equal(t.texto, 'Vieja');
  assert.deepEqual([t.espera, t.link, t.eventId], ['', '', ''], 'columnas nuevas vacías, datos intactos');
  assert.equal(h.api.migrarHeadersTareas_(sh), false, 'segunda pasada: idempotente, no toca nada');
});

test('espera/link viajan por crear → hoja → wiki (waiting_on + línea de historial) → esperaDias', () => {
  const h = msHarness({ tareas: [] });
  const config = cfg(h);
  const res = plain(h.api.crearTarea('SID', config, { texto: 'Validar presupuesto', espera: 'Ada', link: 'https://doc' }));

  const t0 = h.api.listarTareas_('SID', config)[0];
  assert.equal(t0.espera, 'Ada');
  assert.equal(t0.link, 'https://doc');

  const root = h.api.ensureBrainFolder_('SID', config);
  const pg = h.api.leerArchivoBrain_(h.api.carpetaBrain_(root, ['wiki', 'tasks']), res.id + '.md');
  assert.match(pg, /waiting_on: Ada/);
  assert.match(pg, /espera de: Ada/, 'línea del historial: la fuente de los días del pill');

  const t = tareaDe(cargar(h), res.id);
  assert.equal(t.esperaDias, 0, 'esperando desde hoy');

  // soltar la espera via actualizarTarea también se anota
  h.api.actualizarTarea('SID', config, res.id, { espera: '' });
  assert.match(h.api.leerArchivoBrain_(h.api.carpetaBrain_(root, ['wiki', 'tasks']), res.id + '.md'),
    /espera de: —/);
});

// --- R2: índice _tasks.json (Tendencia) ---

test('el índice nace con el sync/mutaciones: created, hecha al completar y posp al re-fechar', () => {
  const h = msHarness({ tareas: [['Tarea X', 'Alpha', MANANA, 'Alta', 'Pendiente', '🎥 Comité', 'idT']] });
  const config = cfg(h);
  const root = h.api.ensureBrainFolder_('SID', config);
  h.api.sincronizarTareasWiki_('SID', config, HOY);

  let e = h.api.cargarIndiceTareas_(root).idT;
  assert.equal(e.created, HOY);
  assert.deepEqual([e.hecha, e.archivada, e.posp], ['', '', 0]);
  assert.equal(e.origen, '🎥 Comité');

  h.api.actualizarTarea('SID', config, 'idT', { vence: HOY });        // re-fecha → posp
  h.api.actualizarTarea('SID', config, 'idT', { estado: 'Hecha' });   // completar → hecha
  e = h.api.cargarIndiceTareas_(root).idT;
  assert.equal(e.posp, 1);
  assert.equal(e.hecha, HOY);

  h.api.archivarTarea('SID', config, 'idT');                          // archivar → archivada
  e = h.api.cargarIndiceTareas_(root).idT;
  assert.equal(e.archivada, HOY, 'sale de "abiertas" desde hoy');
});

test('cargarTendencia devuelve el índice como array y lo RECONSTRUYE si _tasks.json falta', () => {
  const h = msHarness({ tareas: [['Reconstruible', 'Alpha', '', 'Media', 'Pendiente', '', 'idR']] });
  const config = cfg(h);
  const root = h.api.ensureBrainFolder_('SID', config);
  h.api.sincronizarTareasWiki_('SID', config, AYER);
  h.api.actualizarTarea('SID', config, 'idR', { vence: MANANA });   // deja una re-fecha en el historial

  // simular _tasks.json perdido: la reconstrucción sale de las páginas (frontmatter + historial)
  h.api.escribirArchivoBrain_(h.api.carpetaBrain_(root, ['wiki', 'tasks']), '_tasks.json', 'no soy json');
  const d = plain(h.api.cargarTendencia('SID', config));
  assert.equal(d.brainEnabled, true);
  const e = d.indice.find((x) => x.id === 'idR');
  assert.equal(e.created, AYER);
  assert.equal(e.posp, 1, 'posp reconstruida del historial');
  assert.ok(h.api.cargarIndiceTareas_(root), 'el índice reconstruido quedó persistido');

  // sin brain: honesto y vacío
  const h2 = msHarness({ brain: false });
  assert.deepEqual(plain(h2.api.cargarTendencia('SID', cfg(h2))), { hoy: HOY, brainEnabled: false, indice: [] });
});

// --- Ruteo ---

test('dispatch enruta el modal y buildDialog/menú conocen miseguimiento', () => {
  const h = msHarness({ tareas: [['T', '', '', 'Media', 'Pendiente', '', 'id1']] });
  const config = cfg(h);
  const d = plain(h.api.dispatch('cargarMiSeguimiento', [], 'SID', config));
  assert.equal(d.tareas.length, 1);
  const r = plain(h.api.dispatch('crearTarea', [{ texto: 'Via dispatch' }], 'SID', config));
  assert.equal(r.ok, true);

  const dlg = h.api.buildDialog('miseguimiento');
  assert.equal(dlg.html._file, 'DialogMiSeguimiento');
  assert.match(dlg.titulo, /Mi seguimiento/);
});
