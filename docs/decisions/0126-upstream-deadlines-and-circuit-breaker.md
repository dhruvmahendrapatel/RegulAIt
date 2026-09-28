# ADR-0126 — Deadlines and a circuit breaker: bounding one call, and bounding the hundredth

- **Status**: Accepted
- **Date**: 2026-09-26
- **Relates to**: [ADR-0043](0043-mcp-egress-guard.md) (the refusal this sits beside, and must not be
  confused with), [ADR-0097](0097-mcp-admission-control.md) (the other pre-connect refusal),
  [ADR-0124](0124-kill-switch-and-safe-modes.md) (the halt these columns are deliberately separate
  from), [ADR-0125](0125-shared-enforcement-counters.md) (the SQL-increment pattern reused here),
  [ADR-0021](0021-admin-configurable-policy.md) (the configurability mandate this incurs debt
  against), [ROADMAP §8](../product/ROADMAP.md) G2
- **Migration**: [`0116_upstream_circuit_breaker.sql`](../../packages/db/migrations/0116_upstream_circuit_breaker.sql)

## Context

The second of the two items ROADMAP §8 called defects rather than features. A hung or hostile
upstream had no bound anywhere, and an unreachable one produced the single error shape this product
tries hardest never to emit.

**The roadmap item was again broader than the defect.** It said "timeouts, body limits", and the
body limit **already existed**: Fastify defaults `bodyLimit` to 1 MiB and nothing overrode it. That
half is therefore about restating a number where an operator can find it, not adding a missing
bound — no request that worked before this change stops working, and a test pins the number so
changing it has to be argued for.

What was genuinely unbounded:

| path | state before |
|---|---|
| `requestTimeout` | Fastify's default `0`, i.e. disabled |
| MCP `connect` / `listTools` / `callTool` | no options argument at any of the three; the guarded fetch forwards a caller signal nobody supplied |
| model dispatch | `maxRetries: 2` and no `timeout`, inheriting a 10-minute vendor default **and retrying it** — a worst case near half an hour, chosen by nobody |
| an unreachable upstream | `throw err` → `500 {"error":"internal"}`, **nothing audited** |

## Decision

### 1. `connectionTimeout` is deliberately NOT set, and that is the load-bearing choice

It is the obvious third knob and it would be a bug. Fastify's `connectionTimeout` is
`server.setTimeout`: socket **inactivity**. This product holds sockets open on purpose almost
everywhere — the MCP proxy hijacks the reply and streams, both compat edges stream SSE, the
orchestration channel streams SSE, `/v1/audit.csv` streams a batched DB walk. An idle-socket
deadline severs correct long streams and reports them as timeouts.

`requestTimeout` is safe beside all of that because it bounds **receiving** a request, not handling
or answering one. Rather than trust the documentation on that, a test drives the real stack over a
real socket with a `requestTimeout` four times shorter than the handler's own wait, and asserts the
handler's answer still wins.

The bound the streaming paths actually need is a deadline on *what they are waiting for*, which is
what the upstream numbers are.

### 2. The bare 500 becomes two named refusals, and they are different questions

`connectUpstream` handled exactly two failures and rethrew everything else. An ECONNREFUSED escaped
to the global handler and became `500 {"error":"internal"}` — on the route whose entire proposition
is that every refusal is named, and in practice the **most common failure a new deployment hits**,
because the upstream simply is not running. The demo runbook carried a troubleshooting row for it.

Now `502 mcp_upstream_unreachable` or `504 mcp_upstream_timeout`. Two codes, not one, because "it
refused us" and "it never finished" send an operator to different places. Detecting which is a
predicate rather than an `instanceof`: three shapes arrive from three layers (a `TimeoutError`
DOMException from `AbortSignal.timeout`, an `McpError` with `RequestTimeout` when the SDK's own
timer wins, and an undici `ETIMEDOUT`-family `cause.code`), and missing one would silently downgrade
a timeout to "unreachable".

Both are audited under **`mcp-upstream-unreachable`**, not the egress rule id. *"We refused to reach
it"* and *"we could not reach it"* lead to a policy screen and a network respectively, and one
shared id would answer neither.

### 3. The breaker bounds the hundredth caller, which the deadline does not

