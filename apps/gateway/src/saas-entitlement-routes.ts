/**
 * ADR-0337 §6 (lane E18; owner decision 2026-11-17): the entitlement graph's apps and their link to RegulAIt agents.
 *
 * - An admin declares an identifier for an agent (its app id on one platform). Every app whose vendor id EXACTLY
 *   equals it (case-sensitive, same platform) is auto-linked to the agent, now and after each later read; each link is
 *   audited.
 * - A partial or fuzzy match is never linked automatically: an admin links it by hand.
 * - An admin can unlink any app; an unlinked app is not auto-linked again.
 *
 * The link's states and transitions are the declared machine `SAAS_APP_AGENT_LINK_MACHINE` (@regulait/shared), and
 * every app in a listing carries its `describe()` view, so a screen or an agent sees what can be done next and why not.
 * Admin-only by default (none of these routes is in NON_ADMIN_ROUTES). Nothing here calls a vendor.
 */
import { z } from "zod";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  and,
  asc,
  eq,
  gt,
  sql,
  agentVendorIdentifiers,
  agents,
  auditLog,
  saasEntitlementApps,
  type Db,
} from "@regulait/db";
import { AGENT_VENDOR_IDENTIFIER_PATTERN, SAAS_APP_AGENT_LINK_MACHINE, SAAS_ENTITLEMENT_PLATFORMS } from "@regulait/shared";
import { GUID } from "./discovery-wider-scanners.js";
import { autoLinkApps, changeAgentLink } from "./saas-entitlements.js";

const NIL_UUID = "00000000-0000-0000-0000-000000000000";
const isUniqueViolation = (e: unknown): boolean => {
  const err = e as { code?: string; cause?: { code?: string } } | null;
  return err?.code === "23505" || err?.cause?.code === "23505";
};
const MAX_PAGE = 200;

const appParam = z.object({ appId: z.string().uuid() });
const identifierParam = z.object({ identifierId: z.string().uuid() });
const page = { after: z.string().uuid().optional(), limit: z.coerce.number().int().min(1).max(MAX_PAGE).default(50) };
const appsQuery = z.object({ sourceId: z.string().uuid(), ...page }).strict();
const identifiersQuery = z.object({ agentId: z.string().uuid().optional(), ...page }).strict();
const linkBody = z.object({ agentId: z.string().uuid() }).strict();
const identifierBody = z
  .object({
    agentId: z.string().uuid(),
    platform: z.enum(SAAS_ENTITLEMENT_PLATFORMS),
    externalId: z.string().regex(AGENT_VENDOR_IDENTIFIER_PATTERN, "an identifier is 1 to 255 printable characters, no spaces"),
  })
  .strict();

/**
 * An identifier as stored: Microsoft 365 app ids are GUIDs, which Graph may print in either case, so they are kept
 * lowercase (and the M365 reader stores them as Graph returns them, lowercase); every other platform's id is exact.
 */
export function normaliseAgentIdentifier(platform: (typeof SAAS_ENTITLEMENT_PLATFORMS)[number], externalId: string): string {
  return platform === "m365" && GUID.test(externalId) ? externalId.toLowerCase() : externalId;
}

