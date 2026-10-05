/**
 * ADR-0173 batch 2b — THE GOVERNED PROMPT REGISTRY.
 *
 *   GET    /v1/prompts                               prompts the caller may see
 *   POST   /v1/prompts                               create
 *   GET    /v1/prompts/:promptId                     detail: commits, tags, promotions
 *   PATCH  /v1/prompts/:promptId                     rename / describe / share (owner or admin)
 *   DELETE /v1/prompts/:promptId                     archive (owner or admin)
 *   POST   /v1/prompts/:promptId/commits             write a commit (owner or admin)
 *   GET    /v1/prompts/:promptId/commits/:hash       one commit
 *   GET    /v1/prompts/:promptId/diff?from=&to=      diff any two commits
 *   PUT    /v1/prompts/:promptId/tags/:tag           move a tag (owner or admin);
 *                                                    `prod` goes to the approvals queue
 *   GET    /v1/prompts/resolve?ref=name@tag          what a `prompt@tag` reference resolves to
 *
 * Every route is a signed-in person's own work (non-admin, ADR-0172's builder
 * model): visibility is owner / workspace / named people / admins, plus the
 * named approver of one of the prompt's promotions (they must be able to read
 * what they are asked to promote). An identity-less token is refused.
 *
 * PROMOTION TO `prod` (separation of duties). Moving `prod` never moves the
 * tag in the request. It writes a `prompt_promotions` row pinned to the
 * (prompt, tag, commit hash) digest and an ordinary `prompt_promotion` row in
 * the one approvals queue. The approver may not be the commit's author — at
 * request time, and again in the decide path keyed on the DECIDER, so no
 * delegation or admin override reaches a person's own commit. The tag moves
 * only in the decide hook (`applyPromptPromotionDecision`), inside the
 * decision's transaction, and only if the stored binding still matches.
 *
 * Every commit, tag move, promotion request and decision is audited
 * (objectType `prompt`) and emits an outbound webhook event.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { diffLines } from "diff";
import {
  and,
  approvals,
  asc,
  auditLog,
  desc,
  eq,
  inArray,
  isNull,
  or,
  promptCommits,
  promptPromotions,
  promptShares,
  promptTags,
  prompts,
  sql,
  users,
  type Db,
  type PromptCommitRow,
  type PromptPromotionRow,
  type PromptRow,
} from "@regulait/db";
import {
  PROMPT_PROD_TAG,
  extractPromptVariables,
  promptCommitCreateSchema,
  promptCommitHash,
  promptCreateSchema,
  promptPromotionDigest,
  promptTagMoveSchema,
  promptTagNameSchema,
  promptUpdateSchema,
  type PromptCommitContent,
} from "@regulait/shared";
import { assertProjectAttribution } from "./projects.js";
import { enqueueWebhookEvent, kickWebhookDeliveries } from "./outbound-webhooks.js";
import { validateJsonSchemaShape } from "./playground.js";

export const PROMPT_PROMOTION_PREFIX = "__prompt_promotion__:";

export const PROMPT_RULE_IDS = {
  created: "prompt-created",
  updated: "prompt-updated",
  archived: "prompt-archived",
  committed: "prompt-committed",
  tagMoved: "prompt-tag-moved",
  promotionRequested: "prompt-promotion-requested",
  promotionApplied: "prompt-promotion-applied",
  promotionDenied: "prompt-promotion-denied",
  promotionStale: "prompt-promotion-stale",
} as const;

export interface PromptViewer {
  userId: string;
  isAdmin: boolean;
}

function viewerOf(req: FastifyRequest, reply: FastifyReply): PromptViewer | null {
  const userId = req.authCtx.userId;
  if (!userId) {
    void reply.status(403).send({
      error: "prompt_requires_identity",
      detail: "A prompt is a person's own work: a token with no user identity cannot own, edit or promote one.",
    });
    return null;
  }
  return { userId, isAdmin: req.authCtx.isAdmin };
}

/** owner, admins, everyone when shared with the workspace, named people, and
 * the named approver of one of its promotions; never once archived */
export async function canSeePrompt(db: Db, prompt: PromptRow, viewer: PromptViewer): Promise<boolean> {
  if (prompt.archivedAt) return false;
  if (viewer.isAdmin || prompt.ownerUserId === viewer.userId || prompt.visibility === "workspace") return true;
  if (prompt.visibility === "people") {
    const [share] = await db
      .select({ u: promptShares.userId })
      .from(promptShares)
      .where(and(eq(promptShares.promptId, prompt.id), eq(promptShares.userId, viewer.userId)));
    if (share) return true;
  }
  const [approver] = await db
    .select({ id: promptPromotions.id })
    .from(promptPromotions)
    .where(and(eq(promptPromotions.promptId, prompt.id), eq(promptPromotions.approverUserId, viewer.userId)))
    .limit(1);
  return !!approver;
}

