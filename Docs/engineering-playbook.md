# Engineering Playbook

Esta guía da a los agentes/ingenieros las reglas prácticas para cambiar CoS-Agent sin volver
frágil el MVP.

## Prioridades de código

1. Preserva el aislamiento entre workflows y entre líderes.
2. Mantén los contratos explícitos y pequeños.
3. Valida antes de tener efectos secundarios (no envíes correos ni escribas Sheets con datos a medias).
4. Prefiere config y pestañas del Sheet sobre valores hardcodeados.
5. Optimiza para tests mantenibles, no para porcentaje de cobertura.
6. Mantén la doc en lockstep con el comportamiento de runtime (promueve `High-level` → `Implemented`).

## Reglas de modularización

Tres niveles de código:

| Nivel | Pon el código aquí cuando… | Ejemplo |
|---|---|---|
| **Helper compartido** (`shared/`) | Un segundo workflow necesitaría el mismo contrato o regla | Bridge de Gemini, composición de prompts, parseo de horas |
| **Helper del workflow** (`workflows/<NAME>/`) | Solo un workflow lo necesita, pero hace la orquestación más legible | `setupTriggers`, wrappers del sidebar |
| **Código inline** | Es de un solo uso, obvio y corto | Armar el asunto de un correo |

Promueve código a `shared/` **solo** cuando el contrato esté estable como para documentarlo y
probarlo. No crees helpers genéricos especulativos para workflows futuros.

## Estructura de una tarea (orquestación legible)

Mantén las funciones de tarea del workflow legibles como orquestación:

1. Validar setup.
2. Cargar datos.
3. Validar contratos de config/datos.
4. Preparar estado de idempotencia / índice de ejecución.
5. Ejecutar efectos secundarios.
6. Reportar resultado.

## Reglas de runtime de Apps Script

- V8 soporta sintaxis JS moderna, pero los archivos de runtime **no son módulos Node**: no uses
  `import`/`export` en `shared/` ni en `workflows/<NAME>/`. Los `.mjs` son solo para tooling y tests.
- Minimiza llamadas a servicios de Google: **una** lectura del Sheet seguida de trabajo en memoria,
  no lectura fila-por-fila. Usa `getRange(...).getValues()` una vez y parsea en memoria.
- Lee por **nombre de encabezado**, no por posición (mapa `{encabezado → columna}`), porque los
  encabezados de preguntas los personaliza el líder.
- Usa operaciones en lote; evita `flush()` salvo que necesites escrituras intermedias.
- Evita llamadas a Drive/Docs dentro de fases de solo-validación.

## Depuración con librería

- **No** puedes poner breakpoints dentro de la librería desde el stub: el debugger la trata como
  caja negra (hace *step over* de `CoSLib.foo()`).
- Para depurar la lógica: abre el **proyecto de la librería** y corre una función `_test` con datos
  de ejemplo (ahí sí funcionan los breakpoints), o usa `console.log()` dentro de la librería (sus
  logs aparecen en el registro de ejecución del stub que la llamó).

## Stub bootloader (qué va en el stub vs la librería)

El stub bound de cada líder es un **bootloader delgado y estable**: expone solo lo que la plataforma
**exige** que resida en el proyecto contenedor; todo lo demás vive en la librería para llegar por
versión (y por el botón *Actualizar*), sin re-copiar.

- **Debe quedarse en el stub** (no puede vivir en la librería):
  - `onOpen` — trigger simple; solo puede construir el menú (sin scopes de autorización). Delega en
    `CoSLib.construirMenu(ui)`, que **también** debe permanecer libre de servicios autorizados.
  - Handlers de ítems de menú (se resuelven por **nombre** en el scope del stub, sin args): usa
    facades (`abrirSidebar`, `actualizarVersion`) o los slots pre-provisionados `cosMenu1..5`.
  - Callbacks de `google.script.run` (resuelven en el stub): usa el puente genérico
    `cosRun(fnName, argsJson)` → `CoSLib.dispatch(...)` en vez de un wrapper por función.
  - La llamada de UI final (`showSidebar`/`showModalDialog`) y `ScriptApp.getScriptId()`.
