-- Migration 0099 (batch B4, ADR-0063 amendment) — THE KEY RE-ENCRYPTION WALK'S
-- DURABLE PROGRESS.
--
-- ADR-0063 §4 named the follow-up in one sentence: "a resumable, transactional
-- walk over all CIPHERTEXT_COLUMNS" so a declared rotation can genuinely
-- re-encrypt instead of merely re-recording the fingerprint. RESUMABLE is the
-- word these three tables exist for: a walk that keeps its progress in process
-- memory restarts from zero after a crash and, worse, cannot PROVE it did not
-- double-process or skip rows. Progress therefore lives in the same database
-- as the ciphertext, committed in the SAME transaction as each batch's
-- re-encrypted rows — so "these rows are under the new key" and "the watermark
-- has moved past them" are one atomic fact, and a kill at any point leaves a
-- state the next invocation resumes exactly.
--
-- 1. data_key_reencryption_runs — one row per walk. `status` is honest by
--    construction: 'running' until the walk itself says otherwise, and a row
--    that decrypted under NEITHER key forces 'completed_with_failures' —
--    never 'completed'. A killed run simply stays 'running'; the next
--    invocation with the same from/to fingerprints picks it up.
--
-- 2. data_key_reencryption_progress — one row per (run, table, column): the
--    per-PK watermark (all thirteen ciphertext-bearing tables key on a uuid
--    `id`; uuid ordering is well-defined in Postgres), the done flag, and the
--    three counters the completion record reports.
--
-- 3. data_key_reencryption_failures — the id + table of every row that
--    decrypted under neither key. Recorded, and then WALKED PAST: one corrupt
--    row must not brick a key rotation, but it must also never be silently
--    counted as success. The unique constraint means a resumed run cannot
--    double-record the same corpse.
--
-- No existing table changes. Reversing this migration loses only walk
-- bookkeeping, never ciphertext.

CREATE TABLE IF NOT EXISTS "data_key_reencryption_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "from_fingerprint" text NOT NULL,
  "to_fingerprint" text NOT NULL,
  "status" text NOT NULL DEFAULT 'running',
  "started_at" timestamp with time zone NOT NULL DEFAULT now(),
  "finished_at" timestamp with time zone,
  CONSTRAINT "data_key_reencryption_runs_status_check"
    CHECK ("status" IN ('running', 'completed', 'completed_with_failures'))
);

CREATE INDEX IF NOT EXISTS "data_key_reencryption_runs_status_idx"
  ON "data_key_reencryption_runs" ("status", "started_at");

CREATE TABLE IF NOT EXISTS "data_key_reencryption_progress" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "run_id" uuid NOT NULL REFERENCES "data_key_reencryption_runs"("id") ON DELETE CASCADE,
  "table_name" text NOT NULL,
  "column_name" text NOT NULL,
  -- the PK of the last row this walk has settled, in uuid order. NULL = this
  -- column has not been started. Committed in the same transaction as the
  -- batch it describes, which is the whole resumability guarantee.
  "watermark" uuid,
  "done" boolean NOT NULL DEFAULT false,
  "rows_reencrypted" integer NOT NULL DEFAULT 0,
  "rows_already_current" integer NOT NULL DEFAULT 0,
  "rows_failed" integer NOT NULL DEFAULT 0,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "data_key_reencryption_progress_unique" UNIQUE ("run_id", "table_name", "column_name")
);

CREATE TABLE IF NOT EXISTS "data_key_reencryption_failures" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "run_id" uuid NOT NULL REFERENCES "data_key_reencryption_runs"("id") ON DELETE CASCADE,
  "table_name" text NOT NULL,
  "column_name" text NOT NULL,
  "row_id" uuid NOT NULL,
  "detail" text,
  "recorded_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "data_key_reencryption_failures_unique" UNIQUE ("run_id", "table_name", "column_name", "row_id")
);
