/**
 * ADR-0337 §5 (lane E18, slice 3b): raising a SaaS entitlement finding into THE approvals queue for a second
 * administrator's recorded decision.
 *
 * - An admin raises a finding that the report flags NOW (re-computed server side: a stale or invented key is refused),
 *   naming another active admin as approver. The review keeps the rationale and evidence as raised; the approval's
 *   arguments digest binds them, so the approver decides exactly what was raised.
 * - Approved = "remove or narrow this grant in the vendor's console"; denied = "keep it, risk accepted" (with the
 *   decider's reason). NOTHING EXECUTES either way: RegulAIt never revokes a vendor-side grant.
 * - The requester never decides their own review, by any route (no admin override). A pending review can be withdrawn.
 * - The lifecycle is the declared machine `SAAS_FINDING_REVIEW_MACHINE` (@regulait/shared); every write is guarded on
 *   the states its event may leave from, and every move is audited.
 *
 * Admin-only by default (none of these routes is in NON_ADMIN_ROUTES). Nothing here calls a vendor.
 */
import { z } from "zod";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { and, approvals, asc, auditLog, desc, eq, gt, inArray, isNull, sql, saasFindingReviews, users, type Db, type SaasFindingReviewRow } from "@regulait/db";
import {
  SAAS_FINDING_REVIEW_MACHINE,
  SAAS_FINDING_REVIEW_STATES,
  SAAS_FINDING_WINDOW_DAYS_MAX,
  SAAS_FINDING_WINDOW_DAYS_MIN,
  approvalArgumentsDigest,
  approvalArgumentsPreview,
  parseSaasFindingWindowDays,
  scrubAuditText,
} from "@regulait/shared";
import { loadApprovalPool, requestedAtOf } from "./approval-pool.js";
import { computeSaasFindings, type SaasFinding } from "./saas-entitlement-findings.js";
import { whereFrom } from "./state-transition.js";

export const SAAS_FINDING_REVIEW_APPROVAL_PREFIX = "saas-finding-review:";
/** how long a raised review waits in the queue before its approval expires */
export const SAAS_FINDING_REVIEW_TTL_DAYS = 14;
const MAX_PAGE = 200;
const KEY = /^[a-z-]{1,40}:(?:grant|record):[0-9a-f-]{36}$/;

const raiseBody = z
  .object({
    key: z.string().regex(KEY, "a finding key as the report gives it"),
    approverUserId: z.string().uuid(),
    reason: z.string().trim().min(1).max(1000),
    windowDays: z.string().optional(),
  })
  .strict();
const listQuery = z
  .object({
    status: z.enum(SAAS_FINDING_REVIEW_STATES).optional(),
    findingKey: z.string().regex(KEY).optional(),
    after: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(MAX_PAGE).default(50),
  })
  .strict();
const reviewParam = z.object({ reviewId: z.string().uuid() });

/** what the approval binds: the finding exactly as raised */
export const reviewFacts = (r: Pick<SaasFindingReviewRow, "findingKey" | "ruleId" | "ruleVersion" | "grantId" | "agentRecordId" | "sourceId" | "rationale" | "evidence">) => ({
  op: "saas_finding_review",
  findingKey: r.findingKey,
  ruleId: r.ruleId,
  ruleVersion: r.ruleVersion,
  grantId: r.grantId,
  agentRecordId: r.agentRecordId,
  sourceId: r.sourceId,
  rationale: r.rationale,
  evidence: r.evidence,
});
export const reviewArgumentsDigest = (r: Parameters<typeof reviewFacts>[0]) => approvalArgumentsDigest({ projectId: null, arguments: reviewFacts(r) });

const audit = (t: Db, userId: string, objectId: string, ruleId: string, effect: "allow" | "deny" | "require_approval", reason: string, detail: Record<string, unknown>) =>
  t.insert(auditLog).values({ userId, objectType: "saas_finding_review", objectId, detail: { subsystem: "saas-finding-reviews", adr: "0337", ...detail }, effect, ruleId, ruleChain: [], reason });

/** the fixed fields a review's audit rows carry (never vendor text beyond the rendered rationale's rule id) */
const fixed = (r: SaasFindingReviewRow) => ({ reviewId: r.id, findingKey: r.findingKey, ruleId: r.ruleId, ruleVersion: r.ruleVersion, sourceId: r.sourceId, status: r.status, approvalId: r.approvalId });

