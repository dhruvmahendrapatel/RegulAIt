# RegulAIt — Multi-Agent Orchestration Spec (P0 Pillar 7)

> Source: original specification authored during bootstrap planning (2026-07-24), prompted by
> the third feature report (`atlas-cursor-lovable-feature-report_4.md` §14) and commissioned by
> [ADR-0008](../decisions/0008-eight-p0-pillars.md) — synthesized from gaps identified across
> Atlas, Cursor, Lovable, and HyperLocal (see [VISION.md](VISION.md)).

> **This is a co-equal P0 pillar, not a bolt-on feature.** Per
> [ADR-0008](../decisions/0008-eight-p0-pillars.md) (2026-07-24), multi-agent orchestration
> escalates to sit alongside [GOVERNANCE_LAYER_SPEC.md](GOVERNANCE_LAYER_SPEC.md),
> [WORKFLOW_ENGINE_SPEC.md](WORKFLOW_ENGINE_SPEC.md), and
> [TOKEN_OPTIMIZATION_SPEC.md](TOKEN_OPTIMIZATION_SPEC.md) among RegulAIt's eight non-negotiable
> architectural pillars (see [CLAUDE.md](../../CLAUDE.md) and [VISION.md](VISION.md)'s banner).
> Design principle, unchanged from the other pillars: orchestration is a **capability layered on
> top of** governance and cost control, never a way around them — delegating work to a team of
> agents must never delegate away accountability for what any single agent is allowed to do or
> spend.

## 1. Why this matters — practicality assessment

**This is not a hypothetical ask.** It is a well-established and increasingly standard pattern,
already visible piecemeal in every product surveyed for [VISION.md](VISION.md):

- **Cursor** already runs subagents in parallel across different subtasks and models.
- **Lovable** already splits complex investigations into parallel subagents.
- **HyperLocal** already has named specialist agents (Architect, Integration Architect, API
  Designer, UX Designer) feeding a review-board gate — a delegation pattern in miniature, already
  reflected in this product's own
  [WORKFLOW_ENGINE_SPEC.md §3](WORKFLOW_ENGINE_SPEC.md)'s optional Design/Architecture sign-off
  stage.

What's specified below is the **generalized, admin-visible, governance-composed version** of a
pattern every one of those products already runs in some narrower form. That said, it has real
engineering hard parts that must be designed for deliberately here, not assumed away by "just
fan out more agents":

- **Cost multiplies with parallelism.** N agents running in parallel can cost up to N× as much
  simultaneously as one agent running serially. This must compose tightly with the governance
  layer's cost dashboard and per-user entitlements and with the token-optimization layer's routing
  from day one (§5 below), not be bolted on after the orchestration mechanics are built — otherwise
  an "optimized team" quietly becomes an expensive one.
- **Bad task decomposition is worse than no decomposition.** Splitting a task into subtasks that
  aren't actually independent produces duplicated work, conflicting outputs, and wasted spend. The
  system needs an explicit "is this actually parallelizable?" judgment step (§3), not blind fan-out
  on every request.
- **Shared-state conflicts are real.** Multiple agents editing the same codebase, the same file, or
  the same git branch at once will step on each other without an ownership/locking model (§4).
- **Not every task benefits.** Small, simple, or tightly sequential tasks should run serially
  through one agent; forcing parallelism everywhere adds coordination overhead without a payoff
  (§4, §7).

None of these is a reason not to build this pillar — they are the specific failure modes the
design in §2–§6 exists to handle.

## 2. Delegation hierarchy — Project Manager → Team Lead → Worker Agents

Three tiers, each with a narrower scope than the one above it:

- **Project Manager (PM) Agent** — the top-level orchestrator for a given run. Receives a user's
  request — either directly, or as the **Build stage** of a
  [WORKFLOW_ENGINE_SPEC.md §2](WORKFLOW_ENGINE_SPEC.md) workflow instance (stage 6, "Build
  execution," or the equivalent `automated_build` stage type in
  [WORKFLOW_ENGINE_SPEC.md §3](WORKFLOW_ENGINE_SPEC.md)) — decomposes it into a task graph (§3),
  estimates dependencies and effort, and assigns each task to the most appropriate agent or Team
  Lead. This is the same function a real PM performs breaking an initiative into a backlog, which
  is also why decomposed tasks are the natural handoff point into
  [PM_TOOL_INTEGRATION_SPEC.md](PM_TOOL_INTEGRATION_SPEC.md)'s bi-directional work-item sync.
- **Team Lead Agents** (used for larger efforts) — domain-scoped supervising agents (e.g. a
  "Frontend Lead," "Backend Lead," "Security Lead," "Migration Lead") that each own a cluster of
  worker agents in their domain, report rolled-up status back to the PM Agent, and resolve
  domain-local conflicts (e.g. two frontend workers touching overlapping components) before they
  ever reach the PM Agent. Not every run needs a Team Lead tier — small task graphs route workers
  directly under the PM Agent.
- **Worker Agents** — narrowly scoped and **spun up on demand**, provisioned with only the model,
  tools, and connector/MCP access needed for their specific subtask, and **torn down when the
  subtask completes**. Capability provisioning is decided per task, not drawn from a fixed roster
  of standing agents — a worker doing a read-only code search gets no write-capable tools; a worker
  doing a scoped file edit gets exactly the connector/MCP grants that edit requires, never the
  initiating user's full entitlement surface by default (see §5 for the hard ceiling this sits
  under).

