/**
 * meet-notes-runtime.js — Ingesta de "Notas de Gemini" (Google Meet) al second brain.
 *
 * Indexa al wiki los Docs de notas que Gemini genera por reunión: los propios (carpeta
 * "Google Meet" / legacy) y los COMPARTIDOS por otros organizadores. Diseño del grill (ago 2026):
 *
 *   Descubrimiento (3 fuentes, anti-dup por docId):
 *     a) attachments de los eventos del Calendar (REST v3 — CalendarApp no los expone; el combo
 *        calendar.readonly + getOAuthToken alcanza). La fuente MÁS confiable.
 *     b) carpetas propias de Meet (nombres localizados y re-estructurados por Google en jul-2026:
 *        se recorren "Google Meet" + un nivel de subcarpetas, y las legacy).
 *     c) sharedWithMe con sufijo de título ("Notas de Gemini" / "Notes by Gemini").
 *   Match Doc↔evento en cascada: attachment directo → parseo del título
 *     ("<Título>: yyyy/MM/dd HH:mm GMT±off - Notas de Gemini") + evento con título igual y hora
 *     ±60 min → sin match = acta standalone (matched: false). El título NUNCA es clave primaria.
 *   Extracción: 1 call Flash por Doc (el Doc ya es un resumen) con responseSchema: resumen +
 *     asistentes + eventos (tipos del brain + `accion` → sección "Pendientes").
 *   Personas: roster por correo; EXTERNOS con página propia `external: true` (fuera del scan de
 *     silencios y de todo correo), identidad estabilizada con _people.json (alias, patrón de
 *     proyectos). "Olvidar" borra su página; las actas (registro grupal) quedan.
 *   Cadencia: pasada 1×/hora con ventana de 7 días; durante el IMPORT INICIAL (lookbackDays del
 *     líder) corre en cada pasada del dispatcher, time-boxed. Sin-acceso (403): se cuenta y
 *     loguea 1×/día por doc, se reintenta al día siguiente mientras siga en ventana.
 *
 * Público (via dispatch): iniciarImportNotas, estadoImportNotas, cancelarImportNotas.
 * Hook del dispatcher: runMeetPass_. Ver Docs/workflows/SECOND-BRAIN/SECOND-BRAIN.md.
 * Sin import/export: runtime de Apps Script. Privados con sufijo "_".
 */

var MEET_VENTANA_DIAS_ = 7;        // régimen permanente: mirada-hacia-atrás de cada pasada horaria
var MEET_MAX_DOCS_PASADA_ = 10;    // tope de Docs ingestados por pasada (cada uno = 1 call Gemini)
var MEET_MATCH_TOLERANCIA_MS_ = 60 * 60000;   // título+hora: ±60 min contra el inicio del evento
var MEET_CARPETAS_ = ['Google Meet', 'Meet Recordings', 'Grabaciones de Meet'];
var MEET_SUFIJOS_ = ['Notas de Gemini', 'Notes by Gemini'];

/** responseSchema de la extracción de una nota de Meet. */
var MEET_SCHEMA_ = {
  type: 'object',
  properties: {
    resumen:    { type: 'string' },
    asistentes: { type: 'array', items: { type: 'string' } },
    eventos: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          persona:    { type: 'string' },
          correo:     { type: 'string' },   // SOLO si mapea a alguien del roster dado en el prompt
          proyecto:   { type: 'string' },
          tipo:       { type: 'string', enum: ['avance', 'blocker', 'riesgo', 'decision', 'accion'] },
          texto:      { type: 'string' },
          confidence: { type: 'number' }
        },
        required: ['tipo', 'texto']
      }
    }
  },
  required: ['resumen', 'eventos']
};

// --- API pública (sidebar via cosRun → dispatch) ---

/**
 * Estado del import inicial + config. Con `dias` calcula además el plan (docs pendientes de
 * ingestar en esa ventana — cuesta 1 fetch de Calendar + recorrido de Drive, sin LLM).
 * @return {{enabled, lookbackDays, status, total, ok, sinAcceso, errores, plan?}}
 */
function estadoImportNotas(sheetId, config, dias) {
  var aj = getAjustes_(sheetId, config.sheets.settings);
  var out = {
    enabled: aj.meet.enabled, lookbackDays: aj.meet.lookbackDays,
    status: aj.meet.import.status, total: aj.meet.import.total,
    ok: aj.meet.import.ok, sinAcceso: aj.meet.import.sinAcceso, errores: aj.meet.import.errores
  };
  if (dias) out.plan = { pendientes: notasPendientes_(sheetId, config, int_(dias, 30), new Date()).length };
  return out;
}