export function reviewView(r: SaasFindingReviewRow) {
  return {
    id: r.id,
    findingKey: r.findingKey,
    ruleId: r.ruleId,
    ruleVersion: r.ruleVersion,
    sourceId: r.sourceId,
    grantId: r.grantId,
    agentRecordId: r.agentRecordId,
    /** the vendor-side subject was removed since the review was raised (its row is gone) */
    subjectGone: r.grantId === null && r.agentRecordId === null,
    rationale: r.rationale,
    evidence: r.evidence,
    status: r.status,
    reason: r.reason,
    requestedBy: r.requestedBy,
    approvalId: r.approvalId,
    decidedBy: r.decidedBy,
    decidedAt: r.decidedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
    lifecycle: SAAS_FINDING_REVIEW_MACHINE.describe(r.status),
  };
}

/** the latest review of each key, for the report's annotation (bounded by the keys asked for) */
export async function latestReviewsByKey(db: Db, keys: readonly string[]): Promise<Map<string, { id: string; status: string; decidedAt: string | null }>> {
  const out = new Map<string, { id: string; status: string; decidedAt: string | null }>();
  for (let i = 0; i < keys.length; i += 1000) {
    const part = keys.slice(i, i + 1000);
    const rows = await db
      .selectDistinctOn([saasFindingReviews.findingKey], { key: saasFindingReviews.findingKey, id: saasFindingReviews.id, status: saasFindingReviews.status, decidedAt: saasFindingReviews.decidedAt })
      .from(saasFindingReviews)
      .where(inArray(saasFindingReviews.findingKey, part))
      .orderBy(saasFindingReviews.findingKey, desc(saasFindingReviews.createdAt), desc(saasFindingReviews.id));
    for (const r of rows) out.set(r.key, { id: r.id, status: r.status, decidedAt: r.decidedAt?.toISOString() ?? null });
  }
  return out;
}

const isUniqueViolation = (e: unknown, name: string): boolean => {
  const err = e as { code?: string; constraint?: string; cause?: { code?: string; constraint?: string } } | null;
  return (err?.code === "23505" && err.constraint === name) || (err?.cause?.code === "23505" && err.cause.constraint === name);
};

class Refused extends Error {
  constructor(readonly statusCode: number, readonly body: Record<string, unknown>) {
    super(String(body.error));
  }
}

