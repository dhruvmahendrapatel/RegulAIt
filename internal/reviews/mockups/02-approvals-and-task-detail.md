# Mockup 02 — Approvals and task detail

**Design proposal for Claude; not an implemented screen or a completed usability test.**
Source reviewed: main `6d81348a543cf923dbd6fb9e45e8f70206c95ce4`.
Use synthetic requests only when prototyping. Reuse fixes already merged on main.

## User task and intended improvement

A reviewer should find a request, understand its scope and their authority, make one deliberate decision,
and know what happened afterward. An administrator needs fleet visibility without confusing it with
permission to decide every request. Replace ambiguous table actions and success-only toasts with clear
record context and a durable outcome. Keep a dense queue for experienced users.

Routes: `/inbox`, `/admin/approvals`, `/admin/review-workbench`.
Traceability: APR-001..003, WBK-001..005, UIW-06, UXP-002/003/005/006 in
[the review record](../codexreviews.md).

## Desktop wireframe — 1440 px

```text
+--------------------------------------------------------------------------------+
| Approvals                 Search visible requests               Help            |
| Review requests you are permitted to see.                                        |
+-----------------------------------------------+--------------------------------+
| Status [Pending v]  Kind [Any v]  Scope [Any v] | Request A                 [Close]|
| Order [Oldest first v]  [Apply filters]        | Project: Example project        |
| 1-10 of 24 visible requests     [Refresh]      | Pending decision                |
|                                               | Your role: named reviewer       |
| Request / Scope      Waiting     Next step    |                                |
| > Request A          40 min      [Open]       | What you are approving          |
|   Project change                              | Read project records.           |
|   Request B          55 min      [Open]       | No write operation is included. |
|   Tool action                                 |                                |
|   Request C          1 hour      [Open]       | Evidence             [Expand]   |
|   Project change                              | Target / payload / expiry       |
|                                               | Current proof policy shown here |
| [Previous]  Page 1  [Next]                     |                                |
|                                               | Decision reason (optional)      |
|                                               | [                            ]   |
|                                               +--------------------------------+
|                                               | [Approve request]  Deny  Close  |
+-----------------------------------------------+--------------------------------+
```

The example is an ordinary request. For a tool action, replace its summary with the existing exact-action
review: target, operation, resource scope, expiry, payload and signing requirement. Never replace that
review with the example's short read-only description. Do not imply that all requests permit writes.
The queue's `Open` links are navigation, not competing primary decision buttons.

## Phone wireframe — 375/390 px

```text
+---------------------------------+
| Approvals               Search  |
| [Filters: Pending, oldest first]|
| 24 visible requests   [Refresh]  |
+---------------------------------+
| Request A                       |
| Project change / Example project|
| Waiting 40 min          [Open]  |
+---------------------------------+
| Request B                       |
| Tool action / Example project   |
| Waiting 55 min          [Open]  |
+---------------------------------+
| [Previous]  Page 1  [Next]       |
+---------------------------------+

Open -> existing narrow-screen modal drawer:
+---------------------------------+
| Request A                Close  |
| Pending / Named reviewer        |
| Project: Example project        |
|                                 |
| What you are approving          |
| Scope and consequences          |
| Evidence               [Expand] |
| Decision reason (optional)      |
| [                             ] |
+---------------------------------+
| [Approve request]  Deny         |
+---------------------------------+
```

The phone drawer keeps background content inert and its action row reachable. Its body scrolls; the
footer must not cover the last field at zoom or when the software keyboard opens. Closing restores the
queue position and focus to the originating request, rather than scrolling to its first row.

## State and copy contract

These are display mappings over existing query, decision, signature and lifecycle facts, not new server states.

| Condition | Copy and available action |
| --- | --- |
| Initial loading | `Loading requests…`; skeletons and an announced busy region, no invented zero. |
| Confirmed empty | `No pending requests in this view.` Secondary: `Change filters`. |
| Failed queue read | `We couldn't load these requests.` `Retry`; keep the selected filter. |
| Forbidden record | `You no longer have access to this request.` Return to the permitted queue; no approval controls. |
| Other reviewer required | `Another reviewer must decide this request.` Show the permitted inspection/request route. |
| Own protected action | `Someone else must review your request.` Never offer an admin override where the server forbids one. |
| Proof required | Existing proof dialog: `Confirm this decision for Request A.` Keep target and reason fixed. |
| Proof cancelled | `No decision was sent.` Restore the reason and focus; do not mark the request decided. |
| Mutation pending | `Recording decision…`; freeze its IDs, decision and reason; disable both opposing decision controls. |
| Final decision recorded | `Decision recorded.` Show its status and a deliberate `Review next request` navigation action. |
| Partial quorum | `Your approval is recorded. Waiting for another reviewer.` Do not invite the same principal to vote again. |
| Downstream failure after commit | `Decision recorded. Execution needs attention.` Link to the permitted workflow/run; no second approval POST. |
| Decision saved, refresh failed | `Decision recorded. The queue could not refresh.` `Refresh queue`; stale controls remain locked. |
| Uncertain timeout | `We couldn't confirm whether the decision was recorded.` `Check current status`; do not replay blindly. |

