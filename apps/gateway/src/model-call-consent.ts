/**
 * ADR-0251 (P-01 remainder) — THE APPROVAL QUEUE AND REPLAY FOR MODEL CALLS.
 *
 * Until this module a model call matched by a model approval rule (`resource_approval_rules`, resource_type 'model')
 * was refused (403 `approval_required`), because a model call had no per-call consent to be released by. It is now
 * held in the one approvals queue, exactly as a connector call is (ADR-0173 batch 2b, ADR-0251 slice 1):
 *
 *  1. HOLD. The core composes `require_approval`. One `model_call` approval row is queued per distinct required
 *     approver (review #715 finding 1: every named approver signs), naming the model (`approvals.agent_id`), bound to
 *     the call's payload (ADR-0104 `argumentsDigest` over the RAW request) and to its policy context (ADR-0105
 *     `contextDigest`: the matched rule ids, the named approver, the org's signing and quorum posture, the target).
 *     The caller is answered 202 `approval_pending` with the approval id. Nothing is sent to a provider, nothing is
 *     billed, and an identical pending call reuses its pending row.
 *  2. DECIDE. Through the tool-call decide path (`decideToolCallApproval`): quorum, separation of duties, delegation
 *     and the passkey signature over `{approvalId, decision, argumentsDigest, contextDigest, agentId, toolName}`.
 *  3. REPLAY. The caller re-submits the IDENTICAL call. Its bindings find an approved, fresh row for every required
 *     approver; the core then allows, and each consent is SPENT ONCE (`spendBoundApproval`: policy epoch, payload,
 *     context, expiry and the signature recheck, under a row lock) before any provider work. A consent that lapsed or
 *     whose policy context changed is superseded and audited; a second replay of the same consent runs nothing.
 *
 * The approval's `tool_name` is `<model name>.<mode>`, what a person reads in the queue.
 *
 * The A2A lane reuses this shape for remote-agent calls; the target union is the extension point.
 *
 * `mcp-proxy.js` (the consent spend and retirement) is imported lazily: a static edge would close an import cycle
 * through the dispatch core (scripts/preflight-import-cycles.mjs), and both uses run long after start-up.
 */
import { and, approvals, asc, auditLog, eq, governancePolicyEpoch, gt, inArray, isNull, or, sql, type Db } from "@regulait/db";
import type { GovernedResourceDecision, ResourceApprovalRule } from "@regulait/policy-kernel";
import { approvalArgumentsDigest, approvalArgumentsPreview, approvalContextDigest } from "@regulait/shared";
import {
  auditQuorumUnsatisfiableAtQueue,
  recheckApprovalSignatures,
  reusePendingToolApproval,
  supersedeOnRecheckFailure,
  toolApprovalRequirements,
} from "./approval-signatures.js";
import { loadOrgSettings } from "./org-settings.js";
import type { RetiredApproval } from "./governed-evaluate.js";

export const MODEL_APPROVAL_OBJECT_TYPE = "model_call" as const;

/** The request a model-call consent is bound to: everything that changes what the model is asked. Callers pass the
 * dispatch request as the provider will receive it; streaming callbacks and routing hints are not part of it. */
export interface ModelInvocation {
  mode: string;
  input: string;
  messages?: unknown;
  system?: string | null | undefined;
  tools?: unknown;
  toolChoice?: unknown;
  responseFormat?: unknown;
  thinking?: unknown;
  maxTokens?: number | null | undefined;
}

export interface ModelCallTarget {
  agentId: string;
  agentName: string;
  provider: string | null;
  model: string | null;
}

/** one required approver's consent identity for this call */
export interface ModelConsentBinding {
  approverUserId: string;
  ruleIds: string[];
  argumentsDigest: string;
  argumentsPreview: unknown;
  contextDigest: string;
  /** a fresh, payload- and context-matching approved row this call may spend */
  approvedApprovalId: string | null;
  /** payload-matching approved rows that lapsed or went stale */
  retired: RetiredApproval[];
}

