-- ADR-0282 / ADR-0283 (backlog P30, lane L5): the queue under pillar 2's stage runner. Hand-authored (never drizzle-kit
-- generate). Runs in the migrator's one transaction.
--
-- 1. The pg-boss 12.38.2 schema, in our own schema `regulait_queue`. The block between the `pg-boss:begin` and
--    `pg-boss:end` markers is `getConstructionPlans('regulait_queue')` of the pinned version with only its own
--    transaction wrapper removed (BEGIN, the two SET LOCAL timeouts, its advisory lock and COMMIT): the migrator's
--    transaction replaces them. pg-boss starts with `migrate: false`, so it never changes this schema itself; an
--    upgrade is a lockfile change plus a new migration from `getMigrationPlans`. `workflows-queue.test.ts` fails when
--    this block and the installed package disagree.
-- 2. One queue, `workflow-stage-retry`, policy `exclusive`: at most one job per singletonKey queued, retrying or
--    active. The key is the stage execution's idempotency key `<instance>:<stage>:<round>:<entry>` (ADR-0284), so one
--    failing stage entry has one retry chain whatever re-sends it. Retry counts and delays are set on each job from
--    the stage's own policy; the queue's own retryLimit is 0. `expireInSeconds` 900 matches the stage claim TTL
--    (REGULAIT_WORKFLOW_CLAIM_TTL_MS, 15 minutes).
-- 3. Jobs carry ids only (instance, stage, round, entry): no prompt, artifact, check output or secret. The schema holds
--    no tenant content and no route reads it, so it joins no ADR-0234 RLS batch. `regulait_app` (migration 0272) may
--    use it, because the send runs inside the transition's transaction, which can run as that role.

