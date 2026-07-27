# Testing and Deploy

Cómo se prueba CoS-Agent y cómo se publica/versiona con **clasp** (verificado contra
`@google/clasp` **3.3.0**). Léelo antes de escribir código: define la disciplina de pruebas y el
ciclo de promoción a los líderes.

> **Estado:** `High-level` (spec). Aún no hay código `.gs` ni proyectos de Apps Script creados.

---

## Parte 1 — Testing

El código de runtime usa **globales de Apps Script** (`SpreadsheetApp`, `FormApp`, `UrlFetchApp`,
`PropertiesService`, `MailApp`) que **no existen en Node**, y los archivos de runtime usan namespace
global (sin `import/export`). Por eso el testing se parte en **dos capas**.

### Capa A — Tests de contrato en Node (rápidos, automatizables)

Mismo patrón que el proyecto AOS de referencia: `tests/` + un **mock harness** de GAS.

- **El harness** (`tests/gas-harness.mjs`) provee versiones falsas de los globales de GAS e
  **inyecta** las funciones del runtime en un sandbox para poder invocarlas desde Node. Como los
  archivos de runtime no exportan nada, el harness **lee el archivo y lo evalúa** en un contexto
  (`node:vm`) con los mocks ya definidos como globales.
- **Se prueba la lógica pura y determinística** — donde están los bugs caros. Sin red, sin Google.

| Módulo (planeado) | Qué se testea |
|---|---|
| `shared/sheets-runtime.js` | mapa de encabezados, `toHHMM_` (normalización de hora), `horaCoincide_` (ventana) |
| `shared/roster-runtime.js` | parseo de la pestaña `Equipo` a objetos |
| `shared/prompts-runtime.js` | composición `soul + user + task` y **fallback a defaults** cuando la celda está vacía |
| `shared/summaries-runtime.js` | **pass-through genérico**: extrae columnas variables y excluye las de contrato (`Nombre`/`Correo`/`Lider`/`Summary`); cruce de identidad contra `Equipo` |
| `shared/consolidation-runtime.js` | filtro/agrupación de `Summary` por fecha de hoy |
| `shared/email-runtime.js` | **parseo tolerante** de la salida del LLM a secciones + escapado del HTML |
| `shared/invites-runtime.js` | formato de la guarda anti-dup y su lógica |
| `shared/gemini-runtime.js` | con `UrlFetchApp` **mockeado**: forma del payload (modelo por llamada, split system/user), reintento en 429/5xx, respuesta vacía, key ausente → falla rápido |

**Correr:** `npm test` (`node --test tests/`). Rápido, sin cuenta de Google, **antes de cada push**.

```
tests/
├── gas-harness.mjs           # mocks de los globales GAS + loader de runtime
├── shared.test.mjs           # contratos de shared/*
└── clevel-reports.test.mjs   # contratos del workflow
```

### Capa B — Smoke / integración manual (en el editor de Apps Script)

Lo que **solo** funciona contra Google real: enviar correos, crear Forms, leer el Sheet vivo, que
disparen los triggers. Se replican los helpers manuales de la v0.5:

| Helper | Corre a mano | Qué valida |
|---|---|---|
| `smokeTestGemini` | sí | key + modelo responden |
| `testSummaryUltimaFilaDaily` / `...Weekly` | sí | resumen por fila sin enviar el Form |
| `testConsolidadoDiario` / `...Semanal` | sí | consolidado de hoy al correo del líder |
| `testInvitacionDaily` / `...Weekly` | sí | invitación llega y nombra al líder |
| `onFormSubmit` | **no** | es activador: necesita el evento del Form; a mano falla con `undefined.range` |

- **Guardas anti-dup:** para repetir pruebas por hora el mismo día, correr antes un
  `limpiarGuardasEnvio` (borra claves `sent:*`).
