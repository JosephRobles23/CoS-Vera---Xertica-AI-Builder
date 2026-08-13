/**
 * brain-backfill-runtime.js — Importación del histórico Daily/Weekly al second brain.
 *
 * Ingesta las respuestas YA guardadas en las hojas (previas a activar el brain) para que el líder
 * arranque con contexto, sin esperar reportes nuevos. Diseño acordado (grill ago 2026):
 *   - Job reanudable por cursor (un cursor por hoja, persistidos en Ajustes `brain.backfill.*`);
 *     lo avanza el dispatcher AL FINAL de cada pasada, time-boxed (~3.5 min, tope 30 filas).
 *   - Merge cronológico Daily+Weekly por Marca temporal: el estado previo de cada página (y la
 *     detección de contradicciones) evoluciona en el orden en que ocurrieron los reportes.
 *   - Cada fila se ingesta con la FECHA DE LA FILA (no la de hoy): el wiki, la purga por retención
 *     y el scan de silencios reflejan cuándo pasó de verdad.
 *   - Se saltan (contándolas) las filas fuera de `brain.retentionMonths`, las de correos fuera del
 *     roster actual y las sin contenido. Una fila que falla en Gemini avanza igual (queda en log).
 *   - El Summary de la fila se rellena solo si estaba vacío; nunca se pisa uno existente.
 *   - Idempotente: el raw `_r<fila>` existente no se re-escribe y los eventos dedup-ean por línea.
 *
 * Público (via dispatch): iniciarBackfill, estadoBackfill, cancelarBackfill.
 * Hook del dispatcher: runBackfillPass_. Ver Docs/workflows/SECOND-BRAIN/SECOND-BRAIN.md.
 *
 * Sin import/export: runtime de Apps Script. Privados con sufijo "_".
 */

var BACKFILL_MAX_FILAS_ = 30;            // tope de filas ingestadas por pasada del dispatcher
var BACKFILL_PRESUPUESTO_MS_ = 210000;   // ~3.5 min: presupuesto de la pasada (queda margen del límite de 6)

// --- API pública (sidebar via cosRun→dispatch) ---

/**
 * Estado del job + plan del histórico (conteo sin LLM: elegibles y saltadas con desglose).
 * El sidebar lo usa para el confirm previo y para pintar el progreso.
 * @return {{status,total,ok,saltadas,errores,plan:{elegibles,fueraRetencion,fueraRoster,vacias}}}
 */
function estadoBackfill(sheetId, config) {
  var st = getAjustes_(sheetId, config.sheets.settings).brain.backfill;
  return {
    status: st.status, total: st.total, ok: st.ok, saltadas: st.saltadas, errores: st.errores,
    plan: planBackfill_(sheetId, config, new Date())
  };
}

/**
 * Arranca (o reanuda) el backfill. Exige brain.enabled. Si hay un job pausado con avance, retoma
 * donde quedó; si no, resetea cursores y contadores con el plan fresco. Con 0 filas elegibles no
 * arranca nada. @return {{iniciado:boolean, status, total, ok, saltadas, errores}}
 */
function iniciarBackfill(sheetId, config) {
  if (!(config.brain && config.brain.enabled)) {
    throw new Error('Activa la memoria (brain.enabled) en el panel Brain antes de importar el histórico.');
  }
  var st = getAjustes_(sheetId, config.sheets.settings).brain.backfill;
  if (st.status === 'running') {
    return { iniciado: false, status: 'running', total: st.total, ok: st.ok, saltadas: st.saltadas, errores: st.errores };
  }

  // Job pausado con avance → reanudar conservando cursores y contadores.
  var conAvance = st.status === 'idle' && (st.cursorDaily > 2 || st.cursorWeekly > 2);
  if (conAvance) {
    setAjustes_(sheetId, config.sheets.settings, { 'brain.backfill.status': 'running' });
    return { iniciado: true, status: 'running', total: st.total, ok: st.ok, saltadas: st.saltadas, errores: st.errores };
  }

  var plan = planBackfill_(sheetId, config, new Date());
  if (!plan.elegibles) {
    return { iniciado: false, status: st.status, total: 0, ok: 0, saltadas: 0, errores: 0, plan: plan };
  }
  guardarBackfill_(sheetId, config, {
    status: 'running', cursorDaily: 2, cursorWeekly: 2,
    total: plan.elegibles, ok: 0, saltadas: 0, errores: 0
  });
  return { iniciado: true, status: 'running', total: plan.elegibles, ok: 0, saltadas: 0, errores: 0, plan: plan };
}

