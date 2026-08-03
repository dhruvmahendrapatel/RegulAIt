-- Migration 0056 (ADR-0044) — the AGENT EVALUATION & REGRESSION HARNESS: the
-- schema that lets the platform answer the one question every existing gate
-- refuses to answer. Today RegulAIt can prove a dispatch was GOVERNED, METERED
-- and AUDITED (ADR-0019/0024). It cannot prove a config change did not make the
-- agent WORSE. A prompt edit, a routing-tier drop (pillar 6), or a swapped
-- custom_provider endpoint all sail through every check we have, because those
-- checks examine authority and cost, never output quality.
--
-- WHAT THIS SCHEMA HAS TO HOLD, AND WHY EACH PIECE EXISTS
--
--  1. A GATE IS ONLY TRUSTWORTHY IF THE RULER CANNOT MOVE. `eval_datasets` is
--     one row PER (name, version) — not one row per dataset with a mutable case
--     list. A version is frozen the moment an `eval_runs` row references it
--     (enforced in the gateway, which refuses a case write against a referenced
--     version); editing cases mints version N+1 instead. Without this, a red
--     check is always arguable as "the dataset changed", and an arguable gate
--     is a gate that gets worked around.
--
--  2. THE CASE→VERSION BINDING IS A DATABASE CONSTRAINT, NOT A CONVENTION.
--     `eval_cases` and `eval_runs` carry (dataset_id, dataset_version) and
--     point at the COMPOSITE unique key (id, version) on eval_datasets. A case
--     can therefore never claim a version its dataset row does not have — the
--     denormalized `dataset_version` ADR-0044 asks for is kept honest by the
--     FK rather than by every future caller remembering to set it right.
--
--  3. A RUN SNAPSHOTS THE THING IT MEASURED. agent_name, model, tier and a HASH
--     of the agent's ADR-0023 system prompt are copied onto the run. Those four
--     fields ARE the levers ADR-0044 exists to police, so "run B regressed
--     against run A" is only actionable next to "and here is what differed".
--     The hash, not the prompt: a system prompt is a governance artifact that
--     lives in `agents`, and copying its text into a second table would create
--     a second, drifting copy of it.
--
--  4. THE BASELINE IS DATA, NOT A DERIVED GUESS. `is_baseline` marks the run an
--     admin pinned as the reference; `baseline_run_id` records which run THIS
--     run was actually compared against, alongside the resulting deltas and the
--     gate verdict. A gate result must remain reconstructible months later even
--     if the baseline has since moved — so the comparison is stored, not
--     recomputed on read.
--
--  5. NO NEW LEDGER, AGAIN. There is no eval_audit table and no eval_cost
--     table: every eval dispatch goes through executeGovernedDispatch, so its
--     spend lands in the SINGLE `usage_events` ledger (ADR-0019/0024) and its
--     decisions in the SINGLE `audit_log` (object_type 'eval_run', a plain-text
--     column — no DDL, the pattern ADR-0024/0034 established). `cost_usd` on
--     the run/result rows is a ROLL-UP of those metered rows for display, never
--     a second source of truth.
--
--  6. OUTPUTS ARE STORED, TRUNCATED, AND NEVER STORED WHEN WITHHELD. A
--     regression you cannot read is a regression you cannot act on, so
--     `eval_results.output_text` keeps the (truncated) model output. When a PII
--     or ADR-0042 guardrail block withheld the output, the withheld marker is
--     what gets stored — the eval path is not a bypass, including for storage.

-- --------------------------------------------------------------------------
-- Golden datasets — immutable once referenced
-- --------------------------------------------------------------------------

CREATE TABLE "eval_datasets" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  -- one ROW per version. v1 and v2 of "refusal-discipline" are two rows with
  -- two ids, which is what makes "pinned and cannot move underneath the run"
  -- expressible as a foreign key instead of as a policy.
  "version" integer NOT NULL DEFAULT 1,
  "note" text,
  -- the dataset-level DEFAULT scorer; a case may override both (ADR-0044 §2:
  -- "selected per dataset (or per case)")
  "scorer_kind" text NOT NULL DEFAULT 'contains',
  "scorer_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_by_user_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "eval_datasets_version_check" CHECK ("version" >= 1),
  CONSTRAINT "eval_datasets_scorer_kind_check" CHECK ("scorer_kind" IN
    ('exact','contains','regex','json_schema','numeric','rubric','llm_as_judge'))
);
--> statement-breakpoint

