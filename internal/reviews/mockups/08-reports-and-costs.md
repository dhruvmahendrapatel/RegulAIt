# Mockup 08 — Reports and costs with clear scope and retained evidence

Status: design proposal for Claude, not an implemented screen, a real financial reconciliation or completed user test.
Source snapshot: `b5f88e79e4a8d25432f4ec70bc0ad811751e492c`.
Traceability: REV-001..005, CST-001..006, UXP-002..006 and the recorded owner decisions on retention, date bounds and mapping reasons.

## User task and design intent

An administrator generates a scoped report, understands what its figures mean, and can find the same recorded run later.
A cost analyst compares estimated usage cost and imported reported cost without mistaking an estimate, unknown value or changed attribution for a bill.
The primary action belongs to the selected task; schedules, exports and archive remain deliberate secondary work.

## Desktop wireframe — approximately 1440 px

```text
+----------------------+------------------------------------------------------------+
| Existing suite rail  | Reports                                [Generate report]  |
|                      | Inspect recorded figures and retain their evidence.        |
|                      |                                                            |
|                      | [Report runs]  [Definitions]  [Schedules]                   |
|                      | Scope [Project A v]  Period [This month v] [Apply filters]  |
|                      |                                                            |
|                      | Definition       Generated     Scope      Action           |
|                      | Monthly review   22 Nov, 09:00 Project A  Open report →    |
|                      | Monthly review   21 Nov, 09:00 Project A  Open report →    |
|                      | ... bounded history ...                                    |
|                      | [Previous]  1–10 of 36 authorised runs  [Next]             |
|                      +------------------------------------------------------------+
|                      | Recorded report: Monthly review                            |
|                      | Period: 1–22 Nov · Project A · Generated 22 Nov, 09:00 UTC  |
|                      |                                                            |
|                      | Estimated spend      Governed calls    Approval decisions |
|                      | $42.10               320               18 decided         |
|                      | List-price estimate  Current run total  4 pending         |
|                      |                                                            |
|                      | Median approval time: 12 minutes · measured on 18 decisions|
|                      | Evidence/coverage notes …                                  |
|                      | [Export CSV] [Download signed bundle]                      |
+----------------------+------------------------------------------------------------+
```

The example values are synthetic. Display only fields actually carried by the stored payload, with their real denominator/window.
Usage-derived spend remains a list-price estimate: retain the stored disclaimer beside the amount,
not just in exported evidence. It is not a provider bill or verified financial reconciliation.
An unavailable median reads `Not measured`, not `0 minutes`. Do not recompute today's figures into a historical run.
If the server cannot supply the shown count/filter, label the limit honestly until that contract is implemented.

## Phone wireframe — 375/390 px

```text
+-----------------------------------+
| Menu  Reports              Search |
| [Generate report]                 |
| [Report runs v]                   |
| Scope: Project A                  |
| Period: This month     [Filters]  |
+-----------------------------------+
| Monthly review                    |
| Generated 22 Nov, 09:00 UTC        |
| Scope: Project A                  |
|                      Open report →|
+-----------------------------------+
| [Previous]  1–10 of 36    [Next]  |
+-----------------------------------+

Open report → existing detail surface:
+-----------------------------------+
| ← Back to reports             [×] |
| Monthly review                    |
| Recorded period: 1–22 Nov UTC      |
| Scope: Project A                  |
| Generated: 22 Nov, 09:00 UTC       |
| Estimated spend: $42.10             |
| List-price estimate               |
| Governed calls: 320               |
| Approvals: 18 decided · 4 pending  |
| Median time: 12 minutes           |
| Evidence/coverage notes …          |
| [Export CSV] [Signed bundle]       |
+-----------------------------------+
```

Keep units, period and scope next to the figures at phone width; do not hide them in hover help or a download.
Use the current page/dialog mechanism consistently; a new drawer is optional reuse, not a required duplicate report viewer.

## Generate and schedule

The generation panel asks for the existing definition and permitted scope before submission.
Show the resolved period and what will be included. Submission is guarded once; failure retains the non-secret choice.

| Situation | Copy and action |
| --- | --- |
| Generating | `Generating report…`; preserve focus and prevent repeat activation. |
| Recorded success | `Report generated. These are the figures recorded for this run.` Link to its stable run record. |
| Unknown outcome | `Generation is not confirmed. Check recent runs before trying again.` Do not blindly replay. |
| Configured scheduler | `Automatic scheduling is configured.` Show latest evaluation separately when available. |
| Scheduler unavailable/off | `Automatic scheduling is unavailable/off.` Explain the supported operator path truthfully. |
| No successful run yet | `Not generated yet.` Do not claim that no driver exists. |
| Health unknown | `Scheduler health could not be read.` Offer recovery without inventing healthy status. |

Configuration is not proof of health. Reuse the existing scheduler; never add a second browser timer or imply scheduling approves actions.

## Archive with evidence retained

Owner direction is now implemented in the archive contract: `reporting.ts:745–810` archives under a row lock,
stops schedules transactionally, retains runs and audits the change. Legacy DELETE also invokes archive.
`ReportsPage.tsx:487–519` already confirms the named consequence. Reuse this implementation; independent runtime retest remains open.

```text
Archive “Monthly review”?
This definition leaves the active list. Its recorded runs and signed evidence remain available.
Schedules stop; recorded runs remain available.
[Cancel]                                      [Archive definition]

After confirmation:
Definition archived. Recorded runs are kept. [View recorded runs]
```

