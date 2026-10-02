# ADR-0156: AI-System Dependency Graph with Max-Propagated Declared Risk

Status: Accepted (implemented)
Date: 2026-10-02
Related: ADR-0050 (data lineage), ADR-0082 (inventory, granted vs observed),
ADR-0147 (residual risk), ADR-0084 (vendor registry), ADR-0089 (use cases);
ROADMAP §9 Phase 1 "Dependency graph", Phase 2 "aggregate risk scoring"
Migration: none

## Context

ROADMAP §9 marks the dependency graph as partial: `lineage.ts` records which
inputs a run was handed (data provenance per run), and the inventory shows one
agent's granted and observed tools, but nothing answers the system question a
governance reviewer asks first: *what does this use case depend on, and how
exposed is it because of those dependencies?* A vendor flagged high-risk today
changes nothing visible on the use cases that rely on it.

## Decision

1. **`GET /v1/inventory/graph[?useCaseId=&includeObserved=false]`**,
   admin-only through the default gate (org-wide inventory, same position as
   `/v1/inventory/agents`). Rebuilt on every read from the registers; nothing
   is stored, so it cannot drift.
2. **Nodes:** use case, agent, model, vendor, MCP server, connector. A model is
   keyed `model:<provider>:<model>` or `model:custom:<customProviderId>`.
3. **Edges point from dependent to dependency and carry a basis.**
   *Declared*: use case → agent (intended agents), agent → model (registry),
   model → vendor (vendor's linked providers). *Observed* (inventory window,
   90 days): agent → MCP server and agent → connector from trace spans whose
   parent carries the agent; agent → agent from orchestration feeds. Observed
   edges are opt-out with `includeObserved=false`.
4. **Own risk** of a node is the worst *effective* rating among risks naming
   it (`agentId` / `useCaseId` / `vendorId`): likelihood × impact on the
   register's 3×3 matrix (1–2 low, 3–4 medium, 6–9 high), residual when set
   (ADR-0147) else inherent. Closed risks are excluded; **accepted risks
   count** — accepting a risk is a decision to carry it. Risks naming none of
   those subjects are counted as `unattachedRisks`, not placed.
5. **Propagated risk is a maximum, not a sum or a probability.** Each node
   carries the worst rating among itself and everything it transitively
   depends on, with `sourceNodeKey`, `sourceRiskId` and the `path` to it, so a
   reviewer can walk to the actual entry. Cycle-safe (feeds can run both
   ways), bounded at |V| relaxation rounds, deterministic regardless of edge
   order; own risk wins a tie, then the shorter path.
6. `useCaseId` returns the transitive dependency subgraph of that use case;
   ratings are computed over the full graph first so a scoped read never
   shows a different number than the org view.

## Consequences

- Credo-parity "dependency graph with risk propagation" exists as an API;
  the visual graph is a web task (AgentCoordination X6, post-demo unless
  Codex has capacity).
- Max-propagation deliberately does not escalate two mediums into a high.
  If the owner later wants an aggregate score (e.g. count-weighted), it is a
  new, separately-labelled field, never a change to this one.
- Vendor ↔ model linkage is the vendor register's declared `linkedAgentProviders`
  hint; a vendor linked to a provider string links every model of that
  provider. That is the register's granularity today, stated in the response
  notes rather than refined by guesswork.

## Tests

`packages/shared/src/dependency-graph.test.ts` (9: matrix bands, residual /
closed / accepted, transitive path, direction, max-not-sum, cycles, unknown
nodes, edge-order independence). `apps/gateway/src/zz-adr0156-dependency-graph.test.ts`
(4: declared + observed edges with basis and counts, vendor risk reaching the
use case with path, scoping and `includeObserved=false`, 404 / 403).