/** Pausa el job (status→idle) conservando cursores y contadores: re-iniciar retoma donde quedó. */
function cancelarBackfill(sheetId, config) {
  setAjustes_(sheetId, config.sheets.settings, { 'brain.backfill.status': 'idle' });
  var st = getAjustes_(sheetId, config.sheets.settings).brain.backfill;
  return { status: st.status, total: st.total, ok: st.ok, saltadas: st.saltadas, errores: st.errores };
}

// --- Pasada del dispatcher ---

/** ¿Hay un backfill corriendo? Lee Ajustes fresco (el config de la pasada puede estar viejo). */
function backfillActivo_(sheetId, config) {
  try {
    return getAjustes_(sheetId, config.sheets.settings).brain.backfill.status === 'running';
  } catch (e) {
    return false;
  }
}

/**
 * Avanza el backfill hasta agotar el presupuesto de tiempo o el tope de filas. La invoca
 * runDispatcher al final de la pasada; no-op si el job no está en running.
 * @param {Date}   now         reloj de la pasada (inyectable en tests)
 * @param {number} deadlineMs  epoch-ms límite: no se ingesta ninguna fila pasado este instante
 * @return {number} filas ingestadas (con llamada a Gemini) en esta pasada
 */
function runBackfillPass_(sheetId, config, now, deadlineMs) {
  var st = getAjustes_(sheetId, config.sheets.settings).brain.backfill;
  if (st.status !== 'running') return 0;

  // Guardia de Drive ANTES de gastar llamadas a Gemini: sin carpeta no hay brain que escribir
  // (p.ej. scope sin re-consentir). Se pospone la pasada entera; el job queda running y la
  // siguiente pasada reintenta. Sin esto, ingestarFila_ degradaría a "resumen sin brain" y el
  // backfill contaría éxitos que no dejaron memoria.
  try {
    ensureBrainFolder_(sheetId, config);
  } catch (e) {
    if (typeof Logger !== 'undefined') {
      Logger.log('backfill: sin acceso a Drive, pasada pospuesta (%s).', e);
    }
    return 0;
  }

  var tz = config.timezone;
  var corteUTC = corteRetencionUTC_(config, now || new Date());
  var roster = rosterPorCorreo_(sheetId, config);
  var prompts = getPrompts_(sheetId, config.sheets.prompts);
  var ctxD = contextoHojaBackfill_(sheetId, config, 'daily', true);
  var ctxW = contextoHojaBackfill_(sheetId, config, 'weekly', true);

  var procesadas = 0;
  while (procesadas < BACKFILL_MAX_FILAS_ && Date.now() <= deadlineMs) {
    // Merge cronológico: la siguiente fila con Marca temporal de cada hoja; gana la más antigua.
    var d = siguienteConTs_(ctxD, st.cursorDaily, tz, corteUTC, roster);
    var w = siguienteConTs_(ctxW, st.cursorWeekly, tz, corteUTC, roster);
    st.cursorDaily = d ? d.row : cursorFin_(ctxD);
    st.cursorWeekly = w ? w.row : cursorFin_(ctxW);
    if (!d && !w) { st.status = 'done'; break; }

    var esDaily = d && (!w || d.ev.ts.getTime() <= w.ev.ts.getTime());
    var ctx = esDaily ? ctxD : ctxW;
    var pick = esDaily ? d : w;

    if (pick.ev.estado !== 'elegible') {
      st.saltadas++;
    } else {
      procesadas++;
      try {
        var taskField = (ctx.tipo === 'daily') ? 'taskSummaryDaily' : 'taskSummaryWeekly';
        var summary = ingestarFila_(sheetId, config, ctx.tipo, pick.ev.meta, pick.ev.pairs,
          pick.row, composeSystem_(prompts, taskField), pick.ev.fecha);
        st.ok++;
        // Summary de regalo: solo si la celda estaba vacía (nunca pisar uno que el líder ya leyó).
        if (!pick.ev.summaryExistente && summary && ctx.headerMap['Summary']) {
          ctx.sh.getRange(pick.row, ctx.headerMap['Summary']).setValue(summary);
        }
      } catch (e) {
        st.errores++;
        logBackfill_(sheetId, config, now,
          '⚠️ backfill · fila ' + pick.row + ' de ' + ctx.nombre + ' falló: ' + ((e && e.message) || e));
      }
    }
    if (esDaily) st.cursorDaily = pick.row + 1; else st.cursorWeekly = pick.row + 1;
  }

  // ¿Se agotó el histórico justo al cierre del lote?
  if (st.status === 'running' && agotado_(ctxD, st.cursorDaily) && agotado_(ctxW, st.cursorWeekly)) {
    st.status = 'done';
  }
  if (st.status === 'done') {
    logBackfill_(sheetId, config, now,
      '✅ backfill completado · ' + st.ok + ' ingestada(s) · ' + st.saltadas + ' saltada(s) · ' + st.errores + ' error(es)');
  }

  guardarBackfill_(sheetId, config, st);
  return procesadas;
}

