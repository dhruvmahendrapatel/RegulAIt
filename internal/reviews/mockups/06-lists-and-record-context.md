# Mockup 06 — Lists that preserve place and record context

Status: design proposal for Claude, not an implemented screen or completed usability test.
Source snapshot: `6d81348a543cf923dbd6fb9e45e8f70206c95ce4`.
Traceability: UXP-002/005/006, UIS-04/05/06/08, INT-005, REV-003/004, APR-003.

## User task and design intent

A reviewer finds an older open risk, inspects its evidence, records a permitted change, and returns to the same list position.
An administrator comparing two accounts must always know whose permissions the displayed results and actions belong to.
Keep the existing dense table useful for experienced users; reduce uncertainty about scope, freshness and the selected record.

## Desktop wireframe — approximately 1440 px

The risk register is the concrete example; use the same pattern for inventory and access lists with their own nouns.
`New risk` is the primary action when no record is open. Opening the detail makes its action the primary action of that view.

```text
+----------------------+-----------------------------------------------------------+
| Existing suite rail  | Risks                                      [New risk]     |
|                      | Review risks visible to your account.                     |
|                      |                                                           |
|                      | Search [data handling     ]   Status [Open v]             |
|                      | Category [All v]          [Clear filters]                 |
|                      |                                                           |
|                      | 11–20 of 126 matches · Oldest first   [Refresh] [Export]   |
|                      | Filters: Open ×                        [Columns]          |
|                      +-------------------------------------+---------------------+
|                      | Risk               Status   Action  | Risk detail     [×] |
|                      | Data handling...   Open     Open →  | Data handling review|
|                      | Tool permissions...Open     Open →  | Open · Tool misuse  |
|                      | ...                                 | Scope: Project A    |
|                      |                                     | Your access: Review |
|                      |                                     |                     |
|                      |                                     | Evidence            |
|                      |                                     | [View evidence]     |
|                      |                                     |                     |
|                      |                                     | Change status       |
|                      |                                     | [Choose allowed v]  |
|                      |                                     | Reason              |
|                      |                                     | [                 ] |
|                      |                                     +---------------------+
|                      | [Previous]  Page 2  [Next]          | [Review change]     |
+----------------------+-------------------------------------+---------------------+
```

The count is exact only when the server supplies an exact scoped total. If it does not, show `11–20 · More results available`.
`Open` is a real link or button in the primary cell; preserve table row semantics. Do not make an entire `<tr>` a link.
Technical identifiers remain copyable secondary details rather than the only readable record title.

## Phone wireframe — 375/390 px

```text
+-----------------------------------+
| Menu  Risks                Search |
| Review risks visible to you.      |
| [New risk]                        |
| [Search risks                  ] |
| [Filters (1)]  [Sort: Oldest first]|
| Open ×              Clear filters |
| 11–20 of 126 matches    [Refresh]  |
+-----------------------------------+
| Data handling review         Open |
| Tool misuse · Project A           |
| Status: Open                      |
| Owner: Unassigned                 |
|                         Open →    |
+-----------------------------------+
| Tool permissions review      Open |
| ... labelled folded metadata ... |
+-----------------------------------+
| [Previous]       Page 2    [Next]  |
+-----------------------------------+

Open → replaces this with the existing modal drawer:
+-----------------------------------+
| ← Back to risks   Risk detail [×] |
| Data handling review              |
| Open · Tool misuse · Project A    |
| Your access: Review               |
| Evidence ...                      |
| Change status [Choose allowed v] |
| Reason [                        ] |
|                                   |
+-----------------------------------+
| [Review change]                   |
+-----------------------------------+
```

Use existing folded-table/drawer behaviour, not a separate phone data store. Keep warnings, scope and next action visible.
The footer stays pinned; it must not obscure the last input or its error at zoom.

## Interaction and state variants