A deadline bounds **one** call. It does nothing about the tenth caller paying that same bound to
learn what the first one learned. With a 10-second connect deadline and a dead upstream, a hundred
queued requests is a hundred held sockets and sixteen minutes of aggregate waiting for a fact
already known.

State lives on the **`mcp_servers` row**, not in a new table, because the proxy already fetches that
row at the top of every request — so reading the breaker costs **nothing** on the hot path of the
mechanism whose entire purpose is to avoid work. A tidier generic table would have cost a lookup per
request forever.

**It is a third fact, and the columns are deliberately separate.** `agents.enabled` is "not in
service"; ADR-0124's `halted_at` is "a human stopped this during an incident"; these are "failing
right now, observed by the platform". Collapsing any pair would let one clear another — a recovered
upstream must not un-halt something an operator deliberately stopped.

### 4. Exactly one prober, because the naive half-open rebuilds the herd

The obvious half-open lets every waiting request through the moment the cooldown expires, which
against a still-dead upstream reproduces precisely the thundering herd the breaker was added to
prevent — at its worst moment, when a backlog has built. The election is a conditional `UPDATE` that
moves `breaker_opened_at` forward only if it still holds the value this request read: one statement,
atomic, no lock, no transaction. The winner probes; everyone else sees a moved timestamp and keeps
fast-failing. A test fires twelve concurrent requests at an expired cooldown and asserts **one** 504
and **eleven** 503s.

The failure counter is incremented in SQL for ADR-0125's reason: concurrent failures against one
dead upstream are the *normal* case here, and two writers each storing an absolute would lose counts
exactly when the count is supposed to be rising.

### 5. A policy refusal never counts towards it

Egress refusals and admission holds return before the connect and are not counted. If they were,
tightening the allow-list would trip breakers across the estate and a **governance change would
present as an outage** — with the ledger asserting the upstreams failed, which would be false. A
test flips the org default to deny private ranges and asserts six consecutive `egress_blocked`
refusals leave the failure count at zero.

### 6. Transitions are audited; individual fast-fails are not

Every other refusal in this product files a row. This one deliberately files **opened / probing /
closed** and not the individual refusals, because an open breaker's whole job is to refuse a lot,
quickly. A row per refused request turns one upstream outage into thousands of identical entries,
burying the transitions that answer what an auditor actually asks: *when did this upstream go away,
and when did it come back.* The refusal is still named to the caller; it is the ledger that gets the
summary rather than the stream.

## Consequences

**What this buys.** No unbounded wait remains on any MCP or model path. A dead upstream is a named,
audited, fast refusal instead of an opaque 500 and a held socket — and after five failures it stops
costing anything at all.

**What it costs.** One SQL update per upstream failure, and nothing per success on a healthy
upstream. The breaker read is free.

**Deliberate limits, named rather than discovered.**

- **The breaker covers MCP upstreams only.** Model dispatch and connector invokes now have
  deadlines but no breaker. Extending it is the natural follow-up, and the storage decision made
  here (columns on the subject row) is the thing to revisit if a third subject type appears.
- **Connector HTTP calls still have no deadline.** G2's text named MCP and model upstreams and this
  change matches it; the connector path is an open gap and is listed as such.
- **ADR-0021 convention debt**, restated rather than hidden: under the admin-configurability mandate
  every number here belongs in `org_settings`. They are env-overridable constants instead, exactly
  as `rate-limit.ts` says of its own, and for the same reason — this change already carries a
  migration for the breaker columns and adding six settings columns is its own decision.
- **Nothing reports the breaker to an operator yet** beyond the refusal itself. `openBreakers()`
  exists and no route calls it. The posture page and the execution-control screen are the obvious
  homes, and ADR-0124's argument applies verbatim: an operator mid-incident should be able to see
  what is stopped and why.

## Amendment 2026-09-28 — the active probe, and the starved tail it shipped with (AER-037)

**The passive breaker leaves one cost nobody chose: the first user after an outage always pays the
full connect deadline.** On a quiet deployment that "first user" can be the customer in a demo, and
the breaker's whole value — an immediate, named refusal — only begins on the *second* one. So
`mcp-health-probe.ts` adds a scheduler job (`mcp-health-probe-sweep`, every 5 minutes) that makes the
platform the first caller instead. It is a new way for the breaker to **learn**, not a second
mechanism and **not a control**: with the scheduler off, which is the shipped default, behaviour is
byte-identical, because the breaker still learns from traffic.

