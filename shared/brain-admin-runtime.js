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
      resumen: primerParrafo_(pg.body),
      status: str_(fm.status),                    // 'closed' = proyecto archivado (fuera de alertas)
      external: String(fm.external) === 'true'    // solo personas: contacto de Meet que no reporta
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
  cacheInvalidar_(sheetId, CACHE_SEGUIMIENTO_);
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
  cacheInvalidar_(sheetId, CACHE_SEGUIMIENTO_);
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
  cacheInvalidar_(sheetId, CACHE_SEGUIMIENTO_);
  return { ok: true, name: str_(fm.name) || slug };
}

// --- Curación de proyectos (sidebar): renombrar (completo) y cerrar/reabrir ---

/**
 * Renombra un proyecto de forma COMPLETA: cambia el `name` visible, el identificador (slug) y el
 * nombre del archivo .md en wiki/projects, migra la entrada canónica de _projects.json (el slug
 * viejo queda como ALIAS, para que ingestas futuras del nombre anterior sigan cayendo aquí) y
 * reetiqueta las tareas que referencian el proyecto por nombre (hoja Tareas + wiki/tasks + índice).
 * Las menciones en el texto histórico de personas/actas NO se reescriben: son verdad histórica y el
 * alias cubre las ingestas futuras (mismo criterio que `mergearProyectos`). Público.
 * @param {string} file          nombre de archivo actual (p.ej. 'ai-platform.md')
 * @param {string} nuevoNombre   nombre visible nuevo
 * @return {{ok:boolean, name:string, file:string, slugChanged:boolean, tareas:number}}
 */
function renombrarProyecto(sheetId, config, file, nuevoNombre) {
  var root = ensureBrainFolder_(sheetId, config);
  var carpeta = carpetaBrain_(root, ['wiki', 'projects']);
  var oldFile = nombreArchivoSeguro_(file);
  var nuevo = str_(nuevoNombre).trim();
  if (!nuevo) throw new Error('El nombre no puede quedar vacío.');

  var oldRaw = leerArchivoBrain_(carpeta, oldFile);
  if (oldRaw == null) throw new Error('Proyecto no encontrado: ' + oldFile);
  var page = parsearPagina_(oldRaw);
  var oldSlug = oldFile.replace(/\.md$/, '');
  var oldName = str_((page.frontmatter || {}).name) || oldSlug;

  var newSlug = slugBrain_(nuevo);
  var newFile = newSlug + '.md';
  var slugChanged = newSlug !== oldSlug;

  // Colisión: renombrar hacia un slug que ya es otro proyecto sería una fusión encubierta.
  if (slugChanged && leerArchivoBrain_(carpeta, newFile) != null) {
    throw new Error('Ya existe un proyecto con ese nombre. Usa «Fusionar» para combinarlos.');
  }

  // 1) Página .md: nuevo name; si cambió el slug, se escribe en el archivo nuevo y se borra el viejo.
  escribirArchivoBrain_(carpeta, newFile, componerPagina_(mergeFrontmatter_(page.frontmatter, { name: nuevo }), page.body));
  if (slugChanged) borrarArchivoBrain_(carpeta, oldFile);

  // 2) Catálogo: mueve el canónico oldSlug → newSlug (aliases preservados; el slug viejo pasa a alias).
  var mapa = cargarProyectos_(root);
  var prev = mapa[oldSlug] || { name: oldName, aliases: [] };
  var aliases = (prev.aliases || []).slice();
  if (slugChanged && aliases.indexOf(oldSlug) === -1) aliases.push(oldSlug);
  if (mapa[newSlug]) (mapa[newSlug].aliases || []).forEach(function (al) { if (aliases.indexOf(al) === -1) aliases.push(al); });
  aliases = aliases.filter(function (al) { return al !== newSlug; });
  if (slugChanged) delete mapa[oldSlug];
  mapa[newSlug] = { name: nuevo, aliases: aliases };
  // Por si el nuevo slug estaba registrado como alias de otro canónico (merge previo): purgarlo.
  Object.keys(mapa).forEach(function (c) {
    if (c !== newSlug && mapa[c].aliases && mapa[c].aliases.indexOf(newSlug) > -1) {
      mapa[c].aliases = mapa[c].aliases.filter(function (al) { return al !== newSlug; });
    }
  });
  guardarProyectos_(root, mapa);

  // 3) Tareas que referencian el proyecto por NOMBRE (match exacto): hoja + wiki/tasks + índice.
  var tareas = renombrarProyectoEnTareas_(sheetId, config, root, oldName, nuevo);

  appendArchivoBrain_(carpetaBrain_(root, ['wiki']), 'log.md',
    '- ' + hoyISO_(config) + ' · ✏️ renombrar proyecto · ' + oldName + ' → ' + nuevo +
    (slugChanged ? ' (' + oldSlug + ' → ' + newSlug + ')' : '') + ' · ' + tareas + ' tarea(s)\n');
  regenerarIndexBrain_(root, hoyISO_(config));
  cacheInvalidar_(sheetId, CACHE_SEGUIMIENTO_.concat(CACHE_MISEGUIMIENTO_));
  return { ok: true, name: nuevo, file: newFile, slugChanged: slugChanged, tareas: tareas };
}

