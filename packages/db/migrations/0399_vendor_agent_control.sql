-- Pending migration vendor_agent_control (numbered at merge, ADR-0252). ADR-0338 slice 1: governed control of an agent
-- inside its vendor platform (disable, quarantine, or the restore of an earlier action) through the vendor admin API.
-- Hand-authored (never drizzle-kit generate). Re-runnable: every statement is idempotent.
--
-- 1. `discovery_settings.vendor_agent_control_enabled`: the org switch, default false (ADR-0180 first-load posture).
--    Turning it on is a `settings_relax` step-up, audited; turning it off is free. While it is off no action is
--    requested or executed.
-- 2. `discovery_settings.vendor_agent_control_approval_ttl_hours`: how long a control action's approval stays open,
--    24 by default, 1 to 72. Shortening it is free; lengthening it past 24 is a `settings_relax` step-up, audited.
-- 3. `vendor_agent_actions`: one admin-requested action on one discovered vendor agent. Its `status` is ADR-0348's
--    `vendor_agent_action` machine (`VENDOR_ACTION_MACHINE`); the one CHECK listing the states is
--    `vendor_agent_actions_status_check`. A restore is a new row naming the action it reverses, so terminal rows stay
--    terminal. Source, registry and vendor id are the snapshot the approval's arguments digest is computed over (a
--    commented 3NF exception); execute re-reads the record and refuses if they moved.
-- 4. Row-level security, ENABLEd and FORCEd: an admin principal, or the `system_task` / `migration` reason.
--
-- No step-up kind is added: requesting, executing and settling use `settings_relax`, and deciding uses
-- `approval_decide`, each bound to the action's facts. No function or trigger, so the 0185 guards have nothing new to
-- check; the 0272 default privileges give `regulait_app` its grants.

ALTER TABLE "discovery_settings" ADD COLUMN IF NOT EXISTS "vendor_agent_control_enabled" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "discovery_settings" ADD COLUMN IF NOT EXISTS "vendor_agent_control_approval_ttl_hours" integer DEFAULT 24 NOT NULL;
--> statement-breakpoint
ALTER TABLE "discovery_settings" DROP CONSTRAINT IF EXISTS "discovery_settings_vendor_control_ttl_check";
--> statement-breakpoint
ALTER TABLE "discovery_settings" ADD CONSTRAINT "discovery_settings_vendor_control_ttl_check"
  CHECK ("vendor_agent_control_approval_ttl_hours" BETWEEN 1 AND 72);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "vendor_agent_actions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "record_id" uuid NOT NULL REFERENCES "agent_registry_records"("id") ON DELETE RESTRICT,
  -- 3NF exception: the snapshot the approval's arguments digest binds (execute re-reads the record)
  "source_id" uuid NOT NULL,
  "registry" text NOT NULL,
  "external_id" text NOT NULL,
  "action" text NOT NULL,
  "direction" text NOT NULL,
  "reverses_action_id" uuid REFERENCES "vendor_agent_actions"("id") ON DELETE RESTRICT,
  "reason" text NOT NULL,
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "approval_id" uuid NOT NULL REFERENCES "approvals"("id") ON DELETE RESTRICT,
  "status" text DEFAULT 'requested' NOT NULL,
  "lease_expires_at" timestamp with time zone,
  "prior_state" text,
  "observed_state" text,
  "outcome_code" text,
  "http_status" integer,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "settled_at" timestamp with time zone,
  CONSTRAINT "vendor_agent_actions_approval_uq" UNIQUE ("approval_id"),
  CONSTRAINT "vendor_agent_actions_status_check" CHECK (
    "status" IN ('requested', 'approved', 'executing', 'unknown', 'succeeded', 'already_in_state', 'failed', 'denied', 'cancelled')
  ),
  CONSTRAINT "vendor_agent_actions_action_check" CHECK ("action" IN ('disable', 'quarantine')),
  CONSTRAINT "vendor_agent_actions_direction_check" CHECK (("direction" = 'reverse') = ("reverses_action_id" IS NOT NULL)),
  CONSTRAINT "vendor_agent_actions_registry_check" CHECK (char_length("registry") BETWEEN 1 AND 64),
  CONSTRAINT "vendor_agent_actions_external_id_check" CHECK (char_length("external_id") BETWEEN 1 AND 2048),
  CONSTRAINT "vendor_agent_actions_reason_check" CHECK (char_length("reason") BETWEEN 1 AND 500),
  CONSTRAINT "vendor_agent_actions_state_check" CHECK (
    ("prior_state" IS NULL OR "prior_state" IN ('active', 'disabled', 'quarantined', 'unknown'))
    AND ("observed_state" IS NULL OR "observed_state" IN ('active', 'disabled', 'quarantined', 'unknown'))
  ),
  CONSTRAINT "vendor_agent_actions_outcome_check" CHECK ("outcome_code" IS NULL OR "outcome_code" ~ '^[a-z][a-z0-9_]{0,63}$'),
  CONSTRAINT "vendor_agent_actions_http_check" CHECK ("http_status" IS NULL OR "http_status" BETWEEN 100 AND 599),
  CONSTRAINT "vendor_agent_actions_lease_check" CHECK ("status" <> 'executing' OR "lease_expires_at" IS NOT NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "vendor_agent_actions_open_uq" ON "vendor_agent_actions" ("record_id")
  WHERE "status" IN ('requested', 'approved', 'executing', 'unknown');
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "vendor_agent_actions_reverse_uq" ON "vendor_agent_actions" ("reverses_action_id")
  WHERE "reverses_action_id" IS NOT NULL AND "status" NOT IN ('cancelled', 'denied', 'failed');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vendor_agent_actions_created_idx" ON "vendor_agent_actions" ("created_at", "id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vendor_agent_actions_record_idx" ON "vendor_agent_actions" ("record_id", "created_at");
--> statement-breakpoint
ALTER TABLE "vendor_agent_actions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "vendor_agent_actions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "vendor_agent_actions_admin" ON "vendor_agent_actions";
--> statement-breakpoint
CREATE POLICY "vendor_agent_actions_admin" ON "vendor_agent_actions" FOR ALL
  USING ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration']))
  WITH CHECK ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration']));
