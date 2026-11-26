/**
 * ADR-0341 follow-up (Camunda gap row 10) — the sub-process catalogue: approved, reusable, versioned fragments that
 * builder drafts call by pinned version. Every route is admin-gated by the default route class (none is in
 * NON_ADMIN_ROUTES).
 *
 *   GET  /v1/workflows/fragments                                   the catalogue (approved only; `include=all` for every fragment)
 *   POST /v1/workflows/fragments                                   propose a new fragment {name, description?, stages, reviewerUserId}
 *   GET  /v1/workflows/fragments/:fragmentId                       a fragment and every version with its state
 *   POST /v1/workflows/fragments/:fragmentId/versions              propose its next version {stages, reviewerUserId}
 *   GET  /v1/workflows/fragments/:fragmentId/versions/:version     one version's stages
 *
 * Every version is filed in the one Approvals Queue (kind `workflow_fragment`), decided by the named administrator
 * (never its proposer), and only an approved version is listed or callable. A version's state is the status of that
 * approval row, read through ADR-0348's declared `WORKFLOW_FRAGMENT_VERSION_MACHINE` (rule 12): nothing here writes a
 * state.
 * A new version never changes a caller: callers pin a version, and only a republish of the caller moves the pin.
 */
import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  and,
  approvals,
  auditLog,
  desc,
  eq,
  inArray,
  sql,
  users,
  workflowFragments,
  workflowFragmentVersions,
  workflowTemplateVersionFragments,
  workflowTemplateVersions,
  type Db,
} from "@regulait/db";
import {
  canonicalJson,
  fragmentVersionState,
  FRAGMENT_VERSION_CALLABLE_APPROVAL_STATUS,
  FRAGMENT_VERSION_CALLABLE_STATE,
  sha256Hex,
  type WorkflowFragmentVersionState as FragmentVersionState,
} from "@regulait/shared";
import { collapseCalls, expandCalls, isCallStage, validateFragmentStages, type CallIssue, type ResolvedCall } from "@regulait/workflow-kernel";

/** the approval row's `stage_id` names the version it decides */
export const FRAGMENT_VERSION_PREFIX = "workflow-fragment-version:";

export const FRAGMENT_RULE_IDS = {
  proposed: "workflow-fragment-version-proposed",
  approved: "workflow-fragment-version-approved",
  rejected: "workflow-fragment-version-rejected",
} as const;

const fragmentParam = z.object({ fragmentId: z.string().uuid() });
const versionParam = fragmentParam.extend({ version: z.coerce.number().int().min(1).max(1_000_000) });
const listQuery = z
  .object({
    limit: z.coerce.number().int().refine((n) => n === 10 || n === 50 || n === 100, "limit is 10, 50 or 100").default(50),
    offset: z.coerce.number().int().min(0).max(100_000).default(0),
    include: z.enum(["approved", "all"]).default("approved"),
  })
  .strict();
const proposeVersionBody = z.object({ stages: z.array(z.unknown()).max(1000), reviewerUserId: z.string().uuid() }).strict();
const createBody = proposeVersionBody
  .extend({ name: z.string().trim().min(1).max(100), description: z.string().trim().max(500).optional() })
  .strict();

type Refusal = { status: number; body: Record<string, unknown> };

export function fragmentContentHash(stages: unknown): string {
  return sha256Hex(canonicalJson(stages));
}

const actorOf = (req: FastifyRequest) => req.authCtx.userId ?? null;

/** who may review: an active administrator who is not the proposer (separation of duties, as ADR-0208) */
async function reviewerRefusal(db: Db, actor: string, reviewerUserId: string): Promise<Refusal | null> {
  if (reviewerUserId === actor) {
    return { status: 422, body: { error: "reviewer_is_author", detail: "a sub-process version is reviewed by someone other than its author" } };
  }
  const [r] = await db.select({ isAdmin: users.isAdmin, disabledAt: users.disabledAt }).from(users).where(eq(users.id, reviewerUserId));
  if (!r || r.disabledAt !== null || !r.isAdmin) {
    return { status: 422, body: { error: "reviewer_not_eligible", detail: "the reviewer must be an active administrator" } };
  }
  return null;
}