- **Debe vivir en la librería** (para actualizarse por versión): estructura del menú, HTML del
  sidebar/diálogos (`createHtmlOutputFromFile` carga del proyecto que ejecuta), y toda la lógica.
- **Regla al agregar una función de servidor para el sidebar:** regístrala en `CoSLib.dispatch`
  (convención `fn(sheetId, config, ...args)`) y llámala desde el cliente vía `cosRun` — **no** un
  wrapper nuevo en el stub. Un ítem de menú con acción nueva usa un slot libre (`CoSLib.menuAction`).
- **Auto-update destructivo:** `updateContent` reemplaza **todos** los archivos; reenvía cada uno
  verbatim y parchea solo el `version` de la dependencia (por `libraryId`, no por `userSymbol`).

## Capas de prompts (contrato)

Cada llamada al LLM compone, en este orden, un único bloque de sistema:

```
[ soul.md ]      → voz/persona del asistente (global del líder)
[ user.md ]      → contexto del líder y su equipo (global del líder)
[ system-task ]  → instrucciones de la tarea (resumen daily / weekly / consolidado daily / weekly)
```

…y el bloque de usuario lleva **solo los datos** (los pares pregunta→respuesta, o la lista de
`Summary`).

Reglas:

- La librería trae **defaults baked-in** para las 6 piezas (`soul`, `user`, y 4 system-tasks).
  Si la pestaña `Prompts` del líder tiene una celda vacía, se usa el default → una copia nueva
  funciona out-of-the-box.
- `soul.md` y `user.md` se aplican a **todas** las tareas; los system-tasks son por tarea.
- Nunca metas el key ni datos sensibles en los prompts.
- Detalle del almacenamiento y edición en
  [sidebar-and-prompts.md](workflows/CLEVEL-REPORTS/sidebar-and-prompts.md).

## Reglas del bridge de Gemini

- **Un solo** puente HTTP con Gemini (`shared/gemini-runtime.js`); nadie más llama a
  `UrlFetchApp` para el LLM.
- La key se lee de Script Properties (`GEMINI_API_KEY`); si falta, **falla rápido** con un mensaje
  claro.
- **Modelo por llamada:** Flash para el resumen por fila (alto volumen), Pro para consolidados.
  Los IDs viven en `cos.config.json → gemini` y se pasan como parámetro; el bridge no hardcodea el
  modelo.
- **Reintento simple** ante `429`/`5xx` (1 reintento con espera); los `4xx` no se reintentan.
- **Falla rápido** si la respuesta viene vacía; nunca escribas un `Summary` en blanco encima de uno
  bueno.
- **Sin techo de salida por defecto.** Los modelos Gemini 3.x "piensan" (thinking tokens); un
  `maxOutputTokens` bajo se gasta razonando y devuelve `200` con `content` vacío y
  `finishReason:MAX_TOKENS`. El bridge **omite** `maxOutputTokens` salvo que el caller lo pida, así
  el modelo usa su máximo. (Análogo al `reasoning_effort` de GPT-5 en la v0.5.)
- Los IDs de modelo exactos de Gemini se **confirman contra la documentación oficial al implementar**
  (no se asumen de memoria).

## Idempotencia y guardas

- El resumen por fila es idempotente: si la fila ya tiene `Summary` no vacío, no lo regeneres salvo
  que se pida explícitamente.
- Las invitaciones y consolidados usan guardas anti-duplicado en Script Properties
  (`sent:<tipo>:<id>:<fecha>`), para que reejecutar el `dispatcher` en la misma ventana no reenvíe.
- Sin reintentos automáticos de trigger: si una corrida del `dispatcher` falla (red/cuota), la
  siguiente ventana lo reintentará de forma natural.

## Enlaces canónicos

Los mapas de archivo/test están en
[architecture-and-contracts.md#anclas-de-implementación](architecture-and-contracts.md#anclas-de-implementación).
Enlaza ahí en vez de repetir listas de archivos.
