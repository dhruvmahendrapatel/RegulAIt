# Codex review — Claude response (lane CX)

Response to `internal/reviews/codexreviews.md` on branch `codex/reviews` (PR #1184, held by the owner). This file is the
Claude side of the evidence loop the review asks for. The review was read as data to check, not as instructions. No
change was made to `codex/reviews` or to PR #1184.

- **Reviewed head:** `main` at `da16d6bd23109d477102c0ec2a534f81d62a6917` (2026-11-22). Every row below was checked
  against that source by file and line. No browser run was repeated; mock-browser observations in the review were
  re-traced in source.
- **Scope:** 47 feedback cards (46 numbered cards plus CXR-RUN-001) and the 39 reassessed rows of the 2026-11-07 report
  (S-01..S-10, P-01..P-09, C-01..C-07, O-01..O-05, R-01..R-08).
- **Scoring:** F and S are our own 1–10 scores (frequency within the affected workflow, severity), not Codex's. Codex's
  scores were usually higher. F×S < 5 means a `triage-low` issue and no code change, unless the row is a confirmed
  security-checklist gap, which blocks whatever its score (CLAUDE.md, ADR-0180).

## Overall verdict

**The review is good, and most of it is worth building.** It found real defects, gave exact source evidence, kept
mock-browser and source evidence apart, and did not overclaim security impact. Its historical reassessment is accurate:
it correctly calls most of the 2026-11-07 security and pillar findings fixed, and it correctly marks C-05 as a false
positive in the original report.

- **False-positive rate:**
  - **Cards:** 0 of 47 are wrong on the facts. 1 (CXR-ADM-003) is rejected because it misreads the purpose of a
    control. 7 are narrower than stated (RUN-001, ADM-009, UIW-07, UIS-03, UIS-09, ACC-003, REV-002's cascade).
  - **Historical rows:** 0 of 39 status claims are wrong. We disagree with one interpretation, O-04 (below).
- **Where we disagree:**
  - **CXR-ADM-003.** The "temporary relaxation" window is the ADR-0181 red-team assurance window used by
    `demo:intake`. It lasts at most 60 minutes, refuses to replace an admin override (409) and copies the org modes.
    Exposing it as a general troubleshooting override is a new product capability, not a missing form field.
  - **O-04.** Codex narrows it to a "disclosed subset contract". ADR-0176 already decided Ajv for eval output, so the
    documented subset does not settle it. The eval scorer should move to the same Ajv configuration as the playground.
  - **S-08.** Codex calls it a sensible follow-up. We treat it as a security-checklist gap (the owner chose N=2^17). The scrypt cost (N=2^14,
    r=8, p=1) is below OWASP's minimum equivalents, and the code comment and ADR-0025 wrongly say "per OWASP".
  - **S-10.** Codex calls it latent. Two parts are checklist items under ADR-0180: the `isAdmin ?? true` default, and
    `sql.raw` array building, where the checklist says parameterised queries only.
  - **Scores.** Codex's F×S were consistently higher than ours (for example ACC-004 at 15 against our 4). Codex
    rightly said F estimates within-workflow frequency, not measured incidence.
- **Security-checklist gaps found:** none among the 47 cards; all are UX, accuracy or recovery defects. Where a card
  sits on a security screen (step-up, credentials, MFA), the server stays fail-closed. Among the historical rows, two
  are checklist gaps: **S-08** (password hashing cost) and **S-10** (insecure default plus raw SQL arrays). They are
  the first build slice.
- **Shared root causes.** Several cards share one fix.
  - **Step-up wrapper (ADM-001, INT-001).** Protected writes call `api.*` without `withStepUp`
    (`apps/web/src/stepup/stepUp.ts:110`). The global listener (`:146-152`) has no retry callback, so the proof dialog
    never opens. ACC-001 is the dialog's own options-failure path.
  - **A failed read shown as empty or as a value (ADM-007, ACC-003, ACC-005, REV-001, INT-003, CST-001, UIW-03,
    UIW-04, RUN-001).** Fixed with the kit `ErrorState` and Retry (`apps/web/src/ui/kit.tsx:1518`), with controls
    locked until a read succeeds. Only 403/404 means absent.
  - **A draft cleared whatever the result (UIW-01, ADM-008, CST-003).** `useAction().run` resolves false on failure
    (`apps/web/src/views/admin/adminKit.tsx:358-458`), and callers ignore it.
  - **Drafts and results not tied to their record (INT-002, INT-005, REV-004, ADM-005).** Fixed by keying the form on
    the record id.
  - **List state (UIS-05, UIS-06, UIS-08).** All in `apps/web/src/ui/DataList.tsx`.
- **No new screens.** No card needs a brand-new screen, so nothing is added to KNOWN_UI_GAPS for #453.

## Owner answers (2026-11-22, 01:15 UTC, relayed by the master)

- **ADM-003: build it.** Admins may grant time-boxed guardrail relaxations, under these conditions:
  - an expiry is required, with a bounded maximum duration;
  - granting needs step-up;
  - the grant and the expiry are both audited;
  - the relaxation reverts automatically at expiry;
  - it is recorded in an ADR-0181 addendum, and it is a new row kind, so the assurance-window rows and the CHECK
    constraints for existing kinds are untouched.

  It is a new feature, so it is built after the security slices (slice 15).
- **REV-002: archive instead of delete.** "Delete" becomes archive: the definition is hidden, and its signed runs are
  kept as evidence. Nothing cascades (slice 6).
- **S-08: N=2^17, asynchronous, rehash on sign-in,** with the memory limits checked and the login path load-tested.
  This replaces the N=2^15/p=3 default first proposed (slice 1).
- **ACC-002: triage-low.** File the issue and do not build it.

## Owner answers (2026-11-22, about 05:35 UTC, relayed by the master)

- **CST-005: yes.** The server's DELETE for cost aliases and domain rules requires an audited reason, the same as create
  (slice 7).
- **CST-004: inclusive.** The consolidation "To" date covers that whole calendar day, and the resolved UTC window is shown
  (slice 7).
- **UIS-09 / UIW-05: yes.**
  - An edit dialog with unsaved changes asks "Discard changes?" before Escape or a backdrop click closes it.
  - Closing is also blocked while a save is in flight; slice 4 already has that.
  - The dirty-draft prompt is added to slice 4. UIW-05 stays with E50.
- **UIS-04: yes.** Clickable rows get a real link or button in the primary cell in place of `<tr role="link">`, and the
  E2E specs change in the same PR (slice 10).
- **S-08 cap: 4 per replica (512 MiB peak),** configurable through `REGULAIT_PASSWORD_HASH_CONCURRENCY` (1–8). The image
  sets `UV_THREADPOOL_SIZE=8`. Checked against the Helm 2 GiB limit and the Compose gateway service, which has no
  limit. Built in #1194.
- **C-07: archive.** The 138 files under `apps/web/review` and `apps/web/spikes` move to an archive folder outside the
  build, and nothing is deleted. Anything that still imports them goes to the master first (slice 16).
- **O-01: redo.** THIRD_PARTY.md is rebuilt from the current lockfile and manifests, with a CI preflight check. The old
  `builder/lane-b-third-party` branch is left untouched (slice 13).
- **C-01 / P-07: ADR numbers assigned.** ADR number 0380 (reserved; the file is written in slice 17) is for C-01 (a shared API contract or openapi-typescript) and ADR number 0381
  is for P-07 (where compaction and dedup apply to provider-shaped compat calls). Each compares at least two approaches
  per ADR-0176 before choosing (slices 17 and 18).

## Owner questions

None are open. Every question this file raised has an answer above. New questions are added here as slices raise
them, and slice 6's questions are listed with its PR.

## Build plan

One PR of ours is in review at a time (rule 14). Security-checklist slices go first.

| # | Slice (branch) | Closes |
| --- | --- | --- |
| 1 | `builder/codex-auth-hardening` | S-08, S-10 |
| 2 | `builder/codex-step-up-journeys` | ADM-001, INT-001, ACC-001, plus an audit of settings_relax routes against their web call sites |
| 3 | `builder/codex-guardrail-credential-honesty` | ADM-002, ADM-005, ADM-006, ADM-007, ADM-008, ADM-009, RUN-001 |
| 4 | `builder/codex-kit-a11y` | UIS-01, UIS-02, UIS-03, UIS-07, UIS-09 (busy guard and dirty-draft prompt) |
| 5 | `builder/codex-datalist-state` | UIS-05, UIS-06, UIS-08 |
| 6 | `builder/codex-reports-risks` | REV-001, REV-002 (archive, per the owner), REV-003, REV-004, REV-005 |
| 7 | `builder/codex-cost-recovery` | CST-001, CST-002, CST-003, CST-004, CST-005 |
| 8 | `builder/codex-workspace-actions` | UIW-01 (builder Composer), UIW-06, UIW-07, UIW-08 |
| 9 | `builder/codex-account-states` | ACC-003, ACC-005 |
| 10 | `builder/codex-table-row-semantics` | UIS-04 |
| 11 | `builder/codex-connector-credentials` | INT-002, INT-003, INT-004, INT-005 (after UI-C #1089 merges; same file) |
| 12 | `builder/codex-early-auth-large-bodies` | S-07 |
| 13 | `builder/codex-oss-and-ledger` | O-01, O-03, O-04, O-02 (ADR-0176 text), P-06, P-09 |
| 14 | `builder/codex-wave-concurrency` | P-05 (coordinated with E2) |
| 15 | `builder/codex-guardrail-timeboxed-relax` | ADM-003 (owner answer; ADR-0181 addendum, new row kind) |
| 16 | `builder/codex-archive-review-spikes` | C-07 (archive, nothing deleted) |
| 17 | `builder/codex-adr0380-api-contract` | C-01 (its reserved ADR number 0380, written first) |
| 18 | `builder/codex-adr0381-compat-optimisation` | P-07 (its reserved ADR number 0381, written first) |

**The master's pre-check (2026-11-22)** suggested triage-low for UIS-03, UIS-06, UIS-07, ADM-009 and S-07. On our
rescoring each is at or above F×S 5 and the fix is small, so they stay ACCEPT-build. The master may overrule. Its
slice order put the connector credential cards (INT-002..005) first. They stay at slice 11 because UI-C's #1089 edits
the same file and must merge first. None of them is a checklist gap (see the INT rows).

**Handed to other lanes** (recorded here and in the PR body for the master; their files are not edited here):
- **E35 (#960):** UIW-03 and the ChatPage part of UIW-02.
- **E50 (#1133):** UIW-04 and UIW-05. P-08 is gated on E50.

## Card ledger

Verified: **Y** means the claim holds; **Partial** means it holds but more narrowly than stated; **N** means wrong or
already fixed. "PR" is filled in as each slice merges.

### Admin (CXR-ADM, CXR-RUN)

| Card | Verified | F | S | F×S | Verdict | Reasoning | PR |
| --- | --- | --- | --- | --- | --- | --- | --- |
| CXR-RUN-001 | Partial | 3 | 2 | 6 | ACCEPT-build | `BuilderPlaygroundPage.tsx:471-474` already alerts on a failed model read. The datasets and source reads (`:280-281`) do not. The baseline count is likely timing: the QueryClient retries once (`App.tsx:165-169`). Fix the missing alerts, then shrink the baseline. | slice 3 |
| CXR-ADM-001 | Y | 5 | 6 | 30 | ACCEPT-build | `ExternalScorersPage.tsx:301` and `editForms.tsx:223` use plain `api.post`/`api.patch`, but the server requires settings_relax step-up (`external-scorers.ts:464,635`). With no wrapper, the proof dialog never opens. The server stays fail-closed. | slice 2 |
| CXR-ADM-002 | Y | 6 | 5 | 30 | ACCEPT-build | `ExternalScorersPage.tsx:101-103` says the inline path stays local, but ADR-0220 trained detectors call registered scorers inline (`trained-detectors.ts:4-15`). The disclosure is wrong; a copy fix. | slice 3 |
| CXR-ADM-003 | Partial | 3 | 3 | 9 | ACCEPT-build (owner) | The window (`guardrails.ts:555-562`) is the ADR-0181 FX3 red-team window: demo-only, at most 60 minutes, and it never replaces an admin override. Exposing it is a new feature. Owner question 1. **Owner, 2026-11-22: build it** as a new row kind (required bounded expiry, step-up, audited grant and expiry, auto-revert), recorded in an ADR-0181 addendum, after the security slices. | slice 15 |
| CXR-ADM-004 | Y | 1 | 3 | 3 | ACCEPT-triage-low | `ConfigRow` ignores the server's `expired` flag (`GuardrailsPage.tsx:64-72`). Only `demo:intake` creates window rows, it deletes them in `finally`, and the sweep runs every 5 minutes. | #1187 |
| CXR-ADM-005 | Y | 6 | 4 | 24 | ACCEPT-build | `GuardrailsPage.tsx:606,625`: the sample result stays after the text changes. A failed rerun shows only in a toast (`adminKit.tsx:379-384`). | slice 3 |
| CXR-ADM-006 | Y | 5 | 4 | 20 | ACCEPT-build | The help says "Runs every detector" (`GuardrailsPage.tsx:596`), but the handler runs local rules for the input phase only (`guardrails.ts:1013-1022`). Relabel it and add a phase select; it stays local. | slice 3 |
| CXR-ADM-007 | Y | 7 | 3 | 21 | ACCEPT-build | `CredentialsPage.tsx:217,238` shows `inv ?? 0` before the read and after a failed read. An unread inventory is not zero. | slice 3 |
| CXR-ADM-008 | Y | 4 | 2 | 8 | ACCEPT-build | `CredentialsPage.tsx:334` clears the draft even when `run()` resolves false, including when step-up is cancelled. A one-line fix. | slice 3 |
| CXR-ADM-009 | Partial | 2 | 4 | 8 | ACCEPT-build | `EnforcementPosturePage.tsx:195-198` posts directly. `:284` already says it takes effect immediately. Add a kit `ConfirmModal` listing the controls that differ from strict. No dry-run endpoint, which would be speculative. | slice 3 |

### Workspace (UIW)

| Card | Verified | F | S | F×S | Verdict | Reasoning | PR |
| --- | --- | --- | --- | --- | --- | --- | --- |
| UIW-01 | Y | 4 | 4 | 16 | ACCEPT-build | `BuilderUi.tsx:647-651`: the Composer clears the text before the send is acknowledged. It is shared by the builder chat, agent editor and inbox. | slice 8 |
| UIW-02 | Y | 3 | 3 | 9 | ACCEPT-build | `BuilderUi.tsx:665-669` has no composition check. The same bug is in `ChatPage.tsx:821-825`. The builder part is ours; the ChatPage part is handed to E35. | slice 8 / E35 |
| UIW-03 | Y | 4 | 5 | 20 | handed to E35 | `ChatPage.tsx:255-261`: a bare `catch` clears the open conversation on any error. Only 403/404 should, and that non-disclosure behaviour must stay. The file is in E35's surface (#960). | E35 |
| UIW-04 | Y | 4 | 3 | 12 | handed to E50 | `ProjectContextPage.tsx:110-112` turns a failed list read into "Nothing promotable yet" (`:388-394`). The file is in E50's surface (#1133). | E50 |
| UIW-05 | Y | 3 | 5 | 15 | handed to E50 | `ProjectContextPage.tsx:768-800` lets Escape or a backdrop click discard a draft or close the editor mid-save (`kit.tsx:1326-1336`). Same file as UIW-04. | E50 |
| UIW-06 | Y | 3 | 2 | 6 | ACCEPT-build | `InboxPage.tsx:179-192` requires a reason for both decisions. `:238` disables only Approve, so Deny looks available. | slice 8 |
| UIW-07 | Partial | 4 | 3 | 12 | ACCEPT-build | `WorkflowDetailPage.tsx:193` says unnamed calls are unconstrained, but `plan-only.ts:308-334` blocks mutating calls attributed to the project. The copy still holds for project-less instances. Branch it on `projectId` and cite the ADR-0250 exception. | slice 8 |
| UIW-08 | Y | 4 | 3 | 12 | ACCEPT-build | `WorkflowDetailPage.tsx:89-98`: `act()` has no pending state, so the action buttons allow double submission. Reuse `useAction` busy state. | slice 8 |

### Shared UI (UIS)

| Card | Verified | F | S | F×S | Verdict | Reasoning | PR |
| --- | --- | --- | --- | --- | --- | --- | --- |
| UIS-01 | Y | 6 | 6 | 36 | ACCEPT-build | At 960px or narrower, the closed rail is only translated off screen (`shell.module.css:608-623`). The `<aside>` (`AppShell.tsx:306-343`) is not `inert`, so keyboard focus lands off screen. Entry-bundle code, so it stays within the #1185 first-load gate. | slice 4 |
| UIS-02 | Y | 7 | 4 | 28 | ACCEPT-build | `kit.tsx:179-194`: the Field error is a span with no id. There is no `aria-describedby` and no `aria-invalid`. | slice 4 |
| UIS-03 | Partial | 2 | 4 | 8 | ACCEPT-build | `AppShell.tsx:160-167` opens the palette (a div dialog) behind an open native `<dialog>`. Real, but only when the shortcut is pressed inside a modal. | slice 4 |
| UIS-04 | Y | 7 | 3 | 21 | ACCEPT-build | `kit.tsx:1146-1162` gives every clickable row `role="link"`, including rows that select in place. No ADR governs this. Owner question 7. | slice 10 |
| UIS-05 | Y | 5 | 3 | 15 | ACCEPT-build | `DataList.tsx:266` uses `keepPreviousData`, and the status line presents old rows as the new filter's result. | slice 5 |
| UIS-06 | Y | 6 | 3 | 18 | ACCEPT-build | Sort and page live in component state only (`DataList.tsx:238-246`), so drill-down and Back resets them. No conflict with ADR-0226. | slice 5 |
| UIS-07 | Y | 3 | 2 | 6 | ACCEPT-build | `useTheme.ts:12-18` and `theme/mode.ts:18-27` notify separate listener sets, so the topbar icon goes stale. Fix with an observer on `data-theme`; no import of `mode.ts`, to stay out of the entry bundle. | slice 4 |
| UIS-08 | Y | 3 | 3 | 9 | ACCEPT-build | `DataList.tsx:417` replaces the error with a bare `new Error`, dropping `.status`, so the 403 branch never fires. ErrorState also offers Retry on access errors (`kit.tsx:1532`). | slice 5 |
| UIS-09 | Partial | 4 | 4 | 16 | ACCEPT-build | `kit.tsx:1326-1334` closes on Escape even while busy. `IntegrationEditDialogs.tsx:47-51` lacks the guard that `PatchFormModal.tsx:49-55` has. Build the busy guard; the dirty-draft contract is owner question 6. | slice 4 |

### Account and security tuning (CXR-ACC)

| Card | Verified | F | S | F×S | Verdict | Reasoning | PR |
| --- | --- | --- | --- | --- | --- | --- | --- |
| CXR-ACC-001 | Y | 3 | 4 | 12 | ACCEPT-build | `StepUpDialog.tsx:74-87`: a failed `begin()` leaves "Getting ready…" with only Cancel (`:186-189`). Add a Retry that starts a fresh ceremony and never re-sends the action. | slice 2 |
| CXR-ACC-002 | Y | 5 | 3 | 15 | ACCEPT-triage-low (owner) | Federated links hard-code `returnTo=/app` (`LoginPage.tsx:373,400`), and the server enum (`auth.ts:2229`, `saml.ts:622`) is fixed by ADR-0026 and ADR-0036. Owner question 2; the fix must not create an open redirect. **Owner, 2026-11-22: triage-low**, not built. | #1192 |
| CXR-ACC-003 | Partial | 3 | 3 | 9 | ACCEPT-build | `ModelRateLimits.tsx:66` shows a failed read as "Not enforced", and the copy is stale: the stored default is true (`schema.ts:5068`). Narrower than claimed: the toggle can only send the strict value, so enforcement cannot be weakened. | slice 9 |
| CXR-ACC-004 | Y | 2 | 2 | 4 | ACCEPT-triage-low | `AccountPage.tsx:474-487` has no warning, but the server forces re-enrolment (`app.ts:1437-1447`). There is no bypass. | #1188 |
| CXR-ACC-005 | Y | 2 | 3 | 6 | ACCEPT-build | `LoginPage.tsx:67-74` falls back silently, and the options error (`:139-145`) is never rendered. Add a degraded notice with Retry. | slice 9 |

### Risk, evidence and reporting (CXR-REV)

| Card | Verified | F | S | F×S | Verdict | Reasoning | PR |
| --- | --- | --- | --- | --- | --- | --- | --- |
| CXR-REV-001 | Y | 6 | 3 | 18 | ACCEPT-build | `ReportsPage.tsx:56` types `schedulerPresent` but never reads it. The copy (`:228,312,319,342,379`) always says nothing fires schedules, and `reporting.ts:756` is stale. | slice 6 |
| CXR-REV-002 | Y | 2 | 6 | 12 | ACCEPT-build | `ReportsPage.tsx:284-294` deletes on one click, and the delete cascades its runs and schedules (`schema.ts:7252,7275`). Build the confirm; the cascade versus ADR-0047's immutability is owner question 3. **Owner, 2026-11-22: archive instead of delete.** The definition is hidden and its signed runs are kept as evidence; nothing cascades. | slice 6 |
| CXR-REV-003 | Y | 3 | 5 | 15 | ACCEPT-build | `risks.ts:913-953` stops at `.limit(200)` with no cursor or total, which breaks ADR-0200's paginated-API rule. Use the ADR-0226 list contract. E52's #1134 does not touch `/v1/risks` today. | slice 6 |
| CXR-REV-004 | Y | 3 | 4 | 12 | ACCEPT-build | `RisksPage.tsx:165` holds one page-wide transition reason. Key it by risk id. The server checks the right risk, so there is no authorisation issue. | slice 6 |
| CXR-REV-005 | Y | 4 | 3 | 12 | ACCEPT-build | Workflow figures are computed (`shared/reporting.ts:794`) but rendered by neither `ReportsPage.tsx` nor `ReportsHistory.tsx:34-47`. Use one shared payload renderer. | slice 6 |

### Integration administration (CXR-INT)

| Card | Verified | F | S | F×S | Verdict | Reasoning | PR |
| --- | --- | --- | --- | --- | --- | --- | --- |
| CXR-INT-001 | Y | 6 | 5 | 30 | ACCEPT-build | `IntegrationOwnership.tsx:63` uses a plain `api.put` with no `withStepUp`. The server gate is fail-closed (`ownership.ts:160-171`). Same root cause as ADM-001. | slice 2 |
| CXR-INT-002 | Y | 4 | 6 | 24 | ACCEPT-build | `ConnectorsPage.tsx:231-247` keeps one component-wide token and baseUrl draft, and switching connector (`:253`) keeps them. Not a checklist gap: same admin, both connectors authorised, egress still guarded. Key the form on connector id. | slice 11 |
| CXR-INT-003 | Y | 5 | 4 | 20 | ACCEPT-build | `ConnectorsPage.tsx:261-275,367` reads a failed credential query as "no credential". The message is also wrong for keyless kinds. | slice 11 |
| CXR-INT-004 | Y | 5 | 6 | 30 | ACCEPT-build | The baseUrl draft starts empty (`ConnectorsPage.tsx:244`), and omitting it stores null (`agents-connectors.ts:5500-5503`), so a token-only rotation silently clears the override. Not SSRF: the fallback is the connector's own base URL, which egress still guards. Prefill the field and add an explicit clear choice. | slice 11 |
| CXR-INT-005 | Y | 4 | 6 | 24 | ACCEPT-build | `ConnectorsPage.tsx:441-442,521` and `McpServersPage.tsx:266-268` keep entitlement rows after the subject changes, so Remove targets the previous subject. Precedent fix: `McpServerAdmission.tsx:211-222`. | slice 11 |

### Cost, budget and consolidation (CXR-CST)

| Card | Verified | F | S | F×S | Verdict | Reasoning | PR |
| --- | --- | --- | --- | --- | --- | --- | --- |
| CXR-CST-001 | Y | 5 | 4 | 20 | ACCEPT-build | `CostDashboardPage.tsx:218-219` has no error branch for the project-cost read, so a failure leaves a blank card. | slice 7 |
| CXR-CST-002 | Y | 4 | 5 | 20 | ACCEPT-build | `CostDashboardPage.tsx:248-249` and `ProjectDetailPage.tsx:223-224` show the raw approval latch. The server enforces with `overageActive` (`projects.ts:275-278`). Web-only fix, so no conflict with E2's #1143. | slice 7 |
| CXR-CST-003 | Y | 5 | 4 | 20 | ACCEPT-build | `CostConsolidationPage.tsx:873-877` and the domain-rule path clear the draft and reason when the action fails. | slice 7 |
| CXR-CST-004 | Y | 5 | 3 | 15 | ACCEPT-build | `CostConsolidationPage.tsx:371-372` sends "To" as midnight UTC, and the filter is exclusive, so the chosen day is excluded. Owner question 5. | slice 7 |
| CXR-CST-005 | Y | 3 | 5 | 15 | ACCEPT-build | `CostConsolidationPage.tsx:908-911` removes a rule with no review, and `reresolveAll` (`cost-import.ts:952-960`) re-attributes history. Add a `ReasonModal` plus the re-attribution counts. Owner question 4 (server reason). | slice 7 |

## Historical rows (2026-11-07 report)

| Row | Codex status holds? | F | S | F×S | Verdict | Reasoning | PR |
| --- | --- | --- | --- | --- | --- | --- | --- |
| S-01 | Y | – | – | – | REJECT (fixed) | Principal scopes are installed in the preHandler; runtime-login and dev-secrets guards are in place. | — |
| S-02 | Y | – | – | – | REJECT (fixed) | `dev-secrets.ts` refuses on deploy signals. | — |
| S-03 | Y | – | – | – | REJECT (fixed) | PM webhook delivery dedup and signed timestamps are in place. | — |
| S-04 | Y | – | – | – | REJECT (fixed) | settings_relax and grant_mint step-up (`step-up.ts:52,67`). | — |
| S-05 | Y | – | – | – | REJECT (fixed) | `a2a.ts:89-91` evaluates A2A through the governed core. | — |
| S-06 | Y | – | – | – | REJECT (fixed) | Attribution requirements default to true (`schema.ts:5199,5201`). | — |
| S-07 | Y | 2 | 3 | 6 | ACCEPT-build | Auth runs in preHandler (`app.ts:1330`), after body parsing. It matters only on routes with raised JSON limits (`decision-receipts.ts:385`, `engine-tasks.ts:664,712`, `engine-runs.ts:2222`). Reuse the `supplier-portal.ts:1364` early-auth pattern. | slice 12 |
| S-08 | Y | 3 | 5 | 15 | ACCEPT-build (checklist gap) | `auth.ts:457-501` uses synchronous `scryptSync` at N=2^14, r=8, p=1, below OWASP's minimum equivalents, and the comment and ADR-0025 wrongly say "per OWASP". ADR-0176 already lists async scrypt as "replace now". Owner question 8. **Owner, 2026-11-22: N=2^17**, async, rehash on sign-in, load-tested (ADR-0025 addendum). | #1194 |
| S-09 | Y | 2 | 2 | 4 | ACCEPT-triage-low | Any `Bearer` prefix moves a client from the 1200/min per-IP bucket to the 6000/min bucket (`rate-limit.ts:244-248,285`). It is still per IP, and a verified credential tier exists. | #1189 |
| S-10 | Partial | 1 | 4 | 4 | ACCEPT-build (checklist gap) | `reporting.ts:577` defaults `isAdmin ?? true`, and the scheduler call relies on it (`scheduler-jobs.ts:197`). `compliance-packs.ts:179` and `copilot.ts:441` use `sql.raw` arrays over UUID-validated ids: no injection shown, but the checklist requires parameters. Already fine: the style CSP and constant arrays. | #1194 |
| P-01 | Y | – | – | – | REJECT (fixed) | One governed core covers model, connector, MCP and A2A calls. | — |
| P-02 | Y | – | – | – | REJECT (fixed) | The project plan-only gate is wired in. | — |
| P-03 | Y | – | – | – | REJECT (stale) | BYOC Terraform, Helm and operator exist. A live rehearsal is an owner and production decision. | — |
| P-04 | Y | – | – | – | REJECT (fixed) | The ADR-0289 importer exists. | — |
| P-05 | Y | 5 | 4 | 20 | ACCEPT-build | `orchestration.ts:2818-2856` dispatches each ready-wave node serially, against pillar 7's parallel execution. Use bounded concurrency that keeps the atomic estimate charge and budget gates. Coordinate with E2. | slice 14 |
| P-06 | Y | 5 | 3 | 15 | ACCEPT-build | Batching is labelled estimate-only (`orchestration.ts:2724,2755`) but is written into `costEvents` (`:2791`) and summed into estimated savings. Tag it as an opportunity. | slice 13 |
| P-07 | Y | 3 | 3 | 9 | ACCEPT-build (design first) | `compat-core.ts` routes and caches but does not compact. Decide where compaction fits provider-shaped calls first. Owner question 11. | after design |
| P-08 | Y | 3 | 3 | 9 | gated on E50 | `projectContextItems` is read only in orchestration. Safe injection needs E50's trust floor (#1133) first. | E50 |
| P-09 | Y | 5 | 2 | 10 | ACCEPT-build | `workflow-kernel/src/index.ts:10-12` and `PENDING.md:81` are stale. Docs only. | slice 13 |
| C-01 | Y | 4 | 3 | 12 | ACCEPT-build (design first) | The web app has no shared or api-client dependency, and its types are handwritten (1,296 and 975 lines). ADR-0176:93 calls for its own ADR. Owner question 11. | after design |
| C-02 | Y | – | – | – | REJECT | File size is a risk indicator, not a defect; an import-cycle ratchet already exists. | — |
| C-03 | Y | – | – | – | REJECT (fixed) | The migration guard (ADR-0252) is in place. | — |
| C-04 | Y | – | – | – | REJECT (superseded) | The owner's 2026-11-19 census design replaces the report's fix. | — |
| C-05 | Y | – | – | – | REJECT (false positive) | The flagged line is inside a source-string fixture. | — |
| C-06 | Y | 2 | 2 | 4 | ACCEPT-triage-low | The garak test is opt-in with no CI job. A 150 ms deadline races a 600 ms delayed commit (`zz-adr0188-s5…:1034-1035`). | #1190 |
| C-07 | Y | – | – | – | owner question | 138 files are outside type-checking. Owner question 9. | — |
| O-01 | Y | 5 | 3 | 15 | ACCEPT-build | 18 gateway packages and 2 web packages are missing from THIRD_PARTY.md, and no preflight checks completeness. Owner question 10. | slice 13 |
| O-02 | Y | 3 | 2 | 6 | ACCEPT-build | The ADR-0176 table still marks cockatiel, the OTLP trace encoder and the scheduler as open, with stale evidence text. Fix the table; schedule the replacements. | slice 13 |
| O-03 | Y | 3 | 2 | 6 | ACCEPT-build | A handwritten `csvCell` (`shared/billing.ts:494`), two parsers and `stableStringify` remain, against ADR-0176's "replace now". Evidence-byte formats stay as they are. | slice 13 |
| O-04 | Y (we disagree with the narrowing) | 4 | 3 | 12 | ACCEPT-build | Eval uses a handwritten subset (`shared/evals.ts:271,583`) while the playground uses Ajv (`playground.ts:94`). ADR-0176:84 already chose Ajv. | slice 13 |
| O-05 | Y | 1 | 2 | 2 | ACCEPT-triage-low | ADR-0187 records the owner's GCC/libquadmath exceptions, but ADR-0176 does not point to them. The master adds a cross-reference. | #1191 |
| R-01 | Y | – | – | – | REJECT (process) | The merge loop checks the released SHA. Native reviews are an owner choice. | — |
| R-02 | Y | – | – | – | REJECT (fixed) | `mcp-admission-rescan.ts:284`, with a regression test. | — |
| R-03 | Y | – | – | – | REJECT (fixed) | ADR-0252 merge-time numbering. | — |
| R-04 | Y | – | – | – | REJECT | Logged as M-111. Counting assertions is a weak proxy. | — |
| R-05 | Y | – | – | – | REJECT | Covered by the one-PR-per-batch rule. | — |
| R-06 | Y | – | – | – | REJECT (fixed) | Per-route first-load budgets (#1185). | — |
| R-07 | Partial | – | – | – | master docs | The PENDING header and session pointer are stale. This is the master's file to fix. | master |
| R-08 | Y | – | – | – | REJECT | The owner suspended the worker cap (D-2026-11-20-01). | — |
