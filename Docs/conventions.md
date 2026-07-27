# Conventions

Patrones que todo workflow sigue. Ante la duda, haz lo que hacen los demás workflows.

## Patrón librería + stub

CoS-Agent parte cada workflow en **dos piezas**:

| Pieza | Dónde vive | Contiene |
|---|---|---|
| **Librería** (una, compartida) | Proyecto Apps Script **standalone**, compartido **solo-lectura** | "Casi todo": lógica de negocio, bridge de Gemini, defaults de prompts, y el key en Script Properties |
| **Stub** (uno por Sheet de líder) | Script **container-bound** al Sheet | Mínimo: `onOpen`, host del sidebar, wrappers de `google.script.run`, e instalación de triggers |

```javascript
// Stub (container-bound) — esto es lo ÚNICO que ve el líder en su Sheet
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('CoS')
    .addItem('Configurar', 'abrirSidebar')
    .addToUi();
}
function abrirSidebar() {
  const html = HtmlService.createHtmlOutputFromFile('Sidebar').setTitle('CoS — Configuración');
  SpreadsheetApp.getUi().showSidebar(html);
}
// Wrapper que el sidebar invoca; delega TODO a la librería:
function generarFormulario(tipo, preguntas) {
  return CoSLib.generarFormulario(tipo, preguntas, SpreadsheetApp.getActive().getId());
}
```

### Qué NO puede ir en la librería (por eso existe el stub)

- **Triggers simples** (`onOpen`, `onEdit`) — si viven en la librería **no se disparan** para el
  Sheet que la incluye. El handler va en el stub (aunque sea una línea que llama a la librería).
- **Funciones personalizadas** (`=MIFUNCION()`) — deben estar en el script bound.
- **Menú y UI** (`getUi()`, `getActiveSpreadsheet()`) — solo funcionan desde el stub bound.
- **Instalación de triggers** (`ScriptApp.newTrigger(...)`) — se instalan desde el stub.

Todo lo demás (lógica, Gemini, FormApp, correos, defaults de prompts) va en la **librería**.

### Ocultar el key sin exponerlo

- La **API key de Gemini** vive en `PropertiesService.getScriptProperties()` **de la librería**,
  bajo la clave `GEMINI_API_KEY`. Nunca en el código, nunca en `cos.config.json`, nunca en el Sheet.
- Los Script Properties son un recurso **not-shared**: aunque alguien copie la librería por su
  file ID, **el key no se copia**. Eso *ofusca* el secreto (no es seguridad real; el código sí es
  legible con acceso de lectura).
- Los métodos internos de la librería terminan en `_` (`llamarGemini_`) para no ser visibles.