/**
 * Arranca el import inicial de notas: persiste lookbackDays, resetea contadores y deja el job
 * running (lo avanza el dispatcher, time-boxed). Exige brain.enabled y meet.enabled.
 * @return {{iniciado:boolean, status, total, ok, sinAcceso, errores}}
 */
function iniciarImportNotas(sheetId, config, dias) {
  if (!(config.brain && config.brain.enabled)) {
    throw new Error('Activa la memoria (brain.enabled) antes de importar notas de Meet.');
  }
  var aj = getAjustes_(sheetId, config.sheets.settings);
  if (!aj.meet.enabled) {
    throw new Error('Activa las notas de Meet (meet.enabled) y guarda antes de importar.');
  }
  if (aj.meet.import.status === 'running') {
    var st = aj.meet.import;
    return { iniciado: false, status: 'running', total: st.total, ok: st.ok, sinAcceso: st.sinAcceso, errores: st.errores };
  }

  var lookback = int_(dias, aj.meet.lookbackDays || 30);
  var pendientes = notasPendientes_(sheetId, config, lookback, new Date());
  setAjustes_(sheetId, config.sheets.settings, {
    'meet.lookbackDays': String(lookback),
    'meet.import.status': pendientes.length ? 'running' : 'done',
    'meet.import.total': String(pendientes.length),
    'meet.import.ok': '0',
    'meet.import.sinAcceso': '0',
    'meet.import.errores': '0'
  });
  return { iniciado: pendientes.length > 0, status: pendientes.length ? 'running' : 'done',
    total: pendientes.length, ok: 0, sinAcceso: 0, errores: 0 };
}

/** Pausa el import (status→idle). El anti-dup por docId hace que re-iniciar no re-ingeste nada. */
function cancelarImportNotas(sheetId, config) {
  setAjustes_(sheetId, config.sheets.settings, { 'meet.import.status': 'idle' });
  var st = getAjustes_(sheetId, config.sheets.settings).meet.import;
  return { status: st.status, total: st.total, ok: st.ok, sinAcceso: st.sinAcceso, errores: st.errores };
}

// --- Pasada del dispatcher ---

/**
 * Ingesta las notas nuevas. Régimen: 1×/hora, ventana de 7 días. Durante el import inicial
 * (status running): corre en CADA pasada con la ventana de lookbackDays hasta agotar pendientes.
 * @return {number} Docs ingestados en esta pasada
 */
function runMeetPass_(sheetId, config, now, deadlineMs) {
  var aj = getAjustes_(sheetId, config.sheets.settings);
  var importando = aj.meet.import.status === 'running';
  var tz = config.timezone;
  var today = Utilities.formatDate(now, tz, 'yyyy-MM-dd');

  if (!importando) {
    var horaKey = today + '-' + Utilities.formatDate(now, tz, 'HH');
    if (yaEnviado_(sheetId, 'meet-scan', 'hora', horaKey)) return 0;
    marcarEnviado_(sheetId, 'meet-scan', 'hora', horaKey);
  }

  var root;
  try {
    root = ensureBrainFolder_(sheetId, config);
  } catch (e) {
    if (typeof Logger !== 'undefined') Logger.log('meet: sin acceso a Drive, pasada pospuesta (%s).', e);
    return 0;
  }

  var dias = importando ? (aj.meet.lookbackDays || 30) : MEET_VENTANA_DIAS_;
  var cands = notasPendientes_(sheetId, config, dias, now);

  var stats = { ok: 0, sinAcceso: 0, errores: 0 };
  var procesadas = 0, pospuestas = 0;

  for (var i = 0; i < cands.length; i++) {
    var cand = cands[i];
    if (procesadas >= MEET_MAX_DOCS_PASADA_ || Date.now() > deadlineMs) { pospuestas++; continue; }
    procesadas++;

    try {
      var texto = exportarDocTexto_(cand.docId);
      if (texto == null) {
        // Sin acceso: se anota 1×/día por doc y se reintenta mañana (quizá ya lo compartieron).
        if (!yaEnviado_(sheetId, 'meet-noaccess', cand.docId, today)) {
          stats.sinAcceso++;
          appendArchivoBrain_(carpetaBrain_(root, ['wiki']), 'log.md',
            '- ' + today + ' · 🔒 nota de Meet sin acceso · ' + cand.tituloDoc + '\n');
          marcarEnviado_(sheetId, 'meet-noaccess', cand.docId, today);
        }
        continue;
      }
      ingestarNotaMeet_(sheetId, config, root, cand, texto, today);
      marcarEnviado_(sheetId, 'meet-doc', cand.docId, 'v1');
      stats.ok++;
    } catch (e) {
      stats.errores++;
      marcarEnviado_(sheetId, 'meet-doc', cand.docId, 'v1');   // no reintentar en bucle
      appendArchivoBrain_(carpetaBrain_(root, ['wiki']), 'log.md',
        '- ' + today + ' · ⚠️ nota de Meet falló · ' + cand.tituloDoc + ' · ' + ((e && e.message) || e) + '\n');
    }
  }

  if (importando) {
    var imp = aj.meet.import;
    var updates = {
      'meet.import.ok': String(imp.ok + stats.ok),
      'meet.import.sinAcceso': String(imp.sinAcceso + stats.sinAcceso),
      'meet.import.errores': String(imp.errores + stats.errores)
    };
    if (!pospuestas) {   // nada quedó fuera por presupuesto: todo ingestado, sin acceso o con error
      updates['meet.import.status'] = 'done';
      appendArchivoBrain_(carpetaBrain_(root, ['wiki']), 'log.md',
        '- ' + today + ' · ✅ import de notas de Meet completado · ' + (imp.ok + stats.ok) +
        ' indexada(s) · ' + (imp.sinAcceso + stats.sinAcceso) + ' sin acceso · ' +
        (imp.errores + stats.errores) + ' error(es)\n');
    }
    setAjustes_(sheetId, config.sheets.settings, updates);
  }
  return stats.ok;
}

