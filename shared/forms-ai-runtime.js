/**
 * forms-ai-runtime.js — Generación de preguntas del Form a partir de un prompt detallado (Gemini).
 *
 * El líder pega un prompt en el modal (pestaña "Generative Form"); esto llama a Gemini con salida
 * estructurada (responseSchema) y devuelve preguntas listas para el editor, junto con título y
 * descripción del Form si el prompt los especifica. La generación NO persiste ni toca el Form real:
 * solo devuelve datos para que el líder revise/edite y luego guarde (guardarFormulario).
 *
 * Todo lo puro (esquema, saneado, degradado de tipos, cap) es testeable en Node.
 *
 * Sin import/export: runtime de Apps Script. Privados con sufijo "_".
 */

/** Tipos de pregunta soportados (deben coincidir con addPregunta_ en forms-runtime.js). */
var TIPOS_AI_ = ['texto', 'parrafo', 'opcion', 'casillas', 'lista', 'escala', 'fecha', 'hora'];
var CON_OPCIONES_AI_ = ['opcion', 'casillas', 'lista'];
var CAP_PREGUNTAS_ = 25;

/**
 * Mapa de tipos "de fuera" (nombres comunes que la IA podría inventar) al más cercano soportado.
 * Lo no listado cae a 'parrafo'.
 */
var DEGRADAR_TIPO_ = {
  short_answer: 'texto', respuesta_corta: 'texto', number: 'texto', numero: 'texto', email: 'texto',
  correo: 'texto', telefono: 'texto', url: 'texto',
  paragraph: 'parrafo', respuesta_larga: 'parrafo', long_answer: 'parrafo', textarea: 'parrafo',
  radio: 'opcion', multiple_choice: 'opcion', opcion_multiple: 'opcion', seleccion_unica: 'opcion',
  checkbox: 'casillas', checkboxes: 'casillas', seleccion_multiple: 'casillas',
  dropdown: 'lista', desplegable: 'lista', select: 'lista',
  linear_scale: 'escala', escala_lineal: 'escala', rating: 'escala', puntuacion: 'escala',
  date: 'fecha', time: 'hora',
  file: 'parrafo', file_upload: 'parrafo', subir_archivo: 'parrafo', archivo: 'parrafo',
  grid: 'lista', cuadricula: 'lista', multiple_choice_grid: 'lista', checkbox_grid: 'lista'
};

/** Esquema de salida (subconjunto OpenAPI que acepta la Gemini API en generationConfig). */
var SCHEMA_PREGUNTAS_ = {
  type: 'OBJECT',
  properties: {
    titulo: { type: 'STRING' },
    descripcion: { type: 'STRING' },
    preguntas: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          tipo: { type: 'STRING', enum: TIPOS_AI_ },
          titulo: { type: 'STRING' },
          opciones: { type: 'ARRAY', items: { type: 'STRING' } },
          min: { type: 'INTEGER' },
          max: { type: 'INTEGER' },
          requerido: { type: 'BOOLEAN' },
          ayuda: { type: 'STRING' }
        },
        required: ['tipo', 'titulo']
      }
    }
  },
  required: ['preguntas']
};

/** Instrucción de sistema para la generación. */
function promptSistemaPreguntas_(tipo) {
  var cual = (tipo === 'weekly') ? 'semanal (Weekly)' : 'diario (Daily)';
  return [
    'Eres un asistente que diseña formularios de reporte ' + cual + ' para un equipo.',
    'A partir del pedido del usuario, devuelve las preguntas del formulario en español.',
    'Tipos de pregunta permitidos (usa EXACTAMENTE estas claves): ' + TIPOS_AI_.join(', ') + '.',
    'Reglas:',
    '- "opcion" (una respuesta), "casillas" (varias), "lista" (desplegable) DEBEN traer "opciones" (>=2).',
    '- "escala" usa "min" y "max" enteros (por defecto 1 y 5).',
    '- Marca "requerido": true solo cuando el pedido lo indique o sea claramente obligatorio.',
    '- Usa "ayuda" para una aclaración breve solo si aporta.',
    '- Incluye "titulo" y "descripcion" del formulario SOLO si el pedido los especifica; si no, omítelos.',
    '- No inventes una pregunta de nombre ni de correo: la identidad se toma de la cuenta de Google.',
    '- Máximo ' + CAP_PREGUNTAS_ + ' preguntas.'
  ].join('\n');
}

