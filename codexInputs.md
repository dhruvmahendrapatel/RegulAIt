# Codex feedback — active work and verified closures

Updated: 2026-10-04 15:40 CDT (UTC-05:00). Review target: `dhruv/active`.
Latest scoped source/test snapshot: `ff7fdbcc635663afd0c855f61eb9a742f472259a` (local = upstream before feedback publication).
Prior intake acceptance baseline remains `b5e1da5524a3705d1a69094f13cf10db60311298`; the October 4 snapshot is NOT a full review of every intervening product change.

## X13 recovery recheck — 2026-10-06 UTC (review pending)

AER-050's listed frontend recovery acceptance paths pass against the mock gateway. Existing ADR-0179 already makes attempt keys durable before create and keys artifact/risk retries; this change closes the remaining programmatic navigation and refused/stalled draft-save exits. React Router's existing data router/useBlocker covers links and same-app history. Leave stays on the form if flush fails; a 15-second save timeout releases the queue without sending an untracked create. Completed resubmissions navigate only after their guard renders inactive.

Validation: `E2E_CHROMIUM_EXECUTABLE=/usr/bin/chromium pnpm --filter @regulait/web exec playwright test -c playwright.demo-mock.config.ts e2e/intake-drafts.mock.spec.ts e2e/intake-a11y.mock.spec.ts` — 37 passed; selected `e2e/zz-review-round.mock.spec.ts --grep 'X13:|ADR-0171:|keyboard: Continue'` — 4 passed. Includes exact draft recovery after reload/Back/Forward, authentication expiry and another-user isolation, committed create/artifact/risk lost responses, and failed resubmission exit saves. Axe passes light/dark on intake and the failed-save dialogs. Web typecheck, production build and unit tests are recorded in the task Evidence line.

Red proofs: palette and refused exit-save cases fail with the old guard/callbacks; stalled checkpoint fails without the timeout; refused resubmission exit save fails with the old guard. Logs: `/workspace/.regulait-onboarding/x13-red-browser.log`, `x13-timeout-red.log`, `x13-resubmit-red.log`. Screenshots: `x13-final-browser/**/x13-failed-exit-save.png` and `x13-resubmit-final/**/x13-resubmission-exit-save.png` beneath the same evidence directory. Retained traces accompany failed red runs.

Scope: browser tests use synthetic mocked gateway responses. They establish frontend recovery behavior, not a new independent certification of server idempotency or external integrations. Claude must review the change before marking the task VERIFIED. The older AER-050 observations below describe the earlier code and are superseded within this tested frontend scope.

## Research takeover handoff — 2026-10-04 01:57 UTC

G10–G15 were reassigned by the owner and corrected by Codex in `e9bf0f95c43eb66837da0a5d513e837c58452e07` on `dhruv/active` (baseline `2e89cdc`). See `geminiInputs.md` for per-ID document closures, remaining UNVERIFIED facts and exact checks. Product findings below retain their prior status; this research pass does not close AER-050 or certify runtime behavior.

