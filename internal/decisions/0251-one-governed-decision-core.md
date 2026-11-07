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
- **Migration**: 0307 (`0307_governed_core_resource_rules.sql`, `when` 1785234000000)
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
- **Data** (migration 0307): two tables keyed on a resource type and an optional resource id, with the same subject
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

(Filled in per slice.)
