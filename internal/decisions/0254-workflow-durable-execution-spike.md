# ADR-0254: `vercel/workflow` on Postgres does not fit as pillar 2's durable-execution engine; the existing stage runner stays

- **Status**: Accepted. This is a spike verdict under ADR-0176 ("none fits, because …").
- **Date**: 2026-11-07
- **Backlog item**: [PENDING.md](../product/PENDING.md) §2h P30 (owner, 2026-11-07)
- **Prototype**: [`spikes/workflow-p30/`](../../spikes/workflow-p30/README.md). It is behind the default-off switch
  `REGULAIT_WORKFLOW_DURABLE_P30` and no workspace package imports it.
- **Migration**: none. The reserved number 0309 (`when` 1785236000000) is not used and is released.
- **Related**: ADR-0176 (open source first), ADR-0180 (secure by default), ADR-0200 (security checklist),
  ADR-0234 (row-level security), and [WORKFLOW_ENGINE_SPEC.md](../product/WORKFLOW_ENGINE_SPEC.md).

## Context

The owner asked for a time-boxed spike on 2026-11-07. The candidate was `vercel/workflow`: the packages `workflow` 5.4.0
and `@workflow/*`, Apache-2.0, with `@workflow/world-postgres` 5.1.1 as the World. The question was whether it can replace
or underpin pillar 2's stage runner: durable steps, sign-off pauses through hooks with resume, and fan-out. Six pass
criteria were set, and all six were required.

**What the existing runner already does.** It is pure kernel plus gateway, with no polling loop.

- `packages/workflow-kernel/src/index.ts` is the kernel. `transition()` (:747) and `runForward` (:664) are pure state
  machines that return effects. A `human_approval` stage parks the instance at `blocked_on_approval` and emits
  `request_approval`.
- `apps/gateway/src/workflows.ts` `applyEvent` (:151) runs every transition in one transaction. That transaction holds
  `SELECT … FOR UPDATE` on `workflow_instances`, runs the kernel transition, inserts the `workflow_events` row and writes
  the `audit_log` row (:285–304) together. It also inserts the `approvals` rows that sign-off uses and records a
  `workflow_stage` trace span.
- `runGitExecutions` (:1215) claims a stage under a lease kept in `context`. The lease TTL comes from
  `REGULAIT_WORKFLOW_CLAIM_TTL_MS` and defaults to 15 minutes.
- Governance runs twice. `ExecutorHooks.assertTransitionAllowed` is checked at claim (:1260) and again at commit (:2516),
  and a refusal is audited as `workflow:executor-signoff-refused`.
- Resume paths: `applyWorkflowApprovalDecision` (:519), `reopenWorkflowInstance` (:632) and
  `handleNestedRunCompletion` (:919).
- Gaps: there is no fan-out inside a stage, and no automatic retry with backoff. `execution_failed` waits at
  `awaiting_execution` for `/advance`.

## What the spike built and measured

The prototype runs one real pillar-2 sequence on the engine: a requirements artifact, then the requester's sign-off,
then three checks. The real kernel `transition()` runs inside durable steps. The sign-off is a `createHook()` pause
resumed by `resumeHook()` from a product route, and the checks fan out with `Promise.all`. Every step body is wrapped in a
default-deny allow-list. A refusal is a `FatalError`, so it is never retried, and it is recorded. The host is fastify 5.

The suite (7 tests) passed twice, inside `unshare -n`. That namespace has loopback only and no route out, and Postgres is
reached over its unix socket. The output is in `spikes/workflow-p30/evidence/run-2026-11-07.txt`.

