-- ADR-0346: fairness evaluation through the governed gateway (extends ADR-0222, migration 0271).
--
-- 1. fairness_datasets gains a kind: 'supplied_predictions' (ADR-0222; every existing row) or 'model_inputs' (RegulAIt
--    runs the model). A model-input dataset has no prediction column, one to eight input columns (a join table) and
--    a point-in-time snapshot of the cascade PII mode its cells were checked under and the finding count.
-- 2. fairness_evaluations (+ its attributes and thresholds as rows, ADR-0200 addendum): a saved definition on one card.
-- 3. fairness_runs gains mode/evaluation/engine run/unparseable count/metrics engine; every existing row is 'supplied'.
-- 4. fairness_run_evidence: the signed, append-only evidence of a run (the ai_bom_snapshots shape).
-- 5. fairness_breach_reviews: the one approvals-queue item a breach opens, and its time-boxed risk acceptance.
-- 6. model_card_evidence kind 'fairness_run'; org_settings promotion gate + max run age; compliance_profiles
--    fairness_gate_required (OR-composed, like mrm_required).
--
-- Hand-authored, additive. No new functions: the triggers use regulait_refuse_mutation and regulait_refuse_truncate,
-- which already pin their search_path (zz-dbguard-0185). RLS: admin-only, plus the scheduler (system_task), the engine
-- runner's result (credential_request) and the approvals decide path (approval_maintenance) where each one writes.

