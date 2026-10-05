-- ADR-0180 (ADR-0175 batch D3) — continuous assurance: the foundation schema.
--
-- Secure by default (ADR-0180 §1): every new setting starts strict and nothing
-- is grandfathered. The logic that reads these columns lands with the D3 item
-- owners (A2 conditions, A3 required tests, A8 autonomy, A10 risk tolerance).
--
-- use_case_conditions      a condition may now be MEASURED: kind, metric spec,
--                          cadence, breach policy, the last evaluation, and an
--                          admin waiver (reason required).
-- risk_tolerances          per risk category or review tier, the highest
--                          residual band the org tolerates. EMPTY on purpose:
--                          the strict default (above medium needs acceptance)
--                          lives in code, so an empty table is the strict state.
-- risk_acceptances         time-boxed residual-risk acceptance history. The DB
--                          caps the expiry (184 days for high/critical, 366
--                          otherwise, in absolute hours) behind the calendar
--                          6/12-month rule the gateway applies, and allows one
--                          live acceptance per risk.
-- builder_agents           a steward's DECLARED autonomy class (the observed
--                          class is derived, never stored).
-- org_settings             assurance_gate_mode, DEFAULT 'enforce'.
-- governance_review_policy required_tests: per-tier required test classes and
--                          freshness, a separate column so the existing policy
--                          PUT (which rebuilds `tiers`) cannot drop it. '{}' =
--                          the strict per-tier defaults in code.
-- audit_log                a partial index over the guardrail hit rows, read by
--                          the guardrail_hits condition metric.

