# ADR-0250: Grant mints need a step-up, and the plan-only gate is forced at project level

- **Status**: Accepted
- **Date**: 2026-11-07
- **Index**: Grant mints need a step-up; the plan-only gate is forced at project level (whole-build review S-04, P-02)
- **Driver**: the whole-build review of `main` at 6a06dc1 (`internal/reviews/2026-11-07-whole-build-review.md`,
  PR #701), findings **S-04** (medium) and **P-02** (high), dispatched by the master session.
- **Migration**: none. S-04 reuses the existing `settings_relax` step-up kind (no change to
  `STEP_UP_ACTION_KINDS`, the `org_settings.step_up_actions` CHECK or `step_up_grants`). P-02 reads
  `workflow_instances` by `project_id` and status; no new column.
- **Amends**: [ADR-0079](0079-plan-only-stage-enforcement.md) (the plan-only gate's "opt-in" limit is withdrawn) and
  [ADR-0186](0186-batch4-approvals-receipts-detection.md) A (a new `settings_relax` op, `grant_mint`).

## Context

**S-04.** Eight routes widen default deny with only the separation-of-duties check and `admin_only`: person and role
grants of MCP tools, MCP servers' read tools, agents and connectors. Smaller relaxations (adding an egress host,
lifting a revocation, replacing a workload-identity grant set) already need a step-up. Admin API keys can never step
up, so a leaked admin key could widen anyone's access, including its own holder's.

**P-02.** Pillar 2 promises a *forced* plan-only stage. As built (ADR-0079), the gate ran only when a call named its
workflow instance: on `/v1/agents/:id/invoke` it sat inside `if (body.instanceId)`, a test pinned that `execute` with no
`instanceId` returned 200 while the project's instance was planning, `/v1/runs` followed the same opt-in pattern, and
the IDE compat shims (`COMPAT_MODE = "execute"`) and the MCP proxy had no way to name an instance, so they never met
the gate. ADR-0079 disclosed this as an honest limit; it conflicts with ADR-0180 (secure by default) and the pillar text.

## Decision

### S-04: a step-up on every grant mint

Each of the eight POST routes requires a `settings_relax` step-up bound to `{op: "grant_mint", grant}` (helper
`grantMintStepUp` in `apps/gateway/src/step-up.ts`), where `grant` names exactly what is minted:

| Route | `grant` facts |
|---|---|
| `POST /v1/grants/tools` | `{kind: "tool", userId, serverId, toolName}` |
| `POST /v1/grants/servers` | `{kind: "server", userId, serverId, readOnlyAll: true}` |
| `POST /v1/grants/agents` | `{kind: "agent", userId, agentId, allowedModes}` |
| `POST /v1/grants/connectors` | `{kind: "connector", userId, connectorId, mode, allowedObjects}` |
| `POST /v1/roles/:roleId/grants/tools` | `{kind: "role_tool", roleId, serverId, toolName}` |
| `POST /v1/roles/:roleId/grants/servers` | `{kind: "role_server", roleId, serverId, readOnlyAll}` |
| `POST /v1/roles/:roleId/grants/agents` | `{kind: "role_agent", roleId, agentId, allowedModes}` |
| `POST /v1/roles/:roleId/grants/connectors` | `{kind: "role_connector", roleId, connectorId, mode, allowedObjects}` |

- The check runs after validation and the SoD gate (a refused mint never spends a grant) and before the write.
- A grant made for one mint is refused for any other (the digest binds the grantee, the object and the modes).
- An admin API key is refused 403 `step_up_required` with `credential: "api_key"` and `methods: []`. The bootstrap
  credential passes only during first-admin setup (B4S-06), as for every other step-up.
- **Why reuse `settings_relax`:** a mint is a relaxation of default deny, which is what that kind already covers
  (revocation lift, egress additions). A new `grant_mint` kind would need a migration of the `step_up_actions` CHECK and
  the strict default for no extra protection; the `op` in the facts already keeps a mint grant from authorising any
  other relaxation. Removing `settings_relax` from `step_up_actions` (itself a stepped-up, audited relaxation) turns
  this off with the rest.
- DELETE routes stay without step-up: removing a grant narrows access.

### P-02: the plan-only gate is forced at project level, on every surface

`guardProjectPlanOnly` (`apps/gateway/src/plan-only.ts`) keys on the **project** a call is attributed to. While any
live workflow instance of that project rests at a planning stage (`currentPlanningStage`, the kernel's own predicate),
a mutating call is refused **409 `plan_only_stage`**, whether or not it names the instance. The refusal names the
project, the instance, the stage and the exact call that leaves planning, and it is audited on the planning instance's
own trail (`objectType: workflow`, `ruleId: workflow-plan-only-stage`, `detail.enforcement: "project"`,
`detail.surface`).

| Surface | What "mutating" means | Project it keys on |
|---|---|---|
| `POST /v1/agents/:id/invoke` | `!isPlanSafeMode(mode)` | `projectId` (or the conversation's), plus a named instance's project |
| `POST /v1/runs` | any node with a non-plan-safe mode | `projectId`, plus a named instance's project |
| compat (`/v1/chat/completions`, `/v1/messages`) | always (`COMPAT_MODE = "execute"`) | the project header, or an engine key's pin |
| MCP proxy `tools/call` | a WRITE-classified tool; read tools are plan-safe | the project header / `?project=` |

The ADR-0079 instance-attributed gate is unchanged and still runs first when a call names its instance.

**The one exception (audited).** The workflow engine's own work for an instance at an executable stage is not stopped
by *another* instance of the same project resting in planning. That is: the nested build-stage run
(`workflows.ts`, `planRun(..., {engineInstanceId: instance.id})`) and any call made with an engine run's key
(`engineKeyWorkflowInstance`: `virtual_keys.engine_run_id` → `engine_runs.workflow_instance_id`). Each pass under the
exception writes an `allow` row `workflow-plan-only-engine-exception` on the planning instance's trail. The engine's
work is still refused when its **own** instance is in planning. Without this exception, two changes in one project
could not proceed concurrently: one change's build would wait for every other change's planning to finish. No other
flow was found that needs execute during planning: the seed leaves plan-only before it dispatches.

## Consequences

- A leaked admin API key can no longer mint grants. Grant administration happens in a signed-in browser session with a
  fresh second factor, like the other relaxations. The admin UI's grant buttons go through `withStepUp`, and the demo
  seed mints its grants during first-admin setup (before Ada enrols), reporting rather than forcing a mint it cannot
  re-send on a re-seed.
- "Forced" now holds on every surface for every **attributed** call. Calls that cannot name a project are covered by
  attribution policy: compat and MCP refuse an unattributed call by default (`requireProjectAttribution`,
  `requireMcpAttribution`, ADR-0181), and an admin who relaxes those (audited) accepts that unattributed calls meet no
  plan gate.
- **Honest limits.**
  - An invoke or run that names **no project** (and no instance) has nothing to key on and is not plan-gated. The
    invoke path has no project-attribution requirement today; making one mandatory is a separate decision.
  - An instance created **without a project** can only be gated by naming it (ADR-0079), as before.
  - A run's worker loop is gated when the run is planned, not on every tool call it makes: a run planned before an
    instance of its project entered planning keeps running.
  - The MCP session reads the engine-key exception once per session; the planning state itself is read on every
    `tools/call`.
  - The project lookup filters `workflow_instances` by `project_id` and non-terminal status without a dedicated index
    (no migration in this batch); add a partial index if the table grows large.
- Test setup: about 180 gateway suites mint grants in setup with the bootstrap credential, which passes a step-up only
  while no admin can give one, and the shared test database may hold such an admin left by an earlier file. The
  setup file `testing/bootstrap-grant-mint.ts` repeats such a mint once inside `relaxStepUpAround` (what suites already
  do by hand for egress relaxations), and ONLY when the refusal is the bootstrap credential's own; API-key and session
  mints, and every other refusal, reach the test unchanged. It hooks app instances through Fastify's `fastify.initialization`
  diagnostics channel and loads no gateway module at setup time, so a suite's own `vi.mock()`s still apply. It relaxes
  the suite database (`DATABASE_URL`) only; the twelve suites that run on their own scratch database and enrol their own
  steppable admin wrap their bootstrap mint in `relaxStepUpAround(db, ...)` by hand.
- Tests: `adr0250-grant-mint-step-up.test.ts` (all eight routes: admin API key refused, no grant refused, another
  mint's grant refused and unspent, the exact grant allowed and spent); `plan-only.test.ts` (the opt-in regression test
  is replaced by one asserting the refusal; naming another instance does not get round a planning one; the run path;
  the engine exception); `adr0250-plan-gate-surfaces.test.ts` (compat and MCP).
