-- Migration 0085 (ADR-0076) — SCHEDULED COST RECONCILIATION.
--
-- ADR-0069 disclosed the gap this migration exists for, in its own §honest
-- limits: the row/byte bounds mean a large CUR must be chunked by the operator,
-- and "two overlapping chunks of the same CUR are two batches with different
-- fingerprints and will double-count. The fingerprint guard catches identical
-- bytes only." That is a wrong chargeback presented confidently — the exact
-- failure the whole slice was built to refuse — reachable by an ordinary
-- operator mistake.
--
-- THE ONE RULE THIS MIGRATION ENFORCES IN THE DATABASE
--
--   A duplicate imported line is MARKED, never deleted. `superseded_at` /
--   `superseded_by_line_id` / `superseded_reason` record that a NEWER batch
--   restated the same vendor fact; the row itself stays, because it is the
--   evidence of what the older file said and of what every read before the
--   reconciliation reported. A CHECK makes a mark without a reason impossible:
--   nothing can be quietly excluded from the consolidated view without a
--   sentence an auditor can read.
--
-- WHAT IS DELIBERATELY NOT HERE
--
--   No DELETE of any line, ever. Supersession is a read-side exclusion with a
--   disclosed count, not an erasure.
--
--   No automatic resolution of AMBIGUITY. When two batches carry the same
--   vendor fact at DIFFERENT multiplicities (batch C says a charge happened
--   twice, batch D says once), the reconciliation marks NOTHING for that group
--   and reports the conflict instead — a guessed dedup is a guessed invoice.
--   Overlapping-but-not-identical windows are likewise REPORTED, never
--   auto-superseded: a partial-period restatement with a different amount is
--   an operator decision (revoke and re-import), not a mechanical one.
--
--   No vendor polling. ADR-0069's posture stands: RegulAIt holds no billing
--   credential. The scheduled job re-examines rows we already hold.

-- ---------------------------------------------------------------------------
-- 1. The reconciliation run ledger. One row per pass, whether an operator
--    pressed "run now" or the ADR-0064 scheduler ticked. Mirrors
--    `scheduler_runs`' open-first shape: a row stuck at 'running' with a stale
--    started_at IS the diagnosis of a process that died mid-pass.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "cost_reconciliation_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "trigger" text DEFAULT 'manual' NOT NULL,
  "initiated_by_user_id" uuid,
  "started_at" timestamp with time zone DEFAULT now() NOT NULL,
  "finished_at" timestamp with time zone,
  "outcome" text DEFAULT 'running' NOT NULL,
  "scanned_lines" integer DEFAULT 0 NOT NULL,
  "duplicate_groups" integer DEFAULT 0 NOT NULL,
  "superseded_lines" integer DEFAULT 0 NOT NULL,
  "ambiguous_groups" integer DEFAULT 0 NOT NULL,
  "overlap_warnings" integer DEFAULT 0 NOT NULL,
  -- the bounded, structured conflict report — what was NOT touched, and why
  "warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "error" text,
  CONSTRAINT "cost_reconciliation_runs_trigger_check" CHECK ("trigger" IN ('manual', 'schedule')),
  CONSTRAINT "cost_reconciliation_runs_outcome_check" CHECK ("outcome" IN ('running', 'ok', 'failed'))
);

DO $$ BEGIN
  ALTER TABLE "cost_reconciliation_runs" ADD CONSTRAINT "cost_reconciliation_runs_initiated_by_fk"
    FOREIGN KEY ("initiated_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "cost_reconciliation_runs_started_idx"
  ON "cost_reconciliation_runs" ("started_at");

-- ---------------------------------------------------------------------------
-- 2. The supersession mark on the line itself. NULL everywhere = the line is
--    live and counts. All pre-existing rows are live by construction.
-- ---------------------------------------------------------------------------
ALTER TABLE "imported_cost_lines" ADD COLUMN IF NOT EXISTS "superseded_at" timestamp with time zone;
ALTER TABLE "imported_cost_lines" ADD COLUMN IF NOT EXISTS "superseded_by_line_id" uuid;
ALTER TABLE "imported_cost_lines" ADD COLUMN IF NOT EXISTS "superseded_run_id" uuid;
ALTER TABLE "imported_cost_lines" ADD COLUMN IF NOT EXISTS "superseded_reason" text;

-- The superseding line may itself be withdrawn later (its batch revoked); the
-- pointer nulls but the gateway REINSTATES the superseded line in the same
-- transaction — a fact restated and then un-restated must come back into the
-- consolidated view rather than silently vanish with its replacement.
DO $$ BEGIN
  ALTER TABLE "imported_cost_lines" ADD CONSTRAINT "imported_cost_lines_superseded_by_fk"
    FOREIGN KEY ("superseded_by_line_id") REFERENCES "imported_cost_lines"("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "imported_cost_lines" ADD CONSTRAINT "imported_cost_lines_superseded_run_fk"
    FOREIGN KEY ("superseded_run_id") REFERENCES "cost_reconciliation_runs"("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- a mark without a reason is an exclusion nobody can audit; a pointer or a
-- run id without a mark is a half-written state that must not exist; and a
-- line can never supersede itself
DO $$ BEGIN
  ALTER TABLE "imported_cost_lines" ADD CONSTRAINT "imported_cost_lines_supersession_check"
    CHECK (
      (("superseded_at" IS NULL) = ("superseded_reason" IS NULL))
      AND ("superseded_at" IS NOT NULL OR "superseded_by_line_id" IS NULL)
      AND ("superseded_at" IS NOT NULL OR "superseded_run_id" IS NULL)
      AND ("superseded_by_line_id" IS NULL OR "superseded_by_line_id" <> "id")
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- the consolidated read filters on "live", so give it the partial index
CREATE INDEX IF NOT EXISTS "imported_cost_lines_live_period_idx"
  ON "imported_cost_lines" ("period_start") WHERE "superseded_at" IS NULL;
