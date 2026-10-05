-- ADR-0173 batch 2c (K) — monitoring KRIs, dashboards, automation rules,
-- their match log, and retention holds on traces.
--
-- kris                    key risk indicators over traces (the metric registry
--                         ADR-0175 A2 reuses); the governance monitor raises
--                         `kri_threshold_breached` episodes from them.
-- monitoring_dashboards   saved dashboards, at most 24 panels each.
-- automation_rules        filter + deterministic sampling + 1..4 actions, run
--                         as the rule's author by the automation-rule sweep.
-- automation_matches      one row per (rule, trace): the dedupe that keeps a
--                         re-run or a backfill from running an action twice.
-- trace_retention_holds   one hold per trace past the §8.3 floor (at most 2x
--                         the floor and 3 years); the prune skips held traces;
--                         an erasure request always releases the hold.
CREATE TABLE IF NOT EXISTS "kris" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "metric" text NOT NULL,
  "scope" text DEFAULT 'fleet' NOT NULL,
  "scope_id" uuid,
  "window_days" integer DEFAULT 7 NOT NULL,
  "comparator" text DEFAULT 'above' NOT NULL,
  "threshold" double precision NOT NULL,
  "min_samples" integer DEFAULT 20 NOT NULL,
  "severity" text DEFAULT 'medium' NOT NULL,
  "score_name" text,
  "enabled" boolean DEFAULT true NOT NULL,
  "created_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "kris_metric_ck" CHECK ("metric" IN ('trace_volume', 'error_rate', 'latency_p50', 'latency_p99', 'cost_usd', 'feedback_score')),
  CONSTRAINT "kris_scope_ck" CHECK ("scope" IN ('fleet', 'agent', 'project')),
  CONSTRAINT "kris_scope_id_ck" CHECK (("scope" = 'fleet') = ("scope_id" IS NULL)),
  CONSTRAINT "kris_window_ck" CHECK ("window_days" BETWEEN 1 AND 90),
  CONSTRAINT "kris_comparator_ck" CHECK ("comparator" IN ('above', 'below')),
  CONSTRAINT "kris_min_samples_ck" CHECK ("min_samples" BETWEEN 1 AND 100000),
  CONSTRAINT "kris_severity_ck" CHECK ("severity" IN ('low', 'medium', 'high'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "monitoring_dashboards" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "panels" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "created_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "monitoring_dashboards_panels_ck" CHECK (jsonb_array_length("panels") <= 24)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "automation_rules" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "filter" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "sampling_rate" double precision DEFAULT 1 NOT NULL,
  "actions" jsonb NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "paused_reason" text,
  "paused_at" timestamp with time zone,
  "author_user_id" uuid NOT NULL REFERENCES "users"("id"),
  "daily_action_cap" integer DEFAULT 500 NOT NULL,
  "cursor_ended_at" timestamp with time zone DEFAULT now() NOT NULL,
  "cursor_trace_id" uuid,
  "backfill_until" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "automation_rules_sampling_ck" CHECK ("sampling_rate" >= 0 AND "sampling_rate" <= 1),
  CONSTRAINT "automation_rules_status_ck" CHECK ("status" IN ('active', 'paused')),
  CONSTRAINT "automation_rules_cap_ck" CHECK ("daily_action_cap" BETWEEN 1 AND 10000),
  CONSTRAINT "automation_rules_actions_ck" CHECK (jsonb_array_length("actions") BETWEEN 1 AND 4)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "automation_rules_status_idx" ON "automation_rules" ("status");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "automation_matches" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "rule_id" uuid NOT NULL REFERENCES "automation_rules"("id") ON DELETE CASCADE,
  "trace_id" uuid NOT NULL REFERENCES "traces"("id") ON DELETE CASCADE,
  "matched_at" timestamp with time zone DEFAULT now() NOT NULL,
  "backfill" boolean DEFAULT false NOT NULL,
  "status" text DEFAULT 'done' NOT NULL,
  "attempts" integer DEFAULT 1 NOT NULL,
  "action_results" jsonb DEFAULT '[]'::jsonb NOT NULL,
  CONSTRAINT "automation_matches_status_ck" CHECK ("status" IN ('done', 'retry', 'failed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "automation_matches_rule_trace_uq" ON "automation_matches" ("rule_id", "trace_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "automation_matches_rule_at_idx" ON "automation_matches" ("rule_id", "matched_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "automation_matches_retry_idx" ON "automation_matches" ("rule_id") WHERE "status" = 'retry';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "trace_retention_holds" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "trace_id" uuid NOT NULL REFERENCES "traces"("id") ON DELETE CASCADE,
  "hold_until" timestamp with time zone NOT NULL,
  "rule_id" uuid REFERENCES "automation_rules"("id") ON DELETE SET NULL,
  "created_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "released_at" timestamp with time zone,
  "released_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "release_reason" text,
  CONSTRAINT "trace_retention_holds_reason_ck" CHECK ("release_reason" IS NULL OR "release_reason" IN ('erasure', 'admin'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "trace_retention_holds_trace_uq" ON "trace_retention_holds" ("trace_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "trace_retention_holds_active_idx" ON "trace_retention_holds" ("hold_until") WHERE "released_at" IS NULL;
