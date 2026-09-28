# ADR-0128 — A retry policy we own: a retry is an idempotence claim, and `tools/call` cannot make it

- **Status**: Accepted
- **Date**: 2026-09-28
- **Relates to**: [ADR-0126](0126-upstream-deadlines-and-circuit-breaker.md) (the deadlines this
  spends and the breaker this reports to), [ADR-0043](0043-mcp-egress-guard.md) and
  [ADR-0097](0097-mcp-admission-control.md) (the two refusals that must never be retried),
  [ADR-0021](0021-admin-configurable-policy.md) (the configurability debt this inherits from
  `timeouts.ts`), [ROADMAP §8](../product/ROADMAP.md) G2
- **Migration**: none — the policy is stateless. It reads `mcp_tools.kind`, which the initial migration
  already stores (`0000_organic_thanos.sql`, `mcp_tools.kind`).

## Context

The last of the three gaps in ADR-0126's resilience story. The deadlines bound one call and the
breaker bounds the hundredth; nothing turned the *first* transient failure into a second attempt.

**The honest description of the gap is narrower than "no retries", and auditing before building is
what narrowed it.** The model SDKs retry twice on their own — `maxRetries: 2` at four call sites in
`packages/model-provider/src/index.ts` — so the accurate statement is:

| path | state before |
|---|---|
| MCP `connect` | attempted **once** |
| MCP `tools/list` | attempted **once** |
| MCP `tools/call` | attempted **once** |
| model dispatch | retried twice, with the **vendor's** backoff, on the **vendor's** idea of what is retryable, invisible to our breaker and unattached to our deadlines |

So the gap on the MCP path was total, and on the model path it was ownership rather than absence.
This ADR closes the first. The second is named as an open item below rather than half-solved.

## Decision

### 1. A retry is an idempotence claim, and that is what decides where it applies

A retry is not a reliability feature. It is an assertion that running the operation twice is
indistinguishable from running it once. For MCP that assertion is true of `connect` and
`tools/list` — a handshake and a manifest read — and **it is false for `tools/call`**, which is an
arbitrary side-effecting operation on somebody else's system. A blind retry there can open two pull
requests, send two messages, charge two cards; worse, it does so only under packet loss, which means
never in a demo and always in production.

This product already knows which is which. §3's read/write distinction is stored per tool in
`mcp_tools.kind`, and `toolKind()` classifies a tool **without** `readOnlyHint` as a write. So
`attemptsForToolKind` reads that column and returns exactly `1` for a write — and for a tool whose
kind is unknown, because an unclassified tool is not "probably safe" and disagreeing here would make
the retry policy more permissive than the authorization policy it rides on. An upstream that wants
its writes retried can say so by declaring them read-only, and an upstream that lies about that has
lied about something this product already acts on everywhere else.

### 2. Retries never extend the bound an operator set

The naive wrapper multiplies the deadline by the attempt count: a 10s connect bound with 3 attempts
is a 30s wait, and the number in `timeouts.ts` that an operator read and approved has quietly become
a third of the truth. So **the budget for a whole retry sequence *is* the operation's configured
deadline**, and each attempt is handed whatever is left of it. Two consequences follow and both are
wanted:

- a **fast** failure (connection refused, reset, 503) leaves nearly all of the budget, so it is
  retried — which is the case retries actually help;
- a **deadline exceeded is never retried**, because waiting the full bound the operator chose and
  then waiting it again is not resilience, it is ignoring the bound.

The second is written into the classifier as its own verdict (`deadline_spent_the_budget`) rather
than left to emerge from the arithmetic, so it can be tested and so the audit row can say it.

A backoff additionally never consumes more than **half** of what is left: sleeping out the remainder
of a budget and then giving up for want of time is strictly worse than trying again immediately.

### 3. Our own refusals are never retried

The same distinction the breaker and the health probe make. An egress block (ADR-0043) or an
admission hold (ADR-0097) is an adjudication this gateway made. Retrying it re-runs a decision whose
inputs have not changed, three times, and tells an operator reading latency that the network is
flaky when the manifest is dirty. On an air-gapped install — where every outbound host is refused by
design — it would turn every call into three refusals with backoff between them.

The retry therefore wraps **both gates** inside `connectUpstream` rather than sitting inside
`guardedMcpConnect`. That placement has a second property worth stating: every attempt
re-adjudicates, so a retry can never become an egress or admission bypass.

### 4. The default is do-not-retry for an error we cannot name

Repeating an unrecognised error is a guess made at an upstream's expense — it might be a protocol
violation, a bad argument or a refusal. Retryable is an allow-list: a set of network codes, a set of
HTTP statuses read off the SDK's own `StreamableHTTPError`, and Node's codeless `socket hang up`
(recognised by message because there is nothing else to recognise it by, and it is the most common
transient MCP failure behind a proxy that reaps idle connections). `501` is deliberately absent —
"not implemented" will not become implemented in 200ms.

### 5. Full jitter, not a fixed delay

`random() * min(cap, base * 2^n)`. A fixed or equal-jitter backoff leaves N callers that failed
together still synchronised, which is the one property that matters when the thing being protected
is an upstream that just fell over. The rng is injected so a test asserts the schedule rather than
observing a random one.

