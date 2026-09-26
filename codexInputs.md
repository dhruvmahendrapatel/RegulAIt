# Codex review findings and implementation handoff

<!-- codex-enterprise-feedback:start -->
## Automated enterprise-readiness feedback

### Baseline run — 2026-09-06 21:38:07 -05:00

**Reviewed range:** `2c90396..0a7a4c254496c629cf62f69b6286f7997f159ea1`  
**Branch/upstream:** `claude/status-check-2gbrwf` / `origin/claude/status-check-2gbrwf`  
**Synchronization:** `git pull --ff-only` succeeded; local and upstream both resolve to
`0a7a4c254496c629cf62f69b6286f7997f159ea1`. The only pre-existing worktree item was this
untracked `codexInputs.md`; it was preserved.

**Delta:** one commit, `feat(mcp): gate paid tool calls on the project budget`, changing
`apps/gateway/src/mcp-proxy.ts` and `apps/gateway/src/orchestration.ts` (+99/-2). The change
reuses `preDispatchProjectGate` inside the shared MCP execution primitive and maps its new
`budget_blocked` outcome in both direct MCP and delegated-worker surfaces.

**Verification performed**

- `git diff --check 2c90396..HEAD` — passed.
- Source search confirmed the new production gate and outcome handling, but found no new or
  changed test and no ADR-0103 document/index/state entry in the commit.
- `pnpm --filter @regulait/gateway typecheck` — **not executed successfully**. The available
  Codex pnpm runtime attempted dependency bootstrap with pnpm 11.19.0 although the repo declares
  pnpm 10.33.0, then refused ignored dependency build scripts. A direct `tsc` invocation was
  non-diagnostic because workspace packages were not linked/built. The bootstrap's incidental
  tracked-file changes were removed; no product file was changed. This is an environment/setup
  limitation, not evidence that the commit fails typecheck.

#### AER-001 — HIGH — Budget enforcement landed without its required evidence/decision set

**Evidence type:** observed in the pulled commit.

The commit changes a material governance boundary and cites **ADR-0103** at
`apps/gateway/src/mcp-proxy.ts:163,384,1101` and
`apps/gateway/src/orchestration.ts:1108`, but the ADR sequence still ends at
`docs/decisions/0102-operator-prose-credential-scrub.md`. The commit changes only two production
files: no regression test, ADR, ADR-index row, `STATE.md` update, or session record accompanied
it. That conflicts with the repo's decision/evidence discipline and leaves the claimed
pre-upstream enforcement unproved. PR #108's description also still says “303 commits” and
ADRs through 0102, so its review surface no longer describes its head.

**Impact:** a budget-control change can regress either direct MCP or delegated execution without
the gate noticing. The missing ADR also leaves ordering semantics—entitlement, compliance,
budget, approval, PII, guardrails—and unattributed behavior documented only in mutable comments.

**Recommended remediation:** complete the repo's normal decision set and add adversarial tests
before presenting F02 as closed. Do not merely test the returned error.

**Acceptance evidence required:**

1. For an attributed priced tool on an exhausted blocking project, both direct MCP and delegated
   worker paths return a budget refusal; an instrumented fake upstream sees **zero** calls;
   usage/cost stays unchanged; no action approval is queued or consumed.
2. `warn_only` still calls and meters the upstream, while compliance-forced `block` overrides
   the org warning mode.
3. A sanctioned active overage permits execution.
4. Unattributed behavior remains deliberate and unchanged, with metering in the null-project
   bucket.
5. Audit and trace rows report the refusal without leaking arguments and without claiming the
   tool executed.
6. A negative/non-vacuity test proves removing or bypassing the new gate makes the suite red.

#### AER-002 — MEDIUM — “Paid tool calls” wording does not match the implemented predicate

**Evidence type:** source observation; product intent needs a decision.

`pricePerCallUsd` is resolved at `apps/gateway/src/mcp-proxy.ts:316` and copied into the denial
audit detail, but it is not used to decide whether the new gate runs. The unconditional call at
`apps/gateway/src/mcp-proxy.ts:416` means an exhausted project blocks attributed tools priced
`null` or `0` as well as paid tools. That may be the intended “stop all project activity”
contract—`preDispatchProjectGate` itself says “further attributed dispatches”—but it conflicts
with the commit title/comments' narrower paid-spend rationale.

**Impact:** operators may lose free/remediation/read-only tooling after a budget exhaustion, or
documentation may promise a narrower control than the system enforces.

**Recommended remediation:** decide explicitly whether a project budget is (a) a spend admission
control covering only calls with positive price, or (b) a project-wide dispatch freeze after the
threshold. Align the ADR, UI/operator wording, and code; test `null`, `0`, inherited server
price, and per-tool override cases.

#### AER-003 — MEDIUM — The clean-checkout verification path is not reproducible in this host

**Evidence type:** reproduced tooling/setup failure, not a product-code failure.

The repository declares pnpm 10.33.0, while the available automated path used pnpm 11.19.0,
rewrote lock/workspace metadata, downloaded dependencies, and stopped on
`ERR_PNPM_IGNORED_BUILDS` before typecheck. Because local verification is documented as the
only gate while GitHub Actions is exhausted, an enterprise-readiness loop needs a pinned,
non-interactive clean-checkout bootstrap that does not mutate tracked dependency policy.

**Acceptance evidence required:** on a clean checkout, one documented command installs with the
declared pnpm version and approved build-script policy, leaves `git status --short` clean, and
runs typecheck/build plus a deliberately failing control proving the gate propagates failure.

**Prior-finding reconciliation**

- **F02:** implementation is now present at the shared MCP primitive, but remains **open /
  unverified** pending AER-001 acceptance evidence.
- **F03:** still open; this commit reuses measured-spend, first-crossing-allowed semantics and
  does not add transactional spend reservations.
- **F04:** superseded by ADR-0102 and the current source claim, but not independently rerun in
  this baseline. Treat as repository-reported resolved until its tests are reproduced.
- **F01:** unchanged and still open; no commit in this reviewed range addressed the
  nondeterministic socket-teardown/test-exit issue.

### Follow-up run — 2026-09-07 07:37:18 -05:00

**Reviewed range:** `0a7a4c254496c629cf62f69b6286f7997f159ea1..271bdcadd20d66e4419bde3a08045a6639a18ff5`  
**Branch/upstream:** `claude/status-check-2gbrwf` / `origin/claude/status-check-2gbrwf`  
**Synchronization:** the worktree had no tracked modifications; `git pull --ff-only` advanced
both local and upstream from `0a7a4c2` to `271bdca`. The pre-existing untracked
`codexInputs.md` was preserved.

**Delta:** four commits add the F02 budget-path decision and tests, make one EU-tier test query
deterministic, and correct the test-flake attribution in `PENDING.md`.

**Verification performed**

- `git diff --check 0a7a4c254496c629cf62f69b6286f7997f159ea1..HEAD` — passed.
- `pnpm --filter @regulait/gateway typecheck` — passed (`tsc -p tsconfig.json --noEmit`).
  The available host still used pnpm 11.19.0 rather than the repository-declared pnpm 10.33.0,
  warned that `package.json`'s `pnpm.overrides` was ignored, and rewrote `pnpm-lock.yaml` metadata.
  That command-induced lockfile change was restored to HEAD; no product file was changed.
- The new database-backed `mcp-project-budget.test.ts` was **not run** because this host has no
  explicit disposable `DATABASE_URL`. The full-suite counts recorded in `PENDING.md` are therefore
  repository-reported evidence, not independently reproduced by this run.

#### AER-001 — SOURCE-CLOSED / RUNTIME-UNVERIFIED — Required decision and adversarial tests landed

`docs/decisions/0103-mcp-path-project-budget-gate.md` now states the gate position, null-project
treatment, unpriced-tool treatment, measured-spend semantics, and the still-open concurrency
limit. `apps/gateway/src/mcp-project-budget.test.ts` covers direct MCP and delegated-worker paths,
uses independent HTTP/tool counters to prove zero upstream contact on a block, checks zero MCP
usage, checks the audit denial, and pins unchanged `warn_only`, unattributed, and under-budget
behavior. The ADR is indexed. This closes AER-001's missing-evidence-set finding **in source**;
the new integration test still needs execution on a disposable database before calling the
runtime behavior verified.

#### AER-002 — RESOLVED BY DECISION — Project exhaustion freezes attributed dispatches

ADR-0103 explicitly chooses the broader contract: an unpriced tool on an exhausted project is
blocked because the gate keys on project spend, not the current call's price. The new test pins
that behavior. Product/UI language should consistently describe a project dispatch freeze rather
than a paid-call-only gate.

#### AER-003 — OPEN — Verification host still violates the pinned package-manager contract

Typechecking now completed, but only after pnpm 11 re-resolved the workspace, ignored the root
override location, and dirtied the lockfile. A clean-checkout gate must invoke the declared pnpm
10.33.0 without rewriting dependency policy. Treat this as a reproducibility/supply-chain issue,
not as evidence that the new code fails typechecking.

**Prior-finding reconciliation**

- **F01:** partially improved. Commit `0ebfabe` fixes one independent unordered-query flake.
  The intermittent `socket.destroySoon` teardown exception remains open, and the repository now
  records a needed sweep of raw `db.select()` results indexed with `.at(-1)` without `ORDER BY`.
- **F02:** source-closed by ADR-0103 and its adversarial test definition; runtime-unverified here.
- **F03:** open by explicit ADR-0103 limitation. The budget is measured-spend with first crossing
  allowed, not a transactional reservation; concurrent in-flight calls can overshoot.

### Scheduled run — 2026-09-07 17:58:25 -05:00

**Reviewed range:** `271bdcadd20d66e4419bde3a08045a6639a18ff5..28c400c0659e274c9b9aacdb668cba7a0b6a3821`  
**Branch/upstream:** `claude/status-check-2gbrwf` / `origin/claude/status-check-2gbrwf`  
**Synchronization:** `git pull --ff-only` advanced the local branch from `271bdca` to
`28c400c`; local HEAD and upstream now agree. The pre-existing untracked `PathForward.md` and
`codexInputs.md` were preserved, and there are no tracked worktree modifications.

**Delta:** eight commits (+1844/-22 across 19 files) implement ADR-0104 approval payload binding,
add migration 0106, add unit and database-backed gateway tests, close B13a/B13b in the state
record, correct an earlier test-evidence claim, and incorporate Codex/PathForward review items into
the enterprise-readiness plan.

**Verification performed**

- `git diff --check 271bdcadd20d66e4419bde3a08045a6639a18ff5..HEAD` — passed.
- `node_modules/.bin/vitest.cmd run packages/shared/src/approval-binding.test.ts` — passed: 1 file,
  14 tests.
- `node_modules/.bin/tsc.cmd -p apps/gateway/tsconfig.json --noEmit` — passed.
- ADR/index and migration/journal consistency checks passed: 104 ADR files / 104 index rows; 106
  journal entries with unique, ascending indices and timestamps; migration 0106 is represented in
  both schema and journal.
- The new database-backed gateway test was **not run** because `DATABASE_URL` is unset. Its results
  in repository records remain repository-reported, not independently reproduced here.

#### AER-004 — HIGH — Payload binding is not policy binding, and approvals do not expire

**Evidence type:** observed in current source; exploit-path acceptance test is required.

