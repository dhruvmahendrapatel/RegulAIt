# ADR-0125 — Shared enforcement counters: the one limit that multiplied by the replica count, and the one that erased itself

- **Status**: Accepted
- **Date**: 2026-09-26
- **Relates to**: [ADR-0031](0031-security-hardening-batch.md) item 4 (the HTTP rate limiter this
  moves out of process memory), [ADR-0064](0064-in-process-scheduler.md) (enforcement never depends
  on a sweep — why the prune here is allowed to be a plain timer),
  [ADR-0087](0087-pillar7-orchestration.md) §5.2 (the measured run/node budgets whose accumulation
  this makes atomic), [ROADMAP §8](../product/ROADMAP.md) G1
- **Migration**: [`0115_rate_limit_counters.sql`](../../packages/db/migrations/0115_rate_limit_counters.sql)

## Context

A gap analysis against Kong (ROADMAP §8) listed twelve things an API gateway has that we do not.
Ten are features. **Two were defects**, and this ADR is the first of them.

The survey that produced §8 said "rate limits and budgets live in process memory". Auditing it
properly before building anything, that turned out to be **too broad, and the correction matters**:
almost every enforcement counter in this product was already shared, because it was already SQL.

| counter | where it lives |
|---|---|
| kernel `rate_limits` rule | `count()` over `audit_log`, sliding window — `governed-evaluate.ts:406` |
| project budgets | `sum(usage_events.cost_usd)` — `projects.ts:252` |
| virtual-key USD budgets | atomic `spent_usd = spent_usd + x` — `virtual-keys.ts:248` |
| login lockout | `users.failed_login_count` |
| replay guards (SAML, TOTP, OIDC) | unique indexes and columns |

Two were not:

1. **The HTTP edge rate limiter.** `@fastify/rate-limit` registered with no `store`, which is its
   default per-process `Map`.
2. **The measured run/node budget** (`orchestration_runs.budget`). Postgres-backed, but
   read-modify-write.

Both are real, and they fail in opposite directions, which is why they are one ADR.

## Decision

### 1. The edge limiter counts in Postgres — and the naive version of that is a mistake

With one process the in-memory store is correct. With two it is not approximately wrong, it is
wrong **by a factor**: each process admits the full ceiling independently, so N replicas enforce
N × the configured limit *while the posture page goes on reporting the configured number*.
Enforcing a number you cannot name is worse than enforcing nothing, because nobody goes looking.

The obvious fix — one `INSERT … ON CONFLICT` per request — is correct and would be a mistake. A
rate limiter is the cheapest thing in the request path precisely because it is what stands in front
of a flood. Give every unauthenticated request a database **write** and an attacker can turn a
request flood into a Postgres flood: the limiter becomes the amplifier it exists to prevent.

So `SharedRateLimitStore` is **local-first, shared-authoritative**:

1. bump an in-process counter, as before;
2. if the **local** count alone has already passed the ceiling, refuse and touch nothing;
3. otherwise ask Postgres atomically, and let its answer win.

Step 2 is sound rather than a heuristic — local ≤ global always, so a process that has by itself
exceeded the limit has exceeded it. It is also what **bounds the write rate**: writes only happen
while local ≤ max, so at most `max` per process per window however long a flood lasts.

**Strictly greater, not `>=`, and the difference is load-bearing.** At `hits === max` the request is
still allowed (the plugin refuses on `current > max`). Short-circuiting there would let each process
serve the last request of every window without telling the database — the shared count would
under-report by one per process per window. That was written as `>=` first and a test caught it.

The window stays **fixed**, reproducing the old store rather than upgrading to sliding. Changing
where a counter lives is the wrong moment to change what every configured number means.

### 2. It fails OPEN, and that is stated rather than discovered

On a database error the store falls back to the local count and serves. This is the one place in
this product that deliberately fails open, so:

- this gateway cannot answer a single governed request without Postgres — every decision reads it —
  so a database outage is **already** a total outage. Failing closed here converts "Postgres
  blipped" into "every caller sees 429", which is louder, not safer.
- the degradation is bounded: the local ceiling still applies, so a process serving through an
  outage still enforces the full configured limit on its own traffic. That is exactly the pre-ADR
  behaviour, which is the worst it can get.

### 3. The prune is hygiene, not enforcement — which is why it may be a timer

Rows are bounded by **distinct callers in a window**, not by requests. A stale row is already
harmless because every read compares the window before trusting the count, so ADR-0064's rule — no
ceiling may depend on a sweep having run — holds. Retention is an hour against a widest configured
window of five minutes, and the margin is the point: deleting a row whose window is still live would
reset that caller's count mid-window and hand them a fresh allowance, turning a cleanup job into a
documented way around the limit.

### 4. The measured run budget is added up by the database, not by whichever worker writes last

The agentic loop held its own running totals, seeded at loop start, and overwrote the whole `budget`
JSONB after every turn. Correct for one worker — and pillar 7's entire proposition is running
independent nodes of one task graph **in parallel**. Two workers each wrote an absolute computed
from what they read at their own start, so whichever landed second **erased the other's charges**.

The visible consequence is the bad one: a run could spend past its cap with the ledger showing it
under, and the per-node ceilings inherited the same hole because they ride the same JSONB.

`chargeRunBudget` now posts a **delta** and the database does the addition under `FOR UPDATE` on the
run row — blocking, deliberately not `SKIP LOCKED`, because the second writer must wait and then add
rather than step over. It returns the stored totals so the escalation checks fire on what the ledger
says rather than on the caller's own arithmetic.

### 5. Both tests were proven able to fail

A single-process test cannot see either defect: it passes identically before and after. So the tests
that matter are **two apps on one database** and **twelve concurrent charges**, and both were run
against the old implementations to confirm they go red. The write-bounding test additionally asserts
the counter reaches `max` *before* it stops advancing, because a store that never wrote at all would
satisfy "stops advancing" trivially — and did, during exactly that check.

## Consequences

**What this buys.** More than one gateway process now enforces the limits an admin configured,
rather than a multiple of them, and a fanned-out run can no longer spend past its cap while
reporting that it has not. ROADMAP G1 closes.

**What it costs.** One database round trip per request per caller **below** the ceiling — bounded,
and skipped entirely once a bucket saturates. One short row lock per node charge.

**What this is NOT.** It does not make the gateway horizontally scalable; it removes one of the
reasons it is not. The scheduler was already lease-safe (ADR-0064), but request-scoped in-process
state elsewhere has not been audited for multi-process safety, and the deployment still ships one
replica with a fixed host port. **Do not read this ADR as "we support HA now."** ROADMAP G2's
timeouts and breaker, and a real audit of per-process state, come first.

**Still read-then-act.** Project budgets remain an unlocked read of `sum(usage_events)` before the
charge, so the first crossing is allowed — documented, deliberate (`projects.ts:723`), and widened
slightly by concurrency rather than introduced by it. The virtual-key check has the same shape over
an atomic counter. Neither is made worse here; neither is fixed here.
