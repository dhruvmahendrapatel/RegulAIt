-- Migration 0066 (ADR-0054) — ONBOARDING WIZARD & MIGRATION/IMPORT TOOLING.
--
-- WHY THERE ARE ONLY TWO TABLES
--
--   ADR-0054's whole posture is that the wizard produces ORDINARY GOVERNED
--   STATE, not a parallel "setup" representation. So there is no table here for
--   roles, no table for mappings, no table for compliance settings — those land
--   in `roles`, `group_role_mappings` and `compliance_profiles` exactly as they
--   would if an admin had clicked through the existing console, which is what
--   makes the result exportable and reviewable as policy-as-code (ADR-0040) and
--   replayable into a second BYOC deployment.
--
--   What genuinely does not exist anywhere else is (1) HOW FAR THROUGH the
--   wizard this deployment is, and (2) WHAT AN IMPORT DID. Those are the two
--   tables.
--
-- ------------------------------------------------------------------------
-- onboarding_steps — the resumable checklist
-- ------------------------------------------------------------------------
--
-- THE PRIMARY KEY IS THE STEP KEY, AND THAT IS THE WHOLE IDEMPOTENCE STORY.
-- ADR-0054 names a non-idempotent re-run during a piecemeal BYOC install as the
-- failure it most fears: an admin closes the tab mid-step, comes back, and
-- re-runs. With `step_key` as the primary key there is exactly one row per step
-- in the entire deployment and an upsert is the ONLY thing a write can be —
-- "run the step twice" and "run it once" are the same row. There is no
-- wizard-session id, no per-attempt row, and therefore no way to accumulate a
-- second, contradictory answer to "is the IdP connected?".
--
-- WHY THERE IS NO `is_complete` BOOLEAN. `skipped` is a real answer and it is
-- not `pending`. An air-gapped deployment with no IdP has not left the wizard
-- half-done — it has made a decision, and the checklist has to be able to say
-- so, or an operator will be nagged forever by a step that will never be true.
--
-- THE `done <-> completed_at` CHECK is what stops a half-written transition:
-- a row cannot claim `done` without recording WHEN, and cannot record a
-- completion time while claiming it is still pending. An interrupted write
-- either landed as a complete transition or did not land.
--
-- WHY A `done` ROW IS STILL NOT PROOF. The status is what an ADMIN ASSERTED.
-- `GET /v1/onboarding` composes it with a LIVE readiness signal read out of the
-- objects that actually exist, and reports both. A step marked done whose
-- provider was later deleted shows `done` + `satisfied: false` rather than
-- quietly lying — the checklist is a record of intent, never a substitute for
-- the state.

CREATE TABLE "onboarding_steps" (
  -- ONE row per step, forever. The idempotence guarantee is structural.
  "step_key" text PRIMARY KEY NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  -- what the admin recorded alongside the step (which provider, which file,
  -- how many rows). Evidence, never a credential — the route refuses anything
  -- that looks like key material before it reaches this column.
  "detail" jsonb,
  "started_at" timestamp with time zone,
  "completed_at" timestamp with time zone,
  "completed_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "onboarding_steps_status_ck"
    CHECK ("status" IN ('pending', 'in_progress', 'done', 'skipped')),
  -- a completion is atomic: the flag and its timestamp agree or the row is
  -- refused by the database
  CONSTRAINT "onboarding_steps_done_ck"
    CHECK (("status" = 'done') = ("completed_at" IS NOT NULL))
);

-- ------------------------------------------------------------------------
-- onboarding_imports — what an import proposed, and what it did
-- ------------------------------------------------------------------------
--
-- EVERY IMPORT LANDS HERE, INCLUDING THE ONES THAT WERE REFUSED. That is the
-- point. A payload that tried to set `isAdmin` on a row is refused by the
-- schema and by the pre-parse screen, and the REFUSAL is a row here plus an
-- `audit_log` deny — because "somebody uploaded a file that tried to mint
-- administrators" is exactly the event an operator needs to be able to find
-- later, and an error message that scrolled past in a browser is not findable.
--
-- `mode` SEPARATES THE PREVIEW FROM THE ACT. A `dry_run` writes a `planned` row
-- and changes nothing else in the deployment; an `apply` writes an `applied`
-- row and the ordinary state beside it. Both compute their plan with the SAME
-- pure planner, so a preview can never be computed differently from the thing
-- it previews — which is the failure mode that makes dry-run features
-- worthless.
--
-- `payload_sha256` IS NOT A LOCK. Re-uploading the same file is allowed and
-- lands another row; idempotence comes from the planner reconciling against
-- current state (the second apply reports everything `unchanged`), not from
-- refusing a duplicate. Refusing on hash would break the legitimate case of
-- re-running an import after fixing something it reported.

CREATE TABLE "onboarding_imports" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "kind" text NOT NULL,
  "mode" text NOT NULL,
  "status" text NOT NULL,
  -- the exact bytes that were screened, fingerprinted — so "which file did
  -- this?" is answerable without storing a directory export forever
  "payload_sha256" text NOT NULL,
  "row_count" integer DEFAULT 0 NOT NULL,
  -- the plan the pure planner produced: the diff a dry-run showed, and the
  -- diff the apply acted on. Kept for both so the two can be compared.
  "plan" jsonb NOT NULL,
  -- what actually happened (null for a dry run, and for a refusal — nothing
  -- happened, which is the correct record)
  "result" jsonb,
  -- the stable rule id that also names the audit_log row, so an import in this
  -- table and its audit entry join on a value a human can read
  "rule_id" text NOT NULL,
  "reason" text NOT NULL,
  "requested_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "applied_at" timestamp with time zone,
  CONSTRAINT "onboarding_imports_kind_ck" CHECK ("kind" IN ('users', 'group_roles')),
  CONSTRAINT "onboarding_imports_mode_ck" CHECK ("mode" IN ('dry_run', 'apply')),
  CONSTRAINT "onboarding_imports_status_ck"
    CHECK ("status" IN ('planned', 'applied', 'refused')),
  -- an applied import records WHEN; a plan or a refusal never does
  CONSTRAINT "onboarding_imports_applied_ck"
    CHECK (("status" = 'applied') = ("applied_at" IS NOT NULL))
);
CREATE INDEX "onboarding_imports_created_idx" ON "onboarding_imports" ("created_at");
CREATE INDEX "onboarding_imports_kind_idx" ON "onboarding_imports" ("kind");
CREATE INDEX "onboarding_imports_status_idx" ON "onboarding_imports" ("status");