interface VersionView {
  id: string;
  version: number;
  contentHash: string;
  stageCount: number;
  state: FragmentVersionState;
  proposedBy: string | null;
  createdAt: Date;
  decidedAt: Date | null;
}

/** every version of the given fragments with its state, newest first */
async function versionsOf(db: Db, fragmentIds: string[]): Promise<Map<string, VersionView[]>> {
  const out = new Map<string, VersionView[]>();
  if (fragmentIds.length === 0) return out;
  const rows = await db
    .select({
      fragmentId: workflowFragmentVersions.fragmentId,
      id: workflowFragmentVersions.id,
      version: workflowFragmentVersions.version,
      contentHash: workflowFragmentVersions.contentHash,
      stageCount: sql<number>`jsonb_array_length(${workflowFragmentVersions.stages})`.mapWith(Number),
      proposedBy: workflowFragmentVersions.proposedBy,
      createdAt: workflowFragmentVersions.createdAt,
      approvalStatus: approvals.status,
      decidedAt: approvals.decidedAt,
    })
    .from(workflowFragmentVersions)
    .leftJoin(approvals, eq(approvals.id, workflowFragmentVersions.approvalId))
    .where(inArray(workflowFragmentVersions.fragmentId, fragmentIds))
    .orderBy(desc(workflowFragmentVersions.version));
  for (const r of rows) {
    const { fragmentId, approvalStatus, ...v } = r;
    out.set(fragmentId, [...(out.get(fragmentId) ?? []), { ...v, state: fragmentVersionState(approvalStatus) }]);
  }
  return out;
}

const latestApproved = (vs: readonly VersionView[] | undefined) => vs?.find((v) => v.state === FRAGMENT_VERSION_CALLABLE_STATE) ?? null;

/** the catalogue the template gallery shows: every fragment with an approved version, by name */
export async function approvedFragmentCatalogue(db: Db, limit = 100, offset = 0) {
  const listed = sql`exists (select 1 from ${workflowFragmentVersions} v join ${approvals} a on a.id = v.approval_id
    where v.fragment_id = ${workflowFragments.id} and a.status = ${FRAGMENT_VERSION_CALLABLE_APPROVAL_STATUS})`;
  const rows = await db
    .select()
    .from(workflowFragments)
    .where(listed)
    .orderBy(workflowFragments.name, workflowFragments.id)
    .limit(limit + 1)
    .offset(offset);
  const page = rows.slice(0, limit);
  const versions = await versionsOf(
    db,
    page.map((f) => f.id),
  );
  return {
    items: page.map((f) => {
      const v = latestApproved(versions.get(f.id))!;
      return { id: f.id, name: f.name, description: f.description, version: v.version, contentHash: v.contentHash, stageCount: v.stageCount };
    }),
    nextOffset: rows.length > limit ? offset + limit : null,
  };
}

/**
 * The stages of every approved version a definition's call stages pin, then the expansion (kernel `expandCalls`).
 * A version that is unknown, pending or rejected does not resolve, so the draft is refused with `call_unresolved`.
 */