export function canEditPrompt(prompt: PromptRow, viewer: PromptViewer): boolean {
  return !prompt.archivedAt && (viewer.isAdmin || prompt.ownerUserId === viewer.userId);
}

/** `null` = unknown OR invisible (a 404 either way, so ids cannot be probed) */
export async function loadVisiblePrompt(db: Db, id: string, viewer: PromptViewer): Promise<PromptRow | null> {
  const [p] = await db.select().from(prompts).where(eq(prompts.id, id));
  if (!p) return null;
  return (await canSeePrompt(db, p, viewer)) ? p : null;
}

async function listVisiblePrompts(db: Db, viewer: PromptViewer): Promise<PromptRow[]> {
  if (viewer.isAdmin) {
    return db.select().from(prompts).where(isNull(prompts.archivedAt)).orderBy(asc(prompts.name));
  }
  const shared = await db.select({ id: promptShares.promptId }).from(promptShares).where(eq(promptShares.userId, viewer.userId));
  const vis = [eq(prompts.ownerUserId, viewer.userId), eq(prompts.visibility, "workspace")];
  if (shared.length) vis.push(and(eq(prompts.visibility, "people"), inArray(prompts.id, shared.map((s) => s.id)))!);
  return db.select().from(prompts).where(and(isNull(prompts.archivedAt), or(...vis))).orderBy(asc(prompts.name));
}

const audit = (
  db: Db,
  userId: string,
  promptId: string,
  ruleId: string,
  reason: string,
  detail: Record<string, unknown>,
  effect: "allow" | "deny" | "require_approval" = "allow",
) => db.insert(auditLog).values({ userId, objectType: "prompt", objectId: promptId, detail, effect, ruleId, ruleChain: [], reason });

const serializeCommit = (c: PromptCommitRow) => ({
  id: c.id,
  hash: c.hash,
  parentHash: c.parentHash,
  template: c.template,
  modelConfig: c.modelConfig,
  variables: c.variables,
  outputSchema: c.outputSchema,
  tools: c.tools,
  authorUserId: c.authorUserId,
  message: c.message,
  createdAt: c.createdAt.toISOString(),
});

const serializePromotion = (p: PromptPromotionRow) => ({
  id: p.id,
  tag: p.tag,
  commitHash: p.commitHash,
  previousCommitHash: p.previousCommitHash,
  status: p.status,
  approvalId: p.approvalId,
  requestedByUserId: p.requestedByUserId,
  approverUserId: p.approverUserId,
  decidedByUserId: p.decidedByUserId,
  decidedAt: p.decidedAt?.toISOString() ?? null,
  result: p.result,
  createdAt: p.createdAt.toISOString(),
});

async function tagsOf(db: Db, promptIds: string[]) {
  if (!promptIds.length) return [];
  return db
    .select({
      promptId: promptTags.promptId,
      name: promptTags.name,
      commitHash: promptCommits.hash,
      movedByUserId: promptTags.movedByUserId,
      movedAt: promptTags.movedAt,
    })
    .from(promptTags)
    .innerJoin(promptCommits, eq(promptCommits.id, promptTags.commitId))
    .where(inArray(promptTags.promptId, promptIds))
    .orderBy(asc(promptTags.name));
}

async function names(db: Db, ids: Array<string | null | undefined>): Promise<Map<string, string>> {
  const uniq = [...new Set(ids.filter((x): x is string => !!x))];
  if (!uniq.length) return new Map();
  const rows = await db.select({ id: users.id, displayName: users.displayName, email: users.email }).from(users).where(inArray(users.id, uniq));
  return new Map(rows.map((r) => [r.id, r.displayName || r.email]));
}

/** the content's hash input, as stored */
function hashOf(content: PromptCommitContent, parent: string | null): string {
  return promptCommitHash({
    template: content.template,
    modelConfig: content.modelConfig,
    variables: extractPromptVariables(content.template),
    outputSchema: content.outputSchema,
    tools: content.tools,
    parent,
  });
}

// ---------------------------------------------------------------------------
// diff
// ---------------------------------------------------------------------------

export function diffPromptCommits(from: PromptCommitRow, to: PromptCommitRow) {
  const stable = (v: unknown) => JSON.stringify(v ?? null);
  const fromTools = new Map(from.tools.map((t) => [t.name, stable(t)]));
  const toTools = new Map(to.tools.map((t) => [t.name, stable(t)]));
  return {
    from: from.hash,
    to: to.hash,
    template: diffLines(from.template, to.template).map((p) => ({
      op: p.added ? ("add" as const) : p.removed ? ("remove" as const) : ("same" as const),
      text: p.value,
    })),
    variables: {
      added: to.variables.filter((v) => !from.variables.includes(v)),
      removed: from.variables.filter((v) => !to.variables.includes(v)),
    },
    modelConfig: stable(from.modelConfig) === stable(to.modelConfig) ? null : { from: from.modelConfig, to: to.modelConfig },
    outputSchema: stable(from.outputSchema) === stable(to.outputSchema) ? null : { from: from.outputSchema, to: to.outputSchema },
    tools: {
      added: [...toTools.keys()].filter((n) => !fromTools.has(n)),
      removed: [...fromTools.keys()].filter((n) => !toTools.has(n)),
      changed: [...toTools.keys()].filter((n) => fromTools.has(n) && fromTools.get(n) !== toTools.get(n)),
    },
  };
}

