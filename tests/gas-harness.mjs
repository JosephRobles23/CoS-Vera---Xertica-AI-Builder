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
  'invites-runtime.js',
  'dispatcher-runtime.js',
  'forms-runtime.js',
  'settings-runtime.js'
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
    fetch: opts.fetch || (() => { throw new Error('UrlFetchApp.fetch no fue mockeado en este test'); })
  };

  const byId = {};
  const spec = opts.spreadsheets || {};
  Object.keys(spec).forEach((sid) => { byId[sid] = makeSpreadsheet(sid, spec[sid]); });

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
      formatDate: (d, tz, fmt) => formatDate_(d, tz, fmt)
    },
    UrlFetchApp: {
      fetch: (url, options) => {
        state.fetchCalls.push({ url, options });
        return state.fetch(url, options);
      }
    },
    MailApp: {
      sendEmail: (to, subject, body) => { state.sentEmails.push({ to, subject, body }); }
    },
    Logger: { log: (...a) => state.logs.push(a) },
    ScriptApp: { getOAuthToken: () => 'TEST_OAUTH_TOKEN' },
    SpreadsheetApp: {
      openById: (id) => {
        if (!byId[id]) throw new Error('Spreadsheet no mockeado: ' + id);
        return byId[id];
      },
      flush: () => {},
      DestinationType: { SPREADSHEET: 'SPREADSHEET' },
      BandingTheme: { LIGHT_GREY: 'LIGHT_GREY' },
      BorderStyle: { SOLID: 'SOLID', SOLID_MEDIUM: 'SOLID_MEDIUM' }
    },
    FormApp: opts.FormApp || { DestinationType: { SPREADSHEET: 'SPREADSHEET' } }
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
    scriptProps: state.scriptProps,
    setFetch: (fn) => { state.fetch = fn; },
    getSpreadsheet: (id) => byId[id]
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
