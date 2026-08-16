import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../shared/DialogSeguimiento.html', import.meta.url), 'utf8');

test('fase 1: el diálogo ofrece cuatro tabs operativos y conserva vistas previas en Más', () => {
  ['tabHoy', 'tabCompromisos', 'tabFlujo', 'tabTendencias', 'tabMas', 'vHoy', 'vCompromisos', 'vFlujo', 'vTendencias', 'drawer'].forEach((id) => {
    assert.match(html, new RegExp('id=["\\\']' + id + '["\\\']'));
  });
  assert.match(html, /function\s+pintarHoy\s*\(/);
  assert.match(html, /function\s+pintarCompromisos\s*\(/);
  assert.match(html, /function\s+pintarFlujo\s*\(/);
  assert.match(html, /function\s+pintarTendencias\s*\(/);
  assert.match(html, /max-width:\s*760px/);
});