-- pg-boss:begin
CREATE SCHEMA IF NOT EXISTS regulait_queue;

    CREATE TYPE regulait_queue.job_state AS ENUM (
      'created',
      'retry',
      'active',
      'completed',
      'cancelled',
      'failed'
    )
  ;

    CREATE FUNCTION regulait_queue.job_now()
    RETURNS timestamp with time zone AS
    $$
      SELECT pg_catalog.now();
    $$
    LANGUAGE sql STABLE;
  ;

    CREATE TABLE regulait_queue.version (
      version int primary key,
      cron_on timestamp with time zone,
      bam_on timestamp with time zone,
      flow_on timestamp with time zone,
      reindex_on timestamp with time zone,
      monitor_backoff_on timestamp with time zone
    )
  ;

    CREATE TABLE regulait_queue.queue (
      name text NOT NULL,
      policy text NOT NULL,
      retry_limit int NOT NULL,
      retry_delay int NOT NULL,
      retry_backoff bool NOT NULL,
      retry_delay_max int,
      expire_seconds int NOT NULL,
      retention_seconds int NOT NULL,
      deletion_seconds int NOT NULL,
      dead_letter text REFERENCES regulait_queue.queue (name) CHECK (dead_letter IS DISTINCT FROM name),
      partition bool NOT NULL,
      table_name text NOT NULL,
      deferred_count int NOT NULL default 0,
      blocked_count int NOT NULL default 0,
      queued_count int NOT NULL default 0,
      ready_count int NOT NULL default 0,
      warning_queued int NOT NULL default 0,
      active_count int NOT NULL default 0,
      failed_count int NOT NULL default 0,
      total_count int NOT NULL default 0,
      retained_count int,
      retained_on timestamp with time zone,
      created_delta int NOT NULL default 0,
      completed_delta int NOT NULL default 0,
      failed_delta int NOT NULL default 0,
      delta_on timestamp with time zone,
      delta_seconds int,
      wait_bins int[],
      run_bins int[],
      ready_oldest_seconds int,
      ready_history int[] NOT NULL default '{}',
      heartbeat_seconds int,
      notify bool NOT NULL DEFAULT false,
      singletons_active text[],
      monitor_claim_on timestamp with time zone,
      monitor_on timestamp with time zone,
      maintain_on timestamp with time zone,
      created_on timestamp with time zone not null default now(),
      updated_on timestamp with time zone not null default now(),
      PRIMARY KEY (name)
    )
  ;

    CREATE TABLE regulait_queue.schedule (
      name text REFERENCES regulait_queue.queue ON DELETE CASCADE,
      key text not null DEFAULT '',
      kind text not null DEFAULT 'cron' CHECK (kind IN ('cron', 'rrule')),
      cron text not null,
      timezone text DEFAULT 'UTC',
      data jsonb,
      options jsonb,
      created_on timestamp with time zone not null default now(),
      updated_on timestamp with time zone not null default now(),
      last_job_id uuid,
      PRIMARY KEY (name, key)
    )
  ;

    CREATE TABLE regulait_queue.subscription (
      event text not null,
      name text not null REFERENCES regulait_queue.queue ON DELETE CASCADE,
      created_on timestamp with time zone not null default now(),
      updated_on timestamp with time zone not null default now(),
      PRIMARY KEY(event, name)
    )
  ;

    CREATE TABLE regulait_queue.bam (
      id uuid PRIMARY KEY default gen_random_uuid(),
      name text NOT NULL,
      version int NOT NULL,
      status text NOT NULL DEFAULT 'pending',
      queue text,
      table_name text NOT NULL,
      command text NOT NULL,
      error text,
      created_on timestamp with time zone NOT NULL DEFAULT clock_timestamp(),
      started_on timestamp with time zone,
      completed_on timestamp with time zone
    )
  ;

    CREATE FUNCTION regulait_queue.job_table_format(command text, table_name text)
    RETURNS text AS
    $$
      SELECT format(
        regexp_replace(
          regexp_replace(command, '\.job\y', '.%1$I', 'g'),
          '\yjob_i(\d+)', '%1$s_i\1', 'g'
        ),
        table_name
      );
    $$
    LANGUAGE sql IMMUTABLE;
  ;

    CREATE FUNCTION regulait_queue.job_table_run(command text, tbl_name text DEFAULT NULL, queue_name text DEFAULT NULL)
    RETURNS VOID AS
    $$
    DECLARE
      tbl RECORD;
    BEGIN
      IF queue_name IS NOT NULL THEN
        SELECT table_name INTO tbl_name FROM regulait_queue.queue WHERE name = queue_name;
      END IF;

      IF tbl_name IS NOT NULL THEN
        EXECUTE regulait_queue.job_table_format(command, tbl_name);
        RETURN;
      END IF;

      EXECUTE regulait_queue.job_table_format(command, 'job_common');

      FOR tbl IN SELECT table_name FROM regulait_queue.queue WHERE partition = true
      LOOP
        EXECUTE regulait_queue.job_table_format(command, tbl.table_name);
      END LOOP;
    END;
    $$
    LANGUAGE plpgsql;
  ;

    CREATE FUNCTION regulait_queue.job_table_run_async(command_name text, version int, command text, tbl_name text DEFAULT NULL, queue_name text DEFAULT NULL)
    RETURNS VOID AS
    $$
    BEGIN
      IF queue_name IS NOT NULL THEN
        SELECT table_name INTO tbl_name FROM regulait_queue.queue WHERE name = queue_name;
      END IF;

      IF tbl_name IS NOT NULL THEN
        INSERT INTO regulait_queue.bam (name, version, status, queue, table_name, command)
        VALUES (
          command_name,
          version,
          'pending',
          queue_name,
          tbl_name,
          regulait_queue.job_table_format(command, tbl_name)
        );
        RETURN;
      END IF;

      INSERT INTO regulait_queue.bam (name, version, status, queue, table_name, command)
      SELECT
        command_name,
        version,
        'pending',
        NULL,
        'job_common',
        regulait_queue.job_table_format(command, 'job_common')
      UNION ALL
      SELECT
        command_name,
        version,
        'pending',
        queue.name,
        queue.table_name,
        regulait_queue.job_table_format(command, queue.table_name)
      FROM regulait_queue.queue
      WHERE partition = true;
    END;
    $$
    LANGUAGE plpgsql;
  ;

    CREATE TABLE regulait_queue.job (
      id uuid not null default gen_random_uuid(),
      name text not null,
      priority integer not null default(0),
      data jsonb,
      state regulait_queue.job_state not null default 'created',
      retry_limit integer not null default 2,
      retry_count integer not null default 0,
      retry_delay integer not null default 0,
      retry_backoff boolean not null default false,
      retry_delay_max integer,
      expire_seconds int not null default 900,
      deletion_seconds int not null default 604800,
      singleton_key text,
      singleton_on timestamp without time zone,
      group_id text,
      group_tier text,
      start_after timestamp with time zone not null default now(),
      created_on timestamp with time zone not null default now(),
      started_on timestamp with time zone,
      completed_on timestamp with time zone,
      keep_until timestamp with time zone NOT NULL default now() + interval '1209600',
      output jsonb,
      dead_letter text,
      policy text,
      heartbeat_on timestamp with time zone,
      heartbeat_seconds int,
      blocked boolean not null default false,
      blocking boolean not null default false,
      pending_dependencies int not null default 0,
      source_name text,
      source_id uuid,
      source_created_on timestamp with time zone,
      source_retry_count int,
      source_output jsonb,
      source_root_id uuid,
      trace_context jsonb,
      upsert_by_key bool
    ) PARTITION BY LIST (name)
  ;
