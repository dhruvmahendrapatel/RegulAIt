/**
 * ADR-0339 addendum — the capabilities an agent holds, one row per tool, connector, inbound channel or computer use,
 * for the risk score's capability combinations (`capabilityLegs` in @regulait/shared).
 *
 *  - A BUILDER agent's own bindings: `builder_agent_tools` (Ask-first is `requires_approval`), its inbound channels
 *    (Slack or Teams with a connection, the same rule as `loadAutonomyFacts`) and computer use.
 *  - A REGISTRY agent's workload identity grants (ADR-0262, direct and through identity roles, merged by
 *    `loadActorEntitlements`). A registry agent has no Ask-first switch, so `askFirst` is null (unconfirmed). An agent
 *    with no active identity holds nothing of its own: the result is null ("not applicable").
 *
 * Every classification fails closed:
 *  - an MCP tool reads or writes by its `kind` (a tool with no `readOnlyHint` is a write, mcp-proxy);
 *  - it reaches the open world unless its ADMITTED definition says `openWorldHint: false` (the MCP default is true);
 *  - a write is destructive when an admin marked it dangerous (ADR-0236), or unless its admitted definition says
 *    `destructiveHint: false` (the MCP default for a non-read tool is true);
 *  - a source nobody classified is untrusted (ADR-0193 `DEFAULT_CONTENT_TRUST_TIER`).
 * A connector reads and writes by its provider (`connectorOperations`), never reaches the open world on a read, and is
 * not destructive (connectors carry no annotations).
 */
import {
  and,
  builderAgentChannels,
  builderAgents,
  builderAgentTools,
  connectors,
  contentTrustTiers,
  count,
  eq,
  inArray,
  isNotNull,
  isNull,
  mcpDefinitionPins,
  mcpTools,
  ne,
  or,
  workloadIdentities,
  type Db,
} from "@regulait/db";
import type { AgentRiskCapability, AgentRiskSourceTier } from "@regulait/shared";
import { loadActorEntitlements } from "./actor-entitlements.js";
import { connectorOperations } from "./builder-tools.js";

const INBOUND_CHANNEL_PROVIDERS = ["slack", "teams"] as const;

interface ToolRow {
  id: string;
  serverId: string;
  name: string;
  kind: "read" | "write";
  dangerous: boolean;
}

/** the admitted annotations of each tool (server id + name), from the approved definition pin */
async function admittedAnnotations(db: Db, tools: readonly ToolRow[]): Promise<Map<string, Record<string, unknown>>> {
  const out = new Map<string, Record<string, unknown>>();
  if (!tools.length) return out;
  const rows = await db
    .select({ serverId: mcpDefinitionPins.serverId, name: mcpDefinitionPins.name, def: mcpDefinitionPins.approvedDefinition })
    .from(mcpDefinitionPins)
    .where(
      and(
        eq(mcpDefinitionPins.kind, "tool"),
        isNotNull(mcpDefinitionPins.approvedDigest),
        inArray(mcpDefinitionPins.serverId, [...new Set(tools.map((t) => t.serverId))]),
      ),
    );
  for (const r of rows) {
    const ann = r.def && typeof r.def === "object" ? (r.def as { annotations?: unknown }).annotations : undefined;
    if (ann && typeof ann === "object") out.set(`${r.serverId}\u0000${r.name}`, ann as Record<string, unknown>);
  }
  return out;
}

/** the ADR-0193 tier of each source (absent = unclassified, which reads as untrusted) */
async function sourceTiers(db: Db, serverIds: readonly string[], connectorIds: readonly string[]): Promise<Map<string, AgentRiskSourceTier>> {
  const out = new Map<string, AgentRiskSourceTier>();
  const conds = [
    ...(serverIds.length ? [and(eq(contentTrustTiers.sourceKind, "mcp_server"), inArray(contentTrustTiers.sourceId, [...new Set(serverIds)]))] : []),
    ...(connectorIds.length ? [and(eq(contentTrustTiers.sourceKind, "connector"), inArray(contentTrustTiers.sourceId, [...new Set(connectorIds)]))] : []),
  ];
  if (!conds.length) return out;
  const rows = await db.select().from(contentTrustTiers).where(or(...conds));
  for (const r of rows) out.set(`${r.sourceKind}:${r.sourceId}`, r.tier as AgentRiskSourceTier);
  return out;
}

