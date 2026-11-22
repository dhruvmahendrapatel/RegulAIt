# Mockup 03 — Workflow progress and recovery

**Design proposal for Claude; not an implemented screen or an executed workflow.**
Source reviewed: main `6d81348a543cf923dbd6fb9e45e8f70206c95ce4`.

## User task and intended improvement

A user should know where a change has reached, why it is waiting, who may act and what the next safe action
is. A failed attempt needs a recovery path with the existing execution guarantees. Keep readable progress
for reviewers without offering them initiator-only operational controls.

Routes: `/workflows`, `/workflows/:instanceId`; link to the existing `/inbox` and permitted run detail.
Traceability: WFL-001..004, UIW-07/08, APR-002 and UXP-002/003/006 in [the review record](../codexreviews.md).
The stages below are a synthetic example; render the stored template's actual stages.

## Desktop wireframe — 1440 px

```text
+--------------------------------------------------------------------------------+
| Workflows / Example change                                                      |
| Example change                                      Help                        |
| Project: Example project   Your role: initiator                                  |
+--------------------------------------------------------------------------------+
| Intake  [done] -> Plan [done] -> Sign-off [done] -> Build [needs attention]        |
| -> Checks [not started] -> Delivery [not started]                                |
+----------------------------------------------------+---------------------------+
| Build needs attention                              | Change summary            |
| The last attempt ended without completing this     | Requested scope           |
| stage. No new attempt is running.                   | Current template version  |
|                                                    | Evidence / recorded input |
| What happened                                      |                           |
| Safe failure explanation from the executor.         | Related records           |
| Last attempt: recorded time / status                | [Open run]                |
|                                                    | [Open inbox]              |
| Before retrying                                    |                           |
| Required configuration and authority summary.       | [Show recorded events]    |
| The server will recheck these conditions.           |                           |
|                                                    |                           |
| [Retry build stage]  View previous attempt          |                           |
+----------------------------------------------------+---------------------------+
| Advanced actions [Expand]                                                       |
| Abort change: stops future progress; completed external effects are not undone.  |
+--------------------------------------------------------------------------------+
```

`Retry build stage` appears only when the server permits that operation and no attempt is already running.
A visible error string is not proof of retry eligibility. Where safe retry facts are not available, show
`Check current status` or the actual operator/prerequisite route until the server contract supplies them.
Keep technical evidence expandable; keep the failure, scope and consequence visible.

## Phone wireframe — 375/390 px

```text
+---------------------------------+
| < Workflows                     |
| Example change                  |
| Example project / Initiator     |
+---------------------------------+
| Current step: Build             |
| Needs attention                 |
| [View all stages]               |
+---------------------------------+
| Last attempt did not complete.  |
| No new attempt is running.      |
|                                 |
| What happened                   |
| Safe failure explanation        |
| [View previous attempt]         |
|                                 |
| Before retrying                 |
| Required prerequisite summary   |
|                                 |
| [Retry build stage]             |
+---------------------------------+
| Evidence               [Expand] |
| Advanced actions       [Expand] |
+---------------------------------+
```

Use a vertical stage list in `View all stages`; do not compress a long rail into unreadable labels or
sideways page scroll. Retain the current stage's state, next action and failure summary outside the
collapsed list. A page action need not become a sticky footer if it would obscure content or the keyboard.

## State and copy contract

This is a presentation mapping to the stored definition, existing server lifecycle and execution-attempt
facts. It does not define another product transition table.

| Authoritative condition | Presentation and next permitted action |
| --- | --- |
| Initial loading | `Loading change status…`; announced busy region and a skeleton. |
| Empty list | `No changes match these filters.` Offer permitted intake or reset filters. |
| Read failure | `We couldn't load this change.` `Retry`; retain context and a back link. |
| No access | `You don't have access to this change.` Return to visible workflows; do not show cached restricted evidence. |
| Planning | `Planning is required before work can continue.` Show actual safe modes/scope; initiator gets `Finish planning`. |
| Artifact needed | `Requirements are needed before sign-off.` Eligible user gets labelled input and `Submit requirements`. |
| Approval needed | `Waiting for an authorised reviewer.` An eligible reviewer can `Open inbox`; other readers see the wait. |
| Executor actually running | `Build is running.` `View run`; no additional retry button. |
| Automatic retry scheduled | `Another attempt is scheduled for [recorded time].` Explain who can change it, if anyone. |
| Retry exhausted or unconfigured | `Build needs attention.` Show prerequisite and permitted manual recovery. |
| Missing check results | `Waiting for check results.` Name the missing checks; never show them as passed. |
| Required proof | Existing action-bound proof dialog names the change and operation; draft/input remains fixed. |
| Recovery request pending | `Starting another attempt…`; suppress repeated activation and conflicting actions. |
| Recovery cancelled before submission | `No new attempt was requested.` Keep the failure evidence and suitable input. |
| Uncertain request timeout | `We couldn't confirm whether another attempt started.` `Check current status`; no blind replay. |
| Durable decision, failed execution | `Decision recorded. Build needs attention.` Show the actual recorded decision separately. |
| Completed | `Change completed.` Show recorded delivery evidence and whether any step was a dry run. |
| Aborted | `Change stopped.` State that completed external effects were not automatically undone. |