ALTER TABLE "fairness_datasets" ADD COLUMN IF NOT EXISTS "kind" text DEFAULT 'supplied_predictions' NOT NULL;
--> statement-breakpoint
ALTER TABLE "fairness_datasets" ALTER COLUMN "prediction_column" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "fairness_datasets" ADD COLUMN IF NOT EXISTS "pii_mode" text;
--> statement-breakpoint
ALTER TABLE "fairness_datasets" ADD COLUMN IF NOT EXISTS "pii_findings" integer;
--> statement-breakpoint
ALTER TABLE "fairness_datasets" ADD CONSTRAINT "fairness_datasets_kind_check" CHECK ("kind" IN ('supplied_predictions','model_inputs'));
--> statement-breakpoint
ALTER TABLE "fairness_datasets" ADD CONSTRAINT "fairness_datasets_kind_shape_check" CHECK (
  ("kind" = 'supplied_predictions' AND "prediction_column" IS NOT NULL AND "pii_mode" IS NULL AND "pii_findings" IS NULL)
  OR ("kind" = 'model_inputs' AND "prediction_column" IS NULL AND "pii_mode" IS NOT NULL AND "pii_mode" IN ('block','redact','warn','log') AND "pii_findings" IS NOT NULL AND "pii_findings" >= 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "fairness_dataset_input_columns" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "dataset_id" uuid NOT NULL REFERENCES "fairness_datasets"("id") ON DELETE CASCADE,
  "column_name" text NOT NULL,
  "position" integer NOT NULL,
  CONSTRAINT "fairness_dataset_input_columns_position_check" CHECK ("position" BETWEEN 0 AND 7),
  CONSTRAINT "fairness_dataset_input_columns_name_check" CHECK (char_length("column_name") BETWEEN 1 AND 200)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "fairness_dataset_input_columns_name_uq" ON "fairness_dataset_input_columns" ("dataset_id", "column_name");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "fairness_dataset_input_columns_position_uq" ON "fairness_dataset_input_columns" ("dataset_id", "position");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "fairness_evaluations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "card_id" uuid NOT NULL REFERENCES "model_cards"("id") ON DELETE CASCADE,
  "dataset_id" uuid NOT NULL REFERENCES "fairness_datasets"("id") ON DELETE RESTRICT,
  "name" text NOT NULL,
  "prompt_template" text NOT NULL,
  "favourable_output" text NOT NULL,
  "unfavourable_output" text NOT NULL,
  "min_group_size" integer DEFAULT 30 NOT NULL,
  "max_unparseable_rate" double precision DEFAULT 0 NOT NULL,
  "engine_schedule_id" uuid REFERENCES "engine_schedules"("id") ON DELETE SET NULL,
  "relaxed" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "created_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "fairness_evaluations_status_check" CHECK ("status" IN ('active','archived')),
  CONSTRAINT "fairness_evaluations_name_check" CHECK (char_length("name") BETWEEN 1 AND 120),
  CONSTRAINT "fairness_evaluations_template_check" CHECK (char_length("prompt_template") BETWEEN 1 AND 8000),
  CONSTRAINT "fairness_evaluations_outputs_check" CHECK (
    char_length("favourable_output") BETWEEN 1 AND 200 AND char_length("unfavourable_output") BETWEEN 1 AND 200
    AND lower(btrim("favourable_output")) <> lower(btrim("unfavourable_output"))
  ),
  CONSTRAINT "fairness_evaluations_min_group_size_check" CHECK ("min_group_size" BETWEEN 30 AND 10000),
  CONSTRAINT "fairness_evaluations_unparseable_check" CHECK ("max_unparseable_rate" >= 0 AND "max_unparseable_rate" <= 0.05),
  CONSTRAINT "fairness_evaluations_relaxed_check" CHECK (jsonb_typeof("relaxed") = 'object')
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "fairness_evaluations_card_name_uq" ON "fairness_evaluations" ("card_id", "name");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "fairness_evaluations_schedule_uq" ON "fairness_evaluations" ("engine_schedule_id") WHERE "engine_schedule_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fairness_evaluations_dataset_idx" ON "fairness_evaluations" ("dataset_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "fairness_evaluation_attributes" (
  "evaluation_id" uuid NOT NULL REFERENCES "fairness_evaluations"("id") ON DELETE CASCADE,
  "attribute" text NOT NULL,
  CONSTRAINT "fairness_evaluation_attributes_pkey" PRIMARY KEY ("evaluation_id", "attribute"),
  CONSTRAINT "fairness_evaluation_attributes_name_check" CHECK (char_length("attribute") BETWEEN 1 AND 200)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "fairness_evaluation_thresholds" (
  "evaluation_id" uuid NOT NULL REFERENCES "fairness_evaluations"("id") ON DELETE CASCADE,
  "metric" text NOT NULL,
  "limit" double precision NOT NULL,
  "action" text NOT NULL,
  CONSTRAINT "fairness_evaluation_thresholds_pkey" PRIMARY KEY ("evaluation_id", "metric"),
  CONSTRAINT "fairness_evaluation_thresholds_metric_check" CHECK ("metric" IN ('demographic_parity_difference','disparate_impact_ratio','equal_opportunity_difference','equalized_odds_difference')),
  CONSTRAINT "fairness_evaluation_thresholds_limit_check" CHECK ("limit" >= 0 AND "limit" <= 1),
  CONSTRAINT "fairness_evaluation_thresholds_action_check" CHECK ("action" IN ('fail','flag'))
);
--> statement-breakpoint
ALTER TABLE "fairness_runs" ADD COLUMN IF NOT EXISTS "mode" text DEFAULT 'supplied' NOT NULL;
--> statement-breakpoint
ALTER TABLE "fairness_runs" ADD COLUMN IF NOT EXISTS "evaluation_id" uuid REFERENCES "fairness_evaluations"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "fairness_runs" ADD COLUMN IF NOT EXISTS "engine_run_id" uuid REFERENCES "engine_runs"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "fairness_runs" ADD COLUMN IF NOT EXISTS "unparseable_count" integer;
--> statement-breakpoint
ALTER TABLE "fairness_runs" ADD COLUMN IF NOT EXISTS "metrics_engine" text;
--> statement-breakpoint
ALTER TABLE "fairness_runs" ADD CONSTRAINT "fairness_runs_mode_check" CHECK ("mode" IN ('supplied','model'));
--> statement-breakpoint
ALTER TABLE "fairness_runs" ADD CONSTRAINT "fairness_runs_mode_shape_check" CHECK (
  ("mode" = 'supplied' AND "evaluation_id" IS NULL AND "engine_run_id" IS NULL AND "unparseable_count" IS NULL AND "metrics_engine" IS NULL)
  OR ("mode" = 'model' AND "evaluation_id" IS NOT NULL AND "engine_run_id" IS NOT NULL AND "unparseable_count" IS NOT NULL AND "unparseable_count" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "fairness_runs_engine_run_uq" ON "fairness_runs" ("engine_run_id") WHERE "engine_run_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fairness_runs_evaluation_created_idx" ON "fairness_runs" ("evaluation_id", "created_at") WHERE "evaluation_id" IS NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "fairness_run_evidence" (
  "run_id" uuid PRIMARY KEY NOT NULL REFERENCES "fairness_runs"("id") ON DELETE RESTRICT,
  "body" text NOT NULL,
  "body_sha256" text NOT NULL,
  "signature" text NOT NULL,
  "key_id" text NOT NULL REFERENCES "receipt_signing_keys"("key_id"),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "fairness_run_evidence_body_size_check" CHECK (octet_length("body") <= 262144),
  CONSTRAINT "fairness_run_evidence_body_sha256_check" CHECK ("body_sha256" = encode(sha256(convert_to("body", 'UTF8')), 'hex')),
  CONSTRAINT "fairness_run_evidence_body_check" CHECK (COALESCE(("body"::jsonb ->> 'v') = 'regulait.fairness-run.v1' AND ("body"::jsonb ->> 'runId') = "run_id"::text, false)),
  CONSTRAINT "fairness_run_evidence_signature_check" CHECK ("signature" ~ '^[A-Za-z0-9_-]{86}$')
);
--> statement-breakpoint
-- evidence is append-only: no UPDATE, DELETE or TRUNCATE (migration 0185's rule)
DROP TRIGGER IF EXISTS "fairness_run_evidence_append_only" ON "fairness_run_evidence";
--> statement-breakpoint
CREATE TRIGGER "fairness_run_evidence_append_only" BEFORE UPDATE OR DELETE ON "fairness_run_evidence"
  FOR EACH ROW EXECUTE FUNCTION "regulait_refuse_mutation"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "fairness_run_evidence_no_truncate" ON public."fairness_run_evidence";
--> statement-breakpoint
CREATE TRIGGER "fairness_run_evidence_no_truncate" BEFORE TRUNCATE ON public."fairness_run_evidence"
  FOR EACH STATEMENT EXECUTE FUNCTION public.regulait_refuse_truncate();
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "fairness_breach_reviews" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "run_id" uuid NOT NULL REFERENCES "fairness_runs"("id") ON DELETE RESTRICT,
  "approval_id" uuid NOT NULL REFERENCES "approvals"("id") ON DELETE RESTRICT,
  "status" text DEFAULT 'pending' NOT NULL,
  "accepted_until" timestamp with time zone,
  "decided_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "fairness_breach_reviews_status_check" CHECK ("status" IN ('pending','accepted','rejected','superseded')),
  CONSTRAINT "fairness_breach_reviews_decision_check" CHECK (
    ("status" = 'pending' AND "decided_at" IS NULL AND "accepted_until" IS NULL)
    OR ("status" = 'accepted' AND "decided_at" IS NOT NULL AND "accepted_until" > "decided_at" AND "accepted_until" <= "decided_at" + interval '90 days')
    OR ("status" = 'rejected' AND "decided_at" IS NOT NULL AND "accepted_until" IS NULL)
    OR ("status" = 'superseded' AND "decided_at" IS NOT NULL)
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "fairness_breach_reviews_run_uq" ON "fairness_breach_reviews" ("run_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "fairness_breach_reviews_approval_uq" ON "fairness_breach_reviews" ("approval_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fairness_breach_reviews_status_idx" ON "fairness_breach_reviews" ("status");
--> statement-breakpoint
ALTER TABLE "model_card_evidence" ADD COLUMN IF NOT EXISTS "fairness_run_id" uuid REFERENCES "fairness_runs"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "model_card_evidence" DROP CONSTRAINT IF EXISTS "model_card_evidence_kind_check";
--> statement-breakpoint
ALTER TABLE "model_card_evidence" ADD CONSTRAINT "model_card_evidence_kind_check" CHECK ("kind" IN ('eval_run','external','engine_scan','fairness_run'));
--> statement-breakpoint
ALTER TABLE "model_card_evidence" DROP CONSTRAINT IF EXISTS "model_card_evidence_shape_check";
--> statement-breakpoint
ALTER TABLE "model_card_evidence" ADD CONSTRAINT "model_card_evidence_shape_check" CHECK (
  ("kind" = 'eval_run' AND "eval_run_id" IS NOT NULL AND "external_ref" IS NULL AND "artifact_scan_id" IS NULL AND "fairness_run_id" IS NULL)
  OR ("kind" = 'external' AND "external_ref" IS NOT NULL AND "eval_run_id" IS NULL AND "artifact_scan_id" IS NULL AND "fairness_run_id" IS NULL)
  OR ("kind" = 'engine_scan' AND "artifact_scan_id" IS NOT NULL AND "eval_run_id" IS NULL AND "external_ref" IS NULL AND "fairness_run_id" IS NULL)
  OR ("kind" = 'fairness_run' AND "fairness_run_id" IS NOT NULL AND "eval_run_id" IS NULL AND "external_ref" IS NULL AND "artifact_scan_id" IS NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "model_card_evidence_card_fairness_run_uq" ON "model_card_evidence" ("card_id", "fairness_run_id") WHERE "fairness_run_id" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "org_settings" ADD COLUMN IF NOT EXISTS "fairness_promotion_gate" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "org_settings" ADD COLUMN IF NOT EXISTS "fairness_run_max_age_days" integer DEFAULT 90 NOT NULL;
--> statement-breakpoint
ALTER TABLE "org_settings" ADD CONSTRAINT "org_settings_fairness_run_max_age_days_check" CHECK ("fairness_run_max_age_days" BETWEEN 1 AND 365);
--> statement-breakpoint
ALTER TABLE "compliance_profiles" ADD COLUMN IF NOT EXISTS "fairness_gate_required" boolean;
--> statement-breakpoint
-- Row-level security on the new tables (ADR-0234's admin-only shape, with the system reasons that write each one).
ALTER TABLE "fairness_dataset_input_columns" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fairness_dataset_input_columns" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS fairness_dataset_input_columns_all ON "fairness_dataset_input_columns";
--> statement-breakpoint
CREATE POLICY fairness_dataset_input_columns_all ON "fairness_dataset_input_columns" FOR ALL
  USING ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['migration', 'system_task', 'credential_request']))
  WITH CHECK ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['migration']));
--> statement-breakpoint
ALTER TABLE "fairness_evaluations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fairness_evaluations" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS fairness_evaluations_all ON "fairness_evaluations";
--> statement-breakpoint
CREATE POLICY fairness_evaluations_all ON "fairness_evaluations" FOR ALL
  USING ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['migration', 'system_task', 'credential_request']))
  WITH CHECK ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['migration']));
--> statement-breakpoint
ALTER TABLE "fairness_evaluation_attributes" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fairness_evaluation_attributes" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS fairness_evaluation_attributes_all ON "fairness_evaluation_attributes";
--> statement-breakpoint
CREATE POLICY fairness_evaluation_attributes_all ON "fairness_evaluation_attributes" FOR ALL
  USING ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['migration', 'system_task', 'credential_request']))
  WITH CHECK ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['migration']));
