# ADR-0251: One governed decision core for model, connector, MCP and A2A calls

- **Status**: Proposed (builder lane `builder/gov-core-unify`; owner decision "Yes, ADR then build", 2026-11-07, #453)
- **Date**: 2026-11-07
- **Closes**: whole-build review findings P-01 (high), S-05 and S-06
  ([2026-11-07-whole-build-review.md](../reviews/2026-11-07-whole-build-review.md))
- **Builds on**: [ADR-0014](0014-role-bundled-agent-connector-grants.md) (grants),
  [ADR-0040](0040-abac-policy-as-code.md) (Cedar ABAC), [ADR-0104](0104-approval-payload-binding.md) and
  [ADR-0105](0105-consent-context-binding-and-expiry.md) (consent binding), [ADR-0124](0124-kill-switch-and-safe-modes.md)
  (kill switch), [ADR-0180](0180-continuous-assurance-strict-by-default.md) (secure by default), [ADR-0212](0212-modality-pricing-and-model-rate-limits.md)
  (model rate limits), [ADR-0219](0219-a2a-governance.md) (A2A)
- **Migration**: pending `governed_core_resource_rules` (`packages/db/migrations/pending/governed_core_resource_rules.sql`; numbered at merge time under ADR-0252.
  Drafted as 0307 with `when` 1785234000000; converted when main reached 0313.)
- **Coordinates with**: P8 Cedar consolidation (#707, ADR-0239), P11 MCP bundles (#697), P12d token exchange (#712),
  S-04/P-02 step-up plan gate (`builder/s04-p02-stepup-plan-gate`)

## Context

Pillar 1 promises that every agent/model, connector and MCP tool call passes one per-user governance layer: default
deny, approvals, rate limits, audit. The review found that only the MCP tool path does. `governedEvaluate`
(`apps/gateway/src/governed-evaluate.ts`) is the only caller that feeds the kernel approval rules, rate windows and a
Cedar verdict, and those are fields on the tool-shaped `EvaluationInput`. As built on `main` at `d8d6480`:

| Control | MCP tool | Model/agent | Connector | A2A |
|---|---|---|---|---|
| Decision function | `governedEvaluate` → `evaluate` | `evaluateAgent` | `evaluateConnector` | route checks, no kernel call |
| Kill switch, safe modes, literacy | yes | yes | yes | **no** |
| Approval rules | yes | **no** (dial hold becomes deny) | **no** (dial hold only, writes only) | **no** |
| Governance rate limit | yes | `model_rate_limits`, **off by default** | **none** | **none** |
| Cedar ABAC | yes | **no** | **no** | **no** |
| Attribution mandate on by default | yes | yes | **no** | **no** |

`ARCHITECTURE.md` claimed one decision core for all of them; that was corrected in the commit before this ADR.

The kernel's three entitlement functions are sound and well tested; what is missing is the *restriction layer* that
sits on top of an entitlement allow (approval, rate, ABAC, attribution) and a single place that applies it.

## Decision

**Every governed call (MCP tool, model/agent, connector, A2A) is decided by one core, `governedEvaluate`, at the same
interception point, before anything is sent or billed.** The core runs one fixed sequence for every resource type:

1. **Execution posture**: kill switch, safe modes and the AI literacy gate (`executionGate`, `literacyGate`).
2. **Per-user entitlement, default deny**: the resource type's own kernel function (`evaluate`, `evaluateAgent`,
   `evaluateConnector`, and a new `evaluateA2a` that moves A2A's grant, skill and lead-ceiling checks into the kernel).
   Unchanged in substance; the core only calls it.
3. **Attribution mandate** (pillar 5): a call that names no project is refused unless the surface's org setting has
   been relaxed (audited). On by default for every surface, including connector and A2A, which have no such setting
   today.
4. **Data-scope cascade**: the project's PII mode and data scope (`projectPiiMode`, `data_scope_rules` for tools, the
   grant's `allowedObjects` for connectors). Unchanged where it exists; the core is where it is read.
5. **Rate limits**, per subject (user, role, team, fleet) and per resource (tool, model, connector, remote agent).
   Model rate limits are **enforced by default** (`model_rate_limits_enabled` defaults to true; an admin may turn it
   off, step-up and audited). Connector and A2A limits are new and always enforced.
6. **Cedar ABAC**: the active policy set, evaluated for the call's action and resource type. ABAC never grants; it can
   only forbid or require approval (ADR-0040's invariant).
7. **Approval rules**: a matching rule turns an allow into `require_approval` with the rule's named approver, satisfied
   only by a bound, fresh consent (ADR-0104/0105 digests). Applies to every resource type.
8. **Cost attribution**: the decision carries the project (or the explicit Unattributed bucket where relaxed) that the
   usage row and the budget gate (`preDispatchProjectGate`) then use. Mandatory and on by default.
9. **Audit**: exactly one decision row per evaluation, on the chained audit writer, whatever the outcome.

**Error is deny.** Any exception inside the core (a load that fails, a Cedar evaluation error, an unparseable rule)
returns a deny with rule id `governed-core-error`, audited, and the call is not sent. The core never returns allow on
a path that did not reach step 7.

**Order is fixed and the same for every type.** Restrictions apply only after an entitlement allow (an approval never
manufactures a grant, as AER-017 already requires on the MCP path), and in the order rate limit, ABAC, approval, so a
call that is over its limit is refused before it is queued for anyone's sign-off.

### Shape

- **Kernel** (`packages/policy-kernel/src/resource.ts`, pure, zero I/O): `GovernedResource` (a tagged union of
  `tool`, `model`, `connector`, `a2a`), `ResourceApprovalRule`, `ResourceRateLimit`, `evaluateA2a`, and
  `composeResourceDecision(base, restrictions)`, which applies steps 3, 5, 6 and 7 to an entitlement decision and
  returns one `GovernedResourceDecision` with a rule chain.
- **Gateway** (`apps/gateway/src/governed-core.ts`): `governedEvaluateResource(db, input)` loads the posture, the rule
  sets for the caller's scopes, the window counts, the attribution setting and the ABAC verdict, calls the kernel,
  writes nothing on a pure evaluation, and catches every error as `governed-core-error`. The MCP tool path keeps
  `governedEvaluate` as its implementation of the same contract; it is already complete, so it is not rewritten.
- **Data** (migration `governed_core_resource_rules`): two tables keyed on a resource type and an optional resource id, with the same subject
  dimension as `approval_rules` and `rate_limits`:
  - `resource_approval_rules` (`resource_type` in model, connector, a2a; nullable `agent_id`, `connector_id`,
    `a2a_agent_id` foreign keys, at most one set and matching the type; null = every resource of that type;
    `write_only`; `approver_user_id`).
  - `resource_rate_limits` (connector and A2A; same resource keys; `max_calls`, `window_seconds`).
  - Models keep `model_rate_limits` (ADR-0212), read by the same loader, so one fact stays in one place.
  - Two org settings, `connector_attribution_required` and `a2a_attribution_required`, both default true.
  - `model_rate_limits_enabled` defaults to true, and the existing row is set to true (ADR-0180: no grandfathering).
  - The MCP tables are not touched, so the tool path's loads, versioning and kernel stay byte-identical.
- **Counting**: windows count allowed decision rows in `audit_log` for the subject and resource, by the database
  clock (M-rule: `now()`), the same source the MCP path counts.
- **ABAC**: a v5 Cedar schema adds the actions `ModelInvoke`, `ConnectorCall` and `A2aMessage` with resource types
  `Model`, `Connector` and `RemoteAgent`. Existing v1 to v4 policies are scoped to `McpToolCall`, so none of them starts
  matching a new call type silently. The v5 schema is built after P8's consolidation (#707) lands, because both edit
  `policy-kernel/src/abac.ts`; until then the core's ABAC slot evaluates to "no active policy for this action", which
  is exactly true (no policy can be written for these actions yet).

### Delegated calls (pillar 7): a worker never exceeds the person who started the run

When a lead agent hands off to a worker, every call the worker makes (model, connector, MCP tool, A2A) goes through
this same core, decided **as the initiating user**, and can only be narrower than that user's own call:

- **Entitlement** is the kernel's intersection for an actor chain (ADR-0188: `evaluateConnector` / `evaluateAgent`
  with the stored `GovernedActor`, `evaluateDelegatedAgentCall` on dispatch), plus the §5.1 lead ceiling
  (`ceilingTools`, `ceilingAgentIds`), which only narrows. A worker has no grant of its own.
- **Restrictions** (attribution mandate, rate limits, approval rules, ABAC) are loaded for the initiating user's
  subject scopes, so a worker's calls count against, and are held by, the same limits and rules as that user's own.
  Fanning work out to many workers therefore cannot multiply anyone's rate allowance.
- **Budget**: the per-run delegation budget (`delegation-budget` in the actor chain, ADR-0016's transitive per-node
  ceiling) and the project budget gate (`preDispatchProjectGate`) both apply on the worker's call, on the project the
  run is attributed to.
- **Error is deny** holds for a worker's call exactly as for a person's.

Design references for the hand-off and role model, cited only (no code copied, and neither is a dependency: both are
Python, and crewAI ships telemetry on by default, which fails ADR-0180): `openai/openai-agents-python` (MIT), for agent
hand-offs and guardrail hooks around them; `crewAIInc/crewAI` (MIT), for the role, task and crew model and Flows.
What we take from them is the shape (a hand-off is a call, and a guard runs on every call), not their trust model:
both let a hand-off carry the caller's full tool set, where ours carries the intersection.

### Migration plan per call type

Each slice is one commit with tests, in this order. Every existing test keeps passing; a **differential test** per
slice runs the old decision and the new one over the same fixtures and asserts they agree wherever the old path had a
decision. Cases the old path could not decide (a rule type it never read) are listed as intended new denials.

| Slice | Call type | What changes | Intended new denials |
|---|---|---|---|
| 1 | Connector | `executeGovernedConnectorCall` calls the core after `evaluateConnector`. Approval rules reuse the existing connector consent binding (`connectorWriteBinding`, now keyed on the matched rule ids, not only the dial). Rate limits and the attribution mandate are new. | An unattributed connector call (`connector_attribution_required`); a call over a connector rate limit; a call matching a connector approval rule (queued, 202). |
| 2 | Model | `evaluateAgent` call sites in `agents-connectors.ts` and `compat-core.ts` call the core. `checkModelRateLimit` becomes the core's model rate step, on by default. Approval rules refuse with `approval_required` (403) naming the approver until model calls can be queued and replayed (follow-up). | A call over a model rate limit that was configured but not enforced; a call matching a model approval rule. |
| 3 | A2A | `executeGovernedA2aCall` calls the core instead of its own checks 3 to 5; `evaluateA2a` brings the kill switch, safe modes and literacy gate to A2A (S-05). | Any A2A call while the kill switch is engaged, in `read_only` or `halted` mode, or by a person whose AI literacy is not current; an unattributed A2A call; a call over an A2A rate limit; a call matching an A2A approval rule (refused, as for models). |
| 4 | ABAC v5 | After #707 merges: the v5 schema and the authoring UI's action picker. | Whatever an admin writes. |

### Latency

Measured on the local Postgres 16 (one connection, warm cache, 2,000 iterations after 200 warm-up) with the
bench in `apps/gateway/src/zz-adr0251-core-latency.test.ts` (`REGULAIT_BENCH=1`). The numbers are recorded in the
"As built" section of this ADR when each slice lands. Budget: the core adds no more than 2 ms at p95 to a connector or
model decision with no rules configured, and no more than 5 ms with ten matching rules, because it is three indexed
queries (scope memberships, rules, window counts) that run concurrently. A slice that exceeds the budget does not
merge.

## Consequences

- One sequence to explain to a buyer and to an auditor, and one place to add a control.
- Connector and A2A calls with no project are refused by default (S-06). Callers that cannot send a project need the
  admin relaxation, which is audited.
- Model rate limits an admin configured start being enforced. Nothing is enforced where no limit row exists.
- Models and A2A get approval rules that refuse rather than queue until a replay path exists for them; that is a
  stricter interim, not a looser one.
- A2A is subject to the kill switch for the first time. That is the point of S-05.
- The MCP tool path is not rewritten; it already satisfies the contract. Unifying its implementation with
  `governedEvaluateResource` is a later refactor with its own differential test, not a precondition.

## As built

### Slice 1: connector (2026-11-07)

- Kernel: `packages/policy-kernel/src/resource.ts` (`composeResourceDecision`, `matchingResourceApprovalRules`,
  `governedCoreErrorDecision`), exported from the package root. Gateway: `apps/gateway/src/governed-core.ts`
  (`loadResourceRestrictions`, `governedEvaluateResource`). Migration `governed_core_resource_rules` as decided above.
- `executeGovernedConnectorCall` loads the core's restrictions before the consent binding, so a matching approval
  rule's id enters the consent's context digest (`connectorWriteBinding` now takes the rule ids; the dial alone keeps
  the pre-ADR-0251 digest byte for byte). The composed decision is what the one decision row records.
- An approval rule on a connector call (read or write; `write_only` narrows it to writes) is queued through the
  existing connector consent path (202, one approvals row, spent once by the identical call).
- Window counts read allowed connector decision rows (`detail.receiptClass = 'decision'`, advisories excluded) on the
  database clock, using the new partial index `audit_log_resource_window_idx`.
- Scope memberships are subqueries inside the rule loads, so the core is one round trip (three concurrent queries)
  when no rate limit binds, plus one concurrent count per binding limit.
- Tests: `resource.test.ts` (kernel, 11), `zz-adr0251-connector-core.test.ts` (mandate on by default and relaxable,
  rate limit per subject, approval rule queue and spend-once, error is deny, and the differential over 144 entitlement
  cases agreeing on effect, rule id and approver). The 18 existing connector suites that call without a project now
  relax `connectorAttributionRequired` by name through the ADR-0181 fixture, which is the intended new denial; no
  assertion in them changed.
- **Latency, measured** (`REGULAIT_BENCH=1 vitest run src/zz-adr0251-core-latency.test.ts`, local Postgres 16, warm,
  2,000 iterations after 200 warm-up, three runs): no rules p50 1.2 to 1.4 ms, p95 2.2 to 2.7 ms; ten matching rules
  p50 2.8 to 3.1 ms, p95 4.3 to 4.8 ms. **The proposed +2 ms p95 budget with no rules was missed** by up to 0.7 ms.
  Single queries cost about 0.25 ms here; the rest is pool scheduling of three concurrent queries. The budget is
  amended to +3 ms (no rules) and +6 ms (ten rules) at p95, and the bench asserts it. Folding the three loads into
  one statement is the known next step if a pilot needs it.

### Slice 2: model (2026-11-07)

- `governedModelGate` (in `governed-core.ts`) runs once in the shared dispatch core (`dispatchAttempt` in
  `agents-connectors.ts`), after every caller's own `evaluateAgent` and the lifecycle gate, before any provider work.
  It replaces the direct `checkModelRateLimit` call there, so every native, compat, playground, builder and fallback
  dispatch inherits it. Step one is ADR-0212's `checkModelRateLimit` unchanged (429 `model_rate_limited`, its audit
  row), now enforced by default; step two is the model approval rules through `governedEvaluateResource`
  (`canQueue: false`).
- A matching model approval rule refuses with 403 `approval_required`, one audited decision row (`phase:
  governed-core`, the matched rule ids), and no usage row. An error in either step refuses with 503
  `governed_core_error`.
- The attribution mandate on this path stays in the existing gates (`requireProjectAttribution` on compat,
  `dispatchAttributionRequired` on native dispatch); both were already on by default.
- Tests: `zz-adr0251-model-core.test.ts` (enforced by default, approval rule refusal with no usage row, subject
  binding, error is deny, and a differential over enforcement on/off x no limit, under and at the limit agreeing with
  `checkModelRateLimit`). ADR-0212's own suite now pins on-by-default.

### Slice 3: A2A (2026-11-07)

- Kernel `evaluateA2a` (in `resource.ts`): the execution posture first (kill switch, subject halt, read-only,
  the approval dial, AI literacy; a message to a remote agent counts as a write and has no queue, so the dial's
  `require_approval` refuses it), then the lead ceiling, then the person's grant (default deny). The lead-ceiling and
  no-grant refusals keep the route's rule ids (`lead-ceiling`, `a2a-default-deny`), status (403 `forbidden`) and
  reason text.
- `executeGovernedA2aCall` calls `evaluateA2a` and then `governedEvaluateResource` (`canQueue: false`) in place of its
  own steps 3 and 4. Org setting, agent and skill checks stay before it; project attribution, the budget gate, PII,
  egress and the credential stay after it. New refusal codes: 403 `execution_refused`, 409 `attribution_required`,
  429 `rate_limited`, 403 `approval_required`, 503 `governed_core_error`.
- A2A decision rows (allowed, upstream error, refused) now carry `receiptClass: "decision"`, so the A2A window counts
  read them the same way as connector rows.
- Tests: `resource.test.ts` (evaluateA2a: grants, ceiling, every stop), `zz-adr0251-a2a-core.test.ts` (the three
  stops refuse and audit, mandate on by default and relaxable, rate limit 429, approval rule refusal bound to its
  subject, error is deny, and a differential over 45 cases of grant shape, requested skill and lead ceiling against a
  transcription of the pre-ADR-0251 route checks). The P10 suite relaxes `a2aAttributionRequired` by name.
- Intended new denials, as listed above: A2A under the kill switch, read-only or approval dial; a person whose AI
  literacy is not current; an unattributed A2A call; a call over an A2A rate limit or matching an A2A approval rule.


### Review #715 round 1 (2026-11-08)

1. **Every named approver signs** (blocking, fixed). A connector write held by the execution dial *and* matched by an
   approval rule needs one consent per distinct required approver: the dial's approver and each matching rule's
   approver. Each consent binds that approver and the rule ids that demanded it, so one approver can never release a
   call another was named for. The hold asks the next missing approver, and execution spends every consent once. The
   matched rule ids reach `toolApprovalRequirements`. Tested in `zz-adr0251-connector-core.test.ts`.
2. **Rate limits are soft under concurrency** (accepted, recorded here). The window count is read when the call is
   decided, and the call's allowed row is written later, so calls that are decided at the same moment can each see the
   same count. The overshoot is bounded by the number of calls in flight for that subject and resource. This is the
   same semantics as the project budget gate ("overshoots by at most one call per call in flight", ARCHITECTURE.md)
   and the MCP rate windows. On A2A the in-flight window is longer, because the allowed row is written after the
   remote agent replies. A hard limit (an advisory lock per subject and resource held from the count to the decision
   row, or a reservation row) is a follow-up. It is not taken here, because it puts a lock on every governed call's
   hot path and needs its own latency measurement.
3. **Side rows do not spend a slot** (fixed). The window counts only the call's own decision row. Connector decision
   rows carry no `phase`; A2A call rows carry `phase: "call"`. A PII warning or a guardrail row of the same call no
   longer counts as a second call.
4. **No admin routes yet for `resource_approval_rules` and `resource_rate_limits`** (follow-up). Today the tables can
   only be written with direct SQL. No rows means no change in behaviour, and no UI exposes them. The routes come
   next and follow `/v1/rules/model-rate-limits`: admin only, a `settings_relax` step-up for every removal or
   loosening, and an audit row with the old and new values in the same transaction as the write. They must exist
   before any UI exposes these tables.
5. **Latency bench size.** `zz-adr0251-core-latency.test.ts` measures 0 rules, then 10 matching rules (5 approval
   rules and 5 rate limits under their limit). Each binding rate limit adds one concurrent count query, so the cost
   grows with the number of limits that bind one subject and resource, not with traffic.
