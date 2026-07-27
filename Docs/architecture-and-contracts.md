# Architecture and Contracts

Este documento es el mapa de escritura de código de CoS-Agent. Léelo antes de cambiar código
de runtime, helpers compartidos o specs de workflow.

## Intent arquitectónico

CoS-Agent es un MVP hecho de automatizaciones **container-bound** de Apps Script, deliberadamente
pequeñas: un Sheet de settings, archivos de Apps Script, Forms y una carpeta de Drive. El código
común vive en **una librería compartida** — no se copia en cada Sheet.

La arquitectura favorece **contratos explícitos sobre abstracción**. Si un comportamiento debe
reusarse, se define el contrato en `shared/` (dentro de la librería), se documenta en `Docs/` y
se cubre con un test. Si es específico de un workflow, se queda ahí hasta que un segundo workflow
necesite el mismo contrato.

### Dos artefactos, un contrato

```mermaid
flowchart LR
    subgraph Cada_Lider["Sheet de cada líder (container-bound)"]
      STUB["Stub delgado<br/>onOpen · sidebar host · wrappers · triggers"]
      TABS["Pestañas: Daily · Weekly · Equipo · Prompts"]
      FORMS["Forms Daily/Weekly del líder"]
    end
    subgraph Compartido["Librería compartida (standalone, solo-lectura)"]
      LIB["Lógica: summaries · consolidation · invites · FormApp<br/>Gemini bridge · defaults de prompts"]
      KEY["Script Properties: GEMINI_API_KEY"]
    end
    STUB -->|"Lib.funcion(datos)"| LIB
    LIB --> KEY
    FORMS -->|onFormSubmit| STUB
```

El stub **no contiene lógica de negocio**: reenvía a la librería. La librería **no toca la UI ni
los triggers** del contenedor: recibe datos y devuelve resultados.

---

## Capas

| Capa | Archivos / superficie | Posee | No debe poseer |
|---|---|---|---|
| **Dev tooling** | `package.json`, `scripts/`, `cos.config.json` | Sync local, comandos clasp, IDs del entorno | Comportamiento de runtime |
| **Librería (runtime compartido)** | `shared/*.js` | Helpers cross-workflow, Gemini bridge, defaults de prompts, contratos reusables | Reglas de negocio de un solo workflow · triggers · UI |
| **Config del workflow** | `workflows/<NAME>/config.js` | IDs, nombres de pestaña, patrones de nombres | Lógica |
| **Código del workflow (stub)** | `workflows/<NAME>/*.js` | Orquestación de menú, triggers y secuencia específica; wrappers de `google.script.run` | Helpers genéricos (van a `shared/`) |
| **Runtime settings** | Pestañas del Sheet (`Daily`, `Weekly`, `Equipo`, `Prompts`) | Datos y config editados por el líder | IDs hardcodeados o lógica |
| **Artefactos de Drive** | Forms, correos generados | Superficies humanas y salidas | Fuente de verdad de contratos de código |
| **Documentación** | `Docs/` | Contratos legibles por humano/IA y specs de workflow | Comportamiento no implementado como si existiera |
| **Tests locales** | `tests/**/*.test.mjs` | Chequeos de contrato con mocks de GAS | Prueba de integración en vivo con Drive/Sheets |

---

## Desviación consciente de AOS: usamos una librería

El proyecto de referencia **AOS** establece en su `conventions.md`: *"una script container-bound
por workflow; tasks expuestas como items de menú en `onOpen()`. Sin librerías standalone (todavía)."*

**CoS-Agent se desvía de esa regla a propósito** y **sí usa una librería runtime standalone.**

**Por qué:**

- El objetivo de negocio es **distribuir a cada líder sin repartir el código** y **ocultar la
  API key**. El modelo clasp-dev-sync de AOS copia el código en cada proyecto bound (queda
  visible) y requiere clasp por líder — incompatible con "amigable y sin código a la vista".
- Una librería solo-lectura con el key en Script Properties es el mínimo que oculta código y key,
  y permite actualizar a todos los líderes desde un solo lugar.