// --- Descubrimiento (3 fuentes) + match ---

/** Candidatos de la ventana que AÚN no se ingestaron (filtra la guarda por docId). */
function notasPendientes_(sheetId, config, dias, now) {
  return descubrirNotasMeet_(config, dias, now).filter(function (c) {
    return !yaEnviado_(sheetId, 'meet-doc', c.docId, 'v1');
  });
}

/**
 * Une las 3 fuentes en un mapa por docId y matchea cada Doc a su evento del Calendar.
 * @return {Array<{docId, tituloDoc, eventId, evTitulo, inicioMs, tsMs}>}
 */
function descubrirNotasMeet_(config, dias, now) {
  var desdeMs = now.getTime() - dias * 86400000;
  var eventos = eventosCalendarREST_(desdeMs, now.getTime() + 86400000);
  var porDoc = {};

  // a) Attachments de eventos (fuente de verdad: match exacto por eventId).
  eventos.forEach(function (ev) {
    (ev.attachments || []).forEach(function (a) {
      if (!a.fileId) return;
      var esDoc = (a.mimeType === 'application/vnd.google-apps.document');
      if (!esDoc && !esTituloNotas_(a.title || '')) return;
      if (esDoc && a.title && !esTituloNotas_(a.title)) return;   // otros docs adjuntos no son notas
      porDoc[a.fileId] = { docId: a.fileId, tituloDoc: a.title || ev.titulo,
        eventId: ev.id, evTitulo: ev.titulo, inicioMs: ev.inicioMs, tsMs: 0 };
    });
  });

  // b) + c) Drive (carpetas propias + compartidos): match por título parseado.
  archivosNotasDrive_(desdeMs).forEach(function (f) {
    if (porDoc[f.docId]) return;
    var cand = { docId: f.docId, tituloDoc: f.titulo, eventId: '', evTitulo: '', inicioMs: 0, tsMs: 0 };
    var p = parsearTituloNotas_(f.titulo);
    if (p) {
      cand.tsMs = p.tsMs;
      var ev = matchEventoPorTitulo_(eventos, p.titulo, p.tsMs);
      if (ev) { cand.eventId = ev.id; cand.evTitulo = ev.titulo; cand.inicioMs = ev.inicioMs; }
    }
    porDoc[f.docId] = cand;
  });

  return Object.keys(porDoc).map(function (k) { return porDoc[k]; });
}

