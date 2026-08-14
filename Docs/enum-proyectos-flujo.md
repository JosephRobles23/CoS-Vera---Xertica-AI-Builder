# Proyectos como `enum` — cómo funciona y flujo de datos de la ingesta

> **Estado: IMPLEMENTADO (2026-08-14)** — compuerta, enum por llamada, temperatura 0, dedup con
> contención/stopwords, truncados y `olvidarProyecto` están en código con su matriz de tests
> (ver `tests/brain-ingest-runtime.test.mjs`, `tests/meet-notes-runtime.test.mjs`,
> `tests/brain-admin-runtime.test.mjs`). La fase 2 (cola de aprobación HITL) sigue en backlog.
>
> Documento de diseño del fix a los bugs de títulos de proyecto:
> fuga de razonamiento del LLM dentro del campo `proyecto` y duplicación de páginas en
> `wiki/projects/`. Acompaña al grill de 2026-08-14. Estado actual del código:
> `shared/brain-ingest-runtime.js` (formularios) y `shared/meet-notes-runtime.js` (notas de Meet).

---

## 1. El flujo de datos HOY (dónde nace el bug)

Hay **dos caminos de entrada** al brain y ambos convergen en `resolverProyecto_`:

```mermaid
flowchart TD
    subgraph Entradas
        A1["📝 Formulario Daily/Weekly<br/>(onFormSubmit → generarSummaryFila)"]
        A2["🎥 Nota de Gemini en Meet<br/>(pasada horaria del dispatcher)"]
    end

    A1 --> B1["ingestarFila_<br/>brain-ingest-runtime.js"]
    A2 --> B2["ingestarNotaMeet_<br/>meet-notes-runtime.js"]

    B1 --> C1["callGemini_ (Flash, temp 0.4)<br/>responseSchema: INGEST_SCHEMA_<br/>{summary, eventos[]}"]
    B2 --> C2["callGemini_ (Flash, temp 0.4)<br/>responseSchema: MEET_SCHEMA_<br/>{resumen, asistentes, eventos[]}"]

    C1 --> D["parseIngest_ / parseo JSON<br/>filtra eventos sin texto/tipo<br/>⚠️ NO valida contenido de strings"]
    C2 --> D

    D --> E{"evento.proyecto<br/>≠ vacío?"}
    E -- no --> F["El evento vive solo en<br/>página de persona + acta"]
    E -- sí --> G["resolverProyecto_<br/>brain-ingest-runtime.js:355"]

    G --> H{"¿match exacto<br/>slug/alias en<br/>_projects.json?"}
    H -- sí --> I["Reusa entidad canónica"]
    H -- no --> J{"¿Jaccard ≥ 0.6<br/>contra algún canónico?"}
    J -- sí --> K["Registra alias<br/>y reusa canónica"]
    J -- no --> L["🔴 AUTOCREA:<br/>entrada en _projects.json +<br/>página wiki/projects/&lt;slug&gt;.md"]

    I --> M["regenerarPaginaProyecto_<br/>+ página persona + acta<br/>+ log.md + index"]
    K --> M
    L --> M

    style L fill:#fdd,stroke:#c00
    style D fill:#ffd,stroke:#a80
```

**Los dos defectos, señalados en el diagrama:**

