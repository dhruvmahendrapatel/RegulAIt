/**
 * ADR-0168 amendment (2026-10-03, afternoon) — THE REVIEW POLICY, MULTI-ROLE
 * REVIEW ROUNDS, AND RECERTIFICATION.
 *
 * 1. THE POLICY. One admin-edited row: reviewer roles (id, name, members), per
 *    EU AI Act tier the roles that must sign, an optional approval lifetime per
 *    tier, and who may accept risk. No row — or a tier with no roles — keeps
 *    the intake template's single named approver, byte-identical.
 *
 * 2. A REVIEW ROUND. When an intake instance asks for its sign-off, the kernel
 *    writes the template's approver rows (workflows.ts, unchanged). If the
 *    policy routes the use case's tier to roles, `ensureReviewRound` replaces
 *    those still-pending rows — under the instance lock — with ONE row per
 *    required role (`review_role_id`, a name snapshot and a round number). Any
 *    member of the role may decide a row (the decide path checks membership
 *    live); the proposer never may. The stage advances only when every role
 *    row is approved — the decide path holds the stage while a sibling is
 *    still pending, so the org's approval-quorum dial cannot turn "each role
 *    is a required review" into "first one wins".
 *
 * 3. RECERTIFICATION. An approved use case whose `approvedUntil` has passed is
 *    moved back to `under_review` with `recertification = true`, and its
 *    (completed) intake instance is re-opened at its sign-off stage with a new
 *    review round per the policy. Audited, idempotent (an approved row is moved
 *    once; a second pass finds nothing), and the deploy gate keeps refusing
 *    because the use case is no longer `approved` until the round approves.
 */
import type { FastifyInstance } from "fastify";
import {
  aiUseCases,
  and,
  approvals,
  auditLog,
  desc,
  eq,
  governanceReviewPolicy,
  inArray,
  isNotNull,
  users,
  workflowEvents,
  workflowInstances,
  type AiUseCaseRow,
  type Db,
  type GovernanceReviewPolicyRow,
} from "@regulait/db";
import type { InstanceState, WorkflowDefinition } from "@regulait/workflow-kernel";
import {
  recertificationSweepSchema,
  reviewPolicyInputSchema,
  REVIEW_POLICY_TIER_KEYS,
  type ReviewPolicyTierKey,
  type ReviewPolicyView,
  type UseCaseReviewView,
} from "@regulait/shared";

const NO_IDENTITY = "00000000-0000-0000-0000-000000000000";
const POLICY_ID = "default";

export type StoredReviewPolicy = GovernanceReviewPolicyRow;

export async function loadReviewPolicy(db: Db): Promise<StoredReviewPolicy | null> {
  const [row] = await db.select().from(governanceReviewPolicy).where(eq(governanceReviewPolicy.id, POLICY_ID));
  return row ?? null;
}

/** the policy key a use case's screening routes on */
export function tierKeyFor(tier: string | null | undefined): ReviewPolicyTierKey {
  return tier && (REVIEW_POLICY_TIER_KEYS as readonly string[]).includes(tier)
    ? (tier as ReviewPolicyTierKey)
    : "unscreened";
}

/** the roles the tier requires, in the tier's order (empty = single approver) */
export function requiredRolesFor(
  policy: StoredReviewPolicy | null,
  tier: string | null | undefined,
): Array<{ id: string; name: string; memberUserIds: string[] }> {
  if (!policy) return [];
  const roleIds = policy.tiers[tierKeyFor(tier)]?.roleIds ?? [];
  const byId = new Map(policy.roles.map((r) => [r.id, r]));
  return roleIds.map((id) => byId.get(id)).filter((r): r is NonNullable<typeof r> => r !== undefined);
}

/** the per-tier lifetime override, or null for the ADR-0168 default */
export function policyValidityMonths(policy: StoredReviewPolicy | null, tier: string | null | undefined): number | null {
  return policy?.tiers[tierKeyFor(tier)]?.validityMonths ?? null;
}

