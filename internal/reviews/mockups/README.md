# UI mockups for Claude

**Pickup pack, 2026-11-22.** Twelve Markdown wireframes for making regulAIt easier to use.
Original eight-document baseline: main `6d81348a543cf923dbd6fb9e45e8f70206c95ce4`.
2026-11-23: mockups 06/08 refined and 09 added against main `b5f88e79e4a8d25432f4ec70bc0ad811751e492c`; each document names its own baseline.
2026-11-24: mockups 10/11 added against main `2d57877b82fbb4c7d9969ffd88ee7ce7805f132e`.
These are proposed layouts and interaction contracts, not shipped screens or completed usability tests.
All records and figures in examples are synthetic.

Start with the relevant task below, then read its linked feedback in
[codexreviews.md](../codexreviews.md). Keep reasoning and implementation replies in that review's discussion loop.
The [design guidelines](../../DESIGN_GUIDELINES.md) and current server contracts govern implementation.

## Pick up a task

| Mockup | User task and main recommendation | Related feedback | Suggested order |
| --- | --- | --- | --- |
| [01 — Home and navigation](01-home-and-navigation.md) | Find immediate work before browsing the suite catalogue; show unknown counts honestly. | HME-001; UXP-001/003/006 | After truthful status handling |
| [02 — Approvals and task detail](02-approvals-and-task-detail.md) | Understand the exact request, decide once, and see recorded/partial execution outcomes. | APR-001..003; WBK-001..005; UXP-002/003/005 | First task slice |
| [03 — Workflow progress and recovery](03-workflow-progress-and-recovery.md) | Understand a blocked stage and use the existing permitted recovery path. | WFL-001..004; UXP-002/003 | Next task slice |
| [04 — Security settings and exceptions](04-security-settings-and-exceptions.md) | Review one intentional policy change; make supported relaxation scoped, explained and expiring. | ADM-003/004/009; SSO-002/003; UXP-004 | Current-policy integration first; new exception contract separately |
| [05 — Connections and credentials](05-connections-and-credentials.md) | Configure a service and replace its credential without moving the wrong connection or claiming untested health. | INT-002..005; CON-001..004; SSO-003 | Alongside assigned connection fixes |
| [06 — Lists and record context](06-lists-and-record-context.md) | Reach older work, inspect it, and return to the same place without mixing subjects. | UIS-04/05/06/08; REV-003/004; APR-003; UXP-005 | Reuse shared list work before caller changes |
| [07 — Sign-in and account linking](07-sign-in-and-account-linking.md) | Choose an available method, finish required setup/proof and complete linking without repeated dead ends. | ACC-001/004/005; SSO-003/004; UXP-002/003/006 | Verify merged proof fixes before new changes |
| [08 — Reports and costs](08-reports-and-costs.md) | Understand recorded figures and date scope; retain evidence when archiving definitions. | REV-001..005; CST-001..006; UXP-002..006 | Reuse merged archive/reason/date/renderer work; verify pending actions |
| [09 — Project work and chat](09-project-work-and-chat.md) | Keep project/thread context, drafts and tool-decision outcomes clear. | UIW-01..05; UXP-001/002/003/005/006 | Reuse Composer fixes; coordinate history/context work with E35/E50 |
| [10 — Refusal explanations](10-denial-explanations-and-recovery.md) | Understand a denial, known outcome and safe next step at the current reader’s authority. | BRN-UX-03; existing proof/outcome cards | Reuse current refusal mapping; gate missing per-reader facts |
| [11 — First run and navigation](11-first-run-and-navigation.md) | Resume configuration or inspect readiness through clear task entry points. | BRN-UX-01/02; UXP-001 | Reuse existing wizard/readiness lifecycle and attention-first Home |
| [12 — Tool admission and permissions](12-tool-admission-and-permissions.md) | Inspect exact changed definitions and distinguish admission from effective access. | MCP-001; BRN-SEC-03; loaded-subject/pending findings | Reuse pin/digest/proof/entitlement contracts; expose existing full diff values safely |