/** how many OTHER builder agents bind each tool or connector (the blast radius of removing it) */
async function bindingCounts(db: Db, refIds: readonly string[], exceptAgentId: string | null): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!refIds.length) return out;
  const rows = await db
    .select({ refId: builderAgentTools.refId, n: count() })
    .from(builderAgentTools)
    .innerJoin(builderAgents, eq(builderAgents.id, builderAgentTools.agentId))
    .where(
      and(
        inArray(builderAgentTools.refId, [...new Set(refIds)]),
        isNull(builderAgents.archivedAt),
        ...(exceptAgentId ? [ne(builderAgentTools.agentId, exceptAgentId)] : []),
      ),
    )
    .groupBy(builderAgentTools.refId);
  for (const r of rows) out.set(r.refId, Number(r.n));
  return out;
}

async function toolCapabilities(
  db: Db,
  tools: readonly ToolRow[],
  askFirstOf: (toolId: string) => boolean | null,
  readOnly: (toolId: string) => boolean,
  shared: Map<string, number>,
): Promise<AgentRiskCapability[]> {
  const [ann, tiers] = await Promise.all([admittedAnnotations(db, tools), sourceTiers(db, tools.map((t) => t.serverId), [])]);
  return tools.map((t) => {
    const a = ann.get(`${t.serverId}\u0000${t.name}`) ?? {};
    const writes = t.kind === "write" && !readOnly(t.id);
    return {
      kind: "mcp_tool",
      id: t.id,
      name: t.name,
      reads: t.kind === "read",
      writes,
      askFirst: askFirstOf(t.id),
      sourceTier: tiers.get(`mcp_server:${t.serverId}`) ?? "untrusted",
      openWorld: a.openWorldHint !== false,
      destructive: writes && (t.dangerous || a.destructiveHint !== false),
      sharedWith: shared.get(t.id) ?? 0,
    };
  });
}

async function connectorCapabilities(
  db: Db,
  rows: ReadonlyArray<{ id: string; name: string; providerKind: string | null; readOnly: boolean; askFirst: boolean | null }>,
  shared: Map<string, number>,
): Promise<AgentRiskCapability[]> {
  const tiers = await sourceTiers(db, [], rows.map((r) => r.id));
  return rows.map((c) => {
    const ops = connectorOperations(c.providerKind);
    return {
      kind: "connector",
      id: c.id,
      name: c.name,
      reads: ops.includes("read"),
      writes: ops.includes("write") && !c.readOnly,
      askFirst: c.askFirst,
      sourceTier: tiers.get(`connector:${c.id}`) ?? "untrusted",
      openWorld: false,
      destructive: false,
      sharedWith: shared.get(c.id) ?? 0,
    };
  });
}

/** a builder agent's own capabilities */
export async function builderAgentCapabilities(db: Db, agent: { id: string; computerUse: boolean }): Promise<AgentRiskCapability[]> {
  const bound = await db
    .select({ kind: builderAgentTools.kind, refId: builderAgentTools.refId, requiresApproval: builderAgentTools.requiresApproval })
    .from(builderAgentTools)
    .where(eq(builderAgentTools.agentId, agent.id));
  const askFirst = new Map(bound.map((t) => [t.refId, !!t.requiresApproval]));
  const mcpIds = bound.filter((t) => t.kind === "mcp_tool").map((t) => t.refId);
  const connectorIds = bound.filter((t) => t.kind === "connector").map((t) => t.refId);
  const [tools, conns, channels, shared] = await Promise.all([
    mcpIds.length
      ? db.select({ id: mcpTools.id, serverId: mcpTools.serverId, name: mcpTools.name, kind: mcpTools.kind, dangerous: mcpTools.dangerous }).from(mcpTools).where(inArray(mcpTools.id, mcpIds))
      : Promise.resolve([] as ToolRow[]),
    connectorIds.length
      ? db
          .select({ id: connectors.id, name: connectors.name, providerKind: connectors.providerKind })
          .from(connectors)
          .where(and(inArray(connectors.id, connectorIds), isNull(connectors.disabledAt)))
      : Promise.resolve([]),
    db
      .select({ id: builderAgentChannels.id, provider: builderAgentChannels.provider })
      .from(builderAgentChannels)
      .where(
        and(
          eq(builderAgentChannels.agentId, agent.id),
          inArray(builderAgentChannels.provider, [...INBOUND_CHANNEL_PROVIDERS]),
          isNotNull(builderAgentChannels.chatopsConnectionId),
        ),
      ),
    bindingCounts(db, [...mcpIds, ...connectorIds], agent.id),
  ]);
  return [
    ...(await toolCapabilities(db, tools as ToolRow[], (id) => askFirst.get(id) ?? false, () => false, shared)),
    ...(await connectorCapabilities(db, conns.map((c) => ({ ...c, readOnly: false, askFirst: askFirst.get(c.id) ?? false })), shared)),
    ...channels.map(
      (c): AgentRiskCapability => ({
        kind: "channel", id: c.id, name: `${c.provider} inbound channel`, reads: false, writes: false, askFirst: null,
        sourceTier: null, openWorld: false, destructive: false, sharedWith: 0,
      }),
    ),
    ...(agent.computerUse
      ? [{ kind: "computer_use", id: agent.id, name: "computer use", reads: false, writes: false, askFirst: null, sourceTier: null, openWorld: false, destructive: false, sharedWith: 0 } as AgentRiskCapability]
      : []),
  ];
}

