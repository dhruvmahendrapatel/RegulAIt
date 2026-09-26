-- Migration 0080 (ADR-0068) — RED-TEAM PROBE-CORPUS DEPTH.
--
-- ADR-0057 built the red-team subsystem and then ran every probe EXACTLY ONCE
-- against a corpus of nine probes across five attack classes. Model output is
-- stochastic, so a single-shot boolean is a sample of size one presented as a
-- measurement. This migration adds what turns that into a statistic, and what
-- lets a probe exercise the one surface a text-only scanner structurally
-- cannot: our own tool/connector gateway.
--
-- WHAT IS DELIBERATELY NOT HERE
--
--   No new dispatch path, no second metering ledger, no second audit log, no
--   second gate. Every probe trial — single-turn, multi-turn or agentic — still
--   goes through `executeGovernedDispatch`, so the entitlement check, the
--   guardrail pass, the `usage_events` cost row and the `audit_log` row are the
--   ones that already exist. Single-turn probes still materialize into
--   `eval_cases` and still run through ADR-0044's `runEvalSuite`; that path is
--   untouched.
--
--   No Postgres ENUM TYPE is created or altered. `attack_class` is a plain
--   `text` column (the ADR-0024/0034 pattern) — but migration 0070 did put a
--   CHECK constraint on it naming the five original values, so widening the
--   vocabulary to ten IS a real DDL statement: the two constraints are dropped
--   and re-added below. That is deliberately kept as a CHECK rather than
--   relaxed away: a constraint that lists the vocabulary is what stops a typo'd
--   attack class becoming a class nobody ever gates on. Every existing row
--   keeps its exact meaning, and the widened list is a strict superset.
--
-- THE HONEST LIMITS BAKED INTO THE SHAPE
--
--   `redteam_probe_trials.error` exists because a trial that failed before
--   producing a scoreable result must be excluded from the ASR denominator
--   rather than scored. Counting a failed dispatch as "resisted" would let an
--   outage manufacture a clean security result; counting it as "defeated" would
--   manufacture a finding. Both are lies, so it gets its own column and its own
--   number.
--
--   `redteam_runs.not_run_probes` exists for the same reason at the probe
--   level: an agentic probe naming a connector this install has never
--   registered CANNOT be adjudicated, and the only honest report is NOT RUN.
--   It is excluded from `asr`, from `probe_stats`' rates, and from the gate.
--
--   `redteam_runs.trials` DEFAULTS TO 1, which is byte-identical to the
--   pre-0068 behaviour, because this number multiplies model spend and
--   ADR-0064's `redteam-sweep` repeats the whole run on every scheduled pass.
--   A run at 1 is stamped `measurement_quality = 'single-trial'` and is never
--   reported as a measured rate.
--
--   `redteam_runs.platform_held` counts probes where the MODEL was successfully
--   induced and this deployment's own entitlement layer refused the call
--   anyway. That is a first-class result, not an absence — it is the evidence
--   that pillar 1 held under attack — so it gets a column rather than being
--   inferred from the lack of a finding.
--
--   Nothing in the agentic path EXECUTES anything. An induced tool or connector
--   call is handed to the policy kernel for a DECISION and recorded. A probe
--   corpus that actually fired connectors would be a weapon rather than a test.

-- ---------------------------------------------------------------------------
-- The attack-class vocabulary: five values -> ten. A strict superset, so no
-- existing row can be invalidated by this. The CHECK is re-added rather than
-- dropped: an unconstrained text column would let a typo'd class silently
-- become a class no gate ever names.
-- ---------------------------------------------------------------------------
ALTER TABLE "redteam_probes" DROP CONSTRAINT IF EXISTS "redteam_probes_class_ck";
ALTER TABLE "redteam_probes" ADD CONSTRAINT "redteam_probes_class_ck" CHECK (
  "attack_class" IN (
    'prompt_injection', 'jailbreak', 'data_exfiltration', 'pii_leak', 'bias',
    'indirect_prompt_injection', 'tool_abuse', 'excessive_agency',
    'system_prompt_extraction', 'encoding_evasion'
  )
);
ALTER TABLE "redteam_findings" DROP CONSTRAINT IF EXISTS "redteam_findings_class_ck";
ALTER TABLE "redteam_findings" ADD CONSTRAINT "redteam_findings_class_ck" CHECK (
  "attack_class" IN (
    'prompt_injection', 'jailbreak', 'data_exfiltration', 'pii_leak', 'bias',
    'indirect_prompt_injection', 'tool_abuse', 'excessive_agency',
    'system_prompt_extraction', 'encoding_evasion'
  )
);

-- ---------------------------------------------------------------------------
-- Probes: multi-turn sequences, declared tools, agentic vectors
-- ---------------------------------------------------------------------------
ALTER TABLE "redteam_probes" ADD COLUMN IF NOT EXISTS "turns" jsonb;
ALTER TABLE "redteam_probes" ADD COLUMN IF NOT EXISTS "tools" jsonb;
ALTER TABLE "redteam_probes" ADD COLUMN IF NOT EXISTS "agentic" jsonb;

-- ---------------------------------------------------------------------------
-- Libraries: which SHIPPED corpus version seeded this one (reproducibility)
-- ---------------------------------------------------------------------------
ALTER TABLE "redteam_libraries" ADD COLUMN IF NOT EXISTS "corpus_version" integer;

