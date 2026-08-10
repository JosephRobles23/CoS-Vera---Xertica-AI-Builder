/**
 * brain-drive-runtime.js — Sustrato en Drive del "second brain" (patrón LLM-Wiki de Karpathy).
 *
 * Crea y mantiene la carpeta autocontenida `CoS-Brain/` (scope `drive.file`: la app solo ve lo
 * que ella misma crea) con tres capas:
 *   - raw/reports/   copia INMUTABLE de cada reporte ingerido (verdad de origen; append, nunca pisa).
 *   - wiki/          páginas que el LLM REGENERA: index.md, log.md (append-only), people/, projects/,
 *                    meetings/. El humano LEE, nunca edita (por eso no hay riesgo de clobber).
 *   - _schema.md     documenta el schema de páginas y el frontmatter (estable).
 *
 * Analogía de compilación: raw/ = fuente, wiki/ = binario. El estado vive en el frontmatter YAML,
 * no en un _state.json ni en bloques marcados.
 *
 * Este archivo es SOLO el sustrato (carpetas, I/O, (de)serialización markdown+frontmatter). La
 * ingesta (extraer eventos, regenerar páginas) vive en brain-ingest-runtime.js. Ver
 * Docs/workflows/SECOND-BRAIN/SECOND-BRAIN.md.
 *
 * Sin import/export: runtime de Apps Script. Privados con sufijo "_".
 */

// --- Estructura canónica del brain ---

var BRAIN_ROOT_NAME_ = 'CoS-Brain';

/** Semilla del _schema.md (se escribe una sola vez al crear el brain; el humano puede leerlo). */
var BRAIN_SCHEMA_MD_ = [
  '# CoS-Brain — esquema',
  '',
  'Memoria organizacional autoconstruida desde los reportes Daily/Weekly. Patrón LLM-Wiki:',
  '',
  '- `raw/reports/` — copia inmutable de cada reporte. Verdad de origen. No editar.',
  '- `wiki/` — páginas regeneradas por el LLM. **El humano lee, no edita** (se sobrescriben).',
  '  - `index.md` — índice de entidades.',
  '  - `log.md` — bitácora append-only (ingestas, contradicciones, silencios).',
  '  - `people/<slug>.md`, `projects/<slug>.md`, `meetings/<slug>.md` — una página por entidad.',
  '',
  '## Frontmatter YAML de cada página',
  '',
  '```',
  'page_type: person | project | meeting',
  'name: <nombre legible>',
  'last_updated: <YYYY-MM-DD>',
  'confidence: <0..1>',
  'tags: [..]',
  'sources: [raw/reports/..]',
  'open_blockers: [..]',
  '```',
  ''
].join('\n');

/** Semillas mínimas de los archivos wiki de nivel superior. */
var BRAIN_INDEX_SEED_ = [
  '---',
  'page_type: index',
  'name: Índice',
  '---',
  '',
  '# Índice del brain',
  '',
  '_Se regenera automáticamente a medida que llegan reportes._',
  ''
].join('\n');

var BRAIN_LOG_SEED_ = [
  '# Bitácora (append-only)',
  '',
  'Cada línea registra una ingesta, contradicción o silencio detectado.',
  ''
].join('\n');

// --- Carpetas (idempotentes) ---

/** Devuelve la subcarpeta `name` de `parent`, creándola si no existe. */
function subcarpeta_(parent, name) {
  var it = parent.getFoldersByName(name);
  if (it.hasNext()) return it.next();
  return parent.createFolder(name);
}

/**
 * Asegura la carpeta raíz del brain y toda su estructura. Idempotente: si `brain.folderId` ya
 * apunta a una carpeta viva la reutiliza; si no, la crea y persiste el id en Ajustes.
 * @return {Folder} la carpeta raíz CoS-Brain/
 */
function ensureBrainFolder_(sheetId, config) {
  var aj = getAjustes_(sheetId, config.sheets.settings);
  var root = null;

  if (aj.brain && aj.brain.folderId) {
    try { root = DriveApp.getFolderById(aj.brain.folderId); } catch (e) { root = null; }
  }
  if (!root) {
    root = DriveApp.createFolder(BRAIN_ROOT_NAME_);
    setAjustes_(sheetId, config.sheets.settings, { 'brain.folderId': root.getId() });
  }

  // Estructura de capas (crear-si-falta).
  var raw = subcarpeta_(root, 'raw');
  subcarpeta_(raw, 'reports');
  var wiki = subcarpeta_(root, 'wiki');
  subcarpeta_(wiki, 'people');
  subcarpeta_(wiki, 'projects');
  subcarpeta_(wiki, 'meetings');

  // Archivos semilla (solo si no existen: no pisar).
  ensureArchivoBrain_(root, '_schema.md', BRAIN_SCHEMA_MD_);
  ensureArchivoBrain_(wiki, 'index.md', BRAIN_INDEX_SEED_);
  ensureArchivoBrain_(wiki, 'log.md', BRAIN_LOG_SEED_);

  return root;
}

/**
 * Navega/crea una ruta de subcarpetas desde la raíz del brain.
 * @param {Folder} root
 * @param {string[]} segs  p. ej. ['wiki','people']
 * @return {Folder}
 */
function carpetaBrain_(root, segs) {
  var cur = root;
  for (var i = 0; i < segs.length; i++) cur = subcarpeta_(cur, segs[i]);
  return cur;
}

// --- Archivos (I/O de texto) ---

/** Lee el contenido de texto de un archivo por nombre dentro de `folder`, o null si no existe. */
function leerArchivoBrain_(folder, name) {
  var it = folder.getFilesByName(name);
  if (!it.hasNext()) return null;
  return it.next().getBlob().getDataAsString();
}