export function isReviewRoleMember(policy: StoredReviewPolicy | null, roleId: string, userId: string): boolean {
  return !!policy?.roles.find((r) => r.id === roleId)?.memberUserIds.includes(userId);
}

export function reviewRoleIdsFor(policy: StoredReviewPolicy | null, userId: string): string[] {
  return policy ? policy.roles.filter((r) => r.memberUserIds.includes(userId)).map((r) => r.id) : [];
}

export function isRiskAcceptor(policy: StoredReviewPolicy | null, userId: string): boolean {
  return !!policy?.riskAcceptorUserIds.includes(userId);
}

type UseCaseForReview = Pick<AiUseCaseRow, "id" | "name" | "ownerUserId" | "workflowInstanceId" | "euAiActTier">;

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** insert one approval row per required role, numbered as the next round */
async function insertReviewRows(
  tx: Tx,
  instance: { id: string; initiatorUserId: string },
  stageId: string,
  roles: Array<{ id: string; name: string; memberUserIds: string[] }>,
  proposerIds: string[],
): Promise<{ round: number; ids: string[] }> {
  const [last] = await tx
    .select({ round: approvals.reviewRound })
    .from(approvals)
    .where(and(eq(approvals.instanceId, instance.id), isNotNull(approvals.reviewRoleId)))
    .orderBy(desc(approvals.reviewRound))
    .limit(1);
  const round = (last?.round ?? 0) + 1;
  const ids: string[] = [];
  for (const role of roles) {
    // the row names ONE member so every existing surface (inbox, names, the
    // approverUserId filter) has someone to show; any member may decide it.
    // Never the proposer while another member exists.
    const approver = role.memberUserIds.find((m) => !proposerIds.includes(m)) ?? role.memberUserIds[0]!;
    const [row] = await tx
      .insert(approvals)
      .values({
        userId: instance.initiatorUserId,
        objectType: "workflow",
        instanceId: instance.id,
        stageId,
        approverUserId: approver,
        reviewRoleId: role.id,
        reviewRoleName: role.name,
        reviewRound: round,
      })
      .returning({ id: approvals.id });
    ids.push(row!.id);
  }
  return { round, ids };
}

/**
 * If the review policy routes this use case's tier to roles and its intake
 * instance is waiting on a sign-off that still carries the template's
 * single-approver rows, replace them with one row per required role. Called
 * from `syncUseCaseForInstance` (after the tier is recomputed) and from the
 * decide path before a single-approver row is decided, so the window between
 * the kernel writing its rows and this replacing them cannot be used to
 * approve past the policy. A no-op without a policy, for a tier with no
 * roles, and once a round exists — idempotent.
 */
export async function ensureReviewRound(
  db: Db,
  useCase: UseCaseForReview,
  actorUserId: string | null,
  policyIn?: StoredReviewPolicy | null,
): Promise<{ round: number; supersededIds: string[] } | null> {
  if (!useCase.workflowInstanceId) return null;
  const policy = policyIn === undefined ? await loadReviewPolicy(db) : policyIn;
  const roles = requiredRolesFor(policy, useCase.euAiActTier);
  if (roles.length === 0) return null;
  return db.transaction(async (tx) => {
    const [inst] = await tx
      .select()
      .from(workflowInstances)
      .where(eq(workflowInstances.id, useCase.workflowInstanceId!))
      .for("update");
    if (!inst || inst.status !== "blocked_on_approval") return null;
    const def = inst.definition as WorkflowDefinition;
    const state = inst.state as InstanceState;
    const stage = def.stages[state.currentStageIndex];
    if (!stage || stage.type !== "human_approval") return null;
    const pending = await tx
      .select({ id: approvals.id, reviewRoleId: approvals.reviewRoleId })
      .from(approvals)
      .where(
        and(eq(approvals.instanceId, inst.id), eq(approvals.stageId, stage.id), eq(approvals.status, "pending")),
      );
    if (pending.length === 0 || pending.some((p) => p.reviewRoleId !== null)) return null;
    const supersededIds = pending.map((p) => p.id);
    await tx.update(approvals).set({ status: "superseded" }).where(inArray(approvals.id, supersededIds));
    const { round, ids } = await insertReviewRows(tx, inst, stage.id, roles, [
      useCase.ownerUserId,
      inst.initiatorUserId,
    ]);
    await tx.insert(auditLog).values({
      userId: actorUserId ?? useCase.ownerUserId,
      objectType: "ai_use_case",
      objectId: useCase.id,
      detail: {
        phase: "review-round-opened",
        round,
        tier: tierKeyFor(useCase.euAiActTier),
        roles: roles.map((r) => ({ id: r.id, name: r.name })),
        approvalIds: ids,
        supersededApprovalIds: supersededIds,
        workflowInstanceId: inst.id,
      },
      effect: "allow",
      ruleId: "use-case-review-round-opened",
      ruleChain: [],
      reason:
        `AI use case '${useCase.name}' sign-off routed by the review policy: ${roles.length} required ` +
        `review(s) — ${roles.map((r) => r.name).join(", ")}`,
    });
    return { round, supersededIds };
  });
}