ALTER TABLE regulait_queue.job ADD PRIMARY KEY (name, id);

    CREATE TABLE regulait_queue.job_common (LIKE regulait_queue.job INCLUDING GENERATED INCLUDING DEFAULTS);

    SELECT regulait_queue.job_table_run($cmd$ALTER TABLE regulait_queue.job ADD PRIMARY KEY (name, id)$cmd$, 'job_common');
    SELECT regulait_queue.job_table_run($cmd$ALTER TABLE regulait_queue.job ADD CONSTRAINT q_fkey FOREIGN KEY (name) REFERENCES regulait_queue.queue (name) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED$cmd$, 'job_common');
    SELECT regulait_queue.job_table_run($cmd$ALTER TABLE regulait_queue.job ADD CONSTRAINT dlq_fkey FOREIGN KEY (dead_letter) REFERENCES regulait_queue.queue (name) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED$cmd$, 'job_common');
    SELECT regulait_queue.job_table_run($cmd$CREATE UNIQUE INDEX job_i1 ON regulait_queue.job (name, COALESCE(singleton_key, '')) WHERE state = 'created' AND policy = 'short'$cmd$, 'job_common');
    SELECT regulait_queue.job_table_run($cmd$CREATE UNIQUE INDEX job_i2 ON regulait_queue.job (name, COALESCE(singleton_key, '')) WHERE state = 'active' AND policy = 'singleton'$cmd$, 'job_common');
    SELECT regulait_queue.job_table_run($cmd$CREATE UNIQUE INDEX job_i3 ON regulait_queue.job (name, state, COALESCE(singleton_key, '')) WHERE state <= 'active' AND policy = 'stately'$cmd$, 'job_common');
    SELECT regulait_queue.job_table_run($cmd$CREATE UNIQUE INDEX job_i6 ON regulait_queue.job (name, COALESCE(singleton_key, '')) WHERE state <= 'active' AND policy = 'exclusive'$cmd$, 'job_common');
    SELECT regulait_queue.job_table_run($cmd$CREATE UNIQUE INDEX job_i8 ON regulait_queue.job (name, singleton_key) WHERE state IN ('active', 'retry', 'failed') AND policy = 'key_strict_fifo'$cmd$, 'job_common');
    SELECT regulait_queue.job_table_run($cmd$CREATE INDEX job_i10 ON regulait_queue.job (name, singleton_key, state DESC, created_on, id) INCLUDE (start_after) WHERE state < 'active' AND NOT blocked AND policy = 'key_strict_fifo'$cmd$, 'job_common');
    SELECT regulait_queue.job_table_run($cmd$ALTER TABLE regulait_queue.job ADD CONSTRAINT job_key_strict_fifo_singleton_key_check CHECK (NOT (policy = 'key_strict_fifo' AND singleton_key IS NULL))$cmd$, 'job_common');
    SELECT regulait_queue.job_table_run($cmd$CREATE UNIQUE INDEX job_i4 ON regulait_queue.job (name, singleton_on, COALESCE(singleton_key, '')) WHERE state <> 'cancelled' AND singleton_on IS NOT NULL$cmd$, 'job_common');
    SELECT regulait_queue.job_table_run($cmd$CREATE INDEX job_i11 ON regulait_queue.job (name, priority DESC, created_on, start_after) WHERE state < 'active' AND NOT blocked$cmd$, 'job_common');
    SELECT regulait_queue.job_table_run($cmd$CREATE INDEX job_i7 ON regulait_queue.job (name, group_id) WHERE state = 'active' AND group_id IS NOT NULL$cmd$, 'job_common');
    SELECT regulait_queue.job_table_run($cmd$CREATE INDEX job_i9 ON regulait_queue.job (name, id) WHERE blocking AND state = 'completed'$cmd$, 'job_common');
    SELECT regulait_queue.job_table_run($cmd$CREATE INDEX job_i12 ON regulait_queue.job (source_root_id) WHERE source_root_id IS NOT NULL$cmd$, 'job_common');
    SELECT regulait_queue.job_table_run($cmd$CREATE UNIQUE INDEX job_i13 ON regulait_queue.job (name, singleton_key) WHERE state = 'created' AND upsert_by_key$cmd$, 'job_common');
    SELECT regulait_queue.job_table_run($cmd$CREATE INDEX job_i14 ON regulait_queue.job (name, state, blocked, start_after) WHERE state IN ('created', 'retry', 'active', 'failed')$cmd$, 'job_common');
    SELECT regulait_queue.job_table_run($cmd$CREATE INDEX job_i15 ON regulait_queue.job (name, created_on)$cmd$, 'job_common');
    SELECT regulait_queue.job_table_run($cmd$CREATE INDEX job_i16 ON regulait_queue.job (name, completed_on) WHERE completed_on IS NOT NULL$cmd$, 'job_common');
    SELECT regulait_queue.job_table_run($cmd$CREATE INDEX job_i17 ON regulait_queue.job (name, singleton_key, created_on) WHERE state < 'active' AND singleton_key IS NOT NULL$cmd$, 'job_common');

    ALTER TABLE regulait_queue.job ATTACH PARTITION regulait_queue.job_common DEFAULT;
  ;

    CREATE TABLE regulait_queue.warning (
      id uuid PRIMARY KEY default gen_random_uuid(),
      type text NOT NULL,
      message text NOT NULL,
      data jsonb,
      created_on timestamp with time zone NOT NULL DEFAULT now()
    )
  ;
