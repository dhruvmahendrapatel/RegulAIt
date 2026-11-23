/**
 * ADR-0357 §4 (lane E38, slice 2): tighten-only policy inheritance, org → business unit → project → use case.
 *
 *   GET   /v1/business-units                      list (paginated)
 *   POST  /v1/business-units                      create
 *   PATCH /v1/business-units/:businessUnitId      rename / describe
 *   PUT   /v1/projects/:projectId/business-unit   move a project under a unit (or back under the org)
 *   GET   /v1/governance-policy/layer             one level's own layer (?level=&id=)
 *   PUT   /v1/governance-policy/layer             write one level's layer (tighten-only; compare-and-set)
 *   DELETE /v1/governance-policy/layer            remove one level's layer (?level=&id=&expectedVersion=)
 *   GET   /v1/governance-policy/effective         the effective policy at a level, each rule naming the level that set it
 *
 * Rules, in the order every write takes them:
 *  - a child layer that would widen what it inherits is refused (400 `policy_widens_parent`), naming each rule;
 *  - an edit that loosens a layer against its own previous self, removing a layer, and moving a project to a unit
 *    whose policy is looser are relaxations: a `settings_relax` step-up bound to exactly what loosens (ADR-0180);
 *  - every write runs under one advisory lock for the hierarchy and is audited (`governance_policy`).
 * The merge table and its tests are `@regulait/shared` (governance-policy.ts). Admin only (the global gate).
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  aiUseCases,
  and,
  asc,
  auditLog,
  businessUnits,
  eq,
  governancePolicyLayers,
  gt,
  projects,
  sql,
  type Db,
  type GovernancePolicyLayerRow,
} from "@regulait/db";
import {
  POLICY_LEVELS,
  effectivePolicy,
  governancePolicySchema,
  layerRelaxations,
  policyWidenings,
  ruleLoosens,
  type EffectiveRule,
  type GovernancePolicy,
  type PolicyLayerInput,
  type PolicyLevel,
} from "@regulait/shared";
import { requireStepUp } from "./step-up.js";

const NIL_USER = "00000000-0000-0000-0000-000000000000";

/** one hierarchy, one writer at a time: a policy write and a project move are decided on the chain they read */
const lockHierarchy = (tx: Db) => tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('regulait.governance_policy'))`);

export interface ChainLink {
  level: PolicyLevel;
  subjectId: string | null;
  name: string | null;
}

export class PolicySubjectNotFound extends Error {}

/** the levels from the org down to (and including) `level`/`id`, each with its subject */
export async function policyChain(db: Db, level: PolicyLevel, id: string | null): Promise<ChainLink[]> {
  const org: ChainLink = { level: "org", subjectId: null, name: null };
  if (level === "org") return [org];
  if (level === "business_unit") {
    const [bu] = await db.select({ id: businessUnits.id, name: businessUnits.name }).from(businessUnits).where(eq(businessUnits.id, id!));
    if (!bu) throw new PolicySubjectNotFound(`no business unit ${id}`);
    return [org, { level, subjectId: bu.id, name: bu.name }];
  }
  const projectLinks = async (projectId: string): Promise<ChainLink[]> => {
    const [p] = await db
      .select({ id: projects.id, name: projects.name, buId: businessUnits.id, buName: businessUnits.name })
      .from(projects)
      .leftJoin(businessUnits, eq(businessUnits.id, projects.businessUnitId))
      .where(eq(projects.id, projectId));
    if (!p) throw new PolicySubjectNotFound(`no project ${projectId}`);
    return [
      ...(p.buId ? [{ level: "business_unit" as const, subjectId: p.buId, name: p.buName }] : []),
      { level: "project", subjectId: p.id, name: p.name },
    ];
  };
  if (level === "project") return [org, ...(await projectLinks(id!))];
  const [uc] = await db.select({ id: aiUseCases.id, name: aiUseCases.name, projectId: aiUseCases.projectId }).from(aiUseCases).where(eq(aiUseCases.id, id!));
  if (!uc) throw new PolicySubjectNotFound(`no use case ${id}`);
  return [org, ...(uc.projectId ? await projectLinks(uc.projectId) : []), { level: "use_case", subjectId: uc.id, name: uc.name }];
}

const subjectWhere = (level: PolicyLevel, id: string | null) =>
  level === "org"
    ? eq(governancePolicyLayers.level, "org")
    : level === "business_unit"
      ? eq(governancePolicyLayers.businessUnitId, id!)
      : level === "project"
        ? eq(governancePolicyLayers.projectId, id!)
        : eq(governancePolicyLayers.useCaseId, id!);

export async function loadLayer(db: Db, level: PolicyLevel, id: string | null): Promise<GovernancePolicyLayerRow | undefined> {
  return (await db.select().from(governancePolicyLayers).where(subjectWhere(level, id)))[0];
}

async function layersFor(db: Db, chain: readonly ChainLink[]): Promise<PolicyLayerInput[]> {
  const out: PolicyLayerInput[] = [];
  for (const l of chain) {
    const row = await loadLayer(db, l.level, l.subjectId);
    if (row) out.push({ level: l.level, subjectId: l.subjectId, policy: governancePolicySchema.parse(row.policy) });
  }
  return out;
}

/**
 * Whether stored policy is applied to calls yet. ADR-0357 §4 slice 2 stores and resolves layers, but no call path
 * reads them yet: wiring the decision core belongs to the ADR-0251 lane (fragment
 * `2026-11-17-e38-policy-enforcement-pending.md`). Every layer and effective-policy response carries this, so an admin
 * (or an agent) is never told a stored rule is in force when it is not (ADR-0180). The enforcement slice flips it.
 */
export const POLICY_ENFORCEMENT = Object.freeze({
  enforced: false,
  status: "not_enforced",
  reason: "stored and resolved, not yet applied at call time: the decision core does not read the effective policy yet",
} as const);

/**
 * The effective policy at a level: the chain and each rule's merged value. No call path reads this yet
 * (see POLICY_ENFORCEMENT); it is exported for the enforcement slice, which must fail closed when the read is empty.
 */
export async function effectivePolicyAt(db: Db, level: PolicyLevel, id: string | null) {
  const chain = await policyChain(db, level, id);
  return { chain, rules: effectivePolicy(await layersFor(db, chain)) };
}

/** what moving from one effective policy to another loosens, by rule (empty = nothing) */
function effectiveLoosening(before: readonly EffectiveRule[], after: readonly EffectiveRule[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const b of before) {
    if (b.value === null) continue;
    const a = after.find((x) => x.rule === b.rule)!;
    if (a.value === null || ruleLoosens(b.rule, b.value, a.value)) out[b.rule] = a.value;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------------------------------------------

const levelQuery = z
  .object({ level: z.enum(POLICY_LEVELS), id: z.string().uuid().optional() })
  .strict()
  .refine((q) => (q.level === "org") === (q.id === undefined), { message: "the org level takes no id; every other level names its subject" });
const putLayerBody = z
  .object({
    level: z.enum(POLICY_LEVELS),
    id: z.string().uuid().optional(),
    policy: governancePolicySchema,
    /** absent = create (refused if a layer exists); present = compare-and-set on the layer's version */
    expectedVersion: z.number().int().positive().optional(),
  })
  .strict()
  .refine((q) => (q.level === "org") === (q.id === undefined), { message: "the org level takes no id; every other level names its subject" });
const deleteLayerQuery = z
  .object({ level: z.enum(POLICY_LEVELS), id: z.string().uuid().optional(), expectedVersion: z.coerce.number().int().positive() })
  .strict()
  .refine((q) => (q.level === "org") === (q.id === undefined), { message: "the org level takes no id; every other level names its subject" });
const buBody = z.object({ name: z.string().trim().min(1).max(200), description: z.string().max(2000).nullable().optional() }).strict();
const buPatch = z.object({ name: z.string().trim().min(1).max(200).optional(), description: z.string().max(2000).nullable().optional() }).strict();
const buList = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100), after: z.string().uuid().optional() }).strict();
const moveBody = z.object({ businessUnitId: z.string().uuid().nullable() }).strict();

class Refusal extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    readonly body: Record<string, unknown>,
  ) {
    super(String(body.error));
  }
}

export function registerGovernancePolicyRoutes(app: FastifyInstance, db: Db): void {
  const actor = (req: FastifyRequest) => req.authCtx.userId ?? null;
  const audit = (tx: Db, req: FastifyRequest, objectId: string | null, ruleId: string, effect: "allow" | "deny", reason: string, detail: Record<string, unknown>) =>
    tx.insert(auditLog).values({ userId: actor(req) ?? NIL_USER, objectType: "governance_policy", objectId, detail, effect, ruleId, ruleChain: [], reason });

  /** runs `write` in one transaction under the hierarchy lock; a Refusal is answered (and audited) after the rollback */
  async function guarded<T>(req: FastifyRequest, reply: import("fastify").FastifyReply, ruleId: string, write: (tx: Db) => Promise<T>) {
    try {
      return await db.transaction(async (raw) => {
        const tx = raw as unknown as Db;
        await lockHierarchy(tx);
        return write(tx);
      });
    } catch (e) {
      if (e instanceof PolicySubjectNotFound) {
        await reply.status(404).send({ error: "unknown_subject", detail: e.message });
        return undefined;
      }
      if (!(e instanceof Refusal)) throw e;
      await audit(db, req, null, ruleId, "deny", String(e.body.detail ?? e.body.error), { error: e.body.error });
      await reply.status(e.status).send(e.body);
      return undefined;
    }
  }

  // --- business units -------------------------------------------------------------------------------------------

  app.get("/v1/business-units", async (req, reply) => {
    const q = buList.safeParse(req.query);
    if (!q.success) return reply.status(400).send({ error: "invalid_query", issues: q.error.issues });
    const rows = await db
      .select()
      .from(businessUnits)
      .where(q.data.after ? gt(businessUnits.id, q.data.after) : undefined)
      .orderBy(asc(businessUnits.id))
      .limit(q.data.limit + 1);
    const page = rows.slice(0, q.data.limit);
    return { businessUnits: page, next: rows.length > q.data.limit ? page[page.length - 1]!.id : null };
  });

  app.post("/v1/business-units", async (req, reply) => {
    const body = buBody.safeParse(req.body);
    if (!body.success) return reply.status(400).send({ error: "invalid_body", issues: body.error.issues });
    const row = await db.transaction(async (raw) => {
      const tx = raw as unknown as Db;
      const [created] = await tx
        .insert(businessUnits)
        .values({ name: body.data.name, description: body.data.description ?? null, createdBy: actor(req) })
        .onConflictDoNothing()
        .returning();
      if (created) await audit(tx, req, created.id, "business_unit.created", "allow", `business unit '${created.name}' created`, { name: created.name });
      return created;
    });
    if (!row) return reply.status(409).send({ error: "business_unit_exists", detail: "a business unit with this name already exists" });
    return reply.status(201).send(row);
  });

  app.patch("/v1/business-units/:businessUnitId", async (req, reply) => {
    const { businessUnitId } = z.object({ businessUnitId: z.string().uuid() }).parse(req.params);
    const body = buPatch.safeParse(req.body);
    if (!body.success) return reply.status(400).send({ error: "invalid_body", issues: body.error.issues });
    try {
      const row = await db.transaction(async (raw) => {
        const tx = raw as unknown as Db;
        const [updated] = await tx
          .update(businessUnits)
          .set({ ...(body.data.name !== undefined ? { name: body.data.name } : {}), ...(body.data.description !== undefined ? { description: body.data.description } : {}) })
          .where(eq(businessUnits.id, businessUnitId))
          .returning();
        if (updated) await audit(tx, req, updated.id, "business_unit.updated", "allow", `business unit '${updated.name}' updated`, { changed: Object.keys(body.data) });
        return updated;
      });
      if (!row) return reply.status(404).send({ error: "unknown_business_unit" });
      return row;
    } catch (e) {
      if ((e as { code?: string; cause?: { code?: string } }).cause?.code === "23505" || (e as { code?: string }).code === "23505") {
        return reply.status(409).send({ error: "business_unit_exists", detail: "a business unit with this name already exists" });
      }
      throw e;
    }
  });

  /** moving a project re-parents its whole subtree: if the effective policy loosens, it is a relaxation */
  app.put("/v1/projects/:projectId/business-unit", async (req, reply) => {
    const { projectId } = z.object({ projectId: z.string().uuid() }).parse(req.params);
    const body = moveBody.safeParse(req.body);
    if (!body.success) return reply.status(400).send({ error: "invalid_body", issues: body.error.issues });
    const to = body.data.businessUnitId;
    // decided once unlocked (for the step-up), then again under the lock (fail closed on a move)
    const decide = async (q: Db) => {
      const [p] = await q.select({ id: projects.id, buId: projects.businessUnitId }).from(projects).where(eq(projects.id, projectId));
      if (!p) throw new Refusal(404, { error: "unknown_project" });
      if (to !== null && !(await q.select({ id: businessUnits.id }).from(businessUnits).where(eq(businessUnits.id, to))).length) {
        throw new Refusal(404, { error: "unknown_business_unit" });
      }
      const before = effectivePolicy(await layersFor(q, await policyChain(q, "project", projectId)));
      const chainAfter: ChainLink[] = [
        { level: "org", subjectId: null, name: null },
        ...(to !== null ? [{ level: "business_unit" as const, subjectId: to, name: null }] : []),
        { level: "project", subjectId: projectId, name: null },
      ];
      const after = effectivePolicy(await layersFor(q, chainAfter));
      return { from: p.buId, relaxed: effectiveLoosening(before, after) };
    };
    let first: Awaited<ReturnType<typeof decide>>;
    try {
      first = await decide(db);
    } catch (e) {
      if (e instanceof Refusal) return reply.status(e.status).send(e.body);
      throw e;
    }
    if (first.from === to) return { projectId, businessUnitId: to, changed: false };
    if (Object.keys(first.relaxed).length) {
      const su = await requireStepUp(db, req, reply, {
        kind: "settings_relax",
        facts: { op: "project_business_unit", projectId, from: first.from, to, values: first.relaxed },
      });
      if (!su.ok) return reply;
    }
    const out = await guarded(req, reply, "project.business_unit", async (tx) => {
      const now = await decide(tx);
      if (now.from !== first.from || JSON.stringify(now.relaxed) !== JSON.stringify(first.relaxed)) {
        throw new Refusal(409, { error: "changed_concurrently", detail: "the hierarchy changed while this move was decided; try again" });
      }
      await tx.update(projects).set({ businessUnitId: to }).where(eq(projects.id, projectId));
      await audit(tx, req, projectId, "project.business_unit", "allow", `project moved ${first.from ?? "org"} → ${to ?? "org"}`, {
        from: first.from,
        to,
        relaxed: first.relaxed,
      });
      return { projectId, businessUnitId: to, changed: true, relaxed: Object.keys(first.relaxed) };
    });
    return out === undefined ? reply : out;
  });

  // --- layers ---------------------------------------------------------------------------------------------------

  app.get("/v1/governance-policy/layer", async (req, reply) => {
    const q = levelQuery.safeParse(req.query);
    if (!q.success) return reply.status(400).send({ error: "invalid_query", issues: q.error.issues });
    try {
      await policyChain(db, q.data.level, q.data.id ?? null);
    } catch (e) {
      if (e instanceof PolicySubjectNotFound) return reply.status(404).send({ error: "unknown_subject", detail: e.message });
      throw e;
    }
    const row = await loadLayer(db, q.data.level, q.data.id ?? null);
    return {
      level: q.data.level,
      id: q.data.id ?? null,
      layer: row ? { policy: row.policy, version: row.version, updatedAt: row.updatedAt } : null,
      enforcement: POLICY_ENFORCEMENT,
    };
  });

  app.put("/v1/governance-policy/layer", async (req, reply) => {
    const body = putLayerBody.safeParse(req.body);
    if (!body.success) return reply.status(400).send({ error: "invalid_body", issues: body.error.issues });
    const { level, policy, expectedVersion } = body.data;
    const id = body.data.id ?? null;
    // the same decision, unlocked (for the step-up) and again under the lock
    const decide = async (q: Db) => {
      const chain = await policyChain(q, level, id);
      const parent = effectivePolicy(await layersFor(q, chain.slice(0, -1)));
      const widenings = policyWidenings(parent, policy);
      if (widenings.length) {
        throw new Refusal(400, {
          error: "policy_widens_parent",
          detail: `a ${level} layer may narrow what it inherits, never widen it: ${widenings.map((w) => w.rule).join(", ")}`,
          widenings,
        });
      }
      const current = await loadLayer(q, level, id);
      if (current && expectedVersion === undefined) throw new Refusal(409, { error: "layer_exists", detail: "send expectedVersion to change an existing layer", version: current.version });
      if (current && current.version !== expectedVersion) throw new Refusal(409, { error: "version_conflict", version: current.version });
      if (!current && expectedVersion !== undefined) throw new Refusal(409, { error: "version_conflict", version: null });
      return { current, relaxed: layerRelaxations(current ? governancePolicySchema.parse(current.policy) : null, policy) };
    };
    let first: Awaited<ReturnType<typeof decide>>;
    try {
      first = await decide(db);
    } catch (e) {
      if (e instanceof PolicySubjectNotFound) return reply.status(404).send({ error: "unknown_subject", detail: e.message });
      if (!(e instanceof Refusal)) throw e;
      await audit(db, req, id, "governance_policy.layer", "deny", String(e.body.detail ?? e.body.error), { level, error: e.body.error });
      return reply.status(e.status).send(e.body);
    }
    if (Object.keys(first.relaxed).length) {
      const su = await requireStepUp(db, req, reply, { kind: "settings_relax", facts: { op: "governance_policy_layer", level, id, values: first.relaxed } });
      if (!su.ok) return reply;
    }
    const out = await guarded(req, reply, "governance_policy.layer", async (tx) => {
      const now = await decide(tx);
      if (JSON.stringify(now.relaxed) !== JSON.stringify(first.relaxed)) throw new Refusal(409, { error: "changed_concurrently" });
      const subject = { businessUnitId: level === "business_unit" ? id : null, projectId: level === "project" ? id : null, useCaseId: level === "use_case" ? id : null };
      const [row] = now.current
        ? await tx
            .update(governancePolicyLayers)
            .set({ policy, version: now.current.version + 1, updatedBy: actor(req), updatedAt: sql`now()` })
            .where(eq(governancePolicyLayers.id, now.current.id))
            .returning()
        : await tx.insert(governancePolicyLayers).values({ level, ...subject, policy, updatedBy: actor(req) }).returning();
      await audit(tx, req, id, "governance_policy.layer", "allow", `${level} policy layer ${now.current ? "changed" : "created"}`, {
        level,
        version: row!.version,
        before: now.current?.policy ?? null,
        after: policy,
        relaxed: first.relaxed,
      });
      return { level, id, layer: { policy: row!.policy, version: row!.version }, enforcement: POLICY_ENFORCEMENT };
    });
    return out === undefined ? reply : out;
  });

  app.delete("/v1/governance-policy/layer", async (req, reply) => {
    const q = deleteLayerQuery.safeParse(req.query);
    if (!q.success) return reply.status(400).send({ error: "invalid_query", issues: q.error.issues });
    const { level, expectedVersion } = q.data;
    const id = q.data.id ?? null;
    const current = await loadLayer(db, level, id);
    if (!current) return reply.status(404).send({ error: "unknown_layer" });
    if (current.version !== expectedVersion) return reply.status(409).send({ error: "version_conflict", version: current.version });
    // removing a layer drops every rule it sets: a relaxation of each
    const relaxed = layerRelaxations(governancePolicySchema.parse(current.policy) as GovernancePolicy, null);
    if (Object.keys(relaxed).length) {
      const su = await requireStepUp(db, req, reply, { kind: "settings_relax", facts: { op: "governance_policy_layer_delete", level, id, values: relaxed } });
      if (!su.ok) return reply;
    }
    const out = await guarded(req, reply, "governance_policy.layer", async (tx) => {
      const gone = await tx
        .delete(governancePolicyLayers)
        .where(and(eq(governancePolicyLayers.id, current.id), eq(governancePolicyLayers.version, expectedVersion)))
        .returning({ id: governancePolicyLayers.id });
      if (!gone.length) throw new Refusal(409, { error: "changed_concurrently" });
      await audit(tx, req, id, "governance_policy.layer", "allow", `${level} policy layer removed`, { level, version: current.version, before: current.policy, relaxed });
      return { removed: true };
    });
    return out === undefined ? reply : out;
  });

  app.get("/v1/governance-policy/effective", async (req, reply) => {
    const q = levelQuery.safeParse(req.query);
    if (!q.success) return reply.status(400).send({ error: "invalid_query", issues: q.error.issues });
    try {
      const { chain, rules } = await effectivePolicyAt(db, q.data.level, q.data.id ?? null);
      const nameOf = (s: { level: PolicyLevel; subjectId: string | null } | null) => (s ? (chain.find((c) => c.level === s.level)?.name ?? null) : null);
      return {
        level: q.data.level,
        id: q.data.id ?? null,
        chain,
        rules: rules.map((r) => ({ ...r, setBy: r.setBy ? { ...r.setBy, name: nameOf(r.setBy) } : null })),
        enforcement: POLICY_ENFORCEMENT,
      };
    } catch (e) {
      if (e instanceof PolicySubjectNotFound) return reply.status(404).send({ error: "unknown_subject", detail: e.message });
      throw e;
    }
  });
}
