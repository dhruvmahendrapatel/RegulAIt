/**
 * ADR-0314 (G6): the admin API over agents staged from vendor agent registries (`agent_registry_records`), and the
 * import that turns one into an agent of the inventory. Admin-only (none of these routes is in NON_ADMIN_ROUTES);
 * the import is a `settings_relax` step-up bound to the record and the name, gated like `POST /v1/agents` by the
 * licence expansion gate, and audited with its provenance in the same transaction.
 *
 * Secure by default (ADR-0180): an imported agent is `enabled = false`, lifecycle `proposed` (with the import as the
 * reason) and has no grant of any kind, so nothing may call it and it may call nothing until an admin grants it.
 * Import never writes to the vendor: it reads only the staged row. API only; the screens are a known UI gap (#453).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { AGENT_REGISTRIES, AGENT_REGISTRY_LABELS, type AgentRegistry } from "@regulait/shared";
import { agentRegistryRecords, agents, and, auditLog, desc, discoverySources, eq, isNotNull, isNull, sql, type Db } from "@regulait/db";
import { checkOwnerTarget } from "./ownership.js";
import { requireStepUp } from "./step-up.js";
import { refuseIfExpansionBlocked } from "./licensing.js";

const NIL_UUID = "00000000-0000-0000-0000-000000000000";

/** the inventory's `provider` for an agent imported from each registry */
export const REGISTRY_PROVIDER: Readonly<Record<AgentRegistry, string>> = Object.freeze({
  entra_agent_id: "microsoft",
  agent_365: "microsoft",
  gemini_enterprise: "google",
  bedrock_agentcore: "aws",
});

export const AGENT_REGISTRY_PAGE_MAX = 200;

const listQuery = z
  .object({
    status: z.enum(["open", "imported", "absent", "all"]).default("open"),
    sourceId: z.string().uuid().optional(),
    registry: z.enum(AGENT_REGISTRIES).optional(),
    agentId: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(AGENT_REGISTRY_PAGE_MAX).default(50),
    /** keyset cursor: the `nextCursor` of the previous page (opaque) */
    cursor: z.string().max(200).regex(/^[A-Za-z0-9_-]+$/).optional(),
  })
  .strict();
const recordParam = z.object({ recordId: z.string().uuid() }).strict();
const importBody = z
  .object({
    /** the inventory name; default the vendor's display name. Unique across agents. */
    name: z.string().trim().min(1).max(120).optional(),
    /** the risk tier the admin assigns (the vendor has none) */
    tier: z.number().int().min(0).max(10),
    /** the accountable steward (ADR-0089); default none, shown as "unowned" */
    stewardUserId: z.string().uuid().optional(),
  })
  .strict();

const recordView = (r: typeof agentRegistryRecords.$inferSelect, sourceName: string | null) => ({
  id: r.id,
  source: { id: r.sourceId, name: sourceName },
  registry: r.registry,
  registryLabel: AGENT_REGISTRY_LABELS[r.registry],
  externalId: r.externalId,
  displayName: r.displayName,
  description: r.description,
  vendorAttributes: r.vendorAttributes,
  firstSeenAt: r.firstSeenAt.toISOString(),
  lastSeenAt: r.lastSeenAt.toISOString(),
  absentSince: r.absentSince?.toISOString() ?? null,
  lastRunId: r.lastRunId,
  agentId: r.agentId,
  importedAt: r.importedAt?.toISOString() ?? null,
  importedByUserId: r.importedByUserId,
});

const CURSOR_TS = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,6})?[+-]\d{2}(?::\d{2})?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const encodeCursor = (at: string, id: string) => Buffer.from(JSON.stringify([at, id])).toString("base64url");
function decodeCursor(c: string): { at: string; id: string } | null {
  try {
    const v: unknown = JSON.parse(Buffer.from(c, "base64url").toString("utf8"));
    if (Array.isArray(v) && v.length === 2 && typeof v[0] === "string" && typeof v[1] === "string" && CURSOR_TS.test(v[0]) && UUID.test(v[1])) return { at: v[0], id: v[1] };
  } catch {
    // fall through
  }
  return null;
}

