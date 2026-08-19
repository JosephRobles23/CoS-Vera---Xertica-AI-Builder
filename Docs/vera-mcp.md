# Vera-MCP — server MCP multi-tenant

Conecta el CoS **Vera** a las cuentas **personales** de Claude/ChatGPT de ~50 CLEVEs
vía un **server MCP remoto multi-tenant**, para dar contexto del second brain y
**crear/editar tareas** desde el chat. Es un **proxy delgado**: la data vive en el
Drive de cada CLEVE a través de su GAS Web App (sin mirror central).

> Log de la sesión de diseño (preguntas + decisiones + rationale):
> [`decisions/2026-08-19-vera-mcp.md`](../decisions/2026-08-19-vera-mcp.md).

## Plataforma y framework

- **Cloudflare Workers, plan Free.** Monitorear el tope de **1k KV-writes/día**
  (`wrangler tail`); flip a Paid ($5) si aparecen fallos de login.
- **Sin dominio** → URL `*.workers.dev`. Se acepta el re-connect masivo si algún día
  se migra; la URL del Worker vive **detrás de config** en GAS por si acaso.
- **`createMcpHandler` + `@cloudflare/workers-oauth-provider`**, **stateless, sin
  Durable Objects**, en **TypeScript**. Lógica de tools detrás de **adapters**
  (storage + OAuth) para portabilidad futura a Cloud Run.
- Estado: **D1** (mapping tenant) + **KV** (estado OAuth del provider).

## Autenticación

- **Usuario:** OAuth 2.1 (DCR + PKCE, lo da el provider) con **pairing-code** como
  paso de identidad (sin Sign-in-with-Google). DCR hoy → **CIMD** como deuda futura
  (DCR se retira post-verano 2027).
- **Worker→GAS:** **secreto opaco por-tenant** en el **body JSON**, comparado por
  igualdad en `CoSLib.mcpAction`. Generado por GAS (UUID en Script Properties). El
  **`sheetId` nunca se transmite** (implícito en la `webAppUrl` del tenant) → evita
  el confused-deputy: el scope se deriva server-side del token, jamás del input del modelo.
- **Enrollment: challenge-response** — sin secreto compartido en los 50 stubs.
- **Tokens:** default del provider (access ~1h + refresh con rotación). Botón
  **"Desconectar"** en el sidebar → revoca tokens + rota el secreto.
- **Rate-limit:** pairing-code 8 chars, un-solo-uso, TTL 10 min, lockout por IP +
  regla básica de Cloudflare en `/authorize`.

## Flujo de conexión (end-to-end)

1. El CLEVE pulsa **"Conectar"** en el sidebar → GAS asegura el Web App (reusa el de
   Seguimiento R2 o lanza el **wizard guiado**), toma su secreto por-tenant y llama a
   `/enroll` del Worker con `{webAppUrl, secreto}`.
2. El Worker **verifica por challenge-response**: llama a la `webAppUrl` con un nonce;
   GAS responde `HMAC(nonce, secreto)`; el Worker valida con el secreto recibido →
   prueba que ese `/exec` realmente posee ese secreto (no puedes registrar la
   `webAppUrl` de una víctima). Crea registro pendiente y devuelve un **pairing-code**
   que el sidebar muestra.
3. El CLEVE pega la **URL del Worker** en el custom connector de Claude/ChatGPT →
   OAuth (DCR + PKCE) → redirige a `/authorize`.
4. En `/authorize` pega el **pairing-code** → el Worker vincula el grant al tenant y
   emite su propio token.
5. Cada tool-call lleva el token → el Worker resuelve `token→tenant` → POST a la
   `webAppUrl` con el secreto en el body → `mcpAction` valida y ejecuta.

## Tools v1

| Tool | Input | Output | Mapea a |
|---|---|---|---|
| `list_tasks` | filtros opc. (`estado`,`proyecto`,`prioridad`, rango `vence`) | array `{id,texto,proyecto,vence,prioridad,estado,espera,link}` | `listarTareas_` |
| `search_wiki` | `query`, `tipo?` | **snippets/páginas crudas** + refs (NO respuesta Gemini) | `telegramWikiPages_` |
| `get_catalog` | — | `{projects:[...], people:[...]}` | `telegramTaskCatalog_` |
| `create_task` | `{texto*, proyecto?, espera?, vence?, prioridad?, force?}` | `{id,created}` o `{duplicate,similar:[...]}` | `telegramCreateTask_` + `telegramSimilarTask_` + validación catálogo |
| `edit_task` | `{id*, campos:{...}}` | tarea actualizada | `actualizarTarea` |

