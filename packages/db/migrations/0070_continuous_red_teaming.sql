-- Migration 0070 (ADR-0057) — CONTINUOUS RED-TEAMING.
--
-- WHAT IS NOT IN THIS MIGRATION, AND THAT IS THE WHOLE POINT
--
--   There is no redteam_cases table, no redteam_results table, no second
--   dispatch ledger and no second gate. A red-team probe is MATERIALIZED into
--   an ordinary `eval_cases` row and run by ADR-0044's `runEvalSuite` through
--   `executeGovernedDispatch` — so the prompt that was sent, the output that
--   came back, the entitlement check, the guardrail pass, the `usage_events`
--   cost row and the `audit_log` row are all the ones that already exist.
--   Promotion is blocked by the SAME `automated_check` → `blocked_on_check`
--   route a failed unit-test check takes; no new blocking mechanism exists.
--
--   Red-team results reach a model card through the EXISTING
--   `model_card_evidence` table (`kind = 'eval_run'`, ADR-0045 §5). There is
--   deliberately no parallel findings queue and no parallel approvals surface:
--   a defeat is a RECORD, and remediation runs through the workflow engine.
--
--   The four tables below add exactly what an eval run cannot express: WHICH
--   ATTACK LIBRARY VERSION scored it, which ATTACK CLASS each case attacks, how
--   SEVERE a defeat is, and which probes actually got through.
--
-- HONEST LIMITS BAKED INTO THE SHAPE
--
--   `redteam_runs.system_prompt_hash` exists because a red-team result is about
--   a CONFIGURATION, not about an agent's name: the same agent with an edited
--   system prompt is a different thing under attack, and the baseline
--   comparison must be able to say so.
--
--   `class_summary` is denormalised jsonb rather than a per-class table. The
--   per-class numbers are a derived reading of `eval_results`, recomputable at
--   any time; storing them keeps the gate's inputs exactly as they were at
--   verdict time, which is what makes a historical verdict re-readable.

-- ------------------------------------------------------------------------
-- redteam_libraries — attacks are DATA, and data is versioned
-- ------------------------------------------------------------------------
--
-- A library version FREEZES on publish, because publish is the moment it
-- becomes an eval dataset a run can score against, and a result stamped with a
-- library version is meaningless if the library can move underneath it. Editing
-- a published library mints the next version — the identical discipline
-- `eval_datasets` already applies to its cases.
--
-- `eval_dataset_id` IS the "reuse ADR-0044's harness" decision expressed in the
-- schema: a published library points at an eval dataset, and there is no
-- red-team runner for it to point at instead. ON DELETE RESTRICT so the dataset
-- that a stamped result was scored against cannot be deleted out from under it.

CREATE TABLE "redteam_libraries" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "version" integer DEFAULT 1 NOT NULL,
  "note" text,
  "status" text DEFAULT 'draft' NOT NULL,
  "eval_dataset_id" uuid REFERENCES "eval_datasets"("id") ON DELETE RESTRICT,
  "eval_dataset_version" integer,
  "published_at" timestamp with time zone,
  "created_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "redteam_libraries_status_ck" CHECK ("status" IN ('draft', 'published')),
  -- a published library MUST name the dataset it was materialized into: a
  -- "published" row with no dataset would be a library nothing can run
  CONSTRAINT "redteam_libraries_published_ck" CHECK (
    "status" <> 'published'
    OR ("eval_dataset_id" IS NOT NULL AND "eval_dataset_version" IS NOT NULL AND "published_at" IS NOT NULL)
  )
);
CREATE UNIQUE INDEX "redteam_libraries_name_version_uq"
  ON "redteam_libraries" ("name", "version");

-- ------------------------------------------------------------------------
-- redteam_probes — one adversarial prompt plus the oracle that judges it
-- ------------------------------------------------------------------------
--
-- The oracle is an ordinary ADR-0044 scorer config with INVERTED meaning: the
-- `forbidden` markers describe the DISCLOSURE, and a score of 1.0 means the
-- agent RESISTED. `validateRedTeamProbe` refuses an oracle that cannot report a
-- defeat (a `contains` with no forbidden markers, a non-negated `regex`) at
-- authoring time, for the same reason ADR-0044 refuses a `contains` with no
-- needles: a suite in which no case can fail is theatre.
--
-- The scorer kinds that match a reference answer (exact / numeric /
-- json_schema) are refused in code rather than by CHECK, because the refusal
-- carries a sentence explaining WHY, and a constraint violation cannot.