/** Eventos del calendario primario vía REST v3 (CalendarApp no expone attachments). */
function eventosCalendarREST_(desdeMs, hastaMs) {
  var url = 'https://www.googleapis.com/calendar/v3/calendars/primary/events' +
    '?singleEvents=true&maxResults=250' +
    '&timeMin=' + encodeURIComponent(new Date(desdeMs).toISOString()) +
    '&timeMax=' + encodeURIComponent(new Date(hastaMs).toISOString());
  try {
    var resp = UrlFetchApp.fetch(url, {
      headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
      muteHttpExceptions: true
    });
    if (resp.getResponseCode() !== 200) return [];
    var items = (JSON.parse(resp.getContentText()).items) || [];
    return items.map(function (it) {
      var inicio = (it.start && (it.start.dateTime || it.start.date)) || '';
      return {
        id: it.id, titulo: it.summary || '',
        inicioMs: inicio ? new Date(inicio).getTime() : 0,
        attachments: it.attachments || []
      };
    });
  } catch (e) {
    if (typeof Logger !== 'undefined') Logger.log('meet: Calendar REST falló (%s).', e);
    return [];
  }
}

/** Docs de notas en Drive: carpetas de Meet (+1 nivel de subcarpetas jul-2026) y sharedWithMe. */
function archivosNotasDrive_(desdeMs) {
  var out = [], vistos = {};
  function addFile(f) {
    var id = f.getId();
    if (vistos[id]) return;
    vistos[id] = true;
    var titulo = f.getName();
    if (!esTituloNotas_(titulo)) return;
    var creado = (typeof f.getDateCreated === 'function') ? f.getDateCreated() : null;
    if (creado && creado.getTime() < desdeMs) return;
    out.push({ docId: id, titulo: titulo });
  }
  function addCarpeta(folder, conSubcarpetas) {
    var fit = folder.getFiles();
    while (fit.hasNext()) addFile(fit.next());
    if (!conSubcarpetas) return;
    var sit = folder.getFolders();
    while (sit.hasNext()) addCarpeta(sit.next(), false);   // un solo nivel (subcarpeta por reunión)
  }

  MEET_CARPETAS_.forEach(function (nombre) {
    try {
      var it = DriveApp.getFoldersByName(nombre);
      while (it.hasNext()) addCarpeta(it.next(), true);
    } catch (e) { /* best-effort por carpeta */ }
  });
  try {
    var q = 'sharedWithMe and trashed = false and mimeType = "application/vnd.google-apps.document"';
    var si = DriveApp.searchFiles(q);
    while (si.hasNext()) addFile(si.next());
  } catch (e) { /* sin permiso de búsqueda o mock sin soporte */ }
  return out;
}

/** ¿El título termina en un sufijo de notas de Gemini? */
function esTituloNotas_(titulo) {
  var t = String(titulo == null ? '' : titulo).trim();
  return MEET_SUFIJOS_.some(function (s) { return t.slice(-s.length) === s; });
}

/**
 * Parsea el patrón real de los títulos ('AAP - Team: 2026/07/31 14:29 GMT-03:00 - Notas de
 * Gemini'). El offset explícito vuelve el timestamp absoluto (las zonas no son problema).
 * @return {?{titulo:string, tsMs:number}}
 */
function parsearTituloNotas_(titulo) {
  var re = /^(.+?):\s*(\d{4})\/(\d{2})\/(\d{2})\s+(\d{1,2}):(\d{2})\s*GMT([+-])(\d{2}):?(\d{2})\s*-\s*(?:Notas de Gemini|Notes by Gemini)\s*$/;
  var m = re.exec(String(titulo == null ? '' : titulo).trim());
  if (!m) return null;
  var offMin = (m[7] === '-' ? -1 : 1) * (parseInt(m[8], 10) * 60 + parseInt(m[9], 10));
  var tsMs = Date.UTC(+m[2], +m[3] - 1, +m[4], +m[5], +m[6]) - offMin * 60000;
  return { titulo: m[1].trim(), tsMs: tsMs };
}

/** Evento con título igual (normalizado) e inicio a ±60 min del timestamp del título. */
function matchEventoPorTitulo_(eventos, titulo, tsMs) {
  var buscado = normTitulo_(titulo);
  if (!buscado) return null;
  for (var i = 0; i < eventos.length; i++) {
    var ev = eventos[i];
    if (normTitulo_(ev.titulo) !== buscado) continue;
    if (Math.abs(ev.inicioMs - tsMs) <= MEET_MATCH_TOLERANCIA_MS_) return ev;
  }
  return null;
}

function normTitulo_(s) { return String(s == null ? '' : s).trim().toLowerCase().replace(/\s+/g, ' '); }

/** Exporta el texto plano del Doc (files.export funciona con el scope drive). null = sin acceso. */
function exportarDocTexto_(docId) {
  var url = 'https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(docId) +
    '/export?mimeType=text%2Fplain';
  var resp = UrlFetchApp.fetch(url, {
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    muteHttpExceptions: true
  });
  var code = resp.getResponseCode();
  if (code === 200) return resp.getContentText();
  if (code === 403 || code === 404) return null;
  throw new Error('export del Doc falló (HTTP ' + code + ')');
}