ALTER TABLE "use_case_conditions" ADD COLUMN IF NOT EXISTS "kind" text DEFAULT 'manual' NOT NULL;
--> statement-breakpoint
ALTER TABLE "use_case_conditions" ADD COLUMN IF NOT EXISTS "metric" text;
--> statement-breakpoint
ALTER TABLE "use_case_conditions" ADD COLUMN IF NOT EXISTS "params" jsonb DEFAULT '{}'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "use_case_conditions" ADD COLUMN IF NOT EXISTS "operator" text;
--> statement-breakpoint
ALTER TABLE "use_case_conditions" ADD COLUMN IF NOT EXISTS "threshold" double precision;
--> statement-breakpoint
ALTER TABLE "use_case_conditions" ADD COLUMN IF NOT EXISTS "window_days" integer;
--> statement-breakpoint
ALTER TABLE "use_case_conditions" ADD COLUMN IF NOT EXISTS "min_samples" integer;
--> statement-breakpoint
ALTER TABLE "use_case_conditions" ADD COLUMN IF NOT EXISTS "cadence" text;
--> statement-breakpoint
ALTER TABLE "use_case_conditions" ADD COLUMN IF NOT EXISTS "on_breach" text DEFAULT 'alert' NOT NULL;
--> statement-breakpoint
ALTER TABLE "use_case_conditions" ADD COLUMN IF NOT EXISTS "last_value" double precision;
--> statement-breakpoint
ALTER TABLE "use_case_conditions" ADD COLUMN IF NOT EXISTS "last_samples" integer;
--> statement-breakpoint
ALTER TABLE "use_case_conditions" ADD COLUMN IF NOT EXISTS "last_state" text;
--> statement-breakpoint
ALTER TABLE "use_case_conditions" ADD COLUMN IF NOT EXISTS "last_evaluated_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "use_case_conditions" ADD COLUMN IF NOT EXISTS "consecutive_breaches" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "use_case_conditions" ADD COLUMN IF NOT EXISTS "evidence" jsonb DEFAULT '[]'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "use_case_conditions" ADD COLUMN IF NOT EXISTS "waived_by" uuid REFERENCES "users"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "use_case_conditions" ADD COLUMN IF NOT EXISTS "waived_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "use_case_conditions" ADD COLUMN IF NOT EXISTS "waive_reason" text;
--> statement-breakpoint
ALTER TABLE "use_case_conditions" ADD CONSTRAINT "use_case_conditions_kind_check" CHECK ("kind" IN ('manual', 'metric', 'test_class', 'autonomy_floor'));
--> statement-breakpoint
ALTER TABLE "use_case_conditions" ADD CONSTRAINT "use_case_conditions_metric_check" CHECK ("metric" IS NULL OR "metric" IN ('trace_eval_flag_rate', 'guardrail_hits', 'guardrail_mode', 'redteam_asr', 'eval_mean_score', 'eval_pass_rate', 'spend_usd', 'error_rate', 'pack_control_evidenced'));
--> statement-breakpoint
ALTER TABLE "use_case_conditions" ADD CONSTRAINT "use_case_conditions_measured_check" CHECK (
  ("kind" = 'manual') = ("metric" IS NULL)
  AND ("metric" IS NULL OR ("operator" IS NOT NULL AND "threshold" IS NOT NULL AND "window_days" IS NOT NULL AND "min_samples" IS NOT NULL AND "cadence" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "use_case_conditions" ADD CONSTRAINT "use_case_conditions_operator_check" CHECK ("operator" IS NULL OR "operator" IN ('lt', 'lte', 'gt', 'gte', 'eq'));
--> statement-breakpoint
ALTER TABLE "use_case_conditions" ADD CONSTRAINT "use_case_conditions_window_check" CHECK ("window_days" IS NULL OR "window_days" BETWEEN 1 AND 90);
--> statement-breakpoint
ALTER TABLE "use_case_conditions" ADD CONSTRAINT "use_case_conditions_min_samples_check" CHECK ("min_samples" IS NULL OR "min_samples" BETWEEN 1 AND 100000);
--> statement-breakpoint
ALTER TABLE "use_case_conditions" ADD CONSTRAINT "use_case_conditions_cadence_check" CHECK ("cadence" IS NULL OR "cadence" IN ('hourly', 'daily', 'weekly'));
--> statement-breakpoint
ALTER TABLE "use_case_conditions" ADD CONSTRAINT "use_case_conditions_on_breach_check" CHECK ("on_breach" IN ('alert', 'reopen_review'));
--> statement-breakpoint
ALTER TABLE "use_case_conditions" ADD CONSTRAINT "use_case_conditions_last_state_check" CHECK ("last_state" IS NULL OR "last_state" IN ('pass', 'fail', 'insufficient', 'not_run'));
--> statement-breakpoint
ALTER TABLE "use_case_conditions" ADD CONSTRAINT "use_case_conditions_breaches_check" CHECK ("consecutive_breaches" >= 0);
--> statement-breakpoint
ALTER TABLE "use_case_conditions" ADD CONSTRAINT "use_case_conditions_evidence_check" CHECK (jsonb_typeof("evidence") = 'array' AND jsonb_typeof("params") = 'object');
--> statement-breakpoint
ALTER TABLE "use_case_conditions" ADD CONSTRAINT "use_case_conditions_waived_check" CHECK (
  ("status" = 'waived') = ("waived_at" IS NOT NULL)
  AND ("waived_at" IS NULL OR length(btrim(coalesce("waive_reason", ''))) BETWEEN 1 AND 2000)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "use_case_conditions_measured_idx" ON "use_case_conditions" ("use_case_id") WHERE "kind" <> 'manual';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "risk_tolerances" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "scope_kind" text NOT NULL,
  "scope_key" text NOT NULL,
  "max_band" text NOT NULL,
  "created_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "risk_tolerances_scope_kind_check" CHECK ("scope_kind" IN ('category', 'tier')),
  CONSTRAINT "risk_tolerances_scope_key_check" CHECK (length(btrim("scope_key")) BETWEEN 1 AND 64),
  CONSTRAINT "risk_tolerances_max_band_check" CHECK ("max_band" IN ('none', 'low', 'medium', 'high', 'critical'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "risk_tolerances_scope_uq" ON "risk_tolerances" ("scope_kind", "scope_key");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "risk_acceptances" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "risk_id" uuid NOT NULL REFERENCES "ai_risks"("id") ON DELETE CASCADE,
  "use_case_id" uuid REFERENCES "ai_use_cases"("id") ON DELETE SET NULL,
  "response_type" text NOT NULL,
  "residual_band" text NOT NULL,
  "accepted_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "accepted_at" timestamp with time zone DEFAULT now() NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "rationale" text NOT NULL,
  "compensating_controls" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "superseded_at" timestamp with time zone,
  "superseded_by_id" uuid REFERENCES "risk_acceptances"("id") ON DELETE SET NULL,
  "expired_at" timestamp with time zone,
  "revoked_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "revoked_at" timestamp with time zone,
  "revoke_reason" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "risk_acceptances_response_type_check" CHECK ("response_type" IN ('accept', 'mitigate_partially', 'transfer', 'avoid_pending')),
  CONSTRAINT "risk_acceptances_residual_band_check" CHECK ("residual_band" IN ('low', 'medium', 'high', 'critical')),
  CONSTRAINT "risk_acceptances_rationale_check" CHECK (length(btrim("rationale")) BETWEEN 1 AND 4000),
  CONSTRAINT "risk_acceptances_expiry_check" CHECK (
    "expires_at" > "accepted_at"
    AND "expires_at" <= "accepted_at" + CASE WHEN "residual_band" IN ('high', 'critical') THEN interval '4416 hours' ELSE interval '8784 hours' END
  ),
  CONSTRAINT "risk_acceptances_controls_check" CHECK (jsonb_typeof("compensating_controls") = 'array' AND jsonb_array_length("compensating_controls") <= 20),
  CONSTRAINT "risk_acceptances_revoke_check" CHECK (("revoked_at" IS NULL) = ("revoke_reason" IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "risk_acceptances_live_uq" ON "risk_acceptances" ("risk_id") WHERE "superseded_at" IS NULL AND "expired_at" IS NULL AND "revoked_at" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "risk_acceptances_risk_idx" ON "risk_acceptances" ("risk_id", "accepted_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "risk_acceptances_expiry_idx" ON "risk_acceptances" ("expires_at") WHERE "superseded_at" IS NULL AND "expired_at" IS NULL AND "revoked_at" IS NULL;
--> statement-breakpoint
ALTER TABLE "builder_agents" ADD COLUMN IF NOT EXISTS "declared_autonomy_class" text;
--> statement-breakpoint
ALTER TABLE "builder_agents" ADD COLUMN IF NOT EXISTS "autonomy_declared_by" uuid REFERENCES "users"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "builder_agents" ADD COLUMN IF NOT EXISTS "autonomy_declared_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "builder_agents" ADD COLUMN IF NOT EXISTS "autonomy_note" text;
--> statement-breakpoint
ALTER TABLE "builder_agents" ADD CONSTRAINT "builder_agents_autonomy_class_ck" CHECK ("declared_autonomy_class" IS NULL OR "declared_autonomy_class" IN ('assist', 'supervised', 'delegated', 'autonomous'));
--> statement-breakpoint
ALTER TABLE "builder_agents" ADD CONSTRAINT "builder_agents_autonomy_declared_ck" CHECK (
  ("declared_autonomy_class" IS NULL) = ("autonomy_declared_at" IS NULL)
  AND ("autonomy_note" IS NULL OR length("autonomy_note") <= 2000)
);
--> statement-breakpoint
ALTER TABLE "org_settings" ADD COLUMN IF NOT EXISTS "assurance_gate_mode" text DEFAULT 'enforce' NOT NULL;
--> statement-breakpoint
ALTER TABLE "org_settings" ADD CONSTRAINT "org_settings_assurance_gate_mode_check" CHECK ("assurance_gate_mode" IN ('off', 'warn', 'enforce'));
--> statement-breakpoint
ALTER TABLE "governance_review_policy" ADD COLUMN IF NOT EXISTS "required_tests" jsonb DEFAULT '{}'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "governance_review_policy" ADD CONSTRAINT "governance_review_policy_required_tests_check" CHECK (jsonb_typeof("required_tests") = 'object');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_log_guardrail_hits_idx" ON "audit_log" ("rule_id", "at") WHERE "rule_id" IN ('guardrail-blocked', 'guardrail-warned', 'guardrail-logged');