ADR-0104 correctly binds a single-use approval to the project and canonical call arguments. The
fingerprint contains only `{projectId, arguments}`
(`packages/shared/src/approval-binding.ts:97-110`). Candidate selection matches only the requester,
server, tool, and `approved` status, then selects by that arguments digest
(`apps/gateway/src/governed-evaluate.ts:223-247,410-412`). Although an approval row stores `ruleId`,
`approverUserId`, and decision timestamps, it stores neither a current policy/config identity nor an
approval expiry (`packages/db/src/schema.ts:1205-1234`). The decision path checks the approver saved
on the queued row and atomically moves a pending row to the requested decision, but does not
re-evaluate that MCP approval against the current rule body/version or current required approver
(`apps/gateway/src/app.ts:2702-2743,2792-2803`). Consumption similarly checks only row id plus
`approved` status (`apps/gateway/src/mcp-proxy.ts:593-603`).

**Impact:** consent queued and approved under rule/configuration A can remain spendable after the
active governance configuration changes to stricter rule B or a different required approver,
provided user/server/tool/project/arguments are unchanged. An approved but unconsumed row can also
remain usable indefinitely. This is an authorization time-of-check/time-of-use and stale-consent
gap: the action is payload-identical, but the policy and human authority governing it may no longer
be the same.

**Recommended remediation:** define a canonical consent-context identity and expiry contract. At
minimum bind the approval to the applicable current rule identity/body version, active config
version, required approver set, and security-relevant deploy/compliance context; define which
policy changes invalidate consent. Store that identity and an explicit expiry, rederive immediately
before execution, and atomically consume only when action digest, context identity, approved status,
and expiry all still match. Supersede or expire stale rows visibly rather than silently ignoring or
reusing them. Keep ADR-0104's explicit `tool`-scope escape hatch separate and visibly weaker.

**Acceptance evidence required:**

1. Queue and approve an action under rule/config A; activate a stricter version or change the
   required approver; retrying the identical payload must fail closed and contact the upstream zero
   times.
2. An approval past its configured TTL cannot execute and is reported as expired/superseded, not
   consumed.
3. A policy change classified as harmless follows the explicitly documented compatibility rule;
   a security-relevant change always requires reapproval.
4. The final match and consume are atomic so concurrent calls and a concurrent policy activation
   cannot spend stale consent.
5. Audit evidence records the action digest, consent-context identity/version, expiry outcome, and
   old-row disposition without leaking raw arguments.

**Prior-finding reconciliation**

- **F05:** payload/project binding is source-implemented and its pure tests passed here, but F05 is
  only **partially closed** because policy/approver freshness and expiry remain open as AER-004.
- **AER-001 / F02:** the source evidence is stronger and repository records report the DB-backed
  journey passing; it was not rerun here without a disposable database.
- **AER-003:** unchanged. This run deliberately used the installed direct binaries and did not
  invoke the mismatched pnpm bootstrap.
- **F01:** the intermittent `socket.destroySoon` teardown issue remains open.
- **F03:** concurrent budget-reservation semantics remain open.

### Scheduled run — 2026-09-19 10:28:46 -05:00

**Reviewed range:** `28c400c0659e274c9b9aacdb668cba7a0b6a3821..a6a855ad1886bb5ed246a34b355e23070a17c24f`  
**Branch/upstream:** `claude/status-check-2gbrwf` / `origin/claude/status-check-2gbrwf`  
**Synchronization:** the worktree had no tracked modifications. `git pull --ff-only` advanced
the branch to `a6a855ad1886bb5ed246a34b355e23070a17c24f`; local HEAD and upstream agree.
The pre-existing untracked `PathForward.md` and `codexInputs.md` were preserved.

**Delta:** 47 commits, 81 files (+12,274/-821). The range adds ADR-0105 through ADR-0114,
migrations 0107 through 0109, consent-context binding and expiry, deterministic-read and
unique-constraint work, backup lifecycle/pre-flight work, credential presentation scrubs, Teams
outbound delivery, and the current eval-result scrub implementation.

**Verification performed**

- `git diff --check 28c400c0659e274c9b9aacdb668cba7a0b6a3821..HEAD` — passed.
- `corepack pnpm --version` — `10.33.0`, matching `packageManager`.
- `corepack pnpm -r build` — passed for all 15 selected workspace projects. The web build emitted
  its existing >900 kB chunk warning; no tracked file changed.
- `corepack pnpm -r exec tsc --noEmit` — passed.
- `..\\..\\node_modules\\.bin\\vitest.cmd run src\\mock-socket-contract.test.ts`, run
  from `apps/gateway` so its `vitest.config.ts` setup file is active — passed: 1 file / 3 tests.
- A first root-level targeted invocation,
  `node_modules/.bin/vitest.cmd run packages/shared/src/approval-binding.test.ts packages/connector-provider/src/index.test.ts apps/gateway/src/mock-socket-contract.test.ts`,
  passed the 70 connector-provider and 23 approval-binding tests but failed 2/3 MockSocket tests
  because invoking Vitest from the root bypassed the gateway workspace's required `setupFiles`.
  The correct workspace invocation above passed; this false start is not a product failure.
- A direct pre-build `node_modules/.bin/tsc.cmd -p apps/gateway/tsconfig.json --noEmit` failed
  with unresolved workspace-package declarations. The repository's documented ordering is build
  first, then source typecheck; that exact sequence passed above. This false start is likewise not
  a source failure.
- ADR/index consistency passed: 114 numbered ADR files, max 0114, no missing/duplicate number and
  no missing/orphan index row. Migration/journal consistency passed: 109 SQL files, max 0109, 109
  matching journal tags and no duplicate number.
- `DATABASE_URL` is unset. No database-backed test or full suite was run. ADR-0105/0109/0110/0115
  runtime claims and the full-suite totals in repository records remain repository-reported
  evidence, not independently reproduced by this run.

#### AER-004 — PARTIALLY RESOLVED / HIGH RESIDUAL — Context binding landed, but accepted stale-consent paths and the atomicity claim remain

**Evidence type:** source observation plus the ADR's own disclosed limits; database-backed exploit
paths were not rerun here.

ADR-0105 materially improves the control: the digest binds matched approval-rule ids and active
version ids, the currently required approver, and approval scope
(`packages/shared/src/approval-binding.ts:246-256`;
`apps/gateway/src/governed-evaluate.ts:527-547`). Candidate selection retires a non-null mismatched
digest or elapsed expiry (`apps/gateway/src/governed-evaluate.ts:564-595`), and consumption now
atomically compares action digest, the supplied context digest, expiry, id and status
(`apps/gateway/src/mcp-proxy.ts:805-819`).

The original high-severity finding is nevertheless not fully closed:

1. A pre-0107 approved row with `context_digest IS NULL` is explicitly accepted, and
   `expires_at IS NULL` never expires (`apps/gateway/src/governed-evaluate.ts:568-572`;
   `apps/gateway/src/mcp-proxy.ts:797-816`; `packages/db/src/schema.ts:1245-1262`). ADR-0105
   calls this the weaker choice and says such a row can still be spent after policy changed
   (`docs/decisions/0105-consent-context-binding-and-expiry.md:192-203,241-246`).
2. The digest is computed from an earlier in-memory policy snapshot, not re-derived in the SQL
   UPDATE. ADR-0105 admits that activating a version after the snapshot but before the UPDATE can
   allow one request under the old policy
   (`docs/decisions/0105-consent-context-binding-and-expiry.md:247-253`). This directly contradicts
   `project-state/STATE.md:502-505`, which says both facts are re-derived inside the UPDATE and
   therefore “nothing can be checked good and spent bad.”
3. A pure ABAC `require_approval` policy has no rule/version identity in the digest. Editing that
   policy does not invalidate consent unless the required approver changes; ADR-0105 records this
   as a genuine hole (`docs/decisions/0105-consent-context-binding-and-expiry.md:259-263`).
4. Operators may deliberately set the TTL to `NULL`, restoring never-expiring MCP consent
   (`docs/decisions/0105-consent-context-binding-and-expiry.md:125-131`).

**Impact:** an approved legacy row, a concurrent policy activation, or a pure-ABAC policy edit can
still authorize one or more calls on consent that no longer represents current governance. The
status record overstates the implementation's guarantee, so reviewers may approve the boundary on
a property the code and ADR explicitly do not provide.

**Recommended remediation:** correct the STATE/claim text immediately to the actual snapshot-bound
guarantee. For the control, fail closed on null context for approved MCP rows (supersede and
re-queue rather than invent a digest), include ABAC policy identity/version in the canonical
context, and add a database-verifiable policy epoch/version predicate to the atomic consume
statement or otherwise close the activation race without a global hot-path lock. Treat a null TTL
as an explicit high-risk exception with visible posture, not an ordinary silent setting.

**Acceptance evidence required:**

1. A pre-0107 approved MCP row with null context cannot execute after a policy change; upstream
   count stays zero and the row is visibly superseded/re-queued.
2. A barrier-controlled test evaluates under policy A, pauses before consume, activates B, then
   resumes; the A consent must not execute and the fake upstream sees zero calls.
3. Editing only the governing ABAC policy invalidates the prior consent.
4. Null-TTL behavior is either refused for exact-action consent or exposed as a named high-risk
   posture in API/UI/operator evidence.
5. Run these tests on a fresh explicitly disposable database and include a negative control that
   reddens when the epoch/context predicate is removed.

#### AER-005 — MEDIUM — HEAD implements and cites ADR-0115, but the decision/evidence set is absent

**Evidence type:** current-HEAD source and repository-record mismatch.

Commit `a6a855a` adds an `adr0115-eval-result-scrub.test.ts` and labels the generalized
presentation scrub “ADR-0115” (`apps/gateway/src/adr0115-eval-result-scrub.test.ts:31`;
`apps/gateway/src/conversation-presentation.ts:139`). The decision directory and index end at
0114, while `docs/product/PENDING.md:162-164` still says S22 is unassessed. No current STATE entry
describes the choice to retain eval/red-team defeat evidence with credentials at rest while
redacting selected presentation routes.

**Impact:** this is a material security/data-handling decision, not merely a refactor. Without the
decision, route inventory, storage/export/backup implications, operator rotation procedure and
claimed test evidence are split across code comments and an unexecuted DB test. The backlog
simultaneously claims the work has not been assessed.

**Recommended remediation:** complete ADR-0115, index it, reconcile S22 and STATE, and enumerate
every read/copy/export surface plus the explicit at-rest limitation. Keep the current commit's
honesty that evidence fidelity and secret-at-rest exposure are a deliberate tradeoff.

**Acceptance evidence required:** ADR/index/state/backlog agree; the DB-backed synthetic-secret
test runs on a fresh disposable database; raw storage fidelity, covered route redaction, error
write-scrub, copy surfaces, replay/provider behavior, and an unprotected-route negative control are
each demonstrated separately.

**Prior-finding reconciliation**

- **AER-001 / F02:** source-closed; build/typecheck passed here, but its database-backed execution
  journey was not rerun.
- **AER-003:** source-closed and locally improved: README now gives a pinned clean-checkout
  sequence, Corepack selected pnpm 10.33.0, and its build/source-typecheck stages passed. This run
  did not repeat a frozen clean install or the database stages.
- **F01:** ADR-0106's MockSocket contract test passes when invoked through the gateway workspace,
  but F01 remains open because `docs/product/PENDING.md:264-300` records the unrelated,
  still-undetermined order-dependent `compat-longtail.test.ts` 500 (S8).
- **F03:** unchanged and open; spend admission remains measured-spend rather than a transactional
  reservation.
- **AER-004:** do not mark resolved from ADR-0105's headline. The narrower implementation is real,
  but its accepted legacy, snapshot-race, ABAC and null-TTL residuals remain as above.
### Scheduled run — 2026-09-19 15:29:21 -05:00

**Reviewed range:** `a6a855ad1886bb5ed246a34b355e23070a17c24f..d557d25a6544aeb3eb4b1a6d7ce90bb7fb24d264`  
**Branch/upstream:** `claude/status-check-2gbrwf` / `origin/claude/status-check-2gbrwf`  
**Synchronization:** the pre-pull worktree had no tracked modifications. `git pull --ff-only`
advanced the branch through four commits; local HEAD and upstream now both resolve to
`d557d25a6544aeb3eb4b1a6d7ce90bb7fb24d264`. The pre-existing untracked `PathForward.md` and
`codexInputs.md` were preserved.