ALTER TABLE "eval_datasets" ADD CONSTRAINT "eval_datasets_created_by_user_id_fk"
  FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint

-- one row per (name, version): minting v2 of a name is legal, minting v2 twice
-- is not
CREATE UNIQUE INDEX "eval_datasets_name_version_uq" ON "eval_datasets" USING btree ("name","version");
--> statement-breakpoint
-- the COMPOSITE key cases and runs point at, so a child row can never name a
-- version its parent does not have
ALTER TABLE "eval_datasets" ADD CONSTRAINT "eval_datasets_id_version_uq" UNIQUE ("id","version");
--> statement-breakpoint

-- --------------------------------------------------------------------------
-- Cases
-- --------------------------------------------------------------------------

CREATE TABLE "eval_cases" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "dataset_id" uuid NOT NULL,
  "dataset_version" integer NOT NULL,
  -- what is sent to the agent under test
  "input" text NOT NULL,
  -- the reference answer: a string, a number, or a JSON object/array. NULL for
  -- cases whose scorer needs no reference (a regex or json_schema case).
  "expected" jsonb,
  -- ADR-0044 §2's structured checklist, when the case is rubric-scored
  "rubric" jsonb,
  -- jsonb rather than the ADR's text[]: every array in this schema is jsonb
  -- (agents.modes, guardrail_configs.custom_terms, …) and one table using a
  -- native array would be the only place a reader has to switch idioms
  "tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
  -- NULL = inherit the dataset's default scorer
  "scorer_kind" text,
  "scorer_config" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "eval_cases_scorer_kind_check" CHECK ("scorer_kind" IS NULL OR "scorer_kind" IN
    ('exact','contains','regex','json_schema','numeric','rubric','llm_as_judge'))
);
--> statement-breakpoint

ALTER TABLE "eval_cases" ADD CONSTRAINT "eval_cases_dataset_version_fk"
  FOREIGN KEY ("dataset_id","dataset_version") REFERENCES "public"."eval_datasets"("id","version")
  ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint

CREATE INDEX "eval_cases_dataset_idx" ON "eval_cases" USING btree ("dataset_id","dataset_version");
--> statement-breakpoint

-- --------------------------------------------------------------------------
-- Runs
-- --------------------------------------------------------------------------

CREATE TABLE "eval_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "dataset_id" uuid NOT NULL,
  "dataset_version" integer NOT NULL,
  -- the agent under test. ON DELETE set null keeps the historical record: a
  -- deleted agent must not erase the evidence of how it scored.
  "agent_id" uuid,
  "custom_provider_id" uuid,
  -- §3 snapshot of WHAT was measured — the four ADR-0044 levers
  "agent_name" text NOT NULL,
  "model" text,
  "tier" integer,
  "system_prompt_hash" text,
  -- ADR-0044 §6: the judge is PINNED on the run, so "which judge, at what cost"
  -- is always answerable and a gate result can never be silently re-scored by a
  -- different instrument.
  "judge_agent_id" uuid,
  "judge_impl" text,
  "trigger" text NOT NULL,
  "status" text NOT NULL DEFAULT 'running',
  "mode" text NOT NULL DEFAULT 'execute',
  "initiated_by_user_id" uuid,
  "project_id" uuid,
  -- set when the run IS a workflow automated_check (ADR-0044 §4)
  "workflow_instance_id" uuid,
  "workflow_stage_id" text,
  "workflow_check_name" text,
  -- gate configuration, recorded so a verdict stays reconstructible
  "tolerance" double precision DEFAULT 0.05 NOT NULL,
  "min_score" double precision,
  "min_pass_rate" double precision,
  -- aggregate
  "cases" integer DEFAULT 0 NOT NULL,
  "passed_cases" integer DEFAULT 0 NOT NULL,
  "mean_score" double precision,
  "pass_rate" double precision,
  -- roll-up of the metered usage_events rows this run produced (display only)
  "cost_usd" double precision DEFAULT 0 NOT NULL,
  "input_tokens" integer DEFAULT 0 NOT NULL,
  "output_tokens" integer DEFAULT 0 NOT NULL,
  -- the stored comparison: which run, what delta, what verdict
  "baseline_run_id" uuid,
  "score_delta" double precision,
  "pass_rate_delta" double precision,
  "gate_passed" boolean,
  "regression" boolean,
  "gate_reason" text,
  -- the admin-pinned reference for (dataset version, agent)
  "is_baseline" boolean DEFAULT false NOT NULL,
  "error" text,
  "note" text,
  "started_at" timestamp with time zone DEFAULT now() NOT NULL,
  "finished_at" timestamp with time zone,
  CONSTRAINT "eval_runs_trigger_check" CHECK ("trigger" IN ('manual','workflow','scheduled')),
  CONSTRAINT "eval_runs_status_check" CHECK ("status" IN ('running','completed','error','denied')),
  CONSTRAINT "eval_runs_tolerance_check" CHECK ("tolerance" >= 0 AND "tolerance" <= 1)
);
--> statement-breakpoint

