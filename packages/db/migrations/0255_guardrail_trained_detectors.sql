-- ADR-0220: trained runtime detectors (P7). Hand-authored (never drizzle-kit generate). Re-runnable: every statement
-- is idempotent.
--
-- 1. One optional row per trained detector kind. No row = off, and nothing is backfilled (ADR-0180: default-off), so
--    a fresh or upgraded database runs only the heuristic detectors until an admin turns one on.
-- 2. The column defaults are the strict values an enabled detector starts from: mode `block`, fail closed
--    (`on_failure` = `block`), threshold 0.5, a 2 s call budget. Relaxing any of them goes through a settings_relax
--    step-up on PUT /v1/guardrails/trained-detectors/:kind, audited in the same transaction.
-- 3. `scorer_id` names the registered external scorer (ADR-0088) that serves the kind. Deleting a scorer that an
--    enabled detector names is refused (the SET NULL would break the CHECK below; the gateway answers 409 first), so a
--    delete cannot leave a detector on with nothing to call. The gateway still fails closed if the scorer is disabled
--    or unreachable at call time.
-- 4. Single-tenant per deployment, like `guardrail_configs`: no tenant column, so no row-level security.

CREATE TABLE IF NOT EXISTS "guardrail_trained_detectors" (
  "kind" text PRIMARY KEY NOT NULL,
  "enabled" boolean DEFAULT false NOT NULL,
  "scorer_id" uuid REFERENCES "external_scorers"("id") ON DELETE SET NULL,
  "mode" text DEFAULT 'block' NOT NULL,
  "threshold" double precision DEFAULT 0.5 NOT NULL,
  "on_failure" text DEFAULT 'block' NOT NULL,
  "timeout_ms" integer DEFAULT 2000 NOT NULL,
  "updated_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "guardrail_trained_detectors_kind_check" CHECK ("kind" IN ('pii', 'prompt_injection', 'harm')),
  CONSTRAINT "guardrail_trained_detectors_mode_check" CHECK ("mode" IN ('log', 'warn', 'block')),
  CONSTRAINT "guardrail_trained_detectors_on_failure_check" CHECK ("on_failure" IN ('block', 'heuristic')),
  CONSTRAINT "guardrail_trained_detectors_threshold_check" CHECK ("threshold" > 0 AND "threshold" <= 1),
  CONSTRAINT "guardrail_trained_detectors_timeout_check" CHECK ("timeout_ms" BETWEEN 200 AND 10000),
  CONSTRAINT "guardrail_trained_detectors_enabled_scorer_check" CHECK (NOT "enabled" OR "scorer_id" IS NOT NULL)
);
