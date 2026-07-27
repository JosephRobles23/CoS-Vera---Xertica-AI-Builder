# Sidebar and Prompts

El sidebar es la **superficie de configuración** de CLEVEL-REPORTS: una mini-app HTML dentro del
Sheet del líder que le permite personalizar preguntas, prompts, horarios y equipo sin tocar código.
Es también donde vive la feature nueva de esta V0.5: **editar el system-prompt que genera el
resumen por fila** (Daily y Weekly), además del consolidado, `soul.md` y `user.md`.

> **Estado:** todo este documento es `High-level` (spec). No hay `.gs`/HTML aún.

## Anatomía: un sidebar, cuatro paneles

El sidebar **no** son cuatro sidebars: es uno solo con navegación tipo pestañas (SPA). Los botones
cambian el panel visible; no abren ventanas nuevas.

```
┌─────────────────────────────────────┐
│  [📝 Preguntas][🤖 Prompts][⏰ Horarios][👥 Equipo]  │  ← nav
├─────────────────────────────────────┤
│                                     │
│   (panel activo)                    │
│                                     │
│   [ Guardar ]                       │
└─────────────────────────────────────┘
```

| Panel | Qué edita el líder | Persiste en | Efecto lateral |
|---|---|---|---|
| **Preguntas** | Preguntas del Daily/Weekly (tipo + texto + opciones) | (define los Forms) | Genera/actualiza los Forms con `FormApp` |
| **Prompts** | `soul`, `user`, y los 4 system-prompts de tarea | Pestaña `Prompts` | Ninguno (se leen al generar texto) |
| **Horarios** | `invitesDaily`, `invitesWeekly`, `closeDaily`, `closeWeekly`, `timezone` | Pestaña `Ajustes` | Ninguno (el dispatcher lee en vivo) |
| **Equipo** | Miembros (Nombre, Correo, Rol) | Pestaña `Equipo` | Destinatarios de invitaciones |

---

## Contrato de comunicación (`google.script.run`)

El JS del sidebar llama funciones del **stub bound** con `google.script.run`, usando
`.withSuccessHandler()` / `.withFailureHandler()`. Regla clave:

> `google.script.run` **solo puede llamar funciones del stub bound**, nunca directo a la librería.
> Por eso cada acción del sidebar = un **wrapper delgado** en el stub que delega a `CoSLib`.

```html
<!-- Sidebar.html (fragmento) -->
<button onclick="generar('daily')">Generar Form Daily</button>
<script>
  function generar(tipo) {
    const preguntas = leerPanelPreguntas();      // arma el array desde la UI
    google.script.run
      .withSuccessHandler(url => mostrarLink(url))
      .withFailureHandler(err => alert('Error: ' + err.message))
      .generarFormulario(tipo, preguntas);       // ← wrapper del stub
  }
</script>
```

Wrappers esperados en el stub (todos delegan a `CoSLib`):

| Wrapper (stub) | Delegación (`CoSLib.*`) | Devuelve |
|---|---|---|
| `cargarConfig()` | `cargarConfig(sheetId, config)` | estado de los 4 paneles para pintar la UI |
| `configurarFormulario(tipo, preguntas)` | `configurarFormulario(tipo, preguntas, sheetId, config)` | URL publicada del Form (y persiste URL/ID/preguntas en `Ajustes`) |
| `guardarPrompts(prompts)` | `guardarPrompts(sheetId, config, prompts)` | `{ ok }` |
| `guardarHorarios(horarios)` | `guardarHorarios(sheetId, config, horarios)` | `{ ok }` |
| `guardarLeader(leader)` | `guardarLeader(sheetId, config, leader)` | `{ ok }` |
| `guardarEquipo(miembros)` | `guardarEquipo(sheetId, config, miembros)` | `{ ok, count }` |

> Cada wrapper del stub resuelve `sheetId`/`config` con `getSheetId_()` / `getConfig_()` y solo
> pasa los datos de la UI. Al abrir, el sidebar llama `cargarConfig()` una vez y pinta cada panel
> con lo guardado (o los defaults).

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

## Panel Preguntas ↔ Resumen (pass-through)

El líder define sus preguntas (tipo + texto + opciones). Como cada líder puede tener preguntas
distintas, el resumen **no** depende de encabezados fijos:

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

### Editor de opciones y Preview (UI)

- Para los tipos con opciones (`opcion`, `casillas`, `lista`) el sidebar muestra **un campo por
  opción** (cada uno con su ✕ y un botón "+ Opción") — **no** se separan por comas. Se guardan como
  `opciones: []`. Al crear la pregunta con estos tipos se siembra una opción vacía.
- Botón **"Preview"** (se habilita con ≥1 pregunta en el tipo activo): abre un diálogo que
  **renderiza el Form** tal como se vería — respuesta corta/larga, radios, casillas, desplegable,
  escala 1–5, fecha, hora. Es una **maqueta cliente**, no el Form real.
- `forms-runtime` filtra opciones vacías antes de crear el Form (`setChoiceValues([])` lanzaría error).

### Tipos de pregunta soportados (FormApp)

El panel ofrece estos tipos, mapeados a `FormApp`:

| Tipo en el sidebar | Método FormApp |
|---|---|
| Respuesta corta | `addTextItem()` |
| Párrafo | `addParagraphTextItem()` |
| Opción única | `addMultipleChoiceItem().setChoiceValues(...)` |
| Casillas | `addCheckboxItem()` |
| Desplegable | `addListItem()` |
| Escala | `addScaleItem().setBounds(1, 5)` |
| Fecha / Hora | `addDateItem()` / `addTimeItem()` |

### Generación de Forms

- `generarFormulario(tipo, preguntas)` crea (o regenera) el Form del líder con `FormApp.create()`,
  agrega los ítems según el panel, y fija el destino de respuestas al Sheet del líder con
  `form.setDestination(FormApp.DestinationType.SPREADSHEET, sheetId)`.
- Devuelve `form.getPublishedUrl()` para que el sidebar lo muestre y se guarde en
  `CONFIG.forms.<tipo>Url` (lo usa la invitación).

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

- **Stub bound:** `Sidebar.html`, `onOpen`, los wrappers de `google.script.run`, y la instalación
  de triggers.
- **Librería (`CoSLib`):** `FormApp`, composición de prompts + defaults, llamadas a Gemini,
  lectura/escritura de las pestañas, y envío de correos.
- **Sheet del líder:** pestañas `Prompts`, `Equipo`, `Daily`, `Weekly` — toda la personalización
  *por persona*.

Ver el patrón general en [../../conventions.md#patrón-librería--stub](../../conventions.md#patrón-librería--stub).
