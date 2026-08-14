/**
 * email-runtime.js — Plantilla HTML de los correos (invitaciones y consolidado).
 *
 * Único lugar donde se arma HTML. El resto del runtime pasa CONTENIDO (texto), nunca
 * marcado: así el diseño es idéntico en todos los correos y el LLM no puede romperlo.
 *
 * Restricciones de Gmail que explican el estilo del marcado:
 *  - Estilos SIEMPRE inline: Gmail descarta <style> en varios clientes (sobre todo móvil).
 *  - Layout con <table>: flexbox/grid no son fiables en correo.
 *  - Ancho máximo 600px y `bgcolor` además del inline, para clientes viejos.
 *  - Siempre se manda también una versión de texto plano (3er argumento de sendEmail).
 *
 * Branding tomado de las variables CSS de xertica.ai.
 *
 * Sin import/export: runtime de Apps Script. Privados con sufijo "_".
 */

/** Paleta de marca (nombres tal como los define xertica.ai). */
var MARCA_ = {
  ink:      '#1a1814',   // texto principal (negro cálido)
  ink2:     '#3d372f',   // texto de cuerpo
  tenue:    '#6b6259',   // texto secundario
  surface:  '#fffef8',   // fondo de la tarjeta principal
  cream:    '#f2edd8',   // fondo del correo
  cream2:   '#f5f0e8',   // fondo del pie
  borde:    '#e6ddc4',
  bordeSuave: '#ece3cd',
  amarillo: '#faf338',   // acento de marca (solo como FONDO: sobre blanco no contrasta)
  celeste:  '#1899af',
  verde:    '#2e8b5a',
  naranja:  '#e8651e',
  rojo:     '#d9503b',
  magenta:  '#c45baa',
  morado:   '#5c3a8a'
};

var FUENTE_ = "'Helvetica Neue', Helvetica, Arial, sans-serif";

/**
 * Paleta EXTRA para los PDF de impresión (Deep Prep), tomada de la guía de marca
 * (guia-chif-of-staff.html). Lo que ya existe en MARCA_ se reusa; aquí solo van los tonos
 * que el PDF necesita y el correo no (crema de papel, teal claro, franja de marca).
 */
var PDF_ = {
  paper:    MARCA_.surface,   // #fffef8 — papel crema de la página
  ink:      MARCA_.ink,       // #1a1814
  teal:     MARCA_.celeste,   // #1899af — acento principal de la guía
  tealSoft: '#dceff1',        // fondo del bloque TL;DR
  linea:    '#d9d3c7',        // filetes (masthead / footer)
  muted:    '#6f6b63',        // texto secundario
  // Franja de marca (la matriz de colores de la guía).
  lilac:    '#e8e1eb',
  mint:     '#dcefeb',
  peach:    '#f1dcd3',
  lemon:    '#f5f1bd'
};

/**
 * Color del filete de cada tarjeta según el tema de la sección. Se busca por
 * coincidencia de palabra clave en el título, así el líder puede renombrar sus secciones
 * en el prompt sin que esto deje de funcionar (lo no reconocido cae a `ink`).
 */
var COLOR_SECCION_ = [
  { claves: ['LOGRO', 'AVANCE', 'HECHO'],                  color: MARCA_.verde },
  { claves: ['BLOQUEO', 'AYUDA', 'IMPEDIMENTO'],           color: MARCA_.naranja },
  { claves: ['RIESGO', 'ALERTA'],                          color: MARCA_.rojo },
  { claves: ['APRENDIZAJE', 'COMENTARIO', 'NOTA'],         color: MARCA_.celeste },
  { claves: ['AUTOMATIZA'],                                color: MARCA_.morado },
  { claves: ['CARGA', 'PENDIENTE', 'PRÓXIMA', 'PROXIMA'],  color: MARCA_.magenta }
];

function colorDeSeccion_(titulo) {
  var t = String(titulo || '').toUpperCase();
  for (var i = 0; i < COLOR_SECCION_.length; i++) {
    for (var j = 0; j < COLOR_SECCION_[i].claves.length; j++) {
      if (t.indexOf(COLOR_SECCION_[i].claves[j]) > -1) return COLOR_SECCION_[i].color;
    }
  }
  return MARCA_.ink;
}

