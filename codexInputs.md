# Codex feedback — active work and verified closures

Updated: 2026-10-03 15:39 CDT (UTC-05:00). Review target: `dhruv/active`.
Reviewed local and upstream SHA: `64f0943f7fcc5d62332df29d42f0dbbea944beb0`.

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

**Verdict: a coherent guided happy path, but not yet seamless for a first-time business user.**
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
| Describe/classify | Too much assumed regulatory vocabulary; no focused missing-answer recovery (AER-053). |
| Suggestions/questionnaire | Explicit decisions are good; edits can disappear or never be saved (AER-051/052). |
| Link stack | Optional agent/vendor selection is disclosed, including load failure. Add clear “link later / ask an administrator” guidance, not an obligatory technical setup detour. |
| Review/submit | Counts are not a review of the actual submission; recovery promise exceeds page-memory durability (AER-050/054). |
| Human review | Shared review drawer, role-aware decisions, reason validation and self-review refusal are meaningful improvements. |
| Sent back/resubmit | Prefilled answers, visible return reason, new questionnaire version and review round are implemented. Leaving still loses unsaved edits (AER-050). |
| Approved/conditions/expiry | Lifecycle and next activities exist, but a failed detail read can misstate approval conditions (AER-055). |
| Stewardship | Linked-agent card leads to inventory; stewardship has named owner/successor and review dates. This is distinct from approval of the use case. |

### New findings — implement in this order

#### AER-050 — MEDIUM / OPEN — Draft and recovery state disappear when the page is left

Evidence (source observation): `apps/web/src/views/admin/governance/IntakeWizardPage.tsx:116-172,329-331,429-433,642,657`;
`intakeCheckpoint.ts:48-53`; `IntakeResubmit.tsx:127-138,167-181`.
Answers and completed-write checkpoint live only in React state/refs. No draft persistence or leave guard was found in
`apps/web/src` (`beforeunload|useBlocker`). Cancel/Back remain available during submission.
The first create response must arrive before its ID enters the checkpoint. The page nevertheless promises “nothing is created twice”
and “completed steps … retained” without limiting that promise to the current mount.

Impact: refresh, session-loss redirect, Cancel or a lost success response can lose substantial work and the ability to resume partial writes.
Duplicate creation after an ambiguous response is a **risk requiring transport-fault reproduction**, not a browser-reproduced result in this pass.
This is outside AER-046's verified same-mount input-binding fix; do not reopen AER-046.

Remediation: authenticated server-side drafts/resume identifiers and durable idempotency for submission; confirm leaving a dirty form;
settle or explicitly track in-flight submission before navigation. Until durable recovery exists, disclose its scope honestly.
Do not indiscriminately persist sensitive questionnaire text in browser localStorage.

Acceptance: fill all stages, refresh/re-login and resume unchanged; Cancel warns; leave during submission has a recoverable outcome;
drop the create response after server commit, retry/reload, and assert one use case with one coherent risk/control set.
Apply the dirty-form test to resubmission too.

#### AER-051 — MEDIUM / OPEN — Re-drafting silently replaces questionnaire edits

Evidence: `IntakeWizardPage.tsx:228-234,407-409,433`. The assist success callback replaces the entire questionnaire and resets
question decisions to accepted. Back-navigation followed by “Draft suggestions” invokes it again.
**Reproduced in isolation using the actual callback:** a manual answer becomes the generated draft and is accepted.
Old `suggestionEdits` are not cleared/reconciled at the same time, creating inconsistent preservation across sections.

Remediation: preserve keyed edits for unchanged answers; when classification changes, show affected sections and an explicit regenerate/keep choice.
Invalidate stale suggestions deliberately without silently replacing user text.
Acceptance: edit/reject questionnaire sections, return to Classify and continue unchanged: preserve edits and decisions.
Change classification: show a diff/warning; regenerate only with explicit consent and reconcile framework/risk edits.

#### AER-052 — MEDIUM / OPEN — Framework explanation editing is a dead-end control

Evidence: `IntakeWizardPage.tsx:290-293,563,724-740`. The framework suggestion offers an editable “Why it applies” explanation.
Submission serializes only its framework identifier in `complianceTags`; unlike risk descriptions, the edited explanation is never consumed.
**Reproduced in isolation using the actual submissionInputs expression:** a unique edited rationale is absent from the serialized payload.

Remediation: persist the rationale and show it to the reviewer, or make the explanation read-only and remove the edit affordance for frameworks.
Acceptance: edit a framework rationale, submit, reload and open reviewer evidence: the exact edit survives; alternatively the UI offers no unsupported edit.
Do not label an edited rationale “saved” if only the framework identifier is retained.

#### AER-053 — MEDIUM / OPEN — Classification assumes expertise and hides the incomplete answer

Evidence: `intakeFields.tsx:16-59,85-95`; `IntakeWizardPage.tsx:248-255,404-409,487-540`.
Yes/no controls ask “Has an EU nexus”, “Profiles natural persons”, “Safety component” and “Manipulative techniques” without a definition/example.
All answers are mandatory; the only incomplete-state guidance is “Answer every question”, with a disabled primary action.
The existing labels/keyboard accessibility are not reopened (AER-029 remains DONE).

Remediation: short plain-language help/examples next to these labels, a clearly governed “I need help / unsure” route that never defaults to No,
and missing-field summary with focus/link to the first unanswered field. Avoid making a business user guess to get past a disabled button.
Acceptance: omit one answer in each group and get its name/location; keyboard users reach the problem; unfamiliar users can find a definition;
uncertainty cannot silently produce a low-risk classification. Validate comprehension with representative business users.