/** the CURRENT round's reviews for a use case's intake instance ([] on the
 * single-approver path) */
export async function reviewsForInstance(db: Db, instanceId: string | null): Promise<UseCaseReviewView[]> {
  if (!instanceId) return [];
  const rows = await db
    .select()
    .from(approvals)
    .where(and(eq(approvals.instanceId, instanceId), isNotNull(approvals.reviewRoleId)));
  if (rows.length === 0) return [];
  const round = Math.max(...rows.map((r) => r.reviewRound ?? 0));
  const current = rows.filter((r) => r.reviewRound === round);
  const deciderIds = [...new Set(current.map((r) => r.decidedBy).filter((x): x is string => !!x))];
  const names = deciderIds.length
    ? new Map(
        (
          await db
            .select({ id: users.id, displayName: users.displayName, email: users.email })
            .from(users)
            .where(inArray(users.id, deciderIds))
        ).map((u) => [u.id, u.displayName || u.email]),
      )
    : new Map<string, string>();
  const policy = await loadReviewPolicy(db);
  const order = new Map((policy?.roles ?? []).map((r, i) => [r.id, i]));
  current.sort(
    (a, b) =>
      (order.get(a.reviewRoleId!) ?? 999) - (order.get(b.reviewRoleId!) ?? 999) ||
      a.reviewRoleName!.localeCompare(b.reviewRoleName!) ||
      a.id.localeCompare(b.id),
  );
  return current.map((r) => ({
    roleId: r.reviewRoleId!,
    roleName: r.reviewRoleName!,
    status: (r.status === "consumed" ? "approved" : r.status) as UseCaseReviewView["status"],
    deciderName: r.decidedBy ? (names.get(r.decidedBy) ?? null) : null,
    decidedAt: r.decidedAt ? r.decidedAt.toISOString() : null,
    approvalId: r.id,
  }));
}

// ---------------------------------------------------------------------------
// Recertification
// ---------------------------------------------------------------------------

export interface RecertificationSweepResult {
  evaluated: number;
  movedToReview: number;
  movedIds: string[];
  skipped: Array<{ id: string; reason: string }>;
}

function resolveApprover(approver: string, initiatorUserId: string): string {
  return approver === "requesting_user" ? initiatorUserId : approver;
}

/**
 * Move every approved use case whose approval has expired back into review.
 * The scheduler job (`use-case-recertification`) and the admin endpoint call
 * this one function. `useCaseIds` narrows a pass to named records.
 */
