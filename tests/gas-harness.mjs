/**
 * gas-harness.mjs — Carga los archivos de runtime de shared/ en un contexto vm de Node
 * con los globales de Apps Script mockeados, para poder probar la lógica pura en Node.
 *
 * Los archivos de runtime usan namespace global (var/function, sin import/export): al
 * ejecutarlos con vm.runInContext, sus funciones quedan como propiedades del sandbox.
 *
 * Uso:
 *   const h = makeHarness({ spreadsheets: {...}, scriptProperties: {...}, fetch: fn });
 *   h.api.toHHMM_('18:00');        // llamar cualquier función del runtime
 *   h.sentEmails; h.fetchCalls;    // inspeccionar efectos
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHARED = path.join(HERE, '..', 'shared');

const RUNTIME_FILES = [
  'sheets-runtime.js',
  'prompts-runtime.js',
  'roster-runtime.js',
  'gemini-runtime.js',
  'summaries-runtime.js',
  'consolidation-runtime.js',
  'brand-assets-runtime.js',
  'email-runtime.js',
  'invites-runtime.js',
  'dispatcher-runtime.js',
  'forms-runtime.js',
  'forms-ai-runtime.js',
  'settings-runtime.js',
  'brain-drive-runtime.js',
  'brain-ingest-runtime.js',
  'brain-admin-runtime.js',
  'brain-backfill-runtime.js',
  'deepprep-runtime.js',
  'ui-runtime.js'
];

let sheetIdSeq = 1;

// --- Formateo de fecha mínimo (ignora timezone; suficiente para tests deterministas) ---
function formatDate_(date, _tz, fmt) {
  const p2 = (n) => (n < 10 ? '0' : '') + n;
  const dow = date.getDay() === 0 ? 7 : date.getDay();  // 'u': 1=lun … 7=dom
  return String(fmt)
    .replace('yyyy', date.getFullYear())
    .replace('MM', p2(date.getMonth() + 1))
    .replace('dd', p2(date.getDate()))
    .replace('HH', p2(date.getHours()))
    .replace('mm', p2(date.getMinutes()))
    .replace('u', String(dow));
}

// --- Mock de Sheet/Range/Spreadsheet respaldado por arrays 2D (mutados in place) ---
function makeRange(data, row, col, nr, nc) {
  const range = {
    getValues() {
      const out = [];
      for (let r = 0; r < nr; r++) {
        const rowArr = [];
        const src = data[row - 1 + r] || [];
        for (let c = 0; c < nc; c++) {
          const v = src[col - 1 + c];
          rowArr.push(v === undefined ? '' : v);
        }
        out.push(rowArr);
      }
      return out;
    },
    getDisplayValues() {
      return range.getValues().map((r) =>
        r.map((v) => (v === null || v === undefined) ? '' : String(v)));
    },
    getValue() { return range.getValues()[0][0]; },
    setValue(v) {
      if (!data[row - 1]) data[row - 1] = [];
      data[row - 1][col - 1] = v;
      return range;
    },
    setValues(values) {
      for (let r = 0; r < values.length; r++) {
        if (!data[row - 1 + r]) data[row - 1 + r] = [];
        for (let c = 0; c < values[r].length; c++) {
          data[row - 1 + r][col - 1 + c] = values[r][c];
        }
      }
      return range;
    },
    // --- estilo (no-op, encadenables) ---
    setBackground() { return range; },
    setFontColor() { return range; },
    setFontWeight() { return range; },
    setVerticalAlignment() { return range; },
    setWrap() { return range; },
    setBorder() { return range; },
    setNumberFormat() { return range; },
    applyRowBanding() {
      const banding = { setFirstRowColor() { return banding; }, setSecondRowColor() { return banding; }, remove() {} };
      return banding;
    }
  };
  return range;
}

function makeSheet(name, data) {
  const id = sheetIdSeq++;
  let _name = name;
  const numRows = () => data.length;
  const numCols = () => data.reduce((m, r) => Math.max(m, (r && r.length) || 0), 0);
  const sheet = {
    _data: data,
    getName: () => _name,
    setName: (n) => { _name = n; return sheet; },
    getSheetId: () => id,
    getLastRow: () => numRows(),
    getLastColumn: () => numCols(),
    getRange: (row, col, nr = 1, nc = 1) => makeRange(data, row, col, nr, nc),
    getDataRange: () => makeRange(data, 1, 1, Math.max(numRows(), 1), Math.max(numCols(), 1)),
    clearContents: () => { data.length = 0; return sheet; },
    clear: () => { data.length = 0; return sheet; },
    // --- estilo (no-op) ---
    setFrozenRows: () => sheet,
    setRowHeight: () => sheet,
    setColumnWidth: () => sheet,
    getBandings: () => [],
    getMaxRows: () => Math.max(numRows(), 2)
  };
  return sheet;
}

function makeSpreadsheet(id, tabs) {
  const sheets = Object.keys(tabs).map((name) => makeSheet(name, tabs[name]));
  return {
    getId: () => id,
    getSheetByName: (n) => sheets.find((s) => s.getName() === n) || null,
    getSheets: () => sheets.slice(),
    insertSheet: (name) => { const s = makeSheet(name, []); sheets.push(s); return s; },
    getSpreadsheetTimeZone: () => 'America/Lima'
  };
}

// --- Mock de DriveApp (carpetas/archivos en memoria; respeta el subset que usa el brain) ---
function makeDriveMock() {
  let seq = 1;
  const byId = {};

  const iterator = (arr) => {
    let i = 0;
    return { hasNext: () => i < arr.length, next: () => arr[i++] };
  };

  const makeFile = (name, content, parent) => {
    const file = {
      _kind: 'file', _name: name, _parent: parent, _trashed: false,
      _content: content == null ? '' : String(content), _id: 'file' + seq++,
      getId: () => file._id,
      getName: () => file._name,
      setName: (n) => { file._name = n; return file; },
      getBlob: () => ({ getDataAsString: () => file._content }),
      setContent: (c) => { file._content = c == null ? '' : String(c); return file; },
      setTrashed: (v) => { file._trashed = !!v; return file; }
    };
    byId[file._id] = file;
    return file;
  };

  const makeFolder = (name, parent) => {
    const kids = [];
    const live = (kind) => kids.filter((c) => c._kind === kind && !c._trashed);
    const folder = {
      _kind: 'folder', _name: name, _parent: parent, _trashed: false,
      _children: kids, _id: 'folder' + seq++,
      getId: () => folder._id,
      getName: () => folder._name,
      createFolder: (n) => { const f = makeFolder(n, folder); kids.push(f); return f; },
      createFile: (n, c) => { const f = makeFile(n, c, folder); kids.push(f); return f; },
      getFoldersByName: (n) => iterator(live('folder').filter((c) => c._name === n)),
      getFilesByName: (n) => iterator(live('file').filter((c) => c._name === n)),
      getFolders: () => iterator(live('folder')),
      getFiles: () => iterator(live('file'))
    };
    byId[folder._id] = folder;
    return folder;
  };

  return {
    createFolder: (name) => makeFolder(name, null),
    getFolderById: (id) => {
      const f = byId[id];
      if (!f || f._trashed || f._kind !== 'folder') throw new Error('Folder no encontrado: ' + id);
      return f;
    },
    _byId: byId
  };
}

// --- Mock de CalendarApp (calendario por defecto respaldado por una lista de eventos) ---
// Cada spec: { id, title, start:Date, end?:Date, description?, location?, guests?:[email] }
function makeCalendarMock(events = []) {
  const wrap = (e) => ({
    getId: () => e.id,
    getTitle: () => e.title || '',
    getStartTime: () => e.start || null,
    getEndTime: () => e.end || null,
    getDescription: () => e.description || '',
    getLocation: () => e.location || '',
    getGuestList: () => (e.guests || []).map((email) => ({ getEmail: () => email }))
  });
  const cal = {
    getEvents: (start, end) => events
      .filter((e) => e.start && e.start.getTime() >= start.getTime() && e.start.getTime() <= end.getTime())
      .map(wrap),
    getEventById: (id) => { const e = events.find((x) => x.id === id); return e ? wrap(e) : null; }
  };
  return { getDefaultCalendar: () => cal, _events: events };
}

// --- Mock de Blob (Utilities.newBlob(...).getAs(mime)) ---
function makeBlob(content, mime, name) {
  const blob = {
    _content: content == null ? '' : String(content), _mime: mime || 'text/plain', _name: name || '',
    getAs: (m) => makeBlob(blob._content, m, blob._name),   // convierte de mime (p.ej. HTML→PDF)
    setName: (n) => { blob._name = n; return blob; },
    getName: () => blob._name,
    getContentType: () => blob._mime,
    getDataAsString: () => blob._content,
    getBytes: () => Array.from(blob._content).map((c) => c.charCodeAt(0))
  };
  return blob;
}

/**
 * Crea un harness aislado.
 * @param {Object} opts
 *   spreadsheets: { [sheetId]: { [tabName]: rows2D } }   (mutados in place por setValue)
 *   scriptProperties: { [key]: value }
 *   fetch: (url, options) => ({ getResponseCode(), getContentText() })
 */
