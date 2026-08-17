# Mi seguimiento — diseño del release (grill 2026-08-15)

Modal personal del líder (menú **🎯 Mi seguimiento**, slot `cosMenu5`) sobre la **hoja Tareas
como única fuente de verdad**. Maqueta aprobada: `Docs/html/mi-seguimiento-mockups.html`
(Idea A completa). Este doc fija las decisiones del grill y el faseo.

## Faseo

| Fase | Contenido | Estado |
|---|---|---|
| **R1** | Modal Hoy/Tareas/Tablero + creación híbrida + mutadores + Nivel 0 + separación del modal de equipo + higiene en dispatcher + foco manual | **Implementado** (`miseguimiento-runtime.js`, `DialogMiSeguimiento.html`) — CoSLib **v27** |
| **R2** | Tab Tendencia (línea carga abierta, creadas vs completadas, donut por origen, barras por proyecto, heatmap) **junto con** el índice `_tasks.json` (N2: se actualiza en sync diario + mutación + archivado; reconstrucción de emergencia desde las páginas; filtros y series 100 % en el cliente) | **Implementado** |
| **R3** | Columnas N1: `Espera de` (pill ⏳ con días del historial + follow-up mailto simple), `Link` (📎), `EventId` (ligadas exactas de la agenda desde la ingesta de Meet), con migración idempotente por encabezado (Tareas y Archivo) | **Implementado** |

## Decisiones del grill (con su porqué)

**R1:**
- Mutador **genérico** `actualizarTarea(id, campos)` + `crearTarea` + `archivarTarea` +
  `guardarFoco`, expuestos por `dispatch`. Fila desaparecida → **error claro y recarga**, jamás
  recrear (la hoja manda).
- Cada mutación **espeja `wiki/tasks` de inmediato** (best-effort): el historial fiel al minuto es
  la fuente del futuro tab Tendencia; el sync diario repara si Drive falló.
- **Higiene diaria (ensure + sync + archivado) movida del briefing al dispatcher**
  (`runTareasHygiene_`, guarda `tareas-hig` 1×/día): un líder sin briefing también archiva y
  espeja. `archivarHechas_` archiva TODAS las Hechas en esa pasada (no "a los 7 días").
- **Foco manual** en Ajustes (`briefing.focoManual`): editable desde el modal; si existe, el
  briefing lo usa y **no le pide foco al LLM** (borrarlo devuelve la sugerencia).
- **Agenda de hoy sin "ligadas"** en R1: el cruce tarea↔reunión por título miente a veces;
  llega exacto con `EventId` en R3. (Mismo criterio: sin deep-link 🎥 al acta por matching débil.)
- **Posponer** = popover Mañana / +7 días / Elegir fecha. **🗑 Archivar** = mueve ESA fila a
  Archivo con confirm, cualquiera sea su estado ("esto ya no aplica" sin mentir con Hecha).
- **Chips de proyecto de la creación** = catálogo canónico de `_projects.json` (misma fuente que
  el enum de ingesta); sin brain, degradación honesta a texto libre.
- **Tab Tendencia no existe en R1** (se estrena completo en R2; la data ya se acumula).
- **Separación del modal de equipo**: (i) la fila "Líder" salió de Pendientes por Persona;
  (ii) las viñetas de páginas de proyecto llevan autor `· por Nombre` (antes del sufijo de cierre
  ✓/✖ — ninguna regex existente cambia), solo hacia adelante; Actividad muestra el autor, filtra
  lo del líder por defecto y tiene el toggle "incluir mis eventos". Lo histórico sin autor es
  inatribuible y se muestra siempre. El autor de Meet pasa por `sanitizarPersona_` (compuerta).

**R2 (cuando se implemente):**
- `_tasks.json` = **índice crudo por tarea** (`created`, fecha de Hecha, `posp`, proyecto,
  prioridad, origen, estado, vence); las series se agregan al cargar. Se actualiza en el sync
  diario y en cada mutación.
- Los **filtros recalculan en el cliente** (el índice viaja entero una vez).
- El toggle "incluir archivadas" **se eliminó del diseño**: el histórico siempre usa todo el
  índice; los charts "de hoy" son solo abiertas. Heatmap: entra.
- Orígenes reales hoy: 🎥 Meet y ✍️ Manual (el Briefing NO crea tareas; ⚡ sería feature nueva).
- Sin data retroactiva anterior al espejo: las curvas nacen cortas y se pueblan solas.

**R3 (cuando se implemente):**
- Migración de columnas **idempotente por nombre de encabezado** (patrón guardarEquipo).
- `Espera de` guarda solo el **nombre**; los días salen de la línea `espera de:` del historial
  (editada a mano sin historial → pill sin días, degradación honesta).
- Follow-up desde tarea en espera = **borrador de correo simple** (sin tokens/compromisos); la
  integración con el flujo R2 del equipo merece su propio grill si el uso la pide.

## Post-release (2026-08-17): fecha real de creación + cache

- **Columna `Creada el`** (11ª, migración idempotente): la fecha REAL de la tarea. Al crear:
  Meet → sufijo del Origen (`'🎥 Título · YYYY-MM-DD'`, parseado con regex ANCLADA al final —
  determinista, 0 LLM; una fecha dentro del título en otro formato no matchea); manual → hoy.
  `edad`, el `created` del wiki y `_tasks.json` la usan; el sync se **autocura** (created del
  primer sync > fecha real → se corrige) y `repararWiki` hace el backfill completo (columna +
  páginas activas y archivadas, vía `fm.origin`). El equipo NO tenía este problema: sus viñetas
  llevan la fecha del reporte/reunión desde la ingesta.
- **CacheService** en `cargarSeguimiento` (claves `seg:7`/`seg:30`) y `cargarMiSeguimiento`
  (`miseg`): TTL 55 s (bajo el poll de 60 s), namespaced por sheetId, límite 95 KB, best-effort.
  Invalidación: resolverPendiente y gobernanza (merge/olvidar/reparar) → seg; mutadores del modal,
  `agregarTarea_` y archivado → miseg. Escrituras a mano en hoja/wiki se ven en ≤55 s (igual que
  el poll). Snapshot `_seguimiento.json` queda como palanca futura si el wiki crece mucho.

## Fuera de alcance (explícito)

- Mejora del match del nombre del líder en notas de Meet (contención/alias) — fase posterior.
- Página del líder en `wiki/people` — NUNCA (rompe silencios/correos/seguimiento).
- ⚡ Briefing como origen de tareas — feature nueva si se pide (foco→tarea o reply al correo).
