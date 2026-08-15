/**
 * brain-ingest-runtime.js — Ingesta al second brain, piggyback del resumen por fila.
 *
 * Cuando `brain.enabled`, el resumen de la fila (onFormSubmit → generarSummaryFila) hace UNA sola
 * llamada a Gemini con responseSchema que devuelve { summary, eventos[] }: el mismo call que ya
 * pagábamos para resumir ahora TAMBIÉN extrae eventos estructurados → costo de API cero extra.
 *
 * Con esos eventos escribe las tres capas del brain (ver brain-drive-runtime.js):
 *   - raw/reports/   copia inmutable del reporte (verdad de origen).
 *   - wiki/people|projects/  páginas de entidad regeneradas incrementalmente (dedup por fuente).
 *   - wiki/log.md    bitácora append-only (una línea por ingesta + por contradicción).
 *
 * Contradicciones: el LLM las marca en el MISMO call comparando el reporte contra el "estado
 * previo" de la persona (su página wiki), que le pasamos como contexto. Silencios NO se detectan
 * aquí (son un scan determinista del dispatcher, Fase 2). Ver Docs/workflows/SECOND-BRAIN/.
 *
 * Sin import/export: runtime de Apps Script. Privados con sufijo "_".
 */

/** responseSchema del call piggyback: resumen + eventos estructurados. */
var INGEST_SCHEMA_ = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    eventos: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          persona:    { type: 'string' },
          proyecto:   { type: 'string' },
          tipo:       { type: 'string', enum: ['avance', 'blocker', 'riesgo', 'decision', 'contradiccion', 'accion'] },
          texto:      { type: 'string' },
          confidence: { type: 'number' }
        },
        required: ['tipo', 'texto']
      }
    }
  },
  required: ['summary', 'eventos']
};

// --- Compuerta determinista de nombres de entidad ---
//
// El responseSchema de Gemini fuerza la ESTRUCTURA (y los enum) por decodificación restringida,
// pero NO el contenido de un string libre: maxLength es decorativo (la doc oficial manda validar
// en la app). Esta compuerta es la única garantía real de que un nombre propuesto por el LLM no
// sea razonamiento fugado (bug 2026-08-13: un monólogo de ~1.900 chars como nombre de proyecto).

