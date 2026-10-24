# Session — 2026-09-28: a retry policy we own, two external findings, and two of my own claims that were wrong

*Append-only. Never edited retroactively.*

## What was asked

Continuation. The standing `/goal` is to keep building next-in-queue items until the product beats
its competitors, **checking open source before building from scratch**. The user had approved one
specific plan — *"verify the claims-vs-reality section first, then build the four no-decision
gateway-hardening items"* — and then went away. Two external review findings (AER-036, AER-037)
arrived mid-session via the owner committing to `codexInputs.md`, and were worked as they landed.

## What shipped

| Thing | Where |
|---|---|
| Active upstream health probing | `apps/gateway/src/mcp-health-probe.ts`, scheduler job, ADR-0126 amendment |
| ADR-0128 — a retry/backoff policy we own | `apps/gateway/src/upstream-retry.ts` (26 tests) |
| AER-037 — probe rotation | migration `0118_health_probe_rotation.sql` |
| AER-036 — Kong session origin derived, not asserted | `integrations/kong/**`, closed PDP vocabulary, ADR-0127 amendment |
| AER-035 item 3 — fault injected at the applier's last write | `zz-aer035-apply-atomicity.test.ts`, ADR-0056 amendment |
| Verification appendix II — pillars 7/8 and section 5 | `geminiInputs.md` |
| ABAC schema v2 — `context.clientIp` | `packages/policy-kernel/src/abac.ts`, ADR-0040 amendment |
| M-048, M-049 | `mistakes.md` |

Final state: **CI and Integrations both green on `5a9cad2`**, verified via the API. Local full
gateway suite on a fresh database: **199 files / 2969 passed / 9 skipped / 0 failures**;
policy-kernel 139 passed.

## The four findings worth carrying forward

**1. A retry is an idempotence claim, and that is what decides where it applies.** Not a reliability
feature — an assertion that running an operation twice is indistinguishable from running it once.
True of `connect` and `tools/list`, false of `tools/call`. So `attemptsForToolKind` reads §3's stored
`mcp_tools.kind` and gives a write — *and an unknown kind* — exactly one attempt. The corollary that
mattered as much: **the budget for a whole sequence IS the operation's configured deadline**, so
retries never extend a bound an operator approved, and a timeout is therefore never retried.

**2. A cap over an ordered set is a starvation bug unless the order moves (M-048).** I shipped the
health probe with `LIMIT 50` over `name asc` and wrote a paragraph in its header defending the cap:
*"servers past the cap are discovered passively by the first user, which is exactly today's
behaviour."* True of any one server, **false of the estate** — the same servers waited every time.
An external reviewer caught it the next day. Before defending a `LIMIT`, name the rows it excludes on
pass two; if they are the same rows as pass one, the tail is starved, not merely late.

**3. A grep that returns nothing proves the absence of a string, never the absence of a capability
(M-049).** I wrote verification appendix II — the document whose entire purpose is to stop agents
acting on unchecked claims of absence — and asserted in it that ABAC does not evaluate time-of-day.
It does, and carefully (policy-declared IANA zone, never the server's locale). I had grepped for
`timeOfDay`, a token the code does not use, and never opened the context Record twenty lines below
where I stopped reading. **The appendix's own "NOT CHECKED" section is what should have caught it.**
A "missing" verdict must now cite the file and line range of the structure read, not the grep that
failed to find it.

**4. Verification before building paid for itself three times over.** Of four planned
gateway-hardening items, three already existed. Of pillars 7 and 8, the DAG, the Team-Lead ceilings,
the PM inbound sync and the first-class `decisions` table all already existed — the real gaps turned
out to be narrower and different (wall-clock concurrency; whether PM state may drive the run state
machine). Of section 5's ten items, three already ship. Building any of those from the document's
description would have been weeks of rebuilding working code.

## Two things that could not be proven the usual way, and what replaced the proof

**The atomicity probe deadlocks instead of reddening.** The obvious non-vacuity check for the new
fault-injection test is to move one of the three writes onto the plain `db` handle and watch it go
red. Both attempts deadlocked and neither finished: the transaction holds `FOR UPDATE` on the
proposal row and, once it has written to the ledger, `pg_advisory_xact_lock(AUDIT_CHAIN_LOCK_KEY)`.
A second connection needing either waits on a transaction waiting for it. That is a **better** result
than the probe would have been — the boundary is structurally enforced, so a refactor that took a
write out of the transaction hangs in the suite rather than silently committing two facts of three.
What the test leans on instead is its own paired positive case.

**The Kong half could not be run locally** (no Docker this session). Both Lua files were
syntax-checked with `luac -p`, and the claim rested on the Integrations job until that job actually
ran and passed — at which point the ADR was corrected to name the run rather than keep the hedge.

## Predicted wrong twice in one test, and wrote down the measurement

Building ABAC v2 I predicted the v1 behaviour of a guarded network policy twice and was wrong twice.
A guarded v2-style policy **passes** v1 validation (Cedar's `has` on an undeclared attribute is legal
and always false, `&&` short-circuits). First guess: it therefore never fires. It is the opposite —
`forbid … unless {guard}` with a permanently-false guard **forbids every request**, including
on-network ones. Safe direction, but an outage. The test now asserts the measurement and the ADR
records that it was measured after two wrong guesses, because a prediction that survived two
falsifications is not something to state as reasoning.

## The scratch-database trap, twice

A `409 conflict` from `abac-policy.test.ts` is **not** a regression: that file creates global fixtures
and only cleans up on a clean exit, so any killed run leaves it conflicting forever after. It passes
on a genuinely fresh database. Separately, two egress tests in the health-probe file passed alone and
failed in the full run because `mcp-proxy.test.ts` allow-lists `127.0.0.1` — **the third instance of
M-040/M-042**, fixed the way `g2-upstream-deadlines.test.ts` already prescribes: a randomised
TEST-NET-3 address, which is public and therefore independent of every other suite's state.

## Left open deliberately

- **In-flight PII redaction** is the one positively-confirmed gap in section 5 (verbs are
  `block|warn|log`, no mask). It carries a **governance fork**: a `redact` verb means data that would
  have been blocked now flows, masked. Recommended as strictly opt-in, never a cascade default and
  never reachable from an existing `block` — but that is the owner's call, not an assumption to make
  while they are away.
- **SIEM streaming, SOAR webhooks, tool-result malware scanning and outbound secret classifiers** were
  NOT FOUND. Each needs a build decision, not just work.
- **ISO 27001** does not ship (the ISO pack is 42001 — a different standard). `soc-2` and `hipaa` do.
- **Wall-clock concurrency** in the orchestration wave needs a decision on per-provider concurrency
  limits and partial-failure semantics first.
- Five older OPEN HIGH findings — AER-017, AER-018, AER-019, AER-021, AER-022 — untouched all session.

## Process note

`check_suite.completed` notifications on this PR have meant *"cancelled by my next push"* **seven
times**. Every green claim in this log was verified through `actions_list` against a named run id.
