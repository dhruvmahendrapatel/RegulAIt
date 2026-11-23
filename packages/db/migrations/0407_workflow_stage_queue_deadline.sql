-- ADR-0340 slice 2 (lane E21): the stage DEADLINE queue under pillar 2's stage runner. Hand-authored (never
-- drizzle-kit generate). Named to sort after `workflow_stage_queue.sql`, which installs the pg-boss schema it uses.
--
-- `workflow-stage-deadline`, policy `exclusive`: at most one job per singletonKey queued, retrying or active. The key
-- is the stage execution's key (ADR-0284) plus the phase (`warn` or `breach`), so one stage entry has at most one
-- warning and one breach whatever re-sends them. A job carries ids only (instance, stage, round, entry, phase).
-- A handler that throws is retried 3 times, a minute apart; `expireInSeconds` 900 matches the stage claim TTL.
-- `regulait_app` already holds what sending and working jobs needs (workflow_stage_queue.sql §4); creating a queue
-- stays the migrator's.
SELECT regulait_queue.create_queue(
  'workflow-stage-deadline',
  '{"policy":"exclusive","retryLimit":3,"retryDelay":60,"expireInSeconds":900,"retentionSeconds":1209600,"deleteAfterSeconds":604800}'::jsonb
);
