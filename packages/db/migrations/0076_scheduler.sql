-- ADR-0064 — THE IN-PROCESS SCHEDULER.
--
-- Six ADRs (0044 eval drift, 0045 MRM expiry, 0046 approval SLA, 0047 report
-- generation, 0049 spend anomaly, 0057 red-team runs) each shipped a schedule
-- and then, in the same breath, disclosed that nothing drives it: "an operator
-- or an external cron must call this endpoint". That was honest and it was also
-- six copies of the same hole. A BYOC/air-gapped install (ADR-0041, the primary
-- motion) frequently has no cron the customer will let us near and certainly no
-- cloud scheduler, so "wire up EventBridge" is not an answer for the buyer this
-- product targets.
--
-- These two tables are the DURABLE half of the answer. The tick loop lives in
-- the gateway (apps/gateway/src/scheduler.ts); what lives HERE is everything an
-- operator needs to answer the question the loop cannot answer about itself:
--
--     "Did the MRM sweep actually run last night, and what did it do?"
--
-- 1. scheduler_jobs — one row per registered job. Cadence, enabled, when it is
--    next due, and the outcome of its last pass. This row is ALSO the LOCK: the
--    claim is a short transaction that takes `FOR UPDATE` on it and writes a
--    lease, so two gateway instances pointed at one database cannot both run
--    the same job. Correctness therefore does not depend on there being exactly
--    one process — which matters because the deployment-readiness checklist
--    plans HA and nobody will remember this file when that lands.
--
-- 2. scheduler_runs — the append-only ledger, one row per execution ATTEMPT,
--    including the attempts that were skipped because another instance held the
--    lease. A skip is data, not an error: "the other box ran it" and "nothing
--    ran it" must not look the same.
--
-- WHAT THIS IS NOT. It is not a job queue. There is no fan-out, no retry
-- policy, no per-item durability — a failed pass is recorded and the NEXT tick
-- tries again, which is the correct shape for a sweep whose whole purpose is
-- timeliness rather than correctness. Every one of the six sweeps is written so
-- enforcement never depends on it having run (MRM recomputes expiry at
-- dispatch; SLA breach is caught on read and on decide), and that property is
-- deliberately unchanged by this migration.

CREATE TABLE IF NOT EXISTS "scheduler_jobs" (
  -- the STABLE job id, chosen in code and used as the audit ruleId suffix.
  -- Text, not uuid: an operator reading a run ledger should see
  -- 'mrm-expiry-sweep', not a random uuid they have to join to understand.
  "name" text PRIMARY KEY NOT NULL,
  -- what the job does, in one sentence, synced from the code definition on
  -- every boot so the database never carries a stale description.
  "description" text NOT NULL DEFAULT '',
  -- which ADR this job discharges. Purely for the admin screen and for the
  -- person who finds this table in three years with no context.
  "adr" text,
  -- OFF here means the tick loop skips it even when the scheduler itself is
  -- running. Defaults to true so registering a job means it runs; the SCHEDULER
  -- is what is off by default (REGULAIT_SCHEDULER), not the individual jobs.
  "enabled" boolean NOT NULL DEFAULT true,
  -- cadence. A plain interval rather than a cron expression on purpose: a cron
  -- parser is a dependency and an expression is a thing to get wrong, and none
  -- of the six sweeps needs "the third Tuesday". An operator who needs wall
  -- clock precision still has the endpoint and their own cron.
  "interval_seconds" integer NOT NULL,
  -- when this job may next be claimed. Advanced on every completed pass; it is
  -- the single source of "is it due", so two instances reading it inside the
  -- claim transaction cannot disagree.
  "next_due_at" timestamp with time zone NOT NULL DEFAULT now(),
  "last_run_at" timestamp with time zone,
  "last_finished_at" timestamp with time zone,
  -- ok | failed | skipped — the last pass's verdict, denormalised off
  -- scheduler_runs so the jobs list renders without a lateral join.
  "last_outcome" text,
  "last_error" text,
  "last_items_processed" integer,
  "last_duration_ms" integer,
  -- --- the lease. This is the lock. ---------------------------------------
  -- Held for the duration of a pass. `running` alone would strand the job
  -- forever if the holder was SIGKILLed mid-pass, so it is paired with an
  -- expiry: a lease past its expiry is reclaimable by anyone.
  "running" boolean NOT NULL DEFAULT false,
  -- which process claimed it (a per-boot instance id). Recorded so "who ran
  -- this" is answerable in an HA deployment.
  "lease_owner" text,
  "lease_expires_at" timestamp with time zone,
  -- running totals, so a job that has failed every night for a month is
  -- visible as such rather than as one red row.
  "runs" integer NOT NULL DEFAULT 0,
  "failures" integer NOT NULL DEFAULT 0,
  "consecutive_failures" integer NOT NULL DEFAULT 0,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "scheduler_jobs_interval_check" CHECK ("interval_seconds" >= 1),
  CONSTRAINT "scheduler_jobs_last_outcome_check"
    CHECK ("last_outcome" IS NULL OR "last_outcome" IN ('ok', 'failed', 'skipped'))
);

CREATE TABLE IF NOT EXISTS "scheduler_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "job_name" text NOT NULL,
  -- schedule = the tick loop claimed it; manual = a human pressed "run now" or
  -- called the job's own endpoint. Both go through the same claim and the same
  -- job body, so a manual run cannot race a scheduled one.
  "trigger" text NOT NULL DEFAULT 'schedule',
  -- the per-boot id of the gateway process that owned this attempt
  "instance_id" text NOT NULL,
  "initiated_by_user_id" uuid,
  "started_at" timestamp with time zone DEFAULT now() NOT NULL,
  "finished_at" timestamp with time zone,
  "duration_ms" integer,
  -- running | ok | failed | skipped. A row left at 'running' with a finished_at
  -- of NULL and a stale started_at is a process that died mid-pass — which is
  -- exactly the diagnosis an operator wants and would not get from a design
  -- that only wrote the row on success.
  "outcome" text NOT NULL DEFAULT 'running',
  -- whatever the job counted: approvals evaluated, cards expired, reports
  -- generated. The number that answers "and what did it do?".
  "items_processed" integer NOT NULL DEFAULT 0,
  "detail" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "error" text,
  CONSTRAINT "scheduler_runs_job_fk" FOREIGN KEY ("job_name")
    REFERENCES "scheduler_jobs" ("name") ON DELETE CASCADE,
  CONSTRAINT "scheduler_runs_user_fk" FOREIGN KEY ("initiated_by_user_id")
    REFERENCES "users" ("id") ON DELETE SET NULL,
  CONSTRAINT "scheduler_runs_outcome_check"
    CHECK ("outcome" IN ('running', 'ok', 'failed', 'skipped')),
  CONSTRAINT "scheduler_runs_trigger_check"
    CHECK ("trigger" IN ('schedule', 'manual'))
);

-- the one query the admin screen and the operator both make: this job's
-- history, newest first.
CREATE INDEX IF NOT EXISTS "scheduler_runs_job_idx"
  ON "scheduler_runs" ("job_name", "started_at" DESC);

-- "what ran last night, across everything"
CREATE INDEX IF NOT EXISTS "scheduler_runs_started_idx"
  ON "scheduler_runs" ("started_at" DESC);
