/**
 * ui-runtime.test.mjs — UI servida desde la librería (shared/ui-runtime.js).
 * Corre con: npm test  (node --test tests/)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHarness } from './gas-harness.mjs';

const SID = 'SHEET_1';
const config = { sheets: { daily: 'Daily', weekly: 'Weekly', roster: 'Equipo', prompts: 'Prompts', settings: 'Ajustes' }, timezone: 'America/Lima' };

/** Ui mock: registra los ítems agregados y a qué nombre de función apunta cada uno. */
function makeUi() {
  const items = [];
  const menu = {
    addItem(caption, fn) { items.push({ kind: 'item', caption, fn }); return menu; },
    addSeparator() { items.push({ kind: 'separator' }); return menu; },
    addToUi() { menu._added = true; }
  };
  return { _menu: menu, _items: items, createMenu(name) { menu._name = name; return menu; } };
}

test('construirMenu arma el menú CoS con handlers del stub por nombre', () => {
  const { api } = makeHarness();
  const ui = makeUi();
  api.construirMenu(ui);

  assert.equal(ui._menu._name, 'CoS');
  assert.equal(ui._menu._added, true);
  const items = ui._items.filter((i) => i.kind === 'item');
  assert.deepEqual(items.map((i) => i.fn), ['abrirSidebar', 'cosMenu1', 'cosMenu2', 'cosMenu3']);
  assert.deepEqual(items.map((i) => i.caption),
    ['⚙️ Configurar', '📝 Formularios', '📤 Compartir reportes', '☀️ Morning Briefing']);
});

test('buildSidebar carga el HTML de la librería con título', () => {
  const { api } = makeHarness();
  const out = api.buildSidebar();
  assert.equal(out._file, 'Sidebar');           // shared/Sidebar.html (proyecto que ejecuta = librería)
  assert.equal(out._title, 'CoS — Configuración');
});

test('buildDialog(\'preguntas\') resuelve el modal desde el HTML de la librería', () => {
  const { api } = makeHarness();
  const d = api.buildDialog('preguntas');
  assert.equal(d.html._file, 'DialogPreguntas');    // shared/DialogPreguntas.html
  assert.equal(d.html._width, 760);
  assert.equal(d.html._height, 660);
  assert.match(d.titulo, /Preguntas/);
});

test('buildDialog lanza en un nombre desconocido', () => {
  const { api } = makeHarness();
  assert.throws(() => api.buildDialog('inexistente'), /Diálogo desconocido/);
});

test('menuAction(\'cosMenu1\') abre el modal de preguntas con showModalDialog', () => {
  const h = makeHarness();
  h.api.menuAction('cosMenu1', SID, config);
  assert.equal(h.uiCalls.length, 1);
  assert.equal(h.uiCalls[0].kind, 'modal');
  assert.equal(h.uiCalls[0].html._file, 'DialogPreguntas');
  assert.match(h.uiCalls[0].titulo, /Preguntas/);
});

test('menuAction lanza si el slot no tiene acción asignada', () => {
  const { api } = makeHarness();
  assert.throws(() => api.menuAction('cosMenu4', SID, config), /no asignada/);
});

test('dispatch enruta cargarConfig igual que la llamada directa', () => {
  const spreadsheets = { [SID]: {} };   // sin pestañas: cargarConfig tolera ausencias
  const h = makeHarness({ spreadsheets });
  const viaDispatch = h.api.dispatch('cargarConfig', [], SID, config);
  const directo = h.api.cargarConfig(SID, config);
  assert.deepEqual(viaDispatch, directo);
  assert.ok('prompts' in viaDispatch && 'equipo' in viaDispatch);
});

test('dispatch lanza en una función no registrada', () => {
  const { api } = makeHarness();
  assert.throws(() => api.dispatch('borrarTodo', [], SID, config), /no permitida/);
});

test('dispatch guardarLeader pasa args en el orden correcto (sheetId, config, ...args)', () => {
  const spreadsheets = { [SID]: {} };
  const h = makeHarness({ spreadsheets });
  const res = h.api.dispatch('guardarLeader', [{ email: 'c@x.com', name: 'C' }], SID, config);
  assert.deepEqual({ ...res }, { ok: true });
  // efecto: quedó persistido en la pestaña Ajustes
  const leido = h.api.cargarConfig(SID, config);
  assert.equal(leido.leader.email, 'c@x.com');
  assert.equal(leido.leader.name, 'C');
});