// ---------------------------------------------------------------------------
// `prompt@tag` — the interface a builder agent's instructions can follow
// ---------------------------------------------------------------------------

/**
 * Resolve `name@tag` (or `name@<commit hash>`) for a viewer: the commit the
 * reference points at now, or null when the prompt is not visible to them,
 * the tag does not exist, or the reference is malformed. A builder agent that
 * links its instructions to `prompt@prod` calls this at run time AS THE
 * PERSON THE TURN RUNS AS, so a prompt they may not see is never read.
 */
export async function resolvePromptRef(
  db: Db,
  viewer: PromptViewer,
  ref: string,
): Promise<{ prompt: PromptRow; commit: PromptCommitRow; tag: string | null } | null> {
  const at = ref.lastIndexOf("@");
  if (at <= 0 || at === ref.length - 1) return null;
  const name = ref.slice(0, at).trim();
  const target = ref.slice(at + 1).trim();
  const [p] = await db
    .select()
    .from(prompts)
    .where(and(isNull(prompts.archivedAt), sql`lower(${prompts.name}) = lower(${name})`));
  if (!p || !(await canSeePrompt(db, p, viewer))) return null;
  if (/^[0-9a-f]{64}$/.test(target)) {
    const [c] = await db.select().from(promptCommits).where(and(eq(promptCommits.promptId, p.id), eq(promptCommits.hash, target)));
    return c ? { prompt: p, commit: c, tag: null } : null;
  }
  if (!promptTagNameSchema.safeParse(target).success) return null;
  const [t] = await db
    .select({ commit: promptCommits })
    .from(promptTags)
    .innerJoin(promptCommits, eq(promptCommits.id, promptTags.commitId))
    .where(and(eq(promptTags.promptId, p.id), eq(promptTags.name, target)));
  return t ? { prompt: p, commit: t.commit, tag: target } : null;
}

// ---------------------------------------------------------------------------
// the decide path's two hooks (called from app.ts decideOneApproval)
// ---------------------------------------------------------------------------

/** separation of duties keyed on the DECIDER: the commit's author never decides its promotion */
export async function precheckPromptPromotionDecision(
  db: Db,
  approval: { id: string },
  deciderUserId: string,
): Promise<{ status: number; body: Record<string, unknown> } | null> {
  const [row] = await db
    .select({ authorUserId: promptCommits.authorUserId })
    .from(promptPromotions)
    .innerJoin(promptCommits, eq(promptCommits.id, promptPromotions.commitId))
    .where(eq(promptPromotions.approvalId, approval.id));
  if (row && row.authorUserId === deciderUserId) {
    return {
      status: 403,
      body: {
        error: "cannot_approve_own_prompt_commit",
        detail:
          "the decider wrote the commit this promotion would put in prod — promoting one's own change is not a review; " +
          "another approver must decide it",
      },
    };
  }
  return null;
}

/**
 * Runs inside the decision's transaction. Approved: the tag moves to the
 * promoted commit ONLY if the promotion's stored binding still equals the
 * digest of (prompt, tag, commit hash) AND the approval row's own digest, the
 * commit is still that prompt's commit with that hash, the prompt is not
 * archived, and the tag still points where it did when promotion was
 * requested. Anything else records the promotion `stale` and moves nothing.
 * Denied: nothing moves. Returns the post-commit step (the webhook kick).
 */
