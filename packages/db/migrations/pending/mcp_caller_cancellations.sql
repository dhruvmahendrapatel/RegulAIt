-- ADR-0364 S3 (lane E45, owner D-2026-11-22-07): a caller's cancel reaches the call on EVERY gateway replica.
--
-- A client's `notifications/cancelled` arrives on a later, stateless HTTP request, often at another replica than the
-- one serving the call (a robot run's tools/call). The replica that receives it and does not serve the call itself
-- writes one row here; every replica with calls in flight watches the table and aborts a call whose key appears. A
-- robot run's heartbeat also confirms the watch, and a run whose cancel state cannot be confirmed is stopped (fail
-- closed).
--
--  - request_key: a scrypt hash (32 bytes, hex) of the caller's cancellation scope (user, server, credential) and the JSON-RPC request
--    id, so no raw credential id is stored and one caller can never name another's call.
--  - user_id: the caller, the one the scope names.
--  - No client-supplied text is stored (the client's free-text reason is not kept: nothing reads it).
--  - Rows are short-lived: a cancel applies to calls that started before it, and the watcher deletes rows older than
--    an hour.
-- Only the gateway's system task reads or writes the table.

CREATE TABLE IF NOT EXISTS "mcp_caller_cancellations" (
  "request_key" text PRIMARY KEY NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "mcp_caller_cancellations_key_check" CHECK ("request_key" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mcp_caller_cancellations_created_idx" ON "mcp_caller_cancellations" ("created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mcp_caller_cancellations_user_idx" ON "mcp_caller_cancellations" ("user_id");
--> statement-breakpoint
ALTER TABLE "mcp_caller_cancellations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "mcp_caller_cancellations" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS mcp_caller_cancellations_system ON "mcp_caller_cancellations";
--> statement-breakpoint
CREATE POLICY mcp_caller_cancellations_system ON "mcp_caller_cancellations" FOR ALL
  USING ((SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration']))
  WITH CHECK ((SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration']));