export async function expandDefinitionCalls(
  db: Db,
  raw: unknown,
): Promise<{ ok: true; definition: unknown; calls: Array<ResolvedCall & { fragmentVersionId: string }> } | { ok: false; issues: CallIssue[] }> {
  const stages = (raw as { stages?: unknown } | null)?.stages;
  if (!Array.isArray(stages) || !stages.some(isCallStage)) return { ok: true, definition: raw, calls: [] };
  const refs = stages
    .filter(isCallStage)
    .map((s) => s as { fragment?: unknown; version?: unknown })
    .filter((s): s is { fragment: string; version: number } => z.string().uuid().safeParse(s.fragment).success && Number.isInteger(s.version));
  const ids = [...new Set(refs.map((r) => r.fragment))];
  const rows = ids.length
    ? await db
        .select({
          id: workflowFragmentVersions.id,
          fragmentId: workflowFragmentVersions.fragmentId,
          version: workflowFragmentVersions.version,
          stages: workflowFragmentVersions.stages,
          approvalStatus: approvals.status,
        })
        .from(workflowFragmentVersions)
        .leftJoin(approvals, eq(approvals.id, workflowFragmentVersions.approvalId))
        .where(inArray(workflowFragmentVersions.fragmentId, ids))
    : [];
  const callable = new Map(
    rows.filter((r) => fragmentVersionState(r.approvalStatus) === FRAGMENT_VERSION_CALLABLE_STATE).map((r) => [`${r.fragmentId}@${r.version}`, r]),
  );
  const expanded = expandCalls(raw, (fragmentId, version) => (callable.get(`${fragmentId}@${version}`)?.stages as Record<string, unknown>[]) ?? null);
  if (!expanded.ok) return expanded;
  return {
    ok: true,
    definition: expanded.definition,
    calls: expanded.calls.map((c) => ({ ...c, fragmentVersionId: callable.get(`${c.fragmentId}@${c.version}`)!.id })),
  };
}

/** the calls a published template version recorded, to collapse its definition back into a draft */
export async function callsOfTemplateVersion(db: Db, templateVersionId: string): Promise<ResolvedCall[]> {
  const rows = await db
    .select({
      callStageId: workflowTemplateVersionFragments.callStageId,
      fragmentId: workflowFragmentVersions.fragmentId,
      version: workflowFragmentVersions.version,
      stages: workflowFragmentVersions.stages,
    })
    .from(workflowTemplateVersionFragments)
    .innerJoin(workflowFragmentVersions, eq(workflowFragmentVersions.id, workflowTemplateVersionFragments.fragmentVersionId))
    .where(eq(workflowTemplateVersionFragments.templateVersionId, templateVersionId));
  return rows.map((r) => ({ ...r, stages: r.stages as Record<string, unknown>[] }));
}

/** one recorded call: the call stage's id and the sub-process version it expanded */
export type TemplateVersionPin = { callStageId: string; fragmentVersionId: string };

/**
 * ADR-0341 §9: every path that writes a template version writes it here, with the sub-process versions its call
 * stages were expanded from (the builder publish, a governance-config apply, a canary rollback, a baseline of a live
 * definition), so no version holds an expansion it has no record of. In the caller's transaction.
 */
export async function insertTemplateVersion(
  tx: Db,
  values: typeof workflowTemplateVersions.$inferInsert,
  pins: ReadonlyArray<TemplateVersionPin>,
): Promise<typeof workflowTemplateVersions.$inferSelect> {
  const [version] = await tx.insert(workflowTemplateVersions).values(values).returning();
  if (pins.length > 0) {
    await tx
      .insert(workflowTemplateVersionFragments)
      .values(pins.map((p) => ({ templateVersionId: version!.id, callStageId: p.callStageId, fragmentVersionId: p.fragmentVersionId })));
  }
  return version!;
}

/** the pins a template version recorded, as insertTemplateVersion takes them (a restore or re-record copies them) */
export async function pinsOfTemplateVersion(db: Pick<Db, "select">, templateVersionId: string): Promise<TemplateVersionPin[]> {
  return db
    .select({ callStageId: workflowTemplateVersionFragments.callStageId, fragmentVersionId: workflowTemplateVersionFragments.fragmentVersionId })
    .from(workflowTemplateVersionFragments)
    .where(eq(workflowTemplateVersionFragments.templateVersionId, templateVersionId))
    .orderBy(workflowTemplateVersionFragments.callStageId);
}

/**
 * Each template's live definition as it was written: collapsed back into the call stages its latest version recorded
 * (a definition with no recorded calls is returned as is). The governance-config export and plan read templates this
 * way, so a file that calls a sub-process compares equal to what it published. Two queries for any number of templates.
 */
