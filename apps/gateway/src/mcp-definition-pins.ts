/**
 * ADR-0246 — MCP DEFINITION PINNING (rug-pull detection): the database and request-path half.
 *
 * `packages/shared/src/mcp-definition-pins.ts` owns the digests, the observation plan and the diff. This module owns:
 *
 *   1. (`observeServedDefinitions`, in mcp-proxy.ts beside the manifest read so this module imports no upstream
 *      code: the prompts, resources and templates a server serves, for the capabilities it advertises.)
 *   2. `recordDefinitionPins` — run inside `syncUpstreamTools`' transaction, BEFORE the manifest is upserted. The
 *      first admitted manifest is the baseline (approved, `approved_by` NULL). Every later one is compared; an item
 *      that changed, appeared or disappeared since approval is recorded with its served definition and audited in
 *      the same transaction. Under 'block' the tools that are not approved are returned so the caller neither
 *      stores nor serves them.
 *   3. `definitionPinRefusal` — THE GATE on a tool call, `prompts/get` and `resources/read`: under 'block' an item
 *      that is not approved is refused before any upstream connect.
 *   4. The admin API: the list of servers with changes, one server's pins with the RFC 6902 diff, and the
 *      re-approval (a `settings_relax` step-up bound to the exact digests reviewed, compare-and-set, audited in the
 *      same transaction).
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  and,
  asc,
  auditLog,
  count,
  eq,
  inArray,
  mcpDefinitionPins,
  mcpServers,
  sql,
  type Db,
} from "@regulait/db";
import {
  approveMcpDefinitionPinsSchema,
  definitionDiff,
  definitionPinStatus,
  MCP_DEFINITION_KINDS,
  pinnableDefinitions,
  planDefinitionPins,
  type McpDefinitionKind,
  type McpDefinitionPinMode,
  type McpServedDefinitions,
  type StoredDefinitionPin,
} from "@regulait/shared";
import { loadOrgSettings } from "./org-settings.js";
import { requireStepUp } from "./step-up.js";


const NIL_USER = "00000000-0000-0000-0000-000000000000";

export const MCP_DEFINITIONS_PINNED_RULE_ID = "mcp-definitions-pinned";
export const MCP_DEFINITION_CHANGED_RULE_ID = "mcp-definition-changed";
export const MCP_DEFINITION_BLOCKED_RULE_ID = "mcp-definition-blocked";
export const MCP_DEFINITION_APPROVED_RULE_ID = "mcp-definition-approved";

/** what the audit row and the diff call each kind */
const KIND_LABEL: Readonly<Record<McpDefinitionKind, string>> = {
  tool: "tool",
  prompt: "prompt",
  resource: "resource",
  resource_template: "resource template",
};

export interface DefinitionPinOutcome {
  mode: McpDefinitionPinMode;
  /** true when this fetch took the admission baseline */
  baseline: boolean;
  /** tool names that are not approved; non-empty only under 'block' */
  blockedTools: Set<string>;
}

/**
 * Record one manifest observation. Runs inside the caller's transaction (`tx`), so the pins, their audit row and
 * the manifest upsert commit together. The server row is locked first, so two syncs of one server serialise and
 * neither can take a second baseline.
 */
