/**
 * ADR-0156 — THE AI-SYSTEM DEPENDENCY GRAPH, with declared risk propagated
 * from every dependency to everything that relies on it.
 *
 * Composition only, over records the platform already keeps. Nothing here is
 * stored; the graph is rebuilt on every read so it cannot drift from the
 * registers it is drawn from.
 *
 *  DECLARED edges (a register says so):
 *    use case  → agent    `ai_use_cases.intended_agent_ids`
 *    agent     → model    `agents.provider` / `model` / `custom_provider_id`
 *    model     → vendor   `ai_vendors.linked_agent_providers` / `linked_custom_provider_ids`
 *  OBSERVED edges (the ledgers saw it happen, inventory window):
 *    agent     → MCP server  tool spans whose parent span carries the agent
 *    agent     → connector   connector spans, same rule
 *    agent     → agent       orchestration feeds (`computeFeedEdges`)
 *
 * Distinct from `lineage.ts` (ADR-0050), which is DATA provenance per run.
 * This is the standing SYSTEM picture: what depends on what, and how exposed
 * each piece is because of what it depends on.
 *
 * Admin-only through the default gate (not in NON_ADMIN_ROUTES): it is the
 * org-wide inventory, the same position as `/v1/inventory/agents`.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  agents,
  aiRisks,
  aiUseCases,
  aiVendors,
  and,
  connectors,
  customModelProviders,
  eq,
  gte,
  inArray,
  isNotNull,
  mcpServers,
  traceSpans,
  type Db,
} from "@regulait/db";
import {
  DEPENDENCY_GRAPH_NOTES,
  effectiveRiskRating,
  propagateRisk,
  type GraphEdgeBasis,
  type GraphEdgeKind,
  type GraphNodeType,
  type PropagatedRating,
  type RiskRating,
} from "@regulait/shared";
import { INVENTORY_WINDOW_DAYS, computeFeedEdges } from "./inventory.js";

export interface DependencyGraphNode {
  key: string;
  type: GraphNodeType;
  /** the record id where one exists; a model keyed by provider/model string has none */
  id: string | null;
  label: string;
  attributes: Record<string, unknown>;
  ownRisk: RiskRating & { riskId: string | null; openRisks: number };
  propagatedRisk: PropagatedRating;
}

export interface DependencyGraphEdge {
  from: string;
  to: string;
  kind: GraphEdgeKind;
  basis: GraphEdgeBasis;
  observedCount?: number;
  lastSeenAt?: string | null;
}

const modelKeyFor = (a: { provider: string; model: string | null; customProviderId: string | null }) =>
  a.provider === "custom" && a.customProviderId
    ? `model:custom:${a.customProviderId}`
    : `model:${a.provider}:${a.model ?? "*"}`;