**Delta:** 4 commits, 7 files (+891/-3). ADR-0115 and its index/state/backlog/checklist records
landed, and a 556-line international-identifier detector draft landed in `packages/shared` with an
explicit commit-level warning that it is not wired or tested.

**Verification performed**

- `git diff --check a6a855ad1886bb5ed246a34b355e23070a17c24f..HEAD` — passed.
- `corepack pnpm -r build` — passed for all 15 selected workspace projects. The web build emitted
  the existing >900 kB chunk warning.
- `corepack pnpm -r exec tsc --noEmit` — passed.
- `corepack pnpm --filter @regulait/shared test` — passed: 36 files / 806 tests. This suite has no
  `pii-conformance.test.ts` and does not import the new international module, so the green result
  proves the existing package suite, not the new algorithms.
- A local no-I/O Node probe imported `packages/shared/dist/pii-international.js`, generated a
  checksum-valid synthetic Aadhaar-shaped value using the detector itself, and compared the bare
  value with the same value separated after every digit. Result: `bareCount=1`,
  `everyDigitSpacedCount=1`; importing `packages/shared/dist/index.js` also confirmed
  `INTERNATIONAL_DETECTORS` is not publicly exported.
- ADR/index consistency — passed: 115 numbered ADR files through 0115; 115 index rows; no missing,
  duplicate or orphan number. Migration/journal consistency — passed: 109 SQL migrations through
  0109 and 109 matching journal tags, with no missing/orphan/duplicate tag.
- `DATABASE_URL` is unset. No database-backed ADR-0115 test and no full database suite was run.
  STATE's `180 files / 2753 passed / 9 skips` result remains repository-reported evidence.
- Final `git status --short --branch` showed only the same two untracked feedback documents; no
  tracked file was changed by verification.

#### AER-004 — UNCHANGED / HIGH RESIDUAL — Approval context still accepts stale-consent paths and the atomicity claim remains overstated

**Evidence type:** current-source recheck plus ADR-disclosed limits; runtime not reproduced in this
run. None of the four pulled commits touched the approval evaluation/consumption paths.

The current source still accepts a null context digest and treats null expiry as never expiring
(`apps/gateway/src/governed-evaluate.ts:564-585`; `apps/gateway/src/mcp-proxy.ts:797-816`;
`packages/db/src/schema.ts:1245-1262`). ADR-0105 still records the one-request snapshot/activation
window and the pure-ABAC identity gap
(`docs/decisions/0105-consent-context-binding-and-expiry.md:241-263`). The status record still says
both facts are re-derived inside the consuming UPDATE and therefore nothing can be checked good and
spent bad (`project-state/STATE.md:542-543`), while the ADR says the digest comes from an earlier
snapshot. Impact, remediation and the five acceptance tests in the preceding AER-004 entry are
unchanged. Do not close this finding from build/typecheck success.

#### AER-005 — PARTIALLY RESOLVED / LOW RESIDUAL — ADR-0115 landed, but PENDING still says S22 is unassessed

**Evidence type:** direct documentation/source observation; runtime evidence remains
repository-reported.

The material absence is closed in source: ADR-0115 now exists, is indexed
(`docs/decisions/README.md:123`), S22 has a closed entry (`docs/product/PENDING.md:162-170`), the
operator checklist has the storage/presentation split (`docs/product/TESTING_CHECKLIST.md:123`),
and STATE records the decision (`project-state/STATE.md:24-55`). However, the immediately preceding
S14 residual list still says `eval_results.output_text` "remains unassessed" and points to S22 as
open (`docs/product/PENDING.md:150-160`). One current backlog page therefore asserts both states.

**Impact:** the security decision is now reviewable, but an agent or release reviewer can still
re-open completed work or conclude that the eval surface has no assessed handling. The runtime
claims cannot be promoted beyond repository-reported evidence because the database test was not
rerun here.

**Recommended remediation:** update S14 residual (2) to say ADR-0115 assessed and closed it, while
retaining ADR-0115's explicit at-rest exposure. Then rerun
`apps/gateway/src/adr0115-eval-result-scrub.test.ts` on a fresh disposable database.

**Acceptance evidence required:** one search of `PENDING.md` yields no live statement that S22 is
unassessed; ADR/index/STATE/PENDING/checklist agree; the 13-test ADR-0115 file passes on an isolated
database with its raw-storage, presentation-route, write-scrub and negative controls intact.

#### AER-006 — MEDIUM — The dormant international-PII draft cites evidence and formatting limits that do not exist yet

**Evidence type:** source observation plus reproduced local behavior. This is a pre-integration
blocker, not a claim that current dispatches enforce these detectors.

Commit `3d967a0` honestly labels the file "NOT WIRED IN, NOT YET TESTED", and current references
confirm that posture: `packages/shared/src/index.ts:14` exports only the existing `detectPII`, and
no file outside `pii-international.ts` imports its registry. The module itself nevertheless says
`pii.ts` composes its results, cites non-existent ADR-0117, and says measured rates are pinned by a
non-existent `pii-conformance.test.ts` (`packages/shared/src/pii-international.ts:2-9,51-60`).

The candidate scanner also accepts an optional separator between every pair of digits
(`packages/shared/src/pii-international.ts:333-358`), while the Aadhaar limit describes only bare
or 4-4-4 spaced/hyphenated forms (`packages/shared/src/pii-international.ts:445-452`). The synthetic
probe reproduced the mismatch: a checksum-valid value with spaces after every digit counted as a
match. The recorded `falsePositivePct` values are therefore unsupported by a committed method and
do not establish the rate for every accepted formatting shape.

**Impact:** there is no active customer-path regression because the module is not exported or
wired. Wiring it based on its internal comments would, however, introduce block-mode refusals from
a candidate language broader than the disclosed limits, while jurisdictional correctness and
false-positive claims remain unrepeatable. That is unsafe for a control whose false positive stops
legitimate work.

**Recommended remediation:** keep the default set empty and the module disconnected until
ADR-0117, authoritative positive/negative vectors, deterministic conformance/property tests and a
documented false-positive methodology land together. Make each scanner accept only the published
formats it claims (or broaden the disclosed limit and measure every accepted form). Then integrate
through the existing counts-only `detectPII` result and tenant/jurisdiction configuration, with UI
disclosure of measured collision risk.

**Acceptance evidence required:**

1. Every scheme has issuing-authority vectors, one-character/check-digit mutations, longer-run
   boundary cases, Unicode/lookalike cases, and exact-format negatives; the every-digit-separated
   probe above is rejected unless explicitly supported and measured.
2. Independent reference/property tests exercise the checksum primitives; deterministic sample
   size, seed, corpus shape and confidence/error bounds reproduce each displayed rate.
3. Default-off behavior is pinned across upgrades. Opt-in block/warn/log tests cover every shared
   dispatch path and prove a block leaves the fake upstream count at zero.
4. ADR, public package exports, admin/API configuration, UI limits, audit reason and docs land in
   one reviewable change; no capability claim appears before those gates pass.

**Remaining uncertainty and prior-finding reconciliation**

- AER-004 remains the only open high-severity automated finding and was source-rechecked above;
  its database-controlled race/legacy cases were not executed.
- AER-005's decision artifacts are now present, but its database result is not independently
  reproduced and its backlog has the one stale sentence above.
- F01 remains open on the repository-recorded, order-dependent `compat-longtail.test.ts` 500; this
  run did not execute the shared database suite. F03 remains open on measured-spend versus
  transactional reservation semantics.
- The new international algorithms' authoritative correctness was not independently researched in
  this run; the finding is about their demonstrable repository state and the reproduced scanner
  mismatch, not a conclusion that each checksum is wrong.
- STATE front matter still says `last_updated: 2026-09-07` while its lead narrative is 2026-09-19;
  the existing F08 status-claim hygiene item therefore remains open.
### Scheduled run — 2026-09-19 20:30:56 -05:00

**Reviewed range:** `d557d25a6544aeb3eb4b1a6d7ce90bb7fb24d264..6c378b625a610402f534271870080c19cd01c0fb`  
**Branch/upstream:** `claude/status-check-2gbrwf` / `origin/claude/status-check-2gbrwf`  
**Synchronization:** the pre-pull worktree had no tracked or staged modification; the existing
untracked `PathForward.md` and `codexInputs.md` were preserved. `git pull --ff-only` advanced nine
commits to `6c378b625a610402f534271870080c19cd01c0fb`; local HEAD and upstream now agree. No reset,
stash, commit, push or sibling-repository write was performed.

**Delta:** 31 files, +4233/-70. The material additions are international PII production wiring,
migration 0110, vectors/conformance tests and ADR-0117; and Ed25519-signed report/audit export
bundles, an offline verifier, key-custody documentation and ADR-0116. The review covered this delta
and the still-open high-residual AER-004.

**Verification performed**

- `git diff --check d557d25a6544aeb3eb4b1a6d7ce90bb7fb24d264..HEAD` — passed.
- `corepack pnpm --filter @regulait/shared test` — passed: 37 files / 903 tests, including 97
  international-PII conformance tests and their deterministic false-positive measurements.
- `corepack pnpm -r build` — passed. Vite emitted its existing >900 kB chunk warning; the build
  exited 0.
- `corepack pnpm -r exec tsc --noEmit` — an initial invocation run concurrently with the build
  exited 1 while workspace declarations were being regenerated, reporting the new audit-export
  object type and org PII field as absent. The identical command rerun sequentially after the build
  exited 0. The sequential result is the diagnostic one; the first result records that these two
  commands must not be overlapped on a mutable declaration tree.
- Local no-I/O Node detector probe against the freshly built package — reproduced
  `bareCount=1` and `everyDigitSpacedCount=1` for checksum-valid synthetic Aadhaar
  `234567890124` versus `2 3 4 5 6 7 8 9 0 1 2 4`.
- ADR/index inventory — 117 numbered ADR files through 0117 and 117 index rows. Migration/journal
  inventory — 110 SQL migrations through 0110 and 110 journal entries ending at
  `0110_pii_international_categories`.
- Targeted source/test searches covered report-export authorization, chain selection and payload
  content; missing-key audit ordering; verifier file-set checks; non-admin isolation tests; and the
  web UI's international-PII controls. No full gateway/database suite was run: `DATABASE_URL` was
  unset and no explicitly disposable, session-exclusive database was available.

#### AER-004 — UNCHANGED / HIGH RESIDUAL — Approval context still accepts stale-consent paths and the atomicity claim remains overstated

**Evidence type:** current-source recheck; runtime not reproduced. The delta changes PII calls in
the MCP proxy but does not change approval evaluation or consumption. Null context/null expiry,
the one-request snapshot window and pure-ABAC identity limitation remain as recorded in the prior
AER-004 entry (`apps/gateway/src/governed-evaluate.ts:564-585`;
`apps/gateway/src/mcp-proxy.ts:797-816`; `packages/db/src/schema.ts:1245-1262`;
`docs/decisions/0105-consent-context-binding-and-expiry.md:241-263`). Impact, remediation and the
five acceptance tests in that entry remain current. Build/typecheck success does not close it.

#### AER-005 — UNCHANGED / LOW RESIDUAL — PENDING still says the closed S22 eval surface is unassessed

**Evidence type:** direct documentation observation. `docs/product/PENDING.md:153-160` still says
`eval_results.output_text` remains unassessed, while `docs/product/PENDING.md:162-170` immediately
marks S22 closed by ADR-0115. No file in this delta reconciles the contradiction. Remediation and
the acceptance test in the prior AER-005 entry remain current.