/**
 * Sanea y normaliza el objeto devuelto por la IA. Puro y testeable.
 * @param {Object} obj  { titulo?, descripcion?, preguntas: [...] }
 * @return {{titulo:string, descripcion:string, preguntas:Array, notas:string[]}}
 * @throws si no hay un arreglo de preguntas utilizable.
 */
function sanearPreguntas_(obj) {
  obj = obj || {};
  var notas = [];
  var raw = obj.preguntas;
  if (!Array.isArray(raw) || !raw.length) {
    throw new Error('La IA no devolvió preguntas. Ajusta el prompt e intenta de nuevo.');
  }

  if (raw.length > CAP_PREGUNTAS_) {
    notas.push('Se recortaron ' + (raw.length - CAP_PREGUNTAS_) +
      ' pregunta(s): el máximo es ' + CAP_PREGUNTAS_ + '.');
    raw = raw.slice(0, CAP_PREGUNTAS_);
  }

  var preguntas = raw.map(function (q) {
    q = q || {};
    var tipoIn = String(q.tipo || '').toLowerCase().trim();
    var tipo = (TIPOS_AI_.indexOf(tipoIn) > -1) ? tipoIn : (DEGRADAR_TIPO_[tipoIn] || 'parrafo');
    var titulo = String(q.titulo || '').trim();
    if (tipo !== tipoIn) {
      notas.push('"' + (titulo || tipoIn || '(sin título)') + '": tipo "' + tipoIn +
        '" no soportado → se usó "' + tipo + '".');
    }

    var out = { tipo: tipo, titulo: titulo };

    if (CON_OPCIONES_AI_.indexOf(tipo) > -1) {
      var opciones = (Array.isArray(q.opciones) ? q.opciones : [])
        .map(function (o) { return String(o == null ? '' : o).trim(); })
        .filter(function (o) { return o; });
      if (opciones.length) out.opciones = opciones;
      else notas.push('"' + (titulo || '(sin título)') + '": tipo con opciones pero sin opciones.');
    }

    if (tipo === 'escala') {
      var min = parseInt(q.min, 10); if (isNaN(min)) min = 1;
      var max = parseInt(q.max, 10); if (isNaN(max)) max = 5;
      if (min < 0) min = 0;
      if (min > 1) min = 1;               // Forms: el mínimo de escala es 0 o 1
      if (max > 10) max = 10;             // Forms: el máximo de escala es 10
      if (max <= min) max = min + 4;
      out.min = min;
      out.max = max;
    }

    out.requerido = !!q.requerido;
    var ayuda = String(q.ayuda == null ? '' : q.ayuda).trim();
    if (ayuda) out.ayuda = ayuda;
    return out;
  });

  return {
    titulo: String(obj.titulo == null ? '' : obj.titulo).trim(),
    descripcion: String(obj.descripcion == null ? '' : obj.descripcion).trim(),
    preguntas: preguntas,
    notas: notas
  };
}

/**
 * Genera preguntas del Form con IA a partir de un prompt detallado. Público (vía cosRun/dispatch).
 * NO persiste: devuelve datos para que el modal los muestre/edite antes de guardar.
 *
 * @param {string} sheetId  (no usado; presente por la convención fn(sheetId, config, ...args))
 * @param {Object} config   CONFIG (usa config.models.perRow como modelo)
 * @param {string} tipo     'daily' | 'weekly'
 * @param {string} promptDetallado
 * @return {{titulo:string, descripcion:string, preguntas:Array, notas:string[]}}
 */
function generarPreguntasIA(sheetId, config, tipo, promptDetallado) {
  if (!promptDetallado || !String(promptDetallado).trim()) {
    throw new Error('Escribe un prompt con el detalle del formulario antes de generar.');
  }

  var texto = callGemini_(config.models.perRow, promptSistemaPreguntas_(tipo), String(promptDetallado), {
    responseSchema: SCHEMA_PREGUNTAS_,
    temperature: 0.2
  });

  var obj;
  try {
    obj = JSON.parse(texto);
  } catch (e) {
    throw new Error('La IA devolvió una respuesta no válida (JSON). Reintenta o ajusta el prompt.');
  }
  return sanearPreguntas_(obj);
}