## 3. Task graph — a DAG, not a flat list

- Decomposed work is represented as a **dependency graph (DAG)**, not a flat list: independent
  subtasks are eligible to run in parallel; dependent subtasks are sequenced. Getting this
  classification right is the PM Agent's most important job and is treated as a **distinct,
  reviewable step** — not an implicit side effect of decomposition. A task graph can be inspected
  before execution starts, the same way a workflow's requirements artifact is reviewable before
  build begins ([WORKFLOW_ENGINE_SPEC.md §2](WORKFLOW_ENGINE_SPEC.md), stages 3–4).
- **Per-task status**: each node carries a status (Not Started / In Progress / Blocked / In Review
  / Done) — mirroring a real project-management view, and feeding directly into
  [PM_TOOL_INTEGRATION_SPEC.md](PM_TOOL_INTEGRATION_SPEC.md)'s work-item sync so a task graph node
  and its linked ADO/Jira item never show contradictory status.
- **Failure handling**: if a worker agent stalls or fails, the orchestrator can **retry**,
  **reassign** to a different agent/model, or **escalate to a human** via the existing
  [GOVERNANCE_LAYER_SPEC.md §6](GOVERNANCE_LAYER_SPEC.md) Approvals Queue. A stuck subtask must
  never silently block the whole run indefinitely — every failure path terminates in one of those
  three outcomes, never in silence.
- Illustrative task-graph shape (not a new stage type — this executes *inside* a single
  `automated_build` stage of a [WORKFLOW_ENGINE_SPEC.md §3](WORKFLOW_ENGINE_SPEC.md) workflow
  instance):

```yaml
task_graph:
  run_id: run-2026-0724-001
  initiating_user: dhruv.patel@reynoldsbrands.com
  nodes:
    - id: schema-migration
      owner: pm_agent
      depends_on: []
      parallelizable: false        # explicit serialization (§4)
      status: done
    - id: backend-endpoint
      owner: backend_lead
      depends_on: [schema-migration]
      parallelizable: true
      status: in_progress
    - id: frontend-form
      owner: frontend_lead
      depends_on: [schema-migration]
      parallelizable: true
      status: in_progress
    - id: integration
      owner: pm_agent
      depends_on: [backend-endpoint, frontend-form]
      parallelizable: false
      status: not_started
  on_failure: [retry, reassign, escalate_to_approvals_queue]
```

## 4. Resource contention and conflict avoidance

- **Ownership assignment**: before fanning out parallel workers on a shared codebase, the
  orchestrator assigns non-overlapping file/module ownership wherever possible, and serializes
  access to anything that can't be cleanly split.
- **Integration step, not N-way merges**: parallel workers never independently push to the same
  branch. Their outputs are reconciled by the orchestrator (or a dedicated integration task in the
  graph, as in the example above) **before** becoming a single PR — reusing the existing
  git-operation stage type ("Create PR") from
  [WORKFLOW_ENGINE_SPEC.md §3](WORKFLOW_ENGINE_SPEC.md), not a new git-integration mechanism.
- **Explicit serialization detection**: the PM Agent must be able to mark a node
  `parallelizable: false` — "this subtask blocks everything else and cannot be parallelized" (e.g.
  a schema migration everything downstream depends on) — rather than forcing parallel execution
  where it would only create conflicts. This is the direct mitigation for §1's "not every task
  benefits" and "bad decomposition is worse than none" risks: a task graph with zero parallel
  nodes is a valid, correct output of decomposition, not a failure of it.

## 5. Governance and cost composition (the core of this spec)

This section is the reason multi-agent orchestration is safe to build at all. Every mechanism
below composes with an existing governance or cost-control surface — none introduces a parallel
one.

### 5.1 Entitlement inheritance, never escalation

- Every worker/lead agent spun up by the PM Agent **inherits — and can never exceed — the
  entitlements of the human user who initiated the run**, exactly as
  [GOVERNANCE_LAYER_SPEC.md §4](GOVERNANCE_LAYER_SPEC.md) defines them: the user's per-user agent
  allow-list, their **default and ceiling** model/agent, and any mode-level restriction on top of
  either.