CREATE INDEX warning_i1 ON regulait_queue.warning (created_on DESC);

    CREATE TABLE regulait_queue.queue_stats (
      id uuid NOT NULL DEFAULT gen_random_uuid(),
      name text NOT NULL,
      deferred_count int NOT NULL DEFAULT 0,
      queued_count   int NOT NULL DEFAULT 0,
      ready_count    int NOT NULL DEFAULT 0,
      active_count   int NOT NULL DEFAULT 0,
      failed_count   int NOT NULL DEFAULT 0,
      total_count    int NOT NULL DEFAULT 0,
      created_delta   int,
      completed_delta int,
      failed_delta    int,
      delta_seconds   int,
      delta_on        timestamptz,
      wait_bins       int[],
      run_bins        int[],
      ready_oldest_seconds int,
      captured_on timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (id, captured_on)
    ) PARTITION BY RANGE (captured_on)
  ;
CREATE INDEX queue_stats_i1 ON regulait_queue.queue_stats (name, captured_on DESC) INCLUDE (deferred_count, queued_count, ready_count, active_count, failed_count, total_count);
;

    DO $$
    DECLARE
      d date;
      i int;
      part_name text;
    BEGIN
      FOR i IN 0..1 LOOP
        d := (regulait_queue.job_now() AT TIME ZONE 'UTC')::date + i;
        part_name := 'queue_stats_' || to_char(d, 'YYYYMMDD');
        IF NOT EXISTS (
          SELECT 1 FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'regulait_queue' AND c.relname = part_name
        ) THEN
          EXECUTE format(
            'CREATE TABLE regulait_queue.%I PARTITION OF regulait_queue.queue_stats FOR VALUES FROM (%L) TO (%L)',
            part_name,
            to_char(d, 'YYYY-MM-DD') || ' 00:00:00+00',
            to_char(d + 1, 'YYYY-MM-DD') || ' 00:00:00+00'
          );
        END IF;
      END LOOP;
    END;
    $$
  ;

    CREATE TABLE regulait_queue.job_dependency (
      child_name text NOT NULL,
      child_id uuid NOT NULL,
      parent_name text NOT NULL,
      parent_id uuid NOT NULL,
      PRIMARY KEY (child_name, child_id, parent_name, parent_id)
    )
  ;
