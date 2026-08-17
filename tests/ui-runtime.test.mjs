/**
 * ui-runtime.test.mjs — UI servida desde la librería (shared/ui-runtime.js).
 * Corre con: npm test  (node --test tests/)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeHarness } from './gas-harness.mjs';

const SID = 'SHEET_1';
const config = { sheets: { daily: 'Daily', weekly: 'Weekly', roster: 'Equipo', prompts: 'Prompts', settings: 'Ajustes' }, timezone: 'America/Lima' };
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const readShared = (name) => fs.readFileSync(path.join(ROOT, 'shared', name), 'utf8');

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
  assert.deepEqual(items.map((i) => i.fn), ['abrirSidebar', 'cosMenu1', 'cosMenu2', 'cosMenu3', 'cosMenu4', 'cosMenu5']);
  assert.deepEqual(items.map((i) => i.caption),
    ['⚙️ Configurar', '📝 Formularios', '📤 Compartir reportes', '☀️ Morning Briefing', '👥 Seguimiento del equipo', '🎯 Mi seguimiento']);
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

test('Telegram abre un modal y sus acciones quedan registradas en el dispatcher', () => {
  const h = makeHarness({ spreadsheets: { [SID]: { Ajustes: [['key', 'value']] } } });
  const d = h.api.buildDialog('telegram');
  assert.equal(d.html._file, 'DialogTelegram');
  assert.equal(d.html._width, 620);
  assert.equal(d.html._height, 620);

  const res = h.api.dispatch('abrirTelegram', [], SID, config);
  assert.deepEqual({ ...res }, { ok: true });
  assert.equal(h.uiCalls.length, 1);
  assert.equal(h.uiCalls[0].kind, 'modal');
  assert.equal(h.uiCalls[0].html._file, 'DialogTelegram');

  ['cargarTelegram', 'guardarTokenTelegram', 'iniciarPairingTelegram', 'revocarTelegram'].forEach((name) => {
    assert.equal(typeof h.api.DISPATCH_[name], 'function', name + ' debe estar permitido vía cosRun');
  });
});

test('la UI de Telegram guarda secretos sin exponerlos y renderiza QR solo en el cliente', () => {
  const dialog = readShared('DialogTelegram.html');
  const sidebar = readShared('Sidebar.html');

  ['cargarTelegram', 'guardarTokenTelegram', 'iniciarPairingTelegram', 'revocarTelegram'].forEach((name) => {
    assert.match(dialog, new RegExp("run\\('" + name + "'\\)"), name + ' debe usar cosRun');
  });
  assert.match(dialog, /type="password"/);
  assert.doesNotMatch(dialog, /innerHTML\s*=\s*[^;]*token/i, 'el token no puede renderizarse en HTML');
  assert.doesNotMatch(dialog, /https?:\/\/[^'"\s]*(?:qr|qrcode|chart\.google)/i, 'el QR no puede usar servicios externos');
  assert.match(dialog, /function renderQr\(/, 'el QR se genera localmente');
  assert.match(dialog, /addEventListener\(['"]click['"]/, 'los controles dinámicos usan listeners, no handlers construidos');
  assert.match(sidebar, /abrirTelegramUI/);
  assert.match(sidebar, /runB\('abrirTelegram'\)/);
});

test('Centro del Brain abre el diálogo modeless correcto y queda disponible vía dispatch', () => {
  const h = makeHarness({ spreadsheets: { [SID]: { Ajustes: [['key', 'value']] } } });
  const d = h.api.buildDialog('braincentro');
  assert.equal(d.html._file, 'DialogBrainCentro');
  assert.equal(d.html._width, 860);
  assert.equal(d.html._height, 680);

  const res = h.api.dispatch('abrirBrainCentro', [], SID, config);
  assert.deepEqual({ ...res }, { ok: true });
  assert.equal(h.uiCalls.length, 1);
  assert.equal(h.uiCalls[0].kind, 'modeless');
  assert.equal(h.uiCalls[0].html._file, 'DialogBrainCentro');
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

// --- Guía del CoS (asistente modeless) ---

test('cargarAsistente auto-detecta los pasos contra el estado REAL de la copia', () => {
  const h = makeHarness({ spreadsheets: { [SID]: {
    Ajustes: [['key', 'value'],
      ['forms.dailyUrl', 'https://d'], ['forms.weeklyUrl', 'https://w'],
      ['leader.email', 'lider@x.com'], ['brain.enabled', 'true']],
    Equipo: [['Nombre', 'Correo', 'Rol'], ['Ada', 'ada@x.com', 'Dev']]
  } } });
  const d = JSON.parse(JSON.stringify(h.api.cargarAsistente(SID, config)));

  const porId = {};
  d.pasos.forEach((p) => { porId[p.id] = p; });
  assert.equal(porId[1].hecho, true, 'equipo con gente');
  assert.equal(porId[2].hecho, true, 'ambos forms creados');
  assert.equal(porId[4].hecho, true, 'líder con correo');
  assert.equal(porId[5].hecho, true, 'memoria activa');
  assert.equal(porId[6].hecho, false, 'meet apagado');
  assert.equal(porId[7].hecho, false, 'briefing apagado');
  assert.deepEqual([porId[3].manual, porId[8].manual], [true, true], 'solo 3 y 8 son manuales');
  assert.deepEqual([porId[3].hecho, porId[8].hecho], [false, false]);
});

test('marcarPasoAsistente persiste los manuales y rechaza fingir los automáticos', () => {
  const h = makeHarness({ spreadsheets: { [SID]: {
    Ajustes: [['key', 'value']],
    Equipo: [['Nombre', 'Correo', 'Rol']]
  } } });
  h.api.marcarPasoAsistente(SID, config, 3, true);
  h.api.marcarPasoAsistente(SID, config, 8, true);
  let d = JSON.parse(JSON.stringify(h.api.cargarAsistente(SID, config)));
  assert.deepEqual(d.pasos.filter((p) => p.hecho).map((p) => p.id), [3, 8]);

  h.api.marcarPasoAsistente(SID, config, 8, false);   // desmarcar también funciona
  d = JSON.parse(JSON.stringify(h.api.cargarAsistente(SID, config)));
  assert.deepEqual(d.pasos.filter((p) => p.hecho).map((p) => p.id), [3]);

  assert.throws(() => h.api.marcarPasoAsistente(SID, config, 5, true), /se marca solo/);
});

test('abrirGuia usa diálogo MODELESS y abrirDesdeAsistente rutea sidebar/modales', () => {
  const h = makeHarness({ spreadsheets: { [SID]: { Ajustes: [['key', 'value']] } } });
  h.api.abrirGuia(SID, config);
  assert.equal(h.uiCalls[0].kind, 'modeless', 'la guía NO bloquea la hoja');
  assert.equal(h.uiCalls[0].html._file, 'DialogAsistente');

  h.api.abrirDesdeAsistente(SID, config, 'sidebar');
  assert.equal(h.uiCalls[1].kind, 'sidebar');
  h.api.abrirDesdeAsistente(SID, config, 'briefing');
  assert.equal(h.uiCalls[2].kind, 'modal');
  assert.equal(h.uiCalls[2].html._file, 'DialogBriefing');

  const viaDispatch = JSON.parse(JSON.stringify(h.api.dispatch('cargarAsistente', [], SID, config)));
  assert.equal(viaDispatch.pasos.length, 8, 'dispatch enruta la guía');
});

test('menuAction lanza si el slot no tiene acción asignada', () => {
  // cosMenu1..5 ya están todos asignados: un slot inexistente cae por el mismo camino.
  const { api } = makeHarness();
  assert.throws(() => api.menuAction('cosMenu9', SID, config), /no asignada/);
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