// --- Ingesta de un Doc ---

function ingestarNotaMeet_(sheetId, config, root, cand, texto, today) {
  var tz = config.timezone;
  var baseMs = cand.inicioMs || cand.tsMs;
  var fecha = baseMs ? Utilities.formatDate(new Date(baseMs), tz, 'yyyy-MM-dd') : today;
  var p = parsearTituloNotas_(cand.tituloDoc);
  var titulo = cand.evTitulo || (p && p.titulo) || cand.tituloDoc;

  var roster = [];
  try { roster = getRoster_(sheetId, config.sheets.roster); } catch (e) { roster = []; }

  // Schema por llamada (proyectos como enum) + temperatura 0: extracción de hechos, no creatividad.
  var raw = callGemini_(config.models.perRow, meetSystem_(),
    meetUser_(titulo, fecha, roster, cargarExternosConocidos_(root), texto, config.leader,
      pendientesAbiertosEquipo_(root, roster)),
    { responseSchema: schemaConProyectos_(root, MEET_SCHEMA_), temperature: 0 });
  var parsed = parseNotaMeet_(raw);

  // 1) raw/ inmutable (verdad de origen del Doc exportado).
  var source = guardarRawMeet_(root, cand, titulo, fecha, texto);

  // 2) proyectos. La compuerta puede rechazar (null): el evento vive igual en persona/acta.
  var proyectos = {};
  var rechazados = [];
  parsed.eventos.forEach(function (ev) {
    var nombre = nombreProyectoEvento_(ev);
    if (!nombre) return;
    var pr = resolverProyecto_(root, nombre);
    if (!pr) { rechazados.push(nombre); return; }
    proyectos[pr.slug] = pr.name;
    ev._proyectoName = pr.name;
  });
  appendLogRechazos_(root, fecha, rechazados);
  Object.keys(proyectos).forEach(function (slug) {
    regenerarPaginaProyecto_(root, slug, proyectos[slug],
      parsed.eventos.filter(function (ev) { return ev._proyectoName === proyectos[slug]; }), source, fecha);
  });

  // 3) personas: roster por correo/nombre; externos con página `external: true` + alias.
  var porPersona = agruparEventosPorPersona_(root, roster, parsed.eventos, config.leader);
  Object.keys(porPersona).forEach(function (key) {
    var g = porPersona[key];
    var proys = [];
    g.eventos.forEach(function (ev) {
      if (ev._proyectoName && proys.indexOf(ev._proyectoName) === -1) proys.push(ev._proyectoName);
    });
    regenerarPaginaPersona_(root, g.meta, g.eventos, source, fecha, proys);
  });

  // 3b) Tareas del líder: sus acciones aterrizan en la hoja Tareas (fuente del Morning Briefing).
  var liderCorreo = String((config.leader && config.leader.email) || '').toLowerCase();
  if (liderCorreo) {
    parsed.eventos.forEach(function (ev) {
      if (ev.tipo !== 'accion') return;
      var evCorreo = String(ev.correo || '').trim().toLowerCase();
      var esDelLider = evCorreo === liderCorreo ||
        (ev.persona && config.leader.name && normTitulo_(ev.persona) === normTitulo_(config.leader.name));
      if (!esDelLider) return;
      try {
        agregarTarea_(sheetId, config, {
          texto: ev.texto, proyecto: ev._proyectoName || '',
          origen: '🎥 ' + titulo + ' · ' + fecha
        });
      } catch (e) {
        if (typeof Logger !== 'undefined') Logger.log('meet: no se pudo crear la tarea (%s).', e);
      }
    });
  }

  // 4) acta en wiki/meetings/ (merge con la del Deep Prep si comparten eventId).
  actaNotaMeet_(root, cand, parsed, titulo, fecha, source);

  // 5) bitácora + índice.
  regenerarIndexBrain_(root, fecha);
  var acciones = parsed.eventos.filter(function (ev) { return ev.tipo === 'accion'; }).length;
  appendArchivoBrain_(carpetaBrain_(root, ['wiki']), 'log.md',
    '- ' + fecha + ' · 🎥 notas de Meet · ' + titulo + ' · ' + parsed.eventos.length +
    ' eventos' + (acciones ? ' · ' + acciones + ' pendiente(s)' : '') +
    (cand.eventId ? '' : ' · sin evento (standalone)') + '\n');
}

