# Sidebar and Prompts

CLEVEL-REPORTS tiene **dos superficies de configuración** HTML dentro del Sheet del líder, ambas
servidas por la librería (`CoSLib`) y abiertas desde el menú **CoS**:

- **Sidebar** (`CoS → Configurar`, `shared/Sidebar.html`): tres paneles — **Prompts**, **Horarios**
  y **Equipo**.
- **Modal de formularios** (`CoS → Formularios`, `shared/DialogPreguntas.html`): editor de las
  preguntas del Daily/Weekly, con edición manual **y** generación por IA. Ver
  [§ Modal de formularios](#modal-de-formularios-preguntas--generación-por-ia).

> **Estado:** `Implemented`. El editor de preguntas **se movió del sidebar a un modal** propio;
> el sidebar quedó con 3 paneles. Anclas de archivo/test en
> [../../architecture-and-contracts.md#anclas-de-implementación](../../architecture-and-contracts.md#anclas-de-implementación).

## Anatomía: un sidebar, tres paneles

El sidebar **no** son tres sidebars: es uno solo con navegación tipo pestañas (SPA). Los botones
cambian el panel visible; no abren ventanas nuevas. Abre en **Prompts** por defecto.

```
┌─────────────────────────────────────┐
│  [🤖 Prompts][⏰ Horarios][👥 Equipo]  │  ← nav
├─────────────────────────────────────┤
│                                     │
│   (panel activo)                    │
│                                     │
│   [ Guardar ]                       │
└─────────────────────────────────────┘
```

| Panel | Qué edita el líder | Persiste en | Efecto lateral |
|---|---|---|---|
| **Prompts** | `soul`, `user`, y los 4 system-prompts de tarea | Pestaña `Prompts` | Ninguno (se leen al generar texto) |
| **Horarios** | `invitesDaily`, `invitesWeekly`, `closeDaily`, `closeWeekly`, `timezone` | Pestaña `Ajustes` | Ninguno (el dispatcher lee en vivo) |
| **Equipo** | Miembros (Nombre, Correo, Rol) | Pestaña `Equipo` | Destinatarios de invitaciones + acceso a Forms |

Las **preguntas** ya no viven en el sidebar: se editan en el
[modal de formularios](#modal-de-formularios-preguntas--generación-por-ia).

---

## Contrato de comunicación (`google.script.run`)

Toda la UI (sidebar y modal) llama funciones del **stub bound** con `google.script.run`, usando
`.withSuccessHandler()` / `.withFailureHandler()`. Regla clave:

> `google.script.run` **solo puede llamar funciones del stub bound**, nunca directo a la librería.

Hay **dos canales**, y esta distinción es un contrato (ver
[../../architecture-and-contracts.md#contract-based-development](../../architecture-and-contracts.md#contract-based-development)):

1. **Wrappers nombrados** — un conjunto **fijo** de funciones que el stub declara explícitamente y
   delega a `CoSLib`. Los usa el sidebar (código heredado). Agregar uno nuevo obliga a re-empujar
   el stub a cada copia, así que **no se agregan más**.
2. **Puente genérico `cosRun(fnName, argsJson)`** — el stub reenvía a `CoSLib.dispatch(fnName, …)`,
   que enruta a `DISPATCH_` (`shared/ui-runtime.js`). Es el canal para **toda función de servidor
   nueva**; permite sumar funciones **sin tocar el stub** (viajan por versión de librería). El modal
   usa **solo** este canal.

> ⚠️ Llamar una función nueva como método directo (`google.script.run.generarPreguntasIA(...)`) da
> `undefined` y el wrapper cliente truena con *"Cannot read properties of undefined (reading
> 'apply')"*. El HTML nuevo debe llamar `...cosRun(fnName, JSON.stringify(args))`. Ver memoria
> `gsrun-bridge-cosrun`.

```html
<!-- DialogPreguntas.html (fragmento) — canal cosRun -->
<script>
  function run(method) {
    return function () {
      var args = Array.prototype.slice.call(arguments);
      return new Promise(function (resolve, reject) {
        google.script.run.withSuccessHandler(resolve).withFailureHandler(reject)
          .cosRun(method, JSON.stringify(args));   // ← puente genérico → dispatch
      });
    };
  }
  // uso: run('guardarFormulario')(tipo, { preguntas, titulo, descripcion, prompt })
</script>
```

**Wrappers nombrados** en el stub (los usa el sidebar; todos delegan a `CoSLib`):

| Wrapper (stub) | Delegación (`CoSLib.*`) | Devuelve |
|---|---|---|
| `cargarConfig()` | `cargarConfig(sheetId, config)` | estado de los paneles + `formMeta` para pintar la UI |
| `configurarFormulario(tipo, preguntas)` | `configurarFormulario(tipo, preguntas, sheetId, config)` | URL publicada del Form (compat; el modal usa `guardarFormulario`) |
| `guardarPrompts(prompts)` | `guardarPrompts(sheetId, config, prompts)` | `{ ok }` |
| `guardarHorarios(horarios)` | `guardarHorarios(sheetId, config, horarios)` | `{ ok }` |
| `guardarLeader(leader)` | `guardarLeader(sheetId, config, leader)` | `{ ok }` |
| `guardarEquipo(miembros)` | `guardarEquipo(sheetId, config, miembros)` | `{ ok, count }` |

**Funciones vía `cosRun` → `DISPATCH_`** (las usa el modal; convención `fn(sheetId, config, …args)`):

| Clave en `dispatch` | Función (`CoSLib.*`) | Devuelve |
|---|---|---|
| `generarPreguntasIA` | `generarPreguntasIA(sheetId, config, tipo, prompt)` | `{ titulo, descripcion, preguntas, notas }` (no persiste) |
| `guardarFormulario` | `guardarFormulario(sheetId, config, tipo, payload)` | `{ publishedUrl }` (crea/reescribe el Form y persiste todo en `Ajustes`) |

> Cada wrapper/entrada resuelve `sheetId`/`config` con `getSheetId_()` / `getConfig_()` y solo
> recibe los datos de la UI. Al abrir, cada superficie llama `cargarConfig()` una vez y pinta con lo
> guardado (o los defaults).

---

## Panel Prompts: capas y composición

El líder edita **6 artefactos**, en dos grupos:

- **Globales** (se aplican a toda generación): `soul.md` (voz/persona), `user.md` (contexto del
  líder y su equipo).
- **Por tarea** (system-prompt de cada salida): `task.summary.daily`, `task.summary.weekly`,
  `task.consolidated.daily`, `task.consolidated.weekly`.

Cada llamada al LLM compone un único bloque de sistema en este orden:

```
system = soul.md
       + user.md
       + <system-prompt de la tarea>
user   = <solo datos>   (pares pregunta→respuesta, o la lista de Summary)
```

Ejemplo (resumen Daily por fila):

```
system:
  [soul]  Eres el Chief of Staff de {líder}. Tono ejecutivo, directo, sin relleno…
  [user]  Contexto: equipo de Procesos; prioridades Q3…; el destinatario es {C-level}…
  [task]  Redacta un RESUMEN DIARIO factual (4–7 líneas). Estructura: foco, bloqueos, riesgos…
user:
  Persona: Ana
  ¿Qué vas a lograr hoy?: …
  ¿Qué te bloquea…?: …
  (todas las preguntas del Form de este líder, sean cuales sean)
```

Ver las reglas de composición en
[../../engineering-playbook.md#capas-de-prompts-contrato](../../engineering-playbook.md#capas-de-prompts-contrato).

### Storage de prompts

- Persisten en la pestaña **`Prompts`** del Sheet del líder, una fila por artefacto (`key`, `value`):

  | key | value |
  |---|---|
  | `soul` | … |
  | `user` | … |
  | `task.summary.daily` | … |
  | `task.summary.weekly` | … |
  | `task.consolidated.daily` | … |
  | `task.consolidated.weekly` | … |

- **Defaults baked-in en la librería** (`shared/prompts-runtime.js`): si una celda está vacía, se
  usa el default → una copia nueva funciona out-of-the-box y el líder solo sobrescribe lo que quiera.
- Editable desde el sidebar **y** a mano en la pestaña (útil para textos largos como `soul`/`user`).
- Sin límite práctico de tamaño (a diferencia de Document Properties, ~9KB por valor). Fácil de
  inspeccionar y respaldar.

Resolución efectiva de un prompt: `valor de la celda` → si vacío → `default de la librería`.

- **En el sidebar:** el `value` del textarea es lo **guardado** (vacío si no se personalizó) y el
  **placeholder muestra el default**. Para esto `cargarConfig` devuelve `prompts` (crudos, `''` si no)
  y `promptDefaults` (los defaults de la librería vía `getPromptsRaw_` / `getDefaultPrompts_`).
- Botón **"Reestablecer Prompts"**: carga los textos por defecto en los campos (para editarlos desde
  ahí); no guarda solo — el líder revisa y pulsa **Guardar prompts**.

---

## Modal de formularios (preguntas + generación por IA)

Se abre desde `CoS → Formularios` (`shared/DialogPreguntas.html`). Reemplaza al viejo panel
"Preguntas" del sidebar. Estructura:

```
┌───────────────────────────────────────────────┐
│  [ Daily ][ Weekly ]                            │  ← secciones padre
│  ┌─────────────────────────────────────────┐   │
│  │ [ Preguntas ][ Generative Form ]         │   │  ← sub-pestañas
│  │                                          │   │
│  │  (edición manual  |  prompt → IA)        │   │
│  │                                          │   │
│  │  [ Preview ]  [ Guardar / actualizar ]   │   │
│  └─────────────────────────────────────────┘   │
└───────────────────────────────────────────────┘
```

- **Sección padre Daily / Weekly:** cada una tiene su propio set de preguntas, título/descripción
  del Form y prompt de generación, persistidos por separado.
- **Sub-pestaña Preguntas (manual):** inputs de **Título** y **Descripción** del Form; lista de
  preguntas (por card: tipo, enunciado, opciones si aplica, **toggle Obligatorio**, **texto de
  Ayuda**, **flechas ↑/↓** para reordenar, borrar); botones "Agregar pregunta", "Preview" y
  "Guardar / actualizar Form".
- **Sub-pestaña Generative Form (IA):** un `<textarea>` con el prompt detallado (precargado con el
  guardado); "Generar" pide confirmación ("reemplazará las N preguntas actuales") → llama
  `generarPreguntasIA` → autocompleta la lista de la sub-pestaña Preguntas más el título/descr. (si
  el prompt los especifica) y muestra las **notas** (tipos degradados, cap aplicado). No persiste
  hasta Guardar.
- **Preview:** overlay in-modal que **renderiza el Form** tal como se vería (control por tipo,
  **asterisco** si es obligatorio, texto de ayuda), sobre lo editado sin guardar. Es una maqueta
  cliente, no el Form real.

### Modelo de pregunta (retrocompatible)

Cada pregunta es un objeto JSON persistido en `Ajustes` bajo `questions.<tipo>`:

```json
{ "tipo": "escala", "titulo": "¿Nivel de bloqueo?", "opciones": [],
  "min": 1, "max": 5, "requerido": true, "ayuda": "1 = sin bloqueo" }
```

`requerido`, `ayuda`, `min` y `max` son **opcionales**: las preguntas viejas sin esos campos siguen
válidas (`parseQuestions_` solo hace `JSON.parse`).

### Pass-through al resumen

Como cada líder puede tener preguntas distintas, el resumen **no** depende de encabezados fijos:

- El Form generado lleva **solo** las preguntas del líder: no se agrega casilla de `Nombre` ni de
  `Correo`. La identidad sale del correo **verificado** de la sesión de Google del respondiente,
  cruzado contra la pestaña `Equipo` al recibir la respuesta.
- Al **generar el resumen**, la librería toma **todas** las columnas de respuesta (las que están
  entre el bloque fijo inicial y las columnas de contrato `Nombre`/`Correo`/`Lider`/`Summary`) y las
  manda al LLM como pares `pregunta → respuesta`.
- La **estructura de la salida** la impone el system-prompt de la tarea, no las columnas.
- Consecuencia: el líder cambia sus preguntas cuando quiera **sin romper** el resumen ni el
  consolidado.

> Contrato relacionado en
> [CLEVEL-REPORTS.md#contrato-de-datos](CLEVEL-REPORTS.md#contrato-de-datos).

### Editor de opciones

- Para los tipos con opciones (`opcion`, `casillas`, `lista`) el modal muestra **un campo por
  opción** (cada uno con su ✕ y un botón "+ Opción") — **no** se separan por comas. Se guardan como
  `opciones: []`. Al crear la pregunta con estos tipos se siembra una opción vacía.
- `forms-runtime` filtra opciones vacías antes de crear el Form (`setChoiceValues([])` lanzaría error).

### Tipos de pregunta soportados (FormApp)

El modal ofrece estos tipos, mapeados a `FormApp`:

| Tipo en el modal | Método FormApp |
|---|---|
| Respuesta corta | `addTextItem()` |
| Párrafo | `addParagraphTextItem()` |
| Opción única | `addMultipleChoiceItem().setChoiceValues(...)` |
| Casillas | `addCheckboxItem()` |
| Desplegable | `addListItem()` |
| Escala | `addScaleItem().setBounds(1, 5)` |
| Fecha / Hora | `addDateItem()` / `addTimeItem()` |

Cada ítem aplica además `setRequired(true)` si `requerido` y `setHelpText(...)` si hay `ayuda`.

### Generación por IA (`generarPreguntasIA`)

- `generarPreguntasIA(sheetId, config, tipo, promptDetallado)` (`shared/forms-ai-runtime.js`) llama a
  Gemini (`config.models.perRow`) con **structured output** (`responseSchema` +
  `responseMimeType:'application/json'`, ver [gemini-runtime](#)) y un system-prompt que fija idioma
  español, tipos permitidos y reglas (escala 1–5 por defecto, opciones solo para los tipos que las
  usan).
- El texto JSON se parsea y **sanea**: tipos desconocidos se **degradan** al más cercano (con nota),
  opciones vacías se descartan, `requerido` se coacciona a bool, la escala se hace clamp, y se
  aplica un **cap de ~25 preguntas** (recorta + nota). **JSON inválido → error visible.**
- Devuelve `{ titulo, descripcion, preguntas, notas }` y **no persiste** (eso ocurre al Guardar).

### Guardar / regenerar el Form (`guardarFormulario`)

- `guardarFormulario(sheetId, config, tipo, { preguntas, titulo, descripcion, prompt })`
  (`shared/settings-runtime.js`) llama a `generarFormulario(...)` y persiste en un solo `setAjustes_`:
  `questions.<tipo>` (JSON), `forms.<tipo>Url`/`FormId`, `form.title.<tipo>`, `form.desc.<tipo>` y
  `prompt.gen.<tipo>`.
- **Regenerar reescribe el MISMO Form** (conserva URL/ID, correo **verificado**, publicación y
  acceso del equipo, y la pestaña de respuestas): la primera vez `FormApp.create()`; después edita el
  Form existente por su `FormId`. Título/descr. solo se re-aplican si vienen no vacíos.
- Devuelve `{ publishedUrl }` para mostrarlo; la URL se guarda en `CONFIG.forms.<tipo>Url` (la usa la
  invitación).

---

## Panel Horarios

- **Zona horaria:** un `<select>` (agrupado por país: Perú, Ecuador, Colombia, México, Chile,
  Argentina, Brasil, EE. UU.) que persiste `timezone`. El dispatcher interpreta **todas** las horas
  en esta zona, así cada líder opera en su país. Si el valor guardado no está en la lista, se inyecta.
- **Cuatro** selectores **HH:MM** (popover custom de dos columnas hora/minuto, paso de 5, scroll
  fino): invitación **Daily**, invitación **Weekly**, **cierre Daily** y **cierre Weekly** (los
  cierres son **independientes**). Más el líder (nombre/correo que recibe los consolidados).
- **Guardar NO reprograma triggers.** El único trigger de tiempo es el `dispatcher` cada 5 min,
  que **lee los horarios en vivo** de la pestaña `Ajustes` en cada corrida. Cambiar una hora solo
  reescribe `Ajustes`; no se toca ningún trigger.
- Recordatorio: el dispatcher dispara dentro de una **ventana** (~5 min), no al minuto exacto, y
  respeta `CONFIG.timezone`.

---

## Panel Equipo

- Tabla editable: `Nombre`, `Correo`, `Rol`. Persiste en la pestaña `Equipo`.
- Es la lista de destinatarios de las invitaciones (Daily/Weekly), que **nombran al líder**.
- `Correo` es además la **llave de identidad**: como el Form ya no pregunta quién responde, cada
  respuesta se cruza por este correo para escribir `Nombre` y `Correo` en `Daily`/`Weekly`. Debe ser
  la cuenta de Google con la que la persona realmente inicia sesión, o la fila quedará sin nombre.
- `Rol` es opcional y puede enriquecer `user.md` para dar contexto al LLM.
- **Guardar equipo también sincroniza el acceso a los Forms** (`sincronizarAccesoForms`): agrega a
  cada correo como **respondiente** (*published reader* — puede responder, **no** editar) de los
  Forms ya generados. Por eso quien entra al equipo después no necesita que se regeneren los Forms.
  **No quita** a quien sale del equipo: revocar acceso se hace a mano en el propio Form.

---

## Resumen del reparto (coherente con el patrón librería + stub)

- **Stub bound (bootloader):** `onOpen`/`abrirSidebar`/`abrirDialogo` (delegan en la librería), el
  puente `cosRun` + los wrappers nombrados de `google.script.run`, los slots de menú, y la
  instalación de triggers.
- **Librería (`CoSLib`):** el **menú, el HTML del sidebar y del modal** (`ui-runtime.js` +
  `Sidebar.html` + `DialogPreguntas.html`), el `dispatch`/`DISPATCH_`, `FormApp`, generación de
  preguntas por IA, composición de prompts + defaults, llamadas a Gemini, lectura/escritura de las
  pestañas, y envío de correos.
- **Sheet del líder:** pestañas `Prompts`, `Equipo`, `Daily`, `Weekly` — toda la personalización
  *por persona*.

Ver el patrón general en [../../conventions.md#patrón-librería--stub](../../conventions.md#patrón-librería--stub).
