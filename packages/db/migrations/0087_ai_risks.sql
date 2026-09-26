-- Migration 0087 (ADR-0081) — THE AI RISK REGISTER.
--
-- The L2 gap (docs/product/GAP_ANALYSIS_CREDO_AI_2026-08.md): we MEASURE
-- relentlessly — red-team ASR (ADR-0068), evals (ADR-0067), guardrail verdicts
-- (ADR-0042), model cards (ADR-0045) — but nothing links a measurement to a
-- named risk scenario, a mitigating control, an owner, and a residual-risk
-- acceptance. This table is that link, built the one way our positioning
-- claims: a risk's EVIDENCE is not stored here at all. It is computed at read
-- time by SELECTs over the real ledgers (the ADR-0058 discipline), keyed off
-- `category` — so there is no column anywhere in this migration an admin
-- could set to make a risk look measured.
--
-- WHAT IS DECLARED vs WHAT IS MEASURED (the honesty split, in the schema):
--
--   `likelihood` and `impact` are DECLARED human judgments — small enums, no
--   arithmetic, never blended into any computed number. `category` is the key
--   the gateway resolves to ledger queries. `status` reaches 'accepted' ONLY
--   through the audited acceptance endpoint (who, when, why — the residual-
--   risk record), never through a PATCH.
--
-- WHAT IS DELIBERATELY NOT HERE
--
--   No risk scores or quantified-exposure columns (a 3x3 of two enums is not
--   risk math and we do not pretend it is). No stored evidence counts. No
--   auto-discovery columns — nothing creates a risk but a person.
CREATE TABLE IF NOT EXISTS "ai_risks" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "title" text NOT NULL,
  "description" text NOT NULL,
  -- the EVIDENCE KEY: one of the curated vocabulary the gateway maps to
  -- ledger queries (@regulait/shared RISK_CATEGORY_EVIDENCE). 'scope_drift'
  -- is the honest outlier: no ledger measures it, and the register says
  -- "evidence: none — attestation only" rather than inventing a proxy.
  "category" text NOT NULL,
  "owner_user_id" uuid NOT NULL,
  -- OPTIONAL SCOPE, references not copies: a risk may be org-wide (all null)
  -- or pinned to the project/agent/use case whose ledger slice evidences it.
  "project_id" uuid,
  "agent_id" uuid,
  "use_case_id" uuid,
  "status" text DEFAULT 'open' NOT NULL,
  -- DECLARED human judgments. Small enums on purpose: they are a position a
  -- person takes, not a measurement, and the API labels them 'declared' so
  -- they can never be mistaken for the computed evidence beside them.
  "likelihood" text NOT NULL,
  "impact" text NOT NULL,
  -- the mitigating control, in prose — what this deployment actually enforces
  -- against the scenario (the seed library fills this with ADR references)
  "mitigation" text,
  -- THE RESIDUAL-RISK ACCEPTANCE RECORD: who accepted, when, and why.
  -- Written only by the audited acceptance endpoint. It is a record of a
  -- human decision, not a control — accepting a risk changes no enforcement.
  "accepted_by_user_id" uuid,
  "accepted_at" timestamp with time zone,
  "acceptance_note" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "ai_risks_title_check" CHECK (length(btrim("title")) > 0),
  CONSTRAINT "ai_risks_category_check"
    CHECK ("category" IN ('tool_misuse', 'scope_drift', 'prompt_injection', 'data_leakage_pii',
                          'over_permissioning', 'budget_overrun', 'hallucination', 'shadow_ai')),
  CONSTRAINT "ai_risks_status_check"
    CHECK ("status" IN ('open', 'mitigating', 'accepted', 'closed')),
  CONSTRAINT "ai_risks_likelihood_check" CHECK ("likelihood" IN ('low', 'medium', 'high')),
  CONSTRAINT "ai_risks_impact_check" CHECK ("impact" IN ('low', 'medium', 'high')),
  -- an acceptance without a note and a timestamp is not a record; the reverse
  -- (acceptance fields on a non-accepted row) is equally incoherent — and
  -- 'accepted' is terminal, so the biconditional can never be outgrown
  CONSTRAINT "ai_risks_acceptance_check"
    CHECK (("status" = 'accepted') = ("accepted_at" IS NOT NULL AND "acceptance_note" IS NOT NULL))
);

DO $$ BEGIN
  ALTER TABLE "ai_risks" ADD CONSTRAINT "ai_risks_owner_fk"
    FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "ai_risks" ADD CONSTRAINT "ai_risks_project_fk"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "ai_risks" ADD CONSTRAINT "ai_risks_agent_fk"
    FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "ai_risks" ADD CONSTRAINT "ai_risks_use_case_fk"
    FOREIGN KEY ("use_case_id") REFERENCES "ai_use_cases"("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "ai_risks" ADD CONSTRAINT "ai_risks_accepted_by_fk"
    FOREIGN KEY ("accepted_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "ai_risks_owner_idx" ON "ai_risks" ("owner_user_id");
CREATE INDEX IF NOT EXISTS "ai_risks_status_idx" ON "ai_risks" ("status");
CREATE INDEX IF NOT EXISTS "ai_risks_category_idx" ON "ai_risks" ("category");
CREATE INDEX IF NOT EXISTS "ai_risks_use_case_idx" ON "ai_risks" ("use_case_id");
