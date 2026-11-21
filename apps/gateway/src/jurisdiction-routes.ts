/**
 * ADR-0345 §9, slice 3b: the jurisdiction admin APIs. Jurisdictions, their obligations and a use case's declared
 * jurisdictions are DATA (seeded by migration); these routes are how an admin edits them.
 *
 *   GET    /v1/jurisdictions                                 every jurisdiction with its obligations (paged)
 *   POST   /v1/jurisdictions                                 add a jurisdiction
 *   PATCH  /v1/jurisdictions/:code                           rename it, move it under a parent, or mark it global
 *   DELETE /v1/jurisdictions/:code                           remove it (refused while a use case or child names it)
 *   POST   /v1/jurisdictions/:code/obligations               add an obligation from the ADR-0158 feed
 *   PATCH  /v1/jurisdictions/obligations/:obligationId       change its tier floor
 *   DELETE /v1/jurisdictions/obligations/:obligationId       remove it
 *   GET    /v1/use-cases/:useCaseId/jurisdictions            the declared ones, and what they resolve to
 *   PUT    /v1/use-cases/:useCaseId/jurisdictions            replace the declared ones
 *
 * All are admin-only through the default gate (none is in `NON_ADMIN_ROUTES`).
 *
 * The #1019 security review, met here:
 *   - NARROWING IS A RELAXATION. Removing an obligation or a jurisdiction, lowering or clearing a tier floor, taking
 *     away a parent or the global flag, and any declaration change that drops a jurisdiction, an obligation or the floor
 *     from a use case's scope (`geographyNarrowing`, over the same `resolveGeography` the tiering reads) needs a
 *     `settings_relax` step-up bound to exactly what is narrowed. Widening needs none. Every write is audited with its
 *     reason in its own transaction.
 *   - A FEED KEY IS VALIDATED (#1037): an obligation must cite an ADR-0158 entry that exists, is not withdrawn, and
 *     names this jurisdiction.
 *   - `code` IS IMMUTABLE (#1036): the update schema has no `code`, so the natural key the references use never moves.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  aiUseCaseJurisdictions,
  aiUseCases,
  and,
  asc,
  auditLog,
  count,
  eq,
  inArray,
  jurisdictionObligations,
  jurisdictions,
  type Db,
} from "@regulait/db";
import {
  EU_AI_ACT_TIER_RANK,
  JURISDICTION_CODE_RE,
  REGULATORY_UPDATES,
  createJurisdictionObligationSchema,
  createJurisdictionSchema,
  geographyNarrowing,
  jurisdictionReasonSchema,
  resolveGeography,
  updateJurisdictionObligationSchema,
  updateJurisdictionSchema,
  useCaseJurisdictionsSchema,
  type JurisdictionObligationRow,
} from "@regulait/shared";
import { requireRelaxStepUp } from "./step-up.js";
import { SYSTEM_ATTRIBUTION_ID } from "./system-attribution.js";

export const JURISDICTION_AUDIT_RULES = {
  created: "jurisdiction-created",
  updated: "jurisdiction-updated",
  deleted: "jurisdiction-deleted",
  obligationCreated: "jurisdiction-obligation-created",
  obligationUpdated: "jurisdiction-obligation-updated",
  obligationDeleted: "jurisdiction-obligation-deleted",
  declarationsChanged: "use-case-jurisdictions-changed",
} as const;

export const JURISDICTIONS_PAGE_MAX = 200;

const codeParam = z.object({ code: z.string().max(40).regex(JURISDICTION_CODE_RE) }).strict();
const obligationParam = z.object({ obligationId: z.string().uuid() }).strict();
const useCaseParam = z.object({ useCaseId: z.string().uuid() }).strict();
const pageQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(JURISDICTIONS_PAGE_MAX).default(100),
    offset: z.coerce.number().int().min(0).max(100_000).default(0),
  })
  .strict();

/** why an obligation may not cite this feed key for this jurisdiction (#1037), or null when it may */
export function obligationFeedProblem(regulatoryUpdateKey: string, jurisdictionCode: string): string | null {
  const entry = REGULATORY_UPDATES.find((u) => u.key === regulatoryUpdateKey);
  if (!entry) return "unknown_feed_key";
  if (entry.status === "withdrawn") return "withdrawn_feed_key";
  if (entry.jurisdiction !== jurisdictionCode) return "feed_key_other_jurisdiction";
  return null;
}