/** Escapa texto para incrustarlo en HTML. TODO contenido dinámico pasa por aquí. */
function escapeHtml_(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** '2026-07-27' -> '27 jul 2026'. Devuelve la entrada tal cual si no calza el formato. */
function fechaLegible_(iso) {
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || '').trim());
  if (!m) return String(iso || '');
  var meses = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
  return parseInt(m[3], 10) + ' ' + meses[parseInt(m[2], 10) - 1] + ' ' + m[1];
}

// --- Piezas de la plantilla ---

/**
 * Envoltorio común: fondo crema, tarjeta de 600px, cabecera con el wordmark y pie.
 *
 * El wordmark va como TEXTO, no como imagen: los clientes de correo bloquean imágenes
 * remotas por defecto (se vería un hueco), y la URL del logo en xertica.ai lleva un hash
 * que cambia en cada despliegue del sitio.
 */
function emailShell_(titulo, subtitulo, contenidoHtml) {
  return '' +
  '<!DOCTYPE html><html><body style="margin:0;padding:0;background:' + MARCA_.cream + ';">' +
  '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="' + MARCA_.cream + '" style="background:' + MARCA_.cream + ';">' +
  '<tr><td align="center" style="padding:24px 12px;">' +
    '<table role="presentation" width="600" cellpadding="0" cellspacing="0" bgcolor="' + MARCA_.surface + '" style="width:100%;max-width:600px;background:' + MARCA_.surface + ';border:1px solid ' + MARCA_.borde + ';border-radius:14px;">' +

    // Cabecera
    '<tr><td bgcolor="' + MARCA_.ink + '" style="background:' + MARCA_.ink + ';padding:20px 28px;border-radius:13px 13px 0 0;">' +
      '<div style="font:700 19px/1.2 ' + FUENTE_ + ';color:' + MARCA_.surface + ';letter-spacing:-0.4px;">' +
        'Xertica<span style="color:' + MARCA_.amarillo + ';">.ai</span></div>' +
      '<div style="font:400 10px/1.4 ' + FUENTE_ + ';color:#a89f92;letter-spacing:1.4px;text-transform:uppercase;padding-top:5px;">' +
        'Chief of Staff AI</div>' +
    '</td></tr>' +

    // Título
    '<tr><td style="padding:26px 28px 4px;">' +
      '<div style="font:700 22px/1.3 ' + FUENTE_ + ';color:' + MARCA_.ink + ';">' + escapeHtml_(titulo) + '</div>' +
      (subtitulo
        ? '<div style="font:400 13px/1.5 ' + FUENTE_ + ';color:' + MARCA_.tenue + ';padding-top:6px;">' + escapeHtml_(subtitulo) + '</div>'
        : '') +
    '</td></tr>' +

    // Contenido
    '<tr><td style="padding:18px 28px 26px;">' + contenidoHtml + '</td></tr>' +

    // Pie
    '<tr><td bgcolor="' + MARCA_.cream2 + '" style="background:' + MARCA_.cream2 + ';padding:16px 28px;border-top:1px solid ' + MARCA_.borde + ';border-radius:0 0 13px 13px;">' +
      '<div style="font:400 12px/1.5 ' + FUENTE_ + ';color:' + MARCA_.tenue + ';">' +
        'Vera · Chief of Staff AI — correo automático de Xertica.ai</div>' +
    '</td></tr>' +

    '</table>' +
  '</td></tr></table></body></html>';
}

/** Párrafo de cuerpo. */
function parrafoHtml_(texto) {
  return '<p style="margin:0 0 14px;font:400 15px/1.65 ' + FUENTE_ + ';color:' + MARCA_.ink2 + ';">' +
    escapeHtml_(texto) + '</p>';
}