#### AER-006 — PARTIALLY RESOLVED / MEDIUM RESIDUAL — International PII is wired and tested, but accepted formats and the claimed admin control still disagree with the product

**Evidence type:** source observation plus reproduced detector behavior. The previous evidence-set
gap is materially resolved: ADR-0117, migration 0110, package exports, required enforcement
arguments, production-path wiring, vectors and a 97-test conformance suite now exist. Default-off
is explicit in the migration/schema and `DEFAULT_INTERNATIONAL_CATEGORIES`.

Two residuals remain. First, the shared scanner builds an optional scheme separator between every
digit (`packages/shared/src/pii-international.ts:336-343`) while Aadhaar's disclosed limit says bare
or 4-4-4 grouped (`packages/shared/src/pii-international.ts:450-455`). The fresh probe reproduced
acceptance of the every-digit-spaced form. The conformance rate therefore does not prove the rate
for every syntax the scanner accepts. The registry comment also still says checksum members are
default-on (`packages/shared/src/pii-international.ts:443-446`) although ADR-0117 and the constant at
line 555 make the default empty.

Second, the repository tells an operator to use “Admin → Org settings → data protection” and read
the measured rate beside each switch (`docs/product/TESTING_CHECKLIST.md:125`), and the source says
the same (`packages/shared/src/pii-international.ts:543-548`). The web app has no
`piiInternationalCategories`, category or `falsePositivePct` control: its compliance form reads and
writes only `defaultPiiMode` and environment-key settings
(`apps/web/src/views/admin/settings/OrganizationPage.tsx:122-128,361-380`). The API is configurable,
but the documented UI journey does not exist.

**Impact:** operators cannot perform the documented opt-in or make the promised risk-informed
choice in the product UI. API users can enable a detector whose actual accepted language is wider
than its displayed/documented limit, which matters when `block` mode refuses legitimate work.

**Recommended remediation:** encode exact accepted layouts per scheme instead of inserting a
separator between every digit; align comments and measured corpus with that grammar. Add an admin
UI that reads/writes the category set, shows jurisdiction, limits and measured rate before save,
and records the existing audited org-settings update. Until then, correct the checklist/claim so it
does not instruct an operator to use a nonexistent switch.

**Acceptance evidence required:**

1. Every scheme accepts only its enumerated bare/published layouts; every-digit and mixed-layout
   negatives are paired with positive detector-run controls. The synthetic Aadhaar above returns 0.
2. Rate tests sample every accepted layout or explicitly scope the displayed rate to one layout.
3. A browser/API test enables only `steuer_id`, reloads, displays 0.23% plus limits, then proves
   `steuer_id` blocks while BSN and default-off identifiers still pass on each governed path.
4. Upgrade/default tests continue to prove `[]`; stale “checksum members are default-on” wording is
   absent from source and operator documentation.

#### AER-007 — HIGH — Entitlement-scoped signed report exports embed organization-wide audit payloads

**Evidence type:** direct source observation; database runtime not reproduced in this run.

The signed report route is intentionally non-admin
(`apps/gateway/src/route-classes.ts:225-228`) and checks only whether the caller may read that report
run (`apps/gateway/src/reporting.ts:886-908`). It then passes the report id to `buildExportBundle`
(`apps/gateway/src/reporting.ts:922-959`). `readChainSegment` finds the first audit row mentioning
that id, but its payload query selects **every** audit row from that global sequence through the
global head, bounded only by the row cap and with no user/project/entitlement predicate
(`apps/gateway/src/export-bundle.ts:340-366,581`). The archive writes the canonical payload for
every selected row (`apps/gateway/src/export-bundle.ts:607-618`), including user id, object ids,
detail, tool/server names, rule chain and reason
(`packages/shared/src/audit-chain.ts:222-237`). The signed-export tests exercise report scope setup
but contain no non-admin/unrelated-row confidentiality assertion.

**Impact:** a non-admin entitled to one report can request `?signed=1` and receive up to the chain
cap of unrelated organization audit records. This bypasses the report's entitlement boundary and
can disclose other users' actions, object identities, policy reasons and audit detail. Signing the
archive authenticates the over-disclosure; the 2,000-row default cap limits volume, not scope.

**Recommended remediation:** do not place raw global intermediary payloads in an
entitlement-scoped bundle. Either make full-chain bundles admin-only, or design an offline proof
that exposes full payload only for authorized subject rows and cryptographic links/commitments for
intermediary rows. Document precisely what such a proof establishes; do not call redacted/hash-only
rows full audit exports.

**Acceptance evidence required:**

1. Create a project-scoped report and an unrelated audit sentinel containing a unique benign value
   in `detail`/`reason`; export as an entitled non-admin and prove the sentinel occurs nowhere in
   the unpacked archive.
2. The non-admin can still verify the authorized report offline against the pinned trust root.
3. A caller without the report entitlement is refused, and a deliberately reintroduced global-row
   payload makes the isolation test fail.
4. If an admin-only full-audit bundle is retained, the same sentinel appears only there and its
   wider scope is explicit in the manifest/UI.

#### AER-008 — MEDIUM — Missing signing keys leave success claims in the audit chain for exports that were refused

**Evidence type:** direct source observation; missing-key tests do not assert the resulting audit
semantics.

The report path records `report-exported` before bundle construction
(`apps/gateway/src/reporting.ts:910-924`), then, when no key exists, records a separate refusal and
returns 409 (`apps/gateway/src/reporting.ts:959-970`). The audit CSV path inserts an `allow` row with
rule `audit-export-signed` and the statement that the trail “was exported” before bundle
construction (`apps/gateway/src/app.ts:3625-3647`); its missing-key branch returns 409 without a
correcting denial row (`apps/gateway/src/app.ts:3674-3675`).

**Impact:** the supposedly authoritative ledger can state that a signed artifact left the platform
when the request produced no artifact. Investigators cannot distinguish attempt, refusal and
successful egress from the event names/effects alone.

**Recommended remediation:** preflight key availability before writing a success event. Record an
honest attempt/refusal on failure and a success only after archive generation succeeds; if the
manifest must commit to an event about its own creation, define separate intent and completion
events and disclose exactly which head is signed.

**Acceptance evidence required:** with no key, each route returns 409 and adds no `allow`/“exported”
event; it adds one accurate refusal/attempt event. With a key, one completion event names the
artifact actually returned. Assert the exact audit delta and event effect/reason for both routes,
and make a mutation restoring the current pre-write-success ordering fail the test.

#### AER-009 — MEDIUM — The offline verifier ignores unlisted files under `audit/rows/`

**Evidence type:** direct verifier/test observation; exploit archive not generated in this run.

The verifier's extra-file check deliberately removes every `audit/rows/*` path before comparing
the archive with the signed file list (`scripts/verify-export-bundle.sh:292-303`). Its later chain
loop checks only payload filenames named by `audit/chain.tsv`
(`scripts/verify-export-bundle.sh:336-371`). Consequently, an extra
`audit/rows/999.payload` is checked by neither stage. The test suite's unlisted-file case adds
`content/extra-invoice.csv`, not an audit payload
(`apps/gateway/src/export-bundle.test.ts:571-576`).

**Impact:** a bundle can pass verification while carrying an unauthenticated, misleading file in
the directory auditors are explicitly told contains exact audit records. This contradicts the
verifier's “nothing extra” guarantee even though the extra file is not part of the signed chain.

**Recommended remediation:** derive the exact expected payload path set from `audit/chain.tsv` and
compare it with the actual `audit/rows/` set; reject extras, duplicates, non-canonical sequence
names and missing files before verifying row hashes.

**Acceptance evidence required:** pristine bundle passes; adding `audit/rows/999.payload` produces
a distinct extra-audit-row refusal; adding a second spelling/duplicate or nonnumeric payload also
fails; removing a listed payload keeps the existing missing-row refusal. Each negative must first
verify its pristine control.

**Remaining uncertainty and prior-finding reconciliation**

- AER-004 remains the open high residual, and AER-007 is a new high source finding. Neither
  database-controlled path was executed because no disposable `DATABASE_URL` was available.
- AER-006's structure/wiring/test gap is mostly closed, but the reproduced format mismatch and
  absent documented UI remain. The 903 shared tests do not exercise the admin browser journey.
- AER-005 remains a documentation contradiction; the ADR-0115 database test was not rerun.
- The repository-reported fresh-database total and signed-export integration/tamper results in
  STATE/ADRs remain repository-reported, not independently reproduced here.
- `project-state/STATE.md` front matter still says phase
  `codex-review-hardening-f02-closed-f05-next`, `last_updated: 2026-09-07`, and an August session
  while its body now describes work through 2026-09-20. The existing F08 status-claim hygiene item
  therefore remains open.
### Latest no-change run — 2026-09-20 06:31:05 -05:00

**Reviewed range:** no new commit; local HEAD and
`origin/claude/status-check-2gbrwf` remain
`6c378b625a610402f534271870080c19cd01c0fb`.  
**Synchronization:** preflight found no tracked/staged changes and preserved the existing
untracked `PathForward.md` and `codexInputs.md`. `git pull --ff-only` returned “Already up to
date.” No reset, stash, commit, push, product-code edit or sibling-repository write occurred.

**Verification performed**

- Re-read the current suite/repository instructions and current status/decision records required
  by the automation.
- `git status --short --branch`, `git remote -v`, `git branch --show-current`, `git rev-parse HEAD`
  and `git rev-parse '@{upstream}'` — expected branch/remote; both SHAs identical; only the two
  pre-existing untracked feedback documents present. `DATABASE_URL` remains unset.
- `git diff --quiet 6c378b625a610402f534271870080c19cd01c0fb..HEAD` — passed (empty range).
- Targeted source recheck kept AER-004's null-context/null-expiry predicates at
  `apps/gateway/src/governed-evaluate.ts:571-585` and
  `apps/gateway/src/mcp-proxy.ts:805-820`, and AER-007's global chain selection at
  `apps/gateway/src/export-bundle.ts:340-366,581`.
- No build or test was rerun because the reviewed SHA is byte-identical to the preceding run; that
  run's 903 shared tests, build and sequential typecheck are not relabelled as fresh evidence for
  this timestamp. No database test was run without an explicitly disposable, session-exclusive
  database.

**Finding status:** no new finding, resolution, severity change or verification failure. AER-004
and AER-007 remain open and unchanged; AER-005, AER-006, AER-008 and AER-009 also remain unchanged.
Their prior evidence, impacts, recommended remediations, acceptance tests and uncertainties are not
duplicated here.
### Scheduled run — 2026-09-20 11:32:10 -05:00

**Reviewed range:** `6c378b625a610402f534271870080c19cd01c0fb..537e4cc6c3e00b67c35956726b3aabce42ffc611`  
**Branch/upstream:** `claude/status-check-2gbrwf` / `origin/claude/status-check-2gbrwf`  
**Synchronization:** the pre-pull tree had no tracked/staged changes; existing untracked
`PathForward.md` and `codexInputs.md` were preserved. `git pull --ff-only` fast-forwarded seven
commits to `537e4cc6c3e00b67c35956726b3aabce42ffc611`; local HEAD and upstream agree. No reset,
stash, commit, push, cloud call, deployment, product-code edit or sibling-repository write occurred.

**Delta:** 14 files, +1811/-47. ADR-0118 adds an admin posture read and hardened preset. ADR-0119
adds semantic-cache service to the non-admin IDE/compat path and extracts the native/compat cache
lookup and store into one module. The export-bundle production implementation did not change; one
tamper test was repaired so its mutation cannot be a no-op.

**Verification performed**