/** Reetiqueta el proyecto (match exacto por nombre) en la hoja Tareas, wiki/tasks y _tasks.json. */
function renombrarProyectoEnTareas_(sheetId, config, root, oldName, newName) {
  var n = 0;
  // Hoja Tareas (columna 2 = Proyecto).
  try {
    var sh = ensureTareasSheet_(sheetId, config);
    listarTareas_(sheetId, config).forEach(function (t) {
      if (t.proyecto === oldName) { sh.getRange(t.fila, 2).setValue(newName); n++; }
    });
  } catch (e) { /* sin hoja Tareas todavía */ }

  // wiki/tasks: frontmatter `project` (páginas activas y archivadas).
  var carpeta = carpetaBrain_(root, ['wiki', 'tasks']);
  listarArchivosBrain_(carpeta, '.md').forEach(function (a) {
    if (a.name.charAt(0) === '_') return;
    var pg = parsearPagina_(a.content);
    if (str_((pg.frontmatter || {}).project) === oldName) {
      escribirArchivoBrain_(carpeta, a.name, componerPagina_(mergeFrontmatter_(pg.frontmatter, { project: newName }), pg.body));
    }
  });
  // Índice _tasks.json: reconstruir desde las páginas ya corregidas (idempotente).
  try { reconstruirIndiceTareas_(root); } catch (e) { /* sin tareas todavía */ }
  return n;
}

/**
 * Marca/desmarca un proyecto como CERRADO (`status: closed` en el frontmatter). Un proyecto cerrado
 * conserva TODO su historial, pero queda fuera de las alertas de silencio del Morning Briefing, del
 * scan del dispatcher y de la Actividad del Seguimiento. Reversible. Público.
 * @param {string}  file     nombre de archivo en wiki/projects
 * @param {boolean} cerrado  true = cerrar/archivar; false = reabrir
 * @return {{ok:boolean, name:string, cerrado:boolean}}
 */
function cerrarProyecto(sheetId, config, file, cerrado) {
  var root = ensureBrainFolder_(sheetId, config);
  var carpeta = carpetaBrain_(root, ['wiki', 'projects']);
  var name = nombreArchivoSeguro_(file);
  var raw = leerArchivoBrain_(carpeta, name);
  if (raw == null) throw new Error('Proyecto no encontrado: ' + name);
  var page = parsearPagina_(raw);
  var cerrar = bool_(cerrado);

  var fm;
  if (cerrar) {
    fm = mergeFrontmatter_(page.frontmatter, { status: 'closed', closed_on: hoyISO_(config) });
  } else {
    fm = mergeFrontmatter_(page.frontmatter, { status: 'active' });
    delete fm.closed_on;
  }
  escribirArchivoBrain_(carpeta, name, componerPagina_(fm, page.body));

  appendArchivoBrain_(carpetaBrain_(root, ['wiki']), 'log.md',
    '- ' + hoyISO_(config) + ' · ' + (cerrar ? '✅ cerrar' : '↩ reabrir') + ' proyecto · ' +
    (str_(fm.name) || name.replace(/\.md$/, '')) + '\n');
  regenerarIndexBrain_(root, hoyISO_(config));
  cacheInvalidar_(sheetId, CACHE_SEGUIMIENTO_);
  return { ok: true, name: str_(fm.name) || name.replace(/\.md$/, ''), cerrado: cerrar };
}