export async function computeDependencyGraph(
  db: Db,
  opts: { useCaseId?: string | null; includeObserved?: boolean; now?: Date } = {},
) {
  const now = opts.now ?? new Date();
  const includeObserved = opts.includeObserved ?? true;
  const nodes = new Map<string, Omit<DependencyGraphNode, "ownRisk" | "propagatedRisk">>();
  const edges = new Map<string, DependencyGraphEdge>();
  const addEdge = (e: DependencyGraphEdge) => {
    if (!nodes.has(e.from) || !nodes.has(e.to) || e.from === e.to) return;
    const k = `${e.from}|${e.kind}|${e.to}`;
    if (!edges.has(k)) edges.set(k, e);
  };

  // -- registers -------------------------------------------------------------
  const [agentRows, useCaseRows, vendorRows, providerRows] = await Promise.all([
    db
      .select({
        id: agents.id,
        name: agents.name,
        provider: agents.provider,
        model: agents.model,
        customProviderId: agents.customProviderId,
        enabled: agents.enabled,
        lifecycleStatus: agents.lifecycleStatus,
        haltedAt: agents.haltedAt,
        ownerUserId: agents.ownerUserId,
      })
      .from(agents),
    db
      .select({
        id: aiUseCases.id,
        name: aiUseCases.name,
        status: aiUseCases.status,
        euAiActTier: aiUseCases.euAiActTier,
        intendedAgentIds: aiUseCases.intendedAgentIds,
      })
      .from(aiUseCases),
    db
      .select({
        id: aiVendors.id,
        name: aiVendors.name,
        status: aiVendors.status,
        category: aiVendors.category,
        linkedAgentProviders: aiVendors.linkedAgentProviders,
        linkedCustomProviderIds: aiVendors.linkedCustomProviderIds,
      })
      .from(aiVendors),
    db.select({ id: customModelProviders.id, name: customModelProviders.name }).from(customModelProviders),
  ]);
  const providerName = new Map(providerRows.map((p) => [p.id, p.name]));

  for (const u of useCaseRows) {
    nodes.set(`use_case:${u.id}`, {
      key: `use_case:${u.id}`,
      type: "use_case",
      id: u.id,
      label: u.name,
      attributes: { status: u.status, euAiActTier: u.euAiActTier },
    });
  }
  for (const a of agentRows) {
    nodes.set(`agent:${a.id}`, {
      key: `agent:${a.id}`,
      type: "agent",
      id: a.id,
      label: a.name,
      attributes: {
        provider: a.provider,
        model: a.model,
        enabled: a.enabled,
        lifecycleStatus: a.lifecycleStatus,
        halted: a.haltedAt !== null,
        owned: a.ownerUserId !== null,
      },
    });
    const mk = modelKeyFor(a);
    if (!nodes.has(mk)) {
      const custom = a.provider === "custom" && a.customProviderId;
      nodes.set(mk, {
        key: mk,
        type: "model",
        id: custom ? a.customProviderId : null,
        label: custom
          ? `${providerName.get(a.customProviderId!) ?? "custom provider"}${a.model ? ` / ${a.model}` : ""}`
          : `${a.provider} / ${a.model ?? "unspecified model"}`,
        attributes: custom
          ? { provider: "custom", customProviderId: a.customProviderId }
          : { provider: a.provider, model: a.model },
      });
    }
  }
  for (const v of vendorRows) {
    nodes.set(`vendor:${v.id}`, {
      key: `vendor:${v.id}`,
      type: "vendor",
      id: v.id,
      label: v.name,
      attributes: { status: v.status, category: v.category },
    });
  }

  // -- declared edges ----------------------------------------------------------
  const agentById = new Map(agentRows.map((a) => [a.id, a]));
  for (const u of useCaseRows) {
    for (const agentId of u.intendedAgentIds ?? []) {
      if (agentById.has(agentId)) {
        addEdge({ from: `use_case:${u.id}`, to: `agent:${agentId}`, kind: "uses_agent", basis: "declared" });
      }
    }
  }
  for (const a of agentRows) {
    addEdge({ from: `agent:${a.id}`, to: modelKeyFor(a), kind: "runs_on", basis: "declared" });
  }
  for (const v of vendorRows) {
    const providers = new Set(v.linkedAgentProviders ?? []);
    const customIds = new Set(v.linkedCustomProviderIds ?? []);
    for (const n of nodes.values()) {
      if (n.type !== "model") continue;
      const p = n.attributes.provider as string;
      const matches =
        p === "custom" ? customIds.has(n.attributes.customProviderId as string) : providers.has(p);
      if (matches) addEdge({ from: n.key, to: `vendor:${v.id}`, kind: "supplied_by", basis: "declared" });
    }
  }

  // -- observed edges ----------------------------------------------------------
  if (includeObserved) {
    const windowStart = new Date(now.getTime() - INVENTORY_WINDOW_DAYS * 86_400_000);
    const childSpans = await db
      .select({
        parentSpanId: traceSpans.parentSpanId,
        kind: traceSpans.kind,
        mcpServerId: traceSpans.mcpServerId,
        connectorId: traceSpans.connectorId,
        startedAt: traceSpans.startedAt,
      })
      .from(traceSpans)
      .where(
        and(
          inArray(traceSpans.kind, ["tool", "connector"]),
          isNotNull(traceSpans.parentSpanId),
          gte(traceSpans.startedAt, windowStart),
        ),
      );
    const parentIds = [...new Set(childSpans.map((s) => s.parentSpanId!).filter(Boolean))];
    const parentAgent = new Map<string, string>();
    for (let i = 0; i < parentIds.length; i += 1000) {
      const chunk = parentIds.slice(i, i + 1000);
      const rows = await db
        .select({ id: traceSpans.id, agentId: traceSpans.agentId })
        .from(traceSpans)
        .where(and(inArray(traceSpans.id, chunk), isNotNull(traceSpans.agentId)));
      for (const r of rows) parentAgent.set(r.id, r.agentId!);
    }
    const serverIds = new Set<string>();
    const connectorIds = new Set<string>();
    const observed = new Map<string, { from: string; to: string; kind: GraphEdgeKind; n: number; last: Date }>();
    for (const s of childSpans) {
      const agentId = s.parentSpanId ? parentAgent.get(s.parentSpanId) : undefined;
      if (!agentId) continue;
      let to: string | null = null;
      let kind: GraphEdgeKind | null = null;
      if (s.kind === "tool" && s.mcpServerId) {
        serverIds.add(s.mcpServerId);
        to = `mcp_server:${s.mcpServerId}`;
        kind = "calls_tool";
      } else if (s.kind === "connector" && s.connectorId) {
        connectorIds.add(s.connectorId);
        to = `connector:${s.connectorId}`;
        kind = "calls_connector";
      }
      if (!to || !kind) continue;
      const k = `agent:${agentId}|${to}`;
      const e = observed.get(k) ?? { from: `agent:${agentId}`, to, kind, n: 0, last: s.startedAt };
      e.n += 1;
      if (s.startedAt > e.last) e.last = s.startedAt;
      observed.set(k, e);
    }
    if (serverIds.size) {
      const rows = await db
        .select({ id: mcpServers.id, name: mcpServers.name })
        .from(mcpServers)
        .where(inArray(mcpServers.id, [...serverIds]));
      for (const r of rows) {
        nodes.set(`mcp_server:${r.id}`, { key: `mcp_server:${r.id}`, type: "mcp_server", id: r.id, label: r.name, attributes: {} });
      }
    }
    if (connectorIds.size) {
      const rows = await db
        .select({ id: connectors.id, name: connectors.name, kind: connectors.kind })
        .from(connectors)
        .where(inArray(connectors.id, [...connectorIds]));
      for (const r of rows) {
        nodes.set(`connector:${r.id}`, {
          key: `connector:${r.id}`,
          type: "connector",
          id: r.id,
          label: r.name,
          attributes: { kind: r.kind },
        });
      }
    }
    for (const e of observed.values()) {
      addEdge({ from: e.from, to: e.to, kind: e.kind, basis: "observed", observedCount: e.n, lastSeenAt: e.last.toISOString() });
    }
    // "W consumes X's output": the dependent is the agent that was fed
    for (const f of await computeFeedEdges(db)) {
      addEdge({
        from: `agent:${f.toAgentId}`,
        to: `agent:${f.fromAgentId}`,
        kind: "consumes_output",
        basis: "observed",
        observedCount: f.observedRuns,
        lastSeenAt: f.lastSeenAt,
      });
    }
  }

  // -- own risk per node -------------------------------------------------------
  const riskRows = await db
    .select({
      id: aiRisks.id,
      title: aiRisks.title,
      status: aiRisks.status,
      likelihood: aiRisks.likelihood,
      impact: aiRisks.impact,
      residualLikelihood: aiRisks.residualLikelihood,
      residualImpact: aiRisks.residualImpact,
      agentId: aiRisks.agentId,
      useCaseId: aiRisks.useCaseId,
      vendorId: aiRisks.vendorId,
    })
    .from(aiRisks);
  const own = new Map<string, { rating: RiskRating; riskId: string | null; openRisks: number }>();
  let unattachedRisks = 0;
  for (const r of riskRows) {
    const rating = effectiveRiskRating(r);
    if (!rating) continue;
    const subjects = [
      r.agentId ? `agent:${r.agentId}` : null,
      r.useCaseId ? `use_case:${r.useCaseId}` : null,
      r.vendorId ? `vendor:${r.vendorId}` : null,
    ].filter((k): k is string => k !== null && nodes.has(k));
    if (subjects.length === 0) unattachedRisks += 1;
    for (const k of subjects) {
      const cur = own.get(k);
      const better = !cur || rating.score > cur.rating.score || (rating.score === cur.rating.score && r.id < (cur.riskId ?? ""));
      own.set(k, {
        rating: better ? { score: rating.score, band: rating.band } : cur!.rating,
        riskId: better ? r.id : cur!.riskId,
        openRisks: (cur?.openRisks ?? 0) + 1,
      });
    }
  }

  const allEdges = [...edges.values()];
  const propagated = propagateRisk([...nodes.keys()], own, allEdges);

  // -- scope to one use case: what it depends on, transitively ---------------
  let keep: Set<string> | null = null;
  if (opts.useCaseId) {
    const start = `use_case:${opts.useCaseId}`;
    keep = new Set([start]);
    const queue = [start];
    while (queue.length) {
      const k = queue.shift()!;
      for (const e of allEdges) {
        if (e.from === k && !keep.has(e.to)) {
          keep.add(e.to);
          queue.push(e.to);
        }
      }
    }
  }

  const outNodes: DependencyGraphNode[] = [...nodes.values()]
    .filter((n) => !keep || keep.has(n.key))
    .map((n) => {
      const o = own.get(n.key);
      return {
        ...n,
        ownRisk: o
          ? { ...o.rating, riskId: o.riskId, openRisks: o.openRisks }
          : { score: 0, band: "none" as const, riskId: null, openRisks: 0 },
        propagatedRisk: propagated.get(n.key)!,
      };
    })
    .sort((a, b) => a.type.localeCompare(b.type) || a.label.localeCompare(b.label));
  const outEdges = allEdges.filter((e) => !keep || (keep.has(e.from) && keep.has(e.to)));

  const byType: Record<string, number> = {};
  for (const n of outNodes) byType[n.type] = (byType[n.type] ?? 0) + 1;
  const inherited = outNodes.filter(
    (n) => n.propagatedRisk.sourceNodeKey !== null && n.propagatedRisk.sourceNodeKey !== n.key,
  );

  return {
    generatedAt: now.toISOString(),
    scope: { useCaseId: opts.useCaseId ?? null, includeObserved },
    window: { days: INVENTORY_WINDOW_DAYS, applies: "observed edges only" },
    summary: {
      nodes: outNodes.length,
      edges: outEdges.length,
      byType,
      propagatedHigh: outNodes.filter((n) => n.propagatedRisk.band === "high").length,
      /** nodes whose worst exposure comes from something they depend on, not from their own risks */
      inheritedExposure: inherited.length,
      unattachedRisks: opts.useCaseId ? undefined : unattachedRisks,
    },
    nodes: outNodes,
    edges: outEdges,
    notes: {
      ...DEPENDENCY_GRAPH_NOTES,
      unattached:
        "Risks that name no agent, use case or vendor (for example, project-only risks) are counted but not placed on the graph.",
    },
  };
}

const query = z.object({
  useCaseId: z.string().uuid().optional(),
  includeObserved: z.enum(["true", "false"]).optional(),
});

export function registerDependencyGraphRoutes(app: FastifyInstance, db: Db): void {
  app.get("/v1/inventory/graph", async (req, reply) => {
    const q = query.parse(req.query);
    if (q.useCaseId) {
      const [u] = await db.select({ id: aiUseCases.id }).from(aiUseCases).where(eq(aiUseCases.id, q.useCaseId));
      if (!u) return reply.status(404).send({ error: "unknown_use_case" });
    }
    return computeDependencyGraph(db, {
      useCaseId: q.useCaseId ?? null,
      includeObserved: q.includeObserved !== "false",
    });
  });
}