- Re-read the required suite rules, registry, capability map, repository agreement, current STATE,
  latest mistakes, ADR index and parallel-session rules before synchronizing.
- `git diff --check 6c378b625a610402f534271870080c19cd01c0fb..HEAD` — passed.
- `corepack pnpm -r build` — passed. Vite repeated the existing >900 kB chunk warning; exit 0.
- `corepack pnpm -r exec tsc --noEmit` — passed sequentially after the build; exit 0.
- Local no-network Node probe against the built code — reproduced that distinct case-sensitive
  prompts `Return API_KEY exactly` and `return api_key exactly` produce the same semantic-cache key.
  It also reproduced that a freshly resolved S3 Object-Lock sink has destination
  `s3_object_lock`, exposes `observe()`, but its synchronous `tamperResistant` grade is `false`
  before observation — the exact value the new synchronous posture builder consumes.
- ADR/index inventory — 119 files through 0119 and 119 rows. Migration/journal inventory remains
  110/110 through 0110; the two ADRs correctly claim no migration.
- No gateway/database test was run: `DATABASE_URL` is unset and no explicitly disposable,
  session-exclusive database was available. The new ADRs' reported fresh-database totals (184
  files / 2813 passed / 9 skipped), non-vacuity probes and integration behavior remain
  repository-reported evidence, not independently reproduced in this run.

#### AER-004 — UNCHANGED / HIGH RESIDUAL — Approval context still accepts stale-consent paths

No approval evaluation/consumption file changed. The null-context/null-expiry paths, snapshot race,
policy-identity residual, impact and prior acceptance tests remain unchanged.

#### AER-007 — UNCHANGED / HIGH RESIDUAL — Signed report bundles still include global audit payloads

Only `export-bundle.test.ts` changed, repairing a no-op mutation. The production report route,
global contiguous chain query and payload emission did not change, so AER-007 remains open. AER-008
and AER-009 likewise remain unchanged. AER-005 and AER-006 also received no relevant fix.

#### AER-010 — HIGH — Compat semantic-cache hits bypass the shared governance dispatch core

**Evidence type:** direct source observation; database behavior not reproduced here.

The new compat path looks up and returns a cache hit at
`apps/gateway/src/compat-core.ts:886-1015`. The call to `executeGovernedDispatch` begins only after
that early return at `apps/gateway/src/compat-core.ts:1019`. Consequently, a hit does not execute the
current gates kept inside the shared core: virtual-key allow-list/budget
(`apps/gateway/src/agents-connectors.ts:1233-1269`), MRM approval/expiry (1271-1298), mandatory
attribution (1300-1327), approved use case (1329-1359), project budget (1362-1371), input PII
(1375-1421), or input guardrails (1425 onward). The hit path rechecks only cached **output** PII
(`compat-core.ts:934-952`). This directly contradicts the file-level invariant that a compat call
can never obtain something the invoke path would deny (`compat-core.ts:5-12`).

**Impact:** prime the cache while controls are permissive, then harden the deployment, exhaust a
budget, lapse the model card, enable a use-case gate, or change input PII/guardrail policy: the same
compat request can still receive the cached answer even though a fresh dispatch is now refused.
ADR-0118 and ADR-0119 therefore compose into a bypass — the new hardening controls can be enabled
while the new optimisation path returns before them. The audit row records an `allow` cache hit,
not the denial the current policy requires.

**Recommended remediation:** make a cache serve a governed dispatch outcome. Factor the complete
provider-independent pre-dispatch gate sequence into one shared primitive and run it on both hits
and misses before any cached bytes are emitted. Re-evaluate current output controls (PII and general
guardrails) on the cached answer. Keep the useful invariant that a permitted hit contacts no
provider and creates no usage row; “zero spend” must not mean “skip current authorization and
compliance.”

**Acceptance evidence required:**

1. Prime one compat cache entry with controls off. Enable, one at a time, MRM with a missing/lapsed
   card, mandatory attribution, use-case enforcement, project budget block, input PII block and an
   input guardrail block. The identical repeat must return each exact current refusal, emit no
   cached text/saving row and contact no provider.
2. Prime under one output policy, then enable output PII and a non-PII output guardrail; the hit is
   withheld/refused under the new policy.
3. A permitted hit still returns the cached answer with provider delta 0, usage delta 0 and one
   accurate saving/audit fact.
4. A negative control that moves the lookup above the shared gate sequence makes the denial matrix
   fail.

#### AER-011 — HIGH — The compat cache key is not the identity of the request whose answer it serves

**Evidence type:** direct source observation plus a reproduced pure-key collision.

The key is derived only from message text flattened without role labels and joined by newlines
(`apps/gateway/src/compat-core.ts:886-922`). `semanticCacheKey` then lower-cases and collapses
whitespace (`apps/gateway/src/semantic-cache-shared.ts:30-35`). Yet the provider request also carries
ordered roles/boundaries plus separate `system`, `responseFormat`, `thinking`, `maxTokens` and
project context (`apps/gateway/src/compat-core.ts:1019-1033`). None of those fields, the agent's
active prompt/config version, or the project is in the key/collision guard. The new six-test file
covers one fixed user-message shape, normalization, user scope, tools and policy mode; it has no
paired system/role/response-contract/project/config-version identity cases.

**Impact:** requests that are materially different to the model can collide and receive a prior
answer without a provider call. Changing only a system instruction can return an answer produced
under the old instruction; changing role boundaries can reuse an answer for a different dialogue;
requesting structured output can receive cached plain text; and case-sensitive code or identifiers
can reuse the opposite-cased prompt. This is an integrity and policy-context failure even though
cross-user scope is correctly constrained.

**Recommended remediation:** key on a versioned canonical request fingerprint, not flattened text:
ordered role-tagged messages with boundaries and all supported content blocks, system instruction,
response format/schema, thinking/max-token options, requested agent plus active prompt/config
version, and any project/policy identity that can change the valid answer. Either skip caching when
an input cannot be represented faithfully or include it. Preserve an exact canonical request beside
the hash and compare it on lookup; lower-cased text may be a search hint, never answer identity.

**Acceptance evidence required:**

1. Identical complete requests hit; paired requests differing only in system text, one role,
   message boundary, response schema, max-token/thinking option, case-sensitive text, project, or
   active prompt/config version each miss and increment the provider/usage delta by one.
2. A structured-output request never receives a cached response created without the same schema.
3. A collision-guard test forces the indexed digest equal while canonical request bytes differ and
   proves the row is refused.
4. Negative controls that omit each field from the fingerprint redden its paired test.

#### AER-012 — MEDIUM — The posture endpoint says it observes S3 Object Lock but never calls the observation

**Evidence type:** source observation plus local no-network reproduction.

`environmentControls` creates a fresh sink and immediately reads the synchronous getter
(`apps/gateway/src/posture-preset.ts:135-150`). For `S3ObjectLockSink`, that getter is deliberately
false until `await observe()` asks `GetObjectLockConfiguration`
(`apps/gateway/src/audit-chain.ts:307-333,346-376`). `buildPostureReport` and both routes are
synchronous with respect to the sink (`posture-preset.ts:188-221,238-240,337`). Thus even a real
COMPLIANCE-mode bucket is reported unmet and overall `hardened` cannot become true. The test named
“grades the anchor from the OBSERVED sink” supplies only a local directory and asserts false
(`apps/gateway/src/adr0118-hardened-posture.test.ts:436-445`); it never names or observes an S3 sink.

**Impact:** this is conservative rather than permissive, but the primary deliverable cannot answer
its advertised question. Operators with genuine WORM evidence are told they lack it, automation can
never reach green, and ADR/STATE/checklist claims of medium-observed posture are unsupported.

**Recommended remediation:** make posture construction async, use the same long-lived sink instance
as the audit subsystem, and await `observe()`; publish its mode/disclosure as well as the boolean.
Fail closed on observation errors, but distinguish “unobserved/error” from a bucket that positively
reported no lock.

**Acceptance evidence required:** with an injected fake S3 client, COMPLIANCE reports true,
GOVERNANCE/no-default/absent/error report false with distinct mode/disclosure, and local buffer/off
remain false. Assert the public GET and harden response, not only a pure helper. A negative control
replacing the awaited observation with the synchronous getter must fail.

#### AER-013 — MEDIUM — The hardened preset's mutation and audit facts are neither atomic nor concurrency-idempotent

**Evidence type:** direct source observation; failure/concurrency not reproduced without a database.

The handler reads the singleton, updates all target columns, then inserts the preset audit row and
optional MRM audit row as three independent statements with no transaction or row lock
(`apps/gateway/src/posture-preset.ts:268-334`). If either audit insert fails, governance state has
already changed while the request fails, and the ledger is missing one or both facts. Two concurrent
first calls can also read the same old row, both report `applied`, both update, and both mint audit
rows despite the advertised idempotency.

**Impact:** a high-blast-radius operation can take effect without the audit evidence operators rely
on, or produce duplicate “changed” facts for one logical transition. A caller retrying a 500 cannot
tell whether hardening already happened.

**Recommended remediation:** serialize on the org-settings singleton and perform the conditional
update plus all required audit inserts in one database transaction. Derive `applied` from the locked
row/conditional RETURNING result; roll back settings if any audit fact cannot be written.

**Acceptance evidence required:** two concurrent harden requests yield exactly one applied outcome,
one already-satisfied outcome, one preset audit row and one MRM audit row. Inject failure into each
audit insertion and prove settings plus audit deltas both stay zero. A retry after a committed
success is a no-op. Unknown/duplicate/empty group payloads have explicit, tested semantics.

**Remaining uncertainty and prior-finding reconciliation**

- AER-010 and AER-011 are new high-severity source findings. They were not database-reproduced, but
  the early return and omitted request fields are direct control-flow/data-flow observations.
- AER-004 and AER-007 remain open high residuals. The export-test repair makes its tamper test
  meaningful but changes none of AER-007's production authorization/data selection.
- AER-005, AER-006, AER-008 and AER-009 remain open at their prior severities; no relevant product
  or UI file changed.
- Build and typecheck establish compilation only. The repository-reported new database suites and
  hostile probes were not independently run, and no live S3/provider/cloud resource was contacted.
- STATE front matter remains stale (`last_updated: 2026-09-07`, August session) while its body now
  describes 2026-09-20 work; F08 remains open.

### Automated enterprise-readiness run — 2026-09-20 16:33:14 CDT (UTC-05:00)

**Review boundary and synchronization**

- Local before sync: `537e4cc6c3e00b67c35956726b3aabce42ffc611` on
  `claude/status-check-2gbrwf`, tracking `origin/claude/status-check-2gbrwf`.
- `git status --short --branch` showed only the pre-existing untracked feedback artifacts
  `PathForward.md` and `codexInputs.md`; no tracked local modification needed to be overwritten.
- `git pull --ff-only` succeeded, fast-forwarding seven commits to
  `c4c2804d0b2b59a29802a01fab72c3494c4361ee`. Local and upstream now match that SHA.
- Reviewed range: `537e4cc6c3e00b67c35956726b3aabce42ffc611..c4c2804d0b2b59a29802a01fab72c3494c4361ee`
  (ADR-0120 rule-candidate simulation plus the Outlook send-only connector; 14 files,
  +1,310/-41). No commit, push, stash, reset, cloud call or product-code edit was made.

**Commands and independently observed outcomes**

- `corepack pnpm --filter @regulait/connector-provider test` — PASS: 1 file / 76 tests. These are
  fake-upstream adapter tests; they do not exercise connector creation through the gateway or UI.
- `corepack pnpm -r exec tsc --noEmit` — PASS, exit 0.
- `corepack pnpm -r build` — PASS, exit 0; Vite repeated the existing warning that the main JS
  chunk is about 1,077 kB and exceeds the 900 kB warning threshold.
