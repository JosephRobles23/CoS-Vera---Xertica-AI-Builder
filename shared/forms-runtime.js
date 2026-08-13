/**
 * forms-runtime.js — Generación/edición de los Forms Daily/Weekly con FormApp.
 *
 * Lo llama el sidebar (panel Preguntas) vía el wrapper del stub. Crea un Form nuevo (o
 * edita uno existente si se pasa formId), agrega las preguntas del líder, activa la
 * recolección VERIFICADA de correo y fija el destino de respuestas al Sheet del líder,
 * renombrando la pestaña de respuestas al nombre de contrato (Daily/Weekly).
 *
 * El Form NO pregunta ni el nombre ni el correo: la identidad sale de la cuenta de Google
 * del respondiente (correo verificado) y el `Nombre` se cruza contra la pestaña `Equipo`
 * al recibir la respuesta (ver enriquecerFilaConRoster_ en summaries-runtime.js).
 * Ver Docs/workflows/CLEVEL-REPORTS/sidebar-and-prompts.md.
 *
 * Sin import/export: runtime de Apps Script. Privados con sufijo "_".
 */

/** Agrega un ítem al form según el tipo elegido en el editor (sidebar/modal). */
function addPregunta_(form, p) {
  var titulo = String(p.titulo || '').trim() || 'Pregunta';
  // Filtra opciones vacías (el editor por-opción puede dejar alguna en blanco).
  var opciones = (p.opciones || []).filter(function (o) { return o && String(o).trim(); });
  var metodoOpc = { opcion: 'addMultipleChoiceItem', casillas: 'addCheckboxItem', lista: 'addListItem' };
  var item;

  switch (p.tipo) {
    case 'texto':    item = form.addTextItem().setTitle(titulo); break;
    case 'parrafo':  item = form.addParagraphTextItem().setTitle(titulo); break;
    case 'opcion':
    case 'casillas':
    case 'lista':
      item = form[metodoOpc[p.tipo]]().setTitle(titulo);
      if (opciones.length) item.setChoiceValues(opciones);  // setChoiceValues([]) lanza error
      break;
    case 'escala':   item = form.addScaleItem().setTitle(titulo).setBounds(p.min || 1, p.max || 5); break;
    case 'fecha':    item = form.addDateItem().setTitle(titulo); break;
    case 'hora':     item = form.addTimeItem().setTitle(titulo); break;
    default:         item = form.addParagraphTextItem().setTitle(titulo);
  }

  // Ayuda y obligatoriedad: soportadas por todos nuestros tipos de ítem.
  if (p.ayuda && String(p.ayuda).trim()) item.setHelpText(String(p.ayuda).trim());
  if (p.requerido) item.setRequired(true);
}

/** Borra todas las preguntas actuales del form (para regenerar sin crear un Form nuevo). */
function limpiarItems_(form) {
  var items = form.getItems();
  for (var i = items.length - 1; i >= 0; i--) form.deleteItem(items[i]);
}

/**
 * Genera (o edita) el Form del líder. Público (lo llama el stub desde el sidebar).
 *
 * @param {string} tipo             'daily' | 'weekly'
 * @param {Array}  preguntas        [{ tipo, titulo, opciones?, min?, max?, requerido?, ayuda? }]
 * @param {string} sheetId          Spreadsheet del líder (destino de respuestas)
 * @param {Object} config           CONFIG (sheets.daily/weekly como nombre de pestaña destino)
 * @param {string} [existingFormId] si se pasa, se EDITA ese Form (conserva URL y pestaña)
 * @param {Object} [meta]           { titulo?, descripcion? } del Form (título/descr. editables)
 * @return {{formId:string, publishedUrl:string, editUrl:string, tab:string}}
 */
/** Aviso de transparencia que se añade a la descripción del Form cuando el brain está activo. */
var BRAIN_FORM_AVISO_ = 'Nota de transparencia: tus respuestas alimentan una memoria asistida por ' +
  'IA (el "second brain" del equipo) que las cruza con notas de reuniones (Meet) para ayudar a tu ' +
  'líder a preparar resúmenes y reuniones.';

/** Devuelve la descripción con el aviso del brain anexado (idempotente). Sin brain, la deja igual. */
function descripcionConAviso_(descripcion, config) {
  var base = descripcion == null ? '' : String(descripcion);
  if (!(config && config.brain && config.brain.enabled)) return base;
  if (base.indexOf(BRAIN_FORM_AVISO_) > -1) return base;
  return (base ? base + '\n\n' : '') + BRAIN_FORM_AVISO_;
}