/**
 * Escribe (sobrescribe) un archivo de texto por nombre. Como DriveApp no expone update de
 * contenido, elimina los homónimos previos (a papelera) y crea uno nuevo. Idempotente por nombre.
 * @return {File}
 */
function escribirArchivoBrain_(folder, name, contenido) {
  var it = folder.getFilesByName(name);
  while (it.hasNext()) it.next().setTrashed(true);   // limpia versión previa y duplicados
  return folder.createFile(name, contenido == null ? '' : String(contenido), 'text/plain');
}

/** Crea el archivo con `contenidoInicial` SOLO si no existe. No pisa. @return {File} */
function ensureArchivoBrain_(folder, name, contenidoInicial) {
  var it = folder.getFilesByName(name);
  if (it.hasNext()) return it.next();
  return folder.createFile(name, contenidoInicial == null ? '' : String(contenidoInicial), 'text/plain');
}

/** Anexa texto al final de un archivo (crea si no existe). Base del log.md append-only. @return {File} */
function appendArchivoBrain_(folder, name, texto) {
  var prev = leerArchivoBrain_(folder, name);
  return escribirArchivoBrain_(folder, name, (prev == null ? '' : prev) + (texto == null ? '' : String(texto)));
}

/**
 * Lista los archivos de una carpeta como [{name, content}]. Con `sufijo` filtra por extensión
 * (p. ej. '.md'). Lo usa el scan de silencios para recorrer las páginas wiki.
 */
function listarArchivosBrain_(folder, sufijo) {
  var out = [];
  var it = folder.getFiles();
  while (it.hasNext()) {
    var f = it.next();
    var nm = f.getName();
    if (sufijo && nm.slice(-sufijo.length) !== sufijo) continue;
    out.push({ name: nm, content: f.getBlob().getDataAsString() });
  }
  return out;
}

/** Manda a la papelera todos los archivos con ese nombre en `folder`. @return {number} borrados. */
function borrarArchivoBrain_(folder, name) {
  var it = folder.getFilesByName(name);
  var n = 0;
  while (it.hasNext()) { it.next().setTrashed(true); n++; }
  return n;
}

// --- Slug de nombres de entidad → nombre de archivo estable ---

/** Normaliza un nombre de entidad a un slug de archivo (minúsculas, sin acentos, guiones). */
function slugBrain_(nombre) {
  var s = str_(nombre).toLowerCase().trim();
  s = s.replace(/[áàä]/g, 'a').replace(/[éèë]/g, 'e').replace(/[íìï]/g, 'i')
       .replace(/[óòö]/g, 'o').replace(/[úùü]/g, 'u').replace(/ñ/g, 'n');
  s = s.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return s || 'sin-nombre';
}

// --- (De)serialización de markdown + frontmatter YAML (subset plano) ---

/** Escapa un escalar para YAML: entrecomilla si trae caracteres ambiguos. */
function escYaml_(v) {
  if (v == null) return '';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  var s = String(v);
  if (s === '' || /[:#\-\[\]{}&*!|>'"%@`]/.test(s) || /^\s|\s$/.test(s)) {
    return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  }
  return s;
}

/** Quita comillas de un escalar YAML y desescapa. */
function unquoteYaml_(s) {
  s = str_(s).trim();
  if (s.length >= 2 && s.charAt(0) === '"' && s.charAt(s.length - 1) === '"') {
    return s.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  return s;
}

/**
 * Serializa un objeto plano a bloque de frontmatter YAML (entre `---`). Soporta escalares
 * (string/number/boolean) y arrays de escalares. No anida objetos (no lo necesitamos).
 */
function serializarFrontmatter_(obj) {
  var lines = ['---'];
  Object.keys(obj || {}).forEach(function (k) {
    var v = obj[k];
    if (Array.isArray(v)) {
      if (!v.length) { lines.push(k + ': []'); return; }
      lines.push(k + ':');
      v.forEach(function (item) { lines.push('  - ' + escYaml_(item)); });
    } else {
      lines.push(k + ': ' + escYaml_(v));
    }
  });
  lines.push('---');
  return lines.join('\n');
}

/** Parsea el subset de YAML plano que emite serializarFrontmatter_. @return {Object} */
function parsearYamlPlano_(texto) {
  var out = {};
  var lines = str_(texto).split('\n');
  var curKey = null;
  for (var i = 0; i < lines.length; i++) {
    var raw = lines[i];
    if (!raw.trim()) continue;
    var mItem = /^\s+-\s+(.*)$/.exec(raw);
    if (mItem && curKey) {
      if (!Array.isArray(out[curKey])) out[curKey] = [];
      out[curKey].push(unquoteYaml_(mItem[1]));
      continue;
    }
    var mKv = /^([A-Za-z0-9_.]+):\s*(.*)$/.exec(raw);
    if (mKv) {
      curKey = mKv[1];
      var val = mKv[2];
      if (val === '') { out[curKey] = ''; continue; }      // puede volverse array si siguen ítems
      if (val === '[]') { out[curKey] = []; curKey = null; continue; }
      out[curKey] = unquoteYaml_(val);
      curKey = null;
    }
  }
  return out;
}

/**
 * Separa una página en { frontmatter, body }. Si no hay bloque `---`, frontmatter = {} y todo
 * el texto es body.
 */
function parsearPagina_(texto) {
  var t = str_(texto);
  var m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(t);
  if (!m) return { frontmatter: {}, body: t };
  return { frontmatter: parsearYamlPlano_(m[1]), body: (m[2] || '').replace(/^\n/, '') };
}

/** Compone una página desde frontmatter + body. Inverso de parsearPagina_. */
function componerPagina_(frontmatter, body) {
  return serializarFrontmatter_(frontmatter) + '\n\n' + (body == null ? '' : String(body));
}