**Costo aceptado:** una librería corre algo más lento que un proyecto monolítico y no permite
breakpoints dentro de ella desde el stub (se depura abriendo la librería o con `console.log()`).
Ver el detalle en [conventions.md](conventions.md#patrón-librería--stub) y
[engineering-playbook.md](engineering-playbook.md).

> Si en el futuro se migra a **Add-on**, esta desviación se revisa: el Add-on oculta el código de
> forma nativa y podría reabsorber el rol de la librería.

---

## Anclas de implementación

Este es el mapa canónico de archivo/test. Otros docs enlazan aquí en vez de repetir listas de
archivos. Se agrega un ancla nueva solo cuando un archivo se vuelve una superficie de contrato estable.

> **Estado:** `Planned` — aún no existe código. La tabla fija los nombres y responsabilidades
> acordados; se marcará `Implemented` a medida que se cree cada archivo.

| Superficie | Archivo canónico (planeado) | Estado |
|---|---|---|
| Config del workflow (estático) | `workflows/CLEVEL-REPORTS/config.js` | Implemented |
| Wrappers del stub (menú + `google.script.run`) | `workflows/CLEVEL-REPORTS/stub.js` | Implemented |
| Host del sidebar (HTML, 4 paneles) | `workflows/CLEVEL-REPORTS/Sidebar.html` | Implemented |
| Instalación de triggers | `workflows/CLEVEL-REPORTS/triggers.js` | Implemented |
| Bridge único con Gemini | `shared/gemini-runtime.js` | Implemented |
| Composición de prompts (soul+user+task) | `shared/prompts-runtime.js` | Implemented |
| Resumen por fila | `shared/summaries-runtime.js` | Implemented |
| Consolidados al líder | `shared/consolidation-runtime.js` | Implemented |
| Invitaciones (envío) | `shared/invites-runtime.js` | Implemented |
| Dispatcher (timing) + guardas anti-dup | `shared/dispatcher-runtime.js` | Implemented |
| Generación de Forms (FormApp) | `shared/forms-runtime.js` | Implemented |
| Acceso a Sheets/columnas/horas | `shared/sheets-runtime.js` | Implemented |
| Lectura de `Equipo` (roster) | `shared/roster-runtime.js` | Implemented |
| Ajustes editables + soporte del sidebar | `shared/settings-runtime.js` | Implemented |
| Mock harness de GAS para tests | `tests/gas-harness.mjs` | Implemented |
| Tests de contrato compartido | `tests/shared.test.mjs` | Implemented (22 tests) |
| Tests del workflow | `tests/clevel-reports.test.mjs` | Implemented (11 tests) |

> Estrategia de tests y flujo de deploy/versionamiento: [testing-and-deploy.md](testing-and-deploy.md).

---

## Modelo de archivos de runtime

Los archivos de runtime de Apps Script **no usan módulos ES**. Todos los `.js` de runtime
comparten un único namespace global, así que:

- **No** uses `import` / `export` en archivos bajo `shared/` o `workflows/<NAME>/`.
- Usa `.mjs` solo para tooling local y tests (que sí corren en Node).
- Los métodos privados de la librería terminan en guion bajo (`miHelper_`) para que **no sean
  visibles** a quien la incluye.
- El split en varios archivos es puramente organizacional; mantén cada archivo enfocado en una
  responsabilidad.

---

## Contract-Based Development

1. Un contrato se **define** en `shared/`, se **documenta** en `Docs/` y se **prueba** en `tests/`.
2. Un valor que cruza workflows (p. ej. la forma del objeto `roster`, o la clave de
   `GEMINI_API_KEY`) es un **contrato compartido**: cambiarlo obliga a actualizar doc + test.
3. La **detección de estado** (qué ya se envió hoy, qué fila ya tiene `Summary`) no depende de
   nombres legibles sino de guardas explícitas (Script Properties, columna `Summary` no vacía).
4. Los **encabezados de las preguntas NO son un contrato** — el líder los personaliza. El resumen
   usa *pass-through genérico* sobre pares pregunta→respuesta. Ver
   [CLEVEL-REPORTS.md](workflows/CLEVEL-REPORTS/CLEVEL-REPORTS.md#contrato-de-datos) y
   [sidebar-and-prompts.md](workflows/CLEVEL-REPORTS/sidebar-and-prompts.md).
