/**
 * ADR-0188 S2 (decisions 3, 24, 27) — an agent principal's OWN grants, read for the kernel.
 *
 * One `ActorEntitlements` per identity, from the parallel `identity_*_grants` tables of migration 0180 plus the
 * grants of every role assigned to the identity (`identity_role_assignments` → `role_*_grants`). The kernel then
 * checks each actor of a chain against its own set (`actor-allow-list`); nothing here decides anything.
 *
 * THE ONE RULE THIS FILE ADDS (decision 27): an agent never gets "every mode" or "every object" implicitly. A
 * user's role grant may carry `allowed_modes` / `allowed_objects` = NULL, meaning "all"; for an agent principal
 * such a role grant contributes NOTHING. An admin who wants an agent to have a mode or an object names it, in a
 * direct identity grant or in a role whose grant lists it. Secure by default (ADR-0180): the omission refuses.
 *
 * NOT CACHED. S3's live-chain check (decision 17) reads this at the point of use, so a grant removed after a
 * delegation was minted narrows the very next call.
 *
 * Connector and agent grants are returned as CANDIDATES (one entry per grant, possibly several per connector),
 * never merged: merging a read grant on one object with a readwrite grant on another would invent a readwrite
 * grant on both. The kernel allows when ANY single candidate covers the call, exactly as for a user.
 */
import {
  and,
  eq,
  identityAgentGrants,
  identityConnectorGrants,
  identityRoleAssignments,
  identityServerGrants,
  identityToolGrants,
  inArray,
  roleAgentGrants,
  roleConnectorGrants,
  roleServerGrants,
  roleToolGrants,
  type Db,
} from "@regulait/db";
import type { ActorEntitlements } from "@regulait/policy-kernel";

type Mutable = {
  tools: { serverId: string; toolName: string }[];
  servers: { serverId: string; readOnlyAll: boolean }[];
  agents: { agentId: string; allowedModes: string[] }[];
  connectors: { connectorId: string; mode: "read" | "readwrite"; allowedObjects: string[] }[];
};

/** the stored list, or null when it is not a list of strings (a role's NULL = "all", refused for agents) */
function stringList(v: unknown): string[] | null {
  return Array.isArray(v) && v.every((x) => typeof x === "string") ? [...new Set(v as string[])] : null;
}

/**
 * Load the own entitlements of each identity. An identity with no rows maps to empty lists (OWNER DECISION 1:
 * every identity starts with nothing). Every requested id is present in the result.
 */
export async function loadActorEntitlements(db: Db, identityIds: readonly string[]): Promise<Map<string, ActorEntitlements>> {
  const ids = [...new Set(identityIds)];
  const out = new Map<string, Mutable>(ids.map((id) => [id, { tools: [], servers: [], agents: [], connectors: [] }]));
  if (ids.length === 0) return out;

  const [tools, servers, agents, connectors, roleRows] = await Promise.all([
    db.select().from(identityToolGrants).where(inArray(identityToolGrants.identityId, ids)),
    db.select().from(identityServerGrants).where(inArray(identityServerGrants.identityId, ids)),
    db.select().from(identityAgentGrants).where(inArray(identityAgentGrants.identityId, ids)),
    db.select().from(identityConnectorGrants).where(inArray(identityConnectorGrants.identityId, ids)),
    db
      .select({ identityId: identityRoleAssignments.identityId, roleId: identityRoleAssignments.roleId })
      .from(identityRoleAssignments)
      .where(inArray(identityRoleAssignments.identityId, ids)),
  ]);

  for (const g of tools) out.get(g.identityId)!.tools.push({ serverId: g.serverId, toolName: g.toolName });
  for (const g of servers) out.get(g.identityId)!.servers.push({ serverId: g.serverId, readOnlyAll: g.readOnlyAll });
  for (const g of agents) {
    const modes = stringList(g.allowedModes);
    if (modes) out.get(g.identityId)!.agents.push({ agentId: g.agentId, allowedModes: modes });
  }
  for (const g of connectors) {
    const objects = stringList(g.allowedObjects);
    if (objects) out.get(g.identityId)!.connectors.push({ connectorId: g.connectorId, mode: g.mode, allowedObjects: objects });
  }

  const roleIds = [...new Set(roleRows.map((r) => r.roleId))];
  if (roleIds.length) {
    const [rTools, rServers, rAgents, rConnectors] = await Promise.all([
      db.select().from(roleToolGrants).where(inArray(roleToolGrants.roleId, roleIds)),
      db.select().from(roleServerGrants).where(and(inArray(roleServerGrants.roleId, roleIds), eq(roleServerGrants.readOnlyAll, true))),
      db.select().from(roleAgentGrants).where(inArray(roleAgentGrants.roleId, roleIds)),
      db.select().from(roleConnectorGrants).where(inArray(roleConnectorGrants.roleId, roleIds)),
    ]);
    for (const { identityId, roleId } of roleRows) {
      const e = out.get(identityId)!;
      for (const g of rTools) if (g.roleId === roleId) e.tools.push({ serverId: g.serverId, toolName: g.toolName });
      for (const g of rServers) if (g.roleId === roleId) e.servers.push({ serverId: g.serverId, readOnlyAll: true });
      for (const g of rAgents) {
        if (g.roleId !== roleId) continue;
        const modes = stringList(g.allowedModes); // NULL ("every mode") contributes nothing for an agent
        if (modes) e.agents.push({ agentId: g.agentId, allowedModes: modes });
      }
      for (const g of rConnectors) {
        if (g.roleId !== roleId) continue;
        const objects = stringList(g.allowedObjects); // NULL ("every object") contributes nothing for an agent
        if (objects) e.connectors.push({ connectorId: g.connectorId, mode: g.mode, allowedObjects: objects });
      }
    }
  }

  // de-duplicate the two shapes whose duplicates carry no extra meaning
  for (const e of out.values()) {
    e.tools = [...new Map(e.tools.map((t) => [`${t.serverId}\u0000${t.toolName}`, t])).values()];
    e.servers = [
      ...new Map(
        e.servers.map((s) => [s.serverId, { serverId: s.serverId, readOnlyAll: e.servers.some((x) => x.serverId === s.serverId && x.readOnlyAll) }]),
      ).values(),
    ];
  }
  return out;
}