export async function recordDefinitionPins(
  tx: Db,
  serverId: string,
  served: McpServedDefinitions,
  trigger: "sync" | "rescan",
): Promise<DefinitionPinOutcome> {
  const mode = (await loadOrgSettings(tx)).mcpDefinitionPinMode;
  const [server] = await tx
    .select({ id: mcpServers.id, name: mcpServers.name, definitionsPinnedAt: mcpServers.definitionsPinnedAt })
    .from(mcpServers)
    .where(eq(mcpServers.id, serverId))
    .for("update");
  if (!server) return { mode, baseline: false, blockedTools: new Set() };
  const observed = pinnableDefinitions(served);

  if (server.definitionsPinnedAt === null) {
    // THE ADMISSION BASELINE: the first manifest this server serves after it was admitted (a held or quarantined
    // manifest never gets here). Rows a pre-baseline write may have left are replaced, never trusted.
    await tx.delete(mcpDefinitionPins).where(eq(mcpDefinitionPins.serverId, serverId));
    if (observed.definitions.length > 0) {
      await tx.insert(mcpDefinitionPins).values(
        observed.definitions.map((d) => ({
          serverId,
          kind: d.kind,
          name: d.name,
          approvedDigest: d.digest,
          approvedDefinition: d.definition,
          approvedBy: null,
          approvedAt: sql`now()`,
          observedDigest: d.digest,
          observedDefinition: d.definition,
          observedAt: sql`now()`,
        })),
      );
    }
    await tx.update(mcpServers).set({ definitionsPinnedAt: sql`now()` }).where(eq(mcpServers.id, serverId));
    const counts = Object.fromEntries(
      MCP_DEFINITION_KINDS.map((k) => [k, observed.definitions.filter((d) => d.kind === k).length]),
    );
    await tx.insert(auditLog).values({
      userId: NIL_USER,
      serverId,
      objectType: "mcp_server",
      objectId: serverId,
      detail: { phase: "definition-pins", trigger, baseline: true, counts, skipped: observed.skipped.length },
      effect: "allow",
      ruleId: MCP_DEFINITIONS_PINNED_RULE_ID,
      ruleChain: [],
      reason:
        `MCP server '${server.name}': admission baseline pinned (${observed.definitions.length} definition(s)). ` +
        `A later change to any of them is held for an admin's re-approval.`,
    });
    return { mode, baseline: true, blockedTools: new Set() };
  }

  const stored = (await tx
    .select({
      kind: mcpDefinitionPins.kind,
      name: mcpDefinitionPins.name,
      approvedDigest: mcpDefinitionPins.approvedDigest,
      observedDigest: mcpDefinitionPins.observedDigest,
    })
    .from(mcpDefinitionPins)
    .where(eq(mcpDefinitionPins.serverId, serverId))) as StoredDefinitionPin[];
  const plan = planDefinitionPins(stored, observed);
  const events: Array<{ kind: McpDefinitionKind; name: string; status: string; approvedDigest: string | null; observedDigest: string | null }> = [];

  if (plan.added.length > 0) {
    await tx.insert(mcpDefinitionPins).values(
      plan.added.map((d) => ({
        serverId,
        kind: d.kind,
        name: d.name,
        observedDigest: d.digest,
        observedDefinition: d.definition,
        observedAt: sql`now()`,
        changedAt: sql`now()`,
      })),
    );
    for (const d of plan.added) events.push({ kind: d.kind, name: d.name, status: "added", approvedDigest: null, observedDigest: d.digest });
  }
  for (const { pin, observed: d } of plan.reobserved) {
    const back = pin.approvedDigest === d.digest;
    await tx
      .update(mcpDefinitionPins)
      .set({
        observedDigest: d.digest,
        observedDefinition: d.definition,
        observedAt: sql`now()`,
        // back to exactly what was approved: nothing is pending any more
        changedAt: back ? null : sql`now()`,
      })
      .where(and(eq(mcpDefinitionPins.serverId, serverId), eq(mcpDefinitionPins.kind, pin.kind), eq(mcpDefinitionPins.name, pin.name)));
    if (!back) {
      events.push({
        kind: pin.kind,
        name: pin.name,
        status: definitionPinStatus(pin.approvedDigest, d.digest),
        approvedDigest: pin.approvedDigest,
        observedDigest: d.digest,
      });
    }
  }
  for (const pin of plan.gone) {
    const where = and(eq(mcpDefinitionPins.serverId, serverId), eq(mcpDefinitionPins.kind, pin.kind), eq(mcpDefinitionPins.name, pin.name));
    if (pin.approvedDigest === null) {
      // an addition nobody approved has gone again: nothing is left to review
      await tx.delete(mcpDefinitionPins).where(where);
      continue;
    }
    await tx
      .update(mcpDefinitionPins)
      .set({ observedDigest: null, observedDefinition: null, observedAt: sql`now()`, changedAt: sql`now()` })
      .where(where);
    events.push({ kind: pin.kind, name: pin.name, status: "removed", approvedDigest: pin.approvedDigest, observedDigest: null });
  }

  if (events.length > 0) {
    const shown = events.slice(0, 50);
    await tx.insert(auditLog).values({
      userId: NIL_USER,
      serverId,
      objectType: "mcp_server",
      objectId: serverId,
      // names and digests only: the definitions themselves stay in mcp_definition_pins for the admin diff
      detail: { phase: "definition-pins", trigger, mode, changes: shown, changeCount: events.length },
      effect: mode === "block" ? "deny" : "allow",
      ruleId: MCP_DEFINITION_CHANGED_RULE_ID,
      ruleChain: [],
      reason:
        `MCP server '${server.name}' changed ${events.length} definition(s) since approval (` +
        shown.slice(0, 5).map((e) => `${KIND_LABEL[e.kind]} '${e.name}' ${e.status}`).join(", ") +
        (events.length > 5 ? ", …" : "") +
        `)` +
        (trigger === "rescan" ? " (observed by the scheduled re-scan)" : "") +
        (mode === "block"
          ? ". Each is refused until an admin re-approves it against the diff."
          : ". mcp_definition_pin_mode='warn': RECORDED ONLY, nothing was refused."),
    });
  }

  const blockedTools = new Set<string>();
  if (mode === "block") {
    const pending = await tx
      .select({ name: mcpDefinitionPins.name })
      .from(mcpDefinitionPins)
      .where(
        and(
          eq(mcpDefinitionPins.serverId, serverId),
          eq(mcpDefinitionPins.kind, "tool"),
          sql`${mcpDefinitionPins.approvedDigest} IS DISTINCT FROM ${mcpDefinitionPins.observedDigest}`,
        ),
      );
    for (const p of pending) blockedTools.add(p.name);
    // a served tool past the per-kind cap (or with an unusable name) has no pin, so it is not approved either
    const pinned = new Set(observed.definitions.filter((d) => d.kind === "tool").map((d) => d.name));
    for (const t of served.tools) {
      const name = (t as { name?: unknown } | null)?.name;
      if (typeof name === "string" && !pinned.has(name)) blockedTools.add(name);
    }
  }
  return { mode, baseline: false, blockedTools };
}

