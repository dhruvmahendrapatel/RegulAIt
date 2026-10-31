/**
 * ADR-0207 — LIFECYCLE FOR CONNECTORS, MCP SERVERS AND MCP REGISTRIES (G3, G4).
 *
 * The order is fixed: a live object is DISABLED first (a reason is required, audited as a `deny`), and only a disabled
 * one can be DELETED. ENABLING again lifts a stop, so it is a `settings_relax` step-up (the same class as re-enabling an
 * agent). Disabling and deleting only remove access, so neither needs one.
 *
 * WHAT A DISABLE DOES. `disabled_at` is read on every governed call: a disabled connector refuses in
 * `executeGovernedConnectorCall` (and the ChatOps courier), a disabled server in the MCP proxy route and in
 * `executeGovernedToolCall` (people, agents and delegated workers alike). Both columns advance the policy epoch
 * (0122's statement trigger on `connectors`, 0220's row trigger on `mcp_servers`), so a call decided before the
 * disable is withheld at its next epoch check, and a call that waited for an approval is refused when it comes back.
 *
 * WHAT A DELETE REFUSES. Evidence is never cascaded away: approvals (and ChatOps connections, which carry decided
 * cards) block a connector delete; approvals, agent grants and versioned rules (approval rules, data-scope rules, rate
 * limits, which ADR-0074 versions) block a server delete. The refusal names the counts and up to `IDS_SHOWN` ids of
 * each. What the delete does cascade (grants, revocations, credentials, tools) is counted in its audit row, written in
 * the same transaction as the delete.
 *
 * Every route here is admin-only through the default gate (none is in `NON_ADMIN_ROUTES`), CSRF-checked by the
 * global cookie gate and versioned under `/v1`. Open source first (ADR-0176): no library is involved; this reuses
 * Fastify, drizzle, zod and the existing step-up and audit helpers. What is ours is the lifecycle rule.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  and,
  auditLog,
  connectors,
  eq,
  inArray,
  isNotNull,
  isNull,
  mcpRegistries,
  mcpServers,
  sql,
  users,
  type Db,
} from "@regulait/db";
import { setIntegrationEnabledSchema } from "@regulait/shared";
import { CHANGED_CONCURRENTLY, requireStepUp } from "./step-up.js";

const NIL_USER = "00000000-0000-0000-0000-000000000000";
/** a refusal lists at most this many blocking ids of each kind; the counts are always exact */
export const IDS_SHOWN = 20;

/** Distinct rule ids per event, so an operator alerting on one never matches another. */
export const INTEGRATION_LIFECYCLE_RULE_IDS = {
  connectorDisabled: "connector-disabled",
  connectorEnabled: "connector-enabled",
  connectorRemoved: "connector-removed",
  serverDisabled: "mcp-server-disabled",
  serverEnabled: "mcp-server-enabled",
  serverRemoved: "mcp-server-removed",
  registryRemoved: "mcp-registry-removed",
} as const;

const connectorParam = z.object({ connectorId: z.string().uuid() });
const serverParam = z.object({ serverId: z.string().uuid() });
const registryParam = z.object({ registryId: z.string().uuid() });

interface DisableColumns {
  disabledAt: Date | null;
  disabledReason: string | null;
  disabledBy: string | null;
}

/** the lifecycle fields a list row carries: `enabled`, and who disabled it by email (null when unknown) */
export async function withLifecycle<T extends DisableColumns>(
  db: Db,
  rows: readonly T[],
): Promise<Array<Omit<T, "disabledBy"> & { enabled: boolean; disabledBy: string | null }>> {
  const ids = [...new Set(rows.map((r) => r.disabledBy).filter((v): v is string => v !== null))];
  const emails = ids.length
    ? new Map((await db.select({ id: users.id, email: users.email }).from(users).where(inArray(users.id, ids))).map((u) => [u.id, u.email]))
    : new Map<string, string>();
  return rows.map((r) => ({ ...r, enabled: r.disabledAt === null, disabledBy: r.disabledBy ? (emails.get(r.disabledBy) ?? null) : null }));
}

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** `select count(*)` over a table this module must not name by its drizzle symbol (ADR-0074's rule tables are
 * scanned by `rule-write-guard.test.ts`; this module only reads them) */
