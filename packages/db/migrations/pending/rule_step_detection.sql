-- ADR-0327 (lane E12, slice 2): rule-like AI step detection. Hand-authored (never drizzle-kit generate).
-- Re-runnable: every statement is idempotent. No function and no trigger (nothing for the 0185 guard to check).
--   trace_spans_llm_step_started_idx  serves the scan: recent model spans grouped by (agent, span name).
--
--   rule_step_settings      one row, absent until an admin first saves it. Absent = OFF (ADR-0180): no scan runs.
--                           Thresholds default strict and are bounded below by the same floors as the kernel
--                           (`RULE_INDUCTION_FLOORS`), so a row written around the API cannot relax past them.
--   rule_step_suggestions   one row per AI step (agent + trace span name): the latest scan's rule (a point-in-time
--                           snapshot, ADR-0200 exception) with its evidence and projected monthly saving. Detection is
--                           read-only: nothing here changes routing.

CREATE TABLE IF NOT EXISTS "rule_step_settings" (
  "id" text PRIMARY KEY DEFAULT 'singleton' NOT NULL,
  "enabled" boolean DEFAULT false NOT NULL,
  "min_runs" integer DEFAULT 200 NOT NULL,
  "min_agreement" double precision DEFAULT 0.99 NOT NULL,
  "min_coverage" double precision DEFAULT 0.9 NOT NULL,
  "min_cell_support" integer DEFAULT 5 NOT NULL,
  "last_scan_at" timestamp with time zone,
  "updated_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "rule_step_settings_singleton_check" CHECK ("id" = 'singleton'),
  CONSTRAINT "rule_step_settings_min_runs_check" CHECK ("min_runs" BETWEEN 50 AND 100000),
  CONSTRAINT "rule_step_settings_min_agreement_check" CHECK ("min_agreement" >= 0.95 AND "min_agreement" <= 1),
  CONSTRAINT "rule_step_settings_min_coverage_check" CHECK ("min_coverage" >= 0.5 AND "min_coverage" <= 1),
  CONSTRAINT "rule_step_settings_min_cell_support_check" CHECK ("min_cell_support" BETWEEN 3 AND 1000)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "rule_step_suggestions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "agent_id" uuid NOT NULL REFERENCES "agents"("id") ON DELETE CASCADE,
  "step_name" text NOT NULL,
  "rule" jsonb NOT NULL,
  "runs" integer NOT NULL,
  "structured_runs" integer NOT NULL,
  "output_classes" integer NOT NULL,
  "agreement" double precision NOT NULL,
  "coverage" double precision NOT NULL,
  "window_cost_usd" double precision NOT NULL,
  "projected_monthly_savings_usd" double precision NOT NULL,
  "status" text DEFAULT 'suggested' NOT NULL,
  "detected_at" timestamp with time zone DEFAULT now() NOT NULL,
  "dismissed_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "dismissed_at" timestamp with time zone,
  CONSTRAINT "rule_step_suggestions_status_check" CHECK ("status" IN ('suggested', 'dismissed')),
  CONSTRAINT "rule_step_suggestions_rates_check" CHECK ("agreement" BETWEEN 0 AND 1 AND "coverage" BETWEEN 0 AND 1),
  CONSTRAINT "rule_step_suggestions_dismissed_check" CHECK (("status" = 'dismissed') = ("dismissed_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "rule_step_suggestions_step_uq" ON "rule_step_suggestions" ("agent_id", "step_name");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rule_step_suggestions_status_savings_idx" ON "rule_step_suggestions" ("status", "projected_monthly_savings_usd");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "trace_spans_llm_step_started_idx" ON "trace_spans" ("agent_id", "name", "started_at") WHERE "kind" = 'llm' AND "agent_id" IS NOT NULL;
