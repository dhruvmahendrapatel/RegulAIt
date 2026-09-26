-- ADR-0065 — REGULAIT-LLM: custom-model creation, training and governance.
--
-- WHAT THIS IS, IN ONE SENTENCE THAT HAS TO STAY TRUE
--
--   These tables record MODEL CUSTOMISATION — a versioned, PII-scanned training
--   dataset, a job that consumed exactly one version of it on a named backend,
--   and the artifact that came out — under the same governance every other
--   model in this product already carries. They do NOT claim that this codebase
--   trains frontier models. It cannot: there is no GPU and no training runtime
--   in a Node/Fastify process, and pretending otherwise is precisely the
--   overclaiming ADR-0042's `tier: 'heuristic'` labelling and ADR-0044's
--   "mechanism-proven, judgment-unverified" language exist to prevent.
--
--   The `local` backend is REAL and runs to completion in-process, because what
--   it does is genuinely small-scale: it builds a TF-IDF retrieval index, or
--   trains a multinomial logistic-regression classifier by actual gradient
--   descent, over the uploaded rows. Both produce a queryable artifact that
--   answers from the training data, and both are labelled with the method they
--   really used (`retrieval_index` / `text_classifier`) — never "fine-tuned
--   LLM". The four REAL adapters (huggingface, together, bedrock, vertex) carry
--   the API shape and the poll loop and refuse honestly, with a typed error and
--   an audit row, when no credential/compute is configured. That refusal is the
--   feature: `custom-providers.ts` (ADR-0034) takes exactly the same posture.
--
-- FIVE PROPERTIES THE DDL BELOW EXISTS TO ENFORCE
--
--  1. DATASET IMMUTABILITY, THE ADR-0044 WAY. `training_datasets` carries a
--     UNIQUE (id, version) so a job's (dataset_id, dataset_version) pair is a
--     real composite FK, not a hopeful pair of columns. A job therefore records
--     exactly what it trained on and that version cannot move underneath it —
--     the same discipline `eval_datasets` uses, for the same reason: a claim
--     about a model is meaningless if the data behind it can be edited later.
--     The FK is ON DELETE RESTRICT: a dataset version a job cites cannot be
--     deleted out from under the artifact that came from it.
--
--  2. THE PII VERDICT IS PART OF THE ROW, NOT A LOG LINE. `pii_verdict` and the
--     COUNTS-ONLY `scan_findings` are columns on the dataset version, because
--     "was this training corpus scanned, and what did the scan say" is a
--     question an auditor asks about the DATA, months after the audit row that
--     recorded the scan has scrolled away. Counts only — never matched text —
--     the same §8.4 / ADR-0042 contract every other detector surface honours.
--
--  3. AN ARTIFACT IS A GOVERNED MODEL OR IT IS NOTHING. `training_artifacts`
--     carries the optional `agent_id` it was registered as and the
--     `model_card_id` (ADR-0045) that governs it. A home-trained model is
--     dispatched through `executeGovernedDispatch` like any vendor one, so the
--     MRM gate, entitlements, guardrails, PII and the usage ledger all apply
--     with no special case.
--
--  4. AN EXPENSIVE JOB GOES TO THE ONE APPROVALS QUEUE. `approval_id` points at
--     a row in `approvals` (object_type 'training_job' — a TS-only widening,
--     that column has no DB CHECK). There is no second inbox and no second
--     decide path: the decision comes back through
--     POST /v1/approvals/:id/decide with its separation-of-duties guards intact.
--
--  5. A BACKEND'S CREDENTIAL IS A CREDENTIAL. `training_backend_configs`
--     stores the key as AES-256-GCM ciphertext under REGULAIT_DATA_KEY and the
--     base_url is adjudicated by the ADR-0034/0062 egress guard on write AND on
--     every use — DNS can be re-pointed after an admin approves a host.

