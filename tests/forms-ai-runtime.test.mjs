/**
 * forms-ai-runtime.test.mjs — Generación de preguntas por IA (shared/forms-ai-runtime.js) y el
 * soporte de responseSchema en callGemini_ (shared/gemini-runtime.js).
 * Corre con: npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHarness, httpResponse, geminiOk } from './gas-harness.mjs';

const CONFIG = {
  sheets: { daily: 'Daily', weekly: 'Weekly', roster: 'Equipo', prompts: 'Prompts', settings: 'Ajustes' },
  models: { perRow: 'gemini-3.6-flash', consolidated: 'gemini-3.1-pro-preview' },
  timezone: 'America/Lima'
};

const KEY = { scriptProperties: { GEMINI_API_KEY: 'TESTKEY' } };

/** Harness con Gemini que responde `obj` (como JSON estructurado en parts[].text). */
function withGemini(obj) {
  const h = makeHarness(KEY);
  h.setFetch(() => httpResponse(200, geminiOk(JSON.stringify(obj))));
  return h;
}

// --- callGemini_ + responseSchema ---

test('callGemini_ con responseSchema añade responseMimeType y responseSchema al generationConfig', () => {
  const h = makeHarness(KEY);
  h.setFetch(() => httpResponse(200, geminiOk('{"preguntas":[]}')));
  const schema = { type: 'OBJECT', properties: { preguntas: { type: 'ARRAY' } } };
  h.api.callGemini_('gemini-3.6-flash', 'sys', 'user', { responseSchema: schema });

  const body = JSON.parse(h.fetchCalls[0].options.payload);
  assert.equal(body.generationConfig.responseMimeType, 'application/json');
  assert.deepEqual(body.generationConfig.responseSchema, schema);
});

test('callGemini_ sin responseSchema NO cambia el payload (no-regresión)', () => {
  const h = makeHarness(KEY);
  h.setFetch(() => httpResponse(200, geminiOk('hola')));
  h.api.callGemini_('gemini-3.6-flash', 'sys', 'user', {});

  const body = JSON.parse(h.fetchCalls[0].options.payload);
  assert.equal('responseMimeType' in body.generationConfig, false);
  assert.equal('responseSchema' in body.generationConfig, false);
});

// --- generarPreguntasIA: prompt + esquema ---

test('generarPreguntasIA exige un prompt no vacío', () => {
  const h = makeHarness(KEY);
  assert.throws(() => h.api.generarPreguntasIA('SID', CONFIG, 'daily', '   '), /prompt/i);
});

test('generarPreguntasIA usa el modelo perRow y manda el responseSchema', () => {
  const h = withGemini({ preguntas: [{ tipo: 'texto', titulo: 'X' }] });
  h.api.generarPreguntasIA('SID', CONFIG, 'daily', 'crea un form');

  const call = h.fetchCalls[0];
  assert.match(call.url, /gemini-3\.6-flash:generateContent/);
  const body = JSON.parse(call.options.payload);
  assert.equal(body.generationConfig.responseMimeType, 'application/json');
  assert.ok(body.generationConfig.responseSchema.properties.preguntas);
});

test('generarPreguntasIA devuelve título/descr. cuando el prompt los especifica', () => {
  const h = withGemini({
    titulo: 'Reporte de ventas', descripcion: 'Diario del equipo comercial',
    preguntas: [{ tipo: 'parrafo', titulo: '¿Avances?' }]
  });
  const res = h.api.generarPreguntasIA('SID', CONFIG, 'daily', 'con título y descripción');
  assert.equal(res.titulo, 'Reporte de ventas');
  assert.equal(res.descripcion, 'Diario del equipo comercial');
  assert.equal(res.preguntas.length, 1);
});

test('JSON inválido de la IA → falla visible (no ensucia el editor)', () => {
  const h = makeHarness(KEY);
  h.setFetch(() => httpResponse(200, geminiOk('esto no es json {')));
  assert.throws(() => h.api.generarPreguntasIA('SID', CONFIG, 'daily', 'x'), /no válida|JSON/i);
});