- No-network built-module probe — reproduced a registry split: `isConnectorProviderKind("outlook")`
  returned true, while `createConnectorSchema.safeParse({name:"mail", kind:"notifications",
  providerKind:"outlook"})` returned false with an enum error. `connectorDefaultBaseUrl("outlook")`
  returned `undefined`.
- `DATABASE_URL` was unset. In accordance with the repository's shared-database safety rule, the
  new database-backed ADR-0120 tests and the repository-reported 2,819-test suite were not run.

#### AER-014 — HIGH — Rate-limit simulation compares historical calls with one present-time counter, so its exact blast-radius claim is false

**Evidence type:** direct source observation and claim-to-code comparison; database behavior not
reproduced because no disposable database was available.

`runRuleSimulation` walks historical audit rows and calls `governedEvaluate` once per row
(`apps/gateway/src/policy-simulation.ts:348-388`). The replay supplies no event timestamp. Inside
`governedEvaluate`, every rate count is instead calculated from `Date.now()` and the current audit
table (`apps/gateway/src/governed-evaluate.ts:405-423`). Consequently, every historical row for a
given subject sees the same present-time count, including calls that happened *after* that row. It
does not see the count that would have existed immediately before the recorded call.

This is not disclosed as an approximation. ADR-0120 says counts are recomputed and calls the result
a preview through the same gate (`docs/decisions/0120-rule-candidate-simulation.md:25-44`), then
authorizes the claim that it shows **exactly which recorded calls would have gone differently**
(`docs/decisions/0120-rule-candidate-simulation.md:120-126`). Its stated long-window limitation says
the opposite of the implementation: the ADR says a longer candidate window sees only calls inside
the replay window (116-118), whereas `countFor` queries the live audit table independently of the
loaded transcript. The six new integration tests exercise an approval-rule candidate and refusal
shapes, but no rate-limit candidate (`apps/gateway/src/adr0120-rule-simulation.test.ts:174-319`).

**Impact:** a candidate such as two calls per hour can mark the first call in a historical sequence
as denied because later calls already raised today's counter, or mark an old call using activity that
did not yet exist. The stored `newlyDenied` / `newlyAllowed` totals and named flip rows can therefore
be confidently wrong. An operator could approve an unsafe limit or reject a safe one based on the
feature's primary governance evidence.

**Recommended remediation:** make replay time an explicit input to the gate/counting primitive.
For each row, count only matching allowed calls strictly before (or according to one documented
boundary at) `row.at`, using the candidate's tool and window. Bound the evidence query to the data
actually available; when the required lookback predates the captured transcript/retention boundary,
return `indeterminate` or refuse rather than inventing an exact result. Keep production evaluation
on the real clock and make it impossible for a caller to select replay time outside simulation.

**Acceptance evidence required:** seed a timestamped sequence with a candidate limit of two calls
per hour. The replay must permit the first two and deny the third exactly as activation followed by
the same ordered sequence would. Add a call after the first replayed row and prove it cannot
retroactively change that row. Cover per-user, fleet/server, tool-specific, changed-window and
truncated-lookback cases. A negative control that switches back to `Date.now()` must fail. Assert the
public response, persisted totals and sampled flip rows, not only a helper.

#### AER-015 — MEDIUM — The Outlook adapter passes isolated tests but cannot be created through the product surface

**Evidence type:** direct source observation plus reproduced no-network schema behavior.

The provider package adds `"outlook"` to its executable registry
(`packages/connector-provider/src/index.ts:51-63`) and its direct fake-upstream tests pass. The shared
API schema that the gateway uses to create connectors still omits it
(`packages/shared/src/index.ts:1238-1254`; `apps/gateway/src/agents-connectors.ts:4394-4424`). The
admin UI's provider list omits both Outlook and the previously added Teams adapter
(`apps/web/src/views/admin/integrations/ConnectorsPage.tsx:18,101-108`). The no-network probe
reproduced that a public create payload with `providerKind: "outlook"` is rejected. In addition,
`connectorDefaultBaseUrl` has no Outlook case (`packages/connector-provider/src/index.ts:1882-1908`),
so a manually inserted Outlook connector without an explicit base URL is classified as an unknown
compiled destination and refused under strict egress posture before the adapter runs.

**Impact:** the new code is library-reachable but not operator-reachable through supported API/UI
setup. Adapter-only green tests can be cited as shipped functionality while a real administrator
cannot configure it, and strict deployments fail even if a row is inserted out of band.

**Recommended remediation:** define the provider-kind vocabulary once or add an exhaustive parity
test across the executable registry, shared create/update schemas, UI options and compiled-default
egress registry. Add Outlook's Graph default explicitly; keep the credential-derived Entra login URL
under the guarded-fetch check. Document and validate the structured credential at save time so an
operator gets an early actionable error rather than an invoke-time failure.

**Acceptance evidence required:** through the supported admin route and UI, create an Outlook
connector, store a synthetic encrypted credential, grant one recipient, and invoke it against fake
Entra and Graph servers. Prove a different recipient is denied, payload recipient fields cannot
redirect delivery, read is refused, strict egress blocks unlisted Graph/login hosts, and allow-listing
the exact hosts permits both requests. A parity test must fail whenever a provider exists in one
registry/schema/UI list but not the others.

#### AER-016 — MEDIUM — The non-admin rule preview admits a 20,000-row sequential N+1 database workload

**Evidence type:** direct source observation; availability impact not load-tested.

Any authenticated entitled caller can POST this route (`apps/gateway/src/policy-simulation.ts:826-855`).
The schema permits 20,000 replay rows and defaults to 5,000
(`packages/shared/src/policy-simulation.ts:399-425`). The new branch then awaits a full
`governedEvaluate` for every row serially (`policy-simulation.ts:348-388`); each evaluation reloads
memberships, entitlements, three rule sets, approvals, server data, versions, names, active ABAC and
one audit count per applicable rate limit (`governed-evaluate.ts:213-307,327-423,478-498`). The hard
row cap prevents an unbounded table scan, but it does not bound query fan-out or request duration.

**Impact:** one low-privilege request can generate tens or hundreds of thousands of database queries;
concurrent requests can exhaust the pool or starve enforcement traffic. HTTP request-rate limiting
does not bound the work inside one accepted request.

**Recommended remediation:** turn replay into a bounded job or batch the immutable evidence needed
for all rows, precompute memberships/rules/versions and time-indexed counts, enforce per-caller and
global simulation concurrency, and publish timeout/cancellation/truncation state. Do not hold a web
request open across an operator-selectable 20,000-row query loop.

**Acceptance evidence required:** instrument query count and wall-clock work for 100, 5,000 and
20,000 rows with multiple rules/users. Query growth must be bounded by batches rather than rows times
rules; concurrent low-privilege runs must not delay a normal governed dispatch beyond the declared
SLO. Cancellation/timeout writes an honest incomplete state and no successful simulation/audit fact.

**Remaining uncertainty and prior-finding reconciliation — 2026-09-20 16:33 CDT**

- AER-014 is a new high-severity claim-integrity finding. It is based on direct clock/data-flow
  inspection; a disposable-database reproduction is still required.
- AER-015 is a reproduced integration failure despite 76 passing adapter tests. AER-016 is an
  availability risk requiring instrumented load evidence.
- AER-010 and AER-011 remain open HIGH findings: their source anchors are unchanged and the pulled
  range did not touch `compat-core.ts` or the shared cache key. AER-004 and AER-007 also remain open
  HIGH residuals; no relevant authorization/export implementation changed.
- AER-012 and AER-013 remain open MEDIUM findings; the posture source is unchanged. AER-005,
  AER-006, AER-008 and AER-009 remain open at their prior severities.
- Build/typecheck and one provider unit suite establish compilation and isolated adapter behavior,
  not database correctness, gateway/UI reachability, delivery, provider parity or production
  readiness. No live Microsoft, S3, provider or cloud resource was contacted.
- STATE body now records ADR-0120 and repository-reported 2,819-test evidence, but its front matter
  remains stale (`last_updated: 2026-09-07`, August session); F08 remains open.
### Automated enterprise-readiness run — 2026-09-26 09:46:16 CDT (UTC-05:00)

**Review boundary and synchronization**

- Local before sync: `c4c2804d0b2b59a29802a01fab72c3494c4361ee` on
  `claude/status-check-2gbrwf`, tracking `origin/claude/status-check-2gbrwf` at the same SHA.
- `git status --short --branch` showed only the pre-existing untracked feedback artifacts
  `PathForward.md` and `codexInputs.md`; no tracked local modification needed to be overwritten.
- `git pull --ff-only` succeeded, fast-forwarding 20 commits to
  `76958bb3a98bd12c2fb8b06fe156df6bf78a9bca`. Local and upstream match that SHA.
- Reviewed range: `c4c2804d0b2b59a29802a01fab72c3494c4361ee..76958bb3a98bd12c2fb8b06fe156df6bf78a9bca`
  (ADR-0121 through ADR-0124, demo setup/runbook and related corrections; 66 files,
  +6,309/-67). No commit, push, stash, reset, cloud call, provider call or product-code edit was made.

**Commands and independently observed outcomes**

- `corepack pnpm --filter @regulait/policy-kernel test` — PASS: 2 files / 129 tests.
- `corepack pnpm --filter @regulait/shared test` — PASS: 38 files / 912 tests, including 9 MCP
  discovery tests and the PII conformance vector suite.
- `corepack pnpm -r exec tsc --noEmit` — the first run FAILED because dependent projects resolved
  stale local package declarations from the pre-pull build (for example, the gateway could not see
  the newly exported execution types or DB columns). `corepack pnpm -r build` then PASSed for all
  15 selected workspace projects; the web build emitted the existing 1,081.54 kB chunk warning.
  Re-running `corepack pnpm -r exec tsc --noEmit` against the rebuilt declarations PASSed, exit 0.
- `corepack pnpm --filter @regulait/connector-provider test` — PASS: 1 file / 76 tests. This is an
  isolated adapter suite, not supported-surface or strict-egress reachability evidence.
- Pure built-module kill-switch probe — REPRODUCED: under `execution.mode = require_approval`, an
  ungranted write returned `require_approval` instead of default-deny; a granted write carrying
  `approvedApprovalId = "approval-1"` also returned `require_approval`. No DB or network was used.
- Pure built-module MCP-discovery probe — REPRODUCED: the result's purportedly redacted `samples`
  array returned the supplied `Authorization: Bearer sk-live-secret?token=abc` text verbatim.
- Source inventory with `rg` found direct external mutation calls in workflow deployment/Git,
  infrastructure remediation and PM synchronization that do not load an execution posture or call
  any policy-kernel evaluation entry point.
- `DATABASE_URL` was unset. In accordance with the repository's shared-database rule, no gateway DB
  suite, migration, or full repository suite was run. Repository-reported totals in STATE/ADRs remain
  repository claims, not independent evidence from this run.

#### AER-017 — HIGH — `require_approval` mode can authorize nothing and can never consume the approval it queues

**Evidence type:** reproduced pure-kernel behavior plus direct gateway source tracing; the database
queue/decide/retry journey was not run because no disposable database was available.

The execution gate runs before every grant, rule, limit and scope and returns immediately
(`packages/policy-kernel/src/index.ts:652-668`). In `require_approval` mode, the MCP branch always
returns that effect when `canQueue` is true (`index.ts:177-190`); it does not inspect entitlement or
`approvedApprovalId`. The pure probe therefore produced the same `execution-require-approval`
decision for both (a) a caller with no grant and (b) a granted caller carrying an approved approval
id. The ordinary approval-consumption logic is later in the evaluator (`index.ts:909-950`) and is
unreachable in this mode.

