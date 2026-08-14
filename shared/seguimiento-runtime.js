/**
 * seguimiento-runtime.js — Modal "Seguimiento del equipo" (Release 1).
 *
 * Vista de lectura del estado del equipo (3 tabs: Personas / Actividad / Dashboards) + el cierre
 * de pendientes por el líder (Fase 2a). Todo `cargarSeguimiento` es DETERMINISTA — agrega wiki +
 * hojas Daily/Weekly, cero LLM — así el auto-refresco de 60 s del modal es barato y nunca inventa.
 *
 * Decisiones del grill (ago 2026):
 *  - Salud por persona derivada de brain.silenceDays (verde < ½ umbral, ámbar < umbral, rojo si lo
 *    superó o el scan la marcó). Externos (external:true) fuera de esta fase.
 *  - Cumplimiento = % de días HÁBILES de la ventana (7/30) con Daily, PRORRATEADO desde el primer
 *    reporte de la persona; racha = días hábiles consecutivos con Daily hasta hoy.
 *  - Pendientes "abiertos" = viñetas de ## Pendientes SIN sufijo de cierre. Gramática de sufijos
 *    (Fase 2a): "✓ [resuelto FECHA · quién]" | "✖ [descartado FECHA · quién]"; Reabrir lo quita.
 *  - Sin brain.enabled: degradación honesta (solo cumplimiento/racha desde las hojas).
 *
 * Público (via dispatch): cargarSeguimiento, resolverPendiente.
 * Sin import/export: runtime de Apps Script. Privados con sufijo "_".
 */

var SEG_SUFIJO_RE_ = /\s*[✓✖]\s*\[[^\]]*\]\s*$/;   // sufijo de cierre al final de una viñeta
var SEG_VINETA_RE_ = /^-\s*\[(\d{4}-\d{2}-\d{2})\]\s*(.*)$/;   // "- [fecha] texto"
var SEG_LOG_TAIL_ = 500;   // líneas de la cola de log.md que se parsean (el log crece por años)

/** ¿La viñeta de pendiente sigue abierta (sin sufijo ✓/✖)? */
function esPendienteAbierto_(linea) {
  return !SEG_SUFIJO_RE_.test(String(linea == null ? '' : linea));
}

// --- API pública ---

/**
 * Datos completos del modal para una ventana de días (7|30).
 * @return {{brainEnabled, dias, hoy, personas:[], actividad:[], charts:{}}}
 */
function cargarSeguimiento(sheetId, config, dias) {
  var n = int_(dias, 7);
  var tz = config.timezone;
  var hoy = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  var desdeUTC = isoAUTC_(hoy) - (n - 1) * 86400000;
  var brainOn = !!(config.brain && config.brain.enabled);

  var roster = [];
  try { roster = getRoster_(sheetId, config.sheets.roster); } catch (e) { roster = []; }

  var cumpl = cumplimientoDaily_(sheetId, config, hoy, desdeUTC);

  var root = null;
  if (brainOn) {
    try { root = ensureBrainFolder_(sheetId, config); } catch (e) { root = null; }
  }
  var paginas = root ? paginasPersonas_(root) : {};

  var personas = roster.map(function (p) {
    return armarPersona_(p, paginas[p.correo.toLowerCase()], cumpl[p.correo.toLowerCase()],
      config, hoy, desdeUTC);
  });
  // Orden por severidad: rojo → ámbar → verde → sin datos.
  var peso = { bad: 0, warn: 1, ok: 2, 'sin-datos': 3 };
  var pesoDe = function (s) { return (s in peso) ? peso[s] : 9; };   // ojo: peso.bad es 0 (falsy)
  personas.sort(function (a, b) { return pesoDe(a.salud) - pesoDe(b.salud); });

  return {
    brainEnabled: !!root,
    dias: n,
    hoy: hoy,
    personas: personas,
    actividad: root ? actividadWiki_(root, desdeUTC) : [],
    charts: {
      cumplimiento: personas.map(function (p) {
        return { nombre: p.nombre, pct: p.cumplimiento, salud: p.salud };
      }),
      blockers: root ? blockersConEdad_(personas) : [],
      pendientes: pendientesPorPersona_(sheetId, config, personas),
      actividadBrain: root ? actividadBrainPorDia_(root, hoy, desdeUTC) : []
    }
  };
}