export interface DefinitionPinRefusal {
  ruleId: typeof MCP_DEFINITION_BLOCKED_RULE_ID;
  reason: string;
  status: string;
}

/**
 * THE GATE. Under 'block', after the server's baseline, a tool is served only when its pin is approved; a prompt or
 * resource is refused when it has a pin that is not approved (one with no pin at all was never observed, e.g. a URI
 * from a template). Before the baseline there is nothing to compare with: the manifest fetch that takes it runs first.
 */
export async function definitionPinRefusal(
  db: Db,
  serverId: string,
  kind: "tool" | "prompt" | "resource",
  name: string,
): Promise<DefinitionPinRefusal | null> {
  if ((await loadOrgSettings(db)).mcpDefinitionPinMode !== "block") return null;
  const [server] = await db
    .select({ name: mcpServers.name, definitionsPinnedAt: mcpServers.definitionsPinnedAt })
    .from(mcpServers)
    .where(eq(mcpServers.id, serverId));
  if (!server || server.definitionsPinnedAt === null) return null;
  const [pin] = await db
    .select({ approvedDigest: mcpDefinitionPins.approvedDigest, observedDigest: mcpDefinitionPins.observedDigest })
    .from(mcpDefinitionPins)
    .where(and(eq(mcpDefinitionPins.serverId, serverId), eq(mcpDefinitionPins.kind, kind), eq(mcpDefinitionPins.name, name)));
  if (!pin) {
    // a prompt or resource the baseline never saw (its list not observed, or a URI from a template) has no pin; an
    // added one does have a pin and is refused below. A tool list is always observed, so an unpinned tool is refused.
    if (kind !== "tool") return null;
    return {
      ruleId: MCP_DEFINITION_BLOCKED_RULE_ID,
      status: "unpinned",
      reason: `MCP ${KIND_LABEL[kind]} '${name}' on server '${server.name}' is not among its approved definitions; an admin must approve it first`,
    };
  }
  const status = definitionPinStatus(pin.approvedDigest, pin.observedDigest);
  if (status === "approved") return null;
  return {
    ruleId: MCP_DEFINITION_BLOCKED_RULE_ID,
    status,
    reason:
      `MCP ${KIND_LABEL[kind]} '${name}' on server '${server.name}' is ${status} since approval ` +
      `(mcp_definition_pin_mode='block'); an admin must review the diff and re-approve it`,
  };
}

// ---------------------------------------------------------------------------
// The admin API (admin-only through the default gate: none of these is in NON_ADMIN_ROUTES)
// ---------------------------------------------------------------------------

const serverParam = z.object({ serverId: z.string().uuid() }).strict();
const PAGE_MAX = 200;
const pageQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(PAGE_MAX).default(50),
    offset: z.coerce.number().int().min(0).max(100_000).default(0),
  })
  .strict();
const pinsQuery = pageQuery.extend({ pending: z.enum(["true", "false"]).optional() }).strict();

