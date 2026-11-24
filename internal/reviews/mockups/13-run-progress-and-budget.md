# Mockup 13 — Run progress, task recovery and budget context

**Design proposal, 2026-11-24.** Source: main `2d57877b82fbb4c7d9969ffd88ee7ce7805f132e`.
Related: CXR-BRN-PRD-02, CXR-UXP-002/003 and [workflow recovery mockup 03](03-workflow-progress-and-recovery.md).
Use the [shared rules](README.md). This is a proposed presentation of existing run facts and commands,
not an implemented screen, a second orchestration engine or a completed usability/native-device test.

## User task and reason

A person should know what the run has completed, which task needs attention, who is responsible and what a permitted
recovery will do. An approver needs enough evidence to decide without being offered execution authority. The current
graph is useful evidence; lead with plain-language task status and keep its existing ordered-list alternative.

Show recorded usage cost separately from planning estimates and configured caps. A forecast, reservation or worker's
remaining allocation cannot be invented from a status badge or subtraction of unrelated amounts.

## Desktop wireframe — approximately 1440 px

```text
+--------------------------------------------------------------------------------+
| < All runs                                                                       |
| Example run                         Status: Running                              |
| Project: [authorised label]          Your role: run initiator                     |
+------------------------------------------------------+-------------------------+
| Needs attention                                      | Run budget              |
| Example task is blocked.                             | Recorded usage: $2.40   |
| Recorded explanation and prerequisites.              | Configured cap: $10.00  |
| Responsible agent: [loaded agent label]               | Plan estimate: $5.10    |
|                                                      | Basis / scope shown     |
| [Review task recovery]                               | Unpriced tasks: [actual]|
+------------------------------------------------------+-------------------------+
| Tasks in this run                                                                |
| Task                  State            Responsible agent       Next step         |
| Gather references     Done             Example reader          Inspect result    |
| Prepare change        Blocked          Example worker          Review recovery   |
| Check result          Not started      Example checker         Waiting on change |
|                                                                                 |
| [Show task graph]   Existing graph and Steps in order                            |
+--------------------------------------------------------------------------------+
| Selected task: Prepare change                                                    |
| Current state / dependencies / safe failure / recorded output                    |
| Existing permitted choices: Retry / Reassign / Escalate                          |
| Advanced: edit instruction / manual dispatch, only for applicable task states   |
+--------------------------------------------------------------------------------+
```

All figures and task names are synthetic. Counts may describe the complete returned task graph; they are not a
completion percentage, an ETA or a ranking of the next best task. A stopped automatic pass is not necessarily a
terminal run: explain its recorded stopped reason separately from `run.status`.

`Review task recovery` opens that task's existing context. Once recovery is selected, its chosen permitted command
owns the primary action; the run-wide automatic-pass action remains secondary. Do not turn every row into another
page-level primary button. Project/agent labels appear only from authorised facts; an unavailable name is not an
unassigned task.

## Phone wireframe — 375/390 px

```text
+-----------------------------------+
| < All runs       Example run      |
| Running / Run initiator           |
+-----------------------------------+
| Needs attention                   |
| Prepare change: Blocked           |
| Safe reason and prerequisites     |
| [Review task recovery]            |
+-----------------------------------+
| Budget                            |
| Recorded usage: $2.40             |
| Cap: $10.00                       |
| Plan estimate: $5.10              |
| Basis / unpriced coverage         |
+-----------------------------------+
| Tasks                            |
| Gather references · Done         |
| Prepare change · Blocked [Open]  |
| Check result · Not started       |
| [Show graph / Steps in order]     |
+-----------------------------------+

Selected task:
+-----------------------------------+
| Prepare change              Close |
| Blocked / Assigned agent          |
| Why it stopped                    |
| What retry changes                |
| Dependencies / permitted evidence |
| Other recovery options v          |
+-----------------------------------+
| [Retry this task]                 |
+-----------------------------------+
```

Use existing responsive detail/modal patterns. The graph's text alternative remains available; a phone user need
not pan a drawing to find the blocker or budget. Do not hide failures, scope or required consequences in hover help.
If recovery uses a pinned action row, the last field/error remains reachable at zoom and with the software keyboard.

## Command meanings and permission boundaries

| Existing command or condition | User wording and boundary |
| --- | --- |
| Planned run / `start` event | `Start run`; starts this run through its existing lifecycle and budget checks. |
| `/auto` | `Run an automatic pass`; dispatches eligible work under existing caps, instructions and acceptance choice. Explain any edited instructions before sending. |
| Automatic output acceptance | Current UI initialises `acceptReviews=true` and sends it on `/auto`. Keep that choice and its consequence visible before an automatic pass; this mockup does not silently change the existing contract/default. Worker-output acceptance is distinct from independent approval/signature requirements; it cannot decide those requests. |
| Blocked node / `retry_node` | `Retry this task`; reopens this node through the existing transition, rather than claiming that it immediately dispatches work. |
| Blocked node / `reassign_node` | `Reassign task`; choose from the caller's existing granted roster. The server rechecks the initiator's entitlements and lead ceiling. A visible agent is not proof the reassignment will pass. |
| Blocked node / `escalate_node` | `Ask the configured reviewer`; use the existing escalation approval. Do not invent a recipient or send an external message. |
| Node `in_review` / `node_accepted` | `Accept task output`; explain what is being accepted. Keep this separate from a protected tool-call approval. |
| In-progress manual `/dispatch` | Advanced operator recovery only. Explain that it dispatches the selected worker; do not relabel it harmless Resume or infer that a worker is stranded from `in_progress` alone. |
| `abort` event | `Abort run`; existing terminal transition. Explain that it cannot restart and that completed external effects are not automatically reversed. Do not promise remote work was cancelled unless the server proves it. |
| Completed/aborted | Recorded evidence and permitted navigation; no fabricated restart, pause, resume or generic cancel endpoint. |