// --- Reparación del wiki (gobernanza): reconciliar estructuras viejas con el contrato actual ---
//
// Wikis creados por versiones anteriores pueden tener páginas de persona sin `email:` en el
// frontmatter, con slug de NOMBRE en vez de correo, o marcadas `external: true` por el matching
// débil de nombres de las notas de Meet — y entonces el Seguimiento no las atribuye al roster
// (Personas "sin datos", Flujo en ceros, Actividad solo con proyectos). Estas dos rutinas son el
// botón de update: `diagnosticarWiki` (solo lectura) y `repararWiki` (reconciliación idempotente
// y NO destructiva: fusiona con dedup, corrige frontmatter, regenera catálogos e índices).

/**
 * Radiografía del wiki vs el roster, solo lectura. Público (sidebar).
 * @return {{personas:{paginas,matchean,sinEmail,externas,fusionables}, proyectos:{paginas,catalogados}, catalogos:{people,projects,tasks}}}
 */
function diagnosticarWiki(sheetId, config) {
  var root = ensureBrainFolder_(sheetId, config);
  var roster = [];
  try { roster = getRoster_(sheetId, config.sheets.roster); } catch (e) { roster = []; }

  var out = {
    personas: { paginas: 0, matchean: 0, sinEmail: 0, externas: 0, fusionables: 0 },
    proyectos: { paginas: 0, catalogados: 0 },
    catalogos: {
      people: leerArchivoBrain_(carpetaBrain_(root, ['wiki', 'people']), '_people.json') != null,
      projects: leerArchivoBrain_(carpetaBrain_(root, ['wiki', 'projects']), '_projects.json') != null,
      tasks: leerArchivoBrain_(carpetaBrain_(root, ['wiki', 'tasks']), '_tasks.json') != null
    }
  };
  var correos = {};
  roster.forEach(function (p) { correos[String(p.correo).toLowerCase()] = true; });

  listarArchivosBrain_(carpetaBrain_(root, ['wiki', 'people']), '.md').forEach(function (a) {
    if (a.name.charAt(0) === '_') return;
    out.personas.paginas++;
    var fm = parsearPagina_(a.content).frontmatter || {};
    var email = str_(fm.email).toLowerCase();
    var externa = String(fm.external) === 'true';
    if (externa) out.personas.externas++;
    if (!email) out.personas.sinEmail++;
    if (email && correos[email] && !externa && a.name === slugBrain_(email) + '.md') out.personas.matchean++;
    else if (rosterDePagina_(roster, fm, a.name)) out.personas.fusionables++;
  });

  var mapaP = cargarProyectos_(root);
  listarArchivosBrain_(carpetaBrain_(root, ['wiki', 'projects']), '.md').forEach(function (a) {
    if (a.name.charAt(0) === '_') return;
    out.proyectos.paginas++;
    if (mapaP[a.name.replace(/\.md$/, '')]) out.proyectos.catalogados++;
  });
  return out;
}

/**
 * Repara el wiki contra el contrato actual. Idempotente (una segunda corrida no toca nada).
 * 1) Personas: páginas que corresponden a alguien del roster (por email, o por nombre con match
 *    ÚNICO) se fusionan en la página canónica por correo, con frontmatter corregido.
 * 2) Catálogos: _projects.json gana las páginas no catalogadas y purga huérfanos (aliases se
 *    preservan); _people.json queda solo con las externas reales.
 * 3) Índices: _tasks.json reconstruido + index.md regenerado. Deja rastro en log.md. Público.
 * @return {{personasFusionadas, personasCorregidas, proyectosCatalogados, huerfanosPurgados}}
 */
