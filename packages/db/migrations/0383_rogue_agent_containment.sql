-- ADR-0366 (lane E52): rogue-agent containment (OWASP Agentic ASI10), slice 1.
-- Hand-authored (never drizzle-kit generate). Re-runnable: every statement is idempotent.
--
-- 1. `builder_agents` gets ADR-0124's halt columns (as `agents` has since migration 0114): a containment of a
--    builder agent halts that agent alone, never the registry model it shares with other builder agents.
-- 2. `org_settings` gets the containment policy: the automatic-containment threshold ('critical' by default,
--    ADR-0180; a lower severity contains more, 'off' is a relaxation) and the administrator proposals go to.
-- 3. `agent_containments`: one row per signal per agent. Row-level security (ADR-0234), ENABLED and FORCED: a row
--    names an agent, its steward's decision trail and the deciding administrators. Only an active admin principal
--    and the `system_task` (the monitor pass) and `migration` reasons read or write it.
-- No new functions or refusal triggers.

ALTER TABLE "builder_agents" ADD COLUMN IF NOT EXISTS "halted_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "builder_agents" ADD COLUMN IF NOT EXISTS "halted_reason" text;
--> statement-breakpoint
ALTER TABLE "builder_agents" ADD COLUMN IF NOT EXISTS "halted_by_user_id" uuid;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "builder_agents" ADD CONSTRAINT "builder_agents_halted_by_user_id_users_id_fk"
    FOREIGN KEY ("halted_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "builder_agents" ADD CONSTRAINT "builder_agents_halt_reason_ck" CHECK (
    ("halted_at" IS NULL AND "halted_reason" IS NULL)
    OR ("halted_at" IS NOT NULL AND "halted_reason" IS NOT NULL AND length(btrim("halted_reason")) > 0)
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "builder_agents_halted_idx" ON "builder_agents" ("id") WHERE "halted_at" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "org_settings" ADD COLUMN IF NOT EXISTS "containment_auto_severity" text DEFAULT 'critical' NOT NULL;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "org_settings" ADD CONSTRAINT "org_settings_containment_auto_severity_check"
    CHECK ("containment_auto_severity" IN ('off', 'low', 'medium', 'high', 'critical'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
ALTER TABLE "org_settings" ADD COLUMN IF NOT EXISTS "containment_approver_user_id" uuid;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "org_settings" ADD CONSTRAINT "org_settings_containment_approver_user_id_users_id_fk"
    FOREIGN KEY ("containment_approver_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_containments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "subject_kind" text NOT NULL,
  "agent_id" uuid,
  "builder_agent_id" uuid,
  "signal_source" text NOT NULL,
  "signal_rule_id" text NOT NULL,
  "signal_ref_id" text NOT NULL,
  "alert_id" uuid,
  "severity" text NOT NULL,
  "threshold_at_decision" text NOT NULL,
  "automatic" boolean NOT NULL,
  "status" text NOT NULL,
  "explanation" text NOT NULL,
  "evidence" jsonb NOT NULL,
  "approval_id" uuid,
  "halt_applied" boolean DEFAULT false NOT NULL,
  "contained_at" timestamp with time zone,
  "decided_by_user_id" uuid,
  "decided_at" timestamp with time zone,
  "release_requested_by_user_id" uuid,
  "release_requested_at" timestamp with time zone,
  "release_approval_id" uuid,
  "released_by_user_id" uuid,
  "released_at" timestamp with time zone,
  "release_reason" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "agent_containments_subject_kind_check" CHECK ("subject_kind" IN ('agent', 'builder_agent')),
  CONSTRAINT "agent_containments_subject_check" CHECK (
    ("subject_kind" = 'agent' AND "agent_id" IS NOT NULL AND "builder_agent_id" IS NULL)
    OR ("subject_kind" = 'builder_agent' AND "builder_agent_id" IS NOT NULL AND "agent_id" IS NULL)
  ),
  CONSTRAINT "agent_containments_signal_source_check" CHECK ("signal_source" IN ('monitor', 'behaviour_baseline')),
  CONSTRAINT "agent_containments_signal_rule_check" CHECK ("signal_rule_id" ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  CONSTRAINT "agent_containments_signal_ref_check" CHECK (length("signal_ref_id") BETWEEN 1 AND 128),
  CONSTRAINT "agent_containments_severity_check" CHECK ("severity" IN ('low', 'medium', 'high', 'critical')),
  CONSTRAINT "agent_containments_threshold_check" CHECK ("threshold_at_decision" IN ('off', 'low', 'medium', 'high', 'critical')),
  CONSTRAINT "agent_containments_status_check" CHECK ("status" IN ('proposed', 'contained', 'declined', 'release_pending', 'released')),
  CONSTRAINT "agent_containments_explanation_check" CHECK (length("explanation") BETWEEN 1 AND 1000),
  CONSTRAINT "agent_containments_evidence_check" CHECK (jsonb_typeof("evidence") = 'object' AND pg_column_size("evidence") <= 16384),
  -- written with = / OR, not IN: the status CHECK above is the one place the states are listed (ADR-0348 test)
  CONSTRAINT "agent_containments_contained_check" CHECK (
    ("status" = 'contained' OR "status" = 'release_pending' OR "status" = 'released') = ("contained_at" IS NOT NULL)
  ),
  -- owner decision 2026-11-21: a release is requested with a reason, then approved by another administrator
  CONSTRAINT "agent_containments_release_request_check" CHECK (
    ("status" = 'release_pending' OR "status" = 'released')
      = ("release_requested_at" IS NOT NULL AND "release_reason" IS NOT NULL AND length(btrim("release_reason")) >= 10)
  ),
  CONSTRAINT "agent_containments_released_check" CHECK (("status" = 'released') = ("released_at" IS NOT NULL)),
  CONSTRAINT "agent_containments_release_reason_check" CHECK ("release_reason" IS NULL OR length("release_reason") <= 2000),
  CONSTRAINT "agent_containments_automatic_check" CHECK (NOT "automatic" OR "approval_id" IS NULL)
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "agent_containments" ADD CONSTRAINT "agent_containments_agent_id_agents_id_fk"
    FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "agent_containments" ADD CONSTRAINT "agent_containments_builder_agent_id_builder_agents_id_fk"
    FOREIGN KEY ("builder_agent_id") REFERENCES "public"."builder_agents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "agent_containments" ADD CONSTRAINT "agent_containments_alert_id_governance_alerts_id_fk"
    FOREIGN KEY ("alert_id") REFERENCES "public"."governance_alerts"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "agent_containments" ADD CONSTRAINT "agent_containments_approval_id_approvals_id_fk"
    FOREIGN KEY ("approval_id") REFERENCES "public"."approvals"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "agent_containments" ADD CONSTRAINT "agent_containments_decided_by_user_id_users_id_fk"
    FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "agent_containments" ADD CONSTRAINT "agent_containments_release_requested_by_user_id_users_id_fk"
    FOREIGN KEY ("release_requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "agent_containments" ADD CONSTRAINT "agent_containments_release_approval_id_approvals_id_fk"
    FOREIGN KEY ("release_approval_id") REFERENCES "public"."approvals"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "agent_containments" ADD CONSTRAINT "agent_containments_released_by_user_id_users_id_fk"
    FOREIGN KEY ("released_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_containments_signal_uq" ON "agent_containments" ("signal_source", "signal_ref_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_containments_agent_idx" ON "agent_containments" ("agent_id", "status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_containments_builder_agent_idx" ON "agent_containments" ("builder_agent_id", "status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_containments_created_idx" ON "agent_containments" ("created_at", "id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_containments_release_approval_idx" ON "agent_containments" ("release_approval_id");
--> statement-breakpoint
ALTER TABLE "agent_containments" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "agent_containments" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "agent_containments_admin" ON "agent_containments";
--> statement-breakpoint
CREATE POLICY "agent_containments_admin" ON "agent_containments" FOR ALL
  USING ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration']))
  WITH CHECK ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration']));
