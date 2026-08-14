/**
 * brain-admin-runtime.js — Administración y gobernanza del second brain (Fase 4).
 *
 * Dos audiencias:
 *  - El sidebar (vía cosRun→dispatch): visor de la wiki (listar/leer páginas), merge de proyectos
 *    duplicados, toggles de los feature flags y "olvidar" a una persona (borra su página + su raw).
 *  - El dispatcher: purga del raw/ por retención (purgarRaw_), 1×/día.
 *
 * Todas las rutas de lectura/escritura pasan por brain-drive-runtime.js (I/O) y respetan el mismo
 * modelo: el estado vive en el frontmatter; wiki/ es regenerable, raw/ es la verdad de origen (y
 * por eso "olvidar" y "purgar" son las ÚNICAS operaciones que lo borran, de forma explícita).
 *
 * Sin import/export: runtime de Apps Script. Privados con sufijo "_".
 */

var WIKI_TIPOS_ = { people: true, projects: true, meetings: true };

/** Valida un nombre de archivo de la wiki (evita path traversal desde el cliente). */
function nombreArchivoSeguro_(name) {
  var s = str_(name);
  if (!s || s.indexOf('/') > -1 || s.indexOf('\\') > -1 || s.indexOf('..') > -1) {
    throw new Error('Nombre de archivo inválido: ' + s);
  }
  return s;
}

function carpetaWiki_(root, tipo) {
  if (!WIKI_TIPOS_[tipo]) throw new Error('Tipo de wiki desconocido: ' + tipo);
  return carpetaBrain_(root, ['wiki', tipo]);
}

// --- Visor de la wiki (sidebar) ---

/**
 * Lista las páginas de una carpeta de la wiki con lo justo para pintar la lista: nombre,
 * last_updated, blockers abiertos y una línea de resumen (primer párrafo del body). Público.
 * @param {string} tipo  'people' | 'projects' | 'meetings'
 * @return {Array<{file,name,last_updated,open_blockers,resumen}>}
 */
function listarWikiPaginas(sheetId, config, tipo) {
  var root = ensureBrainFolder_(sheetId, config);
  var carpeta = carpetaWiki_(root, tipo);
  var out = [];
  listarArchivosBrain_(carpeta, '.md').forEach(function (a) {
    if (a.name.charAt(0) === '_') return;   // _projects.json u otros internos
    var pg = parsearPagina_(a.content);
    var fm = pg.frontmatter || {};
    out.push({
      file: a.name,
      name: str_(fm.name) || a.name,
      last_updated: str_(fm.last_updated) || str_(fm.date),
      open_blockers: Array.isArray(fm.open_blockers) ? fm.open_blockers : [],
      resumen: primerParrafo_(pg.body)
    });
  });
  out.sort(function (x, y) { return str_(y.last_updated).localeCompare(str_(x.last_updated)); });
  return out;
}

/** Lee una página completa de la wiki (frontmatter + body). Público. */
function leerWikiPagina(sheetId, config, tipo, file) {
  var root = ensureBrainFolder_(sheetId, config);
  var carpeta = carpetaWiki_(root, tipo);
  var contenido = leerArchivoBrain_(carpeta, nombreArchivoSeguro_(file));
  if (contenido == null) throw new Error('Página no encontrada: ' + file);
  var pg = parsearPagina_(contenido);
  return { file: file, tipo: tipo, frontmatter: pg.frontmatter, body: pg.body };
}

/** Primera línea de contenido real del body (ignora encabezados y viñetas), recortada. */
function primerParrafo_(body) {
  var lines = str_(body).split('\n');
  for (var i = 0; i < lines.length; i++) {
    var l = lines[i].trim();
    if (!l || l.charAt(0) === '#') continue;
    l = l.replace(/^[-*]\s+/, '').replace(/^\[[0-9-]+\]\s*/, '');
    if (l) return l.length > 160 ? l.slice(0, 160) + '…' : l;
  }
  return '';
}

// --- Merge de proyectos duplicados (sidebar) ---

/**
 * Fusiona la página de proyecto `origenFile` en `destinoFile`: une frontmatter (arrays) y las
 * secciones del body, manda `origen` a la papelera y registra el alias en _projects.json para que
 * las ingestas futuras del nombre viejo caigan en el proyecto destino. Público.
 * @return {{ok:boolean, destino:string, origen:string}}
 */