- **Depuración con librería:** no puedes poner breakpoints dentro de la librería desde el stub;
  depura abriendo el proyecto de la librería (función `_test` con datos de ejemplo) o con
  `console.log()` (sus logs salen en el registro del stub que la llamó). Ver
  [engineering-playbook.md](engineering-playbook.md#depuración-con-librería).

### Regla

`clasp push` **no corre tests.** Disciplina: `npm test` local → si pasa, `clasp push`. Opcional:
un script `prepush` en `package.json` que ejecute `npm test`.

---

## Parte 2 — Deploy y versionamiento con clasp

> **Malentendido a despejar:** clasp maneja el **script**, no el **Sheet**, y **`push` NO crea
> versiones.**

### clasp sube código, no crea Sheets

`clasp push` sube tus archivos (`.gs`/`.html`/`appsscript.json`) al **proyecto de Apps Script**
identificado por su `.clasp.json` (`scriptId`). No crea ni guarda un Sheet.

### Dónde vive en Drive (se decide al CREAR, no en cada push)

| Pieza | Comando de creación | Dónde queda |
|---|---|---|
| **Librería** (standalone) | `clasp create --type standalone --title "CLEVEL-REPORTS-Lib" --parentId <folderId>` | Archivo "Apps Script" en la carpeta indicada |
| **Stub bound** (plantilla) | `clasp create --type sheets --title "CoS — Plantilla" --parentId <folderId>` | Crea un **Sheet nuevo** + su script bound; `--parentId` decide la carpeta del Sheet |

- `--parentId` fija la **carpeta de Drive** al **crear**. Luego `clasp push` **solo actualiza el
  código** — no mueve, no re-crea, no cambia de carpeta.
- El script bound **no** aparece como archivo aparte en Drive: vive dentro del Sheet.

### `push` = HEAD · el versionamiento es un paso EXPLÍCITO

- `clasp push` sobrescribe el **HEAD** (código actual). **No** genera versiones numeradas.
- Las **versiones** (snapshots inmutables 1, 2, 3…) se crean con **`clasp create-version
  "descripción"`** (alias `clasp version`); se listan con `clasp list-versions`.
- **Por qué es central aquí:** los stubs de los líderes apuntan a una **versión FIJA** de la
  librería (`"version": "1"` en `appsscript.json`). El ciclo real de promoción:

```bash
# 1) Desarrollo: subir cambios a HEAD de la librería
clasp push                        # (desde shared/)

# 2) Probar contra HEAD (npm test + smoke manual)

# 3) Congelar una versión nueva de la librería
clasp create-version "v0.5.1 — pass-through genérico"

# 4) Promover: apuntar los stubs a la nueva versión
#    editar "version" en workflows/CLEVEL-REPORTS/appsscript.json → clasp push del stub
```

Si solo haces `push` y no creas versión, los líderes en versión fija **no ven** los cambios — que
es justo lo que quieres para estabilidad: tú controlas cuándo saltan de versión.

### No confundas dos historiales

| Historial | Qué es | ¿Automático? |
|---|---|---|
| **Versiones del script** | Snapshots que usan las librerías | ❌ Explícito (`clasp create-version`) |
| **Historial del Sheet** | Version history del documento en Drive | ✅ Automático, pero es del documento, no del código, e independiente |

> `clasp deploy` (deployments) es para **web apps / API executable**. Para una
> **librería-como-dependencia NO se necesita deployment** — basta con una **versión guardada**.

### Mapeo al repo (dos proyectos = dos `.clasp.json`)

| Proyecto Apps Script | Fuente local | Push |
|---|---|---|
| Librería (standalone) | `shared/` | `clasp push --project shared` (`npm run lib:push`) |
| Stub / plantilla (bound al Sheet) | `workflows/CLEVEL-REPORTS/` | `clasp push --project workflows/CLEVEL-REPORTS` |

Cada carpeta lleva su propio `.clasp.json` (gitignored) con el `scriptId` correspondiente.

---

## Comandos de referencia (clasp 3.3.0)

| Necesidad | Comando |
|---|---|
| Iniciar sesión | `clasp login` (interactivo, en tu terminal con `! clasp login`) |
| Crear la librería | `clasp create --type standalone --title "..." --parentId <folderId>` |
| Crear la plantilla (Sheet + stub) | `clasp create --type sheets --title "..." --parentId <folderId>` |
| Clonar un proyecto existente | `clasp clone <scriptId>` |
| Subir código (HEAD) | `clasp push` · `clasp push -w` (watch) |
| Ver qué se subiría | `clasp status` |
| **Crear versión inmutable** | `clasp create-version "descripción"` |
| Listar versiones | `clasp list-versions` |
| Ver logs | `clasp tail-logs` |
| Abrir el IDE | `clasp open-script` |

> Requisito previo para clonar/crear: habilitar la Apps Script API en
> https://script.google.com/home/usersettings.