/** Botón de acción (amarillo de marca sobre texto ink: ~15:1 de contraste). */
function botonHtml_(texto, url) {
  return '' +
  '<table role="presentation" cellpadding="0" cellspacing="0" style="margin:6px 0 18px;"><tr>' +
  '<td bgcolor="' + MARCA_.amarillo + '" style="background:' + MARCA_.amarillo + ';border-radius:8px;">' +
  '<a href="' + escapeHtml_(url) + '" style="display:inline-block;padding:13px 26px;font:700 15px/1 ' + FUENTE_ +
    ';color:' + MARCA_.ink + ';text-decoration:none;">' + escapeHtml_(texto) + '</a>' +
  '</td></tr></table>';
}

/** Tarjeta de sección con filete de color a la izquierda. */
function tarjetaHtml_(titulo, itemsHtml) {
  var color = colorDeSeccion_(titulo);
  return '' +
  '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#ffffff" ' +
    'style="width:100%;background:#ffffff;border:1px solid ' + MARCA_.bordeSuave + ';border-left:4px solid ' + color +
    ';border-radius:10px;margin:0 0 12px;"><tr><td style="padding:14px 16px;">' +
  '<div style="font:700 11px/1.3 ' + FUENTE_ + ';color:' + MARCA_.ink + ';letter-spacing:1.1px;text-transform:uppercase;padding-bottom:8px;">' +
    escapeHtml_(titulo) + '</div>' +
  itemsHtml +
  '</td></tr></table>';
}

/** Cuerpo de una tarjeta: viñetas si las hay, párrafos si no. */
function cuerpoSeccionHtml_(lineas) {
  var vinetas = lineas.filter(function (l) { return l.esVineta; });
  var sueltas = lineas.filter(function (l) { return !l.esVineta; });
  var html = '';

  sueltas.forEach(function (l) {
    html += '<div style="font:400 14px/1.6 ' + FUENTE_ + ';color:' + MARCA_.ink2 + ';padding-bottom:4px;">' +
      escapeHtml_(l.texto) + '</div>';
  });

  if (vinetas.length) {
    html += '<ul style="margin:4px 0 0;padding-left:18px;">';
    vinetas.forEach(function (l) {
      html += '<li style="font:400 14px/1.6 ' + FUENTE_ + ';color:' + MARCA_.ink2 + ';padding-bottom:3px;">' +
        escapeHtml_(l.texto) + '</li>';
    });
    html += '</ul>';
  }
  return html;
}

// --- Parseo tolerante de la salida del LLM ---

/**
 * ¿La línea parece un encabezado de sección? Tolerante a lo que devuelva el modelo:
 * "LOGROS DE HOY", "## Logros", "**Logros:**". Criterio: línea corta, sin puntuación de
 * frase, y en MAYÚSCULAS o marcada con markdown.
 */