ALTER TABLE "eval_runs" ADD CONSTRAINT "eval_runs_dataset_version_fk"
  FOREIGN KEY ("dataset_id","dataset_version") REFERENCES "public"."eval_datasets"("id","version")
  ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
-- ON DELETE restrict above is the OTHER half of immutability: a dataset version
-- a run has scored cannot be deleted out from under the evidence.
ALTER TABLE "eval_runs" ADD CONSTRAINT "eval_runs_agent_id_fk"
  FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "eval_runs" ADD CONSTRAINT "eval_runs_custom_provider_id_fk"
  FOREIGN KEY ("custom_provider_id") REFERENCES "public"."custom_model_providers"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "eval_runs" ADD CONSTRAINT "eval_runs_judge_agent_id_fk"
  FOREIGN KEY ("judge_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "eval_runs" ADD CONSTRAINT "eval_runs_initiated_by_user_id_fk"
  FOREIGN KEY ("initiated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "eval_runs" ADD CONSTRAINT "eval_runs_project_id_fk"
  FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "eval_runs" ADD CONSTRAINT "eval_runs_workflow_instance_id_fk"
  FOREIGN KEY ("workflow_instance_id") REFERENCES "public"."workflow_instances"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "eval_runs" ADD CONSTRAINT "eval_runs_baseline_run_id_fk"
  FOREIGN KEY ("baseline_run_id") REFERENCES "public"."eval_runs"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint

CREATE INDEX "eval_runs_dataset_idx" ON "eval_runs" USING btree ("dataset_id","dataset_version","started_at");
--> statement-breakpoint
CREATE INDEX "eval_runs_agent_idx" ON "eval_runs" USING btree ("agent_id","started_at");
--> statement-breakpoint
-- AT MOST ONE pinned baseline per (dataset version, agent). Two pinned
-- baselines would make "the" comparison ambiguous, so the database refuses it
-- rather than leaving the runner to pick.
CREATE UNIQUE INDEX "eval_runs_baseline_uq" ON "eval_runs"
  USING btree ("dataset_id","dataset_version","agent_id") WHERE "is_baseline";
--> statement-breakpoint

-- --------------------------------------------------------------------------
-- Per-case results
-- --------------------------------------------------------------------------

CREATE TABLE "eval_results" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "run_id" uuid NOT NULL,
  "case_id" uuid,
  "scorer_kind" text NOT NULL,
  "score" double precision NOT NULL,
  "passed" boolean NOT NULL,
  "latency_ms" integer,
  "cost_usd" double precision,
  "input_tokens" integer DEFAULT 0 NOT NULL,
  "output_tokens" integer DEFAULT 0 NOT NULL,
  -- TRUNCATED, and carrying the withheld marker rather than the content when a
  -- PII/guardrail block acted — the eval path is not a storage bypass either
  "output_text" text,
  -- the judge's stated reasoning, so a red gate can be argued with
  "judge_rationale" text,
  -- why the dispatch itself failed (entitlement, budget, guardrail block,
  -- provider error) — distinct from "the answer scored badly"
  "error" text,
  "detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "eval_results_score_check" CHECK ("score" >= 0 AND "score" <= 1)
);
--> statement-breakpoint

ALTER TABLE "eval_results" ADD CONSTRAINT "eval_results_run_id_fk"
  FOREIGN KEY ("run_id") REFERENCES "public"."eval_runs"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "eval_results" ADD CONSTRAINT "eval_results_case_id_fk"
  FOREIGN KEY ("case_id") REFERENCES "public"."eval_cases"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint

-- one result per case per run: a re-scored case must UPDATE, never accumulate a
-- second opinion the aggregate would then double-count
CREATE UNIQUE INDEX "eval_results_run_case_uq" ON "eval_results" USING btree ("run_id","case_id");