| # | Criterion | Result | Evidence |
|---|---|---|---|
| 1 | Runs in the fastify gateway, or as a sibling Node service; the `"use workflow"` transform builds with our toolchain | **Partial pass** | `workflow build --target standalone` needs no framework plugin. It writes Fetch-API handlers (`flow.mjs` 13 MB, step bundle 5.8 MB) that a fastify route can serve through a `Request` adapter. `start({ workflowId }, args)` works from plain Node with the id from `manifest.json`. **However**, the World delivers every workflow and step invocation as an *unauthenticated* POST to `/.well-known/workflow/v1/flow` on loopback, with no signature, secret or caller check (its README says so). The gateway's default-deny auth hooks would refuse that route. Mounting it means an auth exemption in the gateway (against ADR-0180), or a sibling process whose security rests only on a loopback-only listener. |
| 2 | No Vercel endpoints and no runtime downloads; works air-gapped | **Pass, with caveats** | The run and the build both completed with no network. The in-process recorder saw only `unix:` and loopback. **Caveats:** the bundles embed dormant Vercel code: `api.vercel.com/v1/workflow…`, `oidc.vercel.com` and `vercel-workflow.com`. The runtime tree carries `@vercel/oidc`, `@vercel/queue`, `@vercel/functions` and `@workflow/world-vercel`. World selection fails open: without `WORKFLOW_TARGET_WORLD`, the presence of `VERCEL_DEPLOYMENT_ID` selects the Vercel cloud World, and otherwise the local filesystem World is used. The prototype pins the World with `setWorld()`; a production adoption would have to do the same and test it. |
| 3 | Our Postgres, a schema we control, migrations included, with RLS implications for ADR-0234 | **Fail** | It writes to three schemas whose names are hard-coded: `workflow` (`pgSchema('workflow')`), `workflow_drizzle` (its migration journal) and `graphile_worker`. It ships its own Drizzle migrator with 30 upstream migrations. Migration 0008 swapped pg-boss for graphile-worker, and migration 0027 is a timestamp rewrite with no down step. None of this can sit in our hand-numbered journal: watermark guard, `zz-dbguard-0185` and placement tests (CONTRIBUTING_PARALLEL_SESSIONS §4.1). We would have to port every upstream migration by hand at every release. Its tables have no principal key and no RLS. They cannot take ADR-0234's `regulait.user_id` / `system_context` policies, because the World uses its own pool sessions and never calls `withPrincipal`. Step inputs, outputs and hook payloads are stored in plaintext, because this World does not implement `getEncryptionKeyForRun()`. The ADR-0233 content guard does not run on its columns. |
| 4 | An audit hook on every step transition, and our governance checks can wrap each step | **Partial pass** | Every state change goes through `World.events.create` / `createBatch`. Wrapping both caught every requested transition: run, step, hook and completion events. The World writes `step_created` itself inside a `step_started` append, so that event is only derivable. **But the audit row cannot share the event's transaction**, because the World owns it. Ours is therefore an at-least-once *intent* log: `run_started` was audited 3 times for 1 stored row, because of redelivery after the restart. It is not the same-transaction chained `audit_log` row that `applyEvent` writes today. Governance can wrap each step body, and a refusal is final. It cannot gate the World's own orchestration deliveries. |
| 5 | Measured overhead per step | **Fail on cost** | Each step costs about **14–16 ms** (13.74, 14.44, 15.76 and 15.93 ms over 50 sequential no-op steps; 153 events, about 3 per step). The existing runner's write shape (lock, update, event and audit rows in one transaction) costs **0.7–0.9 ms** on the same database, so the engine is about 18× slower. The cost comes from the loopback HTTP hop per delivery, the graphile-worker poll (`pollInterval` 500 ms when idle), CBOR-encoded event rows and replay of the event log. |
| 6 | API stability, given the v4 to v5 change within the year | **Fail** | `workflow` has published 178 versions since 4.0 beta (2025-10-22), with 5.0.0 on 2026-09-30 and 5.4.0 on 2026-11-04. `@workflow/world-postgres` has 130 versions in about 13 months and 30 schema migrations, one of them a queue swap. Upstream calls this World "a reference implementation … not a managed backend" and "highly recommend[s] cloning" it. In practice, adopting it means forking the World. |

**Security checklist (ADR-0200).** `npm audit` reports 28 advisories (23 high). Two of them are reached at run time:

- `zod` <4.6.6, pinned `~4.5.4` by `@workflow/world` and `@workflow/core`;
- `undici` 7.30.0, pinned by `@workflow/world-local`.

Patching either one means forcing versions outside upstream's ranges. "Patched, never allow-listed" would then depend on
overrides that each release can break. The licences are permissive (Apache-2.0 and MIT), but three transitive packages are
outside the ADR-0176 list or undeclared (`spikes/workflow-p30/THIRD_PARTY.md`).

## Decision

1. **None fits.** We do not adopt `vercel/workflow` with `@workflow/world-postgres`. The decisive failures are criteria 3,
   5 and 6, together with the security posture under criterion 1:
   - its schemas and migrations are hard-coded and cannot carry RLS;
   - it is about 18× slower per step;
   - its API and schema churn high, and upstream's own advice is to clone the World;
   - its run-time route is unauthenticated, its audit cannot be atomic with the event, and it pins two vulnerable
     run-time packages.
2. **The existing stage runner stays the engine.** Pillar 2's durability already comes from the pure kernel plus
   `applyEvent`'s single transaction. That keeps the audit row atomic with the transition, which the candidate cannot do.