// --- sanearPreguntas_ (puro) ---

test('sanearPreguntas_ lanza si no hay preguntas utilizables', () => {
  const h = makeHarness();
  assert.throws(() => h.api.sanearPreguntas_({ preguntas: [] }), /no devolvió preguntas/i);
  assert.throws(() => h.api.sanearPreguntas_({}), /no devolvió preguntas/i);
});

test('sanearPreguntas_ degrada un tipo desconocido al más cercano + nota', () => {
  const h = makeHarness();
  const r = h.api.sanearPreguntas_({ preguntas: [{ tipo: 'file_upload', titulo: 'Adjunta algo' }] });
  assert.equal(r.preguntas[0].tipo, 'parrafo');
  assert.ok(r.notas.some((n) => /no soportado/i.test(n)));
});

test('sanearPreguntas_ mapea nombres comunes (dropdown→lista, linear_scale→escala)', () => {
  const h = makeHarness();
  const r = h.api.sanearPreguntas_({ preguntas: [
    { tipo: 'dropdown', titulo: 'Etapa', opciones: ['A', 'B'] },
    { tipo: 'linear_scale', titulo: 'Ánimo' }
  ] });
  assert.equal(r.preguntas[0].tipo, 'lista');
  assert.equal(r.preguntas[1].tipo, 'escala');
});

test('sanearPreguntas_ recorta al cap de 25 y lo anota', () => {
  const h = makeHarness();
  const muchas = [];
  for (let i = 0; i < 30; i++) muchas.push({ tipo: 'texto', titulo: 'P' + i });
  const r = h.api.sanearPreguntas_({ preguntas: muchas });
  assert.equal(r.preguntas.length, 25);
  assert.ok(r.notas.some((n) => /recort/i.test(n)));
});

test('sanearPreguntas_ pone escala 1–5 por defecto y respeta límites de Forms', () => {
  const h = makeHarness();
  const r = h.api.sanearPreguntas_({ preguntas: [
    { tipo: 'escala', titulo: 'sin bounds' },
    { tipo: 'escala', titulo: 'fuera de rango', min: 3, max: 99 }
  ] });
  assert.deepEqual([r.preguntas[0].min, r.preguntas[0].max], [1, 5]);
  assert.equal(r.preguntas[1].min <= 1, true);   // Forms: mínimo 0 o 1
  assert.equal(r.preguntas[1].max <= 10, true);  // Forms: máximo 10
  assert.equal(r.preguntas[1].max > r.preguntas[1].min, true);
});

test('sanearPreguntas_ descarta opciones vacías y anota si quedan cero', () => {
  const h = makeHarness();
  const r = h.api.sanearPreguntas_({ preguntas: [
    { tipo: 'opcion', titulo: 'con vacías', opciones: ['Sí', '', '  ', 'No'] },
    { tipo: 'casillas', titulo: 'sin opciones', opciones: ['', ' '] }
  ] });
  assert.deepEqual(r.preguntas[0].opciones, ['Sí', 'No']);
  assert.equal('opciones' in r.preguntas[1], false);
  assert.ok(r.notas.some((n) => /sin opciones/i.test(n)));
});

test('sanearPreguntas_ coacciona requerido a booleano y limpia ayuda', () => {
  const h = makeHarness();
  const r = h.api.sanearPreguntas_({ preguntas: [
    { tipo: 'texto', titulo: 'A', requerido: 'true', ayuda: '  pista  ' },
    { tipo: 'texto', titulo: 'B' }
  ] });
  assert.equal(r.preguntas[0].requerido, true);
  assert.equal(r.preguntas[0].ayuda, 'pista');
  assert.equal(r.preguntas[1].requerido, false);
  assert.equal('ayuda' in r.preguntas[1], false);
});
