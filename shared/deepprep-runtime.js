/**
 * deepprep-runtime.js — "Deep Prep": briefing pre-reunión a partir del second brain.
 *
 * Feature flag `deepPrep.enabled` (requiere `brain.enabled` para tener memoria que leer). El líder
 * marca reuniones desde el sidebar (deepPrep.selected = eventIds del Calendar). El dispatcher, en
 * cada pasada, revisa esas reuniones: si alguna arranca dentro de `deepPrep.leadHours`, genera el
 * prep UNA vez (anti-dup por eventId) y lo manda al líder como PDF de marca + TL;DR en el cuerpo.
 *
 * Flujo de generación (generarDeepPrep_):
 *   Calendar (asistentes, hora) + wiki/people|projects de los asistentes  →  Gemini Pro (responseSchema
 *   { tldr, briefing })  →  HTML de marca (email-runtime)  →  PDF (Utilities.newBlob(html).getAs pdf)
 *   →  correo al líder (TL;DR + PDF adjunto)  →  archivo en wiki/meetings/.
 *
 * Un solo call a Gemini por reunión; el brain aporta el contexto (no se re-consulta a nadie).
 * Ver Docs/workflows/SECOND-BRAIN/SECOND-BRAIN.md.
 *
 * Sin import/export: runtime de Apps Script. Privados con sufijo "_".
 */

/** responseSchema del call de Deep Prep: resumen ejecutivo + briefing seccionado. */
var DEEPPREP_SCHEMA_ = {
  type: 'object',
  properties: {
    tldr:     { type: 'string' },   // 2-3 frases: qué es, por qué importa, qué decidir
    briefing: { type: 'string' }    // texto seccionado (encabezados + viñetas) que se pinta como tarjetas
  },
  required: ['tldr', 'briefing']
};

var DEEPPREP_LEAD_DEFAULT_ = 3;     // horas antes de la reunión (fallback)
var DEEPPREP_VENTANA_DIAS_ = 7;     // horizonte del listado de reuniones del sidebar

// --- Sidebar: listar / marcar reuniones ---

/**
 * Lista las reuniones próximas (Calendar por defecto) para pintarlas en el sidebar, marcando las
 * que ya están seleccionadas para prep. Público (via dispatch). Tolera Calendar vacío.
 * @return {Array<{id,titulo,inicio,asistentes,seleccionado}>}
 */
function listarReunionesProximas(sheetId, config, dias) {
  var n = int_(dias, DEEPPREP_VENTANA_DIAS_);
  var tz = config.timezone;
  var ahora = new Date();
  var fin = new Date(ahora.getTime() + n * 86400000);

  var eventos = [];
  try {
    eventos = CalendarApp.getDefaultCalendar().getEvents(ahora, fin) || [];
  } catch (e) {
    if (typeof Logger !== 'undefined') Logger.log('deepprep: no se pudo leer el Calendar (%s).', e);
    return [];
  }

  var aj = getAjustes_(sheetId, config.sheets.settings);
  var sel = {};
  (aj.deepPrep.selected || []).forEach(function (id) { sel[id] = true; });

  return eventos.map(function (ev) {
    var inicio = ev.getStartTime();
    return {
      id: ev.getId(),
      titulo: ev.getTitle() || '(sin título)',
      inicio: inicio ? Utilities.formatDate(inicio, tz, 'yyyy-MM-dd HH:mm') : '',
      asistentes: (ev.getGuestList() || []).map(function (g) { return g.getEmail(); }),
      seleccionado: !!sel[ev.getId()]
    };
  });
}

/**
 * Marca/desmarca una reunión para Deep Prep (persistiendo deepPrep.selected en Ajustes). Si `on`
 * se omite, alterna. Público (via dispatch). @return {{selected:string[]}}
 */
function toggleReunionPrep(sheetId, config, eventId, on) {
  var aj = getAjustes_(sheetId, config.sheets.settings);
  var sel = aj.deepPrep.selected || [];
  var i = sel.indexOf(eventId);
  var quiere = (on === undefined || on === null) ? (i === -1) : !!on;

  if (quiere && i === -1) sel.push(eventId);
  else if (!quiere && i > -1) sel.splice(i, 1);

  setAjustes_(sheetId, config.sheets.settings, { 'deepPrep.selected': JSON.stringify(sel) });
  return { selected: sel };
}

// --- Dispatcher: pasada de Deep Prep (la invoca runDispatcher si deepPrep.enabled) ---

/**
 * Recorre las reuniones seleccionadas y genera el prep de las que arrancan dentro de leadHours.
 * Anti-dup por eventId (una reunión se prepara una sola vez). Best-effort por reunión.
 */