const ns = (s: string) => `jurisdictions.${s}`;

async function audit(
  tx: Db,
  req: FastifyRequest,
  ruleId: string,
  detail: Record<string, unknown>,
  reason: string,
): Promise<void> {
  await tx.insert(auditLog).values({
    userId: req.authCtx.userId ?? SYSTEM_ATTRIBUTION_ID,
    objectType: "jurisdiction",
    objectId: null,
    detail: { via: req.authCtx.via, ...detail },
    effect: "allow",
    ruleId,
    ruleChain: [],
    reason,
  });
}

/** the codes of a jurisdiction and every ancestor (the visited set stops a cycle in admin-edited data) */
function ancestry(code: string | null, parentOf: ReadonlyMap<string, string | null>): Set<string> {
  const out = new Set<string>();
  let cur = code;
  while (cur && !out.has(cur)) {
    out.add(cur);
    cur = parentOf.get(cur) ?? null;
  }
  return out;
}

const pgCode = (err: unknown): string | undefined => {
  const e = err as { code?: string; cause?: { code?: string } };
  return e?.code ?? e?.cause?.code;
};

export function registerJurisdictionRoutes(app: FastifyInstance, db: Db): void {
  app.get("/v1/jurisdictions", async (req) => {
    const q = pageQuery.parse(req.query ?? {});
    const rows = await db.select().from(jurisdictions).orderBy(asc(jurisdictions.code)).limit(q.limit + 1).offset(q.offset);
    const page = rows.slice(0, q.limit);
    const obligations = page.length
      ? await db
          .select()
          .from(jurisdictionObligations)
          .where(inArray(jurisdictionObligations.jurisdictionCode, page.map((j) => j.code)))
          .orderBy(asc(jurisdictionObligations.regulatoryUpdateKey), asc(jurisdictionObligations.agentRiskKey))
      : [];
    return {
      jurisdictions: page.map((j) => ({
        code: j.code,
        name: j.name,
        parentCode: j.parentCode,
        global: j.global,
        createdAt: j.createdAt,
        obligations: obligations
          .filter((o) => o.jurisdictionCode === j.code)
          .map((o) => ({ id: o.id, regulatoryUpdateKey: o.regulatoryUpdateKey, agentRiskKey: o.agentRiskKey, tierFloor: o.tierFloor, createdAt: o.createdAt })),
      })),
      hasMore: rows.length > q.limit,
    };
  });

  /** adding a jurisdiction only widens: no step-up */
  app.post("/v1/jurisdictions", async (req, reply) => {
    const body = createJurisdictionSchema.parse(req.body);
    if (body.parentCode === body.code) return reply.status(400).send({ error: "parent_is_self" });
    try {
      const row = await db.transaction(async (rawTx) => {
        const tx = rawTx as unknown as Db;
        const [created] = await tx
          .insert(jurisdictions)
          .values({ code: body.code, name: body.name, parentCode: body.parentCode, global: body.global })
          .returning();
        await audit(tx, req, JURISDICTION_AUDIT_RULES.created, { code: body.code, after: { name: body.name, parentCode: body.parentCode, global: body.global }, reason: body.reason }, `jurisdiction '${body.code}' added — reason: ${body.reason}`);
        return created!;
      });
      return reply.status(201).send(row);
    } catch (err) {
      if (pgCode(err) === "23505") return reply.status(409).send({ error: "jurisdiction_exists" });
      if (pgCode(err) === "23503") return reply.status(400).send({ error: "unknown_parent" });
      throw err;
    }
  });

  app.patch("/v1/jurisdictions/:code", async (req, reply) => {
    const { code } = codeParam.parse(req.params);
    const body = updateJurisdictionSchema.parse(req.body);
    const all = await db.select({ code: jurisdictions.code, parentCode: jurisdictions.parentCode, global: jurisdictions.global, name: jurisdictions.name }).from(jurisdictions);
    const current = all.find((j) => j.code === code);
    if (!current) return reply.status(404).send({ error: "unknown_jurisdiction" });
    const parentOf = new Map(all.map((j) => [j.code, j.parentCode]));
    const nextParent = body.parentCode === undefined ? current.parentCode : body.parentCode;
    if (nextParent === code) return reply.status(400).send({ error: "parent_is_self" });
    if (nextParent !== null && !parentOf.has(nextParent)) return reply.status(400).send({ error: "unknown_parent" });
    // a parent under this jurisdiction would make a cycle
    if (nextParent !== null && ancestry(nextParent, parentOf).has(code)) return reply.status(400).send({ error: "parent_cycle" });
    const relaxed: Record<string, unknown> = {};
    if (body.global === false && current.global) relaxed[ns(`${code}.global`)] = false;
    if (nextParent !== current.parentCode) {
      // the ancestors this jurisdiction would stop inheriting obligations from
      const lost = [...ancestry(current.parentCode, parentOf)].filter((c) => !ancestry(nextParent, parentOf).has(c));
      if (lost.length) relaxed[ns(`${code}.parentCode`)] = nextParent;
    }
    if (!(await requireRelaxStepUp(db, req, reply, relaxed))) return reply;
    const row = await db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Db;
      const [updated] = await tx
        .update(jurisdictions)
        .set({
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.parentCode !== undefined ? { parentCode: body.parentCode } : {}),
          ...(body.global !== undefined ? { global: body.global } : {}),
        })
        .where(eq(jurisdictions.code, code))
        .returning();
      await audit(
        tx,
        req,
        JURISDICTION_AUDIT_RULES.updated,
        {
          code,
          before: { name: current.name, parentCode: current.parentCode, global: current.global },
          after: { name: updated!.name, parentCode: updated!.parentCode, global: updated!.global },
          relaxed: Object.keys(relaxed),
          reason: body.reason,
        },
        `jurisdiction '${code}' changed${Object.keys(relaxed).length ? " (narrowed, stepped up)" : ""} — reason: ${body.reason}`,
      );
      return updated!;
    });
    return reply.send({ ...row, relaxed: Object.keys(relaxed) });
  });

  /** removing a jurisdiction removes its obligations (and narrows undeclared use cases): always a relaxation */
  app.delete("/v1/jurisdictions/:code", async (req, reply) => {
    const { code } = codeParam.parse(req.params);
    const body = jurisdictionReasonSchema.parse(req.body ?? {});
    const [current] = await db.select().from(jurisdictions).where(eq(jurisdictions.code, code));
    if (!current) return reply.status(404).send({ error: "unknown_jurisdiction" });
    const [[declared], [children]] = await Promise.all([
      db.select({ n: count() }).from(aiUseCaseJurisdictions).where(eq(aiUseCaseJurisdictions.jurisdictionCode, code)),
      db.select({ n: count() }).from(jurisdictions).where(eq(jurisdictions.parentCode, code)),
    ]);
    if (Number(declared?.n ?? 0) > 0) return reply.status(409).send({ error: "jurisdiction_declared", useCases: Number(declared!.n) });
    if (Number(children?.n ?? 0) > 0) return reply.status(409).send({ error: "jurisdiction_has_children", children: Number(children!.n) });
    if (!(await requireRelaxStepUp(db, req, reply, { [ns(`${code}.deleted`)]: true }))) return reply;
    await db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Db;
      const obligations = await tx.select().from(jurisdictionObligations).where(eq(jurisdictionObligations.jurisdictionCode, code));
      await tx.delete(jurisdictions).where(eq(jurisdictions.code, code));
      await audit(
        tx,
        req,
        JURISDICTION_AUDIT_RULES.deleted,
        {
          code,
          before: { name: current.name, parentCode: current.parentCode, global: current.global },
          obligationsRemoved: obligations.map((o) => ({ regulatoryUpdateKey: o.regulatoryUpdateKey, agentRiskKey: o.agentRiskKey, tierFloor: o.tierFloor })),
          relaxed: [ns(`${code}.deleted`)],
          reason: body.reason,
        },
        `jurisdiction '${code}' removed with ${obligations.length} obligation(s) (narrowed, stepped up) — reason: ${body.reason}`,
      );
    });
    return reply.status(204).send();
  });

  /** adding an obligation only widens; its feed key must exist, be live and name this jurisdiction (#1037) */
  app.post("/v1/jurisdictions/:code/obligations", async (req, reply) => {
    const { code } = codeParam.parse(req.params);
    const body = createJurisdictionObligationSchema.parse(req.body);
    const [j] = await db.select({ code: jurisdictions.code }).from(jurisdictions).where(eq(jurisdictions.code, code));
    if (!j) return reply.status(404).send({ error: "unknown_jurisdiction" });
    const problem = obligationFeedProblem(body.regulatoryUpdateKey, code);
    if (problem) return reply.status(400).send({ error: problem, regulatoryUpdateKey: body.regulatoryUpdateKey });
    try {
      const row = await db.transaction(async (rawTx) => {
        const tx = rawTx as unknown as Db;
        const [created] = await tx
          .insert(jurisdictionObligations)
          .values({
            jurisdictionCode: code,
            regulatoryUpdateKey: body.regulatoryUpdateKey,
            agentRiskKey: body.agentRiskKey,
            tierFloor: body.tierFloor,
            createdByUserId: req.authCtx.userId ?? null,
          })
          .returning();
        await audit(
          tx,
          req,
          JURISDICTION_AUDIT_RULES.obligationCreated,
          { code, obligationId: created!.id, after: { regulatoryUpdateKey: body.regulatoryUpdateKey, agentRiskKey: body.agentRiskKey, tierFloor: body.tierFloor }, reason: body.reason },
          `obligation '${body.regulatoryUpdateKey}' -> ${body.agentRiskKey} added to '${code}' — reason: ${body.reason}`,
        );
        return created!;
      });
      return reply.status(201).send(row);
    } catch (err) {
      if (pgCode(err) === "23505") return reply.status(409).send({ error: "obligation_exists" });
      throw err;
    }
  });

  /** lowering or clearing a tier floor narrows: a relaxation; raising it does not */
  app.patch("/v1/jurisdictions/obligations/:obligationId", async (req, reply) => {
    const { obligationId } = obligationParam.parse(req.params);
    const body = updateJurisdictionObligationSchema.parse(req.body);
    const [current] = await db.select().from(jurisdictionObligations).where(eq(jurisdictionObligations.id, obligationId));
    if (!current) return reply.status(404).send({ error: "unknown_obligation" });
    const lowered =
      current.tierFloor !== null && (body.tierFloor === null || EU_AI_ACT_TIER_RANK[body.tierFloor] < EU_AI_ACT_TIER_RANK[current.tierFloor]);
    const relaxed = lowered ? { [ns(`obligations.${obligationId}.tierFloor`)]: body.tierFloor } : {};
    if (!(await requireRelaxStepUp(db, req, reply, relaxed))) return reply;
    const row = await db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Db;
      const [updated] = await tx.update(jurisdictionObligations).set({ tierFloor: body.tierFloor }).where(eq(jurisdictionObligations.id, obligationId)).returning();
      await audit(
        tx,
        req,
        JURISDICTION_AUDIT_RULES.obligationUpdated,
        { code: current.jurisdictionCode, obligationId, before: { tierFloor: current.tierFloor }, after: { tierFloor: body.tierFloor }, relaxed: Object.keys(relaxed), reason: body.reason },
        `obligation '${current.regulatoryUpdateKey}' in '${current.jurisdictionCode}': tier floor ${current.tierFloor ?? "none"} -> ${body.tierFloor ?? "none"}${lowered ? " (narrowed, stepped up)" : ""} — reason: ${body.reason}`,
      );
      return updated!;
    });
    return reply.send({ ...row, relaxed: Object.keys(relaxed) });
  });

  /** removing an obligation narrows: always a relaxation */
  app.delete("/v1/jurisdictions/obligations/:obligationId", async (req, reply) => {
    const { obligationId } = obligationParam.parse(req.params);
    const body = jurisdictionReasonSchema.parse(req.body ?? {});
    const [current] = await db.select().from(jurisdictionObligations).where(eq(jurisdictionObligations.id, obligationId));
    if (!current) return reply.status(404).send({ error: "unknown_obligation" });
    const key = ns(`obligations.${obligationId}.deleted`);
    if (!(await requireRelaxStepUp(db, req, reply, { [key]: true }))) return reply;
    await db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Db;
      await tx.delete(jurisdictionObligations).where(eq(jurisdictionObligations.id, obligationId));
      await audit(
        tx,
        req,
        JURISDICTION_AUDIT_RULES.obligationDeleted,
        {
          code: current.jurisdictionCode,
          obligationId,
          before: { regulatoryUpdateKey: current.regulatoryUpdateKey, agentRiskKey: current.agentRiskKey, tierFloor: current.tierFloor },
          relaxed: [key],
          reason: body.reason,
        },
        `obligation '${current.regulatoryUpdateKey}' removed from '${current.jurisdictionCode}' (narrowed, stepped up) — reason: ${body.reason}`,
      );
    });
    return reply.status(204).send();
  });

  async function loadGeography(tx: Db) {
    const [js, os] = await Promise.all([
      tx.select({ code: jurisdictions.code, parentCode: jurisdictions.parentCode, global: jurisdictions.global }).from(jurisdictions),
      tx.select().from(jurisdictionObligations),
    ]);
    return { js, os: os as unknown as JurisdictionObligationRow[] };
  }

  async function useCaseExists(useCaseId: string, reply: FastifyReply): Promise<boolean> {
    const [u] = await db.select({ id: aiUseCases.id }).from(aiUseCases).where(eq(aiUseCases.id, useCaseId));
    if (!u) {
      await reply.status(404).send({ error: "unknown_use_case" });
      return false;
    }
    return true;
  }

  app.get("/v1/use-cases/:useCaseId/jurisdictions", async (req, reply) => {
    const { useCaseId } = useCaseParam.parse(req.params);
    if (!(await useCaseExists(useCaseId, reply))) return reply;
    const declared = (await db.select().from(aiUseCaseJurisdictions).where(eq(aiUseCaseJurisdictions.useCaseId, useCaseId))).map((d) => d.jurisdictionCode).sort();
    const { js, os } = await loadGeography(db);
    return { useCaseId, declared, resolution: resolveGeography(declared, js, os) };
  });

  /** replace the declared jurisdictions; a change that drops anything from scope is a relaxation */
  app.put("/v1/use-cases/:useCaseId/jurisdictions", async (req, reply) => {
    const { useCaseId } = useCaseParam.parse(req.params);
    const body = useCaseJurisdictionsSchema.parse(req.body);
    if (!(await useCaseExists(useCaseId, reply))) return reply;
    const { js, os } = await loadGeography(db);
    const known = new Set(js.map((j) => j.code));
    const unknown = body.codes.filter((c) => !known.has(c));
    if (unknown.length) return reply.status(400).send({ error: "unknown_jurisdiction", codes: unknown });
    const before = (await db.select().from(aiUseCaseJurisdictions).where(eq(aiUseCaseJurisdictions.useCaseId, useCaseId))).map((d) => d.jurisdictionCode).sort();
    const next = [...body.codes].sort();
    const narrowed = geographyNarrowing(resolveGeography(before, js, os), resolveGeography(next, js, os));
    const relaxed = narrowed.length ? { [ns(`useCases.${useCaseId}.declared`)]: next } : {};
    if (!(await requireRelaxStepUp(db, req, reply, relaxed))) return reply;
    const resolution = await db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Db;
      const removed = before.filter((c) => !next.includes(c));
      const added = next.filter((c) => !before.includes(c));
      if (removed.length) await tx.delete(aiUseCaseJurisdictions).where(and(eq(aiUseCaseJurisdictions.useCaseId, useCaseId), inArray(aiUseCaseJurisdictions.jurisdictionCode, removed)));
      if (added.length) await tx.insert(aiUseCaseJurisdictions).values(added.map((c) => ({ useCaseId, jurisdictionCode: c, addedByUserId: req.authCtx.userId ?? null })));
      await audit(
        tx,
        req,
        JURISDICTION_AUDIT_RULES.declarationsChanged,
        { useCaseId, before, after: next, narrowed, relaxed: Object.keys(relaxed), reason: body.reason },
        `use case ${useCaseId}: declared jurisdictions [${before.join(", ") || "none: every jurisdiction"}] -> [${next.join(", ") || "none: every jurisdiction"}]` +
          `${narrowed.length ? " (narrowed, stepped up)" : ""} — reason: ${body.reason}`,
      );
      return resolveGeography(next, js, os);
    });
    return reply.send({ useCaseId, declared: next, narrowed, relaxed: Object.keys(relaxed), resolution });
  });
}
