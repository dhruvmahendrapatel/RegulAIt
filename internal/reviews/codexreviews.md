# Codex reviews

## Purpose and current status

This is the owner-requested continuing review and discussion record for regulAIt.

Read: [initial recommendations](#initial-recommendations--posted-before-the-deeper-audit), [research](#research-and-comparison), [deep audit](#deep-audit--iteration-1-2026-11-21), [Claude discussion](#claudecodex-discussion-ledger), and [historical baseline](#historical-baseline--2026-11-07). It replaces the filename `2026-11-07-whole-build-review.md`; the original dated report is retained under **Historical baseline** below. This file contains feedback and proposals, not permission to merge, deploy, remove a hold or relax production policy.

- **Current assessed source:** `9797d6f42798689d896103b9e9ce04278e01a4ad` (main, 2026-11-21).
- **Initial assessment:** all 39 numbered rows of the November 7 report were reassessed. That is 39 review rows, not 39 independently reproduced vulnerabilities.
- **Research:** primary documentation was retrieved on November 21; sources and limits are below.
- **Deep audit:** first source and browser iteration is published below; full per-page/per-role/per-function completion remains explicitly tracked. The current route census contains 150 screens. Inventory or a generic error-state screenshot does not mean a page's complete user journey has been reviewed.
- **Product source changes in this lane:** none. Recommendations require review and an assigned implementation slice.

## Initial recommendations — posted before the deeper audit

1. **Use the old report as a dated baseline, not today's backlog.** Major RLS, bootstrap-secret, webhook replay, grant-mint, A2A governance, attribution and project-plan enforcement remedies now exist. Reopening their original implementation tasks would duplicate work. Validate their remaining coverage and failure modes rather than equating implementation with complete assurance.
2. **Correct the false positive and qualify the broad claims.** C-05's `expect(1).toBe(1)` is inside a source fixture used to test a scanner; the real test checks that scanner's result. An assertion-count gate, raw RLS table percentage, missing direct import or the presence of an installed library is not sufficient evidence of security or quality by itself.
3. **Prioritize current user-visible correctness and genuine gaps.** Current source still supports follow-up on authentication before expensive parsing, synchronous password hashing, the pre-auth bearer tier, eval/playground JSON Schema disagreement, serial orchestration dispatch, limited IDE optimization and shared-context coverage. Their actual user impact, incidence and risk need evidence; old severities are not automatic current release verdicts.
4. **Reduce security friction by finishing the workflow first.** A protected action must explain its consequences, offer the applicable proof, preserve work on refusal and retry the exact authorized action. A stranded 403 is not a reason to turn MFA off. Expose existing scoped, expiring exceptions where the server already supports them; show inherited floors, effective mode, scope and expiry.
5. **Offer deliberate tuning, not a universal security slider.** Strict defaults remain. Administrators may use appropriate existing per-project/rule controls with reason, impact preview, audit, maximum duration and automatic expiry. Identity, object authorization, credential confidentiality, integrity/signatures, replay protection and sensitive-change audit are mandatory boundaries. Detailed research-backed distinctions are below.
6. **Make this an evidence and reasoning loop.** Codex records a falsifiable finding and recommendation; Claude checks the evidence and responds with a counterexample, agreement or narrower interpretation; the agreed builder links the fix; an independent retest closes it. An opinion or a green baseline test alone does not close a finding.

## How Claude and Codex use this file

The owner requested continuous feedback and reasoning, including page, section, function, UI, UX and usability review. Use stable finding IDs; never renumber an existing finding. Add a new dated iteration when the source head changes. Preserve disputed and refuted findings with their explanation rather than quietly deleting them.

For each new finding record:

| Field | Required content |
| --- | --- |
| Evidence | Exact source commit; page, section, function, role and state; file:line; reproduction and observed/expected behavior. Mark source inspection, mock-browser reproduction and real-gateway reproduction separately. |
| Reason and impact | The user's task, what is confusing/broken/risky, consequence and why it deserves attention. State uncertainty and avoid inventing production incidence. |
| Triage | Frequency and severity, each 1–10, with rationale. A confirmed security-checklist gap blocks irrespective of product score. A confirmed bug with F×S < 5 is an issue/deferred item, not a reason for a speculative code fix. |
| Recommendation | Concrete change, relevant best practice, tradeoff, reuse of existing components/server policy, security tuning implications and proposed acceptance checks. |
| Claude response | Date and reviewed head; agree/disagree/partly agree; evidence and reasoning. A disagreement needs a reproducible counterexample or source trace, not an unsupported dismissal. |
| Disposition | Reported → under discussion → agreed / narrowed / refuted / deferred → fix proposed → independently retested → closed. These are review-record states, not a new product lifecycle helper. |
| Closure | Fix PR/full SHA, acceptance evidence, retest head and remaining limits. A builder's claim is not independent confirmation. |

Use the draft review PR for notifications and discussion, then fold the reasoned result into this file. The owner has authorized repo coordination for this loop. Do not post secrets, customer data or identifying records. This file does not create an unattended background agent; updates occur during active review sessions and in response to Claude's recorded feedback.

## Research and comparison

## Primary-source research for the continuing regulAIt review

Research date: **2026-11-21 UTC**. This is guidance for evaluating the product, not evidence that the product passes these checks. Public documentation was fetched with an HTTP client; no vendor account, vendor UI or live integration was tested. No dependency or product change is proposed here.

### 1. Source-backed review principles

| ID | Principle and why it matters | Concrete review/acceptance question | Primary evidence |
| --- | --- | --- | --- |
| BP-01 | **Start with the user's task, current state and next permitted action.** A technically complete page can still fail if a user cannot tell what to do. | For each role, can the user identify where they are, whether a value is measured/current, what blocks progress and the next allowed action? Does a successful mutation visibly update the state? | [NN/g heuristics](https://www.nngroup.com/articles/ten-usability-heuristics/): visibility of status; match with the real world; recognition rather than recall. |
| BP-02 | **Show advanced controls progressively, but keep essential consequences visible.** Reducing visual density is useful; hiding the policy that will block a workflow is harmful. | Are rarely needed settings collapsed with meaningful labels, while required input, inherited policy, warning impact and the primary task remain visible? Is the security explanation available before a refusal? | [GOV.UK Details](https://design-system.service.gov.uk/components/details/): do not hide information most users need. |
| BP-03 | **Make errors actionable and preserve work.** Generic toasts force users to guess and repeat expensive input. | After submit, does an error summary explain what failed, link to the exact field, match the inline text, receive appropriate focus, retain valid input and permit safe retry? For API policy errors, is there a permitted recovery action or named administrator/request path? | [GOV.UK Error summary](https://design-system.service.gov.uk/components/error-summary/); [WCAG 3.3.3](https://www.w3.org/WAI/WCAG22/Understanding/error-suggestion.html). Suggestions must not jeopardize security. |
| BP-04 | **Do not repeatedly ask for the same information in one process without a reason.** Re-entering project, purpose or configuration after navigation increases mistakes and abandonment. | Do drafts, back navigation and retries preserve authorized non-secret values? Is repeated entry essential, stale or security-required, rather than an implementation accident? Never preserve plaintext secrets merely to satisfy this principle. | [WCAG 3.3.7](https://www.w3.org/WAI/WCAG22/Understanding/redundant-entry.html): previously supplied information should be auto-populated or selectable, with defined security/essential/staleness exceptions. |
| BP-05 | **Accessible authentication reduces friction without removing authentication.** Password-manager support and passkeys are better first remedies than weakening account security. | Can users paste passwords and OTPs, use a password manager, operate every control by keyboard and select an accessible alternative? Does a step-up return them to the action with their non-secret work intact? | [WCAG 3.3.8](https://www.w3.org/WAI/WCAG22/Understanding/accessible-authentication-minimum.html): support password managers and copy/paste; avoid an unsupported cognitive test. |
| BP-06 | **Treat keyboard focus, touch targets and overlays as functional requirements.** Screenshots cannot establish that a modal, sticky footer or icon-only control is usable. | Does focus move predictably, stay visible, return on dialog close and avoid being entirely hidden by sticky UI? Are pointer targets at least 24×24 CSS px or covered by a valid spacing/other exception? Aim larger for frequent/high-impact actions. | [WCAG 2.4.11](https://www.w3.org/WAI/WCAG22/Understanding/focus-not-obscured-minimum.html), [WCAG 2.5.8](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html). Do not misstate the AA target-size criterion as an unconditional 44px rule. |
| BP-07 | **Make task status look like status, and task actions look actionable.** Color alone, fake progress and button-shaped labels mislead people. | Are incomplete/blocked/reviewed/completed states explicit and distinguishable without color? Can the user identify ownership, urgency and what can be done now? Do read-only badges avoid hover/click affordances? | [GOV.UK Task list](https://design-system.service.gov.uk/components/task-list/): research found users mistook statuses for buttons; the redesigned linked row and sentence-case status address that confusion. |
| BP-08 | **Apply reauthentication to sensitive events and transactions, not reflexively to every read.** Repeated ceremonies can drive users into workarounds; removing assurance from sensitive actions creates a different failure. | Is a fresh challenge justified by a specific security-sensitive change or risk event? Are prompts scoped to the intended action and facts? Can passkeys/SSO reduce ceremony without reusing approval for a different operation? | [OWASP Authentication](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html): risk-based/context-aware reauthentication and “Minimize User Friction”; sensitive actions still require reauthentication. |
| BP-09 | **Expose the effective policy and the narrowest authorized exception.** Users should not have to understand the internal inheritance graph just to unblock a legitimate task. | Does the interface show which organization/project setting caused the outcome, who may change it, the exact scope of an exception, affected resources, expiry and impact preview? Can it offer a request/change path when the user lacks authority? | [Defender ASR deployment](https://learn.microsoft.com/en-us/defender-endpoint/attack-surface-reduction-rules-deployment-test), [Sentinel automation](https://learn.microsoft.com/en-us/azure/sentinel/create-manage-use-automation-rules). This does **not** justify changing regulAIt's strict first-load defaults. |
| BP-10 | **Authorization remains server-enforced on every request.** Friendly UI cannot substitute for tenant/project/resource checks. | Do list, count, export, detail, bulk, retry, embedded widget and mutation paths share the same visibility and authority rules? Does changing a client-side role or hidden field fail on the server? | [OWASP Authorization](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html): least privilege, deny by default and validate permissions on every request. |
| BP-11 | **Failed workflows need a recovery model, not only a red status.** A retry button can duplicate side effects unless the backend defines its semantics. | Can the user locate the failed step, inspect permitted evidence, know which side effects committed, distinguish retry/resume/restart, and safely recover or escalate? Does cancellation have an honest terminal outcome? | [n8n error handling](https://docs.n8n.io/build/flow-logic/handle-errors-gracefully.md): execution inspection/debugging and reusable error workflows; [NN/g](https://www.nngroup.com/articles/ten-usability-heuristics/) error recovery/user control. |
| BP-12 | **Assess every page through its underlying function contract.** Counting buttons or endpoints is not deep coverage. | For each action trace input validation → identity/scope → transition/precondition → atomic side effect/audit → response/UI state → failure/retry/cancel. For each displayed metric trace its source, time window, denominator and unknown/partial state. | OWASP per-request authorization, NN/g status/error-prevention principles, [Camunda user-task lifecycle](https://docs.camunda.io/docs/apis-tools/frontend-development/task-applications/user-task-lifecycle/). This is a proposed audit method, not a claim to have completed all function traces. |

### 2. Competitor and adjacent-product patterns

These are documented patterns, not a claim that regulAIt lacks every feature, that a competitor implements it perfectly, or that vendor pages prove live behavior. Licensing/plan terms are separate from UX patterns; do not import code/assets from these products under this comparison.

| Product / source | Verified documentation behavior | Useful comparison for regulAIt | Constraint / avoid copying blindly |
| --- | --- | --- | --- |
| **Camunda Tasklist** — [priorities](https://docs.camunda.io/docs/components/tasklist/userguide/defining-task-priorities/), [managing tasks](https://docs.camunda.io/docs/components/tasklist/userguide/managing-tasks/), [access control](https://docs.camunda.io/docs/components/tasklist/userguide/access-control/) | Task priorities are 0–100, default 50, displayed as labels and sortable. The guide distinguishes unassigned, assigned-to-me and completed tasks, with assignment followed by form completion. | Compare queue triage, ownership, priority visibility, state labels, task detail and post-completion navigation against the existing single approvals queue. Test both a reviewer and a requester. | Do not add an unnecessary numeric-priority scheme or duplicate task engine just to match Camunda. Preserve existing policy, step-up, quorum and signature requirements. Current served docs identify version 8.10; earlier versions may differ. |
| **Microsoft Defender ASR** — [test deployment](https://learn.microsoft.com/en-us/defender-endpoint/attack-surface-reduction-rules-deployment-test), [exclusions](https://learn.microsoft.com/en-us/defender-endpoint/microsoft-defender-antivirus-exclusions-configure) | Deployment guidance uses a small pilot group, audit observations, impact reporting and rule-specific exclusions; it explicitly recommends exclusions/Warn where suitable over turning a whole rule off. | Review whether an administrator can understand a false positive, preview impact, choose a narrow authorized scope and see what protection changes. Report mode and actual enforcement honestly. | Microsoft's audit-first rollout advice conflicts with regulAIt's strict-by-default rule if applied globally. Transfer the controlled-preview/exception pattern, not a warn-only default. An exclusion broadens risk and needs explanation, authorization, audit and bounded scope. |
| **Microsoft Sentinel** — [automation rules](https://learn.microsoft.com/en-us/azure/sentinel/create-manage-use-automation-rules) | Rules support explicit conditions, ordered actions and an optional expiration date/time; incident history can be queried to see automation actions. | Compare temporary exceptions, readable conditions, precedence, expiration and decision history. A visible reason and expiry are easier to reason about than a silent global toggle. | The cited page proves optional rule expiration, not that all Sentinel exceptions expire by default or that every automation action has reversible effects. Do not claim those stronger properties. |
| **n8n** — [handle errors gracefully](https://docs.n8n.io/build/flow-logic/handle-errors-gracefully.md) | Users can inspect failed executions, load execution data for debugging and configure a reusable error workflow in workflow settings. | Compare recovery discoverability, context linking from failure to execution, the difference between re-run and retry, and reusable administrative handling of failures. | Do not duplicate governed dispatch or expose raw customer payloads/secrets in a friendly debugger. Documentation is a UX reference; n8n is not proposed as an allowed-license runtime dependency. |
| **Retool** — [permissions](https://docs.retool.com/permissions/) | Documentation distinguishes default groups from plan-dependent custom groups, object permissions and per-environment resource access. | Compare whether settings explain the effective permission, resource and environment scope, and why a person can view but cannot change something. | Plan-dependent capabilities must be acknowledged. No claim about observed Retool UI or tenant isolation is made; no Retool code/assets are being adopted. |

### 3. Security tuning: useful options versus invariants

The goal is to remove unnecessary ceremony and false-positive disruption while preserving actual trust boundaries. Recommendations below are candidates for policy/design review, **not changes already authorized or implemented**. Reuse existing server settings, scopes and state machines; do not introduce an independent bypass path.

Every relaxation should display: **what changes, why, who is affected, who approved it, inherited floor, expiry/review date, remaining protection and rollback**. Persist changes with their audit in one transaction. Enforce expiry on the server; a countdown in the browser is not enforcement. When an inherited/legal/tenant policy disallows relaxation, explain it and offer an authorized request path rather than an editable control that cannot succeed.

| Control area | Usability/tuning option worth evaluating | Boundary that remains enforced |
| --- | --- | --- |
| Repeated authentication | Passkeys/SSO, password-manager/paste support, accessible alternatives, and risk/action-based prompts; consider bounded recent-auth reuse only where the existing value-bound action semantics remain satisfied. | Required admin MFA, authentication, resource authorization and fresh assurance on sensitive security changes. Never make a token for one action authorize another. |
| Low-risk reads and routine navigation | Avoid needless step-ups; retain an authenticated session within permitted idle/absolute limits. Preserve non-secret form state if a challenge interrupts a task. | Session validity/revocation, tenant/project boundaries and restricted reads. |
| Detection false positives | Existing policy thresholds/modes or a narrowly scoped, admin-approved exception with explanation, evidence, impact preview and expiry, if the effective policy permits it. | No silent downgrade below organization/project floors; mandatory verification and hard safety bounds stay in force. Default remains strict. |
| Approval friction | Better assignment/delegation, bulk triage and trusted low-risk policy exemptions where explicitly permitted; make the scope/decision clear before save. | Separation of duties, eligible approver/quorum/signature requirements and server transition guards for actions that require them. |
| Rate limits and budgets | Per-user/project/provider limits with impact preview and authorized bounded temporary increases; explain which limit was reached and when it resets. | No uncontrolled amplification, unbounded input/body/response sizes, or bypass of another user's budget/entitlement. |
| Timeouts and session expiry | Administratively configurable bounded durations, advance warning where appropriate, drafts and safe retry/resume. | Server deadlines, revocation and maximum limits; saving drafts must not retain plaintext credentials or protected data outside authorized storage. |
| Emergency access | If required, explicit short-lived narrowly scoped break-glass grants, named owner/reason, independent review and post-use audit; implement through the existing policy engine. | No universal “security off” switch, silent grant escalation, identity substitution or audit suppression. |
| Network and imports | Clear allow-list management and quarantined previews, using existing approved policy controls. | TLS/credential protection on remote connections; SSRF validation, signature/replay checks, import integrity, algorithm/key/version validation and bounded parsing. A development-only relaxation must remain explicitly scoped, never an ambient customer default. |
| Audit and evidence | Role-appropriate explanations and redacted summaries rather than raw internal logs; flexible authorized retention above mandatory floors. | Audit of sensitive changes, relaxations and imports cannot be skipped to make an operation faster. Secret values must not enter logs or explanation text. |

**Avoid a security slider.** “Low/medium/high security” hides several independent consequences. Prefer task-specific controls with a summary of effective settings and inherited locks. If presets are eventually introduced, show their exact diff, applicability, expiration and authorization requirements before applying them; a preset must not bypass individual control floors.

### 4. How to use this in each deep page/function review

For every page and its important sections, record: intended users/task; data source and authorization; primary/secondary actions; empty/loading/error/denied/partial/stale/success states; keyboard/focus/screen-reader/mobile behavior; preservation of work and recovery; task completion evidence; policy-friction hotspots and any justified tuning. Inspect both a permitted and denied role. Trace every mutation to the backend function/transition and relevant side effects rather than inferring behavior from the button label.

Measure actual task outcomes when possible: task completion, time/steps, wrong-action and recovery rate, repeated prompts, abandoned steps, permission-refusal clarity and ability to locate the next action. Do not invent numerical targets or claim user testing from static inspection. A mock API proves a rendered state under that fixture; a source trace proves the inspected path; neither alone proves the live end-to-end journey.

A finding card should separate **observation** from **recommendation** and include: ID, reviewed commit/page/role/state, reproduction and evidence, user/business impact, cause/function references, frequency/severity with rationale, proposed change and tradeoff, default/tuning implications, acceptance check, confidence, Claude response, agreed disposition, fixing commit and independent retest evidence. Mark “not yet inspected” explicitly; an inventory row is not completed coverage.

### 5. Retrieval record and limitations

All final URLs linked above returned **HTTP 200** on 2026-11-21. HTML/Markdown and retrieval metadata are preserved locally under `/tmp/review-research/` (`sources.json`, `sources-extra.json`). Initial guessed Camunda lifecycle/priority URLs and a Sentinel exception URL returned 404; they were not used as evidence. Correct Camunda links were located in the site's public sitemap; the Sentinel claim is limited to its verified automation-rule page. The n8n URL redirected to its current Markdown document, and the Defender exclusions URL redirected to its current canonical URL; final URLs are cited above.

These sources provide design/security criteria and documented comparisons. They do **not** certify regulatory compliance, prove vendor behavior, establish all current regulAIt defects, or justify relaxing mandatory policy. No new library is recommended, so no unvalidated dependency comparison is substituted for the repository's required open-source due diligence.

## Deep audit — iteration 1, 2026-11-21

This iteration adds **26 feedback cards**, six targeted mock-browser reproductions and a known harness observation. Cards include functional defects, usability gaps and explicit design proposals; they are not 26 independently proven security vulnerabilities. Frequency scores estimate encounter frequency within the affected workflow, not measured production incidence. Overlapping cards identify shared causes rather than independent bug totals.

### Priority recommendations for Claude to challenge

1. **Unstrand protected scorer actions (CXR-ADM-001).** Connect the existing proof-and-retry UI to the server's protected action. Keep step-up and all server checks; repair the journey instead of weakening them.
2. **Preserve work and honor input methods (UIW-01/02, CXR-ADM-008).** Failed writes must not erase a prompt or configuration draft. Enter during composition must not submit early. Preserve authorized non-secret work without persisting credentials or blindly replaying a possibly committed mutation.
3. **Make keyboard navigation and overlays functional (UIS-01/03).** A closed mobile rail must not take invisible focus. A global shortcut must not create an unusable overlay behind a native modal. Reuse existing focus/overlay primitives.
4. **Make security status and previews honest (CXR-ADM-002–007).** Explain where text goes, expose the existing bounded troubleshooting window, distinguish expired overrides, and label stale or partial sample results. Unknown inventory is not zero inventory.
5. **Improve error recovery, policy explanations and list continuity (UIW-03–08, UIS-05/06/08).** Preserve context through outages, distinguish missing access from retryable failures and restore an investigator's view after drill-down. Avoid adding more confirmation prompts to routine work.

### Browser evidence and its limits

- Existing enterprise harness: **445 expected passes, 5 public-page state skips, 0 unexpected failures** over 150 routes. There are 300 light/dark axe records, 150 responsive records, 145 state records and 145 density records. These are automatic error/loading-state checks, not end-to-end task completion.
- There were no serious/critical axe findings in those rendered states and no viewport overflow findings at the harness's768–1920px widths. Those widths omit phones; they did not catch the375px off-screen keyboard failure.
- One known baseline observation remains: `/builder/playground` lacks an error alert under the harness's generic503 responses. The baseline permits it. A green ratchet therefore does not establish a completely clean UI.
- Six targeted probes use existing synthetic fixtures. Four were first reproduced, then the guardrail-sample and synthetic-IME probes were rerun after the harness's preview server had stopped. Initial connection-refused setup failures were not counted as product defects. The final two probes completed on a verified local preview.
- Raw sanitized results are in [browser coverage](evidence/2026-11-21/browser-coverage.json) and [targeted observations](evidence/2026-11-21/runtime-probes.json). Reproduction steps and proposed regression locations are in each card. Screenshots were inspected locally and are not a claim of live vendor, customer-data or screen-reader testing.

### CXR-RUN-001 — Existing baseline permits a missing playground error state

**Observation:** under the generic503 fixture, `/builder/playground` recorded `error-not-shown:1`; the test still passed because this count is already in the committed baseline. **Provisional F6×S3=18** for a user facing an unavailable dependency. This is a rendered-state observation, not proof that every playground failure lacks recovery.

**Reason and recommendation:** a user must distinguish “no eligible agents” from “the agent list could not be read.” Claude should reproduce with the page's real API contract, inspect the intended degraded state, and either add actionable inline error/retry guidance or document why another accessible recovery path satisfies it. Do not raise or silently clear the baseline to dismiss the observation. Closure requires populated, empty, denied and unavailable fixtures.

## Deep admin usability assessment — first source batch

Assessed source: `/workspace/codexreviews`, main `9797d6f42798689d896103b9e9ce04278e01a4ad`. Read-only. This contribution did not run a browser, a gateway, or tests. Findings marked source-confirmed follow executable handlers and their server contracts; runtime recipes below are requested validation, not claimed results. Recommendations marked design are product proposals, not vulnerabilities. F and S use the owner's 1–10 scales; frequency is conditional on the described journey, not a measured production incidence.

### Key recommendations

1. Complete existing protected workflows in the UI instead of asking operators to weaken step-up settings when the UI cannot request a proof.
2. Expose the **existing** server-expiring guardrail window in the override form. Preserve compliance floors, value-bound step-up and audit; do not build a second exception engine.
3. Make safety status truthful: show expiry, bind test results to the tested input, and distinguish unread inventory from zero inventory.
4. Add an explicit review of bulk-hardening changes. A user should see affected controls and likely refusal effects before the immediately effective operation.

### Findings

#### CXR-ADM-001 — Protected scorer edits and enablement cannot complete through the ordinary page

**Root verification:** The browser sent one protected enable request, received step_up_required, opened zero verification dialogs and made zero step-up options/verify calls. The page displayed the refusal but offered no way to finish it. This is a mock-browser UI reproduction, not a fresh backend exploit. See [sanitized observations](evidence/2026-11-21/runtime-probes.json).

- **Type/status:** functional integration defect; source-confirmed. **F7 × S6 = 42**, High.
- **Evidence:** `apps/web/src/views/admin/integrations/ExternalScorersPage.tsx:301` uses ordinary `api.post` for enable/disable. `apps/web/src/views/admin/editForms.tsx:223` uses ordinary `api.patch` for scorer edits. The gateway requires value-bound step-up for changes to an instrument used by an enabled trained detector (`apps/gateway/src/external-scorers.ts:464`) and guarded enablement (`:635`). The shared client announces a refusal, but its `StepUpRequest` has no retry callback (`apps/web/src/api/client.ts:27`). The global listener explicitly returns when that callback is absent (`apps/web/src/stepup/stepUp.ts:149`). There is no implicit prompt-and-retry to rescue these calls.
- **User impact/reason:** an entitled admin with a configured second factor clicks a supported action and gets a refusal with no usable way to complete it on this page. This looks like excessive security, but the actual defect is an unwired security workflow. It encourages global policy weakening or abandoning the product.
- **Reproduce:** use a signed-in admin session with TOTP/passkey, strict step-up and a scorer referenced by an enabled trained detector. Change its endpoint/credential/kinds, or re-enable the referenced scorer. The request receives `step_up_required`; no identity dialog is opened. A vendor-adapter enablement that requires the same guard is another case. Test as a session, not an API key, because API keys correctly cannot step up.
- **Recommendation:** use the existing `withStepUp` and header-aware request helpers at both call sites, keeping the draft through cancel/refusal and refreshing the scorer after success. Add a route-level browser regression for proof → retry → successful state change.
- **Preserve:** admin permission, exact action-bound proof, scorer/binding locks, fresh server facts, CSRF, audit and egress restrictions. Do not fix by disabling step-up.
- **Claude question:** can the shared request abstraction make protected-action coverage explicit so future server guards cannot strand older pages?

#### CXR-ADM-002 — External-scorer explanation incorrectly says inline guardrails remain local-only

- **Type/status:** incorrect product/data-boundary disclosure; source-confirmed. **F8 × S5 = 40**, Medium.
- **Evidence:** the visible help in `ExternalScorersPage.tsx:97`–`:103` says the inline guardrail path stays local-detector only and deliberately does not make the latency/data-egress decision. The same page offers guardrail scorer kinds (`:44`–`:49`). `TrainedDetectorsPanel.tsx:194` directs users to register a scorer here and bind it to a trained detector. The gateway's trained detector execution uses that scoring service beside local detection.
- **User impact/reason:** the admin can believe content is checked locally even after configuring a service that receives scanned content. A service may be self-hosted; that does not make the "local-detector only" statement true. Informed privacy and latency choices depend on the actual destination.
- **Reproduce:** read the scorer help, register a scorer claiming a guardrail kind, then open Guardrails → Trained detectors and choose it. Compare the claimed boundary with the configured call path.
- **Recommendation:** explain eval-only and inline-trained uses separately, show the chosen endpoint/hosting boundary and affected phases, and disclose which data is sent before enabling. Link directly to the relevant guardrail setup. Counts-only audit storage must not be described as "text never leaves this gateway."
- **Preserve:** no automatic third-party opt-in, air-gap checks, per-host egress and audited activation.

#### CXR-ADM-003 — The safe temporary guardrail-relaxation option exists on the server but is absent from the form

- **Type/status:** capability/discoverability gap; source-confirmed UI omission. **F6 × S5 = 30**, Medium.
- **Evidence:** `GuardrailsPage.tsx:485` sends only `{modes: ovModes}`. The server already supports `assuranceWindow: {ttlMinutes}` (`apps/gateway/src/guardrails.ts:555`–`:562`), refuses replacement of an ordinary active admin override (`:794`), and binds window opening/extension into step-up facts (`:804`). The window expires server-side rather than relying on an open browser.
- **User impact/reason:** an operator handling a false positive can only discover a lasting override through this form, while the safer self-expiring alternative is hidden in API semantics. This is exactly where security friction can be reduced without silently weakening the deployment forever.
- **Reproduce:** open Guardrails → Overrides and attempt to relax one detector for one agent for a short troubleshooting interval. There is no duration/window choice, although the same endpoint accepts it.
- **Recommendation:** expose "temporary troubleshooting window" with bounded duration, exact target, old → effective modes, reason and expiry preview. Default any relaxation journey to the shortest useful scoped window; leave permanent changes as an explicit separately explained choice. Reuse the existing server mechanism; add any missing reason support through the same audit path rather than parallel storage.
- **Preserve:** compliance floors, admin authorization, value-bound proof, no automatic extension, server expiry and an always-visible active-window status.
- **Claude question:** what duration and renewal experience is appropriate for real operations, and should recurring false positives lead to a reviewed rule exception rather than repeated windows?

#### CXR-ADM-004 — Expired overrides still look effective until the cleanup sweep removes them

- **Type/status:** policy-status display defect; source-confirmed. **F5 × S5 = 25**, Medium.
- **Evidence:** the backend deliberately lists an expired row until the sweep and returns `expired` (`guardrails.ts:641`–`:647`), while runtime policy ignores expired rows. The frontend `ConfigRow` type has no expiry fields (`GuardrailsPage.tsx:65`), counts every returned row (`:210`), and renders every mode as an ordinary status badge in the override table (`:543`–`:553`).
- **User impact/reason:** users see a relaxing override after it has ceased to apply, misdiagnose a renewed block, or assume a stricter override is still protecting traffic. The effective-policy card can disagree with the list without explaining why.
- **Reproduce:** create a short window through the existing API, wait past its expiry without running the removal sweep, and open the Overrides tab. The API says `expired: true`, but the table has no expired indication and the count includes it.
- **Recommendation:** include expiry in the typed view, distinguish active/expired, show the server timestamp, and label counts as active versus awaiting cleanup. Do not infer validity solely from row presence. Effective policy remains the authority.
- **Preserve:** server enforcement independent of cleanup and browser timers.

#### CXR-ADM-005 — Sample results can describe old text and a failed rerun only appears in a toast

**Root verification:** The visible clean badge remained after changing the input and after a second sample request returned503. Two synthetic requests were observed. The screenshot was inspected; the result was not bound to the currently edited input. See [sanitized observations](evidence/2026-11-21/runtime-probes.json).

- **Type/status:** stale-result/error-recovery defect; source-confirmed. **F8 × S5 = 40**, Medium.
- **Evidence:** editing the text only updates `sample` (`GuardrailsPage.tsx:606`) while `sampleOut` remains visible (`:625`). A failed request does not clear it (`:614`–`:620`); the Sample tab has no inline `act.error`. The shared action handler catches failures and emits a toast (`adminKit.tsx:379`–`:384`). Thus a previous green "No detector fired" can persist beside changed text or an unsuccessful new check.
- **User impact/reason:** tuning a security rule depends on knowing exactly which text was tested. A stale green result creates false confidence; a transient toast is insufficient for operators comparing results or assistive-technology users returning to the card.
- **Reproduce:** detect benign text and receive clean=true. Replace the text with a different payload without detecting again: green remains. Then return 503 for the next sample request: green still remains after the toast closes.
- **Recommendation:** bind each result to the submitted input and phase; mark it out of date on edits, show pending and failed states inline, and cancel or ignore obsolete requests. Preserve the last successful result only with a clear label identifying what it belongs to.
- **Preserve:** no unconsented model/scorer dispatch, no sample-content audit leakage, and no use of this local preview as an enforcement override.

#### CXR-ADM-006 — "Try a sample" overstates coverage and cannot select the output phase

- **Type/status:** misleading preview scope; source-confirmed. **F7 × S4 = 28**, Medium.
- **Evidence:** help says "Runs every detector" and invites a prompt or completion (`GuardrailsPage.tsx:596`,`:607`). It sends only text (`:618`), so `guardrailSampleSchema` defaults to `phase: input` (`packages/shared/src/index.ts:768`). The handler calls only local `evaluateGuardrails` (`apps/gateway/src/guardrails.ts:1021`), not the trained-detector service, effective-policy resolver or published-classifier loader. The local evaluator filters detectors by phase (`packages/shared/src/guardrails.ts:719`).
- **User impact/reason:** users may interpret a local rule preview as an end-to-end test of trained services, live project policy or an output completion. It does not establish those facts. This makes false-positive tuning and data-egress decisions unreliable.
- **Reproduce:** enable a trained-only detector whose service would flag a fixture that local heuristics do not. The Sample tab can still return clean. Inspect the submitted body for a completion: phase is absent and input is used.
- **Recommendation:** label the existing action "Test local rules", show included and excluded layers, add an explicit phase choice, and display effective policy separately. A future governed full-pipeline preview must be a distinct opt-in with explicit destination/cost disclosure, not a silent extension of the local-only sample.
- **Preserve:** no outbound data from the existing local preview and no assertion that a clean preview guarantees safety.

#### CXR-ADM-007 — Credential inventory reports zero before its inventory has been read

- **Type/status:** unknown-to-zero presentation defect; source-confirmed. **F10 × S3 = 30**, Medium.
- **Evidence:** `CredentialsPage.tsx:238` renders `Inventory · ${inv?.counts.total ?? 0} credentials, ${inv?.counts.flagged ?? 0} flagged`. `inv` starts null and is populated only by the nested DataList's onRows callback (`:217`,`:276`). The outer heading therefore shows zero during loading and can retain zero when the request fails, even though the child list renders an error.
- **User impact/reason:** an operator checking for exposed or stale credentials can see a reassuring empty count while no answer was obtained. This contradicts the existing design rule that an unread or failed measurement is not zero.
- **Reproduce:** hold or fail GET `/v1/admin/credentials` on first visit to `/admin/credentials`; inspect the heading independently of the DataList loading/error region.
- **Recommendation:** render "Loading inventory"/unknown counts until a successful read, and keep a visible stale timestamp when old data is deliberately retained after failure. Populate inventory-wide metadata from a clearly defined response rather than treating null as a measured empty set.
- **Preserve:** permission-scoped totals and counts-only inventory; no credential plaintext added for convenience.

#### CXR-ADM-008 — An unsuccessful monitoring-threshold save clears the user's draft

- **Type/status:** form recovery defect; source-confirmed. **F6 × S3 = 18**, Medium.
- **Evidence:** `CredentialsPage.tsx:334` unconditionally resets `days` in `.then(() => setDays(""))`. `useAction.run` resolves `false` on failure rather than rejecting (`adminKit.tsx:379`–`:384`). The input then falls back to the stored old threshold (`CredentialsPage.tsx:314`), losing the typed value after a server error or cancelled step-up.
- **User impact/reason:** retrying an ordinary tuning change requires re-entering it, and the form appears to have reverted while only a toast explains why. Repeated friction is a reason users stop maintaining thresholds.
- **Reproduce:** change the unused-days threshold, fail the PUT, and inspect the input after the promise settles. It shows the old saved value rather than the attempted one.
- **Recommendation:** reset only when `ok === true`; retain the draft and inline refusal on failure/cancel. Follow the successful pattern already used in ExternalScorersPage and SsoPage registration handlers.
- **Preserve:** server validation, step-up where required and the audit record of successful writes.

#### CXR-ADM-009 — Bulk hardening has an immediate-effect warning but no review of the actual changes

- **Type/status:** usability/safe-operation recommendation, not a hidden behavior or proven authorization flaw. **F4 × S5 = 20**, Medium.
- **Evidence:** `EnforcementPosturePage.tsx:195` posts the enforcement preset directly; its button at286 does not open a review step. The page **does disclose** "Takes effect immediately · no dry run" at284 and lists generic refusal effects. That warning should be acknowledged rather than claiming the action is undisclosed.
- **User impact/reason:** operators must mentally compare a large matrix and predict which currently working journeys will start failing. A one-click safety improvement can create an availability incident and then cause indiscriminate relaxation to recover.
- **Recommendation:** add a review delta listing controls actually changing, affected scopes, unresolved prerequisites, and a confirmation naming immediate impact. Start with a source-derived dry review; do not claim a live-traffic simulation unless it genuinely exists. Offer staged application or a scheduled maintenance window if justified by user research, keeping a clear restore procedure.
- **Preserve:** strict first-load defaults, per-control authorization/audit, atomic update semantics and the choice not to enable optimization as a side effect.

### Patterns worth preserving

- `OrgSettingsCard` distinguishes unknown from a strict default, writes only the changed key, explains old/new and relaxation effects, and locks after a write until reloaded.
- `PatchFormModal.submit` retains the draft and inline error on rejected writes; use it consistently.
- `SsoPage` provider registration and `GroupMappingsPage` correctly use `withStepUp`; SCIM's rendered status links to group mappings and no longer says that mapping is unbuilt.
- `ContentTrustPage` separates source tiers, effective write floor and counts-only evidence. A convenient tuning UI must not silently bypass this policy.

### Coverage ledger

**Routes/sections inspected in this batch:** `/admin/external-scorers` (registration, list actions, edit callback, removal confirmation, disclosure); `/admin/guardrails` (default policy, effective-policy matrix, overrides, sample, trained panel linkage, decision-list structure); `/admin/credentials` (inventory metadata, filters, monitoring threshold/alerts); `/admin/enforcement-posture` (matrix, observed environment controls, harden action); `/admin/organization` (status, generic settings cards, network lockout handling); `/admin/sso` (provider registration, enable/disable callback, sign-in status); `/admin/provisioning` (token issue/rotate/revoke/status, as source checks only); `/admin/group-mappings` (creation and mapping explanation). Route names checked against App.tsx. These are not claims that every state of every route was exercised.

**Functions traced completely or at the cited control:** `OrgSettingsCard`, `SettingRow`, `SettingControl`, `ExternalScorersPage`, `EditExternalScorerButton`, `PatchFormModal.submit`, `GuardrailsPage` sample/override/effective handlers, `detectionContentUnresolved`, `TrainedDetectorsPanel.open`/eligible selection/edit form, `CredentialsPage`, `credentialColumns`, `AlertingCard`, `EnforcementPosturePage.harden`, `renderValue`, `controlRow`, `OrganizationPage`, `relaxedSettings`, `OrgStatus`, `useSection`, `SectionShell`, `Loaded.saveNet`, `ScimPage.issue`, `StatusCard`, `SignInStatus`, `OidcCard` registration/toggle, SAML registration/toggle, `GroupMappingsPage` creation, `useAction.run`, `installGlobalStepUp`, `withStepUp`, shared `announceStepUp` contract; corresponding scorer, override, sample and SCIM server route guards.

**Not fully audited:** every Organization Loaded subform and every identity/integration/governance page; roles/users detail actions beyond sampled guards; actual data population, all role permutations, keyboard/focus, accessible names, responsive layouts, browser history and drafts across navigation; live third-party services and full scorer inference; latency/contrast. Existing Playwright specs and kit helpers were read as references but were not executed. Root's runtime audit should attach its own results against these recipes before marking findings runtime-confirmed.

### Claude response contract

For each finding: accept / partly accept / reject, with the current SHA and source/runtime counter-evidence. If accepted, record the proposed change, guardrails retained, builder/PR, exact regression and later retest. A rejection needs an explanation of why the described user journey does work; pointing only to a backend route is insufficient for a UI integration finding. Discovery of a safe temporary backend mechanism should lead to reusing it, not another exception engine.

## Deep workspace/end-user review — 2026-11-21

Target: `/workspace/codexreviews`, main `9797d6f42798689d896103b9e9ce04278e01a4ad`. Read-only source review; **no browser or live gateway test was executed by this reviewer**. Findings below are source-confirmed behavior or explicitly labelled recommendations; their browser reproduction recipes still require execution. Root owns the living review document and any UI evidence.

### Key recommendations

Keep strict governance, project attribution, evidence binding and approval eligibility. Remove avoidable recovery friction: preserve failed drafts, distinguish temporary outages from deleted records, show the real reason a decision is unavailable, make active policy understandable, and prevent accidental duplicate actions. Security relaxation is not the remedy for any of UIW-01–08.

### Findings

#### UIW-01 — Failed builder messages disappear from the composer

**Root verification:** A budget refusal in the existing synthetic builder fixture displayed an error and left the composer empty. The typed prompt was not editable for retry. This does not claim server-side history was deleted. See [sanitized observations](evidence/2026-11-21/runtime-probes.json).

**Evidence:** `apps/web/src/views/builder/BuilderUi.tsx:647-651` calls a void `onSend` then clears the text synchronously. `BuilderChatPage.tsx:63-72` records an error but clears `pending` on settlement; it neither restores the message nor provides a retry-with-original-content action. `BuilderAgentEditorPage.tsx:38-65` uses the same mutation shape and `:201-206` the same Composer.

**Impact/reason:** A user can spend minutes writing a prompt or setup instruction, receive a temporary network/503 refusal, and lose their editable input. A failed attempt should preserve the user's work; requiring retyping makes policy/network failures feel punitive.

**Score:** F6 × S4 =24. **Confidence:** high, source-confirmed; root mock-browser reproduction recorded below. Applies to builder chat and agent-editor test threads; do not assume all chat paths share this component.

**Reproduction:** Open `/builder`, select a granted agent, type a distinctive multi-paragraph message, make the chat POST return503 before creating a thread, send, wait for the error; the composer is blank and the original prompt has no retry affordance. Repeat within an editor test thread.

**Recommendation:** Keep the draft until send acknowledgement, or retain a failed-message draft with Retry/Edit/Copy. Avoid blindly replaying a mutation that may already have succeeded: use the returned thread/turn identity or existing idempotency contract. Clear only the acknowledged version, so text typed while a send is pending is not overwritten.

**Acceptance:** A rejected or disconnected send leaves the exact original message editable; a successful send clears only the sent draft; retry does not create a second successful turn. All existing model/tool policy checks remain server-enforced.

#### UIW-02 — Enter-to-send ignores IME composition

**Root verification:** A synthetic KeyboardEvent with isComposing=true and Enter produced one chat POST and cleared the input. Native operating-system IME behavior still needs a separate check. See [sanitized observations](evidence/2026-11-21/runtime-probes.json).

**Evidence:** `BuilderUi.tsx:665-669` sends on Enter without checking `e.nativeEvent.isComposing` or the browser's composition state.

**Impact/reason:** For users entering Japanese, Chinese or Korean, Enter is used to commit a candidate word. It can send an unfinished message instead. This is a functional international-input problem, not a stylistic preference.

**Score:** F7 × S3 =21 among affected IME users. **Confidence:** high code-path concern; browser/OS behavior must be verified with real composition as well as a synthetic regression.

**Reproduction:** Start composing a candidate in the builder composer and press Enter to accept the candidate. Confirm whether a chat request fires before composition ends. A browser regression should dispatch Enter with `isComposing=true` and assert zero sends; normal Enter after composition ends should send once.

**Recommendation:** Respect composition before the Enter shortcut, keep Shift+Enter for a newline, and document the shortcut. Do not disable paste or composition as a workaround.

#### UIW-03 — Temporary chat-history errors are treated as deleted conversations

**Evidence:** `apps/web/src/views/chat/ChatPage.tsx:242-261`, function `restoreHistory`, catches every exception and clears `convo`, exchanges and loaded identity, returning `gone`. The newest-thread selection effect at `:231-235` can subsequently select a different thread. No error-type/status distinction exists in that catch.

**Impact/reason:** A500 or brief disconnection can make a conversation appear gone, erase the currently displayed transcript and redirect attention to another conversation. This undermines trust in stored work and makes outages harder to understand.

**Score:** F5 × S4 =20. **Confidence:** high, source-confirmed; runtime reproduction pending. This is not a claim that server history is deleted.

**Reproduction:** Load conversation A, arrange a subsequent restoration of A to return500, retain another conversation B in the rail, and inspect active selection/transcript. Compare with genuine404/403 behavior.

**Recommendation:** Clear selection only for an authorization/not-found result that policy intentionally treats as absent. Keep the current selection and cached display on transient failures; show a retryable error. On session/account changes, retain existing cache-clearing protections so preservation cannot leak another user's transcript.

#### UIW-04 — Shared-context promotion turns API failures into “Nothing promotable yet”

**Evidence:** `apps/web/src/views/projects/ProjectContextPage.tsx:110-112` converts every workflow-list error into `{instances:[]}`; `:117-135` silently swallows all instance-detail failures. The card at `:389-394` has loading and empty branches, but no error branch or degraded-result notice.

**Impact/reason:** An offline or failing workflow service is presented as absence of eligible artifacts. Users repeat workflow work or ask an administrator to relax access when the real issue is a failed read. This is an accuracy/recovery failure, not evidence that the promotion permission should be weakened.

**Score:** F5 × S3 =15. **Confidence:** high, source-confirmed.

**Reproduction:** Open a project's Context page; fail `/v1/workflows/instances` with503. The card says Nothing promotable yet instead of Couldn't load artifacts. Then allow the list but fail an eligible instance detail, and check for a partial-results notice.

**Recommendation:** Preserve authorization-aware omission for truly inaccessible records, but surface network/server failures with Retry. Report partial results when some detail reads fail. Show the existing eight-workflow source limit or provide an explicit view-more workflow path so a bounded subset is not mistaken for complete absence.

#### UIW-05 — Shared-context editor can discard an unsaved draft or close during a save

**Evidence:** `ProjectContextPage.tsx:768-800` passes `props.onClose` directly to Modal and both Cancel controls, including while `busy`. `apps/web/src/ui/kit.tsx:1321-1337` invokes `onClose` for Escape and backdrop clicks. No dirty-draft guard exists in this editor. Closing unmounts the component holding draft/base/conflict state.

**Impact/reason:** Escape or an outside click can discard a carefully edited shared revision without an explicit discard choice. Closing during a slow save can also leave the user uncertain whether Cancel cancelled anything; the request continues and may commit.

**Score:** F5 × S4 =20. **Confidence:** high source behavior; browser demonstration pending. Do not generalize to every modal without checking its owner.

**Reproduction:** Open Edit shared context, change the text, press Escape or click outside, reopen: the draft is gone. Delay the context POST, click Save then Cancel: observe whether the POST completes after the editor disappears.

**Recommendation:** Track dirty vs loaded content; on dismissal offer Keep editing/Discard. While saving, show Saving and either prevent dismissal or make clear that closing does not cancel an accepted save. Preserve existing revision/conflict semantics; never “fix” friction by overwriting the accepted head.

#### UIW-06 — Inbox Deny looks available when the same required reason blocks it

**Evidence:** `apps/web/src/views/inbox/InboxPage.tsx:180-196` requires a reason for admin overrides/self-review before either decision is submitted. `:228-240` disables Approve for `missingReason` but leaves Deny enabled and says only “Approve unlocks once a reason is entered.”

**Impact/reason:** A person sees an enabled Deny action, clicks it and receives a predictable local error. The page already knows the unmet precondition. Inconsistent availability is needless security friction; the reason requirement itself is valid.

**Score:** F6 × S2 =12 for the affected override/self-review rows. **Confidence:** high, source-confirmed.

**Reproduction:** As an admin, open a non-tool, non-intake approval not assigned or delegated to that admin; leave the required reason blank; compare Approve and Deny, then click Deny. Repeat a self-review row.

**Recommendation:** Make both relevant decision controls reflect the same required precondition, with a persistent explanation naming the exact requirement. Keep normal eligible denials available where no reason is required; do not introduce a universal reason requirement.

#### UIW-07 — Workflow planning copy describes a bypass that the backend now blocks

**Evidence:** `apps/web/src/views/workflows/WorkflowDetailPage.tsx:188-194` states “A call that names no workflow is not constrained by this stage.” Current enforcement is project-wide: `apps/gateway/src/plan-only.ts:308-334`, agent invoke `agents-connectors.ts:4128-4131`, compat `compat-core.ts:636-643`, MCP `mcp-proxy.ts:1298`.

**Impact/reason:** Users are told to understand protection in terms of a supplied instanceId although enforcement can refuse an unattributed-instance mutating call because the project has a planning workflow. A correct refusal then appears contradictory. This is stale explanatory UI, not a recommendation to recreate the historical bypass.

**Score:** F7 × S3 =21 among users running project planning flows. **Confidence:** high, UI/backend source-confirmed.

**Reproduction:** Open a project workflow at a plan-only stage; read the explanation; invoke a mutating mode in the same project without instanceId. The displayed “not constrained” expectation conflicts with the project guard.

**Recommendation:** Explain the active project-wide restriction, plan-safe modes and the authorized action that ends the relevant planning stage. Explain documented engine-work exceptions only where relevant. Link to the blocking workflow/project using authorized data. Keep server enforcement.

#### UIW-08 — Workflow actions have no visible in-flight state or click suppression

**Evidence:** `WorkflowDetailPage.tsx:89-98` helper `act` awaits a mutation but records no pending state. Finish planning `:197-209`, submit artifact `:229-242`, and run stage `:265-274` do not disable themselves while their mutation runs. Reason-only disables on other actions do not address pending state.

**Impact/reason:** On a slow network, the action appears idle and can be clicked repeatedly. The user cannot tell whether work was accepted; redundant requests and repeated errors/toasts follow. This finding does not assert that backend state guards permit duplicate deployments or charges.

**Score:** F6 × S3 =18. **Confidence:** high for missing UI pending state; side-effect deduplication must be assessed separately.

**Reproduction:** Delay an advance/artifact response by two seconds, click its button twice and count requests. Confirm the button offers no Working/Submitting/Finishing indication.

**Recommendation:** Reuse a per-action pending mutation state, disable only conflicting actions, retain entered artifact/reason content on failure and provide a retryable result. Keep server transition/idempotency checks; UI suppression alone is not authorization or exactly-once execution.

### Security-friction options that fit these journeys

- Use authorized project selection and persistent “why blocked / who can resolve / next action” context instead of telling users to turn attribution off. An agent's essential billing project should not be discoverable only under Advanced when missing; an authorized preselection for a sole available project is a possible convenience, subject to explicit visible confirmation.
- Approval signatures, per-object permission checks and evidence binding stay mandatory for protected decisions. Reduce repeated explanation, input loss and ambiguous pending states first. A short-lived, action/value-bound step-up proof may be reused only according to the existing server contract; never treat a UI toggle as an override.
- Distinguish display preferences and notification density from policy relaxations. Only the latter need administrator authority, a recorded reason, scope, expiry where supported and a clear effective-policy preview. Do not add an unbounded global “less security” switch.
- Preserve password-manager autocomplete and OTP paste already present in Login/forced-change forms. No password-manager restriction was found in the inspected forms.

### Coverage actually inspected

This is a deep selected-flow source pass, not complete coverage of every workspace function.

| File | Functions/sections inspected | Coverage limit |
| --- | --- | --- |
| `views/auth/LoginPage.tsx` | normalizeOptions, ProviderLink, LoginPage state/options, finish, submitPassword, submitTotp; password/OTP field attributes and account-link help | Login handlers/field semantics only; no external IdP/browser or complete account-link execution |
| `views/auth/ForcedPasswordChange.tsx` | password inputs, autocomplete and submit/sign-out controls | Form rendering selected; server password policy not audited here |
| `views/builder/BuilderChatPage.tsx` | complete component: agent selection, useMutation lifecycle, current-thread/error/loading views, new composer, recent threads | No browser fixtures executed |
| `views/builder/BuilderAgentEditorPage.tsx` | component through conversation/setup/editor controls; mutation lifecycle, no-project banner, Composer integration | Later setup walkthrough/configuration internals not exhaustively read |
| `views/builder/BuilderUi.tsx` | ChoiceCards, Segmented, Switch, Disclosure, Section, Composer; project selection references | Other large shared helper/dialog/message functions remain outside this pass |
| `views/builder/AgentConfigure.tsx` | Advanced/project setting placement | Other configure sections unreviewed by this worker |
| `views/chat/ChatPage.tsx` | restoration effects/ticketing, attachment add/paste/drop, send creation/clearing, HTTP/SSE error handling and stop semantics | Full exchange rendering and every multimodal/provenance branch not audited |
| `views/inbox/InboxPage.tsx` | query/scoping summary, device-clock notice, focus restoration, instance-evidence reads, decide, itemView/controls, drawer selection | Remaining detailed evidence/intake/MCP dialogs require separate specialized review |
| `views/projects/ProjectsPage.tsx` | list loading/error/empty branches, create modal, archived chips, card navigation/budget summaries | No populated keyboard/browser pass |
| `views/projects/ProjectDetailPage.tsx` | settings modal, measured/forecast/budget cards and membership guard references | Full membership form/CSV delivery not audited |
| `views/projects/ProjectContextPage.tsx` | promotable query, promotion, outcome reporting, context/history controls, ContextEditorModal load/readCurrent/submit/conflict/dismiss logic | Other graph/index pages not read |
| `views/workflows/WorkflowsPage.tsx` | list columns, intake routing/fields, start mutation, default staging/paths, DataList setup | No server assignment-rule integration test |
| `views/workflows/WorkflowDetailPage.tsx` | loading/error, state/stages, act, plan/artifact/trigger/check/deploy action controls | No real deployment, complete provider or trigger chain execution |
| `views/spend/SpendPage.tsx` | self-scope queries, server summaries, savings aggregation and KPI/error/empty sections | Most charts/export/rendering helpers not fully audited |
| Backend cross-checks | `plan-only.guardProjectPlanOnly`, invoke/compat/MCP call sites; context promotion authorization | Source inspection only |
| Existing tests read selectively | builder chat/editor mock-test coverage searches; project-context patterns | No test run by this reviewer |

Unreviewed workspace surfaces include: BuilderAgents/Templates/TemplateDetail/Prompts/PromptDetail/Usage/Playground/Integrations/Skills, pipeline builders, ContextGraph/ContextIndex, AnnotationReview, forced-MFA complete flow, complete ReviewPanel/McpActionReview and all run-detail branches. They must remain marked pending rather than counted as reviewed because their names appeared in an inventory.

### Positive behavior to retain

Inbox uses server-scoped queue results and explicitly labels client-clock due summaries; it restores focus after decisions. Shared-context editing distinguishes accepted revisions from retained conflicts and shows both texts. Spend separates measured routing actuals from estimated technique totals. Login supports password-manager and OTP autocomplete. Those features should not be discarded during visual redesign or friction reduction.

## Deep shared UI/UX review — source pass, 2026-11-21

Target: `/workspace/codexreviews`, main `9797d6f42798689d896103b9e9ce04278e01a4ad`. Read-only. These are source-backed findings and proposed browser reproductions, not claims that the browser reproductions or test suites were executed. Root browser observations are recorded in this file; the source contribution itself did not execute them. F is estimated encounter frequency in the affected flow, not measured incidence; S is user impact. No issue below F×S < 5 is proposed for a code change. No public verdict or source edit made.

### Highest-value findings

#### UIS-01 — closed mobile navigation remains keyboard reachable off screen

**Root verification:** At375px, Tab from the skip link reached seven controls in the closed aside with right bounds between−17px and−9px, entirely outside the viewport. The hidden navigation did not become visible. See [sanitized observations](evidence/2026-11-21/runtime-probes.json).

- **Evidence:** `apps/web/src/shell/shell.module.css:608–623` hides the mobile rail only with `transform: translateX(-100%)`. `AppShell.tsx:306–343` leaves the aside mounted with focusable nav controls, without `inert` or hidden state. `onRailFocus` at289 sets `focusOpen`, but mobile CSS opens only `.sideOpen`, derived from the separate `sideOpen` state.
- **User impact/reason:** a keyboard or switch user on a narrow viewport can tab into navigation controls they cannot see. The desktop keyboard auto-opening behavior does not open the mobile rail. This is more than aesthetic overflow: focus visibility and order fail in a primary navigation flow.
- **F7 × S5 =35. Confidence:** high from DOM/CSS state, root mock-browser reproduction recorded below.
- **Reproduce:** use375px viewport, load a signed-in page with nav closed, press Tab from the skip link; compare focused element bounds with the viewport. Repeat at960px and961px.
- **Recommendation:** explicitly remove the closed mobile rail from interaction/accessibility traversal (e.g. `inert` with correct focus handoff), and manage opening/closing/focus-return as one mobile state. Preserve the existing desktop auto-open behavior. Include Escape and route-choice closure; do not globally hide desktop nav.
- **Acceptance:** no offscreen nav item is a Tab stop while closed; open nav is fully operable; closing returns to its trigger; desktop rail keyboard behavior remains intact.

#### UIS-02 — inline field errors are visible but not associated with the input

- **Evidence:** `ui/kit.tsx:179–194` clones a sole Input/Select/Textarea only to give it an id. The error is an anonymous span with no id, no `aria-describedby`/`aria-errormessage` association and no automatic `aria-invalid`. This occurs in real consumers, e.g. `views/approvals/ReviewPanel.tsx:473,483,545`, `views/admin/compliance/DataSubjectRequestsPage.tsx:103` and builder forms.
- **User impact/reason:** a screen-reader user returning to a bad field hears its label but may not hear why it failed. A form can look self-explanatory while its correction path is inaccessible.
- **F8 × S4 =32. Confidence:** high source-level. Existing kit tests cover label/help preservation and busy-state focus, not this association.
- **Reproduce:** submit an approval condition with an invalid date or another Field-error consumer; inspect accessibility name/description and invalid state on the input, then refocus it with a screen reader.
- **Recommendation:** the shared Field should attach a stable error id, merge it into existing descriptions, and mark only erroneous inputs invalid. Preserve caller ids/help associations. Group fields need an explicit group pattern rather than putting multiple controls in one label. A page error summary should link to affected fields where several errors exist.
- **Acceptance:** corrected field clears its invalid association; existing help stays; each error is available when focusing its field; error summary focus does not erase the draft.

#### UIS-03 — global search shortcut conflicts with an already-open native modal

**Root verification:** With a native edit dialog open, Ctrl-K mounted a command palette behind it. Focus remained inside the original dialog. The screenshot was inspected and shows both overlays; this is a functional modal-stack conflict, not only a theoretical CSS concern. See [sanitized observations](evidence/2026-11-21/runtime-probes.json).

- **Evidence:** `shell/AppShell.tsx:160–167` toggles the command palette on Ctrl/⌘-K globally, without considering open dialogs. `ui/kit.tsx:1301` uses native `dialog.showModal()`. `shell/CommandPalette.tsx:216–225` instead renders a styled div with role=dialog; its autofocus at142 tries to focus a background input.
- **User impact/reason:** when a native dialog is open, the palette div cannot rise above the browser top layer and its background input is inert. The shortcut can create a hidden second UI layer; closing the first dialog can reveal an unexpected search overlay. This is particularly confusing during a step-up or approval confirmation.
- **F4 × S4 =16. Confidence:** high browser-model/source reasoning; root mock-browser reproduction recorded below.
- **Reproduce:** open a DataList column picker or another kit Modal; press Ctrl-K; inspect palette visibility/focus, then close the original modal. Repeat with a step-up dialog.
- **Recommendation:** define one modal stack/shortcut policy. Suppress command-palette activation while a higher-priority modal owns interaction, or use the native dialog stack consistently. Do not reset or dismiss an approval/step-up transaction to satisfy global search.
- **Acceptance:** shortcut never opens an invisible layer; focus stays predictable; Escape closes only the active layer; original draft/confirmation remains intact.

#### UIS-04 — clickable table rows replace native row semantics with link semantics

- **Evidence:** `ui/kit.tsx:1135–1155` sets `<tr role="link" tabIndex=0>` for every `onRowClick`; its children remain `<td>`. Some callbacks do not navigate at all: `views/admin/identity/RolesPage.tsx:195` selects a grants panel and `UsersPage.tsx:263` opens management in place. Others navigate through JavaScript, e.g. `views/runs/RunsPage.tsx:478`.
- **User impact/reason:** assistive technology no longer receives an ordinary row/cell table structure. Announcing a link for an in-place selection also gives the wrong action model; a JS row cannot provide genuine link behaviors such as copy/open in a new tab. Empty/error-only audits miss populated-row defects.
- **F8 × S4 =32. Confidence:** high source-level; run axe/screen-reader checks on populated rows before assigning a specific WCAG violation.
- **Reproduce:** populate Roles/Users/Runs, inspect the accessibility tree and navigate by table rows/cells; activate the row action using keyboard and try normal link context actions on Runs.
- **Recommendation:** keep native table/row/cell semantics. Put a real link in a primary cell for navigation, or a named button for in-place disclosure/selection, with explicit expanded/selected state where applicable. Optional whole-row pointer targeting must not steal events from embedded action controls. Preserve existing row labels and keyboard access.
- **Acceptance:** populated table structure is valid; navigation anchors have real hrefs; selection is announced accurately; inline actions do not also trigger row navigation.

#### UIS-05 — a changed filter can display old matching rows with no clear old-filter warning

- **Evidence:** `ui/DataList.tsx:262–267` sets `placeholderData: keepPreviousData`. Rows at288 and status at369–376 use that previous page while fetching the new filter. The table receives `loading={q.isLoading}` at416, which is false for placeholder data; only the refresh icon carries busy state. `isPlaceholderData` prevents Next at434 but does not label the visible records as belonging to the old filter.
- **User impact/reason:** after changing status or a role filter, the filter control says one thing while actionable rows still represent another. Keeping useful rows is good; silently making them appear current is not. This is especially risky for operational lists where the user acts quickly on status.
- **F7 × S3 =21. Confidence:** high source/React Query behavior, network-delay reproduction pending.
- **Reproduce:** delay a DataList response2s, change a filter from one disjoint result set to another and inspect rows/status/actions before it resolves.
- **Recommendation:** retain previous rows if useful, but label them explicitly as previous results while the new selection loads, mark the result region busy, and prevent context-sensitive bulk actions from treating them as the current filtered selection. Do not replace honest old data with fabricated empty state.
- **Acceptance:** delayed queries cannot misrepresent the active result scope; success/error states clear/update the label; navigation does not jump; existing stale-refetch error messaging remains.

#### UIS-06 — drill-down/back loses the list position and sort

- **Evidence:** `ui/DataList.tsx:238–246` initializes sort and page in component state; only page size and column preferences are persisted. No URL/location-state restoration exists in DataList. `views/runs/RunsPage.tsx:478` navigates to a detail route, unmounting this list; returning mounts it at page0/default sort.
- **User impact/reason:** an investigator working through later pages must repeatedly reconstruct their view after inspecting one record. URLs cannot communicate the same sorted page to a colleague. This costs time and encourages multiple tabs as a workaround.
- **F8 × S3 =24. Confidence:** high source-level. Some page filters already use search parameters; preserve those instead of inventing another filter state.
- **Reproduce:** sort a Runs list, advance several pages, open a run and use browser Back; compare sort/page/scroll position.
- **Recommendation:** make shareable filters/sort and a safe page/cursor restoration part of the existing list contract; restore Back navigation and scroll. Avoid persisting stale authorization-dependent records themselves, and revalidate cursor scope when filters or permissions change.
- **Acceptance:** Back restores a coherent view and position; deep links are bounded/validated; deleted/expired cursors recover to a labelled nearest valid view rather than silently switching scope.

#### UIS-07 — the two theme stores do not notify each other

- **Evidence:** `ui/useTheme.ts:12–18` subscribes only to its own module's listener Set. `theme/mode.ts:18–27` writes `data-theme` but notifies a different Set. `useThemeMode` observes data-theme at32–35, but useTheme does not. It also does not subscribe to the OS media query when in system mode. AppShell uses useTheme to render its toggle icon and accessible name at483–487.
- **User impact/reason:** changing appearance through the account/settings selector or OS can change the CSS while the topbar continues to advertise the previous action/icon until an unrelated shell render. A setting appears inconsistent even though the underlying theme changed.
- **F5 × S2 =10. Confidence:** high source-level; browser-state check pending.
- **Reproduce:** set Dark/Match my device in Appearance without reloading, or change emulated color scheme in system mode; inspect the topbar label/icon before another shell update.
- **Recommendation:** share one external theme store, including attribute/media/storage events, rather than add another local state copy. Keep account persistence and local fallback behavior.
- **Acceptance:** all theme controls and accessible names agree immediately; system-mode changes work live; blocked storage still leaves the tab operable.

#### UIS-08 — custom list error wording discards the HTTP status needed for recovery guidance

- **Evidence:** `ui/DataList.tsx:417` replaces a structured ApiError with `new Error(props.errorMessage)`. `ui/kit.tsx:1189` detects access denial from `.status===403`; that metadata is now gone. Real consumers include `views/admin/identity/WorkloadIdentitiesPage.tsx:264` and `WorkloadIdentitySubpages.tsx:67`. Shared ErrorState also renders Retry whenever onRetry exists, including access errors (`kit.tsx:1528–1535`).
- **User impact/reason:** a stable authorization refusal looks like a transient load failure and invites repeated retries. This makes security feel arbitrary instead of showing the legitimate route to recovery. Sanitizing the server's detail is appropriate; discarding its classification is unnecessary.
- **F6 × S3 =18. Confidence:** high source-level.
- **Reproduce:** return403 from a workload-identity list using errorMessage; compare heading/recovery with an ordinary structured403 list response.
- **Recommendation:** preserve safe status/code metadata while replacing the display sentence. Distinguish unauthenticated, access denied, not found, rate-limited and transient failure. Offer Back/contact-admin/approved access-request affordances as appropriate; do not suggest disabling authorization or expose hidden resource data.
- **Acceptance:** custom wording remains safe;403 is accurately described and does not present futile Retry as the only action;500 still retries;429 respects Retry-After.

#### UIS-09 — edit dialogs have no shared dirty/pending-dismiss contract

- **Evidence:** kit Modal always invokes onClose on Escape/backdrop (`ui/kit.tsx:1326–1334`) and knows nothing about draft or pending save. `views/admin/integrations/IntegrationEditDialogs.tsx:47–51` passes unconditional onClose and leaves Cancel enabled while Save is busy. By contrast, `views/admin/PatchFormModal.tsx:49–55` already refuses dismissal and disables Cancel while busy. Neither primitive offers dirty-draft preservation/confirmation.
- **User impact/reason:** Escape/backdrop can silently discard substantial edits. In the integration dialog, Cancel can close the UI while an already-started save/step-up continues, so the eventual configuration outcome is unclear. Blanket confirmation on every close would create unnecessary friction; the missing distinction between pristine, dirty and pending is the problem.
- **F5 × S4 =20. Confidence:** high for the code paths; verify pending/save timing through browser with delayed response before treating Cancel as cancellation.
- **Reproduce:** edit MCP name/URL, dismiss backdrop and reopen; delay Save, press Cancel and observe whether the request still applies.
- **Recommendation:** define a shared optional dirty/pending dismissal contract. Pristine/read-only dialogs should close immediately; dirty forms should preserve a draft or ask once; pending writes should explain status and use explicit supported cancellation semantics. Reuse PatchFormModal's current busy guard rather than duplicate page-specific rules. Never imply a client abort reverses a server commit.
- **Acceptance:** no silent draft loss; pending writes have a truthful result/recovery path; simple dialogs gain no unnecessary prompts; step-up and server authorization remain unchanged.

### Existing strengths to preserve

- Native kit Modal already uses the browser top layer, traps boundary Tab presses and returns focus without repeatedly resetting it during edits.
- DetailDrawer deliberately distinguishes desktop non-modal side panel from mobile modal and defers mode changes while a nested modal is open.
- Field's normal labels/help controls are correctly separated, and Buttons/Switches support focusable busy states.
- Table preserves last successful data and visibly reports a failed refetch; this should remain when improving placeholder states.
- DataList performs server-side filtering/sort/export, warns when export is truncated and keeps status/warning columns mandatory.
- Error toasts persist until dismissed; RefusalNotice keeps recovery links inline rather than in expiring notifications.
- Tabs have roving focus and optional TabPanel preserves drafts across tab switches; route error boundaries retain the signed-in shell.

### Coverage and limits

**Inspected source functions/sections:**

- `App.tsx`: Protected/ApplicationRoutes boundaries and route lazy loader; no claim to inspect each page's implementation.
- `shell/AppShell.tsx`: readPinned/writePinned, rail expansion/hover/focus, shortcut listeners, suite/filter/nav-entry derivation, user menu keyboard behavior, topbar actions, shell content and PageHeader heading/breadcrumb sections.
- `shell/CommandPalette.tsx`: quiet/useEntityItems, PaletteDialog search/selection/keyboard/focus, custom modal markup.
- `shell/RouteError.tsx`: isChunkLoadError, RouteErrorPanel, ShellRouteBoundary/RootRouteError.
- `ui/kit.tsx`: Button/Switch/Field/Fieldset/Input/Select/Textarea; InfoButton; Card containment/fold interactions; Table sort/loading/error/empty/clickable rows; tabTrap/returnFocus/Modal/ConfirmModal; Tabs/TabPanel; ErrorState/RecordError; IdChip and status primitives (selected sections, not every chart/bar renderer).
- `ui/DataList.tsx`: IconButton, ColumnPicker, DataList state/reset/paging/cursors/infinite rows/sort/export/error/toolbar.
- `ui/listState.ts`: storage preferences, column resolution/toggling/movement and page-size constants; selected URL/paging helpers.
- `ui/DetailDrawer.tsx`: overlay store, DrawerActions, subject focus/opener capture, mode-switch deferral, desktop reflow and Escape handling.
- `ui/ExpandableTable.tsx`: expansion focus and collapse behavior, selected row/render sections.
- `ui/CardBoundary.tsx`, `ui/toast.tsx`, `ui/RefusalNotice.tsx`, `ui/focus.ts`, `ui/useTheme.ts`, `theme/mode.ts`: entire small components/helpers.
- Contextual consumers: selected RunsPage, RolesPage, UsersPage, McpServersPage/PrivateRangesCell, McpIdentityPropagation, McpServerAdmission, IntegrationEditDialogs/EditServerDialog, PatchFormModal; error-Field consumers enumerated by rg. These consumer pages were not exhaustively reviewed by this subtask.

**Existing tests cross-read, not run:** kit.test.tsx, DataList.test.tsx and enterprise keyboard/a11y harness definitions. Current DataList tests chiefly exercise SSR markup; they do not prove delayed-query restoration or browser navigation behavior. Enterprise error-state route scans do not substitute for populated-table and nested-dialog tests.

**Not completed here:** visual verification, screen-reader session, all viewport/theme combinations, server-backed role flows, every row-action consumer, every form's dirty-state semantics, all RefusalGuidance paths, full chart canvas accessibility, mobile assistive hardware, all page-specific functions. Findings above are traceable first-pass evidence, not a claim of exhaustive audit completion.

## Claude/Codex discussion ledger

Each row below is initially **reported**, not accepted, assigned or fixed. Claude should add its source-based response and counterevidence in the review PR or this file, then Codex folds the reasoned outcome into the card. A source disagreement stays visible. Fixing a shared primitive should link all affected cards; do not count one underlying fix as many unrelated releases.

| ID | Evidence at publication | Claude response / reason | Agreed disposition / fix / retest |
| --- | --- | --- | --- |
| CXR-ADM-001 | mock-browser + source | Awaiting response | Reported; no fix claimed |
| CXR-ADM-002 | source; see confidence/design qualification | Awaiting response | Reported; no fix claimed |
| CXR-ADM-003 | source; see confidence/design qualification | Awaiting response | Reported; no fix claimed |
| CXR-ADM-004 | source; see confidence/design qualification | Awaiting response | Reported; no fix claimed |
| CXR-ADM-005 | mock-browser + source | Awaiting response | Reported; no fix claimed |
| CXR-ADM-006 | source; see confidence/design qualification | Awaiting response | Reported; no fix claimed |
| CXR-ADM-007 | source; see confidence/design qualification | Awaiting response | Reported; no fix claimed |
| CXR-ADM-008 | source; see confidence/design qualification | Awaiting response | Reported; no fix claimed |
| CXR-ADM-009 | source; see confidence/design qualification | Awaiting response | Reported; no fix claimed |
| UIW-01 | mock-browser + source | Awaiting response | Reported; no fix claimed |
| UIW-02 | mock-browser + source | Awaiting response | Reported; no fix claimed |
| UIW-03 | source; see confidence/design qualification | Awaiting response | Reported; no fix claimed |
| UIW-04 | source; see confidence/design qualification | Awaiting response | Reported; no fix claimed |
| UIW-05 | source; see confidence/design qualification | Awaiting response | Reported; no fix claimed |
| UIW-06 | source; see confidence/design qualification | Awaiting response | Reported; no fix claimed |
| UIW-07 | source; see confidence/design qualification | Awaiting response | Reported; no fix claimed |
| UIW-08 | source; see confidence/design qualification | Awaiting response | Reported; no fix claimed |
| UIS-01 | mock-browser + source | Awaiting response | Reported; no fix claimed |
| UIS-02 | source; see confidence/design qualification | Awaiting response | Reported; no fix claimed |
| UIS-03 | mock-browser + source | Awaiting response | Reported; no fix claimed |
| UIS-04 | source; see confidence/design qualification | Awaiting response | Reported; no fix claimed |
| UIS-05 | source; see confidence/design qualification | Awaiting response | Reported; no fix claimed |
| UIS-06 | source; see confidence/design qualification | Awaiting response | Reported; no fix claimed |
| UIS-07 | source; see confidence/design qualification | Awaiting response | Reported; no fix claimed |
| UIS-08 | source; see confidence/design qualification | Awaiting response | Reported; no fix claimed |
| UIS-09 | source; see confidence/design qualification | Awaiting response | Reported; no fix claimed |

### Coverage — every page and function is a tracked goal, not a blanket completion claim

The [150-route ledger](evidence/2026-11-21/route-coverage.md) lists every screen's automatic checks and named deeper feedback. The detailed contributions above list exactly which files, sections and functions were inspected and what was not. A shared shell check is useful across pages, but it does not inspect each page's business behavior.

A compiler-AST [function inventory](evidence/2026-11-21/function-inventory.json) records **36,791 executable function-like nodes across 1,335 TS/JS files**, including callbacks. This is inventory only; it is not a claim that all 36,791 bodies were read or verified. Other languages are not counted. Use file/function/line to select bounded review batches and attach their evidence here; do not load the whole inventory as a substitute for code reasoning.

**Still requiring deeper work:** populated success/error/denied workflows for every role; forms and sub-tabs not covered in these source passes; exports, import recovery and undo semantics; screen-reader use; real IME input; all phone layouts; charts/canvas accessibility; permission changes mid-session; save/timeout/retry races; actual gateway/integration journeys; and Go/Python/other-language functions. Browser mock checks do not prove those properties. The next feedback iteration must close named coverage items and record actual observations, rather than repeat broad recommendations.


## Reassessment of the November 7 findings

The following checks use the current source head above. Tests mentioned as present were not rerun by the source assessors. Current status is separate from the original report's historical validity.

## Whole-build review security reassessment — 2026-11-21

Target: `9797d6f42798689d896103b9e9ce04278e01a4ad` (`origin/main`). Source report: `internal/reviews/2026-11-07-whole-build-review.md`, S-01 through S-10. Read-only source assessment; no test suite rerun, product change, security approval or external post.

The high-impact security diagnoses make sense for the November7 snapshot, but the report is substantially stale as a current vulnerability list. S-01's principal/runtime-login gap and S-02 through S-06 have specific implemented remedies. Three smaller observations persist. S-10 bundles distinct hardening choices and should not be read as four demonstrated exploits.

| ID | Historical reasoning | Current status and evidence | Recommendation assessment |
| --- | --- | --- | --- |
| S-01 | Sound: RLS policies do not protect requests that run unscoped or under a bypass-capable runtime role. The fraction of *all* tables is a poor independent coverage metric: deployment-wide and actor-stamped tables do not all require user-row filters. | Core defects addressed. `apps/gateway/src/app.ts:1566` installs resolved principal/system scopes. `packages/db/src/index.ts:456` applies scoped pool behavior; `packages/db/src/rls.ts:287` explains per-statement/transaction enforcement. `apps/gateway/src/boot.ts:184` checks runtime login. `apps/gateway/src/runtime-login.ts:178` refuses an unfit login unless the explicit development exception applies; deployment signals disallow that exception. ADR0234 has as-built batches7a/7b and later table work. There are now84 literal ENABLE-RLS statements across migrations, but that is not an audited current protected-table count. | Prioritizing runtime-role plus principal-context fixes was correct. Do not repeat “4 of338, none at runtime.” Do not infer every current table is protected: a fresh classified inventory is needed for that separate claim. |
| S-02 | Sound: relying on operator-supplied deployment flags to reject public default secrets is fail-open. Automatic bootstrap retirement and guarding other-user key minting address real authority paths. | Addressed by `apps/gateway/src/dev-secrets.ts:75` (HTTPS/deploy signals), `:138` (nonloopback exposure), `:151` (dev override cannot override deployment signal). `auth.ts:260` refuses retired bootstrap; `app.ts:2024` requires identity_manage for another user's key unless the explicit bootstrap-after-admin test/dev relaxation applies. | Correct direction. Existing deliberate development exceptions need clear boundaries; their mere existence is not proof that deployed defaults remain insecure. |
| S-03 | Sound: authenticated webhook delivery can still be replayed; effectful reprocessing requires an independent delivery/timestamp guard. | Addressed structurally. `apps/gateway/src/pm.ts:1287` removes the hash/static-header fallback and requires decryptable credentials. `:1353` records a delivery once with conflict refusal before effects. `packages/pm-provider/src/inbound.ts:124` checks signed timestamps; `:635` defines timestamp-bound generic HMAC and rejects legacy static header/body-only forms. Provider delivery-key/freshness logic is at `:770` and unsigned-provider age bounds at `:680`. | Do not require a provider timestamp signature a provider cannot supply; provider-specific delivery authentication plus dedup/age bounds must be evaluated on their actual contract. “No replay protection on any provider” is no longer true. |
| S-04 | Sound: granting access is a security relaxation even when the caller is an admin; an API-key compromise should not bypass fresh proof. | Addressed. `apps/gateway/src/step-up.ts:707` returns a value-bound settings_relax/grant_mint request. The eight original routes call it at `app.ts:2822,2857,2924,2946,2969,2990` and `agents-connectors.ts:3873,5576`. Role assignment paths are covered too (`app.ts:3107`). | Good recommendation. Reuse settings_relax rather than introducing a duplicate ceremony; that is what the current implementation does. |
| S-05 | Core concern sound: A2A must honor the execution posture/literacy gate. Lack of a direct import alone would not prove a bypass if a shared helper applied it transitively. | Addressed explicitly. `apps/gateway/src/a2a.ts:89` imports evaluateA2a; `:428-450` evaluates the kernel and calls governedEvaluateResource. This covers execution posture and shared restrictions before dispatch. | Correct integration goal. Validate actual call flow rather than using an import-name check as the test. Default-off mitigates exposure but does not excuse a missing gate once enabled. |
| S-06 | Sound: absent attribution should not silently bypass a mandatory project budget boundary. | Addressed. `packages/db/src/schema.ts:5182,5184` default connector/A2A attribution requirements true. `apps/gateway/src/governed-core.ts:240,266` loads them fail-closed when settings absent, and `:283-296` composes the mandate into the decision. A2A calls that core at `a2a.ts:450`; connectors import/use it from `connector-call.ts:62`. | Correct, with distinction between attributable calls and an explicitly audited policy relaxation. Null-return behavior of a lower-level project helper alone does not establish a bypass once its callers enforce attribution first. |
| S-07 | Ordering claim is valid, but availability severity was explicitly unmeasured in the original report. Body-size/rate bounds and expensive parser behavior affect actual DoS impact. | Still present for ordinary protected routes: principal authentication is `preHandler` (`app.ts:1328`); existing `onRequest` interception and rate hooks are not a universal authenticated-body gate. | Useful follow-up, especially raised-bodyLimit imports. Benchmark and regression-test route-specific early authentication. Do not move every auth operation globally without respecting login, webhook-signature and RLS setup semantics. |
| S-08 | Accurate parameter/event-loop observation. N=2^14,r=8,p=1 is below modern conservative recommendations; that does not by itself demonstrate a practical password compromise. Synchronous hashing can consume event-loop time. | Still present: `apps/gateway/src/auth.ts:458-465`, `verifyPassword` at `:474-497`. | Async KDF and benchmarked stronger parameters/rehash-on-login are sensible. A module migration is not required solely because a different library exists; node:crypto is a validated primitive. |
| S-09 | Accurate, limited claim: a fake bearer prefix buys the bearer-carrying *per-IP pre-auth* envelope, not authenticated access or a valid credential quota. | Still present: `apps/gateway/src/rate-limit.ts:237-251`, `:285`; apiKeyMax defaults6000 at`:111`. | Sensible low-severity abuse-hardening follow-up. Keep a common pre-auth IP ceiling and a higher verified post-auth tier, rather than claiming the API-key limit itself is bypassed. No load/DoS test was run here. |
| S-10 | Mixed hardening observations, not a coherent demonstrated vulnerability. Explicit caller checks matter. | `reporting.ts:577` still defaults missing isAdmin to true (latent while callers supply it). `security-headers.ts:93` intentionally keeps style unsafe-inline. UUID-validated raw ARRAY SQL still exists (`compliance-packs.ts:179`, `copilot.ts:441`), so this is not demonstrated injection. `shared/chatops.ts:158` still reports no signature replay window for Teams; however approval interactions already check idempotency at `apps/gateway/src/chatops.ts:1721`, and Teams messages have freshness plus activity-id dedup at`:1910`. | Require explicit isAdmin and parameterized SQL as hygiene. Do not present unsafe-inline styles as an XSS exploit without an injection path. The blanket “deduplicate Teams activity IDs” recommendation misses existing guards; separate message freshness from delayed-first interaction replay and establish a concrete path before a vulnerability claim. |

Important limits: no deployment was exercised, no runtime database role census was performed, and none of these statuses is a blanket security sign-off. “Addressed” means the original missing control is now implemented in the inspected current call flow, not that every adversarial case has been retested.

### Security controls and product friction

Keep secure defaults and make legitimate tuning precise, rather than adding a global “disable security” control. Existing policies already distinguish behavior that can be tuned (guardrail modes, rate/budget thresholds, attribution settings) from proofs that make an identity or payload trustworthy.

- Prefer per-project/resource/environment policy choices with a visible explanation of what is blocked, why, and the smallest permitted change. Show measured limit usage and the exact next action; avoid turning unknown enforcement state into a green status.
- A permitted relaxation should be admin-only, value-bound step-up, versioned and audited, with explicit scope and expiry where feasible. Honor any compliance floor and refuse a weaker override that would contradict it. Preview the effect before committing, using existing policy-preview mechanisms.
- Keep identity validation, object authorization, webhook signatures, anti-replay, secret confidentiality and transaction/receipt integrity mandatory. Product mode selections should not silently bypass these invariants.
- Treat developer/test exceptions as explicit environment-bound exceptions. The current published-secret and privileged-runtime-login opt-ins correctly distinguish development from a declared deployment; do not expose these as ordinary production UI switches.
- Authentication before a large import body and async password verification can reduce resource cost without weakening protection or adding user ceremony. These are higher-value friction/performance improvements than raising anonymous request limits.

These are recommendations for a future authorized design/build slice, not implemented configuration changes or an approval to relax any existing security control.

## Whole-build review reassessment: pillars and readiness

Target: main `9797d6f42798689d896103b9e9ce04278e01a4ad`, read with `git show`, rather than the older C3 checkout. Source report: `internal/reviews/2026-11-07-whole-build-review.md` (November7 snapshot `6a06dc1`). This is source inspection only: no suite, cloud resource, external API, live integration or deployment was exercised.

The report's concerns generally follow from the evidence it cites for its historical snapshot. It is unsuitable as a current open-defect list: several major implementation gaps have since been closed. Its recommendations require policy and authorization boundaries rather than literal implementation in every case.

| ID | Assessment at current main | Evidence and qualification |
| --- | --- | --- |
| P-01 | Substantially addressed; old categorical claim stale | `apps/gateway/src/governed-core.ts:184` loads resource ABAC, approval/rate rules and required attribution; `:333` describes model consent. Connector invokes use the shared resource core at `connector-call.ts:550`, A2A at `a2a.ts:450`. `internal/ARCHITECTURE.md:123` now expressly documents MCP's `governedEvaluate` and the model/connector/A2A restriction layer. One literal function for every different resource shape is unnecessary; consistent enforced semantics is the real requirement. This inspection is not a proof of every execution/caching branch. |
| P-02 | Addressed for named surfaces in the original finding | `plan-only.ts:308` adds the project-scoped gate; invokes/runs/compat call it, and `mcp-proxy.ts:1298` does too. The original omit-instance bypass is no longer the declared design. The broad proposal “any planning workflow blocks every project mutation” is a product policy with overblocking implications; current code has a documented engine-instance exception. New surfaces still need a coverage inventory rather than assuming a helper protects every route automatically. |
| P-03 | “BYOC is compose only” is stale; real-cloud proof still unverified | `infra/modules/byoc-aws/`, `infra/environments/byoc-aws/`, `deploy/helm/regulait/`, `deploy/operator/` and `docs/deployment/BYOC_AWS_INSTALL.md` now exist. The Helm chart documents multi-replica support and protected signed migration hooks. Infra adapters intentionally remain off unless explicitly live-enabled and wired (`packages/infra-provider/src/index.ts:410`). Packaging is not proof of a successful customer-cloud rehearsal. An unauthorized live sandbox run is not a permissible shortcut to validating this recommendation. |
| P-04 | Mixed: importer claim fixed, live-proof and semantics need qualification | ADR-0289's importer is implemented at `pm-import.ts:336` with preview digest, bounded listing and transactional apply. It deliberately retains linkage instead of copying provider-owned descriptions/priority, and `/v1/pm/links?live=true` reads authoritative fields through at `pm.ts:1615`. Inbound fields still enter event payload at `pm.ts:1110`; state drift handling does not blindly mutate the internal state machine. “Adopt inbound fields” must not become an unreviewed overwrite of approved requirements or duplicate source of truth. Tests against real tenants remain unverified here. |
| P-05 | Still supported by current source | `orchestration.ts:2800` iterates the ready wave, then awaits `dispatchRunNode` before proceeding to the next member (`:2840`). Deferring submissions until the end makes recorded lifecycle states overlap, but provider execution remains serial in this path. The recommended bounded concurrency is reasonable only while preserving atomic estimates, measured-budget gates, cancellation and deterministic state transitions. |
| P-06 | Real presentation/accounting issue, but “counted as realised” overstates literal API labels | `orchestration.ts:2737` explicitly says batching is estimate-only and not performed; `:2778` nevertheless writes its hypothetical token reduction into the common savings ledger. The aggregate at `optimization.ts:70` includes all techniques. However `SpendPage.tsx:337` and `:343` explicitly separate measured routing actuals from estimated all-technique savings. Label this “unperformed opportunity mixed with estimates of applied techniques”, not fabricated measured spend. Separating opportunity from applied savings is sensible. |
| P-07 | Still supported in this inspection | Compat code applies routing and exact-match semantic caching (`compat-core.ts:1035`), but does not invoke the native conversation-compaction/dedup pipeline. Native compaction is in `agents-connectors.ts:4677` under its conversation-invoke branch, not in generic `executeGovernedDispatch`. Apply missing optimizations only where their semantics fit provider-shaped conversations, or document the narrower coverage. |
| P-08 | Still supported in this inspection | `projectContextItems` retrieval appears in orchestration (`orchestration.ts:535`), not ordinary invokes or compat. Blindly injecting every project item is not a safe fix: preserve provenance, membership, context approval, prompt-injection and token-budget boundaries; project attribution alone does not make arbitrary retained text trusted instructions. |
| P-09 | Documentation drift still demonstrable; live-provider assertion unverified | `packages/workflow-kernel/src/index.ts:10` still says deployment/rollback are rejected although they are executable. `internal/product/PENDING.md:81` still says no LLM provider is connected despite later additions. The existence of `docs/deployment/LIVE_TESTS.md` and gated live harness does not prove which providers actually passed. Current test status and tenant evidence must be requested, not inferred. |

### Product-readiness conclusions

1. **Deployment:** the report's absence-of-packaging and HA statements are outdated. AWS Terraform, Helm/operator and multi-replica/failover paths are implemented. That does not establish a production-grade deployment, and the owner's production sign-off remains a release boundary, not an implementation defect.
2. **The three security-default blockers:** another assessment covers S-01/S-02/S-03; do not carry the old summary forward without checking those fixes.
3. **Governance:** P-01/P-02 implementations now contradict the report's categorical old claims. This requires a current path/coverage audit, rather than repeating that only MCP is governed.
4. **Integration lifecycle:** now has server/connector enable and delete routes (`integration-lifecycle.ts:123,164,216,258`), connector credentials (`agents-connectors.ts:5422`), and PM webhook-secret rotation (`pm.ts:695`). The report's categorical absence claim is stale; implementation presence is not exhaustive end-to-end revocation proof.
5. **Release keys:** still a genuine operational prerequisite. `infra/release-keys/README.md:20` lists only the dev key and explains no retained private half; the November15 ADR-0324 ceremony tooling is prepared, and `PENDING.md:96` still requires the owner to execute it. Never solve this by putting a private key in the public repo.
6. **Live integration proof:** still unverified in this reassessment. Manual/credential-gated tests exist; empty-credential skips cannot establish live success. Request actual successful run evidence before claiming validation.
7. **Buyer docs:** mixed. `ARCHITECTURE.md` has corrected governance coverage and deployment guides exist, while PENDING/ROADMAP still contain contradictory old rows. “There is no admin guide” was not independently established here; a deployment guide alone does not prove an adequate role-based administration guide.

No product change, external post, formal review verdict or release/merge action was made.

## Whole-build report: engineering/OSS reassessment

Target: main `9797d6f42798689d896103b9e9ce04278e01a4ad`. Original: `internal/reviews/2026-11-07-whole-build-review.md` at `6a06dc1`. Read-only source/history inspection; no build or test suite executed. Current checkout was not used as the target. Historical count claims are not treated as current measurements.

| ID | Assessment | Current evidence and qualification |
|---|---|---|
| C-01 | Valid; largely still open | `apps/web/package.json:16` still has neither shared nor api-client dependency. Handwritten `api/types.ts` and `api/adminTypes.ts` are now 1,296 and 975 lines. Reusing a browser-safe contract makes sense. OpenAPI generation alone is insufficient unless its schemas cover the internal APIs used by the web app; public-only SDK generation cannot magically type them. |
| C-02 | Valid maintenance concern; counts stale | Current schema.ts 20,185 lines, app.ts 7,029, shared/index.ts 5,147. Gateway import baseline still has 74 data edges (`scripts/import-cycles-gateway.baseline.txt`). Domain extraction and ratcheting help, but size is a risk indicator rather than proof of a functional/security defect. Do scoped refactoring with behavior parity, not a wholesale layer rewrite for its own sake. |
| C-03 | Main guard failures addressed; parity caveat remains unverified | `scripts/migration-watermark-guard.mjs:47–80` compares all merged journal fields, freezes merged SQL hashes, and enforces SQL/journal 1:1. Lines83–112 validate pending files and exact assign-at-merge output. `packages/db/package.json:17` no longer exposes generate. Missing historical numbers do not themselves imply missing/unapplied migrations; monotonic journal and byte invariants matter. A schema-introspection parity check remains a separate concern, not proven absent by this assessment. |
| C-04 | Historical hot spot valid; prescribed fix superseded | Tests no longer pin MACHINE_ONLY/SUPERSEDED/INDIRECT sizes. More importantly, owner Nov19 removed the hand-maintained max-gap ceiling too; `scripts/preflight-ui-route-census.test.mjs:340–365` explicitly tests fragment counting and rejection of undocumented no-UI routes. Restoring report's `KNOWN_UI_GAPS_MAX=0` would contradict the later approved design and break approved API-only lanes. Preserve per-entry ownership/tracking and stale/no-UI checks. |
| C-05 | Isolation concern valid; placeholder assertion claim is false | The cited `scripts/preflight-egress-allow-cleanup.test.mjs:88` is **inside a source-string fixture**, both at original6a06dc1 and current main. The actual test assertion at92 checks that the scanner detects missing cleanup. Do not replace that fixture as a bogus passing test. Serial files do not prove singleton isolation, so shared fixtures/scratch databases still make sense. `zz-` names are not a gateway ordering guarantee. |
| C-06 | Mostly still open; some wording/recommendation needs care | `garak-real.test.ts:36,72` is opt-in, and no `.github` file references its controlling REGULAIT_GARAK_PYTHON variable. `zz-adr0188-s5-token-endpoint.test.ts:1032` still uses150ms deadline versus600ms delayed commit. This establishes coverage/timing sensitivity, not a measured current flake rate. Fake timers across real HTTP/DB I/O can change the property under test; injected deterministic barriers/deadlines may be safer. The #605 rescan point was explicitly unverified in this report. |
| C-07 | Unchecked is supported; dead/deletion is not established | Web tsconfig includes src and vite.config.ts, not review. There are138 files across apps/web/review and spikes today. These are research/probe artifacts outside runtime compilation, not necessarily dead product code. Archive or add an explicit check only after checking actual use; deletion requires owner approval. |
| O-01 | Valid and partially still open; original counts and pin wording need update | Exact-name scan of current dependency manifests versus THIRD_PARTY text finds18 gateway names absent (AWS/Azure/Google cloud SDKs, @fastify/rate-limit, node-saml) and web @tanstack/react-query/react-dom absent. This is a textual spot check, not an SPDX/parser-complete audit. Some originally missing rows (e.g. zod/Ajv) were added. No dedicated manifest-to-THIRD_PARTY completeness preflight was found. The db doc's phrase exact devDependency versus manifest caret is misleading, but frozen pnpm-lock exact resolution is a valid pin; a caret alone is not evidence builds float. |
| O-02 | Replacement debt remains; one factual premise now false | `ADR-0176:226–228` still lists all three open; retry engine remains handwritten, `shared/tracing.ts:836` builds trace OTLP JSON manually, scheduler.ts still owns leases and says it is not a distributed queue. But current gateway manifest **does contain** @opentelemetry/otlp-transformer0.223.0 and pg-boss12.38.2. They serve metrics-otlp.ts and workflows-queue.ts, respectively; their presence does not mean trace encoding/scheduler migration is done. No cockatiel manifest entry found. Reassess fit and retain retry/governance/lease semantics rather than assuming mere installation completes replacement. |
| O-03 | Valid duplication; partly improved; replacement must preserve formats | Shared onboarding.ts:610 and reporting.ts:737 still implement separate parsers. Shared billing.ts:494–501 still writes CSV manually (the report's gateway billing path is stale/wrong for that writer). config-versions.ts:987 still has stableStringify. Several cited gateway copies are no longer present. Reuse csv-parse/stringify where compatible; do not blindly replace persisted evidence/hash serialization with JCS—prove byte compatibility or version/migrate the format. |
| O-04 | Valid, still open, concrete behavioral mismatch | `shared/evals.ts:589–642` checks only a subset: type/enum/min/max/length/required/properties/items. It ignores pattern, additionalProperties, minItems and composition/$ref. `playground.ts:93–121` compiles with full Ajv and RE2 regex engine. A string violating a schema's pattern can pass evals and fail playground. A common validated dialect/compiler is the right direction, with safe regex and schema complexity bounds retained. |
| O-05 | Sound documentation conflict; not proof of illegal shipment | ADR0176 still has no GCC-runtime/libquadmath carve-out; ADR0187:1285–1287 and2531 explicitly record the owner's accepted runtime exceptions. Clarify policy precedence/exception scope rather than treating Boost BSL1.0 as Business Source License or declaring the whole distribution noncompliant. This assessment is not legal advice or a fresh licence admission. |

Most useful still-current engineering actions: unify JSON Schema validation (O04); close third-party inventory coverage (O01); scope the three known replacement debts (O02); reduce contract duplication (C01). Remove already-fixed migration/census work from the current backlog. Correct C05's fixture false positive before using report totals.

### Process findings R-01 through R-08

| ID | Current assessment and reason | Recommended disposition |
| --- | --- | --- |
| R-01 | The identity/provenance concern is valid. Current protocol still uses SHA-bound prose verdicts; `scripts/master/merge-loop.sh:8–18,65–84` additionally checks an explicit released SHA, draft/hold state, mergeability and completed checks. That improves release control but is not an independently authenticated native GitHub approval. | Keep separate reviewer identities and enforceable native reviews as a process proposal. Do not call every current release unreviewed merely because the review is a comment. App/account configuration is an owner/master action. |
| R-02 | The old #605 miss is historical, not an open code defect today. #605 merged November 14; `mcp-admission-rescan.ts:284` excludes disabled servers and a regression checks the filter. REVIEW_CHECKLISTS §6 preserves finding numbers and fixing commits. | Retain the lesson and test. Do not reopen the one-line fix. |
| R-03 | Pending migrations and merge-time assignment now exist (ADR-0252, CONTRIBUTING_PARALLEL_SESSIONS §4.1 and `assign-at-merge.mjs`). Branches leave the numbered journal alone. The November 20 STATE snapshot still reports an unmerged assignment/fragment-fold backlog while the merge queue awaits an owner decision. | Separate implemented branch-conflict prevention from the still-unfinished operational queue/fold process. Verify account support, required merge-group checks and rollback before enabling a queue; do not treat it as a one-click fix. |
| R-04 | The deleted assertion incident is recorded as M-111. The recommendation to count assertions is a weak proxy: trivial or duplicate assertions can raise a count without protecting behavior. A blanket ban on scripts would also forbid safe structured tooling. | Review guard behavior and add targeted regression/mutation checks. Prefer syntax-aware conflict handling, explicit diffs and tests; do not gate quality on assertion totals. |
| R-05 | Small coherent PRs and keeping their declared surface accurate remain sensible. A cross-cutting dependency should normally land separately and reach dependents through main; a large diff alone does not prove unrelated work. | Apply scope review to the actual goal and acceptance list. Our standing instructions still prohibit Codex from changing another PR's title, draft state or hold. |
| R-06 | Combined-tree regression is a real integration risk. The original 55-byte breach was explicitly unverified in the report and was not reproduced here. Current workflows support merge-group/full checks; current per-route budgets also change the old all-JS constraint. | Test the final combined tree, retain the entry budget and validate actual queue support/configuration. Do not report the old byte count as today's build result. |
| R-07 | Partly addressed. STATE has a November 20 snapshot; fragments, `fold-docs.mjs`, generated-index checks and hand-over files now exist. The top PENDING status still says August 3 and the session pointer remains October 25. M-110 through M-112 now explicitly record the three previously missing mistakes. | Keep improving the fold/hand-over process and truthful metadata. Do not repeat that the mistake ledger still stops at M-108, or manually edit protected ledgers from this review lane. |
| R-08 | Queue pressure and overcentralized decisions remain useful operational concerns; historical counts are not current telemetry. PR status now lives on PRs, there are multiple reviewer pairs and orchestration hand-over files. The owner suspended the global worker cap on November 20. | Measure queue age, review latency and rework before selecting a cap/batch policy. Preserve this lane's five-open-PR limit; do not reinstate a global cap contrary to the newer owner decision. |

## Coverage interpretation

See the deep-audit ledger above. Automatic mock-admin checks do not establish member permissions, successful saves, real integrations or task completion; source inspection and targeted workflow reproductions are recorded separately.

## Historical baseline — 2026-11-07

This section is retained as the original dated evidence and recommendations. Its source counts, findings and “next actions” must be read with the current reassessment above; they are not instructions to undo newer owner decisions or repeat completed work.

### Whole-build review: `main` at 6a06dc1 (2026-11-07)

**Scope.** This is an independent review of the whole product as it stands on `main` at merge commit 6a06dc1 (PR #628). It is not a PR review. The reviewer reports and does not fix. The review changed no code, made no comments on other PRs, and wrote nothing to any cloud account.

**Method.**
- Four parallel read-only passes:
  - pillar fit;
  - the ADR-0200 security checklist;
  - code health, migrations and the open-source-first rule;
  - process and product readiness.
- Then an adversarial pass: one skeptic per top-eight finding cluster, each told to refute the finding against the code. Where a skeptic corrected a claim, the corrected wording is used below.
- History counts cover 2026-10-17 to 11-07, from a deepened clone.
- No test suite was run.
- **UNVERIFIED** marks any claim not re-read in code at 6a06dc1.

**Not a compliance statement.** Nothing here is a claim of compliance or certification against any standard.

---

#### Executive summary

1. **The build is broad, and in places it is narrower than the docs say.**
   - Every pillar has routes, tables, UI and tests.
   - Pillars 2 (workflow), 4 (shared context), 5 (cost) and 7 (orchestration) are substantially built.
   - Pillars 1, 3, 6 and 8 are partial against what CLAUDE.md claims (P-01 to P-04).
2. **Governance is uniform only for MCP calls.**
   - Approval rules, kernel rate limits and Cedar ABAC reach MCP tool calls only.
   - Model calls get allow or deny, and model rate limits are off by default.
   - Connectors have no governance rate limit.
   - A2A calls never call the policy kernel.
   - ARCHITECTURE.md's "one decision core" diagram is inaccurate for model, connector and A2A calls (P-01, S-05).
3. **The "forced" plan-only gate is opt-in.**
   - An invoke that omits `instanceId` runs `execute` while its project's instance is in planning.
   - A test pins this behaviour.
   - IDE (compat) and MCP calls never meet the gate (P-02).
4. **RLS covers 4 of 338 tables and is enforced on none at runtime.**
   - The gateway never calls `withPrincipal`.
   - The shipped login is a superuser.
   - No boot check refuses a superuser login.
   - CLAUDE.md treats this as a blocking bug (S-01).
5. **The published dev secrets are accepted on the public compose profiles.**
   - The refusal signal (`REGULAIT_HSTS`) is never forwarded to the gateway container.
   - So `tls`, `hosted` and `tunnel` boot with a known full-admin bootstrap token and a known data key (S-02).
6. **PM inbound webhooks have no replay protection on any provider.**
   - No timestamp window and no delivery-id dedup.
   - Jira and monday rely on static URL tokens.
   - The generic adapter accepts a static header (S-03).
7. **Process cost is now the main drag on throughput.**
   - Over 3 weeks: 699 merge commits against 885 content commits.
   - The migration journal took 115 commits and 37 recorded conflicts, with 20 renumber commits.
   - A review finding on #605 was missed across three rounds because findings have no tracked state (R-01 to R-03).
8. **Open source first is behind its own deadline.**
   - Three ADR-0176 "Replace" items are still open after 11-03.
   - `apps/gateway/THIRD_PARTY.md` lacks rows for 25 production deps; `apps/web` lacks 3.
   - No check compares the rows to `package.json` (O-01, O-02).
9. **Code health is acceptable but concentrated.**
   - `schema.ts` (15,630 lines) and `app.ts` (6,445 lines, 72 routes, no service layer) are the churn hot spots.
   - The web app hand-copies about 2,150 lines of gateway types (C-01, C-02).
   - Tests do check behaviour: real routes and DB, no snapshots.
10. **For an enterprise pilot**, the top blockers, in order:
    - no production-grade or BYOC deployment path;
    - the three security defaults above;
    - governance coverage beyond MCP;
    - integration lifecycle (disable, rotate);
    - release signing.

---

#### Findings

Severity follows the CLAUDE.md convention: a confirmed security-checklist gap is a blocking bug under ADR-0180.

##### Security (ADR-0200 checklist and ADR-0180 secure by default)

| ID | Sev | Finding | Evidence | Recommended action |
|---|---|---|---|---|
| S-01 | **high** | **RLS covers 4 of 338 tables and is enforced on none at runtime.**<br>• Only migration 0272 enables RLS, with ENABLE + FORCE and policies on users, auth_mfa_pending, approvals and audit_log.<br>• ADR-0234 is still Proposed, and batches 2–7 are not built.<br>• Non-test gateway code never calls `withPrincipal` or `withSystemContext`.<br>• One `pg.Pool` built from `DATABASE_URL` serves both migrations and requests. The shipped login is the image superuser, which bypasses FORCE.<br>• No boot check refuses a `rolsuper` or `rolbypassrls` login. | `packages/db/migrations/0272_rls_foundation_slice1.sql:134,136,169,171,192,194,308,310` (ENABLE/FORCE)<br>`internal/decisions/0234-postgres-row-level-security.md:3,13-15,190-196`<br>`packages/db/src/rls.ts:19-21,120-160`<br>`apps/gateway/src/main.ts:11-38`<br>`packages/db/src/index.ts:347-357`<br>`docker-compose.yml:116,341`<br>`scripts/install.sh:916`<br>`boot.ts`: no role check | Do batch 7 (a non-owner runtime login and a boot refusal of superuser or BYPASSRLS) together with batch 2 (wrap request handling in `withPrincipal`) as the next security batch. Then roll out table batches in order: user-owned, then credentials, then project. Track every remaining batch as a blocking bug. Update the ADR-0234 inventory: it says 329 tables, and there are now 338. |
| S-02 | **high** | **Published dev secrets are accepted unless the operator sets a deploy signal, and the public profiles never set one.**<br>• `assessDevSecrets` refuses the published bootstrap token or data key only when `REGULAIT_DEPLOY_MODE` or `REGULAIT_HSTS` is set.<br>• Compose falls back to the published values, and `DEPLOY_MODE` defaults to empty.<br>• The base compose never forwards `REGULAIT_HSTS` to the gateway (only install.sh's override adds it), so `--profile tls`, `hosted` and `tunnel` boot with both published values.<br>• The bootstrap credential is a full admin with no expiry. It skips MFA and the IP envelope, and keeps working after a real admin exists.<br>• Step-up actions are refused once an admin has a step-up method, but the bootstrap credential can still mint an API key for any user, including a TOTP-enrolled admin, without step-up.<br>• Mitigation: the no-profile stack publishes the gateway on loopback only. | `apps/gateway/src/dev-secrets.ts:35-36,60-66,97-103`<br>`apps/gateway/src/boot.ts:197-205,430-441`<br>`docker-compose.yml:351-352,411`<br>`apps/gateway/src/auth.ts:248-249`<br>contrast `metrics.ts:420-447` (strict refusal) | Refuse published values unless the bind is loopback or an explicit dev opt-in is set. Treat an `https` non-loopback `REGULAIT_PUBLIC_URL` as a deploy signal. Forward `REGULAIT_HSTS` in the base compose. Retire the bootstrap credential automatically once an active admin exists. Make API-key minting for another user a step-up action. |
| S-03 | **high** | **PM inbound webhooks have no replay protection on any provider path.**<br>• No parser checks a timestamp. `pm_sync_events` is a plain append with no unique key, so a replayed delivery is fully re-processed: it can re-orphan links, re-flag drift and re-trigger `prefer_regulait` pushes.<br>• Jira and monday authenticate with a static `?token=`. Azure DevOps uses a static basic-auth password and ignores the username.<br>• The generic adapter falls back to a static `x-regulait-webhook-secret` when no signature header is sent.<br>• `pm.ts` falls back to a legacy hash compare whenever `dataKey` is unset.<br>• Even the HMAC paths (Linear, Asana) sign only the body.<br>• No ADR records an exception. Contrast: Slack ChatOps enforces 300 s. | `packages/pm-provider/src/inbound.ts:72-93,160-161,240,328,395-396,501-511,596-610`<br>`apps/gateway/src/pm.ts:862-872,1060-1073`<br>contrast `packages/shared/src/chatops.ts` (Slack window) | Add a `pm_webhook_deliveries` table with a unique key on (integration, delivery id), or on a body hash where the provider gives no id. Enforce Linear's signed timestamp within a window. Remove the generic static-header path and the legacy hash fallback: ADR-0180 forbids grandfathering. Document URL-token rotation for Jira and monday. |
| S-04 | medium | **Grant-minting routes have no step-up, while smaller relaxations do.**<br>• Eight routes widen default-deny with only the SoD check and `admin_only`: person and role grants of tools, servers, agents and connectors.<br>• Adding an egress host, lifting a revocation and replacing a workload-identity grant set do need step-up.<br>• Admin API keys can never step up, so a leaked admin key can widen anyone's access. | `apps/gateway/src/app.ts:2581,2612,2675,2696,2718,2737`<br>`apps/gateway/src/agents-connectors.ts:3757,5327`<br>contrast `custom-providers.ts:309-361`, `app.ts:3120,3184,3236`, `workload-identity-admin.ts:649`, `step-up.ts:35-38` | Add a `grant_mint` step-up kind, or reuse `settings_relax`, on all eight routes. The DELETE routes correctly need none. |
| S-05 | medium | **A2A calls bypass the policy kernel entirely.** `a2a.ts` imports nothing from `policy-kernel`, so the kill switch (`executionGate`), the read-only and halted modes and the AI-literacy gate do not apply. Mitigation: `a2aEnabled` is off by default. | `apps/gateway/src/a2a.ts` (no kernel import)<br>`packages/policy-kernel/src/index.ts:1541-1546` (gate on other paths) | Route A2A through the same kernel evaluation, or at minimum through `executionGate`, before A2A can be switched on in any pilot. |
| S-06 | medium | **Connector and A2A calls with no project run unattributed and skip the budget gate.** This is a loose default under ADR-0180. MCP and compat each require attribution by default; agent dispatch has `dispatchAttributionRequired`; connector and A2A have neither. | `apps/gateway/src/connector-call.ts:365,406`<br>`apps/gateway/src/projects.ts:796` (`preDispatchProjectGate` returns ok on a null project)<br>`use-case-gate.ts:111-119` (called only from `agents-connectors.ts:1530`)<br>`a2a.ts:307` | Extend the attribution mandate to connector and A2A calls, default on. |
| S-07 | medium | **Authentication runs after body parsing.** The auth hook is a `preHandler`, so unauthenticated callers get bodies of up to about 11 MiB parsed on raised-`bodyLimit` routes. Only the supplier upload checks the credential first. CPU cost was not measured (UNVERIFIED). | `apps/gateway/src/app.ts:1178`<br>`bom-routes.ts:376`, `decision-receipts.ts:387`, `cost-import.ts:383`, `endpoint-import-routes.ts:149`, `shadow-ai.ts:667`<br>contrast `supplier-portal.ts:1108-1118` | Add an `onRequest` credential pre-check, at least on every route with a raised `bodyLimit`. |
| S-08 | low | Password hashing uses scrypt N=2^14, r=8 (16 MiB), below the commonly cited N≥2^17. `scryptSync` blocks the event loop on every login. | `apps/gateway/src/auth.ts:445-448,452,468,484` | Raise the parameters with rehash-on-login, or move to a maintained Argon2id module. Use async scrypt. |
| S-09 | low | Any `Authorization: Bearer x` header moves pre-auth traffic from the 1,200/min tier to the 6,000/min tier per IP. | `apps/gateway/src/rate-limit.ts:237-251,285` | Apply the higher tier only after the credential has been verified. |
| S-10 | low | Hardening items:<br>• `isAdmin = opts.isAdmin ?? true` (latent, since both callers pass it);<br>• CSP keeps `style-src 'unsafe-inline'`;<br>• the Teams interaction path has `replayWindowEnforced: false`;<br>• `sql.raw` builds `ARRAY[...]` literals, safe today only because of `assertUuid`. | `reporting.ts:575`<br>`security-headers.ts` (`documentCsp`)<br>`packages/shared/src/chatops.ts:155-158`<br>`reporting.ts:257`, `compliance-packs.ts:169`, `copilot.ts:439` | Make `isAdmin` required. Use style hashes or nonces. Deduplicate Teams activity IDs. Use `inArray` or `= ANY($1)`. |

**What's solid.**
- Route authorization is default-deny from one source (`route-classes.ts`). A scan of 156 non-admin parameterised routes found no missing object-level check.
- MFA is required for admins, step-up is strict by default, and CSRF requires both SameSite=Strict and a custom header.
- The DNS-pinned guarded fetch covers about 23 outbound sites, with no stray raw fetch to user-supplied URLs found.
- `jose` pins the JWT algorithm and audience.
- The web app keeps no tokens in browser storage, ships no source maps and has no `dangerouslySetInnerHTML`.
- Pino redacts sensitive fields.
- `pnpm audit --prod` reported 0 advisories across 576 production dependencies.

##### Pillar fit

| ID | Sev | Finding | Evidence | Recommended action |
|---|---|---|---|---|
| P-01 | **high** | **Pillar 1 is uniform only for MCP.**<br>• Kernel approval rules, rate limits and ABAC are fields on the tool `EvaluationInput` only.<br>• For agent and connector calls, ABAC is "never supplied on this path today", and the model decision is allow or deny only (the dial's `require_approval` maps to deny).<br>• Model rate limits exist but are off by default.<br>• Connectors have no governance rate limit, only the generic HTTP limiter, which does not cover in-process builder-tool calls.<br>• Connector writes get an approval hold only under the execution dial, with no approval rules.<br>• ARCHITECTURE.md:118-148 says all call types go through `governedEvaluate`. That function is called only from the MCP surfaces and the simulation and evaluate callers. | `packages/policy-kernel/src/index.ts:586-587,631,1503,1514-1519,1541-1546,1780`<br>`internal/ARCHITECTURE.md:61,118-148`<br>`apps/gateway/src/governed-evaluate.ts:283-305`<br>`schema.ts:1908-1933,4386`<br>ADR-0040 §7.1, ADR-0212 | Write an ADR that brings model, connector and A2A calls under one `governedEvaluate` core, covering approval rules, rate windows and ABAC per resource type. Until it lands, correct ARCHITECTURE.md and every buyer-facing claim of "approvals and rate limits on every call". |
| P-02 | **high** | **The plan-only gate is opt-in.**<br>• On `/v1/agents/:id/invoke` the gate runs only inside `if (body.instanceId)`.<br>• A regression test pins that `execute` with `dispatch:true` and no `instanceId` returns 200 while the instance is in planning.<br>• The compat shims hard-code `COMPAT_MODE = "execute"` and the MCP proxy has no instance join point, so both ignore planning entirely.<br>• `/v1/runs` follows the same opt-in pattern.<br>• ADR-0079 discloses this as a limit, but it conflicts with ADR-0180 and with the "forced Plan-only" pillar text. | `apps/gateway/src/agents-connectors.ts:4001-4016`<br>`apps/gateway/src/plan-only.ts:136-220`<br>`apps/gateway/src/plan-only.test.ts:305-320`<br>`apps/gateway/src/compat-core.ts:129`<br>`packages/shared/src/index.ts:1326-1339`<br>ADR-0079 (Honest limits) | Enforce at project level: refuse non-plan-safe modes on every surface while any instance of the target project or repo sits in a planning stage. Make instance attribution mandatory where a project has active instances. ADR-0079 line 168 is also out of date: conversation turns do pass the gate when they name an instance. |
| P-03 | medium | **In pillar 3, "BYOC" means one compose stack on the customer's host.**<br>• `infra/modules` holds nothing for deploying into a customer's own AWS, Azure or GCP account.<br>• The infra and deploy adapters answer 501 unless a live flag is set, and ROADMAP records them as never run against a real cloud.<br>• The compliance cascade and the air-gap egress posture are real and enforced. | `internal/ARCHITECTURE.md:228-236`<br>`packages/infra-provider/src/index.ts:410-472`<br>`apps/gateway/src/infra.ts:310-372`<br>`internal/product/ROADMAP.md:200-206`<br>`projects.ts:368-400`<br>`deploy-posture.ts:88-136` | Run one live sandbox check per cloud for the infra and deploy adapters. Add reference BYOC packaging (Terraform or Helm) to `infra/modules`. Disclose the difference in buyer docs until then. Whether packaging exists outside this repo is UNVERIFIED. |
| P-04 | medium | **Pillar 8 adapters are real HTTP clients, proven only against fake servers.**<br>• Covered: Azure DevOps, Jira, Linear, Asana, monday and a generic adapter.<br>• The ADR-0054 work-item importer is not built.<br>• Inbound description, priority and acceptance-criteria fields are only stored in the event payload. Only state changes and deletes affect RegulAIt, so the PM tool is not yet the source of truth that the pillar promises. | `packages/pm-provider/src/index.ts:330,453,584,746,873,1079`<br>`apps/gateway/src/pm.ts:862-872,912-1000`<br>`internal/product/PENDING.md` ("Blocked on a live instrument")<br>ADR-0054 | Do a live sandbox pass for Jira and Azure DevOps first. Build the importer and adopt inbound fields. |
| P-05 | medium | **Orchestration "parallel" waves run one after another.** Auto-advance awaits each wave node in turn, so pillar 7's "run independent subtasks in parallel" holds only in the recorded state. | `apps/gateway/src/orchestration.ts:2607-2614,2771-2820` | Dispatch each wave concurrently with a bound, using the existing atomic `chargeRunEstimate`, or state plainly that execution is sequential. |
| P-06 | medium | **Batching savings are estimates, but they are counted as realised.** Batching writes tokens-saved rows that the savings totals include, and the UI says batching "works on your behalf". | `orchestration.ts:2710-2760`<br>`optimization.ts:40-46`<br>`projects.ts:2586-2594`<br>`apps/web/.../SpendPage.tsx:561`, `OptimizationPage.tsx:119` | Exclude batching estimates from realised savings and show them as "opportunity". |
| P-07 | low | **Pillar 6 is thin on the IDE path.** Compat calls get only routing and the semantic cache, and the cache is off by default. | `apps/gateway/src/compat-core.ts:62,860`<br>`schema.ts:4148-4159,4175` | Apply compaction and dedup to compat calls, or document the gap. |
| P-08 | low | **Pillar 4: shared context reaches only orchestration run nodes.** Plain agent invokes and IDE calls never see it. | `apps/gateway/src/orchestration.ts:526-549` | Inject project context on governed invoke when a `projectId` is attributed. |
| P-09 | low | **Several docs contradict the code or each other.**<br>• The `workflow-kernel` header comment says deployment and rollback stages are rejected; they are supported.<br>• PENDING §1 says "No LLM provider is connected", against its own addendum.<br>• Only the Google model adapter has been checked live (August). | `packages/workflow-kernel/src/index.ts:10-13`<br>`internal/product/PENDING.md` §1 | Fix the comment and PENDING §1. Add live smoke checks for the other model providers. |

##### Architecture, code health, tests and migrations

| ID | Sev | Finding | Evidence | Recommended action |
|---|---|---|---|---|
| C-01 | medium | **The web app hand-copies the gateway contract.**<br>• `apps/web` depends on neither `@regulait/shared` nor `@regulait/api-client`.<br>• `api/types.ts` (1,199 lines) and `adminTypes.ts` (948 lines) are written by hand.<br>• "mirrors …" comments mark copied rules: `git grep mirrors -- apps/web/src` returns 62 lines across 47 files.<br>• About 36 tests read gateway source text to catch drift. | `apps/web/src/api/types.ts`, `adminTypes.ts`<br>e.g. `apps/web/src/api/step-up-refusal.test.ts:109` | Generate web types from the gateway OpenAPI (`openapi-client-gen.ts` already exists), or export a browser-safe slice of `shared`. |
| C-02 | medium | **A few god files take most of the churn.**<br>• `packages/db/src/schema.ts`: 15,630 lines, 256 commits.<br>• `apps/gateway/src/app.ts`: 6,445 lines, 72 routes, 57 direct DB calls, no service layer, 253 commits.<br>• `packages/shared/src/index.ts`: 4,869 lines, 213 exports, 239 commits.<br>• 18 non-test gateway files are over 2,000 lines.<br>• The gateway import-cycle baseline (74 edges) has not shrunk since 10-16. org-settings and mcp-proxy are each on 8 edges.<br>• Package boundaries are clean: no package cycles and no `@regulait/*/src` deep imports. | `wc -l`<br>`git log --oneline -- <file> \| wc -l`<br>`scripts/import-cycles-gateway.baseline.txt` | After the freeze, split `schema.ts` and `app.ts` by domain. This also removes most merge conflicts on them. Ratchet the cycle baseline down. |
| C-03 | medium | **The migration guard leaves gaps.**<br>• `migration-watermark-guard.mjs` reads only the journal and skips tags already on base. It cannot see edits to a merged migration's SQL, removal of a merged entry, or `idx` and breakpoint changes. It has no journal-to-`.sql` 1:1 check (both are 230 today).<br>• It does catch a broken `when` order and a renamed merged tag.<br>• 51 numbers are missing across 14 gaps.<br>• A `drizzle-kit generate` script is still exposed, against a stale `0000_snapshot.json`.<br>• No schema-to-SQL parity test was found (UNVERIFIED that none exists). | `scripts/migration-watermark-guard.mjs:13,18-29,39-40`<br>`scripts/migration-watermark-guard.test.mjs:18-20`<br>`.github/workflows/ci.yml:285-294`<br>`packages/db/package.json` (`generate`) | Extend the guard: merged entries and their `.sql` bytes are unchanged, and the file set equals the journal. Remove the `generate` script. Add a parity test (fresh migrate compared with schema introspection). See R-03 for the structural fix. |
| C-04 | medium | **The route-census test pins set sizes**: `MACHINE_ONLY` 46, `SUPERSEDED` 16, `INDIRECT_UI_CALLS` 55 and `KNOWN_UI_GAPS_MAX` 0. Every new route edits the same lines, so this is a merge hot spot rather than a flaky test: 27 commits in 3 weeks, 13 of them merges of main, and at least 7 conflicts on open PRs on the night of 11-06. | `scripts/preflight-ui-route-census.test.mjs:355-363` | Drop the three count pins (the owner approved dropping `INDIRECT`). The per-entry reason and stale-entry checks already enforce intent. Keep `KNOWN_UI_GAPS_MAX = 0`. |
| C-05 | low | **Test isolation has gaps.**<br>• The gateway suite runs files serially per CI shard, each shard on a fresh Postgres.<br>• The 177 `zz-` file prefixes do nothing for gateway order: vitest orders by size and cache, and CI by SHA-1 of path. The prefixes are a leftover of the Playwright rule M-018.<br>• Hidden cross-file state dependencies (for example on the `org_settings` singleton) are masked rather than prevented.<br>• 390 of 522 files repeat the migrate and `DATABASE_URL` bootstrap.<br>• There is one placeholder `expect(1).toBe(1)`. | `apps/gateway/vitest.config.ts:5-7`<br>`vitest.run-last.config.ts:6-14`<br>`ci.yml:352-362`<br>e.g. `zz-adr0180-assurance-foundation.test.ts:87`<br>`scripts/preflight-egress-allow-cleanup.test.mjs:88` | Use a shared bootstrap helper. Give files that touch singletons a scratch schema (`testing/scratch-db.ts` exists). Stop adding `zz-` prefixes to gateway tests, and replace the placeholder assertion. |
| C-06 | low | **Flaky-test hot spots.**<br>• The real garak suite never runs in CI: it is skipped unless `REGULAIT_GARAK_PYTHON` is set, and no workflow sets it.<br>• The token-endpoint timeout test races a 150 ms timer against a 600 ms hook and polls for 5 s, so it depends on wall-clock timing.<br>• The intermittent "work is BOUNDED" rescan failure on #605 traces to the open finding in R-02, not to the test. This applies to the #605 branch, not `main` (UNVERIFIED here). | `packages/engine-garak/src/garak-real.test.ts:72`<br>`apps/gateway/src/zz-adr0188-s5-token-endpoint.test.ts:1028` | Run the real garak suite nightly. Use fake timers in the timeout test. |
| C-07 | low | **Dead or unchecked code.** `apps/web/review/` (21 files, 2,576 lines) imports `packages/*/dist` and sits outside the web tsconfig, so nothing type-checks it. `spikes/` holds 106 files (about 23k lines). | `apps/web/review/`<br>`spikes/` | Move both under `internal/` or delete them. |

##### Open source first (ADR-0176)

| ID | Sev | Finding | Evidence | Recommended action |
|---|---|---|---|---|
| O-01 | medium | **`THIRD_PARTY.md` is incomplete.**<br>• `apps/gateway/THIRD_PARTY.md` has rows for 23 of 48 non-workspace production deps. The 25 missing:<br>  – `@aws-sdk/client-{acm,backup,ecs,s3,ssm,sts}`;<br>  – `@azure/{arm-compute,arm-recoveryservicesbackup,arm-resourcegraph,arm-resources,identity,keyvault-certificates}`;<br>  – `@fastify/rate-limit`;<br>  – `@google-cloud/{backupdr,certificate-manager,config,os-config}`;<br>  – `@kubernetes/client-node`, `@modelcontextprotocol/sdk`, `@node-saml/node-saml`;<br>  – `ajv`, `ajv-formats`, `fastify`, `openid-client`, `zod`.<br>• `apps/web/THIRD_PARTY.md` lacks `react`, `react-dom` and `@tanstack/react-query`.<br>• `xml-crypto` is an exact-pinned gateway devDependency (tests only), and transitive through node-saml in the shipped closure.<br>• `packages/db/THIRD_PARTY.md:12` says drizzle-kit is exact 0.31.11; `package.json` has `^0.31.4`.<br>• No preflight compares rows to `package.json`. The licence gate does cover the whole `--prod` closure. | `apps/gateway/package.json:30-95,104`<br>`apps/gateway/THIRD_PARTY.md:7-32`<br>`apps/web/package.json:16-28`<br>`apps/web/THIRD_PARTY.md:7-16`<br>`pnpm-lock.yaml:248-250,5279-5290` | Add the rows. Add a preflight that fails when a production dep in any workspace has no row, and when a row's stated pin does not match the manifest. |
| O-02 | medium | **Three ADR-0176 "Replace" decisions are open past the 11-03 deadline:**<br>• `upstream-retry.ts` (429 lines; cockatiel planned);<br>• `shared/tracing.ts` OTLP encoder (960 lines; `@opentelemetry/otlp-transformer` planned);<br>• `scheduler.ts` (924 lines; pg-boss or graphile-worker planned).<br>None of the target libraries is in any manifest. | `internal/decisions/0176-open-source-first.md:226-229` | Schedule one replacement batch per item, keeping the existing tests. |
| O-03 | medium | **Hand-written CSV and canonical-JSON code exists next to the libraries.**<br>• Two CSV parsers: `onboarding.ts:610`, whose comment claims there is "exactly ONE CSV parser", and `reporting.ts:737`.<br>• A CSV writer: `billing.ts:494`.<br>• Meanwhile `csv-parse` and `csv-stringify` are already dependencies.<br>• `stableStringify` copies remain, while `canonicalize` is a shared dependency. | `packages/shared/src/onboarding.ts:610`, `reporting.ts:737`<br>`apps/gateway/src/billing.ts:494`, `fairness.ts:45`, `reporting.ts:36`<br>`config-versions.ts:987`, `mcp-admission.ts:431` | Switch to `csv-parse` (its `info` option gives line numbers), `csv-stringify` and `canonicalize`. |
| O-04 | medium | **Two JSON-Schema validators can disagree.** The eval scorer uses a hand-written subset validator; the playground uses full Ajv. The same schema can pass in an eval and fail in the playground. | `packages/shared/src/evals.ts:589,723`<br>`apps/gateway/src/playground.ts:100-125` | Use the shared Ajv + re2js instance in evals. |
| O-05 | low | **The licence rule's wording conflicts with an accepted exception.** The engine images ship libgfortran (GPL-3.0 with the GCC runtime exception) and libquadmath (LGPL-2.1), which the owner accepted under ADR-0187. On its face, the CLAUDE.md rule "no GPL … in shipped code" forbids this. Note: the torch entry's "BSL-1.0" is the Boost licence, not the Business Source Licence. | ADR-0187 (decisions 106, 193)<br>CLAUDE.md "open source first" §3 | Write the runtime-exception carve-out into ADR-0176 so the rule and the practice agree. |

##### Process

| ID | Sev | Finding | Evidence | Recommended action |
|---|---|---|---|---|
| R-01 | **high** | **A review is a prose comment, not a GitHub review.** Every session posts as the owner account, so there is no review state, no thread resolution and nothing branch protection can enforce. | PR #605: `get_reviews` returns `[]`; all 14 comments have association OWNER | Run reviewer sessions under a separate GitHub App identity that submits real reviews with inline threads. Turn on "require conversation resolution" and "dismiss stale approvals". The merge loop refuses a head with any unresolved thread. |
| R-02 | **high** | **#605: a verified one-line fix was missed across three review rounds.**<br>• The fix: the rescan query lacks `isNull(mcpServers.disabledAt)`, so disabled servers use up capped batch slots.<br>• Raised at ee3d71b6, and still open at 3c30ced9 and at 78414e79.<br>• Every push after round 2 reacted to `main` moving (journal merges, renumbers, an entry-trim merge).<br>• The lane's status posts on #453 at 00:13, 00:48, 03:00 and 03:24 never list the finding.<br>• `READY` meant "CI green", not "findings closed", and the security verdict said APPROVE while the code verdict said REQUEST CHANGES. | PR #605 review comments (11-06 22:05 and later)<br>#453 comment 6702033079 | Number every finding. A `READY` post lists each open finding with the commit that fixes it, or "deferred, accepted by". Every delta review opens with the previous round's open findings. Reviewers post one-line fixes as GitHub suggestion blocks. |
| R-03 | **high** | **The migration journal serialises unrelated PRs.**<br>• In 3 weeks the journal took 115 commits (66 of them merges of main), with 37 recorded conflicts and 20 renumber or re-stamp commits.<br>• #605's migration was renumbered three times (0219→0262→0277→0285), and #628's three times.<br>• Each landing forces the next PR to merge main and re-run CI, for example #683 waiting on #605. | `git log -- packages/db/migrations/meta/_journal.json`<br>#453 comments 6697259161, 6701062213 | Structural fix: lanes write a placeholder migration (`pending_<branch>.sql`) and no journal entry. A merge-queue step assigns the next number and `when`, then appends the journal entry on the merge-group ref. Or use a migrator that tracks which migrations have run, not a watermark, and fails loudly on any unapplied migration below the highest one applied. Either way, nobody edits the journal on a branch. |
| R-04 | medium | **A script that resolved census-test conflicts silently deleted a guard assertion** on four PRs (`expect(SUPERSEDED.size)` on #639, #640, #681 and #692). It was restored later. | #453 designer comment, 11-07 03:00 | Never resolve test files by script. Add a CI check that each guard-test file's assertion count is not below the base branch's. C-04 removes the main source of these conflicts. |
| R-05 | medium | **Unrelated commits get folded into approved PRs.**<br>• The entry-trim commit aae03518 was merged into #605, #622, #654, #681, #690 and #691.<br>• #605 grew from a UI prototype into 39 files and 3,187 lines, with migrations and an ADR, while still titled "HOLD proto… needs API". | #453 master comment, 11-07 00:56<br>PR #605 file list | A cross-cutting fix gets its own PR, and others merge `main` once it lands. Re-review any PR whose diff leaves its declared surface, and refresh its title and body. |
| R-06 | medium | **Each PR passed the size limit alone, and the combined tree did not.** `main` itself was over the entry-JS limit at 6a06dc1 (139,555 B against 139,500 B). This repeats M-104. | #453, 11-07 03:24 (not re-run here: UNVERIFIED) | Use GitHub merge queue, running size-limit and the full gate on the merge-group ref. Log the repeat in `mistakes.md`. |
| R-07 | medium | **The memory files have drifted.**<br>• STATE.md is 495 KB and 5,828 lines; its recap and `last_updated` say 10-29.<br>• The last session file is from 10-25, and there is no record of the demo's outcome.<br>• The PENDING header says "current as of 2026-08-03".<br>• `mistakes.md` stops at M-108 (10-31), with no entries for the #605 miss, the census-guard deletion or the M-104 repeat.<br>• The ADR index (448 KB) took 165 commits and 34 conflicts in 3 weeks. | `internal/memory/STATE.md:1-9`<br>`internal/memory/sessions/`<br>`internal/product/PENDING.md` header<br>`internal/decisions/README.md` | Generate the ADR index from ADR front matter in CI, and stop editing it by hand. Write STATE.md's recap as per-session fragment files compiled by a script (a towncrier-style pattern). Set `merge=union` in `.gitattributes` only for line-append logs, never for the journal JSON. Log the three missed mistakes. |
| R-08 | medium | **Coordination is too centralised.**<br>• Everything runs through one issue (#453, over 360 comments), and master's broadcasts mix many PRs per comment.<br>• One lane holds about 20 PRs and 3 background builders.<br>• About 70 CI runs were queued at once (11-06 21:47), and reviews were done at heads with CI still queued.<br>• Over 3 weeks, `main` took 699 merges against 885 content commits: about 2 merges of main per PR. | #453<br>`git log origin/main --merges` | Cap open PRs per lane (for example, 5 or fewer). Keep each PR's status in that PR as a checklist a script updates, and use #453 only for decisions. A merge queue batches merges, which cuts both the merge-main loop and the CI backlog. |

---

#### Product readiness: what blocks an enterprise pilot (ranked)

1. **There is no production-grade or customer-cloud deployment path.**
   - The original AWS Organization is gone (ADR-0203).
   - Hosting is a single hardened instance (ADR-0228), and high availability is deferred (PENDING P2).
   - "BYOC" is one compose stack (P-03).
   - Nothing holds a production designation, which needs the owner's explicit sign-off under the standing guardrail.
2. **Three security defaults would fail a buyer's security review on day one:** S-01 (RLS), S-02 (published secrets on the public profiles) and S-03 (webhook replay). All three are blocking bugs under CLAUDE.md.
3. **Governance coverage is weaker than the pitch.** Approvals, rate limits and ABAC cover MCP calls only, and the plan gate is opt-in (P-01, P-02, S-05, S-06). This is the core value proposition, and buyers will test it first.
4. **Integration lifecycle basics are missing on `main`.**
   - There is no per-server or per-connector disable or delete route. `updateServerSchema` has no disable field, and no DELETE route exists for servers or connectors.
   - There is no webhook-secret rotation route.
   - Git-token replacement is held in #604 and #605.
   - So an admin cannot cleanly cut off one MCP server they suspect is compromised. Whether grant revocation or the org kill switch covers every caller is UNVERIFIED.
5. **There is no real release keypair.** The update-bundle and licence verifiers pin a dev public key whose private half was not kept (PENDING S3, `infra/release-keys/`). Customers cannot verify updates or licences.
6. **Integrations are not live-proven.** Only the Google model adapter was checked live. The PM adapters have run against fake servers only, and the infra and deploy adapters have never run live (P-03, P-04, P-09).
7. **The docs are not buyer-ready.** STATE, PENDING and ROADMAP are stale (R-07), there is no admin guide, and ARCHITECTURE.md overstates the decision core (P-01).

---

#### Top 10 next actions (prioritised)

1. **S-02 (small, high leverage).** Refuse published dev secrets unless the bind is loopback or an explicit dev opt-in is set. Treat an https `PUBLIC_URL` as a deploy signal and forward `REGULAIT_HSTS`. Retire the bootstrap credential once a real admin exists.
2. **S-03.** Add a webhook delivery dedup table and timestamp windows, and remove the static-header and legacy-hash fallbacks.
3. **S-01.** Run ADR-0234 batches 7 and 2 together: a non-owner runtime role, a boot refusal of superuser or BYPASSRLS, and `withPrincipal` around requests. Then roll out the table batches as blocking work.
4. **R-03 and C-04 (structural conflict fixes, one small PR).**
   - Drop the census count pins.
   - Move migration numbering and journal append to a merge-queue step, and turn on GitHub merge queue (which also fixes R-06 and part of R-08).
   - Extend the watermark guard (C-03).
5. **R-01 and R-02.**
   - Reviewer sessions post real reviews under a separate App identity.
   - Require conversation resolution.
   - Number every finding.
   - `READY` lists each finding with its fixing commit.
6. **P-02.** Enforce plan-only at project level on every surface: invoke, runs, compat and MCP.
7. **P-01, S-05 and S-06.** Write an ADR for one `governedEvaluate` core covering model, connector and A2A calls, with the attribution mandate on by default. Correct ARCHITECTURE.md now.
8. **S-04.** Make the eight grant-mint routes a step-up action.
9. **Readiness item 4.** Merge per-server and per-connector disable, credential and webhook-secret rotation, and git-token replacement as one small "integration lifecycle" batch, split out of #604 and #605.
10. **O-01, then O-02 and O-03.** Add the missing THIRD_PARTY rows plus a preflight that keeps them complete, then schedule the three overdue ADR-0176 replacements.

After those: generate the ADR index and compile STATE from per-session fragments (R-07). Run live sandbox passes for Jira and Azure DevOps and for one cloud's infra adapter (P-03, P-04). Run the key ceremony for a real release keypair (readiness item 5).

---

*Evidence line numbers are at 6a06dc1. Process counts come from git history between 2026-10-17 and 2026-11-07, and from issue #453 and PR #605 as read on 2026-11-07. Items marked UNVERIFIED were reported by a review pass but not independently re-read in code.*