3. **The two real gaps go to the runner, not to a new engine.**
   - **Fan-out inside a stage:** run an `automated_check` stage's named checks concurrently and commit them as one
     transition.
   - **Automatic retry with backoff:** for a retryable `execution_failed`.

   The open-source candidate for both is **graphile-worker** (MIT, 0.18.0, 2026-09-08), the queue this World itself uses.
   It takes a configurable schema, runs no HTTP hop, and can be driven inside our transactions with `add_job` /
   `addJob`. It is evaluated as a queue under the scheduler (`apps/gateway/src/scheduler.ts`), not as an execution engine.
   pg-boss (MIT) is the fallback.
4. **Patterns borrowed for the follow-up design (owner input, 2026-11-07), from trigger.dev and from this spike:**
   - *Wait-for-token pauses.* A sign-off parks on a named token, and an authenticated route resumes it. This already
     matches `blocked_on_approval` plus `applyWorkflowApprovalDecision`. Spike: `createHook({ token })` / `resumeHook()`.
   - *Idempotency keys* on stage executions and their retries, so a redelivered job never runs a stage twice.
   - *Per-queue concurrency limits* for the fan-out and retry jobs, for example per check kind and per project.

   Each pattern goes into the runner under its own follow-up ADR, with the audit row kept in the transition's
   transaction.
5. **The prototype stays on the branch as evidence.** It sits behind its default-off switch and no package imports it.
   Nothing in `apps/` or `packages/` changes.

### Other permissively licensed durable-execution options (compared, not spiked)

Licences were read from npm on 2026-11-07. A server licence marked † comes from upstream's repository, and must be
re-checked before any re-evaluation.

| Option | Licence | Shape | Fit |
|---|---|---|---|
| **graphile-worker** 0.18.0 | MIT | Postgres job queue, configurable schema, `add_job` callable in SQL | Best fit for retry/backoff and fan-out jobs under our runner (decision 3). It is not durable execution itself. |
| **pg-boss** 12.38.1 | MIT | Postgres job queue, configurable schema | Fallback to graphile-worker. Same role. |
| **DBOS Transact** (`@dbos-inc/dbos-sdk` 5.4.0) | MIT | In-process durable execution on Postgres, with its own system schema | The closest architectural fit: no HTTP hop, and steps can run inside the app's transactions. Worth a separate spike only if decision 3 proves insufficient; its schema and RLS story would need the same criterion-3 check. |
| **Temporal** (`@temporalio/*` 1.25.0) | MIT SDK, MIT server† | A separate server cluster with its own persistence | Works air-gapped, but adds a stateful cluster to every BYOC and air-gapped install (pillar 3). Too heavy for one control plane. |
| **Restate** (`@restatedev/restate-sdk` 1.18.3) | MIT SDK, BSL 1.1 server† | A separate server | Excluded: BSL in shipped code (ADR-0176). |
| **Inngest** (`inngest` 4.26.2) | Apache-2.0 SDK, SSPL server† | A separate server | Excluded: SSPL in shipped code (ADR-0176). |
| **trigger.dev** (`@trigger.dev/sdk` 4.8.3, 2026-10-30) | MIT SDK on npm; Apache-2.0 platform† (owner input, 2026-11-07) | A self-hosted platform: webapp, supervisor, runners, Postgres, Redis, ClickHouse, Electric, a registry and object storage | **Rejected (owner input, 2026-11-07; nothing found here to contradict it).** The stack is heavy for every BYOC and air-gapped install. Telemetry is on unless `TRIGGER_TELEMETRY_DISABLED` is set, which fails ADR-0180. Checkpoints, warm starts and autoscaling are Cloud-only. Its runs, approvals and logs would duplicate our audit trail and Approvals Queue outside the gateway. The SDK licence on npm reads MIT, not the Apache-2.0 given in the owner's note; both are permissive, so the verdict stands. |

## Consequences

- No migration and no production change. Reserved migration 0309 is released.
- The ADR-0176 record for pillar 2's engine is "none fits, because": hard-coded schemas, no RLS, 18× per-step overhead,
  high churn, an unauthenticated run-time route, non-atomic audit, and pinned vulnerable run-time dependencies.
- Follow-up backlog work, not started here:
  - in-stage fan-out for named checks;
  - retry with backoff, over graphile-worker or pg-boss, under the existing runner.

  Each needs its own ADR and must keep the same-transaction audit.
- **Re-open this verdict if** upstream ships one of the following, and the overhead is re-measured:
  - a World whose schema name can be configured, whose migrations can run from a host journal, and whose route is
    signed or runs in-process;
  - `getEncryptionKeyForRun()` support in the Postgres World;
  - an API with no breaking changes for 12 months.