function mergearProyectos(sheetId, config, origenFile, destinoFile) {
  var root = ensureBrainFolder_(sheetId, config);
  var carpeta = carpetaBrain_(root, ['wiki', 'projects']);
  var oName = nombreArchivoSeguro_(origenFile), dName = nombreArchivoSeguro_(destinoFile);
  if (oName === dName) throw new Error('Origen y destino son el mismo proyecto.');

  var oRaw = leerArchivoBrain_(carpeta, oName), dRaw = leerArchivoBrain_(carpeta, dName);
  if (oRaw == null) throw new Error('Proyecto origen no encontrado: ' + oName);
  if (dRaw == null) throw new Error('Proyecto destino no encontrado: ' + dName);

  var o = parsearPagina_(oRaw), d = parsearPagina_(dRaw);

  // Frontmatter: los arrays del origen se unen al destino; el name/last_updated del destino manda.
  var fm = mergeFrontmatter_(d.frontmatter, {
    sources: Array.isArray(o.frontmatter.sources) ? o.frontmatter.sources : [],
    open_blockers: Array.isArray(o.frontmatter.open_blockers) ? o.frontmatter.open_blockers : []
  });
  // Body: mete cada viñeta del origen bajo su sección en el destino (dedup exacto).
  var parsed = parseBodySections_(d.body);
  parseBodySections_(o.body).sections.forEach(function (s) {
    s.lines.forEach(function (l) { if (l.trim()) upsertLineaSeccion_(parsed, s.name, l.trim()); });
  });
  escribirArchivoBrain_(carpeta, dName, componerPagina_(fm, renderBodySections_(parsed)));
  borrarArchivoBrain_(carpeta, oName);

  // Registro de alias: el slug origen pasa a ser alias del destino (y deja de ser canónico).
  var oSlug = oName.replace(/\.md$/, ''), dSlug = dName.replace(/\.md$/, '');
  var mapa = cargarProyectos_(root);
  if (!mapa[dSlug]) mapa[dSlug] = { name: str_(fm.name) || dSlug, aliases: [] };
  mapa[dSlug].aliases = (mapa[dSlug].aliases || []);
  [oSlug].concat((mapa[oSlug] && mapa[oSlug].aliases) || []).forEach(function (al) {
    if (al !== dSlug && mapa[dSlug].aliases.indexOf(al) === -1) mapa[dSlug].aliases.push(al);
  });
  delete mapa[oSlug];
  guardarProyectos_(root, mapa);

  var wiki = carpetaBrain_(root, ['wiki']);
  appendArchivoBrain_(wiki, 'log.md', '- ' + hoyISO_(config) + ' · merge de proyecto · ' + oSlug + ' → ' + dSlug + '\n');
  regenerarIndexBrain_(root, hoyISO_(config));
  return { ok: true, destino: dName, origen: oName };
}

// --- Feature flags (sidebar) ---

var FLAGS_PERMITIDOS_ = {
  'brain.enabled': 'bool', 'deepPrep.enabled': 'bool',
  'deepPrep.leadHours': 'int', 'brain.silenceDays': 'int', 'brain.retentionMonths': 'int',
  'meet.enabled': 'bool', 'meet.lookbackDays': 'int'
};

/**
 * Persiste los feature flags del brain/Deep Prep desde el sidebar. Solo acepta claves conocidas y
 * las normaliza (bool → 'true'/'false'; int → entero como texto). Público.
 * @param {Object} flags  subconjunto de FLAGS_PERMITIDOS_
 * @return {{ok:boolean, aplicados:string[]}}
 */
function guardarFlags(sheetId, config, flags) {
  var updates = {}, aplicados = [];
  Object.keys(flags || {}).forEach(function (k) {
    var tipo = FLAGS_PERMITIDOS_[k];
    if (!tipo) return;   // ignora claves no permitidas
    updates[k] = (tipo === 'bool') ? (bool_(flags[k]) ? 'true' : 'false') : String(int_(flags[k], 0));
    aplicados.push(k);
  });
  if (aplicados.length) setAjustes_(sheetId, config.sheets.settings, updates);
  return { ok: true, aplicados: aplicados };
}

// --- "Olvidar" a una persona (gobernanza / derecho al olvido) ---

/**
 * Borra la página wiki de una persona y TODO su raw/ (los reportes que la originan). Deja rastro
 * en el log (auditoría de la propia eliminación). Público.
 * @param {string} file  nombre de archivo en wiki/people (p.ej. 'ada-x-com.md')
 * @return {{ok:boolean, email:string, raw_borrados:number}}
 */