> Ver la justificación de por qué usamos librería (y la desviación de AOS) en
> [architecture-and-contracts.md](architecture-and-contracts.md#desviación-consciente-de-aos-usamos-una-librería).

---

## Un stub container-bound por líder

Cada líder tiene un Google Sheet con su script bound. Las tareas se exponen como items de menú
en `onOpen()` y como botones del sidebar. No hay lógica de negocio duplicada entre líderes: toda
apunta a la misma librería.

**Distribución:** se comparte una **plantilla** (Sheet con el stub ya enganchado a la librería).
El líder hace *"Hacer una copia"* (URL que termina en `/copy`) y **autoriza con su @xertica**.
Copiar el Sheet copia el stub y su dependencia de librería (queda en `appsscript.json`), así que
el líder **no** agrega la librería a mano.

---

## Estructura de archivos de código

> **Estado:** `Planned` — la estructura acordada; el código se crea en una fase posterior.

Dentro de la librería (`shared/`, se sincroniza al proyecto standalone):

```
shared/
├── gemini-runtime.js        # bridge único con Gemini (key desde Script Properties)
├── prompts-runtime.js       # compone soul.md + user.md + system-prompt de tarea + defaults
├── summaries-runtime.js     # resumen por fila (pass-through genérico de Q&A)
├── consolidation-runtime.js # consolidados diario/semanal al líder
├── invites-runtime.js       # envío de invitaciones (redacción del correo)
├── dispatcher-runtime.js    # runDispatcher: timing + iteración + guardas anti-duplicado
├── forms-runtime.js         # generación/edición de Forms con FormApp
├── sheets-runtime.js        # acceso a hojas, mapa de encabezados, utilidades de hora
├── roster-runtime.js        # lectura de la pestaña Equipo
└── settings-runtime.js      # pestaña Ajustes (editable) + construirConfig + soporte del sidebar
```

Dentro de cada workflow bound (`workflows/CLEVEL-REPORTS/`):

```
workflows/CLEVEL-REPORTS/
├── appsscript.json          # manifiesto (scopes, dependencia de librería)
├── config.js                # const CONFIG = { ... } — IDs, nombres de pestaña, patrones
├── stub.js                  # onOpen, wrappers de google.script.run, delegación a la librería
├── triggers.js              # setupTriggers(): onFormSubmit + dispatcher
└── Sidebar.html             # los 4 paneles del sidebar
```

Regla de reparto: si un helper lo necesitaría un segundo workflow, va a `shared/`. Si es específico
de este workflow, se queda local. Ver
[engineering-playbook.md](engineering-playbook.md#reglas-de-modularización).

---

## Requisitos del manifiesto (`appsscript.json`)

El **stub** declara la dependencia de la librería y los scopes. Scopes esperados:

```json
{
  "timeZone": "America/Lima",
  "oauthScopes": [
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/script.external_request",
    "https://www.googleapis.com/auth/script.send_mail",
    "https://www.googleapis.com/auth/script.scriptapp",
    "https://www.googleapis.com/auth/forms",
    "https://www.googleapis.com/auth/script.container.ui"
  ],
  "dependencies": {
    "libraries": [
      {
        "userSymbol": "CoSLib",
        "libraryId": "<SCRIPT_ID de la librería>",
        "version": "1",
        "developmentMode": false
      }
    ]
  }
}
```

- `spreadsheets` → leer/escribir el Sheet.
- `script.external_request` → llamar a Gemini (`UrlFetchApp`).
- `script.send_mail` → enviar invitaciones y consolidados (`MailApp`, como el líder).
- `script.scriptapp` → crear/borrar triggers.
- `forms` → crear/editar Forms (`FormApp`).
- `script.container.ui` → mostrar el sidebar.

> **Versión de la librería.** En producción los stubs apuntan a una **versión fija** (`"1"`, `"2"`…),
> no a HEAD. El desarrollo se hace contra HEAD en el proyecto de la librería; se "promueve"
> guardando una versión nueva. Ver [engineering-playbook.md](engineering-playbook.md).

---

## Nomenclatura

- **Pestañas del Sheet:** `Daily`, `Weekly`, `Equipo`, `Prompts`, `Ajustes` (nombres en
  `cos.config.json → runtime.sheets`). `Ajustes` (key/value) guarda lo editable en runtime:
  líder, horarios, URLs/IDs de Forms y las preguntas (JSON). El resto del CONFIG es estático
  (código, en `config.js`); el stub los mezcla con `CoSLib.construirConfig`. Las pestañas
  auto-generadas (`Ajustes`, `Prompts`, `Equipo`) se crean con **formato de tabla** (encabezado
  oscuro + filas zebra + anchos) vía `estilizarTabla_`; `CoSLib.estilizarPestanas` re-aplica el
  estilo a pestañas ya existentes.
- **Claves de Script Properties:** `GEMINI_API_KEY`; guardas anti-dup `sent:<tipo>:<id>:<fecha>`.
- **Métodos privados de librería:** sufijo `_`.
- **Identificador de la librería en los stubs:** `CoSLib`.
- **Prosa en español; identificadores/claves/código en inglés.**