1. **Nodo amarillo (`parseIngest_`)**: el `responseSchema` de Gemini garantiza la *forma* del
   JSON (decodificación restringida: llaves, tipos, enums), pero **no el contenido de un
   string**. Cuando Flash dudó entre nombres de proyecto, su deliberación entera ("Usaremos
   'AI Academy'. No, dejemos…") entró como valor de `proyecto` y el parseo la aceptó.
2. **Nodo rojo (autocreación)**: cualquier string que no matchee crea entidad. Un nombre de
   300 tokens jamás alcanza Jaccard 0.6 contra `ai-academy` → página basura. Y variantes
   legítimas ("Academia IA" vs "AI Academy") tampoco matchean → **duplicados**.

---

## 2. Qué es el `enum` y por qué es garantía dura

Hallazgo del research (docs oficiales del API de Gemini, ago 2026):

| Restricción en `responseSchema` | ¿Se fuerza? | Mecanismo |
|---|---|---|
| Estructura, tipos, campos `required` | ✅ Sí | Decodificación restringida (el modelo no puede emitir tokens inválidos) |
| `enum` en strings | ✅ Sí | Ídem — literalmente no puede emitir un valor fuera de la lista |
| `maxLength` / `minLength` / `pattern` | ❌ No | El API lo acepta pero es una *pista*; la doc dice "always validate values in your application" |

Conclusión: **`enum` sí es una garantía absoluta; `maxLength` no existe en la práctica.**
Por eso la longitud la garantiza código nuestro (la compuerta `sanitizarProyecto_`), y la
*asignación* a proyectos existentes la garantiza el `enum`.

### El schema se construye POR LLAMADA

Hoy `MEET_SCHEMA_` / `INGEST_SCHEMA_` son constantes. Con el cambio, el campo `proyecto`
se genera dinámicamente leyendo `_projects.json` del wiki del líder justo antes del call:

```js
// pseudocódigo del builder
function schemaConProyectos_(root, baseSchema) {
  var conocidos = Object.keys(cargarProyectos_(root))
                        .map(function (s) { return mapa[s].name; });   // nombres canónicos
  var ev = baseSchema…eventos.items.properties;
  ev.proyecto        = { type: 'string', enum: conocidos.concat(['OTRO', '']) };
  ev.proyecto_nuevo  = { type: 'string' };   // SOLO se lee si proyecto === 'OTRO'
  return baseSchema;
}
```

El modelo ve tres salidas posibles para `proyecto`:

- **Un nombre canónico de la lista** → mapeo directo, sin fuzzy matching, sin error posible.
- **`''` (vacío)** → el hecho no refiere a ningún proyecto distinguible.
- **`'OTRO'`** → el modelo cree que es un proyecto que no está en el catálogo, y propone el
  nombre en `proyecto_nuevo` (campo libre → pasa por la compuerta determinista).

---

## 3. El flujo PROPUESTO (enum + compuerta)

```mermaid
flowchart TD
    A["Entrada (formulario o nota de Meet)"] --> B["cargarProyectos_(root)<br/>lee _projects.json"]
    B --> C["schemaConProyectos_<br/>inyecta enum: [canónicos] + 'OTRO' + ''"]
    C --> D["callGemini_ (Flash, <b>temp 0</b>)<br/>prompt endurecido:<br/>'nombre propio, máx 3-4 palabras,<br/>NUNCA razonamiento en campos'"]

    D --> E{"evento.proyecto"}
    E -- "nombre del enum" --> F["✅ Match directo garantizado<br/>por decodificación restringida<br/>(sin Jaccard, sin alias nuevos)"]
    E -- "'' (vacío)" --> G["Evento sin proyecto:<br/>vive en persona + acta"]
    E -- "'OTRO'" --> H["sanitizarProyecto_(proyecto_nuevo)<br/><b>compuerta determinista</b>"]

    H --> I{"¿pasa la compuerta?<br/>≤60 chars, ≤6 palabras,<br/>1 oración, sin marcadores<br/>de fuga, sin saltos de línea"}
    I -- no --> J["🛡️ RECHAZO: evento queda sin<br/>proyecto + línea ⚠️ en wiki/log.md"]
    I -- sí --> K["resolverProyecto_ (dedup mejorado):<br/>1. exacto slug/alias<br/>2. contención de tokens (slugContenido_)<br/>3. Jaccard ≥ 0.6 sin stopwords ES/EN"]

    K --> L{"¿matchea?"}
    L -- sí --> M["Registra alias y reusa canónica"]
    L -- no --> N["🟡 AUTOCREA (saneado):<br/>entra a _projects.json →<br/>aparece en el enum de la<br/>SIGUIENTE llamada"]

    F --> O["Regeneración de páginas<br/>+ log + index"]
    G --> O
    J --> O
    M --> O
    N --> O

    style F fill:#dfd,stroke:#080
    style J fill:#dfd,stroke:#080
    style N fill:#ffd,stroke:#a80
    style H fill:#def,stroke:#06c
```

### Secuencia completa de una nota de Meet (propuesta)

```mermaid
sequenceDiagram
    participant DIS as Dispatcher (pasada horaria)
    participant DRV as Drive/Calendar
    participant WIKI as Brain (Drive wiki/)
    participant GEM as Gemini Flash
    participant GATE as Compuerta (código)

    DIS->>DRV: notasPendientes_ (busca Docs "Notas de Gemini", ventana 7d)
    DRV-->>DIS: doc candidato + evento de Calendar
    DIS->>WIKI: cargarProyectos_ → _projects.json
    WIKI-->>DIS: {ai-academy: {name, aliases}, dealflow: …}
    DIS->>DIS: schemaConProyectos_ (enum por llamada)
    DIS->>GEM: system endurecido + texto de la nota + roster + pendientes (temp 0)
    GEM-->>DIS: JSON {resumen, asistentes, eventos[]}<br/>proyecto ∈ enum ⟵ GARANTIZADO
    loop por cada evento
        alt proyecto = nombre canónico
            DIS->>WIKI: regenerarPaginaProyecto_ (entidad existente)
        else proyecto = 'OTRO'
            DIS->>GATE: sanitizarProyecto_(proyecto_nuevo)
            alt pasa
                GATE->>WIKI: resolverProyecto_ (dedup) → reusar o autocrear saneado
            else no pasa
                GATE->>WIKI: log.md ⚠️ rechazado · evento sin proyecto
            end
        end
    end
    DIS->>WIKI: página persona + acta + log.md + index.md
```

---

## 4. ¿Se autoactualiza el catálogo sin HITL? — SÍ (fase 1), con red de seguridad

**Respuesta corta: sí, el enum se retroalimenta solo, sin humano en el loop, en la fase 1.**
El ciclo de vida de un proyecto nuevo:

```mermaid
flowchart LR
    A["Reunión menciona<br/>'Proyecto Fénix'<br/>(no está en el catálogo)"] --> B["Modelo emite<br/>proyecto: 'OTRO'<br/>proyecto_nuevo: 'Fénix'"]
    B --> C["Compuerta ✅<br/>+ dedup sin match"]
    C --> D["Autocreación:<br/>_projects.json += fenix"]
    D --> E["Próxima ingesta:<br/>'Fénix' YA está en el enum<br/>→ match directo garantizado"]
```

- **Sin HITL**: nadie aprueba la creación. El humano solo interviene *a posteriori* y en
  excepción: el modal de gobernanza permite `mergearProyectos` (fusionar duplicados) y —nuevo
  en este release— `olvidarProyecto` (borrar una entidad equivocada). El `log.md` deja rastro
  de cada autocreación y cada rechazo, así que la deriva es auditable.
- **La red de seguridad es la compuerta**: la autocreación sigue existiendo, pero ya solo
  puede crear nombres cortos, de una oración, sin marcadores de fuga. El pantallazo del bug
  es **irreproducible por construcción**: un monólogo de 1.900 caracteres no pasa `≤60 chars`.
- **Convergencia del catálogo**: cada proyecto legítimo pasa por "OTRO" exactamente una vez
  (su primera mención); después vive en el enum y el modelo ya no puede inventar variantes
  ("Academia IA" no existe como opción si el enum ofrece "AI Academy" — la decodificación
  restringida lo obliga a elegir del catálogo o declarar OTRO, y el dedup por contención
  atrapa la variante en ese único paso).

**Fase 2 (backlog, con maqueta/grill propio): HITL opcional.** La autocreación se sustituye
por una **cola de "proyectos por confirmar"**: `proyecto_nuevo` válido no crea página sino una
entrada pendiente que el líder aprueba/fusiona/descarta desde el modal de gobernanza. Ahí el
catálogo pasa a ser 100 % curado por humano y el enum se vuelve un vocabulario cerrado real.

### Casos borde del enum, explícitos

| Caso | Comportamiento |
|---|---|
| Wiki nuevo (catálogo vacío) | El enum es solo `['OTRO', '']` → todo proyecto nuevo pasa por la compuerta. Es el comportamiento de hoy pero saneado; no empeora nada. |
| Catálogo crece mucho (50+ proyectos) | El enum agranda el schema (tokens de entrada). A escala de un equipo de C-level (~5-20 iniciativas) es irrelevante; si llegara a doler, se poda con `status: activo` en `_projects.json`. |
| El modelo se equivoca de canónico | Posible pero mucho menos probable que el fuzzy actual (el modelo ve los nombres con contexto semántico; el Jaccard solo ve tokens). Corrección: `mergearProyectos` / edición de la página. |
| Proyecto renombrado por el equipo | El nombre viejo sigue en el enum; el nuevo entra por OTRO y se fusiona con `mergearProyectos` (los aliases quedan). |
| Fallo del call con schema dinámico | Igual que hoy: `parseIngest_` es tolerante (summary crudo, 0 eventos); el reporte/nota no se pierde (raw/ inmutable). |

---

## 5. Resumen de garantías por capa

| Amenaza | Capa que la elimina | ¿Determinista? |
|---|---|---|
| Fuga de razonamiento como nombre de proyecto | Compuerta `sanitizarProyecto_` (código) | ✅ 100 % |
| Asignación errónea a proyecto existente | `enum` (decodificación restringida) | ✅ 100 % |
| Duplicado por variante de nombre | enum (tras 1.ª mención) + contención de tokens + stopwords | ◐ Muy alta |
| Divagación en `texto`/`resumen` | Truncado en código (~300/600 chars) | ✅ 100 % |
| Persona inventada/verbosa | Compuerta sobre `persona` | ✅ 100 % |
| Varianza del modelo | Temperatura 0 en extracción | ◐ Reduce, no garantiza |
| Entidad basura ya creada (daño histórico) | `olvidarProyecto` (gobernanza) | ✅ Manual explícito |