--> statement-breakpoint
ALTER TABLE "fairness_evaluation_thresholds" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fairness_evaluation_thresholds" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS fairness_evaluation_thresholds_all ON "fairness_evaluation_thresholds";
--> statement-breakpoint
CREATE POLICY fairness_evaluation_thresholds_all ON "fairness_evaluation_thresholds" FOR ALL
  USING ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['migration', 'system_task', 'credential_request']))
  WITH CHECK ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['migration']));
--> statement-breakpoint
ALTER TABLE "fairness_run_evidence" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fairness_run_evidence" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS fairness_run_evidence_all ON "fairness_run_evidence";
--> statement-breakpoint
CREATE POLICY fairness_run_evidence_all ON "fairness_run_evidence" FOR ALL
  USING ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['migration', 'system_task', 'credential_request', 'approval_maintenance']))
  WITH CHECK ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['migration', 'system_task', 'credential_request']));
--> statement-breakpoint
ALTER TABLE "fairness_breach_reviews" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fairness_breach_reviews" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS fairness_breach_reviews_all ON "fairness_breach_reviews";
--> statement-breakpoint
CREATE POLICY fairness_breach_reviews_all ON "fairness_breach_reviews" FOR ALL
  USING ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['migration', 'system_task', 'credential_request', 'approval_maintenance']))
  WITH CHECK ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['migration', 'system_task', 'credential_request', 'approval_maintenance']));
