-- schema.sql — D1 de Vera-MCP.  Aplicar con: npm run db:init
--
-- Modelo: cada tenant (un CLEVE) = un GAS Web App (/exec) + su secreto por-tenant.
-- El `sheetId` NO se guarda ni viaja: es implícito en la webAppUrl → aislamiento.

-- Tenants ya emparejados. El OAuth token del provider lleva props.tenantId; los tools
-- resuelven {web_app_url, secret} por ese id (nunca desde input del modelo).
CREATE TABLE IF NOT EXISTS tenants (
  id           TEXT PRIMARY KEY,          -- uuid del tenant (va en props del token)
  web_app_url  TEXT NOT NULL,             -- /exec del líder
  secret       TEXT NOT NULL,             -- secreto por-tenant (Worker↔GAS)
  created_at   INTEGER NOT NULL           -- epoch ms
);

-- Pairings pendientes: creados por /enroll (tras el challenge-response), consumidos en
-- /authorize. Un solo uso + TTL corto (Q12).
CREATE TABLE IF NOT EXISTS pairings (
  code         TEXT PRIMARY KEY,          -- código que el CLEVE pega en /authorize
  web_app_url  TEXT NOT NULL,
  secret       TEXT NOT NULL,
  expires_at   INTEGER NOT NULL           -- epoch ms; purgar/rechazar si < now
);

CREATE INDEX IF NOT EXISTS idx_pairings_expires ON pairings(expires_at);