It reuses `breakerAdmits` rather than reading the state, so the sweep enters the breaker's own
one-winner election like any other caller and cannot become the thundering herd that election exists
to prevent. And it counts **our** refusals — egress-blocked, admission-held — in their own bucket
without touching the breaker: an air-gapped install refuses every outbound host by design, so
charging those would report every upstream as circuit-broken on a deployment where nothing is wrong.

**AER-037 — the cap starved the tail of the estate, and the header argued it was fine.** The first
version bounded a pass at 50 and ordered the remainder `name asc`. That order is **constant**, so
past the cap every pass probed the same lexicographically first cohort and the tail was never
actively probed at all. `capped: true` reported the truncation honestly and said nothing about
progress. The file's own header defended this — *"servers past the cap are simply discovered
passively by the first user to call them, which is exactly today's behaviour"* — which is **true of
any one server and false of the estate**: the failure is not that some server waits, it is that the
same servers wait every time.

Migration 0118 adds `mcp_servers.last_health_probe_at`, a per-row rotation cursor, and the order
becomes: open-breaker cohort first (recovery is the time-critical half), then **least recently
considered**, then name only as a deterministic tiebreak. Every registered upstream is now reached
within `ceil(n / limit)` passes regardless of its name.

Three properties of that design are deliberate:

- **The cursor is stamped at SELECTION, not after the probe answers.** A row whose probe fails still
  moves to the back — its breaker, not this cursor, is what keeps it urgent — two concurrent passes
  select **disjoint** sets rather than racing over the same head of the queue, and a pass that dies
  half way leaves its rows late rather than starved.
- **A column, not a cursor table or a scalar position.** The sweep already reads and writes this row.
  A single position cursor would also be wrong, because the open-breaker cohort must keep jumping the
  queue, which a per-row stamp allows and a position does not.
- **Rows whose cooldown has not elapsed are no longer SELECTED at all**, filtered in SQL rather than
  selected and then skipped. That was a second way to starve the tail, found while fixing the first:
  a bounded pass could spend its whole budget on rows nobody is permitted to probe. `eligible` now
  means "a probe is possible right now" and `inCooldown` counts the rest, so the numbers add up.
- **`capped` alone was not enough for an operator to diagnose this**, so the result and the scheduler
  detail now carry `backlog`, `neverProbed` and `oldestProbeAt`. A steady backlog on a rotating
  estate is fine; a `neverProbed` that does not fall is the AER-037 symptom returning.

**Verification.** The rotation test creates `2 × limit + 1` servers **named so that name order and
registration order disagree** — if the ordering were still lexicographic the test would pass for the
wrong reason — and asserts across three bounded passes that every row is selected exactly once, read
from the cursor the sweep stamps rather than from its own counts. Probe measured: restoring `name
asc` reddens exactly the two AER-037 tests. The wording in both the function doc and the scheduler
description changed from "every registered upstream" to "up to N per pass", because that phrasing is
what made the starved tail invisible.

**Also fixed here, and it is the third instance of one mistake (M-048).** The sweep's two
egress-refusal tests used loopback with `allowPrivateRanges: false`. They passed alone and failed in
the full suite, because `mcp-proxy.test.ts` inserts an `egress_allow_hosts` row for `127.0.0.1` — so
the "blocked" host was allow-listed and the refusal never happened, leaving both tests asserting
`> 0` against 0. They now use a randomised TEST-NET-3 address (RFC 5737), which is public and
therefore independent of the private-range posture and of every other suite's allow-list — exactly
the remedy the paragraph in `g2-upstream-deadlines.test.ts` already prescribes for this.

**Remaining limit, named.** A cap plus a rotation bounds staleness at `interval × ceil(n / limit)` —
about 4 minutes for 50 servers and about an hour for 500. That is a real bound rather than a starved
tail, but it is not "every upstream every 5 minutes", and an estate large enough to care should raise
the limit or shorten the interval. The result's `oldestProbeAt` is what says whether it needs to.