/**
 * Cierra/reabre un pendiente de una persona desde el modal (Fase 2a). La viñeta gana (o pierde)
 * el sufijo de la gramática; queda rastro en log.md. Acciones: 'resolver' | 'descartar' | 'reabrir'.
 * @param {string} file   página en wiki/people (p.ej. 'ada-x-com.md')
 * @param {string} linea  la viñeta EXACTA (trim) a modificar
 * @return {{ok:boolean, linea:string}}
 */
function resolverPendiente(sheetId, config, file, linea, accion) {
  if (['resolver', 'descartar', 'reabrir'].indexOf(accion) === -1) {
    throw new Error('Acción desconocida: ' + accion);
  }
  var root = ensureBrainFolder_(sheetId, config);
  var carpeta = carpetaBrain_(root, ['wiki', 'people']);
  var name = nombreArchivoSeguro_(file);
  var contenido = leerArchivoBrain_(carpeta, name);
  if (!contenido) throw new Error('Página no encontrada: ' + name);

  var page = parsearPagina_(contenido);
  var ps = parseBodySections_(page.body);
  var seccion = null;
  for (var i = 0; i < ps.sections.length; i++) {
    if (ps.sections[i].name === 'Pendientes') { seccion = ps.sections[i]; break; }
  }
  if (!seccion) throw new Error('La persona no tiene sección Pendientes.');

  var buscada = String(linea == null ? '' : linea).trim();
  var hoy = hoyISO_(config);
  var quien = (config.leader && config.leader.name) || 'líder';
  var nueva = null;

  for (var j = 0; j < seccion.lines.length; j++) {
    if (seccion.lines[j].trim() !== buscada) continue;
    var base = buscada.replace(SEG_SUFIJO_RE_, '');
    if (accion === 'resolver')  nueva = base + ' ✓ [resuelto ' + hoy + ' · ' + quien + ']';
    if (accion === 'descartar') nueva = base + ' ✖ [descartado ' + hoy + ' · ' + quien + ']';
    if (accion === 'reabrir')   nueva = base;
    seccion.lines[j] = nueva;
    break;
  }
  if (nueva == null) throw new Error('No se encontró el pendiente en la página.');

  escribirArchivoBrain_(carpeta, name, componerPagina_(page.frontmatter, renderBodySections_(ps)));
  var etiqueta = accion === 'resolver' ? '✓ pendiente resuelto'
    : (accion === 'descartar' ? '⛔ pendiente descartado' : '↩ pendiente reabierto');
  appendArchivoBrain_(carpetaBrain_(root, ['wiki']), 'log.md',
    '- ' + hoy + ' · ' + etiqueta + ' · ' + name.replace(/\.md$/, '') + ' · ' +
    recorteTexto_(buscada.replace(/^-\s*\[[^\]]*\]\s*/, '').replace(SEG_SUFIJO_RE_, ''), 120) + '\n');
  regenerarIndexBrain_(root, hoy);
  return { ok: true, linea: nueva };
}

// --- Personas: salud + métricas ---

/** Mapa correoLower → {frontmatter, secciones} de wiki/people (solo roster: externos fuera). */
function paginasPersonas_(root) {
  var out = {};
  listarArchivosBrain_(carpetaBrain_(root, ['wiki', 'people']), '.md').forEach(function (a) {
    if (a.name.charAt(0) === '_') return;
    var page = parsearPagina_(a.content);
    var fm = page.frontmatter || {};
    if (String(fm.external) === 'true') return;
    var correo = str_(fm.email).toLowerCase();
    if (!correo) return;
    out[correo] = { file: a.name, fm: fm, secciones: parseBodySections_(page.body) };
  });
  return out;
}