function olvidarPersona(sheetId, config, file) {
  var root = ensureBrainFolder_(sheetId, config);
  var people = carpetaBrain_(root, ['wiki', 'people']);
  var name = nombreArchivoSeguro_(file);

  var contenido = leerArchivoBrain_(people, name);
  if (contenido == null) throw new Error('Persona no encontrada: ' + name);
  var fm = parsearPagina_(contenido).frontmatter || {};
  var email = str_(fm.email);

  borrarArchivoBrain_(people, name);

  // Raw: los reportes guardan `email` en el frontmatter; borra los que coincidan.
  var raws = carpetaBrain_(root, ['raw', 'reports']);
  var borrados = 0;
  listarArchivosBrain_(raws, '.md').forEach(function (a) {
    var rfm = parsearPagina_(a.content).frontmatter || {};
    if (email && str_(rfm.email) === email) borrados += borrarArchivoBrain_(raws, a.name);
  });

  var wiki = carpetaBrain_(root, ['wiki']);
  appendArchivoBrain_(wiki, 'log.md',
    '- ' + hoyISO_(config) + ' · 🗑️ olvidar persona · ' + (str_(fm.name) || name) +
    ' · ' + borrados + ' raw borrado(s)\n');
  regenerarIndexBrain_(root, hoyISO_(config));
  return { ok: true, email: email, raw_borrados: borrados };
}

// --- "Olvidar" un proyecto (gobernanza: entidades basura o descontinuadas) ---

/**
 * Borra la página wiki de un proyecto y su entrada en _projects.json (canónico + aliases, y
 * purga el slug como alias de otros). El raw/ NO se toca: los reportes/notas de origen son
 * verdad histórica de personas y reuniones, no del proyecto. Deja rastro en el log. Público.
 * @param {string} file  nombre de archivo en wiki/projects (p.ej. 'ai-academy.md')
 * @return {{ok:boolean, name:string}}
 */
function olvidarProyecto(sheetId, config, file) {
  var root = ensureBrainFolder_(sheetId, config);
  var carpeta = carpetaBrain_(root, ['wiki', 'projects']);
  var name = nombreArchivoSeguro_(file);

  var contenido = leerArchivoBrain_(carpeta, name);
  if (contenido == null) throw new Error('Proyecto no encontrado: ' + name);
  var fm = parsearPagina_(contenido).frontmatter || {};

  borrarArchivoBrain_(carpeta, name);

  var slug = name.replace(/\.md$/, '');
  var mapa = cargarProyectos_(root);
  delete mapa[slug];
  // Por si el slug quedó registrado como alias de otro canónico (merge previo): purgarlo.
  Object.keys(mapa).forEach(function (c) {
    if (mapa[c].aliases && mapa[c].aliases.indexOf(slug) > -1) {
      mapa[c].aliases = mapa[c].aliases.filter(function (al) { return al !== slug; });
    }
  });
  guardarProyectos_(root, mapa);

  appendArchivoBrain_(carpetaBrain_(root, ['wiki']), 'log.md',
    '- ' + hoyISO_(config) + ' · 🗑️ olvidar proyecto · ' + (str_(fm.name) || slug) + '\n');
  regenerarIndexBrain_(root, hoyISO_(config));
  return { ok: true, name: str_(fm.name) || slug };
}

// --- Gobernanza: purga del raw/ por retención (dispatcher) ---

/**
 * Manda a la papelera los reportes de raw/reports/ más antiguos que `brain.retentionMonths`.
 * Best-effort; deja una línea en el log si borró algo. La llama el dispatcher 1×/día.
 * @return {number} archivos purgados.
 */
function purgarRaw_(sheetId, config, now) {
  var root = ensureBrainFolder_(sheetId, config);
  var meses = (config.brain && config.brain.retentionMonths) || 12;
  var tz = config.timezone;
  var corte = new Date(now || new Date());
  corte.setMonth(corte.getMonth() - meses);
  var corteISO = Utilities.formatDate(corte, tz, 'yyyy-MM-dd');
  var corteUTC = isoAUTC_(corteISO);

  var purgados = 0;
  // Ambas capas de raw caen bajo la misma retención: reportes (daily/weekly) y notas de Meet.
  ['reports', 'meetings'].forEach(function (sub) {
    var carpeta = carpetaBrain_(root, ['raw', sub]);
    listarArchivosBrain_(carpeta, '.md').forEach(function (a) {
      var fecha = str_(parsearPagina_(a.content).frontmatter.date);
      var u = isoAUTC_(fecha);
      if (u != null && u < corteUTC) purgados += borrarArchivoBrain_(carpeta, a.name);
    });
  });

  if (purgados) {
    appendArchivoBrain_(carpetaBrain_(root, ['wiki']), 'log.md',
      '- ' + Utilities.formatDate(now || new Date(), tz, 'yyyy-MM-dd') +
      ' · 🧹 purga de raw · ' + purgados + ' reporte(s) anteriores a ' + corteISO + '\n');
  }
  return purgados;
}
