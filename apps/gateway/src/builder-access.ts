/**
 * ADR-0172 — who may see, edit and use what in the agent builder.
 *
 * Every rule here REUSES an existing entitlement source rather than restating
 * one: model bindings go through the copilot's `agentDecision` (the same
 * `evaluateAgent` path an invoke takes), connectors through the direct + role
 * grants minus revocations that `GET /v1/users/:id/connectors` shows, and MCP
 * tools through `loadEntitlements` + the kernel's `visibleTools` (with the
 * ADR-0097 admission hold) that `GET /v1/users/:id/servers/:id/tools` uses.
 */
import {
  agentGrants,
  agents,
  and,
  asc,
  builderAgentShares,
  builderAgents,
  connectorGrants,
  connectors,
  eq,
  inArray,
  isNull,
  mcpServers,
  mcpTools,
  or,
  userAgentPolicies,
  type BuilderAgentRow,
  type Db,
} from "@regulait/db";
import { visibleTools, type ToolRef } from "@regulait/policy-kernel";
import { agentDecision } from "./copilot.js";
import type { AgentRow } from "./agents-connectors.js";
import {
  loadConnectorRevocations,
  loadEntitlements,
  loadRoleAgentGrants,
  loadRoleConnectorGrants,
} from "./entitlements.js";
import { admissionHidesTools } from "./mcp-admission.js";

export interface Viewer {
  userId: string;
  isAdmin: boolean;
}

/** visible: owner, everyone when shared with the workspace, listed people,
 * and admins. Archived agents are visible to nobody through the builder. */
export function canSeeAgent(agent: BuilderAgentRow, viewer: Viewer, sharedWithViewer: boolean): boolean {
  if (agent.archivedAt) return false;
  if (viewer.isAdmin) return true;
  if (agent.ownerUserId === viewer.userId) return true;
  if (agent.sharing === "workspace") return true;
  return agent.sharing === "people" && sharedWithViewer;
}

export function canEditAgent(agent: BuilderAgentRow, viewer: Viewer): boolean {
  return !agent.archivedAt && (viewer.isAdmin || agent.ownerUserId === viewer.userId);
}

/** every non-archived agent the viewer may see */
export async function listVisibleAgents(db: Db, viewer: Viewer): Promise<BuilderAgentRow[]> {
  if (viewer.isAdmin) {
    return db.select().from(builderAgents).where(isNull(builderAgents.archivedAt)).orderBy(asc(builderAgents.name));
  }
  const shared = await db
    .select({ agentId: builderAgentShares.agentId })
    .from(builderAgentShares)
    .where(eq(builderAgentShares.userId, viewer.userId));
  const sharedIds = shared.map((s) => s.agentId);
  const visibility = [eq(builderAgents.ownerUserId, viewer.userId), eq(builderAgents.sharing, "workspace")];
  if (sharedIds.length) {
    visibility.push(and(eq(builderAgents.sharing, "people"), inArray(builderAgents.id, sharedIds))!);
  }
  return db
    .select()
    .from(builderAgents)
    .where(and(isNull(builderAgents.archivedAt), or(...visibility)))
    .orderBy(asc(builderAgents.name));
}

/** load one agent if the viewer may see it: `null` = unknown OR invisible
 * (a 404 either way, so ids cannot be probed) */
export async function loadVisibleAgent(db: Db, id: string, viewer: Viewer): Promise<BuilderAgentRow | null> {
  const [agent] = await db.select().from(builderAgents).where(eq(builderAgents.id, id));
  if (!agent) return null;
  const [share] = await db
    .select({ agentId: builderAgentShares.agentId })
    .from(builderAgentShares)
    .where(and(eq(builderAgentShares.agentId, id), eq(builderAgentShares.userId, viewer.userId)));
  return canSeeAgent(agent, viewer, !!share) ? agent : null;
}

// ---------------------------------------------------------------------------
// model bindings
// ---------------------------------------------------------------------------

/** may this user dispatch to this registry agent? The invoke path's check. */
export async function modelAllowed(db: Db, userId: string, agent: AgentRow): Promise<boolean> {
  return (await agentDecision(db, userId, agent)).effect === "allow";
}