function esEncabezado_(linea) {
  var l = String(linea || '').trim();
  if (!l || l.length > 60) return false;
  if (/^#{1,6}\s+/.test(l)) return true;                       // "## Logros"
  if (/^\*\*[^*]+\*\*:?$/.test(l)) return true;                // "**Logros**"

  var limpio = l.replace(/[:*#]/g, '').trim();
  if (!limpio || /[.?!,;]$/.test(limpio)) return false;        // termina como frase → no
  if (!/[A-ZÁÉÍÓÚÑ]/.test(limpio)) return false;
  return limpio === limpio.toUpperCase();                      // "LOGROS DE HOY"
}

/** Quita el marcado del encabezado: "## Logros:" -> "Logros". */
function limpiarEncabezado_(linea) {
  return String(linea).trim()
    .replace(/^#{1,6}\s+/, '').replace(/^\*\*|\*\*$/g, '').replace(/:$/, '').trim();
}

/** ¿La línea es una viñeta? Devuelve el texto sin el marcador, o null. */
function textoDeVineta_(linea) {
  var m = /^\s*(?:[-*•·—]|\d+[.)])\s+(.*)$/.exec(String(linea));
  return m ? m[1].trim() : null;
}

/**
 * Parte el texto del LLM en secciones. **Tolerante por diseño**: si no reconoce ningún
 * encabezado (el modelo devolvió texto corrido), devuelve UNA sección sin título con todo
 * el contenido — el correo se degrada a una tarjeta única en vez de romperse.
 *
 * @return {Array<{titulo:string, lineas:Array<{texto:string, esVineta:boolean}>}>}
 */
function parseSecciones_(texto) {
  var lineas = String(texto == null ? '' : texto).split('\n');
  var secciones = [];
  var actual = null;

  lineas.forEach(function (raw) {
    var linea = String(raw).replace(/\s+$/, '');
    if (!linea.trim()) return;

    if (esEncabezado_(linea)) {
      actual = { titulo: limpiarEncabezado_(linea), lineas: [] };
      secciones.push(actual);
      return;
    }

    if (!actual) { actual = { titulo: '', lineas: [] }; secciones.push(actual); }

    var vineta = textoDeVineta_(linea);
    actual.lineas.push(vineta !== null
      ? { texto: vineta, esVineta: true }
      : { texto: linea.trim(), esVineta: false });
  });

  return secciones.filter(function (s) { return s.titulo || s.lineas.length; });
}

// --- Render de cada correo ---

/**
 * Consolidado del líder. `cuerpoLlm` es el texto crudo de Gemini: se parsea a secciones y
 * cada una se pinta como tarjeta. Todo el contenido va escapado.
 */
function renderConsolidadoHtml_(tipo, leaderName, today, cuerpoLlm) {
  var titulo = (tipo === 'daily') ? 'Consolidado Diario' : 'Consolidado Semanal';
  var subtitulo = 'Equipo ' + leaderName + ' · ' + fechaLegible_(today);

  var secciones = parseSecciones_(cuerpoLlm);
  var contenido = '';

  secciones.forEach(function (s) {
    var cuerpo = cuerpoSeccionHtml_(s.lineas);
    // Sección sin título (texto corrido): párrafo suelto, sin caja.
    contenido += s.titulo ? tarjetaHtml_(s.titulo, cuerpo) : cuerpo;
  });

  if (!contenido) contenido = parrafoHtml_(cuerpoLlm || '');
  return emailShell_(titulo, subtitulo, contenido);
}

/**
 * Deep Prep de una reunión. Reusa el shell de marca y el parseo tolerante del consolidado.
 * `tldr` es un párrafo corto (va también en el cuerpo del correo); `briefing` es el texto
 * seccionado del LLM que se pinta como tarjetas. Todo el contenido va escapado.
 */
function renderDeepPrepHtml_(evento, tldr, briefing) {
  evento = evento || {};
  var partes = [];
  if (evento.fecha) partes.push(fechaLegible_(evento.fecha) + (evento.hora ? ' · ' + evento.hora : ''));
  if (evento.asistentes && evento.asistentes.length) partes.push(evento.asistentes.length + ' asistentes');
  var subtitulo = partes.join(' · ');

  var contenido = tarjetaHtml_('TL;DR', cuerpoSeccionHtml_([{ texto: tldr || '', esVineta: false }]));
  parseSecciones_(briefing).forEach(function (s) {
    var cuerpo = cuerpoSeccionHtml_(s.lineas);
    contenido += s.titulo ? tarjetaHtml_(s.titulo, cuerpo) : cuerpo;
  });
  if (!briefing) contenido += parrafoHtml_('');

  return emailShell_('Deep Prep — ' + (evento.titulo || 'Reunión'), subtitulo, contenido);
}

/** Píldora-botón de follow-up (link con token) para la sección de compromisos. */
function botonFollowupHtml_(etiqueta, color, url) {
  return '<a href="' + url + '" style="display:inline-block;border:1.5px solid ' + color +
    ';color:' + color + ';border-radius:999px;padding:5px 11px;margin:2px 4px 2px 0;' +
    'font:600 11px/1.4 ' + FUENTE_ + ';text-decoration:none;background:#ffffff;">' + etiqueta + '</a>';
}

/** Sección "📌 Tus compromisos" de la invitación (Release 2: 4 botones-token por ítem). */
function seccionCompromisosHtml_(compromisos) {
  var items = compromisos.map(function (c) {
    return '<div style="background:' + MARCA_.cream2 + ';border-radius:10px;padding:10px 12px;margin:8px 0;">' +
      '<div style="font:600 13px/1.4 ' + FUENTE_ + ';color:' + MARCA_.ink + ';">' + escapeHtml_(c.texto) + '</div>' +
      '<div style="font:400 10px/1.4 ' + FUENTE_ + ';color:' + MARCA_.tenue + ';margin:1px 0 7px;">desde ' + escapeHtml_(c.fecha) + ' · cada botón funciona una sola vez</div>' +
      botonFollowupHtml_('✓ Lo terminé', '#16A34A', c.links.terminado) +
      botonFollowupHtml_('⏳ Sigo en ello', '#1E40AF', c.links.sigo) +
      botonFollowupHtml_('🚧 Bloqueado', '#DC2626', c.links.bloqueado) +
      botonFollowupHtml_('⛔ No aplica', '#6B7280', c.links.noaplica) +
      '</div>';
  }).join('');
  return '<div style="border-top:1px solid ' + MARCA_.borde + ';margin-top:14px;padding-top:12px;">' +
    '<div style="font:700 10.5px/1.4 ' + FUENTE_ + ';letter-spacing:.05em;color:' + MARCA_.tenue + ';text-transform:uppercase;">📌 Tus compromisos · ¿cómo van?</div>' +
    items + '</div>';
}

/** Invitación a llenar el Form: intro, botón, nota de la cuenta y (si hay) compromisos. */
function renderInvitacionHtml_(tipo, persona, leaderName, formUrl, intro, compromisos) {
  var esDaily = (tipo === 'daily');
  var titulo = 'Hola ' + (persona.nombre || '') + ',';

  var contenido =
    parrafoHtml_(intro) +
    botonHtml_('Llenar mi ' + (esDaily ? 'Daily' : 'Weekly'), formUrl) +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="' + MARCA_.cream2 + '" ' +
      'style="width:100%;background:' + MARCA_.cream2 + ';border-radius:8px;"><tr><td style="padding:12px 14px;">' +
    '<div style="font:400 13px/1.55 ' + FUENTE_ + ';color:' + MARCA_.tenue + ';">' +
      'Solo son las preguntas: responde con <strong style="color:' + MARCA_.ink + ';">' +
      escapeHtml_(persona.correo) + '</strong> y tu nombre se registra solo.</div>' +
    '</td></tr></table>';

  // Follow-up de compromisos (Release 2): los 4 botones-token por ítem.
  if (compromisos && compromisos.length) {
    contenido += seccionCompromisosHtml_(compromisos);
  }

  // Transparencia activa (compartir reportes): la persona sabe a quién más llega su reporte.
  if (persona.compartirCon && persona.compartirCon.length) {
    contenido += parrafoHtml_('Transparencia: tu reporte también llega a ' +
      persona.compartirCon.join(', ') + '.');
  }

  return emailShell_(titulo, (esDaily ? 'Reporte diario' : 'Reporte semanal') + ' · equipo de ' + leaderName, contenido);
}

/**
 * Reporte compartido de UNA persona (compartir reportes, Fase 1): el resumen del día o el
 * aviso de silencio, con pie de quién lo comparte. Mismo shell de marca del consolidado.
 */
function renderReporteCompartidoHtml_(tipo, persona, fecha, texto, leaderName, esSilencio) {
  var etiqueta = (tipo === 'daily') ? 'Daily' : 'Weekly';
  var quien = persona.nombre || persona.correo || '';

  var contenido = esSilencio
    ? parrafoHtml_(texto)
    : tarjetaHtml_((tipo === 'daily') ? 'Resumen del día' : 'Resumen de la semana',
        cuerpoSeccionHtml_([{ texto: texto, esVineta: false }]));
  contenido += parrafoHtml_('Compartido por ' + leaderName + ' vía CoS · ' + quien +
    ' sabe que este reporte se comparte contigo.');

  return emailShell_('Reporte ' + etiqueta + ' de ' + quien, fechaLegible_(fecha), contenido);
}

/**
 * Morning Briefing: secciones en el orden configurado. Lo factual (agenda/tareas) viene ya
 * estructurado; `ia` trae el foco y la narrativa de urgente del LLM.
 */
function renderBriefingHtml_(fecha, secciones, datos, ia) {
  var contenido = '';
  secciones.forEach(function (s) {
    if (s.id === 'dia') {
      var lineas = datos.reuniones.map(function (r) {
        return { texto: r.hora + ' · ' + r.titulo + ' (' + r.asistentes + ')' + (r.prep ? ' — tienes Deep Prep' : ''), esVineta: true };
      });
      if (!lineas.length) lineas = [{ texto: 'Sin reuniones: día despejado.', esVineta: false }];
      contenido += tarjetaHtml_('📅 Tu día · ' + datos.reuniones.length + ' reunión(es)', cuerpoSeccionHtml_(lineas));
    } else if (s.id === 'pendientes') {
      var tl = datos.tareas.map(function (t) {
        var marca = t.atrasada ? ' [ATRASADA]' : (t.hoy ? ' [hoy]' : '');
        return { texto: t.texto + marca + (t.proyecto ? ' · ' + t.proyecto : ''), esVineta: true };
      });
      if (!tl.length) tl = [{ texto: 'Nada pendiente — la hoja Tareas está limpia.', esVineta: false }];
      contenido += tarjetaHtml_('✅ Pendientes · ' + datos.tareas.length, cuerpoSeccionHtml_(tl));
    } else if (s.id === 'urgente') {
      if (ia.urgente) {
        contenido += tarjetaHtml_('🚨 Urgente', cuerpoSeccionHtml_([{ texto: ia.urgente, esVineta: false }]));
      } else if (datos.urgentes.length) {
        contenido += tarjetaHtml_('🚨 Urgente', cuerpoSeccionHtml_(datos.urgentes.map(function (u) {
          return { texto: u, esVineta: true };
        })));
      }
    } else if (s.id === 'foco' && ia.foco) {
      contenido += tarjetaHtml_('💡 Foco sugerido', cuerpoSeccionHtml_([{ texto: ia.foco, esVineta: false }]));
    }
  });
  if (!contenido) contenido = parrafoHtml_('Día despejado: sin reuniones ni pendientes. Aprovéchalo.');
  return emailShell_('☀️ Tu día', fechaLegible_(fecha), contenido);
}

// --- PDF de impresión (Deep Prep) ------------------------------------------------------
//
// El adjunto del Deep Prep NO reusa emailShell_ (pensado para clientes de correo, wordmark
// como texto): el PDF es un documento de marca al estilo de la guía (guia-chif-of-staff.html).
// Ojo: el convertidor HTML→PDF de Apps Script (Utilities.newBlob(html).getAs('application/pdf'))
// NO soporta flexbox/grid — por eso el layout va con <table> + estilos inline, igual que los
// correos, pero con la paleta y el wordmark (imagen) de la guía. Ver deepprep-runtime.js.

/** Franja de marca (matriz de 4 colores de la guía) como borde superior de la página. */
function pdfFranjaMarca_() {
  var celda = function (c) {
    return '<td width="25%" height="6" bgcolor="' + c + '" ' +
      'style="width:25%;height:6px;background:' + c + ';font-size:0;line-height:0;">&nbsp;</td>';
  };
  return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;"><tr>' +
    celda(PDF_.lilac) + celda(PDF_.mint) + celda(PDF_.peach) + celda(PDF_.lemon) +
  '</tr></table>';
}

/** Bloque TL;DR destacado (teal claro con filete teal), el elemento que más pesa en el prep. */
function pdfTldrCard_(tldr) {
  return '' +
  '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="' + PDF_.tealSoft + '" ' +
    'style="width:100%;background:' + PDF_.tealSoft + ';border-top:3px solid ' + PDF_.teal + ';margin:0 0 18px;">' +
  '<tr><td style="padding:16px 20px;">' +
    '<div style="font:700 10px/1.2 ' + FUENTE_ + ';color:' + PDF_.teal + ';letter-spacing:2px;text-transform:uppercase;padding-bottom:8px;">TL;DR</div>' +
    '<div style="font:600 15px/1.55 ' + FUENTE_ + ';color:' + PDF_.ink + ';">' + escapeHtml_(tldr || '') + '</div>' +
  '</td></tr></table>';
}

/**
 * Deep Prep como PDF de marca. Reusa el parseo tolerante y las tarjetas de acento del
 * consolidado (parseSecciones_/tarjetaHtml_) para el briefing; encima pone el masthead con el
 * wordmark, el hero (título de la reunión + metadatos) y el TL;DR destacado. Todo escapado.
 */
function renderDeepPrepPdfHtml_(evento, tldr, briefing) {
  evento = evento || {};
  var titulo = evento.titulo || 'Reunión';

  var meta = [];
  if (evento.fecha) meta.push(fechaLegible_(evento.fecha) + (evento.hora ? ' · ' + evento.hora : ''));
  if (evento.ubicacion) meta.push(evento.ubicacion);
  if (evento.asistentes && evento.asistentes.length) meta.push(evento.asistentes.length + ' asistentes');
  var metaLinea = meta.join('   ·   ');

  // Briefing → tarjetas con acento de color por tema (mismo criterio que el consolidado).
  var cuerpo = '';
  parseSecciones_(briefing).forEach(function (s) {
    var c = cuerpoSeccionHtml_(s.lineas);
    cuerpo += s.titulo ? tarjetaHtml_(s.titulo, c) : c;
  });
  if (!cuerpo) cuerpo = parrafoHtml_('(Sin briefing disponible.)');

  return '' +
  '<!DOCTYPE html><html><body style="margin:0;padding:0;background:' + PDF_.paper + ';">' +
  '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="' + PDF_.paper + '" style="background:' + PDF_.paper + ';">' +
  '<tr><td align="center" style="padding:0;">' +
    '<table role="presentation" width="720" cellpadding="0" cellspacing="0" bgcolor="' + PDF_.paper + '" style="width:100%;max-width:720px;background:' + PDF_.paper + ';">' +

    // Franja de marca (borde superior de la página)
    '<tr><td style="padding:0;">' + pdfFranjaMarca_() + '</td></tr>' +

    '<tr><td style="padding:34px 44px 40px;">' +

      // Masthead: wordmark (imagen) + etiqueta del documento
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;border-bottom:1px solid ' + PDF_.linea + ';"><tr>' +
        '<td align="left" valign="middle" style="padding-bottom:14px;">' +
          '<img src="' + XERTICA_LOGO_PNG_ + '" width="150" alt="Xertica.ai" style="display:block;width:150px;height:auto;border:0;">' +
        '</td>' +
        '<td align="right" valign="middle" style="padding-bottom:14px;font:700 10px/1.2 ' + FUENTE_ + ';color:' + PDF_.muted + ';letter-spacing:2.5px;text-transform:uppercase;">Deep Prep</td>' +
      '</tr></table>' +

      // Hero: eyebrow + título de la reunión + metadatos
      '<div style="padding-top:30px;">' +
        '<div style="font:700 9px/1.2 ' + FUENTE_ + ';color:' + PDF_.teal + ';letter-spacing:3px;text-transform:uppercase;">Briefing pre-reunión</div>' +
        '<div style="font:800 32px/1.06 ' + FUENTE_ + ';color:' + PDF_.ink + ';letter-spacing:-1px;padding:12px 0 0;">' + escapeHtml_(titulo) + '</div>' +
        (metaLinea
          ? '<div style="font:400 13px/1.5 ' + FUENTE_ + ';color:' + PDF_.muted + ';padding-top:12px;">' + escapeHtml_(metaLinea) + '</div>'
          : '') +
      '</div>' +

      // TL;DR destacado
      '<div style="padding-top:24px;">' + pdfTldrCard_(tldr) + '</div>' +

      // Secciones del briefing
      cuerpo +

      // Footer
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;border-top:1px solid ' + PDF_.linea + ';margin-top:8px;"><tr>' +
        '<td valign="middle" style="padding-top:14px;font:400 10px/1.4 ' + FUENTE_ + ';color:' + PDF_.muted + ';letter-spacing:0.5px;">Vera · Chief of Staff AI — Xertica.ai</td>' +
        (evento.fecha
          ? '<td align="right" valign="middle" style="padding-top:14px;font:700 10px/1.4 ' + FUENTE_ + ';color:' + PDF_.ink + ';">' + escapeHtml_(fechaLegible_(evento.fecha)) + '</td>'
          : '') +
      '</tr></table>' +

    '</td></tr>' +
    '</table>' +
  '</td></tr></table></body></html>';
}