export async function runUseCaseRecertificationSweep(
  db: Db,
  opts: { now?: Date; actorUserId?: string | null; useCaseIds?: string[] } = {},
): Promise<RecertificationSweepResult> {
  const now = opts.now ?? new Date();
  const candidates = await db
    .select({ id: aiUseCases.id, approvedUntil: aiUseCases.approvedUntil })
    .from(aiUseCases)
    .where(
      and(
        eq(aiUseCases.status, "approved"),
        isNotNull(aiUseCases.approvedUntil),
        ...(opts.useCaseIds?.length ? [inArray(aiUseCases.id, opts.useCaseIds)] : []),
      ),
    );
  const out: RecertificationSweepResult = { evaluated: candidates.length, movedToReview: 0, movedIds: [], skipped: [] };
  const policy = await loadReviewPolicy(db);
  for (const c of candidates) {
    if (!c.approvedUntil || c.approvedUntil.getTime() > now.getTime()) continue;
    const moved = await db.transaction(async (tx): Promise<{ ok: true } | { ok: false; reason: string }> => {
      const [uc] = await tx.select().from(aiUseCases).where(eq(aiUseCases.id, c.id)).for("update");
      // re-checked under the lock: a concurrent pass (or a decision) got here first
      if (!uc || uc.status !== "approved" || !uc.approvedUntil || uc.approvedUntil.getTime() > now.getTime()) {
        return { ok: false, reason: "no_longer_expired" };
      }
      if (!uc.workflowInstanceId) return { ok: false, reason: "no_intake_instance" };
      const [inst] = await tx
        .select()
        .from(workflowInstances)
        .where(eq(workflowInstances.id, uc.workflowInstanceId))
        .for("update");
      if (!inst) return { ok: false, reason: "no_intake_instance" };
      if (inst.status !== "completed") return { ok: false, reason: `intake_instance_${inst.status}` };
      const def = inst.definition as WorkflowDefinition;
      let signoff = -1;
      for (let i = def.stages.length - 1; i >= 0; i--) {
        if (def.stages[i]!.type === "human_approval") {
          signoff = i;
          break;
        }
      }
      if (signoff < 0) return { ok: false, reason: "no_signoff_stage" };
      const stage = def.stages[signoff]!;
      const prior = inst.state as InstanceState;
      const state: InstanceState = {
        ...prior,
        status: "blocked_on_approval",
        currentStageIndex: signoff,
        stageStatuses: prior.stageStatuses.map((st, i) => (i >= signoff && st !== "pending" ? "reopened" : st)),
        artifactVersions: { ...prior.artifactVersions },
      };
      state.stageStatuses[signoff] = "active";
      // a re-open: the round tokens move exactly as a kernel re-open moves them
      await tx
        .update(workflowInstances)
        .set({
          state,
          status: state.status,
          round: inst.round + 1,
          stageEntry: inst.stageEntry + 1,
          updatedAt: new Date(),
        })
        .where(eq(workflowInstances.id, inst.id));
      const event = { kind: "recertification_reopened", stageId: stage.id, useCaseId: uc.id };
      await tx
        .insert(workflowEvents)
        .values({ instanceId: inst.id, event: event as never, actorUserId: opts.actorUserId ?? null });
      await tx.insert(auditLog).values({
        userId: opts.actorUserId ?? NO_IDENTITY,
        objectType: "workflow",
        objectId: inst.id,
        detail: { event, round: inst.round + 1, stageEntry: inst.stageEntry + 1 },
        effect: "allow",
        ruleId: "workflow:recertification_reopened",
        ruleChain: [],
        reason: `workflow instance re-opened at '${stage.id}' — the approval it recorded expired (status → blocked_on_approval)`,
      });
      const roles = requiredRolesFor(policy, uc.euAiActTier);
      let round: number | null = null;
      let approvalIds: string[];
      if (roles.length > 0) {
        const r = await insertReviewRows(tx, inst, stage.id, roles, [uc.ownerUserId, inst.initiatorUserId]);
        round = r.round;
        approvalIds = r.ids;
      } else {
        approvalIds = [];
        for (const approver of stage.approvers ?? []) {
          const [row] = await tx
            .insert(approvals)
            .values({
              userId: inst.initiatorUserId,
              objectType: "workflow",
              instanceId: inst.id,
              stageId: stage.id,
              approverUserId: resolveApprover(approver, inst.initiatorUserId),
            })
            .returning({ id: approvals.id });
          approvalIds.push(row!.id);
        }
      }
      await tx
        .update(aiUseCases)
        .set({ status: "under_review", recertification: true, updatedAt: new Date() })
        .where(eq(aiUseCases.id, uc.id));
      await tx.insert(auditLog).values({
        userId: opts.actorUserId ?? NO_IDENTITY,
        objectType: "ai_use_case",
        objectId: uc.id,
        detail: {
          phase: "recertification-started",
          from: "approved",
          to: "under_review",
          approvedUntil: uc.approvedUntil.toISOString(),
          workflowInstanceId: inst.id,
          tier: tierKeyFor(uc.euAiActTier),
          reviewRound: round,
          roles: roles.map((r) => ({ id: r.id, name: r.name })),
          approvalIds,
        },
        effect: "deny",
        ruleId: "use-case-recertification-started",
        ruleChain: [],
        reason:
          `AI use case '${uc.name}' approval expired on ${uc.approvedUntil.toISOString().slice(0, 10)} — ` +
          `back in review for recertification (${roles.length > 0 ? `${roles.length} required review(s)` : "the named approver"}); ` +
          "deployment is refused until it is re-approved",
      });
      return { ok: true };
    });
    if (moved.ok) {
      out.movedToReview += 1;
      out.movedIds.push(c.id);
    } else out.skipped.push({ id: c.id, reason: moved.reason });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

async function policyView(db: Db, row: StoredReviewPolicy | null): Promise<ReviewPolicyView> {
  if (!row) return { roles: [], tiers: {}, riskAcceptorUserIds: [], updatedAt: null, updatedByName: null };
  let updatedByName: string | null = null;
  if (row.updatedByUserId) {
    const [u] = await db
      .select({ displayName: users.displayName, email: users.email })
      .from(users)
      .where(eq(users.id, row.updatedByUserId));
    updatedByName = u ? u.displayName || u.email : null;
  }
  return {
    roles: row.roles.map((r) => ({ id: r.id, name: r.name, memberUserIds: [...r.memberUserIds] })),
    tiers: row.tiers as ReviewPolicyView["tiers"],
    riskAcceptorUserIds: [...row.riskAcceptorUserIds],
    updatedAt: row.updatedAt.toISOString(),
    updatedByName,
  };
}

export function registerReviewPolicyRoutes(app: FastifyInstance, db: Db): void {
  // Any signed-in user: reviewers need to know which roles they hold, and the
  // policy names people and roles, never secrets.
  app.get("/v1/governance/review-policy", async () => policyView(db, await loadReviewPolicy(db)));

  // Admin (the default gate). Validated as a whole, written as one row, audited.
  app.put("/v1/governance/review-policy", async (req, reply) => {
    const parsed = reviewPolicyInputSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.status(422).send({ error: "invalid_review_policy", issues: parsed.error.issues });
    }
    const body = parsed.data;
    const roleIds = body.roles.map((r) => r.id);
    const dupRole = roleIds.find((id, i) => roleIds.indexOf(id) !== i);
    if (dupRole) {
      return reply.status(422).send({ error: "duplicate_role_id", roleId: dupRole, detail: `role id '${dupRole}' is listed twice` });
    }
    for (const role of body.roles) {
      const dupMember = role.memberUserIds.find((m, i) => role.memberUserIds.indexOf(m) !== i);
      if (dupMember) {
        return reply.status(422).send({
          error: "duplicate_member",
          roleId: role.id,
          userId: dupMember,
          detail: `role '${role.id}' lists a member twice`,
        });
      }
    }
    const roleById = new Map(body.roles.map((r) => [r.id, r]));
    for (const key of REVIEW_POLICY_TIER_KEYS) {
      const tier = body.tiers[key];
      if (!tier) continue;
      const dup = tier.roleIds.find((id, i) => tier.roleIds.indexOf(id) !== i);
      if (dup) {
        return reply.status(422).send({
          error: "duplicate_role_in_tier",
          tier: key,
          roleId: dup,
          detail: `tier '${key}' lists role '${dup}' twice — each role is one required review`,
        });
      }
      for (const id of tier.roleIds) {
        const role = roleById.get(id);
        if (!role) {
          return reply.status(422).send({
            error: "unknown_role",
            tier: key,
            roleId: id,
            detail: `tier '${key}' names role '${id}', which the policy does not define`,
          });
        }
        if (role.memberUserIds.length === 0) {
          return reply.status(422).send({
            error: "role_without_members",
            tier: key,
            roleId: id,
            detail: `role '${id}' has no members, so the review it requires for tier '${key}' could never be decided`,
          });
        }
      }
    }
    const dupAcceptor = body.riskAcceptorUserIds.find((m, i) => body.riskAcceptorUserIds.indexOf(m) !== i);
    if (dupAcceptor) {
      return reply.status(422).send({ error: "duplicate_risk_acceptor", userId: dupAcceptor });
    }
    const userIds = [...new Set([...body.roles.flatMap((r) => r.memberUserIds), ...body.riskAcceptorUserIds])];
    if (userIds.length > 0) {
      const found = new Set(
        (await db.select({ id: users.id }).from(users).where(inArray(users.id, userIds))).map((u) => u.id),
      );
      const missing = userIds.filter((id) => !found.has(id));
      if (missing.length > 0) {
        return reply.status(422).send({
          error: "unknown_user",
          userIds: missing,
          detail: "every role member and risk acceptor must name an existing user",
        });
      }
    }
    const tiers: Record<string, { roleIds: string[]; validityMonths?: number }> = {};
    for (const key of REVIEW_POLICY_TIER_KEYS) {
      const t = body.tiers[key];
      if (t) tiers[key] = { roleIds: t.roleIds, ...(t.validityMonths !== undefined ? { validityMonths: t.validityMonths } : {}) };
    }
    const values = {
      roles: body.roles.map((r) => ({ id: r.id, name: r.name, memberUserIds: r.memberUserIds })),
      tiers,
      riskAcceptorUserIds: body.riskAcceptorUserIds,
      updatedAt: new Date(),
      updatedByUserId: req.authCtx.userId ?? null,
    };
    const before = await loadReviewPolicy(db);
    const [row] = await db
      .insert(governanceReviewPolicy)
      .values({ id: POLICY_ID, ...values })
      .onConflictDoUpdate({ target: governanceReviewPolicy.id, set: values })
      .returning();
    await db.insert(auditLog).values({
      userId: req.authCtx.userId ?? NO_IDENTITY,
      objectType: "org_settings",
      objectId: null,
      detail: {
        phase: "review-policy-updated",
        before: before ? { roles: before.roles, tiers: before.tiers, riskAcceptorUserIds: before.riskAcceptorUserIds } : null,
        after: { roles: values.roles, tiers: values.tiers, riskAcceptorUserIds: values.riskAcceptorUserIds },
      },
      effect: "allow",
      ruleId: "review-policy-updated",
      ruleChain: [],
      reason:
        `review policy updated: ${values.roles.length} reviewer role(s), ` +
        `${Object.values(tiers).filter((t) => t.roleIds.length > 0).length} tier(s) routed to roles, ` +
        `${values.riskAcceptorUserIds.length} risk acceptor(s)`,
    });
    return policyView(db, row!);
  });

  // Admin (the default gate): run the recertification sweep now. The scheduler
  // job calls the same function.
  app.post("/v1/governance/recertification/sweep", async (req) => {
    const body = recertificationSweepSchema.parse(req.body ?? {});
    const out = await runUseCaseRecertificationSweep(db, {
      actorUserId: req.authCtx.userId ?? null,
      ...(body.useCaseIds ? { useCaseIds: body.useCaseIds } : {}),
    });
    return { evaluated: out.evaluated, movedToReview: out.movedToReview, movedIds: out.movedIds, skipped: out.skipped };
  });
}

/** used by the detail/list reads: approved rows with a passed approval are
 * due; `recertificationDueAt` is simply the approval's valid-until */
export function recertificationDueAt(row: Pick<AiUseCaseRow, "approvedUntil">): string | null {
  return row.approvedUntil ? row.approvedUntil.toISOString() : null;
}