function armarPersona_(p, pagina, cumpl, config, hoy, desdeUTC) {
  var umbral = (config.brain && config.brain.silenceDays) || 7;
  var out = {
    nombre: p.nombre || p.correo,
    correo: p.correo,
    file: pagina ? pagina.file : '',
    salud: 'sin-datos', diasSinReporte: null,
    ultimoReporte: '', racha: 0, cumplimiento: null,
    blockers: [], pendientes: [], ultimoAvance: null, avances7d: 0
  };

  if (cumpl) {
    out.ultimoReporte = cumpl.ultima || '';
    out.racha = cumpl.racha;
    out.cumplimiento = cumpl.pct;
  }

  var luBase = pagina ? str_(pagina.fm.last_updated) : (cumpl && cumpl.ultima) || '';
  if (luBase) {
    out.diasSinReporte = diasEntreISO_(luBase, hoy);
    out.salud = out.diasSinReporte >= umbral ? 'bad'
      : (out.diasSinReporte >= Math.ceil(umbral / 2) ? 'warn' : 'ok');
    if (pagina && str_(pagina.fm.silence_flagged) &&
        str_(pagina.fm.silence_flagged) === str_(pagina.fm.last_updated)) {
      out.salud = 'bad';
    }
  }

  if (pagina) {
    var edad = str_(pagina.fm.last_updated) ? diasEntreISO_(str_(pagina.fm.last_updated), hoy) : 0;
    out.blockers = (Array.isArray(pagina.fm.open_blockers) ? pagina.fm.open_blockers : [])
      .map(function (b) { return { texto: str_(b), dias: edad }; });

    pagina.secciones.sections.forEach(function (s) {
      s.lines.forEach(function (l) {
        var m = SEG_VINETA_RE_.exec(l.trim());
        if (!m) return;
        var enVentana = isoAUTC_(m[1]) >= desdeUTC;
        if (s.name === 'Pendientes' && enVentana) {
          out.pendientes.push({ linea: l.trim(), fecha: m[1], texto: m[2].replace(SEG_SUFIJO_RE_, ''), abierto: esPendienteAbierto_(l) });
        }
        if (s.name === 'Avances') {
          if (enVentana) out.avances7d++;
          if (!out.ultimoAvance || m[1] > out.ultimoAvance.fecha) {
            out.ultimoAvance = { fecha: m[1], texto: m[2] };
          }
        }
      });
    });
  }
  return out;
}

/** Cumplimiento/racha de Daily por correo: prorrateado y en días hábiles. */
function cumplimientoDaily_(sheetId, config, hoy, desdeUTC) {
  var out = {};
  var sh;
  try { sh = getSheet_(sheetId, config.sheets.daily); } catch (e) { return out; }
  if (sh.getLastRow() < 2) return out;

  var map = getHeaderMap_(sh);
  var colTs = map['Marca temporal'];
  var colCorreo = map['Correo'] || map['Dirección de correo electrónico'];
  if (!colTs || !colCorreo) return out;

  var tz = config.timezone;
  var rows = sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).getValues();
  rows.forEach(function (r) {
    var ts = r[colTs - 1];
    if (!(ts instanceof Date)) return;
    var correo = String(r[colCorreo - 1] || '').trim().toLowerCase();
    if (!correo) return;
    var iso = Utilities.formatDate(ts, tz, 'yyyy-MM-dd');
    if (!out[correo]) out[correo] = { fechas: {}, primera: iso, ultima: iso };
    out[correo].fechas[iso] = true;
    if (iso < out[correo].primera) out[correo].primera = iso;
    if (iso > out[correo].ultima) out[correo].ultima = iso;
  });

  var hoyUTC = isoAUTC_(hoy);
  Object.keys(out).forEach(function (correo) {
    var d = out[correo];
    // % sobre los días HÁBILES de la ventana, desde el primer reporte de la persona (prorrateo).
    var iniUTC = Math.max(desdeUTC, isoAUTC_(d.primera));
    var habiles = 0, con = 0;
    for (var u = iniUTC; u <= hoyUTC; u += 86400000) {
      if (!esHabilUTC_(u)) continue;
      habiles++;
      if (d.fechas[isoDeUTC_(u)]) con++;
    }
    d.pct = habiles ? Math.round((con / habiles) * 100) : null;
    // Racha: días hábiles consecutivos con Daily, contando hacia atrás desde hoy.
    var racha = 0;
    for (var v = hoyUTC; v >= isoAUTC_(d.primera); v -= 86400000) {
      if (!esHabilUTC_(v)) continue;
      if (!d.fechas[isoDeUTC_(v)]) { if (v === hoyUTC) continue; break; }   // hoy aún sin reportar no corta
      racha++;
    }
    d.racha = racha;
  });
  return out;
}

