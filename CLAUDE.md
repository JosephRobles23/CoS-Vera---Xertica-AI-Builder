# CoS-Agent

**Chief of Staff Agent** — automatizaciones de reportería Daily/Weekly per-líder sobre
**Google Apps Script + Forms + Sheets** con generación de texto vía **Gemini**.

La lógica común vive en una **librería compartida** (`shared/`, solo-lectura); cada líder
recibe una **plantilla** con un *stub* delgado que llama a esa librería. El código nuevo del
runtime va en `shared/*-runtime.js`; los diálogos son `shared/Dialog*.html` y `Sidebar.html`.

## Documentación

Todo vive en **`Docs/`**. Antes de tocar código, lee según necesites:
- `Docs/overview.md` — qué es y qué hay hoy.
- `Docs/architecture-and-contracts.md` — capas y contratos.
- `Docs/conventions.md` — patrón librería + stub y estructura.
- `Docs/engineering-playbook.md` — reglas para escribir el código.

## Convenciones clave

- La UI nueva llama al servidor por `cosRun`→`dispatch`, **nunca** como método nombrado de
  `google.script.run` (si no: `undefined reading 'apply'`). Ver el dispatcher en
  `shared/dispatcher-runtime.js`.
- Tests: `npm test` (usa `node --test tests/*.test.mjs`).
- Deploy de la librería: `npm run lib:push` / `lib:pull` (clasp).

## codegraph — inteligencia de código

Este repo está indexado con **CodeGraph** (`.codegraph/codegraph.db`, local — no se commitea).
Úsalo para navegar y entender el código **antes** de leer archivos a ciegas o hacer greps
amplios; da símbolos, fuente y rutas de llamada en un solo tiro.

**Regla práctica:** para "¿dónde está X?", "¿qué llama a X?", "¿qué rompo si cambio X?" o
"muéstrame cómo funciona X", empieza por codegraph, no por `grep`/`find`. Si **no** existe
el directorio `.codegraph/`, ignora CodeGraph: indexar es decisión del usuario.

### Herramientas MCP (preferidas cuando estén disponibles)

El server MCP de codegraph está instalado (`.mcp.json`); tras reiniciar el agente tendrás
las tools `mcp__codegraph__*`. Úsalas antes que el CLI cuando existan:

- **`codegraph_explore`** — responde la mayoría de preguntas en una sola llamada: la fuente
  literal de los símbolos relevantes + las rutas de llamada entre ellos, incluidos saltos de
  dynamic-dispatch que grep no sigue. Nombra un archivo o símbolo en la consulta para leer su
  fuente actual con nº de línea.
- **`codegraph_node`** — un símbolo con su fuente + trail de callers/callees, o un archivo con
  líneas numeradas y sus dependientes.

El CLI de abajo produce la misma salida y **siempre** funciona (útil en scripts o sin MCP).

### Comandos que usarás más

```bash
codegraph status                 # estado del índice (files/nodes/edges)
codegraph sync                   # sincroniza cambios desde el último index (rápido)
codegraph query <texto>          # busca símbolos por nombre (-k function, -l 20, -j)
codegraph explore <consulta...>  # área relevante: fuente + rutas de llamada de varios símbolos
codegraph node <símbolo>         # un símbolo: su fuente + cadena de callers/callees
codegraph node -f <archivo>      # lee un archivo con nº de línea + sus dependientes
codegraph callers <símbolo>      # quién llama a este símbolo
codegraph callees <símbolo>      # a quién llama este símbolo
codegraph impact <símbolo>       # qué se ve afectado si cambias el símbolo (-d profundidad)
codegraph affected <archivos...> # qué tests toca un cambio de archivos fuente
```

### Flujo recomendado

1. **Sincroniza primero si editaste código:** `codegraph sync` (barato; el índice puede
   quedar viejo tras tus ediciones).
2. **Localiza:** `codegraph query <nombre>` o `codegraph explore "<qué quieres entender>"`.
3. **Profundiza:** `codegraph node <símbolo>` para ver la fuente y su trail de llamadas.
4. **Antes de refactorizar:** `codegraph impact <símbolo>` y `codegraph callers <símbolo>`
   para no romper llamadores; luego `codegraph affected <archivos>` para saber qué tests correr.

Añade `-j` para salida JSON cuando quieras parsear el resultado.

> Si el índice se corrompe o queda desalineado: `codegraph index` reconstruye desde cero.
> Si un lock quedó atascado bloqueando el indexado: `codegraph unlock`.
