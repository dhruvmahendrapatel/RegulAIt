-- ADR-0180 addendum (2026-11-21, lane E51): an unmet autonomy floor blocks dispatch for a delegated or autonomous
-- builder agent. Hand-authored (never drizzle-kit generate). Re-runnable: every statement is idempotent.
--
-- - `autonomy_enforcement`: 'enforced' (the strict default, ADR-0180) or 'relaxed'. The default applies to every
--   existing agent as well: no grandfathering. Transitions are declared in AUTONOMY_ENFORCEMENT_MACHINE
--   (@regulait/shared) and taken only by PUT /v1/builder/agents/:id/autonomy/enforcement (admin, step-up to relax,
--   audited).
-- - `autonomy_relaxed_by` / `autonomy_relaxed_at`: who relaxed it and when; set exactly while relaxed.
-- - `autonomy_enforcement_reason`: the admin's reason for the latest change, prose-scrubbed (ADR-0102).
-- builder_agents has no row-level security today; these columns keep the table's posture. No functions, no triggers.

ALTER TABLE "builder_agents" ADD COLUMN IF NOT EXISTS "autonomy_enforcement" text DEFAULT 'enforced' NOT NULL;
--> statement-breakpoint
ALTER TABLE "builder_agents" ADD COLUMN IF NOT EXISTS "autonomy_relaxed_by" uuid REFERENCES "users"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "builder_agents" ADD COLUMN IF NOT EXISTS "autonomy_relaxed_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "builder_agents" ADD COLUMN IF NOT EXISTS "autonomy_enforcement_reason" text;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "builder_agents" ADD CONSTRAINT "builder_agents_autonomy_enforcement_ck"
    CHECK ("autonomy_enforcement" IN ('enforced', 'relaxed'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "builder_agents" ADD CONSTRAINT "builder_agents_autonomy_relaxed_ck"
    CHECK (("autonomy_enforcement" = 'relaxed') = ("autonomy_relaxed_at" IS NOT NULL)
      AND ("autonomy_enforcement_reason" IS NULL OR length("autonomy_enforcement_reason") <= 2000));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