IDs above use the `CXR-` prefix in the review. This is a task-first implementation order, subject to the master's
assigned slices and security prerequisites. It is not permission to open twelve parallel implementation PRs.
These twelve journeys do not exhaust the current 157-route inventory or every page's functions and states.

## What the user should gain

1. **A clear next step:** resource, scope, effective state and one primary action visible together.
2. **Less repeated work:** retain suitable non-secret input, filters and list position through safe back/cancel/retry.
3. **Honest outcomes:** separate a recorded decision from failed execution, an estimate from a measurement,
   and an unavailable value from zero.
4. **Understandable security:** explain the exact consequence and applicable proof. Offer only supported,
   authorised policy choices; make permitted exceptions narrow, audited and time-bound.
5. **The same task on a phone or keyboard:** preserve critical context and reachable actions rather than hiding it.

## Shared visual and interaction rules

- Reuse the existing suite rail, command palette, brand components, typography and spacing tokens. Wireframe widths
  describe reference viewports, not CSS constants or replacement breakpoints. Use sentence case and British English.
- Keep one primary action per active view. Navigation links and per-row actions are not extra page-level primaries.
  Destructive actions stay secondary and explain their actual consequence; do not implement deletion from a mockup.
- Use native links for destinations, buttons for mutations, and real table structure. Give row actions a fixed slot
  and a resource-specific accessible name. Do not make a table row a fake link.
- Reuse `DataList`, `FoldTable`, `DetailDrawer`, `DrawerActions`, `RowActions`, `QueryGate`, `RecordError`,
  `RefusalNotice`, `OrgSettingsCard`, current proof wrappers and single-flight guards before adding a helper.
- Treat each state table as a presentation mapping. Product transitions remain in the existing declared,
  server-enforced lifecycle pattern owned by E29; no additional state engine is proposed.
- Drawer decision rows use `DrawerActions`. Keep required explanations and errors reachable above that row,
  including with zoom and a software keyboard. Desktop and phone surfaces use the current drawer/modal rules.
- Busy controls retain focus through the shared `aria-disabled` plus activation guard pattern. Protect both
  opposing actions from repeat/conflicting submission. A visual disabled state alone is insufficient.
- Ask before discarding dirty edits under the recorded owner rule. Suitable non-secret drafts belong to one
  loaded resource/principal scope; clear secrets on cancellation, resource/provider changes and unmount.

## States every implementation must address

| State | Required experience |
| --- | --- |
| Loading | Announce busy; show a skeleton/unknown value, not a successful zero or guessed policy. |
| Successful empty | Explain the actual scope and offer an available next step or filter reset. |
| Read failed | Inline error and appropriate Retry; independently successful panels remain usable. |
| Forbidden / missing | Use the existing non-disclosure and `RecordError` conventions; no inaccessible cached content. |
| Background refresh / stale subject | Name the old scope and freshness; do not enable mutations for a newly selected subject against old data. |
| Proof required / cancelled | Explain the same fixed action; use current proof handling; preserve suitable work when no mutation was sent. |
| Mutation pending | Stable submitted identity and intent; one write attempt; preserve focus and prevent conflicting dismissal. |
| Partial completion | Keep the recorded part visible and name the remaining work; never resend a committed decision to repair execution. |
| Saved, refresh failed | Keep the saved result, offer read recovery and reconcile before further writes. |
| Uncertain outcome | Read authoritative state through supported mechanisms; do not blindly replay a possibly committed write. |

Do not automatically add confirmation and proof to harmless reads. Do not infer permissions from a visible row,
priority from age, provider health from saved configuration, or exact totals from a truncated page.
List/count/export/detail must share current server-enforced authority and filter scope.

## Contract gates and owner decisions

Each mockup separates reusable components from missing facts or APIs. A missing contract is an implementation
dependency, not permission to fake data or create a client-only safeguard. Recheck latest main before assigning it.
In particular:

- New administrative exceptions need the owner-approved new row kind, bounded expiry, step-up, audit and automatic
  reversion. The existing red-team assurance window cannot stand in for that contract.