function repararWiki(sheetId, config) {
  var root = ensureBrainFolder_(sheetId, config);
  var hoy = hoyISO_(config);
  var roster = [];
  try { roster = getRoster_(sheetId, config.sheets.roster); } catch (e) { roster = []; }
  var people = carpetaBrain_(root, ['wiki', 'people']);
  var informe = { personasFusionadas: 0, personasCorregidas: 0, proyectosCatalogados: 0, huerfanosPurgados: 0 };

  // 1) Personas → canónicas por correo del roster.
  listarArchivosBrain_(people, '.md').forEach(function (a) {
    if (a.name.charAt(0) === '_') return;
    var page = parsearPagina_(a.content);
    var fm = page.frontmatter || {};
    var miembro = rosterDePagina_(roster, fm, a.name);
    if (!miembro) return;   // externa real o ex-miembro: no se toca

    var canonName = slugBrain_(miembro.correo) + '.md';
    if (a.name === canonName) {
      // Archivo correcto: solo corregir frontmatter si está mal marcado.
      if (String(fm.external) === 'true' || str_(fm.email).toLowerCase() !== String(miembro.correo).toLowerCase()) {
        var fm1 = mergeFrontmatter_(fm, { email: miembro.correo, name: miembro.nombre || fm.name, last_updated: hoy });
        delete fm1.external;
        escribirArchivoBrain_(people, a.name, componerPagina_(fm1, page.body));
        informe.personasCorregidas++;
      }
      return;
    }
    // Archivo con slug viejo (nombre) → fusionar en la canónica y borrar el origen.
    fusionarPaginaEn_(people, a, canonName, {
      page_type: 'person', name: miembro.nombre || str_(fm.name), email: miembro.correo, last_updated: hoy
    });
    purgarDePersonasExt_(root, a.name.replace(/\.md$/, ''));
    informe.personasFusionadas++;
  });

  // 2) Catálogo de proyectos: páginas sin entrada → se catalogan; entradas sin página → fuera.
  var mapaP = cargarProyectos_(root);
  var slugsConPagina = {};
  listarArchivosBrain_(carpetaBrain_(root, ['wiki', 'projects']), '.md').forEach(function (a) {
    if (a.name.charAt(0) === '_') return;
    var slug = a.name.replace(/\.md$/, '');
    slugsConPagina[slug] = true;
    if (!mapaP[slug]) {
      var nombre = str_((parsearPagina_(a.content).frontmatter || {}).name) || slug;
      mapaP[slug] = { name: nombre, aliases: [] };
      informe.proyectosCatalogados++;
    }
  });
  Object.keys(mapaP).forEach(function (slug) {
    if (!slugsConPagina[slug]) { delete mapaP[slug]; informe.huerfanosPurgados++; }
  });
  guardarProyectos_(root, mapaP);

  // 2b) _people.json: solo externas reales que siguen teniendo página (aliases preservados).
  var mapaExt = cargarPersonasExt_(root);
  var extConPagina = {};
  listarArchivosBrain_(people, '.md').forEach(function (a) {
    if (a.name.charAt(0) === '_') return;
    var fm = parsearPagina_(a.content).frontmatter || {};
    if (String(fm.external) === 'true') extConPagina[a.name.replace(/\.md$/, '')] = str_(fm.name) || a.name.replace(/\.md$/, '');
  });
  var mapaExt2 = {};
  Object.keys(extConPagina).forEach(function (slug) {
    mapaExt2[slug] = mapaExt[slug] || { name: extConPagina[slug], aliases: [] };
  });
  guardarPersonasExt_(root, mapaExt2);

  // 2c) Fechas de creación de tareas: el created del primer sync no es la fecha real.
  informe.fechasCorregidas = repararFechasTareas_(sheetId, config, root);

  // 3) Índices + rastro.
  try { reconstruirIndiceTareas_(root); } catch (e) { /* sin tareas todavía */ }
  regenerarIndexBrain_(root, hoy);
  appendArchivoBrain_(carpetaBrain_(root, ['wiki']), 'log.md',
    '- ' + hoy + ' · 🔧 reparación del wiki · ' + informe.personasFusionadas + ' fusionada(s) · ' +
    informe.personasCorregidas + ' corregida(s) · ' + informe.proyectosCatalogados + ' proyecto(s) catalogado(s) · ' +
    informe.huerfanosPurgados + ' huérfano(s) · ' + informe.fechasCorregidas + ' fecha(s)\n');
  cacheInvalidar_(sheetId, CACHE_SEGUIMIENTO_.concat(CACHE_MISEGUIMIENTO_));
  return informe;
}