Reason wording and required status follow the request's actual rule. If override or self-review needs a
reason, label it `Decision reason (required)` and explain why beside the field. Both approval and denial
must honour the same server-required inputs; do not make every ordinary request require a reason.

## Bulk completion must survive an empty queue

```text
Last batch / 3 selected requests
2 decisions recorded / 1 refused
Request A  Recorded
Request B  Recorded
Request C  Not changed: another reviewer already decided it
[View current requests]  Dismiss result

Current queue: No pending requests in this view.
```

Render that outcome independently of the current queue. Bind it to the submitted batch, never to a newly
changed selection. Keep individual signature/quorum requirements, sensitive-project exclusions and the
configured batch cap. A shared proof cannot stand in for required individual action signatures.

## Existing components and data dependencies

| Reuse now | Contract or integration still to complete |
| --- | --- |
| `DataList`, server paging, filters and export conventions | Admin queue adoption of the bounded list contract; preserve visibility in rows/counts/export. |
| `DetailDrawer` and `DrawerActions` | Integrate existing approval review content without a second decision endpoint. |
| `McpActionReview`, `QuorumProgress`, `signedDecision` | Use current target/expiry/payload and caller vote facts; add safe effective capability facts if missing. |
| `ReviewPanel` for intake sign-offs | Preserve its special role, risk-acceptance and outcome rules rather than flattening it into generic approval. |
| `RefusalNotice`, `RecordError`, query invalidation | A typed durable decision outcome must retain execution/evidence/mirror warnings. |
| Shared server state-machine and existing `decideOne` path | Render permitted actions from actual authority; never infer authority merely from queue placement. |

Source entry points: `apps/web/src/views/inbox/InboxPage.tsx`,
`apps/web/src/views/admin/governance/ApprovalsAdminPage.tsx`, `ReviewWorkbenchPage.tsx`,
`apps/web/src/views/approvals/{McpActionReview,ReviewPanel,QuorumProgress,signedDecision}.tsx` or `.ts`,
`apps/web/src/ui/{DataList,DetailDrawer,RefusalNotice}.tsx`, and gateway approval routes in `app.ts`/`workbench.ts`.
Verify each filename when implementing; this plan proposes no new route registry or dependency.

## Keyboard, focus and draft behaviour

- Native link/button semantics; keep table row and column relationships meaningful.
- Opening a request focuses its heading; retargeting updates the heading and resource context together.
- An innermost proof/confirmation closes before the containing drawer. Return focus to the correct trigger.
- Keep suitable non-secret reason drafts per request. Clear them on an account boundary or confirmed submission.
- Ask before discarding a dirty edit; block dismissal during an unresolved protected mutation.
- A multiline reason's Enter key adds text. Approval requires deliberate activation of its own control.
- Announce pending and outcome changes without repeatedly stealing focus. Text conveys state alongside colour.

## Claude implementation and acceptance sequence

1. Check merged CX work and reuse the current kit before changing call sites.
2. Map one ordinary, one tool-call and one intake request to the correct existing decision paths.
3. Add the context block and explicit navigation semantics; retain filters/page/scroll on close.
4. Integrate authoritative queue refresh, partial quorum and durable outcome presentation.
5. Exercise success, refusal, proof cancellation, post-commit warning and uncertain timeout at the same request identity.
6. Exercise a last-item bulk result and an opposing click while the first batch is pending; no duplicate request is sent.
7. Check admin, named reviewer, delegate, own-call and read-only cases; inaccessible data never leaks through totals.
8. Validate keyboard and 375/768/1440 layouts in both themes, including zoom and long reasons.
9. Record the fixing SHA and independent retest against the linked feedback IDs; a wireframe is not closure evidence.

## 2026-11-24 follow-up — pending drawer dismissal

At main `2d57877b82fbb4c7d9969ffd88ee7ce7805f132e`, four mocked keyboard probes at 375/768 px in both themes
found the action row reachable and opposing decisions locked while pending, but Escape still closes the drawer
before the response arrives. This is additional consumer evidence for the existing pending-action cause, not a
new decision protocol. Integrate the current shared busy/close guard and keep submitted identity/outcome visible.
See [iteration 10](../codexreviews.md#continuing-review--iteration-10-2026-11-24-claude-response-and-prioritised-next-steps)
and its phone evidence. No native soft-keyboard/screen-reader or actual decision was tested.