CREATE TABLE "redteam_probes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "library_id" uuid NOT NULL REFERENCES "redteam_libraries"("id") ON DELETE CASCADE,
  "probe_key" text NOT NULL,
  "attack_class" text NOT NULL,
  "severity" text DEFAULT 'high' NOT NULL,
  "input" text NOT NULL,
  "scorer_kind" text NOT NULL,
  "scorer_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "expected" jsonb,
  "note" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "redteam_probes_class_ck" CHECK (
    "attack_class" IN ('prompt_injection', 'jailbreak', 'data_exfiltration', 'pii_leak', 'bias')
  ),
  CONSTRAINT "redteam_probes_severity_ck"
    CHECK ("severity" IN ('low', 'medium', 'high', 'critical'))
);
CREATE UNIQUE INDEX "redteam_probes_library_key_uq" ON "redteam_probes" ("library_id", "probe_key");
CREATE INDEX "redteam_probes_class_idx" ON "redteam_probes" ("attack_class");

-- ------------------------------------------------------------------------
-- redteam_runs — the SECURITY READING of exactly one eval_runs row
-- ------------------------------------------------------------------------
--
-- `eval_run_id` is UNIQUE and ON DELETE RESTRICT. Unique, so two verdicts can
-- never claim the same evidence; restrict, so a red-team verdict can never be
-- detached from the governed, metered, audited dispatches that produced it.
-- Every token this run spent is already in `usage_events` under the run's
-- project with the `redteam` origin tag on its detail, so adversarial traffic
-- is separable from real usage in the pillar-5 dashboard rather than polluting
-- it.

CREATE TABLE "redteam_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "library_id" uuid NOT NULL REFERENCES "redteam_libraries"("id") ON DELETE RESTRICT,
  "library_name" text NOT NULL,
  "library_version" integer NOT NULL,
  "eval_run_id" uuid NOT NULL REFERENCES "eval_runs"("id") ON DELETE RESTRICT,
  "agent_id" uuid REFERENCES "agents"("id") ON DELETE SET NULL,
  "agent_name" text NOT NULL,
  "model" text,
  -- a red-team result is about a CONFIGURATION, not about a name
  "system_prompt_hash" text,
  "initiated_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  -- FK-free like the rest of the pillar-5 attribution columns
  "project_id" uuid,
  "trigger" text DEFAULT 'manual' NOT NULL,
  "probes" integer DEFAULT 0 NOT NULL,
  "resisted" integer DEFAULT 0 NOT NULL,
  "defeated" integer DEFAULT 0 NOT NULL,
  "resist_rate" double precision,
  "mean_score" double precision,
  "class_summary" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "gating_classes" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "baseline_run_id" uuid,
  "gate_passed" boolean,
  "regression" boolean DEFAULT false NOT NULL,
  "gate_reason" text,
  "cost_usd" double precision DEFAULT 0 NOT NULL,
  "note" text,
  "started_at" timestamp with time zone DEFAULT now() NOT NULL,
  "finished_at" timestamp with time zone,
  CONSTRAINT "redteam_runs_counts_ck" CHECK ("resisted" + "defeated" = "probes")
);
CREATE UNIQUE INDEX "redteam_runs_eval_run_uq" ON "redteam_runs" ("eval_run_id");
CREATE INDEX "redteam_runs_agent_idx" ON "redteam_runs" ("agent_id", "started_at");
CREATE INDEX "redteam_runs_library_idx" ON "redteam_runs" ("library_id");

-- ------------------------------------------------------------------------
-- redteam_findings — a defeat, pointing at the transcript that proves it
-- ------------------------------------------------------------------------
--
-- One row per probe that GOT THROUGH, referencing the `eval_results` row with
-- the actual output and the scorer's evidence. A finding therefore cannot drift
-- from what the agent really said, and "which attack succeeded, and what did it
-- produce" is one join.
--
-- This is a RECORD, not a queue. There is no status column, no assignee and no
-- decision here on purpose: remediation is a workflow, and a sign-off is an
-- `approvals` row. A second inbox would be a second place for a security
-- decision to be made, which is exactly what ADR-0057 refuses.

CREATE TABLE "redteam_findings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "run_id" uuid NOT NULL REFERENCES "redteam_runs"("id") ON DELETE CASCADE,
  "probe_id" uuid REFERENCES "redteam_probes"("id") ON DELETE SET NULL,
  "probe_key" text NOT NULL,
  "attack_class" text NOT NULL,
  "severity" text NOT NULL,
  "score" double precision NOT NULL,
  "eval_result_id" uuid REFERENCES "eval_results"("id") ON DELETE SET NULL,
  "output_snippet" text,
  "detail" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "redteam_findings_class_ck" CHECK (
    "attack_class" IN ('prompt_injection', 'jailbreak', 'data_exfiltration', 'pii_leak', 'bias')
  ),
  CONSTRAINT "redteam_findings_severity_ck"
    CHECK ("severity" IN ('low', 'medium', 'high', 'critical'))
);
CREATE INDEX "redteam_findings_run_idx" ON "redteam_findings" ("run_id");
CREATE INDEX "redteam_findings_class_idx" ON "redteam_findings" ("attack_class", "severity");