/**
 * Backfill determinista de 'Creada el' (hoja) y `created` (wiki/tasks) desde el sufijo del
 * Origen ('· YYYY-MM-DD', escrito por nuestro código — regex anclada, sin LLM). Cubre también
 * páginas de tareas ya archivadas (usa fm.origin). Idempotente. @return {number} correcciones
 */
function repararFechasTareas_(sheetId, config, root) {
  var n = 0;
  var carpeta = carpetaBrain_(root, ['wiki', 'tasks']);

  // Hoja: llena 'Creada el' vacías desde el Origen (la migración de encabezados ya corrió en ensure).
  try {
    var sh = ensureTareasSheet_(sheetId, config);
    listarTareas_(sheetId, config).forEach(function (t) {
      var real = fechaDeOrigen_(t.origen);
      if (!t.creada && real) { sh.getRange(t.fila, 11).setValue(real); n++; }
    });
  } catch (e) { /* sin hoja Tareas todavía */ }

  // Wiki: corrige `created` posterior a la fecha real (páginas activas Y archivadas).
  listarArchivosBrain_(carpeta, '.md').forEach(function (a) {
    if (a.name.charAt(0) === '_') return;
    var page = parsearPagina_(a.content);
    var fm = page.frontmatter || {};
    var real = fechaDeOrigen_(str_(fm.origin));
    if (real && (!str_(fm.created) || str_(fm.created) > real)) {
      escribirArchivoBrain_(carpeta, a.name, componerPagina_(mergeFrontmatter_(fm, { created: real }), page.body));
      n++;
    }
  });
  return n;
}

/**
 * ¿A qué miembro del roster corresponde una página de persona? Por email exacto; si no hay
 * email, por nombre normalizado igual o contención de tokens con match ÚNICO (ambiguo = null:
 * mejor no fusionar que fusionar mal). @return miembro del roster o null
 */
function rosterDePagina_(roster, fm, fileName) {
  var email = str_(fm.email).toLowerCase();
  for (var i = 0; i < roster.length; i++) {
    if (email && String(roster[i].correo).toLowerCase() === email) return roster[i];
  }
  var slugPagina = slugBrain_(str_(fm.name) || fileName.replace(/\.md$/, ''));
  var candidatos = roster.filter(function (p) {
    var slugNombre = slugBrain_(p.nombre || '');
    return slugNombre && (slugNombre === slugPagina || slugContenido_(slugNombre, slugPagina));
  });
  return candidatos.length === 1 ? candidatos[0] : null;
}

/** Fusiona la página `origen` dentro de `destinoName` (merge de secciones con dedup) y la borra. */
function fusionarPaginaEn_(carpeta, origen, destinoName, fmUpdates) {
  var o = parsearPagina_(origen.content);
  var dRaw = leerArchivoBrain_(carpeta, destinoName);
  var d = dRaw ? parsearPagina_(dRaw) : { frontmatter: {}, body: '' };

  var fm = mergeFrontmatter_(d.frontmatter, {
    sources: Array.isArray(o.frontmatter.sources) ? o.frontmatter.sources : [],
    open_blockers: Array.isArray(o.frontmatter.open_blockers) ? o.frontmatter.open_blockers : []
  });
  fm = mergeFrontmatter_(fm, fmUpdates);
  delete fm.external;

  var parsed = parseBodySections_(d.body);
  parseBodySections_(o.body).sections.forEach(function (s) {
    s.lines.forEach(function (l) { if (l.trim()) upsertLineaSeccion_(parsed, s.name, l.trim()); });
  });
  escribirArchivoBrain_(carpeta, destinoName, componerPagina_(fm, renderBodySections_(parsed)));
  borrarArchivoBrain_(carpeta, origen.name);
}

/** Saca un slug de _people.json (canónico o alias) tras fusionarlo al roster. */
function purgarDePersonasExt_(root, slug) {
  var mapa = cargarPersonasExt_(root);
  var cambio = false;
  if (mapa[slug]) { delete mapa[slug]; cambio = true; }
  Object.keys(mapa).forEach(function (c) {
    var al = mapa[c].aliases || [];
    if (al.indexOf(slug) > -1) { mapa[c].aliases = al.filter(function (x) { return x !== slug; }); cambio = true; }
  });
  if (cambio) guardarPersonasExt_(root, mapa);
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