export function makeHarness(opts = {}) {
  const state = {
    scriptProps: new Map(Object.entries(opts.scriptProperties || {})),
    sentEmails: [],
    logs: [],
    fetchCalls: [],
    uiCalls: [],   // showModalDialog/showSidebar invocados vía SpreadsheetApp.getUi()
    fetch: opts.fetch || (() => { throw new Error('UrlFetchApp.fetch no fue mockeado en este test'); })
  };

  const byId = {};
  const spec = opts.spreadsheets || {};
  Object.keys(spec).forEach((sid) => { byId[sid] = makeSpreadsheet(sid, spec[sid]); });

  const drive = makeDriveMock();
  const calendar = makeCalendarMock(opts.calendar || []);

  const sandbox = {
    console,
    Date,   // comparte el Date de Node para que `x instanceof Date` funcione entre realms
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => (state.scriptProps.has(k) ? state.scriptProps.get(k) : null),
        setProperty: (k, v) => { state.scriptProps.set(k, String(v)); },
        deleteProperty: (k) => { state.scriptProps.delete(k); },
        getProperties: () => Object.fromEntries(state.scriptProps)
      })
    },
    Utilities: {
      sleep: () => {},
      formatDate: (d, tz, fmt) => formatDate_(d, tz, fmt),
      newBlob: (content, mime, name) => makeBlob(content, mime, name)
    },
    UrlFetchApp: {
      fetch: (url, options) => {
        state.fetchCalls.push({ url, options });
        return state.fetch(url, options);
      }
    },
    MailApp: {
      sendEmail: (to, subject, body, options) => {
        state.sentEmails.push({
          to, subject, body,
          html: (options && options.htmlBody) || '',
          attachments: (options && options.attachments) || []
        });
      }
    },
    Logger: { log: (...a) => state.logs.push(a) },
    ScriptApp: { getOAuthToken: () => 'TEST_OAUTH_TOKEN' },
    DriveApp: drive,
    CalendarApp: calendar,
    SpreadsheetApp: {
      openById: (id) => {
        if (!byId[id]) throw new Error('Spreadsheet no mockeado: ' + id);
        return byId[id];
      },
      flush: () => {},
      // getUi(): registra los diálogos/sidebars mostrados para poder afirmar en tests que
      // MENU_ACTIONS_.cosMenu1 abre el modal de preguntas (showModalDialog desde la librería).
      getUi: () => ({
        showModalDialog: (html, titulo) => { state.uiCalls.push({ kind: 'modal', html, titulo }); },
        showSidebar: (html) => { state.uiCalls.push({ kind: 'sidebar', html }); }
      }),
      DestinationType: { SPREADSHEET: 'SPREADSHEET' },
      BandingTheme: { LIGHT_GREY: 'LIGHT_GREY' },
      BorderStyle: { SOLID: 'SOLID', SOLID_MEDIUM: 'SOLID_MEDIUM' }
    },
    FormApp: opts.FormApp || { DestinationType: { SPREADSHEET: 'SPREADSHEET' } },
    HtmlService: {
      // Devuelve un HtmlOutput mock encadenable que recuerda el archivo y los ajustes aplicados,
      // para poder afirmar en tests qué archivo cargó buildSidebar/buildDialog.
      createHtmlOutputFromFile: (name) => {
        const out = {
          _file: name, _title: null, _width: null, _height: null,
          setTitle(t) { out._title = t; return out; },
          setWidth(w) { out._width = w; return out; },
          setHeight(h) { out._height = h; return out; }
        };
        return out;
      }
    }
  };

  vm.createContext(sandbox);
  for (const f of RUNTIME_FILES) {
    const code = fs.readFileSync(path.join(SHARED, f), 'utf8');
    vm.runInContext(code, sandbox, { filename: f });
  }

  return {
    api: sandbox,
    sentEmails: state.sentEmails,
    logs: state.logs,
    fetchCalls: state.fetchCalls,
    uiCalls: state.uiCalls,
    scriptProps: state.scriptProps,
    setFetch: (fn) => { state.fetch = fn; },
    getSpreadsheet: (id) => byId[id],
    getDrive: () => drive,
    getCalendar: () => calendar
  };
}