function runDeepPrepPass_(sheetId, config, now) {
  var sel = (config.deepPrep && config.deepPrep.selected) || [];
  if (!sel.length) return;

  var leadMs = ((config.deepPrep && config.deepPrep.leadHours) || DEEPPREP_LEAD_DEFAULT_) * 3600000;
  var tz = config.timezone;
  var cal;
  try { cal = CalendarApp.getDefaultCalendar(); } catch (e) { return; }

  sel.forEach(function (eventId) {
    var ev = null;
    try { ev = cal.getEventById(eventId); } catch (e) { ev = null; }
    if (!ev) return;

    var inicio = ev.getStartTime();
    if (!inicio) return;
    var delta = inicio.getTime() - now.getTime();
    if (delta < 0 || delta > leadMs) return;   // ya pasó, o aún fuera de la ventana lead

    var fechaEv = Utilities.formatDate(inicio, tz, 'yyyy-MM-dd');
    if (yaEnviado_(sheetId, 'deepprep', eventId, fechaEv)) return;

    try {
      generarDeepPrep_(sheetId, config, eventId);
    } catch (e) {
      if (typeof Logger !== 'undefined') Logger.log('deepprep: generación falló para %s (%s).', eventId, e);
    }
    marcarEnviado_(sheetId, 'deepprep', eventId, fechaEv);   // marca aun si falló: no reintentar en bucle
  });
}

// --- Generación del Deep Prep ---

/**
 * Genera y envía el Deep Prep de UNA reunión ya, sin esperar la ventana de anticipación ni la
 * anti-dup. Público — para el smoke manual desde el stub (testDeepPrep). Si no se pasa eventId,
 * toma la primera reunión de los próximos DEEPPREP_VENTANA_DIAS_ días.
 * @return {{enviado:boolean, eventId:string, archivo:string}}
 */
function probarDeepPrep(sheetId, config, eventId) {
  if (!eventId) {
    var proximas = listarReunionesProximas(sheetId, config, DEEPPREP_VENTANA_DIAS_);
    if (!proximas.length) {
      throw new Error('No hay reuniones en los próximos ' + DEEPPREP_VENTANA_DIAS_ + ' días para probar.');
    }
    eventId = proximas[0].id;
  }
  return generarDeepPrep_(sheetId, config, eventId);
}

/**
 * Genera y envía el Deep Prep de una reunión. Privado: lo invocan runDeepPrepPass_ (dispatcher)
 * y probarDeepPrep (smoke manual).
 * @return {{enviado:boolean, eventId:string, archivo:string}}
 */
function generarDeepPrep_(sheetId, config, eventId) {
  var root = ensureBrainFolder_(sheetId, config);
  var ev = CalendarApp.getDefaultCalendar().getEventById(eventId);
  if (!ev) throw new Error('Evento no encontrado: ' + eventId);

  var evento = detalleEvento_(ev, config);
  var contexto = contextoReunion_(root, evento);
  var raw = callGemini_(config.models.consolidated, deepPrepSystem_(), deepPrepUser_(evento, contexto),
    { responseSchema: DEEPPREP_SCHEMA_ });
  var prep = parseDeepPrep_(raw);

  // Cuerpo del correo: render pensado para clientes de correo (wordmark como texto).
  var html = renderDeepPrepHtml_(evento, prep.tldr, prep.briefing);
  // Adjunto PDF: documento de marca (masthead con logo, hero, TL;DR destacado). Ver email-runtime.js.
  var pdfHtml = renderDeepPrepPdfHtml_(evento, prep.tldr, prep.briefing);
  var pdf = Utilities.newBlob(pdfHtml, 'text/html', 'deep-prep.html')
    .getAs('application/pdf')
    .setName('Deep Prep — ' + evento.titulo + '.pdf');

  var leader = (config.leader && config.leader.email) || '';
  if (leader) {
    MailApp.sendEmail(leader, 'Deep Prep — ' + evento.titulo, prep.tldr, {
      htmlBody: html,
      attachments: [pdf]
    });
  }

  var archivo = archivarReunion_(root, evento, prep);
  return { enviado: !!leader, eventId: eventId, archivo: archivo };
}

/** Normaliza un CalendarEvent al shape que usan el prompt y el render. */
function detalleEvento_(ev, config) {
  var tz = config.timezone;
  var inicio = ev.getStartTime();
  return {
    id: ev.getId(),
    titulo: ev.getTitle() || '(sin título)',
    fecha: inicio ? Utilities.formatDate(inicio, tz, 'yyyy-MM-dd') : '',
    hora:  inicio ? Utilities.formatDate(inicio, tz, 'HH:mm') : '',
    descripcion: (ev.getDescription && ev.getDescription()) || '',
    ubicacion: (ev.getLocation && ev.getLocation()) || '',
    asistentes: (ev.getGuestList && ev.getGuestList() || []).map(function (g) { return g.getEmail(); })
  };
}