/** the import step-up, bound to everything the import decides: the record, the agent's name, its tier and its steward */
export function agentRegistryImportStepUpArgs(a: { recordId: string; name: string; tier: number; stewardUserId: string | null }) {
  return { kind: "settings_relax" as const, facts: { op: "agent_registry_import", recordId: a.recordId, name: a.name, tier: a.tier, stewardUserId: a.stewardUserId } };
}

export function registerAgentRegistryRoutes(app: FastifyInstance, db: Db): void {
  const badRequest = (reply: FastifyReply, err: z.ZodError) =>
    reply.status(400).send({ error: "invalid_request", detail: err.issues.map((i) => `${i.path.join(".") || "query"}: ${i.message}`).join("; ") });
  const actor = (req: FastifyRequest) => req.authCtx.userId ?? null;

  app.get("/v1/agent-registry/records", async (req, reply) => {
    const q = listQuery.safeParse(req.query ?? {});
    if (!q.success) return badRequest(reply, q.error);
    const { status, sourceId, registry, agentId, limit, cursor } = q.data;
    const conds = [
      status === "open" ? and(isNull(agentRegistryRecords.agentId), isNull(agentRegistryRecords.absentSince)) : undefined,
      status === "imported" ? isNotNull(agentRegistryRecords.agentId) : undefined,
      status === "absent" ? isNotNull(agentRegistryRecords.absentSince) : undefined,
      sourceId ? eq(agentRegistryRecords.sourceId, sourceId) : undefined,
      registry ? eq(agentRegistryRecords.registry, registry) : undefined,
      agentId ? eq(agentRegistryRecords.agentId, agentId) : undefined,
    ];
    if (cursor) {
      const k = decodeCursor(cursor);
      if (!k) return reply.status(400).send({ error: "invalid_request", detail: "cursor: not a cursor this API issued" });
      // the database's own timestamp text (microseconds), so rows stamped by one now() are never skipped
      conds.push(sql`(${agentRegistryRecords.lastSeenAt}, ${agentRegistryRecords.id}) < (${k.at}::timestamptz, ${k.id}::uuid)`);
    }
    const rows = await db
      .select({ r: agentRegistryRecords, sourceName: discoverySources.name, at: sql<string>`${agentRegistryRecords.lastSeenAt}::text` })
      .from(agentRegistryRecords)
      .leftJoin(discoverySources, eq(discoverySources.id, agentRegistryRecords.sourceId))
      .where(and(...conds.filter((c) => c !== undefined)))
      .orderBy(desc(agentRegistryRecords.lastSeenAt), desc(agentRegistryRecords.id))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      records: page.map((x) => recordView(x.r, x.sourceName)),
      nextCursor: rows.length > limit && last ? encodeCursor(last.at, last.r.id) : null,
    };
  });

  app.get("/v1/agent-registry/records/:recordId", async (req, reply) => {
    const p = recordParam.safeParse(req.params);
    if (!p.success) return badRequest(reply, p.error);
    const [row] = await db
      .select({ r: agentRegistryRecords, sourceName: discoverySources.name })
      .from(agentRegistryRecords)
      .leftJoin(discoverySources, eq(discoverySources.id, agentRegistryRecords.sourceId))
      .where(eq(agentRegistryRecords.id, p.data.recordId));
    if (!row) return reply.status(404).send({ error: "unknown_registry_record" });
    return recordView(row.r, row.sourceName);
  });

  app.post("/v1/agent-registry/records/:recordId/import", async (req, reply) => {
    const p = recordParam.safeParse(req.params);
    if (!p.success) return badRequest(reply, p.error);
    const b = importBody.safeParse(req.body ?? {});
    if (!b.success) return badRequest(reply, b.error);
    const [rec] = await db.select().from(agentRegistryRecords).where(eq(agentRegistryRecords.id, p.data.recordId));
    if (!rec) return reply.status(404).send({ error: "unknown_registry_record" });
    if (rec.agentId) return reply.status(409).send({ error: "already_imported", detail: "this registry agent is already in the inventory", agentId: rec.agentId });
    const name = (b.data.name ?? rec.displayName).trim().slice(0, 120);
    // ADR-0052: a new agent widens the governed footprint, so it is expansion-class (as POST /v1/agents)
    const licenseRefusal = await refuseIfExpansionBlocked(db, { actorUserId: actor(req), objectType: "agent", what: `importing agent '${name}' from a vendor registry` });
    if (licenseRefusal) return reply.status(licenseRefusal.status).send(licenseRefusal.body);
    // checked BEFORE the step-up is spent, so a refusal never burns the grant
    const [taken] = await db.select({ id: agents.id }).from(agents).where(eq(agents.name, name));
    if (taken) return reply.status(409).send({ error: "conflict", detail: `an agent named '${name}' already exists: import it under another name` });
    // the shared owner check (as every other owner assignment): an existing, active user, else 422
    const steward = await checkOwnerTarget(db, b.data.stewardUserId ?? null);
    if (!steward.ok) return reply.status(steward.status).send(steward.body);
    const su = await requireStepUp(db, req, reply, agentRegistryImportStepUpArgs({ recordId: rec.id, name, tier: b.data.tier, stewardUserId: steward.ownerUserId }));
    if (!su.ok) return reply;

    const label = AGENT_REGISTRY_LABELS[rec.registry];
    const out = await db.transaction(async (tx) => {
      const t = tx as unknown as Db;
      // re-read under lock: a concurrent import of the same record loses here, not at the unique index
      const [locked] = await t.select().from(agentRegistryRecords).where(eq(agentRegistryRecords.id, rec.id)).for("update");
      if (!locked || locked.agentId) return { conflict: true as const };
      const [agent] = await t
        .insert(agents)
        .values({
          name,
          provider: REGISTRY_PROVIDER[locked.registry],
          tier: b.data.tier,
          // ADR-0180: off and proposed until an admin reviews it; no grant rows are written (default-deny)
          enabled: false,
          lifecycleStatus: "proposed",
          lifecycleReason: `imported from ${label} (${locked.externalId.slice(0, 200)}); awaiting review`,
          lifecycleChangedAt: sql`now()`,
          ownerUserId: steward.ownerUserId,
        })
        .onConflictDoNothing({ target: agents.name })
        .returning();
      if (!agent) return { nameTaken: true as const };
      await t
        .update(agentRegistryRecords)
        .set({ agentId: agent.id, importedAt: sql`now()`, importedByUserId: actor(req) })
        .where(eq(agentRegistryRecords.id, locked.id));
      await t.insert(auditLog).values({
        userId: actor(req) ?? NIL_UUID,
        objectType: "agent",
        objectId: agent.id,
        detail: {
          subsystem: "agent-registry-import",
          provenance: { recordId: locked.id, sourceId: locked.sourceId, registry: locked.registry, externalId: locked.externalId, lastRunId: locked.lastRunId, lastSeenAt: locked.lastSeenAt.toISOString() },
          tier: b.data.tier,
          stewardUserId: b.data.stewardUserId ?? null,
          enabled: false,
          lifecycleStatus: "proposed",
          grants: 0,
          stepUp: su.method,
          receiptClass: "configuration",
        },
        effect: "allow",
        ruleId: "agent-registry-imported",
        ruleChain: [],
        reason: `agent '${name}' imported from ${label} as proposed and disabled, with no grants (default-deny until an admin grants it)`,
      });
      return { agent, record: { ...locked, agentId: agent.id } };
    });
    if ("conflict" in out) return reply.status(409).send({ error: "already_imported", detail: "this registry agent was imported concurrently" });
    if ("nameTaken" in out) return reply.status(409).send({ error: "conflict", detail: `an agent named '${name}' already exists: import it under another name` });
    const [fresh] = await db.select().from(agentRegistryRecords).where(eq(agentRegistryRecords.id, rec.id));
    return reply.status(201).send({ agent: out.agent, record: recordView(fresh ?? out.record, null) });
  });
}