export async function liveDefinitionsAsWritten(
  db: Db,
  templates: ReadonlyArray<{ id: string; definition: unknown }>,
): Promise<Map<string, Record<string, unknown>>> {
  const out = new Map(templates.map((t) => [t.id, (t.definition ?? {}) as Record<string, unknown>]));
  if (templates.length === 0) return out;
  const latest = await db
    .selectDistinctOn([workflowTemplateVersions.templateId], { id: workflowTemplateVersions.id, templateId: workflowTemplateVersions.templateId })
    .from(workflowTemplateVersions)
    .where(inArray(workflowTemplateVersions.templateId, templates.map((t) => t.id)))
    .orderBy(workflowTemplateVersions.templateId, desc(workflowTemplateVersions.version));
  if (latest.length === 0) return out;
  const rows = await db
    .select({
      templateVersionId: workflowTemplateVersionFragments.templateVersionId,
      callStageId: workflowTemplateVersionFragments.callStageId,
      fragmentId: workflowFragmentVersions.fragmentId,
      version: workflowFragmentVersions.version,
      stages: workflowFragmentVersions.stages,
    })
    .from(workflowTemplateVersionFragments)
    .innerJoin(workflowFragmentVersions, eq(workflowFragmentVersions.id, workflowTemplateVersionFragments.fragmentVersionId))
    .where(inArray(workflowTemplateVersionFragments.templateVersionId, latest.map((l) => l.id)));
  const templateOf = new Map(latest.map((l) => [l.id, l.templateId]));
  const callsByTemplate = new Map<string, ResolvedCall[]>();
  for (const r of rows) {
    const templateId = templateOf.get(r.templateVersionId)!;
    const list = callsByTemplate.get(templateId) ?? [];
    list.push({ callStageId: r.callStageId, fragmentId: r.fragmentId, version: r.version, stages: r.stages as Record<string, unknown>[] });
    callsByTemplate.set(templateId, list);
  }
  for (const [templateId, calls] of callsByTemplate) {
    const def = out.get(templateId)!;
    if (Array.isArray((def as { stages?: unknown }).stages)) out.set(templateId, collapseCalls(def, calls));
  }
  return out;
}

/** files the version and its approval row, audited, in the caller's transaction */
async function proposeVersion(
  tx: Db,
  input: { fragmentId: string; fragmentName: string; version: number; stages: unknown[]; actor: string; reviewerUserId: string },
) {
  const contentHash = fragmentContentHash(input.stages);
  const versionId = randomUUID();
  const [approval] = await tx
    .insert(approvals)
    .values({ userId: input.actor, objectType: "workflow_fragment", approverUserId: input.reviewerUserId, stageId: `${FRAGMENT_VERSION_PREFIX}${versionId}` })
    .returning({ id: approvals.id });
  const [v] = await tx
    .insert(workflowFragmentVersions)
    .values({ id: versionId, fragmentId: input.fragmentId, version: input.version, stages: input.stages, contentHash, proposedBy: input.actor, approvalId: approval!.id })
    .returning();
  await tx.insert(auditLog).values({
    userId: input.actor,
    objectType: "workflow_fragment",
    objectId: input.fragmentId,
    detail: { phase: "version-proposed", name: input.fragmentName, version: input.version, contentHash, approvalId: approval!.id, reviewerUserId: input.reviewerUserId },
    effect: "allow",
    ruleId: FRAGMENT_RULE_IDS.proposed,
    ruleChain: [],
    reason: `sub-process '${input.fragmentName}' version ${input.version} proposed; it is listed and callable only once its reviewer approves it`,
  });
  return v!;
}

