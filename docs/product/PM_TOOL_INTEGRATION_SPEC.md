# RegulAIt — PM Tool Integration Spec (P0 Pillar 8)

> Source: original specification authored during bootstrap planning (2026-07-24), prompted by
> the third feature report (`atlas-cursor-lovable-feature-report_4.md` §15) and commissioned by
> [ADR-0008](../decisions/0008-eight-p0-pillars.md) — synthesized from gaps identified across
> Atlas, Cursor, Lovable, and HyperLocal (see [VISION.md](VISION.md)).

> **This is a co-equal P0 pillar, not a bolt-on feature.** Per
> [ADR-0008](../decisions/0008-eight-p0-pillars.md) (2026-07-24), native PM-tool integration
> escalates to sit alongside [GOVERNANCE_LAYER_SPEC.md](GOVERNANCE_LAYER_SPEC.md),
> [WORKFLOW_ENGINE_SPEC.md](WORKFLOW_ENGINE_SPEC.md), and
> [MULTI_AGENT_ORCHESTRATION_SPEC.md](MULTI_AGENT_ORCHESTRATION_SPEC.md) among RegulAIt's eight
> non-negotiable architectural pillars (see [CLAUDE.md](../../CLAUDE.md) and
> [VISION.md](VISION.md)'s banner). Design principle: RegulAIt's task graph and workflow stages
> must map **onto** the customer's own Azure DevOps/Jira/etc. work items, not sit beside them as
> a second, drifting copy.

## 1. Why this matters — practicality assessment

**Closer to must-have than nice-to-have.** Most enterprise engineering organizations already run
their work through Jira or Azure DevOps; a governance/workflow tool that doesn't meet them there
creates a second, competing system of record — and enterprises actively resist adopting a second
system of record. Every product surveyed for [VISION.md](VISION.md) points the same direction:
Cursor's Linear integration, and the ADO/Jira-shaped work-item concepts implicit in HyperLocal's
and Atlas's own pipelines.

The integration itself is **low-risk from an API-maturity standpoint** — Azure DevOps and Jira
both have mature, well-documented, stable APIs, so the connector mechanics are not the hard part.
**The real work is the field-mapping/configuration layer**: every enterprise customizes its
work-item types and fields differently (custom terminal states, custom work-item types like
"RICEFW" or "Risk" sitting alongside standard Task/Bug/Story), so this integration cannot be a
hardcoded schema — it has to be genuinely admin-configurable, per customer, from day one.

## 2. What "native" means here (vs. a generic connector)

A generic MCP/connector integration — the kind already covered by
[GOVERNANCE_LAYER_SPEC.md §2](GOVERNANCE_LAYER_SPEC.md)'s connector object type — would let an
agent *call* the ADO/Jira API: create an item, read a field, post a comment, as one more governed
tool call among many. That is necessary but not sufficient for this pillar.

**"Native" means something structurally deeper**: the task graph produced by
[MULTI_AGENT_ORCHESTRATION_SPEC.md §3](MULTI_AGENT_ORCHESTRATION_SPEC.md) and the workflow stages
defined in [WORKFLOW_ENGINE_SPEC.md §2–§3](WORKFLOW_ENGINE_SPEC.md) map **directly onto** the
customer's actual ADO work items / Jira issues — not a shadow copy that RegulAIt maintains
internally and periodically reconciles. A task-graph node *is* a linked ADO task or Jira issue,
kept in sync bi-directionally (§3), not a RegulAIt-internal record that merely references one.

## 3. Bi-directional sync and source-of-truth model

- **PM Agent → PM tool**: when the PM Agent decomposes a request into a task graph
  ([MULTI_AGENT_ORCHESTRATION_SPEC.md §3](MULTI_AGENT_ORCHESTRATION_SPEC.md)), it creates real,
  linked work items in the customer's existing project, using the **customer's own work-item
  types and custom fields** (configured per §6's field-mapping layer) — not a generic "Task" type
  that ignores the customer's actual taxonomy.
- **PM tool → RegulAIt**: conversely, direct edits made in ADO/Jira by an end user —
  re-prioritizing, editing a description, adding a comment — flow back into RegulAIt's
  task/workflow state. A task-graph node's status and metadata in RegulAIt are never allowed to
  drift silently out of sync with what the linked work item actually shows.
- **The PM tool is the source of truth for priority, description, and acceptance-criteria
  fields.** End users document and prioritize where they already work: those fields are set
  directly on the linked ADO/Jira item, and **RegulAIt does not maintain a competing internal copy
  of them**. RegulAIt reads them from the linked item when needed and displays them, but never
  treats an internally-cached value as authoritative if the linked item has since changed —
  a read of a synced field always resolves to (or triggers a refresh from) the PM tool's current
  value, not a stale RegulAIt-side cache treated as canonical.

## 4. Decisions as first-class linked records

- Any significant decision made during planning or build (e.g. "chose Postgres over MongoDB for
  this workload") is captured as a **linked Decision record** — mirroring a "Decision" work-item
  type where the customer's ADO/Jira taxonomy supports one (configured per §6's field mapping) —
  rather than left buried in chat history or a RegulAIt-only log.
- Each Decision record carries, at minimum: the decision itself, its **rationale**, the
  **decision-maker**, and a **timestamp** — the same structured fields a human PM would expect to
  find on a decision log entry, and the same fields that make a decision auditable after the fact
  without reconstructing it from a conversation transcript.
- Where the customer's taxonomy has no dedicated "Decision" work-item type, the adapter falls back
  to the best available equivalent configured for that customer (e.g. a tagged comment or a
  generic linked item type) rather than failing to record the decision at all — degrade gracefully,
  never silently drop the record.

## 5. Approvals as status transitions on the linked work item

- Every sign-off/approval stage defined in
  [WORKFLOW_ENGINE_SPEC.md §2–§3](WORKFLOW_ENGINE_SPEC.md) — requirements sign-off (stage 4, "User
  sign-off"), merge approval (stage 9), and deploy approval (the conditional-deploy gate, stage
  11) — posts a corresponding **status transition or comment on the linked work item**.
- This means anyone on the customer's side can see who approved what and when **directly from
  ADO/Jira, without ever opening RegulAIt** — the linked work item's history is a complete,
  human-readable approval trail on its own.
- These status transitions/comments are additive to, not a replacement for, the
  [GOVERNANCE_LAYER_SPEC.md §6](GOVERNANCE_LAYER_SPEC.md) Approvals Queue and audit log — the
  approval event itself is still recorded once, centrally (§6's "one audit trail" requirement
  below); the PM-tool-side status transition is the customer-visible mirror of that same event, not
  a second decision point.

## 6. Feature specification

- **Adapters** for Azure DevOps, Jira, Linear, Asana, and monday.com, plus a **generic
  webhook/API adapter** for anything else — following the same pluggable-adapter pattern already
  established for models/connectors/MCP servers in
  [GOVERNANCE_LAYER_SPEC.md §2](GOVERNANCE_LAYER_SPEC.md)'s object-type table. A new PM-tool
  adapter is a new implementation of that same pattern, not a new architectural concept.
- **Configurable field mapping**: an admin maps RegulAIt's internal concepts — **Task**,
  **Decision**, **Approval**, **Requirements artifact** — to the customer's actual work-item types
  and custom fields. Because real-world ADO/Jira instances vary widely (custom terminal states,
  custom work-item types like "RICEFW" or "Risk" alongside standard Task/Bug/Story), this mapping
  is admin-configurable per customer instance, not a fixed schema shipped in code. Illustrative
  mapping config:

```yaml
pm_tool_field_mapping:
  adapter: azure_devops
  organization: reynoldsbrands
  project: RegulAIt-Pilot
  mappings:
    task:
      work_item_type: Task
      fields:
        title: System.Title
        status: System.State
        priority: Microsoft.VSTS.Common.Priority   # source of truth (§3)
        description: System.Description            # source of truth (§3)
        acceptance_criteria: Microsoft.VSTS.Common.AcceptanceCriteria  # source of truth (§3)
    decision:
      work_item_type: Risk           # customer's custom type stands in for "Decision"
      fields:
        rationale: Custom.Rationale
        decision_maker: Custom.DecisionMaker
        timestamp: System.CreatedDate
    approval:
      target: status_transition       # or "comment" if no dedicated state exists
      stage_map:
        requirements_signoff: "Ready for Build"
        merge_approval: "Ready to Merge"
        deploy_approval: "Approved for Deploy"
    requirements_artifact:
      work_item_type: Task
      attach_as: linked_document
  fallback:
    decision: comment   # if no equivalent work-item type is mapped
```

- **Full traceability**: every PR, deployment, decision, and approval RegulAIt's workflow engine
  generates automatically links back to its originating work item — a click from Jira/ADO
  surfaces the complete build history, and a click from RegulAIt surfaces the linked work item,
  in both directions, for every artifact the platform produces.
- **One audit trail**: PM-tool activity — status changes, comments, approvals synced per §5 —
  feeds the **same unified audit log** as every other governed action
  ([GOVERNANCE_LAYER_SPEC.md §3](GOVERNANCE_LAYER_SPEC.md) for the per-event audit record,
  [GOVERNANCE_LAYER_SPEC.md §6](GOVERNANCE_LAYER_SPEC.md) for the Admin Portal's Audit & Activity
  Log surface) — never a second, separate audit surface a reviewer would need to check
  independently to get the full picture.

## 7. What NOT to do

- **Never let this become a second, competing system of record** for fields the PM tool already
  owns. Priority, description, and acceptance criteria are read from and written to the customer's
  ADO/Jira item (§3) — RegulAIt must not silently accumulate an internal copy of these fields that
  can drift from what the linked item actually shows, even for display convenience.
- **Never hardcode a field-mapping schema.** §6's configurable field-mapping layer is the load-
  bearing part of this entire pillar — real ADO/Jira instances vary too widely for a fixed schema
  to survive contact with more than one customer. Every adapter must ship with a default mapping
  an admin can override, never a mapping an admin cannot change.
- **Never let PM-tool activity bypass the unified audit log.** §6's "one audit trail" requirement
  is not optional logging hygiene — a status change made via the ADO/Jira adapter that doesn't
  reach the same audit log as a status change made through RegulAIt's own UI is exactly the kind
  of blind spot this pillar exists to prevent, mirroring
  [MULTI_AGENT_ORCHESTRATION_SPEC.md §5.3](MULTI_AGENT_ORCHESTRATION_SPEC.md)'s identical
  principle for subagent actions.

## 8. How this composes with the rest of the product

- **Governance layer**: PM-tool adapters are one more instance of the pluggable object-type
  pattern in [GOVERNANCE_LAYER_SPEC.md §2](GOVERNANCE_LAYER_SPEC.md) — access to a given PM-tool
  connection is itself governed per-user like any other connector, and every synced action feeds
  the single audit log in [GOVERNANCE_LAYER_SPEC.md §3 and §6](GOVERNANCE_LAYER_SPEC.md). It adds
  no new entitlement concept.
- **Workflow engine**: every sign-off stage type in
  [WORKFLOW_ENGINE_SPEC.md §2–§3](WORKFLOW_ENGINE_SPEC.md) gains a PM-tool-visible mirror (§5)
  without changing the stage library itself — this spec is a delivery mechanism for existing
  workflow events, not a new stage type or a new approval mechanism.
- **Multi-agent orchestration**: the task graph produced by
  [MULTI_AGENT_ORCHESTRATION_SPEC.md §3](MULTI_AGENT_ORCHESTRATION_SPEC.md) is the unit this spec
  keeps synced with real ADO/Jira work items (§3) — that spec owns decomposition and execution;
  this spec owns keeping the customer's system of record accurate as that execution proceeds.
- **Cost dashboard**: no new cost-attribution surface is introduced — PM-tool sync activity is
  governed connector traffic like any other, attributed the same way at the point of the call per
  [GOVERNANCE_LAYER_SPEC.md §10](GOVERNANCE_LAYER_SPEC.md).