The gateway faithfully turns the early result into a queue row (`apps/gateway/src/mcp-proxy.ts:592-717`).
It selects and passes an approved row back into the kernel (`apps/gateway/src/governed-evaluate.ts:631-643`),
but the early gate returns `require_approval` again, so execution never reaches the atomic consume
block (`mcp-proxy.ts:806-885`) or the upstream. The ADR-0124 integration test asserts only the first
queue and dispatch refusal (`apps/gateway/src/adr0124-kill-switch.test.ts:270-283`); it never decides
the queued approval and retries, and it never uses an unentitled caller.

**Impact:** the advertised manual-control mode is a permanent queue loop, not "approval before every
call." Operators can approve work that can never execute while the mode remains set. Worse, callers
who fail the normal default-deny entitlement test are invited into the approval queue, contradicting
the established rule that approval restricts an allow path and never manufactures entitlement.

**Recommended remediation:** preserve stop-first behavior for `halted`, subject halts and read-only
writes, but make deployment-wide approval a restriction on the otherwise-allowed path. A retry with
a fresh, payload/context-bound approval issued by this specific execution-mode rule must satisfy that
rule exactly once; it must not satisfy a different approval rule, and changing mode/approver/context
must retire or reject stale consent. Ungranted, over-limit, out-of-scope and otherwise-denied calls
must remain denied without queueing.

**Acceptance evidence required:** using the public MCP path and a fake upstream, prove (1) ungranted
call -> default-deny and zero approval rows, (2) granted call -> one pending row, (3) decide it -> one
retry reaches upstream exactly once and consumes that row, (4) a second retry queues again, (5)
concurrent retries cannot execute twice, and (6) budget, data-scope, ABAC-forbid, subject-halt and
changed-approver/context denials cannot be overridden. A negative control retaining the current
early return must fail.

#### AER-018 — HIGH — The global kill-switch claim excludes live deployment, Git, infra-remediation and PM-provider writes

**Evidence type:** direct source observation and claim-to-code comparison; external calls were not
executed.

ADR-0124 and STATE assert that every effectful product path reaches `evaluate`, `evaluateAgent` or
`evaluateConnector` (`docs/decisions/0124-kill-switch-and-safe-modes.md:39-43`;
`project-state/STATE.md:27-31`). The new gate does cover those three evaluators, but several effectful
gateway paths call external providers directly and contain no execution-posture lookup or kernel
evaluation:

- live workflow deployment and Git branch creation:
  `apps/gateway/src/workflows.ts:820,1042-1047`;
- approved/automatic infrastructure remediation, including certificate rotation and auto-remediate:
  `apps/gateway/src/infra.ts:456-464,622-630,1019-1027`;
- PM synchronization and decision export writes:
  `apps/gateway/src/pm.ts:518-521,560-588,702-705,736-739,1124-1129`.

The source-wide search found no `execution`, `evaluate`, `resolveExecutionPosture` or `postureOf`
call in those three modules. These are not the ADR's explicit read/evaluation exceptions: they deploy,
create branches, remediate infrastructure, rotate credentials/certificates, and create/update work
items in external systems.

**Impact:** throwing the advertised deployment-wide halt can still allow material external effects.
During an incident, an already-running workflow, approved remediation, auto-remediation or PM sync
can continue changing customer systems while the UI says the deployment is halted. This invalidates
the emergency-control boundary and the strongest new enterprise-readiness claim.

**Recommended remediation:** define one exhaustive effect taxonomy and put the execution-mode check
at a shared dispatch boundary used by every external provider, not only the three AI evaluators.
Classify each operation read/write, name any truly necessary incident-response exception narrowly,
and surface it in the API/UI/ADR. Recheck immediately before the external call so work admitted
before a halt cannot execute after it. If remediation/rollback must remain possible, use a separately
authorized, audited break-glass path rather than an implicit bypass.

**Acceptance evidence required:** with counting fake providers, pause each path immediately before
its external call, set `halted`, then resume; all invocation counts must remain zero and the durable
state must be retryable/refused rather than falsely completed. Repeat for `read_only` and
`require_approval` according to documented semantics. Add a structural coverage test that fails when
a new provider mutation is registered without an execution-control classification.

#### AER-019 — HIGH — Emergency-state changes and their audit facts are separate, racy writes

**Evidence type:** direct source observation; failure-injection and concurrency behavior were not run
without a disposable database.

The execution-control audit helper is a standalone insert (`apps/gateway/src/execution-control.ts:94-115`).
Each route reads current state, updates the control row, and only then inserts the audit fact, with no
transaction, row lock or compare-and-swap predicate: deployment mode at lines 217-261, agent
halt/unhalt at 283-306 and 321-338, and tool halt/unhalt at 358-393 and 409-435. There is no
`db.transaction` in the module.

**Impact:** if audit insertion fails after the state update, the emergency change is real but the API
fails and the immutable ledger has no record of who stopped or resumed execution. Concurrent callers
can both pass the pre-read idempotency check, overwrite one another, and mint duplicate or misleading
`from -> to` facts. This is especially dangerous on resume: execution can restart without the audit
event the ADR describes as the operator's proof of authority.

**Recommended remediation:** perform the state transition and audit insert in one transaction. Lock
the singleton/settings or subject row, or use a conditional update whose predicate includes the
observed state; derive `from`, `changed` and the audit detail from the row actually changed. Make the
audit helper accept the transaction handle. Decide and test retry/idempotency semantics for duplicate
requests and conflicting concurrent transitions.

**Acceptance evidence required:** inject an audit-insert failure for mode set/clear, agent halt/lift
and tool halt/lift and prove the control row is unchanged. Race same and conflicting transitions with
a barrier; assert one durable transition fact per real state change, an accurate ordered history, no
lost reason/approver, and response bodies that match committed state. Restart after each injected
failure and prove the control and ledger still agree.

#### AER-020 — MEDIUM — MCP discovery labels raw evidence samples “redacted” but returns credentials verbatim

**Evidence type:** reproduced pure-function behavior; persistence/logging exposure was not traced
through a deployed reverse proxy.

`McpEndpointObservation.samples` is documented as "bounded, redacted sample lines"
(`packages/shared/src/mcp-discovery.ts:45`), but the implementation only trims and truncates the raw
line (`mcp-discovery.ts:140-161`) and returns it unchanged (`mcp-discovery.ts:180-184`). The pure probe
supplied a plausible MCP request containing `Authorization: Bearer sk-live-secret?token=abc`; the
entire credential appeared in `samples[0]`. The route returns these samples in its response
(`apps/gateway/src/shadow-ai.ts:861-923`). Existing tests cover the three-sample bound but contain no
credential/PII redaction assertion (`packages/shared/src/mcp-discovery.test.ts:70-79`).

**Impact:** operator-supplied proxy/CASB/gateway logs commonly carry authorization headers, signed
URLs, cookies, query tokens and identifiers. Returning raw lines expands those secrets into API
responses, browser state and potentially access/error logs while the type-level contract tells
reviewers they were scrubbed.

**Recommended remediation:** apply the repository's canonical secret/PII scrubber before sampling,
then truncate the scrubbed value. Prefer reconstructing a minimal sample from parsed method, host,
path and indicator rather than reflecting the raw line. Document remaining PII posture honestly and
avoid persisting samples unless there is a separately authorized evidence store.

**Acceptance evidence required:** a table-driven corpus covering bearer/basic/API-key headers,
cookies, signed query parameters, connection strings, email/IP/tenant identifiers and long secrets
must show no raw value in the pure result, API response, audit detail or error. Include benign lines
to prove diagnostic usefulness and a negative control that uses the current `slice` implementation.

**Prior-finding reconciliation and remaining uncertainty — 2026-09-26 09:46 CDT**

- **AER-015 is PARTIALLY RESOLVED / MEDIUM residual.** The shared create schema now accepts Outlook
  (`packages/shared/src/index.ts:1238-1260`) and ADR-0121 adds a public-route creation test
  (`apps/gateway/src/adr0121-outlook-chatops.test.ts:95-111`). However,
  `connectorDefaultBaseUrl` still omits Outlook while the adapter silently defaults to Microsoft
  Graph (`packages/connector-provider/src/index.ts:894-898,1882-1908`), so strict compiled-egress
  posture refuses a connector created without an explicit base URL. The admin connector UI still
  omits Outlook and Teams (`apps/web/src/views/admin/integrations/ConnectorsPage.tsx:18`). The new DB
  test was not independently run and does not invoke the connector through strict posture.
- **AER-010 remains HIGH residual.** ADR-0124 now evaluates execution mode before the compat cache,
  so a global/agent halt covers the hit. But cache hits still return at
  `apps/gateway/src/compat-core.ts:929-1021` before `executeGovernedDispatch` at 1024 and therefore
  still bypass the other current dispatch gates named in AER-010. **AER-011 remains HIGH**: the cache
  identity is still derived from flat text alone at lines 920-938.
- **AER-014 remains HIGH.** Simulation still calls `governedEvaluate` per historical row without a
  replay clock (`apps/gateway/src/policy-simulation.ts:358`), while rate counts still use
  `Date.now()` (`apps/gateway/src/governed-evaluate.ts:407`). Migration 0113 fixes the symbolic rule-id
  crash, not historical rate-limit semantics. **AER-016 remains MEDIUM**; the sequential per-row
  evaluation architecture is unchanged.
- **AER-012 and AER-013 remain MEDIUM.** Posture reporting still reads only
  `sink?.tamperResistant` without calling an observation (`apps/gateway/src/posture-preset.ts:144-155`),
  and the preset mutation/audit flow received no atomicity fix. AER-019 is new scope on the emergency
  control feature, not a duplicate resolution of AER-013.
- **AER-004 and AER-007 remain HIGH residuals; AER-005, AER-006, AER-008 and AER-009 remain at their
  prior severities.** No relevant authorization/export fix in this reviewed range justifies closing
  them. Findings are not resolved by the repository's fresh ADR/test-total claims.
- STATE's body now records work through ADR-0124 and repository-reported 189-file / 2,849-pass DB
  evidence, but its front matter still says `last_updated: 2026-09-07` and names an August session.
  F08 remains open.
- The source probes and non-DB suites establish the reproduced pure behavior and compilation only.
  No migration, gateway DB path, browser journey, provider parity, backup/restore or production
  readiness was independently verified; no live Microsoft, S3, provider or cloud resource was used.
<!-- codex-enterprise-feedback:end -->

Date: 2026-09-06  
Audience: the agent implementing reliability and governance fixes  
Project: RegulAIt Governed  
Status: recommendations from source inspection; implementation has not started

## Purpose and scope

The owner asked Codex to study this project, recommend improvements, and document those recommendations for another agent to investigate and fix.

The recommended direction is a focused reliability and governance-hardening phase before further feature expansion. Preserve the existing gateway/kernel/provider architecture unless a demonstrated defect requires changing it. Aim first for a reproducible, trustworthy customer pilot.

This review read application source, selected test definitions, deployment configuration, architecture decisions, project status, and backlog records. It did not start the application, run tests, call real providers, inspect a deployed environment, or perform a complete security audit. Existing test totals and historical live-verification results are repository-reported evidence, not results produced by Codex.

Read current repository and suite instructions before implementation. Recheck every finding against the current checkout: another agent may already have addressed it. This document records recommendations; it does not authorize production deployment, cloud spending, publishing, secret/key rotation, or destructive changes.

## Evidence labels

- **Observed in source:** visible implementation or configuration; runtime behavior still needs appropriate verification.
- **Repository-reported:** recorded in project documentation; reproduce before treating as a newly verified defect.
- **Investigation:** an apparent gap or design question, not a confirmed exploit or complete-path proof.

Source paths below are repository-relative. Line numbers are navigation hints from the reviewed snapshot and can drift.

## Recommended order