CREATE INDEX IF NOT EXISTS job_dep_parent_idx ON regulait_queue.job_dependency (parent_name, parent_id);

    CREATE TABLE regulait_queue.instance (
      id uuid PRIMARY KEY,
      name text,
      host text NOT NULL,
      pid int NOT NULL,
      version text NOT NULL,
      node_version text NOT NULL,
      application_name text,
      heartbeat_seconds int NOT NULL,
      supervise bool NOT NULL,
      schedule bool NOT NULL,
      migrate bool NOT NULL,
      persist_queue_stats bool NOT NULL,
      persist_warnings bool NOT NULL,
      pool_max int,
      pool_total int,
      pool_idle int,
      pool_waiting int,
      workers jsonb NOT NULL DEFAULT '[]'::jsonb,
      metrics jsonb,
      config jsonb NOT NULL DEFAULT '{}'::jsonb,
      crash_restarts int NOT NULL DEFAULT 0,
      crash_restarts_since timestamptz,
      started_on timestamptz NOT NULL DEFAULT now(),
      heartbeat_on timestamptz NOT NULL DEFAULT now(),
      stopped_on timestamptz
    )
  ;

    CREATE FUNCTION regulait_queue.create_queue(queue_name text, options jsonb)
    RETURNS VOID AS
    $$
    DECLARE
      tablename varchar := CASE WHEN options->>'partition' = 'true'
                            THEN 'j' || encode(sha224(queue_name::bytea), 'hex')
                            ELSE 'job_common'
                            END;
      queue_created_on timestamptz;
    BEGIN

      WITH q as (
        INSERT INTO regulait_queue.queue (
          name,
          policy,
          retry_limit,
          retry_delay,
          retry_backoff,
          retry_delay_max,
          expire_seconds,
          retention_seconds,
          deletion_seconds,
          warning_queued,
          dead_letter,
          partition,
          table_name,
          heartbeat_seconds,
          notify,
          created_on,
          updated_on
        )
        VALUES (
          queue_name,
          options->>'policy',
          COALESCE((options->>'retryLimit')::int, 2),
          COALESCE((options->>'retryDelay')::int, 0),
          COALESCE((options->>'retryBackoff')::bool, false),
          (options->>'retryDelayMax')::int,
          COALESCE((options->>'expireInSeconds')::int, 900),
          COALESCE((options->>'retentionSeconds')::int, 1209600),
          COALESCE((options->>'deleteAfterSeconds')::int, 604800),
          COALESCE((options->>'warningQueueSize')::int, 0),
          options->>'deadLetter',
          COALESCE((options->>'partition')::bool, false),
          tablename,
          (options->>'heartbeatSeconds')::int,
          COALESCE((options->>'notify')::bool, false),
          regulait_queue.job_now(),
          regulait_queue.job_now()
        )
        ON CONFLICT DO NOTHING
        RETURNING created_on
      )
      SELECT created_on into queue_created_on from q;

      IF queue_created_on IS NULL OR options->>'partition' IS DISTINCT FROM 'true' THEN
        RETURN;
      END IF;

      EXECUTE format('CREATE TABLE regulait_queue.%I (LIKE regulait_queue.job INCLUDING DEFAULTS)', tablename);

      EXECUTE regulait_queue.job_table_format($cmd$ALTER TABLE regulait_queue.job ADD PRIMARY KEY (name, id)$cmd$, tablename);
      EXECUTE regulait_queue.job_table_format($cmd$ALTER TABLE regulait_queue.job ADD CONSTRAINT q_fkey FOREIGN KEY (name) REFERENCES regulait_queue.queue (name) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED$cmd$, tablename);
      EXECUTE regulait_queue.job_table_format($cmd$ALTER TABLE regulait_queue.job ADD CONSTRAINT dlq_fkey FOREIGN KEY (dead_letter) REFERENCES regulait_queue.queue (name) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED$cmd$, tablename);

      EXECUTE regulait_queue.job_table_format($cmd$CREATE INDEX job_i11 ON regulait_queue.job (name, priority DESC, created_on, start_after) WHERE state < 'active' AND NOT blocked$cmd$, tablename);
      EXECUTE regulait_queue.job_table_format($cmd$CREATE UNIQUE INDEX job_i4 ON regulait_queue.job (name, singleton_on, COALESCE(singleton_key, '')) WHERE state <> 'cancelled' AND singleton_on IS NOT NULL$cmd$, tablename);
      EXECUTE regulait_queue.job_table_format($cmd$CREATE INDEX job_i7 ON regulait_queue.job (name, group_id) WHERE state = 'active' AND group_id IS NOT NULL$cmd$, tablename);
      EXECUTE regulait_queue.job_table_format($cmd$CREATE INDEX job_i9 ON regulait_queue.job (name, id) WHERE blocking AND state = 'completed'$cmd$, tablename);
      EXECUTE regulait_queue.job_table_format($cmd$CREATE INDEX job_i12 ON regulait_queue.job (source_root_id) WHERE source_root_id IS NOT NULL$cmd$, tablename);
      EXECUTE regulait_queue.job_table_format($cmd$CREATE UNIQUE INDEX job_i13 ON regulait_queue.job (name, singleton_key) WHERE state = 'created' AND upsert_by_key$cmd$, tablename);
      EXECUTE regulait_queue.job_table_format($cmd$CREATE INDEX job_i14 ON regulait_queue.job (name, state, blocked, start_after) WHERE state IN ('created', 'retry', 'active', 'failed')$cmd$, tablename);
      EXECUTE regulait_queue.job_table_format($cmd$CREATE INDEX job_i15 ON regulait_queue.job (name, created_on)$cmd$, tablename);
      EXECUTE regulait_queue.job_table_format($cmd$CREATE INDEX job_i16 ON regulait_queue.job (name, completed_on) WHERE completed_on IS NOT NULL$cmd$, tablename);
      EXECUTE regulait_queue.job_table_format($cmd$CREATE INDEX job_i17 ON regulait_queue.job (name, singleton_key, created_on) WHERE state < 'active' AND singleton_key IS NOT NULL$cmd$, tablename);

      IF options->>'policy' = 'short' THEN
        EXECUTE regulait_queue.job_table_format($cmd$CREATE UNIQUE INDEX job_i1 ON regulait_queue.job (name, COALESCE(singleton_key, '')) WHERE state = 'created' AND policy = 'short'$cmd$, tablename);
      ELSIF options->>'policy' = 'singleton' THEN
        EXECUTE regulait_queue.job_table_format($cmd$CREATE UNIQUE INDEX job_i2 ON regulait_queue.job (name, COALESCE(singleton_key, '')) WHERE state = 'active' AND policy = 'singleton'$cmd$, tablename);
      ELSIF options->>'policy' = 'stately' THEN
        EXECUTE regulait_queue.job_table_format($cmd$CREATE UNIQUE INDEX job_i3 ON regulait_queue.job (name, state, COALESCE(singleton_key, '')) WHERE state <= 'active' AND policy = 'stately'$cmd$, tablename);
      ELSIF options->>'policy' = 'exclusive' THEN
        EXECUTE regulait_queue.job_table_format($cmd$CREATE UNIQUE INDEX job_i6 ON regulait_queue.job (name, COALESCE(singleton_key, '')) WHERE state <= 'active' AND policy = 'exclusive'$cmd$, tablename);
      ELSIF options->>'policy' = 'key_strict_fifo' THEN
        EXECUTE regulait_queue.job_table_format($cmd$CREATE UNIQUE INDEX job_i8 ON regulait_queue.job (name, singleton_key) WHERE state IN ('active', 'retry', 'failed') AND policy = 'key_strict_fifo'$cmd$, tablename);
        EXECUTE regulait_queue.job_table_format($cmd$CREATE INDEX job_i10 ON regulait_queue.job (name, singleton_key, state DESC, created_on, id) INCLUDE (start_after) WHERE state < 'active' AND NOT blocked AND policy = 'key_strict_fifo'$cmd$, tablename);
        EXECUTE regulait_queue.job_table_format($cmd$ALTER TABLE regulait_queue.job ADD CONSTRAINT job_key_strict_fifo_singleton_key_check CHECK (NOT (policy = 'key_strict_fifo' AND singleton_key IS NULL))$cmd$, tablename);
      END IF;

      EXECUTE format('ALTER TABLE regulait_queue.%I ADD CONSTRAINT cjc CHECK (name=%L)', tablename, queue_name);
      EXECUTE format('ALTER TABLE regulait_queue.job ATTACH PARTITION regulait_queue.%I FOR VALUES IN (%L)', tablename, queue_name);
    END;
    $$
    LANGUAGE plpgsql;
  ;

    CREATE FUNCTION regulait_queue.delete_queue(queue_name text)
    RETURNS VOID AS
    $$
    DECLARE
      v_table varchar;
      v_partition bool;
    BEGIN
      
      SELECT table_name, partition
      FROM regulait_queue.queue
      WHERE name = queue_name
      INTO v_table, v_partition;

      IF v_partition THEN
        EXECUTE format('DROP TABLE IF EXISTS regulait_queue.%I', v_table);
      ELSE
        EXECUTE format('DELETE FROM regulait_queue.%I WHERE name = %L', v_table, queue_name);
      END IF;
    
      DELETE FROM regulait_queue.queue WHERE name = queue_name;
    END;
    $$
    LANGUAGE plpgsql;
  ;
