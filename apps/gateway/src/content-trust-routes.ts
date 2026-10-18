/**
 * ADR-0193 (I4) P1 admin routes: the trust tiers of content sources, the write floor, and the P0 evidence view.
 * Admin-only by default (none of these routes is in NON_ADMIN_ROUTES).
 *
 *   GET /v1/content-trust
 *       Every MCP server and connector with its tier (`untrusted` unless an admin set one, ADR-0180), and the
 *       write floor.
 *   PUT /v1/content-trust/sources/:sourceKind/:sourceId        body { tier }
 *       Set a source's tier. Every change, raising or lowering, needs a `settings_relax` step-up (the ADR's choice:
 *       "an admin sets a source's tier, and the change is audited"; no new step-up kind) and is audited
 *       `content-trust-tier-set`, with `relaxation: true` when the tier went up.
 *   PUT /v1/content-trust/settings                            body { writeFloor }
 *       The lowest tier whose content may drive a write: `trusted` (the default) or `standard` (a relaxation).
 *       A `settings_relax` step-up, audited `content-trust-floor-set`.
 *   GET /v1/content-provenance/records?contextId=&limit=
 *       The newest provenance records (labels and digests, never content), each with the audit anchor that covers
 *       its audit row and that anchor's RFC 3161 state: the timestamp evidence of ADR-0193 decision 4.
 *
 * Every write is a compare-and-set on the value the step-up decision rested on (ADR-0186 Class A): if it moved,
 * nothing is written and the answer is `409 changed_concurrently`.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  and,
  auditLog,
  connectors,
  contentProvenanceRecords,
  contentTrustSettings,
  contentTrustTiers,
  desc,
  eq,
  mcpServers,
  sql,
  type Db,
} from "@regulait/db";
import {
  CONTENT_CONTEXT_ID_PATTERN,
  CONTENT_SOURCE_KINDS,
  CONTENT_TRUST_TIERS,
  CONTENT_TRUST_WRITE_FLOORS,
  DEFAULT_CONTENT_TRUST_TIER,
  contentTrustRank,
  type ContentTrustTier,
} from "@regulait/shared";
import { contentTrustWriteFloor, coveringAnchors } from "./content-provenance.js";
import { CHANGED_CONCURRENTLY, requireStepUp } from "./step-up.js";

const NO_IDENTITY = "00000000-0000-0000-0000-000000000000";
const sourceParam = z.object({ sourceKind: z.enum(CONTENT_SOURCE_KINDS), sourceId: z.string().uuid() });
const setTierBody = z.object({ tier: z.enum(CONTENT_TRUST_TIERS) }).strict();
const setFloorBody = z.object({ writeFloor: z.enum(CONTENT_TRUST_WRITE_FLOORS) }).strict();
const recordsQuery = z
  .object({
    contextId: z.string().regex(CONTENT_CONTEXT_ID_PATTERN).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();

const invalid = (err: z.ZodError) => ({
  error: "invalid_request",
  detail: err.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "),
});

export function registerContentTrustRoutes(app: FastifyInstance, db: Db): void {
  const actor = (req: FastifyRequest) => req.authCtx?.userId ?? NO_IDENTITY;

  app.get("/v1/content-trust", async () => {
    const [servers, conns, tiers, writeFloor] = await Promise.all([
      db.select({ id: mcpServers.id, name: mcpServers.name }).from(mcpServers),
      db.select({ id: connectors.id, name: connectors.name }).from(connectors),
      db.select().from(contentTrustTiers),
      contentTrustWriteFloor(db),
    ]);
    const set = new Map(tiers.map((t) => [`${t.sourceKind}:${t.sourceId}`, t]));
    const view = (kind: "mcp_server" | "connector", s: { id: string; name: string }) => {
      const row = set.get(`${kind}:${s.id}`);
      return {
        sourceKind: kind,
        sourceId: s.id,
        name: s.name,
        tier: row?.tier ?? DEFAULT_CONTENT_TRUST_TIER,
        /** false = no admin has set it: the strict default applies */
        explicit: Boolean(row),
        setByUserId: row?.setByUserId ?? null,
        setAt: row?.setAt.toISOString() ?? null,
      };
    };
    const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
    return {
      tiers: CONTENT_TRUST_TIERS,
      defaultTier: DEFAULT_CONTENT_TRUST_TIER,
      writeFloor,
      writeFloors: CONTENT_TRUST_WRITE_FLOORS,
      sources: [
        ...servers.sort(byName).map((s) => view("mcp_server", s)),
        ...conns.sort(byName).map((s) => view("connector", s)),
      ],
    };
  });

  app.put("/v1/content-trust/sources/:sourceKind/:sourceId", async (req, reply) => {
    const p = sourceParam.safeParse(req.params);
    if (!p.success) return reply.status(400).send(invalid(p.error));
    const b = setTierBody.safeParse(req.body ?? {});
    if (!b.success) return reply.status(400).send(invalid(b.error));
    const { sourceKind, sourceId } = p.data;
    const next = b.data.tier;
    const table = sourceKind === "mcp_server" ? mcpServers : connectors;
    const [source] = await db.select({ id: table.id, name: table.name }).from(table).where(eq(table.id, sourceId));
    if (!source) return reply.status(404).send({ error: "unknown_source" });
    const [before] = await db
      .select()
      .from(contentTrustTiers)
      .where(and(eq(contentTrustTiers.sourceKind, sourceKind), eq(contentTrustTiers.sourceId, sourceId)));
    const from: ContentTrustTier = before?.tier ?? DEFAULT_CONTENT_TRUST_TIER;
    if (from === next && before) return reply.send({ sourceKind, sourceId, tier: next, changed: false });

    const su = await requireStepUp(db, req, reply, {
      kind: "settings_relax",
      facts: { op: "content_trust_tier", sourceKind, sourceId, from, to: next },
    });
    if (!su.ok) return reply;

    const written = await db.transaction(async (tx) => {
      const [locked] = await tx
        .select()
        .from(contentTrustTiers)
        .where(and(eq(contentTrustTiers.sourceKind, sourceKind), eq(contentTrustTiers.sourceId, sourceId)))
        .for("update");
      if ((locked?.tier ?? null) !== (before?.tier ?? null)) return false;
      if (locked) {
        await tx
          .update(contentTrustTiers)
          .set({ tier: next, version: locked.version + 1, setByUserId: actor(req), setAt: sql`now()` })
          .where(and(eq(contentTrustTiers.sourceKind, sourceKind), eq(contentTrustTiers.sourceId, sourceId)));
      } else {
        const inserted = await tx
          .insert(contentTrustTiers)
          .values({ sourceKind, sourceId, tier: next, setByUserId: actor(req) })
          .onConflictDoNothing()
          .returning({ sourceId: contentTrustTiers.sourceId });
        if (inserted.length === 0) return false;
      }
      const relaxation = contentTrustRank(next) > contentTrustRank(from);
      await tx.insert(auditLog).values({
        userId: actor(req),
        objectType: "content_trust",
        objectId: sourceId,
        detail: { subsystem: "content-provenance", sourceKind, sourceId, from, to: next, relaxation, stepUp: su.method },
        effect: "allow",
        ruleId: "content-trust-tier-set",
        ruleChain: [],
        reason: `${sourceKind === "mcp_server" ? "MCP server" : "connector"} '${source.name}' trust tier ${from} -> ${next} (ADR-0193 decision 7)`,
      });
      return true;
    });
    if (!written) return reply.status(CHANGED_CONCURRENTLY.status).send(CHANGED_CONCURRENTLY.body);
    return reply.send({ sourceKind, sourceId, tier: next, changed: true });
  });

  app.put("/v1/content-trust/settings", async (req, reply) => {
    const b = setFloorBody.safeParse(req.body ?? {});
    if (!b.success) return reply.status(400).send(invalid(b.error));
    const next = b.data.writeFloor;
    const from = await contentTrustWriteFloor(db);
    if (from === next) return reply.send({ writeFloor: next, changed: false });
    const su = await requireStepUp(db, req, reply, { kind: "settings_relax", facts: { op: "content_trust_write_floor", from, to: next } });
    if (!su.ok) return reply;
    const written = await db.transaction(async (tx) => {
      const [locked] = await tx.select().from(contentTrustSettings).where(eq(contentTrustSettings.id, 1)).for("update");
      if (!locked) {
        // the migration seeds the row; a missing one is the strict default, written now
        if (from !== "trusted") return false;
        const inserted = await tx
          .insert(contentTrustSettings)
          .values({ id: 1, writeFloor: next, updatedBy: actor(req) })
          .onConflictDoNothing()
          .returning({ id: contentTrustSettings.id });
        if (inserted.length === 0) return false;
      } else {
        if (locked.writeFloor !== from) return false;
        await tx
          .update(contentTrustSettings)
          .set({ writeFloor: next, version: locked.version + 1, updatedBy: actor(req), updatedAt: sql`now()` })
          .where(eq(contentTrustSettings.id, 1));
      }
      const relaxation = contentTrustRank(next) < contentTrustRank(from);
      await tx.insert(auditLog).values({
        userId: actor(req),
        objectType: "content_trust",
        objectId: null,
        detail: { subsystem: "content-provenance", setting: "writeFloor", from, to: next, relaxation, stepUp: su.method },
        effect: "allow",
        ruleId: "content-trust-floor-set",
        ruleChain: [],
        reason: `content trust write floor ${from} -> ${next} (ADR-0193 P1)`,
      });
      return true;
    });
    if (!written) return reply.status(CHANGED_CONCURRENTLY.status).send(CHANGED_CONCURRENTLY.body);
    return reply.send({ writeFloor: next, changed: true });
  });

  app.get("/v1/content-provenance/records", async (req, reply) => {
    const q = recordsQuery.safeParse(req.query ?? {});
    if (!q.success) return reply.status(400).send(invalid(q.error));
    const rows = await db
      .select()
      .from(contentProvenanceRecords)
      .where(q.data.contextId ? eq(contentProvenanceRecords.contextId, q.data.contextId) : undefined)
      .orderBy(desc(contentProvenanceRecords.createdAt))
      .limit(q.data.limit);
    const anchors = await coveringAnchors(db, rows.map((r) => r.auditId));
    return {
      records: rows.map((r) => ({
        id: r.id,
        auditId: r.auditId,
        decisionAuditId: r.decisionAuditId,
        contextId: r.contextId,
        sourceKind: r.sourceKind,
        sourceId: r.sourceId,
        sourceDetail: r.sourceDetail,
        trustTier: r.trustTier,
        classification: r.classification,
        digestAlg: r.digestAlg,
        digestKeyId: r.digestKeyId,
        upstreamDigest: r.upstreamDigest,
        deliveredDigest: r.deliveredDigest,
        label: r.label,
        createdAt: r.createdAt.toISOString(),
        /** null until an anchor covers the audit row; then its RFC 3161 state (`granted` carries a token) */
        anchor: anchors.get(r.auditId) ?? null,
      })),
    };
  });
}
