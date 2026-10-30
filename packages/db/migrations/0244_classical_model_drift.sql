-- Migration 0244. ADR-0223 (P13b, owner 2026-10-30): drift and explainability for classical (non-LLM) models.
-- Hand-authored (never drizzle-kit generate). Re-runnable: every statement is idempotent.
--
--   model_drift_settings            one row, absent until an admin first saves it. Absent = OFF (ADR-0180): no
--                                   monitor can be created and no summary accepted. Turning it on, raising the
--                                   per-monitor hourly cap or lowering the minimum sample count is a `settings_relax`
--                                   step-up.
--   model_drift_monitors            one reference feature distribution for one model card (the ADR-0045 register),
--                                   with its alert thresholds. Strict defaults are the column defaults; a looser
--                                   threshold is a step-up. The reference holds AGGREGATES only (bin edges and
--                                   counts, or category labels and counts), validated and bounded by the gateway.
--   model_drift_reports             one production summary submitted against a monitor (pushed by a pipeline or
--                                   uploaded by an admin), with the per-feature statistics the gateway computed and
--                                   the SHA-256 of the canonical submitted summary. Aggregates only.
--   model_explainability_artefacts  global feature importance or a SHAP summary the customer's pipeline produced,
--                                   recorded as evidence on the model card. Aggregates only (one value per feature).
--
-- Every write goes through the gateway in the same transaction as its audit row. No function and no trigger is
-- created here, so the 0185 guard (pinned search_path; TRUNCATE refusal beside a row refusal) has nothing new to
-- check. The deployment is single-tenant (one org row), so there is no tenant column to put row-level security on.

CREATE TABLE IF NOT EXISTS "model_drift_settings" (
  "id" text PRIMARY KEY DEFAULT 'singleton' NOT NULL,
  "enabled" boolean DEFAULT false NOT NULL,
  "max_reports_per_hour" integer DEFAULT 12 NOT NULL,
  "min_samples" integer DEFAULT 100 NOT NULL,
  "updated_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "model_drift_settings_singleton_check" CHECK ("id" = 'singleton'),
  CONSTRAINT "model_drift_settings_rate_check" CHECK ("max_reports_per_hour" BETWEEN 1 AND 120),
  CONSTRAINT "model_drift_settings_min_samples_check" CHECK ("min_samples" BETWEEN 1 AND 1000000)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "model_drift_monitors" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "card_id" uuid NOT NULL REFERENCES "model_cards"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "reference" jsonb NOT NULL,
  "reference_sha256" text NOT NULL,
  "feature_count" integer NOT NULL,
  "reference_samples" integer NOT NULL,
  "psi_warn" double precision DEFAULT 0.1 NOT NULL,
  "psi_alert" double precision DEFAULT 0.25 NOT NULL,
  "ks_alert" double precision DEFAULT 0.1 NOT NULL,
  "js_alert" double precision DEFAULT 0.05 NOT NULL,
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "model_drift_monitors_name_check" CHECK (char_length(btrim("name")) BETWEEN 1 AND 120),
  CONSTRAINT "model_drift_monitors_reference_check" CHECK (jsonb_typeof("reference") = 'array'),
  CONSTRAINT "model_drift_monitors_sha_check" CHECK ("reference_sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "model_drift_monitors_features_check" CHECK ("feature_count" BETWEEN 1 AND 200),
  CONSTRAINT "model_drift_monitors_samples_check" CHECK ("reference_samples" > 0),
  CONSTRAINT "model_drift_monitors_thresholds_check" CHECK (
    "psi_warn" > 0 AND "psi_alert" >= "psi_warn" AND "psi_alert" <= 10
    AND "ks_alert" > 0 AND "ks_alert" <= 1
    AND "js_alert" > 0 AND "js_alert" <= 0.7
  ),
  CONSTRAINT "model_drift_monitors_card_name_uq" UNIQUE ("card_id", "name")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "model_drift_reports" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "monitor_id" uuid NOT NULL REFERENCES "model_drift_monitors"("id") ON DELETE CASCADE,
  "source" text NOT NULL,
  "window_start" timestamp with time zone NOT NULL,
  "window_end" timestamp with time zone NOT NULL,
  "sample_count" integer NOT NULL,
  "summary" jsonb NOT NULL,
  "summary_sha256" text NOT NULL,
  "results" jsonb NOT NULL,
  "status" text NOT NULL,
  "drifted_features" integer NOT NULL,
  "submitted_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "model_drift_reports_source_check" CHECK ("source" IN ('push', 'upload')),
  CONSTRAINT "model_drift_reports_window_check" CHECK ("window_end" > "window_start"),
  CONSTRAINT "model_drift_reports_samples_check" CHECK ("sample_count" > 0),
  CONSTRAINT "model_drift_reports_summary_check" CHECK (jsonb_typeof("summary") = 'array' AND jsonb_typeof("results") = 'array'),
  CONSTRAINT "model_drift_reports_sha_check" CHECK ("summary_sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "model_drift_reports_status_check" CHECK ("status" IN ('within', 'warn', 'drift', 'insufficient')),
  CONSTRAINT "model_drift_reports_drifted_check" CHECK ("drifted_features" >= 0)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "model_drift_reports_monitor_idx" ON "model_drift_reports" ("monitor_id", "created_at" DESC, "id" DESC);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "model_explainability_artefacts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "card_id" uuid NOT NULL REFERENCES "model_cards"("id") ON DELETE CASCADE,
  "kind" text NOT NULL,
  "method" text NOT NULL,
  "importances" jsonb NOT NULL,
  "feature_count" integer NOT NULL,
  "payload_sha256" text NOT NULL,
  "note" text,
  "submitted_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "model_explainability_artefacts_kind_check" CHECK ("kind" IN ('global_importance', 'shap_summary')),
  CONSTRAINT "model_explainability_artefacts_method_check" CHECK (char_length(btrim("method")) BETWEEN 1 AND 120),
  CONSTRAINT "model_explainability_artefacts_importances_check" CHECK (jsonb_typeof("importances") = 'array'),
  CONSTRAINT "model_explainability_artefacts_features_check" CHECK ("feature_count" BETWEEN 1 AND 500),
  CONSTRAINT "model_explainability_artefacts_sha_check" CHECK ("payload_sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "model_explainability_artefacts_note_check" CHECK ("note" IS NULL OR char_length("note") <= 2000)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "model_explainability_artefacts_card_idx" ON "model_explainability_artefacts" ("card_id", "created_at" DESC);