-- ---------------------------------------------------------------------------
-- Runs: N trials, attack-success rate, Wilson interval, honesty counters
-- ---------------------------------------------------------------------------
ALTER TABLE "redteam_runs" ADD COLUMN IF NOT EXISTS "trials" integer DEFAULT 1 NOT NULL;
ALTER TABLE "redteam_runs" ADD COLUMN IF NOT EXISTS "asr" double precision;
ALTER TABLE "redteam_runs" ADD COLUMN IF NOT EXISTS "asr_lower" double precision;
ALTER TABLE "redteam_runs" ADD COLUMN IF NOT EXISTS "asr_upper" double precision;
ALTER TABLE "redteam_runs" ADD COLUMN IF NOT EXISTS "asr_trials" integer DEFAULT 0 NOT NULL;
ALTER TABLE "redteam_runs" ADD COLUMN IF NOT EXISTS "measurement_quality" text;
ALTER TABLE "redteam_runs" ADD COLUMN IF NOT EXISTS "not_run_probes" integer DEFAULT 0 NOT NULL;
ALTER TABLE "redteam_runs" ADD COLUMN IF NOT EXISTS "probe_stats" jsonb DEFAULT '[]'::jsonb NOT NULL;
ALTER TABLE "redteam_runs" ADD COLUMN IF NOT EXISTS "platform_held" integer DEFAULT 0 NOT NULL;
ALTER TABLE "redteam_runs" ADD COLUMN IF NOT EXISTS "corpus_version" integer;
ALTER TABLE "redteam_runs" ADD COLUMN IF NOT EXISTS "preset_tightened" jsonb DEFAULT '[]'::jsonb NOT NULL;

-- ---------------------------------------------------------------------------
-- One row per TRIAL. `eval_run_id` is nullable: a trial containing only
-- sequence/agentic probes has no eval run, because those probes cannot be
-- `eval_cases` rows. They are still governed, metered and audited — they simply
-- have no eval-run wrapper.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "redteam_trials" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "run_id" uuid NOT NULL REFERENCES "redteam_runs"("id") ON DELETE cascade,
  "trial" integer NOT NULL,
  "eval_run_id" uuid REFERENCES "eval_runs"("id") ON DELETE set null,
  "probes" integer DEFAULT 0 NOT NULL,
  "defeated" integer DEFAULT 0 NOT NULL,
  "errored" integer DEFAULT 0 NOT NULL,
  "cost_usd" double precision DEFAULT 0 NOT NULL,
  "started_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "redteam_trials_run_trial_uq"
  ON "redteam_trials" ("run_id", "trial");

-- ---------------------------------------------------------------------------
-- One row per PROBE per TRIAL. The per-trial outcomes a reviewer needs to see
-- the variance rather than take a mean on trust, plus the agentic adjudication.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "redteam_probe_trials" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "run_id" uuid NOT NULL REFERENCES "redteam_runs"("id") ON DELETE cascade,
  "probe_key" text NOT NULL,
  "attack_class" text NOT NULL,
  "severity" text NOT NULL,
  "trial" integer NOT NULL,
  "defeated" boolean NOT NULL,
  "score" double precision NOT NULL,
  "error" text,
  "turns_dispatched" integer DEFAULT 1 NOT NULL,
  "output_snippet" text,
  "adjudication" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "redteam_probe_trials_class_ck" CHECK (
    "attack_class" IN (
      'prompt_injection', 'jailbreak', 'data_exfiltration', 'pii_leak', 'bias',
      'indirect_prompt_injection', 'tool_abuse', 'excessive_agency',
      'system_prompt_extraction', 'encoding_evasion'
    )
  ),
  CONSTRAINT "redteam_probe_trials_severity_ck"
    CHECK ("severity" IN ('low', 'medium', 'high', 'critical')),
  CONSTRAINT "redteam_probe_trials_trial_ck" CHECK ("trial" >= 1)
);
CREATE INDEX IF NOT EXISTS "redteam_probe_trials_run_idx"
  ON "redteam_probe_trials" ("run_id", "probe_key");
CREATE UNIQUE INDEX IF NOT EXISTS "redteam_probe_trials_uq"
  ON "redteam_probe_trials" ("run_id", "probe_key", "trial");

-- ---------------------------------------------------------------------------
-- ADR-0068 §5 — the compliance cascade's red-team dimension, on the SAME
-- `compliance_profiles` row as its PII mode and guardrail floor. There is
-- deliberately no parallel red-team policy store: an admin configures one
-- thing, and the composition rules are the cascade's existing ones (union for
-- the class set, MAX for the trial floor, strictest-wins for the severity
-- floor). NULL on every pre-0080 row = this framework has no red-team opinion,
-- and the caller's own request stands unchanged.
-- ---------------------------------------------------------------------------
ALTER TABLE "compliance_profiles" ADD COLUMN IF NOT EXISTS "redteam_gating_classes" jsonb;
ALTER TABLE "compliance_profiles" ADD COLUMN IF NOT EXISTS "redteam_min_trials" integer;
ALTER TABLE "compliance_profiles" ADD COLUMN IF NOT EXISTS "redteam_fail_on_severity" text;