The implemented archive contract stops schedules; do not promise restoration or resumption without a supported transition.
The current include-archived control and existing run history preserve discoverability without another whole screen.
Authorised historical links continue to work. Retaining a payload never bypasses current read permission checks.

## Cost view — an explicit date and number contract

```text
Cost consolidation
Group by [Cost centre v]  (current choices: person / cost centre)
From [1 Nov]  Through [22 Nov]  Timezone: UTC       [Apply period]
Includes the whole final day: 1 Nov 00:00 to 23 Nov 00:00 UTC, end exclusive.

Subject        Estimated usage cost       Imported reported cost      Action
Example centre $42.10                    $38.00                      Open →
Unattributed   $3.20                     Not attributable            Review →

Estimated usage and imported reported cost remain separate. They are not added together.
```

Current consolidation groups by person or cost centre; project grouping is not part of that contract.
Use the current inclusive-date conversion at `CostConsolidationPage.tsx:320–326,400–410`, not another date helper.

`Through` implements the owner's inclusive calendar-day instruction; translate it once into the existing exclusive API boundary.
Show the resolved server window and use the identical period/scope for export. Validate reversed dates before submission.
Unknown/mixed-currency/unpriced figures stay named as such. Effective budget approval uses the server's current-period fact, not an old approval latch.

## Mapping removal — review the attribution consequence

```text
Remove this account mapping?
Stored imported lines will be re-evaluated. Some attribution may change.
Reason (required, audited) [                                      ]
Affected lines: [authorised preview, or “Not calculated before removal”]
[Cancel]                                             [Remove mapping]

Mapping removed. Attribution changed for 8 of 24 evaluated lines. [Review results]
```

Changed/evaluated counts appear only from a confirmed response, not a client estimate. Never invent a preview API or substitute a zero count.
A current remaining gap is reproduced as CXR-CST-006: `ReasonModal` can submit Remove twice and dismiss while
the responses are unresolved. Integrate the existing single-flight guard and shared busy modal contract; bind
reason/target to the pending attempt, keep focus, and reconcile an uncertain outcome before permitting another write.

The reason-required server contract now exists (`cost-import.ts:955–964,1000–1009`), as do returned impact counts
and refused-removal draft retention. Reuse it; do not add another cosmetic required input or removal endpoint.
Amounts/currencies and audit history are not rewritten to make reattribution look harmless. Read-only users receive an explanation, not removal controls.

## Failure, focus and accessibility

| State | Expected behaviour |
| --- | --- |
| Initial loading | Announced skeleton/unknown metrics; no fabricated totals, schedules or zero approvals. |
| Empty successful history | `No report runs match these filters.` Preserve scope and offer filter recovery. |
| Read failure | Inline `Reports could not be loaded.` with Retry; keep the last authorised scope explicit. |
| New period loading over old figures | Label `Previous period — refreshing`; keep its dates visible and prevent export under the new period label. |
| Permission refused | Explain access loss and provide an authorised back route; no record-existence leakage. |
| Partial payload | Render available recorded sections; identify missing/unmeasured sections, including workflow metrics. |
| Mutation pending | Preserve focus, block duplicate activation and prevent dismissal into an uncertain result. |
| Recorded mutation, failed refresh | Preserve its outcome; offer refresh, not another archive/removal/generation. |

Use existing dialog/drawer focus return, nested-layer handling and dirty-draft prompts. Error summaries link to labelled fields.
Use text with state colour, readable units, current versus recorded timestamps and the existing spacing/typography tokens.
At 375/768/1440 px, retain period/scope/critical notes and ensure pinned actions do not cover content; test both themes and keyboard separately.

## Reuse, gaps and Claude acceptance

Reuse `ReportsPage`, `ReportsHistory`, `CostConsolidationPage`, `DataList`, existing report exports, `QueryGate`, `RefusalNotice`, `ConfirmModal`/`ReasonModal` and `useApiAction`.
Archive/retention, schedule cessation, required audited removal reasons, inclusive final dates and a shared stored-payload renderer
are now present. `ReportPayloadView` serves immediate and historical results (`ReportsPage.tsx:466`, `ReportsHistory.tsx:35–70`);
validate/refine it instead of building another renderer. History currently filters by definition; the project/period controls
illustrated above require an explicit scoped filter/count/export contract. Any additional scheduler-health data remains a gate.
No parallel report aggregation or state helper is proposed.
Existing APIs: `/v1/reports/overview`, `/v1/reports/runs`, `/v1/reports/runs/:id` and its export, definition generation/schedules, `/v1/cost-consolidated`, and cost-import mapping/domain-rule routes.
Use run-scoped exports for recorded evidence; cost CSV reuses the resolved consolidation query. Do not substitute an overview export for the selected run.
Source components live under `apps/web/src/views/admin/cost/`; shared mutation guards come from `views/admin/adminKit.tsx`.

1. Verify fresh and reopened runs show the same recorded workflow/spend figures and null medians honestly.
2. Archive a synthetic definition with stored runs; prove retention, authorised findability and declared schedule behaviour.
3. Inspect scheduler on/off/unknown states without falsely claiming a timer or successful sweep.
4. Review one calendar day at month/year boundaries; UI and CSV use the same resolved inclusive-day period.
5. Refuse a mapping removal and preserve its reason; complete another and display returned reattribution counts.
6. Test partial failure, committed-save/failed-refresh and uncertain timeout without duplicate mutations.
7. Complete the same tasks at phone width and by keyboard; native screen-reader/provider delivery checks remain separate acceptance work.
