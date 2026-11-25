-- ADR-0310 addendum (lane E1): endpoint decision audit and tamper reporting.
--
-- The endpoint agent uploads signed, replay-protected batches of its hook decisions (ADR-0298, ADR-0330, ADR-0350).
-- Every decision becomes a hash-chained audit_log row, which is the source of truth. These tables are what the batch
-- route needs beside it:
--   - endpoint_decision_batches: one row per accepted batch, so a resent batch is a duplicate, never a second copy.
--   - endpoint_decision_events: one row per accepted event id, so an event resent in another batch is never audited twice.
--   - endpoint_coding_sessions: one coding-agent session on one device user. Its counters are a measured read model
--     whose source of truth is audit_log (rule ids endpoint-hook-*), kept so the session view needs no audit scan.
--   - endpoint_coding_session_modes: each permission mode a session reported (a session can change mode), so a
--     permission-bypass session is a row here, not a flag copied onto the session.
--   - endpoint_managed_file_observations: each distinct state of a managed settings or hook file a device user
--     reported. More than one row for the same file is a change on the device (tamper reporting).
--
-- The vendor session id never reaches the gateway: the agent sends a device-keyed hash of it (session_ref). A vendor
-- that gives no session id has one NULL-ref session per device user and agent (NULLS NOT DISTINCT).
--
-- Hand-authored, additive and idempotent. One guard function (search_path pinned) keeps the two ledgers write-once.
CREATE TABLE IF NOT EXISTS "endpoint_decision_batches" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "identity_id" uuid NOT NULL REFERENCES "endpoint_agent_identities"("identity_id") ON DELETE CASCADE,
  "batch_id" uuid NOT NULL,
  "body_sha256" text NOT NULL,
  "events_received" integer NOT NULL,
  "events_refused" integer NOT NULL,
  "dropped_events" integer NOT NULL,
  "received_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "endpoint_decision_batches_uq" UNIQUE ("identity_id", "batch_id"),
  CONSTRAINT "endpoint_decision_batches_sha_check" CHECK ("body_sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "endpoint_decision_batches_counts_check" CHECK ("events_received" >= 0 AND "events_refused" >= 0 AND "events_refused" <= "events_received" AND "dropped_events" >= 0)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "endpoint_decision_batches_received_idx" ON "endpoint_decision_batches" ("received_at");
--> statement-breakpoint
-- one row per accepted event id (#1044 review): a resent event under a new batch id is a duplicate, never audited twice
CREATE TABLE IF NOT EXISTS "endpoint_decision_events" (
  "identity_id" uuid NOT NULL REFERENCES "endpoint_agent_identities"("identity_id") ON DELETE CASCADE,
  "event_id" uuid NOT NULL,
  "batch_id" uuid NOT NULL REFERENCES "endpoint_decision_batches"("id") ON DELETE CASCADE,
  CONSTRAINT "endpoint_decision_events_pkey" PRIMARY KEY ("identity_id", "event_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "endpoint_decision_events_batch_idx" ON "endpoint_decision_events" ("batch_id");
--> statement-breakpoint
-- the batch and event ledgers are evidence of what was received: written once, never updated, and deleted only as the
-- cascade of their own identity (0207's pattern for endpoint_agent_reports); TRUNCATE is refused (0185's rule)
CREATE OR REPLACE FUNCTION "regulait_endpoint_decision_ledger_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1
     AND NOT EXISTS (SELECT 1 FROM public."endpoint_agent_identities" WHERE "identity_id" = OLD."identity_id") THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '%: a received decision batch or event is written once; it goes only with its identity', TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "endpoint_decision_batches_guard" ON "endpoint_decision_batches";
--> statement-breakpoint
CREATE TRIGGER "endpoint_decision_batches_guard" BEFORE UPDATE OR DELETE ON "endpoint_decision_batches"
  FOR EACH ROW EXECUTE FUNCTION "regulait_endpoint_decision_ledger_guard"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "endpoint_decision_batches_no_truncate" ON public."endpoint_decision_batches";
--> statement-breakpoint
CREATE TRIGGER "endpoint_decision_batches_no_truncate" BEFORE TRUNCATE ON public."endpoint_decision_batches"
  FOR EACH STATEMENT EXECUTE FUNCTION public.regulait_refuse_truncate();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "endpoint_decision_events_guard" ON "endpoint_decision_events";
--> statement-breakpoint
CREATE TRIGGER "endpoint_decision_events_guard" BEFORE UPDATE OR DELETE ON "endpoint_decision_events"
  FOR EACH ROW EXECUTE FUNCTION "regulait_endpoint_decision_ledger_guard"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "endpoint_decision_events_no_truncate" ON public."endpoint_decision_events";
--> statement-breakpoint
CREATE TRIGGER "endpoint_decision_events_no_truncate" BEFORE TRUNCATE ON public."endpoint_decision_events"
  FOR EACH STATEMENT EXECUTE FUNCTION public.regulait_refuse_truncate();
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "endpoint_coding_sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "identity_id" uuid NOT NULL REFERENCES "endpoint_agent_identities"("identity_id") ON DELETE CASCADE,
  "agent" text NOT NULL,
  "session_ref" text,
  "first_seen_at" timestamp with time zone NOT NULL,
  "last_seen_at" timestamp with time zone NOT NULL,
  -- read model over audit_log (endpoint-hook-* rows of this session); see the header
  "decisions" integer DEFAULT 0 NOT NULL,
  "denies" integer DEFAULT 0 NOT NULL,
  "asks" integer DEFAULT 0 NOT NULL,
  "would_denies" integer DEFAULT 0 NOT NULL,
  "would_asks" integer DEFAULT 0 NOT NULL,
  CONSTRAINT "endpoint_coding_sessions_uq" UNIQUE NULLS NOT DISTINCT ("identity_id", "agent", "session_ref"),
  CONSTRAINT "endpoint_coding_sessions_agent_check" CHECK ("agent" IN ('claude-code', 'cursor', 'copilot-cli', 'codex')),
  CONSTRAINT "endpoint_coding_sessions_ref_check" CHECK ("session_ref" IS NULL OR "session_ref" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "endpoint_coding_sessions_seen_check" CHECK ("last_seen_at" >= "first_seen_at"),
  CONSTRAINT "endpoint_coding_sessions_counts_check" CHECK ("decisions" >= 0 AND "denies" >= 0 AND "asks" >= 0 AND "would_denies" >= 0 AND "would_asks" >= 0)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "endpoint_coding_sessions_seen_idx" ON "endpoint_coding_sessions" ("last_seen_at", "id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "endpoint_coding_session_modes" (
  "session_id" uuid NOT NULL REFERENCES "endpoint_coding_sessions"("id") ON DELETE CASCADE,
  "permission_mode" text NOT NULL,
  "first_seen_at" timestamp with time zone NOT NULL,
  "last_seen_at" timestamp with time zone NOT NULL,
  CONSTRAINT "endpoint_coding_session_modes_pkey" PRIMARY KEY ("session_id", "permission_mode"),
  CONSTRAINT "endpoint_coding_session_modes_mode_check" CHECK ("permission_mode" ~ '^[A-Za-z][A-Za-z0-9_-]{0,31}$'),
  CONSTRAINT "endpoint_coding_session_modes_seen_check" CHECK ("last_seen_at" >= "first_seen_at")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "endpoint_coding_session_modes_mode_idx" ON "endpoint_coding_session_modes" ("permission_mode", "session_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "endpoint_managed_file_observations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "identity_id" uuid NOT NULL REFERENCES "endpoint_agent_identities"("identity_id") ON DELETE CASCADE,
  "file" text NOT NULL,
  "state" text NOT NULL,
  "sha256" text,
  "hook_status" text,
  "first_seen_at" timestamp with time zone NOT NULL,
  "last_seen_at" timestamp with time zone NOT NULL,
  CONSTRAINT "endpoint_managed_file_observations_uq" UNIQUE NULLS NOT DISTINCT ("identity_id", "file", "state", "sha256", "hook_status"),
  CONSTRAINT "endpoint_managed_file_observations_file_check" CHECK ("file" IN ('claude-code/managed-settings.json', 'cursor/hooks.json', 'copilot-cli/policy.json', 'openai-codex/requirements.toml')),
  CONSTRAINT "endpoint_managed_file_observations_state_check" CHECK ("state" IN ('present', 'missing', 'unreadable', 'not_system_owned')),
  CONSTRAINT "endpoint_managed_file_observations_sha_check" CHECK (("state" = 'present') = ("sha256" IS NOT NULL) AND ("sha256" IS NULL OR "sha256" ~ '^[0-9a-f]{64}$')),
  CONSTRAINT "endpoint_managed_file_observations_hook_check" CHECK ("hook_status" IS NULL OR "hook_status" IN ('registered', 'weakened', 'absent', 'unparseable')),
  CONSTRAINT "endpoint_managed_file_observations_seen_check" CHECK ("last_seen_at" >= "first_seen_at")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "endpoint_managed_file_observations_seen_idx" ON "endpoint_managed_file_observations" ("identity_id", "file", "last_seen_at");
--> statement-breakpoint
-- Row-level security (ADR-0234). The agent's batch route runs under `credential_request` (a non-user credential,
-- app.ts) and is the only writer; the session and tamper views are admin-only. The route's own predicate binds every
-- write to the caller's identity; RLS keeps any other principal out.
ALTER TABLE "endpoint_decision_batches" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "endpoint_decision_batches" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS endpoint_decision_batches_all ON "endpoint_decision_batches";
--> statement-breakpoint
CREATE POLICY endpoint_decision_batches_all ON "endpoint_decision_batches" FOR ALL
  USING ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['credential_request', 'migration']))
  WITH CHECK ((SELECT regulait_rls_system_reason()) = ANY (ARRAY['credential_request', 'migration']));
--> statement-breakpoint
ALTER TABLE "endpoint_decision_events" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "endpoint_decision_events" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS endpoint_decision_events_all ON "endpoint_decision_events";
--> statement-breakpoint
CREATE POLICY endpoint_decision_events_all ON "endpoint_decision_events" FOR ALL
  USING ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['credential_request', 'migration']))
  WITH CHECK ((SELECT regulait_rls_system_reason()) = ANY (ARRAY['credential_request', 'migration']));
--> statement-breakpoint
ALTER TABLE "endpoint_coding_sessions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "endpoint_coding_sessions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS endpoint_coding_sessions_all ON "endpoint_coding_sessions";
--> statement-breakpoint
CREATE POLICY endpoint_coding_sessions_all ON "endpoint_coding_sessions" FOR ALL
  USING ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['credential_request', 'migration']))
  WITH CHECK ((SELECT regulait_rls_system_reason()) = ANY (ARRAY['credential_request', 'migration']));
--> statement-breakpoint
ALTER TABLE "endpoint_coding_session_modes" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "endpoint_coding_session_modes" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS endpoint_coding_session_modes_all ON "endpoint_coding_session_modes";
--> statement-breakpoint
CREATE POLICY endpoint_coding_session_modes_all ON "endpoint_coding_session_modes" FOR ALL
  USING ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['credential_request', 'migration']))
  WITH CHECK ((SELECT regulait_rls_system_reason()) = ANY (ARRAY['credential_request', 'migration']));
--> statement-breakpoint
ALTER TABLE "endpoint_managed_file_observations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "endpoint_managed_file_observations" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS endpoint_managed_file_observations_all ON "endpoint_managed_file_observations";
--> statement-breakpoint
CREATE POLICY endpoint_managed_file_observations_all ON "endpoint_managed_file_observations" FOR ALL
  USING ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['credential_request', 'migration']))
  WITH CHECK ((SELECT regulait_rls_system_reason()) = ANY (ARRAY['credential_request', 'migration']));