export function registerWorkflowFragmentRoutes(app: FastifyInstance, db: Db): void {
  app.get("/v1/workflows/fragments", async (req) => {
    const q = listQuery.parse(req.query ?? {});
    if (q.include === "approved") return approvedFragmentCatalogue(db, q.limit, q.offset);
    const rows = await db.select().from(workflowFragments).orderBy(workflowFragments.name, workflowFragments.id).limit(q.limit + 1).offset(q.offset);
    const page = rows.slice(0, q.limit);
    const versions = await versionsOf(
      db,
      page.map((f) => f.id),
    );
    return {
      items: page.map((f) => {
        const vs = versions.get(f.id) ?? [];
        const approved = latestApproved(vs);
        return {
          id: f.id,
          name: f.name,
          description: f.description,
          version: approved?.version ?? null,
          contentHash: approved?.contentHash ?? null,
          stageCount: approved?.stageCount ?? null,
          latest: vs[0] ? { version: vs[0].version, state: vs[0].state } : null,
        };
      }),
      nextOffset: rows.length > q.limit ? q.offset + q.limit : null,
    };
  });

  app.post("/v1/workflows/fragments", async (req, reply) => {
    const body = createBody.parse(req.body ?? {});
    const actor = actorOf(req);
    if (!actor) return reply.status(403).send({ error: "identity_required", detail: "a sub-process is proposed by a named administrator" });
    const checked = validateFragmentStages(body.stages);
    if (!checked.ok) return reply.status(422).send({ error: "fragment_invalid", issues: checked.issues });
    const refused = await reviewerRefusal(db, actor, body.reviewerUserId);
    if (refused) return reply.status(refused.status).send(refused.body);
    const [dup] = await db.select({ id: workflowFragments.id }).from(workflowFragments).where(sql`lower(${workflowFragments.name}) = lower(${body.name})`);
    if (dup) return reply.status(409).send({ error: "fragment_name_taken", detail: "a sub-process with this name already exists: propose a new version of it" });
    const out = await db.transaction(async (txRaw) => {
      const tx = txRaw as unknown as Db;
      const [f] = await tx.insert(workflowFragments).values({ name: body.name, description: body.description ?? null, createdBy: actor }).returning();
      const v = await proposeVersion(tx, { fragmentId: f!.id, fragmentName: f!.name, version: 1, stages: checked.stages, actor, reviewerUserId: body.reviewerUserId });
      return { f: f!, v };
    });
    return reply.status(201).send({
      fragment: { id: out.f.id, name: out.f.name, description: out.f.description },
      version: { version: 1, contentHash: out.v.contentHash, state: "pending_approval" satisfies FragmentVersionState, approvalId: out.v.approvalId },
    });
  });

  app.get("/v1/workflows/fragments/:fragmentId", async (req, reply) => {
    const { fragmentId } = fragmentParam.parse(req.params);
    const [f] = await db.select().from(workflowFragments).where(eq(workflowFragments.id, fragmentId));
    if (!f) return reply.status(404).send({ error: "unknown_fragment" });
    const versions = (await versionsOf(db, [f.id])).get(f.id) ?? [];
    return { fragment: { id: f.id, name: f.name, description: f.description, createdAt: f.createdAt }, versions };
  });

  app.post("/v1/workflows/fragments/:fragmentId/versions", async (req, reply) => {
    const { fragmentId } = fragmentParam.parse(req.params);
    const body = proposeVersionBody.parse(req.body ?? {});
    const actor = actorOf(req);
    if (!actor) return reply.status(403).send({ error: "identity_required", detail: "a sub-process is proposed by a named administrator" });
    const checked = validateFragmentStages(body.stages);
    if (!checked.ok) return reply.status(422).send({ error: "fragment_invalid", issues: checked.issues });
    const refused = await reviewerRefusal(db, actor, body.reviewerUserId);
    if (refused) return reply.status(refused.status).send(refused.body);
    const out = await db.transaction(async (txRaw): Promise<Refusal | { version: number; contentHash: string; approvalId: string | null }> => {
      const tx = txRaw as unknown as Db;
      const [f] = await tx.select().from(workflowFragments).where(eq(workflowFragments.id, fragmentId)).for("update");
      if (!f) return { status: 404, body: { error: "unknown_fragment" } };
      const vs = (await versionsOf(tx, [f.id])).get(f.id) ?? [];
      const pending = vs.find((v) => v.state === "pending_approval");
      if (pending) {
        return { status: 409, body: { error: "fragment_version_pending", detail: `version ${pending.version} is waiting for review: decide it before proposing another` } };
      }
      if (vs[0] && vs[0].contentHash === fragmentContentHash(checked.stages)) {
        return { status: 409, body: { error: "no_change", detail: "the proposed stages are the latest version's" } };
      }
      const v = await proposeVersion(tx, { fragmentId, fragmentName: f.name, version: (vs[0]?.version ?? 0) + 1, stages: checked.stages, actor, reviewerUserId: body.reviewerUserId });
      return { version: v.version, contentHash: v.contentHash, approvalId: v.approvalId };
    });
    if ("status" in out) return reply.status(out.status).send(out.body);
    return reply.status(201).send({ version: { ...out, state: "pending_approval" satisfies FragmentVersionState } });
  });

  app.get("/v1/workflows/fragments/:fragmentId/versions/:version", async (req, reply) => {
    const { fragmentId, version } = versionParam.parse(req.params);
    const [row] = await db
      .select({ v: workflowFragmentVersions, approvalStatus: approvals.status, name: workflowFragments.name })
      .from(workflowFragmentVersions)
      .innerJoin(workflowFragments, eq(workflowFragments.id, workflowFragmentVersions.fragmentId))
      .leftJoin(approvals, eq(approvals.id, workflowFragmentVersions.approvalId))
      .where(and(eq(workflowFragmentVersions.fragmentId, fragmentId), eq(workflowFragmentVersions.version, version)));
    if (!row) return reply.status(404).send({ error: "unknown_version" });
    return {
      fragment: { id: fragmentId, name: row.name },
      version: {
        version: row.v.version,
        contentHash: row.v.contentHash,
        stages: row.v.stages,
        state: fragmentVersionState(row.approvalStatus),
        proposedBy: row.v.proposedBy,
        createdAt: row.v.createdAt,
      },
    };
  });
}