- The PM Agent cannot grant itself, a Team Lead, or a worker broader model, connector, or MCP-tool
  access than the initiating user already has. Concretely: if the initiating user's ceiling agent
  is Agent Y, no worker agent spun up under that run may be provisioned with Agent Z even if Agent
  Z exists in the platform-wide registry and would decompose the task "better" — the ceiling in
  [GOVERNANCE_LAYER_SPEC.md §4](GOVERNANCE_LAYER_SPEC.md) is a hard boundary the orchestrator plans
  inside of, not a target it can negotiate past.
- This applies transitively down the hierarchy: a Team Lead cannot grant a worker under it any
  entitlement the Team Lead itself does not hold, and the Team Lead itself holds nothing beyond
  what it inherited from the initiating user via the PM Agent. There is no path in the delegation
  chain where privilege increases moving downward.
- Per-tool, per-server rules from [GOVERNANCE_LAYER_SPEC.md §3](GOVERNANCE_LAYER_SPEC.md) (approval
  requirements, rate limits, data-scope restrictions) apply identically to a worker agent's tool
  calls as they would to the initiating user calling that tool directly — a worker hitting an
  approval-required rule pauses and routes to the Approvals Queue exactly as a human-initiated call
  would, not a special orchestration-only exception path.

### 5.2 Per-run budget cap composing with the cost-per-project dashboard

- An admin sets a **maximum spend for a given orchestration run**, composing directly with the
  per-project budget already defined in
  [GOVERNANCE_LAYER_SPEC.md §10](GOVERNANCE_LAYER_SPEC.md) — a run-level cap is a finer-grained
  instance of the same budget-vs-actual mechanism, not a second budgeting concept.
