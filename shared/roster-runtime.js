/**
 * roster-runtime.js — Lectura de la pestaña `Equipo` del líder.
 *
 * Contrato de columnas (encabezados fila 1): `Nombre`, `Correo`, `Rol` y la opcional
 * `Compartir con` (correos extra, separados por coma, que reciben los reportes de esa persona).
 * En el modelo per-líder el Sheet es de un solo líder; no hay columna de agrupación.
 *
 * Sin import/export: runtime de Apps Script. Privados con sufijo "_".
 */

/**
 * Devuelve el equipo como [{ nombre, correo, rol, compartirCon }], saltando filas sin correo.
 * `compartirCon` sale normalizado (minúsculas, sin duplicados) de la columna `Compartir con`.
 * @param {string} sheetId          ID del Spreadsheet del líder.
 * @param {string} rosterSheetName  Nombre de la pestaña (CONFIG.sheets.roster, p.ej. 'Equipo').
 */
function getRoster_(sheetId, rosterSheetName) {
  var sh = getSheet_(sheetId, rosterSheetName);
  if (sh.getLastRow() < 2) return [];

  // getDisplayValues: strings tal como se ven (útil si algún día se agregan horas por persona).
  var values = sh.getDataRange().getDisplayValues();
  var headers = values.shift();

  var idx = {};
  headers.forEach(function (h, i) { idx[String(h).trim()] = i; });

  var colCorreo = idx['Correo'];
  var colNombre = idx['Nombre'];
  var colRol    = idx['Rol'];
  var colComp   = idx['Compartir con'];

  if (colCorreo == null) {
    throw new Error('La pestaña "' + rosterSheetName + '" no tiene columna "Correo".');
  }

  return values
    .filter(function (r) { return r[colCorreo] && String(r[colCorreo]).trim(); })
    .map(function (r) {
      return {
        nombre: colNombre != null ? String(r[colNombre]).trim() : '',
        correo: String(r[colCorreo]).trim(),
        rol:    colRol != null ? String(r[colRol]).trim() : '',
        compartirCon: colComp != null ? listaCorreos_(r[colComp]) : []
      };
    });
}

/**
 * Busca una persona del equipo por su correo. Es el puente entre la respuesta del Form
 * (que solo trae el correo verificado de Google) y el `Nombre` que muestran el resumen y
 * el consolidado. Compara sin distinguir mayúsculas ni espacios.
 *
 * Tolerante: si la pestaña `Equipo` no existe o no tiene columna `Correo`, devuelve null
 * en vez de romper el onFormSubmit (la fila queda con correo pero sin nombre).
 *
 * @param {string} sheetId
 * @param {string} rosterSheetName  CONFIG.sheets.roster
 * @param {string} correo
 * @return {?{nombre:string, correo:string, rol:string}} null si no está en el equipo.
 */
function buscarEnRoster_(sheetId, rosterSheetName, correo) {
  var buscado = String(correo == null ? '' : correo).trim().toLowerCase();
  if (!buscado) return null;

  var equipo;
  try {
    equipo = getRoster_(sheetId, rosterSheetName);
  } catch (e) {
    Logger.log('buscarEnRoster_: no se pudo leer "%s" (%s).', rosterSheetName, e.message);
    return null;
  }

  return equipo.filter(function (p) {
    return p.correo.toLowerCase() === buscado;
  })[0] || null;
}
