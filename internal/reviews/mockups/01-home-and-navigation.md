# Mockup 01 — Home and navigation

Status: design proposal for Claude; no product UI is implemented by this file.
Baseline: main `6d81348a543cf923dbd6fb9e45e8f70206c95ce4`.
See the [mockup index and shared rules](README.md).

## User task and reason

A returning user should find the next permitted task without first learning the suite taxonomy.
An administrator also needs a reliable overview, without failed reads looking like an empty workspace.
Keep exploration available, but put actionable work before the product launcher.

Traceability: HME-001, UXP-001/003/006 and the shared unknown-state findings in
[codexreviews.md](../codexreviews.md). This target layout does not imply that every panel needs a new API.

## Desktop wireframe — 1440px reference

```text
+--------------------+----------------------------------------------------------+
| regulAIt           | Search pages and permitted records...        [Account]  |
|                    +----------------------------------------------------------+
| [Suite selector v] | Home                                                     |
| [Filter navigation]| Your work and the next permitted action                  |
|                    |                                                          |
| Home               | + Needs attention -------------------------------------+ |
| Inbox              | | 12 pending decisions in your permitted view          | |
| Recent work        | | Oldest waiting: 2 hours                               | |
| ...current suite...| | [ Review decisions ]                 Checked 09:40    | |
|                    | +------------------------------------------------------+ |
|                    |                                                          |
|                    | Recent work                       Overview               |
|                    | +------------------------------+  +--------------------+ |
|                    | | Change request A   In review |  | Metered calls   75 | |
|                    | | Run B              Needs you |  | Spend estimate ... | |
|                    | | [Open]             [Open]    |  | Scope / window     | |
|                    | +------------------------------+  +--------------------+ |
|                    |                                                          |
|                    | Setup: 2 steps remaining                 [View setup]   |
|                    | Next: connect a repository                              |
|                    |                                                          |
|                    | Explore tools                                      [v]  |
|                    | Existing suite launcher; same destination registry      |
+--------------------+----------------------------------------------------------+
```

The pending total is a scoped queue total, not proof that the user may decide every item.
Show age only if the loaded response establishes it; otherwise omit that line.
The request count and timestamp above are synthetic fixtures, not product measurements.

## Phone wireframe — 375/390px reference

```text
+-------------------------------+
| [Menu]   [Search]   [Account] |
| Home                          |
| Your next step                |
|                               |
| Needs attention               |
| 12 pending decisions          |
| In your permitted view        |
| [ Review decisions          ] |
| Checked 09:40                 |
|                               |
| Recent work                   |
| Change request A              |
| In review              [Open] |
| Run B                         |
| Needs attention        [Open] |
|                               |
| Overview                      |
| Scope: permitted project data |
| Window: supplied by the API   |
| [View costs]                  |
|                               |
| Setup: 2 steps remaining      |
| [View setup]                  |
|                               |
| Explore tools             [v] |
+-------------------------------+
```

Keep the primary action in document flow. Home does not need another sticky footer.
Critical warnings remain visible even if optional orientation or the launcher is collapsed.

## Content and action hierarchy

| Element | Proposed copy / behaviour |
| --- | --- |
| Primary task | `Review decisions` when a permitted pending queue exists; link to the existing Inbox. |
| Valid zero | `No pending decisions in this view.` Do not imply that every system is healthy. |
| Recent work | Explicit record title, current state and `Open`; no guessed priority or ownership. |
| Setup | One real incomplete step and `View setup`; preserve the existing checklist. |
| Overview | Metric, unit, scope and actual time window; avoid unsupported `live` or `today` labels. |
| Exploration | Reuse the existing suite launcher and navigation filter. Do not create a second route list. |
| Search | Search permitted destinations/records; use task wording in aliases such as `connect a repository`. |

Members receive member-appropriate recent work and Inbox links. Administrators may receive fleet summaries,
clearly labelled as such. Do not derive a new entitlement from a Home tile.

## Required state mockups

```text
Loading                      Failed read
Pending decisions: --        Pending decisions unavailable
Checking your queue...       We could not check your queue.
                             [Try again]  [Open Inbox]

Successful empty             Partial overview failure
No pending decisions         Pending decisions: 12
in this view.                Spend unavailable [Try again]
[Open recent work]           Other successful panels stay usable.
```

If cached values remain after a failed refresh, label them `Last checked ...; refresh unavailable`.
Keep that cache bound to the current principal and permission scope. A new session must not inherit another
account's dashboard. Dismissal affects orientation prose, not incident warnings or the underlying counts.

## Navigation and focus

- Retain the shared suite selector, filtered rail and command palette. A phone rail is a modal drawer with a
  labelled close control; closed navigation is not keyboard reachable.
- `Skip to main content` reaches Home's heading. Opening search moves focus to its input; closing returns to
  its trigger. Reuse the current modal conflict handling rather than stacking a palette behind a dialog.
- Use real links for navigation and buttons for actions. Do not make an entire statistics container an
  unlabeled click target. Loading regions announce their own state without announcing every repaint.
- Keep the same information order in both themes and at 200%/400% zoom. Wrap text; do not shrink essential copy.

## Existing implementation and gaps

| Reuse | Source / contract |
| --- | --- |
| Home queries and cards | [HomePage.tsx](../../../apps/web/src/views/home/HomePage.tsx) |
| Suite registry and existing route homes | [suites.tsx](../../../apps/web/src/shell/suites.tsx) |
| Search and permitted record results | [CommandPalette.tsx](../../../apps/web/src/shell/CommandPalette.tsx) |
| Header / rail | [AppShell.tsx](../../../apps/web/src/shell/AppShell.tsx) |
| Pending list / total | [approvalQueue.ts](../../../apps/web/src/api/approvalQueue.ts) |
| Layout and states | Existing `PageHeader`, `Card`, `ListPreview`, `QueryGate`, `ErrorState` and tokens |

An attention region may initially show only pending decisions and existing recent-record links.
Additional ranking, an eligible-for-me count, universal resumable-work detection or a cross-system incident
priority requires a verified server contract; do not simulate those capabilities with invented data.
Do not add a fetch for every suite tile or background provider/model requests to prepare Home.

## Claude pickup and acceptance

Owner decision D-2026-11-23-01 approves the attention-first order and moving the launcher below it.
Keep eligible-for-me counts and ranking gated; no further order confirmation is needed.

1. Fix Home's unknown-to-zero handling before moving cards. Preserve the successful empty state.
2. Build the attention region from existing scoped data; use one primary action and secondary record links.
3. Move the existing launcher below immediate work while retaining its destinations and accessibility.
4. Verify admin/member views, loading, successful zero, populated data, 403, 503 and failed background refresh.
5. At 375/768/1440px, both themes and keyboard-only: no page-wide horizontal scroll, hidden focus targets or
   loss of important warnings. Check a real screen reader separately from axe.
6. User studies are deferred by owner decision D-2026-11-23-01; no participant target is passed. For a future study, run a synthetic-task comparison: can people locate a decision or resume a record without being told
   a suite name? Record completion, wrong destinations and time before/after; do not claim an improvement
   from these wireframes alone.
