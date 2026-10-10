/**
 * ADR-0188 S4 test fixture: give an agent grants OF ITS OWN, the way an admin does.
 *
 * S4 switches the in-process agent paths (pillar-7 workers, builder turns and
 * schedules, engine runs) on under the strict default `agent_entitlement_mode =
 * own_grants` (OWNER DECISION 1, ADR-0180): an agent with no grants of its own is
 * refused (`actor-allow-list`), whatever its sponsor holds. A suite whose agents
 * must act grants them here, through `putIdentityGrants` — the same service
 * `PUT /v1/workload-identities/:id/grants` runs, never raw SQL — so the suite
 * stays under the strict default. The grant is ADDITIVE: it merges into the set
 * the identity already has (re-reading the revision), so two fixtures in one file
 * never overwrite each other.
 *
 * Granting is preferred to relaxing. `relaxAgentEntitlementsForTest` exists only
 * for a suite where granting in the fixture is impractical; it switches the org
 * to `sponsor_only` (which still applies every delegation term) and the returned
 * function restores the strict value (M-068).
 */
import { builderAgents, builderAgentTools, eq, inArray, mcpTools, orgSettings, ORG_SETTINGS_ID, type Db } from "@regulait/db";
import type { PutAgentGrants } from "@regulait/shared";
import { ensureIdentityFor, type InternalSubject } from "../in-process-delegation.js";
import { loadOrgSettings } from "../org-settings.js";
import { getIdentityGrants, putIdentityGrants } from "../workload-identity-admin.js";

/** the modes a test agent is granted on itself when none are named (every mode the suites use) */
export const TEST_AGENT_MODES = ["execute", "plan", "chat", "ask", "review", "read", "apply", "dry_run"] as const;

export interface OwnGrantsForTest {
  tools?: Array<{ serverId: string; toolName: string }>;
  servers?: Array<{ serverId: string; readOnlyAll: boolean }>;
  agents?: Array<{ agentId: string; allowedModes: string[] }>;
  connectors?: Array<{ connectorId: string; mode: "read" | "readwrite"; allowedObjects: string[] }>;
  roleIds?: string[];
}

function mergeBy<T>(a: readonly T[], b: readonly T[], key: (v: T) => string, merge?: (x: T, y: T) => T): T[] {
  const out = new Map<string, T>();
  for (const v of a) out.set(key(v), v);
  for (const v of b) {
    const k = key(v);
    const prev = out.get(k);
    out.set(k, prev && merge ? merge(prev, v) : v);
  }
  return [...out.values()];
}

/**
 * Add `grants` to the own grant set of `subject`'s workload identity (created if
 * absent). Returns the identity id.
 */
export async function grantOwnGrantsForTest(db: Db, subject: InternalSubject, grants: OwnGrantsForTest): Promise<string> {
  const ident = await ensureIdentityFor(db, subject);
  const cur = (await getIdentityGrants(db, ident.id))!;
  const next: PutAgentGrants = {
    revision: cur.revision,
    tools: mergeBy(cur.tools, grants.tools ?? [], (t) => `${t.serverId}/${t.toolName}`),
    servers: mergeBy(cur.servers, grants.servers ?? [], (t) => t.serverId, (x, y) => ({ serverId: x.serverId, readOnlyAll: x.readOnlyAll || y.readOnlyAll })),
    agents: mergeBy(cur.agents, grants.agents ?? [], (t) => t.agentId, (x, y) => ({ agentId: x.agentId, allowedModes: [...new Set([...x.allowedModes, ...y.allowedModes])] })),
    connectors: mergeBy(
      cur.connectors,
      grants.connectors ?? [],
      (t) => t.connectorId,
      (x, y) => ({
        connectorId: x.connectorId,
        mode: x.mode === "readwrite" || y.mode === "readwrite" ? "readwrite" : "read",
        allowedObjects: [...new Set([...x.allowedObjects, ...y.allowedObjects])],
      }),
    ),
    roleIds: [...new Set([...cur.roleIds, ...(grants.roleIds ?? [])])],
  };
  await putIdentityGrants(db, ident.id, next, null);
  return ident.id;
}

/**
 * The common case: an agent may be dispatched as itself (its own model) in the
 * named modes, and may call the named tools. Returns the identity id.
 */