The detail GET permits a named pending approver to inspect a run; driving endpoints remain initiator/admin-only.
Use existing identity facts for that presentation distinction, retaining every server check. A broader capability
projection requires server work. A reviewer gets an existing Inbox link, not run-driving buttons or an invented
selected-approval URL. Do not require fresh proof for every harmless read; when a command actually requires proof,
reuse its existing action-bound wrapper and keep the submitted run/node/intent fixed.

## Budget facts and missing data

| Figure | Existing source / display rule |
| --- | --- |
| Run cap | `run.budget.capUsd`; a null cap says no configured run cap, not zero. Other governing limits still apply. |
| Recorded usage | `measuredSpentUsd` and `measuredPerNodeUsd`, following the server's defined accounting semantics; not a provider invoice or a financial reconciliation. |
| Planning estimate | Persisted `estimatedTotalUsd`, `perNodeUsd`, `unpricedNodes` and `estimationBasis` in the server `RunBudget`. The web DTO needs to carry these existing fields before showing the richer summary. |
| Node configured cap | `RunGraphNode.budgetCapUsd` and existing graph facts; label scope explicitly. Do not call a configured cap remaining funds. |
| Reservation / per-worker remaining | Not established by the current run-detail contract. Omit or name the unavailable fact; a new authoritative projection is required before promising it. |
| Overage approval | Existing run budget fact and pending approval; present its actual run scope, not a permanent permission to exceed every limit. |

The gateway explicitly defines absent legacy measured fields as zero; that contract is not itself a failed-read bug.
A failed run/budget read is still an error. Never add estimated and measured spend into one misleading total.
An estimated-budget stop, measured-cap stop, iteration cap and node/pass cap have different reasons and recovery.

## State, draft and outcome contract

- Loading is announced; failed/missing/forbidden reads use the existing record convention, with no invented empty run.
- The run and read-only graph fail independently. A graph failure does not hide a valid run's status or allowed work.
- A task's dependency wait, output review, independent approval, budget block and execution error have distinct labels.
- Keep recorded failure/output tied to its task/attempt. Do not show an earlier error as the current worker result.
- Pending commands freeze run/node/intent and exclude repeated or conflicting mutation and dismissal into uncertainty.
  Reuse the shared pending guard; source-only `postEvent` call sites need integration, not a second command engine.
- A refused command retains suitable instruction/reassignment drafts. Ask before discarding edited non-secret work;
  resource/principal changes cannot retarget a draft or late result. Do not persist raw output/instructions globally.
- A committed command with failed refresh keeps its outcome and offers read recovery. An uncertain timeout says its
  result is unconfirmed and reconciles supported state before another write; a toast alone is insufficient.
- Buffered output required by blocking PII/guardrail policy remains buffered. Never render withheld streaming fragments.
  An interrupted SSE stream does not prove that server dispatch, billing or external side effects stopped.

## Source and contract traceability

- [RunDetailPage](../../../apps/web/src/views/runs/RunDetailPage.tsx): current graph, node statuses/errors, command
  call sites, instruction edits, automatic-pass stopped reasons, streaming/buffered paths and abort confirmation.
- [types.ts](../../../apps/web/src/api/types.ts): `RunGraphNode` and `RunDetailResponse`; preserve their identities.
- [RunGraph](../../../apps/web/src/ui/runGraph/RunGraph.tsx) and
  [runGraphModel](../../../apps/web/src/ui/runGraph/runGraphModel.ts): read-only graph, ordered-list alternative,
  per-step actor/status/cost/evidence references; no raw message or tool arguments fetched to improve this layout.
- [orchestration.ts](../../../apps/gateway/src/orchestration.ts): `RunBudget` at 123–150; `loadRunFor` at 2433–2460;
  `/events`, `/dispatch`, `/auto` and detail GET at 2488, 2595, 2667 and 3033. Reuse existing transitions and execution claims.
- Current destinations are `/runs/:runId`, `/runs` and permitted `/inbox`; graph reads use the existing
  `/v1/run-graph/orchestration/:runId`. No new queue, scheduler, worker state machine or notification service is proposed.

## Claude acceptance

1. Exercise planned, running, blocked, review, completed and aborted records; compare each label/action to the server lifecycle.
2. Check initiator/admin, named pending approver and unrelated reader: inspection never grants driving authority.
3. Inspect dependency wait, absent agent label, budget stop, failed dispatch, independent approval and a pass ending early.
4. Retry/reassign/escalate a synthetic blocked task through existing endpoints; preserve exact intent and safe refusal recovery.
5. Hold a mutation response; attempt repeat/opposing action, Escape, close and navigation. Reconcile a timeout or failed refresh without blind replay.
6. Compare cap, recorded usage, planning estimate, unpriced tasks and null/missing fields; never fabricate reservation or per-worker remaining budget.
7. Test edited instructions, late read, agent change, buffered output and stream interruption without lost drafts or false cancellation claims.
8. Use graph and Steps in order by keyboard. At 375/768/1440 px, both themes and zoom, retain focus, labels, reasons and reachable controls.
9. Record native screen-reader, soft-keyboard, IME and actual provider checks separately. User studies are deferred; no measured usability gain is claimed.

These are proposed acceptance checks. This source/design pass performs no real dispatch, approval, abort or budget change.
