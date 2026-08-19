/**
 * index.ts — Entry del Worker. Compone el OAuthProvider (que maneja /authorize, /token,
 * /register y protege /mcp) con el handler MCP stateless (createMcpHandler).
 *
 * Flujo: cliente MCP → OAuth (DCR+PKCE) → /authorize (pairing-code, ver auth.ts) → token con
 * props.tenantId → llamadas a /mcp → tools.ts resuelve el tenant y proxea al GAS del líder.
 *
 * ⚠️ La forma de `apiHandler` que espera OAuthProvider puede requerir ajuste menor según la
 *    versión de la librería (objeto con fetch vs. handler callable). Confirmar al primer
 *    `npm run typecheck` / `wrangler dev`. Ver README.md §Confirmar.
 */
import { OAuthProvider } from '@cloudflare/workers-oauth-provider';
import { createMcpHandler } from 'agents/mcp/server';
import type { Env } from './env';
import { buildServer } from './tools';
import authHandler from './auth';

export default new OAuthProvider({
  apiRoute: '/mcp',
  // El factory recibe el env por closure; createMcpHandler crea un McpServer fresco por request.
  apiHandler: {
    fetch: (request: Request, env: Env, ctx: ExecutionContext) =>
      createMcpHandler(() => buildServer(env))(request, env, ctx)
  },
  defaultHandler: authHandler,
  authorizeEndpoint: '/authorize',
  tokenEndpoint: '/token',
  clientRegistrationEndpoint: '/register'
});