// ---- the one decide path's hooks (app.ts) -----------------------------------------------------------------------

function versionIdOf(approval: { stageId: string | null }): string | null {
  return approval.stageId?.startsWith(FRAGMENT_VERSION_PREFIX) ? approval.stageId.slice(FRAGMENT_VERSION_PREFIX.length) : null;
}

/** separation of duties: the proposer of a version never approves it, through delegation or admin override */
export async function precheckFragmentDecision(db: Pick<Db, "select">, approval: { stageId: string | null }, deciderUserId: string): Promise<Refusal | null> {
  const versionId = versionIdOf(approval);
  if (!versionId) return null;
  const [v] = await db.select({ proposedBy: workflowFragmentVersions.proposedBy }).from(workflowFragmentVersions).where(eq(workflowFragmentVersions.id, versionId));
  if (v?.proposedBy === deciderUserId) {
    return {
      status: 403,
      body: { error: "cannot_approve_own_fragment_version", detail: "the decider proposed this sub-process version — approving one's own change is not a review" },
    };
  }
  return null;
}

/** inside the decision's transaction: the state is the approval row itself, so only the audit is written here */
export async function applyFragmentDecision(tx: Db, approval: { id: string; stageId: string | null }, decision: "approved" | "denied", deciderUserId: string): Promise<void> {
  const versionId = versionIdOf(approval);
  if (!versionId) return;
  const [row] = await tx
    .select({ fragmentId: workflowFragmentVersions.fragmentId, version: workflowFragmentVersions.version, contentHash: workflowFragmentVersions.contentHash, name: workflowFragments.name })
    .from(workflowFragmentVersions)
    .innerJoin(workflowFragments, eq(workflowFragments.id, workflowFragmentVersions.fragmentId))
    .where(eq(workflowFragmentVersions.id, versionId));
  if (!row) return;
  const approved = decision === "approved";
  await tx.insert(auditLog).values({
    userId: deciderUserId,
    objectType: "workflow_fragment",
    objectId: row.fragmentId,
    detail: { phase: "version-decision", decision, name: row.name, version: row.version, contentHash: row.contentHash, approvalId: approval.id },
    effect: approved ? "allow" : "deny",
    ruleId: approved ? FRAGMENT_RULE_IDS.approved : FRAGMENT_RULE_IDS.rejected,
    ruleChain: [],
    reason: approved
      ? `sub-process '${row.name}' version ${row.version} approved: it is listed and templates may pin it`
      : `sub-process '${row.name}' version ${row.version} rejected: it is not listed and no template may pin it`,
  });
}