/** the user's default binding if they may use it, else the first (by name)
 * dispatchable binding they may use; null when they hold none */
export async function defaultModelFor(db: Db, userId: string): Promise<AgentRow | null> {
  const [policy] = await db.select().from(userAgentPolicies).where(eq(userAgentPolicies.userId, userId));
  if (policy?.defaultAgentId) {
    const [preferred] = await db.select().from(agents).where(eq(agents.id, policy.defaultAgentId));
    if (preferred && preferred.model && (await modelAllowed(db, userId, preferred))) return preferred;
  }
  const [direct, role] = await Promise.all([
    db.select({ agentId: agentGrants.agentId }).from(agentGrants).where(eq(agentGrants.userId, userId)),
    loadRoleAgentGrants(db, userId),
  ]);
  const ids = [...new Set([...direct.map((g) => g.agentId), ...role.map((g) => g.agentId)])];
  if (!ids.length) return null;
  const candidates = await db.select().from(agents).where(inArray(agents.id, ids)).orderBy(asc(agents.name));
  for (const c of candidates) {
    if (!c.model) continue;
    if (await modelAllowed(db, userId, c)) return c;
  }
  return null;
}

// ---------------------------------------------------------------------------
// toolbox entitlements
// ---------------------------------------------------------------------------

/** connector ids the user holds a grant for (direct or via a role), minus a
 * FULL per-user revocation — the Access-preview's own picture */
export async function entitledConnectorIds(db: Db, userId: string): Promise<Set<string>> {
  const [direct, role, revoked] = await Promise.all([
    db.select({ connectorId: connectorGrants.connectorId }).from(connectorGrants).where(eq(connectorGrants.userId, userId)),
    loadRoleConnectorGrants(db, userId),
    loadConnectorRevocations(db, userId),
  ]);
  const full = new Set(revoked.filter((r) => (r.scope ?? "full") === "full").map((r) => r.connectorId));
  const out = new Set<string>();
  for (const g of [...direct, ...role]) if (!full.has(g.connectorId)) out.add(g.connectorId);
  return out;
}

export interface McpToolInfo {
  id: string;
  name: string;
  serverId: string;
  serverName: string;
  kind: "read" | "write";
}

export async function loadMcpTools(db: Db, toolIds: string[]): Promise<McpToolInfo[]> {
  if (!toolIds.length) return [];
  return db
    .select({
      id: mcpTools.id,
      name: mcpTools.name,
      serverId: mcpTools.serverId,
      serverName: mcpServers.name,
      kind: mcpTools.kind,
    })
    .from(mcpTools)
    .innerJoin(mcpServers, eq(mcpTools.serverId, mcpServers.id))
    .where(inArray(mcpTools.id, toolIds));
}

/** of these MCP tools, the ids the user may see (kernel `visibleTools`, which
 * keeps approval-gated tools and drops hard denies) on servers whose admission
 * verdict does not hide their tools */
export async function entitledMcpToolIds(db: Db, userId: string, tools: McpToolInfo[]): Promise<Set<string>> {
  const out = new Set<string>();
  const byServer = new Map<string, McpToolInfo[]>();
  for (const t of tools) byServer.set(t.serverId, [...(byServer.get(t.serverId) ?? []), t]);
  for (const [serverId, list] of byServer) {
    if (await admissionHidesTools(db, serverId)) continue;
    const ent = await loadEntitlements(db, userId, serverId);
    const refs: ToolRef[] = list.map((t) => ({ serverId, name: t.name, kind: t.kind }));
    const visible = new Set(visibleTools(userId, serverId, refs, ent).map((r) => r.name));
    for (const t of list) if (visible.has(t.name)) out.add(t.id);
  }
  return out;
}

export async function loadConnectorsById(db: Db, ids: string[]) {
  if (!ids.length) return [];
  return db
    .select({ id: connectors.id, name: connectors.name, kind: connectors.kind, providerKind: connectors.providerKind })
    .from(connectors)
    .where(inArray(connectors.id, ids));
}
