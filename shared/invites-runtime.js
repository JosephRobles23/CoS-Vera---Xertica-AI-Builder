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
 */
function enviarInvitacion_(tipo, persona, leaderName, formUrl) {
  var esDaily = (tipo === 'daily');

  var asunto = esDaily
    ? 'Tu Daily de hoy — Chief of Staff'
    : 'Tu Weekly de la semana — Chief of Staff';

  var intro = esDaily
    ? 'Es momento de tu reporte diario. Tu líder, ' + leaderName + ', usa estos reportes ' +
      'para dar seguimiento al equipo, así que tu respuesta cuenta.'
    : 'Cierre de semana: comparte tu reporte semanal. Tu líder, ' + leaderName + ', lo revisa ' +
      'para entender logros, aprendizajes y lo que cargas para la próxima semana.';

  var cuerpo =
    'Hola ' + (persona.nombre || '') + ',\n\n' +
    intro + '\n\n' +
    '👉 Llena tu ' + (esDaily ? 'Daily' : 'Weekly') + ' aquí: ' + formUrl + '\n\n' +
    // El Form no pregunta nombre ni correo: los toma de la sesión de Google y los cruza
    // contra la pestaña Equipo. Si responden con otra cuenta, la fila queda sin nombre.
    'Solo son las preguntas: responde con esta misma cuenta (' + persona.correo + ') ' +
    'y tu nombre se registra solo.\n\n' +
    'Gracias,\nVera';

  MailApp.sendEmail(persona.correo, asunto, cuerpo);
}
