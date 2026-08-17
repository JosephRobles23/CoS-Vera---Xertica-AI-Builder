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
var SEG_CIERRE_FECHA_RE_ = /\s*[✓✖]\s*\[(?:resuelto|descartado)\s+(\d{4}-\d{2}-\d{2})\s*·[^\]]*\]\s*$/;
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
  // Cache (TTL 55s, bajo el poll de 60s del modal): releer N páginas de Drive por minuto era el
  // costo real del modal. resolverPendiente y las operaciones de gobernanza invalidan.
  var hit = cacheGetJson_(sheetId, 'seg:' + n);
  if (hit) return hit;
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

  var desdeFlujoUTC = isoAUTC_(hoy) - 29 * 86400000;
  var flujo = flujoPendientes_(personas, hoy, desdeFlujoUTC);
  var out = {
    brainEnabled: !!root,
    dias: n,
    hoy: hoy,
    personas: personas,
    actividad: root ? actividadWiki_(root, desdeUTC, (config.leader && config.leader.name) || '') : [],
    hoyControl: { prioridades: root ? prioridadHoy_(personas, hoy) : [] },
    flujo: flujo,
    tendencias: { dailyHeatmap: heatmapDaily_(cumpl, roster, desdeFlujoUTC), backlog: flujo.backlog },
    charts: {
      cumplimiento: personas.map(function (p) {
        return { nombre: p.nombre, pct: p.cumplimiento, salud: p.salud };
      }),
      blockers: root ? blockersConEdad_(personas) : [],
      pendientes: pendientesPorPersona_(sheetId, config, personas),
      actividadBrain: root ? actividadBrainPorDia_(root, hoy, desdeUTC) : []
    }
  };
  cachePutJson_(sheetId, 'seg:' + n, out);
  return out;
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
  cacheInvalidar_(sheetId, CACHE_SEGUIMIENTO_);
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
    blockers: [], pendientes: [], pendientesHistoricos: [], ultimoAvance: null, avances7d: 0
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
        if (s.name === 'Pendientes') {
          var cierre = SEG_CIERRE_FECHA_RE_.exec(l.trim());
          var pendiente = { linea: l.trim(), fecha: m[1], texto: m[2].replace(SEG_SUFIJO_RE_, ''),
            abierto: esPendienteAbierto_(l), file: out.file, fuente: 'Second Brain',
            cierre: cierre ? cierre[1] : '' };
          out.pendientesHistoricos.push(pendiente);
          if (enVentana) out.pendientes.push(pendiente);
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

  // "Día de Daily" según los días elegidos por el líder (tab Horarios) — si el equipo reporta
  // L-X-V, el cumplimiento y la racha no pueden castigar los martes y jueves.
  var diasDaily = {};
  ((config.schedule && config.schedule.dailyDias && config.schedule.dailyDias.length)
    ? config.schedule.dailyDias : [1, 2, 3, 4, 5]).forEach(function (d) { diasDaily[d] = true; });
  var esDiaDailyUTC = function (u) {
    var dowISO = ((new Date(u).getUTCDay() + 6) % 7) + 1;   // 1=lun … 7=dom
    return !!diasDaily[dowISO];
  };

  var hoyUTC = isoAUTC_(hoy);
  Object.keys(out).forEach(function (correo) {
    var d = out[correo];
    // % sobre los días DE DAILY de la ventana, desde el primer reporte de la persona (prorrateo).
    var iniUTC = Math.max(desdeUTC, isoAUTC_(d.primera));
    var habiles = 0, con = 0;
    for (var u = iniUTC; u <= hoyUTC; u += 86400000) {
      if (!esDiaDailyUTC(u)) continue;
      habiles++;
      if (d.fechas[isoDeUTC_(u)]) con++;
    }
    d.pct = habiles ? Math.round((con / habiles) * 100) : null;
    // Racha: días de Daily consecutivos con reporte, contando hacia atrás desde hoy.
    var racha = 0;
    for (var v = hoyUTC; v >= isoAUTC_(d.primera); v -= 86400000) {
      if (!esDiaDailyUTC(v)) continue;
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

function isoSemana_(fecha, desdeUTC) {
  return Math.min(4, Math.floor((isoAUTC_(fecha) - desdeUTC) / (7 * 86400000)) + 1);
}

/** Cola fija: silencio crítico → blocker → pendiente abierto de 7+ días. */
function prioridadHoy_(personas, hoy) {
  var candidatos = [];
  var silencios = personas.filter(function (p) { return p.salud === 'bad'; })
    .sort(function (a, b) { return (b.diasSinReporte || 0) - (a.diasSinReporte || 0); });
  if (silencios.length) candidatos.push({ tipo: 'silencio', nombre: silencios[0].nombre, correo: silencios[0].correo,
    texto: 'Sin reporte durante ' + silencios[0].diasSinReporte + ' días', fecha: silencios[0].ultimoReporte || '',
    edad: silencios[0].diasSinReporte || 0, file: silencios[0].file, linea: '', fuente: 'Second Brain' });
  var blockers = blockersConEdad_(personas);
  if (blockers.length) {
    var pBloq = personas.find(function (p) { return p.nombre === blockers[0].etiqueta.split(' · ')[0]; });
    candidatos.push({ tipo: 'blocker', nombre: pBloq ? pBloq.nombre : '', correo: pBloq ? pBloq.correo : '',
      texto: blockers[0].etiqueta.replace(/^.*? · /, ''), fecha: '', edad: blockers[0].dias,
      file: pBloq ? pBloq.file : '', linea: '', fuente: 'Second Brain' });
  }
  var pendientes = [];
  personas.forEach(function (p) { (p.pendientesHistoricos || []).forEach(function (x) {
    if (x.abierto && diasEntreISO_(x.fecha, hoy) >= 7) pendientes.push({ p: p, x: x });
  }); });
  pendientes.sort(function (a, b) { return diasEntreISO_(b.x.fecha, hoy) - diasEntreISO_(a.x.fecha, hoy); });
  if (pendientes.length) {
    var top = pendientes[0];
    candidatos.push({ tipo: 'pendiente', nombre: top.p.nombre, correo: top.p.correo, texto: top.x.texto,
      fecha: top.x.fecha, edad: diasEntreISO_(top.x.fecha, hoy), file: top.x.file, linea: top.x.linea, fuente: top.x.fuente });
  }
  return candidatos.slice(0, 3);
}

function flujoPendientes_(personas, hoy, desdeUTC) {
  var semanas = [1, 2, 3, 4, 5].map(function (n) { return { semana: 'S' + n, abiertos: 0, cerrados: 0 }; });
  var edades = { '0-3': 0, '4-7': 0, '8-14': 0, '15+': 0 };
  var backlog = [];
  personas.forEach(function (p) { (p.pendientesHistoricos || []).forEach(function (x) {
    if (isoAUTC_(x.fecha) >= desdeUTC && isoAUTC_(x.fecha) <= isoAUTC_(hoy)) semanas[isoSemana_(x.fecha, desdeUTC) - 1].abiertos++;
    if (x.cierre && isoAUTC_(x.cierre) >= desdeUTC && isoAUTC_(x.cierre) <= isoAUTC_(hoy)) semanas[isoSemana_(x.cierre, desdeUTC) - 1].cerrados++;
    if (!x.abierto) return;
    var edad = diasEntreISO_(x.fecha, hoy);
    edades[edad <= 3 ? '0-3' : edad <= 7 ? '4-7' : edad <= 14 ? '8-14' : '15+']++;
  }); });
  var neto = 0;
  semanas.forEach(function (s) { neto += s.abiertos - s.cerrados; backlog.push({ semana: s.semana, abiertos: neto }); });
  return { dias: 30, semanas: semanas, edades: edades, backlog: backlog };
}

function heatmapDaily_(cumpl, roster, desdeUTC) {
  var nombrePorCorreo = {};
  roster.forEach(function (p) { nombrePorCorreo[String(p.correo).toLowerCase()] = p.nombre || p.correo; });
  var out = [];
  Object.keys(cumpl).forEach(function (correo) { Object.keys(cumpl[correo].fechas || {}).forEach(function (fecha) {
    if (isoAUTC_(fecha) >= desdeUTC) out.push({ correo: correo, nombre: nombrePorCorreo[correo] || correo, fecha: fecha, n: 1 });
  }); });
  return out;
}

// --- Actividad (timeline agregada del wiki) ---

var SEG_TIPOS_SECCION_ = {
  'Avances': 'avance', 'Blockers': 'blocker', 'Riesgos': 'riesgo',
  'Decisiones': 'decision', 'Pendientes': 'pendiente', 'Contradicciones': 'contradiccion'
};

// Autor anotado en viñetas de proyecto ('texto · por Nombre', antes del sufijo de cierre).
var SEG_AUTOR_RE_ = /\s*·\s*por\s+([^·]+)$/;

function actividadWiki_(root, desdeUTC, leaderName) {
  var items = [];
  var liderNorm = String(leaderName == null ? '' : leaderName).trim().toLowerCase();
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
          var texto = m[2].replace(SEG_SUFIJO_RE_, '');
          // Autor de viñetas de proyecto: se muestra sin el sufijo y habilita el filtro
          // "incluir mis eventos" (apagado por defecto). Viñetas viejas sin autor: mio=false.
          var autor = '';
          var ma = SEG_AUTOR_RE_.exec(texto);
          if (subcarpeta === 'projects' && ma) { autor = ma[1].trim(); texto = texto.replace(SEG_AUTOR_RE_, ''); }
          items.push({
            fecha: m[1], tipo: tipo, quien: quien, autor: autor,
            mio: !!(autor && liderNorm && autor.toLowerCase() === liderNorm),
            texto: texto,
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
  // Solo EQUIPO: la fila del líder se movió al modal "Mi seguimiento" (separación R1, ago 2026).
  // Se conserva el flag lider:false para no romper el contrato del chart.
  return personas.map(function (p) {
    return { nombre: p.nombre, abiertos: p.pendientes.filter(function (x) { return x.abierto; }).length, lider: false };
  });
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
