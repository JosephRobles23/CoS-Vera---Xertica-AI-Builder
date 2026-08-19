/** Bindings del Worker (ver wrangler.toml). */
import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider';

export interface Env {
  DB: D1Database;
  OAUTH_KV: KVNamespace;
  /** Inyectado por @cloudflare/workers-oauth-provider en el env del defaultHandler. */
  OAUTH_PROVIDER: OAuthHelpers;
}