export async function applyPromptPromotionDecision(
  tx: Db,
  approval: { id: string; argumentsDigest: string | null },
  decision: "approved" | "denied",
  deciderUserId: string,
  dataKey: string | undefined,
): Promise<((d: Db) => Promise<void>) | null> {
  const [p] = await tx.select().from(promptPromotions).where(eq(promptPromotions.approvalId, approval.id)).for("update");
  if (!p || p.status !== "pending_approval") return null;
  const [prompt] = await tx.select().from(prompts).where(eq(prompts.id, p.promptId));
  const now = new Date();
  const finish = async (status: "applied" | "denied" | "stale", result: Record<string, unknown>) => {
    await tx
      .update(promptPromotions)
      .set({ status, result, decidedByUserId: deciderUserId, decidedAt: now })
      .where(eq(promptPromotions.id, p.id));
    const ruleId =
      status === "applied" ? PROMPT_RULE_IDS.promotionApplied : status === "denied" ? PROMPT_RULE_IDS.promotionDenied : PROMPT_RULE_IDS.promotionStale;
    await audit(
      tx,
      deciderUserId,
      p.promptId,
      ruleId,
      status === "applied"
        ? `prompt '${prompt?.name ?? p.promptId}' tag '${p.tag}' promoted to ${p.commitHash.slice(0, 12)} by approval`
        : status === "denied"
          ? `promotion of prompt '${prompt?.name ?? p.promptId}' to '${p.tag}' denied; the tag did not move`
          : `promotion of prompt '${prompt?.name ?? p.promptId}' to '${p.tag}' approved but stale (${String(result.reason)}); the tag did not move`,
      { promotionId: p.id, approvalId: approval.id, tag: p.tag, commitHash: p.commitHash, previousCommitHash: p.previousCommitHash, ...result },
      status === "applied" ? "allow" : "deny",
    );
    return status;
  };

  let outcome: "applied" | "denied" | "stale";
  if (decision === "denied") {
    outcome = await finish("denied", {});
  } else {
    const expected = promptPromotionDigest({ promptId: p.promptId, tag: p.tag, commitHash: p.commitHash });
    const [commit] = await tx.select().from(promptCommits).where(eq(promptCommits.id, p.commitId));
    const [current] = await tx
      .select({ hash: promptCommits.hash })
      .from(promptTags)
      .innerJoin(promptCommits, eq(promptCommits.id, promptTags.commitId))
      .where(and(eq(promptTags.promptId, p.promptId), eq(promptTags.name, p.tag)));
    const reason =
      p.bindingDigest !== expected || approval.argumentsDigest !== expected
        ? "binding_mismatch"
        : !commit || commit.promptId !== p.promptId || commit.hash !== p.commitHash
          ? "commit_changed"
          : !prompt || prompt.archivedAt
            ? "prompt_archived"
            : (current?.hash ?? null) !== p.previousCommitHash
              ? "tag_moved_since_request"
              : null;
    if (reason) {
      outcome = await finish("stale", { reason });
    } else {
      await tx
        .insert(promptTags)
        .values({ promptId: p.promptId, name: p.tag, commitId: commit!.id, movedByUserId: deciderUserId, movedAt: now })
        .onConflictDoUpdate({
          target: [promptTags.promptId, promptTags.name],
          set: { commitId: commit!.id, movedByUserId: deciderUserId, movedAt: now },
        });
      outcome = await finish("applied", {});
    }
  }
  const ids = await enqueueWebhookEvent(tx, "prompt.promotion.decided", {
    promptId: p.promptId,
    promptName: prompt?.name,
    tag: p.tag,
    commitHash: p.commitHash,
    approvalId: approval.id,
    decision,
    outcome,
    decidedByUserId: deciderUserId,
  });
  if (outcome === "applied") {
    ids.push(
      ...(await enqueueWebhookEvent(tx, "prompt.tag.moved", {
        promptId: p.promptId,
        promptName: prompt?.name,
        tag: p.tag,
        commitHash: p.commitHash,
        previousCommitHash: p.previousCommitHash,
        movedByUserId: deciderUserId,
        approvalId: approval.id,
      })),
    );
  }
  return async (d: Db) => kickWebhookDeliveries(d, dataKey, ids);
}

// ---------------------------------------------------------------------------
// routes
// ---------------------------------------------------------------------------

const idParam = z.object({ promptId: z.string().uuid() });
const hashParam = z.object({ promptId: z.string().uuid(), hash: z.string().regex(/^[0-9a-f]{64}$/) });
const tagParam = z.object({ promptId: z.string().uuid(), tag: promptTagNameSchema });