### 6. One exhausted sequence is ONE failure to the breaker

ADR-0126's threshold — five consecutive failures — was chosen against a unit: one user-visible
failed operation. So the wrapper re-throws the last error and records nothing itself; the call site
still calls `recordUpstreamFailure` exactly once, after the whole sequence. Counting per attempt
would silently redefine "five consecutive failures is a pattern" as "two failed requests", making
the breaker three times more trigger-happy without anybody changing its configuration.

The bounded cost of that choice, stated rather than hidden: an upstream now sees up to
`maxAttempts` contacts per failed operation, so the contacts needed to open a breaker rise from
`failureThreshold` to `failureThreshold × maxAttempts` (5 → 15 at the defaults). **A cross-request
retry quota was deliberately not added**: the breaker already is one, and two mechanisms rationing
the same thing is two things to keep in step.

### 7. The last error is re-thrown unwrapped

Every call site already branches on `McpEgressBlockedError`, `McpAdmissionHeldError` and a deadline
predicate to choose its own status code. A wrapper error would have broken all of them at once, for
the benefit of a stack trace nobody reads.

### 8. No audit row per retry; the counts ride the one row that already existed

Verbatim the breaker's reasoning. A row per attempt turns one upstream outage into thousands of
near-identical entries and buries the transitions an auditor is looking for. Instead the caller
passes a `RetryReport`, and the `mcp-upstream-unreachable` row it already writes carries `attempts`,
`retryDelaysMs` and the classifier's `retryVerdict` — so the ledger says "we tried three times over
1.4s, and declined a fourth because the deadline was spent" on one row rather than on three that did
not exist.

`isDeadlineError` also **moved** out of `mcp-proxy.ts` (where it was private) into this module. The
retry classifier and the 502-vs-504 decision must not be allowed to disagree about what a timeout
is: one deciding "reset" and the other "timeout" for the same error would mean a retried call
reported as unreachable, or an unreachable one silently retried past its bound.

## Consequences

**Verification.** 26 tests in `zz-adr0128-upstream-retry.test.ts`, in three parts: the policy as
pure units, the wiring end-to-end against a real flaky upstream, and the write-tool claim.

- **Non-vacuity is built in rather than measured once.** The end-to-end recovery test has a twin
  that is identical except that the policy is switched to one attempt, and asserts the same flaky
  upstream fails. If the wiring in `connectUpstream` is ever removed, the pair disagrees and one of
  them goes red — a permanent test instead of a temporary edit somebody has to remember to repeat.
- **The read and the write tool are one test, on one upstream, failing the same way, in one pass**,
  because the only interesting question is whether they are treated differently and two separate
  tests could both pass while the distinction was absent. The read call returns its answer and the
  upstream counted **two** `tools/call` POSTs; the write call fails and it counted **one**.
- **Probe predicted and measured**: making `attemptsForToolKind` ignore the kind reddens exactly
  three tests — the two unit claims and the wiring test — and nothing else.
- The budget claim is asserted as a property (`every later attempt's deadline is strictly smaller`,
  and `the sequence fits inside the one configured bound`) with the fake honouring the deadline it
  was handed, because a fake that overran it would model a bug in the SDK rather than one this
  policy can control.

**One defect this file found in itself.** Part 2 originally built **two** apps, one with retries on
and one with them off. It went green in the wrong direction: `setRetryConfig` is a module singleton
(deliberately, exactly like `timeouts.ts` — a gateway process has one policy), so the second
`buildApp` silently set the policy for *both* and every "retries on" test was really running with
them off. The twin is now one app with the policy switched around each test, at the call site rather
than in a builder option, and `BuildAppOptions.retry` documents the process-wide caveat.

**Honest limits, named rather than narrated around.**

- **The model path still retries with the vendor's policy.** `maxRetries: 2` in
  `packages/model-provider/src/index.ts` is untouched: it is a separate change, it has no breaker to
  compose with yet, and folding it in here would have meant shipping two designs under one
  verification. It is the natural next item.
- **A `Retry-After` the upstream sent is not honoured.** `StreamableHTTPError` carries the status and
  not the headers, so a 429 is retried on our own backoff rather than the upstream's instruction.
  Small, because the backoff is bounded and the breaker catches a persistently throttling upstream,
  but it is a real gap.
- **A read tool that is not really read-only is retried.** That is the same trust this product
  already places in `readOnlyHint` for authorization, so the retry adds no new exposure — but it
  does add a new *consequence* to an upstream lying about it.
- **ADR-0021 debt, inherited verbatim from `timeouts.ts`.** Under the admin-configurability mandate
  these three numbers belong in `org_settings`; they are env-overridable constants instead, for the
  same reason and with the same natural follow-up (a column per field read through
  `loadOrgSettings`).
- **A retried connect costs the upstream a second handshake.** Cheap, and bounded by the budget, but
  it is not free and an upstream operator watching connection counts will see it.

**Switchable off.** `REGULAIT_UPSTREAM_RETRY_ATTEMPTS=1` restores pre-ADR-0128 behaviour exactly,
and a test asserts it does — because "you can turn it off" is a claim, and an untested claim about a
safety valve is the kind that is discovered to be false during an incident.