/**
 * Arma el contexto de la reunión desde el brain: página de cada asistente + páginas de los
 * proyectos que esos asistentes tocan (por frontmatter.projects). Recorta para no inflar el prompt.
 */
function contextoReunion_(root, evento) {
  var people = carpetaBrain_(root, ['wiki', 'people']);
  var projects = carpetaBrain_(root, ['wiki', 'projects']);
  var partes = [];
  var proyectos = {};

  (evento.asistentes || []).forEach(function (email) {
    var pg = leerArchivoBrain_(people, slugBrain_(email) + '.md');
    if (!pg) return;
    var parsed = parsearPagina_(pg);
    partes.push('### Persona: ' + (parsed.frontmatter.name || email) + '\n' + recorteTexto_(parsed.body, 1200));
    var proys = Array.isArray(parsed.frontmatter.projects) ? parsed.frontmatter.projects : [];
    proys.forEach(function (nombre) { proyectos[slugBrain_(nombre)] = true; });
  });

  Object.keys(proyectos).forEach(function (slug) {
    var pg = leerArchivoBrain_(projects, slug + '.md');
    if (!pg) return;
    var parsed = parsearPagina_(pg);
    partes.push('### Proyecto: ' + (parsed.frontmatter.name || slug) + '\n' + recorteTexto_(parsed.body, 1200));
  });

  return partes.join('\n\n');
}

function recorteTexto_(s, n) {
  s = str_(s);
  return s.length > n ? s.slice(0, n) + '…' : s;
}

/** System-prompt del Deep Prep. */
function deepPrepSystem_() {
  return [
    'Eres el Chief of Staff del líder. Preparas un briefing PRE-REUNIÓN conciso y accionable a',
    'partir de la memoria organizacional (notas de personas y proyectos) y los datos del evento.',
    'Devuelve SOLO un JSON con:',
    '- "tldr": 2-3 frases — qué es la reunión, por qué importa ahora y qué debe decidir/lograr el líder.',
    '- "briefing": texto con SECCIONES (encabezados en MAYÚSCULAS) y viñetas. Sugeridas:',
    '    CONTEXTO · ASISTENTES (una viñeta por persona: estado y blockers) · PROYECTOS EN JUEGO ·',
    '    RIESGOS Y DECISIONES PENDIENTES · PREGUNTAS QUE HARÍA EL LÍDER.',
    'Sé específico y breve. Si la memoria no cubre algo, dilo en vez de inventar.'
  ].join('\n');
}

/** Bloque de usuario: datos del evento + contexto del brain. */
function deepPrepUser_(evento, contexto) {
  var head = 'REUNIÓN: ' + evento.titulo + '\n' +
    'Fecha: ' + evento.fecha + (evento.hora ? ' ' + evento.hora : '') + '\n' +
    (evento.ubicacion ? 'Lugar: ' + evento.ubicacion + '\n' : '') +
    'Asistentes: ' + (evento.asistentes.join(', ') || '(no listados)') + '\n' +
    (evento.descripcion ? 'Descripción: ' + evento.descripcion + '\n' : '');
  var mem = contexto ? ('\n--- MEMORIA ORGANIZACIONAL ---\n' + contexto)
                     : '\n(No hay notas en la memoria para los asistentes de esta reunión.)';
  return head + mem;
}

/** Parsea el JSON del call; tolerante: si falla, todo el texto va a briefing y un extracto a tldr. */
function parseDeepPrep_(text) {
  var t = str_(text).trim();
  try {
    var o = JSON.parse(t);
    return { tldr: str_(o.tldr), briefing: str_(o.briefing) };
  } catch (e) {
    return { tldr: t.slice(0, 280), briefing: t };
  }
}

/** Archiva el prep en wiki/meetings/ (regenerable, con frontmatter). @return {string} ruta relativa. */
function archivarReunion_(root, evento, prep) {
  var carpeta = carpetaBrain_(root, ['wiki', 'meetings']);
  var name = (evento.fecha || 'sin-fecha') + '_' + slugBrain_(evento.titulo) + '.md';
  var fm = {
    page_type: 'meeting',
    name: evento.titulo,
    date: evento.fecha,
    event_id: evento.id,
    attendees: evento.asistentes || [],
    tldr: prep.tldr
  };
  escribirArchivoBrain_(carpeta, name, componerPagina_(fm, prep.briefing || ''));
  regenerarIndexBrain_(root, evento.fecha || '');
  return 'wiki/meetings/' + name;
}
