/**
 * webapp-runtime.test.mjs — Web App de follow-up + sección "Tus compromisos" (Release 2).
 * Cubre: emisión de tokens (4 por ítem, máx 3 ítems, round-robin por última pregunta),
 * degradación sin URL, GET que NUNCA muta, los 4 efectos del POST (terminado/sigo/bloqueado/
 * noaplica), invalidación de hermanos, reuso/vencido/inválido con páginas de gracia, deshacer,
 * purga de higiene (tokens + guardas viejas con 'v1' intocable), hook diario del dispatcher y
 * el dedup de pendientes en el prompt de Meet.
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
const URL_WA = 'https://wa.test/exec';

function waHarness(opts = {}) {
  const h = makeHarness({
    scriptProperties: { GEMINI_API_KEY: 'K' },
    spreadsheets: { SID: {
      Ajustes: [
        ['key', 'value'],
        ['brain.enabled', 'true'],
        ['leader.email', 'lider@x.com'], ['leader.name', 'Líder A'],
        ...(opts.sinUrl ? [] : [['webapp.url', URL_WA]]),
        ...(opts.ajustes || [])
      ],
      Equipo: [['Nombre', 'Correo', 'Rol'], ['Julio Toloza', 'julio@x.com', 'Dev']],
      Daily: [['Marca temporal', 'Correo', 'Summary']],
      Weekly: [['Marca temporal', 'Correo', 'Summary']]
    } }
  });
  h.setFetch(() => httpResponse(200, geminiOk('X')));
  return h;
}

const JULIO = { nombre: 'Julio Toloza', correo: 'julio@x.com', compartirCon: [] };

function conPendientes(h, config, bullets) {
  const root = h.api.ensureBrainFolder_('SID', config);
  h.api.escribirArchivoBrain_(h.api.carpetaBrain_(root, ['wiki', 'people']), 'julio-x-com.md',
    h.api.componerPagina_({ page_type: 'person', name: 'Julio Toloza', email: 'julio@x.com', last_updated: HOY },
      '## Pendientes\n' + bullets.join('\n') + '\n'));
  return root;
}
const paginaJulio = (h, root) => h.api.parsearPagina_(
  h.api.leerArchivoBrain_(h.api.carpetaBrain_(root, ['wiki', 'people']), 'julio-x-com.md'));
const tokensDe = (h) => plain(h.api.listarTokens_('SID'));
const GET = (h, config, t) => h.api.webAction('get', { parameter: { t } }, 'SID', config).getContent();
const POST = (h, config, t) => h.api.webAction('post', { parameter: { t } }, 'SID', config).getContent();

// --- Emisión de tokens + round-robin ---

test('compromisosParaInvitacion_: máx 3 ítems, 4 tokens por ítem, orden por antigüedad', () => {
  const h = waHarness();
  const config = h.api.construirConfig('SID', CONFIG);
  conPendientes(h, config, [
    '- [' + isoDiasAtras(5) + '] Tarea A',
    '- [' + isoDiasAtras(4) + '] Tarea B',
    '- [' + isoDiasAtras(3) + '] Tarea C',
    '- [' + isoDiasAtras(2) + '] Tarea D',
    '- [' + isoDiasAtras(1) + '] Cerrada ✓ [resuelto ' + HOY + ' · Líder A]'
  ]);

  const cs = plain(h.api.compromisosParaInvitacion_('SID', config, JULIO));
  assert.deepEqual(cs.map((c) => c.texto), ['Tarea A', 'Tarea B', 'Tarea C'], 'las 3 más viejas nunca preguntadas');
  cs.forEach((c) => {
    ['terminado', 'sigo', 'bloqueado', 'noaplica'].forEach((a) => {
      assert.match(c.links[a], new RegExp('^' + URL_WA.replace(/\//g, '\\/') + '\\?t='));
    });
  });
  assert.equal(tokensDe(h).length, 12, '3 ítems × 4 acciones');
});

test('round-robin: el ítem no preguntado entra primero en la siguiente invitación', () => {
  const h = waHarness();
  const config = h.api.construirConfig('SID', CONFIG);
  conPendientes(h, config, [
    '- [' + isoDiasAtras(5) + '] Tarea A', '- [' + isoDiasAtras(4) + '] Tarea B',
    '- [' + isoDiasAtras(3) + '] Tarea C', '- [' + isoDiasAtras(2) + '] Tarea D'
  ]);
  h.api.compromisosParaInvitacion_('SID', config, JULIO);   // pregunta A, B, C
  const segunda = plain(h.api.compromisosParaInvitacion_('SID', config, JULIO));
  assert.equal(segunda[0].texto, 'Tarea D', 'la nunca preguntada va primero');
});

test('sin URL de Web App no hay sección (degradación honesta) y la invitación sale como siempre', () => {
  const h = waHarness({ sinUrl: true });
  const config = h.api.construirConfig('SID', CONFIG);
  conPendientes(h, config, ['- [' + isoDiasAtras(2) + '] Tarea A']);

  assert.deepEqual(plain(h.api.compromisosParaInvitacion_('SID', config, JULIO)), []);
  h.api.enviarInvitacion_('daily', JULIO, 'Líder A', 'https://forms.gle/x', 'SID', config);
  assert.ok(!/Tus compromisos/.test(h.sentEmails[0].html));
});

test('la invitación lleva la sección con los 4 botones y el texto plano lista los ítems', () => {
  const h = waHarness();
  const config = h.api.construirConfig('SID', CONFIG);
  conPendientes(h, config, ['- [' + isoDiasAtras(2) + '] Validar Classroom con Carol']);

  h.api.enviarInvitacion_('daily', JULIO, 'Líder A', 'https://forms.gle/x', 'SID', config);
  const mail = h.sentEmails[0];
  assert.match(mail.html, /Tus compromisos/);
  assert.match(mail.html, /Validar Classroom con Carol/);
  ['✓ Lo terminé', '⏳ Sigo en ello', '🚧 Bloqueado', '⛔ No aplica'].forEach((lbl) => {
    assert.ok(mail.html.indexOf(lbl) > -1, lbl);
  });
  assert.match(mail.body, /📌 Tus compromisos/);
  assert.match(mail.body, /· Validar Classroom con Carol/);
});

// --- GET / POST ---

test('GET pinta la tarjeta de confirmación y JAMÁS muta (anti-escáneres)', () => {
  const h = waHarness();
  const config = h.api.construirConfig('SID', CONFIG);
  const root = conPendientes(h, config, ['- [' + isoDiasAtras(2) + '] Tarea A']);
  const cs = plain(h.api.compromisosParaInvitacion_('SID', config, JULIO));
  const t = cs[0].links.terminado.split('t=')[1];

  const html = GET(h, config, decodeURIComponent(t));
  assert.match(html, /Marcar como terminado/);
  assert.match(html, /Tarea A/);
  assert.match(html, /method="post"/);

  const pg = paginaJulio(h, root);
  assert.ok(!/resuelto/.test(pg.body), 'el GET no tocó la página');
  assert.equal(tokensDe(h).filter((x) => x.usadoEl).length, 0, 'ningún token quedó usado');
});

test('POST terminado: sufijo con el nombre del miembro, hermanos invalidados y deshacer disponible', () => {
  const h = waHarness();
  const config = h.api.construirConfig('SID', CONFIG);
  const root = conPendientes(h, config, ['- [' + isoDiasAtras(2) + '] Tarea A']);
  const cs = plain(h.api.compromisosParaInvitacion_('SID', config, JULIO));
  const t = decodeURIComponent(cs[0].links.terminado.split('t=')[1]);

  const html = POST(h, config, t);
  assert.match(html, /Registrado/);
  assert.match(html, /Deshacer/);

  const pg = paginaJulio(h, root);
  assert.match(pg.body, new RegExp('Tarea A ✓ \\[resuelto ' + HOY + ' · Julio Toloza\\]'));

  const usados = tokensDe(h).filter((x) => x.usadoEl && x.accion !== 'undo');
  assert.equal(usados.length, 4, 'el usado + sus 3 hermanos');
  const log = h.api.leerArchivoBrain_(h.api.carpetaBrain_(root, ['wiki']), 'log.md');
  assert.match(log, /✓ compromiso terminado · Julio Toloza · Tarea A/);
});

test('POST sigo re-fecha la viñeta a hoy y la deja abierta', () => {
  const h = waHarness();
  const config = h.api.construirConfig('SID', CONFIG);
  const root = conPendientes(h, config, ['- [' + isoDiasAtras(5) + '] Tarea A']);
  const cs = plain(h.api.compromisosParaInvitacion_('SID', config, JULIO));
  POST(h, config, decodeURIComponent(cs[0].links.sigo.split('t=')[1]));

  const pg = paginaJulio(h, root);
  assert.match(pg.body, new RegExp('- \\[' + HOY + '\\] Tarea A'));
  assert.equal(h.api.esPendienteAbierto_('- [' + HOY + '] Tarea A'), true);
});

test('POST bloqueado suma a open_blockers y el compromiso sigue abierto', () => {
  const h = waHarness();
  const config = h.api.construirConfig('SID', CONFIG);
  const root = conPendientes(h, config, ['- [' + isoDiasAtras(2) + '] Tarea A']);
  const cs = plain(h.api.compromisosParaInvitacion_('SID', config, JULIO));
  POST(h, config, decodeURIComponent(cs[0].links.bloqueado.split('t=')[1]));

  const pg = paginaJulio(h, root);
  assert.deepEqual(plain(pg.frontmatter.open_blockers), ['Tarea A']);
  assert.match(pg.body, /- \[.*\] Tarea A\n/, 'sin sufijo: sigue abierta');
});

test('POST noaplica marca ✖ y deja auditoría de calidad de extracción en el log', () => {
  const h = waHarness();
  const config = h.api.construirConfig('SID', CONFIG);
  const root = conPendientes(h, config, ['- [' + isoDiasAtras(2) + '] Tarea fantasma']);
  const cs = plain(h.api.compromisosParaInvitacion_('SID', config, JULIO));
  POST(h, config, decodeURIComponent(cs[0].links.noaplica.split('t=')[1]));

  const pg = paginaJulio(h, root);
  assert.match(pg.body, /Tarea fantasma ✖ \[no aplica /);
  const log = h.api.leerArchivoBrain_(h.api.carpetaBrain_(root, ['wiki']), 'log.md');
  assert.match(log, /⛔ no-aplica · Julio Toloza · "Tarea fantasma" · revisar extracción de Meet/);
});

test('reuso, vencido e inválido responden con páginas de gracia y sin doble efecto', () => {
  const h = waHarness();
  const config = h.api.construirConfig('SID', CONFIG);
  const root = conPendientes(h, config, ['- [' + isoDiasAtras(2) + '] Tarea A']);
  const cs = plain(h.api.compromisosParaInvitacion_('SID', config, JULIO));
  const t = decodeURIComponent(cs[0].links.terminado.split('t=')[1]);

  POST(h, config, t);
  const otraVez = POST(h, config, t);
  assert.match(otraVez, /Ya registrado/);
  const pg = paginaJulio(h, root);
  assert.equal((pg.body.match(/resuelto/g) || []).length, 1, 'sin doble sufijo');

  // Hermano del grupo → también "ya registrado".
  const hermano = decodeURIComponent(cs[0].links.sigo.split('t=')[1]);
  assert.match(GET(h, config, hermano), /Ya registrado/);

  // Vencido: se fuerza la expiración en la hoja _Tokens.
  const cs2 = plain(h.api.compromisosParaInvitacion_('SID', config, JULIO));
  assert.equal(cs2.length, 0, 'el único ítem quedó resuelto: nada que preguntar');
  h.api.escribirArchivoBrain_; // (no-op: claridad)
  const sh = h.getSpreadsheet('SID').getSheetByName('_Tokens');
  const filas = sh.getLastRow();
  // toma un token sin usar (el undo del POST) y véncelo
  const tokens = tokensDe(h).filter((x) => !x.usadoEl);
  assert.ok(tokens.length, 'existe el token de deshacer');
  sh.getRange(tokens[0].fila, 8).setValue(isoDiasAtras(1));
  assert.match(GET(h, config, tokens[0].token), /Enlace vencido/);

  assert.match(GET(h, config, 'no-existe'), /Enlace no válido/);
  assert.ok(filas >= 1);
});

test('deshacer revierte lo aplicado (el compromiso vuelve a estar abierto)', () => {
  const h = waHarness();
  const config = h.api.construirConfig('SID', CONFIG);
  const root = conPendientes(h, config, ['- [' + isoDiasAtras(2) + '] Tarea A']);
  const cs = plain(h.api.compromisosParaInvitacion_('SID', config, JULIO));
  const exito = POST(h, config, decodeURIComponent(cs[0].links.terminado.split('t=')[1]));

  const undoTok = decodeURIComponent(/href="[^"]*t=([^"&]+)"/.exec(exito)[1]);
  assert.match(GET(h, config, undoTok), /REVERTIR/);
  POST(h, config, undoTok);

  const pg = paginaJulio(h, root);
  assert.match(pg.body, new RegExp('- \\[' + isoDiasAtras(2) + '\\] Tarea A\\n'));
  assert.ok(!/resuelto/.test(pg.body), 'el sufijo desapareció');
});

// --- Higiene ---

test('purgaHigiene_ borra tokens vencidos y guardas sent:* viejas — pero nunca las "v1"', () => {
  const h = waHarness();
  const config = h.api.construirConfig('SID', CONFIG);
  conPendientes(h, config, ['- [' + isoDiasAtras(2) + '] Tarea A']);
  h.api.compromisosParaInvitacion_('SID', config, JULIO);   // 4 tokens frescos

  const sh = h.getSpreadsheet('SID').getSheetByName('_Tokens');
  sh.getRange(2, 8).setValue(isoDiasAtras(1));   // vence el primero

  h.api.marcarEnviado_('SID', 'daily', 'a@x.com', isoDiasAtras(120));
  h.api.marcarEnviado_('SID', 'daily', 'b@x.com', isoDiasAtras(5));
  h.api.marcarEnviado_('SID', 'meet-doc', 'doc99', 'v1');

  const res = plain(h.api.purgaHigiene_('SID', config, new Date()));
  assert.equal(res.tokens, 1);
  assert.equal(res.guardas, 1, 'solo la de hace 120 días');
  assert.equal(tokensDe(h).length, 3);
  assert.equal(h.api.yaEnviado_('SID', 'meet-doc', 'doc99', 'v1'), true, 'la v1 es intocable');
  assert.equal(h.api.yaEnviado_('SID', 'daily', 'b@x.com', isoDiasAtras(5)), true);
});

test('el dispatcher corre la higiene 1×/día', () => {
  const h = waHarness();
  const config = h.api.construirConfig('SID', CONFIG);
  h.api.marcarEnviado_('SID', 'daily', 'viejo@x.com', isoDiasAtras(200));

  h.api.runDispatcher('SID', config, new Date());
  assert.equal(h.api.yaEnviado_('SID', 'daily', 'viejo@x.com', isoDiasAtras(200)), false, 'purgada');
});

// --- Dedup en el prompt de Meet ---

test('el prompt de Meet lleva los pendientes ya registrados del equipo (dedup por LLM)', () => {
  const h = waHarness({ ajustes: [['meet.enabled', 'true']] });
  const inicio = new Date(Date.now() - 2 * 3600000);
  h.setFetch((url, options) => {
    if (url.indexOf('calendar/v3') > -1) {
      return httpResponse(200, JSON.stringify({ items: [{
        id: 'ev1', summary: 'Comité', start: { dateTime: inicio.toISOString() },
        attachments: [{ fileId: 'doc1', title: 'Comité - Notas de Gemini', mimeType: 'application/vnd.google-apps.document' }]
      }] }));
    }
    if (/drive\/v3\/files\/doc1\/export/.test(url)) return httpResponse(200, 'notas');
    return httpResponse(200, geminiOk(JSON.stringify({ resumen: 'R', asistentes: [], eventos: [] })));
  });
  const config = h.api.construirConfig('SID', CONFIG);
  conPendientes(h, config, ['- [' + isoDiasAtras(2) + '] Validar Classroom con Carol']);

  h.api.runMeetPass_('SID', config, new Date(), Date.now() + 300000);
  const gemini = h.fetchCalls.filter((c) => c.url.indexOf('generativelanguage') > -1);
  const user = JSON.parse(gemini[0].options.payload).contents[0].parts[0].text;
  assert.match(user, /PENDIENTES YA REGISTRADOS/);
  assert.match(user, /Julio Toloza: Validar Classroom con Carol/);
});