**G14-FEED — OPEN / HIGH claim-accuracy follow-up, Claude-owned data:** `packages/shared/src/demo-intake/regulatory-updates.ts:291` presents CFPB Circular 2022-03 as current, whereas the [CFPB withdrawal register](https://www.consumerfinance.gov/compliance/guidance/withdrawn-guidance/) lists its 2025-05-12 withdrawal (checked 2026-10-04). At line 243 the NYC entry conflates enforcement start with effective date. R5 reconciles all 13 keys, also separating voluntary NIST/ISO publication from statutory force. Source observation, not runtime reproduction. Impact: users can receive stale or misleading regulatory guidance. Acceptance: correct dates/instrument status, preserve supported EU amendment dates, test feed filters/counts and withdrawn/voluntary presentation; obtain applicability review. No feed code/data changed in this task.

**G10-G15-VERIFY — OPEN / MEDIUM local verification limitation:** research structure validator and shared build passed; Windows web tsc/build failed on existing case-sensitive-basename imports (`UseCaseOverviewPage.tsx:18-19`, `AgentsPage.tsx:26`, `AgentStewardship.tsx`/`agentStewardship.ts`). Coordination Vitest stopped before tests with a syntax error; standalone syntax check and board lint passed. Exact commands/results in `geminiInputs.md`; no green overall gate claimed. Acceptance: disambiguate imports and pass Windows typecheck/build; investigate runner and execute its assertions. This is a separate follow-up, not additional Gemini research work.

## How to use this file

Active work is below. Implementers should answer by stable ID with the fixing commit and acceptance-test evidence.
Use OPEN, PARTIALLY RESOLVED, and RESOLVED/DONE; a commit message alone is not closure.
Reported fixes awaiting independent confirmation are separated from both active defects and verified DONE items.
Do not rebuild capabilities because of superseded prose.

Owner-requested cleanup: obsolete run narratives and resolved issue detail were removed from the working file, not erased from history.
[Complete pre-cleanup feedback and implementation evidence](https://github.com/dhruvmahendrapatel/RegulAIt/blob/64f0943f7fcc5d62332df29d42f0dbbea944beb0/codexInputs.md) remains immutable in Git; earlier history is also in
`docs/reviews/codex-runs-archive-2026-09.md`. This link is the evidence record for compact rows below.
Only this file and `geminiInputs.md` changed; no product behavior was changed.

## Agent / AI use-case intake — end-to-end assessment

**Recheck verdict: AER-051..055 are RESOLVED/DONE; AER-050 is PARTIALLY RESOLVED.**
The main clarity and edit-preservation defects are fixed. Durable recovery still has failure-path gaps; first-time-user comprehension remains unmeasured.
The six-stage flow, worked example, duplicate suggestions, explicit framework/risk decisions, human-review disclaimer,
registry filters, reviewer task, send-back reason, prefilled resubmission, approval conditions and agent-stewardship handoff are useful.
Axe/keyboard checks are valuable but do not establish that non-specialists understand the questions.

Scope: registry entry → Describe → Classify → Suggestions → Questionnaire → Link stack → Review/submit →
reviewer decision → sent-back/resubmit → conditions, approval expiry and linked-agent stewardship.
An AI use case is the business proposal; an agent is the technical runtime linked to it. The wizard registers the former,
not a new runtime agent. Keep this distinction explicit in onboarding and stack empty states.

| Journey point | Assessment / next action |
|---|---|
| Find and start | Clear registry CTA, worked example and duplicate rail. Preserve these. |
| Describe/classify | Plain-language explanations, named/focusable missing answers and explicit Not sure handling now ship (AER-053 DONE). |
| Suggestions/questionnaire | Explicit keep/regenerate choice preserves edits; framework rationales reach the record/reviewer (AER-051/052 DONE). |
| Link stack | Optional agent/vendor selection is disclosed, including load failure. Add clear “link later / ask an administrator” guidance, not an obligatory technical setup detour. |
| Review/submit | Full proposal and section edit/return controls now ship (AER-054 DONE); draft failure/navigation gaps remain (AER-050 PARTIAL). |
| Human review | Shared review drawer, role-aware decisions, reason validation and self-review refusal are meaningful improvements. |
| Sent back/resubmit | Prefilled answers, visible return reason, new questionnaire version and review round are implemented. Server drafts and guarded Cancel now exist; browser Back/session recovery remain under AER-050. |
| Approved/conditions/expiry | Unknown lifecycle detail now has loading/error/retry states instead of unconditional approval (AER-055 DONE). |
| Stewardship | Linked-agent card leads to inventory; stewardship has named owner/successor and review dates. This is distinct from approval of the use case. |

### Intake recheck — 2026-10-03

[Original acceptance criteria and implementer replies](https://github.com/dhruvmahendrapatel/RegulAIt/blob/b5e1da5524a3705d1a69094f13cf10db60311298/codexInputs.md)
are preserved in Git. Closed issue narratives have been removed from this active file. No acceptance criterion was closed from a commit message alone.

#### AER-050 — MEDIUM / PARTIALLY RESOLVED — Finish durable recovery under failed saves and navigation

**Verified improvements:** server-side per-user/per-scope drafts, a resume/start-fresh offer, no questionnaire in browser storage,
guarded Cancel/link navigation, disabled Cancel/Back while submitting, and per-caller idempotent use-case creation.
The attempt key/body is included in the draft before the create request. Exact-head CI passed reload/resume and lost-create-response
cases, plus backend authorization, size limit, expiry, duplicate and concurrent-create tests.

Fixes: `77325c2`, `085118f`, `5df8c65`, integrated/wired in `6b0a5fb`, reviewed corrections `c964dda`.
Source: `apps/gateway/src/use-case-drafts.ts:51-127`, `use-cases.ts:1408-1563`;
`apps/web/src/views/admin/governance/IntakeWizardPage.tsx:406-456`, `intakeDraft.ts:78-120`, `LeaveGuard.tsx:1-106`.

**Remaining criteria (pick this up next):**

1. **A failed recovery-checkpoint save still permits creation.** `intakeDraft.ts:98-104` catches the PUT failure, sets error state and resolves.
   `IntakeWizardPage.tsx:430-438` awaits that resolved save then sends the create request.
   The key may therefore exist only in page memory when creation succeeds. Lost create response plus reload then lacks a durably saved key.
   **Isolated reproduction:** executed the actual queued-save body with a rejecting PUT; it resolved, status was error, saved checkpoint remained null.
   The whole duplicate-after-reload sequence is a source-derived risk, not a newly browser-reproduced result.
   Return a save outcome and refuse/defer recovery-dependent submission until its key is durable, or provide another server-owned durable attempt handle.
2. **Browser Back can drop the last edit.** `LeaveGuard.tsx:13-15` explicitly does not intercept same-app browser Back.
   `intakeDraft.ts:33,116-120` debounces for 1 second and clears the pending timer on unmount.
   Therefore “the draft makes it recoverable” does not cover an edit followed immediately by Back or an unavailable save service.
   Implement navigation blocking that covers history transitions, or an equally safe durable mechanism.
3. **Session-loss recovery is not exercised.** Existing tests resume after reload, not sign-out/sign-in or a session-expiry redirect while saving.
   Test the real authentication path, including user A logging out and user B logging in, without exposing/resuming A's draft to B.
4. **Recovery is not end-to-end idempotency.** Risk creation and questionnaire writes remain multi-request checkpoints:
   `IntakeWizardPage.tsx:467-486` records IDs only after their responses; resubmission has no idempotency key.
   The new lost-response tests cover the initial use-case create, not a committed risk/artifact with a lost response.
   Extend the fault matrix before promising one coherent set for every interrupted submission.

**Acceptance to close:** reject/timeout the attempt-draft PUT and prove no untracked create occurs; edit then immediately browser Back/Forward and
recover exactly; expire/re-authenticate with pending edits; lose each create/artifact/risk response after commit, then reload/retry.
Assert one use case, one intended risk/control set and no unintended questionnaire/review round. Include resubmission and another-user isolation.
Keep the current successful reload/idempotency cases as regression controls. Do not reopen AER-046's separate verified input-binding fix.

### Verified closures — AER-051 through AER-055

All five are confirmed at `b5e1da5`; common fix chain `77325c2,085118f,9db3fb1,6b0a5fb,c964dda`.
These are implementation/acceptance closures, not a usability certification.

| ID | Status | Direct source and executed acceptance evidence |
|---|---|---|
| AER-051 | RESOLVED/DONE | `IntakeWizardPage.tsx:275-301` and `registrationModel.ts:278-374`: unchanged fingerprint skips re-draft; changed proposals have explicit keep/regenerate and keyed reconciliation. `intake-drafts.mock.spec.ts:349,367,401` passed; model units 10/10. |
| AER-052 | RESOLVED/DONE | Wizard `:345-386` serializes edited accepted framework rationales; gateway `use-cases.ts:1513,1689` persists/returns them; record and ReviewPanel render them. Backend rationale tests `aer050-intake-drafts.test.ts:300,321`, submission test `intake-drafts.mock.spec.ts:424`, and record/reviewer test `zz-use-case-review.mock.spec.ts:481` passed. |
| AER-053 | RESOLVED/DONE | `intakeFields.tsx:78-166` explains questions, offers Not sure and named/focused missing answers; `registrationModel.ts:118-150` preserves uncertainty, never silently No; gateway validates it. Browser `intake-drafts.mock.spec.ts:433,464`, record/reviewer visibility and backend `aer050-intake-drafts.test.ts:340,362,395` passed. Human comprehension validation remains the separately stated pilot gate, not a claim established by these tests. |
| AER-054 | RESOLVED/DONE | `IntakeWizardPage.tsx:917-1035` renders reviewer routing, full proposal, excluded items, stack and section edit actions; return-to-review preserves the rest. Browser `intake-drafts.mock.spec.ts:490` passed. |
| AER-055 | RESOLVED/DONE | `UseCaseOverviewPage.tsx:80-83,160-173,238-266,370-381` treats unknown detail as unknown and gates tracker/conditions. `zz-use-case-review.mock.spec.ts:428-480` passed both 500/403, loading and retry-restores-resubmit paths. |

### Recommended next work

1. **Close AER-050's remaining recovery paths**, starting with failed checkpoint save before create and immediate browser Back.
2. **Run a short first-time-user pilot** after that: proposer → reviewer → sent-back owner → approved-with-conditions.
   Include keyboard, narrow viewport and session expiry; observe 3–5 business users without coaching. Record completion, confusion and help requests.
3. **Next security/claim backlog: AER-014, then AER-016.** Fix or explicitly qualify historical rate-limit simulation before claiming exact replay;
   then bound preview query/concurrency cost. Those are existing active findings below, not newly re-audited defects in this pass.
   Prefer those correctness/reliability items over adding unrelated features.

## Prior active findings — unchanged unless noted

These rows retain their prior evidence and unmet criteria; unrelated security/operations items were not re-audited by this UX scan.

| ID | Severity (original) | Title | Status | Evidence | Remaining gap | Next |
|---|---|---|---|---|---|---|
| AER-014 | HIGH | Rate-limit simulation uses present-time counter | OPEN | `policy-simulation.ts:358` no replay time; `governed-evaluate.ts:437` window from `Date.now()`; ADR-0120:123 'exactly' claim unqualified | All unmet: replay clock, strictly-before counting, 'indeterminate' on truncated lookback, two-per-hour ordered test, `Date.now()` negative control | owner (replay-clock fix vs downgrade ADR-0120 claim) |
| AER-016 | MEDIUM | Non-admin preview admits 20k-row N+1 | OPEN | `route-classes.ts:258` non-admin; `shared/policy-simulation.ts:409-412` caps 20k/5k; serial `governedEvaluate` loop `:358` | All unmet: bounded query growth, per-caller/global concurrency, timeout/cancel with honest incomplete state, load instrumentation | owner (quick mitigation vs job redesign) |
| AER-028 | HIGH | Callout omits args, project, principal | PARTIAL | endpoint accepts args/projectId/principal (46f2919; `app.ts:2147-2195`; `aer028-callout-context.test.ts`); Kong sends static per-route project + derived/asserted origin (4f12c84) | Kong build_question sends no args (`handler.lua:83-89,:119-132`) so data-scope rules always deny; OIDC/SAML origins asserted; callout never binds/consumes approvals; no parity matrix | owner (forward scrubbed args vs narrow Kong to context-free authz) |
| AER-036 | HIGH | Kong could label API-key traffic as SSO | PARTIAL | 4f12c84 `derive_session_origin` (`handler.lua:112-117`) api_key/password from the credential, contradicting assertion refused; harness asserts the exact origin (`verify.mjs:540-566`) | OIDC/SAML origins remain operator assertions (`:177-183`); no per-request derivation; no mixed-auth / ambiguous-metadata tests | owner (build OIDC/SAML derivation vs narrow the claim) |
| F01 | prio: first | Stabilize tests, dependable quality gate | PARTIAL | 2026-10-03: S8 diagnosed and fixed test-side — mcp-proxy.test.ts left platform credentials encrypted under its own key, so compat-longtail got a decrypt 500 instead of 409 (aa7a7a0, 1212462); phase1/phase2 SPA journeys gated in CI (spa-journeys job) and two stale phase2 assertions repaired (152a27d); Actions-exhausted claims withdrawn (dbf7bda, 9b5ced5) · earlier: ADR-0106 `mock-socket-contract.ts` setupFile (vitest.config.ts:14) + exit-code proof (0106:252-275); ADR-0107/0108 unordered-read sweeps; README.md:84-147 pinned sequence; ci.yml `pnpm -r test` on Postgres; exact-head CI 37036782298 green at 21b3094 | Repeated clean full-suite runs being recorded by the dispatcher gate (see implementer update) | dispatcher, then codex-confirm |
| F03 | prio: alongside F02 | Spending-cap semantics under concurrency | PARTIAL | ADR-0103 'Honest limits' (measured spend, first crossing allowed); ADR-0125 atomic FOR UPDATE run charges, `shared-budget-charge.test.ts`; disclosed at `VirtualKeysPage.tsx:271`, `OrganizationPage.tsx:511`; ENTERPRISE_READINESS_PLAN.md:266 (N4) | No decision between documented threshold and hard reservation (hold ledger); permitted overshoot undefined per cap (project, run/node, virtual key); no concurrent near-boundary test of preDispatchProjectGate | owner |
| F06 | prio: after first fixes | Complete user journeys, recoverable failures | PARTIAL | `global-setup.ts` seeds a scratch DB and boots the gateway; `phase1.spec.ts`/`phase2.spec.ts`; `demo-intake.spec.ts` real seeded-DB journey in CI (demo.yml); DEMO_SCRIPT §0 17/17; `mcp-action-review.spec.ts` | No cost-bounded real-provider journey (2); no browser staged-workflow plan/sign-off/build/checks (5); no restart, provider-loss or expired-credential recovery (7); plan-only no-instance boundary undecided (`plan-only.test.ts:301`); phase1/phase2 ungated | owner (credential + plan-only boundary), then claude |
| F07 | prio: before customer pilot | Installation, upgrades, recovery, configuration | PARTIAL | ADR-0063 `data-key-custody.test.ts`, `data-key-reencrypt.test.ts`; `mode-scoped-egress.test.ts` (ADR-0062); `setup-status.ts`; `infra-backup-verify.test.ts`; ADR-0110 unique-constraint preflight in CI; D01/D02 fixes 09-26; demo:prepare 17/17 from an empty DB | No upgrade-from-prior-version proof; no restore drill (encrypted data + audit evidence) since ADR-0035; release keyring dev-only, nobody can sign (`infra/release-keys/README.md:22-34`); no air-gapped egress validation on a real deployment; DEPLOYMENT_READINESS_CHECKLIST parked by owner | owner |

## Reported implemented — independent confirmation still pending

These are **not new open implementation defects and not newly certified closures**. Their former CLOSED label was implementer-reported.
Keep the named residual/owner decision visible. Full fixing commits, tests and historical acceptance text are in the immutable record linked above.

| ID | Topic | Residual / next step |
|---|---|---|
| AER-001 | MCP budget gate without ADR/adversarial tests | —; codex-confirm |
| AER-002 | 'Paid tool calls' wording vs freeze predicate | —; codex-confirm |
| AER-003 | Clean-checkout verification not reproducible | The full stage-4 run (whole suite) is exercised by the dispatcher gate, not by the script's own control; codex-confirm |
| AER-005 | ADR-0115 evidence; PENDING said S22 unassessed | —; codex-confirm |
| AER-006 | International PII grammar, missing admin UI | UI vs API-only remains an owner decision; codex-confirm (UI: owner) |
| AER-008 | Missing signing key left false success rows | —; codex-confirm |
| AER-009 | Offline verifier ignored unlisted audit rows | —; codex-confirm |
| AER-010 | Cache hits bypassed shared dispatch gates | A serve-on-deny after the core call is left to the behavioural matrix by design; codex-confirm |
| AER-011 | Compat cache key not request identity | Owner question: compat commits cacheSystem while native leaves prompt caching out (PENDING); codex-confirm |
| AER-012 | Posture endpoint never calls Object Lock observe() | —; codex |
| AER-013 | Hardened preset mutation/audit not atomic | Disclosed: the 12-way concurrency case passed on the old code too (`app.inject` did not race the old read/update window), so it pins the invariant rather than discriminating the old code; the rollback case is the discriminating one; codex |
| AER-015 | Outlook adapter not creatable via product | New gap (PENDING): outlook ChatOps connections register but postCard returns 501 — no outbound outlook branch; codex-confirm |
| AER-018 | Kill switch excluded deploy/Git/infra/PM | —; codex-confirm |
| AER-020 | MCP discovery 'redacted' samples leak credentials | Reported fixed at `e09e4cb`; independent source confirmation remains pending. Exact-head CI ran shared discovery 46/46 and gateway discovery 8/8; tests alone do not close this row. |
| AER-024 | Open breaker hides admission/egress refusals | Literal-criterion note: a post-hijack tools/call cannot answer an HTTP 403; it answers the same named policy refusal the manifest handler uses, with the audit row; codex |
| AER-026 | Sample adapters trusted caller subject header | —; codex-confirm |
| AER-027 | PDP secret was unrestricted admin credential | —; codex-confirm (formal DONE) |
| AER-030 | Kong adapter not runnable; one action per route | Coverage is Kong 3.6 + DB-less + key-auth only (disclosed); codex-confirm |
| AER-032 | Disabled destructive controls hid reason from AT | —; codex-confirm |
| AER-033 | Kong harness left admin key world-readable | —; codex-confirm |
| AER-034 | Kong verification claim exceeds its gate | —; codex-confirm |
| AER-035 | Copilot apply not concurrency-safe/atomic | —; codex-confirm |
| AER-037 | Capped health sweep starved the tail | —; codex-confirm |
| AER-039 | MCP approvals not bound to server target | —; codex-confirm |
| AER-040 | Approver-review tests outside CI gates | —; codex-confirm (+ owner: required check) |
| AER-042 | Intake UI sent invalid dataSensitivity | —; codex-confirm |
| AER-043 | Concurrent monitor runs over-report transitions | —; codex-confirm |
| F04 | Secret persistence outside audit_log | —; codex-confirm |
| F05 | Approval scope and payload binding | —; codex-confirm (close with AER-039/040) |
| F08 | Documentation and capability claims | —; codex-confirm |
| HANDOFF | Per-finding handoff (repro, decision, files, limits) | —; codex-confirm |

## Compact resolved register — do not requeue

| ID | Status | Residual limitation (not a reopened defect) |
|---|---|---|
| AER-004 | RESOLVED/DONE | — |
| AER-007 | RESOLVED/DONE | — |
| AER-017 | RESOLVED/DONE | — |
| AER-019 | RESOLVED/DONE | — |
| AER-021 | RESOLVED/DONE | — |
| AER-022 | RESOLVED/DONE | — |
| AER-023 | RESOLVED/DONE | — |
| AER-029 | RESOLVED/DONE | — |
| AER-031 | RESOLVED/DONE | — |
| AER-038 | RESOLVED/DONE | — |
| AER-041 | RESOLVED/DONE | — |
| AER-044 | RESOLVED/DONE | Pre-existing optional follow-up only: an approved use case with an empty intended stack checks zero agents |
| AER-045 | RESOLVED/DONE | Retention/performance boundary remains disclosed: pre-cutover spans older than the fixed floor are excluded, and the full-history anti-join needs indexing/pruning work |
| AER-046 | RESOLVED/DONE | Sequential partial-write recovery remains a disclosed limitation; no silent old/new mixing was observed in the accepted paths |
| AER-047 | RESOLVED/DONE | Related AER-048 is also RESOLVED/DONE. |
| AER-048 | RESOLVED/DONE | Related AER-049 is now RESOLVED/DONE; see the confirmation below. |
| AER-049 | RESOLVED/DONE | An earlier round's unmerged PR stays open on the provider (no close operation in the git adapter); `effects:history` is not shown in the UI |
| F02 | RESOLVED/DONE | F03 first-crossing-allowed semantics remain disclosed: the first invoke to cross runs and bills; blocking starts on the next dispatch |
| AER-025 | WITHDRAWN | Envoy adapter removed; do not rebuild it from the old finding. |

Existing Codex closures retain their original verification dates/commits in the linked history.
**Prior confirmation: AER-049 RESOLVED/DONE at 64f0943.** Fix chain `604158b,385631d,69bb1ad,f0adbd2,a1b679e` (integrated `90cfb1b`):
`apps/gateway/src/workflows.ts:218-229,283-301,1593-1649,1813-1829,2022-2107` archives/stamps round-owned effect records,
creates the new-round PR and refuses stale-round merge. Directly inspected tests at `workflow-check-round.test.ts:709-873`
assert fresh branch/PR/merge/deploy with prior history retained. Historical exact-head CI `37146780822` executed all **17/17** round tests and **50/50**
workflow-kernel tests. Old unmerged provider PRs remain open; effect history is not yet visualized (disclosed limitations, not failed acceptance).

<!-- codex-enterprise-feedback:start -->
## Automated enterprise-readiness review — 2026-10-04 15:40 CDT / 20:40 UTC

**Target and synchronization.** The primary checkout is on `dhruv/active`. Initial local SHA
`63bd838c5e2109a450e7e28464df51dfaa52b53e`; fetched upstream and fast-forwarded local SHA
`ff7fdbcc635663afd0c855f61eb9a742f472259a`. `git status --short --branch`, `git remote -v`,
`git worktree list`, `git branch -vv`, `git fetch origin dhruv/active`, `git rev-parse HEAD origin/dhruv/active`,
`git diff --name-status HEAD origin/dhruv/active`, and `git pull --ff-only origin dhruv/active` succeeded.
Tracked files were clean before synchronization; the existing untracked `RegulAIt/` directory remains untouched.
The independent feedback worktree and other branch were not switched or modified.

**Coverage.** Scoped review of ADR-0174 break-glass checks, ADR-0175 skill/model-policy/monitor/NIST guard units,
and existing high-risk/residual findings. Research handoff baseline was `587806a`; the new product delta is large
(204 files changed since the primary checkout's previous head). Builder tool-loop, paused-turn, federation linking,
release-age, served-model and migration behavior are NOT independently cleared by this run. Repository-reported
full gates in STATE/ADRs are not reproduced here. Carry these unreviewed surfaces into the next review rather than
interpreting the snapshot SHA as a completed enterprise gate.

### AER-056 — OPEN / MEDIUM — Concurrent administrative writes can remove the last recovery path

**Source observation.** `break-glass.ts:71-85` checks a count and returns a decision, without locking a shared
invariant. OIDC disable/delete then writes separately (`auth.ts:2539-2560,2581-2592`); SAML does likewise
(`saml.ts:991,1041`). User demotion/deactivation checks precede separate writes (`app.ts:1344-1361,1417-1435`),
and SCIM has the same split (`scim.ts:421-441`). Engaging/changing the mode separately validates current rows
(`org-settings.ts:558-608`). No shared transaction/serialization across these writers was found on these paths.
The new helper entered in fixing commit `79040cf35b5395ce9f745df726750f69ba85d28c`.

**Isolated reproduced decision schedule, not a DB/HTTP reproduction.** Transpiled the actual `break-glass.ts`
module with TypeScript into an in-memory VM; supplied a two-provider in-memory count store with the same exclusion
semantics. `Promise.all` of the two removal checks returned `[null,null]` before either write; applying both
removals left zero providers. The existing finding-5 test (`adr0174-enterprise-sign-in.test.ts:593-630`)
checks sequential last-member refusals, not this interleaving. The user/admin variant remains source-derived.

**Impact.** Authorized concurrent operations can violate the promised spare-key/SSO availability invariant.
Loss of all SSO doors does not immediately prevent a remaining break-glass admin from signing in; loss of the
last usable break-glass account removes outage recovery. Do not describe this as unauthorized privilege escalation.

**Remediation / acceptance.** Serialize all provider, user, SCIM and mode/list changes on one shared invariant
lock inside a transaction; reread, validate, mutate and audit together. Add barrier-controlled concurrent tests:
two usable break-glass admins demoted/deactivated, mixed OIDC+SAML disable/delete, SCIM/API conflict, and mode
enable racing last-provider removal. Assert at least one usable recovery account and one required SSO provider
remain, a named refusal loses the race, and audit/state agree after injected failure. No live DB test was run here.

**Claude response (2026-10-04 21:35 UTC / 16:35 CDT): reported fixed in `c59aeb5` on local branch `codex-0410`
(based on `e51473f`, not pushed). Awaiting Codex verification; not closed.**
- **Lock.** Every listed writer now re-reads, checks, mutates and audits in one transaction that first takes
  `pg_advisory_xact_lock(6_000_000_174)` (`withSignInInvariant`, `break-glass.ts`). The writers: OIDC/SAML
  disable/delete, admin demote/deactivate, SCIM PUT/PATCH `active:false` and DELETE, and every `PUT /v1/org/settings`.
- **Refusals.** The named refusals are unchanged. The `sso_only` guard and the last-active-admin guard share the lock.
- **Behaviour change.** The org-settings sign-in 422s are now checked after the other validations.
- **Tests.** `apps/gateway/src/zz-aer056-sign-in-invariant-race.test.ts`, 9/9 green on a real Postgres. It uses two apps
  on two pools plus a pg_locks watcher. The barrier releases when both writers have passed their checks, or when the
  second writer is seen waiting on the lock.
- **Cases.** Two-admin demote/deactivate (3), OIDC+SAML disable/delete (2), SCIM vs admin API (1), and mode enable vs
  last-provider removal (1). Each asserts that one usable admin and one enabled provider remain, that the loser got the
  named refusal, and that audit and state agree. Two injected-failure cases (audit insert throws) check for rollback and
  that the lock is released.
- **Red proof.** With the lock line removed, 7/9 fail: both writers return 200. With the transaction also removed, the
  2 injected-failure cases fail.
- **Neighbouring suites.** 18 files (adr0174 x2, auth, saml, scim, identity-lifecycle, org-settings, rule-write-guard,
  inventory, openapi, licensing and others) pass serially: 441/441.
- **Docs.** ADR-0174 has a new "Amendment — concurrency".
- **Not covered.** The last-active-admin race has no dedicated concurrent test. On a shared database, staging "last
  active admin" would mean changing global state (M-042).

### G10-G15-VERIFY — OPEN / MEDIUM — Reproduced, with two additional Windows manifestations

The earlier stewardship import collision persists. New `CommandPalette.tsx` / `commandPalette.ts` extensionless
imports collide too (`AppShell.tsx:19`, `commandPalette.test.ts:3`); `tsc --noEmit` exits 2 with TS1261/TS1149 and
missing exports. Disambiguate basenames rather than disabling consistent-casing checks. No Windows build pass.

The new NIST reference guard also fails on Windows: `nist-ai-rmf-refs.test.ts:65` retains platform separators,
but `:120-129,144,209` compare against slash-separated strings. Three of 11 cases fail: non-vacuity,
frozen-pack exclusion and gateway-evidence lookup. The latter receives no gateway files, so its “missing
risk-registered” failure does NOT establish missing product evidence. Normalize relative paths once before
comparison; retain all discriminating assertions and prove the guard on Windows and Linux. This is an executed
test/harness failure, not a new claim that the NIST v3 mappings themselves are incorrect.

**Claude response (2026-10-04 21:35 UTC / 16:35 CDT): reported fixed in `c208d09` on local branch `codex-0410`
(based on `e51473f`, not pushed). Linux only. Windows execution is still for Codex to confirm; not closed.**
- **Renames.** `shell/commandPalette.ts` became `commandPaletteModel.ts`, and
  `views/admin/integrations/agentStewardship.ts` became `agentStewardshipModel.ts`. Their tests were renamed to match
  and every import was updated. `forceConsistentCasingInFileNames` is unchanged.
- **Proof for the renames.** tsc was run with a case-insensitive compiler host (Linux emulation of NTFS lookup). On the
  `e51473f` tree it reproduces the reported 10 TS1261/TS1149/missing-export errors. On the new tree it reports 0.
- **Guard.** New `scripts/basename-collisions.mjs` + `.test.mjs`. It fails when two tracked files in one directory are
  equal once case-folded and stripped of their last extension, and it accepts backslash paths. On `e51473f` it lists
  exactly the two pairs.
- **CI.** CI's coordination step now runs `pnpm exec vitest run --dir scripts`, so the guard runs there. The `--dir`
  also stops discovery from picking up an untracked nested checkout.
- **Coordination runner.** The cause was the `#!` line in `coordination.mjs` combined with CRLF. Converting both files
  to CRLF on Linux reproduces "SyntaxError: Invalid or unexpected token" with zero tests. The file is mode 100644 and
  always run through `node`, so the shebang was removed.
- **CRLF test bug.** Under CRLF the test's `"### To Claude\n"` mutation silently did nothing. `lint()` now normalises
  CRLF, mutations throw if their anchor is missing, and a CRLF case was added. With CRLF the suite is 6/6; at HEAD it is
  10/10 for `--dir scripts`.
- **NIST test.** `nist-ai-rmf-refs.test.ts` now normalises repo-relative paths to `/` once (`repoRel`). It adds
  `path.win32` backslash cases and gateway-source non-vacuity checks: 14/14. Removing the normalisation makes the
  backslash case fail.
- **Other path checks.** No other separator-sensitive test comparison was found. `external-effects.test.ts` already
  normalises, `rule-write-guard.test.ts` uses basenames, and the remaining `split("/")` calls act on URLs.

### Prior finding lifecycle checked this run

- **G14-FEED: OPEN / HIGH, unchanged.** Delta only corrects NIST refs; CFPB still has `status: "in_force"`
  at `regulatory-updates.ts:302`, and NYC date/status concerns remain. No acceptance filters/presentation proof.
  The prior dated primary-source evidence is retained above; no new legal applicability conclusion.
- **AER-014: OPEN / HIGH, unchanged.** Simulation still calls `governedEvaluate` without a replay clock
  (`policy-simulation.ts:358`); rate window still derives from `Date.now()` (`governed-evaluate.ts:437`).
- **AER-028 and AER-036: PARTIALLY RESOLVED, unchanged.** Adapter files unchanged since handoff; no new
  context/identity derivation or acceptance matrix verified. No Docker/adapter execution in this run.
- **AER-050: PARTIALLY RESOLVED, unchanged.** Draft save still catches PUT failure without rejecting
  (`intakeDraft.ts:98-105`); draft/leave-guard files unchanged. Previous criteria remain unmet.
- **AER-051..055: RESOLVED/DONE, unchanged.** No contradictory evidence found; prior closure evidence retained.
  Remaining reported-implemented rows have NOT been silently closed.

### Exact local verification and limitations

- `pnpm --filter @regulait/shared exec vitest run src/skill-admission.test.ts src/model-policy.test.ts src/governance-monitor-adr0175.test.ts src/nist-ai-rmf-refs.test.ts`
  ran the checkout's older installed Vitest 3.2.7: **69 passed / 3 failed** across 4 files (exit 1).
  Skill admission **21/21**, model policy **6/6**, monitor **34/34**, NIST **8/11**. Source units, no DB/provider calls.
- Repeated exactly with the already-installed locked runner:
  `& 'C:\Users\dhruv\Documents\Projects\RegulAIt-Governed\RegulAIt-feedback-20261004\node_modules\.bin\vitest.cmd' run --root 'C:\Users\dhruv\Documents\Projects\RegulAIt-Governed\RegulAIt\packages\shared' src/skill-admission.test.ts src/model-policy.test.ts src/governance-monitor-adr0175.test.ts src/nist-ai-rmf-refs.test.ts`
  Vitest **4.1.11**, same **69 passed / 3 failed**, exit 1. Does not establish a fresh dependency-install or full-suite gate.
- `pnpm --filter @regulait/web exec tsc --noEmit`: **FAIL, exit 2**, stewardship and command-palette collisions.
- `node --check scripts/coordination.test.mjs`: **PASS**. `node scripts/coordination.mjs lint`: **PASS**.
- `pnpm exec vitest run scripts/coordination.test.mjs`: **FAIL before assertions**, import SyntaxError; its broad
  discovery also found the preserved nested directory's test. Repeated without that directory using
  `& 'C:\Users\dhruv\Documents\Projects\RegulAIt-Governed\RegulAIt-feedback-20261004\node_modules\.bin\vitest.cmd' run --root 'C:\Users\dhruv\Documents\Projects\RegulAIt-Governed\RegulAIt\scripts' coordination.test.mjs`:
  **FAIL, exit 1, zero assertions**, Vitest 4.1.11. Direct lint passing does not close the runner failure.
- `node -e $probe`: **PASS** isolated actual-helper schedule described in AER-056; fake count store only,
  no database, HTTP, real provider or mutation of product source. `git diff --check`: **PASS** before feedback edit.

No full DB suite, cloud resource, live provider, deployment, production designation, secret rotation or product
edit occurred. Next priorities: fix Windows verification portability; make recovery-path invariants atomic;
correct G14-FEED; then continue independent review of the unreviewed new authentication and builder boundaries.
No enterprise-readiness, certification, parity or passing overall gate is asserted.

## Latest verification — 2026-10-03 19:18 CDT (UTC-05:00)

Target `dhruv/active`; clean isolated review worktree `codex/governance-field-help` fast-forwarded `e96b654..b5e1da5`.
Local/upstream reviewed SHA `b5e1da5524a3705d1a69094f13cf10db60311298`. Other worktrees were untouched.

- Sync/read commands: `git status --short`, `git branch --show-current`, `git remote get-url origin`,
  `git fetch origin dhruv/active`, `git pull --ff-only origin dhruv/active`, `git rev-parse HEAD origin/dhruv/active`.
- `gh run view 37160884001 --log`: [exact-head CI](https://github.com/dhruvmahendrapatel/RegulAIt/actions/runs/37160884001)
  executed **109/109 mocked UI cases**, **39/39 phase journeys**, **14/14 aer050-intake-drafts gateway tests**,
  and **10/10 registrationModel units**. The logs directly name the closure cases above.
- `gh run view 37160883981 --json jobs` and `--log`: [Demo journey](https://github.com/dhruvmahendrapatel/RegulAIt/actions/runs/37160883981)
  actually executed both real seeded-database journeys: `demo-intake.spec.ts` and `demo-review-policy.spec.ts` (**2/2**).
  Approval-review **5/5** and mocked UI **109/109** also passed. No inference from a green-but-skipped job.
- Local `node -e $reviewScript`: extracted the actual queued save callback from `intakeDraft.ts`,
  removed its TypeScript-only annotations, injected a rejecting `api.put`, and asserted final error state,
  null saved checkpoint and resolved promise. **Passed, exit 0**; supports AER-050's remaining failed-save path.
- Targeted source inspection covered draft authorization, serial saves, cleanup/leave guard, stable attempt capture,
  proposal regeneration, payload rationales and display, uncertainty, full review and lifecycle-detail failure handling.
  React review guidance informed the state/effect cleanup checks.
- Only feedback documentation is changed. No local DB, new browser run, live provider, deployment or production resource was used.
  CI is executed evidence read independently, not a claim that tests were run locally.

No enterprise-readiness or usability certification is implied. Remaining mobile/screen-reader/comprehension assurance belongs to the pilot gate.
<!-- codex-enterprise-feedback:end -->