function meetSystem_() {
  return [
    'Eres el Chief of Staff del líder. Recibes las notas de una reunión (generadas por Gemini en',
    'Meet) y extraes hechos estructurados para la memoria del equipo.',
    'Devuelve SOLO un JSON con:',
    '- "resumen": 2-3 frases ejecutivas de la reunión.',
    '- "asistentes": nombres de las personas que participaron o se mencionan como asistentes.',
    '- "eventos": hechos atómicos { persona, correo, proyecto, tipo, texto, confidence }.',
    '  · tipo ∈ avance | blocker | riesgo | decision | accion.',
    '  · "accion" = compromisos/próximos pasos con dueño ("[Persona] hacer X").',
    '  · "correo": SOLO si la persona corresponde a alguien del EQUIPO listado abajo (usa ese',
    '    correo exacto). Si es alguien de fuera, deja correo vacío y pon su nombre completo tal',
    '    como aparece; si ya existe en EXTERNOS CONOCIDOS, usa ese nombre canónico.',
    '  · proyecto: elige EXACTAMENTE uno del catálogo permitido; si la iniciativa no está en el',
    '    catálogo, pon proyecto "OTRO" y SOLO el nombre propio (máximo 3-4 palabras) en',
    '    "proyecto_nuevo". Si no es evidente, pon proyecto "NINGUNO". NUNCA escribas razonamiento,',
    '    alternativas ni explicaciones dentro de ningún campo.',
    '  · DEDUP: si una acción ya figura (aunque parafraseada) en los PENDIENTES YA REGISTRADOS',
    '    de esa persona, NO la emitas de nuevo como evento "accion".',
    'No inventes: si un hecho no da para evento, no lo fuerces.'
  ].join('\n');
}

/** Pendientes abiertos por persona del roster (para el dedup del prompt; recortado). */
function pendientesAbiertosEquipo_(root, roster) {
  var lineas = [];
  var carpeta = carpetaBrain_(root, ['wiki', 'people']);
  roster.forEach(function (p) {
    var contenido = leerArchivoBrain_(carpeta, slugBrain_(p.correo || p.nombre) + '.md');
    if (!contenido) return;
    var abiertos = [];
    parseBodySections_(parsearPagina_(contenido).body).sections.forEach(function (s) {
      if (s.name !== 'Pendientes') return;
      s.lines.forEach(function (l) {
        if (!esPendienteAbierto_(l)) return;
        var m = SEG_VINETA_RE_.exec(l.trim());
        if (m) abiertos.push(recorteTexto_(m[2], 100));
      });
    });
    abiertos.slice(0, 5).forEach(function (t) {
      lineas.push('- ' + (p.nombre || p.correo) + ': ' + t);
    });
  });
  return lineas;
}

function meetUser_(titulo, fecha, roster, externos, texto, leader, pendientesRegistrados) {
  var lineasEquipo = roster.map(function (pp) { return '- ' + (pp.nombre || pp.correo) + ' <' + pp.correo + '>'; });
  // El líder no está en el roster: se lista aparte para que sus acciones mapeen a su correo
  // (aterrizan en la hoja Tareas, la fuente del Morning Briefing).
  if (leader && leader.email) {
    lineasEquipo.unshift('- ' + (leader.name || 'Líder') + ' <' + leader.email + '> (el líder)');
  }
  return 'REUNIÓN: ' + titulo + ' (' + fecha + ')\n\n' +
    'EQUIPO (roster del líder):\n' + (lineasEquipo.join('\n') || '- (vacío)') + '\n\n' +
    'EXTERNOS CONOCIDOS:\n' + (externos.length ? externos.map(function (n) { return '- ' + n; }).join('\n') : '- (ninguno)') + '\n\n' +
    'PENDIENTES YA REGISTRADOS (no los repitas como acciones nuevas):\n' +
    ((pendientesRegistrados && pendientesRegistrados.length) ? pendientesRegistrados.join('\n') : '- (ninguno)') + '\n\n' +
    'NOTAS DE LA REUNIÓN:\n' + recorteTexto_(String(texto == null ? '' : texto), 9000);
}

