/**
 * seguimiento-runtime.test.mjs — Modal "Seguimiento del equipo" (Release 1).
 * Cubre: salud por persona (umbrales de silenceDays + silence_flagged), cumplimiento prorrateado
 * y racha en días hábiles, pendientes por ventana con la gramática de sufijos, blockers con edad,
 * timeline (people+projects, orden, ventana), externos excluidos, actividad del brain desde la
 * cola del log, degradación sin brain, resolver/descartar/reabrir (Fase 2a) y el ruteo dispatch.
 * OJO: cargarSeguimiento usa reloj real → todas las fechas se siembran RELATIVAS a hoy.
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
const p2 = (n) => (n < 10 ? '0' : '') + n;
const isoLocal = (d) => d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate());
const HOY = isoLocal(new Date());
const isoDiasAtras = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return isoLocal(d); };
const dateDe = (iso) => new Date(iso + 'T10:00:00');   // local, media mañana (lejos de bordes)
const esHabil = (iso) => { const dw = new Date(iso + 'T00:00:00Z').getUTCDay(); return dw >= 1 && dw <= 5; };
// Los últimos k días hábiles (hoy incluido si es hábil), del más reciente al más viejo.
function habilesAtras(k) {
  const out = []; let n = 0;
  while (out.length < k) { const iso = isoDiasAtras(n); if (esHabil(iso)) out.push(iso); n++; }
  return out;
}
function habilesEntre(desdeIso, hastaIso) {
  let c = 0;
  for (let n = 0; ; n++) {
    const iso = isoDiasAtras(n);
    if (iso > hastaIso) continue;
    if (iso < desdeIso) break;
    if (esHabil(iso)) c++;
  }
  return c;
}

function segHarness(opts = {}) {
  const h = makeHarness({
    scriptProperties: { GEMINI_API_KEY: 'K' },
    spreadsheets: { SID: {
      Ajustes: [
        ['key', 'value'],
        ['brain.enabled', String(opts.brain !== false)],
        ['leader.email', 'lider@x.com'], ['leader.name', 'Líder A'],
        ...(opts.ajustes || [])
      ],
      Equipo: [['Nombre', 'Correo', 'Rol'],
        ['Ada Lovelace', 'ada@x.com', 'Eng'], ['Julio Toloza', 'julio@x.com', 'Dev'], ['Ana Ruiz', 'ana@x.com', 'Ds']],
      Daily: [['Marca temporal', 'Correo', 'Summary'], ...(opts.daily || [])],
      Weekly: [['Marca temporal', 'Correo', 'Summary']],
      ...(opts.tareas ? { Tareas: [['Tarea', 'Proyecto', 'Vence', 'Prioridad', 'Estado', 'Origen', 'Id'], ...opts.tareas] } : {})
    } }
  });
  h.setFetch(() => httpResponse(200, geminiOk('X')));
  return h;
}

function ponerPersona(h, root, file, fm, body) {
  h.api.escribirArchivoBrain_(h.api.carpetaBrain_(root, ['wiki', 'people']), file,
    h.api.componerPagina_(fm, body || ''));
}
const cargar = (h, dias) => plain(h.api.cargarSeguimiento('SID', h.api.construirConfig('SID', CONFIG), dias || 7));
const personaDe = (data, nombre) => data.personas.find((p) => p.nombre === nombre);

// --- Salud ---

test('salud por persona: verde/ámbar/rojo según silenceDays, ordenadas por severidad', () => {
  const h = segHarness();
  const config = h.api.construirConfig('SID', CONFIG);
  const root = h.api.ensureBrainFolder_('SID', config);
  ponerPersona(h, root, 'ada-x-com.md', { page_type: 'person', name: 'Ada Lovelace', email: 'ada@x.com', last_updated: HOY }, '');
  ponerPersona(h, root, 'julio-x-com.md', { page_type: 'person', name: 'Julio Toloza', email: 'julio@x.com', last_updated: isoDiasAtras(4) }, '');
  ponerPersona(h, root, 'ana-x-com.md', { page_type: 'person', name: 'Ana Ruiz', email: 'ana@x.com', last_updated: isoDiasAtras(9) }, '');

  const data = cargar(h);
  assert.equal(personaDe(data, 'Ada Lovelace').salud, 'ok');
  assert.equal(personaDe(data, 'Julio Toloza').salud, 'warn');    // 4 ≥ ceil(7/2)
  assert.equal(personaDe(data, 'Ana Ruiz').salud, 'bad');         // 9 ≥ 7
  assert.deepEqual(data.personas.map((p) => p.salud), ['bad', 'warn', 'ok'], 'rojo → ámbar → verde');
});

test('silence_flagged vigente fuerza rojo aunque los días no superen el umbral', () => {
  const h = segHarness();
  const config = h.api.construirConfig('SID', CONFIG);
  const root = h.api.ensureBrainFolder_('SID', config);
  const lu = isoDiasAtras(2);
  ponerPersona(h, root, 'ada-x-com.md',
    { page_type: 'person', name: 'Ada Lovelace', email: 'ada@x.com', last_updated: lu, silence_flagged: lu }, '');
  assert.equal(personaDe(cargar(h), 'Ada Lovelace').salud, 'bad');
});

// --- Cumplimiento y racha ---

test('cumplimiento prorrateado desde el primer reporte y racha en días hábiles', () => {
  const habiles = habilesAtras(5);
  const daily = [];
  // Ada: TODOS los hábiles de la ventana → 100% y racha 5.
  habiles.forEach((iso) => daily.push([dateDe(iso), 'ada@x.com', 'ok']));
  // Julio: entró hace 2 hábiles y reportó ambos → prorrateo = 100% (no 40%).
  daily.push([dateDe(habiles[0]), 'julio@x.com', 'ok']);
  daily.push([dateDe(habiles[1]), 'julio@x.com', 'ok']);
  // Ana: primer reporte hace 5 hábiles y nada más → % bajo, racha 0.
  daily.push([dateDe(habiles[4]), 'ana@x.com', 'ok']);

  const h = segHarness({ daily });
  const data = cargar(h, 7);

  const ada = personaDe(data, 'Ada Lovelace');
  assert.equal(ada.cumplimiento, 100);
  assert.equal(ada.racha, 5);

  const julio = personaDe(data, 'Julio Toloza');
  assert.equal(julio.cumplimiento, 100, 'prorrateado desde su primer reporte');
  assert.equal(julio.racha, 2);

  const ana = personaDe(data, 'Ana Ruiz');
  const desdeVentana = isoDiasAtras(6);
  const base = habilesEntre(habiles[4] > desdeVentana ? habiles[4] : desdeVentana, HOY);
  assert.equal(ana.cumplimiento, Math.round((1 / base) * 100));
  assert.equal(ana.racha, 0);
});

// --- Pendientes, blockers y charts ---

test('pendientes: solo los de la ventana, y la gramática de sufijos separa abiertos de cerrados', () => {
  const h = segHarness({ tareas: [['Mía', '', '', 'Alta', 'Pendiente', '', 'idL']] });
  const config = h.api.construirConfig('SID', CONFIG);
  const root = h.api.ensureBrainFolder_('SID', config);
  ponerPersona(h, root, 'julio-x-com.md',
    { page_type: 'person', name: 'Julio Toloza', email: 'julio@x.com', last_updated: HOY },
    '## Pendientes\n' +
    '- [' + isoDiasAtras(2) + '] Validar Classroom\n' +
    '- [' + isoDiasAtras(3) + '] Cerrar accesos ✓ [resuelto ' + HOY + ' · Líder A]\n' +
    '- [' + isoDiasAtras(40) + '] Viejísima\n');

  const data = cargar(h, 7);
  const julio = personaDe(data, 'Julio Toloza');
  assert.equal(julio.pendientes.length, 2, 'la de hace 40 días queda fuera de la ventana');
  assert.deepEqual(julio.pendientes.map((t) => t.abierto), [true, false]);

  const chart = data.charts.pendientes;
  assert.equal(chart.find((x) => x.nombre === 'Julio Toloza').abiertos, 1);
  // Separación (R1 de Mi seguimiento): el chart es SOLO del equipo — el líder ya no aparece.
  assert.ok(!chart.some((x) => x.lider), 'la fila del líder salió del chart');
});

test('fase 1: expone cola Hoy, flujo de 30d, edades y heatmap sin inventar fuentes Meet', () => {
  const h = segHarness({ daily: [[dateDe(isoDiasAtras(1)), 'ada@x.com', 'ok']] });
  const config = h.api.construirConfig('SID', CONFIG);
  const root = h.api.ensureBrainFolder_('SID', config);
  ponerPersona(h, root, 'ada-x-com.md',
    { page_type: 'person', name: 'Ada Lovelace', email: 'ada@x.com', last_updated: isoDiasAtras(8) },
    '## Pendientes\n- [' + isoDiasAtras(10) + '] Revisar arquitectura\n');
  ponerPersona(h, root, 'julio-x-com.md',
    { page_type: 'person', name: 'Julio Toloza', email: 'julio@x.com', last_updated: HOY, open_blockers: ['Acceso de infraestructura'] },
    '## Pendientes\n- [' + isoDiasAtras(2) + '] Validar entorno ✓ [resuelto ' + isoDiasAtras(1) + ' · Líder A]\n');

  const data = cargar(h, 7);
  assert.deepEqual(data.hoyControl.prioridades.map((x) => x.tipo), ['silencio', 'blocker', 'pendiente']);
  assert.equal(data.hoyControl.prioridades.length, 3);
  assert.equal(data.hoyControl.prioridades[2].edad, 10, 'Hoy inspecciona pendientes antiguos, no solo la ventana UI');
  assert.equal(data.hoyControl.prioridades[2].fuente, 'Second Brain');
  assert.equal(data.flujo.dias, 30);
  assert.equal(data.flujo.semanas.reduce((n, s) => n + s.abiertos, 0), 2, 'ambos compromisos fueron creados en los últimos 30 días');
  assert.equal(data.flujo.semanas.reduce((n, s) => n + s.cerrados, 0), 1);
  assert.equal(Object.values(data.flujo.edades).reduce((n, v) => n + v, 0), 1);
  assert.ok(data.tendencias.dailyHeatmap.some((x) => x.correo === 'ada@x.com' && x.n === 1));
});

test('blockers con edad, ordenados del más viejo al más nuevo', () => {
  const h = segHarness();
  const config = h.api.construirConfig('SID', CONFIG);
  const root = h.api.ensureBrainFolder_('SID', config);
  ponerPersona(h, root, 'ana-x-com.md',
    { page_type: 'person', name: 'Ana Ruiz', email: 'ana@x.com', last_updated: isoDiasAtras(9), open_blockers: ['dependencia de infra'] }, '');
  ponerPersona(h, root, 'julio-x-com.md',
    { page_type: 'person', name: 'Julio Toloza', email: 'julio@x.com', last_updated: isoDiasAtras(3), open_blockers: ['carga masiva'] }, '');

  const data = cargar(h);
  assert.equal(personaDe(data, 'Ana Ruiz').blockers[0].dias, 9);
  assert.deepEqual(data.charts.blockers.map((b) => b.dias), [9, 3]);
});

// --- Actividad (timeline) ---

test('la timeline agrega people + projects, en ventana, orden descendente y con tipo', () => {
  const h = segHarness();
  const config = h.api.construirConfig('SID', CONFIG);
  const root = h.api.ensureBrainFolder_('SID', config);
  ponerPersona(h, root, 'ada-x-com.md',
    { page_type: 'person', name: 'Ada Lovelace', email: 'ada@x.com', last_updated: HOY },
    '## Avances\n- [' + HOY + '] Cerró el diseño\n- [' + isoDiasAtras(40) + '] Prehistoria\n\n' +
    '## Pendientes\n- [' + isoDiasAtras(1) + '] Enviar acta ✓ [resuelto ' + HOY + ' · Líder A]\n');
  h.api.escribirArchivoBrain_(h.api.carpetaBrain_(root, ['wiki', 'projects']), 'alpha.md',
    h.api.componerPagina_({ page_type: 'project', name: 'Alpha', last_updated: isoDiasAtras(2) },
      '## Decisiones\n- [' + isoDiasAtras(2) + '] Bajar servicios sin IAP\n'));

  const data = cargar(h, 7);
  assert.deepEqual(data.actividad.map((i) => i.tipo), ['avance', 'pendiente', 'decision'], 'desc por fecha');
  assert.equal(data.actividad[2].quien, 'Proyecto Alpha');
  assert.equal(data.actividad[1].cerrado, true, 'el pendiente resuelto viene marcado');
  assert.ok(!data.actividad.some((i) => /Prehistoria/.test(i.texto)), 'fuera de ventana');
});

test('cargarSeguimiento cachea por ventana y resolverPendiente invalida', () => {
  const h = segHarness();
  const config = h.api.construirConfig('SID', CONFIG);
  const root = h.api.ensureBrainFolder_('SID', config);
  ponerPersona(h, root, 'ada-x-com.md',
    { page_type: 'person', name: 'Ada Lovelace', email: 'ada@x.com', last_updated: HOY },
    '## Pendientes\n- [' + HOY + '] Enviar acta\n');

  const d1 = cargar(h, 7);
  assert.equal(personaDe(d1, 'Ada Lovelace').pendientes.length, 1);

  // Escritura directa al wiki: dentro del TTL sigue la foto cacheada (aceptado: TTL < poll de 60s).
  ponerPersona(h, root, 'ada-x-com.md',
    { page_type: 'person', name: 'Ada Lovelace', email: 'ada@x.com', last_updated: HOY },
    '## Pendientes\n- [' + HOY + '] Enviar acta\n- [' + HOY + '] Otro pendiente\n');
  assert.equal(personaDe(cargar(h, 7), 'Ada Lovelace').pendientes.length, 1, 'hit de cache');

  // resolverPendiente (la escritura del propio modal) invalida → carga fresca.
  h.api.resolverPendiente('SID', config, 'ada-x-com.md', '- [' + HOY + '] Enviar acta', 'resolver');
  const d3 = cargar(h, 7);
  assert.equal(personaDe(d3, 'Ada Lovelace').pendientes.length, 2, 'invalidado tras resolver');
  assert.equal(personaDe(d3, 'Ada Lovelace').pendientes.filter((x) => x.abierto).length, 1);
});

test('separación: las viñetas de proyecto con autor exponen mio/autor y el sufijo no se pinta', () => {
  const h = segHarness();
  const config = h.api.construirConfig('SID', CONFIG);
  const root = h.api.ensureBrainFolder_('SID', config);
  h.api.escribirArchivoBrain_(h.api.carpetaBrain_(root, ['wiki', 'projects']), 'alpha.md',
    h.api.componerPagina_({ page_type: 'project', name: 'Alpha', last_updated: HOY },
      '## Pendientes\n' +
      '- [' + HOY + '] Coordinar comité · por Líder A\n' +          // del líder → mio
      '- [' + HOY + '] Validar Classroom · por Julio Toloza\n' +    // del equipo
      '- [' + isoDiasAtras(1) + '] Viñeta vieja sin autor\n'));     // histórico inatribuible

  const items = cargar(h, 7).actividad;
  const [mia, deJulio, vieja] = [
    items.find((i) => /Coordinar comité/.test(i.texto)),
    items.find((i) => /Validar Classroom/.test(i.texto)),
    items.find((i) => /Viñeta vieja/.test(i.texto))
  ];
  assert.deepEqual([mia.mio, mia.autor, mia.texto], [true, 'Líder A', 'Coordinar comité'], 'sufijo despintado');
  assert.deepEqual([deJulio.mio, deJulio.autor], [false, 'Julio Toloza']);
  assert.deepEqual([vieja.mio, vieja.autor], [false, ''], 'lo histórico sin autor jamás se marca mío');
});

test('los externos quedan fuera de personas y de la timeline', () => {
  const h = segHarness();
  const config = h.api.construirConfig('SID', CONFIG);
  const root = h.api.ensureBrainFolder_('SID', config);
  ponerPersona(h, root, 'carol-diaz.md',
    { page_type: 'person', name: 'Carol Diaz', last_updated: HOY, external: true },
    '## Avances\n- [' + HOY + '] Algo externo\n');

  const data = cargar(h);
  assert.ok(!data.personas.some((p) => p.nombre === 'Carol Diaz'));
  assert.ok(!data.actividad.some((i) => i.quien === 'Carol Diaz'));
});

// --- Actividad del brain (log) ---

test('actividadBrain cuenta ingestas por día desde la cola del log', () => {
  const h = segHarness();
  const config = h.api.construirConfig('SID', CONFIG);
  const root = h.api.ensureBrainFolder_('SID', config);
  const wiki = h.api.carpetaBrain_(root, ['wiki']);
  h.api.appendArchivoBrain_(wiki, 'log.md',
    '- ' + isoDiasAtras(1) + ' · ingesta daily · Ada · 2 eventos\n' +
    '- ' + isoDiasAtras(1) + ' · 🎥 notas de Meet · Comité · 3 eventos\n' +
    '- ' + isoDiasAtras(40) + ' · ingesta daily · vieja\n' +
    '- ' + isoDiasAtras(1) + ' · scan de silencios · 1 estancado(s)\n');

  const serie = cargar(h, 7).charts.actividadBrain;
  assert.equal(serie.length, 7);
  assert.equal(serie.find((x) => x.fecha === isoDiasAtras(1)).n, 2, 'ingesta + nota cuentan; el scan no');
});

// --- Degradación sin brain ---

test('sin brain: cumplimiento/racha desde las hojas, salud por última fila, wiki vacío', () => {
  const habiles = habilesAtras(2);
  const h = segHarness({ brain: false, daily: [[dateDe(habiles[0]), 'ada@x.com', 'ok']] });
  const data = cargar(h);

  assert.equal(data.brainEnabled, false);
  const ada = personaDe(data, 'Ada Lovelace');
  assert.ok(ada.cumplimiento != null);
  assert.notEqual(ada.salud, 'sin-datos', 'la salud sale de su última fila');
  assert.equal(personaDe(data, 'Ana Ruiz').salud, 'sin-datos');
  assert.deepEqual(data.actividad, []);
  assert.deepEqual(data.charts.blockers, []);
});

// --- Fase 2a: resolver / descartar / reabrir ---

test('resolverPendiente marca el sufijo, saca del conteo y deja auditoría en el log', () => {
  const h = segHarness();
  const config = h.api.construirConfig('SID', CONFIG);
  const root = h.api.ensureBrainFolder_('SID', config);
  const linea = '- [' + isoDiasAtras(1) + '] Validar Classroom';
  ponerPersona(h, root, 'julio-x-com.md',
    { page_type: 'person', name: 'Julio Toloza', email: 'julio@x.com', last_updated: HOY },
    '## Pendientes\n' + linea + '\n');

  const res = plain(h.api.resolverPendiente('SID', config, 'julio-x-com.md', linea, 'resolver'));
  assert.match(res.linea, new RegExp('✓ \\[resuelto ' + HOY + ' · Líder A\\]$'));

  const data = cargar(h, 7);
  assert.equal(personaDe(data, 'Julio Toloza').pendientes[0].abierto, false);
  const log = h.api.leerArchivoBrain_(h.api.carpetaBrain_(root, ['wiki']), 'log.md');
  assert.match(log, /✓ pendiente resuelto · julio-x-com · Validar Classroom/);
});

test('descartar usa ✖ y reabrir limpia el sufijo (vuelve a contar como abierto)', () => {
  const h = segHarness();
  const config = h.api.construirConfig('SID', CONFIG);
  const root = h.api.ensureBrainFolder_('SID', config);
  const linea = '- [' + isoDiasAtras(1) + '] Tarea fantasma';
  ponerPersona(h, root, 'ada-x-com.md',
    { page_type: 'person', name: 'Ada Lovelace', email: 'ada@x.com', last_updated: HOY },
    '## Pendientes\n' + linea + '\n');

  const desc = plain(h.api.resolverPendiente('SID', config, 'ada-x-com.md', linea, 'descartar'));
  assert.match(desc.linea, /✖ \[descartado /);
  assert.equal(h.api.esPendienteAbierto_(desc.linea), false);

  const re = plain(h.api.resolverPendiente('SID', config, 'ada-x-com.md', desc.linea, 'reabrir'));
  assert.equal(re.linea, linea, 'el sufijo desaparece por completo');
  assert.equal(personaDe(cargar(h), 'Ada Lovelace').pendientes[0].abierto, true);
});

test('resolverPendiente valida acción, página y línea', () => {
  const h = segHarness();
  const config = h.api.construirConfig('SID', CONFIG);
  const root = h.api.ensureBrainFolder_('SID', config);
  ponerPersona(h, root, 'ada-x-com.md',
    { page_type: 'person', name: 'Ada', email: 'ada@x.com' }, '## Pendientes\n- [' + HOY + '] Real\n');

  assert.throws(() => h.api.resolverPendiente('SID', config, 'ada-x-com.md', '- x', 'romper'), /Acción desconocida/);
  assert.throws(() => h.api.resolverPendiente('SID', config, '../ada.md', '- x', 'resolver'), /inválido/);
  assert.throws(() => h.api.resolverPendiente('SID', config, 'ada-x-com.md', '- [2020-01-01] No existe', 'resolver'), /No se encontró/);
});

// --- Ruteo ---

test('dispatch enruta cargarSeguimiento/resolverPendiente y buildDialog resuelve el modal', () => {
  const h = segHarness();
  const config = h.api.construirConfig('SID', CONFIG);
  h.api.ensureBrainFolder_('SID', config);

  const data = plain(h.api.dispatch('cargarSeguimiento', [7], 'SID', config));
  assert.equal(data.dias, 7);
  assert.equal(data.personas.length, 3);
  assert.equal(h.api.buildDialog('seguimiento').titulo, 'CoS — Seguimiento del equipo');
});