Do not manufacture a countdown, retry schedule, success percentage or completion time from missing fields.
An old failure can remain in history after a successful retry; it must not be styled as the current attempt.

## Reviewer and initiator are different views

```text
Example change / Your role: reviewer
You can inspect this change and review its assigned approval.
Only the initiator or an administrator can advance execution.
[Open inbox]  View evidence
```

Never solve a disabled-driving control by granting reviewers extra rights. Use a safe capability projection
where available, then recheck every mutation server-side. If the inbox has no supported selected-request
deep link, link to its existing route and preserve a readable change reference; do not invent a new URL
contract or pretend an unsupported filter works.

## Intake and recovery should not silently change the task

- Preview routing against the actual caller/project/change facts; label a candidate preview as provisional.
- A path-only or classification-based route must not be ruled out by an empty change-type enumeration.
- Keep server-derived role and classification facts server-derived; do not let the user choose authority.
- Show any fixed path/environment scope explicitly until the form/API supports choosing it.
- Preserve non-secret requirements after refusal; bind text and pending requests to the workflow/stage identity.
- A metadata refresh must not replace an edited template definition. Deliberate starter changes ask before discard.
- Abort is a distinct destructive action with the existing named consequence dialog, not a generic Close action.

## Existing components and capability dependencies

| Reuse now | Required integration or data before promising the mockup |
| --- | --- |
| `WorkflowDetailPage`, stored definition and current stage | Safe effective driving/retry capabilities and authoritative attempt/schedule facts if absent. |
| Existing `/advance` executor recovery | Reuse execution claims/idempotency and prerequisite checks; never call a second executor. |
| `Stepper`/status badges and existing stage rail | Project the actual definition; never use a visual stepper as a state engine. |
| `RecordError`, `RefusalNotice`, `QueryGate` | Safe recovery descriptions and record links; redact untrusted upstream detail. |
| `AbortWorkflowDialog` | Keep terminal-state, initiator/admin authority and side-effect warnings. |
| Existing checks, artifacts, PM links and decision cards | Display recorded evidence instead of recomputing a historical success from current data. |

Source entry points: `apps/web/src/views/workflows/{WorkflowsPage,WorkflowDetailPage,workflowAbort}.tsx`,
`apps/web/src/ui/{Stepper,RefusalNotice,kit}.tsx`, `apps/gateway/src/workflows.ts`,
`packages/workflow-kernel/src/index.ts` and the existing shared state-machine helper.
No new timer, retry queue, state helper or production deployment action is proposed here.

## Keyboard, focus and draft behaviour

- Page title, current stage and safe outcome use semantic headings and text, not colour alone.
- Announce stage changes without stealing focus from typed requirements or repeatedly reading the entire history.
- In a modal proof/confirmation, use existing focus trapping and return focus to its exact opening action.
- Dirty drafts ask before discard; a pending mutation cannot be dismissed into an ambiguous outcome.
- Keep failure/success messages linked to the attempted stage and bind errors to the corresponding field.
- At 200%/400% zoom, long explanations wrap and the next permitted action remains reachable.

## Claude implementation and acceptance sequence

1. Reuse merged pending/dirty/focus fixes and inventory current server capabilities before changing labels.
2. Map planning, artifact, approval, running, scheduled and failed states to the existing shared lifecycle facts.
3. Add truthful current-attempt copy and retain earlier attempt history separately.
4. Implement permitted recovery through `/advance`; protect it from duplicate or conflicting requests.
5. Exercise a retryable failure, an actually running attempt, an exhausted schedule, a missing check and a signing/prerequisite refusal.
6. Exercise admin/initiator, named reviewer/delegate and denied-reader fixtures; actions match authority.
7. Test a timeout after a possibly committed retry; status reconciliation does not resend it blindly.
8. Test failed artifact submission, late metadata and tab/back navigation without losing suitable input.
9. Validate 375/768/1440 layouts, both themes, keyboard and native accessibility separately from mock execution tests.
10. Record the fixing SHA and independent retest. These Markdown examples do not prove an external build or deployment succeeded.