export interface ModelConsentState {
  bindings: ModelConsentBinding[];
  /** every required approver holds an approved, bound consent */
  allConsented: boolean;
  /** the first binding still missing its consent (rules by specificity), else null */
  missing: ModelConsentBinding | null;
}

/** undefined fields are dropped so `{maxTokens: undefined}` and `{}` bind the same consent */
function canonicalInvocation(inv: ModelInvocation): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(inv)) if (v !== undefined && v !== null) out[k] = v;
  return out;
}

export function modelToolName(target: ModelCallTarget, mode: string): string {
  return `${target.agentName}.${mode}`;
}

async function modelConsentBinding(
  db: Db,
  input: {
    userId: string;
    target: ModelCallTarget;
    projectId: string | null;
    invocation: ModelInvocation;
    approverUserId: string;
    ruleIds: string[];
  },
): Promise<ModelConsentBinding> {
  const args = { agentId: input.target.agentId, ...canonicalInvocation(input.invocation) };
  // ADR-0104: computed on the RAW request, so a scrub of the preview cannot move consent identity
  const argumentsDigest = approvalArgumentsDigest({ projectId: input.projectId, arguments: args });
  const org = await loadOrgSettings(db);
  const contextDigest = approvalContextDigest({
    ruleVersions: input.ruleIds.map((ruleId) => ({ ruleId, activeVersionId: null })),
    requiredApproverUserId: input.approverUserId,
    approvalScope: "action",
    orgDualControl: { signatureMode: org.approvalSignatureMode, sensitiveQuorum: org.toolApprovalSensitiveQuorum },
    target: { kind: "model", agentId: input.target.agentId, provider: input.target.provider, model: input.target.model },
  });
  const approved = await db
    .select({ id: approvals.id, contextDigest: approvals.contextDigest, expiresAt: approvals.expiresAt })
    .from(approvals)
    .where(
      and(
        eq(approvals.userId, input.userId),
        eq(approvals.objectType, MODEL_APPROVAL_OBJECT_TYPE),
        eq(approvals.agentId, input.target.agentId),
        eq(approvals.status, "approved"),
        eq(approvals.argumentsDigest, argumentsDigest),
      ),
    )
    .orderBy(asc(approvals.requestedAt))
    .limit(50);
  const now = Date.now();
  const expired = (r: (typeof approved)[number]) => r.expiresAt != null && r.expiresAt.getTime() <= now;
  const fresh = (r: (typeof approved)[number]) => !expired(r) && r.contextDigest === contextDigest;
  return {
    approverUserId: input.approverUserId,
    ruleIds: input.ruleIds,
    argumentsDigest,
    // the scrubbed rendering a person reads in the queue (ADR-0099); never the digest's input
    argumentsPreview: approvalArgumentsPreview(args),
    contextDigest,
    approvedApprovalId: approved.find(fresh)?.id ?? null,
    retired: approved.filter((r) => !fresh(r)).map((r) => ({ id: r.id, reason: expired(r) ? "expired" : "context_changed" })),
  };
}

/** One binding per distinct required approver: each matching rule's approver (ADR-0251 review #715 finding 1). */
export async function modelConsentState(
  db: Db,
  input: { userId: string; target: ModelCallTarget; projectId: string | null; invocation: ModelInvocation; matchedRules: readonly ResourceApprovalRule[] },
): Promise<ModelConsentState> {
  const required: Array<{ approverUserId: string; ruleIds: string[] }> = [];
  for (const r of input.matchedRules) {
    const slot = required.find((x) => x.approverUserId === r.approverUserId);
    if (slot) slot.ruleIds.push(r.id);
    else required.push({ approverUserId: r.approverUserId, ruleIds: [r.id] });
  }
  const bindings = await Promise.all(
    required.map((r) =>
      modelConsentBinding(db, { userId: input.userId, target: input.target, projectId: input.projectId, invocation: input.invocation, ...r }),
    ),
  );
  // a consent fresh for ONE required approver is not stale for another (their context digests differ by design)
  const freshIds = new Set(bindings.map((b) => b.approvedApprovalId).filter((id): id is string => id !== null));
  for (const b of bindings) b.retired = b.retired.filter((r) => !freshIds.has(r.id));
  return {
    bindings,
    allConsented: bindings.length > 0 && bindings.every((b) => b.approvedApprovalId !== null),
    missing: bindings.find((b) => b.approvedApprovalId === null) ?? null,
  };
}