INSERT INTO regulait_queue.version(version) VALUES ('46');
-- pg-boss:end

SELECT regulait_queue.create_queue(
  'workflow-stage-retry',
  '{"policy":"exclusive","retryLimit":0,"expireInSeconds":900,"retentionSeconds":1209600,"deleteAfterSeconds":604800}'::jsonb
);

-- 4. Least privilege for `regulait_app`: what sending, working and supervising jobs need, nothing that creates,
--    deletes or reconfigures a queue or the schema. The jobs (job and its partitions) are read and written; the queue
--    and version rows are read, with UPDATE only on pg-boss's own bookkeeping columns (counts, timestamps), never a
--    policy, retry setting, table name or the version itself; the worker registers its instance. Functions are not
--    executable by PUBLIC; the app may run only `job_now()`. Default privileges cover a job partition a later
--    migration creates (create_queue with partition, run by the migrator).
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA regulait_queue FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA regulait_queue REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'regulait_app') THEN
    GRANT USAGE ON SCHEMA regulait_queue TO regulait_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON regulait_queue.job, regulait_queue.job_common TO regulait_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON regulait_queue.instance TO regulait_app;
    GRANT SELECT, DELETE ON regulait_queue.job_dependency TO regulait_app;
    GRANT SELECT ON regulait_queue.queue, regulait_queue.version, regulait_queue.bam TO regulait_app;
    GRANT UPDATE (
      deferred_count, blocked_count, queued_count, ready_count, warning_queued, active_count, failed_count, total_count,
      retained_count, retained_on, created_delta, completed_delta, failed_delta, delta_on, delta_seconds, wait_bins,
      run_bins, ready_oldest_seconds, ready_history, heartbeat_seconds, singletons_active, monitor_claim_on, monitor_on,
      maintain_on, updated_on
    ) ON regulait_queue.queue TO regulait_app;
    GRANT UPDATE (cron_on, bam_on, flow_on, reindex_on, monitor_backoff_on) ON regulait_queue.version TO regulait_app;
    GRANT EXECUTE ON FUNCTION regulait_queue.job_now() TO regulait_app;
    ALTER DEFAULT PRIVILEGES IN SCHEMA regulait_queue GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO regulait_app;
  END IF;
END
$$;