// --- Plan (conteo sin LLM) ---

/** Recorre ambas hojas clasificando cada fila. @return {{elegibles,fueraRetencion,fueraRoster,vacias}} */
function planBackfill_(sheetId, config, now) {
  var tz = config.timezone;
  var corteUTC = corteRetencionUTC_(config, now || new Date());
  var roster = rosterPorCorreo_(sheetId, config);
  var plan = { elegibles: 0, fueraRetencion: 0, fueraRoster: 0, vacias: 0 };

  ['daily', 'weekly'].forEach(function (tipo) {
    var ctx = contextoHojaBackfill_(sheetId, config, tipo, false);
    if (!ctx) return;
    for (var r = 2; r <= ctx.lastRow; r++) {
      var ev = evaluarFilaBackfill_(ctx, r, tz, corteUTC, roster);
      if (ev.estado === 'elegible') plan.elegibles++;
      else if (ev.estado === 'fuera-retencion') plan.fueraRetencion++;
      else if (ev.estado === 'fuera-roster') plan.fueraRoster++;
      else if (ev.estado === 'vacia') plan.vacias++;
      // 'sin-ts' (fila en blanco) no cuenta en el plan
    }
  });
  return plan;
}

// --- Lectura y clasificación de filas ---

/**
 * Contexto de una hoja para el backfill: encabezados + todas las filas leídas de una vez.
 * `asegurarSummary` crea la columna Summary si falta (solo en la pasada, que escribe).
 * @return {Object|null} null si la hoja no existe o no tiene filas de datos.
 */
function contextoHojaBackfill_(sheetId, config, tipo, asegurarSummary) {
  var sheetName = (tipo === 'daily') ? config.sheets.daily : config.sheets.weekly;
  var sh;
  try { sh = getSheet_(sheetId, sheetName); } catch (e) { return null; }

  if (asegurarSummary) ensureColumn_(sh, 'Summary');
  var headerMap = getHeaderMap_(sh);
  var lastRow = sh.getLastRow();
  if (!headerMap['Marca temporal'] || lastRow < 2) return null;

  return {
    tipo: tipo, nombre: sheetName, sh: sh, headerMap: headerMap, lastRow: lastRow,
    datos: sh.getRange(2, 1, lastRow - 1, sh.getLastColumn()).getValues()
  };
}

/**
 * Clasifica una fila: 'sin-ts' | 'fuera-retencion' | 'fuera-roster' | 'vacia' | 'elegible'.
 * Para las elegibles incluye { ts, fecha, meta, pairs, summaryExistente }.
 */
