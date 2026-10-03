-- AER-037 — the health sweep's cap starved the tail of the estate forever.
--
-- ADR-0126's active probe (`mcp-health-probe.ts`) bounds a pass at 50 upstreams
-- and ordered them `breaker_opened_at desc nulls last, name asc`. With more than
-- 50 registered servers that order is CONSTANT, so every five-minute pass picked
-- the same lexicographically first 50 and the tail was never actively probed at
-- all. The result reported `capped: true`, which is honest about truncation and
-- says nothing about progress — and the tail kept exactly the "first user
-- discovers the outage" behaviour the feature exists to remove, on a deployment
-- whose scheduler page looked green.
--
-- A cap needs a CURSOR, and the cheapest correct cursor is "when did a pass last
-- consider this row". Ordering by it ascending, nulls first, makes the sweep a
-- fair round-robin: never-probed rows go first, then the longest-neglected, so
-- every registered upstream is reached within ceil(n / limit) passes regardless
-- of its name.
--
-- WHY A COLUMN AND NOT A CURSOR TABLE. Same reason as 0116's breaker columns:
-- the sweep already reads and writes this row, so the cursor costs no extra
-- query, and a single scalar cursor would be wrong anyway — the open-breaker
-- cohort must keep jumping the queue, which a per-row stamp allows and a
-- position cursor does not.
--
-- The stamp is written when a row is SELECTED, not after it answers, which is
-- also what makes two concurrent passes pick disjoint sets rather than racing
-- over the same head of the queue. A pass that dies half way leaves its rows
-- stamped and they simply go to the back — late, never starved.
--
-- NOT EVIDENCE. An operational observation, rewritten constantly and safe to
-- lose; the ledger records breaker transitions.

alter table mcp_servers
  add column if not exists last_health_probe_at timestamptz;

-- The sweep's own ORDER BY, in index form: the open-breaker cohort first, then
-- least-recently-considered. Not partial — unlike the breaker index, every row
-- participates in this ordering on every pass, which is the point.
create index if not exists mcp_servers_health_probe_rotation_idx
  on mcp_servers ((breaker_opened_at is null), last_health_probe_at nulls first, name);