function generarFormulario(tipo, preguntas, sheetId, config, existingFormId, meta) {
  meta = meta || {};
  var tituloDefault = (tipo === 'daily') ? 'Reporte Daily' : 'Reporte Weekly';
  var titulo = (meta.titulo && String(meta.titulo).trim()) ? String(meta.titulo).trim() : tituloDefault;
  var tabName = (tipo === 'daily') ? config.sheets.daily : config.sheets.weekly;
  preguntas = preguntas || [];

  var form, tab;

  if (existingFormId) {
    // --- Editar: conserva la misma URL y la misma pestaña de respuestas ---
    form = FormApp.openById(existingFormId);
    // Solo re-aplica el título si el líder puso uno (vacío = conserva el actual del Form).
    if (meta.titulo && String(meta.titulo).trim()) form.setTitle(String(meta.titulo).trim());
    if (meta.descripcion != null) form.setDescription(descripcionConAviso_(meta.descripcion, config));
    limpiarItems_(form);
    setCorreoVerificado_(form);            // re-aplica: migra forms viejos que pedían el correo
    preguntas.forEach(function (p) { addPregunta_(form, p); });
    tab = tabName;
  } else {
    // --- Crear nuevo + enlazar destino + renombrar la pestaña de respuestas ---
    form = FormApp.create(titulo);
    var descNueva = descripcionConAviso_(meta.descripcion, config);
    if (descNueva) form.setDescription(descNueva);
    setCorreoVerificado_(form);            // contrato: columna de correo, sin casilla visible
    preguntas.forEach(function (p) { addPregunta_(form, p); });

    var ss = getSpreadsheet_(sheetId);
    var idsAntes = ss.getSheets().map(function (s) { return s.getSheetId(); });
    form.setDestination(FormApp.DestinationType.SPREADSHEET, sheetId);
    SpreadsheetApp.flush();

    var nueva = ss.getSheets().filter(function (s) {
      return idsAntes.indexOf(s.getSheetId()) === -1;
    })[0];
    if (nueva) {
      if (ss.getSheetByName(tabName)) tabName = tabName + ' ' + nueva.getSheetId();  // evita choque
      nueva.setName(tabName);
      tab = tabName;
    }
  }

  sincronizarAccesoForm_(form, sheetId, config);   // publicar + dar acceso al Equipo

  return {
    formId: form.getId(),
    publishedUrl: form.getPublishedUrl(),
    editUrl: form.getEditUrl(),
    tab: tab || tabName
  };
}

/**
 * Deja el Form accesible para el equipo: lo **publica** y agrega a los correos de `Equipo`
 * como respondientes (published readers, NO editores — no pueden modificar el Form).
 *
 * Por qué hace falta publicar: los Forms creados por API después del 30-jun-2026 nacen en
 * estado *no publicado*, así que el equipo recibiría la invitación y vería "necesitas acceso".
 * `setPublished` además reemplaza a `setAcceptingResponses`.
 *
 * Gated por supportsAdvancedResponderPermissions(): los Forms antiguos no soportan el modelo
 * de publicación y llamar a estos métodos ahí lanza error. Todo es best-effort — un fallo de
 * permisos no debe impedir que el líder termine de generar su Form; queda en el log y se ve
 * con `diagnostico()`.
 *
 * NO quita a nadie: si alguien sale de `Equipo`, conserva el acceso (quitarlo es una decisión
 * destructiva que preferimos dejar manual, en el propio Form).
 *
 * @return {{soportado:boolean, publicado:boolean, responders:number}}
 */