- Caller eligibility, current attempt, authoritative schedule/health and exact scoped counts need actual safe facts.
  Do not promise an unsupported deep link, priority/widget endpoint or automatic retry mechanism.
- Report archive now stops schedules and retains runs; mapping removal requires an audited reason; cost dates
  include the whole final day. Mockup 08 identifies their current implementations and remaining UX checks.
  Risk paging and a shared report renderer also exist: do not rebuild them from the original design gates.
- Claude's [later response](https://github.com/dhruvmahendrapatel/RegulAIt/pull/1184#issuecomment-7083558347)
  accepts 20 cards for implementation, reports IDM-002/SSO-001 fixed in #1205, and defers CON-004 to
  [#1212](https://github.com/dhruvmahendrapatel/RegulAIt/issues/1212). Independent retest remains required.
- ACC-002 remains the owner's low-priority [#1192](https://github.com/dhruvmahendrapatel/RegulAIt/issues/1192).
  ACC-004 also remains deferred in [#1188](https://github.com/dhruvmahendrapatel/RegulAIt/issues/1188).
  A future-compatible form sketch does not authorise a standalone fix for any deferred item.
- The [initial response](../codexreviews-response.md), owner decisions and current assigned slices continue to apply.
  These mockups do not close cards, relax trust boundaries, authorise production writes or replace an ADR.

## Prototype and acceptance plan

Build from synthetic populated fixtures. Check each chosen task at 375, 768 and 1440 px, light and dark,
keyboard-only, visible focus, 200%/400% zoom and reduced motion. Use the product's 24×24 CSS-px target minimum;
prefer larger targets for frequent/high-impact actions. Check long names, errors and a soft keyboard.
Run existing accessibility gates, then separately record real screen-reader, password-manager, native proof/device,
IME and provider checks where relevant. Automated or mocked results do not prove those native journeys.

Owner decision D-2026-11-23-01 approves attention-first Home and defers user studies. Participant targets remain
unmet; report automated/mock/keyboard evidence only and retain the untested native-device list.

A future before/after comparison could record task completion, wrong-record or duplicate-action attempts, successful
recovery, repeated entry/navigation and confidence about what persisted. A shorter flow is useful only if its
meaning and consequences remain clear. No usability gain has been measured by these Markdown wireframes.

The research basis is the main review's [best-practice and comparison section](../codexreviews.md#research-and-comparison):
NN/g task/status/error principles; GOV.UK progressive disclosure and error handling; WCAG authentication/focus/targets;
OWASP contextual reauthentication and per-request authorisation; documented Camunda, Defender/Sentinel and n8n
patterns. These are cited design references, not copied code or claims of live competitor testing.

## Current Claude and owner response

The [iteration 7/8 response](https://github.com/dhruvmahendrapatel/RegulAIt/pull/1184#issuecomment-7102099112)
agrees with mockups 02/08 and narrows 01/03/04/05/06/07 to assigned slices and available facts.
[Owner answers](https://github.com/dhruvmahendrapatel/RegulAIt/pull/1184#issuecomment-7102576169) approve attention-first
Home and defer user studies. Iteration 10 in the main review records the detailed reasoning, independent retests
and new BRN discussion topics. Mockups 09–12 still need a direct assessment. No recommendation is closed merely
from agreement.

## Reply format for Claude

For each selected mockup, reply in the draft review PR with:

1. Mockup and finding IDs; agree, narrow, disagree or already implemented, with source reasoning.
2. Assigned implementation slice and current source SHA; existing contracts reused and any remaining contract gate.
3. Exact layout/copy/states implemented and acceptance evidence; explicitly list untested native/user-study work.
4. Fix PR/head and relevant build/tests/bundle results. Follow the normal builder report and READY process only
   after its gates pass; keep this feedback PR draft and on HOLD.
5. Ask Codex for an independent retest of the named task/states. Codex records the result in the review ledger;
   disagreement stays visible until source evidence or a reproducible counterexample resolves it.

Do not mark a recommendation closed merely because its mockup exists or its code was merged.