export interface ModelConsentOutcome {
  ok: false;
  status: number;
  error: string;
  detail: string;
  ruleId: string;
  approvalId?: string;
  auditLogId?: string | null;
}

/**
 * THE HOLD: queue (or reuse) the consent the call still lacks, and answer 202. A pool that can never reach its
 * quorum is a denied, audited call (ADR-0186 A), never an orphaned row.
 *
 * ONE TRANSACTION (review #807 item 2): retiring the stale consents, the queue row (or the reuse of a pending one) and
 * the `require_approval` decision row commit together, so a pending, approvable row never exists without the decision
 * that raised it. An advisory lock on (caller, model, payload digest, context digest) serialises identical calls
 * (review #807 item 3), so two at the same moment reuse one pending row rather than queueing two.
 */
export async function queueModelConsent(
  db: Db,
  input: {
    userId: string;
    target: ModelCallTarget;
    projectId: string | null;
    mode: string;
    decision: GovernedResourceDecision;
    state: ModelConsentState;
  },
): Promise<ModelConsentOutcome> {
  const b = input.state.missing!;
  const toolName = modelToolName(input.target, input.mode);
  const { supersedeStaleConsent } = await import("./mcp-proxy.js");
  // read-only, so outside the transaction: who may sign, and the org's expiry
  const requirement = await toolApprovalRequirements(db, {
    callerUserId: input.userId,
    approverUserId: b.approverUserId,
    ruleId: null,
    matchedApprovalRuleIds: input.decision.matchedApprovalRuleIds,
    projectId: input.projectId,
  });
  const { approvalTtlHours } = await loadOrgSettings(db);
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`regulait.model-consent:${input.userId}:${input.target.agentId}:${b.argumentsDigest}:${b.contextDigest}`}, 0))`,
    );
    const superseded = b.retired.length
      ? await supersedeStaleConsent(tx, b.retired, { userId: input.userId, agent: { id: input.target.agentId, name: input.target.agentName }, projectId: input.projectId })
      : [];
    if (!requirement.satisfiable) {
      const reason = await auditQuorumUnsatisfiableAtQueue(tx, {
        userId: input.userId,
        req: requirement,
        projectId: input.projectId,
        target: { agentId: input.target.agentId, toolName },
      });
      return { ok: false, status: 403, error: "approval_quorum_unsatisfiable", detail: reason, ruleId: "approval-quorum-unsatisfiable" };
    }
    // an identical pending call reuses its pending row (a different payload is a different consent)
    const [pending] = await tx
      .select({ id: approvals.id })
      .from(approvals)
      .where(
        and(
          eq(approvals.userId, input.userId),
          eq(approvals.objectType, MODEL_APPROVAL_OBJECT_TYPE),
          eq(approvals.agentId, input.target.agentId),
          eq(approvals.status, "pending"),
          eq(approvals.argumentsDigest, b.argumentsDigest),
          eq(approvals.contextDigest, b.contextDigest),
        ),
      )
      .orderBy(asc(approvals.requestedAt))
      .limit(1);
    const reusable = pending && (await reusePendingToolApproval(tx, pending.id)) ? pending : undefined;
    const approvalId =
      reusable?.id ??
      (
        await tx
          .insert(approvals)
          .values({
            userId: input.userId,
            objectType: MODEL_APPROVAL_OBJECT_TYPE,
            agentId: input.target.agentId,
            toolName,
            approverUserId: b.approverUserId,
            argumentsDigest: b.argumentsDigest,
            argumentsPreview: b.argumentsPreview,
            argumentsPreviewKind: "arguments_v1",
            approvalScope: "action",
            projectId: input.projectId,
            contextDigest: b.contextDigest,
            ...(approvalTtlHours != null ? { expiresAt: new Date(Date.now() + approvalTtlHours * 3_600_000) } : {}),
            quorum: requirement.quorum,
            signatureMode: requirement.signatureMode,
            approverRoleId: requirement.approverRoleId,
            namedApproverUserId: b.approverUserId,
          })
          .returning({ id: approvals.id })
      )[0]!.id;
    const [row] = await tx
      .insert(auditLog)
      .values({
        userId: input.userId,
        objectType: "agent",
        objectId: input.target.agentId,
        detail: {
          phase: "governed-core",
          mode: input.mode,
          approvalId,
          ...(input.projectId ? { projectId: input.projectId } : {}),
          matchedApprovalRuleIds: input.decision.matchedApprovalRuleIds,
          ...(superseded.length ? { supersededApprovalIds: superseded } : {}),
          receiptClass: "decision",
        },
        effect: "require_approval",
        ruleId: input.decision.ruleId,
        ruleChain: input.decision.ruleChain,
        reason: input.decision.reason,
      })
      .returning({ id: auditLog.id });
    const anyContext = b.retired.some((r) => superseded.includes(r.id) && r.reason === "context_changed");
    return {
      ok: false,
      status: 202,
      error: "approval_pending",
      approvalId,
      ruleId: input.decision.ruleId,
      auditLogId: row?.id ?? null,
      detail:
        `approval '${approvalId}' is pending sign-off; nothing was sent to the model and nothing was billed. ` +
        "Re-submit the identical call once it is approved" +
        (superseded.length
          ? ` (approval ${superseded.join(", ")} ${anyContext ? "was granted under a policy that has since changed" : "expired"} and was superseded)`
          : ""),
    } satisfies ModelConsentOutcome;
  });
}

/**
 * THE REPLAY: spend every required consent ONCE, right before any provider work. `null` = every consent was spent and
 * the call may run.
 *
 * ALL OR NOTHING (review #807 item 1). One transaction locks every consent row (`FOR UPDATE`, in id order so two
 * replays cannot deadlock), checks each one (still approved, unexpired on the database clock, the same payload and
 * policy context, its approving signatures), and only when every check passes marks them all consumed. If any check
 * fails, NO consent is spent: the failing consents are retired (superseded and audited), the others stay approved for
 * the next identical call, and the refusal's own `deny` decision row is written in the same transaction (item 2).
 * Losing the race (a second replay of the same approved call) runs nothing and spends nothing.
 */
export async function spendModelConsents(
  db: Db,
  input: {
    userId: string;
    target: ModelCallTarget;
    projectId: string | null;
    mode: string;
    state: ModelConsentState;
    /** the core's decision, named on the refusal's audit row */
    decision: GovernedResourceDecision;
  },
): Promise<ModelConsentOutcome | null> {
  const { signatureRecheckDenial, supersedeStaleConsent } = await import("./mcp-proxy.js");
  const toolName = modelToolName(input.target, input.mode);
  const bindings = input.state.bindings
    .filter((b): b is ModelConsentBinding & { approvedApprovalId: string } => b.approvedApprovalId !== null)
    .sort((a, b) => (a.approvedApprovalId < b.approvedApprovalId ? -1 : a.approvedApprovalId > b.approvedApprovalId ? 1 : 0));
  if (bindings.length === 0) return null;
  const ids = bindings.map((b) => b.approvedApprovalId);
  return db.transaction(async (tx) => {
    const refuse = async (outcome: Omit<ModelConsentOutcome, "auditLogId">): Promise<ModelConsentOutcome> => {
      const [row] = await tx
        .insert(auditLog)
        .values({
          userId: input.userId,
          objectType: "agent",
          objectId: input.target.agentId,
          detail: {
            phase: "governed-core",
            mode: input.mode,
            approvalId: outcome.approvalId ?? null,
            ...(input.projectId ? { projectId: input.projectId } : {}),
            matchedApprovalRuleIds: input.decision.matchedApprovalRuleIds,
            receiptClass: "decision",
          },
          effect: "deny",
          ruleId: outcome.ruleId,
          ruleChain: input.decision.ruleChain,
          reason: outcome.detail,
        })
        .returning({ id: auditLog.id });
      return { ...outcome, auditLogId: row?.id ?? null };
    };
    // a policy change cannot land between the checks and the spend (the epoch row is held shared)
    const [generation] = await tx.select({ epoch: governancePolicyEpoch.epoch }).from(governancePolicyEpoch).for("share");
    if (!generation) throw new Error("the governance policy epoch row is missing; refusing to spend a consent");
    const rows = await tx.select().from(approvals).where(inArray(approvals.id, ids)).orderBy(asc(approvals.id)).for("update");
    const live = new Set(
      (
        await tx
          .select({ id: approvals.id })
          .from(approvals)
          .where(and(inArray(approvals.id, ids), or(isNull(approvals.expiresAt), gt(approvals.expiresAt, sql`now()`))))
      ).map((r) => r.id),
    );
    const byId = new Map(rows.map((r) => [r.id, r]));
    // 1. freshness: still approved, unexpired, the same payload and policy context
    const stale: RetiredApproval[] = [];
    for (const b of bindings) {
      const row = byId.get(b.approvedApprovalId);
      if (!row || row.status !== "approved") {
        return refuse({
          ok: false,
          status: 409,
          error: "approval_consumed_race",
          approvalId: b.approvedApprovalId,
          ruleId: "approval-consumed-race",
          detail: `approval '${b.approvedApprovalId}' was already used by another call; nothing was sent and no other approval was spent`,
        });
      }
      if (!live.has(row.id)) stale.push({ id: row.id, reason: "expired" });
      else if (row.argumentsDigest !== b.argumentsDigest || row.contextDigest !== b.contextDigest) stale.push({ id: row.id, reason: "context_changed" });
    }
    if (stale.length) {
      await supersedeStaleConsent(tx, stale, { userId: input.userId, agent: { id: input.target.agentId, name: input.target.agentName }, projectId: input.projectId });
      const first = stale[0]!;
      const expired = first.reason === "expired";
      return refuse({
        ok: false,
        status: 409,
        error: expired ? "approval_expired" : "approval_context_stale",
        approvalId: first.id,
        ruleId: expired ? "approval-expired" : "approval-context-stale",
        detail:
          `approval '${first.id}' ${expired ? "expired before it was used" : "was granted under a policy that has since changed"}; ` +
          "nothing was sent and no other approval was spent — re-submit to raise a fresh one",
      });
    }
    // 2. the approving signatures, rechecked against this exact call (ADR-0186 B)
    for (const b of bindings) {
      const row = byId.get(b.approvedApprovalId)!;
      const call = { agentId: input.target.agentId, toolName, argumentsDigest: b.argumentsDigest, contextDigest: b.contextDigest };
      const recheck = await recheckApprovalSignatures(tx, row, call);
      if (!recheck.ok) {
        await supersedeOnRecheckFailure(tx, row, call, recheck);
        const denial = signatureRecheckDenial(row.id);
        return refuse({ ok: false, status: 403, error: "approval_signature_recheck_failed", approvalId: row.id, ruleId: denial.ruleId, detail: denial.reason });
      }
    }
    // 3. every check passed: spend them all, together
    const consumed = await tx
      .update(approvals)
      .set({ status: "consumed" })
      .where(and(inArray(approvals.id, ids), eq(approvals.status, "approved")))
      .returning({ id: approvals.id });
    if (consumed.length !== ids.length) throw new Error("a locked consent changed under its row lock; refusing the call");
    return null;
  });
}