function sincronizarAccesoForm_(form, sheetId, config) {
  var estado = { soportado: false, publicado: false, responders: 0 };

  try {
    if (!form.supportsAdvancedResponderPermissions ||
        !form.supportsAdvancedResponderPermissions()) {
      return estado;   // Form antiguo: su acceso lo rige el ajuste clásico del Form
    }
    estado.soportado = true;
  } catch (e) {
    Logger.log('No se pudo consultar el modelo de publicación del Form (%s).', e.message);
    return estado;
  }

  try {
    form.setPublished(true);
    estado.publicado = true;
  } catch (e) {
    Logger.log('⚠️ No se pudo PUBLICAR el Form (%s). Mientras no esté publicado, el equipo ' +
      'verá "necesitas acceso" al abrir el enlace. Publícalo a mano desde el Form.', e.message);
  }

  var correos;
  try {
    correos = getRoster_(sheetId, config.sheets.roster)
      .map(function (p) { return p.correo; })
      .filter(function (c) { return c; });
  } catch (e) {
    return estado;   // sin pestaña Equipo todavía: se sincroniza al guardar el equipo
  }
  if (!correos.length) return estado;

  try {
    form.addPublishedReaders(correos);
    estado.responders = correos.length;
  } catch (e) {
    Logger.log('No se pudo dar acceso de respondiente a %s correo(s) (%s). ' +
      'Revisa que sean cuentas de Google válidas.', correos.length, e.message);
  }
  return estado;
}

/**
 * Re-sincroniza el acceso de los Forms ya generados (Daily y Weekly) contra el `Equipo` actual.
 * Público: lo llama `guardarEquipo` para que quien entra al equipo después de generar los Forms
 * no se quede sin acceso. Tolera que aún no exista ningún Form.
 *
 * @return {{daily:?Object, weekly:?Object}} estado por Form (null si no está generado)
 */
function sincronizarAccesoForms(sheetId, config) {
  var aj = getAjustes_(sheetId, config.sheets.settings);
  var out = { daily: null, weekly: null };

  [['daily', aj.forms.dailyFormId], ['weekly', aj.forms.weeklyFormId]].forEach(function (par) {
    if (!par[1]) return;                       // ese Form aún no se ha generado
    try {
      out[par[0]] = sincronizarAccesoForm_(FormApp.openById(par[1]), sheetId, config);
    } catch (e) {
      Logger.log('No se pudo abrir el Form %s (%s) para sincronizar acceso.', par[0], e.message);
    }
  });
  return out;
}

var FORMS_API_ = 'https://forms.googleapis.com/v1/forms';

/**
 * Deja el Form recolectando el correo en modo VERIFICADO: Google lo toma de la sesión del
 * respondiente y lo escribe en la columna `Dirección de correo electrónico`, SIN mostrar
 * una casilla "Correo" en el formulario.
 *
 * Son dos pasos porque FormApp no expone el modo:
 *   1. form.setCollectEmail(true) → activa la recolección, pero en modo "entrada del
 *      encuestado" (la casilla visible que queremos quitar).
 *   2. Forms REST API (updateSettings.emailCollectionType = VERIFIED) → cambia el modo.
 *
 * El paso 2 es best-effort: si falla (Forms API sin habilitar en el proyecto de Cloud,
 * permiso faltante), el Form igual recoge el correo — solo que pidiéndolo a mano. Se
 * registra el motivo en el log en vez de romper la generación del Form.
 */
function setCorreoVerificado_(form) {
  try {
    // OJO: solo si NO recolecta ya. setCollectEmail(true) activa el modo "entrada del
    // encuestado", así que llamarlo a ciegas DEGRADA un Form que ya venía en "Verificado"
    // (p. ej. heredado de la Configuración predeterminada del líder). collectsEmail() no
    // distingue el modo, pero para no empeorar basta con no tocar lo que ya está activo.
    if (!form.collectsEmail()) form.setCollectEmail(true);
  } catch (e) {
    Logger.log('No se pudo activar la recolección de correo automáticamente (%s). ' +
      'Actívala a mano en el Form: Configuración → Recopilar correos.', e.message);
    return;
  }

  var url = FORMS_API_ + '/' + encodeURIComponent(form.getId()) + ':batchUpdate';
  var payload = {
    requests: [{
      updateSettings: {
        settings: { emailCollectionType: 'VERIFIED' },
        updateMask: 'emailCollectionType'   // mask puntual: '*' es rechazado por la API
      }
    }]
  };

  try {
    var res = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
    if (res.getResponseCode() !== 200) {
      Logger.log('No se pudo poner el correo en modo VERIFICADO (HTTP %s: %s). El Form ' +
        'seguirá mostrando la casilla "Correo"; cámbialo a mano en Configuración → ' +
        'Recopilar direcciones de correo → Verificado.',
        res.getResponseCode(), resumenCuerpo_(res.getContentText()));
    }
  } catch (e) {
    Logger.log('No se pudo llamar a la Forms API para el correo verificado (%s).', e.message);
  }
}