-- ---------------------------------------------------------------------------
-- 1. training_datasets — the immutable, versioned, PII-scanned corpus
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "training_datasets" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  -- monotonic per NAME. Version 1 is minted on create; every later version is
  -- minted by copying, never by editing (see the FK note in the header).
  "version" integer NOT NULL DEFAULT 1,
  "note" text,
  -- how the rows are shaped. A closed vocabulary: a corpus whose shape the
  -- validator does not understand is a corpus nothing can honestly check.
  "format" text NOT NULL DEFAULT 'prompt_completion',
  "row_count" integer NOT NULL DEFAULT 0,
  -- total characters across every row's input+output. The cost estimator's
  -- input, and the thing that makes "is this job expensive?" answerable before
  -- the job runs rather than after it has billed.
  "char_count" integer NOT NULL DEFAULT 0,
  -- sha256 over the canonical row serialisation. Two datasets with the same
  -- checksum are the same corpus; a version whose checksum changed without a
  -- new version number would be a bug this makes visible.
  "checksum" text NOT NULL DEFAULT '',
  -- --- the ADR-0042 / §8.4 ingest scan -----------------------------------
  -- clean    nothing fired
  -- flagged  something fired and the configured mode was log/warn — ACCEPTED,
  --          and the row says so forever
  -- blocked  something fired at 'block'. A blocked scan NEVER produces a row:
  --          this value exists so a rejected attempt can be recorded by an
  --          operator importing an audit trail, not because the pipeline
  --          writes it.
  "pii_verdict" text NOT NULL DEFAULT 'clean',
  -- the mode actually in force for this ingest, after MAX-composition with the
  -- project's compliance floor. Recorded because "why was this accepted?" is
  -- unanswerable from the verdict alone.
  "pii_mode" text NOT NULL DEFAULT 'block',
  -- COUNTS ONLY. {"pii":[{"category":"email","count":3}],"guardrails":[...]}
  "scan_findings" jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- pillar 5 attribution + the pillar-4 project whose compliance cascade set
  -- the PII floor above. NULL = unattributed (no floor, no lineage capture).
  "project_id" uuid,
  "created_by_user_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "training_datasets_name_version_uq" UNIQUE ("name", "version"),
  -- THE COMPOSITE FK TARGET. This is the whole immutability mechanism: without
  -- it, `training_jobs.dataset_version` would be a number somebody hoped was
  -- right. Cf. eval_datasets / eval_runs (ADR-0044).
  CONSTRAINT "training_datasets_id_version_uq" UNIQUE ("id", "version"),
  CONSTRAINT "training_datasets_version_check" CHECK ("version" >= 1),
  CONSTRAINT "training_datasets_format_check"
    CHECK ("format" IN ('prompt_completion', 'classification', 'documents')),
  CONSTRAINT "training_datasets_verdict_check"
    CHECK ("pii_verdict" IN ('clean', 'flagged', 'blocked')),
  CONSTRAINT "training_datasets_pii_mode_check"
    CHECK ("pii_mode" IN ('off', 'log', 'warn', 'block')),
  CONSTRAINT "training_datasets_project_fk" FOREIGN KEY ("project_id")
    REFERENCES "projects" ("id") ON DELETE SET NULL,
  CONSTRAINT "training_datasets_user_fk" FOREIGN KEY ("created_by_user_id")
    REFERENCES "users" ("id") ON DELETE SET NULL
);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. training_dataset_rows — the corpus itself, pinned to ONE version
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "training_dataset_rows" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "dataset_id" uuid NOT NULL,
  -- carried explicitly and FK'd as a PAIR. A row belongs to a dataset VERSION,
  -- not to a dataset — that is what makes minting v2 a copy rather than an edit.
  "dataset_version" integer NOT NULL,
  "idx" integer NOT NULL,
  -- the prompt / document / text to classify
  "input" text NOT NULL,
  -- the completion / label. NULL is legal for the `documents` format, where
  -- there is nothing to predict and the corpus is retrieval material.
  "output" text,
  "tags" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "training_dataset_rows_dataset_fk"
    FOREIGN KEY ("dataset_id", "dataset_version")
    REFERENCES "training_datasets" ("id", "version") ON DELETE CASCADE,
  CONSTRAINT "training_dataset_rows_idx_uq" UNIQUE ("dataset_id", "dataset_version", "idx")
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "training_dataset_rows_version_idx"
  ON "training_dataset_rows" ("dataset_id", "dataset_version", "idx");
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. training_backend_configs — where a REAL backend's credential lives
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "training_backend_configs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  -- one config per backend kind. 'local' and 'mock' never need one; a row for
  -- them is legal and simply carries no key.
  "backend" text NOT NULL UNIQUE,
  -- default FALSE, exactly like custom_model_providers: registering is not
  -- enabling, and nothing is contacted until an admin says so.
  "enabled" boolean NOT NULL DEFAULT false,
  -- the API root. Adjudicated by the ADR-0034/0062 egress guard on write and
  -- again on every use. NULL = the adapter's own compiled default, which is
  -- itself adjudicated under a strict posture (ADR-0062).
  "base_url" text,
  -- AES-256-GCM under REGULAIT_DATA_KEY. Write-only; never returned by a route.
  "key_ciphertext" text,
  "allow_plaintext_http" boolean NOT NULL DEFAULT false,
  -- free-form per-backend settings the adapter needs and that are NOT secret
  -- (an AWS region, a GCP project id, a HF namespace).
  "settings" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "last_tested_at" timestamp with time zone,
  "last_test_error" text,
  "created_by_user_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "training_backend_configs_backend_check"
    CHECK ("backend" IN ('local', 'mock', 'huggingface', 'together', 'bedrock', 'vertex')),
  CONSTRAINT "training_backend_configs_user_fk" FOREIGN KEY ("created_by_user_id")
    REFERENCES "users" ("id") ON DELETE SET NULL
);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 4. training_jobs — one run of one method, on ONE pinned dataset version
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "training_jobs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "dataset_id" uuid NOT NULL,
  "dataset_version" integer NOT NULL,
  "backend" text NOT NULL,
  -- WHAT WAS ACTUALLY DONE. `retrieval_index` and `text_classifier` are what
  -- the local backend really produces; the LLM fine-tuning methods are only
  -- reachable on a credentialed real backend, and this column is how a reader
  -- tells the two apart without trusting a label somebody typed.
  "method" text NOT NULL,
  -- the model being customised. NULL for a local retrieval index, which
  -- derives from no model at all — recording a base model there would be the
  -- first lie in the chain.
  "base_model" text,
  -- the registry agent this customisation is ANCHORED to: whose entitlement
  -- gated the job, and whose tier the resulting artifact inherits when it is
  -- registered for inference. You cannot train a derivative of a model you are
  -- not entitled to use.
  "base_agent_id" uuid,
  "hyperparameters" jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- pending_approval → queued → running → succeeded | failed | cancelled
  -- refused = a real backend declined honestly (no credential, no compute).
  -- It is a TERMINAL state distinct from `failed` on purpose: "we never tried"
  -- and "we tried and it broke" are different facts about a model.
  "status" text NOT NULL DEFAULT 'queued',
  "progress" double precision NOT NULL DEFAULT 0,
  -- the backend's own job id, for a remote adapter's poll loop
  "external_job_id" text,
  "error" text,
  -- pillar 5. `estimated_cost_usd` is what the approval gate compared against
  -- BEFORE the job ran; `cost_usd` is what actually landed in usage_events.
  -- Keeping both is what makes "the estimate was wrong" a visible fact.
  "estimated_cost_usd" double precision NOT NULL DEFAULT 0,
  "cost_usd" double precision,
  "project_id" uuid,
  "initiated_by_user_id" uuid,
  -- the ONE Approvals Queue row gating an over-threshold job (object_type
  -- 'training_job'). NULL = under threshold, no approval was ever required.
  "approval_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "started_at" timestamp with time zone,
  "finished_at" timestamp with time zone,
  "duration_ms" integer,
  CONSTRAINT "training_jobs_dataset_fk"
    FOREIGN KEY ("dataset_id", "dataset_version")
    REFERENCES "training_datasets" ("id", "version") ON DELETE RESTRICT,
  CONSTRAINT "training_jobs_agent_fk" FOREIGN KEY ("base_agent_id")
    REFERENCES "agents" ("id") ON DELETE SET NULL,
  CONSTRAINT "training_jobs_project_fk" FOREIGN KEY ("project_id")
    REFERENCES "projects" ("id") ON DELETE SET NULL,
  CONSTRAINT "training_jobs_user_fk" FOREIGN KEY ("initiated_by_user_id")
    REFERENCES "users" ("id") ON DELETE SET NULL,
  CONSTRAINT "training_jobs_approval_fk" FOREIGN KEY ("approval_id")
    REFERENCES "approvals" ("id") ON DELETE SET NULL,
  CONSTRAINT "training_jobs_backend_check"
    CHECK ("backend" IN ('local', 'mock', 'huggingface', 'together', 'bedrock', 'vertex')),
  CONSTRAINT "training_jobs_method_check"
    CHECK ("method" IN ('retrieval_index', 'text_classifier', 'lora_sft', 'full_sft', 'dpo')),
  CONSTRAINT "training_jobs_status_check"
    CHECK ("status" IN ('pending_approval', 'queued', 'running', 'succeeded', 'failed', 'cancelled', 'refused')),
  CONSTRAINT "training_jobs_progress_check" CHECK ("progress" >= 0 AND "progress" <= 1)
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "training_jobs_status_idx" ON "training_jobs" ("status", "created_at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "training_jobs_dataset_idx" ON "training_jobs" ("dataset_id", "dataset_version");
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 5. training_artifacts — what came out, and how it is governed
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "training_artifacts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "job_id" uuid NOT NULL,
  "name" text NOT NULL,
  "method" text NOT NULL,
  "base_model" text,
  -- inline  the artifact IS the `payload` below and is queryable in-process.
  --         This is what the local backend produces and the only kind this
  --         deployment can actually run inference against.
  -- remote  the artifact lives at `location` on the training backend. We hold
  --         a reference and the metrics it reported; we cannot query it here,
  --         and the API says so rather than pretending.
  "kind" text NOT NULL DEFAULT 'inline',
  -- the real, queryable model for an inline artifact: the TF-IDF index or the
  -- classifier's learned weights. jsonb because it IS structured data and a
  -- reader should be able to see the vocabulary a model learned.
  "payload" jsonb,
  "location" text,
  -- whatever the trainer MEASURED — train/eval accuracy, final loss, index
  -- size. Never a figure nothing computed.
  "metrics" jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- the registry agent this artifact was registered as, so the platform can
  -- dispatch to it under the ordinary governed path. NULL = trained but not
  -- yet promoted to something anybody can call.
  "agent_id" uuid,
  -- ADR-0045. A home-trained model is subject to the MRM gate exactly like a
  -- vendor one; this is the card that carries its risk position.
  "model_card_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "training_artifacts_job_fk" FOREIGN KEY ("job_id")
    REFERENCES "training_jobs" ("id") ON DELETE CASCADE,
  CONSTRAINT "training_artifacts_agent_fk" FOREIGN KEY ("agent_id")
    REFERENCES "agents" ("id") ON DELETE SET NULL,
  CONSTRAINT "training_artifacts_card_fk" FOREIGN KEY ("model_card_id")
    REFERENCES "model_cards" ("id") ON DELETE SET NULL,
  CONSTRAINT "training_artifacts_kind_check" CHECK ("kind" IN ('inline', 'remote')),
  CONSTRAINT "training_artifacts_method_check"
    CHECK ("method" IN ('retrieval_index', 'text_classifier', 'lora_sft', 'full_sft', 'dpo')),
  -- an inline artifact must carry its payload and a remote one its location:
  -- an artifact that is neither queryable nor locatable is a row claiming a
  -- model exists somewhere nobody can name.
  CONSTRAINT "training_artifacts_body_check" CHECK (
    ("kind" = 'inline' AND "payload" IS NOT NULL)
    OR ("kind" = 'remote' AND "location" IS NOT NULL)
  )
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "training_artifacts_job_uq" ON "training_artifacts" ("job_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "training_artifacts_agent_idx" ON "training_artifacts" ("agent_id");
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 6. The org dials
-- ---------------------------------------------------------------------------
--
-- Two, and only two. `llm_training_enabled` is the master switch (ADR-0034's
-- `customModelProvidersEnabled` precedent: a capability an org may not want at
-- all should be refusable in one place, honestly, rather than by removing every
-- grant). `llm_training_approval_threshold_usd` is where the ONE Approvals
-- Queue takes over: an estimated cost at or above it does not start, it queues.
-- 5 USD is a deliberately low default — the wrong failure mode here is a
-- surprise bill, and an org that wants unattended training raises it on purpose.

ALTER TABLE "org_settings"
  ADD COLUMN IF NOT EXISTS "llm_training_enabled" boolean NOT NULL DEFAULT true;
--> statement-breakpoint
ALTER TABLE "org_settings"
  ADD COLUMN IF NOT EXISTS "llm_training_approval_threshold_usd" double precision NOT NULL DEFAULT 5;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 7. Lineage vocabulary (ADR-0050)
-- ---------------------------------------------------------------------------
--
-- dataset → job → artifact must be traversable in the ONE provenance graph, not
-- in a second one. `LINEAGE_SUBTYPES` is a deliberately CLOSED vocabulary with
-- a DB CHECK behind it — "a new kind of traceable object is a deliberate act,
-- not a typo in a text column" — so widening it is a migration, which is
-- exactly the friction that comment was asking for.

ALTER TABLE "lineage_nodes" DROP CONSTRAINT IF EXISTS "lineage_nodes_subtype_check";
--> statement-breakpoint
ALTER TABLE "lineage_nodes" ADD CONSTRAINT "lineage_nodes_subtype_check" CHECK ("subtype" IN (
  'context_item','workflow_artifact','connector_result','mcp_result','document',
  'run_node','agent_dispatch','dispatch_output','pull_request','pm_work_item',
  -- ADR-0065: the training chain. `training_dataset` is a SOURCE (a pinned
  -- corpus version), `training_job` is a RUN (the thing that consumed it), and
  -- `model_artifact` is an OUTPUT (the model that came out) — which is why no
  -- new node KIND was needed: a training run is a run.
  'training_dataset','training_job','model_artifact'
));
