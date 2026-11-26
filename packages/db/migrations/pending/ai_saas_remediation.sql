-- ADR-0361 slice 3 (lane E42): optional remediation of a monitored conversation through the vendor API (delete only:
-- no vendor documents a quarantine). Hand-authored (never drizzle-kit generate). Re-runnable: every statement is
-- idempotent. Builds on `pending/ai_saas_monitoring.sql` (slice 1), which is numbered before this one at merge.
--
-- - `ai_saas_monitor_policy.remediation_enabled`: a second switch, OFF (ADR-0180); on = a step-up, audited, refused
--   under air_gapped in code.
-- - `ai_saas_monitor_credentials.purpose`: `read` (every existing row) or `remediate`. A delete-capable key is a
--   separate credential (as both vendors recommend), so the read key stays read-only; one live credential per
--   connector and purpose.
-- - `ai_saas_remediations`: one row per requested action. Its lifecycle is the declared `AI_SAAS_REMEDIATION_MACHINE`
--   (@regulait/shared); every write is a conditional UPDATE on the states the machine allows. `conversation_ref` and
--   `actor_ref` are a point-in-time copy of the interaction's (ADR-0200 exception: the evidence row they came from may
--   be removed by retention while the action's record must still say what was deleted). One open action per
--   connector and conversation.
-- - Row-level security (ADR-0234): ENABLED and FORCED, admin, `system_task` and `migration` only.

ALTER TABLE "ai_saas_monitor_policy" ADD COLUMN IF NOT EXISTS "remediation_enabled" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "ai_saas_monitor_credentials" ADD COLUMN IF NOT EXISTS "purpose" text DEFAULT 'read' NOT NULL;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "ai_saas_monitor_credentials" ADD CONSTRAINT "ai_saas_monitor_credentials_purpose_check" CHECK ("purpose" IN ('read', 'remediate'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DROP INDEX IF EXISTS "ai_saas_monitor_credentials_live_uq";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ai_saas_monitor_credentials_live_purpose_uq"
  ON "ai_saas_monitor_credentials" ("connector_id", "purpose") WHERE "revoked_at" IS NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ai_saas_remediations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "connector_id" uuid NOT NULL REFERENCES "ai_saas_monitor_connectors"("id") ON DELETE RESTRICT,
  "interaction_id" uuid REFERENCES "ai_saas_interactions"("id") ON DELETE SET NULL,
  "action" text NOT NULL,
  "conversation_ref" text NOT NULL,
  "actor_ref" text,
  "status" text DEFAULT 'requested' NOT NULL,
  "approval_id" uuid REFERENCES "approvals"("id") ON DELETE SET NULL,
  "arguments_digest" text NOT NULL,
  "requested_by" uuid NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "request_reason" text NOT NULL,
  "lease_expires_at" timestamp with time zone,
  "outcome_code" text,
  "vendor_status" integer,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "finished_at" timestamp with time zone,
  CONSTRAINT "ai_saas_remediations_action_check" CHECK ("action" IN ('delete_conversation')),
  CONSTRAINT "ai_saas_remediations_status_check" CHECK ("status" IN (
    'requested', 'approved', 'executing', 'unknown', 'succeeded', 'failed', 'denied', 'cancelled')),
  CONSTRAINT "ai_saas_remediations_conversation_check" CHECK (char_length("conversation_ref") BETWEEN 1 AND 500),
  CONSTRAINT "ai_saas_remediations_actor_check" CHECK ("actor_ref" IS NULL OR char_length("actor_ref") BETWEEN 1 AND 100),
  CONSTRAINT "ai_saas_remediations_digest_check" CHECK ("arguments_digest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "ai_saas_remediations_reason_check" CHECK (char_length("request_reason") BETWEEN 3 AND 500),
  CONSTRAINT "ai_saas_remediations_outcome_check" CHECK ("outcome_code" IS NULL OR "outcome_code" ~ '^[a-z0-9_]{1,64}$'),
  CONSTRAINT "ai_saas_remediations_vendor_status_check" CHECK ("vendor_status" IS NULL OR "vendor_status" BETWEEN 100 AND 599),
  CONSTRAINT "ai_saas_remediations_lease_check" CHECK (("status" = 'executing') = ("lease_expires_at" IS NOT NULL)),
  CONSTRAINT "ai_saas_remediations_finished_check" CHECK (
    ("status" IN ('succeeded', 'failed', 'denied', 'cancelled')) = ("finished_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ai_saas_remediations_open_uq" ON "ai_saas_remediations" ("connector_id", "conversation_ref")
  WHERE "status" IN ('requested', 'approved', 'executing', 'unknown');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_saas_remediations_created_idx" ON "ai_saas_remediations" ("created_at" DESC, "id" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_saas_remediations_interaction_idx" ON "ai_saas_remediations" ("interaction_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_saas_remediations_approval_idx" ON "ai_saas_remediations" ("approval_id");
--> statement-breakpoint
ALTER TABLE "ai_saas_remediations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "ai_saas_remediations" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS ai_saas_remediations_all ON "ai_saas_remediations";
--> statement-breakpoint
CREATE POLICY ai_saas_remediations_all ON "ai_saas_remediations" FOR ALL
  USING ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration']))
  WITH CHECK ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration']));