export function registerPromptRegistryRoutes(app: FastifyInstance, db: Db, opts: { dataKey?: string | undefined } = {}): void {
  const kick = (ids: string[]) => kickWebhookDeliveries(db, opts.dataKey, ids, app.log);

  async function projectRefusal(viewer: PromptViewer, projectId: string | null) {
    if (!projectId) return null;
    const r = await assertProjectAttribution(db, projectId, viewer.userId, viewer.isAdmin);
    return r.ok ? null : { status: r.status, body: { error: r.error, field: "projectId" } };
  }

  async function sharedUsersRefusal(ids: string[]) {
    if (!ids.length) return null;
    const found = await db.select({ id: users.id }).from(users).where(inArray(users.id, ids));
    return found.length === new Set(ids).size ? null : { status: 422, body: { error: "unknown_user", field: "sharedUserIds" } };
  }

  async function detail(prompt: PromptRow, viewer: PromptViewer) {
    const [commits, tags, promotions, shares] = await Promise.all([
      db.select().from(promptCommits).where(eq(promptCommits.promptId, prompt.id)).orderBy(desc(promptCommits.createdAt)),
      tagsOf(db, [prompt.id]),
      db.select().from(promptPromotions).where(eq(promptPromotions.promptId, prompt.id)).orderBy(desc(promptPromotions.createdAt)).limit(50),
      db.select({ userId: promptShares.userId }).from(promptShares).where(eq(promptShares.promptId, prompt.id)),
    ]);
    const nameOf = await names(db, [
      prompt.ownerUserId,
      ...commits.map((c) => c.authorUserId),
      ...tags.map((t) => t.movedByUserId),
      ...promotions.flatMap((p) => [p.requestedByUserId, p.approverUserId, p.decidedByUserId]),
      ...shares.map((s) => s.userId),
    ]);
    return {
      prompt: {
        id: prompt.id,
        name: prompt.name,
        description: prompt.description,
        ownerUserId: prompt.ownerUserId,
        ownerName: nameOf.get(prompt.ownerUserId) ?? null,
        visibility: prompt.visibility,
        projectId: prompt.projectId,
        sharedUsers: shares.map((s) => ({ id: s.userId, name: nameOf.get(s.userId) ?? null })),
        createdAt: prompt.createdAt.toISOString(),
        updatedAt: prompt.updatedAt.toISOString(),
        canEdit: canEditPrompt(prompt, viewer),
      },
      commits: commits.map((c) => ({ ...serializeCommit(c), authorName: nameOf.get(c.authorUserId) ?? null })),
      tags: tags.map((t) => ({
        name: t.name,
        commitHash: t.commitHash,
        movedByUserId: t.movedByUserId,
        movedByName: t.movedByUserId ? (nameOf.get(t.movedByUserId) ?? null) : null,
        movedAt: t.movedAt.toISOString(),
      })),
      promotions: promotions.map((p) => ({
        ...serializePromotion(p),
        requestedByName: nameOf.get(p.requestedByUserId) ?? null,
        approverName: nameOf.get(p.approverUserId) ?? null,
        decidedByName: p.decidedByUserId ? (nameOf.get(p.decidedByUserId) ?? null) : null,
      })),
    };
  }

  app.get("/v1/prompts", async (req, reply) => {
    const viewer = viewerOf(req, reply);
    if (!viewer) return;
    const rows = await listVisiblePrompts(db, viewer);
    const ids = rows.map((r) => r.id);
    const [tags, heads] = await Promise.all([
      tagsOf(db, ids),
      ids.length
        ? db
            .selectDistinctOn([promptCommits.promptId], {
              promptId: promptCommits.promptId,
              hash: promptCommits.hash,
              createdAt: promptCommits.createdAt,
            })
            .from(promptCommits)
            .where(inArray(promptCommits.promptId, ids))
            .orderBy(promptCommits.promptId, desc(promptCommits.createdAt))
        : Promise.resolve([]),
    ]);
    const nameOf = await names(db, rows.map((r) => r.ownerUserId));
    return {
      prompts: rows.map((r) => {
        const head = heads.find((h) => h.promptId === r.id);
        return {
          id: r.id,
          name: r.name,
          description: r.description,
          visibility: r.visibility,
          ownerUserId: r.ownerUserId,
          ownerName: nameOf.get(r.ownerUserId) ?? null,
          projectId: r.projectId,
          latestCommitHash: head?.hash ?? null,
          latestCommitAt: head?.createdAt.toISOString() ?? null,
          tags: tags.filter((t) => t.promptId === r.id).map((t) => ({ name: t.name, commitHash: t.commitHash })),
          canEdit: canEditPrompt(r, viewer),
          updatedAt: r.updatedAt.toISOString(),
        };
      }),
    };
  });

  app.get("/v1/prompts/resolve", async (req, reply) => {
    const viewer = viewerOf(req, reply);
    if (!viewer) return;
    const q = z.object({ ref: z.string().min(3).max(200) }).parse(req.query);
    const r = await resolvePromptRef(db, viewer, q.ref);
    if (!r) return reply.status(404).send({ error: "unknown_prompt_ref" });
    return { promptId: r.prompt.id, promptName: r.prompt.name, tag: r.tag, commit: serializeCommit(r.commit) };
  });

  app.post("/v1/prompts", async (req, reply) => {
    const viewer = viewerOf(req, reply);
    if (!viewer) return;
    const body = promptCreateSchema.parse(req.body ?? {});
    const refused = (await projectRefusal(viewer, body.projectId)) ?? (await sharedUsersRefusal(body.sharedUserIds));
    if (refused) return reply.status(refused.status).send(refused.body);
    const created = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(prompts)
        .values({ name: body.name, description: body.description, ownerUserId: viewer.userId, visibility: body.visibility, projectId: body.projectId })
        .onConflictDoNothing()
        .returning();
      if (!row) return null;
      const share = [...new Set(body.sharedUserIds)].filter((u) => u !== viewer.userId);
      if (share.length) await tx.insert(promptShares).values(share.map((userId) => ({ promptId: row.id, userId })));
      await audit(tx as unknown as Db, viewer.userId, row.id, PROMPT_RULE_IDS.created, `prompt '${row.name}' created`,
        { name: row.name, visibility: row.visibility, projectId: row.projectId, sharedUserIds: share });
      return row;
    });
    if (!created) return reply.status(409).send({ error: "duplicate_name", detail: `a prompt named '${body.name}' already exists` });
    return reply.status(201).send(await detail(created, viewer));
  });

  app.get("/v1/prompts/:promptId", async (req, reply) => {
    const viewer = viewerOf(req, reply);
    if (!viewer) return;
    const { promptId } = idParam.parse(req.params);
    const p = await loadVisiblePrompt(db, promptId, viewer);
    if (!p) return reply.status(404).send({ error: "unknown_prompt" });
    return detail(p, viewer);
  });

  app.patch("/v1/prompts/:promptId", async (req, reply) => {
    const viewer = viewerOf(req, reply);
    if (!viewer) return;
    const { promptId } = idParam.parse(req.params);
    const body = promptUpdateSchema.parse(req.body ?? {});
    const p = await loadVisiblePrompt(db, promptId, viewer);
    if (!p) return reply.status(404).send({ error: "unknown_prompt" });
    if (!canEditPrompt(p, viewer)) return reply.status(403).send({ error: "not_prompt_owner" });
    const refused =
      (body.projectId !== undefined && body.projectId !== p.projectId ? await projectRefusal(viewer, body.projectId) : null) ??
      (body.sharedUserIds ? await sharedUsersRefusal(body.sharedUserIds) : null);
    if (refused) return reply.status(refused.status).send(refused.body);
    if (body.name && body.name.toLowerCase() !== p.name.toLowerCase()) {
      const [clash] = await db.select({ id: prompts.id }).from(prompts).where(and(isNull(prompts.archivedAt), sql`lower(${prompts.name}) = lower(${body.name})`));
      if (clash) return reply.status(409).send({ error: "duplicate_name", detail: `a prompt named '${body.name}' already exists` });
    }
    const updated = await db.transaction(async (tx) => {
      const [row] = await tx
        .update(prompts)
        .set({
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.description !== undefined ? { description: body.description } : {}),
          ...(body.visibility !== undefined ? { visibility: body.visibility } : {}),
          ...(body.projectId !== undefined ? { projectId: body.projectId } : {}),
          updatedAt: new Date(),
        })
        .where(eq(prompts.id, p.id))
        .returning();
      if (body.sharedUserIds !== undefined) {
        await tx.delete(promptShares).where(eq(promptShares.promptId, p.id));
        const share = [...new Set(body.sharedUserIds)].filter((u) => u !== p.ownerUserId);
        if (share.length) await tx.insert(promptShares).values(share.map((userId) => ({ promptId: p.id, userId })));
      }
      await audit(tx as unknown as Db, viewer.userId, p.id, PROMPT_RULE_IDS.updated, `prompt '${row!.name}' updated (${Object.keys(body).join(", ") || "no change"})`,
        { fields: Object.keys(body), visibility: row!.visibility, ...(body.sharedUserIds ? { sharedUserIds: body.sharedUserIds } : {}) });
      return row!;
    });
    return detail(updated, viewer);
  });

  app.delete("/v1/prompts/:promptId", async (req, reply) => {
    const viewer = viewerOf(req, reply);
    if (!viewer) return;
    const { promptId } = idParam.parse(req.params);
    const p = await loadVisiblePrompt(db, promptId, viewer);
    if (!p) return reply.status(404).send({ error: "unknown_prompt" });
    if (!canEditPrompt(p, viewer)) return reply.status(403).send({ error: "not_prompt_owner" });
    const [pending] = await db
      .select({ id: promptPromotions.id })
      .from(promptPromotions)
      .where(and(eq(promptPromotions.promptId, p.id), eq(promptPromotions.status, "pending_approval")));
    if (pending) {
      return reply.status(409).send({ error: "promotion_pending", detail: "a promotion of this prompt is waiting on the approvals queue; decide it first" });
    }
    await db.update(prompts).set({ archivedAt: new Date(), updatedAt: new Date() }).where(eq(prompts.id, p.id));
    await audit(db, viewer.userId, p.id, PROMPT_RULE_IDS.archived, `prompt '${p.name}' archived`, { name: p.name });
    return { archived: true, id: p.id };
  });

  app.post("/v1/prompts/:promptId/commits", async (req, reply) => {
    const viewer = viewerOf(req, reply);
    if (!viewer) return;
    const { promptId } = idParam.parse(req.params);
    const body = promptCommitCreateSchema.parse(req.body ?? {});
    const p = await loadVisiblePrompt(db, promptId, viewer);
    if (!p) return reply.status(404).send({ error: "unknown_prompt" });
    if (!canEditPrompt(p, viewer)) return reply.status(403).send({ error: "not_prompt_owner" });
    const schemaErrors = [
      ...(body.outputSchema ? validateJsonSchemaShape(body.outputSchema).map((e) => `outputSchema: ${e}`) : []),
      ...body.tools.flatMap((t) => validateJsonSchemaShape(t.inputSchema).map((e) => `tools.${t.name}.inputSchema: ${e}`)),
    ];
    if (schemaErrors.length) return reply.status(422).send({ error: "invalid_json_schema", detail: schemaErrors.join("; ") });
    const variables = extractPromptVariables(body.template);
    const result = await db.transaction(async (tx) => {
      // serialize commits per prompt so "first commit" and the parent check cannot race
      await tx.select({ id: prompts.id }).from(prompts).where(eq(prompts.id, p.id)).for("update");
      const [any] = await tx.select({ id: promptCommits.id }).from(promptCommits).where(eq(promptCommits.promptId, p.id)).limit(1);
      if (body.parentHash === null && any) return { refusal: { status: 409, body: { error: "parent_required", detail: "this prompt has commits; name the commit you edited (parentHash)" } } };
      if (body.parentHash !== null) {
        const [parent] = await tx.select({ id: promptCommits.id }).from(promptCommits).where(and(eq(promptCommits.promptId, p.id), eq(promptCommits.hash, body.parentHash)));
        if (!parent) return { refusal: { status: 422, body: { error: "unknown_parent", field: "parentHash" } } };
      }
      const hash = hashOf(body, body.parentHash);
      const [row] = await tx
        .insert(promptCommits)
        .values({
          promptId: p.id,
          hash,
          parentHash: body.parentHash,
          template: body.template,
          modelConfig: body.modelConfig,
          variables,
          outputSchema: body.outputSchema,
          tools: body.tools,
          authorUserId: viewer.userId,
          message: body.message,
        })
        .onConflictDoNothing()
        .returning();
      if (!row) return { refusal: { status: 409, body: { error: "identical_commit", detail: "a commit with exactly this content and parent already exists", hash } } };
      await tx.update(prompts).set({ updatedAt: new Date() }).where(eq(prompts.id, p.id));
      await audit(tx as unknown as Db, viewer.userId, p.id, PROMPT_RULE_IDS.committed, `prompt '${p.name}' commit ${hash.slice(0, 12)}: ${body.message}`.slice(0, 1000),
        { hash, parentHash: body.parentHash, variables, tools: body.tools.map((t) => t.name), modelAgentId: body.modelConfig.agentId });
      const ids = await enqueueWebhookEvent(tx as unknown as Db, "prompt.commit", {
        promptId: p.id,
        promptName: p.name,
        commitHash: hash,
        parentHash: body.parentHash,
        authorUserId: viewer.userId,
      });
      return { row, ids };
    });
    if ("refusal" in result) return reply.status(result.refusal!.status).send(result.refusal!.body);
    kick(result.ids);
    return reply.status(201).send(serializeCommit(result.row));
  });

  app.get("/v1/prompts/:promptId/commits/:hash", async (req, reply) => {
    const viewer = viewerOf(req, reply);
    if (!viewer) return;
    const { promptId, hash } = hashParam.parse(req.params);
    const p = await loadVisiblePrompt(db, promptId, viewer);
    if (!p) return reply.status(404).send({ error: "unknown_prompt" });
    const [c] = await db.select().from(promptCommits).where(and(eq(promptCommits.promptId, p.id), eq(promptCommits.hash, hash)));
    if (!c) return reply.status(404).send({ error: "unknown_commit" });
    return serializeCommit(c);
  });

  app.get("/v1/prompts/:promptId/diff", async (req, reply) => {
    const viewer = viewerOf(req, reply);
    if (!viewer) return;
    const { promptId } = idParam.parse(req.params);
    const q = z.object({ from: z.string().regex(/^[0-9a-f]{64}$/), to: z.string().regex(/^[0-9a-f]{64}$/) }).parse(req.query);
    const p = await loadVisiblePrompt(db, promptId, viewer);
    if (!p) return reply.status(404).send({ error: "unknown_prompt" });
    const rows = await db.select().from(promptCommits).where(and(eq(promptCommits.promptId, p.id), inArray(promptCommits.hash, [q.from, q.to])));
    const from = rows.find((r) => r.hash === q.from);
    const to = rows.find((r) => r.hash === q.to);
    if (!from || !to) return reply.status(404).send({ error: "unknown_commit" });
    return diffPromptCommits(from, to);
  });

  app.put("/v1/prompts/:promptId/tags/:tag", async (req, reply) => {
    const viewer = viewerOf(req, reply);
    if (!viewer) return;
    const { promptId, tag } = tagParam.parse(req.params);
    const body = promptTagMoveSchema.parse(req.body ?? {});
    const p = await loadVisiblePrompt(db, promptId, viewer);
    if (!p) return reply.status(404).send({ error: "unknown_prompt" });
    if (!canEditPrompt(p, viewer)) return reply.status(403).send({ error: "not_prompt_owner", detail: "tags are moved by the prompt's owner or an admin" });
    const [commit] = await db.select().from(promptCommits).where(and(eq(promptCommits.promptId, p.id), eq(promptCommits.hash, body.commitHash)));
    if (!commit) return reply.status(422).send({ error: "unknown_commit", field: "commitHash" });
    const [current] = await db
      .select({ hash: promptCommits.hash })
      .from(promptTags)
      .innerJoin(promptCommits, eq(promptCommits.id, promptTags.commitId))
      .where(and(eq(promptTags.promptId, p.id), eq(promptTags.name, tag)));
    if (current?.hash === commit.hash) return reply.status(409).send({ error: "already_at_commit", detail: `'${tag}' already points at this commit` });

    if (tag !== PROMPT_PROD_TAG) {
      // every other tag moves directly, by the owner or an admin
      if (body.approverUserId) return reply.status(422).send({ error: "approver_only_for_prod", detail: "only moving prod goes through approval" });
      const now = new Date();
      const ids = await db.transaction(async (tx) => {
        await tx
          .insert(promptTags)
          .values({ promptId: p.id, name: tag, commitId: commit.id, movedByUserId: viewer.userId, movedAt: now })
          .onConflictDoUpdate({ target: [promptTags.promptId, promptTags.name], set: { commitId: commit.id, movedByUserId: viewer.userId, movedAt: now } });
        await audit(tx as unknown as Db, viewer.userId, p.id, PROMPT_RULE_IDS.tagMoved,
          `prompt '${p.name}' tag '${tag}' moved to ${commit.hash.slice(0, 12)}`,
          { tag, commitHash: commit.hash, previousCommitHash: current?.hash ?? null });
        return enqueueWebhookEvent(tx as unknown as Db, "prompt.tag.moved", {
          promptId: p.id,
          promptName: p.name,
          tag,
          commitHash: commit.hash,
          previousCommitHash: current?.hash ?? null,
          movedByUserId: viewer.userId,
        });
      });
      kick(ids);
      return { moved: true, tag, commitHash: commit.hash, previousCommitHash: current?.hash ?? null };
    }

    // prod: the approvals queue, with separation of duties
    if (!body.approverUserId) {
      return reply.status(422).send({ error: "approver_required", detail: "moving prod needs an approver who did not write the commit" });
    }
    if (body.approverUserId === commit.authorUserId) {
      return reply.status(409).send({ error: "approver_is_author", detail: "the approver may not be the commit's author; name someone else" });
    }
    if (body.approverUserId === viewer.userId) {
      return reply.status(409).send({ error: "approver_is_requester", detail: "name an approver other than yourself" });
    }
    const [approver] = await db.select({ id: users.id }).from(users).where(and(eq(users.id, body.approverUserId), isNull(users.disabledAt)));
    if (!approver) return reply.status(422).send({ error: "unknown_approver", field: "approverUserId" });
    const binding = promptPromotionDigest({ promptId: p.id, tag, commitHash: commit.hash });
    const created = await db.transaction(async (tx) => {
      const [promo] = await tx
        .insert(promptPromotions)
        .values({
          promptId: p.id,
          tag,
          commitId: commit.id,
          commitHash: commit.hash,
          previousCommitHash: current?.hash ?? null,
          bindingDigest: binding,
          requestedByUserId: viewer.userId,
          approverUserId: body.approverUserId!,
        })
        .onConflictDoNothing()
        .returning();
      if (!promo) return null;
      const [approval] = await tx
        .insert(approvals)
        .values({
          userId: viewer.userId,
          objectType: "prompt_promotion",
          approverUserId: body.approverUserId!,
          stageId: `${PROMPT_PROMOTION_PREFIX}${promo.id}`,
          // what the queue shows as the row's label
          toolName: `${p.name} → ${tag} @ ${commit.hash.slice(0, 12)}`,
          argumentsDigest: binding,
          argumentsPreview: {
            prompt: p.name,
            tag,
            commitHash: commit.hash,
            previousCommitHash: current?.hash ?? null,
            commitMessage: commit.message,
            authorUserId: commit.authorUserId,
          },
          argumentsPreviewKind: "arguments_v1",
          approvalScope: "action",
        })
        .returning({ id: approvals.id });
      const [updated] = await tx.update(promptPromotions).set({ approvalId: approval!.id }).where(eq(promptPromotions.id, promo.id)).returning();
      await audit(tx as unknown as Db, viewer.userId, p.id, PROMPT_RULE_IDS.promotionRequested,
        `promotion of prompt '${p.name}' to '${tag}' at ${commit.hash.slice(0, 12)} sent for approval`,
        { promotionId: promo.id, approvalId: approval!.id, tag, commitHash: commit.hash, previousCommitHash: current?.hash ?? null, approverUserId: body.approverUserId, bindingDigest: binding },
        "require_approval");
      const ids = await enqueueWebhookEvent(tx as unknown as Db, "prompt.promotion.requested", {
        promptId: p.id,
        promptName: p.name,
        tag,
        commitHash: commit.hash,
        approvalId: approval!.id,
        requestedByUserId: viewer.userId,
        approverUserId: body.approverUserId,
      });
      return { promotion: updated!, ids };
    });
    if (!created) return reply.status(409).send({ error: "promotion_pending", detail: `a promotion to '${tag}' is already waiting on the approvals queue` });
    kick(created.ids);
    return reply.status(202).send({ moved: false, pendingApproval: true, promotion: serializePromotion(created.promotion) });
  });
}