export function registerSaasEntitlementRoutes(app: FastifyInstance, db: Db): void {
  const actor = (req: FastifyRequest) => req.authCtx.userId ?? NIL_UUID;
  const badRequest = (reply: FastifyReply, err: z.ZodError) =>
    reply.status(400).send({ error: "invalid_request", detail: err.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ") });
  // an agent to link to: it exists and is not retired (a retired agent is terminal; security review of #884, N4)
  const agentProblem = async (t: Db, id: string) => {
    const [a] = await t.select({ status: agents.lifecycleStatus }).from(agents).where(eq(agents.id, id));
    if (!a) return { ok: false as const, status: 404 as const, error: "agent_not_found", detail: "no such agent" };
    if (a.status === "retired") return { ok: false as const, status: 409 as const, error: "agent_retired", detail: "a retired agent cannot be linked to a vendor app" };
    return null;
  };

  // the apps one entitlement source holds, each with its link state and what can be done with it next
  app.get("/v1/discovery/entitlements/apps", async (req, reply) => {
    const q = appsQuery.safeParse(req.query ?? {});
    if (!q.success) return badRequest(reply, q.error);
    const rows = await db
      .select({
        id: saasEntitlementApps.id,
        sourceId: saasEntitlementApps.sourceId,
        externalId: saasEntitlementApps.externalId,
        appKind: saasEntitlementApps.appKind,
        displayName: saasEntitlementApps.displayName,
        publisher: saasEntitlementApps.publisher,
        publisherVerified: saasEntitlementApps.publisherVerified,
        agentId: saasEntitlementApps.agentId,
        agentLinkState: saasEntitlementApps.agentLinkState,
        firstSeenAt: saasEntitlementApps.firstSeenAt,
        lastSeenAt: saasEntitlementApps.lastSeenAt,
        grants: sql<number>`(SELECT count(*)::int FROM saas_entitlement_grants g WHERE g.app_id = ${saasEntitlementApps.id})`,
      })
      .from(saasEntitlementApps)
      .where(and(eq(saasEntitlementApps.sourceId, q.data.sourceId), q.data.after ? gt(saasEntitlementApps.id, q.data.after) : undefined))
      .orderBy(asc(saasEntitlementApps.id))
      .limit(q.data.limit + 1);
    const items = rows.slice(0, q.data.limit).map((r) => ({ ...r, lifecycle: SAAS_APP_AGENT_LINK_MACHINE.describe(r.agentLinkState) }));
    return { items, nextAfter: rows.length > q.data.limit ? items[items.length - 1]!.id : null, machine: SAAS_APP_AGENT_LINK_MACHINE.toJSON() };
  });

  // an admin links an app to an agent (any match, a partial or fuzzy one included), or moves its link
  app.put("/v1/discovery/entitlements/apps/:appId/agent-link", async (req, reply) => {
    const p = appParam.safeParse(req.params);
    if (!p.success) return badRequest(reply, p.error);
    const b = linkBody.safeParse(req.body ?? {});
    if (!b.success) return badRequest(reply, b.error);
    const out = await db.transaction(async (tx) => {
      const t = tx as unknown as Db;
      const bad = await agentProblem(t, b.data.agentId);
      if (bad) return bad;
      return changeAgentLink(t, { appId: p.data.appId, event: "link", agentId: b.data.agentId, actorUserId: actor(req) });
    });
    if (!out.ok) return reply.status(out.status).send({ error: out.error, detail: out.detail });
    return { appId: out.appId, agentLinkState: out.to, agentId: out.agentId, lifecycle: SAAS_APP_AGENT_LINK_MACHINE.describe(out.to) };
  });

  // an admin removes an app's link (auto or manual); it is not auto-linked again
  app.delete("/v1/discovery/entitlements/apps/:appId/agent-link", async (req, reply) => {
    const p = appParam.safeParse(req.params);
    if (!p.success) return badRequest(reply, p.error);
    const out = await db.transaction((tx) => changeAgentLink(tx as unknown as Db, { appId: p.data.appId, event: "unlink", actorUserId: actor(req) }));
    if (!out.ok) return reply.status(out.status).send({ error: out.error, detail: out.detail });
    return { appId: out.appId, agentLinkState: out.to, agentId: out.agentId, lifecycle: SAAS_APP_AGENT_LINK_MACHINE.describe(out.to) };
  });

  app.get("/v1/discovery/agent-identifiers", async (req, reply) => {
    const q = identifiersQuery.safeParse(req.query ?? {});
    if (!q.success) return badRequest(reply, q.error);
    const rows = await db
      .select({
        id: agentVendorIdentifiers.id,
        agentId: agentVendorIdentifiers.agentId,
        platform: agentVendorIdentifiers.platform,
        externalId: agentVendorIdentifiers.externalId,
        createdByUserId: agentVendorIdentifiers.createdByUserId,
        createdAt: agentVendorIdentifiers.createdAt,
      })
      .from(agentVendorIdentifiers)
      .where(
        and(
          q.data.agentId ? eq(agentVendorIdentifiers.agentId, q.data.agentId) : undefined,
          q.data.after ? gt(agentVendorIdentifiers.id, q.data.after) : undefined,
        ),
      )
      .orderBy(asc(agentVendorIdentifiers.id))
      .limit(q.data.limit + 1);
    const items = rows.slice(0, q.data.limit);
    return { items, nextAfter: rows.length > q.data.limit ? items[items.length - 1]!.id : null };
  });

  // an admin declares an agent's app id on one platform; matching apps are auto-linked at once (each audited)
  app.post("/v1/discovery/agent-identifiers", async (req, reply) => {
    const b = identifierBody.safeParse(req.body ?? {});
    if (!b.success) return badRequest(reply, b.error);
    const externalId = normaliseAgentIdentifier(b.data.platform, b.data.externalId);
    try {
      const out = await db.transaction(async (tx) => {
        const t = tx as unknown as Db;
        const bad = await agentProblem(t, b.data.agentId);
        if (bad) return bad;
        const [row] = await t
          .insert(agentVendorIdentifiers)
          .values({ agentId: b.data.agentId, platform: b.data.platform, externalId, createdByUserId: req.authCtx.userId ?? null })
          .returning();
        // the link pass runs first so the declaration's own audit row states its whole effect: an identifier applies to
        // EVERY entitlement source of its platform, so it names each app and source it linked (each link is audited too)
        const linked = await autoLinkApps(t, { identifierId: row!.id }, actor(req));
        const sourceIds = [...new Set(linked.map((l) => l.sourceId))];
        await t.insert(auditLog).values({
          userId: actor(req),
          objectType: "agent_vendor_identifier",
          objectId: row!.id,
          detail: {
            subsystem: "saas-entitlements",
            agentId: row!.agentId,
            platform: row!.platform,
            externalId: row!.externalId,
            scope: "every entitlement source of this platform",
            autoLinkedApps: linked.map((l) => l.appId),
            autoLinkedSources: sourceIds,
          },
          effect: "allow",
          ruleId: "agent-vendor-identifier-declared",
          ruleChain: [],
          reason: `identifier '${row!.externalId}' (${row!.platform}) declared for agent ${row!.agentId}: applies to every ${row!.platform} source; ${linked.length} app(s) in ${sourceIds.length} source(s) auto-linked on an exact match`,
        });
        return { ok: true as const, identifier: row!, autoLinked: linked.map((l) => l.appId), autoLinkedSources: sourceIds };
      });
      if (!out.ok) return reply.status(out.status).send({ error: out.error, detail: out.detail });
      const { ok: _ok, ...created } = out;
      return reply.status(201).send(created);
    } catch (e) {
      if (isUniqueViolation(e)) return reply.status(409).send({ error: "identifier_taken", detail: "that identifier is already declared for an agent on this platform" });
      throw e;
    }
  });

  // removing an identifier stops future auto-links through it; links already made stay until an admin unlinks them
  app.delete("/v1/discovery/agent-identifiers/:identifierId", async (req, reply) => {
    const p = identifierParam.safeParse(req.params);
    if (!p.success) return badRequest(reply, p.error);
    const removed = await db.transaction(async (tx) => {
      const t = tx as unknown as Db;
      const [row] = await t.delete(agentVendorIdentifiers).where(eq(agentVendorIdentifiers.id, p.data.identifierId)).returning();
      if (!row) return null;
      await t.insert(auditLog).values({
        userId: actor(req),
        objectType: "agent_vendor_identifier",
        objectId: row.id,
        detail: { subsystem: "saas-entitlements", agentId: row.agentId, platform: row.platform, externalId: row.externalId },
        effect: "allow",
        ruleId: "agent-vendor-identifier-removed",
        ruleChain: [],
        reason: `identifier '${row.externalId}' (${row.platform}) removed from agent ${row.agentId}; existing links stay until an admin unlinks them`,
      });
      return row;
    });
    if (!removed) return reply.status(404).send({ error: "not_found", detail: "no such identifier" });
    return reply.status(204).send();
  });
}
