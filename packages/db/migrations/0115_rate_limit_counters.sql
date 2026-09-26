-- ADR-0125 / ROADMAP G1 — the HTTP edge rate limiter's counters, moved out of
-- process memory.
--
-- WHY THIS TABLE EXISTS. Every other enforcement counter in this product is
-- already shared, because it is already SQL: the kernel's rate limits are a
-- count() over audit_log, project budgets are a sum() over usage_events, and a
-- virtual key's spend is an atomic `spent_usd = spent_usd + x`. The HTTP edge
-- limiter was the one exception — @fastify/rate-limit's default LocalStore, a
-- per-process Map. With one process that is correct. With two it is not merely
-- approximate: each process admits the full ceiling, so N replicas enforce N
-- times the limit the admin configured and the posture page still reports the
-- configured number. A limit you cannot name is worse than no limit.
--
-- SHAPE. One row per bucket, where a bucket is whatever `rateLimitKey` derives
-- (ip:…, key:…, auth:…, scim:…). The window is FIXED, not sliding — the same
-- semantics LocalStore had, kept deliberately so that moving the store does not
-- silently change what the configured numbers mean.
--
-- `hits` is integer, not bigint: it is bounded by the configured ceiling plus
-- whatever races in during one window, never by traffic volume, because the
-- counter resets rather than accumulating.

create table if not exists rate_limit_counters (
  bucket             text        primary key,
  window_started_at  timestamptz not null default now(),
  hits               integer     not null default 0,

  -- A negative or zero count is not a state this can legitimately be in: a row
  -- exists only because a request was counted into it. Making it
  -- unrepresentable means a bug in the upsert shows up as a constraint
  -- violation here rather than as a silently un-enforceable limit.
  constraint rate_limit_counters_hits_positive check (hits > 0)
);

-- The prune predicate, and nothing else reads by this column. Rows are deleted
-- wholesale once they are older than any configured window; the index keeps
-- that from being a sequential scan over a table whose row count is bounded by
-- DISTINCT CALLERS rather than by requests.
create index if not exists rate_limit_counters_window_started_at_idx
  on rate_limit_counters (window_started_at);