#### AER-054 — MEDIUM / OPEN — Review does not show the full proposal users are approving for submission

Evidence: `IntakeWizardPage.tsx:624-639`. The final page lists counts for frameworks, risks and questionnaire sections, not their accepted text,
and omits the selected agent/vendor. The progress indicator at `:440-445` is not navigable; correcting a specific earlier answer requires repeated Back.
Questionnaire drafts begin accepted automatically (`:232`), increasing the importance of a meaningful final review.

Remediation: expandable final proposal showing accepted framework/risk text, questionnaire, rejected/omitted sections and linked stack;
“Edit this section” actions returning safely to Review. State who receives the submission and where the owner follows its progress.
Acceptance: final review reflects every changed answer/selection and exclusion; edit one section and return without losing others;
the user can identify the recipient/next action without knowing the workflow implementation.

#### AER-055 — MEDIUM / OPEN — Failed lifecycle detail can read as approval without conditions

Evidence: `UseCaseOverviewPage.tsx:58-80,73-77,126-130,326-332`.
Only the overview query is passed to QueryGate. A failed detail query falls back to empty conditions/reviews and hides the resubmit action.
For an approved overview, the empty-conditions branch renders “This use case was approved without conditions” even when `loaded` is false.
This is a source-proven misleading disclosure; no backend approval/deploy bypass is claimed.

Remediation: render an explicit lifecycle-details error/loading state with retry; never translate unknown conditions into none.
Do not render lifecycle readiness from missing required detail.
Acceptance: overview succeeds while detail returns 500/403: no unconditional-approval statement or misleading completed lifecycle;
display retry; after retry the real conditions, reviews and resubmit action appear.

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
**New confirmation: AER-049 RESOLVED/DONE at 64f0943.** Fix chain `604158b,385631d,69bb1ad,f0adbd2,a1b679e` (integrated `90cfb1b`):
`apps/gateway/src/workflows.ts:218-229,283-301,1593-1649,1813-1829,2022-2107` archives/stamps round-owned effect records,
creates the new-round PR and refuses stale-round merge. Directly inspected tests at `workflow-check-round.test.ts:709-873`
assert fresh branch/PR/merge/deploy with prior history retained. Exact-head CI below executed all **17/17** round tests and **50/50**
workflow-kernel tests. Old unmerged provider PRs remain open; effect history is not yet visualized (disclosed limitations, not failed acceptance).

<!-- codex-enterprise-feedback:start -->
## Latest verification — 2026-10-03 15:39 CDT (UTC-05:00)

- Local isolated review branch: `codex/governance-field-help`; reviewed content is exactly GitHub `dhruv/active`,
  not the unrelated main checkout. Clean ff-only synchronization `8570aad..64f0943`; final pre-edit fetch still `64f0943`.
- Commands: `git status --short`, `git rev-parse HEAD`, `git remote get-url origin`,
  `git fetch origin dhruv/active`, `git pull --ff-only origin dhruv/active`, `git rev-parse origin/dhruv/active`.
- Source inspection: the wizard, shared intake fields/checkpoints, resubmission, registry, record/lifecycle/conditions,
  review drawer, agent stewardship, route/navigation wiring and relevant test cases. Web Interface Guidelines informed
  the checks for dirty-form protection, labels, focused validation and honest error states.
- `gh run view 37146780822 --log` and `gh run view 37146780822 --job 111272519942 --log`:
  [exact-head CI](https://github.com/dhruvmahendrapatel/RegulAIt/actions/runs/37146780822) passed web **160 tests / 20 files**,
  gateway **3,435 / 249**, **39** phase journeys and **88** mocked UI journeys, including intake accessibility and retry/resubmit cases.
  These are independently read **executed CI logs**, not tests newly run locally.
- `gh run view 37146780856 --json jobs`: the separate Demo workflow's demo-journey and approval-review jobs were **skipped** at this head.
  Its green aggregate is NOT evidence that `demo-review-policy.spec.ts` or `demo-intake.spec.ts` executed in that workflow.
- Local `node -e $reviewScript` read-only assertions: evaluated the extracted `submissionInputs` expression with a sentinel framework edit
  (absent from payload), evaluated the extracted assist `onSuccess` callback with a manually edited answer (replaced/reaccepted),
  and asserted the page-memory checkpoint/no wizard persistence guards. **3 checks confirmed, exit 0**.
  Extraction: from `const submissionInputs =` to its closing `});`, evaluate the arrow expression with stubbed pure dependencies;
  from `onSuccess: (data) => {` to its closing `},`, remove TypeScript `as const`, run with setter spies.
  These isolated checks reproduce transformations, not a mounted-browser/end-to-end test.
- Search `rg -n 'beforeunload|useBlocker' apps/web/src`: no matches. One Windows wildcard search of intake test paths failed;
  rerun correctly with `rg -n 'test\\(' apps/web/e2e -g '*intake*' -g '*review-policy*' -g '*resubmit*'`.
- No local database, cloud, provider call, deployment or production data was used. No new installed dependencies or product edits.

**Limits / next gate:** this was a full-path source and automated-evidence scan, not a fresh manual browser session or user study.
Mobile layout, screen-reader speech and first-time-user completion rates remain unmeasured. After AER-050..055, run a browser matrix:
new proposer, reviewer, sent-back owner; clean/partial/failed submission; refresh/session expiry; keyboard and narrow viewport.
Then observe 3–5 non-technical users completing registration without coaching. Record completion, help requests and misunderstood answers.
No enterprise-readiness or certification claim follows from this review.
<!-- codex-enterprise-feedback:end -->