/** Helper: construye una respuesta estilo UrlFetchApp. */
export function httpResponse(code, body) {
  return {
    getResponseCode: () => code,
    getContentText: () => (typeof body === 'string' ? body : JSON.stringify(body))
  };
}

/** Helper: cuerpo JSON de una respuesta exitosa de Gemini con `text`. */
export function geminiOk(text) {
  return JSON.stringify({ candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }] });
}

/**
 * Mock de FormApp para probar generación/edición de Forms y su acceso.
 *
 * `titulos` acumula el título de cada ÍTEM agregado (verifica QUÉ preguntas se crean; el título
 * del Form en sí no entra aquí). Cada form y cada ítem registran lo que se les aplicó
 * (setTitle/setDescription a nivel form; setRequired/setHelpText/setBounds/setChoiceValues por
 * ítem), para poder afirmarlo en los tests.
 *
 * @param {string[]} titulos               acumulador de títulos de ítem (compartible entre asserts)
 * @param {Object}   opts
 *   opts.soportaPublicacion=false → Form antiguo (sin modelo de publicación)
 *   opts.yaRecolectaCorreo=true   → simula el default "Verificado" heredado del líder
 */
export function makeFormAppMock(titulos = [], opts = {}) {
  const soporta = opts.soportaPublicacion !== false;
  const yaRecolecta = opts.yaRecolectaCorreo === true;
  const registro = {};
  let idc = 0;

  const makeItem = () => {
    const it = {
      _titulo: null, _help: null, _required: false, _bounds: null, _choices: null,
      setTitle(t) { it._titulo = t; titulos.push(t); return it; },
      setChoiceValues(v) { it._choices = v; return it; },
      setBounds(a, b) { it._bounds = [a, b]; return it; },
      setRequired(v) { it._required = v; return it; },
      setHelpText(t) { it._help = t; return it; }
    };
    return it;
  };

  const makeForm = () => {
    const id = 'FORM' + (++idc);
    const items = [];
    const add = () => { const it = makeItem(); items.push(it); return it; };
    const f = {
      _publicado: false, _readers: [], _collectEmail: yaRecolecta, _setCollectEmailCalls: 0,
      _titulo: null, _descripcion: null, _items: items,
      addTextItem: add, addParagraphTextItem: add, addMultipleChoiceItem: add,
      addCheckboxItem: add, addListItem: add, addScaleItem: add,
      addDateItem: add, addTimeItem: add,
      getItems: () => items.slice(),
      deleteItem: (it) => { const i = items.indexOf(it); if (i > -1) items.splice(i, 1); },
      setTitle: (t) => { f._titulo = t; return f; },
      setDescription: (t) => { f._descripcion = t; return f; },
      collectsEmail: () => f._collectEmail,
      setCollectEmail: () => { f._collectEmail = true; f._setCollectEmailCalls++; },
      setDestination: () => {}, getId: () => id,
      getPublishedUrl: () => 'https://form/' + id, getEditUrl: () => 'https://edit/' + id,
      // --- modelo de publicación / respondientes ---
      supportsAdvancedResponderPermissions: () => soporta,
      setPublished: (v) => {
        if (!soporta) throw new Error('Form antiguo: no soporta publicación');
        f._publicado = v; return f;
      },
      isPublished: () => f._publicado,
      addPublishedReaders: (correos) => {
        if (!soporta) throw new Error('Form antiguo: no soporta respondientes');
        correos.forEach((c) => { if (!f._readers.includes(c)) f._readers.push(c); });
        return f;
      },
      getPublishedReaders: () => f._readers.slice()
    };
    registro[id] = f;
    return f;
  };

  return {
    create: (titulo) => { const f = makeForm(); if (titulo != null) f._titulo = titulo; return f; },
    openById: (id) => registro[id] || makeForm(),
    _registro: registro,
    DestinationType: { SPREADSHEET: 'SPREADSHEET' }
  };
}