| Situation | Visible copy and behaviour |
| --- | --- |
| Initial load | `Loading risks…`; skeleton rows and an announced busy region. No guessed zero total. |
| Successful empty filter | `No open risks match these filters.` Offer `Clear filters`; keep the current scope visible. |
| Successful empty collection | `No risks registered yet.` Offer `New risk` only when permitted. |
| Read failure | `Risks could not be loaded. Your filters are kept.` Inline `Retry`; do not show empty success. |
| New filter, old rows retained | `Showing previous results while the new filter loads.` Label the old scope and lock its mutations. |
| Recovered read | Replace rows/count together; announce the result succinctly without moving focus. |
| Forbidden detail | `You no longer have access to this risk.` Keep an authorised route back, not a retry invitation. |
| Removed/unavailable detail | Use `RecordError` and the existing non-disclosure contract; never leak another subject's existence. |
| Saving change | `Saving change…`; one guarded in-flight mutation, with its risk identity fixed. |
| Save recorded, refresh failed | `Change saved. Current details could not be refreshed.` Offer refresh, not another save. |
| Write outcome uncertain | `The result is not confirmed yet. Check the current record before trying again.` Reconcile safely. |

## Loaded-subject rule for access comparisons

When an account picker changes, its selected value is not proof that the old result belongs to the new account.
Either clear the previous result and load the new scope, or keep it explicitly labelled and read-only until refreshed.

```text
Selected account: Account B
Showing permissions for Account A — the new account has not loaded.
[Load Account B]                 Old permission changes unavailable
```

A removal confirmation names the account, resource and effective consequence. Never use only `this user` under a changed picker.
Bind pending actions, form drafts and post-save refresh to the loaded record identity. Ignore stale late responses.
Clear secrets on identity changes; retain suitable non-secret drafts only under their own authorised record key.

## Reuse and contract boundaries

| Reuse now | Required contract work or verification |
| --- | --- |
| `DataList`, `listState`, current URL-backed place restoration | Do not rebuild the restoration already merged; verify caller filters and scroll continuity. |
| `DetailDrawer`, `DrawerActions`, `RowActions` | Use existing focus/overlay rules; expose permitted action data only where genuinely available. |
| `QueryGate`, `ErrorState`, `RecordError`, `RefusalNotice` | Distinguish failed count and failed row reads; no new global cache or status engine. |
| Existing server list/page/count/export contracts | Risk register needs the bounded continuation/filter contract before all older risks become reachable. |
| Existing per-record transition enforcement | Populate choices from the existing allowed-transition contract; a mockup does not grant authority. |

Do not load every row into the browser to imitate pagination, estimate an exact total, or sort an unavailable page locally.
Counts, detail, paging and export must use the same current authorisation/filter scope. A viewer gets evidence and navigation, not driving controls.
Do not rely on unmerged priority/widget work or invent client-side queue priority.

## Keyboard and accessibility

- Filter labels, active chips, sort buttons and row links have clear accessible names; colour never carries status alone.
- Preserve focus after refresh and sort; announce result changes with the existing status region, without repeated full-table announcements.
- Desktop drawer follows existing non-modal behaviour. At phone width it becomes modal and the background is inert.
- Move focus to the new detail heading when the subject changes; restore it to that record's opener on close.
- Escape handles the innermost layer first. Ask before discarding dirty changes; prevent dismissal during an unresolved save.
- Retain visible focus, labelled folded values and at least the existing minimum target size. Do not shrink text to fit columns.

## Claude pickup and acceptance checks

1. Check latest main for existing list-state fixes; use this as a target experience, not a request to duplicate them.
2. Use 201+ permitted same-filter records; reach the oldest unresolved item through bounded server controls.
3. Open a row from page 2, inspect another record, close/back, and retain intended filter, sort and place.
4. Switch Account A→B while A's read is delayed; A's grants never appear actionable as B's.
5. Refuse B's read, then recover; error and result subject remain truthful throughout.
6. Complete one allowed change, refuse one, and simulate a committed save with failed refresh; no duplicate mutation is needed.
7. Check 375/768/1440 px, both themes, keyboard and zoom; test native screen-reader output separately.
8. Compare completion, wrong-record attempts and repeated navigation with the current UI. These are acceptance targets, not measured gains.

Sources: `apps/web/src/ui/DataList.tsx`, `listState.ts`, `DetailDrawer.tsx`, `fold.tsx`; `views/admin/governance/RisksPage.tsx`; `views/admin/integrations/ConnectorsPage.tsx`.
