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

### Automated enterprise-readiness run — 2026-09-26 14:34:01 CDT (UTC-05:00)

**Review boundary and synchronization**

- The last commit recorded as reviewed in this ledger was
  `76958bb3a98bd12c2fb8b06fe156df6bf78a9bca`. The checkout began clean at
  `5483a47429c3dfb1ad4f8fd886c2a251f3043199` on `claude/status-check-2gbrwf`, tracking the
  same upstream SHA. The intervening merge/ADR-0125 code and the two feedback-file commits had
  already been directly inspected during the preceding GitHub handoff; this run retained the
  formal ledger boundary and concentrated new-code review on `5483a47..9bce6f6`.
- `git pull --ff-only` succeeded and fast-forwarded the checkout to
  `9bce6f6c1d22fe11b8fbec892571a7ac3e89043c`. Local and
  `origin/claude/status-check-2gbrwf` matched that SHA immediately after synchronization.
  `origin/main` advanced to `5d6cf94` (PR #110 / ADR-0126); the tracking branch also contains the
  later branch-cleanup script commit.
- Reviewed material change: ADR-0126, migration 0116, inbound and provider/MCP deadlines, MCP
  circuit-breaker state and tests, related runbook/roadmap claims, and the dry-run-first remote
  branch cleanup script. No commit, push, stash, reset, cloud/provider call, migration, deployment,
  production action or product-code edit was made. This ledger update is the only local edit.

**Commands and independently observed outcomes**

- `git status --short --branch`; `git rev-parse HEAD`; `git rev-parse @{upstream}`; `git remote -v` —
  PASS before pull: tracking branch configured correctly and no local modification existed.
- `git pull --ff-only` — PASS: fast-forward `5483a47..9bce6f6`.
- `git log`/`git diff`/`rg` and line-numbered source reads over the reviewed range — direct source
  observation. In particular, `GoogleProvider` has no deadline signal, and the breaker call-site
  inventory contains no breaker operation on the shared governed tool-call path.
- `pnpm --filter @regulait/gateway typecheck` — PASS (TypeScript no-emit check). pnpm reused the
  installed dependency graph; it also emitted the existing warning that `package.json`'s `pnpm`
  overrides field is ignored by the installed pnpm version.
- `pnpm --filter @regulait/model-provider typecheck` — PASS.
- `pnpm --filter @regulait/model-provider test` — PASS: 1 file / 122 tests. No test in that suite
  references the newly exported model timeout setter/default, so the green count is not timeout
  parity evidence.
- Isolated no-network `GoogleProvider` probe using the injected fetch seam and a 25 ms configured
  model deadline — REPRODUCED: after 120 ms the dispatch promise was still pending and the captured
  fetch `RequestInit` had no signal. The first attempt with Node's strip-only TypeScript loader failed
  on an unsupported parameter property; rerunning the same probe with the repository's installed
  `tsx` runner produced the result above.
- Isolated no-network MCP SDK probe — the SDK request rejected with `RequestTimeout` and its
  transport signal was aborted when connect cleanup ran. The first invocation from the workspace
  root failed to resolve the package; rerunning from `apps/gateway` resolved it. No separate finding
  is based on the failed setup attempt.
- `bash -n scripts/delete-merged-branches.sh` and its default dry run could not execute on this
  Windows host because the available WSL launcher has no `/bin/bash`. The script was source-reviewed;
  its executable behavior remains unverified here, and no branch deletion was attempted.
- `DATABASE_URL` was absent. Per the shared-database rule, the new database-backed
  `g2-upstream-deadlines.test.ts`, migration 0116 and the full gateway/repository suites were not run.
  ADR/STATE totals remain repository-reported evidence.

#### AER-021 — HIGH — The shipped model deadline omits Google/Gemini completely

**Evidence type:** reproduced isolated behavior plus direct provider source tracing. No provider or
network endpoint was contacted.

ADR-0126 says model dispatch was genuinely unbounded before this change and now concludes that no
unbounded wait remains on any MCP or model path
(`docs/decisions/0126-upstream-deadlines-and-circuit-breaker.md:25-32,120-122`). The roadmap marks G2
shipped on the same basis (`docs/product/ROADMAP.md:679`). The implementation pushes the resolved
number into a process-wide model-provider setting (`apps/gateway/src/timeouts.ts:107-147`) and passes
that value to the Anthropic/OpenAI/xAI/custom SDK constructors
(`packages/model-provider/src/index.ts:257-268,949-990,1034-1066`).

`GoogleProvider` is the provider-agnostic exception. It uses raw `fetch` with no `AbortSignal` or
other deadline at `packages/model-provider/src/index.ts:1265-1349`, then can wait indefinitely for
either `res.json()` or a streaming `reader.read()` at lines 1394-1414. The isolated probe set the
exported model deadline to 25 ms, supplied an injected fetch that never resolves, and observed the
dispatch still pending after 120 ms with no signal in `RequestInit`. Existing provider tests have no
timeout assertion, so their 122 passes do not cover this claim.

**Impact:** a hung or hostile Gemini/custom-Google endpoint can still hold gateway work without a
bound, consume sockets/concurrency and bypass the operator's `REGULAIT_MODEL_TIMEOUT_MS` setting. The
behavior contradicts both the provider-agnostic principle and the explicit shipped/no-unbounded-wait
claim. An enterprise operator cannot name the effective deadline because one supported vendor has
none.

**Recommended remediation:** give every dispatch a per-operation `AbortController`/`AbortSignal`
with the resolved deadline and pass it to Google's fetch. Keep it active through streamed body
consumption, cancel the reader/body on expiry, map timeout distinctly from other provider failure,
and compose it with any future caller cancellation signal. Prefer a shared deadline helper used by
both raw-fetch and SDK-backed adapters so newly added providers cannot omit it silently. Correct the
ADR/roadmap shipped wording until parity is executable.

**Acceptance evidence required:** inject a fetch that never returns headers and a response whose
stream returns headers but never yields/finishes. For both streaming and non-streaming Google calls,
prove rejection near the configured deadline and prove the signal/body reader was cancelled.
Repeat a table-driven timeout conformance test for every real provider kind. Include a negative
control without the signal that remains pending, and test that the environment-configured value is
the one each adapter observes.

#### AER-022 — HIGH — The MCP circuit breaker guards only the outer proxy handshake, not MCP operations or delegated workers

**Evidence type:** direct source/call-site observation. Database-backed concurrency behavior was not
run because no disposable `DATABASE_URL` was available.

The only breaker admission check is in the HTTP proxy route before its initial upstream connection
(`apps/gateway/src/mcp-proxy.ts:1310-1328`). The only failure recording is the catch around that
connection at lines 1334-1392, and a successful initialize immediately resets the breaker at
1395-1398. The actual shared governed tool primitive independently reads the server and opens its
own upstream connection at lines 426-459 and 919-930. Its `listTools` call at 1096 and `callTool`
call at 923-930 have deadlines but no `breakerAdmits`, `recordUpstreamFailure` or
`recordUpstreamSuccess` call. Pillar-7 workers invoke that shared primitive directly, so they never
pass through the proxy-route breaker. The new breaker tests use endpoints that fail or hang during
initialize; none completes initialize and then hangs `listTools`/`callTool`, and none exercises a
delegated worker.

**Impact:** an upstream can initialize successfully and then hang or fail every real operation.
Each request resets any accumulated handshake failures and can pay the full 15-second list or
120-second tool deadline indefinitely; delegated workers bypass the breaker altogether. A hostile
or degraded server can therefore recreate the queued-work/resource-exhaustion condition ADR-0126
says the breaker bounds, while the database reports a healthy closed breaker. This is a material
availability and claim-integrity gap.

**Recommended remediation:** put breaker admission and outcome recording around the one shared MCP
operation boundary used by proxy calls, manifest sync/admission rescans and delegated workers.
Define explicitly whether initialize, `listTools` and `callTool` share one server breaker or separate
operation buckets; whichever model is chosen, a successful handshake must not erase a failed tool
operation. Count only attributable upstream/network/deadline failures, never governance, admission,
egress, budget, PII or approval refusals.

**Acceptance evidence required:** use a fake MCP server that initializes successfully but then
hangs/fails `listTools` or `callTool`. After the configured threshold, prove both direct proxy and
delegated-worker calls fast-fail without a new upstream invocation, then prove exactly one recovery
probe after cooldown. Add mixed-success concurrency cases and assert database state, audit
transitions and invocation counts—not only HTTP status. A negative control retaining route-only
breaker placement must fail.

#### AER-023 — MEDIUM — Breaker state changes and their audit transitions are non-atomic

**Evidence type:** direct source observation; failure injection and threshold-crossing concurrency
were not run without a disposable database.

`recordUpstreamFailure` first increments and reads the server row, then separately writes
`breaker_opened_at`, then separately inserts the opened audit fact
(`apps/gateway/src/upstream-breaker.ts:219-253`). Once the row-level lock from the increment statement
is released, two failures crossing the threshold can both observe `openedAt` null, both set it, and
both file an opened transition. An audit-insert failure leaves a real open state without its claimed
transition. Recovery similarly clears state and then separately files the closed event at lines
260-275. The conditional half-open election is atomic, but the opening/closing transition plus its
ledger fact is not. The sequential tests do not inject audit failure or race the threshold.

**Impact:** the operational state and immutable audit history can disagree, and concurrent failures
can manufacture duplicate or misleading transitions. Operators and incident reviews cannot rely on
the ledger to answer when the breaker opened or recovered—the exact question ADR-0126 says these
summary facts exist to answer.

**Recommended remediation:** perform each state transition and its audit insert in one transaction.
Use a conditional update that opens only when `breaker_opened_at` is null and the post-increment
count crosses the threshold; only the row actually changed may emit `opened`. Close only from an
observed open state and emit recovery from that committed transition. Make transition helpers accept
the transaction handle and define idempotent retry behavior.

**Acceptance evidence required:** barrier-race failures at threshold-1 and threshold, and inject an
audit insert failure on open/probe/close. Assert one durable transition fact per real state change,
rollback of state when audit fails, no duplicate opened/closed events, accurate counts/reasons, and
the same result across multiple gateway instances.

#### AER-024 — MEDIUM — An open breaker masks newer admission and egress policy refusals

**Evidence type:** direct ordering observation; the combined state was not database-reproduced.

The proxy calls `breakerAdmits` at `apps/gateway/src/mcp-proxy.ts:1310-1328` before
`connectUpstream` at 1334-1337. But `connectUpstream` is where the current admission decision and
egress URL policy are actually re-evaluated (`mcp-proxy.ts:136-149`; `mcp-egress.ts:235-256`).
Despite the nearby comment saying the breaker sits after the egress guard, an already-open breaker
returns 503 first. The new policy-refusal test begins from a closed breaker, so it proves policy
denials do not increment the counter; it does not prove a newly tightened policy remains the visible
governing reason while the breaker is open.

**Impact:** after an operator quarantines a server or tightens egress policy, callers can continue to
receive `mcp_upstream_circuit_open` rather than the authoritative
`mcp_admission_held`/`egress_blocked` decision, and the policy refusal is not recorded on those
requests. Nothing reaches the upstream, so this is not an execution bypass, but it makes a governance
change present as an outage and weakens failure honesty during an incident.

**Recommended remediation:** separate side-effect-free admission/egress preflight from socket
creation and run current governance checks before breaker fast-fail. Only after those checks allow
the request should the breaker decide whether to contact the upstream. Keep policy refusals excluded
from the failure count.

**Acceptance evidence required:** open a breaker, then apply an admission hold and separately remove
egress permission. Subsequent calls must return and audit the current policy refusal with zero
upstream attempts and unchanged breaker failure count. Lift policy while the breaker remains open and
prove the next result returns to 503 until the normal cooldown/probe succeeds.

**Prior-finding reconciliation and remaining uncertainty — 2026-09-26 14:34 CDT**

- AER-017, AER-018 and AER-019 remain open HIGH findings. The G2 range does not change execution
  mode semantics, add kill-switch coverage to workflow/infra/PM writes, or make emergency state and
  audit atomic. AER-020 remains open MEDIUM; the discovery scrub implementation was not changed.
- AER-014 remains HIGH: ADR-0125 made selected live counters shared but did not add a replay clock to
  policy simulation. AER-010 and AER-011 remain HIGH residuals; G2 did not change the compat cache
  gate ordering or cache identity. No direct evidence in this run justifies closing AER-004 or
  AER-007.
- ADR-0126's own disclosed gaps remain disclosures, not new findings here: connector HTTP invokes
  still have no deadline, model/connector upstreams have no breaker, and `openBreakers()` has no
  operator route/UI. They should remain visible work rather than being read as covered by G2.
- Migration 0116 was source-checked only. The new G2 database suite and fresh migration were not run,
  so schema behavior, multi-process breaker races and the repository-reported full-suite total remain
  unverified. The inability to execute bash also leaves the branch-deletion script unverified on
  this host.
- Passing typechecks and 122 isolated provider tests establish compilation and existing adapter
  behavior, not provider timeout parity, MCP breaker completeness, database correctness, production
  readiness or certification. No external provider, cloud resource or live deployment was used.

### Automated enterprise-readiness run — 2026-09-26 19:35:36 CDT (UTC-05:00)

**Target branch and synchronization blocker**

- Exclusive target: `dhruv/active`.
- The checkout is still on `claude/status-check-2gbrwf` at
  `9bce6f6c1d22fe11b8fbec892571a7ac3e89043c`, not the target branch.
- The worktree was not clean before synchronization: tracked `codexInputs.md` contains the prior
  automated feedback update (206 inserted lines), and an untracked `RegulAIt/` directory is present.
  Both were preserved exactly; no stash, reset, discard, commit, move or deletion was attempted.
- No local `dhruv/active` branch existed. `git fetch origin dhruv/active` succeeded read-only and
  created the remote-tracking ref at `21209b15a5382079c272ac65aa1ca13efda99659`
  (`feat(web): guided use-case intake, and two kit primitives it needed`).
- Git object inspection showed that committed `codexInputs.md` is byte-identical on the current HEAD
  and `origin/dhruv/active` (`8cd87edfd8438b7c54ec3f1f688d8caff59a7ba3`), and the target tree has no
  tracked `RegulAIt` path. Even so, the branch-transition rule permits creating the missing local
  tracking branch only from a clean worktree. Therefore this run did not switch branches, pull, or
  review another branch as a substitute.

**Commands and outcomes**

- Mandatory suite/repository instruction reads — completed before repository action.
- `git status --short --branch`, `git branch --show-current`, `git remote -v`, `git branch -vv`,
  local/remote ref checks — current branch and local-work blocker confirmed.
- `git fetch origin dhruv/active` — PASS; remote target resolved to `21209b15...` without changing
  the checkout.
- `git diff --name-status HEAD..origin/dhruv/active -- codexInputs.md`, committed blob comparisons,
  local diff stat and target-tree collision check — committed feedback blobs match; local feedback
  modification and untracked directory remain.
- `DATABASE_URL` is absent. No tests, migration, source review or product verification ran because
  the target branch could not be checked out safely under the standing branch rule.

**Required user/agent action:** preserve the current `codexInputs.md` feedback and determine ownership
of the untracked `RegulAIt/` directory, then leave the worktree clean on a local `dhruv/active` branch
tracking `origin/dhruv/active`. Until that happens, this automation will continue to refuse review on
the wrong branch. No finding status changed in this blocked run.

### Automated enterprise-readiness run — 2026-09-26 20:47:13 CDT (UTC-05:00)

**Target branch, synchronization and reviewed range**

- Exclusive target: `dhruv/active`.
- The user explicitly requested that the preserved feedback be moved to and maintained on that
  branch. `git switch --track -c dhruv/active origin/dhruv/active` preserved both the modified
  `codexInputs.md` and the unrelated untracked `RegulAIt/` directory; the latter was not read,
  moved, deleted or otherwise changed.
- `git fetch origin dhruv/active` then `git pull --ff-only origin dhruv/active` fast-forwarded the
  branch from `21209b15a5382079c272ac65aa1ca13efda99659` to
  `d03162003a19ed147cce13e2c37d0185a783e3dc`. Local HEAD and
  `origin/dhruv/active` both resolved to `d03162003...` after synchronization.
- The prior blocked-run condition is therefore **resolved**. The last reviewed G2 work is present
  in this branch; because the prior feedback-only commit is not an ancestor, the code review used
  merge-base `5d6cf94a6b94f3b8d90acb617ac547e155cf6dcc` and concentrated on the G9
  authorization callout, guided intake, page-header sweep, and still-open high-risk anchors.

**Commands/tests and outcomes**

- Mandatory suite and repository instruction reads — completed before branch action.
- Branch/remote/status/ref inspection, `git fetch origin dhruv/active`, safe tracking-branch switch,
  and `git pull --ff-only origin dhruv/active` — **PASS**; no merge, rebase, reset, stash, commit,
  push, force operation or product-code edit was performed.
- `git diff --check 5d6cf94..HEAD` — **FAIL** only for a new blank line at EOF in
  `docs/product/PENDING.md:868`; no source whitespace error was reported.
- `corepack pnpm --filter @regulait/web typecheck` — **PASS**.
- `corepack pnpm --filter @regulait/shared test` — **PASS**, 38 files / 912 tests.
- `corepack pnpm --filter @regulait/policy-kernel test` — **PASS**, 2 files / 129 tests.
- The first isolated `corepack pnpm --filter @regulait/gateway typecheck` — **FAIL**, because its
  workspace dependency declarations were stale (new shared/model-provider/DB exports were absent
  from generated package output). `corepack pnpm build` then completed **PASS** for all 15 workspace
  projects, after which the same gateway typecheck completed **PASS**. This is a build-order/setup
  dependency, not evidence of a source compile defect. The web build emitted its existing
  >900 kB chunk-size warning.
- `DATABASE_URL` was absent. No migration or database-backed gateway test was run; the new
  `adr0127-advisory-decisions.test.ts` remains repository-reported evidence, not an independently
  reproduced result. No Envoy or Lua runtime was installed, and ADR-0127 itself records that the
  adapters are not exercised by CI.

#### AER-025 — HIGH — The shipped Envoy adapter cannot implement the endpoint contract and would treat a reachable deny as allow

**Evidence type:** direct source/configuration observation, cross-checked against Envoy's official
HTTP `ext_authz` contract; no Envoy runtime was available locally.

The endpoint requires a JSON POST body containing `userId`, `serverId` and `toolName`
(`packages/shared/src/index.ts:3336-3341`). The shipped Envoy HTTP filter forwards only selected
request headers, has no `with_request_body`, and uses `path_prefix: /v1/authz/check`
(`integrations/envoy/ext_authz.yaml:18-66`). Envoy documents that its HTTP authorization request has
no body by default and that `path_prefix` is prepended to the original request path; this is not a
JSON-body transformation. Therefore an ordinary protected request cannot satisfy the Zod contract
at `apps/gateway/src/app.ts:2093-2099`.

There is a second, security-critical protocol mismatch. Envoy's raw HTTP authorization service
treats **HTTP 200** as allow and non-200 as deny. RegulAIt's endpoint returns HTTP 200 for all three
application decisions, including `deny`, unknown tool, and `approval_required`
(`apps/gateway/src/app.ts:2100-2108,2122-2142`). Consequently a deployment that adds the missing
request transformation but keeps this response contract converts a policy denial into an Envoy
allow. The comments/docs claiming that `approval_required` “arrives as a denial” and that both
adapters fail closed are not true of this configuration.

Official protocol reference used for this check:
https://www.envoyproxy.io/docs/envoy/latest/api-v3/extensions/filters/http/ext_authz/v3/ext_authz.proto

**Impact:** as shipped, the Envoy example is fail-closed but unusable (malformed/wrong-path calls).
If an operator performs the obvious request-shaping repair without also changing the status
contract, policy denials can proceed upstream. This invalidates the documented supported-Envoy
claim at a primary authorization boundary.

**Recommended remediation:** do not present the raw endpoint as an Envoy HTTP `ext_authz` service.
Either add a purpose-built Envoy-compatible endpoint that derives the action from trusted headers
and returns 200 only for allow / 403 for deny and approval-required, or ship a tested transformation
layer with the same status semantics. Keep the JSON decision code in the denial response/header for
the recoverable approval distinction.

**Acceptance evidence required:**

1. Run a real pinned Envoy container with the shipped example (or the replacement) and an
   instrumented upstream. An allowed decision reaches upstream exactly once.
2. `deny`, unknown tool, malformed/missing identity, PDP 4xx/5xx, timeout and network failure each
   produce zero upstream calls.
3. `approval_required` produces zero upstream calls plus the documented
   `x-regulait-decision: approval_required` response signal.
4. The adapter constructs the exact subject/server/tool action without forwarding the original
   protected payload as if it were the PDP request.
5. The adapter is validated in CI against the minimum and current supported Envoy versions.

#### AER-026 — HIGH — The sample adapters trust a caller-controlled subject header

**Evidence type:** direct source/configuration observation; exploitability depends on an operator's
unshown filters, which the shipped examples do not provide.

The Kong sample chooses `x-regulait-subject` before the authenticated consumer's `custom_id`
(`integrations/kong/regulait-authz.lua:27-35`). The Envoy sample permits the same downstream header
and forwards it to the PDP (`integrations/envoy/ext_authz.yaml:44-50`). Neither artifact removes the
client value and overwrites it from a verified JWT, mTLS principal, or Kong consumer mapping. The
topology document says the gateway “must map” its authenticated identity and admits that a wrong
mapping makes a decision about the wrong person (`docs/deployment/GATEWAY_TOPOLOGY.md:44-54`), but
the worked examples do not implement or enforce that prerequisite.

**Impact:** unless a deployment adds an undocumented sanitization/mapping stage, a caller can name
another RegulAIt user UUID. If that user has broader grants, the PDP answers the wrong subject's
question and the data plane may authorize an otherwise forbidden request.

**Recommended remediation:** make identity derivation part of each adapter, not a comment. Reject
the request if a trusted identity cannot be mapped. Never prefer a downstream-supplied subject
header. If a header must cross filter stages, strip any inbound copy and set it from authenticated
dynamic metadata/consumer data in a named, tested stage.

**Acceptance evidence required:**

1. A client-supplied `x-regulait-subject` for a privileged user is ignored or rejected for both
   adapters; the upstream sees zero calls.
2. The authenticated principal maps deterministically to one RegulAIt user; unmapped, ambiguous,
   disabled and deleted identities fail closed.
3. Tests prove the map cannot be bypassed by duplicate/case-varied headers or by omitting the
   authenticated consumer while supplying the subject header.
4. Audit evidence records both the authenticated workload/consumer identity and resolved subject
   without putting either under client control.

#### AER-027 — HIGH — The documented PDP secret is an unrestricted administrator credential

**Evidence type:** direct authorization-model observation.

`POST /v1/authz/check` is absent from `NON_ADMIN_ROUTES`, so the central route classifier's default
is `admin` (`apps/gateway/src/route-classes.ts:421-446`). Ordinary API keys inherit the owning
user's `isAdmin` bit (`apps/gateway/src/auth.ts:189-221`); the schema documentation explicitly says
an ordinary API key carries admin-ness and reaches every route its user may
(`packages/db/src/schema.ts:6895-6899`). There is no callout-only service credential or route scope.
The topology asks operators to place this key in Envoy/Kong and calls it a subject-impersonation
key, but a stolen key can also invoke the entire admin control plane.

**Impact:** compromise of a data-plane secret can become full organization administration: policy,
identity, connector, provider and deployment configuration are in the blast radius. “Its own key”
does not create least privilege when all keys for an admin user have identical authority.

**Recommended remediation:** introduce a separate workload/service credential type or explicit API
key scopes. A PDP key should be accepted only on the callout (and narrowly necessary health/key
rotation surfaces), have TTL/rotation/revocation, optional network/mTLS binding, and a distinct
audit principal. Do not solve this with a convention that the key is “used only there.”

**Acceptance evidence required:**

1. A callout-scoped credential can call `/v1/authz/check` but receives 403 on representative user,
   policy, secret, provider, connector and execution-control admin routes.
2. A normal non-admin key and virtual key cannot impersonate arbitrary subjects through the
   callout; bootstrap and human session credentials are either explicitly prohibited or justified.
3. Revocation/expiry takes effect on the next check and is independently audited.
4. The adapters can load/rotate the scoped credential without committing it or exposing it in
   process listings, logs, error bodies or configuration exports.

#### AER-028 — HIGH — The callout omits arguments, project attribution and request principal, so “same governance” is not true

**Evidence type:** direct source observation plus passing pure policy-kernel tests; endpoint behavior
was not database-reproduced.

The wire schema names only user, server and tool (`packages/shared/src/index.ts:3336-3341`). The
route calls `governedEvaluate` with `args = undefined`, `projectId = null`, and
`principal = undefined` (`apps/gateway/src/app.ts:2111-2120`). Those are material policy inputs:

- data-scope rules require an argument at their configured path and fail closed when it is missing
  (`packages/policy-kernel/src/index.ts:833-850`), so a correctly scoped action is always refused;
- deploy-mode-scoped approval, rate-limit and data-scope rules do not match an unattributed call
  (`apps/gateway/src/governed-evaluate.ts:132-151` and
  `packages/policy-kernel/src/index.ts:623-639`), so a real project's restrictions can disappear;
- active ABAC policies evaluate with no authenticated-session facts and a null project
  (`apps/gateway/src/governed-evaluate.ts:479-508`).

The topology discloses missing payload-dependent PII/guardrail/output/cost features, but it does not
disclose that authorization itself can diverge. ADR-0127 and the handler call it “same kernel, same
governance,” while the topology table says the answer means “entitled, within limits, nothing
pending” / “out of scope.” Those claims exceed the three-field decision contract.

**Impact:** customers can receive false denials for data-scoped tools and false allows where a
project/deploy-mode restriction would have bound the real action. Session-conditional ABAC can also
answer a different question from the one the gateway is enforcing.

**Recommended remediation:** define a canonical, versioned authorization action envelope containing
the policy-relevant context, with provenance rules for each field. Arguments or extracted resource
attributes must be size-limited and scrubbed; project and authentication facts must come from
trusted gateway identity/context, not arbitrary client JSON. If the product intentionally supports
only context-free authorization, reject context-dependent tools/policies explicitly and narrow the
claims/UI/docs.

**Acceptance evidence required:**

1. A data-scope rule allows a matching resource argument and denies a non-matching/missing one
   through the real adapter; the upstream call count proves enforcement.
2. A project with an active deploy-mode restriction produces the same decision in the callout and
   the in-line path; an unattributed request does not bypass it.
3. Session/IP/authentication-strength ABAC decisions are either faithfully represented from trusted
   metadata or the callout refuses them by name.
4. Exact-action approvals bind to the same canonical context in both paths; changed arguments or
   project cannot spend another action's consent.
5. A parity matrix covers entitlement, revocation, execution posture, rate limits, data scope,
   approvals, ABAC and project/deploy context, and explicitly lists payload-only controls as absent.

#### AER-029 — MEDIUM — The guided intake's new controls have visible text but no accessible labels

**Evidence type:** direct React source observation; web typecheck passed, browser/accessibility test
was not run.

The new wizard renders “Compliance tags,” “Intended agent (optional),” and “Project (optional)” as
plain `<span>` elements (`apps/web/src/views/admin/governance/UseCasesPage.tsx:359-406`). They are
not `<label>` elements and have no `htmlFor`/`aria-labelledby` relationship. `TagPicker` supports an
`id` but this call does not pass one; its input receives `id={props.id}` only
(`apps/web/src/ui/kit.tsx:185-223`). Both `<Select>` controls are therefore unnamed too. The new
visual test locates the tag input with `input[list]`, which avoids detecting the missing label.

**Impact:** screen-reader and voice-control users cannot reliably identify or target three material
governance inputs. This also weakens automated regression coverage for the intake flow.

**Recommended remediation:** expose label/id (or `aria-labelledby`) wiring through `TagPicker` and
use the existing `Field` primitive or explicit labels for both selects. Keep the adjacent
`InfoButton` separate from the control's accessible name.

**Acceptance evidence required:** Playwright `getByLabel` must uniquely resolve all three controls;
tab/shift-tab, Enter, Escape and screen-reader names must be verified; add an automated accessibility
scan of every wizard stage and both themes with no serious/critical violations.

**Prior-finding status and remaining uncertainty**

- AER-017, AER-018, AER-019, AER-021 and AER-022 remain open HIGH findings. The current source still
  omits a Google/Gemini abort signal (`packages/model-provider/src/index.ts:1265-1288`) and confines
  MCP breaker accounting to the outer proxy connect/handshake
  (`apps/gateway/src/mcp-proxy.ts:1310-1398`). G9 did not close the execution-mode, kill-switch or
  emergency-state atomicity findings.
- AER-004, AER-007, AER-010, AER-011 and AER-014 remain open HIGH/residual findings; the reviewed
  range did not supply direct evidence for closure. AER-023 and AER-024 remain MEDIUM.
- The G9 endpoint tests cover its JSON contract and advisory ledger behavior, not either adapter,
  identity mapping, least-privilege credentialing, or project/argument/session parity. A successful
  build, 1,041 passing pure/shared tests and typechecks do not prove the database path, proxy
  integration, production readiness, certification or enterprise readiness.
- `PathForward.md` already carries the strategic workload-identity, constrained-delegation and
  policy-decision-contract direction; this run therefore did not duplicate operational defects into
  that roadmap. `codexInputs.md` remains the single implementation feedback ledger.

### Automated enterprise-readiness run — 2026-09-27 00:35:41 CDT (UTC-05:00)

**Target branch, synchronization and reviewed range**

- Exclusive target: `dhruv/active`.
- The run began with local HEAD and `origin/dhruv/active` at
  `4692894a99fbad4eae1ecdb934255ae6408f8467`. The only pre-existing worktree item was the unrelated
  untracked `RegulAIt/` directory; it was not read, moved, staged or changed.
- `git fetch origin dhruv/active --prune` advanced the upstream ref to
  `717a2034622273ec9fabfbbddc96bde1f361a83e`; `git pull --ff-only origin dhruv/active` then
  fast-forwarded the checkout to the same commit without merge, rebase, reset or stash. The required
  pre-publication fetch found one further non-conflicting script-only commit, so a second
  fast-forward-only pull advanced both local and upstream to
  `d370b9285eab768cbd5b7646b3d56c267f2dff1e` while preserving this feedback.
- Incremental review range: `4692894..d370b92` (ten commits, 25 files), plus the still-open
  authorization-callout findings. The range withdraws the Envoy adapter, changes the Kong adapter,
  adds multiple UI deletion paths and an affordance census, fixes the guided-intake labels, adds an
  approval status filter, and changes the shared `Field` labelling behavior.

**Commands/tests and outcomes**

- Mandatory suite and repository instruction reads — completed before synchronization and review.
- Branch/status/remote/ref inspection, two `git fetch origin dhruv/active --prune` checks, delta
  inspection and two `git pull --ff-only origin dhruv/active` operations — **PASS**; local/upstream
  both became `d370b92...`, and the second upstream delta did not touch `codexInputs.md`.
- Commit-by-commit `git show`, line-numbered inspection of the changed integration, deployment,
  ADR, UI and test files, and targeted `rg` claim/usage searches — completed.
- Kong's current primary documentation was checked for the serverless plugin execution phase,
  priority and sandbox contract. This is documentation-backed source analysis; no Kong runtime was
  exercised. References:
  https://developer.konghq.com/plugins/pre-function/ and
  https://developer.konghq.com/support/error-require-resty-http-not-allowed-within-sandbox/.
- `corepack pnpm --filter @regulait/web typecheck` — **PASS**.
- `corepack pnpm --filter @regulait/web build` — **PASS**; Vite repeated the existing warning that
  the main JavaScript chunk is 1,116.42 kB (309.99 kB gzip), above the configured 900 kB warning
  threshold.
- `node scripts/preflight-ui-affordances.mjs` — **EXIT 1 by the script's stated contract**, both
  before and after the final script-only commit. Final output: 53 DELETE routes, 51 detected as
  reachable, zero exempt, and two still orphaned (`/v1/approvals/views/:x`,
  `/v1/llm/backend-configs/:x`), plus two collections listed but not addable from the UI
  (`/v1/copilot/proposals`, `/v1/redteam/libraries`). This is a source-pattern census, not
  behavior proof; its own header says it is not yet a required gate.
- Node `v22.19.0` and pnpm `10.33.0` matched the repository floor/pin. Docker is installed, but no
  Kong image or Lua runtime was present locally. No image was downloaded and no service was started.
- `DATABASE_URL` was absent. The Playwright global setup drops a fixed default database named
  `regulait_wt_spa`, so the browser suite was not run without proof that no other session could be
  using it. No database, migration, cloud, provider or deployment test ran.

#### AER-030 — HIGH — The remaining Kong adapter is not runnable as the documented pre-function and cannot bind a distinct action per route

**Evidence type:** direct source/configuration observation, cross-checked against Kong's official
plugin and sandbox documentation; no Kong runtime was available locally.

The artifact tells an operator to drop the file into a Kong `pre-function`
(`integrations/kong/regulait-authz.lua:1-4`). In that mode, three independent contract mismatches
remain:

1. Kong documents the Pre-Function plugin as priority `1000000` and says it runs before other
   plugins in the phase. The script obtains identity only from `kong.client.get_consumer()` and
   refuses when it is absent (`integrations/kong/regulait-authz.lua:81-96`). With an ordinary Kong
   authentication plugin on the same route, the pre-function runs first, before that plugin can set
   the authenticated consumer. The shipped path therefore refuses normal authenticated traffic.
2. The first executable line loads `resty.http` (`integrations/kong/regulait-authz.lua:40`). Kong's
   default serverless-function sandbox is restricted, and Kong's own support documentation uses
   `require "resty.http" not allowed within sandbox` as the exact failure example. The repository
   provides no required `untrusted_lua` configuration, pinned Kong version or security analysis for
   weakening that sandbox. `os.getenv` usage (`:43-50`) adds another unproved sandbox dependency.
3. The comments say the server/tool question is configured per route, but both are process
   environment variables (`:46-51`). Environment variables are node/process configuration, not a
   value attached to an individual Kong Route or plugin instance. On one Kong data plane serving
   multiple governed routes, every copy of this file reads the same pair. Once an operator gets the
   script running, route B can therefore be checked as route A's server/tool — the same
   question-versus-action mismatch the header fix intended to remove.

**Impact:** the only remaining advertised adapter is fail-closed but unusable under Kong's normal,
secure serverless-plugin configuration. Workarounds invite operators to disable/relax the Lua
sandbox or reorder/replace authentication without a supported design. A single process-wide action
pair can also turn a truthful `allow` for one tool into admission of a different route. This means
the current “Kong only” / supported-deployment claim is not backed by a runnable integration at the
primary authorization boundary.

**Recommended remediation:** withdraw the Kong support claim until it passes a pinned-container
test. Prefer a real versioned Kong plugin with a schema carrying `serverId`, `toolName`, PDP URL and
vault reference per plugin/Route instance, and an explicit priority that runs after the supported
authentication plugins but before proxying. If Pre-Function remains an example, embed non-secret
route-specific constants in each route's plugin configuration, name the exact safe sandbox settings,
derive identity from a fact guaranteed to exist at that phase, and do not require unrestricted
`os`/module access. A process environment variable is acceptable for a node-wide PDP address, not
for the action being authorized.

**Acceptance evidence required:**

1. Against pinned minimum and current Kong containers with default-secure settings, the adapter
   loads without relaxing the sandbox beyond a documented minimum and observes a consumer created
   by each supported authentication plugin.
2. Two routes in one Kong instance carry different server/tool bindings. A subject entitled only to
   route A gets one upstream call for A and zero for B; the PDP ledger proves the exact two actions
   asked.
3. Client-supplied, duplicated and case-varied subject/server/tool/decision headers cannot alter the
   action or survive to upstream.
4. Missing/disabled/unmapped consumer, missing route configuration, malformed PDP response, 4xx,
   5xx, timeout and network failure each produce zero upstream calls.
5. `allow`, `deny` and `approval_required` are exercised end to end with an upstream invocation
   counter, and CI runs the same test rather than treating Lua review as execution evidence.

#### AER-031 — MEDIUM — The Envoy withdrawal was not reconciled across current support claims

**Evidence type:** direct documentation observation.

The corrected topology banner says there is no Envoy adapter
(`docs/deployment/GATEWAY_TOPOLOGY.md:6-14`), but the same current page still says “both adapters
fail closed” and “both adapters ship” a timeout (`:36-38,63-70`), and later says the HTTP variant
works against the endpoint (`:110-115`). The deployment index still advertises “the Envoy and Kong
adapters” (`docs/deployment/README.md:17`). ADR-0127 still calls this a supported deployment with two
worked adapters (`docs/decisions/0127-authorization-callout.md:122-133`), while its later limits say
nothing under `integrations/` should be called supported before a pinned-container denial test
(`:136-142`). `docs/decisions/README.md:135` and `docs/product/ROADMAP.md:754` retain the shipped,
two-adapter account as well.

**Impact:** an operator can land on current documentation that contradicts the withdrawal and can
reasonably conclude Envoy remains supported. More broadly, the repository marks G9 shipped while
the sole remaining Kong path has never been run and has the AER-030 blockers above. Historical ADR
text may remain historical, but current indexes and roadmap status are product claims.

**Recommended remediation:** perform a repository-wide claim reconciliation, preserving the ADR's
history as an explicitly dated correction while changing current deployment/index/roadmap language
to “endpoint implemented; adapters experimental/withdrawn” until executable evidence exists. Link
every support claim to the pinned integration test and supported-version matrix.

**Acceptance evidence required:** `rg` finds no current statement that two adapters ship, Envoy is
supported, or the deployment is supported; historical text is visibly superseded. A support matrix
names Kong/Envoy versions, status, last runtime-test commit and limits. G9 becomes shipped again only
after the applicable real-proxy suite passes.

#### AER-032 — MEDIUM — Disabled destructive controls hide the explanation from keyboard and assistive-technology users

**Evidence type:** direct React/HTML source observation; browser accessibility behavior was not run.

The shared `RemoveButton` promises that an inapplicable action is “disabled and explained,” but it
puts `disabledReason` only in the native disabled button's `title`
(`apps/web/src/views/admin/adminKit.tsx:205-227`). Disabled buttons are not keyboard-focusable, and a
`title` tooltip is not a reliable accessible description. The visible button and its `aria-label`
contain only the action/object, not the reason. This pattern now carries material guidance for
role-derived agent, connector and MCP grants, active compliance packs, initiatives with projects,
and frozen eval datasets (for example `AgentsPage.tsx:770-773`, `McpServersPage.tsx:203-206`,
`CompliancePacksPage.tsx:350-353`, and `EvalsPage.tsx:611-614`). A mouse user may discover the
tooltip; a keyboard or screen-reader user may encounter an unavailable action with no reason or
remediation.

**Impact:** administrators using keyboard or assistive technology cannot learn why a governance
operation is unavailable or which safer action to take. This directly undercuts the new surface's
stated “never hidden; explained” behavior.

**Recommended remediation:** render the reason as visible row text or a focusable explanatory
control and connect it with `aria-describedby`. If the button must remain in the tab order for
discovery, use `aria-disabled` plus an event guard; otherwise keep native `disabled` and place the
reason in adjacent persistent text that is reachable and programmatically associated. Do not rely
on `title` as the sole channel.

**Acceptance evidence required:** tab/shift-tab and a screen reader expose each disabled reason and
its remediation; pointer, keyboard and touch users receive the same information; automated tests
assert the accessible description for representative direct, role-derived, active/frozen and
dependency-blocked rows.

**Prior-finding status and remaining uncertainty — 2026-09-27 00:35 CDT**

- **AER-025 is mitigated by withdrawal, not closed as delivered functionality.** The executable
  Envoy configuration was removed and the main topology banner warns against using it. There is no
  longer a shipped fail-open config on this branch. A supported Envoy claim remains unearned, and
  AER-031 records the stale current references.
- **AER-026's direct spoof paths are removed in source for Kong, and Envoy is withdrawn.** Kong now
  derives `subject` from `consumer.custom_id`, binds server/tool away from request headers and
  clears client protocol headers. Runtime closure is not yet justified: AER-030 shows the documented
  phase cannot obtain a normal authenticated consumer and the action is not actually per-route.
- **AER-029 is resolved in source.** The intake now wires real labels/ids and the changed Playwright
  spec uses exact `getByLabel` queries for all three controls. The repository reports the browser
  test passing; this run independently passed typecheck/build but did not run the browser suite
  because its fixed scratch database could not be proved exclusive.
- AER-027 and AER-028 remain open HIGH findings; this range explicitly acknowledges them but does
  not add a callout-scoped credential or the missing action context. AER-017, AER-018, AER-019,
  AER-021 and AER-022 also remain open HIGH; their enforcement/provider/MCP paths were not changed.
  No reviewed evidence closes AER-004, AER-007, AER-010, AER-011 or AER-014.
- The web build and source-level affordance census establish compilation and declared UI reachability,
  not deletion semantics, database integrity, proxy enforcement, accessibility conformance,
  production readiness, certification or enterprise readiness. The repository-reported full web
  suite remains unverified in this run.

### Automated enterprise-readiness run — 2026-09-27 05:35:45 CDT (UTC-05:00)

**Target branch, synchronization and reviewed range**

- Exclusive target: `dhruv/active`.
- The run began with local HEAD and `origin/dhruv/active` at
  `3b4635de53d58c338696099eadf19d1ed5ab59ed`. The only pre-existing worktree item was the unrelated
  untracked `RegulAIt/` directory; it was not read, moved, staged or changed.
- `git fetch origin dhruv/active --prune` and `git pull --ff-only origin dhruv/active`
  fast-forwarded the checkout to `a5c873409e5875fd0dbdffa0eafde4b78de20fd6`, matching upstream,
  without merge, rebase, reset or stash.
- Incremental review range: `3b4635d..a5c8734` (nine commits, 14 files), plus the still-open
  authorization-callout findings. The range replaces the unusable Kong pre-function with a custom
  plugin, adds and runs a real Kong container harness, makes that harness a PR gate, restores the
  narrow Kong support claim, and changes the blocked-removal accessibility behavior.

**Commands/tests and outcomes**

- Mandatory suite and repository instruction reads — completed before synchronization and review.
- Branch/status/remote/ref inspection, `git fetch origin dhruv/active --prune`, commit/delta
  inspection and `git pull --ff-only origin dhruv/active` — **PASS**; local and upstream reached
  `a5c8734...` and tracked files remained clean.
- `git diff --check 3b4635d..HEAD` — **PASS**.
- `node --check integrations/kong/test/verify.mjs` and
  `node --check integrations/kong/test/upstream.mjs` — **PASS**.
- `corepack pnpm --filter @regulait/web typecheck` — **PASS**.
- `corepack pnpm --filter @regulait/web build` — **PASS**; Vite reported a 1,116.80 kB main
  JavaScript chunk (310.10 kB gzip), above the configured 900 kB warning threshold.
- `node scripts/preflight-ui-affordances.mjs` — **EXIT 1 by the script's stated contract**: 53
  DELETE routes, 51 detected as reachable, zero exempt and two orphaned
  (`/v1/approvals/views/:x`, `/v1/llm/backend-configs/:x`), plus two listed collections without an
  add affordance (`/v1/copilot/proposals`, `/v1/redteam/libraries`). These are unchanged open UI
  gaps; the result is source-pattern evidence, not runtime proof.
- GitHub Actions run `36300665525`, job `108567580158`, was independently inspected with `gh`:
  **PASS** on PR head `4d7bd55458961a542a90760be7037ce6fd7a7921`. Its build, Kong pull and
  adapter-verification step succeeded. The job log confirms only unauthenticated, allow, policy
  deny, three subject-header spellings and unreachable-PDP assertions. Evidence URL:
  https://github.com/dhruvmahendrapatel/RegulAIt/actions/runs/36300665525
- The local Kong harness was not rerun. No Kong image was installed locally, its script drops a
  fixed database and uses fixed ports/container names, and no exclusive disposable database was
  available. No database, browser, migration, cloud, provider or deployment test ran.

#### AER-033 — HIGH — The Kong verification harness persists an unrestricted administrator key in a world-readable temporary file

**Evidence type:** direct source observation. GitHub-hosted runners are ephemeral, but local and
self-hosted-runner exposure was not reproduced with another operating-system account.

The harness mints a key for `admin@regulait.local` and retains its one-time plaintext token
(`integrations/kong/test/verify.mjs:154-159`). It then changes the generated temporary directory to
mode `0755`, interpolates that token literally as `pdp_key` in `kong.yml`, and changes the file to
mode `0644` (`:166-204`). Any local account able to traverse the normal system temporary directory
can therefore read the full administrator bearer credential during the run. The `finally` block
removes the Kong container and kills processes, but does not delete the host directory/file, revoke
the key or drop the scratch database (`:333-353`). A source search found no `rmSync`, `unlink`, key
revocation or final database drop. Redaction in the diagnostic `cat` output (`:250-260`) does not
remove the on-disk secret.

**Impact:** the newly required security gate leaves a durable, broadly readable control-plane
credential on developer machines and persistent/self-hosted runners. Because AER-027 remains open,
this is not a callout-scoped token: it is an unrestricted administrator identity. A second local
user or later process can use the retained credential against a gateway/database that remains
reachable, turning an integration check into full administrative compromise. The ephemeral nature
of GitHub-hosted runners reduces persistence there; it does not make the documented local harness
safe.

**Recommended remediation:** do not serialize a plaintext administrator token into a
world-readable bind mount. Give the adapter a purpose-built, action-scoped workload credential as
required by AER-027; inject it through a Kong-supported secret/vault mechanism with the narrowest
possible exposure. Keep any unavoidable host directory/file owner-only, and make the container
access it without granting every host user read access. In an unconditional cleanup path, revoke
the minted key, remove the complete temporary directory, and drop a uniquely named scratch
database only after proving it belongs to this run. Apply the same cleanup when startup or an
assertion fails.

**Acceptance evidence required:**

1. A synthetic canary token cannot be read by a non-runner OS account from the temp directory,
   container configuration/inspection, process arguments or logs during the run.
2. Normal success, Kong startup failure, assertion failure and interruption each leave no canary in
   the host temp tree and no reusable key or owned scratch database.
3. The callout credential is denied on unrelated administrative routes and is revocable without
   rotating a human/admin identity.
4. A concurrent run uses unique resources and cannot delete, reuse or expose another run's secret
   or database.

#### AER-034 — MEDIUM — The restored Kong verification claim exceeds the assertions and change coverage of its gate

**Evidence type:** source-to-documentation comparison plus independently inspected repository-run
log; missing cases are not inferred from a green summary.

`integrations/kong/README.md:57-69` says the harness asserts zero upstream calls for policy `deny`,
`approval_required`, PDP unreachable, PDP non-200 or unparseable, and a forged subject header. The
executable assertions at `integrations/kong/test/verify.mjs:290-330` cover unauthenticated, allow,
one policy deny, three spellings of only `x-regulait-subject`, and PDP unreachable. There is no
approval-required, reachable-PDP non-200 or unparseable-response test. The independently inspected
green Actions log lists exactly the smaller set; it does not support the broader README statement.

The harness also creates only one governed route with one server/tool binding (`verify.mjs:172-201`).
It therefore does not satisfy AER-030's two-route acceptance test proving that two plugin instances
in one Kong process authorize distinct actions, nor does it exercise forged server/tool/decision
headers, missing route mappings or disabled/deleted identities. Finally, the required workflow is
triggered only by `integrations/**` and its own YAML (`.github/workflows/integrations.yml:24-29`).
Changes to the gateway PDP route, shared decision schema, authorization semantics, seed or lockfile
can break the contract without running this gate. `kong:3.6` and `postgres:16` are mutable tags,
not immutable image pins, despite the workflow's “PINNED” label (`:36-55`).

**Impact:** the one observed runtime is valuable evidence for a narrow Kong 3.6 DB-less/key-auth
path, but the repository describes refusal modes it did not run and labels a mutable environment as
pinned. Contract changes outside `integrations/` can merge without exercising the adapter. This can
turn a truthful narrow verification into false confidence about action binding and fail-closed
coverage.

**Recommended remediation:** either narrow the README to the assertions that exist or, preferably,
add deterministic PDP fixtures/fault injection for `approval_required`, non-200 and malformed
responses, plus a second route/plugin instance with a different tool. Assert zero upstream calls
for every refusal and prove the PDP ledger received the exact route-specific action. Add missing
mapping/identity/header cases. Expand workflow path coverage to the gateway endpoint, shared
contract/schema, relevant authorization/seed code and dependency lockfile. Pin exact Kong/Postgres
patch versions and immutable digests while still testing an explicitly scheduled/current-version
compatibility lane.

**Acceptance evidence required:** the README case list is generated from or maps one-to-one to
named passing assertions; two routes cannot borrow each other's grant; every documented refusal has
zero upstream calls; deliberate malformed/non-200 fixtures fail closed; a gateway contract change
causes the workflow to run; and logs record exact image digests and tested commit.

**Prior-finding status and remaining uncertainty — 2026-09-27 05:35 CDT**

- **AER-030 is partially resolved, not closed against its acceptance contract.** The custom plugin
  fixes the pre-function phase/sandbox defects and moves server/tool into per-plugin configuration.
  The inspected real-container run proves allow, one deny, subject spoof resistance and PDP-outage
  failure for one Kong 3.6 DB-less/key-auth route. AER-034 records the missing second-route and
  documented refusal cases; `handler.lua:42` also still reports version `0.1.0-unverified`.
- **AER-031 is substantially corrected but retains a current contradiction.** The topology and
  support matrix now withdraw Envoy and narrowly scope Kong. The deployment index nevertheless says
  “Kong only ... no Envoy adapter” and then, in the same entry, advertises “the Envoy and Kong
  adapters” (`docs/deployment/README.md:17`). Remove the second phrase or label historical content.
- **AER-032 is resolved in source and repository-reported browser evidence.** `RemoveButton` now
  uses a focusable `aria-disabled` control with an adjacent keyboard-operable reason control
  (`apps/web/src/views/admin/adminKit.tsx:206-271`), and the new browser test covers focus, Tab,
  Enter, visible note, Escape and focus return
  (`apps/web/e2e/zz-zz-zz-zz-zz-zz-zz-zz-zz-zz-blocked-reason-a11y.spec.ts:55-85`). This run
  independently passed typecheck/build but did not run the database-backed browser test.
- **AER-026 now has narrow runtime evidence for Kong subject spoofing.** The run proves three header
  spellings do not borrow another consumer's entitlement. Duplicate-header behavior and the other
  reserved protocol fields remain untested. Envoy remains withdrawn.
- **AER-027 and AER-028 remain open HIGH findings.** The new harness explicitly uses an admin API
  key and its callout still omits arguments, project attribution and request principal. AER-033 makes
  the key's operational handling a separate high-severity defect. No reviewed code closes AER-017,
  AER-018, AER-019, AER-021 or AER-022; no evidence in this range closes AER-004, AER-007, AER-010,
  AER-011 or AER-014.
- A green PR job for one topology, local compilation and a source-pattern census do not prove all
  supported Kong versions/modes, secret containment, approval semantics, database integrity,
  accessibility conformance, production readiness, certification or enterprise readiness.

### Automated enterprise-readiness run — 2026-09-27 10:47:09 CDT (UTC-05:00)

**Target branch, synchronization and reviewed range**

- Exclusive target: `dhruv/active`.
- The run began with local HEAD and `origin/dhruv/active` at
  `9f7d3563cebf67c72107680d898e5392a687f8af`. The only pre-existing worktree item was the unrelated
  untracked `RegulAIt/` directory; it was not read, moved, staged or changed.
- `git fetch origin dhruv/active --prune` advanced the upstream ref to
  `7c985468a7b25525141d051409deb7c7cab71938`; `git pull --ff-only origin dhruv/active` then
  fast-forwarded the checkout to the same commit without reset, stash, rebase or a new local merge.
- Incremental review range: `9f7d356..7c98546` (eight commits, 34 files), plus still-open
  high-risk findings. The range scopes the PDP key, adds callout context, changes the Kong harness,
  adds a copilot proposal form/diff validation, adds approval filters/saved-view UI, and changes
  seeded/e2e licensing.

**Commands/tests and outcomes**

- Mandatory suite and repository instruction reads — completed before synchronization and review.
- Branch/status/remote/tracking inspection, `git fetch origin dhruv/active --prune`, delta review and
  `git pull --ff-only origin dhruv/active` — **PASS**; local/upstream reached `7c98546...` and tracked
  files remained clean.
- `git diff --check 9f7d356..HEAD` and `node --check integrations/kong/test/verify.mjs` — **PASS**.
- Direct package typechecks immediately after the pull: web and shared — **PASS**; database and
  gateway — **FAIL** because those packages resolve `@regulait/shared` from the prior local
  `dist/` declarations. This was an ordering/artifact failure, not suppressed. The repository's
  dependency-ordered `corepack pnpm -r build` rebuilt shared first and then **PASSED** all 15
  workspace builds; explicit database and gateway typecheck reruns then **PASSED**.
- The build's web bundle completed with a 1,141.24 kB main JavaScript chunk (317.24 kB gzip), above
  the configured 900 kB warning threshold.
- `corepack pnpm --filter @regulait/shared test` — **PASS**, 38 files / 912 tests.
- `node scripts/preflight-ui-affordances.mjs` — **EXIT 1 by the script's stated contract**, improved
  from the prior run: 53 DELETE routes, 52 detected as reachable, zero exempt and one orphaned
  (`/v1/llm/backend-configs/:x`); one listed collection remains without an add affordance
  (`/v1/redteam/libraries`). The saved-view delete and copilot-proposal add gaps are closed in the
  source census; this is not behavioral browser proof.
- GitHub PR 114 at exact head `7c98546...` reports **PASS** for CI run `36319393210` and Integrations
  run `36319393190`. The CI log reports 196 gateway test files, 2,921 passed / 9 skipped, including
  AER-027 (9), AER-028 (6) and queue-filter (9) tests. The Kong job's log still lists only
  unauthenticated, allow, policy deny, three subject-header spellings and unreachable-PDP
  assertions. These are repository-run results independently inspected with `gh`, not locally
  reproduced database/proxy results.
- `DATABASE_URL` was absent. No local database, migration, gateway integration, Playwright, cloud,
  provider or deployment test ran; the fixed database/port/container harnesses were not invoked
  without an explicitly exclusive disposable environment.

#### AER-035 — HIGH — Copilot proposal application is neither concurrency-safe nor atomic with its mutation and audit

**Evidence type:** direct source/control-flow observation. The race and injected-failure paths were
not reproduced because no exclusive disposable database was available.

The apply route reads a proposal and checks `appliedAt` in separate ordinary queries
(`apps/gateway/src/copilot.ts:2037-2067`). It then performs the approved mutation
(`:2123-2259`), unconditionally marks the proposal applied using only `WHERE id = ...`
(`:2261-2265`), and writes the `copilot-proposal-applied` audit event afterwards (`:2267-2277`).
There is no outer transaction, row lock, atomic claim or compare-and-set on `appliedAt` spanning
those operations.

Two concurrent requests can therefore both observe `appliedAt = NULL` and both execute the same
consent. The `rule_to_approval` branch is the clearest material case: each caller reaches
`createApprovalRuleRow` (`copilot.ts:2217`), whose implementation is an unconditional insert with a
new random id and no proposal-id uniqueness (`apps/gateway/src/rule-creates.ts:52-69`). One human
approval can create two live governance rules, while the proposal row's final `appliedResult`
records only whichever update won last. A failure after the mutation but before the applied marker
leaves a real change replayable; a failure after the marker but before the audit leaves an applied
change without the audit row the route promises. The tests prove only sequential replay refusal:
one request completes before the second begins
(`apps/gateway/src/zz-zz-copilot-live.test.ts:599-617,771-786,908-931`). No concurrent
`Promise.all` or failure-boundary test exists.

**Impact:** a client retry, load-balancer retry or two administrators can spend one recorded consent
more than once. Duplicate approval rules can create duplicate governance effects/queue work;
policy edits can mint extra versions; and partial failures can leave the proposal record, actual
policy state and audit ledger disagreeing. This breaks the route's explicit “mutation happens once”
and “audited under the applying human” claims at a privileged governance boundary.

**Recommended remediation:** make application one database transaction over a locked proposal and
approval. Either acquire `SELECT ... FOR UPDATE` on the proposal before rechecking `appliedAt`, or
atomically claim a durable applying state with `UPDATE ... WHERE applied_at IS NULL RETURNING` and
define safe recovery of abandoned claims. Execute the target mutation, proposal result/marker and
audit-chain append in the same transaction; refactor the shared mutation helpers to accept that
transaction rather than starting an independent one. Add a proposal/application idempotency key or
unique source-proposal reference to created artifacts so crash recovery cannot create a second row.

**Acceptance evidence required:**

1. Twenty simultaneous apply requests for one approved `rule_to_approval` proposal yield exactly
   one success, one rule, one applied marker/result and one apply audit; all others get the same
   explicit already-applied/in-progress result.
2. Repeat the concurrency test for policy tightening, grant revocation and budget adjustment; no
   duplicate version, audit, removal or overwrite occurs.
3. Fault injection after the target mutation, after the proposal marker and before audit proves the
   transaction either commits all three facts or rolls back all three.
4. A process crash during an applying claim has a documented, bounded recovery path that cannot
   silently replay a completed mutation.

**Prior-finding status and remaining uncertainty — 2026-09-27 10:47 CDT**

- **AER-033's HIGH credential exposure is resolved in source and in the repository-run Kong job.**
  The harness now mints a `purpose: "pdp"` virtual key, stores only a Kong vault reference in the
  world-readable declarative file, and injects the scoped secret into the short-lived container
  (`integrations/kong/test/verify.mjs:151-170,205-248`). The green head run proves that path starts
  and enforces the tested cases. Residual hygiene remains: the script still does not remove its
  host temp directory, revoke the scratch key or drop its fixed scratch database in `finally`;
  those no longer leave a plaintext administrator token, but should still be cleaned up and made
  per-run before the harness is safe for concurrent/self-hosted use.
- **AER-027 is resolved in source with repository-run database evidence.** Migration 0117 adds a
  closed `dispatch|pdp` purpose; unknown purposes fail to an empty route set; a PDP key reaches only
  `POST /v1/authz/check`; dispatch keys cannot ask; PDP keys cannot dispatch/admin; issuance is
  admin-only and revocation is tested. The head CI log reports all nine focused tests passing. This
  run did not reproduce them locally.
- **AER-028 is partially resolved, not closed for the shipped adapter.** The endpoint now accepts
  `args`, `projectId` and principal facts, passes them into the kernel and reports the names in
  `contextApplied`; all six focused tests pass in head CI. The Kong plugin still sends only
  `userId`, `serverId` and `toolName`
  (`integrations/kong/kong/plugins/regulait-authz/handler.lua:91-107`). Its README explicitly
  discloses missing `args`, but the adapter also omits project/principal context. Operators using
  Kong therefore still do not get parity with a context-bearing dispatch; absent data-scope args
  fail closed as documented.
- **AER-034 remains open MEDIUM.** Workflow path coverage now includes gateway source and packages,
  which closes one sub-finding. README still claims `approval_required`, PDP non-200 and
  unparseable-response assertions that neither the harness source nor the exact head job log
  contains; it still tests one route, and `kong:3.6` / `postgres:16` remain mutable tags described
  as pinned. The head log confirms the same smaller assertion set, so a green job does not resolve
  the claim/evidence mismatch.
- **AER-031's deployment-index contradiction remains** at `docs/deployment/README.md:17`.
  AER-030 retains AER-034's missing two-route/action-binding acceptance evidence. AER-026 has the
  same narrow three-spelling subject-header evidence, not duplicate-header or all-reserved-header
  coverage.
- The green repository CI is strong evidence for the tested commit but does not include Playwright.
  This run's source census shows two UI gaps remain. No reviewed evidence closes AER-017, AER-018,
  AER-019, AER-021 or AER-022, and no evidence in this range closes AER-004, AER-007, AER-010,
  AER-011 or AER-014. Nothing here establishes production readiness, certification or enterprise
  readiness.

### Automated enterprise-readiness run — 2026-09-27 20:30:08 CDT (UTC-05:00)

**Target branch, synchronization and reviewed range**

- Exclusive target: `dhruv/active`.
- The run began with local HEAD and `origin/dhruv/active` at
  `b085a60d700af96d2dc5e4169b9b61b1a4052590`. Tracked files were clean.
- `git fetch origin dhruv/active --prune` advanced the upstream ref to
  `476aab1297eb662069dc5a6ddbe9fa6d67e1942b`; `git pull --ff-only origin dhruv/active` then
  fast-forwarded the checkout to that commit without reset, stash, merge or rebase.
- The required pre-publication fetch then found one additional upstream commit that did not touch
  `codexInputs.md`; a second fast-forward-only pull advanced both refs to
  `b145b1cd476160fe99f10863e517aed39e20beec`. That commit was reviewed before publication.
- Incremental review range: `e0e407683ca5e8deaa2474784db942c9dcf05b75..b145b1cd476160fe99f10863e517aed39e20beec`
  (13 commits, 30 files), because `e0e4076...` is the last commit whose automated review is recorded
  below. The range adds the AER-035 transaction/lock and tests, expands the Kong harness and callout
  context, closes two UI affordance gaps, repairs the deployment index, adds harness cleanup and
  adds/then qualifies `geminiInputs.md`. The final commit adds an active MCP upstream health-probe
  scheduler job and its database-backed tests.

**Commands/tests and outcomes**

- Mandatory suite and repository instruction reads — completed before synchronization and review.
- Branch/status/remote/tracking inspection, `git fetch origin dhruv/active --prune`, delta review and
  `git pull --ff-only origin dhruv/active` — **PASS**; local/upstream reached `476aab1...`.
- `git diff --check e0e4076..HEAD` — **FAIL**: five trailing-whitespace lines in the newly added
  `geminiInputs.md` (`:3,12,36,55,60`). This is a repository-hygiene verification failure in an
  agent-input document, not evidence that product behavior failed. It was not edited because this
  feedback run is authorized to publish only `codexInputs.md`.
- First `corepack pnpm -r build` — **ENVIRONMENT FAILURE** because this checkout had no
  `node_modules` (for example `vite/client`, `vitest`, `zod` and Node types could not be resolved).
  `corepack pnpm install --frozen-lockfile` restored the exact lockfile dependencies without a
  tracked-file change; the subsequent dependency-ordered `corepack pnpm -r build` — **PASS** for all
  15 built workspaces. The web build reported a 1,146.62 kB main JavaScript chunk (318.80 kB gzip),
  above the configured 900 kB warning threshold.
- `corepack pnpm --filter @regulait/gateway typecheck` after the final upstream health-probe commit —
  **PASS**.
- `node --check integrations/kong/test/verify.mjs` and
  `node --check integrations/kong/test/upstream.mjs` — **PASS**.
- `node scripts/preflight-ui-affordances.mjs` — **PASS**: 53 DELETE routes, 53 detected as reachable,
  zero exempt and zero orphaned. This is static source-pattern evidence, not browser behavior.
- GitHub PR 114 at intermediate head `476aab1...` reports **PASS** for CI run `36366023080` and Integrations
  run `36366023084`. The inspected CI log reports 197 gateway files, 2,928 passed / 9 skipped and
  specifically shows `zz-aer035-apply-atomicity.test.ts` passing five tests; its UI-affordance gate
  also reports 53/53. The inspected Kong log shows named PASS results for `approval_required`,
  reachable PDP non-200, unparseable PDP response, context reporting, absent `args` and unreachable
  PDP, all with the intended upstream checks. These are repository-run results, not locally
  reproduced database/container results.
- At final reviewed head `b145b1c...`, Integrations run `36367114978` passed and local gateway
  typecheck passed. CI run `36367114976` had completed install/build and was still running the
  database suite after ten minutes when observation stopped; the new health-probe tests therefore
  had **no completed exact-head CI verdict at publication time**. In-progress is uncertainty, not a
  failure or pass.
- `DATABASE_URL` was absent. No local database, migration, gateway integration, Playwright, Kong
  container, cloud, provider or deployment test ran. The full database suite was not run without an
  explicitly exclusive disposable database.

#### AER-036 — HIGH — The Kong adapter can label API-key traffic as SSO and that unverified value enters ABAC

**Lifecycle: OPEN. Evidence type:** direct source/configuration observation plus reproduced behavior
in the repository-run Kong harness. Exploitation against a custom session-origin policy was not run
locally because no exclusive database was available.

The new Kong schema accepts an operator-set `session_origin` value of `password`, `sso` or `api_key`
(`integrations/kong/kong/plugins/regulait-authz/schema.lua:45`). The handler copies that string into
`principal.sessionOrigin` without deriving it from the request's authenticated consumer or auth
plugin (`handler.lua:89-100`). The PDP then accepts that caller-supplied principal and passes it into
the policy kernel (`apps/gateway/src/app.ts:2141-2155`), where `sessionOrigin` is a policy-visible
principal attribute. The normal in-process boundary deliberately derives an API-key request as
`api_key` and a real session from the resolved session record (`apps/gateway/src/abac-principal.ts:34-57`).

This is not only a hypothetical configuration error: the shipped harness puts `key-auth` on the
governed route (`integrations/kong/test/verify.mjs:263-270`) and configures
`session_origin: "sso"` on that same route (`:281-289`). Its green assertion checks only that the
ledger says a `principal` dimension was present; it never checks the value or proves it came from
authentication. The docs nevertheless say this static setting is something Kong can state
truthfully and that both configured fields are true (`integrations/kong/README.md:103-106`;
`docs/deployment/GATEWAY_TOPOLOGY.md:125-128`). The accepted vocabulary also diverges from the
application's actual origin vocabulary: the UI contract names `oidc`, while the resolved session
path records concrete origins such as `saml`; the adapter invents the generic value `sso`.

**Impact:** an authentication-strength ABAC policy can be evaluated on a fabricated or stale session
origin. A key-auth request can be represented as SSO; on a mixed-auth route every request receives
the same label. A policy such as “forbid unless the origin is the enterprise SSO path” can therefore
make a different decision at the Kong callout than at RegulAIt's own dispatch boundary. The
purpose-scoped PDP key limits which endpoint is reachable, but does not make the attributes in its
request authentic. This breaks the claim that the adapter carries truthful principal context and
can turn a security control into allow-by-configuration.

**Recommended remediation:** do not expose an arbitrary static session-strength assertion as if it
were request evidence. Derive the canonical origin per request from a specific supported Kong auth
plugin/credential type and bind that derivation to the authenticated consumer, or omit
`principal.sessionOrigin` so the kernel receives `unknown`. If a deployment-level constant remains,
name it as an explicit trusted assertion, constrain it to a route proven to have one auth mechanism,
use the same canonical enum as the gateway, and refuse startup/configuration when the declared value
contradicts the configured auth plugin. `contextApplied` must not report `principal` merely because a
field existed; the verification should establish provenance and exact normalized value.

**Acceptance evidence required:**

1. With `key-auth`, a request reaches the PDP as `sessionOrigin: "api_key"` or `unknown`; configuring
   it as SSO is impossible or fails closed before traffic is accepted.
2. With supported OIDC and SAML plugins, per-request tests prove the canonical origin is derived from
   the authentication result, including mixed-auth and missing/ambiguous metadata cases.
3. An ABAC policy that forbids non-SSO traffic cannot be bypassed by plugin configuration, client
   headers or a different credential on the same route; zero upstream calls proves the refusal.
4. The Kong harness asserts the exact recorded origin value and provenance, not only that
   `contextApplied` contains the word `principal`; docs and schema use the same origin vocabulary as
   the gateway.

#### AER-037 — MEDIUM — The capped health sweep selects the same first 50 closed servers forever

**Lifecycle: OPEN. Evidence type:** direct source/control-flow observation. The greater-than-50
case was not run locally because it requires the database suite.

The new active MCP health sweep has a hard default cap of 50
(`apps/gateway/src/mcp-health-probe.ts:73-74`). It sorts open breakers first and every remaining
closed server by the same stable name order, then applies `LIMIT 50` (`:118-134`). It stores no
cursor, last-probed time or rotation state. Therefore, when more than 50 servers are healthy/closed,
each five-minute pass selects the same lexicographically first 50 and the tail is never actively
probed. `capped: true` reports that truncation but does not make progress. The exported function and
scheduler description both say they probe every registered upstream (`:98-100` and
`apps/gateway/src/scheduler-jobs.ts`), while the implementation only ever probes one fixed prefix.
The new tests cover dead, cooldown, egress-refused and zero-limit cases, but not 51+ healthy rows or
eventual coverage (`apps/gateway/src/zz-mcp-health-probe.test.ts:90-209`).

**Impact:** an enterprise deployment with more than 50 registered MCP servers can leave some
upstreams permanently passive. Those tail servers retain the exact “first user discovers the
outage” behavior this feature claims to remove, while scheduler health can remain green and merely
show `capped`. Naming determines protection, so an operator cannot predict eventual coverage from
the feature description.

**Recommended remediation:** keep broken-first priority, but rotate the closed cohort with persisted
`last_health_probe_at`/cursor state (and a deterministic tie-breaker), or process bounded pages until
every eligible row has a fair opportunity across runs. Expose oldest-unprobed age and remaining
backlog; make wording explicitly “up to N per pass” unless one cycle guarantees complete coverage.

**Acceptance evidence required:** create at least 51 closed servers with a small pass limit; across
bounded consecutive runs every id is attempted without starving open-breaker recovery, no server is
double-selected within a page, concurrent scheduler instances preserve the lease/cursor contract,
and the operator output reports backlog plus oldest-unprobed age.

**Prior-finding lifecycle and remaining uncertainty — 2026-09-27 20:30 CDT**

- **AER-035 — PARTIALLY RESOLVED, not RESOLVED/DONE.** Fixing commits `946ba2c` and `f203e7c`
  put proposal lock/read, the public-door mutation, applied marker/result and success audit in one
  database transaction (`apps/gateway/src/copilot.ts:2093-2363`). The proposal row is locked
  `FOR UPDATE`; all four mutation helpers now accept the transaction. The exact-head CI run passes
  five focused tests: 20-way races for `rule_to_approval`, policy tightening, grant revocation and
  budget adjustment, plus a post-lock vanished-target refusal that leaves no marker and retains its
  outside-transaction deny audit (`apps/gateway/src/zz-aer035-apply-atomicity.test.ts:190-359`). This
  directly satisfies acceptance items 1 and 2 and proves one rollback/refusal path. It does **not**
  satisfy item 3's requested fault injection after the target mutation, after the proposal marker
  and before the success audit; the added refusal happens before any target mutation. Nor is the
  process-crash/recovery case in item 4 exercised. Add deterministic failpoints in test builds and
  reconnect/restart assertions before marking AER-035 DONE. The ADR's stated possibility that the
  ordinary decide route changes `approved` to `denied` is not supported by the inspected writer:
  that update is conditional on `status = 'pending'` (`apps/gateway/src/app.ts:3015-3025`), so it is
  not recorded here as a separate race without another applicable writer.
- **AER-034 — PARTIALLY RESOLVED.** Commit `b8e9720` adds executable, green Kong cases for the three
  README promises that were previously unsupported: `approval_required`, PDP non-200 and
  unparseable PDP output (`integrations/kong/test/verify.mjs:445-489`). The harness now has three
  route/plugin instances, but the two added routes are fault fixtures bound to the same server/tool;
  AER-030's acceptance test for two distinct route/action bindings still has not been shown.
  Forged reserved fields beyond the three subject-header spellings and disabled/deleted identities
  also remain untested. `kong:3.6` and `postgres:16` remain mutable tags described as pinned.
- **AER-033 — PARTIALLY RESOLVED.** The high plaintext-administrator-key exposure remains fixed by
  the purpose-scoped PDP key/vault injection. Commit `b8e9720` now revokes the scratch key, removes
  the host temporary directory and drops the database in `finally`
  (`integrations/kong/test/verify.mjs:530-564`), and the exact-head Kong job passes. Do not mark the
  full acceptance contract DONE yet: cleanup is best-effort, a hard process interruption cannot run
  `finally`, and fixed database/port/container resources still prevent safe concurrent runs.
- **AER-031 — RESOLVED/DONE.** Fixing commit `b8e9720` removes the contradictory deployment-index
  wording. `docs/deployment/README.md:17` now says Kong only and explicitly says the Envoy adapter is
  withdrawn; the topology document and index agree. Residual limitation: this is documentation
  consistency, not evidence for a supported Envoy integration.
- **AER-028 — PARTIALLY RESOLVED.** The Kong adapter now carries static `projectId` and a principal
  origin and the exact-head container run proves their dimension names reach the ledger; it still
  intentionally omits `args`, so data-scope rules fail closed. AER-036 shows why presence is not
  enough to close principal parity: the new origin is not authenticated request context. The static
  project value also remains valid only for the documented one-project-per-route deployment shape.
- **Previously observed UI affordance gaps — RESOLVED in source/static gate, not browser-verified in
  this run.** Commit `7205bd2` adds red-team library creation, LLM backend configuration/removal and
  corrects the Red-team scheduling response type. Local build, local census and the exact-head CI
  census pass 53/53. A new Playwright spec exists, but the inspected CI run did not execute
  Playwright and no browser test was run locally, so runtime accessibility and failure UX remain
  uncertain.
- `geminiInputs.md` now carries a verification appendix that corrects several stale “missing”
  assertions before agents act on them. Its Section 5 is explicitly marked unverified. The five
  whitespace errors above remain, and roadmap language remains proposal material rather than proof
  of missing or working product behavior.
- AER-017, AER-018, AER-019, AER-021 and AER-022 remain OPEN HIGH; this range did not change their
  enforcement/provider/MCP paths. No reviewed evidence closes AER-004, AER-007, AER-010, AER-011 or
  AER-014. Green builds and focused repository jobs do not establish production readiness,
  certification, complete provider/deployment parity or enterprise readiness.

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

