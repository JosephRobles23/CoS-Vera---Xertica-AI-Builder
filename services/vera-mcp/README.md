# Vera-MCP Worker

Server MCP remoto **multi-tenant** que conecta el CoS *Vera* a Claude/ChatGPT. Es un **proxy
delgado**: resuelve `token→tenant` y reenvía cada tool-call al **GAS Web App del líder**
(`CoSLib.mcpAction`, en `shared/mcp-runtime.js`). La data vive en el Drive de cada CLEVE.

Diseño y decisiones: [`../../Docs/vera-mcp.md`](../../Docs/vera-mcp.md) ·
[`../../decisions/2026-08-19-vera-mcp.md`](../../decisions/2026-08-19-vera-mcp.md).

## Arquitectura

```
Claude/ChatGPT ──OAuth(DCR+PKCE)──▶ /authorize (pairing-code)
      │                                   │  props.tenantId → token
      └────── tool call /mcp ────────────▶ tools.ts → gasClient ──POST ?mcp=1──▶ GAS /exec (mcpAction)
                                                     (tenantId → D1 {webAppUrl, secret})
```

- `src/index.ts` — `OAuthProvider` + `createMcpHandler`.
- `src/tools.ts` — los 5 tools (`list_tasks`, `search_wiki`, `get_catalog`, `create_task`, `edit_task`).
- `src/gasClient.ts` — puente al backend GAS (**calza exacto con `mcpAction`**).
- `src/auth.ts` — `/enroll` (challenge-response) + `/authorize` (pairing-code).
- `src/storage.ts` — D1 (tenants + pairings). `schema.sql` define las tablas.
- `src/crypto.ts` — HMAC (debe casar con `Utilities.computeHmacSha256Signature` de GAS).

## Setup

```bash
cd services/vera-mcp
npm install
wrangler login

# Crear recursos y pegar los ids en wrangler.toml:
wrangler d1 create vera-mcp                 # → database_id
wrangler kv namespace create OAUTH_KV       # → id
npm run db:init                             # aplica schema.sql

npm run typecheck
wrangler dev            # local
npm run deploy          # → https://vera-mcp.<subdominio>.workers.dev/mcp
```

En el cliente: agregar un **custom connector** con la URL `.../mcp`; el pairing-code se genera
desde el sidebar del CoS (botón *Conectar*, incremento GAS pendiente que llama a `/enroll`).

## Enrollment (challenge-response)

1. Sidebar (GAS) → `POST /enroll {webAppUrl, secret}` (el secreto nunca toca el browser).
2. Worker → `POST <webAppUrl>?mcp=1 {op:'challenge', nonce}`; GAS responde `HMAC(nonce, secret)`.
3. Worker verifica con el secreto recibido → si cuadra, crea pairing-code (TTL 10 min) y lo devuelve.
4. El CLEVE pega el code en `/authorize` → se crea el tenant y el token lleva `props.tenantId`.

## Estado

✅ `npm install` y `npm run typecheck` **pasan** (verificado 2026-08-19) contra las versiones
reales: `@cloudflare/workers-oauth-provider@0.10.x`, `agents@0.21.x`,
`@modelcontextprotocol/server@2.x`, `zod@4.x`, `wrangler@4.x`, `workers-types@5.x`, `typescript@7.x`.
El wiring OAuth (`env.OAUTH_PROVIDER.parseAuthRequest`/`completeAuthorization`, `apiHandler:{fetch}`)
está tipado contra la librería real, no contra interfaces propias.

### Único punto a validar en runtime (con `wrangler dev`)

- El puente **props del token ↔ `getMcpAuthContext()`**: que `props.tenantId` seteado en
  `completeAuthorization` llegue a `getMcpAuthContext()` dentro de los tools. Es la integración
  documentada OAuthProvider→createMcpHandler; confírmala haciendo un tool-call real tras emparejar.

## Deferido

- Sidebar GAS *Conectar/Desconectar* (`iniciarConexionMcp` → `/enroll`; `desconectarMcp`).
- `config.mcp.workerUrl` en el stub. Onboarding wizard. v1.1 tools (get_briefing, etc.).
