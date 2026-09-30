# ADR-0139 - Final-call emergency gate for external writes

- Status: Accepted
- Date: 2026-09-30
- Finding: AER-018
- Extends: ADR-0124's AI/MCP execution-mode boundary

## Decision

Deploy, rollback, Git branch/PR/merge, infrastructure remediation, and PM
provider mutations must re-read the deployment execution mode immediately
before the external provider method is invoked. The shared `runExternalWrite`
boundary classifies these write operations. `halted` and `read_only` refuse
them; `require_approval` also refuses because these paths have no per-call
emergency approval queue. Normal mode preserves the existing behavior.

PM methods are wrapped at the one provider-construction boundary, with the
complete provider interface checked by TypeScript. Workflow and infra provider
calls use the same guard directly. A halted deploy or Git stage stays
`awaiting_execution` and can be retried after the stop is lifted. An infra
approval whose provider action is refused rolls back the decision transaction,
leaving its approval and finding pending. An auto-remediation refused by the
mode leaves the finding open with a deferred-attempt marker; the next scan
retries it only if the current policy still permits auto-remediation. Ordinary
open or re-opened findings do not acquire a new automatic retry behavior.

The final-call check narrows the window but is not a lock held across the
external request. A mode change racing after that check can still overlap an
already-starting call, and an already-running provider request is not
cancelled. Incident operators must account for work already in flight.

## Verification and limits

Focused tests cover all classified operations in normal, halted, read-only and
require-approval modes; a structural assertion checks direct deploy/Git/infra
provider methods remain inside the guard. Route tests cover halted deploy,
Git merge, approved and automatic infra remediation, and PM sync, including
retry after lifting the stop. Six focused files passed 31 tests and six
adjacent files passed 43 tests on disposable PostgreSQL databases. Gateway
typecheck passed. These tests use mock providers; a paused-call matrix with
counting live fakes for every adapter and full CI are still outstanding. The
classification inventory is limited to the paths examined here, not a proof
that every future external effect is automatically covered.