export function registerSaasFindingReviewRoutes(app: FastifyInstance, db: Db): void {
  const actor = (req: FastifyRequest) => req.authCtx.userId;
  const badRequest = (reply: FastifyReply, err: z.ZodError) =>
    reply.status(400).send({ error: "invalid_request", detail: err.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ") });

  // raise a finding the report flags now into the approvals queue
  app.post("/v1/discovery/entitlements/findings/reviews", async (req, reply) => {
    const b = raiseBody.safeParse(req.body ?? {});
    if (!b.success) return badRequest(reply, b.error);
    const userId = actor(req);
    if (!userId) return reply.status(403).send({ error: "user_required", detail: "a review is raised by a named administrator, not a bootstrap token" });
    const windowDays = parseSaasFindingWindowDays(b.data.windowDays);
    if (windowDays === null) return reply.status(400).send({ error: "invalid_request", detail: `windowDays: a whole number of days from ${SAAS_FINDING_WINDOW_DAYS_MIN} to ${SAAS_FINDING_WINDOW_DAYS_MAX}` });
    const approverUserId = b.data.approverUserId.toLowerCase();
    if (approverUserId === userId) return reply.status(422).send({ error: "approver_is_requester", detail: "a finding review is decided by a second administrator, not the person who raises it" });

    // the finding must be flagged NOW, recomputed here: a stale or invented key raises nothing
    const report = await computeSaasFindings(db, { windowDays, key: b.data.key });
    const finding: SaasFinding | undefined = report.rules.flatMap((r) => r.findings).find((f) => f.key === b.data.key);
    if (!finding) return reply.status(404).send({ error: "finding_not_current", detail: `the report does not flag '${b.data.key}' under a ${windowDays}-day window now` });

    try {
      const row = await db.transaction(async (tx) => {
        const t = tx as unknown as Db;
        const [approver] = await t.select({ id: users.id }).from(users).where(and(eq(users.id, approverUserId), eq(users.isAdmin, true), isNull(users.disabledAt)));
        const pool = approver ? await loadApprovalPool(t, { namedApproverUserId: approverUserId, approverRoleId: null, callerUserId: userId }) : null;
        if (!pool || !pool.members.includes(approverUserId)) {
          throw new Refused(422, { error: "approver_not_eligible", detail: "the approver must be another active administrator who is not linked to you by a delegation" });
        }
        const draft = {
          findingKey: finding.key,
          ruleId: finding.ruleId,
          ruleVersion: finding.ruleVersion,
          grantId: finding.grant?.id ?? null,
          agentRecordId: finding.agentRecord?.id ?? null,
          sourceId: finding.source.id,
          rationale: finding.rationale.slice(0, 2000),
          evidence: finding.evidence,
        };
        const [approval] = await t
          .insert(approvals)
          .values({
            userId,
            objectType: "saas_finding_review",
            approverUserId,
            stageId: `${SAAS_FINDING_REVIEW_APPROVAL_PREFIX}pending`,
            argumentsDigest: reviewArgumentsDigest(draft),
            argumentsPreview: approvalArgumentsPreview(reviewFacts(draft)),
            argumentsPreviewKind: "arguments_v1",
            expiresAt: sql`now() + make_interval(days => ${SAAS_FINDING_REVIEW_TTL_DAYS})`,
          })
          .returning({ id: approvals.id });
        const [review] = await t
          .insert(saasFindingReviews)
          .values({ ...draft, reason: b.data.reason, requestedBy: userId, approvalId: approval!.id })
          .returning();
        await t.update(approvals).set({ stageId: `${SAAS_FINDING_REVIEW_APPROVAL_PREFIX}${review!.id}` }).where(eq(approvals.id, approval!.id));
        await audit(t, userId, review!.id, "saas-finding-review-raised", "require_approval", `a ${finding.ruleId} finding was raised for a second administrator's decision (ADR-0337 §5)`, {
          ...fixed(review!),
          approverUserId,
          windowDays,
          reason: scrubAuditText(b.data.reason),
        });
        return review!;
      });
      return reply.status(201).send({ review: reviewView(row) });
    } catch (e) {
      if (e instanceof Refused) return reply.status(e.statusCode).send(e.body);
      if (isUniqueViolation(e, "saas_finding_reviews_pending_uq")) return reply.status(409).send({ error: "review_already_pending", detail: "this finding already has a pending review" });
      throw e;
    }
  });

  app.get("/v1/discovery/entitlements/findings/reviews", async (req, reply) => {
    const q = listQuery.safeParse(req.query ?? {});
    if (!q.success) return badRequest(reply, q.error);
    const where = and(
      q.data.status ? eq(saasFindingReviews.status, q.data.status) : undefined,
      q.data.findingKey ? eq(saasFindingReviews.findingKey, q.data.findingKey) : undefined,
      q.data.after ? gt(saasFindingReviews.id, q.data.after) : undefined,
    );
    const rows = await db.select().from(saasFindingReviews).where(where).orderBy(asc(saasFindingReviews.id)).limit(q.data.limit + 1);
    const more = rows.length > q.data.limit;
    const page = more ? rows.slice(0, q.data.limit) : rows;
    return { reviews: page.map(reviewView), next: more ? page[page.length - 1]!.id : null };
  });

  // withdraw a pending review; its queue item is superseded
  app.post("/v1/discovery/entitlements/findings/reviews/:reviewId/withdraw", async (req, reply) => {
    const p = reviewParam.safeParse(req.params);
    if (!p.success) return badRequest(reply, p.error);
    const userId = actor(req);
    if (!userId) return reply.status(403).send({ error: "user_required", detail: "a review is withdrawn by a named administrator" });
    const out = await db.transaction(async (tx) => {
      const t = tx as unknown as Db;
      const [moved] = await t
        .update(saasFindingReviews)
        .set({ status: SAAS_FINDING_REVIEW_MACHINE.next("pending", "withdraw") })
        .where(and(eq(saasFindingReviews.id, p.data.reviewId), whereFrom(saasFindingReviews.status, SAAS_FINDING_REVIEW_MACHINE, "withdraw")))
        .returning();
      if (!moved) return null;
      await t.update(approvals).set({ status: "superseded" }).where(and(eq(approvals.id, moved.approvalId), eq(approvals.status, "pending")));
      await audit(t, userId, moved.id, "saas-finding-review-withdrawn", "allow", "a pending finding review was withdrawn; its queue item is superseded (ADR-0337 §5)", fixed(moved));
      return moved;
    });
    if (out) return { review: reviewView(out) };
    const [r] = await db.select().from(saasFindingReviews).where(eq(saasFindingReviews.id, p.data.reviewId));
    if (!r) return reply.status(404).send({ error: "review_not_found", detail: "no such review" });
    return reply.status(409).send({ error: "invalid_transition", detail: `a ${r.status} review cannot be withdrawn`, lifecycle: SAAS_FINDING_REVIEW_MACHINE.describe(r.status) });
  });
}

// ---------------------------------------------------------------------------
// The decide path's hooks (app.ts decideOneApprovalUnguarded)
// ---------------------------------------------------------------------------

type ApprovalLike = { id: string; userId: string; approverUserId: string; approverRoleId: string | null; argumentsDigest: string | null };
const reviewOfApproval = (db: Db, approvalId: string) => db.select().from(saasFindingReviews).where(eq(saasFindingReviews.approvalId, approvalId));

/**
 * Before anything is written: the decider did not raise the review (by any route) and is an active admin in the
 * approval's pool (never an override), and the approval still binds the review as raised.
 */
export async function precheckSaasFindingReviewDecision(db: Db, approval: ApprovalLike, deciderUserId: string): Promise<{ status: number; body: Record<string, unknown> } | null> {
  const [r] = await reviewOfApproval(db, approval.id);
  if (!r) return null;
  if (r.requestedBy === deciderUserId || approval.userId === deciderUserId) {
    return { status: 403, body: { error: "cannot_decide_own_finding_review", detail: "the decider raised this review; another administrator must decide it" } };
  }
  const [decider] = await db.select({ id: users.id }).from(users).where(and(eq(users.id, deciderUserId), eq(users.isAdmin, true), isNull(users.disabledAt)));
  const pool = await loadApprovalPool(db, { namedApproverUserId: approval.approverUserId, approverRoleId: approval.approverRoleId, callerUserId: approval.userId, asOf: requestedAtOf(approval.id) });
  if (!decider || !pool.members.includes(deciderUserId)) {
    return { status: 403, body: { error: "not_an_eligible_approver", detail: "a finding review is decided by the administrator it names (or their delegate), never by an override" } };
  }
  if (approval.argumentsDigest !== reviewArgumentsDigest(r)) {
    return { status: 409, body: { error: "approval_unbound", detail: "the approval no longer binds the review as raised" } };
  }
  return null;
}

/** inside the decision's transaction: approved -> remediate, denied -> accepted; nothing is sent anywhere */
export async function applySaasFindingReviewDecision(tx: Db, approval: ApprovalLike, decision: "approved" | "denied", deciderUserId: string): Promise<void> {
  const [r] = await tx.select().from(saasFindingReviews).where(eq(saasFindingReviews.approvalId, approval.id)).for("update");
  if (!r || r.status !== "pending") return;
  const event = decision === "approved" ? "approve" : "deny";
  const [moved] = await tx
    .update(saasFindingReviews)
    .set({ status: SAAS_FINDING_REVIEW_MACHINE.next(r.status, event), decidedBy: deciderUserId, decidedAt: sql`now()` })
    .where(and(eq(saasFindingReviews.id, r.id), whereFrom(saasFindingReviews.status, SAAS_FINDING_REVIEW_MACHINE, event)))
    .returning();
  if (!moved) return;
  await audit(
    tx,
    deciderUserId,
    moved.id,
    `saas-finding-review-${moved.status}`,
    event === "approve" ? "allow" : "deny",
    event === "approve"
      ? "a finding review was approved: the grant is to be removed or narrowed in the vendor's console; RegulAIt sends nothing (ADR-0337 §5)"
      : "a finding review was denied: the grant is kept and the risk accepted (ADR-0337 §5)",
    fixed(moved),
  );
}

/** the approvals queue's label for each finding review */
export async function saasFindingReviewApprovalLabels(db: Db, stageIds: readonly (string | null)[]): Promise<Map<string, string>> {
  const ids = [...new Set(stageIds.filter((s): s is string => !!s?.startsWith(SAAS_FINDING_REVIEW_APPROVAL_PREFIX)).map((s) => s.slice(SAAS_FINDING_REVIEW_APPROVAL_PREFIX.length)))].filter((x) =>
    /^[0-9a-f-]{36}$/.test(x),
  );
  const out = new Map<string, string>();
  if (ids.length === 0) return out;
  const rows = await db.select({ id: saasFindingReviews.id, ruleId: saasFindingReviews.ruleId, rationale: saasFindingReviews.rationale }).from(saasFindingReviews).where(inArray(saasFindingReviews.id, ids));
  for (const r of rows) out.set(`${SAAS_FINDING_REVIEW_APPROVAL_PREFIX}${r.id}`, `${r.ruleId}: ${r.rationale.length > 160 ? `${r.rationale.slice(0, 157)}...` : r.rationale}`);
  return out;
}
