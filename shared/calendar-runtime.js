/**
 * calendar-runtime.js — Escritura de Google Calendar para Vera-MCP (Fase B).
 *
 * Crea y edita eventos en el calendario del líder vía CalendarApp (el Web App corre
 * "ejecutar como: yo", así que actúa sobre el calendario del propio líder → sin CASA).
 * La edición está RESTRINGIDA a eventos donde el líder es organizador/creador.
 *
 * La lectura de Calendar ya vive en deepprep-runtime.js/briefing-runtime.js.
 *
 * Sin import/export: runtime de Apps Script (namespace global). Privados con sufijo "_".
 */

/** Email del líder (para el chequeo de organizador). Ajustes > Session (en /exec = el líder). */
function mcpLeaderEmail_(config) {
  var e = (config && config.leader && config.leader.email) || '';
  if (e) return String(e).trim().toLowerCase();
  try { if (typeof Session !== 'undefined') return String(Session.getActiveUser().getEmail() || '').trim().toLowerCase(); }
  catch (err) {}
  return '';
}

/** ¿El líder es organizador/creador del evento? Compara su email contra getCreators(). */
function mcpEsOrganizador_(ev, email) {
  if (!email) return false;
  var creators = [];
  try { creators = ev.getCreators() || []; } catch (e) { creators = []; }
  return creators.map(function (c) { return String(c).trim().toLowerCase(); }).indexOf(email) > -1;
}

/** Parsea una fecha/hora ISO 8601 (idealmente con offset). Lanza claro si es inválida. */
function mcpParseFechaHora_(v, label) {
  var s = String(v == null ? '' : v).trim();
  if (!s) throw new Error('Falta la fecha/hora de ' + label + ' (ISO 8601, p.ej. 2026-08-20T15:00:00-05:00).');
  var d = new Date(s);
  if (isNaN(d.getTime())) {
    throw new Error('Fecha/hora de ' + label + ' inválida: "' + s + '". Usa ISO 8601 con offset, p.ej. 2026-08-20T15:00:00-05:00.');
  }
  return d;
}

/** Vista pública de un evento (fechas formateadas en la zona del líder). */
function mcpEventoView_(ev, config) {
  var tz = config.timezone, ini = ev.getStartTime(), fin = ev.getEndTime();
  return {
    id: ev.getId(),
    titulo: ev.getTitle() || '',
    inicio: ini ? Utilities.formatDate(ini, tz, 'yyyy-MM-dd HH:mm') : '',
    fin: fin ? Utilities.formatDate(fin, tz, 'yyyy-MM-dd HH:mm') : '',
    descripcion: ev.getDescription() || '',
    ubicacion: ev.getLocation() || '',
    invitados: (ev.getGuestList() || []).map(function (g) { return g.getEmail(); })
  };
}

/** create_calendar_event: crea un evento en el calendario del líder. */
function mcpCreateEvent_(config, args) {
  args = args || {};
  var titulo = String(args.titulo || '').trim();
  if (!titulo) throw new Error('Falta el título del evento.');
  var inicio = mcpParseFechaHora_(args.inicio, 'inicio');
  var fin = mcpParseFechaHora_(args.fin, 'fin');
  if (fin.getTime() <= inicio.getTime()) throw new Error('La hora de fin debe ser posterior a la de inicio.');

  var opts = {};
  if (args.descripcion) opts.description = String(args.descripcion);
  if (args.ubicacion) opts.location = String(args.ubicacion);
  if (args.invitados && [].concat(args.invitados).length) opts.guests = [].concat(args.invitados).join(',');

  var ev = CalendarApp.getDefaultCalendar().createEvent(titulo, inicio, fin, opts);
  return mcpEventoView_(ev, config);
}

/** edit_calendar_event: edita un evento por id, SOLO si el líder es organizador/creador. */
function mcpEditEvent_(config, args) {
  args = args || {};
  var id = String(args.id || '').trim();
  if (!id) throw new Error('Falta el id del evento.');
  var ev = CalendarApp.getDefaultCalendar().getEventById(id);
  if (!ev) throw new Error('Evento no encontrado: ' + id);
  if (!mcpEsOrganizador_(ev, mcpLeaderEmail_(config))) {
    throw new Error('Solo puedes editar eventos de los que eres organizador.');
  }

  var campos = args.campos || {};
  if (campos.titulo != null) ev.setTitle(String(campos.titulo));
  if (campos.descripcion != null) ev.setDescription(String(campos.descripcion));
  if (campos.ubicacion != null) ev.setLocation(String(campos.ubicacion));
  if (campos.inicio != null || campos.fin != null) {
    var nuevoIni = campos.inicio != null ? mcpParseFechaHora_(campos.inicio, 'inicio') : ev.getStartTime();
    var nuevoFin = campos.fin != null ? mcpParseFechaHora_(campos.fin, 'fin') : ev.getEndTime();
    if (nuevoFin.getTime() <= nuevoIni.getTime()) throw new Error('La hora de fin debe ser posterior a la de inicio.');
    ev.setTime(nuevoIni, nuevoFin);
  }
  return mcpEventoView_(ev, config);
}