- **HITL de escritura:** el cliente (que ES el LLM) produce args estructurados → no se
  usa el parseo Gemini de Telegram. El server valida catálogo + dedup determinista;
  ante duplicado devuelve `{duplicate, similar}` y exige `force:true`.
- **`edit_task`** usa el **`id` de la columna 7**, estable ante ediciones de texto
  (`actualizarTarea_` localiza por id→fila y nunca reescribe esa celda). `create_task`
  devuelve el `id` para poder editar de inmediato.

## Tools de Calendar (Fase B)

Escritura de Google Calendar vía `CalendarApp` (Web App corre "ejecutar como: yo" → sobre el
calendario del propio líder, **sin CASA**). Lógica en `shared/calendar-runtime.js`.

| Tool | Input | Nota |
|---|---|---|
| `create_calendar_event` | `{titulo*, inicio*, fin*, descripcion?, ubicacion?, invitados?[]}` | fechas ISO 8601 con offset |
| `edit_calendar_event` | `{id*, campos:{titulo?, inicio?, fin?, descripcion?, ubicacion?}}` | **solo si el líder es organizador** (`getCreators()` incluye su email) |

⚠️ **Requiere scope `https://www.googleapis.com/auth/calendar`** (reemplaza `calendar.readonly` en
`shared/appsscript.json` y el stub). Al cambiar scopes, **cada líder re-autoriza + re-despliega su
Web App**. Escritura = HITL (confirmación nativa del cliente).

## Tools de lectura + Deep Prep (Fase A)

Sin scope nuevo. Reusan `deepprep-runtime.js` y los helpers de hojas.

| Tool | Input | Reusa |
|---|---|---|
| `list_calendar` | `{dias?}` | `listarReunionesProximas` (con flag `seleccionado` de Deep Prep) |
| `set_meeting_prep` | `{eventId, on?}` | `toggleReunionPrep` (Ajustes → `deepPrep.selected`) |
| `set_deepprep_lead` | `{horas}` (1–168) | `setAjustes_` (`deepPrep.leadHours`) |
| `run_deep_prep` | `{eventId?}` | `probarDeepPrep` (genera + envía correo) |
| `read_reports` | `{tipo(daily/weekly), desde?, hasta?, persona?, limit?}` | `getSheet_`+`getHeaderMap_`+`extraerQA_` — respuestas crudas del Form + Summary |

`read_reports` complementa a `search_wiki`: da el feed **operativo crudo** (pregunta→respuesta por
persona/fecha), funciona **con o sin brain**, y expone lo que la wiki curada no guarda verbatim.

## Alcance

- **v1:** 5 tools base + Fase B (2 Calendar) + Fase A (5) = **12 tools**.
- **v1.1 fast-follows** (lógica ya existe → baratos): `get_briefing`, `list_blockers`,
  `meeting_prep` (Deep Prep), `team_status` (silencios/seguimiento). Convierten a Vera
  de "bot de tareas" en copiloto de Chief-of-Staff.

## Estructura, tests y deploy

- **Repo:** `services/vera-mcp/` en este mismo repo, self-contained (`package.json` +
  `wrangler.toml`). El `package.json` raíz es `private` y no es workspace → no hereda.
- **Onboarding:** reusar el Web App de Seguimiento R2 donde exista (mismo `/exec`, solo
  se agrega la rama `mcp` al `doPost`); **wizard del sidebar** (patrón `guia-onboarding`)
  para los que falten. El botón "Conectar" ya conoce su `urlWebApp_`.
- **Tests:** GAS `tests/mcp-runtime.test.mjs` (+ `gas-harness`); Worker vitest + MCP Inspector.
- **Deploy:**
  - Worker: `wrangler deploy`; bindings **D1** + **KV**; **master signing key** vía
    `wrangler secret put`. Con challenge-response **no hay enrollment secret** que guardar.
  - GAS: rama `mcp` nueva en `doPost` + `CoSLib.mcpAction`; desplegado por el flujo
    existente (`lib:push` → create-version → apuntar stubs). Secreto por-tenant en
    Script Properties; **URL del Worker** en config.

## Riesgos aceptados / deuda

- Re-connect de 50 usuarios si se migra de host (decisión de no comprar dominio).
- KV free 1k-writes/día a vigilar → mitigación = Workers Paid $5.
- DCR → CIMD post-2027.
- v2: WAF/rate-limit más fino, challenge-response ya incluido, posible dominio propio.