const DRIFT = sql`${mcpDefinitionPins.approvedDigest} IS DISTINCT FROM ${mcpDefinitionPins.observedDigest}`;

export function registerMcpDefinitionPinRoutes(app: FastifyInstance, db: Db): void {
  /** Servers with at least one definition changed since approval, most recent change first. */
  app.get("/v1/mcp/definition-pins", async (req) => {
    const q = pageQuery.parse(req.query ?? {});
    const rows = await db
      .select({
        serverId: mcpDefinitionPins.serverId,
        serverName: mcpServers.name,
        pending: count(),
        lastChangedAt: sql<string | null>`max(${mcpDefinitionPins.changedAt})`,
      })
      .from(mcpDefinitionPins)
      .innerJoin(mcpServers, eq(mcpServers.id, mcpDefinitionPins.serverId))
      .where(DRIFT)
      .groupBy(mcpDefinitionPins.serverId, mcpServers.name)
      .orderBy(sql`max(${mcpDefinitionPins.changedAt}) DESC NULLS LAST`, asc(mcpDefinitionPins.serverId))
      .limit(q.limit + 1)
      .offset(q.offset);
    const mode = (await loadOrgSettings(db)).mcpDefinitionPinMode;
    return {
      mode,
      blocking: mode === "block",
      servers: rows.slice(0, q.limit).map((r) => ({ ...r, pending: Number(r.pending), changedSinceApproval: true })),
      hasMore: rows.length > q.limit,
    };
  });

  /** One server's pins, with the RFC 6902 diff from the approved definition to the served one. */
  app.get("/v1/servers/:serverId/definition-pins", async (req, reply) => {
    const { serverId } = serverParam.parse(req.params);
    const q = pinsQuery.parse(req.query ?? {});
    const [server] = await db
      .select({ id: mcpServers.id, name: mcpServers.name, definitionsPinnedAt: mcpServers.definitionsPinnedAt })
      .from(mcpServers)
      .where(eq(mcpServers.id, serverId));
    if (!server) return reply.status(404).send({ error: "unknown_server" });
    const rows = await db
      .select()
      .from(mcpDefinitionPins)
      .where(and(eq(mcpDefinitionPins.serverId, serverId), q.pending === "true" ? DRIFT : undefined))
      .orderBy(asc(mcpDefinitionPins.kind), asc(mcpDefinitionPins.name))
      .limit(q.limit + 1)
      .offset(q.offset);
    const [pending] = await db
      .select({ n: count() })
      .from(mcpDefinitionPins)
      .where(and(eq(mcpDefinitionPins.serverId, serverId), DRIFT));
    const mode = (await loadOrgSettings(db)).mcpDefinitionPinMode;
    return {
      serverId,
      serverName: server.name,
      mode,
      pinnedAt: server.definitionsPinnedAt,
      changedSinceApproval: Number(pending?.n ?? 0) > 0,
      pendingCount: Number(pending?.n ?? 0),
      pins: rows.slice(0, q.limit).map((p) => ({
        kind: p.kind,
        name: p.name,
        status: definitionPinStatus(p.approvedDigest, p.observedDigest),
        approvedDigest: p.approvedDigest,
        observedDigest: p.observedDigest,
        approvedBy: p.approvedBy,
        approvedAt: p.approvedAt,
        observedAt: p.observedAt,
        changedAt: p.changedAt,
        approved: p.approvedDefinition,
        observed: p.observedDefinition,
        diff: definitionDiff(p.approvedDefinition ?? null, p.observedDefinition ?? null),
      })),
      hasMore: rows.length > q.limit,
    };
  });

  /**
   * THE RE-APPROVAL. Each item names the observed digest the admin reviewed; the update is a compare-and-set on it,
   * so a definition that changed again after the diff was read is not approved (409, nothing changed). A removed
   * item (observedDigest null) is acknowledged by deleting its pin. A `settings_relax` step-up bound to the server
   * and the exact items, and one audit row, in the same transaction as the writes.
   */
  app.post("/v1/servers/:serverId/definition-pins/approve", async (req, reply) => {
    const { serverId } = serverParam.parse(req.params);
    const body = approveMcpDefinitionPinsSchema.parse(req.body);
    const [server] = await db.select({ id: mcpServers.id, name: mcpServers.name }).from(mcpServers).where(eq(mcpServers.id, serverId));
    if (!server) return reply.status(404).send({ error: "unknown_server" });
    const keys = new Set(body.items.map((i) => `${i.kind}\u0000${i.name}`));
    if (keys.size !== body.items.length) {
      return reply.status(400).send({ error: "duplicate_item", detail: "each kind and name may appear once. Nothing was approved." });
    }
    const items = [...body.items].sort((a, b) => (a.kind + a.name < b.kind + b.name ? -1 : 1));
    const su = await requireStepUp(db, req, reply, {
      kind: "settings_relax",
      facts: { serverId, values: { mcpDefinitionPinsApproved: items.map((i) => [i.kind, i.name, i.observedDigest]) } },
    });
    if (!su.ok) return reply;
    const actor = req.authCtx.userId ?? null;
    const result = await db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Db;
      await tx.select({ id: mcpServers.id }).from(mcpServers).where(eq(mcpServers.id, serverId)).for("update");
      const current = await tx
        .select()
        .from(mcpDefinitionPins)
        .where(and(eq(mcpDefinitionPins.serverId, serverId), inArray(mcpDefinitionPins.name, items.map((i) => i.name))));
      const byKey = new Map(current.map((p) => [`${p.kind}\u0000${p.name}`, p]));
      const stale: Array<{ kind: string; name: string; why: string }> = [];
      for (const i of items) {
        const p = byKey.get(`${i.kind}\u0000${i.name}`);
        if (!p) stale.push({ kind: i.kind, name: i.name, why: "no such pin" });
        else if (p.observedDigest !== i.observedDigest) stale.push({ kind: i.kind, name: i.name, why: "the served definition changed after it was reviewed" });
        else if (definitionPinStatus(p.approvedDigest, p.observedDigest) === "approved") stale.push({ kind: i.kind, name: i.name, why: "already approved" });
      }
      if (stale.length > 0) return { ok: false as const, stale };
      const approved: Array<{ kind: string; name: string; status: string; previousDigest: string | null; digest: string | null }> = [];
      for (const i of items) {
        const p = byKey.get(`${i.kind}\u0000${i.name}`)!;
        const where = and(eq(mcpDefinitionPins.id, p.id), sql`${mcpDefinitionPins.observedDigest} IS NOT DISTINCT FROM ${i.observedDigest}`);
        const status = definitionPinStatus(p.approvedDigest, p.observedDigest);
        if (i.observedDigest === null) {
          await tx.delete(mcpDefinitionPins).where(where);
        } else {
          await tx
            .update(mcpDefinitionPins)
            .set({
              approvedDigest: p.observedDigest,
              approvedDefinition: p.observedDefinition,
              approvedBy: actor,
              approvedAt: sql`now()`,
              changedAt: null,
            })
            .where(where);
        }
        approved.push({ kind: i.kind, name: i.name, status, previousDigest: p.approvedDigest, digest: i.observedDigest });
      }
      await tx.insert(auditLog).values({
        userId: actor ?? NIL_USER,
        serverId,
        objectType: "mcp_server",
        objectId: serverId,
        detail: { phase: "definition-pins-approve", via: req.authCtx.via, items: approved, reason: body.reason },
        effect: "allow",
        ruleId: MCP_DEFINITION_APPROVED_RULE_ID,
        ruleChain: [],
        reason:
          `MCP server '${server.name}': ${approved.length} changed definition(s) re-approved (` +
          approved.slice(0, 5).map((a) => `${a.kind} '${a.name}' ${a.status}`).join(", ") +
          (approved.length > 5 ? ", …" : "") +
          `) — reason: ${body.reason}. Each approval is pinned to the digest reviewed.`,
      });
      return { ok: true as const, approved };
    });
    if (!result.ok) {
      return reply.status(409).send({
        error: "definition_pin_stale",
        detail: "one or more items no longer match what was reviewed. Nothing was approved; reload the diff.",
        items: result.stale,
      });
    }
    const [left] = await db
      .select({ n: count() })
      .from(mcpDefinitionPins)
      .where(and(eq(mcpDefinitionPins.serverId, serverId), DRIFT));
    return reply.send({ serverId, approved: result.approved, pendingCount: Number(left?.n ?? 0) });
  });
}

/** for tests and the posture read: is any definition of this server changed since approval? */
export async function serverChangedSinceApproval(db: Db, serverId: string): Promise<boolean> {
  const [row] = await db
    .select({ n: count() })
    .from(mcpDefinitionPins)
    .where(and(eq(mcpDefinitionPins.serverId, serverId), DRIFT));
  return Number(row?.n ?? 0) > 0;
}