function esHabilUTC_(utcMs) {
  var dow = new Date(utcMs).getUTCDay();   // 0=dom … 6=sáb
  return dow >= 1 && dow <= 5;
}

function isoDeUTC_(utcMs) {
  return new Date(utcMs).toISOString().slice(0, 10);
}

// --- Actividad (timeline agregada del wiki) ---

var SEG_TIPOS_SECCION_ = {
  'Avances': 'avance', 'Blockers': 'blocker', 'Riesgos': 'riesgo',
  'Decisiones': 'decision', 'Pendientes': 'pendiente', 'Contradicciones': 'contradiccion'
};

function actividadWiki_(root, desdeUTC) {
  var items = [];
  var recorrer = function (subcarpeta, quienDe) {
    listarArchivosBrain_(carpetaBrain_(root, ['wiki', subcarpeta]), '.md').forEach(function (a) {
      if (a.name.charAt(0) === '_') return;
      var page = parsearPagina_(a.content);
      var fm = page.frontmatter || {};
      if (subcarpeta === 'people' && String(fm.external) === 'true') return;
      var quien = quienDe(fm, a.name);
      parseBodySections_(page.body).sections.forEach(function (s) {
        var tipo = SEG_TIPOS_SECCION_[s.name];
        if (!tipo) return;
        s.lines.forEach(function (l) {
          var m = SEG_VINETA_RE_.exec(l.trim());
          if (!m || isoAUTC_(m[1]) < desdeUTC) return;
          items.push({
            fecha: m[1], tipo: tipo, quien: quien,
            texto: m[2].replace(SEG_SUFIJO_RE_, ''),
            cerrado: tipo === 'pendiente' && !esPendienteAbierto_(l)
          });
        });
      });
    });
  };
  recorrer('people', function (fm, name) { return str_(fm.name) || name.replace(/\.md$/, ''); });
  recorrer('projects', function (fm, name) { return 'Proyecto ' + (str_(fm.name) || name.replace(/\.md$/, '')); });

  items.sort(function (a, b) { return b.fecha.localeCompare(a.fecha); });
  return items;
}

// --- Datos de los charts ---

function blockersConEdad_(personas) {
  var out = [];
  personas.forEach(function (p) {
    p.blockers.forEach(function (b) {
      out.push({ etiqueta: p.nombre + ' · ' + recorteTexto_(b.texto, 40), dias: b.dias });
    });
  });
  out.sort(function (a, b) { return b.dias - a.dias; });
  return out;
}

function pendientesPorPersona_(sheetId, config, personas) {
  var out = personas.map(function (p) {
    return { nombre: p.nombre, abiertos: p.pendientes.filter(function (x) { return x.abierto; }).length, lider: false };
  });
  try {
    var propias = tareasPendientesHoy_(sheetId, config, hoyISO_(config)).length;
    out.push({ nombre: (config.leader && config.leader.name) || 'Líder', abiertos: propias, lider: true });
  } catch (e) { /* sin hoja Tareas todavía */ }
  return out;
}

/** Ingestas por día (reportes 📝 + notas 🎥) desde la COLA de log.md — el log crece por años. */
function actividadBrainPorDia_(root, hoy, desdeUTC) {
  var log = leerArchivoBrain_(carpetaBrain_(root, ['wiki']), 'log.md') || '';
  var lineas = log.split('\n');
  if (lineas.length > SEG_LOG_TAIL_) lineas = lineas.slice(-SEG_LOG_TAIL_);

  var porDia = {};
  lineas.forEach(function (l) {
    var m = /^-\s*(\d{4}-\d{2}-\d{2})\s*·\s*(?:ingesta|🎥)/.exec(l.trim());
    if (!m || isoAUTC_(m[1]) < desdeUTC) return;
    porDia[m[1]] = (porDia[m[1]] || 0) + 1;
  });

  var serie = [];
  for (var u = desdeUTC; u <= isoAUTC_(hoy); u += 86400000) {
    var iso = isoDeUTC_(u);
    serie.push({ fecha: iso, n: porDia[iso] || 0 });
  }
  return serie;
}