/** Parse tolerante de la respuesta del LLM. */
function parseNotaMeet_(text) {
  var t = String(text == null ? '' : text).trim();
  try {
    var o = JSON.parse(t);
    return {
      resumen: recorteTexto_(str_(o.resumen), RESUMEN_MAX_),
      asistentes: Array.isArray(o.asistentes) ? o.asistentes.map(function (a) { return str_(a); }).filter(Boolean) : [],
      eventos: Array.isArray(o.eventos)
        ? o.eventos.filter(function (e) { return e && e.texto && e.tipo; }).map(truncarEvento_)
        : []
    };
  } catch (e) {
    return { resumen: t, asistentes: [], eventos: [] };
  }
}

/**
 * Agrupa eventos por persona resuelta: roster (correo o nombre) → interna; si no → externa.
 * Los eventos del PROPIO líder no crean página (van a su hoja Tareas y al acta).
 */
function agruparEventosPorPersona_(root, roster, eventos, leader) {
  var porCorreo = {}, porNombre = {};
  roster.forEach(function (pp) {
    porCorreo[pp.correo.toLowerCase()] = pp;
    if (pp.nombre) porNombre[normTitulo_(pp.nombre)] = pp;
  });
  var liderCorreo = String((leader && leader.email) || '').toLowerCase();
  var liderNombre = normTitulo_((leader && leader.name) || '');

  var grupos = {};
  eventos.forEach(function (ev) {
    var meta = null;
    var correo = String(ev.correo || '').trim().toLowerCase();
    if (liderCorreo && (correo === liderCorreo || (ev.persona && normTitulo_(ev.persona) === liderNombre && liderNombre))) {
      return;   // el líder no lleva página de persona
    }
    if (correo && porCorreo[correo]) {
      meta = { nombre: porCorreo[correo].nombre || correo, correo: correo };
    } else if (ev.persona && porNombre[normTitulo_(ev.persona)]) {
      var pr = porNombre[normTitulo_(ev.persona)];
      meta = { nombre: pr.nombre, correo: pr.correo.toLowerCase() };
    } else if (ev.persona && String(ev.persona).trim()) {
      // La compuerta puede rechazar el nombre (fuga del LLM): el evento queda anónimo (acta).
      var ext = resolverExterno_(root, ev.persona);
      if (ext) meta = { nombre: ext.name, correo: '', external: true };
    }
    if (!meta) return;   // sin persona: el hecho vive en el acta y el proyecto

    var key = meta.correo || ('ext:' + slugBrain_(meta.nombre));
    if (!grupos[key]) grupos[key] = { meta: meta, eventos: [] };
    grupos[key].eventos.push(ev);
  });
  return grupos;
}

// --- Identidad de externos (_people.json: mismo patrón de alias que _projects.json) ---

function cargarExternosConocidos_(root) {
  var mapa = cargarPersonasExt_(root);
  return Object.keys(mapa).map(function (slug) { return mapa[slug].name; });
}

function cargarPersonasExt_(root) {
  var carpeta = carpetaBrain_(root, ['wiki', 'people']);
  var raw = leerArchivoBrain_(carpeta, '_people.json');
  if (!raw) return {};
  try { var o = JSON.parse(raw); return (o && typeof o === 'object') ? o : {}; } catch (e) { return {}; }
}

function guardarPersonasExt_(root, mapa) {
  escribirArchivoBrain_(carpetaBrain_(root, ['wiki', 'people']), '_people.json', JSON.stringify(mapa, null, 2));
}

/**
 * ¿Los tokens de un slug son subconjunto del otro? Para NOMBRES de persona el Jaccard puro se
 * queda corto ("carol" vs "carol-diaz" = 0.5): nombre parcial ⊂ nombre completo debe matchear.
 */
function slugContenido_(a, b) {
  var A = String(a).split('-').filter(Boolean);
  var B = String(b).split('-').filter(Boolean);
  if (!A.length || !B.length) return false;
  var corto = A.length <= B.length ? A : B;
  var setLargo = {};
  (A.length <= B.length ? B : A).forEach(function (t) { setLargo[t] = true; });
  return corto.every(function (t) { return setLargo[t]; });
}

/**
 * Resuelve el nombre de un externo a su canónico: compuerta de sanidad (null si huele a fuga del
 * LLM) → exacto/alias → difuso/contenido → autocreate. ÚNICO punto por el que un string del LLM
 * puede crear una página de persona externa.
 * @return {{slug:string, name:string}|null}
 */