async function countWhere(tx: Tx | Db, table: string, column: string, id: string): Promise<{ n: number; ids: string[] }> {
  const res = await tx.execute<{ id: string }>(
    sql`SELECT id::text AS id FROM ${sql.identifier(table)} WHERE ${sql.identifier(column)} = ${id} ORDER BY id LIMIT ${IDS_SHOWN}`,
  );
  const total = await tx.execute<{ n: number }>(
    sql`SELECT count(*)::int AS n FROM ${sql.identifier(table)} WHERE ${sql.identifier(column)} = ${id}`,
  );
  return { n: total.rows[0]?.n ?? 0, ids: res.rows.map((r) => r.id) };
}

const actor = (req: FastifyRequest) => req.authCtx.userId ?? null;

export function registerIntegrationLifecycleRoutes(app: FastifyInstance, db: Db) {
  // -------------------------------------------------------------------------
  // G3 — connectors
  // -------------------------------------------------------------------------

  app.post("/v1/connectors/:connectorId/enabled", async (req, reply) => {
    const { connectorId } = connectorParam.parse(req.params);
    const body = setIntegrationEnabledSchema.parse(req.body);
    const [before] = await db.select().from(connectors).where(eq(connectors.id, connectorId));
    if (!before) return reply.status(404).send({ error: "unknown_connector" });
    const [view] = await withLifecycle(db, [before]);
    if ((before.disabledAt === null) === body.enabled) return view;
    // re-enabling lifts a stop on every governed call: a settings_relax step-up bound to this connector
    if (body.enabled && !(await requireStepUp(db, req, reply, { kind: "settings_relax", facts: { connectorId, values: { enabled: true } } })).ok) {
      return reply;
    }
    const row = await db.transaction(async (tx) => {
      const [r] = await tx
        .update(connectors)
        .set(
          body.enabled
            ? { disabledAt: null, disabledReason: null, disabledBy: null }
            : { disabledAt: sql`now()`, disabledReason: body.reason ?? null, disabledBy: actor(req) },
        )
        // compare-and-set on the state the decision (and any step-up) was made on
        .where(and(eq(connectors.id, connectorId), body.enabled ? isNotNull(connectors.disabledAt) : isNull(connectors.disabledAt)))
        .returning();
      if (!r) return null;
      await tx.insert(auditLog).values({
        userId: actor(req) ?? NIL_USER,
        objectType: "connector",
        objectId: connectorId,
        detail: { phase: body.enabled ? "enabled" : "disabled", name: before.name, receiptClass: "configuration", ...(body.enabled ? { relaxation: true } : {}) },
        effect: body.enabled ? "allow" : "deny",
        ruleId: body.enabled ? INTEGRATION_LIFECYCLE_RULE_IDS.connectorEnabled : INTEGRATION_LIFECYCLE_RULE_IDS.connectorDisabled,
        ruleChain: [],
        reason: body.enabled
          ? `connector '${before.name}' enabled again${body.reason ? `: ${body.reason}` : ""}; governed calls are allowed under its grants`
          : `connector '${before.name}' DISABLED: ${body.reason}. Every governed call to it is refused`,
      });
      return r;
    });
    if (!row) return reply.status(CHANGED_CONCURRENTLY.status).send(CHANGED_CONCURRENTLY.body);
    return (await withLifecycle(db, [row]))[0];
  });

  app.delete("/v1/connectors/:connectorId", async (req, reply) => {
    const { connectorId } = connectorParam.parse(req.params);
    const out = await db.transaction(async (tx) => {
      const [c] = await tx.select().from(connectors).where(eq(connectors.id, connectorId)).for("update");
      if (!c) return { status: 404, body: { error: "unknown_connector" } };
      if (c.disabledAt === null) {
        return { status: 409, body: { error: "connector_not_disabled", detail: "disable the connector before deleting it" } };
      }
      const approvalRefs = await countWhere(tx, "approvals", "connector_id", connectorId);
      const chatRefs = await countWhere(tx, "chatops_connections", "connector_id", connectorId);
      if (approvalRefs.n + chatRefs.n > 0) {
        return {
          status: 409,
          body: {
            error: "connector_in_use",
            detail: "approvals and chat connections refer to this connector; approvals are audit evidence and are never deleted",
            approvals: approvalRefs.n,
            chatopsConnections: chatRefs.n,
            approvalIds: approvalRefs.ids,
            chatopsConnectionIds: chatRefs.ids,
          },
        };
      }
      const cascade = {
        credential: (await countWhere(tx, "connector_credentials", "connector_id", connectorId)).n > 0,
        grants: (await countWhere(tx, "connector_grants", "connector_id", connectorId)).n,
        roleGrants: (await countWhere(tx, "role_connector_grants", "connector_id", connectorId)).n,
        agentGrants: (await countWhere(tx, "identity_connector_grants", "connector_id", connectorId)).n,
        revocations: (await countWhere(tx, "connector_revocations", "connector_id", connectorId)).n,
      };
      await tx.delete(connectors).where(eq(connectors.id, connectorId));
      await tx.insert(auditLog).values({
        userId: actor(req) ?? NIL_USER,
        objectType: "connector",
        objectId: connectorId,
        detail: { phase: "removed", name: c.name, kind: c.kind, providerKind: c.providerKind, cascade, receiptClass: "configuration" },
        effect: "allow",
        ruleId: INTEGRATION_LIFECYCLE_RULE_IDS.connectorRemoved,
        ruleChain: [],
        reason:
          `connector '${c.name}' deleted; removed with it: ${cascade.grants} grant(s), ${cascade.roleGrants} role grant(s), ` +
          `${cascade.agentGrants} agent grant(s), ${cascade.revocations} revocation(s)${cascade.credential ? " and its stored credential" : ""}`,
      });
      return { status: 200, body: { removed: true, cascade } };
    });
    return reply.status(out.status).send(out.body);
  });

  // -------------------------------------------------------------------------
  // G4 — MCP servers
  // -------------------------------------------------------------------------

  app.post("/v1/servers/:serverId/enabled", async (req, reply) => {
    const { serverId } = serverParam.parse(req.params);
    const body = setIntegrationEnabledSchema.parse(req.body);
    const [before] = await db
      .select({ id: mcpServers.id, name: mcpServers.name, disabledAt: mcpServers.disabledAt, disabledReason: mcpServers.disabledReason, disabledBy: mcpServers.disabledBy })
      .from(mcpServers)
      .where(eq(mcpServers.id, serverId));
    if (!before) return reply.status(404).send({ error: "unknown_server" });
    if ((before.disabledAt === null) === body.enabled) return (await withLifecycle(db, [before]))[0];
    if (body.enabled && !(await requireStepUp(db, req, reply, { kind: "settings_relax", facts: { serverId, values: { enabled: true } } })).ok) {
      return reply;
    }
    const row = await db.transaction(async (tx) => {
      const [r] = await tx
        .update(mcpServers)
        .set(
          body.enabled
            ? { disabledAt: null, disabledReason: null, disabledBy: null }
            : { disabledAt: sql`now()`, disabledReason: body.reason ?? null, disabledBy: actor(req) },
        )
        .where(and(eq(mcpServers.id, serverId), body.enabled ? isNotNull(mcpServers.disabledAt) : isNull(mcpServers.disabledAt)))
        .returning({ id: mcpServers.id, name: mcpServers.name, disabledAt: mcpServers.disabledAt, disabledReason: mcpServers.disabledReason, disabledBy: mcpServers.disabledBy });
      if (!r) return null;
      await tx.insert(auditLog).values({
        userId: actor(req) ?? NIL_USER,
        serverId,
        objectType: "mcp_server",
        objectId: serverId,
        detail: { phase: body.enabled ? "enabled" : "disabled", name: before.name, receiptClass: "configuration", ...(body.enabled ? { relaxation: true } : {}) },
        effect: body.enabled ? "allow" : "deny",
        ruleId: body.enabled ? INTEGRATION_LIFECYCLE_RULE_IDS.serverEnabled : INTEGRATION_LIFECYCLE_RULE_IDS.serverDisabled,
        ruleChain: [],
        reason: body.enabled
          ? `MCP server '${before.name}' enabled again${body.reason ? `: ${body.reason}` : ""}; its tools can be called under their grants`
          : `MCP server '${before.name}' DISABLED: ${body.reason}. Every call to its tools is refused, for people and agents`,
      });
      return r;
    });
    if (!row) return reply.status(CHANGED_CONCURRENTLY.status).send(CHANGED_CONCURRENTLY.body);
    return (await withLifecycle(db, [row]))[0];
  });

  app.delete("/v1/servers/:serverId", async (req, reply) => {
    const { serverId } = serverParam.parse(req.params);
    const out = await db.transaction(async (tx) => {
      const [s] = await tx
        .select({ id: mcpServers.id, name: mcpServers.name, url: mcpServers.url, transport: mcpServers.transport, disabledAt: mcpServers.disabledAt })
        .from(mcpServers)
        .where(eq(mcpServers.id, serverId))
        .for("update");
      if (!s) return { status: 404, body: { error: "unknown_server" } };
      if (s.disabledAt === null) {
        return { status: 409, body: { error: "mcp_server_not_disabled", detail: "disable the MCP server before deleting it" } };
      }
      const refs = {
        approvals: await countWhere(tx, "approvals", "server_id", serverId),
        agentServerGrants: await countWhere(tx, "identity_server_grants", "server_id", serverId),
        agentToolGrants: await countWhere(tx, "identity_tool_grants", "server_id", serverId),
        approvalRules: await countWhere(tx, "approval_rules", "server_id", serverId),
        dataScopeRules: await countWhere(tx, "data_scope_rules", "server_id", serverId),
        rateLimits: await countWhere(tx, "rate_limits", "server_id", serverId),
      };
      if (Object.values(refs).some((r) => r.n > 0)) {
        return {
          status: 409,
          body: {
            error: "mcp_server_in_use",
            detail:
              "approvals, agent grants or versioned rules refer to this server; approvals are audit evidence, and grants " +
              "and rules are removed first so each removal is its own audited act",
            approvals: refs.approvals.n,
            agentGrants: refs.agentServerGrants.n + refs.agentToolGrants.n,
            approvalRules: refs.approvalRules.n,
            dataScopeRules: refs.dataScopeRules.n,
            rateLimits: refs.rateLimits.n,
            approvalIds: refs.approvals.ids,
            agentGrantIds: [...refs.agentServerGrants.ids, ...refs.agentToolGrants.ids].slice(0, IDS_SHOWN),
            ruleIds: [...refs.approvalRules.ids, ...refs.dataScopeRules.ids, ...refs.rateLimits.ids].slice(0, IDS_SHOWN),
          },
        };
      }
      const cascade = {
        tools: (await countWhere(tx, "mcp_tools", "server_id", serverId)).n,
        toolGrants: (await countWhere(tx, "tool_grants", "server_id", serverId)).n,
        serverGrants: (await countWhere(tx, "server_grants", "server_id", serverId)).n,
        roleToolGrants: (await countWhere(tx, "role_tool_grants", "server_id", serverId)).n,
        roleServerGrants: (await countWhere(tx, "role_server_grants", "server_id", serverId)).n,
        revocations: (await countWhere(tx, "revocations", "server_id", serverId)).n,
        upstreamCredential: (await countWhere(tx, "mcp_server_upstream_credentials", "server_id", serverId)).n > 0,
        registryEntriesDetached: (await countWhere(tx, "mcp_registry_entries", "server_id", serverId)).n,
      };
      await tx.delete(mcpServers).where(eq(mcpServers.id, serverId));
      await tx.insert(auditLog).values({
        userId: actor(req) ?? NIL_USER,
        serverId,
        objectType: "mcp_server",
        objectId: serverId,
        detail: { phase: "removed", name: s.name, url: s.url, transport: s.transport, cascade, receiptClass: "configuration" },
        effect: "allow",
        ruleId: INTEGRATION_LIFECYCLE_RULE_IDS.serverRemoved,
        ruleChain: [],
        reason:
          `MCP server '${s.name}' deleted; removed with it: ${cascade.tools} tool(s), ` +
          `${cascade.toolGrants + cascade.serverGrants + cascade.roleToolGrants + cascade.roleServerGrants} grant(s), ` +
          `${cascade.revocations} revocation(s)${cascade.upstreamCredential ? " and its upstream credential" : ""}`,
      });
      return { status: 200, body: { removed: true, cascade } };
    });
    return reply.status(out.status).send(out.body);
  });

  // -------------------------------------------------------------------------
  // G4 — MCP registries: delete only once disabled (no scheduled pull in flight). Servers it imported keep running
  // and lose the link (`mcp_servers.registry_id` is ON DELETE SET NULL, 0105); its catalogue entries cascade.
  // -------------------------------------------------------------------------

  app.delete("/v1/mcp-registries/:registryId", async (req, reply) => {
    const { registryId } = registryParam.parse(req.params);
    const out = await db.transaction(async (tx) => {
      const [r] = await tx.select().from(mcpRegistries).where(eq(mcpRegistries.id, registryId)).for("update");
      if (!r) return { status: 404, body: { error: "unknown_registry" } };
      if (r.enabled) {
        return { status: 409, body: { error: "mcp_registry_not_disabled", detail: "disable the registry before deleting it" } };
      }
      const entries = (await countWhere(tx, "mcp_registry_entries", "registry_id", registryId)).n;
      const detached = await tx
        .select({ id: mcpServers.id, name: mcpServers.name })
        .from(mcpServers)
        .where(eq(mcpServers.registryId, registryId))
        .orderBy(mcpServers.name);
      await tx.delete(mcpRegistries).where(eq(mcpRegistries.id, registryId));
      await tx.insert(auditLog).values({
        userId: actor(req) ?? NIL_USER,
        // the registry routes record under the MCP-server object type with a `registry-*` phase (mcp-registry.ts)
        objectType: "mcp_server",
        objectId: registryId,
        detail: {
          phase: "registry-removed",
          name: r.name,
          url: r.url,
          entriesRemoved: entries,
          detachedServers: detached.length,
          detachedServerIds: detached.slice(0, IDS_SHOWN).map((d) => d.id),
          receiptClass: "configuration",
        },
        effect: "allow",
        ruleId: INTEGRATION_LIFECYCLE_RULE_IDS.registryRemoved,
        ruleChain: [],
        reason:
          `MCP registry '${r.name}' deleted with ${entries} catalogue entr${entries === 1 ? "y" : "ies"}; ` +
          (detached.length
            ? `${detached.length} imported server(s) keep running without the link: ${detached.slice(0, IDS_SHOWN).map((d) => d.name).join(", ")}`
            : "no imported server referred to it"),
      });
      return { status: 200, body: { removed: true, entriesRemoved: entries, detachedServers: detached.slice(0, IDS_SHOWN) } };
    });
    return reply.status(out.status).send(out.body);
  });
}