1. Make test results and the release gate trustworthy.
2. Reproduce and resolve differences in governance enforcement across entry points, starting with MCP budget handling.
3. Resolve secret persistence outside the audit ledger.
4. Prove complete user journeys and failure recovery with the real application.
5. Validate installation, updates, backup restoration, and operational configuration.
6. Reconcile documentation, UI disclosures, and release claims.

Items 1–3 are the recommended first implementation batch. Documentation corrections can accompany each fix.

## F01 — Stabilize test outcomes and restore a dependable quality gate

**Priority:** first  
**Evidence:** repository-reported defect; test configuration inspected.

[docs/product/PENDING.md](docs/product/PENDING.md), section 5, reports two unhandled `TypeError: socket.destroySoon is not a function` errors associated with [apps/gateway/src/mcp-admission-auth.test.ts](apps/gateway/src/mcp-admission-auth.test.ts). The same errors reportedly accompanied both successful and failed process exit codes. The latest state also carries this issue forward.

[apps/gateway/vitest.config.ts](apps/gateway/vitest.config.ts) disables file parallelism because files share database state. Do not enable parallelism as a shortcut without first isolating that state.

**Recommended work**

- Reproduce the teardown failure on a scratch database. Record the command, tool versions, errors, and process exit status.
- Trace server, socket, and MCP transport cleanup; fix the lifecycle ordering and await completion. Do not assume the historical diagnosis is the complete root cause.
- Inspect the existing [CI workflow](.github/workflows/ci.yml) before adding another pipeline. Verify the reported Actions-cap limitation is still current.
- Establish one reproducible verification command or documented sequence covering build, typecheck, gateway integration tests, and critical browser journeys. Required gates must actually execute.
- Do not hide unhandled errors or accept a summary count as proof of success when the process reports errors.

**Acceptance criteria**

- Repeated runs intended to reproduce the original nondeterminism complete with no unhandled errors and consistent exit status.
- A deliberately failing assertion and an unhandled error each fail the gate.
- Tests run against an explicitly disposable database.
- CI availability or an equivalent interim gate is documented accurately.

Reference: [Vitest unhandled-error configuration](https://main.vitest.dev/config/dangerouslyignoreunhandlederrors). This is current documentation, not a recommendation to upgrade the repository's Vitest version or adopt newer-version-only APIs.

## F02 — Verify budget enforcement across model, MCP, and connector paths

**Priority:** first batch  
**Evidence:** observed difference in source; exploitability and complete caller coverage remain an investigation.

The model path explicitly invokes `preDispatchProjectGate` in [apps/gateway/src/agents-connectors.ts](apps/gateway/src/agents-connectors.ts), approximately line 1349.

The shared MCP execution path in [apps/gateway/src/mcp-proxy.ts](apps/gateway/src/mcp-proxy.ts) evaluates permissions, approvals, content controls, and upstream calls, then writes usage events around line 554. No equivalent project-budget pre-dispatch check was found in that file during this review. Caller-level protection must be traced before concluding that every MCP entry point is affected.

Unattributed MCP calls deliberately enter a null-project usage bucket. That is a disclosed behavior, not automatically a defect.

**Recommended work**

- Trace direct MCP clients, delegated agent tools, model-compatible APIs, and connectors.
- Build a control matrix covering attribution, permissions, approvals, project budget, compliance, content checks, and audit/usage writes.
- Attempt an attributed paid MCP call against an exhausted project budget, using a fake upstream that counts invocations.
- If the gap is confirmed, reuse the appropriate shared budget decision logic while preserving approval and metering semantics.
- Define expected treatment of unattributed paid calls rather than silently assigning them to a project.

**Acceptance criteria**

- A blocking project budget prevents covered calls from reaching the upstream.
- Warning and approval modes retain their intended behavior.
- Direct callers and delegated workers receive consistent protection.
- Failed, denied, and executed calls have correct usage and audit treatment.
- A regression test proves the upstream was not contacted, rather than merely checking an HTTP error.

## F03 — Define spending-cap semantics under concurrency

**Priority:** resolve alongside F02  
**Evidence:** design question supported by execution structure.

[apps/gateway/src/orchestration.ts](apps/gateway/src/orchestration.ts), around lines 820 onward, checks measured spending between turns. A completed turn can cross a ceiling before the next check. Pre-dispatch checks against measured spend alone should not be described as exact spending reservations.

**Recommended work**

- State whether each cap is a threshold for stopping further work or a hard admission limit.
- Test simultaneous requests near a budget boundary.
- If strict caps are required, design transactional reservations, provider output limits, settlement, and reservation release on failure/restart.
- Preserve the distinction between estimates, measured usage, list-price calculations, and provider invoices.

**Acceptance criteria**

Concurrent behavior and permitted overshoot are explicitly defined and tested. Product wording matches the implemented guarantee; do not promise an exact provider-billing ceiling that the system cannot enforce.

## F04 — Resolve secret persistence outside audit_log

**Priority:** first batch  
**Evidence:** repository-reported finding S5, not independently reproduced.

[docs/product/PENDING.md](docs/product/PENDING.md), S5, reports that an AWS-shaped key was redacted in `audit_log` but persisted verbatim in `mcp_servers.admission_clear_reason`. The recorded schema sweep identified 47 operator-prose columns outside the ledger. That count is historical and should be rechecked.

Related implementation: [packages/shared/src/audit-scrub.ts](packages/shared/src/audit-scrub.ts), [packages/db/src/schema.ts](packages/db/src/schema.ts), and [ADR-0099](docs/decisions/0099-audit-log-credential-scrub.md).

**Recommended work**

- Reproduce with synthetic secrets only.
- Inventory reason/text write paths, including alternate APIs and background jobs.
- Choose and document a reusable enforcement boundary; compare shared parsing/write helpers with database enforcement. Route conventions alone can leave bypasses.
- Assess conversations, traces, exports, errors, and backups as separate surfaces; do not assert they leak without evidence.
- Distinguish operator prose from intentional encrypted credential storage.
- Plan handling of existing stored text separately from prevention of new leakage; do not silently rewrite historical records.

**Acceptance criteria**

Representative synthetic secrets are protected across all declared covered write and output paths. Audit-chain verification still succeeds. Legitimate prose remains usable. Coverage and residual limitations are documented.

## F05 — Verify approval scope and payload binding

**Priority:** targeted investigation during governance hardening  
**Evidence:** source observation, not a confirmed authorization bypass.

[apps/gateway/src/governed-evaluate.ts](apps/gateway/src/governed-evaluate.ts), around lines 200–209, looks up approved tool actions using user/server/tool and status. [apps/gateway/src/mcp-proxy.ts](apps/gateway/src/mcp-proxy.ts) handles approval queueing and atomic consumption. This review did not establish immutable argument-payload binding.

**Recommended work**

- Determine whether consent is intentionally tool-scoped or authorizes one exact action.
- Test changed arguments, changed project context, concurrent consumption, stale approvals, and retries.
- If exact-action consent is required, bind approval to a stable normalized action/context fingerprint and reject mismatches.
- Preserve explicit reusable-grant semantics if the product intentionally supports them; do not change the authorization contract accidentally.

**Acceptance criteria**

Approval scope is visible to the approver and enforced consistently. Single-use approvals cannot execute twice. Tests demonstrate the agreed behavior when action arguments or context change.

## F06 — Prove complete user journeys and recoverable failures

**Priority:** after the first fixes  
**Evidence:** verification recommendation; journeys were not run in this review.

Exercise the actual UI and backend together:

1. Fresh installation, initial sign-in, required password change, and role assignment.
2. Configure an allowed real provider and make a project-attributed request.
3. Deny an ungranted action and block synthetic PII on a configured project.
4. Queue, approve, and execute an action; show its audit and cost records.
5. Run a staged workflow through planning, human approval, execution, and checks.
6. Execute a delegated run and demonstrate ancestor entitlement/budget restrictions.
7. Restart during work, lose a provider connection, expire a credential, and recover without silently duplicating effects.

Sources: [apps/web/src/App.tsx](apps/web/src/App.tsx), [workflow handling](apps/gateway/src/workflows.ts), [delegation tests](apps/gateway/src/delegation-conformance.test.ts), and [plan-only tests](apps/gateway/src/plan-only.test.ts).

Plan-only tests explicitly retain unconstrained behavior for calls without a workflow instance. Verify whether required attribution closes that boundary for the intended product promise.

**Acceptance criteria**

A new operator completes the supported journeys using documented setup. Pending, denied, failed, simulated, and completed states are distinguishable. Browser tests cover the highest-value paths; real-provider smoke tests are explicitly configured and cost-bounded.

## F07 — Validate installation, upgrades, recovery, and configuration

**Priority:** before a customer pilot  
**Evidence:** existing implementation and documented operational gaps.

Relevant sources: [docker-compose.yml](docker-compose.yml), [deployment runbooks](docs/deployment/README.md), [boot sequence](apps/gateway/src/boot.ts), [release-key runbook](infra/release-keys/README.md), and [readiness checklist](docs/ops/DEPLOYMENT_READINESS_CHECKLIST.md).

**Recommended work**

- Prove a clean install, migration from a supported prior version, and signed update verification.
- Restore a backup with the correct data key; verify expected refusal with a missing or wrong key.
- Recheck the reported dev release/license key custody issue before any release ceremony.
- Make scheduler-disabled, provider-unconfigured, mock, dry-run, and live states clear in setup and health views.
- Test local and external audit-anchor configurations separately; preserve runtime disclosure of Object Lock posture and unanchored rows.
- Verify air-gapped egress behavior and deployment network controls.
- Keep expensive HA and production infrastructure work aligned with pilot requirements and existing owner decisions.

**Acceptance criteria**

An operator can install, upgrade, and recover from the runbooks without undocumented developer steps. Recovery includes encrypted data and audit evidence. No production-readiness claim is made merely because Docker starts.

## F08 — Correct documentation and capability claims

**Priority:** alongside fixes  
**Evidence:** observed contradictions.

- [PENDING.md](docs/product/PENDING.md) says the S3 audit sink is unwired; [audit-chain.ts](apps/gateway/src/audit-chain.ts) implements sink resolution and runtime Object Lock checks.
- The same backlog says copilot proposals have no applier; [copilot.ts](apps/gateway/src/copilot.ts), around line 1883 onward, implements approval-gated application for supported proposal kinds. Do not infer support for every kind.
- [STATE.md](project-state/STATE.md) front matter says August 13 while its latest narrative is September 6.
- [boot.ts](apps/gateway/src/boot.ts), around lines 196–197, prints legacy /app and /admin URLs, while the current product surface is /ui.
- Historical deployment shape-only claims must be read with later implementations: [deploy.ts](apps/gateway/src/deploy.ts), around line 733, builds live AWS/Azure/GCP/Kubernetes clients behind a live flag.
- Shipped [guardrails](packages/shared/src/guardrails.ts) are heuristics. Do not market them as comprehensive classifiers.
- Local [training-provider](packages/training-provider/src/index.ts) functionality includes retrieval and classical classification; do not describe it as local transformer training.

**Acceptance criteria**

Current setup instructions, UI disclosures, backlog, and status agree with the release. Integration records distinguish implemented, mock/dry-run, and live-verified capabilities. Historical records remain clearly dated rather than being rewritten to imply old results were current.

## Expected handoff from the implementing agent

For each addressed finding, report:

- Whether it reproduced on the current checkout.
- The agreed behavior and any design decision required.
- Files changed and why.
- Exact verification commands and results, including failures/skips.
- Remaining limitations and deferred work.

Do not mark an investigation fixed without either reproducing and correcting it or providing evidence that existing enforcement already covers it. Do not claim a complete security audit, regulatory certification, or production readiness from this checklist.

