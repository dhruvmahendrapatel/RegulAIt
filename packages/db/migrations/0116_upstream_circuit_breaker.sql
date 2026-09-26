-- ADR-0126 / ROADMAP G2 — a circuit breaker per MCP upstream.
--
-- WHY THESE COLUMNS AND NOT A TABLE. The proxy already does
-- `select * from mcp_servers where id = $1` at the top of every request
-- (mcp-proxy.ts). Putting the breaker's state on that row makes reading it
-- FREE — no second query on the hot path of the thing whose entire purpose is
-- to avoid work. A generic `upstream_breakers` table would be tidier and would
-- cost a lookup per request forever. ADR-0097's admission columns live here for
-- the same reason.
--
-- THREE DIFFERENT FACTS, THREE SETS OF COLUMNS. `agents.enabled` means "not in
-- service" (a registry decision). ADR-0124's `halted_at` means "stopped during
-- an incident" (a human's deliberate act). These mean "failing right now" (an
-- observation the platform made by itself). Collapsing any pair would mean one
-- clearing another: a recovered upstream must not un-halt a server somebody
-- deliberately stopped, and lifting a halt must not hide that the upstream is
-- still dead. Deliberately separate, like ADR-0124 argued for its pair.
--
-- NOTHING HERE IS EVIDENCE. These are operational observations, rewritten
-- constantly and safe to lose; the audit trail records the TRANSITIONS.

alter table mcp_servers
  add column if not exists breaker_consecutive_failures integer not null default 0,
  add column if not exists breaker_opened_at            timestamptz,
  add column if not exists breaker_last_failure_at      timestamptz,
  add column if not exists breaker_last_error           text;

-- A negative failure count is not a state this can legitimately reach.
alter table mcp_servers
  drop constraint if exists mcp_servers_breaker_failures_nonneg;
alter table mcp_servers
  add constraint mcp_servers_breaker_failures_nonneg
  check (breaker_consecutive_failures >= 0);

-- An open breaker must always carry the reason it opened. "Refusing, cause
-- unknown" is the shape this product refuses to emit anywhere else, and making
-- it unrepresentable here is cheaper than remembering to set both.
alter table mcp_servers
  drop constraint if exists mcp_servers_breaker_open_has_reason;
alter table mcp_servers
  add constraint mcp_servers_breaker_open_has_reason
  check (breaker_opened_at is null or breaker_last_error is not null);

-- Partial, because the answer is almost always "no breaker is open" — the same
-- shape as migration 0114's halt indexes.
create index if not exists mcp_servers_breaker_open_idx
  on mcp_servers (breaker_opened_at)
  where breaker_opened_at is not null;