- **Before execution**: if the PM Agent's planned task graph would exceed the run's budget cap,
  the run must either (a) **request human approval to proceed** — reusing the
  [GOVERNANCE_LAYER_SPEC.md §6](GOVERNANCE_LAYER_SPEC.md) Approvals Queue, the same inbox every
  other approval-required action in the product uses — or (b) **automatically re-plan toward a
  cheaper decomposition**: fewer parallel workers, or cheaper models per
  [TOKEN_OPTIMIZATION_SPEC.md §8](TOKEN_OPTIMIZATION_SPEC.md)'s governance-integrated model routing
  (never a model outside the initiating user's entitlement, per §5.1 above). Which of the two paths
  applies is an admin-configurable policy per project, not a hardcoded platform default.
- **During execution**: live spend against the run-level cap is tracked continuously (feeding the
  team dashboard in §6) so a cap breach is caught while the run is in flight, not only reconciled
  after the fact.
- A budget cap is **never silently exceeded**. If neither approval nor a viable cheaper
  re-plan is available before the cap would be breached, the run pauses at the node that would
  breach it and escalates to the Approvals Queue — the same "never silently block" principle from
  §3's failure handling applies equally to budget exhaustion.

### 5.3 One audit trail, not a blind spot

- Every subagent's every action — every model call, every connector call, every MCP tool call,
  regardless of which tier of the hierarchy invoked it — flows into **the same audit log and
  cost-attribution pipeline** as any other governed call
  ([GOVERNANCE_LAYER_SPEC.md §3](GOVERNANCE_LAYER_SPEC.md) for the per-call audit record,
  [GOVERNANCE_LAYER_SPEC.md §10](GOVERNANCE_LAYER_SPEC.md) for cost attribution).
- Each logged action records the acting agent (PM / Team Lead / Worker, with the specific
  instance), the task-graph node it was executing, the initiating human user whose entitlements it
  inherited (§5.1), and the same allow/deny/approval-required outcome fields every other governed
  action carries. A reviewer auditing the log sees a full, attributable chain from any subagent
  action back to the human who kicked off the run — delegation adds a traceable hierarchy to the
  audit record, it does not remove or obscure the underlying accountability.
- **Delegation must never be a way to launder an action around governance.** There is exactly one
  audit trail and one cost-attribution pipeline in the product; orchestration is a consumer and
  contributor to that single stream, never a separate logging path that a reviewer would need to
  check independently to get the full picture.

## 6. Observability — the team dashboard

A **team dashboard** extends the workflow-instance dashboard already specified in
[WORKFLOW_ENGINE_SPEC.md §5](WORKFLOW_ENGINE_SPEC.md) ("a live view of every in-flight workflow
run — current stage, blocking approvals, elapsed time per stage, full history") rather than
introducing a parallel monitoring surface — an orchestration run is, from the workflow engine's
point of view, still one Build-stage instance; the team dashboard is the drill-down view of what's
happening *inside* that stage.

For any in-flight orchestration run, the team dashboard shows:

- The **task graph** (§3), rendered as a DAG, not a flat list.
- **Agent-to-node assignment** — which specific PM/Team-Lead/Worker agent instance is assigned to
  each node.
- **Per-node status** (Not Started / In Progress / Blocked / In Review / Done).
- **Elapsed time** per node and for the run as a whole.
- **Live spend per task**, rolling up into the run-level budget cap from §5.2 and, above that, into
  the per-project cost dashboard in [GOVERNANCE_LAYER_SPEC.md §10](GOVERNANCE_LAYER_SPEC.md).
- **The ability to intervene on one task without halting the whole run** — a human can pause,
  reassign, or cancel a single node (surfacing the same retry/reassign/escalate controls from §3)
  while every other node with no dependency on it keeps running. Intervening on one task is never
  an all-or-nothing stop of the entire orchestration run.

## 7. What NOT to do

- **Never let a worker or Team Lead agent's entitlements exceed the initiating user's.**
  Entitlement inheritance in §5.1 is a ceiling, not a starting point to negotiate from — no
  orchestration logic, "the task needs it" justification, or Team Lead escalation may grant a
  subagent access the initiating user does not already hold.
- **Never let parallel workers push directly to the same branch without an integration step.**
  §4's ownership assignment and integration-before-PR requirement are not optional performance
  tuning — N-way merges from independently pushing workers are exactly the shared-state conflict
  §1 flags as a real hard part, not a hypothetical one.
- **Never force parallelism on tasks that don't benefit from it.** A task graph with a single
  serial chain of nodes, or a `parallelizable: false` node that blocks everything downstream, is a
  correct output of decomposition (§3–§4), not a sign the orchestrator failed to fan out enough.
  Coordination overhead without a payoff is a real cost, not a neutral default.
- **Never let a per-run budget cap be silently exceeded.** Every path that would breach the cap in
  §5.2 must terminate in either human approval (via the existing Approvals Queue) or an automatic
  re-plan to a cheaper decomposition — never a run that simply keeps spending past its configured
  ceiling with no gate.
- **Never build a second audit log, cost-attribution pipeline, or Approvals Queue "for
  orchestration."** §5.3's single-audit-trail principle and §5.2's reuse of the existing Approvals
  Queue are load-bearing, not incidental — a parallel governance surface for subagents is precisely
  the blind spot this spec exists to close.

## 8. How this composes with the rest of the product

- **Governance layer**: multi-agent orchestration adds no new entitlement object type to
  [GOVERNANCE_LAYER_SPEC.md §2](GOVERNANCE_LAYER_SPEC.md). It is a consumer of the existing
  per-user agent entitlement system — default, ceiling, and mode restrictions
  ([GOVERNANCE_LAYER_SPEC.md §4](GOVERNANCE_LAYER_SPEC.md)) — for every worker and Team Lead agent
  it spins up, and of the existing per-tool/per-server rule set
  ([GOVERNANCE_LAYER_SPEC.md §3](GOVERNANCE_LAYER_SPEC.md)) for every tool call a subagent makes.
  It reuses the existing Approvals Queue and audit log
  ([GOVERNANCE_LAYER_SPEC.md §6](GOVERNANCE_LAYER_SPEC.md)) rather than introducing new ones.
- **Workflow engine**: an orchestration run typically executes as the Build stage of a
  [WORKFLOW_ENGINE_SPEC.md §2](WORKFLOW_ENGINE_SPEC.md) workflow instance; no new stage type is
  required in [WORKFLOW_ENGINE_SPEC.md §3](WORKFLOW_ENGINE_SPEC.md)'s stage library — the task
  graph is internal detail of a single `automated_build` stage. The team dashboard (§6) extends the
  existing workflow-instance dashboard rather than duplicating it.
- **Cost dashboard**: run-level budget caps (§5.2) are a finer-grained instance of the
  per-project budget already tracked in
  [GOVERNANCE_LAYER_SPEC.md §10](GOVERNANCE_LAYER_SPEC.md); live per-task spend on the team
  dashboard rolls up into that same per-project view, not a separate cost surface.
- **Token optimization**: when a run must re-plan toward a cheaper decomposition (§5.2), the
  cheaper-model substitution is governance-integrated model routing exactly as specified in
  [TOKEN_OPTIMIZATION_SPEC.md §8](TOKEN_OPTIMIZATION_SPEC.md) — never a model outside the initiating
  user's entitlement ceiling, and the routing decision is logged as a cost-attribution event the
  same way any other routing decision is.
- **PM tool integration**: task-graph nodes (§3) are the natural unit that
  [PM_TOOL_INTEGRATION_SPEC.md](PM_TOOL_INTEGRATION_SPEC.md) links to real ADO/Jira work items —
  this spec produces the task graph; that spec is responsible for keeping it in sync with the
  customer's own system of record.
