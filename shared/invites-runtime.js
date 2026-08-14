/**
 * invites-runtime.js — Correos de invitación a llenar el Form (Daily / Weekly).
 *
 * Funciones puras de envío: el dispatcher decide A QUIÉN y CUÁNDO (timing + guardas);
 * aquí solo se redacta y se manda el correo, nombrando al líder. El correo sale como el
 * líder (autorizó el stub con su cuenta). Ver Docs/workflows/CLEVEL-REPORTS/CLEVEL-REPORTS.md.
 *
 * Sin import/export: runtime de Apps Script. Privados con sufijo "_".
 */

/**
 * Envía la invitación a una persona.
 * @param {string} tipo        'daily' | 'weekly'
 * @param {Object} persona     { nombre, correo, rol }
 * @param {string} leaderName  nombre del líder (se nombra en el correo)
 * @param {string} formUrl     URL del Form correspondiente
 * @param {string} [sheetId]   con config: habilita la sección "Tus compromisos" (Release 2)
 * @param {Object} [config]
 */
function enviarInvitacion_(tipo, persona, leaderName, formUrl, sheetId, config) {
  var esDaily = (tipo === 'daily');

  // Follow-up de compromisos (best-effort: si algo falla, la invitación sale como siempre).
  var compromisos = [];
  if (sheetId && config) {
    try { compromisos = compromisosParaInvitacion_(sheetId, config, persona); } catch (e) {
      if (typeof Logger !== 'undefined') Logger.log('followup: no se pudo armar la sección (%s).', e);
    }
  }

  var asunto = esDaily
    ? 'Tu Daily de hoy — Chief of Staff'
    : 'Tu Weekly de la semana — Chief of Staff';

  var intro = esDaily
    ? 'Es momento de tu reporte diario. Tu líder, ' + leaderName + ', usa estos reportes ' +
      'para dar seguimiento al equipo, así que tu respuesta cuenta.'
    : 'Cierre de semana: comparte tu reporte semanal. Tu líder, ' + leaderName + ', lo revisa ' +
      'para entender logros, aprendizajes y lo que cargas para la próxima semana.';

  // Versión de texto plano: es el fallback para clientes que no renderizan HTML, así que
  // tiene que sostenerse sola (URL completa a la vista, no un "haz clic aquí").
  // Transparencia activa (compartir reportes): la persona sabe a quién más llega su reporte.
  var notaCompartir = (persona.compartirCon && persona.compartirCon.length)
    ? 'Transparencia: tu reporte también llega a ' + persona.compartirCon.join(', ') + '.\n\n'
    : '';

  // Texto plano de los compromisos (los botones viven en el HTML; aquí solo se listan).
  var notaCompromisos = compromisos.length
    ? '📌 Tus compromisos (responde con los botones de la versión HTML):\n' +
      compromisos.map(function (c) { return '· ' + c.texto; }).join('\n') + '\n\n'
    : '';

  var cuerpo =
    'Hola ' + (persona.nombre || '') + ',\n\n' +
    intro + '\n\n' +
    '👉 Llena tu ' + (esDaily ? 'Daily' : 'Weekly') + ' aquí: ' + formUrl + '\n\n' +
    // El Form no pregunta nombre ni correo: los toma de la sesión de Google y los cruza
    // contra la pestaña Equipo. Si responden con otra cuenta, la fila queda sin nombre.
    'Solo son las preguntas: responde con esta misma cuenta (' + persona.correo + ') ' +
    'y tu nombre se registra solo.\n\n' +
    notaCompromisos +
    notaCompartir +
    'Gracias,\nVera';

  MailApp.sendEmail(persona.correo, asunto, cuerpo, {
    htmlBody: renderInvitacionHtml_(tipo, persona, leaderName, formUrl, intro, compromisos)
  });
}
