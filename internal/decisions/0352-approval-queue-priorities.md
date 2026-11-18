# ADR-0352: Approval queue priorities and task-widget contract

- **Status**: Proposed
- **Date**: 2026-11-17

## Owner request

The assigned C3 slice adds priorities, assignee load and an embeddable task-widget contract to the existing approvals queue. Stage deadlines and escalation remain with lane E21 (#891). Design builders own the screens (#453). The priority lifecycle must be declared once and enforced by the server.

## Open-source comparison before implementation

The GitHub primary-source research compared the existing React Query approach (https://github.com/TanStack/query, MIT), Web Components with Lit (https://github.com/lit/lit, BSD-3-Clause), and the separate workflow UI application at https://github.com/temporalio/ui (MIT). All were active at inspection. React Query is already locked in this workspace and supports the future host's existing fetching, pagination and mutation invalidation. Lit adds a second rendering runtime for an API-only slice; the separate workflow application adds another backend/application model. Neither addresses the product-specific approval authorization and audit semantics.

Reuse the existing list contract, database transactions, Zod and ADR-0348 `defineMachine`; add no dependencies, runtime downloads, client engine or task store. The small priority policy and content-free projection are governance semantics specific to this product. A future host should use the existing pinned React Query client, not install a parallel state runtime.

## Decision

- Work-item priority is `low | normal | high | urgent`, default `normal`, stored on the one approvals row. It is separate from assignment-rule matching priority.
- `APPROVAL_PRIORITY_MACHINE` is the sole transition declaration. Admins may change any pending item's priority to another declared level. Expected-current priority and a row lock serialize competing writes. Same-value requests are idempotent. A decided row refuses even a same-value request. All changed values and their audit event commit together.
- Priority never changes decision status, approver eligibility, consent, quorum, assignments or deadline fields. The approval decision lifecycle is not redefined here. Generic machine `by` metadata is not permission enforcement; the route checks admin authorization and the widget blocks events for unauthorized or decided records.
- Existing queue/filter/export scope is reused by the widget and workload. Add a server-side priority filter and explicit numeric priority sort; legacy ordering remains requested date and id. Explicit priority sorting uses requested date and id as deterministic ties and shared bounded offset paging. Requested-date sorting retains the existing cursor contract.
- Workload preserves the assignee buckets and adds per-person open/claimed counts and priority counts. Counts are current visible pending items, not capacity estimates. Claimed group work counts toward its claimant once; unclaimed group work remains a group bucket without inventing a person. Caller visibility applies before aggregation, including delegation, review-role and pooled-approver visibility.
- `GET /v1/approvals/task-widget` returns `approval-task-widget.v1`, the ordinary list paging envelope, and allowlisted ids/kind/status/priority/requested date, assignment references, existing assignment SLA fields, authorized priority lifecycle and links. No user names, object labels, argument previews, workflow context or decision reasons are returned. The host opens the existing Inbox to decide; no widget decision permission is asserted.
- This is a first-party same-origin authenticated JSON/data interaction contract, not a rendered widget, iframe, public endpoint, cross-origin capability, browser credential store or alternate decision route. Existing authentication, CSRF, admission, rate limiting and guarded decision UI still apply. Mutation requires the existing admin route gate as well as its own admin check.

## E21 boundary and UI limitation

Existing assignment `warnAt`, `dueAt`, `slaState`, `breachedAt` and `escalatedAt` are projected as one explicitly named source. Workflow-stage deadlines are explicitly unavailable while the E21 current-entry projection contract is unmerged. No timer, escalation, precedence rule or healthy deadline is invented. A later integration can expose a separately verified source after E21 publishes its current execution-key contract.

No screen is added. Two `KNOWN_UI_GAPS` entries point at #453. The cap and its pinned test remain unchanged: this slice is blocked on the master's UI-gap decision or a design builder closing those gaps. Do not claim READY while that gate fails.

## Validation

Shared machine tests cover every declared move and per-record refusals. Real PostgreSQL tests cover neutral default, authorization, stale/concurrent writes, audit rollback, preservation of consent/decision fields, legacy and priority list behavior, scoped content-free projection/pagination and workload totals. No new bundle or dependency budget is requested.

## As built and outstanding acceptance

The implementation supplies the priority policy, list/filter/export support, workload extension and versioned widget data contract. Nine integration cases pass on a fresh PostgreSQL database, including pooled approvers, declared review roles, delegates, role/team membership and a nonmember, plus audit-failure rollback and competing writes. The shared priority-machine suite passes, and the existing workbench/list-contract compatibility suites pass (52 tests).

Two acceptance boundaries remain explicit: the widget has no rendered host screen (owned by the design builder on #453), and workflow-stage SLA projection is unavailable until E21's current-stage-entry verification contract is merged. Assignment deadlines continue to be exposed as their existing source; this ADR does not claim completion of stage deadline integration. The UI route census reports 75 gaps against the unchanged maximum of 73. The master must resolve that gate before a READY claim. Full-workspace build, bundle measurements and the final exact-head CI result belong in the builder report.
