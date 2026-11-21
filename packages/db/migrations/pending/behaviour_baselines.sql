-- ADR-0359 (lane E40), slice 1: learned behaviour baselines over the install's own audit chain, shadow mode.
-- Hand-authored (never drizzle-kit generate). Re-runnable: every statement is idempotent.
--
-- - `behaviour_baseline_settings`: singleton; `shadow` (findings only) is the default, `off` is a step-up relaxation.
-- - `behaviour_engine_state`: the sweep's leased cursor over `audit_log.seq` and the last evaluated UTC day.
-- - `behaviour_daily_counts`: the per-day rollup (a read model whose source of truth is `audit_log`; FK-free subject
--   ids, like the audit trail).
-- - `behaviour_anomaly_findings`: point-in-time snapshots of each finding with its baseline.
-- - The deployment is single-tenant (ADR-0015), so like the other register tables there is no tenant column for RLS.
-- No new functions or refusal triggers.

CREATE TABLE IF NOT EXISTS "behaviour_baseline_settings" (
  "id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
  "mode" text DEFAULT 'shadow' NOT NULL,
  "updated_by" uuid,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "behaviour_baseline_settings_singleton_check" CHECK ("id" = 1),
  CONSTRAINT "behaviour_baseline_settings_mode_check" CHECK ("mode" IN ('shadow', 'off'))
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "behaviour_baseline_settings" ADD CONSTRAINT "behaviour_baseline_settings_updated_by_users_id_fk"
    FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "behaviour_engine_state" (
  "id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
  "cursor_seq" bigint DEFAULT 0 NOT NULL,
  "evaluated_through" date,
  "lease_until" timestamp with time zone,
  "lease_token" uuid,
  "last_sweep_at" timestamp with time zone,
  CONSTRAINT "behaviour_engine_state_singleton_check" CHECK ("id" = 1)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "behaviour_daily_counts" (
  "day" date NOT NULL,
  "subject_kind" text NOT NULL,
  "subject_id" uuid NOT NULL,
  "signal" text NOT NULL,
  "key" text NOT NULL,
  "count" integer NOT NULL,
  CONSTRAINT "behaviour_daily_counts_pk" PRIMARY KEY ("day", "subject_kind", "subject_id", "signal", "key"),
  CONSTRAINT "behaviour_daily_counts_subject_kind_check" CHECK ("subject_kind" IN ('user', 'agent')),
  CONSTRAINT "behaviour_daily_counts_signal_check" CHECK ("signal" IN ('model_calls', 'data_scoped_calls', 'tool', 'destination', 'hour_of_day')),
  CONSTRAINT "behaviour_daily_counts_key_check" CHECK (char_length("key") <= 200),
  CONSTRAINT "behaviour_daily_counts_count_check" CHECK ("count" >= 1)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "behaviour_anomaly_findings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "day" date NOT NULL,
  "subject_kind" text NOT NULL,
  "subject_id" uuid NOT NULL,
  "signal" text NOT NULL,
  "key" text NOT NULL,
  "method" text NOT NULL,
  "observed" integer NOT NULL,
  "baseline_days" integer NOT NULL,
  "baseline_median" double precision,
  "baseline_mad" double precision,
  "baseline_key_count" integer,
  "baseline_total" integer,
  "score" double precision,
  "threshold" double precision NOT NULL,
  "explanation" text NOT NULL,
  "status" text DEFAULT 'open' NOT NULL,
  "status_changed_by" uuid,
  "status_changed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "behaviour_anomaly_findings_subject_kind_check" CHECK ("subject_kind" IN ('user', 'agent')),
  CONSTRAINT "behaviour_anomaly_findings_signal_check" CHECK ("signal" IN ('model_calls', 'data_scoped_calls', 'tool', 'destination', 'hour_of_day')),
  CONSTRAINT "behaviour_anomaly_findings_method_check" CHECK ("method" IN ('mad_z', 'ratio_over_median', 'share_of_history')),
  CONSTRAINT "behaviour_anomaly_findings_status_check" CHECK ("status" IN ('open', 'acknowledged', 'dismissed')),
  CONSTRAINT "behaviour_anomaly_findings_key_check" CHECK (char_length("key") <= 200),
  CONSTRAINT "behaviour_anomaly_findings_explanation_check" CHECK (char_length("explanation") BETWEEN 1 AND 2000)
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "behaviour_anomaly_findings" ADD CONSTRAINT "behaviour_anomaly_findings_status_changed_by_users_id_fk"
    FOREIGN KEY ("status_changed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "behaviour_anomaly_findings_subject_signal_uq" ON "behaviour_anomaly_findings" USING btree ("day", "subject_kind", "subject_id", "signal", "key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "behaviour_anomaly_findings_status_created_idx" ON "behaviour_anomaly_findings" USING btree ("status", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "behaviour_anomaly_findings_subject_idx" ON "behaviour_anomaly_findings" USING btree ("subject_kind", "subject_id", "day");
