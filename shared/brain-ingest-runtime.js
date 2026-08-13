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
  var raw = callGemini_(config.models.perRow, ingestSystem_(system), user, { responseSchema: INGEST_SCHEMA_ });
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
    '  · persona: a quién refiere (por defecto, quien reporta). proyecto: el proyecto/iniciativa.',
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
      summary: str_(o.summary),
      eventos: Array.isArray(o.eventos) ? o.eventos.filter(function (e) { return e && e.texto && e.tipo; }) : []
    };
  } catch (e) {
    return { summary: t, eventos: [] };
  }
}

// --- Escritura de las tres capas ---

function escribirBrain_(root, config, tipo, meta, pairs, row, parsed, fechaOverride) {
  var fecha = fechaOverride || hoyISO_(config);
  var eventos = parsed.eventos || [];

  // 1) raw/ inmutable.
  var source = guardarRaw_(root, config, tipo, meta, pairs, row, fecha);

  // 2) resolver proyectos y regenerar páginas de proyecto.
  var proyectos = {};   // slug -> name
  eventos.forEach(function (ev) {
    if (!ev.proyecto) return;
    var p = resolverProyecto_(root, ev.proyecto);
    proyectos[p.slug] = p.name;
    ev._proyectoName = p.name;   // para renderizar en la página de persona
  });
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
    var suf = (conProyecto && ev._proyectoName) ? ' (' + ev._proyectoName + ')' : '';
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

/**
 * Resuelve un nombre de proyecto a una entidad canónica: match exacto por slug/alias, luego match
 * difuso (Jaccard ≥ umbral) registrando el alias; si nada matchea, autocrea. Persiste el mapa.
 * @return {{slug:string, name:string}}
 */
function resolverProyecto_(root, nombre) {
  var mapa = cargarProyectos_(root);
  var slug = slugBrain_(nombre);

  // exacto: canonical o alias
  var canon = Object.keys(mapa);
  for (var i = 0; i < canon.length; i++) {
    var c = canon[i];
    if (c === slug || (mapa[c].aliases || []).indexOf(slug) > -1) {
      return { slug: c, name: mapa[c].name };
    }
  }
  // difuso
  var mejor = null, mejorSim = 0;
  for (var j = 0; j < canon.length; j++) {
    var sim = similitudSlug_(canon[j], slug);
    if (sim > mejorSim) { mejorSim = sim; mejor = canon[j]; }
  }
  if (mejor && mejorSim >= PROYECTO_SIMIL_MIN_) {
    if (slug !== mejor && (mapa[mejor].aliases || []).indexOf(slug) === -1) {
      mapa[mejor].aliases = (mapa[mejor].aliases || []).concat([slug]);
      guardarProyectos_(root, mapa);
    }
    return { slug: mejor, name: mapa[mejor].name };
  }
  // autocreate
  mapa[slug] = { name: String(nombre).trim(), aliases: [] };
  guardarProyectos_(root, mapa);
  return { slug: slug, name: mapa[slug].name };
}

// --- Fecha ---

/** Fecha de hoy en la zona del config (YYYY-MM-DD). */
function hoyISO_(config) {
  var tz = (config && config.timezone) || 'America/Lima';
  return Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
}
