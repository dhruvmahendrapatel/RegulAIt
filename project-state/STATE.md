---
phase: p1-security-in-progress
last_updated: 2026-09-30
active_epics: []
completed_epics: [EPIC-01, EPIC-02, EPIC-03, EPIC-04, EPIC-05, EPIC-06]
open_questions_open: []
last_session: sessions/2026-09-30-session-03.md
roadmap: ../docs/product/ROADMAP.md
---

# RegulAIt — Project State

> **Maintenance note (2026-07-31): this file was allowed to drift and has been caught up.**
> Between PR #57 and PR #75 — roughly eighteen PRs including the entire React SPA rewrite and the
> whole authentication system — updates went into the session log
> (`sessions/2026-07-30-session-03.md`) but NOT into this file, which `CLAUDE.md` names as one of
> only two artifacts guaranteed to persist across sessions. The recap below is now current as of
> PR #75. **Lesson for future sessions: update STATE.md at the same moment as the session log, not
> at the end of a long batch** — a session that ended unexpectedly during that window would have
> handed its successor a file describing a project with "no workload to deploy".

## Where we are (read this paragraph first)

**2026-09-30 - Structured consent and complete model-output gates
(ADR-0141/0142).** Added a bounded decoded-JSON redactor and frozen action
preparation that binds original/effective payloads, category policy and both
transform versions. Previews contain the effective action, with credentials
scrubbed; deep/prototype-shaped inputs have explicit safety tests. These are
primitives, not enabled in-flight redaction. Actual model block-mode gaps were
also fixed: PII-only and guardrail policies suppress text AND thinking events,
scan thinking/tool calls, withhold every content channel on a block, and flush
only inspected final content on success. 1,085 shared tests and 204 gateway
tests passed; shared build and gateway typecheck passed. A temporary negative
control failed all four targeted output cases, and was restored before final
verification. The previous `40eb442` commit is confirmed CI-green. New batch
CI is pending. Provider collection limits/cancellation, final-policy binding
and actual redaction integration remain open; the full parity goal is active.

**2026-09-30 - PII redaction foundation (ADR-0140).** Shared validators now
support in-process offsets; `redactPII` performs deterministic full-region
replacement across all 14 supported categories. Existing detection counts,
opt-in defaults and conformance scores are unchanged. All 1,019 shared tests
passed, including 103 new tests; shared build and gateway typecheck passed.
No gateway redaction mode is enabled: structured payloads, exact effective
approval binding, final policy checks and bounded complete-output handling
remain required by ADR-0137. The active full-Credo-parity goal is tracked in
[the current checklist](../docs/product/CREDO_PARITY_CHECKLIST_2026-09-30.md),
using primary vendor pages and the owner's Discover -> Assess -> Govern
workflow reference. Historical completion labels do not establish current
feature or workflow parity. No production deployment occurred.

**2026-09-30 - External-write emergency gate (ADR-0139).** Deployment,
rollback, Git branch/PR/merge, infra remediation and PM mutations now check
the live execution mode at the final provider call. Halted/read-only/
require-approval modes refuse writes; halted workflow stages and infra
approvals remain retryable. A halted auto-remediation is marked deferred and
retried on the next scan if the policy still permits it. Six focused files
passed 31 tests and six adjacent files passed 43 tests on disposable databases;
gateway typecheck passed, and `8507fa3` passed exact-head CI. AER-018 is
mitigated on the enumerated paths, but paused-call counting-fake coverage for
every adapter and already-in-flight cancellation remain unverified. Do not claim a complete
deployment-wide halt from these tests alone.

**2026-09-30 - Cache-hit governance (ADR-0138).** Native and compat cache
hits now re-enter the shared dispatch core before serving. Live virtual-key,
MRM, attribution, use-case, project-budget, input PII/guardrail and output
PII/guardrail denials withhold cached text and record neither a saving nor
provider usage. Four adjacent cache/interception suites passed 93/93 on a
disposable database; gateway typecheck passed. AER-010's documented bypass is
repaired, and commit `b33de7c` passed exact-head CI. An explicit
negative-control mutation remains unrun. Native cache identity/version
invalidation remains a separate AER-011
review. AER-018's non-AI provider paths and PII redaction remain open.

**2026-09-30 - P1/P2/P3 continuation.** AER-035's six focused copilot
fault/concurrency tests passed after an app rebuild before retry; OS process
kill/recovery remains unverified. AER-011 compat cache identity now includes
the complete canonical request rather than lower-cased flattened text;
the eight-test compat suite and gateway typecheck passed. AER-010 remains
HIGH because cache hits still return ahead of shared dispatch gates. The
ISO/IEC 27001:2022 partial evidence seed (ADR-0134) passes 18 shared and
15 gateway pack tests;
it is not an SoA or certification and requires customer attestation. P3 now
has a proposed delivery/detection contract and a 10-case synthetic detector
baseline (ADR-0135); no SIEM adapter or outbound secret block is live. PII
redaction is a proposed boundary only (ADR-0137), not enabled: count-only
detectors cannot yet perform validated in-flight replacement, and current
cache governance/streaming gaps must be closed before that mode ships.

**2026-09-30 - Breaker transition audit atomicity (ADR-0133).** AER-023
reproduced in source and fixed: opened/probing/closed state and audit facts
commit together; recovery reads the locked current row. New fault/concurrency
tests passed 4/4, and the existing breaker/retry/health suites passed 40/40
on a fresh database. The health suite also revalidated AER-037 rotation over
the cap. Full CI for this new batch is pending.

**2026-09-30 - Emergency transition atomicity (ADR-0132).** AER-019's six
set/lift paths now lock the control row and commit state plus audit together.
The existing emergency suite passed 15/15; six new tests passed fault injection
for all directions, app restart/readback, 20-way contention on mode/agent/tool,
and conflicting mode-history ordering. AER-018's external provider paths are
still outside this fix; no deployment-wide halt completeness claim follows.

**2026-09-30 - Signed report export isolation (ADR-0131).** AER-007 reproduced:
non-admin report bundles contained unrelated audit payloads. Version-2 bundles
now disclose only subject-row payloads, keeping contiguous signed hash
commitments for other rows. The verifier names the reduced proof and rejects
extra audit payloads (AER-009). Route-level non-admin denial/entitlement,
synthetic sentinel isolation, pinned offline verification and the full 28-test
bundle suite passed on a disposable database. Admin full-payload bundles stay
version 1. Full CI for the preceding approval commit failed only a flaky
relative login-timing assertion (30 ms versus 67 ms under runner load); both
failure paths still exceed the scrypt floor. The ratio check was removed and
its targeted case passed locally; the next CI run is the full gate. Remaining P1 cache and emergency findings, crash verification,
P2 and P3 are not closed by this change.

**2026-09-30 - P1 approval binding is being hardened (ADR-0130).** The P0
follow-up commit f666733 passed full GitHub CI (run 36653593771) and Kong
integration (run 36653593778). AER-004 source revalidation found the legacy
null-context and ABAC identity gaps and the policy activation race. Migration
0119 adds a database policy epoch; consumption holds a shared epoch lock while
it compares the evaluated generation and spends a matching approval. The
context digest is v2 and binds active ABAC policies; null contexts re-queue.
The approval suite passed 14/14 on a fresh disposable database before the
settings posture response was added. P1 export, cache and emergency controls,
P2 and P3 remain in the approved sequence.

**2026-09-29 - Owner-approved delivery order; P0 fixes implemented in dd50ab2.**

The owner approved: P0 breaker/retry fixes, P1 security findings and crash/concurrency
verification, P2 in-flight PII redaction then an ISO 27001 evidence pack, P3 SIEM and
outbound-secret detection scoping, and design-first treatment of the larger extensions.
This supersedes the older next-work ordering below. AER-017 and AER-021 are already
resolved in the latest audit and are not new implementation work.

ADR-0129 records the P0 change: manifest requests elect before connecting; proxy and
delegated tool calls use one shared admission path; successful initialization never
clears a breaker; every tool call receives one attempt regardless of readOnlyHint.
The final focused run passed 45 tests, including both previously failing CI regressions
and mixed proxy/worker/discovery contention. Workspace build, final gateway build and both
CI preflights passed. Local tests used a task-owned temporary PostgreSQL cluster, separate
from the installed service. The full local run was not completed: see the session log for
the inherited-credential failure and PII measurement timeouts. GitHub checks on the published
commit are the full Linux gate; do not infer a full-suite pass from the focused results.
P1 approval/export/cache/emergency-control work follows the P0 CI gate. No production
designation or deployment was performed.

P0 CI follow-up: run 36652212904 passed the breaker/retry suites but exposed two
egress fixtures sending empty MCP bodies. They now send valid tools/list requests
and retain every denial assertion; IMDS allow-list cleanup now runs in finally,
preventing the two downstream OIDC failures that the skipped cleanup caused.
The combined egress/breaker/retry run passed all 65 tests on a fresh task database.
See session-02 for the first CI failure and follow-up evidence; the published
follow-up commit's checks remain the full-suite gate.

**2026-09-28 (latest) — the three unverified claims closed, two external findings fixed, and
ABAC schema v2 adds network location. M-048 and M-049 logged.**

The session's build work: ADR-0128's retry policy (a retry is an idempotence claim, so a write
tool gets exactly one attempt and the budget for a sequence IS the operation's deadline), the
active health probe, then two findings from an external review — AER-037 (the probe's cap over a
constant order starved the tail of the estate; migration 0118 adds a rotation cursor) and AER-036
(the Kong adapter could label API-key traffic as SSO and the PDP believed it; the origin is now
derived from the credential and a contradiction is refused). Then AER-035 item 3: a fault injected
in Postgres at the applier's last write, proving the abort undoes the mutation AND the marker.

**Verification before building, twice over.** `geminiInputs.md` appendix II closed pillars 7/8 and
section 5: the orchestration DAG, Team-Lead ceilings, PM inbound sync and first-class decisions all
already exist — the real gaps are narrower (wall-clock concurrency; whether PM state may drive the
run state machine). Guardrail block mode, SAML+SCIM and the SOC-2/HIPAA packs ship. **Then I got one
wrong in that very appendix** and corrected it: ABAC does evaluate time-of-day. M-049's rule — *a
grep that returns nothing proves the absence of a string, never the absence of a capability* — is
the most reusable thing this session produced.

**ABAC schema v2** closes the one gap that survived: `context.clientIp`, Cedar's own `ipaddr` type,
`required: false` so strict validation forces `context has clientIp` and "we don't know" is decided
at write time. The version boundary is what makes it safe — emitting it to a stored v1 policy group
would fail-closed every governed call, so `contextFor` takes the schema version. No device-posture
attribute, because nothing here can observe posture and an unpopulatable attribute is an assertion
nobody checked.

Next, in order: in-flight PII redaction (the one confirmed section-5 gap — the verbs are
block/warn/log with no mask), an ISO 27001 pack, and the five older OPEN HIGH findings
(AER-017/018/019/021/022). SIEM streaming, SOAR webhooks, tool-result malware scanning and outbound
secret classifiers were NOT FOUND and need a build decision, not just work.

**2026-09-28 — the two genuine gaps in gateway hardening, closed: ACTIVE upstream health probing
and a retry policy we own. ADR-0128 added.**

Verification before building paid for itself: of four planned "gateway-hardening" items, three
already existed, so the work narrowed to two. (1) **Active health probing** —
`mcp-health-probe-sweep`, registered as a scheduler job under ADR-0126, makes the platform the
first caller after an outage instead of a user. It reuses `breakerAdmits` so it enters the
breaker's own one-winner election rather than re-implementing it, probes broken upstreams FIRST
because recovery is the time-critical half, and counts OUR refusals (egress-blocked,
admission-held) separately without ever charging them to the breaker — an air-gapped install
would otherwise report every upstream as circuit-broken on a deployment where nothing is wrong.
Not a control: with the scheduler off (the shipped default) behaviour is byte-identical, because
the breaker still learns passively.

(2) **A retry policy we own** (ADR-0128). The honest gap was narrower than "no retries": the model
SDKs retry twice already, so on the MCP path the gap was total and on the model path it was
*ownership* — vendor backoff, vendor classifier, invisible to our breaker. The design turns on one
sentence: **a retry is an assertion that running an operation twice is indistinguishable from
running it once**, which is true of `connect` and `tools/list` and false of `tools/call`. So
`attemptsForToolKind` reads §3's stored `mcp_tools.kind` and gives a write — and an unknown kind —
exactly one attempt. The budget for a whole sequence *is* the operation's configured deadline, so
retries never extend a bound an operator approved and a timeout is never retried; our own refusals
exit on the first attempt; one exhausted sequence is ONE failure to the breaker, not three. The
recovery test carries a permanent twin with the policy set to one attempt, so removing the wiring
reddens the pair rather than needing a remembered experiment. The file also caught a false green in
itself: two apps in one process cannot hold different retry policies, because the config is a
module singleton and the second `buildApp` silently set it for both.

Open on this thread: the model path still retries with the vendor's policy, and pillars 7/8 plus
the owner's new `geminiInputs.md` section 5 are still unverified.

**2026-09-27 (latest, second entry) — AER-035: one human approval could be spent twice, and did
create ten governance rules under test. ADR-0056 amended for the fifth time, M-046 logged.**

An external review found the copilot's proposal applier **not transactional and not
concurrency-safe**. It read the proposal, checked `applied_at`, ran the mutation, wrote the marker
and appended the audit row as five independent statements with no lock. Two concurrent requests
could both see `applied_at = NULL` and both spend one human's consent; `rule_to_approval` is the
material case, because `createApprovalRuleRow` is an unconditional insert with a fresh id. **With
the lock removed, twenty simultaneous applies produced ten successes and ten live approval rules
from one approval.** With it: one and one.

The fix is one transaction opened with `SELECT … FOR UPDATE` on the proposal row, with every choke
point widened to accept a transaction handle through ADR-0074's existing `DbOrTx`/`DbOrTxDeep`
types (plus a `DbOrTxWrite` for the ones that DELETE) rather than a new mechanism. Refusals are
audited **after** the rollback on purpose: a deny row written inside the transaction would roll back
with it and leave the one case an operator most needs to find unrecorded.

**And the process failure is mine, not the reviewer's find.** B8c filed this under honest limits as
"not transactional across its audit row" — which sounds like a records-keeping nicety when the real
property was that the change could happen twice — and batch B9a, which *added tests to this exact
route* five weeks later, copied that sentence forward without re-deriving it. M-046: *a limit you
wrote down is a claim you have not re-checked; when you touch the code it describes, re-derive it.*
The existing tests "proved" idempotency by applying twice in sequence, which is a different property,
and their passing is what let me believe the ground was covered.

**Also in this pass:** the Kong adapter now sends the decision context it can state truthfully —
`project_id` and `session_origin` as per-route config — and deliberately still sends no `args`,
because a *wrong* body-to-arguments mapping would evaluate a data-scope rule against the wrong
values, which is worse than the fail-closed deny that omitting them produces. There is no
`mfa_completed` field for the same reason: Kong cannot observe a second factor, and a configured
`true` would be an unchecked assertion in the trusted path. The harness now asserts all of this
against the PDP's own `contextApplied` ledger — including that `args` is NOT claimed — so the
README's disclosure is measured rather than promised, and it cleans up after itself (revokes the
scratch PDP key, removes its temp directory, drops its scratch database), which was AER-033's
residual hygiene.

**Closed in the same pass — AER-034 and AER-031.** The Kong README's "What is actually asserted"
listed `approval_required`, a non-200 PDP and an unparseable PDP answer, and the harness asserted
none of the three. They are asserted now rather than removed: `approval_required` needed a third
subject (entitled AND caught by an approval rule, because putting a rule on the entitled consumer
would turn the `allow` control into a different test), and the two answer-shaped failures needed two
more governed routes whose plugin instances point at stub PDPs — a plugin's config being per route is
what makes "the same upstream, a broken decision point" expressible at all. **Green in a real
container on the first run**, and the Kong access log corroborates each branch independently:
`regulait pdp returned 500` → 503, `/pdp-junk` → 503, and a 403 whose body length differs from the
policy-deny 403 because it carries `approval_required`. AER-031's last residue is gone too —
`docs/deployment/README.md`'s index row said "Kong only, no Envoy adapter" and then described "the
Envoy and Kong adapters" in the same cell.

**One process failure worth the ledger (M-047).** The AER-035 concurrency test passed five tests
locally and broke the CI build on two nonexistent column names. `vitest run` does not typecheck, and
drizzle silently drops unknown keys — so the test was green, correct about the thing it asserted, and
uncompilable, all at once. I had run the gateway typecheck after editing `copilot.ts` and then written
the test file and run only vitest: the check I ran was not the check CI runs. Same family as M-041 and
M-045. Mitigation in use from here: after touching a test file, run the owning package's `build`.

**2026-09-27 — the PDP credential stopped being an administrator, the authorization
callout started asking the same question a dispatch asks, and the copilot's propose half got both
a gate and a UI. Migration 0117, ADR-0127 and ADR-0056 amended.**

**AER-027 — the most exposed component held the keys to the control plane.**
`POST /v1/authz/check` is admin-gated, so the only credential a data-plane proxy (Kong, an
`ext_authz` sidecar) could hold to ask it was an **admin API key** — one that reaches every other
admin route in the product, to do a job that is one question wide. Virtual keys gained a `purpose`
(migration 0117, `dispatch` | `pdp`, defaulting to `dispatch` so every existing key keeps exactly
the routes it had). A `pdp` key reaches that one route and nothing else: it cannot dispatch a model,
read a ledger, or mint another key, and it is never an administrator whatever its owner is. Minting
one is itself an admin act, because such a key can ask about **anybody**. The separation is asserted
in both directions — a `pdp` key is refused `GET /v1/me` (which is on the dispatch allow-list, so
the refusal is about purpose rather than about a route that happens to be closed), and a `dispatch`
key cannot ask an authorization question about anyone.

**AER-028 — "fails closed" is not a defence when the closure is indiscriminate.** The callout
passed `args = undefined, projectId = null, principal = undefined` into the kernel. The consequence
was not that rules were skipped: the kernel **fails closed on a data-scope rule whose argument is
absent**, so any deployment with one got `deny` from the PDP for calls that would really have been
allowed. That is wrong in the safe direction, which is the direction that gets a PDP switched off —
an operator whose proxy denies everything removes the proxy, and then nothing is governed at all.
The request now accepts optional `args`, `projectId` and `principal`, all believed exactly as
`userId` already was (in this topology the proxy is the only component that *can* supply them, which
is why the credential above is purpose-scoped), and the response carries `contextApplied`: the
**names** of the dimensions the decision was computed on, never their values, so a proxy that
believes it is sending arguments and is not can tell its own misconfiguration from a policy refusal.
The fail-closed behaviour with no args is asserted **unchanged** — the fix is context, not a
relaxation, and the tests are written to tell those two apart.

**A real product defect fell out of it.** The parity suite caught the fallback-chain virtual-key
allow-list refusal writing its audit row through `auditHop`, which stamps `objectType: "agent"` —
so a credential-scope denial was filed against the wrong object type. It now writes
`objectType: "virtual_key"` against the key's own id.

**And one claim I made repeatedly in this session was false.** I said no license could be installed
in any environment. `demo:setup` had been minting one all along. The ephemeral-license path added for
the e2e suite (`REGULAIT_EPHEMERAL_LICENSE=1`, keypair generated at seed time, private half never
persisted) is still worth having, but it did not close the gap I claimed.

**Batch B9a — consent was being asked for diffs that could not be applied.** The copilot's diff
validation lived in the **applier only**, and `copilotProposalSchema` types `diff` as
`z.record(z.unknown())`. So a malformed diff was recorded, an ordinary Approvals-Queue item was
opened, a named human read a title and a rationale and consented, and only then did the product
answer `proposal_diff_invalid` — leaving a real human approval permanently on the audit record
against a change that could never happen. The existing test proposed `diff: { revoke: […] }`, a
shape no applier branch can read, and asserted **201**; having to change that test is the clearest
statement of what was wrong. There is now one authority, `validateCopilotProposalDiff`, called from
both ends, and the applier lost four inline copies of the same parsing. Its call is kept anyway:
pre-gate rows are still in the table, and defence in depth at a mutation door is not a duplication
worth trading away — two *different* implementations of one check would have been.

**The propose half also had no UI at all.** The copilot page could list proposals and apply approved
ones, so the product's single most governed write was the one an admin could not reach without curl.
The new form covers all four kinds, and its shape follows from the gate: every target is **chosen
from the real object** rather than typed (a retyped uuid is the likeliest cause of a refused
proposal, and there is now no box to retype one into), each patch field carries its own inclusion
toggle beside its current value (absent is not the same as set to what it already is), a
`rule_to_approval` inherits the source rule's scope rather than asking for it again, and the exact
diff is rendered before it is sent — the recorded object is what a named human will be asked to
approve. The e2e compares the previewed JSON byte-for-byte against what the server stored, because a
preview that drifts from the payload is worse than no preview. The affordance census
(`scripts/preflight-ui-affordances.mjs`) drops its add-affordance list from two entries to one — `/v1/redteam/libraries`
remains, and two delete orphans did too (`/v1/approvals/views/:x`,
`/v1/llm/backend-configs/:x`). **I first wrote that it reported "0 add gaps", in three
documents. That was wrong**: I read the census output as though closing the copilot entry
emptied the list, when the remaining entry was printed directly beneath it. All three are
corrected in place.

Verification: gateway suite green after the one remaining failure was identified and fixed — it was
`adr0127-advisory-decisions.test.ts`'s CLOSED-SET contract assertion, which `contextApplied`
legitimately widened; it was widened by exactly one field rather than exempted, and now also asserts
that `contextApplied` holds only names from a fixed vocabulary (an implementation that put argument
values there would have satisfied the old key check and leaked the very thing it exists to prevent).
Playwright **148/148**.

**2026-09-26 — D01 and G1 fixed. ADR-0125, migration 0115. Both write-ups were wrong first.**

**D01, and I had described it wrongly.** I wrote that a malformed `REGULAIT_DATA_KEY` "boots clean".
It does not — `keyBytes` throws and nothing starts. I had read the code instead of running it; the
PENDING entry now carries that correction in its own heading. What was *actually* wrong was two
narrower things. (i) The refusal was right and the **message** was not: `keyBytes` threw a plain
`Error` and `main.ts` only converts `DataKeyBootError` into the operator sentence, so the one place
written to be read mid-restore printed a stack trace. There is now a `malformed_key` code decided
**first** — with a recorded fingerprint present the old ordering would have reported `key_missing`
and sent an operator hunting a lost key rather than fixing a typo. (ii) **The seeder had no gate at
all**, which is where the bare 500 came from: `seed.ts` builds an app directly rather than through
`startGateway`, and it is usually the FIRST thing run on a new deployment. It now checks shape up
front.

**And fixing it exposed a worse bug than the one I was fixing.** The `switch` in
`verifyDataKeyOnBoot` is what stops a boot — `decision.ok === false` stops nothing, the `throw`
does — and it had no exhaustiveness check. Adding a code without a case would have made the gateway
**come up on a key it had just refused**. There is a `never` default now. Root cause of my own
error: `secrets.ts` said hex, `audit-scrub.ts` said base64, and only `Buffer.from` settled it. One
exported authority (`dataKeyFormatError`) which `keyBytes` itself uses, so the validator can never
be more lenient than the parser.

**G1, and that item was too broad too.** Auditing before building found almost every enforcement
counter was ALREADY shared because it was already SQL — `count()` over `audit_log` for the kernel's
rate limits, `sum(usage_events)` for project budgets, an atomic increment for virtual keys, a column
for lockout. **Exactly two were not**, failing in opposite directions:

- **The HTTP edge limiter** on the plugin's per-process `Map`: N replicas enforced N × the ceiling
  while the posture page reported the ceiling. Now Postgres-backed — but **local-first**, because
  the naive one-write-per-request version lets an attacker turn a request flood into a Postgres
  flood and makes the limiter the amplifier it exists to prevent. The local short-circuit is what
  bounds writes to `max` per process per window. It is `>` not `>=`, and that is load-bearing: at
  `hits === max` the request is still allowed, so `>=` would leave the last request of every window
  unrecorded. Written as `>=` first; a test caught it. It fails **open** to the local count, stated
  rather than discovered — no governed request can be answered without Postgres anyway.
- **`orchestration_runs.budget`** was Postgres-backed but read-modify-write, and pillar 7 runs nodes
  in parallel, so two workers each wrote an absolute and the second **erased the first's charges** —
  a run could pass its cap with the ledger showing it under. Now a delta added under a blocking
  `FOR UPDATE` (not `SKIP LOCKED`: the second writer must wait and then add).

**Both new test files were run against the OLD implementations to confirm they go red**, because a
single-process test cannot see either defect. The write-bounding test also asserts the counter
reaches `max` *before* it stops advancing — a store that never wrote at all would satisfy "stops
advancing" trivially, and did, during exactly that check.

**This is NOT HA**, and the roadmap now says so where it used to say only "one replica": no
timeouts, no breaker, no `/metrics`, a fixed host port, and per-process state outside the limiter
unaudited. G2 and G8 come first.

**Verification**: **191 files / 2867 passed / 9 skipped, exit 0 on a fresh database** (+18 tests,
+2 files), all packages built, web typecheck clean, instrument counters at zero.

**2026-09-26 (later) — the demo runbook walked on a docker-less box. Two blockers, and M-041.**

The container this session runs in has no docker daemon, so the runbook's very first command
(`docker compose up -d db minio minio-init`) does not work here at all — a live failure waiting for
Monday if the demo runs from a machine like this. DEMO_RUNBOOK §1.1 is the native-Postgres path.

**I got its first command wrong, and that is M-041.** I wrote `openssl rand -base64 32`;
`keyBytes` (`secrets.ts:32-35`) does `Buffer.from(key, "hex")` and requires 32 bytes, so it must be
64 hex characters. I had looked it up — `audit-scrub.ts` asserted in a comment that the key "is
base64 of 32 random bytes", `app.ts:206` says "hex AES-256 key" eleven hundred lines away, and I
read the wrong one. **Two comments disagreed; only the parser settles it.** The wrong comment is
fixed, because a wrong comment in a security file is a defect.

**What it exposed is worth more than the typo, and is PENDING D01.** Nothing rejected the bad key.
ADR-0063's boot gate checks key CONTINUITY, not FORMAT, and `dataKeyFingerprint` HMACs a buffer that
comes back short rather than throwing. So the gateway boots clean, prints its posture block, seeds
most of the way, and fails at the first credential write as a bare `500 {"error":"internal"}` — six
`seed.test.ts` tests red, none naming the cause. The gate exists to hand an operator a real message
mid-restore; it does not fire for the simplest possible misconfiguration. **Not fixed here** — it
changes start-up behaviour and `boot.test.ts` drives that path, so it is the owner's call.

**Then I walked it, and it found two more, neither native-specific.** (1) `demo:setup` printed a red
*"do not present"* over a state it creates itself: §3b deliberately leaves the use case `proposed`,
and `useCaseGateMode=enforcing` correctly blocks every dispatch attributed to its project, so the
script's own happy-path probe returns 409. An operator would hunt a fault that does not exist. It
now names that one case, says the gate is working, and gives the single action — every other
non-200 keeps the abort. (2) *"With BOTH of those set"* was hardcoded for two unmet controls and
printed when only one was.

**Verified live, not reasoned about** (runbook §6): posture **6 of 7** with `auditAnchorTamperResistant`
unmet and `settable: false`, exactly as §1.1 predicted; `GET /v1/execution` answering without admin;
`tools/list` as Dana over the real MCP protocol returning `list_branches/read_file/write_file` with
**`search_code` absent**, so her per-user revocation is enforced in DISCOVERY and not only at call
time; a per-tool halt refusing `write_file` with a message that distinguishes an emergency stop from
a missing grant while `read_file` on the same server kept working; the lift; both MCP loopback
addresses reachable natively.

**Suite: 189 files / 2849 passed / 9 skipped, exit 0 on a fresh database**, instrument counters at
zero — the same number as before the kill-switch UI, so that work regressed nothing. The 9 failures
reported mid-session were my own malformed key plus contamination from my own smoke run, not code.

**2026-09-26 — gateway parity, measured against Kong. ROADMAP §8. No code; an honest answer.**

Asked to confirm we work as a central gateway for every MCP call, and to say what
`github.com/Kong/kong` has that we do not.

**Confirmed, with three caveats.** We are in-line, not a policy library: six inbound surfaces open
the upstream socket themselves after the decision (`mcp-proxy.ts:1203`, `compat-openai.ts:438`,
`compat-anthropic.ts:454`, `compat-models.ts:153`, `agents-connectors.ts:3303` and `:4662`), and on
the MCP path the connect happens at `mcp-proxy.ts:1278` *before the JSON-RPC body is interpreted*,
so egress and admission refusals arrive as plain HTTP. The caveats: (1) it is a **method-aware
re-implementation, not a transparent proxy** — exactly two handlers exist, `tools/list` and
`tools/call`, and `resources/*`, `prompts/*`, `completion/*`, `logging/*`, sampling and
notifications have no handler anywhere, so they are refused; (2) **streamable HTTP only** — zero
hits for any stdio or SSE transport, so a local stdio MCP server, the commonest shape in the wild,
cannot be fronted at all; (3) being in the path is an **operator posture, not an invariant** — no
mTLS, no network capture, and the surfaces can be disabled into an indistinguishable 404.

**Kong has moved onto our ground.** Its README now says "API · LLM · MCP Gateway" and `ai-mcp-proxy`
(3.12+) fronts third-party MCP servers with per-tool ACLs — but as **AI Gateway Enterprise**, and
its own docs say "AI Guardrails: not supported" for MCP traffic. So the comparison a prospect makes
is against a paid tier, and we are well ahead on the governance half: per-user per-tool entitlement
with argument-bound approvals versus Kong's consumer allow/deny lists, PII and injection handling on
MCP payloads, hash-chained audit, default-deny egress, per-project cost, the kill switch.

**Two of the twelve gaps are defects, not features, and are written as such.** **G1** — rate limits
and budgets live in process memory (`app.ts:532`, no Redis anywhere), so a second replica silently
doubles every limit while the dashboard says the limit is on. **G2** — no request timeout, no body
limit, no upstream breaker (`Fastify({ logger: false, trustProxy })`, `app.ts:484`): a hung upstream
has no bound, and it is also why the runbook has a row for an opaque `{"error":"internal"}`.

**The cheapest strategic item is G9**: ship the existing decision-only PDP (`POST /v1/evaluate`,
`app.ts:2018`) as an Envoy `ext_authz` / Kong callout. It makes "you already run Kong, keep it" a
sale rather than an objection, and the endpoint already exists and already executes nothing. The
honest posture against a platform team is **behind their gateway, not instead of it** — we should
not grow a Lua plugin runtime or an ingress controller.

**§8.4 says what not to claim**: not operational parity (no health checks, no breaker, no
`/metrics`, one replica), and never that the rate limits hold under scale, because until G1 they
hold for one process.

**2026-09-25 (later) — ADR-0124: the kill switch and safe modes. Roadmap item I1, shipped.**
(Migration 0114.)

**One dial, four positions, checked first.** `org_settings.execution_mode` —
`normal` / `read_only` / `require_approval` / `halted` — consulted ahead of every grant, rule, limit
and scope at all three governed entry points (`evaluate`, `evaluateAgent`, `evaluateConnector`).
Every effectful path in the product reaches one of those three, so a new caller inherits the gate
without knowing it exists.

**`execution` is a REQUIRED kernel input, and that is the whole design.** Optional-with-a-safe-
default is the shape that rots: a future call site omits it, the deployment believes it is halted,
and one path keeps running. Required means the COMPILER enumerates the call sites — 148 of them in
this batch, and every one added later. Each needed a judgement (does this EXECUTE, or only
EVALUATE?), and getting it wrong either way is a bug: an executing path marked evaluation-only is a
bypass, a preview marked executing is a preview that reports "halted" during the one period an
operator most needs to reason about policy.

**Three scopes, because "stop everything" is usually the wrong tool.** Deployment, agent and tool,
with a subject halt OUTRANKING the dial. The halt columns are deliberately separate from
`agents.enabled`: "not in service" and "stopped in an incident" are different facts, and collapsing
them would mean lifting a halt silently returns a deliberately-retired agent to service.

**What it does NOT stop is the part to remember.** Reading the ledger, the queue and the posture
page is never gated — a switch that locks the door behind you is a worse outage than the one it was
thrown for, and `GET /v1/execution` is not even admin-only. Discovery ignores the dial, because an
empty tool list mid-incident reads as revoked access. The platform's own governance sweeps keep
running. Policy simulation and the red-team adjudicator use a named `EVALUATION_ONLY_EXECUTION` so
that reaching for it is a checkable claim. Queued approvals are made unspendable, never destroyed.

**`require_approval` is asymmetric and says so.** Only the MCP tool path can queue; `AgentDecision`
and `ConnectorDecision` cannot even express the effect. It refuses on those two with a reason naming
why, rather than silently denying where it claimed to queue.

**Building it surfaced two real defects, both in that mode.** `approvals.rule_id` is a uuid and the
dial's rule id is symbolic — **M-039 a third time**: a column's type is a claim about every producer.
And `approver_user_id` is NOT NULL, so "nothing runs unattended" now has to name who is attending,
enforced by route and DB CHECK.

**Two structural guards earned their keep again**: ADR-0074's rule-write guard caught the halt write
against `agents` (registered with why it is safe), and ADR-0102's prose inventory caught the three
new reason columns (scrubbed — operator prose typed under incident pressure is exactly when someone
pastes the credential they are rotating). And the ADR's claim that `PLAN_SAFE_MODES` "moved" to the
kernel was false when written — it had been copied. Now one definition, re-exported.

**Verification**: **189 files / 2849 passed / 9 MinIO skips, zero failures on a FRESH database**,
instrument counters at zero; all packages green; web typecheck and build clean. The 129 pre-existing
kernel tests pass unchanged with the dial at `normal`, which is the upgrade-safety proof.

**The operator's screen shipped with it** (`/admin/execution`, the same day): current state first,
all four positions with their blast radius in prose, per-agent and per-tool halts under the dial,
one reason box that refuses a terse reason before the round trip, and an explicit statement of what
survives a halt. Four Playwright tests drive it the way an incident happens, and one of them
**reloads the page while the deployment is halted** — a control surface that dies with the thing it
controls is not a control surface. The posture page links to it when the deployment is restricted.

**Still open on I1**: no automatic or scheduled trip (nothing arms itself; every position is a
deliberate act), one approver for the whole deployment, and no per-connector halt.

**2026-09-25 — ADR-0123: criterion (d) tightened, and the ISACA assessment on the roadmap.**

**The framework was a constant, and a refusal was not countable.** PoC criterion (d) was rated
"yes, with a seam to narrate". Two causes. `euAiActScreeningFor` cited packs only on reaching an EU
`high`/`prohibited` tier and filtered on the literal `"eu-ai-act"`, so every other pack we ship was
unreachable from a use case — including the NIST AI RMF pack, which **has shipped since ADR-0058**
and has no tier concept, so it could never have arrived through a screening gate anyway.

**The half that mattered was worse than a missing feature.** A pack's `audit_decisions` collector
reaches a decision only through `detail->>'projectId'`, and the governed DECISION rows on the MCP
tool and connector paths did not carry it — while the PII-block rows on those same paths did. So
`nist-ai-rmf:MANAGE-2.2`, whose own ownerNote reads "evidenced by refusals actually occurring",
counted **zero** while the refusals sat in the ledger, correct, hash-chained and invisible. The
product was telling an auditor that evidence did not exist when it did. `usage_events` already
carried the project for the same call; the two records now agree.

`GET /v1/use-cases/:id/frameworks` is a MAPPING, not a widened screening — inventing a tier for
frameworks that do not have one would be the wrong shape. The remaining seam is named on every
response rather than narrated around: evidence is collected per PROJECT and the payload says so, a
use case with no project returns null statuses (not measured ≠ measured as none), entitlement is
ADR-0047's own `evaluateReportAccess`, and the route persists nothing.

**Criterion (d) now pairs with (b) on one screen**: the refusal demonstrated in (b) is what turns
MANAGE-2.2 green, provided it carried the project header — and an unattributed refusal is still
correctly not counted.

**Three demo blockers found only by trying it.** Compliance packs are tier-gated and an unlicensed
deployment runs default CLOSED, so (d) could not be shown at all; packs seed as draft and evaluate
nothing until activated; and there was no use case to map. `demo:setup` now mints an EPHEMERAL
licence (keypair in memory, public half only, outside the source tree — the committed dev key's
private half was destroyed on purpose and this does not weaken that), activates the two packs, and
creates the use case.

**An unaudited governance write, closed.** `POST /v1/agents/:agentId/enabled` wrote nothing to the
ledger and took no reason — three lines beneath a comment promising "audited acts — never silent
PATCH writes" — despite being kernel-enforced platform-wide and the nearest thing we have to an
emergency stop.

**ISACA — *Cybersecurity Recommendations for Securing AI Agents* (2026), assessed and shelved as
asked.** ROADMAP §7 holds an audit against its 15-item Secure-by-Default checklist done against
ENFORCING CODE rather than ADRs: **4 full, 9 partial, 2 absent**, with both absences in the one
category we have barely touched (Reliability, Resilience, Kill Switches). Ten ranked items, led by
a kill switch and safe mode — we have every primitive and nothing that reads as an emergency
control — and an ISACA compliance pack, which is the cheapest credibility on the list and would put
our own gaps on our own dashboard. Two claims to stop making are recorded there and in the demo
runbook: least privilege is enforced for the HUMANS holding agent grants, not for agents; and the
injection detector runs at runtime but ships in `log` mode with no provenance model, so it is a
detector rather than a defense.

**2026-09-24 (later) — the seeded AND hardened demo environment, and the overstatement it found.**

Two commands beyond the seed: `demo:mcp` stands up a real Streamable HTTP MCP server on loopback,
and `demo:setup` creates what the gates need, verifies the happy path, and only then applies the
ADR-0118 preset. The order is load-bearing — the five gates fire in sequence, so hardening first
means every refusal demoed afterwards names the first unmet gate rather than the intended one.
`demo:setup` measures a real user's dispatch either side of the preset and says plainly not to
present if the hardened one fails.

**The demo landmine is closed.** The seeded servers pointed at the discard port deliberately, and
`POST /mcp/:serverId` connects upstream before reading any JSON-RPC message, so every request died
at connect and the gateway looked broken rather than governed. With a real upstream the whole
precedence chain now runs live over the real protocol: `read_file` allowed, `search_code` denied by
a per-user revocation, `write_file` queued to a named approver — and `tools/list` is already
filtered, so the deny is not a UI decoration.

**Each demo server gets its OWN loopback address.** ADR-0122's registry diff keys on host, so two
servers sharing one collapse onto whichever registry row came last. That limit is disclosed and
real, but on a demo it reads as the product attributing traffic to the wrong server — the first
rehearsal did exactly that.

**The finding worth keeping: the ADR-0118 preset was overstating what it binds.** There are THREE
independent attribution switches — `org_settings.dispatch_attribution_required` for the native
dispatch, and `interception_settings.require_project_attribution` / `require_mcp_attribution` for
the compat edge and the MCP proxy. Hardening sets one. The control's `refuses` text read "any
dispatch that names no project", which an operator would reasonably read as all of them; a fully
hardened deployment still serves an unattributed MCP tool call, which is now verified rather than
assumed. The schema had always said it precisely — the preset's sentence just did not carry it. The
text now names the scope and the other two switches, and a test asserts BOTH the behaviour and the
disclosure, so widening the preset later fails until the sentence is rewritten. That column is the
entire value of the posture page, and it is about to be read aloud to a customer.

**Verification**: gateway **187 files / 2833 passed / 9 MinIO skips, exit 0 on a fresh database**,
instrument counters at zero. The demo environment itself was rehearsed end to end on a hardened
database: criteria (a) and (b) confirmed live, the happy path 200 on both sides of the preset.
Docker is unavailable in this container, so the two environment-backed controls are handed to the
demo box as exact commands rather than claimed — `docs/product/DEMO_RUNBOOK.md`.

**2026-09-24 — ADR-0121 (Outlook, send-only), ADR-0122 (MCP discovery + the registry diff), the
enforcement-posture page, and a correction to ADR-0120 that only a FRESH database could find.**
(Migrations 0112, 0113.)

**ADR-0121 — Outlook approvals is a courier that can only carry.** ADR-0061 and ADR-0113 both rested
on a property neither had to state, because both providers happened to satisfy it: *the platform
authenticates the inbound callback*. Email does not, and every way to invent one is worse than not
having the channel — reply-to-approve trusts an assertion anyone who can put mail in a mailbox can
make, SPF/DKIM/DMARC relocate the trust onto a relay's header parsing, and a secret link is a bearer
token in a medium built to be forwarded and archived. So inbound is refused under its own code,
`inbound_unsupported_by_design`, and the mail carries the content plus a portal link and **no decide
actions** — with `allowFencedDecide` unable to opt out, because it loosens ADR-0061's fence rather
than this channel's own limits.

**The duller half of 0121 is the instructive one, and it is the session's theme.** The adapter had
shipped an `outlook` case **no caller could reach**, and the full suite passed throughout. Two
hand-maintained mirrors had drifted from it: shared's `connectorProviderKindSchema` had never learned
the kind, so the connector could not be created; and drizzle's `text({enum})` widened while migration
0069's CHECK still read `IN ('slack','teams')`, so the type said yes, the storage said no, and the
route surfaced the violation as a 500. Both fixed, and the *class* is guarded by a test asserting the
two kind lists are equal — living in the gateway because that is the only package that can see both,
which is exactly why the drift was invisible.

**ADR-0122 — detection is half a capability; the registry diff is the other half.** ADR-0055's
catalogue was structurally MCP-blind (its signatures ask "is this a known vendor's hostname", and the
interesting MCP servers are self-hosted on hostnames nobody can enumerate), and its corpus is
hash-pinned on purpose, so this is a separate module rather than new entries. Confidence is graded and
never averaged. The load-bearing part is the diff: from one piece of supplied evidence, a registered
host comes back governed and named and an unknown one comes back `UNREGISTERED`, in the same response.

**The enforcement-posture page is now a screen**, at `/admin/enforcement-posture` — deliberately NOT
`/admin/posture`, which is ADR-0082's read-only executive one-pager. A control that starts refusing
live traffic does not belong on a page people print for a meeting.

**ADR-0120 was wrong in a way its own tests could not reach, and a fresh database found it.** The
rule path reused `policy_simulation_flips.policy_id` — a uuid — for the kernel's `Decision.ruleId`,
which is a uuid only when a stored rule row matched and a **symbolic** id (`default-deny`) when the
kernel decided without one. 22P02 on the flip insert, 500 on the whole simulation — **on precisely
the traffic a restrictive-rule preview exists to be run against**. The fixture's every caller was
entitled, so the other half of the value space was never constructed. Migration 0113 adds
`decision_rule_id text` and keeps both facts. Recorded as **M-039**.

**Two shared-state defects were diagnosed rather than re-run as flakes.** This feature replays *every*
`mcp_tool` audit row in the window rather than its own fixtures, so a shared development database
cannot verify it. And `chatops.test.ts` was dropping a CHECK constraint and restoring a **hardcoded,
now-stale** definition — a test mutating shared DDL and restoring what it remembered rather than what
it found, which silently narrowed the constraint for every file that ran after it. It now reads
`pg_get_constraintdef` before the drop and asserts the restore was faithful.

**Verification**: gateway **187 files / 2832 passed / 9 MinIO skips, exit 0 on a FRESH database**,
with `ECONNREFUSED`, `destroySoon`, unhandled and uncaught all at zero; all eleven packages green
(1721 tests); web typecheck and build clean.

**2026-09-20 (evening) — ADR-0120: policy simulation reaches approval rules and rate limits, and
REFUSES data-scope rules for a stated reason.** (Migration 0111.) The deck listed "policy simulation
and blast-radius preview"; the surface accepted exactly one thing, an ABAC policy version, and
`policy_simulations.policy_version_id` was NOT NULL with an FK to `abac_policy_versions` — so the
**storage** could not describe another candidate even if the code had wanted to.

**The finding that shaped the work: the evaluation was never the missing part.** ADR-0073's shadow
pass already evaluates candidate approval rules, rate limits and data-scope rules on the live path,
and already recomputes a candidate limit's count when its window moves. What it could not do was be
**asked** — it evaluates whatever version is marked `canary`, on real traffic, as it happens. So this
batch adds almost no evaluation logic; it adds a way to ask. `governedEvaluate` gains a dry-run mode
that forces a named version as the candidate and **returns** its decision, computed by the same
`evaluateWith` the served decision came from.

**I made the M-030 mistake again and caught it in time.** I checked `governed-evaluate.ts` for writes
by grepping its own file, found none, and concluded it was side-effect free. It is not: it writes
through `recordCanaryObservations`. A replay calling it once per recorded decision would have written
**one canary observation per transcript row**, corrupting the very measurements an operator relies
on, from a module whose header says it "executes NOTHING". The guard is one clause and its absence
would not have surfaced until someone wondered why their canary percentages had moved.

**`data_scope_rule` is refused, not approximated** — 422 with a self-explaining body, storing nothing.
Judging one needs the call's **arguments**, and the MCP decision transcript records counts only by
design (§8.4). That is ADR-0119's shape again: the product's own privacy discipline is what makes the
feature impossible, and saying so beats a fabricated number on a surface whose whole value is that
its numbers can be trusted.

**Verified by me on a freshly created database**: **185 files / 2819 passed / 9 MinIO skips, exit 0**
— +1 file, +6 tests. Build and `tsc --noEmit` clean; instruments asserted. Probe predicted before
running: neutralise the candidate evaluation, 2 of 6 redden, 4 stay green. Exactly 2 and 4.

**And a second process error, now M-038.** A fixture used `createdByUserId` where the column is
`authorUserId`. It passed the **full 2,819-test suite, twice** — vitest transforms through esbuild
and never typechecks, and drizzle silently dropped the unknown key — and I had begun writing the
ADR's verification section around those numbers. It was caught only because build and tsc run after
the suite, and only because I read their exit codes rather than the green summary above them. **A
test file is code and gets the same gate as code.**

**Honest limits**: two rule kinds of three; the replay covers MCP tool decisions only; project
attribution is not reconstructed for rule candidates; the preview substitutes ONE version into
today's rules, so two changes previewed separately do not tell you what they do together.

**2026-09-20 (later still) — ADR-0119: the semantic cache reaches the IDE path, and the honest
ceiling for that surface is THREE of seven techniques, not seven.** (No migration.) The deck sold
"seven techniques applied automatically on every call" beside a slide selling the compat endpoints as
where "the work developers already do arrives inside the same controls". That surface ran **one**.

**The scoping was the substance.** Each remaining technique was checked against the **wire format**
rather than against convenience, and three cannot follow because a vendor-shaped request has nowhere
to carry what they need: **edit-vs-rewrite** diffs against `body.baseline` and there is no baseline
field; **file pre-processing** shrinks `body.attachments` and the surface carries none; **context
compaction** summarises a **stored conversation** and the surface is stateless. Compacting the
supplied array in-flight would be a *different* technique costing a model call and latency on a
synchronous IDE request — deliberately not smuggled in under this batch's name. Lazy tool loading and
request batching belong to other surfaces. So this takes the surface from **one to two**, and says so,
because the alternative was to make the slide true by redefining "applied" to mean "considered".

**What was about to be duplicated was not a lookup but a governance boundary** — servable only to the
same user, for the same agent, inside the TTL, and only after the stored normalized input is
re-compared as a collision guard. Two copies would drift and **the copy that drifted would serve one
user's answer to another**. It now lives in `semantic-cache-shared.ts` and **both paths call it**;
the invoke path's existing tests passed unchanged, which is what makes that a refactor rather than a
rewrite — and makes "both paths call it" verified rather than asserted. PII re-gating stays with the
caller (a JSON API and a wire-compatible shim must refuse differently) while the **gate itself is
shared**, so a cached answer still cannot be served onto a `block`-mode project.

**Two behaviours differ from the invoke path and both are consequences, not choices.** `opt_in`
cannot engage here — it means "the caller sets `semanticCache: true`", and inventing that field would
break the wire compatibility that is the surface's whole purpose. And a **tool-bearing turn is never
cached**, because its answer is not a pure function of the prompt: serving a previous one would be
*wrong*, not merely stale.

**Evidence is "no provider call", never "the answer matched"** — two identical requests return the
same text whether or not a cache exists, so equality proves nothing. Every hit assertion pairs with a
`usage_events` delta of **zero** and every miss with **one**. The cross-user test first **proves A
hits**, so B's miss is about scope rather than an empty cache.

**Verified by me on a freshly created database**: **184 files / 2813 passed / 9 MinIO skips, exit 0**
— +1 file, +6 tests. Build and `tsc --noEmit` clean; instrument asserted (`ECONNREFUSED: 0`,
`destroySoon: 0`). Probe predicted first: force a permanent miss and 4 of 6 redden, 2 stay green.
Exactly 4 and 2.

**Honest limits**: **exact-match only** — "semantic" is the technique's name, not its matching, so a
re-worded question misses; a hit reports the model that produced the **cached** answer, not what
routing would pick today; poisoning is bounded by scope rather than prevented; and the TTL **slides
on reuse**, so a popular question can stay cached well beyond one TTL from its first ask.

**2026-09-20 (later) — ADR-0118 landed: the hardened posture preset, built by me rather than
dispatched.** (No migration.) Six agent deaths on session limits made delegation the slower path, so
this one was built in-session. Eight controls the deck sells as active ship **off**; every default is
a deliberate, upgrade-safe choice and **not one of them was changed**. What is new is a governed
operation that turns the enforcing set on together, and a read that answers "what is enforcing right
now?" in one call.

**The read is the primary deliverable.** `GET /v1/org/posture` gives each control its value, whether
it is satisfied and settable, and **what turning it on would refuse** — specific enough to act on
(that `useCaseGateMode` binds only dispatches naming a project; that `mrmEnforced` bites on the
**clock**; that `defaultPiiMode: block` must be read beside ADR-0117's false-positive rates). It is
useful to an operator who never applies the preset.

**Two controls are reported and never claimed.** The anchor is env-backed and so is the scheduler —
an API call cannot set an environment variable. They carry `settable: false` and their **observed**
state, `harden` neither touches nor counts them, and the overall verdict stays **false** even when
every settable control is satisfied. So `hardened: true` is **unreachable on a default install**,
which is honest rather than convenient. ADR-0060's precedent, applied.

**Three design calls worth keeping**: enforcement and optimisation are separate groups and `harden`
defaults to enforcement only, because bundling a cache policy into a switch called "hardened"
conflates a cost decision with a security one; `mrmEnforced` emits **its own** audit row as well, or
an operator alerting on `mrm-enforcement-enabled` would silently miss a preset-driven enablement; and
the preset persists **no** "am I hardened" flag, so the answer is derived from the controls and
cannot drift from them.

**Proof is behavioural — allowed before, refused after — and writing it surfaced that the gates are
ORDERED.** With everything hardened, an unattributed dispatch is refused `mrm_approval_required`,
not `attribution_required`: MRM answers first. An assertion naming attribution therefore **fails
while the attribution gate is perfectly healthy**, and my first draft made exactly that mistake. Each
gate is now proved twice — through the preset, and **in isolation** by moving one dial.

**It also exposed a vacuous test in ADR-0116.** The full suite failed *"one altered exported audit
row"*, reporting that a tampered bundle verified clean. A **test** defect, not a product one: the
mutation was `allow -> deny` on the first row of the exported segment, and in the shared database
that row is whatever another file wrote — when it was already a `deny` the replace was a **no-op**
and the bundle reached the verifier pristine. This batch's own MRM `deny` row shifted the segment and
exposed it. **M-033 in a new place: the vacuity was in the SETUP, not the assertion** — the tamper
test was tampering with nothing, and every sibling tamper case passing is what made it look fine.

**Verified by me on a freshly created database**: **183 files / 2807 passed / 9 MinIO skips, exit 0**
— +1 file, +13 tests. Repo-wide build and `tsc --noEmit` clean; instrument asserted
(`ECONNREFUSED: 0`, `destroySoon: 0`, unhandled-error block empty). Non-vacuity predicted before
running: neutralise only the write and 6 of 13 redden, 7 stay green including the isolation cases.
Exactly 6 and 7.

**Honest limits, stated in the ADR rather than discovered later**: "one switch" is true of **six** of
eight; there is **no dry-run**, so applying it to a live install with unregistered use cases starts
refusing real traffic immediately; there is no un-harden operation, deliberately; and a control that
later gains its own toggle semantics would need the same dual-audit treatment `mrmEnforced` got, with
nothing in the type system enforcing it.

**2026-09-20 — ADR-0116 and ADR-0117 landed together: two of the deck's four false claims are now
true, and both batches were finished by me after rate limits killed their agents mid-flight.**

**ADR-0116 — signed, offline-verifiable exports** (no migration). The deck claimed *"a signed,
self-verifying bundle your auditor can check independently."* Exports were **plain unsigned CSV or
JSON**, and audit verification was a **live API call against the running system** — the opposite of
the promise. Now: an Ed25519-signed bundle and a standalone verifier needing no database, no
gateway, no network.

**The design turns on a trap I had found in the sibling LLM product hours earlier**, and the ADR
title states the answer: *the trust root is a fingerprint obtained OUT OF BAND, and the bundled
public key is never the authority.* A bundle carrying its own key is self-*consistent*, not
self-*verifying* — anyone can re-sign a doctored bundle with a fresh key. The verifier takes
`--fingerprint` or a pinned `--keyring`; the bundled copy is a convenience and is never treated as
authority. **No signing key produces a refusal, never a quietly unsigned bundle.** Rotation does not
invalidate past bundles.

**Six export producers were enumerated and only two are covered** — the compliance report artifact
and `GET /v1/audit.csv`. Cost CSVs, billing statements and the onboarding snapshot are **not** signed,
and the ADR says so in a table rather than letting "exports, plural" imply otherwise. **The deck
sentence is written to describe what is covered**; used beside a screenshot of a cost CSV it becomes
an overstatement again.

**ADR-0117 — international identifier PII** (migration 0110). Ten jurisdictions, and the finding is
that the batch's own premise was wrong. It first defaulted to "the checksum-backed jurisdictions";
**three of its checksums were defective** — Verhoeff used the *generation* permutation offset inside
the *validation* loop (rejecting the published example while still accepting ~10% of random input: a
checksum-shaped function that was not the checksum), the German IdNr structural rule was **inverted**
in a way the single published example could not expose, and the French NIR key range was off by one
in both directions.

**Then the reasoning itself fell.** Measured: **one decimal check digit divides the candidate space
by ten and no more** — BSN **9.03%**, TFN 9.00%, NINO 8.47%, SIN 8.09%, Aadhaar 8.03% false positives
on random digit runs, against Steuer-ID 0.23% and NIR 0.06%. In `block` mode that **refuses
legitimate work the user cannot route around**. So the shipped default is **empty**, selection is
per jurisdiction, and each measured rate is published next to its switch. "Checksum-backed" is no
longer used as a safety rating anywhere.

`enforcePII` now takes the enabled set as a **required** argument, so a path added later cannot
silently enforce less than the org configured — the compiler asks, and the type error enumerated the
**ten** call sites.

**The compat/IDE path was passing for the wrong reason, and that is recorded as M-037.** `POST
/v1/messages` resolved its agent by the `mock-balanced` **model string**; in the shared suite
database ADR-0020's deterministic tie-break correctly picks another file's agent, refusing with
`agent_denied`. An assertion asking only for "not 200" was satisfied by a refusal that had nothing
to do with PII, so the enforcement claim on the IDE path had **never been tested in a full run**.
The product was right; the test trusted a coincidence.

**Verified by me on a freshly created database**: **182 files / 2794 passed / 9 MinIO skips, exit 0**
— +2 files and +41 tests over S22's 180/2753. Repo-wide build and `tsc --noEmit` clean; instrument
asserted (`ECONNREFUSED: 0`, `destroySoon: 0`, unhandled-error block empty). My own probe, predicted
before running: removing the agent pin should redden exactly the two compat cases and leave the other
37 green — it did, exactly.

**What I had to finish, and it is a pattern now**: four agents died on one session limit, two more on
the next. ADR-0117 **was never written by its agent at all** — its implementation, tests and vectors
were committed without a decision record, which `CLAUDE.md` forbids. I reconstructed it from the
committed code and the commit messages, re-read the measured rates from the registry rather than
copying them from prose, and checked every cross-referenced ADR filename resolved — **two of my own
first-draft links did not**, and I verified the ADR-0020 tie-break claim against ADR-0020's text
rather than trusting the code comment that cited it (M-036).

**2026-09-19 (evening) — S22 closed: the eval surface held the credential, and the fix is deliberately
NOT one rule for all four columns.**
([ADR-0115](../docs/decisions/0115-eval-result-credential-surface.md), no migration.) ADR-0111 named
`eval_results.output_text` as a sixth surface and never probed it; ADR-0112 left it out of scope. A
synthetic AWS example key was driven through a **real** governed eval run and a **real** red-team run,
and every stored column read back by raw SQL — measured, not argued from the code.

**Four columns, four answers, each argued.** `output_text` held the key **character for character**
and is **left faithful at rest**, redacted at the presentation boundary; `detail` (jsonb) held it in
the judge's per-claim verdicts and takes the same hook; **`error` is scrubbed at WRITE time** in
ADR-0102's registry; `judge_rationale` already carried the marker and is unchanged.

**The reason `error` splits from `output_text` is the whole point of the batch.** A red-team probe's
purpose can be to prove the agent disclosed a secret — a product that records "a probe got through"
while deleting what got through has not been made safer, it has destroyed its own evidence. But an
upstream exception message is **never** evidence of anything: a defeat is proved by what the model
*said*, not by what the transport threw. So the defeat evidence stays intact and a test pins it.

**The copies were the other half of the finding.** `redteam_findings.output_snippet` and
`redteam_probe_trials.output_snippet` are slices of `output_text`, and `cardView` re-derives the
judge's claims onto a model card — so **six read routes** handed the key out, across three files.
All six are now inside an encapsulated Fastify scope, the ADR-0112 pattern reused rather than
re-invented.

**Completed by me after the agent was killed mid-verification.** A session rate limit took it out
while it was running the suite that would have caught the one defect it left: `eval_results.error`
was added to the scrub registry but not to the **inventory that pins the registry's contents**. My
run found exactly that. It is ADR-0102's structural guard working as designed — a registry addition
cannot slip in unannounced — and the inventory entry now carries the write-time-vs-presentation
reasoning above.

**Verified by me on a freshly created database**: **180 files / 2753 passed / 9 MinIO skips, exit 0**
— **+1 file, +13 tests** over S13's 179/2740, nothing else moved. Repo-wide build and `tsc --noEmit`
clean; instrument asserted (`ECONNREFUSED: 0`, `destroySoon: 0`, unhandled-error block empty).

**Worth keeping from its non-vacuity table: five probes, and it reports the one prediction it got
wrong** (N5, over-eager scrub — it predicted 2 failures and got 3). Recording the miss rather than
quietly restating the prediction is the discipline M-023 exists for.

**2026-09-19 (later still) — S13 closed: a re-scan that still sees the SAME signature now RE-OPENS
a finding whose status claims the problem is fixed, and the rule it replaces was never ADR-0017's.**
([ADR-0114](../docs/decisions/0114-rescan-reopens-a-contradicted-finding.md), **no migration** —
`open` was already in the enum.) ADR-0110 made the backup **ledger** row re-open; the **finding**
did not follow. So a restore that reported success over a gap that is still live left
`infra_findings.status` at `remediated` — the product showing an operator a **closed finding over a
live gap**, on `/v1/infra/findings` and `/v1/infra/posture`, the surfaces they read *first*, while
the ledger that now tells the truth is the one they reach for second.

**The premise was wrong, and correcting it is the substance of the batch (now M-036).** S13 was
filed — by me, in ADR-0110's Honest limits, and repeated into STATE.md and PENDING.md — as
"pre-existing **ADR-0017** behaviour", quoting *"a re-scan never resets a finding's status"*.
**ADR-0017 does not contain that sentence.** I checked it myself: its only idempotency claim is that
a re-scan never duplicates a **ledger row** — rows, not status. The rule lived in exactly one place,
an inline comment at `infra.ts:883`. I had put quotation marks around a code comment and an ADR
number beside it. That is why it matters: a rule attributed to an ADR reads as *decided*, so the
respectful move is to leave it alone; the same rule in a comment reads as *how it happens to work*,
which invites the question. The citation is what kept it unexamined.

**With the premise corrected it stops being a trade-off and becomes an inconsistency.**
`infra.ts:670` already re-opens a finding when a cert rotation **fails** — *"re-proposable: the
finding goes back to open, never silently closed."* A remediation that **reported success** while
the same signature is still observable is not a scanner overruling a human; it is evidence the
decision did not take effect. Re-opening the loud failure and staying silent on the quiet one is
backwards — the quiet one is the one an operator cannot otherwise discover.

**Per-status, each argued rather than decided by omission**: `remediated` and `auto_remediated`
re-open (the second more strongly — same claim, but **nobody looked**). **`accepted_risk` does
not** — a human chose to live with a known problem, the scan still seeing it is *expected*, and
re-opening would nag an operator for doing exactly what the product asked, turning `accepted_risk`
into a delay rather than a decision. **`remediation_proposed` does not** — it claims the problem is
*being worked*, not resolved, so there is no contradiction to report; this is where ADR-0114
**deliberately parts from ADR-0110 §2**, because on the ledger `restore_proposed` was the state that
stopped the row saying the gap was live, while on the finding it would destroy an in-flight proposal
and buy nothing. `open` is a no-op **with no audit row** — no closed claim to contradict, and that
is also the flapping bound. `approved` is refused defensively and shown unreachable.

**Flapping is bounded, not eliminated, and the bounds are existing mechanisms rather than an
invented debounce**: it fires **at most once per false close** (`open` does not re-open, so no
oscillation and no audit-row storm — asserted, not argued), and `scanResource` has exactly **one
caller repo-wide** with no findings-scan scheduler anywhere. The second bound is disclosed as a
property of *today's* deployment: whoever schedules fleet scans narrows the window in proportion.

**Verified by me on a freshly created database**: **179 files / 2740 passed / 9 MinIO skips, exit
0** — exactly **+1 file, +6 tests** over S21's 178/2734, nothing else moved. Repo-wide build and
`tsc --noEmit` clean; instrument asserted (`ECONNREFUSED: 0`, `destroySoon: 0`, unhandled-error
block empty). I re-derived the two load-bearing premises from source rather than from the report:
ADR-0017 carries no status claim (`grep` returns nothing), and all **ten** writers of
`infra_findings.status` are where the ADR says, with **no path anywhere setting `approved`**.

**My own non-vacuity probe, additive to the agent's three and with the prediction written first**:
the status flip and the audit row are two separable claims, so removing **only** the `auditLog`
insert — keeping both the status change and the counter — had to redden something, or the
"contradiction is audited, never silent" guarantee rests on nothing. Three tests went red, including
the one pinning `priorStatus: "auto_remediated"`. Probe reverted and the revert verified clean.

**The honest limits, which the ADR gives its own section**: flapping is bounded rather than removed
and a future scan scheduler weakens the second bound; `priorDetectedAt` is the last observation
before the close, **not** a remediation timestamp (there is no `remediated_at` column and no
migration was added to invent one — the remediation's own moment is already in the audit log under
the same `objectId`); "the same signature" is only as good as the provider's signature, and an
unstable one would create new findings rather than re-open; and the provider under test is
`MockInfraProvider` — the right fixture for a false success, and a narrow one.

**2026-09-19 (later still) — S21 closed: the conversation list can now be asked for ONE project,
and `none` for the unattributed ones.** (No ADR, no migration — a query parameter on an existing
route, resolved inside an existing owner-scoped predicate.) `conversations.projectId` has always
been the pillar-5 default attribution for every turn dispatched in a thread, and the list route
already *returned* `projectName`; it could not be *asked* for one. An operator with a dozen threads
had no way to answer "what have I been running against project X".

**The `none` vocabulary is borrowed, not invented.** ADR-0024 O11 already exposes the null-project
bucket as `GET /v1/costs/unattributed`, on the reasoning that spend belonging to no project must
stay visible rather than be silently folded into one. The same argument applies here: without
`none`, a user whose threads are mostly unattributed can filter to every project *except* the one
they actually live in. One condition, one name, two surfaces.

**The property that mattered is "narrows, never widens", and it is asserted rather than assumed.**
The ownership predicate is applied *regardless* of the filter — `and(eq(userId), projectFilter)` —
so passing another user's project id returns an **empty list**, not their threads. Five tests pin
it: the two narrowing cases, and the never-widen case checked from **both** users' sides, because
M-035's lesson is that a guarantee watching one producer is not a guarantee.

**Non-vacuity, with the prediction written before the run** (M-023): removing the filter should
redden the two narrowing tests and leave the three never-widen tests **green**, since ownership is
enforced independently of the filter and a vacuous "never widens" would be indistinguishable from a
sound one under a probe that also broke ownership. Result: exactly 2 red, 3 green. The probe was
reverted and the revert verified (`0` matches).

**Verified by me on a fresh database**: gateway **178 files / 2734 passed + 9 MinIO skips, exit 0**
— exactly **+5** over S19's 2729, which are my five tests and nothing else. Instrument asserted
(`ECONNREFUSED: 0`, `destroySoon: 0`).

**2026-09-19 (later) — S19 closed: Teams ChatOps parity is complete, and the deferred verification
for BOTH batches is done.** ([ADR-0113](../docs/decisions/0113-teams-outbound-courier.md), no
migration.) ADR-0061 shipped Teams **inbound** — signature-verified callbacks that can decide
approvals — and refused outbound with `outbound_provider_unsupported` because
`connector-provider` had no Teams adapter. That courier now exists: `"teams"` in
`CONNECTOR_PROVIDER_KINDS`, a **Bot Framework Connector REST** adapter, and `chatops.ts` routing
through it.

**Verified by me in one run, covering S14 and S19 together**: gateway **178 files / 2729 passed +
9 MinIO skips, exit 0**; `connector-provider` **70 passed, exit 0**; repo-wide build and
`tsc --noEmit` clean; instrument asserted (`ECONNREFUSED: 0`, `destroySoon: 0`). The numbers
reconcile against S14's 2723 — S19 added six tests to the existing `chatops.test.ts`, so the file
count is unchanged and its adapter tests live in the separate package.

**Two things the agent did beyond the brief.** (a) **A message-redirection defence**: every call
derives its `/v3/conversations/{id}/` prefix from the governed `object`, and the Activity's own
`conversation.id` is **overwritten** from it — so a crafted payload cannot redirect a post to
another Teams conversation. (b) **It found Teams is structurally different from Slack on egress**:
one post touches **two hosts** (Entra login + Bot Connector), both routed through the guarded fetch
that re-adjudicates every request URL. Neither is exempt, and an air-gapped install has neither
allow-list entry, so the courier is simply absent rather than failing open.

**Its non-vacuity table is the strongest of this session.** One neutralisation stayed **GREEN** —
removing the entry-point adjudication — and rather than bury that it explains why it is not
vacuity (the guarded fetch alone still refuses), then proves it in the next row by removing **both**
egress layers and watching three tests redden, including ADR-0061's **pre-existing Slack** egress
test. That is M-033 and M-035's lesson applied unprompted.

**Honest about what is weaker**: card fidelity is **not** identical to Slack and the ADR does not
claim it is — code spans have no Adaptive Cards equivalent and render as literal backticks; the
portal link is an `Action.OpenUrl` only when `portalUrl` is absolute. The *content* and the
*sensitivity fence* are identical; the markup is poorer.

**A process note worth keeping.** The building agent was cut off by a rate limit one step before
writing its ADR, having already committed the implementation and tests. I finished the batch: the
ADR was **orphaned**, not in-flight, so committing it was the right call where leaving a *running*
agent's files alone had been right three times before. I also briefly misread the commit range —
the implementation landed *before* my own S14 status commit, so a `759e5b3..HEAD` diff showed only
the test commit and I thought the adapter was missing. It was not; checking the code rather than
trusting the range settled it.

**2026-09-19 — S14 closed: the owner chose option (c), and conversations are now scrubbed at the
PRESENTATION boundary.** ([ADR-0112](../docs/decisions/0112-conversation-presentation-scrub.md), no
migration.) Stored rows keep byte-for-byte what was said; only what the four conversation routes
**hand out** is redacted. Thirteen surfaces were enumerated — three carried content and are covered,
six were checked and found to carry only ids, and a conversation export route **does not exist**
(the `onSend` backstop means adding one later cannot silently reopen the surface).

**The chokepoint, verified myself.** The scrub installs inside an encapsulated Fastify scope
**before the first route is declared**, via `preSerialization` (walks the object, so a marker can
never break the JSON) with `onSend` as the string/Buffer backstop. A route added to that file next
month is covered by *where it is declared*, not by its author remembering a rule — ADR-0099/0102's
own argument applied to the read side. `PRESENTATION_SCRUB` is `scrubAuditText` **by reference**
through ADR-0102's alias, so the marker stays character-identical across `audit_log`, `trace_spans`
and now conversations. Rejected, each for a stated reason: a DB-read scrub (corrupts replay), a
per-route `presentX()` call (the convention ADR-0099 rejected), and a global `onSend` (would put the
detector on every 4xx echo product-wide).

**The find that matters more than the fix — recorded as M-035.** The guard protecting model replay
**passed 10 of 10 while the provider was being handed redacted text.** The invoke path has **two**
model-bound sources and only one runs per dispatch: with compaction eligible the wire comes from
`ConversationContext.messages`; on optimizer `passthrough` compaction is skipped and it comes from
`ConversationContext.history`. The guard watched the first. It was caught only because the probe was
"mis-site the scrub on path X" rather than "remove the control" — a blunter probe would have left it
green and shipped a guarantee that did not hold. **A positive assertion is vacuous in the same way a
negative is, if it watches one of several producers.** `loadOwnConversation` is now
`loadOwnConversationForReplay`, with both paths asserted on two identities.

**The honest limit, which ADR-0112 gives its own top-level section rather than a footnote**: option
(c) protects the API surface, **not the data at rest**. `pg_dump`, a restored backup, a `psql`
session, or any module opening its own `pg.Pool` still reads the credential in the clear. **The
operator procedure for "a customer pasted a key into chat" is therefore: ROTATE IT.** The product
did not contain the secret, it stopped echoing it. And **model replay still sends the original text
to the provider** — on the turn it was typed, on every later turn of that thread, and inside the
compaction summarisation dispatch. Inherent to (c) and to everything short of (b).

**Status of my own verification, stated rather than implied**: I verified the structure from the
committed code (the rename and its two callers, the scope/hook siting, the detector identity). The
agent reports **178 files / 2723 passed / 9 skipped, exit 0**. **I have NOT re-run the suite
myself**, because a second agent (S19, Teams outbound) currently has uncommitted in-flight work in
`chatops.ts` that fails typecheck — a run now would fail for reasons unrelated to S14. One suite
covering both will follow when S19 lands.

**2026-09-17 — R3 landed and retested: the trace surface was leaking credentials BY DEFAULT, and
off the platform.** ([ADR-0111](../docs/decisions/0111-trace-preview-credential-scrub.md), no
migration.) F04 named five surfaces nobody had assessed. All five are now assessed with a synthetic
key (`AKIAIOSFODNN7EXAMPLE`, AWS's own published example): **one fixed, three proven clean, one left
with the risk stated, and one referred to the owner.**

**The finding.** `toolPayloadPreview` only truncated, so a governed tool call wrote its **raw
arguments** into `trace_spans.input_preview` and its **raw result** into `output_preview` — the same
payload ADR-0104 carefully scrubs into `approvals.arguments_preview` two tables away. S5's defect
verbatim: one event, two stores, disagreeing about whether the secret was contained. **Two things
make it worse than S5.** (a) **It is the shipped default** — `tracing_enabled` and
`tracing_capture_content` are both `NOT NULL DEFAULT true` and read as `!== false`, so capture is on
unless an operator turns it off. (b) **It egresses**: ADR-0070 exports spans over OTLP and
`otelAttributesForSpan` puts both columns on the wire as `gen_ai.input.messages` /
`gen_ai.output.messages`. Captured OTLP bytes showed the key in both.

Worth recording the shape of the miss: `loadTracingPolicy`'s catch block reads *"Fail CLOSED on
content (never store a prompt we could not confirm we are allowed to store)"*. The author thought
hard about **authorisation to capture** and never asked **what the capture contains**. Two different
questions; only the first got asked.

**The fix is two strings in ADR-0102's existing registry** — same `createDb` Proxy, same
`scrubAuditText`, no new detector, no per-call-site convention, no migration. It fixes the OTLP
exporter for free, because the exporter reads the stored columns: row and wire cannot disagree.
**Incidental hardening**: `PROSE_COLUMNS` was built with `new Map(REGISTRY.map(…))`, which keeps only
the LAST entry for a repeated table — so a second `traceSpans` entry would have silently dropped
`statusReason`'s coverage **while `proseScrubInventory()` kept reporting it covered**. A scrub that
looks registered and isn't. The map now throws on a duplicate table at module load.

**My independent retest — criteria written before results, all eight pass.** P1b: the Proxy scrubs
**both** columns before the INSERT (proven through the real `createDb` path). P2 **over-redaction
control**: ordinary prose, uuids and emails stored byte-identical — the probe that matters most,
since this product stores payloads so an operator can audit what happened. P3: the marker is
**character-identical** across stores and `PROSE_SCRUB === scrubAuditText` is pinned. P4 **egress**,
asserted separately from storage: the OTLP wire carries the marker, not the key. P5: I attempted my
own leak into a surface the report calls clean (zod `invalid_string`) and confirmed the body carries
only `validation`/`code`/`path` — the value is absent. P6: one registry line, no second redactor.
P7: the only credential-shaped string in the diff is AWS's published example. **P8: 177 files /
2713 passed + 9 MinIO skips, 0 failed, exit 0**, build and repo-wide typecheck clean, instrument
asserted.

**Open, and referred rather than decided: conversations.** `conversation_messages.content`,
`conversations.title` and the compaction summary hold a pasted credential verbatim — proven with a
row. Deliberately **not** fixed: scrubbing a user's chat content is a different contract from
scrubbing operator prose, and silently altering what someone said is data loss where the product
promises fidelity. ADR-0111 draws the line at **the observability copy, not the record**, and states
the cost plainly: the two records of one turn now deliberately disagree — S5's shape inverted,
accepted only because the disagreement runs in the safe direction. **Four options are recorded for
the owner (S14).**

**Proven and accepted rather than closed**: two low-severity error echoes — zod `invalid_enum_value`
returns the rejected value in `received`, and a 409 `detail` interpolates a stored server name.
Neither persists or reaches a third party; both recorded so the next reviewer does not re-find them.
**No backfill**: rows written before today still hold what they held, and the exporter will export
an old unscrubbed span. Deliberate — the write is the chance, and rewriting historical observability
data is a worse precedent.

**2026-09-12 — S11 and S12 closed, and R0 reconciled.**
([ADR-0110](../docs/decisions/0110-backup-rescan-reopen-and-preflight-gate.md), migration 0109.)

**S11 — the owner decided a re-scan SHOULD re-open a miss, and that is now what happens.** One
`backup_runs` row per finding: the idempotency read keys on `finding_id` + `kind='backup'`
**regardless of status** and updates in place instead of inserting a second row. `missed` and
`restore_proposed` re-open (the latter **superseding** a pending proposal, audited as
`infra-restore-proposal-superseded` so it is visible, never silent); `restored` does **not** — the
restore executed, and re-opening it would rewrite history. The constraint ADR-0109 **refused** is
now added and bites (`backup_runs_finding_uq`, partial on `kind='backup' AND finding_id IS NOT
NULL`). **The `kind` predicate is load-bearing on real data**: three `kind='restore'` rows share a
`finding_id` with a `kind='backup'` row in one suite run, so a total index would have broken the
approve path three times over — the same partial-index trap that already caused one bug here.

**Probe B showed the old code was worse than ADR-0109 predicted.** Reverting to the old
`status='missed'` read with the index present made the **RE-SCAN itself 409** — the second INSERT
hit `23505` before any deny was reached. The old lifecycle was broken in **two** places, not one;
ADR-0109 had listed that hazard as an unproven limit and it is now reproduced end to end.

**One necessary corollary, verified rather than accepted**: the approve path now marks its source
row `restored`. The old code inserted a new `kind:"restore"` row and marked the finding
`remediated` but **never touched the source row**, leaving it at `restore_proposed` for ever — which
was already inaccurate and, under the new rule, would have made an executed restore
indistinguishable from a pending one, so a re-scan would have superseded work already done.

**S12 — the pre-flight is now a real gate, and building it found a defect in the thing being
wired.** `scripts/preflight-unique-constraints.mjs` printed with `console.log` and then called
`process.exit()`; **Node's stdout is async on a pipe, so a blocked pre-flight could have handed CI a
non-zero exit with NO reason printed** — a gate that fails silently is worse than none. Fixed to
`fs.writeSync` with blockers repeated on stderr. One step added to the existing CI job after the
suite (it needs a *migrated* database; on an empty one every check is trivially zero). `backup_runs`
promoted advisory → blocking: **10 enforced, none advisory.**

**Verified independently: 176 files / 2708 passed + 9 MinIO skips, 0 failed, exit 0**; repo-wide
build and typecheck clean; migration 0109's index confirmed present in the migrated database; and
**the pre-flight run exactly as CI runs it → `CLEAN`, exit 0.**

**R0 — the enterprise plan's buckets were not stale, they were FALSE.** Its framing paragraph said
ADRs 0036–0061 are "Proposed… not a claim that it is built". Measured: **26 of 26 Accepted, zero
Proposed**, against a tree at ADR-0110. Every unticked row read as evidence something was unbuilt.
Corrected with a dated note and a per-bucket banner, the historical text left standing rather than
tidied. The plan's own rule to update the bucketing already existed and went unkept for six weeks;
it is restated **with the durable fix named** — derive the bucketing from the ADR index instead of
duplicating it, because a generated table cannot disagree with its source.

**Honestly outstanding, both recorded**: the new CI step **has never actually run** (GitHub Actions
is exhausted for this repo; verified locally only), and **a re-scan re-opens the ledger row but
never the FINDING** — after a restore that claimed success while the gap is still live,
`infraFindings.status` stays `remediated`, so the live gap is invisible on the findings surface.
Deliberately not fixed here (**S13**). **Corrected 2026-09-19 (ADR-0114, M-036): calling this
"pre-existing ADR-0017 behaviour" was a mis-attribution** — ADR-0017 makes no claim about finding
status, only that a re-scan never duplicates a LEDGER row. The rule was an inline comment at
`infra.ts:883`. S13 is now CLOSED; this paragraph is left otherwise unedited as the record of what
was believed at the time.

**2026-09-09 (later still) — S10 closed: nine constraints added, and TWO REFUSED on evidence.**
([ADR-0109](../docs/decisions/0109-deferred-unique-constraints.md), migration 0108.) ADR-0107
deferred 11 sites where an `ORDER BY` would encode the wrong claim — *"several are expected, here is
the tiebreak"* — when the truth is *"a second one is a bug the database should refuse"*. The design
I set was conservative: **the migration adds constraints and REFUSES; it never repairs, merges or
deletes.** On a deployment holding duplicates the upgrade stops, which for a governance product
beats silently merging somebody's records — the same reasoning ADR-0104 used declining to backfill
consent. A pre-flight report shows an operator what blocks them before they upgrade.

**Nine added** (partial where the column is nullable, total where not), including the valuable one:
**`users_email_lower_uq ON users (lower(email))`** — the real fix behind the case-folded login
lookup ADR-0107 could only make deterministic and explicitly called a stopgap. Every creation path
was read: **SCIM create/replace, OIDC JIT, SAML JIT and the bulk importer all case-fold or
pre-check and are unaffected**; the one unguarded path, `POST /v1/users`, now answers **409**
instead of creating a second account. Normalising the schema to lower case was rejected — it would
silently *adopt* an existing account's address.

**The two refusals are the better half of this batch.**
- **`backup_runs` — REFUSED, and it is a bug in the WRITING code.** I verified the state machine
  myself: the idempotency read matches only `status='missed'` (`infra.ts:198`), proposing a restore
  sets `restore_proposed` (`:1397`), and denying sets it **back** to `missed` (`:734`). So propose →
  a re-scan inserts a second `missed` row → **denying would fail with 23505 and the operator could
  not refuse the restore.** A constraint that blocks a governance decision is worse than the
  duplicate it prevents. Shipped as an advisory pre-flight instead.
- **`data_key_state` — ADR-0107's entry is factually WRONG.** It says "singleton by convention
  only"; migration 0075 already gives the table `id text PRIMARY KEY DEFAULT 'singleton'` **plus**
  `CHECK (id='singleton')` — the identical shape `org_settings` uses. Verified against the migration.
  ADR-0109 corrects it in a new ADR rather than editing an accepted one.

**The `trace_spans` contradiction I flagged dissolved**: the two sites read different predicates.
`closeRunSpan` reads `(trace_id, kind='run')` with no run id and is genuinely multi-row (a trace can
carry a sub-run), so its `asc(seq)` fix stands untouched; the constraint covers the strictly
narrower `(trace_id, kind='run', run_id)`.

**M-033's lesson was applied without being asked twice**: the tests assert both SQLSTATE `23505`
**and** the exact `error.constraint` name, so a refusal by the pre-existing `users_email_unique`
reddens instead of passing as a false success — and each partial index's *excluded* population is
exercised, so an accidentally-total index reddens. Non-vacuity: all nine dropped on a fresh DB →
**11/11 tests fail**, each on its own index; every one is independently load-bearing.

**Verified: 175 files / 2702 passed + 9 MinIO skips, 0 failed, exit 0**, repo-wide build and
typecheck clean, and **9 of 9 indexes confirmed present in the migrated database** — the migration
applied, not merely compiled.

**New, both owed a decision**: the `backup_runs` writing-code fix (does a re-scan re-open a miss
while a restore is pending?), and the fact that **the pre-flight is wired into no CI or deploy
path** — a check nobody runs is worth nothing.

**2026-09-09 (later) — S9 closed: the test-side sweep found two tests that were VACUOUS, not
flaky.** ([ADR-0108](../docs/decisions/0108-test-side-unordered-reads.md), no migration.) The build
agent hit an account rate limit mid-probe; I picked the batch up, reverted an unreverted probe it had
left in `mcp-tool-pricing.test.ts` (fix backed out, a raw `UPDATE` shuffling heap order, a
`console.log`), ran the probes it had not finished, and completed its ADR — whose draft still
described a *single* fix and carried a `[NON-VACUITY RESULT PENDING]` placeholder.

**Scope collapsed under measurement — for the second batch running.** My brief said "~103 at-risk
test sites". Rather than judge cardinality from `pg_index` as I had instructed, the agent
**instrumented 145 of 148 candidate sites in place and ran the suite under the real condition** —
one shared Postgres across all 174 files — turning every count into a fact. **Only NINE sites can
match more than one row**; six of those assert something true of *every* matching row and were
deliberately left alone. **Three needed fixing**, and all three are **pinned rather than ordered**,
because each test already held the identifier for the row it meant. That is the stronger fix, and it
is the second consecutive batch in which measuring beat the inference method I briefed.

**The finding outranks the fixes.** Probing all three, **only ONE reddens**: `data-key-reencrypt`
fails on `completed_with_failures` once the oldest of its four rows is rewritten to the heap end,
which is what `.at(-1)` then picks — a real intermittent, really fixed. The other two stay **green
with the fix reverted while demonstrably reading the wrong row**. `credentials-keys` asserts
`not.toContain("sk-nina-own-key")`, which a **foreign row satisfies trivially** — so a test whose
entire purpose is proving one user's stored key never leaks into another's ciphertext was capable of
proving that about a row belonging to nobody in particular, and would have passed forever.
`mcp-tool-pricing` passes on either row because a neighbouring file's row carries an identical
`{before, after}`.

**Those two were not flaky. They were vacuous, and that is worse** — a flaky test eventually tells
you something is wrong; a vacuous one never does. Recorded as found rather than smoothed into a
3-of-3 count.

**A limit in my own standard technique, now written down (M-033).** I have claimed non-vacuity
across B13a, B14, N1, N2 and S9 by neutralising a control and watching tests redden. That tests
whether the **FIX** is load-bearing. It cannot test whether the **ASSERTION** is — a vacuous
assertion stays green under any probe, and reads as "correctly unaffected". Two of the three sites
here look identical to a legitimate negative control from the outside.

**Verified: 174 files / 2691 passed + 9 MinIO skips, 0 failed, exit 0** on a fresh DB, with the
instrument asserted (`ECONNREFUSED: 0`, `destroySoon: 0`, `PROBE leftovers: 0`). Counts match the
N2 baseline exactly, as expected — S9 changed three predicates and added no tests.

**Still open**: **S8** (parked, two hypotheses eliminated), **S10** (eleven sites wanting a unique
constraint, incl. `users(lower(email))`), **R0**, **R3**. F01 remains open on S8.

**2026-09-09 — N2 landed, and a flake sweep turned up a production serving bug.**
([ADR-0107](../docs/decisions/0107-unordered-single-row-reads.md), no migration.) The task was
meant to be test hygiene: four intermittents in four batches, all the same disease — *a query that
does not ask for an order, whose caller then depends on one*. Scoping it changed what it was. The
real pattern is not the 86 `.at(-1)` sites but `const [x] = await db.select()` with no `ORDER BY`,
which appears **874 times**; after excluding aggregates (a `count()` returns one row by
definition), singleton tables and primary-key lookups, **286 genuine candidates remained, 142 of
them in PRODUCTION**. An unordered single-row read in production is a correctness bug, not a
nuisance — ADR-0105 had already fixed one by accident, where an arbitrary row decided an
authorization outcome.

**The severe one, confirmed independently against the schema**: `training_artifacts` is
`uniqueIndex(...).on(t.jobId)` — unique on `job_id`, with **`agent_id` unconstrained**. A second
training job registers a second artifact against the same agent, and
`resolveArtifactProviderForDispatch` read it unordered. **Which model answered an inference call
was arbitrary and could differ between two identical requests.** Fixed with a total order
(`desc(createdAt), desc(id)` — `created_at` alone ties for rows written in one transaction).
**19 production sites fixed**, 11 **deferred to unique constraints** rather than tiebreaks, on the
reasoning that an `ORDER BY` *accommodates* a duplicate where a constraint *states and enforces*
the belief that there is none.

**The agent improved on my brief, and the correction matters.** I told it to read `schema.ts` for
uniqueness. It refused to trust that, applied all 107 migrations to a fresh database and queried
`pg_index` directly — finding 274 unique indexes **plus 16 PARTIAL ones**, which is exactly where
schema-reading fails in *both* directions: `compliance_packs_one_active_uq ON (framework) WHERE
status='active'` clears a site that looks unprotected, while `guardrail_configs_org_uq ON (scope)
WHERE scope_id IS NULL` does **not** cover a bare `eq(scope,'org')` — and that gap was one of the
bugs. My instruction would have produced both false positives and false negatives.

**Verified: 174 files / 2691 passed + 9 MinIO skips, 0 failed, exit 0**, on a fresh DB with the
instrument itself checked (`ECONNREFUSED: 0`, `destroySoon: 0` — the assertion added after M-032).
Repo-wide build and `tsc --noEmit` clean. Non-vacuity measured: two `ORDER BY`s reverted in place
reddened 2 of 3 tests — the **stale artifact was served** and the **superseded delegation window
returned** — while the third correctly stayed green as its own negative control.

**F01 remains OPEN, and the partition is stated rather than blurred.** Production is swept; **103
at-risk TEST sites are classified but not fixed**, clustering over `audit_log` (15),
`shadow_ai_findings` (12) and `imported_cost_lines` (11) — the same shape as the two flakes already
found, so each is a latent intermittent. The scan also matches only **two syntactic shapes**:
`.at(-1)`, `rows[0]`, `sql.raw` and `Promise.all` destructuring are unswept, and the
`use-cases-eu-tier` flake was itself an `.at(-1)`, so that class is known real and known unswept.
**S8** is still undiagnosed. Five sites where ordering is a *semantic* choice were flagged, not
decided silently — including which external PM tool receives a mirror, where mirroring to every
link is arguably more correct and belongs to its own decision.

**2026-09-08 — N1 landed: the `socket.destroySoon` cause is closed and proven, but F01 stays OPEN.**
([ADR-0106](../docs/decisions/0106-mock-socket-net-contract.md), no migration.) Also closes
**AER-003**'s residue via a documented pinned clean-checkout sequence in `README.md`.

**The cause, traced end to end and verified rather than reasoned.** `@hono/node-server` — in the
tree only **transitively, via `@modelcontextprotocol/sdk`, whose server transport imports it** —
arms a 500 ms `unref`'d drain timer whose `forceClose` reads `socket && !socket.destroyed` and then
calls `socket.destroySoon()` without establishing it is callable. Under `app.inject()` that socket
is `light-my-request`'s `MockSocket extends EventEmitter`, carrying **only `remoteAddress`**: a real
`net.Socket` answers both members, the mock answers neither — so the guard reads `!undefined` →
`true`, passes, and calls a method that is not there. `unref` stops a timer holding the process
open; it does not stop it firing. Fixed by **completing the mock against the contract it stands in
for** — not by suppressing anything: no `dangerouslyIgnoreUnhandledErrors`, no `uncaughtException`
handler, no `node_modules` patch. Two corrections to the long-standing record:
`mcp-admission-auth.test.ts` was **never the buggy file** (its own upstream fixture uses a real
`http.createServer`; it was merely where the transport is driven hardest), and the production
reach is `mcp-proxy.ts:1458`, so every test file driving the inbound MCP route could hit it.

**Proven, not merely quiet.** An async `throw` injected deliberately still yields *173 files passed,
2688 passed, 0 failed, **exit 1*** — the F01 symptom shape reproduced on purpose, showing unhandled
errors are still caught and the suite simply no longer manufactures one. A deliberately broken
assertion also exits non-zero. `destroySoon`: **0 occurrences across 4 independent full runs.**

**But F01's acceptance criterion is NOT met, and N1 is not being marked closed.** It requires
repeated runs with no unhandled errors *and* consistent exit status. Across my four post-fix runs
the exit codes were **1, 0, 0, 0** — the one failure being a *different*, previously unseen
intermittent: `compat-longtail.test.ts` expecting 409 `no_model_credential` and getting **500**. It
passes 3/3 in isolation, so it is order/state-dependent in the shared database. I instrumented it
and re-ran the suite twice more; **it did not reproduce**, so the probe was reverted and no
diagnosis was reached. Recorded as **S8**, with the untested hypothesis explicitly labelled as a
guess. **That makes four intermittents found in four batches, every one by the independent retest
rather than a build agent's run, and all the same disease: an assertion that passes by luck of
what the shared database holds.**

**A verification failure of my own, worth more than the result it nearly produced.** My first two
N1 runs reported *159 files failed* — which was **Postgres being down**, not the code. I had
redirected the database-setup stderr to `/dev/null`, suppressing the one signal that would have
caught it, and every DB-backed file then "failed" with all its tests skipped. Reporting those
numbers would have handed the owner a fabricated regression on work that was sound. Re-run with
setup errors visible, an explicit reachability probe that aborts, and per-run `ECONNREFUSED`
counts. This is the inverse of the warning I myself wrote into `TESTING_CHECKLIST.md` two batches
ago — mass skips mean the database, not the code; I had only considered *dirty*, not *absent*.
See **M-032**.

**2026-09-08 — B14 closed and retested: a consent is now bound to the policy that demanded it, and
expires.** ([ADR-0105](../docs/decisions/0105-consent-context-binding-and-expiry.md), migration
0107.) A third external review run raised **AER-004 (HIGH)**, and it was true on all three counts I
checked: ADR-0104's fingerprint covered `{projectId, arguments}` only; `approvals` carried `ruleId`
and `approverUserId` but **no expiry and no rule/config-version identity**; and consumption was
`WHERE id=? AND status='approved'` with no digest recheck and no freshness test. Two gaps —
consent approved under rule version A stayed spendable after a stricter version B activated or the
required approver changed (an authorization time-of-check/time-of-use hole), and an approved-but-
unconsumed row lasted forever. The fix needed no new versioning concept: **ADR-0073 already
resolves every approval rule through `config_versions`**, so the active version id per rule was
already there to bind against. Consent is now fingerprinted over matched-rule × active-version ×
required-approver × scope, given a queue-time TTL (72h default dial). The 2026-09-08
implementation compared that earlier policy snapshot with the stored digest during consumption;
it did not re-derive policy inside the UPDATE, leaving the race later tracked as AER-004 and
addressed by ADR-0130. Stale rows are **superseded visibly** and re-queued. The required
approver comes from a no-consent evaluation pass, which asks the kernel rather than re-deriving its
selection order and breaks the digest↔selection↔decision circularity.

**Verified independently: 172 files / 2685 passed + 9 MinIO skips, 0 failed**, on a fresh DB, plus
a clean repo-wide build and `tsc --noEmit`. Its negative control is the strongest of the three
batches — 6 of 11 reddened including both headline cases, and the load-bearing green stayed green:
*an unrelated rule versioned → consent still spendable*, which is what proves the digest is not
over-broad.

**A third flake, found by my run and not the agent's** — the same family as the previous two.
`zz-zz-copilot-live.test.ts` asserted citation labels against
`/^(allow|deny|approval_required|error)/`, but `audit_log.effect` is
`["allow","deny","require_approval"]` and `copilot.ts:1055` builds the label straight off the row,
so a cited `require_approval` row could **never** match. It passed only while retrieval sampled
none; B14's suite writes many such rows into the shared DB and the luck ran out. Fixed
(`d8aa906`). **Root cause recorded as S7**: the codebase carries two adjacent vocabularies for one
concept — `audit_log.effect`/`DecisionEffect` say `require_approval`, `GovernedToolCallOutcome.kind`
says `approval_required` — each correct in its own domain, and reaching for the wrong one fails
silently most of the time.

**Three flakes in three batches, every one caught by the independent retest rather than the build
agent's run, all the same disease: an assertion that passes by luck of what the shared database
holds.** That is F01's substance and it raises the value of the `.at(-1)` sweep (N2).

**Fresh reproduction of the exit-code defect, on this very run**: 2685 passed, **0 failed**, and
the process still exited **1** on one unhandled `socket.destroySoon`. Going at N1 next while the
reproduction is in hand.

**2026-09-07 (later still) — two external review documents taken into the build plan.** The owner
supplied an updated `codexInputs.md` (F01–F08 plus an automated block **AER-001…003** from two
review runs) and a second document, `PathForward.md` (**PF-01…PF-14**, Waves 0–4), proposing
RegulAIt be positioned as an AI security & governance **control plane** rather than a monolith.
Both were rechecked against the tree rather than taken on trust, and the sequenced result is in
[ENTERPRISE_READINESS_PLAN.md](../docs/product/ENTERPRISE_READINESS_PLAN.md) §Addendum.

Three things that intake established. **(a) PF-01 — "bind approval to the exact action" — is P0 in
that document and is already substantially built**: PathForward reviewed `271bdca`, which predates
ADR-0104, so the plan records what ADR-0104 delivered and names the honest remaining delta (dual
proposed/enforced digest recomputed pre-execution, envelope breadth, expiry/idempotency, coverage
beyond the MCP path, the ABAC scope dial) instead of scheduling shipped work. **(b) AER-002 is half a
correction to us, and I over-accepted it**: the enforced contract is a **project dispatch freeze** —
an attributed tool priced `null`/`0` is blocked too, by deliberate decision. But AER-002 says the
narrow wording is in "the ADR title", and **that part is false**: ADR-0103 is titled *"Gate the MCP
tool-call path on the project budget"* and already carries an explicit *"It does not gate on the
price of this call"* section; checklist row 58 already spells the unpriced case out too. The only
genuinely narrow artifacts were the **commit subject** and this file's own headline. I repeated
Codex's overstatement into STATE and the build plan without checking it — M-031's rule, a third
time. Corrected in place; **R1** is correspondingly smaller than filed. **(c) AER-003 was partly misattributed**: the repo pins `pnpm@10.33.0` and CI installs
`--frozen-lockfile`; the reviewer's host ignored the pin. The genuine residue is the absence of a
documented pinned clean-checkout command (**R2**).

The plan also records what none of the three sequencing proposals can settle: whether to adopt the
control-plane positioning at all, whether F03 needs true reservations, whether automatic quarantine
may ever act without a human, and the **suite-gated** items (workload identity, artifact admission)
whose `MODULE_REGISTRY.md` / `CAPABILITY_MAP.md` are not readable from this environment. Also
noted: the plan's own Buckets 1–3 are stale at ADR-0036–0061-as-Proposed against today's ADR-0104,
so reconciling them is listed as **R0** — the same "stale row misleads a reader" failure F08 caught
in PENDING.

**2026-09-07 (later) — B13b closed and retested: an approval is now bound to the arguments it was
approved for.** ([ADR-0104](../docs/decisions/0104-approval-payload-binding.md), migration 0106.)
F05's gap: approval lookup keyed on user/server/tool/status only, `approvals` had no arguments
column, and neither the queue row nor the audit row recorded the payload — so an approver signed
"may call `write_note`" and the caller could execute it with anything. **Decided semantics
(action-scoped consent by default, `tool` as an explicit escape hatch)**, because pillar 1 is
default-deny and strictest-wins is this codebase's idiom; the real defect was that *no ADR said
which it was*. Consent is now a sha256 over canonical `{projectId, arguments}`, the approver reads
a **scrubbed** preview of the payload, and the executed digest lands on the audit row under either
scope — closing the forensic half independently of the consent half.

**Two things the agent did better than my brief.** I told it to write a canonicalizer in
`packages/shared`; it found ADR-0060's existing `canonicalJson` and reused that plus ADR-0099's
`scrubAuditDetail`, so there is genuinely ONE of each rather than the second implementation I was
trying to prevent. And it fixed a pre-existing `.limit(1)` with **no `ORDER BY`** in the approval
lookup — the same defect class as the flake found earlier the same day, sitting in the code path it
was already editing.

**Retested: 171 files / 2674 passed + 9 MinIO skips, 0 failed, 0 unhandled errors**, independently
reproduced on a fresh DB, plus a clean rebuild and a **repo-wide** `tsc --noEmit` — the last of
which matters because the agent's own near-miss (an interface edit that silently dropped
`approverUserId`) passed both the gateway suite and a *filtered* typecheck against a stale
`policy-kernel/dist`, and only a repo-wide check caught it. Verified further **by the rows**, not
by status codes: a call signed for `{text:"safe"}` attempting `{text:"exfiltrate"}` sits **pending**
rather than consumed; two identical calls share a digest and the second still re-queues (single-use
intact); the same arguments in a different project carry a **different** digest; and a payload
carrying a synthetic secret stored `[redacted:…]` in the preview while the call still **executed** —
the digest is taken pre-scrub, so redaction cannot move consent identity.

**A correction I own.** My brief asserted that `mcp-proxy.test.ts` "passes while doing exactly
that". It does not — that test queued and executed with the *same* `{text:"hi"}`, and its retry was
refused by single-use consumption, not by any payload check. The suite never exercised the hole in
either direction. The finding stands (the neutralised-binding control shows it plainly), but I
described a test from its shape instead of reading what it passed in. **M-031**, a repeat of M-030
inside one session.

New residue recorded: **an ABAC-driven pause has no configurable scope** — with no matching
`approval_rules` row the default `action` applies (fail-closed, correct), but `abac_policies` has
no scope column, so the `tool` reading is unavailable to a policy-driven pause.

**2026-09-07 — B13a closed and retested: an exhausted project now FREEZES its attributed MCP
dispatches, and my own retest caught a flake the build agent's run did not.**
([ADR-0103](../docs/decisions/0103-mcp-path-project-budget-gate.md), no migration.) An outside
review (Codex, findings F01-F08) was assessed against the tree; 7 of 8 checked claims held, F04
was stale because ADR-0102 closed it the day before. **F02 was the live one**: pillar 5's
`preDispatchProjectGate` had exactly ONE production call site — the model/connector dispatch path
— so the MCP tool-call path was **priced and attributed but never gated**. Setting
`x-regulait-project-id` and looping `tools/call` ran unbounded paid spend against an exhausted
project, and the overspend then surfaced as a 409 on the *model* path: the symptom appearing
somewhere other than the cause. The gate went into `executeGovernedToolCallInner` — the ONE shared
primitive both entry points funnel through — sited exactly as §8.4 PII and ADR-0023's read_only
enforcement already are, so pillar 7's delegated worker inherits it structurally rather than by
anyone remembering. The gate is **reused, not reimplemented**, which carries the ADR-0027 ceiling,
`overageActive`, ADR-0021's `budgetHardBlockPct`, strictest-wins `warn_only`, and the escalation
into the one approvals queue. Unattributed calls are unchanged and now **defined** rather than
merely tolerated.

**The retest is the part worth recording.** Three full runs of the identical commit: the agent's
170/2664/9-skips clean; mine **2663 passed / 1 failed** with an unhandled error, exit 1; mine again
**2664/0**, zero unhandled errors, exit 0. Two independent lessons. (a) The one failure was NOT
B13a and NOT the known `destroySoon` issue — `use-cases-eu-tier.test.ts` selected from `audit_log`
with no `ORDER BY` and then indexed `.at(-1)`; Postgres guarantees no row order without one. Fixed
(`0ebfabe`); certification run after the fix: **170 files / 2664 passed + 9 MinIO skips, 0 failed,
0 unhandled errors**. (b) **I withdrew one of my own earlier corrections**: I had edited PENDING to
say the `socket.destroySoon` attribution to `@hono/node-server` was wrong "because that package is
not in this repo at all". It IS — transitively, via `@modelcontextprotocol/sdk@1.29.0`
(`pnpm-lock.yaml:4223`). A direct-dependency check missed a transitive one, and I published the
negative. See **M-030**. Net: the suite had **two** unrelated flake sources and §5 had been
blaming one for both. Also corrected: `/app` and `/admin` do **not** 404 as I had said — they 302
to `/ui` and resolve 200, so that F08 item is cosmetic banner staleness, not a broken link.

Still open: **F05** (approval payload binding — designed and briefed, build not yet started),
**S6**, F01's exit-code work and the `.at(-1)` sweep (86 sites, most benign), F03 (the gate is
measured-spend/first-crossing-allowed, not a reservation), and PR #108's description.

**2026-09-06 (later) — B12 closed and retested: the credential leak that the B10 retest found
is shut, and the ledger says exactly how far.** ([ADR-0102](../docs/decisions/0102-operator-prose-credential-scrub.md),
no migration.) ADR-0099 scrubbed `audit_log`; the retest proved the *same* operator-typed key,
in the *same* request, was stored verbatim in `mcp_servers.admission_clear_reason` — one of 47
free-text columns where a human can paste a secret while explaining an action. **The fix I
briefed was measured and rejected**, which is the outcome I wanted from asking: there are **0
shared reason schemas against 63 ad-hoc inline declarations**, so a zod refinement would have
been the per-call-site convention ADR-0099 rejected in a costume. It went instead into the
`createDb` Proxy ADR-0060 already installed — not audit-specific — composing outside the
audit-chain wrapper and re-wrapping `transaction()`, which is load-bearing because the approval
decide route writes its reason inside its own transaction. **51 columns covered, 3 excluded by
name**, and the coverage is structural rather than a snapshot: a test asks `information_schema`,
not the TypeScript, so a hand-authored migration cannot slip past. Retested live — the exact S5
case inverted, with the column's marker **character-identical** to the audit row's (the two
records now agree, which is the defect S5 actually named), a second surface scrubbed inside its
transaction, and ordinary prose byte-identical. I also widened that guard myself (`c90a403`) to
the same patterns as the sweep that found S5, and proved it non-vacuous. Suite **169 files /
2656 passed + 9 MinIO skips**, independently verified on a fresh DB. **S5 is struck in
proportion**: its 47 columns are closed, but ~34 `name`/`title`/`description` **content** columns
remain verbatim and are now recorded as **S6** rather than allowed to vanish inside the closure —
and ADR-0099's stale "but see S5" cross-reference was corrected in the same commit so the two
rows cannot contradict each other. Still open: **S6**, the non-deterministic suite exit code, and
PR #108's description, which is stale at ADR-0092 against today's ADR-0102 and 169/2656.

**2026-09-06 (later) — B11 closed and retested: MCP registries can now be federated, and an
imported entry arrives usable by nobody.** ([ADR-0101](../docs/decisions/0101-federated-mcp-registry.md),
migration 0105.) This was deliberately sequenced last of the MCP wave: the reference
implementation we reviewed grants federated entries the same access as locally-registered ones
with no approval step, which is a default-deny violation, so federation was only safe to build
once ADR-0097's admission gate existed to put imports behind. Built against the **real** v0.1
registry API (`GET /v0.1/servers`, opaque `metadata.nextCursor`, unauthenticated reads) — and
notably the dispatch brief I wrote carried an error from a docs summary (it claimed `packages`
was required); the builder checked the spec, found otherwise, and built to the truth. The
governing rules: a sync writes only a catalogue, **import is a separate audited operator act**
creating one `federated`/`unscanned` row with **zero grants**, a federated server is still
subject to admission with no bypass, and a local row is **never** clobbered — collisions are
recorded and refused. Only a `remotes[]` entry with an absolute untemplated URL can become a
server; a package's own loopback `transport.url` is deliberately ignored and **no URL is ever
invented**, which matters because most registry entries are stdio packages this gateway cannot
proxy at all. Air-gapped refuses before DNS. Retested live against a local fake registry: grant
deltas of zero, the ungranted refusal proven non-vacuous, `held|critical` on a poisoned
federated upstream, cursors round-tripped verbatim, idempotent re-sync, and B9/B10 regressions
intact. Suite **168 files / 2640 passed + 9 MinIO skips**, independently verified on a fresh DB.
Also confirmed at the owner's prompt: **everything is on GitHub** (remote head == local, PR #108
carries it) — but **that PR's description is stale**, ending at ADR-0092 and quoting 141/2321
against today's ADR-0101 and 168/2640; left for an owner decision rather than rewriting a
20k-char record. Open findings carried forward: **S5** (audit scrub covers `audit_log` only; 47
other free-text columns store operator prose verbatim) and the **non-deterministic suite exit
code**.

**2026-09-06 — B10 closed and retested: the product's most privileged credential now expires,
the audit ledger scrubs secrets by construction, and the admission gate no longer has a blind
spot.** Three slices from the gap-review backlog, all previously ranked and none requiring a
prior decision to be reversed. **B10a** ([ADR-0098](../docs/decisions/0098-api-key-expiry.md),
migration 0104): `api_keys` had no expiry column at all, and API keys are what authenticate the
MCP proxy — they now carry a lifetime with an org default and ceiling, enforced in
`authenticate()` (the single place a bearer token becomes an identity, so there is no second
path to bypass). Both dials ship NULL, so an upgrade invalidates nothing; expired and revoked
are distinct 401s with distinct audit rule ids; the ceiling **refuses rather than clamps**,
including refusing an explicit never-expires request. **B10b**
([ADR-0099](../docs/decisions/0099-audit-log-credential-scrub.md)): the credential scrub is
sited at ADR-0060's existing audit-chain chokepoint, so raw inserts and future call sites are
covered by construction rather than by 30-odd authors remembering a helper; redaction preserves
correlation, and scrubbing precedes hashing so chain verification still passes. **B10c**
([ADR-0100](../docs/decisions/0100-scheduled-mcp-admission-rescan.md)): an off-by-default sweep
closes ADR-0097's own residue — a compromised server nobody calls is now re-examined anyway —
re-adjudicating through the LIVE path so no second threshold exists, with `held` deliberately
ineligible because nothing may auto-un-hold. Suite **167 files / 2599 passed + 9 MinIO skips**,
independently verified on a fresh DB. **Two findings came out of the retest, both recorded
rather than patched**: **S5** — the scrub covers `audit_log` only, and the same operator-typed
key was persisted verbatim to `mcp_servers.admission_clear_reason`, one of **47** free-text
columns outside the ledger (the fix is a design choice, and guessing at it would repeat the
convention ADR-0099 rejected); and the gateway suite's **exit code is non-deterministic**
(unhandled socket-teardown errors, same two errors giving exit 0 then 1) which matters because
local verification is this project's only gate. Process: **M-029** — I judged B10a untested from
one commit's stat and overwrote the tests it had committed in another; recovered because the
work had been pushed. Surface ownership held: B10c was rescoped to backend-only, and the
admission review-queue page is an explicit handoff to the local session that owns `apps/web`.

**2026-09-05 — B9 closed and retested: MCP servers are now admitted, not merely registered,
and off-the-shelf MCP clients can discover how to authenticate.** Prompted by an owner-requested
gap review against [mcp-gateway-registry](https://github.com/agentic-community/mcp-gateway-registry)
(Apache-2.0; the review's full findings, including the nine gaps NOT built, are recorded in
PENDING.md), the two highest-value items shipped as one slice —
[ADR-0097](../docs/decisions/0097-mcp-admission-scanning-and-auth-discovery.md), migration 0103.
**Admission scanning** closes a real hole: ADR-0043 gated a server's URL, but `syncUpstreamTools`
then upserted its tool names, descriptions and input schemas unexamined — so a compromised
upstream could put instructions in a description that our models read and obey. A local,
deterministic, zero-network scanner (reusing ADR-0042's detectors, adding tool-order,
sensitive-path, exfiltration and hidden-Unicode rules) now runs over every scanned string
**including each nested schema property description**, and the gate sits at the first statement
of `connectUpstream` and inside the sync before the upsert, so a dirty manifest is never stored.
Retested live: refusal proven **pre-connect by killing the upstream** (still
`mcp_admission_held`, not a connection error), nested-only poison caught with its exact JSON
path, and — the property that matters most — an approved server whose upstream later changed was
**automatically re-held**, so approved-once is not approved-forever. The knob ships `off`
(byte-identical, verified) with `log` and `enforce` beside it; clear is admin-only,
reason-required and audited. **Auth discovery** adds RFC 9728 metadata and an RFC 6750
`WWW-Authenticate` challenge, built to one rule: never advertise a mechanism we do not accept —
`authorization_servers` is omitted *with a written reason* because no route validates an
IdP-issued token, and both advertised credentials were verified genuinely accepted. Suite:
**164 files / 2560 passed + 9 MinIO skips**, independently verified on a fresh DB; the pre-change
403 baseline I captured beforehand is unchanged, confirming no entitlement refusal became a 401.
Process: **M-028** logged — a delegated gap-check answered in convincing detail from a
rolled-back tree (8th rollback), so any subagent reading the repo must now prove `HEAD == origin`
before reading. Owner-gated work is unchanged; PENDING's new addendum names the next buildables
(semantic discovery, which would reverse ADR-0044/0067, and quarantine, which collides with
ADR-0092's no-auto-revoke).

**2026-08-23 — B8 closed and retested: the copilot's filter matrix, the versioning ADR's
last structural pair, and the applier's last two kinds are done; the buildable tail is empty
again.** **B8a** (ADR-0096 amendment): vendor questions filter the audit ledger
(`object_type='ai_vendor'`, retested 94→3 on rows the product wrote), AI use cases narrow
approvals through their own workflow-instance pointer (9→1 live), and workflow templates
narrow through `template_ids` containment (9→1 live, a composed instance counting for every
composing template); still-refusing pairs stay pinned, and the honest limits are recorded
(anomalies-tool intersection deliberately unwired; vendor spend unanswerable). **B8b**
(ADR-0073 amendment, no migration): the compliance-profile shadow is STORED HISTORY —
write-through into `config_canary_observations` with candidate×project×fingerprint dedup
(re-reads write nothing, retested), the 50-project cap disclosed in-row, B7c's prune covering
it unchanged — and recorded divergence feeds the ADR-0059 preview as the read-only
`complianceProfileCanaryDivergence` field (byte-absent without divergence; both legs retested
live with a hipaa candidate). **B8c** (ADR-0056 amendment, no migration): `rule_to_approval`
and `budget_adjustment` proposals now APPLY — through the PRE-EXISTING public routes via
extracted shared implementations (`createApprovalRuleRow`; `applyProjectPatch`, honestly
scoped to project budgets), running each route's own zod with issues verbatim; retested
end-to-end (approval_rules 3→4 with a 409 second apply; budget 0.2→5 with a smuggled field
refused and the project untouched). Suite: **163 files / 2535 passed + 9 MinIO skips**,
independently verified on a fresh DB at `f9b24b1`. Process: **M-027** logged — four
consecutive slice agents stalled on phantom monitors (one with uncommitted work); the
foreground-verification dispatch rule fixed it. Remaining work is owner-gated only (L13,
L19, PII floor, savings semantics, P2 HA, L11/L9, live PM creds, S3 keypair, certification,
quota refresh); the named-next buildables now in PENDING are the anomalies-tool intersection
for use cases/templates and the rule-canary per-decision preview aggregation.

**2026-08-22 (late night) — B7 closed and retested: the buildable-anytime tail is now EMPTY;
every remaining pending item is owner-gated.** The three residual groups the ledger still
carried became batch B7, each agent-built on its own scratch DB and then independently
verified and hands-on retested keyless (criteria pre-written; Google quota still exhausted).
**B7a** (ADR-0096 amendment): the seven remaining entity kinds — compliance packs, AI use
cases, AI risks, workflow templates, initiatives, roles, virtual keys — now resolve in the
copilot, each reusing its own list endpoint's visibility; initiative and virtual_key filter
across multiple ledgers with row-delta proofs, the other five are audit-filterable, and the
retest proved usage 19→15 on a named initiative plus the two-user byte-identical refusal with
its negative control. **B7b** (ADR-0052 amendment): all four remaining tier flags enforce at
their enabling acts (pack activation, decompose, air-gapped deploy target, custom provider —
authoring and basic runs stay open) and the four expansion points are wired;
`enforcementPointsWired` reports 11; retested on an ABSENT license (four named audited 403s,
open paths still 201). **B7c** (ADR-0073 amendment, migration 0102): canary-observation
retention sweep (10th scheduler job + manual door + org knob; versions NEVER pruned,
live-canary evidence kept — retested pruned=1/keptLiveCanary=1), the subject-delete AFTER
DELETE trigger (activation-ledger-authored, proven on a raw SQL delete), and
`usage_events` now stamps the agent_config version that SERVED (moved 3→4 live across an
activation flip; seed rows NULL). Suite: **161 files / 2509 passed + 9 MinIO skips**,
independently verified on a fresh DB at head `77f2f38`. Process: a fifth silent workspace
rollback was absorbed with zero loss (origin restore), and **M-026** logged — decision-only
invoke 200s are previews, not executions; verify probes by the state they write. What
remains is owner-gated only: L13, L19, PII floor default, pillar-6 savings semantics,
session-narrowing/mirror-persistence decisions, P2 HA, L11/L9, live PM creds, S3 release
keypair, certification — and a Google quota refresh for live-narration work. Named-next
buildables recorded in PENDING: vendor audit-filter (now unblocked by ADR-0084's
object_type) and two approvals joins for the copilot.

**2026-08-22 (night) — B6 closed: the last three buildable residuals are live-retested; the
copilot's hallucination class is shut twice over; a parallel-sessions protocol now governs this
repo.** Since the paragraph below: the L6d two-layer narration fix landed and live-retested,
then [ADR-0096](../docs/decisions/0096-copilot-entity-aware-planning.md) replaced disclosure
with structural refusal — deterministic entity extraction (the model may never assert
existence), entitlement-scoped exact-match resolution, and four honest outcomes
(resolved+filtered with a proven row delta, 422 unresolved, 422 ambiguous-with-candidates,
422 tool-cannot-filter), scope honesty byte-identical between invisible and nonexistent.
**B6** (dated amendments to ADR-0095/0080/0096, migration 0101): one exported
`mockShadowedByLive` predicate now covers routing + compaction-summarizer + decompose-worker
(skips disclosed on the audit rows), an org knob `dispatchAttributionRequired` refuses
projectless governed dispatch with 409 `attribution_required` **before any provider call**,
and the copilot resolves MCP servers/tools as first-class entities (row-delta proven
108→1→4 on real deny rows). Live retest passed on all three; mid-retest the owner's Google
key **exhausted its quota** — every gate/refusal/disclosure was proven anyway (the 409-vs-
provider-502 asymmetry itself proves gate ordering), further narration-content live work is
parked in PENDING.md until quota refresh. My independent full-suite verification caught one
non-B6 failure: a latent **7.13%-measured flake** in `agent-config-versioning`'s canary
subject selection, diagnosed with the failed run's real draw order and fixed at the root
(min/max-over-batch, `445a77d`). Gateway now **2475 passing + 9 MinIO skips / 157 files**,
fresh-DB green. Multi-session work is now governed by
[docs/CONTRIBUTING_PARALLEL_SESSIONS.md](../docs/CONTRIBUTING_PARALLEL_SESSIONS.md)
(CLAUDE.md bootstrap step 5): declared surface ownership, push-immediately, the migration-
watermark and same-number-file hazards written down. Remaining work is owner-gated only:
L13, L19, PII floor default, pillar-6 savings semantics, P2 HA, other provider keys, live PM
creds, L11 drift, L9 bias, S3 release keypair — and quota refresh for live narration.

**2026-08-22 (evening) — local hands-on testing of the live copilot found a real
hallucination hole; fix in flight.** Pulled HEAD, built, seeded a fresh database and drove the
copilot against the live Gemini credential. **What works:** deterministic grounding cites real
`audit_log` ids; live narration returns `generation: model` with `modelNarrationVerified: true`
through the governed path, **metered** (2 rows, 1,804 in / 603 out tokens, ~$0.008, attributed)
and audited (`copilot-question-answered`); the decision-support notice and scope caveat render
on every answer. **What broke:** a question naming a NONEXISTENT entity ("Summarise the
Zorblatt Quantum Compliance Widget approvals from last week") did **not** refuse — the
keyword planner ignored the unknown entity, ran an unfiltered `listApprovals`, retrieved 8
real org-wide approvals, and the model narrated *"for the Zorblatt Quantum Compliance Widget,
8 approvals were requested, 4 approved, 4 pending"* — a fabricated subject bound to true
numbers, stamped verified. The three existing guards all passed legitimately (no invented
figure, no invented id, retrieval non-empty); **none checks that the question's SUBJECT was
ever a filter**. Fix dispatched (two layers: filters disclosed to the narrator with a hard
rule against attributing findings to unfiltered entities, plus a deterministic caveat that
holds even when the model misbehaves; ADR-0056 amendment states precisely what
`modelNarrationVerified` does and does not mean). Two process lessons logged: **M-023** (I
called a run a reproduction before the negative control — which then also passed, proving
nothing) and **M-024** (L6's own live test proved the refusal only in the EMPTY-retrieval
case, the easy one, so this whole class survived "verified"). Also fixed and pushed: an
order-fragile SoD audit assertion my independent full-suite run caught (`6059271`). Suite at
**153 files / 2437 passed + 9 skips**.

**2026-08-22 (later) — the autonomous queue is EMPTY: B1–B5 and L6 all landed.** Everything
buildable without further owner input is built, each slice agent-built then independently
re-verified on a second fresh database. **B2** (ADR-0090/0091): campaign expiry sweep on the
real scheduler that decides nothing, review reassignment reusing ADR-0046's escalation with
the holder-bar covering both holder shapes, SoD **N-way** sets (refusing only the completing
mint) and pattern selectors on three enumerable dimensions (no free regex). **B3**
(ADR-0080/0086/0089, migration 0098): three enforcement opt-ins, all default-off and proven
byte-identical until flipped — use-case dispatch gate (`off|warn|enforce`), staleness-forces-
recertification deepening ADR-0045's gate, intent capture with post-approval edits refused by
name. **B4** (ADR-0063, migration 0099): the resumable transactional **key re-encryption
walk** — watermark advanced inside the rewrite transaction, fail-closed registry drift check,
corrupt rows recorded with `completed_with_failures` never `completed`, kill/resume proven.
**B5** (ADR-0049/0052): six test files cured of shared-scratch-DB collisions (proven both
directions), the framework cost floor genuinely sourced from the cascade, first two tier flags
enforced at their enabling acts. **L6 + L24's model-judged half** (ADR-0056/0092 amendments,
migration 0100): the **governance copilot is live through governed dispatch** — grounding
moved from counts to retrieved object ids, an empty retrieval is a refusal (the live model
itself refused a nonsense object), proposals gained a consent-gated applier riding the real
choke points (`applyRuleEdit`, the one grant-revocation function — never a raw write) with
two kinds honestly named unapplied *(all four kinds apply as of batch B8c, 2026-08-22; and as
of batch B9a, 2026-09-27, a malformed diff is refused BEFORE an approval is opened — see the
ADR-0056 amendments)*, and recommendations gained an opt-in `model-judged`
annotation layer that never touches deterministic evidence. Two live-driven fixes: narration
was structurally impossible at a 1024-token ceiling on a reasoning model (981 thought tokens,
39 of JSON, correctly discarded) — ceilings raised and measured. Gateway **2437 passing + 9
MinIO skips / 153 files**, shared **742**, Playwright **136/136**. Process: **M-022** logged —
the first L6 attempt was lost when a workspace rollback erased its unpushed commits, so agents
in this container now push every scoped commit immediately. Remaining work is owner-gated only
(L13, L19, PII floor default, other providers' keys, live PM creds).

**2026-08-22 — the credential is UNPARKED, live-proven; owner testing is live; the follow-up
queue is landing.** The owner supplied a Google/Gemini key and live-instrument verification
passed **V1–V7** ([LIVE_VERIFICATION_2026-08.md](../docs/product/LIVE_VERIFICATION_2026-08.md),
~$0.007): governed live dispatch with real metering, streaming, PII-cascade-precedes-dispatch
proven against a live backend, judges (`model-judged` + the keyless 422 both ways), live-graded
red-team trials, routing treating the live provider as a credentialed candidate. Owner testing
against the checklist began and drives fixes directly: home stats now survive orientation
dismissal (Show-orientation toggle), and **ADR-0094** rebuilt the console as a **tile launcher
+ suite-scoped sidebar** (one product suite at a time, cross-suite `/` filter as the
anti-stranding escape hatch, routes byte-identical, Playwright 121→127). Batch **B1**
(ADR-0073/0058 residuals): rule CRUD edit/delete built honest-first over versioning (migration
0095: `retired` version status), `agent_config` became real versioned dispatch config with a
zero-influence shadow canary, pack activation now seeds its §8.3 profile (migration 0096,
presets as pack data). Batch **B1.5** (ADR-0095): owner-found mock-routing defect fixed —
mocks route only when no credentialed live agent can serve (`mock_shadowed_by_live`
disclosed, keyless demo byte-identical), savings never priced mock-vs-live; seed google agent
→ `gemini-3.6-flash` (the 2.5 id is retired for new accounts) and `PATCH /v1/agents/:id`
rides the versioned edit path. Gateway **2361 passing + 9 MinIO skips / 146 files**,
Playwright **127/127**. In queue: B2 certification ops → B3 enforcement opt-ins → B4 key
re-encryption → B5 long tail → **L6 governance copilot + L24 model-judged half** (now
buildable). PENDING.md's credential section reads UNPARKED.

**2026-08-21 (later) — pending ledger made durable; enterprise console IA shipped.**
[PENDING.md](../docs/product/PENDING.md) now carries the complete post-queue pending set,
each item with its exact unblock condition (credential / owner decision / live instrument /
deliberate refusal / anytime follow-up) — written after the harness task list was lost to a
workspace rollback, proving in-repo docs are the only durable ledger. Then an owner-directed
enterprise UX pass ([ADR-0093](../docs/decisions/0093-console-information-architecture.md),
subordinate to ADR-0075): the 26-entry Governance nav split into **11 question-shaped
sections** (routes and labels byte-identical — grouping, not renaming), one `SeverityBadge`
vocabulary on the brand's measured severity pairs (two disagreeing local maps deleted), a
dismissible first-run orientation on the admin home (three live numbers, start-here links,
zero extra fetches), and raw JSON dumps replaced with bounded code blocks. Survey finding
recorded honestly: the page-pattern discipline had held — every new page already used the
shared header/label/skeleton/empty-state idioms. Playwright **121/121** incl. the brand
contract; one legitimate spec update (nav-section list 6 → 11, assertion unweakened).

**2026-08-20 — the Credo-gap queue is landing: L1 and L3 shipped, positioning refreshed.** A
gap analysis against Credo AI ([GAP_ANALYSIS_CREDO_AI_2026-08.md](../docs/product/GAP_ANALYSIS_CREDO_AI_2026-08.md))
ranked eight lacks, and the owner directed both building the gaps and out-placing their
presentation — so [POSITIONING.md](../docs/product/POSITIONING.md) (category claim: *AI governance
that enforces itself*), two ADR-cited comparison pages, and a README hero rewrite shipped first.
Then **L3**: a seventh seed compliance pack — SOC 2 Security (Common Criteria), 10 controls
honestly graded, no CPA review claimed, `cascadeTag` null — as a dated ADR-0058 amendment. Then
**L1** ([ADR-0080](../docs/decisions/0080-ai-use-case-registry.md)): an AI use-case registry with
a pre-build intake front-door on pillar-2 rails (gallery template → ADR-0079 resting plan →
questionnaire artifact → sign-off), whose `complianceTags` are the same tags §8.3 enforces and
whose status can only change through the one decide path (both lifecycle joins proven non-vacuous
the M-002 way), plus an admin Use-cases page. Then **L2**
([ADR-0081](../docs/decisions/0081-ai-risk-register.md)): an AI risk register that makes the
measurements legible as *risk* — a `DEFAULT_RISK_LIBRARY` of eight agentic risks whose evidence
is computed at read time through a fixed category→resolver mapping over the real ledgers
(red-team ASR verbatim with its Wilson interval, groundedness runs, PII/budget denials,
guardrail configs, grants inventory), measured and declared kept in two labelled blocks that
are never blended, acceptance an admin-only audited terminal action that freezes the evidence
it was taken on, and `scope_drift` honestly attestation-only. Then **L7+L8**
([ADR-0082](../docs/decisions/0082-inventory-and-posture.md)): a standing agent dependency
inventory — pure aggregation, no migration — where **granted (may) and observed (did) are
never blended** (grants ∪ role-derived − revocations vs. usage-event dispatches, trace-attributed
tool/connector calls, and agent→agent feed edges from orchestration run history), plus a
board-shaped, print-friendly **Posture one-pager** on ADR-0047's rails: every number a SELECT
at request time (pack coverage via `evaluatePack`, risk counts with the attestation-only count
named, ASR verbatim with its Wilson interval, spend vs budget, observed anchor grading), and
an empty section renders *unmeasured, not resisted* — never zero-implies-good. Gateway suite
**2172 passing + 9 MinIO skips / 131 files**, Playwright **109/109**, on fresh scratch
databases — still the only gate (Actions exhausted). Then **L4**
([ADR-0083](../docs/decisions/0083-shadow-ai-first-party-discovery.md)): first-party shadow-AI
discovery as an **extension of ADR-0071, not a reversal** — a frozen, hash-pinned
`SHADOW_AI_CATALOG_V1` (81 entries: 37 endpoint, 44 SDK signatures; no regex over input, no
scrapers, no network calls) classifying operator-supplied DNS/proxy logs and dependency
manifests through ADR-0071's existing ingest path, with the honest core being the
**governed-via-gateway vs shadow** line computed per request from live model-credential/custom-
provider config (deliberately NOT the egress allow-list, which would launder egress permissions
into "governed AI"); a hit proves an artifact mentioned a provider, never that traffic flowed,
and compiled-only signature hits surface as named catalogue gaps rather than findings. Then **L5**
([ADR-0084](../docs/decisions/0084-vendor-ai-risk-portal.md), owner-directed over the gap
doc's defer note): vendors as governed objects on the pillar-2 assessment rails — vendor
answers live on the vendor's own row as **attributed attestations that are never evidence**
(pinned both ways: zero delta on `compliance_pack_attestations`, and an org pack evaluation
after a vendor claim still reports `attestation_required`); the seeded SOC 2 v1 stays
byte-identical with CC9.2's graduation path recorded, and the risk register gains a
`third_party_ai` category with a real resolver from day one. Gateway suite **2200 passing +
9 MinIO skips / 133 files**, Playwright **111/111**. The Credo L-queue is now **fully built**
(L1–L5, L7, L8; L6 waits on the parked credential). A second competitive pass
([GAP_ANALYSIS_FOUR_VENDORS_2026-08.md](../docs/product/GAP_ANALYSIS_FOUR_VENDORS_2026-08.md),
owner-directed: Holistic AI, watsonx.governance, Fiddler, OneTrust — all four sites
egress-blocked, per-source honesty grades recorded) ranked lacks L9–L19 and struck ten
near-miss claims after in-repo verification. Then **L10**
([ADR-0085](../docs/decisions/0085-eu-ai-act-tier-screening.md)): EU-AI-Act risk-tier
*screening* on the intake — a frozen, hash-pinned 17-rule data-only ruleset
(`EU_AI_ACT_RULESET_V1`: 4 prohibited/11 high/2 limited, dominance ordered) computed
server-side only from a fenced answers block in the questionnaire artifact (a smuggled tier is
refused; unscreened is null, never guessed), the tier **informing** the human sign-off rather
than blocking (blocking would overclaim enforcement and legal judgement — proven by a
prohibited use case both denied and approved by its human with the tier as the recorded why);
`high` derives its cascade recommendation live from the org's actual eu-ai-act packs/profiles.
Gateway **2208 passing + 9 MinIO skips / 134 files**, Playwright **112/112** (e2e fixture fix:
the auth rate-limit bucket raised in global-setup — the 112th sign-in tipped the production
default's rolling window). Then **L12**
([ADR-0086](../docs/decisions/0086-model-card-autofill.md)): the model card becomes **a window
you sign** — evidence-shaped sections computed by SELECT at read time from the real ledgers
(evals/groundedness, red-team ASR verbatim or *unmeasured not resisted*, guardrail modes,
spend, effective grant holders, drift standing, linked use-cases/risks/vendors), kept in a
labelled block that never blends with manual evidence; at the one decide path the on-screen
window is frozen into the decision's audit detail (no migration — the snapshot is an audit
artifact, not card state), and a **staleness note** counts what moved since the last granting
decision ("2 eval runs and 1 guardrail change since certification") without judging it —
ADR-0045's expiry gate untouched, no fairness number ever synthesized (pinned; L9 stays
open). Gateway **2218 passing + 9 MinIO skips / 135 files**, Playwright **113/113**. The
four-vendor build-next queue is done. Then **L15**
([ADR-0087](../docs/decisions/0087-compliance-pack-version-diff.md)): the regulatory-
intelligence feed REFUSED (a publisher's product; a feed would launder legal advice into a
gateway that disclaims exactly that authority) and the pack-version diff BUILT — a
deterministic zod-typed differ (cascadeTag changes flagged HIGH-consequence), a read-only
diff endpoint whose **impact preview** evaluates both stored versions through the existing
`evaluatePack` machinery against the current ledgers and names every computed-status move,
and an activation audit that records whether a diff was computed without ever gating on it.
Gateway **2228 passing + 9 MinIO skips / 136 files**. A fifth competitive pass
([GAP_ANALYSIS_SAVIYNT_2026-08.md](../docs/product/GAP_ANALYSIS_SAVIYNT_2026-08.md),
owner-directed): Saviynt's Agent Access Gateway is the first genuine call-plane claim in the
series, but **their gateway authorizes an identity; ours governs the call** — nine near-miss
claims struck; new lacks L20 (agent ownership/lifecycle/orphan signal) and L21
(intended-vs-granted flags) queued build-next, L22–L24 later, L25/L26 refused (we integrate
with IGA, we do not compete for it). Then **L14**
([ADR-0088](../docs/decisions/0088-external-scorer-adapter.md)): the external-scorer adapter —
the operator brings a Fiddler-style scoring endpoint as a registered, governed instrument
(custom-provider egress/SSRF validation and credential custody, refused in air-gapped mode,
migration 0090); every stored score is stamped `method: external:<name>` and never blended
with lexical or model-judged, an unreachable scorer follows ADR-0067's refuse-don't-degrade
path, and the inline guardrail path deliberately stays local-only as a named boundary. Built
across a container restart: the killed agent's artifacts survived in pushed WIP checkpoints
and were validated whole rather than rebuilt (M-015) — full revalidation from cold: `pnpm -r
build` clean, shared **719**, gateway **2246 passing + 9 MinIO skips / 137 files**, Playwright
**114/114**, all on fresh scratch databases. Owner promoted **L22–L24** into the queue
(2026-08-20). Then **L20+L21**
([ADR-0089](../docs/decisions/0089-agent-ownership-alignment.md), migration 0091): identity
lifecycle at the call plane — agents gain an owner and a lifecycle where **retired refuses
dispatch** (409 in the one dispatch core, after entitlement, before any provider work; terminal)
and **deprecated only warns**; ownership renders as owned/unowned/orphaned computed at read
time (orphaned = owner's SCIM-written `disabled_at`), and the inventory gains a third
never-blend block: **intended-vs-granted alignment** (aligned/undershoot/overreach against
`ai_use_cases.intendedAgentIds`, holder sets imported from ADR-0082's index, never about
traffic). Gateway **2263 passing + 9 MinIO skips / 138 files**, Playwright **116/116**.
Then **L22**
([ADR-0090](../docs/decisions/0090-grant-certification-campaigns.md), migration 0092): grant
certification campaigns over **gateway grants only** — a campaign snapshots the grants that
existed at open, each item is one row on the ONE approvals queue decided via
`decideOneApproval`, the own-grant bar is decider-keyed (an admin holder with an override
reason is still refused), **revoke executes the real removal inside the decision's
transaction** (which surfaced and closed a real gap: direct MCP tool/server grants had no
removal path at all — two DELETE endpoints added on the shared impl), and a past-due campaign
reads `expired-incomplete` on the breach-on-read idiom — undecided items stay undecided
forever. Gateway **2279 passing + 9 MinIO skips / 139 files**, Playwright **118/118**.
Then **L23**
([ADR-0091](../docs/decisions/0091-sod-toxic-combinations.md), migration 0093):
toxic-combination SoD at the grant choke point — admin-declared capability pairs (concrete,
two-sided, reason required) refused `409 sod_conflict` at **all nine mint paths** (4 direct,
4 role grants checked against every current assignee, role assignment against the whole
bundle including bundle-internal pairs), a dedicated mint-time check so the kernel stays the
one call-time path (byte-identical with zero rules), existing violators **surfaced at read
time and never auto-revoked**, and overrides only through the one approvals queue with a
decider-keyed bar and the mint executing inside the decision's transaction. IdP-group-derived
assignments bypass the gate by design and surface as violations (recorded). Gateway **2302
passing + 9 MinIO skips / 140 files**, Playwright **120/120**. Then **L24**
([ADR-0092](../docs/decisions/0092-access-recommendations.md), migration 0094 — one CHECK
widening; recommendations themselves store nothing): access recommendations as **queries with
reasons** — six frozen v1 rules (unused-grant, never-signed-in-holder, orphaned/retired-agent
grants, overreach, sod-violation), every result carrying hand-checkable evidence and a
concrete action ref, nothing auto-executing; the only action path is a `from_recommendations`
certification-campaign scope whose snapshot is exactly the currently-flagged grants (recommend
→ human review → revoke-is-real, proven end-to-end). Verification falsified a brief premise
(M-010): `usage_events` meters every governed call unconditionally, so unused-grant reads
metering — tracing gates only agent-attribution; `not_assessable` fires where genuinely true.
The model-judged half stays L6-blocked and unapproximated. Gateway **2321 passing + 9 MinIO
skips / 141 files**, shared **728**, Playwright **121/121**. **The competitive build queue is
COMPLETE** — Credo L1–L8, four-vendor L10/L12/L14/L15, Saviynt L20–L24, five gap-analysis
docs, ADRs 0076–0092, migrations through 0094. Open owner decisions: L13 assessment AI
pre-fill (collides with ADR-0080's "the answers are yours"); L6 + L24's copilot half (model
credential); L9/L11 (instrument-gated); L19 certification spend. Process note: M-019 logged —
a REPEAT of M-014 (agent parked on a watcher despite the rule in its brief); the rule is
rewritten to make parking impossible (foreground suite runs with explicit timeouts, stated
inside the verification step).

**2026-08-15 — the ten-slice feature review is CLOSED and the market-analysis build queue is
under way.** Every pillar was driven end-to-end and attacked with probes written to fail if
enforcement regressed. Four governance holes were found live and closed (inert server grant;
the semantic cache as a PII bypass; the self-review guard not surviving a delegation; the
deploy-override with no second party), one ledger-honesty defect fixed (a refused dispatch
claiming pillar-6 savings), and pillar 7's inheritance attacked and found genuinely holding.
Local WORM anchoring (MinIO Object Lock, COMPLIANCE, observed grading) ships in compose by
default; the deployment-wide PII floor closed the attribution dodge; `mistakes.md` is now an
owner-mandated bootstrap read. A fresh market analysis
([MARKET_ANALYSIS_2026-08.md](../docs/product/MARKET_ANALYSIS_2026-08.md)) found the gateway
category absorbed by security vendors and named the **compliance cascade as the single most
defensible claim** — so three queue items shipped against it: the P5 cost-reconciliation +
roster wedge (ADR-0076), the cascade as the demo's headline path plus a cascade-derived
template gallery (ADR-0077), and the tighten-only delegation conformance contract (ADR-0078).
Gateway suite **2108 passing / 126 files**; GitHub Actions are exhausted, so internal
validation on fresh scratch databases is the gate. The queue's top two items (a live model
provider, live-instrument verification) are blocked on credentials the owner keeps parked.

**ADR-0075 shipped, 2026-08-13 — [the regulAIt brand package and the regulAIt UI Structures contract are adopted in the SPA](../docs/decisions/0075-brand-identity-and-ui-structure-adoption.md).
NO MIGRATION — this is presentation only; no schema, no API, no governance semantics.** The owner
supplied two standards, and they settle their own precedence: *"the brand package wins on colour,
type and the mark. This document wins on structure and markup contracts."* A third artefact in the
same archive — an **"Organic" design system** (cream, terracotta, Caprasimo) — is **not adopted**,
and the evidence is decisive rather than a judgement call: it is a generic design-system export with
its own `theme.json` and no product, while UI Structures is titled *"UI structures for regulAIt
apps"*, points at the brand package by name, and is itself rendered in Gantari/Figtree/IBM Plex Mono
over Graphite and Signal Cyan. The two regulAIt artefacts agree; Organic disagrees with both.
`apps/web/src/theme/tokens.css` is rewritten around the `--rg-*` token **names** the contract
specifies (*"Names are the API"*) with **values** from the brand: the twelve-step Graphite ramp,
Signal Cyan 500/400/700, the four product accents, and the four-step severity scale with AA-passing
`-deep` text steps. **The whole palette swapped from one file with zero component edits**, because a
survey found **zero hardcoded hex outside `src/theme/`** — the SPA's pre-existing token discipline
is what made this cheap, and the original names remain as one-directional aliases. Gantari, Figtree
and IBM Plex Mono are **self-hosted** (~90KB; both display faces are variable, so one woff2 each) —
a brand rule that is also an ADR-0062 air-gap requirement, since an off-origin font request would
break air-gapped mode. The sidebar becomes the app's only dark surface and does not invert with the
theme; the mark's AI node is pinned to Signal Cyan; and the brand's forbidden spellings are
corrected in user-visible copy — the wordmark is **`regulAIt`**, and the app had been shipping
"RegulAIt" on every screen. UI Structures' **seven accessibility invariants are now asserted in a
real browser** (`apps/web/e2e/brand-contract.spec.ts`): `main#rgMain` must resolve to a non-zero
box, and the skip link must genuinely be the first tab stop under a real Tab press. That choice is
the point — the doc's own Traps section records a page that returned **200 while rendering its full
markup into a zero-height container**, which any stylesheet assertion would have passed.

**Two process lessons from writing that spec, both worth keeping.** First, **a priming click
invalidates a focus test**: clicking before pressing Tab sets the document's *sequential focus
navigation starting point*, so Tab resumed past the sidebar and the correct skip link "failed" — and
the first fix attempted was a CSS change to markup that was never broken. Second, **a green contract
can be green for the wrong reason**: the wordmark check passed on its first run because the route
list did not cover the pages carrying the offending copy *and* a word-boundary regex let
"RegulAIt-LLM" through on a trailing hyphen. Tightening both made it fail on 14 of 15 routes. That
is the same lesson as ADR-0072's three scoring inversions — *check that the test can fail.*

### Previously


**ADR-0074 shipped, 2026-08-09 — [an ordinary admin edit of a versioned rule now changes what is ENFORCED, not only what is DISPLAYED](../docs/decisions/0074-rule-read-model-write-choke-point.md).
NO MIGRATION — every column already existed.** ADR-0073 (below) made the ACTIVE `config_versions`
row the thing that enforces, which demoted the four rule tables to a **read-model**. Its own gap 10
named the consequence and left it open: any writer that mutated a VERSIONED column without minting a
version produced **silent divergence** — the admin saw their edit in the row, in `GET /v1/rules/*`
and in the SPA, and enforcement never moved. **In a governance product that is worse than a
refusal.** Gap 10 also described the defect wrongly, and the amendment on ADR-0073 corrects it: it
said a rule *"edited through the old CRUD surface"*, implying a body-edit route that **has never
existed**. The three `POST /v1/rules/*` routes are pure creates and were never the defect. The real
set was: **`PATCH /v1/rules/:kind/:id/deploy-mode`** — a bare update **through a module-local table
map**, so a `.update(approvalRules)` grep never found it, and one click on the admin rules list;
**`POST /v1/compliance/profiles`**, which is **not a create route** but an `onConflictDoUpdate` on
the UNIQUE `tag`, i.e. the ONLY edit path a compliance profile has, silently under-enforcing PII
mode, MCP defaults, retention, budget ceilings, ADR-0042 guardrail floors and ADR-0068 red-team
gating **at once**; and **`POST /v1/onboarding/compliance-pack`**, the same upsert, which computes
`plan.profile: "update"` in its own dry-run and therefore *knew* it was overwriting. Worse, the
outcome was **non-uniform** — `RULE_BODY_SCHEMAS` make every field optional, so against a partial
active body the write *did* take effect, and the same 200 meant "discarded" on one artifact and
"applied" on another with no way to tell. **The fix is one choke point, not three patches**:
`applyRuleEdit` classifies the patch by field class — selection-only or unversioned artifact → plain
row write (ADR-0073 §2 and invariant 4, byte-identical pre-0073); effective no-op → **mint nothing**
(the onboarding pack is *designed* to be re-run); enforcing change on a versioned artifact → **mint
AND activate**; versions present with none active → **409 refusing the write**, naming the activate
route, because default-deny extends to WRITES. **The load-bearing line**: the body is composed onto
the **ACTIVE BODY**, never onto the row — the row may already be drifted, and minting from it would
promote that drift into an enforcing version, i.e. the fix would ratify the bug. Atomicity is
**structural**: the mint branch never writes the enforcing columns itself, it lets
`activateVersion`'s `writeRuleReadModel` do it — and that write **moved inside the transaction**,
closing a crash window that reproduced the same divergence with no bad writer involved (this also
reorders ADR-0048's agent-prompt read-model write). **Auto-activation bypasses no gate**, answerable
from code: `evaluatePromotion` gates promoting a CANARY; direct activation has never been gated and
`newVersion(activate:true)` is the shipped pattern. **The structural guard, because a point fix does
not close a class**: `rule-write-guard.test.ts` enumerates every drizzle `.insert`/`.update` in every
gateway source — **including writes through a variable**, which is how the worst writer hid — pins
the set against an audited list where every entry states why it is safe, refuses aliased imports and
raw SQL, and pins that only two modules may import `newVersion`. Verified by attack: adding a bare
`db.update(complianceProfiles)` to an unrelated file makes it red. **Because an ordinary edit can now
move a shadow canary's baseline**, ADR-0072's posture is applied to the comparison — a live ADR-0073
read defect fixed on the way: both surfaces aggregated on `candidate_version_id` **alone** while
`active_version_id` was already stored, pooling comparisons against different baselines into one
`diverged` count that fed a promotion decision. Now every aggregate is keyed on **(candidate,
active)**, the stranded set is **reported beside the totals and never folded in**, the ledger records
`the shadow comparison baseline moved here`, and `POST …/promote` **refuses** a mixed-baseline sample
(`canary-promote-stale-baseline`) unless overridden with a reason — **the gate lands on the
PROMOTION, never on the EDIT**, so an incident edit is never blocked by a measurement. A NULL
baseline counts as NOT comparable, because that failure direction matters. Orphaned versions
(`artifact_id` is polymorphic so there is no FK; deleting a user, server, role, team or **approver**
cascades the rule away and leaves an `active` version behind) are now **disclosed** by both read
surfaces instead of rendering as a live governed artifact — deliberately **not** deleted, since they
are the record of what governed the calls made while the rule existed. **Every assertion is a
governed DECISION, never a column** — a test reading the row or the version count would have passed
against the broken code, which is exactly why the defect shipped; with the fix disabled **12 of the
15 new cases fail**. **Verification**: gateway **1,968 → 1,989 tests / 113 → 115 files** on a freshly
created DB with **no existing gateway test rewritten**; shared **579 → 593**; Playwright **86 → 88**,
zero console errors; policy-kernel 129, model-provider 122, infra-provider 174, training-provider 58,
workflow-kernel 39, orchestration-kernel 27, optimizer-kernel 69, pm-provider 62, git-provider 51,
connector-provider 58 all unchanged; `pnpm -r build`, `pnpm -r typecheck`, `pnpm --filter
@regulait/web build` clean. **Disclosed rather than closed** (eleven items in the ADR): **operational
bypasses remain** — a manual `psql`, a `pg_restore` of a pre-versioning backup or an air-gapped
database dump all desynchronise a row with no application code involved, and **nothing in the schema
prevents it**; existing drift is corrected **opportunistically on the next edit**, with no backfill
and **no drift report** naming currently-drifted artifacts; partial version bodies are still
authorable; ADR-0073's **read-side asymmetry stands** — `redteam.ts`, `cost-import.ts`,
`compliance-packs.ts` and `setup-status.ts` read compliance profiles RAW and so fail **OPEN** in the
same state the cascade fails closed; orphans are disclosed, **not tombstoned** (the AFTER DELETE
trigger is its own slice); and the guard is a source scan over the gateway's own sources only.

**ADR-0073 shipped, 2026-08-09 — [the rules engine now reads `config_versions`](../docs/decisions/0073-rules-engine-versioning.md)
(migration 0084). This closes the LONGEST-STANDING DECLARED GAP in the project**, `PENDING.md` §3's
ADR-0048 row: *"the shadow canary for rules evaluates nothing"*. ADR-0048 shipped immutable
versioning/canary/rollback and wired ONE artifact type (`agent_system_prompt`) through the dispatch
core; for `approval_rule`, `rate_limit`, `data_scope_rule` and `compliance_profile` it shipped
**storage only**, and said so in capitals. So activating a rule version changed nothing, **rolling one
back changed nothing** — the gesture an operator reaches for during an incident — and §2's shadow
canary evaluated nothing at all. Now `governedEvaluate` overlays the **ACTIVE** version of every
loaded rule onto its row before the kernel is called, and `projects.ts:profilesForTags` — the ONE
funnel every §8.3 cascade consumer already goes through — does the same for compliance profiles, so
`projectPiiMode`, `projectMcpMode`, the ADR-0042 guardrail floor and the pillar-3 infra floors all
inherit it without learning `config_versions` exists. **Deliberately the same shape as the prompt
path, not a second mechanism**: fall back to the table row when no version rows exist
(byte-identical pre-0073 behaviour), the table row becomes a read-model rewritten by the same
`activateVersion`, and dispatch never trusts it. **The shadow canary genuinely evaluates**: the
served decision is computed to completion FIRST from the active bodies alone, then the candidate runs
through the SAME kernel call parameterised by the candidate bodies **and nothing else**, and both
sides' effect/ruleId/full reason land in `config_canary_observations` — deliberately NOT `audit_log`,
which since ADR-0060 is the hash-chained record of decisions that were SERVED. `canary_pct` is
honoured as a shadow **SAMPLING RATE** on ADR-0048's existing deterministic bucket. **Proved
adversarially in both directions at once**: the ENTIRE served decision object is captured before any
candidate exists and asserted **deep-equal** while a candidate that would PAUSE the call is running,
AND the same run asserts a divergence row naming `allow` vs `require_approval` — a canary that
recorded nothing passes the first and fails the second, one that enforced passes the second and fails
the first. A corrupt candidate written straight into `config_versions` **throws**, the served answer
is byte-identical, and the failure is recorded as `failed` (never as a divergence). Promotion then
genuinely changes the served decision and **rollback restores it end to end**. **Default-deny
survives**: version rows with NO active version are UNRESOLVABLE and DENY
(`config-version-unresolvable`), or a real **409** in the compliance path. Resolution is **ONE
indexed query per evaluation** across all three rule types, not an N+1; ADR-0048 §7's baseline is
applied **lazily** (the first version of a rule mints `v1 (pre-versioning baseline)` from the live
row) rather than by migration backfill. Only **ENFORCING** columns are versionable — a body naming a
SELECTION column (`userId`, `serverId`, `scope`, `tag`) is a real **422** naming what to do instead,
and bodies are **type-checked** so a stored `windowSeconds: "sixty"` cannot activate and then throw
on the SERVED path. **`canaryIsLive` was NOT flipped for rules, deliberately, and this is the one
place the slice brief was not followed**: it is read by `resolveVersion` and means "the canary
SERVES", so flipping it would enforce a candidate deny on a share of real work — the exact outage §2
forbids, and a direct contradiction of the same brief's own invariant. The vocabulary is split
instead: `canaryIsLive` (still false for rules, pinned by a test), `canaryIsEvaluated` (now true for
all four rule types) and `canaryModeOf` → `live | shadow | inert`; `inert` exists because ADR-0048
DECLARED `agent_config` a live-canary type and never wired a resolver, so the API had been answering
"live" about something nothing reads. **The SPA surfaces it**: `/admin/governance/rules` gained a
shadow-canary card listing every running canary with sampled/would-change/failed counts and, per
decision, what was served versus what the candidate would have done including the sentence the caller
would have been given. **Verification**: gateway **1,943 → 1,968 tests / 112 → 113 files** on a
freshly created DB; shared **566 → 579**; the full Playwright suite **82 → 86**, all green with zero console errors; policy-kernel 129, model-provider 122, infra-provider 174,
training-provider 58, workflow-kernel 39, orchestration-kernel 27, pm-provider 62, git-provider 51 all
unchanged; `pnpm -r build`, `pnpm -r typecheck` and `pnpm --filter @regulait/web build` clean.
ADR-0048's test asserting the endpoint said "NOT yet wired" was **REWRITTEN, not deleted**, with a
comment naming what changed. **Disclosed rather than closed** (twelve items in the ADR): **`agent_config`
is still vocabulary-only** and now reports `inert` instead of being mislabelled `live`; the **ordinary
rule-CRUD routes do NOT mint a version**, so a versioned rule edited through the old CRUD surface has
its row and its active version disagree and **dispatch keeps serving the version** — the sharpest
one; a rule canary still never serves, by design; `canary_pct` is capped at 99 by ADR-0048's DB CHECK
so ~1% of keys are never shadowed; the shadow pass is **inline and awaited**; **no pruning** — one
more monotonically-growing table; the **compliance-profile shadow is computed at READ time over the
first 50 tagged projects** (its effect does not vary per request) and is **never stored
historically**; the divergence is **not fed to ADR-0059's blast-radius preview**; and rebinding a
rule to a different subject is a new rule, not a new version.

**The three API-only parity features got a user-facing surface, 2026-08-09 — NO new ADR and NO
migration, deliberately.** The owner's second request was competitor parity and *"maybe we will
release this as a freeware"*. Six parity ADRs shipped, but **three of them disclosed "there is no
SPA page"** — and on a freeware tool a feature nobody can reach without `curl` is, from a user's
point of view, not built. This slice is a UI layer over already-accepted decisions, so it amends
those ADRs with **dated, appended amendments** rather than superseding them; the Accepted text of
0066, 0069, 0071 and 0072 is untouched. **Three pages**: `/admin/virtual-keys` (ADR-0066, nav
*Identity & Access*) issues a key showing the plaintext **exactly once**, never fetches it again,
leads with the ceiling rule (*a key only ever NARROWS* — listing a model does not grant it), and
renders the enforcement counter and the `usage_events` total **apart** so a disagreement would be
visible; `/admin/cost-consolidation` (ADR-0069, nav *Cost*) uploads/pastes an export, prints each
adapter's `limits` **verbatim from the registry**, dry-runs with **rows accepted vs refused and
every refusal's file line number**, applies, and carries the identity-mapping surface and the
consolidated per-person/per-cost-centre view; the shadow-AI page (ADR-0071) gained a **raw-file
import** card printing each adapter's `verification` sentence **verbatim** — including the four
that say outright they have **never been run against a real vendor export** — with the
whole-file-refusal default and its opt-out labelled as an opt-out. **The ADR-0069 honesty rule
survived into the layout, which is the point**: `metered` and `imported` render in two
separately-ruled columns and are **never summed**, and the browser spec **computes** each
subject's `metered + imported` from the API's own answer and asserts that number appears nowhere
in the document — so the guarantee cannot quietly stop being tested if seeded spend moves.
ADR-0072's stranded-baseline report is now a card on `/admin/evals` (versions, per-version run
counts labelled comparable/NOT, and every stranded pin by run id with the action); ADR-0067's four
groundedness scorers and its `eval_cases.context` field were **already** authorable and needed no
work — verified in the browser rather than assumed. **Two real bugs were found only by driving a
browser, and both are fixed**: (1) `apps/web/src/api/client.ts` called `.join()` on an
`issues[].path` the gateway had already joined into a **string**, so the TypeError escaped from the
`ApiError` constructor and **every such refusal rendered as a JavaScript error instead of its
reason** — the exact failure the "honest refusals" rule exists to prevent; (2) `RequireAdmin`
**silently bounced** a non-admin to Home, which is a disappearance rather than a refusal — it now
renders a real "you don't have access" statement, with the gateway still refusing independently.
Two CSS classes referenced by ~15 admin screens (`.statRow`, `.grid`) were **never defined**, so
those stat rows had no layout at all; both are now defined once. **Verification**: gateway
**1,943 / 112 files unchanged** (no gateway source touched), shared 566, policy-kernel 129,
model-provider 122, infra-provider 174, training-provider 58 — all unchanged; `pnpm -r build`,
`pnpm -r typecheck` and `pnpm --filter @regulait/web build` clean; the **full Playwright suite is
63 → 82 tests**, all green, with zero console errors and 19 screenshots. **Disclosed rather than
closed**: ADR-0066's **fallback chains still have no page**; adapter configuration is a raw JSON
textarea rather than a per-adapter form builder; the cost page has no bulk cost-centre editor; and
the *adapters have still never met a real vendor export* — the page makes that visible, it does not
make it untrue.

**ADR-0072 shipped, 2026-08-07 — [the two scoring inversions, fixed together with an explicit
baseline reset](../docs/decisions/0072-scoring-semantics-correction.md) (migration 0083, the number
ADR-0071 deliberately left unused).** This is a CORRECTION slice, not a feature slice, and it amends
two **Accepted** ADRs with the owner's explicit approval. Both bugs were the same shape: **the
system recorded an ABSENCE OF MEASUREMENT, or a SUCCESS OF THE DEFENCE, as a bad number** — which
then flowed into an average, a drift comparison, a promotion gate and a compliance artifact.
**(1) ADR-0044 scored an `llm_as_judge` case with NO judge as 0** (`no_judge_configured`). Loud,
which is exactly why ADR-0067 left it alone — but wrong IN KIND: a **missing instrument** recorded
as a **bad measurement**, averaged into `mean_score`, deltaed against a baseline, read by the gate
as "the agent answered badly", and citable as measured evidence by an ADR-0045 model card. It now
takes ADR-0067's posture **exactly** — a real **422** from `judgeAvailabilityFor` placed **before**
the `eval_runs` INSERT, with the suite asserting **no run row, no result row and not one dispatched
token** — and the old score-0 branch is an unreachable **throw**, deliberately not a fallback,
because a fallback to zero is the very thing being removed. **(2) ADR-0057 scored a
guardrail-BLOCKED probe as a DEFEAT**, so **the platform holding looked identical to the platform
failing** — in the per-probe outcome, the class aggregate, the pooled ASR and the gate. ADR-0068
found it, named it on the per-trial row, counted `platform_held`, and declined to fix it because it
would move every stored baseline — while **its own sequence path already scored the same input
correctly**. Both paths now call **one** `classifyDispatchFailure`: a governance stop is a
**platform hold** (resisted, score 1, counted, never an attack success anywhere including the
aggregate ASR); a transport failure is excluded from the ASR **denominator**. The new suite runs
**the same probe text down BOTH paths** against the same agent under the same blocking guardrail and
asserts they agree field by field — an assertion that would have FAILED before this slice.
**The baseline reset is the part that makes this safe, and it is explicit.** Both fixes change what
stored numbers MEAN without changing their SHAPE, which is the most dangerous kind of change a
measurement system can make. Migration 0083 adds `scoring_semantics` to `eval_runs` and
`redteam_runs`; every pre-existing row is stamped **1** by the column DEFAULT and everything after
**2**. **History is MARKED, never rewritten and never deleted**, and `audit_log` is not touched at
all, so ADR-0060's hash chain is unaffected *by construction* rather than by care. Comparison
refuses in **four** places: auto-resolution filters on the column; an explicitly pinned pre-0072
baseline is a **422 before the run row exists**; an admin-pinned stranded baseline **FAILS the gate
and names the run to re-pin** (never silently swapped for another); and pinning a v1 run is refused
with **409 `baseline_semantics_stale`**. Both gates gained `baselineComparable` +
`baselineIncomparableReason`, because `scoreDelta: null` alone cannot distinguish "first run ever"
from "not comparable". **The product REPORTS the reset rather than leaving an operator to discover
it**: `GET /v1/evals/scoring-semantics` returns the changelog, per-version run counts and **exactly
which pinned baselines are stranded, by run id, with the action to take**; the ADR-0044 drift sweep
**PAUSES** a stranded pair with the reason stated instead of spending a model call to reach a
refusal it can predict; the run detail and every ADR-0045 model-card evidence entry carry the
version. **Any baseline pinned before 2026-08-07 must be re-pinned.** Two existing tests were
**REWRITTEN, not deleted**, each carrying a comment naming what changed and why: ADR-0067's
judge-boundary test (which had pinned the asymmetry in both directions and now pins the *unified*
boundary in both directions) and ADR-0044's `no_judge_configured` test. Gateway
**1,926 -> 1,942 tests / 111 -> 112 files**; shared **554 -> 561**; policy-kernel 129,
model-provider 122, infra-provider 174, training-provider 58 unchanged. **Disclosed rather than
closed** (eight items in the ADR): the `eval_results` row for a blocked probe **still stores
`score: 0`** — correct for an ordinary quality suite, since polarity belongs to the red-team layer,
and the adjudication row is the authority; **`classifyDispatchFailure` is a DENY-LIST of transport
codes**, so a future transport code would be mis-read as a platform hold — it fails **towards**
claiming the defence worked, the wrong direction, named rather than hidden; there is **no SPA page**
(API only); nothing re-verifies a judged metric because no provider is connected; `redteam_runs` has
no admin-pinned-baseline concept so its reset is the resolution filter only; the version is global,
not per-dataset; pre-0072 `redteam_probe_trials` rows are not individually marked; and there is **no
down migration**, so rolling the code back with the column in place leaves rows stamped 2 that v1
code produced.

**Slice E of the parity wave shipped, 2026-08-07 — [ADR-0071](../docs/decisions/0071-shadow-ai-format-adapters.md),
shadow-AI evidence format adapters. THE PARITY WAVE IS COMPLETE** — six slices, one ADR each,
dispatched sequentially; see [COMPETITIVE_PARITY_PLAN.md](../docs/product/COMPETITIVE_PARITY_PLAN.md)
§5 for the closing summary and the three things the wave is *not*. **This slice needed NO MIGRATION
and that is a decision, not an omission**: 0083 was budgeted and left unused (it was later claimed
by ADR-0072), because
`shadow_ai_imports.summary` is already `jsonb NOT NULL` and carries the adapter id, the format
basis, the fields actually read, the three row counts and the bounded refusal list — adding four
columns to store what jsonb already stores would be migration cost with no query that needs it
(nothing filters imports by adapter). **The plan's original Slice E paragraph asked for importers
ADR-0055 had ALREADY SHIPPED** — four evidence kinds, dry-run/apply, payload fingerprints, per-row
provenance, forbidden-key screening, correlation, the coverage scorecard — and the paragraph was
corrected in the plan file before the slice started, which is the Slice D mistake caught by grepping
first. **The genuine gap was one layer down**: ADR-0055 accepts rows *already normalised to its zod
schemas*, so a customer had to hand-write the transform — and a hand-written transform is exactly
the ten-minute `split("|")` that works on the first three lines of the sample and mis-parses every
escaped line for ever afterwards. **Five adapters** on ADR-0069's registry playbook: `cef` and
`leef` (published grammars, header `\|` escaping and CEF's `\=` extension escaping honoured),
`w3c_extended` (driven by the file's OWN `#Fields:` directive, honoured again if it is redeclared
mid-file), `proxy_common` (Squid native / NCSA common / combined, with the layout a REQUIRED
operator assertion because those formats carry no header and a mis-sniffed layout reads the
client-IP column as the destination), and `generic_mapped` over CSV *or* JSON producing **all four**
evidence kinds. **An adapter LAYER, not a subsystem, and that is the structural claim**: no new
table, no new evidence kind, and `processEvidenceImport` is now ONE function that both the
row-shaped `POST /v1/shadow-ai/imports` and the new `POST /v1/shadow-ai/imports/raw` end in — the
suite **proves** it by asserting the two routes compute a byte-identical analysis from the same
evidence rather than asserting reuse in prose. Every adapter validates its output against
**ADR-0055's OWN row schemas**, which is what turns a `rows.417.destinationHost` zod path into a
refusal naming **line 418 of the file the operator has open**. **The escapes ARE the slice**:
`CEF:0|Acme\|Corp|…|suser=alice\=admin` parses correctly and the unit suite asserts the naive
`split()` gives a DIFFERENT answer, so a regression to string-splitting fails a test rather than
shipping a confident wrong host; **not one regular expression is evaluated over file content
anywhere** (ADR-0055's NO-REGEX-FROM-DATA rule verbatim — a CEF extension is precisely the
attacker-shaped string that turns a lazy alternation into a ReDoS). **Every line is read or REFUSED
WITH ITS 1-BASED FILE LINE NUMBER, and `onMalformedRow` DEFAULTS to refusing the WHOLE FILE**,
because the one unrecoverable failure for a discovery product is a quietly smaller inventory that
looks complete; `report_and_continue` is the explicit opt-in and still lists every refusal.
An unreadable epoch unit, `07/08/2026`, a W3C token-count mismatch, an NCSA line whose target is a
path (an origin-server log names no destination), a LEEF 2.0 sixth field that is not a delimiter, a
declared `devTimeFormat`, and an ambiguous `host`/`url` header pair each REFUSE with the reason
stated. **Three honesty fields, not one**: `capabilities` + a machine-readable `formatBasis`
(`published-spec` / `declared-format` / `operator-mapped`) + a `verification` sentence + `limits`,
all returned by `GET /v1/shadow-ai/adapters` — and every published-spec adapter says outright that
it **has NOT been run against a real vendor export**, asserted by a test so it cannot be quietly
softened. **No vendor-named preset ships, deliberately** (no `zscaler`, no `okta` — a test asserts
it): ADR-0069 disclosed its declared-header presets as its own biggest gap, a CASB/SSO export has no
published format at all, and the vendor's name is the part a buyer trusts. PII posture is
**ADR-0055's, unchanged and strictly NARROWER** — unmapped fields are discarded, so a CEF `msg` or
`cs1Label` never reaches the database; no ingest scan was added because an evidence row's only PII
is the `sourceIdentity` the feature exists to record. Coverage honesty is preserved verbatim at the
new surface, and emptying the catalogue makes every adapter match nothing (asserted — "detection is
data" had to stay true here too). Gateway **1,907 → 1,926 tests / 110 → 111 files**; shared
**500 → 550**; policy-kernel 129, model-provider 122, infra-provider 174, training-provider 58
unchanged. **Disclosed rather than closed** (thirteen items in the ADR): **nothing has been run
against a real export from any vendor's product** — the biggest gap and the owner's first follow-up;
there is no vendor-named adapter at all; only a FIXED key list is read from CEF/LEEF, so a product
using custom `cs1Label` slots gets every line refused; one record must be one line (no multi-line
reassembly, no gzip, no multipart, 2 MB inline); the 5,000-row bound means a real proxy log must be
chunked or pre-aggregated and each log line counts as ONE request unless the format carries a count;
**re-posting the same file doubles a finding's `observationCount`** because ADR-0055 has no
duplicate-payload 409 (pre-existing, unchanged, now named); a row whose host does not normalise is
still DROPPED-and-counted rather than refused — ADR-0055's contract, left alone exactly as ADR-0067
left `llm_as_judge`, named follow-up; a naive timestamp is read as UTC; a LEEF feed declaring
`devTimeFormat` has EVERY row refused; the log grammars produce `egress_log` only; and there is no
SPA page.

**Slice F of the parity wave shipped, 2026-08-07 — [ADR-0070](../docs/decisions/0070-trace-observability.md)
(migration 0082), trace/span observability.** The premise was **verified by grep before anything was
written** (Slice D's was not, and was half wrong): there was **no trace or span model anywhere in
`schema.ts` and no OpenTelemetry dependency in any package.json**, while every FACT a trace is made
of already existed and was already governed — `orchestration_runs` and its node statuses, the
`usage_events` ledger, the hash-chained `audit_log`, the guardrail/eval/red-team/lineage ledgers.
**The gap was the SHAPE, not the data**: nothing could say *this call happened inside that node,
which happened inside that run; this tool call was asked for by that specific model turn; and the
reason there is no model call under this branch at all is that pillar 1 said no.* That last clause
is the whole slice — **a governance product's most valuable trace is the one that shows why NOTHING
happened**, and no incumbent (Langfuse/Helicone/LangSmith) is positioned to record it because none
of them is the thing that refused. **The recorder WRAPS the one dispatch attempt rather than being
scattered through it, and that is the argument**: `dispatchOnce` became `dispatchAttempt` with a
thin traced wrapper taking its name, so all ~12 of its early returns (virtual-key ceiling, MRM,
project budget, §8.4 PII, ADR-0042 guardrails, both egress refusals, missing credential,
undispatchable agent) land as `denied` spans carrying their stated reason **without the core
mentioning tracing at all** — a thirteenth refusal cannot forget to be traced. The pillar-1
entitlement denial never reaches the core, so it gets its own `policy` span at the invoke route AND
in the compat core; without that, the most common refusal in the product would be the one thing with
no trace. **A span REFERENCES, it does not restate** (`usage_event_id`, `audit_log_id`, `run_id`,
`node_id`, `agent_id`); the only duplication is the five fields a tree must render without an N+1,
copied FROM the ledger row in the same call, with the suite **joining back by `usage_event_id` and
asserting equality** rather than trusting the copy. An ADR-0066 **fallback hop is a CHILD of the
attempt that failed**; an orchestration run is **four real levels** (run → node → model turn → the
tool call that turn made), asserted by parent id and depth against a real run with a real MCP
upstream — a flat list relabelled fails every line. `seq` (not the timestamp) orders siblings,
because millisecond timestamps collide in-process. **Content rides the EXISTING ADR-0042/0044/0065
posture** (already-adjudicated text + truncation + the withheld marker; a refusal ABOUT the input
stores the marker, not the prompt), and **retention rides the §8.3 cascade's audit floor with no new
knob** — one would let an operator keep prompts for a year under a framework that says ninety days.
**Reading a trace is default-deny with a self exception** on ADR-0069's precedent: a non-admin
naming somebody else gets a **403, not a narrowed result set**. Export is the published `gen_ai.*`
OTel conventions over a **hand-rolled OTLP/HTTP JSON encoder** (the SDK rejected — we serialise
stored rows, we do not instrument a live process, and its background exporter assumes opening a
socket is fine), with **no default endpoint anywhere**, a real 409 when none is configured, and the
ADR-0034/0043 egress guard applied at write time AND on every export. **The SPA ships a trace-tree
page at `/admin/traces`** that leads with the traces where governance refused something and prints
each deny reason inline. **Measured**: a 2,000-span tree reads in **42 ms in ONE query**, assembles
in 7 ms, encodes to OTLP in 23 ms; the recorder costs two statements per span (≈400 spans/s).
Gateway **1,889 → 1,907 tests / 109 → 110 files**; shared **480 → 500**; policy-kernel 129,
model-provider 122, infra-provider 174, training-provider 58 unchanged.
**Disclosed rather than closed** (twelve items in the ADR): a lost span is a **hole the API reports**
(`partial: true`) rather than prevents — the recorder never fails the call it traces; **connector
calls, workflow stages and eval-run grouping are DECLARED span kinds with nothing writing them**;
there is **no prompt-playground diffing** (named in the slice's own paragraph, not built); no
sampling and **no per-project tracing policy** (org-wide on/off only); no time-to-first-token
(streaming is traced at completion); the exporter is a **pull with no spooling, no retry and no
already-exported marker**, so an overlapping re-run re-sends; the OTLP **span id is the first 8
bytes** of our uuid (the trace id is exact); a DENY exports as OTel status **ERROR** because OTel's
enum has no member meaning "deliberately refused", so in somebody else's Grafana a refusal looks
like a failure; and **nothing has been verified against a live OTLP collector** (`dryRun: true`
exists so an operator can read the exact body first).

**Slice C of the parity wave shipped, 2026-08-07 — [ADR-0069](../docs/decisions/0069-cross-vendor-cost-consolidation.md)
(migration 0081), cross-vendor cost consolidation. This is THE WEDGE** — the one gap session 07's
research found genuinely unserved by any incumbent, because per-seat SaaS spend is **invoice-side,
not call-side**: every gateway attributes the traffic through it, and nobody consolidates one
human's Claude Code seat + Copilot seat + raw OpenAI key + Bedrock account into a per-person figure
FP&A can charge back. A pre-slice grep confirmed **no importer, no vendor-account→user identity
resolution, and — the load-bearing gap — no `metered` vs `imported` distinction anywhere in the cost
model**; every figure was implicitly metered with nothing to say so. **The blended total does not
exist as a matter of TYPE**: `consolidate()`'s return shape has no field for metered+imported, no
route computes one, and both suites walk the entire response body — every number at every depth,
numbers spelled inside sentences included — asserting the blend appears nowhere (fixtures chosen so
61.11 + 146.30 = 207.41 can arise no other way; a future convenience `total` fails four tests).
**The distinction is a CHECK constraint, not a convention**: imported money lives in its own table
with `basis` pinned to `'imported'` in the database — a column on `usage_events` would have been
less code and was rejected because every existing statement/forecast/budget query reads that table
and one missed `WHERE` puts an unverifiable restated figure inside a customer's invoice.
**Five adapters** on the model-provider/infra-provider playbook (registry + declared capabilities +
an honest `limits` string the API returns): `generic_mapped` (CSV *or* JSON, deliberately the good
one — the long tail is longer than any preset list; header inference **refuses on ambiguity**),
`openai_console`, `anthropic_console`, `aws_cur` and `seat_roster` (the wedge case — and its price
is an **operator assertion**, stamped `derivedFrom` on every line). **Never trust the file**:
character-scanned parsers (no regex over imported text, ADR-0055's rule verbatim), an ambiguous
`07/08/2026` **refused** rather than guessed, an empty amount refused because it is not zero,
`rows_parsed = rows_accepted + rows_refused` as a DB CHECK, and every refusal naming its **file line
number** — the suite parses the same file clean and then corrupted and asserts the corrupt parse
does not simply return less money. **Identity resolution is admin-authored and honest**: alias →
exact email → domain rule → unresolved, in that precedence so a human's correction beats a
mechanical match; ambiguity resolves to NOBODY; an unmatched account stays visible as its own
unattributed subject and is **never spread pro-rata**; every line records HOW it matched and every
correction re-resolves stored lines and audits its blast radius; deleting a user un-attributes their
spend rather than deleting it. **Default-deny both ways** — importing and fleet-wide reads are
admin-only, the single non-admin route refuses unless the caller IS that user. Re-applying identical
bytes is a real **409** (partial unique index); the correction path is revoke-then-reimport, and the
revoked batch row survives. **PII**: the same ADR-0042/0065 ingest path, with the **account column
exempt by construction** — the email IS the join key — disclosed in the code, in every response, on
the registry and in the ADR. Gateway **1859 → 1889 tests / 108 → 109 files**; shared **427 → 477**;
policy-kernel 129, model-provider 122, infra-provider 174, training-provider 58 unchanged.
**Disclosed rather than closed**: the three vendor presets are built against **DECLARED header sets
never verified against a live console** (they refuse naming the missing column rather than
mis-parsing, and `generic_mapped` is the escape hatch — this is the biggest honest gap and the
owner's first follow-up); `aws_cur` reads unblended cost only so a Savings-Plan-heavy account will
not reconcile; **imported figures never enter billing statements, budgets, forecasts, the optimizer
or any enforcement path** (reporting-only, deliberately — we will not block work on a number we
cannot verify); no FX conversion; no invoice-total reconciliation; no cross-chunk dedup for an
operator-split CUR; `users.cost_center` has no history; **no scheduled re-import** (nothing to poll
— the view reports its own staleness instead); and **no SPA page** (API + CSV only, same posture as
ADR-0066).

**Slice B shipped the same day — [ADR-0068](../docs/decisions/0068-redteam-depth.md) (migration
0080), red-team probe-corpus depth**: N-trial runs with a Wilson-interval ASR and per-trial outcomes
stored, an offline versioned corpus v2 across ten attack classes, multi-turn crescendo/many-shot
sequences, and agentic probes whose induced tool/connector call is adjudicated by the **real**
entitlement kernel and never executed. Read its "what this explicitly does NOT give you" before
citing any rate: `trials` defaults to 1 and a one-trial run is labelled `single-trial`, probe
grading is unverified because no provider is connected, and against the deterministic provider N
trials buy a denominator rather than variance. See
[docs/decisions/README.md](../docs/decisions/README.md) for the full row.

**Slice A of the parity wave shipped, 2026-08-07 — [ADR-0067](../docs/decisions/0067-groundedness-evaluation.md)
(migration 0079), groundedness/faithfulness/hallucination measurement.** A pre-slice grep found **no
groundedness, faithfulness, hallucination or claim-attribution metric anywhere in the codebase** —
the one measurement a regulated buyer asks for by name, and one that could not have been added by
configuration because `eval_cases` had nowhere to put the CONTEXT an answer is supposed to rest on.
Migration 0079 adds `eval_cases.context` (an **array**, one entry per retrieved chunk — chunk
boundaries are the metric: a claim stitched out of fragments of three unrelated documents is exactly
the fabrication this catches, and a single blob scores it as supported; there is a test asserting the
stitched claim is refused) plus `context_in_prompt`, which records whether the model SAW the context
or whether it was held back for scoring only. Context is **not a bypass** — when it rides the prompt
it IS the dispatch input and takes the same §8.4 PII and ADR-0042 guardrail path; extracted claims are
slices of `outputText` AFTER the withheld-marker substitution. A case with no context dispatches
byte-identically, so **no existing baseline moved**. **Four metrics that genuinely work offline with
no key** — `claim_support` (IDF-weighted coverage of the single best chunk, failing claims stored
VERBATIM, fabricated FIGURES named and capped below threshold outright), `context_precision`
(retrieval utilisation), `context_recall` (measures the RETRIEVER — high support with low recall is
the signature of a model faithful to context that never held the answer), `answer_relevance` (with an
abstention detector scoring 0 and saying why). **Proved adversarially**: every score assertion is
paired with its opposite over the SAME context and the GAP asserted — end to end through the real
harness a grounded answer scores **1.00** and a same-length same-topic fabricated one **0.00**;
precision 1.00 tight vs 0.20 padded; relevance 0.73 vs 0.00. **The honesty line is the point**:
`groundedness_judge` / `answer_relevance_judge` return a real **422** (`judge_required` /
`judge_not_dispatchable`) from a pure, exhaustively-tested `judgeAvailabilityFor` placed BEFORE the
`eval_runs` insert, and the suite asserts **no run row, no result row, not one dispatched token** —
they never degrade to the lexical proxy under the judged name. The tokenizer was **hoisted** (not
copied) out of `training-provider` into `@regulait/shared`, which now owns the one tokenizer.
Gateway **1,815 → 1,835 tests / 106 → 107 files**; shared **360 → 402**; policy-kernel 129,
model-provider 122, infra-provider 174, training-provider 58 all unchanged. **Disclosed rather than
closed, and several limits are THEMSELVES tests so they cannot silently become untrue**: the lexical
metrics cannot see negation flips (flagged, not scored) or swapped attribution, and score a
synonym-only paraphrase as unsupported (a false positive — the direction that hurts);
`context_precision` is utilisation, not Ragas's rank-aware precision; `answer_relevance` scores a
fluent falsehood HIGH; the judges' JUDGMENT is unverified because no provider is connected (plumbing
proven, instrument not); **ADR-0044's `llm_as_judge` deliberately still scores an unjudgeable case
zero rather than refusing** — unifying it would change an accepted ADR's contract from inside a slice
about a different metric, so it is named follow-up for the owner; and there is no retrieval
integration, no embedding similarity, and no groundedness *reporting* screen (the eval page gained a
context field so the new kinds are authorable, and the model card renders the summary).

**Competitive-parity wave started, 2026-08-07 — ADR-0066 (migration 0078) is Slice D of
[docs/product/COMPETITIVE_PARITY_PLAN.md](../docs/product/COMPETITIVE_PARITY_PLAN.md).** That plan
exists because session 07's research **falsified all three assumed differentiators** (per-user
gateway governance, in-gateway cost attribution, governed SDLC workflow are each already served by
LiteLLM/Portkey/Cloudflare/Helicone/Langfuse); read its §0 before repeating the claim. With RegulAIt
likely to ship as **freeware**, parity gaps are adoption blockers rather than competitive risks,
which is the basis on which the wave is worth doing. **Slice D shipped four things, each designed so
it may only ever NARROW** — the same ceiling shape ADR-0062 used for egress: (1) **`GET /v1/models`**,
the discovery endpoint every off-the-shelf OpenAI client calls at setup and without which a tool
fails *before* the first completion — one route, two envelopes (OpenAI by default, Anthropic when
the SDK's `anthropic-version` header is present), both rendered from one entitlement filter that
runs the **same `evaluateAgent` the dispatch path runs**, so an ungranted model is ABSENT rather
than listed-then-403'd (proved with two users on disjoint grants, neither seeing the other's);
(2) **virtual keys** (`rglv_`, reusing the api_keys sha256 hashing verbatim) carrying an owning
user, optional model allow-list, optional USD budget + spend counter, optional expiry, revocation
and an optional pinned platform credential the holder never sees — `isAdmin` hard-coded **false**
whatever the owner is, and a **default-deny five-route allow-list** that makes minting keys,
editing grants and reading credentials structurally unreachable (plus a by-kind refusal at
`/auth/login-with-key`, since exchanging a virtual key for a session would hand back the identity
it exists to narrow); (3) **per-key model allow-lists enforced at BOTH the compat surfaces and the
native dispatch path**, inside the one `dispatchOnce` core against the SERVED agent *and* at the
entry points against the REQUESTED agent (because `dispatch:false` never reaches the core); and
(4) **provider fallback chains** whose subtle rule is that **a governance DENY is not a failure** —
only a transport/upstream error triggers a hop, entitlement is re-evaluated per hop from scratch
in the same mode, egress posture is re-evaluated per hop because each hop runs the whole core, and
every hop is audited and disclosed. Gateway suite **1,764 → 1,815 tests across 106 files**.
Disclosed rather than closed: no load balancing, no retry/backoff, no per-key budget *period*
(lifetime cap; rotate the key), no per-key rate limits, pinning is platform-credential-only,
fallback is one level deep by construction, `GET /v1/models` is gated on the interception surfaces,
each failed hop bills its own usage row, and there is **no SPA page** for either feature (API-only).

**Note on the two preceding slices, which shipped after this file was last caught up**:
[ADR-0064](../docs/decisions/0064-in-process-scheduler.md) (migration 0076) added the in-process
scheduler that six ADRs' sweeps had been missing, and
[ADR-0065](../docs/decisions/0065-regulait-llm.md) (migration 0077) added RegulAIt-LLM. The
paragraph below still describes the world as of ADR-0063 and has NOT been rewritten; treat
[docs/decisions/README.md](../docs/decisions/README.md) as the authority for anything after 0063.

**RegulAIt is a working, deployed product, not a scaffold.** All eight P0 pillars have shipped
functionality; the gateway suite is at **1,689 tests** across 103 files (policy-kernel 129,
workflow-kernel 39, `packages/shared` 360, model-provider 122); the schema is at **migration
0075**; and **every ADR is now Accepted — 0001 through 0063, with nothing left Proposed**.
**[ADR-0063](../docs/decisions/0063-data-key-custody.md) (migration 0075) closed the top deferred
security item — the `REGULAIT_DATA_KEY` custody gap — without weakening the decision that created
it.** ADR-0035 deliberately keeps the envelope key OUT of the backup, which is correct and
unchanged; what was missing was the procedure around it. The gateway now derives a **non-secret**
fingerprint of the key (`dk1:` + truncated `HMAC-SHA256(key, "regulait/data-key-fingerprint/v1")`),
records it in `data_key_state`, prints it in the boot posture block beside proxy/HSTS/egress, and
writes it into every backup's manifest, S3 object metadata, `RESULT=` line and status file — so a
restore runbook answers *"do I have the right key for this dump?"* from `head-object`, **before**
restoring. On boot it records the fingerprint on first run (probing real stored ciphertext first,
so the very first boot after upgrade cannot record the WRONG key), verifies it thereafter, and
**REFUSES TO START on a mismatch** — the restore-onto-a-new-box case — naming both fingerprints.
Custody itself is an append-only, audited **attestation** whose limit is stated wherever it
appears: it records a human's claim and cannot verify custody; what it buys is that its ABSENCE is
visible on the boot line, in the portal, and in every backup run plus a separate `DataKeyAttested`
metric. Full re-encryption under a new key is **named follow-up scope, deliberately not
half-built**.
**[ADR-0062](../docs/decisions/0062-mode-scoped-egress.md) (migration 0074) closed the last open
finding in [docs/deployment/DATA_BOUNDARY.md](../docs/deployment/DATA_BOUNDARY.md) §4**: the
ADR-0034/0043 egress guard adjudicated only admin-*typed* URLs, so on an air-gapped box a stored
credential — or a bare `ANTHROPIC_API_KEY` — made an agent dispatch attempt the vendor's public API
carrying the prompt, with only the absence of a network route stopping it. A deployment-wide egress
posture is now derived from `REGULAIT_DEPLOY_MODE` (hosted/byoc permissive, `air_gapped` **strict**)
and `org_settings.egressCompiledDefaultPolicy` may only TIGHTEN it — the env, not a portal toggle,
per the ADR-0029 HSTS precedent, because an air-gapped posture a compromised admin could switch off
from a web form is not one. Under a strict posture an adapter that would run on its *compiled*
vendor endpoint is refused before it is constructed, against the same `egress_allow_hosts` table. The entire
enterprise-readiness set (**0036–0061**) was built, verified and merged in one session
(PR #105, `27205e7`) — see
[docs/product/ENTERPRISE_READINESS_PLAN.md](../docs/product/ENTERPRISE_READINESS_PLAN.md) for the
bucketing and [docs/decisions/README.md](../docs/decisions/README.md) for what each one actually
enforces.
**Enterprise identity is real**: SAML 2.0 *and* OIDC federate side by side, SCIM 2.0 provisions
and instantly deprovisions, IdP groups drive roles under default-deny, sessions are individually
revocable inside an admin-defined network envelope, and an in-process Cedar ABAC layer can
conditionally restrict — never widen — any call the RBAC kernel already allowed.
**The governance surface is real too**: a guardrail engine at all three governed entry points, an
eval harness that blocks promotion on regression, model-risk cards with an enforced expiry gate,
a review workbench with per-item-authorized bulk actions, entitlement-scoped executive reporting,
immutable prompt versioning with deterministic canary and rollback, spend forecasting that
refuses to fabricate a number, a lineage graph that hides existence rather than just content,
metering-derived billing, an offline-verified license, a published OpenAPI contract with
drift-detection tests, a resumable onboarding wizard whose import cannot escalate privilege,
shadow-AI discovery, a governance copilot that is itself governed, continuous red-teaming,
compliance packs computed from the real ledgers, policy-simulation blast radius with a proven
zero-dispatch guarantee, a hash-chained tamper-evident audit log, and ChatOps approvals bound to
a real human.
**Two things are deliberately NOT true yet, and are load-bearing caveats** (each recorded in its
ADR's amendment rather than implied away): no model provider is connected, so every
model-dependent claim is mechanism-proven and judgment-unverified; and there is **no in-process
scheduler**, so every "scheduled" sweep is an operator/cron-driven endpoint. The third caveat this
paragraph used to carry — the **air-gapped boundary has a real hole**, because the egress guard
adjudicated only admin-*typed* URLs and a built-in provider still reached its vendor's public API
with the network rather than the application as the backstop — was **closed by ADR-0062**
(migration 0074). It is now code-enforced under `REGULAIT_DEPLOY_MODE=air_gapped`, with the honest
residual (a mis-set env var, an adapter whose default is not statically knowable, and the process-
level surfaces the gateway does not mediate) recorded in `docs/deployment/DATA_BOUNDARY.md` §4.1. The product is served by a **React SPA** (`apps/web` —
React 18 + Vite + react-router + TanStack Query, an owned token design system, light/dark, six
grouped nav sections) at **`/ui`**, which is now the *only* UI: `/`, `/app` and `/admin` all 302
there. The template-literal shells are **deleted** as of ADR-0033 (−7,125 lines): the SPA is not
merely the default UI, it is the only one, and `/legacy/*` serves nothing.
Humans authenticate with **real auth** — scrypt passwords, revocable server-side sessions
(HttpOnly/SameSite cookies + a CSRF header), audited lockout, TOTP MFA, and OIDC SSO with PKCE and
default-deny JIT provisioning (ADR-0025); API keys remain the programmatic/IDE credential.
**IDE interception** ships as provider-shaped translation shims (`/v1/messages`,
`/v1/chat/completions`) over the one governed dispatch core, admin-gated and off by default
(ADR-0020/0024). Everything runs on the dev EC2 box, now over **real HTTPS** at
**`https://3-229-246-126.sslip.io`** — a browser-trusted Let's Encrypt certificate terminated by
Caddy on-box, at zero AWS cost (ADR-0029). Still **dev-grade, explicitly NOT production**. The
box **powers itself off outside 08:00–20:00 Mon–Fri America/New_York** (ADR-0032) on an Elastic
IP, so the address — and therefore the URL and its certificate — survives the cycle. **CI is
live again** on a 2,000 min/month budget.
**What is NOT done**: no real model provider is connected (the owner's key is parked and must not
be raised until they raise it), and the deployment is a single EC2 box with Postgres in a
container volume — now with a **nightly verified `pg_dump` to S3** (ADR-0035, applied and proven
by a real restore), so the largest remaining risks are the single point of failure itself and the
fact that `REGULAIT_DATA_KEY` is not recorded out-of-band (a restore onto a new box recovers every
row and leaves every credential undecryptable). Both are tracked in
[docs/ops/DEPLOYMENT_READINESS_CHECKLIST.md](../docs/ops/DEPLOYMENT_READINESS_CHECKLIST.md).

The infrastructure bootstrap phase (EPIC-01) is **complete**. The private GitHub repo
[dhruvmahendrapatel/RegulAIt](https://github.com/dhruvmahendrapatel/RegulAIt) is live with the
full scaffold. AWS is a two-account Organization (Management `913436627353` / Workload
`regulait-dev` `517506432475`), IAM Identity Center only (no long-lived keys), and the full
security baseline — org-wide CloudTrail, GuardDuty, Security Hub (FSBP + CIS standards), AWS
Config with a cross-account aggregator, account-level S3 Block Public Access, a $5/month Budget,
3 SCPs, and all three permission sets (`Admin-BreakGlass`, `Deploy-Builder`, `ReadOnly-Audit`) —
is applied via Terraform (`terraform plan` reports zero drift). The `github-oidc-role` module is
authored but intentionally not wired into `main.tf` yet — no workload exists to deploy.
Full narrative, including two real incidents worth reading before touching this infra again, is
in `sessions/2026-07-21-session-01.md`.

**Product scope escalated twice more, 2026-07-24: now eight co-equal P0 pillars, not two.**
ADR-0007 (six pillars) added infra-ops/compliance-cascade/deployment-model, Shared Projects, and
a cost-per-project dashboard to
[GOVERNANCE_LAYER_SPEC.md](../docs/product/GOVERNANCE_LAYER_SPEC.md) (now §8–§10), and escalated
token/cost optimization to full P0 pillar in
[TOKEN_OPTIMIZATION_SPEC.md](../docs/product/TOKEN_OPTIMIZATION_SPEC.md). ADR-0008 (eight
pillars) added two more, each in its own new spec doc:
[MULTI_AGENT_ORCHESTRATION_SPEC.md](../docs/product/MULTI_AGENT_ORCHESTRATION_SPEC.md) (pillar
7 — PM→Team-Lead→Worker delegation, task-graph DAG, entitlement inheritance never escalation,
per-run budget caps) and
[PM_TOOL_INTEGRATION_SPEC.md](../docs/product/PM_TOOL_INTEGRATION_SPEC.md) (pillar 8 —
Azure DevOps/Jira/etc. as the system of record, not a shadow copy). `CLAUDE.md` and `VISION.md`
updated to list all eight. **No AWS/Terraform infrastructure change was needed for either
escalation** — nothing is deployed yet (EPIC-02 through EPIC-06 haven't started), so both were
spec-only updates.

**EPIC-02 started, 2026-07-24 (session 02).** Stack chosen and recorded as ADR-0009 (TypeScript
end-to-end: Fastify + official MCP SDK planned, hand-rolled pure policy kernel, Postgres +
Drizzle, pnpm monorepo). First vertical slice of MCP-server governance is **built and green**
(21 tests: 13 kernel unit, 8 gateway integration against Postgres 16): `packages/policy-kernel`
(default-deny, per-user×server×tool allow-lists, read-only-all server grants, typed
`Decision {effect, ruleId, ruleChain, reason}`), `packages/db` (schema + first migration:
users/mcp_servers/mcp_tools/tool_grants/server_grants/audit_log — audit rows deliberately have
no FKs so they survive deletions), `packages/shared` (zod schemas), `apps/gateway` (Fastify:
admin CRUD, `/v1/evaluate` writes an audit row for every decision, visible-tools endpoint
implements §3's visibility filtering). Work is on branch `claude/status-check-2gbrwf` (draft PR).
**Not yet in the slice**: initiatives object type, admin portal.

**Review fixes + git-provider abstraction (PR #10).** The PR #8/#9 adversarial reviews'
confirmed findings are fixed (2 critical: stage-scoped approval events kill cross-stage
approval forgery; transactional FOR-UPDATE event application kills decision races; plus
supersede-all on re-open/deny/abort, merge-conflict-throwing template merge, approver
validation at template creation, declared-modes enforcement, ceiling-preserving partial
agent-policy upsert, revocable agent/connector grants). Then `git_operation` became a real
executable stage type: new `packages/git-provider` (provider-neutral interface; GitHub REST
adapter with injectable fetch; in-memory mock for tests/air-gapped dev; GitLab/Bitbucket/ADO
interface-ready but explicitly rejected until implemented), `git_connections` with
AES-256-GCM-encrypted tokens (REGULAIT_DATA_KEY; storage refused without it, migration 0009),
and a gateway executor: create_branch → open_pr (body auto-linked to the signed-off
requirements artifact, §2 stage 7) → merge (configured strategy) with results in
instance.context, failures retryable via /advance, everything audited.

**Real model dispatch, 2026-07-25 — the estimates-to-actuals unblocker.** New
`packages/model-provider` on the git/pm-provider playbook: neutral `ModelProvider` interface
(`dispatch(model, input, …) → {outputText, stopReason, refusal, usage}`), an Anthropic adapter
on the official `@anthropic-ai/sdk` (injectable fetch — unit tests never touch the network;
`stop_reason: "refusal"` handled explicitly: refused content is NEVER surfaced as an answer),
an in-memory mock (input `<<refuse>>` triggers the refusal path for e2e tests), and a registry
that rejects openai/google/xai until implemented. Placement is the whole point: dispatch runs
strictly AFTER governance and AFTER routing in `/v1/agents/:id/invoke` (`dispatch: true`) — the
provider package is handed the served model id as an input and never picks one, so widening
entitlement is structurally impossible. Config problems fail explicit (409
`agent_not_dispatchable` / `no_model_credential`), never fall back to a different model.
Migration 0016: `agents.model` (provider-native id; null = decision-only),
`model_credentials` (one per provider, AES-256-GCM under REGULAIT_DATA_KEY, write-only API —
never returned), and `usage_events` — pillar 5's MEASURED actual-spend ledger, deliberately
distinct from estimate-based `cost_events`: provider-reported token counts × the served agent's
list price (unpriced = null, a measured token count never becomes an invented dollar), plus
`measuredCostSavedUsd` — what the routing baseline would have cost at the SAME measured
volumes — upgrading pillar 6's savings claim from estimated to measured per dispatch.
`GET /v1/usage-events` mirrors the cost-events read surface (admin fleet-wide, non-admins
forced to self; totals include measured spend + measured savings). Every dispatch is audited
(model, stopReason, refusal in the agent audit row). **Second slice: worker-node dispatch —
orchestration runs execute for real.** The dispatch core is extracted as a shared
`executeGovernedDispatch` and `POST /v1/runs/:id/nodes/:nodeId/dispatch` runs a started
(`in_progress`) node's work through it: the node's CURRENT owner is executed exactly as
assigned (no routing at execution time — owner selection already happened, entitlement-checked,
at plan/re-plan/reassign), and §5.1 is re-checked at dispatch time under the INITIATING user —
a grant revoked mid-run stops the worker cold (403, audited). The state machine stays
authoritative: dispatch produces output (returned + recorded as a `node_dispatched` entry in
the run's append-only history, truncated), it never moves the node; a worker refusal is
surfaced honestly and the node does not advance. §5.2 gains MEASURED enforcement alongside the
estimate-based node-start gate: `budget.measuredSpentUsd` accumulates real dispatch cost; the
first cap crossing is allowed (measured cost is only knowable after the call) but escalates
immediately into the one approvals queue (`__budget__:<node>`, audited require_approval), and
every dispatch after it is blocked (409) until the named approver sanctions the overage.
usage_events rows carry `{runId, nodeId}` attribution. **Third slice: auto-dispatch of ready
nodes.** `POST /v1/runs/:id/auto` is a self-driving pass with the same gates and zero new
authority — one synchronous call (no scheduler/queue, ADR-0010's bias), starting the run if
needed then repeatedly taking the first ready node through the SAME machinery the manual
endpoints use: estimate gate → node_started → governed dispatch (§5.1 re-check per node) →
node_submitted. Review stays a human gate BY DEFAULT — nodes land in_review and dependents
wait; only an explicit `acceptReviews: true` also accepts each submission (audited in the
event history like any acceptance). Node-level problems (entitlement denial, config gap,
worker refusal) mark that node failed/blocked — §3's retry/reassign/escalate applies — and
the pass keeps driving independent branches; run-level problems (estimate or measured budget)
stop the whole pass, with the measured-budget check running BEFORE node start so a blocked
pass never strands a node in_progress. Per-node inputs via `inputs` map (title fallback),
`maxNodes` cap per pass, every pass summarized in one `run-auto-advance` audit row. **Fourth
slice: workflow build-stage nesting (§8 of both EPIC-03 and EPIC-05).** An `automated_build`
stage may carry a `run` config — an orchestration task graph, opaque to the workflow kernel
(the GATEWAY validates it with the orchestration kernel at template creation, plus the graph's
escalation approver — fail-fast, a template never promises a graph the engine can't run). The
stage then executes via the same `awaiting_execution`/`execute_stage` machinery as git stages:
the executor spawns a nested run through the same `planRun` the runs API uses, planned under
the **workflow initiator's** entitlements (a workflow can never launch a run its human
couldn't; an unentitled graph fails the stage explicitly with the plan rejection in
`context.lastError`, retryable via /advance once granted). The nested run is a first-class
run — visible at `/v1/runs/:id`, bound via `workflow_instance_id` (waiting since migration
0011), driven manually or by `/auto` — and the run-event funnel notifies the parent when it
turns terminal: completed → `execution_succeeded` (flowing straight into downstream stages),
aborted → `execution_failed` with the stage retryable (retry spawns a FRESH run; a live or
completed run is never duplicated — idempotent like branch creation). The kernel forbids
human-triggering a build-with-run stage — no bypassing the governed execution. **Fifth slice:
signed-off artifacts in nested-run worker prompts — §2's scope-lock made real.** When a
dispatched node belongs to a workflow-bound run, `buildNestedRunContext` injects the
workflow's SIGNED-OFF artifacts as the model's system context ("execute strictly within the
signed-off requirements below; do not expand scope") — the build executes against exactly
what was approved, never a re-imagined version. The build stage's `scope` narrows the context
to that one artifact; without it, the latest version of every artifact is included; artifact
edits re-open the workflow upstream, so a re-run always carries the re-signed version. §6
traceability: the exact `{output, version}` list that framed each execution is recorded in
the `node_dispatched` history entry. Standalone (non-workflow) runs stay system-free —
verified down to the provider call via the shared mock's dispatch log. **Sixth slice:
per-user model credentials (BYO key).** Migration 0017: `user_model_credentials` (unique per
user×provider, AES-256-GCM, write-only like every credential surface). Self-service
`POST/GET/DELETE /v1/users/:id/model-credentials` (self or admin; other users' credentials
are 403-invisible). Dispatch resolution order: the BILLING user's own credential → platform
`model_credentials` → explicit `no_model_credential` failure; the ledger records
`credentialSource` (user|platform|none) on every usage event and in the dispatch response —
spend on a user's key is visibly not platform spend. Verified end-to-end against a local fake
Anthropic Messages server: the real adapter's actual `x-api-key` header carries the user's
key when one exists, falls back to the platform key when deleted, and precedence is restored
on re-add. Not yet: streaming, multi-turn dispatch, openai/google/xai adapters.

**Pillar 5 lands — per-project cost dashboard rollup, 2026-07-25.** Migration 0018: a minimal
`projects` entity (name, cost-center for chargeback, budget + named budget approver, overage
flag — membership/sharing semantics deliberately deferred to pillar 4's Shared Projects; until
then any authenticated caller may attribute, noted) plus FK-free `project_id` attribution
columns on BOTH ledgers (cost_events estimates, usage_events actuals) and on
runs/instances/approvals. **Attribution at the point of every gateway call**, exactly as the
pillar demands: `projectId` on direct invokes (validated at entry), on run creation (every
node dispatch bills to the run's project), and on workflow instances (nested runs inherit it —
the whole Intake→build chain bills to one project). **Budget enforcement in the dispatch
core**: measured spend at/over budget blocks further attributed dispatches (409) with the
first crossing allowed-but-escalated into the ONE approvals queue (objectType "project",
`__project_budget__`, named budget approver); the decide endpoint's approve lifts enforcement
(audited), deny keeps it. **The dashboard**: `GET /v1/projects/:id/costs` (admin FinOps
surface) — measured totals + tokens + measured savings, showback breakdowns by user and by
agent/model, estimated-savings-by-technique from cost_events, budget-vs-actual
(remaining/overBudget/overageApproved), and a labeled last-7-days run-rate forecast to end of
month; `GET /v1/projects` lists per-project spend fleet-wide. Not yet: MCP-proxy cost-event
attribution, per-project (rather than global) overage windows.

**Pillar 4 lands — Shared Projects MVP, 2026-07-25 (ADR-0011).** Shared-Project semantics
extend the ONE `projects` entity (no second container): migration 0019 adds `teams` +
`team_members`, `project_members` (per-user Owner/Contributor/Viewer, decoupled from
home-team role, optional contributing team validated against real team membership), an
append-only `project_context_items` store, and `projects.arbiter_user_id`. **The context
store is §9.2 literally**: every write is a new revision with provenance (user, team,
timestamp, optional source artifact); the current value of a key is its highest ACCEPTED
revision; once a key exists a write must name the accepted `baseRevision` it is based on
(409 otherwise — read-before-write is explicit, never a silent overwrite); a stale-base
write is RETAINED but not accepted and routes to the project's named arbiter through the ONE
approvals queue (`__context_conflict__:<itemId>`); approve makes it the new current value,
deny keeps it retained-but-never-current — every side of every conflict is a permanent row.
An arbiter-less project rejects conflicting writes explicitly (422). **Promotion (§9.4)**:
`POST .../context/promote` copies a workflow artifact into shared context (key = output,
`sourceArtifactId` provenance) — only the artifact's own instance initiator may promote.
**§9.3 honored precisely**: membership widens context visibility and attribution ONLY — a
contributor with no agent grant still hits default-deny (tested); and per ADR-0011, once a
project has members, only members/admins may attribute spend/runs/instances to it (memberless
projects stay open pillar-5 buckets). Everything audited as objectType "project". Deferred:
cross-team cost rollup views (§9.5), §9.4's suggested UI, SCIM team sync.

**Pillar 3's centerpiece lands — the §8.3 compliance-classification cascade, 2026-07-25.**
Classifications are multi-valued FRAMEWORK tags (hipaa/pci-dss/soc2/custom — the spec defines
no strictness ordering among frameworks, so nothing invents one) on the one `projects` entity
(migration 0020, plus `teams.default_classifications` and admin-editable
`compliance_profiles` — the entire cascade expressed as data, per-tag: required workflow
templates, MCP default mode, audit-retention days, PII mode; policy-as-code via API, §5/§8.5).
Profiles compose ADDITIVELY: template unions, mcp tightens to read_only if any says so,
retention takes the max, pii takes the strictest of the three defined modes (block>warn>log —
an ordering the spec does define). **The workflow dimension is ENFORCED**: at instance
creation a classified project's required templates union into the matched set ("no manual
per-control setup") and can FORCE a workflow when no assignment rule matches — the §4
strictest-wins merge carries every added sign-off stage; the admin explicit-template escape
hatch cannot skip it. **The other three dimensions are declared, honestly**:
`GET /v1/projects/:id/compliance` returns the effective policy with per-dimension enforcement
labels (`enforced-at-instance-creation` vs `declared-not-enforced`) — the estimationBasis
discipline applied to compliance. **Reclassification is diff-then-approve** (the spec's most
concrete behavior): first classification applies directly (audited); any CHANGE computes the
before/after effective-policy diff, pends in `pending_classifications`, and opens a
`__reclassification__` approval for a named reviewer through the ONE queue — approve commits,
deny discards, never silent. **§9.3 precedence**: a member team whose default classifications
aren't covered by the project's is surfaced at member-add (response + audit row,
`governing: "project"`), never silently resolved. Deferred: enforcement points for
mcp-default/retention/pii (detector + pruning jobs), reapply-to-in-flight on reclassification
(diff covers the policy; in-flight instances keep their merged definitions), per-framework
cost-governance policies (§8.6→§10.3).

**Demo-readiness sweep — the product becomes CLIENT-PRESENTABLE, 2026-07-25.** After the user
tested the deployed stack ("UI looks okay, functionality still looks incomplete"), a 15-agent
audit produced 126 verified gaps with one diagnosis: ~98 REST routes behind eight working
kernels, but the UIs called only 11/22 of them, the seed created no integrations, and nothing
could be *created* from a browser. Seven slices fixed this (commits 94bfb5f, d012f01, 198704e,
plus the fix pass): (1) the seed now populates every object type with real dispatched spend;
(2) credential/key layer — platform + BYO model credentials, one-time API-key reveal, agent-
policy editor, zero raw-UUID inputs; (3) closed approval loop — approver reads, inline
artifact previews, decision reasons, audited admin override; (4) New Run form (canned DAG
templates + advanced JSON), per-node instructions, project create/PATCH, teams; (5) full
pillar-4 write surface — context editor with baseRevision contract, history, promote,
conflict arbitration with both texts; (6) pillar-2 admin home + seeded 10-stage pipeline
(intake→…→sign-off→nested build→checks→branch→mock PR→merge gate→merge) drivable end-to-end;
(7) pillars 5/6/8 in /app — spend page, DAG SVG with elapsed/abort/reassign/escalate, honest
stop reasons, true parallel waves, PM strip + connections tab. The mock provider now returns
intent-shaped tier-differentiated replies (echo bot dead); orchestration routing respects
credential dispatchability. A three-persona headless-Chromium drive (~50 screenshots) and a
fresh-eyes judge returned "demo-ready-with-caveats" with 6 must-fixes — all fixed and
re-verified live (atomic decide + superseded stale approvals, PM mirror upsert + honest sync
+ orphan handling, compact approvals queue with friendly labels, zero console errors on
approver cross-reads, names instead of UUIDs in human-facing strings, self-review guard with
mandatory reason). Suite: 293 → **365 tests**, all green.

**First AWS deployment — the dev demo stack is LIVE, 2026-07-25 (ADR-0013).** The user
explicitly requested an AWS deployment for hands-on testing (cannot run locally); explicit
sign-off obtained in-session via an IAM Identity Center device-code login (Admin-BreakGlass,
workload account). New reusable module `infra/modules/app-instance` (single AL2023 EC2 box,
IMDSv2-only, SSM Session Manager access with NO ssh keypair, pulls a source tarball from a
module-owned private S3 bucket, `docker compose up -d --build` with per-deploy random
runtime config) composed into `infra/environments/regulait-dev-app` — its own state key
(`regulait-dev-app/terraform.tfstate`) so app deploys can never re-plan the org/security
baseline. Applied: instance `i-013c62adc887c76bb`, `http://3.237.199.248:3000` (/app +
/admin verified 200 through the public IP; seed keys handed to the user in-chat, never
committed). Dev-grade by declaration: HTTP only, port open to the world but everything
key-gated, demo data, ~$15–30/mo (will trip the $5 foundation budget alert — expected).
Teardown = `terraform destroy` in `regulait-dev-app`. NOT production; anything beyond demo
use needs a new decision + explicit sign-off. Operational notes: registry.terraform.io is
blocked from the remote dev container — providers install via a filesystem mirror fed from
releases.hashicorp.com (see session log); Terraform runs with the `regulait-admin` SSO
profile, state backend via `regulait-management`.

**The product becomes USABLE, 2026-07-25 — four slices in one push.** (1) Quickstart
plumbing: the gateway converges its schema on boot; `GET /v1/me`; own-scoped list views for
non-admins (runs/instances = own, projects = memberships); an idempotent demo seed driven
through the real HTTP API (three users with keys printed once, seven agents — three mock ones
usable with zero external keys — templates, hipaa profile, budgeted + classified projects, a
planned run, and an instance already awaiting sign-off). (2) `/app`, the end-user workspace:
one dependency-free file on a new shared design system (`ui-theme.ts` — warm dark, terracotta
accent, mono-for-data): a streaming Playground where every exchange shows routing, measured
cost, model, BYO-key, budget alerts, refusals + a collapsible governance trace; Runs with live
node states, per-node outputs, auto-advance, budget bars; Workflows with the stage rail,
artifact submission, and nested-run links; the approver Inbox (all approval kinds, one-click
decide); member Projects with shared context. (3) `/admin` rebuilt on the same system with a
real Cost & Projects dashboard (stat tiles, budget gauge, hand-rolled SVG showback/savings
charts). (4) Docker quickstart: Dockerfile + compose (Postgres + gateway + auto-migrate +
demo seed; keys in the container log) + README for both paths. The whole surface was driven
in a REAL headless-Chromium pass (sign-in, streamed reply, run auto-advanced to completion,
workflow rail, inbox approve, admin charts — zero page errors). (AWS deployment followed
the same day at the user's explicit request — see the entry above / ADR-0013.)

**Admin portal MVP, 2026-07-25 (ADR-0012).** One dependency-free HTML+JS file served by the
gateway at `GET /admin` — an auth-exempt STATIC SHELL (zero data, zero secrets; the admin
pastes an API key held in memory only) that is strictly a client of the public REST API, so
§5's policy-as-code parity holds by construction: the portal can be deleted without losing
any capability, and no state is UI-only. Tabs are §6's eight functional surfaces VERBATIM
(Users & Roles with the revocation/override layer, Agent Governance with enable toggles +
per-user entitlement views, Connector Governance, MCP Server Governance with the
auto-discovered tool inventory, Policy & Rules Engine over all three rule types, Audit &
Activity Log, the ONE Approvals Queue with inline decide, Simulation / Access preview over
/v1/evaluate) plus the §10.4-mandated Cost & Projects surface (budget-vs-actual + forecast +
showback + savings + compliance view per project). Gaps found while building were fixed as
API endpoints first (GET /v1/users, /v1/servers, /v1/servers/:id/tools, and the three
/v1/rules/* lists — all admin-gated). Deferred (per ADR-0012): SPA rewrite, SCIM/SSO status,
SIEM export, dry-run of UNSAVED policy, bulk actions, CSV export.

**Admin console restructure + roles as a full provisioning bundle, 2026-07-27 (ADR-0014,
migration 0030).** Two gaps closed on user feedback. (1) **Roles now grant agents + connectors**,
not just MCP tools/servers — new `role_agent_grants`/`role_connector_grants` tables (twins of the
per-user grant tables); the kernel folds role-derived grants in additively (`evaluateAgent`
direct-then-role with ceiling/mode still applied; `evaluateConnector` UNION-OF-GRANTS so a narrow
direct grant can't mask a broader role grant), wired into all six evaluate sites; endpoints
POST /v1/roles/:id/grants/{agents,connectors} + four-bucket read-back GET /v1/roles/:id/grants;
per-user revocation of role-derived agent/connector grants deferred (revocations are MCP-only).
ADR-0014 records the additive UNION-MAX semantics. (2) **The portal's flat 13-tab list became 6
grouped sections** (Identity & Access / AI Governance / Policy / Delivery / Cost / Operations); the
overloaded "Users & Roles" tab split into **Users / Roles / Teams**; deep-linking via
`location.hash` (reload keeps the page); the Roles page gained the **role-grants UI** (pick a role →
grant agents/connectors/MCP tools/servers → see the bundle) — the previously-missing "what does
this role grant" surface. UX pass (shared helpers): toast feedback replacing all alert()s +
submit-disable in `wire()`, confirm() on destructive actions, a mobile hamburger drawer (nav no
longer vanishes <900px), `field()` label/aria association, and a contrast bump. Verified on a fresh
DB (build + check-ui-syntax + gateway 297/297 + kernel 82/82) and a Playwright browser drive
(screenshots). Deferred UX follow-ups: table sorting/filter/pagination, human column labels,
raw-JSON operator views, full a11y/contrast sweep.

**Streaming dispatch, 2026-07-25.** Two layers, same gates. Provider layer: `dispatch()`
gains an `onText` delta callback; the Anthropic adapter uses the SDK's streaming API whenever
a caller wants deltas OR `maxTokens` exceeds 16k (long generations must not ride a single
request timeout), with `finalMessage()` returning the SAME complete result — accounting and
refusal handling identical to non-streaming (unit-tested against a faked Anthropic SSE body
through the injectable fetch: real SDK parse path, no network). The mock chunks its echo
deterministically so streaming is testable end-to-end. Gateway layer:
`/v1/agents/:id/invoke` accepts `stream: true` with `dispatch: true` — governance and routing
decide BEFORE any stream opens (denials remain plain JSON 403), then the response hijacks to
SSE: `delta` events as text arrives, one `result` event carrying exactly the JSON path's
payload, `error` events for post-headers failures. The audit row (flagged `stream: true`) and
measured usage ledger are written identically to the JSON path — streaming changes delivery,
never governance or accounting. Deferred: streaming for worker-node/auto dispatch (runs are
backend-driven, no client watching), multi-turn conversations.

**OpenAI model adapter, 2026-07-25 — the provider-agnostic principle made real at the model
layer.** `OpenAiProvider` in model-provider on the same playbook as the Anthropic adapter:
official `openai` SDK (v6) with injectable fetch, chat.completions with
`max_completion_tokens`, finish-reason mapping (stop/length/content_filter →
end_turn/max_tokens/refusal), `message.refusal` honored — a refusal's content is never
surfaced, matching the Anthropic discipline exactly — and streaming via `stream_options:
{include_usage: true}` feeding the same `onText` callback with the same complete-result
return. The registry now resolves anthropic + openai (apiKey required for both); google/xai
stay explicitly rejected. ZERO gateway changes were needed: credentials (platform + BYO-key),
routing, budgets, attribution, and streaming all already key off the provider string — the
e2e proves a `provider: "openai"` agent rides the whole governed pipeline against a local
fake chat.completions server (real adapter, correct Bearer key on the wire, measured usage
ledgered). **Google (Gemini) adapter, same day**: raw injectable
fetch — DELIBERATELY not the unified `@google/genai` SDK, which exposes no fetch injection
(untestable network code loses to plain REST; the git/pm adapters set the precedent) —
`generateContent`/`streamGenerateContent?alt=sse` with `x-goog-api-key` auth, incremental SSE
parsing feeding the same `onText` contract, finishReason mapping (STOP/MAX_TOKENS/SAFETY
family → end_turn/max_tokens/refusal) plus `promptFeedback.blockReason` → refusal (input
blocks and output filters both suppress content — same discipline). Registry now resolves
anthropic + openai + google; only xai stays rejected. Zero gateway changes again — e2e rides
a `provider: "google"` agent through the full pipeline against a local fake Gemini server
(correct header key + path on the wire, measured usage ledgered). **xAI adapter, same day — the registry is
complete.** Grok speaks OpenAI-compatible chat completions, so the chat-completions dispatch
core was extracted as a shared function (`dispatchChatCompletions`) and `XaiProvider` is that
core pointed at `https://api.x.ai/v1` by default — same contract, same refusal discipline,
same streaming accounting, provider-labeled errors. **All four real providers (anthropic,
openai, google, xai) + mock now resolve**; the "interface-ready but not implemented"
rejection era is over, and pillar 1's any-vendor routing claim is demonstrated across four
live adapters with zero gateway changes each time. Deferred: OpenAI Responses-API surface,
per-provider tool-use.

**Jira PM adapter, 2026-07-25 — pillar 8 grows its second real tool.** `JiraProvider` in
pm-provider: REST v2 deliberately (v3 forces ADF rich text; plain strings match the mapping
layer), Basic auth with the Jira Cloud `email:api-token` credential convention, injectable
fetch. The Jira-specific insight honored: **states are not settable fields** —
`transitionState` looks up the issue's available workflow transitions and executes the
matching one (by target-state or transition name), failing EXPLICIT with the available list
when the workflow offers no path (mirror failures surface, never fail the run event — the
established rule). `DEFAULT_MAPPINGS.jira` maps title→summary etc.; `blocked` is deliberately
unmapped (Jira's default workflow has no Blocked state — skip, never invent). Registry
resolves azure_devops + jira + mock; linear/asana/monday/generic_webhook stay rejected.
E2e: a run pm-syncs against a live-shaped fake Jira server (run parent + node issues created
with project/issuetype wrappers and Basic auth asserted on the wire) and a node_started event
mirrors through a real GET-transitions → POST-transition sequence. **Linear adapter, same day**: GraphQL-only API
handled natively — `LinearProvider` speaks `api.linear.app/graphql` (overridable) with the
raw api-key Authorization header, resolves the connection's `project` as a Linear TEAM KEY to
an id once (cached), and drives `issueCreate`/`issueUpdate`/`commentCreate`/`issue` queries;
GraphQL `errors` arrays surface as explicit PmProviderErrors. Transitions resolve the TEAM's
workflow states by name (explicit failure listing available states); Linear issues carry no
native type, so the interface's `type` is accepted-and-ignored (documented). Default mapping
maps title/description/priority with Linear's default state names; `blocked` unmapped again.
E2e: pm-sync + node_started mirror against a fake Linear GraphQL server (team resolution,
issueCreate inputs, raw-token auth, and the stateId move all asserted). **Asana adapter,
2026-07-25**: `AsanaProvider` speaks the REST API (`app.asana.com/api/1.0`, overridable,
Bearer PAT auth) with Asana's `{data: ...}` envelope on every request/response; `project` is
an Asana project GID and `type` is accepted-and-ignored (no native work-item types). Asana
has no workflow states — `transitionState` resolves the PROJECT's board sections by name
(exact then case-insensitive) and moves the task via `POST /sections/:gid/addTask`, failing
explicit with the available section list; the separate `completed` flag is deliberately
untouched (a section move is the literal board behaviour). `DEFAULT_MAPPINGS.asana` maps
title→name, status→section, description→notes; `priority` AND `blocked` both unmapped (no
native priority field, no default Blocked section — skip, never invent). getWorkItem reads
section-as-state for the matching project membership and filters stories to real comments.
E2e: pm-sync + node_started against a live-shaped fake Asana server (data envelopes, bearer
token, projects array, section lookup + addTask all asserted on the wire). **monday.com
adapter, same day**: GraphQL-only `MondayProvider` (`api.monday.com/v2`, overridable, raw
API token) surfacing HTTP errors, `errors[]`, AND monday's top-level `error_message` as
PmProviderErrors; `project` is a BOARD id, `type` accepted-and-ignored. Item URLs built as
`${boardUrl}/pulses/${id}` from a once-per-board cached board-url lookup. Transitions live
in the board's default Status COLUMN: settings_str labels parsed (cached per board), matched
exact-then-case-insensitive, applied via change_simple_column_value — explicit failure
listing available labels. `DEFAULT_MAPPINGS.monday` maps title→name, status→status with
statusMap in_progress→"Working on it", done→"Done", and — per-provider reality — blocked→
"Stuck" IS mapped (the default label ships); not_started/in_review/description/priority
deliberately unmapped. Registry: azure_devops + jira + linear + asana + monday + mock;
generic_webhook is now the SOLE rejected kind. E2e: pm-sync + node_started against a fake
monday GraphQL server (raw token, board_id/item_name, columns lookup + change_simple_column_
value with "Working on it" all asserted). **Generic webhook adapter, same day — the
pillar-8 matrix is COMPLETE; no provider kind is rejected anymore** (the registry switch
stays exhaustive so a future kind still forces a compile error). `GenericWebhookProvider`
inverts the vendor pattern: it POSTs RegulAIt's OWN normalized envelope `{event, timestamp,
project, payload}` (work_item.create/update/transition, comment.add, work_item.get — the
outbound mirror of ADR-0010's inbound shape) to a single customer-defined baseUrl (required,
used verbatim). The connection token is a shared secret used ONLY for signing —
`x-regulait-signature: sha256=<hex HMAC-SHA256 of the exact body>`; the token never travels.
Receiver contract: 2xx or explicit provider error; create must return a real {id, url}
(missing id fails explicit, links are never invented); work_item.get returns the item so
Sync-now verification works, and receivers without read-back fail loudly into the existing
orphan flow. `DEFAULT_MAPPINGS.generic_webhook` is the IDENTITY map over all five canonical
states including blocked — nothing invented because the vocabulary is ours. E2e: the fake
receiver verifies the HMAC on every request and asserts the token never travels raw.
**Compliance enforcement — PII mode + audit-retention pruning, 2026-07-26 (pillar 3 polish
1/4; no migration).** The cascade's last two "declared-not-enforced" dimensions become real.
New pure `packages/shared/src/pii.ts` `detectPII` (email / bounded SSN / Luhn-validated CC /
US phone — returns per-category COUNTS ONLY, never the matched substring, §8.4-safe). Wired
into the two PROJECT-ATTRIBUTED dispatch paths (executeGovernedDispatch + connector invoke;
MCP path honestly DEFERRED — it has no projectId): block on INPUT denies pre-call (no cost,
effect deny ruleId pii-blocked); block on OUTPUT bills-and-withholds (usage row written for
honest spend, outputText replaced by a withheld marker); warn proceeds + piiWarning + audit
pii-warned; log records category counts only. No-classification project = byte-identical
no-op. Audit-retention pruner: POST /v1/audit/prune (admin) deletes audit_log rows older than
a GLOBAL floor = max auditRetentionDays across all compliance profiles (longest-floor-wins,
audit_log has no projectId) + GET /v1/audit/retention shows the floor; the /compliance labels
honestly flipped (only claiming model+connector PII, mcp deferred). Suite 552 → 577.
Independently re-verified: build clean, shared pii 17/17, gateway pii e2e + mcp-proxy 158/158.
KNOWN LIMIT: streaming output-block can transiently flash raw text before the result event
overwrites with the withheld marker (input-block — the common vector — is airtight pre-call);
fast-follow = suppress streaming for block-mode projects.

**Pillar 3/4/5 polish batch complete, 2026-07-26 (4 slices, all stacked on PR #29).** Slice 1 =
the compliance-enforcement block just above (PII mode + audit-retention pruning, no migration).
Slice 2 (pillar-4 membership lifecycle, NO migration): PATCH/DELETE project members, owner-gated,
with hard last-owner protection (409); a provenance fix (context authorship now requires a real
authenticated user — bootstrap token 403s instead of being mis-attributed) and a write-race fix
(writeContextRevision read+insert wrapped in a transaction, 23505 caught+retried against the
existing (project,key,revision) unique index). Slice 3 (pillar-5 cost depth, migration 0028):
projects gain budget_period (none|monthly) + alert_threshold_pct + overage_approved_period —
calendar-month (UTC) windowed spend, overage latch scoped to the approved period key (clears on
rollover), non-blocking threshold alert below cap + hard block at 100%, CSV export
(/costs.csv + /usage-events?format=csv, RFC-4180, member-authz). Slice 4 (pillar-5 Initiative
object + cross-team rollups, migration 0029): new `initiatives` table — a FLAT, REPORTING-ONLY
grouping of projects (NOT a governance tier; no initiative-level budget/enforcement in v1) — plus
a nullable `projects.initiative_id` FK (onDelete set null: deleting an initiative orphans children
back to ungrouped, never deletes project rows). Admin-only CRUD /v1/initiatives (deliberately NOT
in NON_ADMIN_ROUTES — a rollup spans projects a non-admin may not be a member of), rolling up
child count + spend. /v1/projects/:id/costs gains a `byTeam` breakdown (spend attributed to the
team each member contributes under IN THIS project via project_members.teamId; null = "(no team)",
never fabricated) and the project's parent `initiative` label (so the member /app can show it
without the admin endpoint). Per-workflow cost_events source documented-as-reserved (comment,
no writer). Suite 552 → 597 across the batch. Each slice independently re-verified on a fresh DB
(build + check-ui-syntax + the relevant security-critical suites); slice 4 final: gateway 284/284
+ policy-kernel 71 + optimizer 31 + orchestration 23 + shared green. CI on PR #29 is
billing-cap-blocked (account-level Actions minutes cap: both jobs instant-fail, 404 logs, empty
output — verified not code); local verification is the gate. The AWS dev stack is on the
pre-polish merged-main build; a redeploy would be needed after PR #29 merges (only on request).

**§8.2 infrastructure-operations layer, 2026-07-26 — pillar 3's last unstarted surface lands
as a GOVERNED-operations layer (migration 0027).** Monitored resources + operational policies
+ inert findings + governed remediation — not a real patcher; a keyless MockInfraProvider
demos the whole detect→propose→approve→remediate spectrum. Migration 0027: infra_resources
(kind control_plane|agent_runtime|cert|backup_target, classifications), infra_policies
(patch cadence, cert-rotation window, backup schedule+retention, drift baseline,
auto_remediate_max_severity — enum low|medium|high, can't hold 'critical'), infra_findings
(drift|cve|cert_expiring|backup_missed × low|medium|high|critical, status open|
remediation_proposed|auto_remediated|remediated|accepted_risk; UNIQUE on
(resource,kind,detail.signature) so re-scan is idempotent); + approvals/audit_log objectType
+= 'infra_operation'; + compliance_profiles gains backup_retention_days + patch_cadence_days.
New packages/infra-provider mirrors connector-provider (scan/remediate interface, mock keyless
+ aws/azure/gcp 501). THE INVARIANT: a finding is an inert report; a remediation is governed.
On scan a finding is AUTO-remediated (no approval, still AUDITED ruleId infra-auto-remediate)
iff policy has an auto ceiling AND severity ≤ ceiling AND severity !== 'critical'; everything
else + ALL critical findings are approval-gated (approvals row objectType infra_operation via
__infra_remediation__ sentinel → the shared /decide txn → applyInfraApprovalDecision calls
provider.remediate on approve / accepted_risk on deny, both audited, all SoD guards for free).
Critical is doubly guarded (ceiling can't be 'critical' + explicit !=='critical'). §8.3
FINALLY ENFORCED: effectiveCompliancePolicy now composes backupRetentionDays (max) +
patchCadenceDays (min); a classified resource's backup floor = max(policy, cascade.backup,
cascade.auditRetentionDays) — consuming the formerly-dead auditRetentionDays — and its patch
ceiling = min(policy, cascade.patch); the /compliance endpoint's "declared-not-enforced"
labels honestly narrowed to only the still-unenforced parts. Admin Operations tab (resources/
policies/scan-now/findings-inbox/posture); app-ui infra approval label; seed 5 resources (one
HIPAA) + a scan producing the auto/open/critical mix. Suite 535 → 552 (10 provider unit + 7
e2e). Independently re-verified: build clean, infra-provider 10/10, infra e2e + mcp-proxy
157/157 (shared decide path regression-free).

**Pillar-1 rule scoping, 2026-07-26 — policy rules gain role/team/fleet scope (migration
0026); the "one row per user per server" gap closed.** All three restriction-rule tables
(approval_rules, rate_limits, data_scope_rules) were hard-bound to one user × one server
(NOT NULL FKs) — a fleet-wide "any write requires approval" was inexpressible. Migration 0026
(identical per table): user_id/server_id → nullable; add role_id/team_id (nullable FKs),
scope ('user'|'role'|'team'|'fleet', default 'user') + server_scope ('server'|'all', default
'server'); raw CHECK constraints enforce the discriminant; existing rows backfill to
scope='user'/server_scope='server' — byte-identical behaviour (all pre-existing single-user
rule tests pass unchanged). The gateway pre-filters rules in SQL by scope-membership —
`(fleet OR user=me OR role∈myRoles OR team∈myTeams) AND (all-servers OR server=this)`
(loadScopeMemberships resolves roleIds+teamIds) — exactly as role GRANTS are already
pre-filtered, keeping the kernel subject-free. THE INVARIANT (proven): all three rule types
run ONLY AFTER the untouched grant check, so a scoped rule can only ADD a deny/require_approval/
cap — it can never move default-deny to allow, and never relax another scope. Most-restrictive-
wins with NO cross-scope override (no exemptions in v1 — that would widen; deferred as a
separate explicit object): data-scope intersects all matching rules, rate-limits keep
independent per-subject counts (tightest denies first, no summing; all-servers rules count
across servers), approval pauses on any scope match. Guard test: a fleet/role restriction
never rescues an ungranted call. Admin Policy & Rules tab gains scope + server-scope selectors
with a swapping target select and legible "fleet"/"role: X"/"team: Y"/"all servers" listing;
seed shows a fleet approval rule + a role-scoped rate limit. Suite 524 → 535 (6 kernel unit +
5 e2e incl. the headline "fleet rule reaches a user with NO user-specific rule"). Independently
re-verified: build clean, policy-kernel 71/71, mcp-proxy 150/150.

**Connector execution layer, 2026-07-26 — pillar 5's connector-cost gap closed (migration
0025).** POST /v1/connectors/:id/invoke now really contacts the target system and meters cost.
New package `packages/connector-provider` mirrors pm-provider: CONNECTOR_PROVIDER_KINDS
(http/webhook/slack/github/jira/snowflake/generic/mock) + isConnectorProviderKind, neutral
`ConnectorProvider.invoke({operation,object?,payload?})→{status,body}`, injectable FetchLike,
GenericHttpConnectorProvider (read→GET, write→POST payload, optional bearer) + Webhook +
keyless MockConnectorProvider; registry exhaustive-switch, mock keyless, generic/http/webhook
need baseUrl, slack/github/jira/snowflake throw 501 (no silent promises). THE INVARIANT: one
allowed call = the existing ONE audit row + exactly ONE usage_events row; denied → 403 no bill,
failed upstream → 502 no bill (mirrors model path); execute+meter strictly inside the allow
branch. Flat pricing: pricePerCallUsd (null = unpriced → null cost, never invented). BACK-COMPAT:
a connector with null providerKind keeps today's governance-only behaviour exactly (decision +
audit, no execution, no cost) — nothing breaks until a connector opts in. Migration 0025:
connectors +provider_kind/base_url/price_per_call_usd (kind stays the free-text CATEGORY); new
connector_credentials (AES-256-GCM, platform-scoped, never returned); UNIFIED LEDGER —
usage_events token/model NOT NULLs relaxed + object_type ('agent' default, backfilled) +
connector_id + operation, so connector spend rides the SAME ledger and the project total +
showback-by-member pick it up automatically. Rollup gains byConnector (byAgent filtered to
object_type='agent', no phantoms); Spend page + per-project drill-down get a "Spend by connector"
card. Seed: snowflake-analytics now mock-kind $0.002/call (executes keyless) + 3 attributed
reads, jira-cloud stays governance-only. Suite 508 → 524 (8 provider unit + 8 e2e).
Independently re-verified: build clean, mcp-proxy 145/145, all 8 connector-execution e2e green,
migration applies on boot. Every governed entry point — model dispatch, MCP tool, connector —
now flows through the one attribution point.

**Team-Lead entitlement-narrowing tier, 2026-07-26 — pillar 7 §5.1 lands; pillar 7 complete
(no migration).** Worker nodes can declare a `leadNodeId` + `allowedAgentIds`/`allowedToolRefs`
delegation subset (ride the graph jsonb like the tool fields). The pure kernel helper
`computeNodeCeiling(graph, nodeId)` walks the lead chain UP and INTERSECTS each ancestor's
allow-sets (null = no constraint at that hop = identity; set∩set; empty = nothing) → a node's
transitive ceiling. policy-kernel: evaluateAgent gains ceilingAgentIds (new rule
`agent-lead-ceiling`), evaluate gains ceilingTools (new rule `lead-ceiling`) — consulted ONLY
on the allow path, so a ceiling can turn an allow into a deny but NEVER rescue an ungranted
call; default-deny preserved; a null ceiling adds no trace entry (flat runs byte-identical).
The INVARIANT (proven, not relabeled): effective = user_grants ∩ lead_chain_ceiling, composing
grandchild ≤ child ≤ lead ≤ initiating user — a worker is denied a tool/agent its INITIATING
USER genuinely holds because a lead excludes it, while a lead-less control node uses it fine.
Grants subject stays run.initiatingUserId at every site; the ceiling is a SEPARATE arg threaded
into evaluateNodeOwner (dispatch + reassign), planRun evalOwner (envelope + budget re-plan
candidate filter — a re-plan won't move a node onto a ceiling-forbidden agent), resolveNode
ToolContext (narrows what the model is even offered), and per-call executeGovernedToolCall (hard
enforcement). Distinct audit ruleId separates "narrowed by lead" from "user not granted" with
zero new logging. Decompose planner drafts optional two-level hierarchies (lead suggests subset,
gateway drops+records anything beyond the caller's own grants, human edits — the New Run editor
gained a per-node Lead select + allowed-agents/tools controls + indented hierarchy render);
mock `<<lead-plan>>` sentinel for keyless demo. Suite 485 → 508 (9 kernel unit + others).
Independently re-verified: build clean, policy-kernel 65/65, orchestration-tools e2e 9/9
including the narrowing cases. **Pillar 7 is now complete** — agents plan (decompose), do
tool-using work (governed loop), and delegate under enforced transitive entitlement ceilings.

**Tool-using multi-turn workers, 2026-07-26 — pillar 7's workers become a governed agentic
loop (no migration).** dispatchRunNode's single model call is now a bounded loop: each turn
one governed dispatch (measured usage row billed to run.projectId) with `tools` + accumulated
tool-history messages; when the model returns stopReason "tool_use", each tool call runs
through the SAME governance path as the MCP proxy — extracted as `executeGovernedToolCall`
(mcp-proxy.ts) and invoked AS run.initiatingUserId, one audit row each, so allow-list/
data-scope/rate-limit/approval self-enforce MID-LOOP across turns (rate limits are audit-log-
derived, so the Nth call is counted for free). Bounded by BOTH node.maxTurns (default 6, cap
20) AND the per-run measured budget checked EVERY turn — a runaway loop halts and escalates a
__budget__ approval into the one queue exactly like a single dispatch; an approval_required
tool breaks the loop leaving the node blocked, never hangs; no privilege increase entering
the loop. Provider contract extended additively (ModelToolDef in, "tool_use" stopReason +
toolCalls out, ModelChatMessage.content widened to text/tool_use/tool_result blocks; byte-
identical when tools absent) — Anthropic + OpenAI-family fully wired, Google best-effort. Mock
gains `<<use-tool:NAME>>` / `<<use-tool-loop:NAME>>` sentinels so the loop is testable keyless
against the real-upstream MCP harness. Node declares toolServers/toolNames/maxTurns in the
graph jsonb (kernel schema extended — NO migration; per-turn/tool trace rides the event jsonb
as node_tool_call). Decompose planning prompt lists the caller's entitled servers+tools so the
lead can assign them; New Run editor gains per-node tool-servers + max-turns controls. Suite
473 → 485 (7 unit + 5 e2e over the real upstream: granted-loop, ungranted-deny-mid-loop,
maxTurns cap, rate-limit-mid-loop, per-turn-budget halt+escalate). Independently re-verified:
build clean, mcp-proxy 137/137 green after the extraction. Deferred (unchanged): Team-Lead
TIER with transitive entitlement narrowing.

**Automatic context compaction, 2026-07-26 — pillar 6 §5 lands (first technique enabled by
the messages array).** Pure decision in optimizer-kernel (planCompaction/compactionSavings;
threshold >1600 est. tokens of model-bound history, last 4 messages always verbatim;
constants — per-user dials deferred pending an agent-policy migration home). Migration 0024:
summary/summary_through_message_id/summary_tokens/compacted_at on conversations — stored
messages NEVER deleted or altered (asserted). The summarizer is one governed dispatch to
the caller's cheapest entitled+dispatchable agent (audit purpose:"compact", billed to the
same project — the visible price of the savings); re-compaction is CUMULATIVE (prior
summary + newer turns, compacted-away turns never re-read); failure fails OPEN (audited
context-compaction-failed-open, full history dispatches, turn succeeds, failOpen in trace);
routingMode "passthrough" disables it (§12 off-switch consistency). Savings = max(0,
omitted − summary) tokens at the served agent's input price, recorded per summary-riding
dispatch under technique context_compaction in the SAME detail shape as model_routing — the
Spend page and admin charts lit up with zero chart changes. /app shows a compaction divider
with the expandable stored summary + badges + trace detail, persisted on replayed threads.
Suite 455 → 473; browser-verified (on-topic continuation through the summary, $0.0044
compaction bar beside model_routing, zero console errors).

**Prompt caching, 2026-07-27 — pillar 6's 4th technique (after routing, compaction, lazy
tool-loading).** NO migration — the `prompt_caching` cost_events enum value already existed.
Pure `planPromptCache` (optimizer-kernel): marks a stable system prefix cacheable once it clears
Anthropic's 1024-token minimum; passthrough is the §12 off switch; estimatedTokensSaved = the full
prefix served from cache per reuse; CACHE_READ_DISCOUNT 0.9 (ephemeral read ≈ 0.1× list, with the
first-call ~1.25× write surcharge acknowledged — the estimate is the labeled STEADY-STATE reuse
saving). model-provider gains an optional `cacheSystem` on the dispatch request: the Anthropic
adapter emits `system` as a text block carrying `cache_control:{type:ephemeral}` when set (plain
string otherwise, byte-identical); OpenAI/xAI/Google are documented no-ops (auto-cache / no
explicit breakpoint). Gateway writes ONE `prompt_caching` cost_events estimate when caching applies
and threads `cacheSystem` through the dispatch path — a pure cost annotation that never changes the
served agent/model/entitlement/budget/output (§12). The cacheable prefix is sourced from a new
optional `system` field on the invoke request body (the `agents` table has no system-prompt column
yet — a stored `agents.systemPrompt` column is the natural future home, deferred to avoid a
migration this slice). Suite 284 → 288 (prompt-caching.test.ts); optimizer 31 → 36, model-provider
57 → 60. No UI change (savings-by-technique chart is technique-generic). Remaining pillar-6
techniques: edit-vs-rewrite, file pre-processing, semantic caching, request batching.

**Edit-vs-rewrite, 2026-07-27 — pillar 6's 5th technique.** NO migration (the `edit_vs_rewrite`
cost_events enum value already existed). Pure kernel: `classifyEditIntent` (edit / rewrite /
unknown keyword heuristic — a REWRITE signal WINS when both appear, so a full rewrite is the safe
non-optimizing default and we never diff on an ambiguous ask) + `planEditVsRewrite` (guard order
mirrors planPromptCache: passthrough → no baseline → non-edit intent → baseline below the
200-token floor → else edit). When the request reads as a targeted edit over a large-enough
baseline, the gateway injects a compact-diff directive into the dispatch `system` and the
caller-supplied baseline (delimited) into the dispatch `input`, so the model returns a small diff
instead of re-emitting the whole file — the OUTPUT saving is real (not just accounting), the same
way prompt caching actually emits `cache_control`. Opt-in via a new `baseline` field on the invoke
body; baseline tokens are folded into the routing estimate BEFORE routeModel (the model must see
the file either way, so routing/budget/cost reflect the real payload); one `edit_vs_rewrite`
cost_events estimate is written, priced at the served agent's OUTPUT list price (saving ≈ baseline
× 0.75 output tokens). Pure cost annotation — never changes the served agent/model/entitlement/
budget/output; passthrough is the off switch. The baseline rides the model input for that one
dispatch only — persisted conversation history keeps the original request, so it never bloats or
re-sends. Suite 288 → 292 (edit-rewrite.test.ts); optimizer 36 → 47. No UI change. Remaining
pillar-6 techniques: file pre-processing, semantic caching, request batching.

**File preprocessing, 2026-07-27 — pillar 6's 6th technique.** NO migration (enum value existed).
Pure `preprocessReference` deterministically shrinks attached reference/file content without
changing meaning (collapse whitespace runs, trim, collapse 3+ blank lines, elide >512-char
base64/data blobs) while PRESERVING fenced code blocks verbatim (idempotent). `planFilePreprocessing`
decides whether to apply (passthrough off-switch; below a 200-token floor or a zero-reduction result
left untouched) and estimates INPUT tokens saved. Gateway: opt-in `referenceContent` invoke field;
reference tokens folded into the routing estimate at the ACTUAL sent size; processed content appended
as a delimited REFERENCE block (coexists with edit-vs-rewrite's baseline in the shared dispatchInput
composition); one file_preprocessing cost_events estimate at the served input price; persistTurns
keeps the original turn so the reference never bloats history. Suite 297 → 302; optimizer 47 → 59.
Remaining pillar-6: semantic caching + request batching (next slice, migration 0031).

**Semantic caching + request batching, 2026-07-27 — pillar 6's 7th & final techniques (migration
0031).** Semantic caching is a REAL opt-in per-(user,agent) exact-match response cache: an
identical (whitespace/case-normalized) single-turn re-ask within a 1h TTL is served straight from
the `semantic_cache` table, skipping the provider entirely — no usage_events, one `semantic_caching`
cost_events row for the whole-call saving. The lookup runs INSIDE the governance allow-gate and is
scoped by BOTH userId AND agentId (with a normalizedInput collision guard), so a user is never served
another user's — or another agent's — cached response (§12); misses store the result (refreshing the
TTL, never caching refusals/empty/PII-withheld). Request batching is an ESTIMATE only: on an
orchestration auto-pass with ≥2 ready nodes on the same model, one `request_batching` cost_events row
books the per-request overhead batching would amortize — dispatch is unchanged (true async
Batches-API batching doesn't fit the synchronous interactive path). Suite 302 → 307; optimizer 59 →
69. **All seven pillar-6 optimization techniques now shipped**: model routing, context compaction,
lazy tool-loading, prompt caching, edit-vs-rewrite, file preprocessing, semantic caching (+ the
request-batching estimator).

**Admin console UX polish, 2026-07-27.** The deferred follow-ups from the console restructure:
`dataTable()` with free-text filter + keyboard-operable sortable headers (aria-sort, numeric-aware)
+ pagination (adopted on Users/Audit/Approvals/Projects/Findings); `humanizeKey` so th labels read
"Cost Center"/"Alert %" not camelCase; raw-JSON operator views replaced with formatted UI
(Simulation decision = effect badge + numbered rule chain, Compliance = badges + kv list, Infra
posture = inline counts, each with raw behind a `<details>`); and an a11y pass (focus-after-render on
the panel h1, nav aria-current, sortable-th keyboard, text badges for status not color-only, contrast
bump). Browser-verified (filter/sort/paginate on Audit, humanized headers, no console errors beyond
pre-auth 401s). This closes the "review the whole UI/UX" thread except the intentionally-open items
(nothing further deferred beyond what the deeper-a11y sweep would add).

**Pillar 7 — Team-Lead transitive per-node budget ceiling, 2026-07-30 (session-02 addendum 31, ADR-0016).** A mapping pass found the AGENT-entitlement narrowing already shipped (§5.1 lead ceiling: allowedAgentIds/toolRefs → computeNodeCeiling transitive intersection → policy kernel agent-lead-ceiling), so this slice built the missing BUDGET half. A task node gains `budgetCapUsd`; `computeNodeBudgetCeiling` folds the MIN of the node's own cap and every lead ancestor's — symmetric with the agent ceiling (delegation only ever TIGHTENS). Enforced at node_started on top of the run cap: a node over its ceiling escalates into the one Approvals Queue (node-budget-cap). No migration. Gateway 332 → 336, orchestration-kernel 23 → 27. Remaining in the sequence: pillar 3 infra-ops automation.

**AWS redeploy of PRs #34–#37 + a Docker-build fix + CI paused, 2026-07-30 (session-02 addendum
32, PR #38 merged).** The user asked to redeploy the merged work (chat multimodal, pillar-2
deploy/verify/rollback, pillar-3 BYOC, pillar-7 sub-budget) to the dev stack and to stop burning
CI. The redeploy SURFACED a real break: merged `main` did not build in Docker, because the image
runs `pnpm -r build` which type-checks the test files too (each package tsconfig `include:["src"]`)
and two test files that shipped via merged PRs carried type errors CI never caught — the account's
GitHub Actions minutes are exhausted, so every run instant-fails on a 404 log download before the
build gate ever runs. Fixed both (`model-provider/index.test.ts`: two block-array `dispatch()`
calls omitted the required-but-ignored `input` field + a null-narrow; `gateway/node-budget.test.ts`:
two inject helpers returned `app.inject(...)` un-awaited, yielding the overload-intersection type
without `.statusCode`/`.json` — awaited inside, matching sibling helpers). **CI paused** —
`.github/workflows/ci.yml` triggers switched to `workflow_dispatch` only (the `pull_request`/`push`
triggers kept commented for a one-line revert once minutes top up); local verification
(`pnpm -r build` + `check-ui-syntax` + `pnpm -r test`) is the gate meanwhile. PR #38 carries both
and is MERGED — `main` builds again. The dev stack was redeployed from the branch HEAD (= `main` +
those two commits, byte-identical app to post-merge main) because `main` itself didn't build until
#38 merged: `docker compose up -d --build` on `i-013c62adc887c76bb`, gateway container recreated,
the Postgres volume (pgdata) + per-boot secrets override preserved, migrations 0030–0033 applied
(`deploy_targets` present), `/app` + `/admin` 200 on-box at `http://3.237.199.248:3000`. Still
dev-grade, NOT production. The user then directed the four remaining open-item areas in parallel:
pillar-3 infra-ops AUTOMATION (drift/CVE/cert/backup — the operational half beyond the §8.2
governed-ops layer), clearing the ADR-0015/0016 + pillar-2 deferrals, and a deeper UX/a11y pass.

**Batch H SHIPPED — IDE interception is real, 2026-07-30 (migration 0037, ADR-0020).** The plan
below became code the same day, on the owner's "whatever is most comprehensive — need to give
options for the admins to choose from what to use on their end." Two provider-shaped
**translation shims** over the ONE governed dispatch core: `POST /v1/messages` (Anthropic shape,
also accepting `x-api-key`, so `ANTHROPIC_BASE_URL`-based tools like Claude Code just work) and
`POST /v1/chat/completions` (OpenAI shape, for Cursor/Cline/Roo/Continue/Zed), both with real
provider-native SSE. THE INVARIANT, tested against `/invoke` as a control: **the compat surface
creates NO privilege path** — an unentitled user is 403 on both, a revocation denies through them,
and an unresolvable model is 403 default-deny that writes ZERO usage rows, never a silent
pass-through to the vendor. Everything is an ADMIN CHOICE (migration 0037's singleton
`interception_settings`): which surfaces exist (`anthropic_compat_enabled` / `openai_compat_enabled`
default **FALSE**, `mcp_interception_enabled` default true and genuinely wired — false 404s the MCP
proxy too); `resolution_mode` (`map_by_model` | `require_agent` | `router_decides`, the owner's
decision that the admin picks rather than us); declared `enforcement_posture` (observe | voluntary |
managed | key_custody | network, driving honest honor-system warnings in the UI); and
`require_project_attribution`, the admin's lever to guarantee pillar-5 coverage by rejecting
unattributed calls. A disabled surface returns **404, not 501** — we never advertise something the
admin declined. New admin "Client Access" tab (Identity & Access) with a per-client config
generator built from `location.origin` and an honest coverage table naming Copilot and Eclipse as
NOT covered. Unsupported request fields **fail loudly with a 400 naming the field** rather than
being silently dropped (`temperature` included — `ModelDispatchRequest` cannot carry it, so real
clients that send it unconditionally will 400; documented). Streams open LAZILY so a PII-input
block or budget gate raised inside dispatch still returns a real HTTP error rather than a 200
carrying a failure. `docs/product/IDE_INTEGRATION.md` written. Gateway 386 → **426** (40 new).
**Honest limit, restated in ADR-0020:** this makes interception real but NOT universal — at the
`voluntary` rung it is an honor system, and `CLAUDE.md`/`VISION.md` still promise governance over
"every agent/model call" on the assumption calls arrive at us. Key custody is the cheapest
non-bypassable rung and is policy, not code. Those two files deliberately NOT edited — owner's text.

**PARALLEL WAVE LANDED — batches A, B-core, C-core, D-depth, E, org-settings, enterprise/UX,
2026-07-30→31 (PRs #48–#56, migrations 0038+0039, ADR-0021+0022; suite 432 → 492; deployed and
verified live).** The wave announced in the addendum below is COMPLETE. Six builder agents in
isolated worktrees + one hands-on UI review, merged sequentially by the dispatcher with a full
build+suite verification of each combined tree before any PR. Shipped: (A) GitLab/Bitbucket/
Azure-DevOps git adapters, refusals-over-approximations (#52, git-provider tests 7→51, plus an
additive `getPullRequest`/`listChecks` surface); (B-core) Slack/GitHub/Jira connectors (#49,
8→44; **Snowflake still open** — key-pair credential vs single-ciphertext schema decision);
(C-core) the real AWS infra adapter (#51, 33→83, injected clients, no fake success) + gateway
live wiring behind `REGULAIT_INFRA_LIVE` with `@aws-sdk/client-ssm/-acm/-backup` deps, flag-off
byte-identical (#55); (D-depth) OpenAI Responses API behind a behavior-preserving model list +
correct Gemini tool-use replacing the "best-effort" mapping (#50, 62→85); (E) the doc
reconciliation below + prepared-but-off CI + three Terraform follow-ups authored not applied
(#53). **Org-settings (migration 0038, ADR-0021, #54): the owner's standing configurability
mandate made real** — 37 admin controls (six optimizer technique toggles + dials wired to kernel
params that existed unwired; semantic-cache policy `off|opt_in|always`; `default_pii_mode` for
unclassified projects; env-key-fallback gate + visibility; budget `block|warn_only` + hard-block
pct; approval quorum `all|any`; retention auto-prune; worker caps; attachment/truncation
ceilings; `streaming_on_block_mode` + `strict_field_rejection` on interception_settings), every
default behavior-preserving, org = ceiling users can only narrow, new "Organization" admin tab
(Policy group). **Enterprise/UX (migration 0039, ADR-0022, #56): the UI review's three pilot
blockers closed** — approvers get a narrowly-scoped read of instances they are party to (driving
routes keep the strict gate) + merge-gate cards showing PR/checks/dry-run; full identity
lifecycle (deactivate with last-active-admin lockout, promote/demote, role holders/unassign/
delete, team member remove/delete, template retire, **approver delegation** with on-behalf-of
audit rows and an org kill switch); audit CSV export; all practicality gaps (inline confirms
replace native `confirm()`, names over UUIDs, copy buttons, live template resolution, thread
restore); #79b unimplemented-git-kind 400s at creation; #79c `dryRun` is structural, persisted
through the air-gapped branch, and **refuses production deploy gates**. UI review verdict
recorded honestly: past demo-ware, pilot-evaluation-ready; day-to-day operation still gated on
connecting real providers (model key = parked Batch G, owner's call) and the guided
first-provider journey (open). Wave-3 backlog, per ROADMAP §6: Snowflake credential schema,
worker streaming, `agents.systemPrompt`, `mcpDefaultMode` enforcement, O11/O13/O15 interception
depth, Azure/GCP infra, A4.

**Waves 7–8 addendum, 2026-08-01 — TLS, hardening, true SPA parity, username login, and a
terraform landmine (PRs #76–#84).** Written the same day, per the lesson recorded above.

- **#77 / ADR-0029 — zero-cost TLS.** Caddy in the compose stack, `3-237-199-248.sslip.io`
  (free wildcard DNS, no domain purchase), real Let's Encrypt certs. ALB+ACM declined on cost;
  self-signed rejected as not honestly "TLS". Cert volume is named (without it every redeploy
  re-issues and burns the rate limit); HSTS deliberately OFF on an IP-derived hostname; :80 must
  stay open or renewal fails silently two months later. **It exposed a real defect**: a reverse
  proxy would have made `req.ip` — on every `auth_sessions` row — record Caddy instead of the
  user, in a product whose first pillar is per-user audit. Fixed via `trustProxy`, safe because
  Caddy OVERWRITES X-Forwarded-For rather than appending.
- **#78 / migration 0047 / ADR-0030 — username login.** `@` is barred from usernames so the
  namespaces cannot overlap and a username can never impersonate an email; case-folding is
  enforced at STORAGE (normalize-on-write + CHECK), so `Dhruv`/`dhruv` cannot coexist even via
  hand-written SQL; the ADR-0025 uniform-401 body is preserved byte-identically and the unknown-
  username path still burns a scrypt. Seeded personas gained `admin`/`avery`/`dana`.
- **#79/#80/#83 — SPA parity was FALSE three times, then measured.** ADR-0026 claimed "parity
  proven, zero gaps". A capability diff found goal-decomposition, PM links and the decision
  ledger legacy-only (#79); investigating that found a FOURTH, pillar 4's shared context store
  (#80); and closing the last two end-user surfaces (#83) turned up a FIFTH class the diff is
  blind to — `byConnector`/`byMcpTool` spend was inside every project total but rendered in no
  breakdown. **Parity is now defined as a capability diff, not a nav walkthrough**, and the
  legacy shells were NOT deleted (the deletion was built, tested, then reverted).
- **#81 / ADR-0031 — P0 hardening** from an adversarial audit: streamed keyset CSV exports with
  microsecond-exact cursors (a naive cursor silently drops rows sharing an instant) and a
  DISCLOSED ceiling (a compliance export is never silently short); audit cursor pagination;
  `trustProxy` narrowed to Caddy's pinned address; rate limiting; CSP with boot-computed inline
  hashes; observable schedulers. It also corrected ADR-0029: forging `x-forwarded-proto: https`
  only turns Secure ON (harmless) — the dangerous direction, missed by me, is a forged `http`
  turning it OFF and issuing a cleartext-sendable cookie.
- **#84 — a terraform landmine, found before it fired.** `plan` proposed
  `aws_instance.app must be replaced` because the module read the AMI from
  `/aws/service/ami-amazon-linux-latest/...`, which AWS re-points on every AL2023 release.
  **Postgres is a container volume on that instance**, so any apply by anyone, for any reason,
  was total data loss. Fixed by pinning the AMI, `user_data_replace_on_change = false`, and
  reverting a cosmetic SG description (ForceNew). Plan now: `0 add, 2 change, 0 destroy`.

Suite 829 → **881**. Migrations → **0047**. ADRs → **0031**.

**NOT DEPLOYED as of this entry.** Today's app code is unshipped, and it cannot go out the old
way: #77 bound the gateway to host loopback, so a redeploy WITHOUT Caddy leaves the box
unreachable. TLS and the next deploy are one operation, and it awaits the owner's go-ahead.

**Standing exposure the owner has been told about twice and not yet acted on:** Postgres remains
a container volume on a single EC2 instance. #84 defused the current trigger; it did not remove
the exposure. Free mitigation offered: nightly `pg_dump` → S3 + a tested restore.

**Waves 4–7 addendum, 2026-07-31 — the work this file had NOT recorded (PRs #58–#75).**
Written 2026-07-31 to close the STATE.md drift noted at the top. Each item is in the session log
in more detail; this is the durable summary.
- **#58** worker/auto-dispatch STREAMING (multiplexed per-node SSE envelope, live Runs view,
  ledger parity streamed-vs-not).
- **#59** migration 0040 / ADR-0023: **Snowflake connector** (structured-JSON credential inside
  the single AES-GCM ciphertext — a zero-migration convention future multi-field connectors
  reuse), `agents.systemPrompt` (admin prompt is the dispatch system BASE, a caller's is APPENDED
  and can never replace it), and **`mcpDefaultMode` actually ENFORCED** (was declared-only).
- **#60/#62** Azure + GCP infra adapters and real azure/gcp/k8s deploy paths, with honest
  structural unknowns (Azure exposes no CVSS — the severity source is labeled; GCP has no
  renew-now cert API so rotation is a permanent 501).
- **#63** migration 0041 / ADR-0024 — **the interception trio**: every gateway call is now
  METERED (unattributed MCP lands in a visible NULL-project bucket, never a project budget),
  per-user/project/role **scope rules** for staged rollout (exposure ≠ entitlement, pinned by
  test), and **key custody is an ENFORCED rung** (BYO creds go inert), not merely declared.
- **#64** the **async-deploy refactor** (`DeployProvider` → Promise, awaited in workflows.ts, no
  lock held across a cloud LRO) plus the real AWS/Azure/GCP/k8s deploy clients it unblocked.
  `dryRun:false` only ever follows a genuinely completed call.
- **#65** guided **Getting-started** checklist from real readiness data (mock never ticks a box).
- **#67** compat long tail — `tool_choice`, structured outputs, Anthropic `thinking` honoured
  end-to-end; Anthropic `response_format` is a 400 rather than a fake emulation.
- **#68** migration 0042 / **ADR-0025 — SECURE HUMAN AUTH** (see the recap at the top).
- **#69/#70** **ADR-0026 — the React SPA**, phase 1 (workspace) then phase 2 (complete admin
  surface), with parity proven by 32/32 Playwright BEFORE the default-route swap.
- **#71** migrations 0043–0045 / ADR-0027 — all 11 remaining backlog items (per-kind deploy
  targets, A4 complete, cert lifecycle, backup scheduler, per-stage quorum, partial revocations,
  per-tool MCP pricing, additive-only reclassification reapply, per-framework cost policies, PM
  drift auto-resolution, PM budget mirroring).
- **#74/#75** two defects the OWNER found by using the deployed build: auth gates never named the
  account they were acting on; and an API-key session could be **locked out** by a
  forced-password-change gate demanding a password that was never issued. Fixed with migration
  0046 / ADR-0028 (`auth_sessions.origin`), scoped so the recovery bypass CANNOT be used to turn
  a stolen API key into a permanent password — that guard is a named test.

Suite 386 → **801**. Migrations 0036 → **0046**. ADRs 0019 → **0028** (0029/0030 in flight).
**Nine verified deploys.** ROADMAP §6's backlog went from 16 orphans to effectively empty.

**Standing owner directives as of 2026-07-31** — carry these forward:
- **Do NOT raise the Anthropic/model-key topic again until the owner raises it.**
- Admin-configurability is a standing mandate (ADR-0021 conventions).
- No production designation without explicit in-session sign-off (unchanged). The owner
  explicitly declined a production move and any new AWS cost on 2026-07-31.

**Housekeeping addendum, 2026-07-30 (doc-reconciliation batch — amends, does not rewrite, the
entries around it).** (1) **Temperature amendment to Batch H:** the entry above says unsupported
compat fields 400 loudly, `temperature` included. Amended the same day (`fdfeff1`, PR #47,
ADR-0020 §5): `temperature` is now **accepted-and-disclosed** — ignored, with the disclosure via
an `x-regulait-ignored-fields` response header plus an audit row — because real IDE clients send
it unconditionally and 400ing it defeated the very interception the batch exists for. All other
unsupported fields still 400 by name. (2) **Governance-gaps batch is MERGED** (PR #44, migration
0036, ADR-0019) — per-user revocation of role-derived grants, MCP attribution + PII, streaming
suppression for block-mode projects, and the `data_sensitivity` 6th assignment dimension; ROADMAP
§1 described it as in-flight. Current gateway suite after Batch H + governance-gaps + the
temperature merge: **432**. (3) **A parallel build wave is in flight** per the owner's directive
(batches A–D+C, the enterprise/UX track, and the admin-configurability mandate): org-settings
(claiming **migration 0038**) + git-provider adapters + connector adapters + infra AWS +
model-provider depth, each on its own branch. Migration coordination note: the next free
migration number is 0038 and org-settings is taking it — check `packages/db/migrations/` AND
`meta/_journal.json` before claiming a number, since the journal is what `migrate()` actually
reads.

**IDE / existing-agent interception identified as a SCOPE gap, 2026-07-30 (planning — the batch
above is the implementation; ROADMAP Batch H).** The owner raised that most developers use AI agents inside VS Code / Cursor /
JetBrains rather than through a governed portal, and RegulAIt never accounted for it. This is a hole
in the product thesis, not the backlog: every spec in `docs/product/` governs agents that come **to**
our gateway, so a developer running Copilot never touches it and the governance is invisible to
exactly the population it exists for. Findings: (a) **half already works, unmarketed** — the
streamable-HTTP MCP proxy (`POST /mcp/:serverId`) is a fully governed tool-call interception point
any MCP-capable IDE can use today with zero build; (b) **the gap is model calls** — there is no
provider-shaped endpoint (no `/v1/messages`, no `/v1/chat/completions`), only our proprietary
`/v1/agents/:id/invoke`, so IDE completions bypass attribution, optimization, PII and audit
entirely; (c) the fix is a translation shim over the existing `executeGovernedDispatch`, not a
second engine — the same zero-gateway-change shape that landed the OpenAI/Google/xAI adapters.
**Decision recorded (owner, 2026-07-30): model→agent resolution is an ADMIN-SELECTABLE POLICY, not
a constant** — `map_by_model` / `require_agent` / `router_decides` all ship and the admin picks,
bound by the invariant that an unresolvable model is **default-deny, never a silent pass-through to
the vendor**. Also recorded: the six-rung interception ladder (observe → voluntary → managed →
enforced), where **key custody** (the org holds vendor keys, developers hold only RegulAIt keys) is
the cheapest non-bypassable enforcement and is almost entirely policy rather than code. Becomes an
ADR when the batch is scheduled. Honest coverage note: base-URL override works for Continue/Cline/
Roo/Zed/Claude Code, Cursor takes OpenAI-compatible, **Copilot is largely locked down and Eclipse
has no first-party agent** — "works with every IDE" would be false. Doc debt flagged, not edited:
`CLAUDE.md`/`VISION.md` promise governance over "every agent/model call" on the assumption calls
arrive at us; adopting Batch H means restating that as an explicit interception story.

**Four-area cleanup batch shipped, 2026-07-30 (session-02 addendum 33; migrations 0034 + 0035;
ADR-0017, ADR-0018 + ADR-0015/0016 addenda; PRs #40/#41/#42, all merged).** The four directed
areas landed as three per-chunk PRs on fresh branches (branch-per-PR adopted this session so the
mobile app's PR chip tracks the current PR, not an old merged one). **(1) Pillar-3 infra-ops
automation (migration 0034, ADR-0017):** automation DEPTH on the existing §8.2 detect→remediate
spine — durable domain ledgers (`cert_inventory` + `cert_rotations`, `patch_records`
UNIQUE(resource,cve), `backup_runs`) that hang off `infra_resources` and link back to the inert
`infra_findings` via `ref_table`/`ref_id`; the pure detection math (`compareDrift`,
`cvssToSeverity`, `certSeverity`, `evaluateBackupSchedule`) extracted + unit-tested; governed
operator verbs (rotate / patch / restore) that flow through the ONE Approvals Queue via an
action-tagged sentinel `__infra_action__:<action>:<id>` — approve runs the provider action + writes
the ledger outcome in the same /decide txn, deny → linked finding `accepted_risk`; air-gapped
resources reuse the ADR-0015 boundary (metadata-only). `infra_resources.deploy_target_id` ties
customer-hosted resources to their BYOC target. No live cloud mutation. **(2) Deferral cleanup
(migration 0035, ADR-0018 + addenda):** azure/gcp/kubernetes deploy adapter SHAPES (dry-run + //
REAL: markers; all five kinds resolve); real @aws-sdk STS AssumeRole behind an off-by-default
`REGULAIT_DEPLOY_LIVE` flag (injectable client, fake in tests, no live mutation); admin Deploy
Targets management UI; MEASURED per-node budget running total (`measuredPerNodeUsd`,
`__nodebudget_measured__` escalation) + decompose auto-suggesting per-node caps + a per-node cap
chip in /app — clearing all three ADR-0016 deferrals; assignment matching gained target-system +
initiator-role dims (3→5 of 6 wired; data-sensitivity still deferred; `initiatorRole` server-
resolved, never client-supplied); seed now drives instances to rest at blocked_on_check /
blocked_on_deploy / rolled_back. A4 (per-mode policy + mode-aware audit retention) recorded as
design-only in the ADR-0015 addendum. **(3) Deeper UX/a11y:** shared render helpers hoisted into
`ui-theme.ts` (`UI_TABLE_JS`) so both UIs + every table reuse them; `table()` delegates to
`dataTable()` above 8 rows (the new Deploy Targets + infra cards inherit sort/filter/paginate free);
/app parity (renderDecision for the Playground trace, aria-live toast region, heading focus, mobile
hamburger, idChip sweep); a real WCAG contrast fix (`--text-faint` ~3.3:1 → ~4.9:1 + a `--decor`
token) + global :focus-visible rings + keyboard-copyable idChips. Verified per PR on a fresh DB
(build + check-ui-syntax + suites) — full gateway suite 345 → 361; UX PR added a headless-Chromium
drive (0 console errors, axe color-contrast serious+ = 0). CI stays paused; local verification was
the gate. Deploy note: also caught + fixed a pre-existing main build break (two test-file type
errors CI never saw while Actions minutes are exhausted) as part of the redeploy — see addendum 32.

**Pillar 3 — BYOC deploy targets: modes + AWS assume-role adapter + data boundary, 2026-07-28
(session-02 addendum 30, migration 0033, ADR-0015).** First pillar-3 slice, extending the pillar-2
deploy tail into customer-owned cloud. A deploy target gains a `mode` (hosted / byoc / air_gapped)
plus, for AWS BYOC, a `roleArn` + `region`. The `AwsDeployProvider` models STS AssumeRole into the
customer's role (short-lived creds, no static key) then deploy in their region — execution is a
deterministic **dry-run** (no real cloud call, no prod resource without explicit sign-off; `// REAL:`
markers show where the @aws-sdk calls go). The disclosed control-plane / agent-execution-plane data
boundary is **enforced in the executor by mode**: air_gapped keeps METADATA ONLY in the control
plane (never the deploy URL / provider detail), hosted/byoc keep the full record — a testable
property (air-gapped e2e asserts nothing crosses back), not prose. Gateway 327 → 332. Deferred: real
@aws-sdk execution, azure/gcp/k8s adapters, admin mode UI (ADR-0015).

**Pillar 2 — deploy → verify → auto-rollback, 2026-07-28 (session-02 addendum 29, migration
0032).** Completes the workflow pipeline's tail, on top of the check fail→route primitive. The
kernel gains executable `deployment` + `rollback` stages, a `blocked_on_deploy` manual-handoff
state, and a terminal `rolled_back`. A post-deploy verify is an `automated_check` with
`onFailure:"rollback"` that routes STRAIGHT to its rollback stage on failure (auto self-heal);
a rollback stage is a failure-only jump target that normal flow skips, so a passing deploy never
reverses itself. The deploy executor gates on a configured deploy target existing AND an optional
condition matching the change — either unmet parks at the manual handoff (resolved via
`POST .../deploy-override`); otherwise it deploys via a provider-agnostic adapter (mock now;
cloud adapters declared-not-integrated). Deploy targets are a new governed admin resource
(`deploy_targets`, creds encrypted at rest). The /app workflow detail surfaces the handoff, the
rolled_back terminal, and a Delivery row (live / rolled back). Gateway 322 → 327, kernel 29 → 33.
Next in the pillar sequence: pillar 3 BYOC/air-gapped deploy (real cloud adapters), pillar 7
orchestration depth, pillar 3 infra-ops.

**Pillar 2 — automated checks that FAIL and route, 2026-07-28 (session-02 addendum 28).** First
"workflow depth" slice after the 3-ask batch. Before this, every named automated_check auto-passed
— the pipeline had no failure path at all. Now a REPORTED failing check parks the instance at a new
`blocked_on_check` state (kernel: `check_failed`/`recheck` events + surfacing effect, guarded)
instead of advancing; a remediate-then-recheck loop resumes it. The gateway check executor resolves
each named check from reported results (`POST .../checks` — a real CI posts them, seed/tests too),
falling back to the deterministic auto-pass when none are reported (existing templates byte-
identical); a failure is audited `workflow:check_failed`. `POST .../recheck` re-runs a parked stage.
The /app workflow detail surfaces the block, per-check severity, "mark passing", and "Re-run checks".
No migration (free-text status; results in JSONB context). Gateway 318 → 322, kernel 26 → 29. This
is the failure primitive the conditional deploy + post-deploy rollback stages (next slice) build on.

**Chat→Claude + visual context graph + multimodal attachments, 2026-07-28 (three prioritized
product asks, see session-02 addendum 27).** (1) **Chat routes to Claude**: a platform API-key
ENV fallback (ANTHROPIC_API_KEY etc., last-resort after stored user/platform creds, read at
dispatch only) lets a self-hosted box go live with no admin-UI paste; a read-only
`GET /v1/model-providers/status` (booleans only) drives the composer's not-configured banner, and
a fresh chat now defaults to the highest-tier live non-mock agent (Claude wins ties). (2)
**Visual Context Graph** (pillar 4): new /app page rendering the shared-context store as a
dependency-free SVG version graph — one column per key, baseRevision→revision lineage edges,
conflict forks amber/dashed, click-for-detail with contributor/team provenance; backed by
`GET /v1/projects/:projectId/context/graph` (viewer-gated, 240-char preview). (3) **Multimodal
attachments** (mimics Claude native): 📎 + drag-drop + paste-image composer with a thumbnail/chip
tray (<= 8 files, <= 6 MB each) — images/PDFs ride the dispatch as base64 `attachments`
(`ModelContentBlock` gained image/document variants; Anthropic maps to native source blocks,
other adapters degrade to a named placeholder), text/code files ride `referenceContent`; history
stores only a named marker (never bytes, never re-billed), and attachments never widen
entitlement. Suite 307 → 318 (attachments.test.ts); model-provider 60 → 62. Browser-verified both
new surfaces, zero console errors.

**Agent-driven task decomposition, 2026-07-26 — pillar 7's headline lands, human-gated.**
`POST /v1/runs/decompose` {goal, projectId?, leadAgentId?}: a Team-Lead agent (leadAgentId ??
user default ?? cheapest granted mock, entitlement-checked under mode "plan") drafts a
task-graph PROPOSAL via one governed metered dispatch (policy → project budget gate →
usage/audit with detail.purpose:"decompose"; roster in the prompt = the caller's entitled
AND dispatchable agents with tier/price so suggestions are grounded). Parse (balanced-JSON,
fence-tolerant) → decompositionPlanSchema (2-8 kebab-id nodes) → agent names resolved
against real grants (unknown → default agent with recorded substitution) → the SAME kernel
validateGraph as planRun; one error-fed retry then honest 422 with rawOutput (both attempts
billed). It never creates a run — the proposal lands in the New Run editor (editable
everything, substitution badges, lead cost banner, "nothing runs until you accept") and
acceptance is the unchanged human plan gate. Mock planner: deterministic 4-node
analyze → two parallel goal-keyword middles → integrate, roster-aware, tier-scaled —
demoable with zero external keys. Suite 443 → 455; browser-verified (drafted plan executed
to completion with ∥ badges, zero console errors). Deferred (unchanged): Team-Lead TIER
with transitive entitlement narrowing, tool-using multi-turn workers.

**Multi-turn conversations, 2026-07-25 — the Playground stops being amnesiac (pillar 6
prerequisite unlocked).** `ModelDispatchRequest.messages` (full ordered history; `input`
ignored when present, byte-identical single-turn otherwise) threaded through all five
providers (google maps assistant→"model"; mock opens with a continuation line and terse
follow-ups inherit the previous turn's topic — demo-provable). Migration 0023:
`conversations` + `conversation_messages` (FK-free subject ids like the ledgers, cascade on
messages, assistant detail jsonb = stopReason/refusal/servedAgentId/modelUsed/costUsd/
credentialSource). Invoke accepts `conversationId`: ownership checked before anything bills;
EVERY turn is the unchanged governed pipeline (policy → routing → budget → audit → ledgers,
history growth added to cost estimates so budget gates stay truthful); transactional
persistence — success both turns, refusal flagged, denial user-turn-only (excluded from
future model-bound history), dispatch failure nothing. Own-scoped CRUD. /app Playground is
now two-pane: conversations rail (new/delete/active restore via sessionStorage), history
replayed through the SAME badge renderers as live turns (incl. denial pills), auto-create +
auto-title on first send, mid-thread agent/project switching. Seeded 2-exchange demo
conversation (idempotent, real-API-driven) + new seed.test.ts double-run suite. Suite
416 → 443. Browser-verified: continuation reply on-topic, reload restores thread, zero
console errors.

**Provider-native inbound webhooks, 2026-07-25 — the deferred ADR-0010 depth item.** New
`packages/pm-provider/src/inbound.ts`: per-provider `parseInboundWebhook` (exhaustive
registry) verifying each tool's REAL mechanism and translating its REAL payloads into the
one existing normalized shape — handshakes answered without processing, valid-but-irrelevant
payloads 200-and-dropped, verification failures → 401 with no secret material. Mechanisms:
linear `linear-signature` HMAC; asana two-phase (`x-hook-secret` echo handshake, then
`x-hook-signature` HMAC over thin state-less events resolved by read-through); monday
`{challenge}` echo + URL-token (monday sends no signature — documented limitation); jira
URL-token (Jira Cloud manual webhooks can't sign or set headers); azure_devops basic-auth
password; generic/mock `x-regulait-signature` HMAC (outbound symmetry) with the legacy
secret header still accepted, signature taking precedence. All comparisons constant-time.
Migration 0021 adds `pm_connections.webhook_secret_ciphertext` (AES-256-GCM, same envelope
as tokens) because HMAC needs the secret itself — the sha256 hash stays and still gates
legacy traffic. Raw-body capture is scoped to the webhook route only (encapsulated Fastify
scope; global JSON parsing untouched). Downstream normalized processing (pm_sync_events,
drift, orphans) unchanged. Suite 380 → 405 (20 unit + 5 e2e). **ADF descriptions for Jira, 2026-07-25 —
pillar 8's deferred list is now EMPTY.** New dependency-free `packages/pm-provider/src/adf.ts`:
`textToAdf` (paragraphs w/ hardBreak round-tripping, #-headings capped at 6, bullet/ordered
lists, code fences w/ language; total — never throws) and `adfToText` (inverse walk,
unknown nodes descended never dropped). `JiraAdapterOptions.apiVersion?: 2|3` (default 2,
zero behaviour change): v3 uses `/rest/api/3/`, converts the native description field and
comment bodies through ADF both ways. Migration 0022 adds nullable
`pm_connections.api_version` (null = v2; jira-only, superRefine-rejected loudly elsewhere);
admin form gains the v2/v3+ADF select. Adjacent fix: run pm-sync now seeds the mapped
description from the node's instruction at creation (initial value only — the PM tool owns
it thereafter per §3). Suite 405 → 416.

**EPIC-06 started — PM-tool integration first slice, 2026-07-25.** New
`packages/pm-provider` on the git-provider playbook (pillar 8, PM_TOOL_INTEGRATION_SPEC
§2/§3/§6): neutral `PmProvider` interface (create/update/transition/comment/getWorkItem), the
load-bearing FIELD MAPPING layer as pure zod-validated config with per-adapter defaults an
admin overrides (§7: never hardcoded), an Azure DevOps adapter (REST 7.x, PAT, injectable
fetch, json-patch), an in-memory mock, and a registry that explicitly rejects
jira/linear/asana/monday/generic_webhook until implemented. Migration 0013: `pm_connections`
(AES-256-GCM tokens like git_connections) + `pm_links` — the record that makes a task-graph
node BE a work item rather than a shadow copy; RegulAIt stores ONLY the linkage. §3 source of
truth honored literally: priority/description/acceptance-criteria are never cached — the links
view reads them through live (`?live=true`) from the PM tool. Status ownership (documented
decision, spec silent): RegulAIt owns node status (it owns the state machine) and mirrors it
OUTBOUND via the mapping's statusMap on every node event; unmapped statuses are skipped, never
invented; mirror failures are surfaced in the response, never fail the run event, never hidden.
Every creation/mirror writes the one audit trail (objectType "pm_work_item"). Endpoints:
PM connection CRUD (admin), `POST /v1/runs/:id/pm-sync` (idempotent node→work-item linking),
`GET /v1/pm/links` (+live read-through). **Second slice: §5 approval
mirroring.** Mapping gains an `approval` section (`target: status_transition|comment` +
per-stage `stageMap`); pure `resolveApprovalAction` degrades everything unmapped to a comment —
a sign-off decision is never silently dropped (§4's fallback rule applied to approvals), and a
DENIAL never enters a mapped state (always a comment — a customer's "Approved" state is only
entered on approve). Workflow instances now link to ONE work item
(`POST /v1/workflows/instances/:id/pm-sync`, idempotent), and the decide endpoint mirrors every
decided workflow sign-off and run escalation onto its linked item (transition and/or
`[RegulAIt] sign-off …` comment with decider + reason) — strictly display, never a second
decision point; a mirror failure is surfaced in the decide response and never unwinds the
decision. All mirrors audited (pm_work_item). **Third slice: §4 decision
records.** First-class `decisions` table (FK-free — governance records survive deletion;
decision-maker is ALWAYS the authenticated identity, never a body field) with
`POST/GET /v1/decisions` scoped to the parent run/instance initiator. Mapping gains a
`decision` section (customer's Decision-like work-item type + field paths for
title/rationale/decisionMaker); pure `resolveDecisionAction` mirrors a recorded decision as a
real linked work item of that type — with a §6 traceability comment on the parent item — or
degrades to a tagged comment when no type is mapped; no PM link at all = recorded locally with
no mirror. Never dropped, never blocking the local record. Run pm-sync now also creates a
run-LEVEL parent item (anchor for run-scoped records; unblocks budget-approval mirroring
later). **Fourth slice: inbound sync
(ADR-0010 — webhooks + live read-through, no polling).** Per-connection webhook secret minted
at creation (plaintext once, sha256 at rest, constant-time verify — API-key discipline);
`POST /v1/pm/webhooks/:connectionName` accepts the normalized
`{externalId, event: updated|deleted|commented, state?, fields?}` shape (provider-specific
payload translation is a later adapter concern; this shape doubles as the start of the generic
webhook adapter) and is the ONLY route exempt from bearer auth. Every signal lands in
append-only `pm_sync_events`, matched or not. Inbound state is recorded on the link
(`inboundState`/`inboundAt`) and NEVER applied to the state machine — divergence from the
mapped state of the node's current status surfaces as `drift` in the links view plus a
`pm-drift-detected` audit row ("never drift silently" = detect-and-surface, not
auto-overwrite); `deleted` events orphan the link, audited. Not in EPIC-06 yet:
budget-approval mirroring, provider-specific webhook payload adapters + HMAC signatures,
automated drift resolution (human today), Jira + remaining adapters.

**EPIC-05 started — multi-agent orchestration first slice, 2026-07-25.** New pure
`packages/orchestration-kernel` (pillar 7, MULTI_AGENT_ORCHESTRATION_SPEC §2–§5): task-graph
validation (zod + cycle detection + §4 ownership rule: nodes sharing files must be
dependency-ordered), ready-set scheduling with `parallelizable:false` serializing the whole run,
and a run state machine using the spec's five node statuses (not_started/in_progress/blocked/
in_review/done) with §3's three failure outcomes — retry, reassign, escalate — all event-driven.
**The task graph is input** (user/template-supplied): whether a PM Agent may generate it with a
model call is an open spec question, deliberately deferred until real model dispatch exists.
§5.1 (inheritance, never escalation) enforced at the gateway: every node owner — at plan time
AND on reassignment — goes through the same `evaluateAgent` under the *initiating user's*
grants/modes/ceiling; any deny rejects the whole plan (422) or the reassignment (403), audited.
Escalations land in the ONE approvals queue (`approvals.run_id` + objectType "run", named
approver from the graph; approve = re-open node, deny = abort run) and every run event writes to
the one audit trail (objectType "run"). Migration 0011: `orchestration_runs` (graph/state jsonb
snapshots, nullable workflow_instance_id for §8 build-stage nesting later),
`orchestration_run_events` (append-only), `approvals.run_id`. Endpoints: POST /v1/runs
(validate+plan, nothing executes until an explicit start), POST /v1/runs/:id/events,
per-run view (initiator-only) + admin fleet view. **Second slice: §5.2 per-run budget caps.** Pure `estimateGraphCost`/`estimateNodeCost` in the
orchestration kernel (per-node token estimates — planner-declared or heuristic — × the owner
agent's list price; an unpriced owner nullifies the total, which fails CLOSED under a cap:
a cap that can't be checked requires approval, never silent skip, §7). Cap + breach action
(`approve`|`replan`) are admin-set on `user_agent_policies` — an explicit stand-in for the
per-project budget until a projects entity exists. Three §5.2 enforcement points, all
estimate-based (labeled as such in every payload) until real dispatch exists: (1) pre-execution
— over-cap plans either auto-re-plan (owners substituted per node via pillar 6's `routeModel`
with cost-sensitive bias over the entitlement-filtered candidate set — re-plan can never
escalate; substitutions ledgered as `cost_events` objectType "run") or gate `start` behind a
`__budget__` approval; (2) in-flight — `spentUsd` accumulates per node start, and a node whose
CURRENT owner (e.g. after reassignment to a pricier entitled agent) would breach the cap is
paused with a `__budget__:<node>` approval; (3) decisions — approve lifts cap enforcement for
that run (sanctioned overage, audited), deny aborts. Still not in EPIC-05: real worker dispatch,
PM-agent decomposition, team-lead tier, workflow build-stage nesting, per-project budgets.

**EPIC-04 started — token/cost optimization first slice, 2026-07-25.** New pure
`packages/optimizer-kernel` (pillar 6, TOKEN_OPTIMIZATION_SPEC §7/§8): deterministic complexity
classifier (never an LLM call — no text = no signal = no downgrade), token estimator, and
`routeModel()` — cheapest-eligible model selection with a relative tier floor per complexity,
§9 cost-sensitivity biasing (quality-sensitive = never downgraded), a §12 per-user passthrough
off switch, and full `{effect, ruleId, ruleChain, reason}` traceability. Routing runs strictly
*inside* governance at the same interception point: the candidate set is exactly the agents
`evaluateAgent` allows for that user+mode (re-enforced against the tier ceiling in the kernel as
defense in depth), so the optimizer can never widen entitlement. Savings semantics kept honest:
routing reports cost-saved (same tokens, cheaper model) against an explicit
`estimationBasis` — the counterfactual is the requested (baseline) model at list price; tokens-
saved stays 0 and is reserved for future compaction/dedup techniques. Migration 0010:
`agents.cost_per_mtok_in/out` (list price; unpriced models are never routing targets),
`user_agent_policies.routing_mode`, and the FK-free `cost_events` savings ledger (one row per
routing decision, per-technique enum covering all six §7 savings sources). `GET /v1/cost-events`
(admin fleet-wide, non-admins forced to self) returns raw events + per-technique totals —
the dashboard-ready §7 emitter that pillar 5's per-project rollup will consume. **Second slice
(same day): lazy tool-loading in the MCP proxy (§8)** — an optional `?intent=` on the proxy URL
(MCP's tools/list handshake carries no request text, so the signal rides on the URL) feeds pure
`selectTools()`: lexical relevance scoring narrows the *entitled* manifest to intent-relevant
tools, withheld tools stay fully callable (tools/call never consults the selection — the
manifest shrinks, the entitlement never does), no intent or zero matches fails open to the full
entitled list, the same per-user `routing_mode` passthrough switch disables it, and each
tools/list writes a `lazy_tool_loading` cost event with tokens-saved measured from the actual
serialized manifest chars withheld. **Third slice: §9 cost-sensitivity tag on workflow
templates** — `costSensitivity: cost-sensitive|standard|quality-sensitive` on the workflow
definition (validated by the kernel, no new stage type, no migration — it rides the definition
jsonb into the instance snapshot), merged strictest-wins in `mergeDefinitions` (an untagged
template counts as "standard", so a merge can never inherit cost-sensitive downgrading from
one team's template), surfaced top-level on the per-instance view. The invoke path has accepted
the same enum since slice 1; wiring instance→invoke happens when workflows actually invoke
models. Not in EPIC-04 yet: edit-vs-rewrite, compaction, file pre-processing, prompt/semantic
caching, batching.

**EPIC-03 started — workflow engine first slice (PR #9).** New pure `packages/workflow-kernel`:
declarative template validation (§3 — executable stage types trigger/planning/
artifact_generation/human_approval/automated_build/automated_check; git_operation/deployment/
rollback rejected until integrations exist), §4 assignment-rule matching (path glob/changeType/
environment, ANDed; multi-template union-merge keeping every approval stage, single trigger),
and a pure instance state machine: versioned sign-off (§2 stage 4 — artifact edits after
approval re-open the gate and supersede stale pending approvals), decide≠execute (build/check
stages await an explicit human trigger), denial/abort terminal states. Gateway: migration 0007
widens `approvals` into the ONE §6 inbox (workflow sign-offs are approvals rows with
object_type/instance_id/stage_id; deciding one advances the instance, all-named-approvers-must-
approve), plus `workflow_templates`/`workflow_assignment_rules`/`workflow_instances` (merged
definition snapshotted at start)/`workflow_events` (append-only history)/`workflow_artifacts`
(every version retained). Endpoints: template/rule CRUD (admin), instance start (auto-advances
to first block; §4: requester doesn't pick the workflow — rules do; explicit template =
admin-only), artifact submit/edit, advance, abort, per-instance dashboard view + admin fleet
view. Everything audits into the one trail (objectType `workflow`).

**§5 review fixes + agents/connectors governance (PR #8).** The PR #7 adversarial-review
findings are fixed: revocations are unique per (user, server, tool) with NULLS NOT DISTINCT
(migration 0005, duplicates deduped), Postgres constraint violations map to 409/400 instead of
500, and the entitlements view now surfaces tool-scoped carve-outs of role read-only-all grants
plus a `GET /v1/revocations` listing. Governance then extended to two more §2 object types
(migration 0006): **agents** — global registry (name/provider/tier/modes/enabled, §4), per-user
grants with mode-level restriction, per-user default+ceiling policy (tier-based), and a governed
`POST /v1/agents/:id/invoke` enforcement point (registry-enabled → allow-list → mode → ceiling →
allow, deny-by-default); **connectors** — catalog, per-user grants with read/readwrite mode and
`allowedObjects` data scope (fail-closed), governed `POST /v1/connectors/:id/invoke`. Both audit
into the **same** audit_log, widened with object_type/object_id/detail (§7's one audit trail).
Actual provider routing attaches to the invoke endpoints later — governance precedes routing.

**Roles + per-user overrides landed (PR #7) — §5 for the MCP object type.** Kernel: role-derived
grants (`RoleToolGrant`/`RoleServerGrant`, pre-filtered by the gateway to assigned roles) and
`Revocation` (subtractive per-user override; toolName null = all role-derived access on the
server). Precedence: direct grants > revocations > role-derived > default-deny — a revocation
never suppresses a direct grant, and revoked role grants trace as `revoked` (with the revocation
id) in the audit ruleChain. Gateway: migration 0004 (`roles`, `role_tool_grants`,
`role_server_grants`, `role_assignments`, `revocations`), role CRUD + assignment endpoints,
revocation create/delete (independently reversible per spec), and a per-user×server
**entitlements view** flagging every entitlement's source (direct vs role name) and any
revocation — §5's "override visibly flagged as a deviation", API-level.

**Real authn landed (PR #6) — the pre-ship blocker is closed.** Per-user API keys (`rgl_` +
24 random bytes, only the sha256 hash stored, shown once at creation, revocable, lastUsedAt
tracked), `users.isAdmin` flag, and a deploy-time `REGULAIT_BOOTSTRAP_TOKEN` (admin with no
user identity — exists only to mint the first real admin; cannot call tools or decide
approvals). Every gateway route now requires a valid Bearer token; everything is admin-only
except approvals-decide (named approver), own-visible-tools, and the MCP proxy (any user key).
The proxy's trusted `x-regulait-user-id` header is gone — identity comes from the key. The
approvals decide endpoint derives the decider from the authenticated identity (the old
body-supplied `deciderUserId` was spoofable). Migration 0003 (`api_keys`, `users.is_admin`).

**Data-scope rules landed (PR #5) — §3 feature-complete for the MCP object type.** Kernel:
`DataScopeRule` input (per-user×server, optional tool scope, dot-path into call arguments,
allowed-values list) — all matching rules must pass (AND), missing/non-scalar values fail
closed, violations deny before rate limits or approvals are consulted (order: grants →
default-deny → data-scope → rate-limit → approval → allow). Gateway: `data_scope_rules` table
(migration 0002), `POST /v1/rules/data-scopes`, and the proxy now passes each call's arguments
into `governedEvaluate` so scope is enforced on real MCP traffic.

**Approvals + rate limits landed (PR #4)**: the kernel now returns a third effect,
`require_approval`, and takes approval rules (per-user×server, optional tool scope, optional
write-only, named approver) and rate limits (per-user×server, optional tool scope, caller-supplied
usage counts — kernel stays zero-I/O) as inputs. Rule order: grants → default-deny (nothing
rescues an ungranted call) → rate limits (exhausted limit denies even with an approval in hand) →
approval rules → allow. Gateway: `approval_rules`/`rate_limits`/`approvals` tables (migration
0001), §6 Approvals Queue endpoints (`GET /v1/approvals`, `POST /v1/approvals/:id/decide` —
named-approver-only, 403 otherwise), rule CRUD, and proxy `tools/call` enforcement: paused calls
create/reuse one pending queue entry; approved entries are consumed atomically by exactly one
retried call (single-use); usage counting = audit-log allow rows in the limit's window.

**Session 02 continued**: CI added (`.github/workflows/ci.yml` — build + all tests on every
PR/main push against a Postgres 16 service container; PR #2, merged). Then the **real MCP proxy
path** landed (PR #3): `POST /mcp/:serverId` speaks streamable-HTTP MCP on both sides via
`@modelcontextprotocol/sdk` v1.29 (gateway = MCP server to clients, MCP client to upstream) —
`tools/list` auto-syncs the upstream tool manifest into `mcp_tools` (kind inferred from
`annotations.readOnlyHint`, defaulting to write) and filters through `visibleTools()`;
`tools/call` runs the kernel, audits every decision, and only forwards allows upstream. User
identity is an interim trusted header (`x-regulait-user-id`) until real authn lands. E2E-tested
with a real in-process upstream MCP server and real MCP client (26 tests total).

### Wave 9 addendum (2026-08-01) — infra applied, HTTPS live, CI back, power schedule

The owner asked for six things in one message: apply the infra, start powering the AWS box off
when idle, deploy the latest app code, re-enable CI within a 2,000 min/month allowance, clean up
the legacy UI, and get HTTPS live. All are done or in flight, and the route there surfaced three
real defects that had been latent precisely because nothing was exercising them.

**Infra applied (#84's plan, verified `0 add / 2 change / 0 destroy`).** Ports 80/443 opened, the
`:3000` ingress removed. No instance replacement, so the Postgres volume (`vol-0573958930d696417`)
survived — that was the whole point of the #84 landmine fix. **But the apply changed `user_data`,
which the EC2 provider applies by STOPPING AND STARTING the instance**, which released the
auto-assigned public IPv4. The address moved `3.237.199.248` → `98.86.163.252`, and later again to
`3.229.246.126` on Elastic-IP attachment. Worth internalising: *any* `user_data` edit is an
address change on a box whose hostname is derived from its address.

**Defect 1 — the `tls` profile had never once started.** It shipped in #77 and was never exercised
end-to-end. Caddy pins itself to `172.28.0.2` so `REGULAIT_TRUSTED_PROXIES` can name exactly one
container (ADR-0031), but **pinning an address does not reserve it**: Docker allocates dynamically
from the start of the subnet, and Caddy is necessarily last to start (gateway waits on db's
healthcheck, Caddy waits on the gateway). `db` took `172.28.0.2` and Caddy died with
`Address already in use` — which reads as a host *port* conflict, not an IPAM one, with nothing
listening on 80 or 443. Since the gateway is loopback-only since ADR-0029, this left the box with
**no route in at all**. Fixed in #88 with an explicit `ip_range: 172.28.1.0/24` confining dynamic
allocation clear of the pinned address.

**HTTPS is live and verified** (#88 + deploy): Let's Encrypt `CN=3-229-246-126.sslip.io`, `/`→302,
`/ui`→200, `/health`→200, port 80→308 redirect, chain validates. Deploys preserve
`REGULAIT_DATA_KEY` — regenerating it would make every stored credential permanently undecryptable.

**Defect 2 — CI's first run caught a latent test bug.** All **881 tests passed** and the job still
exited 1: `seed.test.ts` tears its scratch database down with `DROP DATABASE ... WITH (FORCE)`,
which force-terminates a connection something still holds, raising Postgres `57P01` as an
unhandled pool error that vitest counts. Latent for weeks *because CI was off*, and it would
red-fail every PR. Being fixed properly rather than suppressed.

**Defect 3 — ADR-0032's `aws:SourceArn` confused-deputy guard does not work** (#90). Every
`CreateSchedule` failed with an error that reads exactly like IAM propagation lag and is not — it
survived four applies over ~30 minutes. Bisected against live API calls: `SourceAccount` alone
passes; `ArnLike` fails; **`ArnLikeIfExists` also fails**, even though tolerating an absent context
key is precisely what that suffix exists for. `CreateSchedule` validates the trust relationship
*before the schedule exists* and satisfies no `SourceArn` condition in any form. Guard dropped,
with the cost stated plainly in the ADR: cross-account is still blocked, intra-account narrowing is
not, and the compensating control is the permission policy (exactly Start/StopInstances on exactly
the passed instance ARNs, no Terminate, no wildcard). **A trap for anyone re-testing: the
validation verdict is cached per-role for a minute or two, so back-to-back probes return the
previous policy's answer.** Two intermediate readings were initially misread that way.

**Power schedule live** (ADR-0032, #87/#90): EventBridge Scheduler → EC2 universal target, no
Lambda and nothing always-on. `ENABLED | start=cron(0 8 ? * MON-FRI *) | stop=cron(0 20 ? * MON-FRI *)
| tz=America/New_York`. **≈$20.43 → ≈$10.67/mo (~48%)** — honestly not more, because EBS bills
whether the box runs or not and the IPv4 charge applies idle or in use; only compute scales with
uptime. `infra/scripts/boot-resync.sh` is installed as a systemd oneshot and re-points Caddy on
every boot; on first run it also re-enabled swap and wrote the `/etc/fstab` entry user-data never
did (cloud-init `scripts-user` is per-*instance*, never per-boot).

**CI re-enabled on a budget** (#86). GitHub bills per job, wall-clock, rounded up, and parallel
jobs bill separately. So: no `push: main` trigger (a PR run already builds the merge commit, so it
was pure duplication), a weekly `schedule` covering what PR runs structurally cannot, docs-only
changes skipped entirely, and `docker-build` self-skipping unless an image-relevant file moved —
**that gate already proved out, finishing in 4 seconds instead of ~5 minutes**. Estimated headroom
~215 PR pushes/month.

**Legacy UI deletion — blocked twice, correctly, then unblocked.** The first attempt was reverted
(`95a3bc1`) because ADR-0026 *asserted* parity with zero evidence and five capabilities were
legacy-only. A rigorous capability diff this session found **six more**: rules deploy-mode scoping,
revocation narrowing, and four run-detail operator controls (manual node dispatch, `reassign_node`,
`node_submitted`, per-node instruction override) — meaning the SPA could only drive a run fully
automatically and could not rescue a stranded node. Closed in #89, which also promoted the checker
into the repo as `scripts/parity-diff.mjs` + `legacy-ui-parity.test.ts`, comparing **three**
dimensions (endpoint shapes, run event kinds POSTed, request-body keys) because an endpoint list
alone cannot see gaps 4–6. It also found the throwaway extractor's comment stripper would eat the
rest of a file on a `text/*` literal — i.e. **it could report false parity**. Deletion follows.

**Legacy UI deleted (ADR-0033, #93) — −7,125 lines.** `admin-portal.ts` (2,583), `app-ui.ts`
(2,841), `ui-theme.ts` (927), plus `check-ui-syntax.mjs`, the `/legacy/*` routes and the tests
that existed only to assert the deleted shells. The parity checker was run on `main` immediately
before deleting and reported zero legacy-only endpoints, run event kinds and request-body keys;
that output is ADR-0033's evidence. Test count 1592 → 1585, and **every one of the seven is an
accounted-for legacy test** — two suites had a legacy assertion *replaced* rather than removed, so
`/legacy/*` is now positively asserted to be gone (401 → 404, never HTML) instead of merely
untested.

Three judgement calls in that PR are worth keeping: **CSP was not weakened** (the inline-script
hashing is shared with the SPA's theme pre-paint script and stays); **`style-src 'unsafe-inline'`
was deliberately left alone** even though ADR-0031's blocker for it is now gone, because a wrongly
tightened `style-src` renders an unstyled page rather than raising an error and needs its own
browser verification; and **the parity gate was deleted along with the thing it guarded**, since
freezing it against a snapshot of a deleted file yields a gate that can only ever pass — worse
than no gate, because it looks like protection. The method it encoded is written into ADR-0033 §1
and the script is recoverable at `a8d2ce9`.

**Standing lesson, restated:** every one of these three defects existed because something shipped
without ever being executed in its real environment — a compose profile never started, a test
suite never run by CI, an IAM policy never applied. Green local tests are not evidence that a
deployment path works.

### Waves 10-11 addendum (2026-08-01) — bring-your-own LLM, and the security work it exposed

The owner asked to "add the ability for users to plug in their own LLM", then for four follow-ups
in sequence. Seven PRs (#95-#101). The feature itself is the smaller half of the story.

**Custom LLM providers (ADR-0034, migration 0048, #95/#97).** BYO *keys* already worked; what did
not exist was a way to name an endpoint the platform ships no adapter for — `provider` was a closed
zod enum of four internet SaaS vendors, so Ollama, vLLM, LM Studio, Azure OpenAI, a Bedrock proxy
and every internal gateway were unreachable, and `agents` had no per-agent endpoint so two
self-hosted models on two hosts was inexpressible. **This also made pillar 3's air-gapped mode
hollow** — a mode whose every supported provider is an internet SaaS is not an air-gapped mode.
Admin-only registration; agents bind by FK (`agents.custom_provider_id` + a DB CHECK making
`provider='custom'` a real discriminated union) rather than by smuggling an id through the
`provider` text column that `model_credentials` keys on and an exhaustive switch depends on. The
adapter implements no protocol of its own — `openai_chat` IS the shared chat-completions core,
`anthropic_messages` IS `AnthropicProvider` — so streaming, refusals and usage accounting are
inherited by construction. Keyless endpoints (local Ollama) are first class: the `Authorization`
header is DELETED, not filled with a sentinel.

**The headline is not the feature. An admin-suppliable `baseUrl` is an SSRF primitive**, and on EC2
it reads the instance role's IAM credentials out of `169.254.169.254`. Building the guard for the
new surface exposed that the *old* ones were never guarded — and worse than first disclosed:
`POST /v1/users/:userId/model-credentials` is in **`NON_ADMIN_ROUTES`**, and a per-user credential
takes **precedence** at dispatch. **Any authenticated user could read this box's AWS credentials.**
Live since per-user BYO keys shipped (migrations 0016/0017). Closed in #96.

**Then the same shape everywhere else (#98).** `connectors.baseUrl` was the sharp one: the
`webhook` kind (and PM's `generic_webhook`) **POSTs the caller's payload** to the URL, so it was an
**exfiltration** channel, not merely SSRF — a governed, audited, cost-attributed pipe to an
attacker's collector. Proven closed by *absence*: a live, listening collector on un-allow-listed
loopback receives **zero requests** and never sees the canary.

**The DNS-rebind window, closed at last (#100).** Three PRs had each disclosed and left it:
validate, then let Node resolve the name a second time at connect. `pinned-fetch.ts` connects
through a `lookup` that resolves nothing and returns the addresses just validated. **The
dependency question was answered NO NEW DEPENDENCY** — Node 22 exports no `undici`/`Agent`, and
both routes to one (a direct dep = a second HTTP stack in the security path; or the undocumented
`globalThis[Symbol.for("undici.globalDispatcher.1")]`) fail the posture `ci.yml` already applies to
third-party actions. `http.request`'s documented `lookup` option gives the whole capability from
stdlib for ~300 lines. **The test performs the attack**: two real TLS listeners on 127.0.0.1 and
127.0.0.2, resolver answering benign-then-attacker; unpinned, the socket lands on the attacker
(asserted on `res.socket.remoteAddress`); pinned, the attacker records zero connections and the
resolver is called exactly once.

**HSTS (#101).** Caddy abstained with a long comment explaining why; the gateway asserted
`max-age=31536000; includeSubDomains` anyway. Two layers disagreeing about a **non-revocable**
browser commitment was the defect. Gateway now owns it (it is what ships into BYOC installs where
no Caddy of ours exists), default `max-age=86400`, no `includeSubDomains`, no `preload`,
configurable via `REGULAIT_HSTS` — deliberately an env var and NOT `org_settings`, because it is a
deployment-shape fact, it is the one setting a server cannot undo, and it is read in the `onSend`
hook that must work when Postgres is down. **ADR-0029's own reasoning was corrected**: its claim
that `includeSubDomains` would be "hostile to everyone else using sslip.io" was overstated — HSTS
is host-scoped. The real argument is better: a released Elastic IP returns to the AWS pool, so a
stranger could inherit our hostname *and* any pin left in browsers.

**Backup: merged, NOT running (ADR-0035, #99).** Nightly verified `pg_dump` to a write-only,
versioned S3 bucket the instance can `PutObject` to but **cannot read or delete**. Restore was
**exercised, not documented** — 70/70 tables matched, scrypt hashes and audit rows byte-identical.
A measured finding worth keeping: on a 90%-truncated dump `pg_restore --list` **exits 0** while an
actual restore yields **0 of 200,000 rows**, so the obvious `--list` check would have blessed and
uploaded a backup containing none of the data. **This is inert until `terraform apply` + a one-time
SSM install. The database still has no backup.**

**Orchestration lesson (mine, not an agent's).** Two agents were run concurrently against the
**same local `regulait_test` Postgres** and one saw broad, unrelated failures from the contention.
`CLAUDE.md` already names per-agent test databases as a convention; the briefs did not enforce it.
Enforce it in the brief, not in the retrospective.

### Enterprise-readiness planning wave (2026-08-01) — 26 Proposed ADRs

Owner asked for a meticulous pending-list and the functionality that makes RegulAIt sellable to
large enterprises, then triaged the resulting gap analysis. The outcome is a tracked plan
([docs/product/ENTERPRISE_READINESS_PLAN.md](../docs/product/ENTERPRISE_READINESS_PLAN.md)) and
**26 Proposed ADRs (0036–0061)** — decisions to pursue, each a starting design proposal that gates
on implementation, none built.

- **NOW (0036–0054):** identity (SAML/SCIM/group-mapping/session-mgmt/ABAC), the BYOC-first
  deployment decision, the two chosen security items (guardrail engine, MCP/OIDC egress), product
  depth (evals, MRM, review workbench, reporting, versioning, cost anomaly, lineage), and
  commercial plumbing (metering/billing, licensing, public API+SDKs, onboarding).
- **CORE, before go-live (0055–0061):** Shadow-AI Discovery, Governance Copilot, continuous
  red-teaming, compliance packs (EU AI Act / NIST AI RMF / ISO 42001), policy-simulation
  blast-radius, tamper-evident audit, ChatOps approvals.
- **DEFERRED (lists, not ADRs):** reliability/ops → `docs/ops/DEPLOYMENT_READINESS_CHECKLIST.md`;
  later security (data-key off the DB volume is the top one) + compliance certification +
  marketplace/docs-portal → the plan's Bucket 3.

**The load-bearing decision is ADR-0041 (BYOC-first):** committing to single-tenant-per-deployment
makes the singleton org the *correct* control-plane architecture rather than a multi-tenant SaaS
rebuild — it turns the single biggest structural "gap" into a non-issue by decision.

**Three hard truths sit above all of it** and are not solved by any ADR here: no real LLM is
connected (key parked); the deployment is a single box (the deployment checklist, parked by owner);
and there is no compliance attestation yet (deferred — though the customer-facing compliance
*packs*, ADR-0058, are core, since selling EU AI Act compliance does not require us to be certified
first).

## Epics
| ID | Name | Status | Related |
|---|---|---|---|
| EPIC-01 | Bootstrap: AWS foundation + GitHub repo + session-continuity scaffold | **done** | ADR-0001–0004 |
| EPIC-02 | Governance layer MVP (§1–§10: MCP/agent/connector governance, infra-ops, compliance cascade, deploy model, Shared Projects, cost dashboard) | **MVP shipped** — all §1–§10 surfaces built and deployed; remaining work is depth, not first-build (see [ROADMAP.md](../docs/product/ROADMAP.md)) | GOVERNANCE_LAYER_SPEC.md, ADR-0007, ADR-0009, ADR-0014 |
| EPIC-03 | Workflow engine MVP | **MVP shipped** — declarative templates, stage machine, executable git/build/check/deploy/rollback stages, 6-dimension assignment matching | WORKFLOW_ENGINE_SPEC.md, ADR-0007, ADR-0018 |
| EPIC-04 | Token/cost optimization MVP (escalated to P0) | **MVP shipped** — all seven techniques live (routing, compaction, lazy tool-loading, prompt caching, edit-vs-rewrite, file preprocessing, semantic caching) + a request-batching estimator; savings measured, not just estimated | TOKEN_OPTIMIZATION_SPEC.md, ADR-0007 |
| EPIC-05 | Multi-agent orchestration MVP (PM/Team-Lead/Worker delegation) | **MVP shipped** — task-graph DAG, governed worker dispatch + auto-advance, tool-using multi-turn workers, transitive entitlement AND budget ceilings | MULTI_AGENT_ORCHESTRATION_SPEC.md, ADR-0008, ADR-0016 |
| EPIC-06 | PM-tool integration MVP (Azure DevOps/Jira/etc.) | **MVP shipped** — the full adapter matrix (ADO, Jira, Linear, Asana, monday, generic webhook) + approval mirroring, decision records, inbound sync; deferral list is empty | PM_TOOL_INTEGRATION_SPEC.md, ADR-0008, ADR-0010 |

## Components
| ID | Name | Status | Related |
|---|---|---|---|
| COMPONENT-01 | AWS security baseline (CloudTrail/GuardDuty/SecurityHub/Config/SCPs/Budgets) | **applied**, zero drift | EPIC-01, ADR-0002 |
| COMPONENT-02 | Identity Center permission sets (Admin-BreakGlass/Deploy-Builder/ReadOnly-Audit) | **applied** (Admin-BreakGlass imported from its manual bootstrap creation, other two created by Terraform) | EPIC-01, ADR-0004 |
| COMPONENT-03 | GitHub OIDC CI role | Terraform authored, intentionally not wired into main.tf/applied (no workload to deploy yet) | EPIC-01 |
| COMPONENT-04 | RegulAIt GitHub repo | **live and private**: https://github.com/dhruvmahendrapatel/RegulAIt | EPIC-01 |
| COMPONENT-05 | Admin portal | **MVP shipped** — single-file API-client portal at /admin (ADR-0012), §6's eight panels + §10.4 cost surface | EPIC-02, ADR-0012 |
| COMPONENT-06 | Policy/allow-list engine (`packages/policy-kernel`) | **shipped** — default-deny kernel over MCP tools, agents, connectors; role grants (UNION-MAX, ADR-0014), per-user revocations, scoped rules, lead ceilings; pure, no I/O | EPIC-02, ADR-0009, ADR-0014 |
| COMPONENT-07 | Dev demo stack on AWS (`regulait-dev-app`) | **live** — EC2 `i-013c62adc887c76bb`, http://3.237.199.248:3000, dev-grade only; teardown = `terraform destroy` | ADR-0013 |
| COMPONENT-10 | Workflow orchestrator (`packages/workflow-kernel` + gateway) | **shipped** — declarative templates, stage state machine, executable git/build/check/deploy/rollback stages, assignment matching | EPIC-03 |
| COMPONENT-11 | Orchestration engine (`packages/orchestration-kernel` + gateway) | **shipped** — task-graph DAG, PM/Team-Lead/Worker delegation, transitive entitlement + budget ceilings | EPIC-05, ADR-0016 |
| COMPONENT-12 | Optimizer (`packages/optimizer-kernel`) | **shipped** — all seven pillar-6 techniques (routing, compaction, lazy tools, prompt caching, edit-vs-rewrite, file preprocessing, semantic caching + batching estimator) | EPIC-04 |
| COMPONENT-13 | Provider packages (model / pm / git / connector / infra) | **partial** — model + PM matrices complete; git is GitHub-only, infra-ops mock-only, several connector kinds 501. See [ROADMAP.md](../docs/product/ROADMAP.md) | — |
| COMPONENT-14 | End-user app (`/app`) | **shipped** — playground, runs, workflows, inbox, projects, spend | EPIC-02 |
| COMPONENT-08 | caveman (output token compression, Claude Code plugin) | **installed**, user scope, no restrictions (verified fully local) | ADR-0005 |
| COMPONENT-09 | graphify (code knowledge graph, Claude Code skill) | **installed**, project scope, restricted to `--code-only` (verified) | ADR-0005 |

## Decisions
See [docs/decisions/README.md](../docs/decisions/README.md) for the full ADR index — that index is
the authority on how many exist and their status; do not restate a count here (this line claimed
"all nine ADRs" long after there were eighteen). All ADRs to date are Accepted; superseding a
decision means a new ADR plus a status flip on the old one, never an edit in place.
ADR-0009 (2026-07-24) chose the product stack: TypeScript
end-to-end — Fastify gateway + official MCP SDK, hand-rolled pure policy kernel (typed
`Decision` object, no OPA/Cedar), Postgres + Drizzle, pnpm-workspace monorepo
(`apps/gateway`, `packages/policy-kernel`, `packages/db`, `packages/shared`).

## Open Questions
None open. OQ-004 fully resolved: (a) caveman + graphify installed and documented (ADR-0005);
(b) standing policy for future scaffolds recorded (ADR-0006, no implementation yet — nothing to
apply it to until EPIC-02/03 produce a first template); (c) full product-feature spec written —
[docs/product/TOKEN_OPTIMIZATION_SPEC.md](../docs/product/TOKEN_OPTIMIZATION_SPEC.md), explicitly
scoped as a standard feature area (not a third P0 pillar), reusing the governance layer's
per-user entitlement system for model routing and the workflow engine's tag mechanism for a new
cost-sensitivity tag — cross-referenced from VISION.md §5.

OQ-001 (region allowlist) defaulted to `["us-east-1", "us-east-2"]` and is applied as the
region-allowlist SCP; OQ-002 (budget cap) resolved to $5/month; OQ-003 (GitHub account) resolved
to personal `dhruvmahendrapatel`.

## Known follow-ups (not urgent, not blocking)
- ~~`planning` is a vocabulary item, not a control~~ **CLOSED 2026-08-15 by
  [ADR-0079](../docs/decisions/0079-plan-only-stage-enforcement.md).** The kernel now RESTS at a
  planning stage (`blocked_on_plan`, left by an explicit `/advance`), an invoke may name an
  `instanceId` (validated on the initiator-or-admin bar), and a mutating mode against an instance
  parked there is refused `409 plan_only_stage` before dispatch, cache or billing. The
  mutating-mode rule is an ALLOW-LIST (`plan/review/chat/ask/read`) so a mode invented later fails
  closed. Honest limits kept in the ADR: attribution is OPT-IN (an invoke naming no instance is as
  unconstrained as before — mandatory attribution would need its own floor decision, like
  ADR-0021's), the rule binds declared intent rather than prompt semantics, and the MCP/compat
  paths carry no instanceId.
- **A deploy-override still has no second party.** ADR-0022's 2026-08-13 amendment made the
  initiator's self-attestation loud (recorded reason + `workflow:deploy-override-attested`), but
  routing the override to a genuine approver is the stronger control and needs a routing policy
  to say *who*.
- **Slice-9/10 findings (2026-08-15), reported not fixed:** (a) `sessionLifetimeHours`
  narrowing is issuance-scoped — an already-issued session keeps its stamped expiry, so a 2h-old
  session survives a 1h narrowing (ADR-0039's revocation levers are the pinned mitigation);
  (b) a failed PM approval-mirror is surfaced in the decide response (`pmMirror.ok=false`) but
  not persisted as a retryable marker — reconciliation currently rides drift detection.
- **Two pillar-6 savings-semantics questions (slice-5 probe, 2026-08-15), deliberately not decided in code:**
  (a) a semantic-cache HIT on a budget-blocked project is served (the cache sits before the
  budget gate) — $0 spend, but the `semantic_caching` savings row claims an avoided dispatch
  that would itself have been refused; (b) decision-only invokes write a `model_routing`
  estimate row with savings although nothing dispatches (pinned behaviour). Both are honest
  as estimates, misleading if the dashboard is ever read as "realized savings" — an owner
  call on reporting semantics, not a code defect.
- ~~Deployment-wide PII floor for unattributed dispatches~~ **RESOLVED 2026-08-13** — owner said
  build it. ADR-0021 amendment: `defaultPiiMode` now governs wherever no compliance framework
  does, including unattributed model/connector/MCP/cache/streaming/training-ingest calls.
  Default stays `none` (behaviour-preserving); one `PUT /v1/org/settings` turns the floor on.
- Security Hub's default standards enabled **both** AWS Foundational Security Best Practices and
  CIS AWS Foundations Benchmark v1.2.0 (the latter wasn't explicitly requested — AWS enables it
  by default alongside FSBP). Harmless; disable the CIS subscription later if its findings become
  noise.
- `infra/modules/aws-security-baseline`'s Config aggregator authorization assumes `us-east-1`
  only (single-region aggregation) — revisit if resources start landing in `us-east-2`.
- The forecasted (not actual) monthly spend shown in `aws budgets describe-budgets` was ~$1.21 at
  last check — almost entirely the two KMS CMKs (state bucket + CloudTrail). Nothing alarming
  against the $5 cap, but worth a glance next session.

**Enterprise-readiness build wave — identity + policy, 2026-08-02 (session-06).** The owner said
"start building the ADRs", turning the 0036–0061 planning set from a document into a work queue.
Six shipped in order, each its own migration, its own agent, and its own full-suite gate; the
gateway suite went **1,004 → 1,191** with zero regressions and the policy kernel **93 → 129**.

| ADR | Commit | Migration | What it makes true |
|---|---|---|---|
| 0043 | `59fef61` | 0049 | `mcp_servers.url` + `oidc_providers.issuerUrl` inside the egress guard — **every** admin-typed outbound URL is now behind one guard, one table, one pinned transport |
| 0039 | `0358b64` | 0050 | Per-session revocation, self-service device list, `last_seen_ip`, org CIDR envelope (`off`/`at_login`/`continuous`) with a separate API-key knob |
| 0036 | `a5e3216` | 0051 | SAML 2.0 SSO beside OIDC, `@node-saml/node-saml`, pinned-cert verification, replay seen-set, IdP-initiated opt-in |
| 0037 | `ab4d308` | 0052 | SCIM 2.0 `/scim/v2` — provisioning and, critically, **instant IdP-driven deprovisioning** as `disabledAt`, never a delete |
| 0038 | `4469d20` | 0053 | IdP group → role mapping: default-deny, additive, reconciled not accumulated |
| 0040 | `3351839` | 0054 | In-process Cedar ABAC on the kernel **allow path only** — can forbid or require approval, can never grant |

Five judgment calls worth remembering, because each one chose the safe side over the conventional
one:
1. **SCIM re-POST of an existing email returns 409, not the RFC-conventional 200-with-existing.**
   A 200 would let an IdP-driven create silently *adopt* a pre-existing local account — including
   an admin's. Refusal is audited as a deny.
2. **A role held both directly and via a group is two rows**, keyed by a composite unique including
   `origin`. The reconciler's `DELETE` is scoped `origin='group'`, so losing an admin's direct
   grant is *structurally* impossible rather than merely avoided by correct code.
3. **Missing groups claim ≠ empty groups claim.** An assertion that omits the claim means "no
   signal, do not reconcile"; an explicitly empty array means "member of nothing, reconcile to
   zero". Conflating them turns an IdP hiccup into an org-wide access strip.
4. **node-saml checks neither the assertion `Recipient` nor the login-Response issuer** (it pins
   `idpIssuer` only for logout). Both are checked in our code, against the assertion the library
   already signature-verified, so no new signature-wrapping surface is created. Its
   `acceptedClockSkewMs: -1` escape hatch — which disables timestamp checks entirely — is
   unreachable from config; skew is clamped to 0–9 minutes.
5. **The SAML correlation cache is the database**, not node-saml's in-memory default, which would
   fail *open* across a restart or a second process.

**A latent suite order-dependency was found and fixed at the source (`19d65b3`).** `saml.test.ts`
created ~30 enabled providers and deleted none; when vitest's duration-ordering cache happened to
run it before `auth.test.ts`, the ADR-0036-generalized `sso_only` guard returned 200, the assertion
failed *before* the test could turn `ssoOnly` back off, and every subsequent password login 403'd —
~20 unrelated failures cascading from one leak. Both files now snapshot/restore the org singleton
and delete the providers they create; auth's `sso_only` block establishes its own precondition
instead of inheriting a fresh DB. Proven by reproducing the exact cross-file order (22 failures
before, green after). **The general lesson: any test touching the `ORG_SETTINGS_ID` singleton must
restore it, because adding any new test file reshuffles the order and can surface this.**

**The wave completed and deployed, 2026-08-02→03 (session-06, PR #105 `27205e7`).** All 26 ADRs
(0036–0061) built across migrations 0049–0073; suite **1,004 → 1,611** across 100 files with no
regression. Merged to `main` and **deployed to the dev box** — 73 migrations applied, live at
`https://3-229-246-126.sslip.io/ui` on a valid Let's Encrypt certificate, login verified
end-to-end over the public URL.

Three things from the back half worth carrying forward:

1. **ADR-0060's own §1 was wrong, and the implementation says so.** Specifying `prev_hash` as the
   predecessor's `content_hash` builds *adjacent pairs*, not a chain — a deep edit plus a full
   recompute lands on an identical head and the anchor catches nothing, contradicting the ADR's
   own worked example. Built as the predecessor's `row_hash`, with the correction in the
   amendment. **An ADR is a decision, not scripture; implementing one is also reviewing it.**
2. **Parallel agents were a net loss and the record should say so.** Running two agents on one
   repo bought perhaps an hour across the final four ADRs and cost a wasted suite run, a merge
   repair, and — worst — a **defective commit reaching the remote**: `d61c5c8` was built from an
   index predating `16174e8`, so it silently deleted 1,127 lines of ADR-0058 while appearing only
   to add ADR-0059. Both agents detected the damage themselves and reported it accurately; the
   push was the main session's error. Repaired by re-applying the corrected content onto the clean
   sibling, resolving `schema.ts` as a union, hand-inserting journal entry 71 in `when`-ascending
   order, and force-with-lease over the bad tip after proving the new HEAD was a strict superset.
   **The file-partition strategy holds for isolated modules but not for the half-dozen files every
   slice must touch, and git's index is not partitionable that way. Prefer sequential.**
3. **A near-miss on false reporting.** An isolation run appeared to show the merge breaking
   `workflow-stage-quorum.test.ts` — until it turned out the merged tree had been re-tested against
   the database that had just run the full suite, while the baseline got a fresh one. On a
   genuinely fresh database it passed 5/5. **When a comparison implicates your own change, check
   that both sides were actually given the same conditions before reporting a regression.**

Two suite-hygiene fixes landed as a side effect: the vitest default 5s timeout was too tight for
~1,600 sequential real-Postgres e2e tests (raised to 20s — deliberately not "no timeout", so a hung
request still fails), and `saml.test.ts` was leaking ~30 enabled SSO providers that cascaded into
~20 unrelated failures depending on vitest's duration-ordering cache.

**What is NOT built** is tracked in
[docs/product/PENDING.md](../docs/product/PENDING.md) — read that before planning the next session.

## Standing guardrail
Nothing gets a "production" designation, and nothing deploys to one, without the user's direct,
explicit sign-off in that session. See [CLAUDE.md](../CLAUDE.md).