export async function grantAgentOwnGrantsForTest(
  db: Db,
  agentId: string,
  opts: { modes?: readonly string[]; tools?: OwnGrantsForTest["tools"]; agents?: OwnGrantsForTest["agents"]; connectors?: OwnGrantsForTest["connectors"] } = {},
): Promise<string> {
  return grantOwnGrantsForTest(db, { kind: "agent", id: agentId }, {
    agents: [{ agentId, allowedModes: [...(opts.modes ?? TEST_AGENT_MODES)] }, ...(opts.agents ?? [])],
    ...(opts.tools ? { tools: opts.tools } : {}),
    ...(opts.connectors ? { connectors: opts.connectors } : {}),
  });
}

/** for a suite where granting is impractical ONLY: `sponsor_only` for this file; restore() puts `own_grants` back */
export async function relaxAgentEntitlementsForTest(db: Db): Promise<() => Promise<void>> {
  await loadOrgSettings(db);
  await db.update(orgSettings).set({ agentEntitlementMode: "sponsor_only" }).where(eq(orgSettings.id, ORG_SETTINGS_ID));
  return async () => {
    await db.update(orgSettings).set({ agentEntitlementMode: "own_grants" }).where(eq(orgSettings.id, ORG_SETTINGS_ID));
  };
}

/** the connector objects a test builder agent is granted by default (the objects the suites name) */
export const TEST_CONNECTOR_OBJECTS = ["customers", "inbox"] as const;

/**
 * A builder agent's own grants, matched to what it is CONFIGURED with: its model
 * in `chat`, every MCP tool in its toolbox, and readwrite on every connector in
 * its toolbox for `connectorObjects`. What an admin grants a builder agent they
 * have reviewed. Returns the identity id, or null when the agent does not exist.
 */
export async function grantBuilderAgentConfiguredForTest(
  db: Db,
  builderAgentId: string,
  opts: { connectorObjects?: readonly string[] } = {},
): Promise<string | null> {
  const [agent] = await db.select().from(builderAgents).where(eq(builderAgents.id, builderAgentId));
  if (!agent) return null;
  const tools = await db.select().from(builderAgentTools).where(eq(builderAgentTools.agentId, builderAgentId));
  const mcpIds = tools.filter((t) => t.kind === "mcp_tool").map((t) => t.refId);
  const mcpRows = mcpIds.length ? await db.select().from(mcpTools).where(inArray(mcpTools.id, mcpIds)) : [];
  return grantOwnGrantsForTest(db, { kind: "builder_agent", id: builderAgentId }, {
    agents: agent.modelAgentId ? [{ agentId: agent.modelAgentId, allowedModes: ["chat"] }] : [],
    tools: mcpRows.map((m) => ({ serverId: m.serverId, toolName: m.name })),
    connectors: tools
      .filter((t) => t.kind === "connector")
      .map((t) => ({ connectorId: t.refId, mode: "readwrite" as const, allowedObjects: [...(opts.connectorObjects ?? TEST_CONNECTOR_OBJECTS)] })),
  });
}

/**
 * For a suite whose agents are created inline in many places (no one `mkAgent`): every agent created
 * through `POST /v1/agents` on this app is then granted ITSELF in every test mode, through the same
 * service an admin's PUT runs, so the suite's pillar-7 workers act under the strict `own_grants`
 * default. Tools are NOT granted here (a tool-using worker needs `grantAgentOwnGrantsForTest` with its
 * tools). The wrapper applies to the object form of `app.inject`, the only form the suites use.
 */
export function autoGrantCreatedAgentsForTest(app: { inject: unknown }, db: Db): void {
  type Res = { statusCode: number; json: () => unknown };
  const original = (app.inject as (o: unknown) => Promise<Res>).bind(app);
  (app as { inject: unknown }).inject = async (o: { method?: string; url?: string }) => {
    const res = await original(o);
    if (o && typeof o === "object" && o.method === "POST" && o.url === "/v1/agents" && res.statusCode === 201) {
      const id = (res.json() as { id?: string }).id;
      if (id) await grantAgentOwnGrantsForTest(db, id);
    }
    return res;
  };
}