/**
 * A registry agent's capabilities: what its active workload identity is granted (direct and through roles). Null when
 * it has no active identity: it then acts only with its caller's entitlements and holds nothing of its own.
 */
export async function registryAgentCapabilities(db: Db, agentId: string): Promise<AgentRiskCapability[] | null> {
  const [identity] = await db
    .select({ id: workloadIdentities.id })
    .from(workloadIdentities)
    .where(and(eq(workloadIdentities.agentId, agentId), eq(workloadIdentities.status, "active")));
  if (!identity) return null;
  const ent = (await loadActorEntitlements(db, [identity.id])).get(identity.id);
  if (!ent) return [];

  // tools: each named grant, and every tool of a server grant (read tools only when it is read-only)
  const serverIds = [...new Set([...ent.tools.map((t) => t.serverId), ...ent.servers.map((s) => s.serverId)])];
  const rows: ToolRow[] = serverIds.length
    ? await db
        .select({ id: mcpTools.id, serverId: mcpTools.serverId, name: mcpTools.name, kind: mcpTools.kind, dangerous: mcpTools.dangerous })
        .from(mcpTools)
        .where(inArray(mcpTools.serverId, serverIds))
    : [];
  const named = new Set(ent.tools.map((t) => `${t.serverId}\u0000${t.toolName}`));
  const readOnlyServers = new Set(ent.servers.filter((s) => s.readOnlyAll).map((s) => s.serverId));
  const wholeServers = new Set(ent.servers.map((s) => s.serverId));
  const held = rows.filter((r) => named.has(`${r.serverId}\u0000${r.name}`) || wholeServers.has(r.serverId));
  // a tool granted only through a read-only server grant cannot write
  const readOnlyTool = (id: string) => {
    const r = held.find((t) => t.id === id)!;
    return readOnlyServers.has(r.serverId) && !named.has(`${r.serverId}\u0000${r.name}`) && !ent.servers.some((s) => s.serverId === r.serverId && !s.readOnlyAll);
  };
  const toolsHeld = held.filter((t) => !(readOnlyTool(t.id) && t.kind === "write"));

  const connectorModes = new Map<string, "read" | "readwrite">();
  for (const g of ent.connectors) if (connectorModes.get(g.connectorId) !== "readwrite") connectorModes.set(g.connectorId, g.mode as "read" | "readwrite");
  const conns = connectorModes.size
    ? await db
        .select({ id: connectors.id, name: connectors.name, providerKind: connectors.providerKind })
        .from(connectors)
        .where(and(inArray(connectors.id, [...connectorModes.keys()]), isNull(connectors.disabledAt)))
    : [];
  const shared = await bindingCounts(db, [...toolsHeld.map((t) => t.id), ...conns.map((c) => c.id)], null);
  return [
    ...(await toolCapabilities(db, toolsHeld, () => null, readOnlyTool, shared)),
    ...(await connectorCapabilities(db, conns.map((c) => ({ ...c, readOnly: connectorModes.get(c.id) === "read", askFirst: null })), shared)),
  ];
}
