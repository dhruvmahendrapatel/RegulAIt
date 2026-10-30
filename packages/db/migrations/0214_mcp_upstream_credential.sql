-- ADR-0204: a static upstream credential per MCP server (freeze exception, owner 2026-10-29).
-- Hand-authored (never drizzle-kit generate). Re-runnable: every statement is idempotent.
--
-- 1. One optional row per MCP server. A server with NO row sends nothing upstream, which is the default (ADR-0180):
--    nothing is backfilled, so a fresh or upgraded database has no credential anywhere.
-- 2. Its own table, like `connector_credentials`, so no read of `mcp_servers` (the registry list, the admission
--    clear, the proxy's row) can ever carry the ciphertext. The secret is the data-key envelope (secrets.ts),
--    registered in CIPHERTEXT_COLUMNS for the custody probe and the re-encryption walk (which updates by `id`).
-- 3. Written only by `PUT`/`DELETE /v1/servers/:serverId/upstream-credential` (admin, settings_relax step-up) and by
--    a url move on `PATCH /v1/servers/:serverId` (which deletes it), each in the same transaction as its audit row.
-- 4. The CHECKs bound the shape and repeat the gateway's header refusals, so a row written around the API cannot name a
--    reserved header either. `secret_set_at` is stamped on the database clock by the 0142 trigger (already pinned).

CREATE TABLE IF NOT EXISTS "mcp_server_upstream_credentials" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "server_id" uuid NOT NULL REFERENCES "mcp_servers"("id") ON DELETE CASCADE,
  "scheme" text NOT NULL,
  "header_name" text NOT NULL,
  "secret_ciphertext" text NOT NULL,
  "secret_last4" text NOT NULL,
  "set_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "secret_set_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "mcp_server_upstream_credentials_server_uq" UNIQUE ("server_id"),
  CONSTRAINT "mcp_server_upstream_credentials_scheme_check" CHECK ("scheme" IN ('bearer', 'header')),
  CONSTRAINT "mcp_server_upstream_credentials_header_check" CHECK (
    "header_name" ~ '^[a-z0-9][a-z0-9-]{0,63}$'
    AND (("scheme" = 'bearer') = ("header_name" = 'authorization'))
    AND "header_name" NOT IN (
      'host', 'cookie', 'connection', 'keep-alive', 'proxy-connection', 'te', 'trailer', 'transfer-encoding',
      'upgrade', 'expect', 'accept', 'accept-encoding', 'forwarded', 'via', 'origin', 'referer',
      'mcp-session-id', 'mcp-protocol-version', 'last-event-id'
    )
    AND "header_name" NOT LIKE 'content-%'
    AND "header_name" NOT LIKE 'proxy-%'
    AND "header_name" NOT LIKE 'sec-%'
    AND "header_name" NOT LIKE 'x-forwarded-%'
    AND "header_name" NOT LIKE 'regulait-%'
    AND "header_name" NOT LIKE 'x-regulait-%'
  ),
  CONSTRAINT "mcp_server_upstream_credentials_last4_check" CHECK (char_length("secret_last4") = 4)
);
--> statement-breakpoint
DROP TRIGGER IF EXISTS "mcp_server_upstream_credentials_secret_set_trg" ON "mcp_server_upstream_credentials";
--> statement-breakpoint
CREATE TRIGGER "mcp_server_upstream_credentials_secret_set_trg" BEFORE INSERT OR UPDATE ON "mcp_server_upstream_credentials"
  FOR EACH ROW EXECUTE FUNCTION "regulait_stamp_secret_set"('secret_ciphertext', 'secret_set_at');