function resolverExterno_(root, nombre) {
  var limpio = sanitizarPersona_(nombre);
  if (!limpio) return null;
  var mapa = cargarPersonasExt_(root);
  var slug = slugBrain_(limpio);

  var canon = Object.keys(mapa);
  for (var i = 0; i < canon.length; i++) {
    if (canon[i] === slug || (mapa[canon[i]].aliases || []).indexOf(slug) > -1) {
      return { slug: canon[i], name: mapa[canon[i]].name };
    }
  }
  var mejor = null, mejorSim = 0;
  for (var j = 0; j < canon.length; j++) {
    var sim = similitudSlug_(canon[j], slug);
    if (slugContenido_(canon[j], slug)) sim = Math.max(sim, 1);   // "carol" ⊂ "carol-diaz"
    if (sim > mejorSim) { mejorSim = sim; mejor = canon[j]; }
  }
  if (mejor && mejorSim >= PROYECTO_SIMIL_MIN_) {
    if (slug !== mejor && (mapa[mejor].aliases || []).indexOf(slug) === -1) {
      mapa[mejor].aliases = (mapa[mejor].aliases || []).concat([slug]);
      guardarPersonasExt_(root, mapa);
    }
    return { slug: mejor, name: mapa[mejor].name };
  }
  mapa[slug] = { name: limpio, aliases: [] };
  guardarPersonasExt_(root, mapa);
  return { slug: slug, name: mapa[slug].name };
}

// --- Escritura: raw + acta ---

function guardarRawMeet_(root, cand, titulo, fecha, texto) {
  var carpeta = carpetaBrain_(root, ['raw', 'meetings']);
  var name = fecha + '_' + slugBrain_(titulo) + '_' + slugBrain_(cand.docId).slice(0, 8) + '.md';
  var fm = {
    page_type: 'meeting-notes', title: titulo, date: fecha,
    doc_id: cand.docId, event_id: cand.eventId || '', matched: !!cand.eventId
  };
  ensureArchivoBrain_(carpeta, name, componerPagina_(fm, String(texto == null ? '' : texto)));
  return 'raw/meetings/' + name;
}

/** Acta en wiki/meetings/: mergea con la del Deep Prep si comparten eventId; si no, crea/mergea. */
function actaNotaMeet_(root, cand, parsed, titulo, fecha, source) {
  var carpeta = carpetaBrain_(root, ['wiki', 'meetings']);
  var acciones = parsed.eventos.filter(function (ev) { return ev.tipo === 'accion'; });

  var existente = cand.eventId ? buscarActaPorEvento_(carpeta, cand.eventId) : null;
  if (!existente) {
    var name = fecha + '_' + slugBrain_(titulo) + '.md';
    var prev = leerArchivoBrain_(carpeta, name);
    if (prev) existente = { name: name, content: prev };   // recurrente/mismo día: mergear
  }

  if (existente) {
    var page = parsearPagina_(existente.content);
    var ps = parseBodySections_(page.body);
    upsertLineaSeccion_(ps, 'Notas (Gemini)', '- [' + fecha + '] ' + recorteTexto_(parsed.resumen, 400));
    acciones.forEach(function (a) {
      upsertLineaSeccion_(ps, 'Pendientes', '- [' + fecha + '] ' + (a.persona ? a.persona + ': ' : '') + a.texto);
    });
    var fm = mergeFrontmatter_(page.frontmatter, {
      doc_id: cand.docId, sources: [source], attendees: parsed.asistentes || []
    });
    escribirArchivoBrain_(carpeta, existente.name, componerPagina_(fm, renderBodySections_(ps)));
    return 'wiki/meetings/' + existente.name;
  }

  var nuevo = fecha + '_' + slugBrain_(titulo) + '.md';
  var cuerpo = '# ' + titulo + ' (' + fecha + ')\n\n' + (parsed.resumen || '') + '\n';
  if (acciones.length) {
    cuerpo += '\n## Pendientes\n' + acciones.map(function (a) {
      return '- [' + fecha + '] ' + (a.persona ? a.persona + ': ' : '') + a.texto;
    }).join('\n') + '\n';
  }
  escribirArchivoBrain_(carpeta, nuevo, componerPagina_({
    page_type: 'meeting', name: titulo, date: fecha,
    event_id: cand.eventId || '', doc_id: cand.docId, matched: !!cand.eventId,
    attendees: parsed.asistentes || [], sources: [source]
  }, cuerpo));
  return 'wiki/meetings/' + nuevo;
}

function buscarActaPorEvento_(carpeta, eventId) {
  var archivos = listarArchivosBrain_(carpeta, '.md');
  for (var i = 0; i < archivos.length; i++) {
    var fm = parsearPagina_(archivos[i].content).frontmatter || {};
    if (str_(fm.event_id) === eventId) return archivos[i];
  }
  return null;
}