function evaluarFilaBackfill_(ctx, row, tz, corteUTC, roster) {
  var vals = ctx.datos[row - 2];
  var tsRaw = vals[ctx.headerMap['Marca temporal'] - 1];
  if (tsRaw === '' || tsRaw == null) return { estado: 'sin-ts' };
  var ts = (tsRaw instanceof Date) ? tsRaw : new Date(tsRaw);
  if (isNaN(ts.getTime())) return { estado: 'sin-ts' };

  var fecha = Utilities.formatDate(ts, tz, 'yyyy-MM-dd');
  if (isoAUTC_(fecha) < corteUTC) return { estado: 'fuera-retencion', ts: ts };

  var colVer = ctx.headerMap['Dirección de correo electrónico'];
  var colCor = ctx.headerMap['Correo'];
  var correo = String((colVer && vals[colVer - 1]) || (colCor && vals[colCor - 1]) || '').trim().toLowerCase();
  if (!correo || !(correo in roster)) return { estado: 'fuera-roster', ts: ts };

  var pairs = extraerQA_(ctx.headerMap, vals);
  if (!pairs.length) return { estado: 'vacia', ts: ts };

  var colSum = ctx.headerMap['Summary'];
  var sumPrevio = colSum ? String(vals[colSum - 1] == null ? '' : vals[colSum - 1]).trim() : '';
  return {
    estado: 'elegible', ts: ts, fecha: fecha,
    meta: { nombre: roster[correo] || correo, correo: correo },
    pairs: pairs, summaryExistente: !!sumPrevio
  };
}

/**
 * Siguiente fila con Marca temporal desde `cursor` (salta filas en blanco sin contarlas).
 * @return {{row:number, ev:Object}|null} null si la hoja se agotó (o no existe).
 */
function siguienteConTs_(ctx, cursor, tz, corteUTC, roster) {
  if (!ctx) return null;
  for (var r = Math.max(cursor, 2); r <= ctx.lastRow; r++) {
    var ev = evaluarFilaBackfill_(ctx, r, tz, corteUTC, roster);
    if (ev.estado !== 'sin-ts') return { row: r, ev: ev };
  }
  return null;
}

function cursorFin_(ctx) { return ctx ? ctx.lastRow + 1 : 2; }

function agotado_(ctx, cursor) { return !ctx || cursor > ctx.lastRow; }

// --- Helpers de estado / retención / roster / log ---

/** Persiste el estado completo del job en Ajustes (una sola escritura por pasada). */
function guardarBackfill_(sheetId, config, st) {
  setAjustes_(sheetId, config.sheets.settings, {
    'brain.backfill.status': st.status,
    'brain.backfill.cursorDaily': String(st.cursorDaily),
    'brain.backfill.cursorWeekly': String(st.cursorWeekly),
    'brain.backfill.total': String(st.total),
    'brain.backfill.ok': String(st.ok),
    'brain.backfill.saltadas': String(st.saltadas),
    'brain.backfill.errores': String(st.errores)
  });
}

/** Corte de retención en epoch-UTC (misma aritmética que purgarRaw_: hoy menos retentionMonths). */
function corteRetencionUTC_(config, now) {
  var meses = (config.brain && config.brain.retentionMonths) || 12;
  var corte = new Date(now);
  corte.setMonth(corte.getMonth() - meses);
  return isoAUTC_(Utilities.formatDate(corte, config.timezone, 'yyyy-MM-dd'));
}

/** Mapa correo(lower) → nombre del roster actual. Filas de gente que ya no está no matchean. */
function rosterPorCorreo_(sheetId, config) {
  var mapa = {};
  try {
    getRoster_(sheetId, config.sheets.roster).forEach(function (p) {
      if (p.correo) mapa[String(p.correo).trim().toLowerCase()] = p.nombre || '';
    });
  } catch (e) { /* sin roster → todo se salta como fuera-roster */ }
  return mapa;
}

/** Línea de auditoría del backfill en wiki/log.md (best-effort). */
function logBackfill_(sheetId, config, now, texto) {
  try {
    var root = ensureBrainFolder_(sheetId, config);
    var fecha = Utilities.formatDate(now || new Date(), config.timezone, 'yyyy-MM-dd');
    appendArchivoBrain_(carpetaBrain_(root, ['wiki']), 'log.md', '- ' + fecha + ' · ' + texto + '\n');
  } catch (e) {
    if (typeof Logger !== 'undefined') Logger.log('backfill: no se pudo escribir el log (%s).', e);
  }
}