var ENTIDAD_MAX_CHARS_ = 60;
var ENTIDAD_MAX_PALABRAS_ = 6;
// Marcadores de fuga: pares clave: del propio schema, flechas de "action items" y comillas.
var ENTIDAD_MARCADORES_FUGA_ = /(confidence|accion|acción|correo|persona|proyecto|tipo|texto)\s*:|->|→|["«»]/i;
var ENTIDAD_PUNTUACION_FUERTE_ = /[.;!?]/g;

/**
 * Valida un nombre de entidad (proyecto/persona externa) propuesto por el LLM.
 * @return {string|null} el nombre limpio, o null si huele a fuga de razonamiento.
 */
function sanitizarNombreEntidad_(valor) {
  var s = String(valor == null ? '' : valor).trim();
  if (!s) return null;
  if (s.length > ENTIDAD_MAX_CHARS_) return null;
  if (s.split(/\s+/).length > ENTIDAD_MAX_PALABRAS_) return null;
  if (/[\r\n]/.test(s)) return null;
  if (ENTIDAD_MARCADORES_FUGA_.test(s)) return null;
  var fuertes = s.match(ENTIDAD_PUNTUACION_FUERTE_);
  if (fuertes && fuertes.length >= 2) return null;   // más de una oración ("Plataforma 2.0" pasa)
  return s;
}

function sanitizarProyecto_(nombre) { return sanitizarNombreEntidad_(nombre); }
function sanitizarPersona_(nombre) { return sanitizarNombreEntidad_(nombre); }

// Techos defensivos para los campos narrativos (truncar, no rechazar: el hecho importa).
var EVENTO_TEXTO_MAX_ = 300;
var RESUMEN_MAX_ = 600;

// --- Catálogo de proyectos como enum (garantía dura del API) ---

/**
 * Clona un responseSchema base e inyecta en eventos[] el campo `proyecto` como enum de los
 * nombres canónicos de _projects.json + 'OTRO' + 'NINGUNO', más el campo libre `proyecto_nuevo`
 * (solo se lee cuando proyecto === 'OTRO'; pasa por la compuerta).
 * Con catálogo vacío el enum es ['OTRO','NINGUNO']: todo nombre nuevo entra por el camino saneado.
 * OJO: el API rechaza con 400 los valores vacíos en un enum — por eso el sentinela 'NINGUNO'
 * en vez de '' (bug de la v25: todas las llamadas de ingesta reventaban con Bad Request).
 */
function schemaConProyectos_(root, base) {
  var schema = JSON.parse(JSON.stringify(base));
  var mapa = cargarProyectos_(root);
  var nombres = Object.keys(mapa).map(function (s) { return mapa[s].name; }).filter(Boolean);
  var props = schema.properties.eventos.items.properties;
  props.proyecto = { type: 'string', enum: nombres.concat(['OTRO', 'NINGUNO']) };
  props.proyecto_nuevo = { type: 'string' };
  return schema;
}

/** Nombre de proyecto que el LLM propuso para un evento (enum: canónico | 'OTRO' | 'NINGUNO'). */
function nombreProyectoEvento_(ev) {
  var v = str_(ev.proyecto);
  if (v === 'NINGUNO') return '';
  if (v === 'OTRO') return str_(ev.proyecto_nuevo);
  return v;
}

/** Una línea ⚠️ por nombre de proyecto rechazado por la compuerta (observabilidad del gate). */
function appendLogRechazos_(root, fecha, nombres) {
  if (!nombres || !nombres.length) return;
  var linea = '';
  nombres.forEach(function (n) {
    linea += '- ' + fecha + ' · ⚠️ proyecto rechazado por sanidad · ' + recorteTexto_(n, 40) + '\n';
  });
  appendArchivoBrain_(carpetaBrain_(root, ['wiki']), 'log.md', linea);
}

/** Sección de página wiki por tipo de evento. */
var SECCIONES_EVENTO_ = {
  avance:        'Avances',
  blocker:       'Blockers',
  riesgo:        'Riesgos',
  decision:      'Decisiones',
  contradiccion: 'Contradicciones',
  accion:        'Pendientes'        // action items (notas de Meet): semilla del follow-up futuro
};

// --- Entrada pública: la llama summaries-runtime cuando brain.enabled ---

/**
 * Resume la fila Y la ingiere al brain en un solo call. Devuelve el summary (mismo contrato que
 * la ruta clásica). La escritura al brain es best-effort: si falla, el summary igual se devuelve
 * (no rompe onFormSubmit).
 *
 * @param {string} sheetId
 * @param {Object} config    CONFIG completo (usa models.perRow, sheets.settings, brain)
 * @param {string} tipo      'daily' | 'weekly'
 * @param {Object} meta      { nombre, correo } de la persona (resuelto contra Equipo)
 * @param {Array}  pairs     [{q,a}] del reporte
 * @param {number} row       fila 1-based (para nombre único del raw)
 * @param {string} system    system-prompt del resumen ya compuesto
 * @param {string} [fecha]   YYYY-MM-DD del reporte; se omite en vivo (= hoy). El backfill pasa
 *                           la Marca temporal de la fila para fechar eventos/raw con fidelidad.
 * @return {string} summary
 */
function ingestarFila_(sheetId, config, tipo, meta, pairs, row, system, fecha) {
  var root;
  try {
    root = ensureBrainFolder_(sheetId, config);
  } catch (e) {
    // Sin carpeta no hay brain: cae a resumen simple para no perder el Summary.
    if (typeof Logger !== 'undefined') Logger.log('brain: no se pudo asegurar la carpeta (%s); resumen simple.', e);
    return callGemini_(config.models.perRow, system, formatQA_(pairs, meta));
  }

  var estadoPrevio = estadoPersonaPrevio_(root, meta);
  var user = construirUserIngest_(pairs, meta, estadoPrevio);
  // Schema por llamada (proyectos como enum) + temperatura 0: extracción de hechos, no creatividad.
  var raw = callGemini_(config.models.perRow, ingestSystem_(system), user,
    { responseSchema: schemaConProyectos_(root, INGEST_SCHEMA_), temperature: 0 });
  var parsed = parseIngest_(raw);

  try {
    escribirBrain_(root, config, tipo, meta, pairs, row, parsed, fecha);
  } catch (e) {
    if (typeof Logger !== 'undefined') Logger.log('brain: ingesta falló pero el summary sí se generó (%s).', e);
  }
  return parsed.summary || '';
}

// --- Prompt de ingesta ---

/** Añade al system del resumen la instrucción de emitir JSON { summary, eventos }. */
function ingestSystem_(baseSystem) {
  return String(baseSystem == null ? '' : baseSystem) + '\n\n' + [
    '--- EXTRACCIÓN PARA LA MEMORIA (además del resumen) ---',
    'Devuelve SOLO un JSON con dos campos:',
    '- "summary": el resumen ejecutivo de esta persona (como lo harías normalmente).',
    '- "eventos": lista de hechos atómicos del reporte. Cada evento:',
    '    { persona, proyecto, tipo, texto, confidence }',
    '  · tipo ∈ avance | blocker | riesgo | decision | contradiccion.',
    '  · persona: a quién refiere (por defecto, quien reporta).',
    '  · proyecto: elige EXACTAMENTE uno del catálogo permitido; si la iniciativa no está en el',
    '    catálogo, pon proyecto "OTRO" y SOLO el nombre propio (máximo 3-4 palabras) en',
    '    "proyecto_nuevo". Si no es evidente, pon proyecto "NINGUNO". NUNCA escribas razonamiento,',
    '    alternativas ni explicaciones dentro de ningún campo.',
    '  · texto: el hecho en una frase. confidence: 0..1.',
    '  · Usa "contradiccion" SOLO si el reporte contradice el ESTADO PREVIO que se te da abajo.',
    'No inventes eventos: si el reporte no da para alguno, deja la lista corta.'
  ].join('\n');
}

/** Bloque de usuario: datos del reporte + (si existe) estado previo de la persona para contradicciones. */
function construirUserIngest_(pairs, meta, estadoPrevio) {
  var base = formatQA_(pairs, meta);
  if (!estadoPrevio) return base;
  return base + '\n\n--- ESTADO PREVIO DE ' + (meta.nombre || meta.correo || 'la persona').toUpperCase() + ' ---\n' + estadoPrevio;
}

/** Lee la página wiki previa de la persona (recortada) para dar contexto de contradicción. */
function estadoPersonaPrevio_(root, meta) {
  var name = slugBrain_(meta.correo || meta.nombre);
  var page = leerArchivoBrain_(carpetaBrain_(root, ['wiki', 'people']), name + '.md');
  if (!page) return '';
  var body = parsearPagina_(page).body || '';
  return body.length > 1500 ? body.slice(0, 1500) + '…' : body;
}

/** Parsea el JSON del call; tolerante: si falla, summary = texto crudo y sin eventos. */
function parseIngest_(text) {
  var t = String(text == null ? '' : text).trim();
  try {
    var o = JSON.parse(t);
    return {
      summary: recorteTexto_(str_(o.summary), RESUMEN_MAX_),
      eventos: Array.isArray(o.eventos)
        ? o.eventos.filter(function (e) { return e && e.texto && e.tipo; }).map(truncarEvento_)
        : []
    };
  } catch (e) {
    return { summary: t, eventos: [] };
  }
}

/** Techos defensivos por evento: el texto se trunca (el hecho importa aunque venga verboso). */
function truncarEvento_(ev) {
  ev.texto = recorteTexto_(str_(ev.texto), EVENTO_TEXTO_MAX_);
  return ev;
}

// --- Escritura de las tres capas ---

function escribirBrain_(root, config, tipo, meta, pairs, row, parsed, fechaOverride) {
  var fecha = fechaOverride || hoyISO_(config);
  var eventos = parsed.eventos || [];

  // 1) raw/ inmutable.
  var source = guardarRaw_(root, config, tipo, meta, pairs, row, fecha);

  // 2) resolver proyectos y regenerar páginas de proyecto. La compuerta puede rechazar un
  //    nombre (null): el evento vive igual en la página de la persona, y el rechazo va al log.
  var proyectos = {};   // slug -> name
  var rechazados = [];
  eventos.forEach(function (ev) {
    ev._autorName = str_(meta.nombre) || str_(meta.correo);   // autor para viñetas de proyecto
  });
  eventos.forEach(function (ev) {
    var nombre = nombreProyectoEvento_(ev);
    if (!nombre) return;
    var p = resolverProyecto_(root, nombre);
    if (!p) { rechazados.push(nombre); return; }
    proyectos[p.slug] = p.name;
    ev._proyectoName = p.name;   // para renderizar en la página de persona
  });
  appendLogRechazos_(root, fecha, rechazados);
  Object.keys(proyectos).forEach(function (slug) {
    var evsProy = eventos.filter(function (ev) { return ev._proyectoName === proyectos[slug]; });
    regenerarPaginaProyecto_(root, slug, proyectos[slug], evsProy, source, fecha);
  });

  // 3) página de la persona (dueña del reporte).
  regenerarPaginaPersona_(root, meta, eventos, source, fecha, Object.keys(proyectos).map(function (s) { return proyectos[s]; }));

  // 4) bitácora + índice navegable al día.
  appendLogIngest_(root, fecha, tipo, meta, eventos);
  regenerarIndexBrain_(root, fecha);
}

/** Escribe una copia inmutable del reporte en raw/reports/. No pisa (nombre único por fila). */
function guardarRaw_(root, config, tipo, meta, pairs, row, fecha) {
  var carpeta = carpetaBrain_(root, ['raw', 'reports']);
  var name = fecha + '_' + slugBrain_(meta.correo || meta.nombre) + '_' + tipo + '_r' + row + '.md';
  var fm = {
    page_type: 'report', tipo: tipo, persona: meta.nombre || '', email: meta.correo || '',
    date: fecha, source_row: row
  };
  var body = '# Reporte ' + tipo + ' — ' + (meta.nombre || meta.correo || '') + ' (' + fecha + ')\n\n' +
    (pairs || []).map(function (p) { return '**' + p.q + '**\n' + p.a; }).join('\n\n');
  ensureArchivoBrain_(carpeta, name, componerPagina_(fm, body));   // inmutable: no sobrescribe
  return 'raw/reports/' + name;
}

/** Regenera (incremental) la página de una persona: mergea eventos por sección + frontmatter. */
function regenerarPaginaPersona_(root, meta, eventos, source, fecha, proyectoNames) {
  var carpeta = carpetaBrain_(root, ['wiki', 'people']);
  var name = slugBrain_(meta.correo || meta.nombre) + '.md';
  var prev = leerArchivoBrain_(carpeta, name);
  var page = prev ? parsearPagina_(prev) : { frontmatter: {}, body: '' };

  var blockers = eventos.filter(function (e) { return e.tipo === 'blocker'; }).map(function (e) { return e.texto; });
  var updates = {
    page_type: 'person',
    name: meta.nombre || meta.correo || '',
    email: meta.correo || '',
    last_updated: fecha,
    projects: proyectoNames || [],
    sources: [source],
    open_blockers: blockers
  };
  // Externos (notas de Meet): página propia pero marcada — el scan de silencios los ignora
  // (no reportan) y jamás reciben correos. Ver meet-notes-runtime.js.
  if (meta.external) updates.external = true;
  var fm = mergeFrontmatter_(page.frontmatter, updates);

  var body = mergearEventosEnBody_(page.body, eventos, fecha, true);
  escribirArchivoBrain_(carpeta, name, componerPagina_(fm, body));
}

/** Regenera (incremental) la página de un proyecto. */
function regenerarPaginaProyecto_(root, slug, name, eventos, source, fecha) {
  var carpeta = carpetaBrain_(root, ['wiki', 'projects']);
  var file = slug + '.md';
  var prev = leerArchivoBrain_(carpeta, file);
  var page = prev ? parsearPagina_(prev) : { frontmatter: {}, body: '' };

  var blockers = eventos.filter(function (e) { return e.tipo === 'blocker'; }).map(function (e) { return e.texto; });
  var fm = mergeFrontmatter_(page.frontmatter, {
    page_type: 'project',
    name: name,
    last_updated: fecha,
    sources: [source],
    open_blockers: blockers
  });

  var body = mergearEventosEnBody_(page.body, eventos, fecha, false);
  escribirArchivoBrain_(carpeta, file, componerPagina_(fm, body));
}

/** Anexa una línea por ingesta y una por contradicción a wiki/log.md. */
function appendLogIngest_(root, fecha, tipo, meta, eventos) {
  var wiki = carpetaBrain_(root, ['wiki']);
  var quien = meta.nombre || meta.correo || '(desconocido)';
  var linea = '- ' + fecha + ' · ingesta ' + tipo + ' · ' + quien + ' · ' + eventos.length + ' eventos\n';
  var contras = eventos.filter(function (e) { return e.tipo === 'contradiccion'; });
  contras.forEach(function (e) {
    linea += '  - ⚠️ contradicción · ' + quien + (e.proyecto ? ' · ' + e.proyecto : '') + ' · ' + e.texto + '\n';
  });
  appendArchivoBrain_(wiki, 'log.md', linea);
}

// --- Merge de eventos en el body por secciones (## Avances, ## Blockers, …) ---

/**
 * Inserta cada evento como bullet bajo su sección (dedup exacto). Con `conProyecto`, anota el
 * proyecto entre paréntesis (páginas de persona); en páginas de proyecto se omite.
 */
function mergearEventosEnBody_(body, eventos, fecha, conProyecto) {
  var parsed = parseBodySections_(body);
  (eventos || []).forEach(function (ev) {
    var seccion = SECCIONES_EVENTO_[ev.tipo];
    if (!seccion) return;
    // Página de persona: anota el proyecto. Página de proyecto: anota el AUTOR ('· por Nombre',
    // antes de cualquier sufijo de cierre ✓/✖ futuro) — así Actividad puede filtrar por autor.
    // Solo hacia adelante: las viñetas viejas sin autor son inatribuibles.
    var suf = conProyecto
      ? (ev._proyectoName ? ' (' + ev._proyectoName + ')' : '')
      : (ev._autorName ? ' · por ' + ev._autorName : '');
    var bullet = '- [' + fecha + '] ' + ev.texto + suf;
    upsertLineaSeccion_(parsed, seccion, bullet);
  });
  return renderBodySections_(parsed);
}

/** Divide un body markdown en { preamble, sections:[{name,lines[]}] } por encabezados '## '. */
function parseBodySections_(body) {
  var lines = String(body == null ? '' : body).split('\n');
  var preamble = [];
  var sections = [];
  var cur = null;
  for (var i = 0; i < lines.length; i++) {
    var m = /^##\s+(.*)$/.exec(lines[i]);
    if (m) { cur = { name: m[1].trim(), lines: [] }; sections.push(cur); }
    else if (cur) { cur.lines.push(lines[i]); }
    else { preamble.push(lines[i]); }
  }
  return { preamble: preamble, sections: sections };
}

/** Recompone el body desde la estructura de parseBodySections_. */
function renderBodySections_(parsed) {
  var out = [];
  var pre = (parsed.preamble || []).join('\n').replace(/\s+$/, '');
  if (pre) out.push(pre);
  (parsed.sections || []).forEach(function (s) {
    var cuerpo = s.lines.join('\n').replace(/^\n+|\n+$/g, '');
    out.push('## ' + s.name + (cuerpo ? '\n' + cuerpo : ''));
  });
  return out.join('\n\n') + '\n';
}

/** Agrega una línea al final de una sección (creándola si falta); ignora duplicados exactos. */
function upsertLineaSeccion_(parsed, seccion, linea) {
  var s = null;
  for (var i = 0; i < parsed.sections.length; i++) {
    if (parsed.sections[i].name === seccion) { s = parsed.sections[i]; break; }
  }
  if (!s) { s = { name: seccion, lines: [] }; parsed.sections.push(s); }
  var existe = s.lines.some(function (l) { return l.trim() === linea.trim(); });
  if (!existe) s.lines.push(linea);
}

// --- Frontmatter merge (arrays se unen deduplicando; escalares se sobrescriben) ---

function mergeFrontmatter_(prev, updates) {
  var out = {};
  Object.keys(prev || {}).forEach(function (k) { out[k] = prev[k]; });
  Object.keys(updates || {}).forEach(function (k) {
    var v = updates[k];
    if (Array.isArray(v)) {
      var base = Array.isArray(out[k]) ? out[k].slice() : [];
      v.forEach(function (item) { if (item && base.indexOf(item) === -1) base.push(item); });
      out[k] = base;
    } else {
      out[k] = v;
    }
  });
  return out;
}

// --- Resolución de proyectos (match difuso + alias + autocreate) ---

/** Carga el mapa de alias de proyectos (canonicalSlug -> {name, aliases[]}). */
function cargarProyectos_(root) {
  var carpeta = carpetaBrain_(root, ['wiki', 'projects']);
  var raw = leerArchivoBrain_(carpeta, '_projects.json');
  if (!raw) return {};
  try { var o = JSON.parse(raw); return (o && typeof o === 'object') ? o : {}; } catch (e) { return {}; }
}

function guardarProyectos_(root, mapa) {
  var carpeta = carpetaBrain_(root, ['wiki', 'projects']);
  escribirArchivoBrain_(carpeta, '_projects.json', JSON.stringify(mapa, null, 2));
}

/** Similitud Jaccard entre dos slugs por tokens ('-'). 1 = idénticos. */
function similitudSlug_(a, b) {
  var A = String(a).split('-').filter(Boolean);
  var B = String(b).split('-').filter(Boolean);
  if (!A.length || !B.length) return 0;
  var setB = {};
  B.forEach(function (t) { setB[t] = true; });
  var inter = 0;
  var seen = {};
  A.forEach(function (t) { if (setB[t] && !seen[t]) { inter++; seen[t] = true; } });
  var union = {};
  A.concat(B).forEach(function (t) { union[t] = true; });
  return inter / Object.keys(union).length;
}

var PROYECTO_SIMIL_MIN_ = 0.6;   // umbral de match difuso

// Ruido que no distingue proyectos: se filtra ANTES de comparar slugs (no del slug persistido).
var STOPWORDS_SLUG_ = { de: 1, del: 1, la: 1, el: 1, los: 1, las: 1, en: 1, y: 1, o: 1, un: 1,
  una: 1, para: 1, con: 1, the: 1, of: 1, in: 1, and: 1, or: 1, for: 1, a: 1, an: 1,
  proyecto: 1, project: 1, iniciativa: 1 };

/** Slug sin stopwords, solo para COMPARAR. Si todo era stopword, se queda como estaba. */
function slugComparable_(slug) {
  var tokens = String(slug).split('-').filter(function (t) { return t && !STOPWORDS_SLUG_[t]; });
  return tokens.length ? tokens.join('-') : String(slug);
}

/**
 * Resuelve un nombre de proyecto a una entidad canónica: compuerta de sanidad (null si el nombre
 * huele a fuga del LLM), match exacto por slug/alias, luego difuso (contención de tokens o
 * Jaccard ≥ umbral, ambos sin stopwords) registrando el alias; si nada matchea, autocrea.
 * Persiste el mapa. ÚNICO punto por el que un string del LLM puede crear una entidad de proyecto.
 * @return {{slug:string, name:string}|null} null = rechazado por la compuerta.
 */
function resolverProyecto_(root, nombre) {
  var limpio = sanitizarProyecto_(nombre);
  if (!limpio) return null;

  var mapa = cargarProyectos_(root);
  var slug = slugBrain_(limpio);

  // exacto: canonical o alias
  var canon = Object.keys(mapa);
  for (var i = 0; i < canon.length; i++) {
    var c = canon[i];
    if (c === slug || (mapa[c].aliases || []).indexOf(slug) > -1) {
      return { slug: c, name: mapa[c].name };
    }
  }
  // difuso, sin stopwords: contención ("ai-academy" ⊂ "ai-academy-web") pesa como match total.
  var cmp = slugComparable_(slug);
  var mejor = null, mejorSim = 0;
  for (var j = 0; j < canon.length; j++) {
    var cmpCanon = slugComparable_(canon[j]);
    var sim = similitudSlug_(cmpCanon, cmp);
    if (slugContenido_(cmpCanon, cmp)) sim = Math.max(sim, 1);
    if (sim > mejorSim) { mejorSim = sim; mejor = canon[j]; }
  }
  if (mejor && mejorSim >= PROYECTO_SIMIL_MIN_) {
    if (slug !== mejor && (mapa[mejor].aliases || []).indexOf(slug) === -1) {
      mapa[mejor].aliases = (mapa[mejor].aliases || []).concat([slug]);
      guardarProyectos_(root, mapa);
    }
    return { slug: mejor, name: mapa[mejor].name };
  }
  // autocreate (ya saneado por la compuerta)
  mapa[slug] = { name: limpio, aliases: [] };
  guardarProyectos_(root, mapa);
  return { slug: slug, name: mapa[slug].name };
}

// --- Fecha ---

/** Fecha de hoy en la zona del config (YYYY-MM-DD). */
function hoyISO_(config) {
  var tz = (config && config.timezone) || 'America/Lima';
  return Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
}
