/**
 * ADR-0366 (lane E52) — ROGUE-AGENT CONTAINMENT (OWASP Agentic ASI10), the gateway half.
 *
 * When the governance monitor raises an episode that means "this agent acts outside its declared role"
 * (`containmentSignalFromAlert`), this module files ONE containment for it:
 *
 *   - below the org's threshold (`org_settings.containment_auto_severity`, 'critical' by default): the alert notifies
 *     as before, and a containment PROPOSAL is filed in the one Approvals Queue (objectType `agent_containment`) for
 *     the administrator the org names. An administrator approving it halts the agent; declining leaves it running.
 *   - at or above the threshold: the agent is halted AT ONCE, through ADR-0124's one halt (`haltAgentInTx`, or the
 *     builder agent's own halt below), and audited as automatic.
 *
 * OWNER DECISION 2026-11-21 (ADR-0366 addendum):
 *   1. the automatic halt runs on its own separate, fail-closed, audited path and does not wait for approval
 *      (`containOpenSignals`: every open signal episode without a containment is filed on every monitor pass, so a
 *      failed attempt is retried, never dropped);
 *   2. lifting a halt, or any wider containment action, needs approval. When no approver is named, approval falls
 *      back to the tenant's admins, with an MFA step-up (`routeApprover`, `containmentDecideStepUp`).
 *
 * Every containment is reversible only through that approval: `POST /v1/containments/:id/release` REQUESTS a release
 * (an admin, a reason, a `settings_relax` step-up, refused while the execution dial is not `normal`, because a release
 * widens access; ADR-0338 §7's guard), and a DIFFERENT administrator approves it in the Approvals Queue. A release
 * lifts the halt only when that halt was set by a containment and no other open containment holds the same agent, so
 * it never lifts a halt a person threw by hand.
 *
 *   GET  /v1/containments              list (admin), newest first, keyset-paginated
 *   GET  /v1/containments/:id          one containment, with its lifecycle (`CONTAINMENT_MACHINE.describe`)
 *   POST /v1/containments/:id/release  request a release (admin, step-up, audited); decided in the Approvals Queue
 *
 * The decision itself is pure (`decideContainmentAction` in @regulait/shared). The monitor calls `containOpenSignals`
 * after every pass; it runs under the `system_task` RLS reason because the containment is the platform acting,
 * whoever's request triggered the pass. Open-source comparison (ADR-0176) is in ADR-0366 §2: the trigger model
 * follows Falco Talon's and Wazuh active response's (a severity threshold selects an automatic response; everything
 * else is a notification), but neither is a library this process can call, and the action is our own halt.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  agentContainments,
  agents,
  and,
  approvals,
  asc,
  auditLog,
  builderAgents,
  desc,
  eq,
  governanceAlerts,
  inArray,
  isNull,
  lt,
  ne,
  notInArray,
  or,
  runWithRlsSystem,
  sql,
  users,
  virtualKeys,
  type AgentContainmentRow,
  type Db,
} from "@regulait/db";
import {
  CONTAINMENT_HALT_PREFIX,
  CONTAINMENT_MACHINE,
  CONTAINMENT_SIGNAL_RULES,
  CONTAINMENT_STATES,
  approvalArgumentsDigest,
  approvalArgumentsPreview,
  containmentSignalFromAlert,
  decideContainmentAction,
  killSwitchNarrowingOnly,
  type ContainmentAutoThreshold,
  type ContainmentSignal,
} from "@regulait/shared";
import { haltAgentInTx, type HaltActor } from "./execution-control.js";
import { loadOrgSettings } from "./org-settings.js";
import { checkStepUp, requireStepUp, type StepUpCheckArgs } from "./step-up.js";
import { errMessage } from "./err-serializer.js";

export const CONTAINMENT_APPROVAL_PREFIX = "agent-containment:";
export const CONTAINMENT_RELEASE_APPROVAL_PREFIX = "agent-containment-release:";
const NO_IDENTITY = "00000000-0000-0000-0000-000000000000";

/** distinct rule ids per event, so an operator alerts on each separately */
export const CONTAINMENT_RULE_IDS = {
  autoContained: "containment-auto-contained",
  proposed: "containment-proposed",
  unrouted: "containment-proposal-unrouted",
  approved: "containment-approved",
  declined: "containment-declined",
  releaseRequested: "containment-release-requested",
  releaseDenied: "containment-release-denied",
  released: "containment-released",
  failed: "containment-failed",
  builderAgentHalted: "execution-builder-agent-halted",
  virtualKeyHalted: "execution-virtual-key-halted",
} as const;

// ---------------------------------------------------------------------------
// the builder agent's halt (ADR-0124's agent halt, for one builder agent)
// ---------------------------------------------------------------------------

/**
 * Halt one builder agent INSIDE the caller's transaction, as `haltAgentInTx` does for a registry agent: locks the
 * row, writes nothing when it is already halted (idempotent), else sets the three halt columns and writes the
 * `execution-builder-agent-halted` audit row. Null for an unknown or archived agent.
 */
export async function haltBuilderAgentInTx(
  tx: Db,
  builderAgentId: string,
  reason: string,
  actor: HaltActor,
): Promise<{ changed: boolean; name: string } | null> {
  const [before] = await tx.select().from(builderAgents).where(eq(builderAgents.id, builderAgentId)).for("update");
  if (!before || before.archivedAt) return null;
  if (before.haltedAt) return { changed: false, name: before.name };
  await tx
    .update(builderAgents)
    .set({ haltedAt: new Date(), haltedReason: reason, haltedByUserId: actor.userId })
    .where(eq(builderAgents.id, builderAgentId));
  await tx.insert(auditLog).values({
    userId: actor.userId ?? NO_IDENTITY,
    objectType: "builder_agent",
    objectId: builderAgentId,
    detail: { via: actor.via, ...actor.detail, receiptClass: "configuration" },
    effect: "deny",
    ruleId: CONTAINMENT_RULE_IDS.builderAgentHalted,
    ruleChain: [],
    reason: `builder agent '${before.name}' HALTED: ${reason}`,
  });
  return { changed: true, name: before.name };
}

/**
 * ADR-0366 slice 2: halt one virtual key INSIDE the caller's transaction (reversible, unlike revocation). Locks the
 * row, idempotent, audited `execution-virtual-key-halted`. Null for an unknown or revoked key (nothing to contain).
 */
export async function haltVirtualKeyInTx(
  tx: Db,
  keyId: string,
  reason: string,
  actor: HaltActor,
): Promise<{ changed: boolean; name: string } | null> {
  const [before] = await tx.select().from(virtualKeys).where(eq(virtualKeys.id, keyId)).for("update");
  if (!before || before.revokedAt) return null;
  if (before.haltedAt) return { changed: false, name: before.name };
  await tx.update(virtualKeys).set({ haltedAt: new Date(), haltedReason: reason, haltedByUserId: actor.userId }).where(eq(virtualKeys.id, keyId));
  await tx.insert(auditLog).values({
    userId: actor.userId ?? NO_IDENTITY,
    objectType: "virtual_key",
    objectId: keyId,
    detail: { via: actor.via, ...actor.detail, receiptClass: "configuration" },
    effect: "deny",
    ruleId: CONTAINMENT_RULE_IDS.virtualKeyHalted,
    ruleChain: [],
    reason: `virtual key '${before.name}' HALTED: ${reason}`,
  });
  return { changed: true, name: before.name };
}

/** the subject id of a containment row, whatever its kind */
const subjectIdOf = (row: Pick<AgentContainmentRow, "agentId" | "builderAgentId" | "virtualKeyId">) =>
  (row.agentId ?? row.builderAgentId ?? row.virtualKeyId)!;

/** halt the containment's subject; null = the subject no longer exists */
async function haltSubject(
  tx: Db,
  row: Pick<AgentContainmentRow, "id" | "subjectKind" | "agentId" | "builderAgentId" | "virtualKeyId" | "explanation">,
  actor: HaltActor,
): Promise<{ changed: boolean } | null> {
  const reason = `${CONTAINMENT_HALT_PREFIX}${row.explanation}`.slice(0, 2000);
  const detail = { ...actor.detail, containmentId: row.id };
  if (row.subjectKind === "agent") {
    const r = await haltAgentInTx(tx, row.agentId!, reason, { ...actor, detail });
    return r ? { changed: r.changed } : null;
  }
  if (row.subjectKind === "virtual_key") {
    const r = await haltVirtualKeyInTx(tx, row.virtualKeyId!, reason, { ...actor, detail });
    return r ? { changed: r.changed } : null;
  }
  const r = await haltBuilderAgentInTx(tx, row.builderAgentId!, reason, { ...actor, detail });
  return r ? { changed: r.changed } : null;
}

/** the subject's steward (the person whose agent or key it is) and whether the subject exists */
async function subjectOf(db: Db, signal: Pick<ContainmentSignal, "subject">): Promise<{ exists: boolean; ownerUserId: string | null; label: string }> {
  if (signal.subject.kind === "virtual_key") {
    const [k] = await db
      .select({ name: virtualKeys.name, userId: virtualKeys.userId, revokedAt: virtualKeys.revokedAt })
      .from(virtualKeys)
      .where(eq(virtualKeys.id, signal.subject.id));
    return k && !k.revokedAt
      ? { exists: true, ownerUserId: k.userId, label: `virtual key '${k.name}'` }
      : { exists: false, ownerUserId: null, label: "" };
  }
  if (signal.subject.kind === "agent") {
    const [a] = await db.select({ name: agents.name, ownerUserId: agents.ownerUserId }).from(agents).where(eq(agents.id, signal.subject.id));
    return a ? { exists: true, ownerUserId: a.ownerUserId, label: `agent '${a.name}'` } : { exists: false, ownerUserId: null, label: "" };
  }
  const [b] = await db
    .select({ name: builderAgents.name, ownerUserId: builderAgents.ownerUserId, archivedAt: builderAgents.archivedAt })
    .from(builderAgents)
    .where(eq(builderAgents.id, signal.subject.id));
  return b && !b.archivedAt
    ? { exists: true, ownerUserId: b.ownerUserId, label: `builder agent '${b.name}'` }
    : { exists: false, ownerUserId: null, label: "" };
}

async function activeAdmin(db: Db, userId: string | null | undefined): Promise<boolean> {
  if (!userId) return false;
  const [u] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, userId), eq(users.isAdmin, true), isNull(users.disabledAt)));
  return !!u;
}

// ---------------------------------------------------------------------------
// routing: who decides (owner decision 2026-11-21: the named approver, else any active admin, with an MFA step-up)
// ---------------------------------------------------------------------------

/**
 * The approver a containment approval is ADDRESSED to: the org's named containment approver when that is an active
 * administrator outside `exclude`; otherwise (owner decision 2026-11-21) the queue falls back to the tenant's admins,
 * so it is addressed to the longest-serving active admin outside `exclude` and ANY other eligible admin may decide it
 * (the decide path's admin override, with its recorded reason, plus the MFA step-up below). Null when no eligible
 * admin exists at all.
 */
async function routeApprover(
  db: Db,
  named: string | null,
  exclude: readonly (string | null)[],
): Promise<{ approverUserId: string; fallback: boolean } | null> {
  const out = new Set(exclude.filter((x): x is string => !!x));
  if (named && !out.has(named) && (await activeAdmin(db, named))) return { approverUserId: named, fallback: false };
  const [first] = await db
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        eq(users.isAdmin, true),
        isNull(users.disabledAt),
        ne(users.id, NO_IDENTITY),
        ...(out.size ? [notInArray(users.id, [...out])] : []),
      ),
    )
    .orderBy(asc(users.createdAt), asc(users.id))
    .limit(1);
  return first ? { approverUserId: first.id, fallback: true } : null;
}

type ContainmentAction2 = "contain" | "release";
/** what the approver signs: the containment, the action and the subject (the MFA step-up is bound to its digest) */
const argumentsOf = (row: Pick<AgentContainmentRow, "id" | "subjectKind" | "agentId" | "builderAgentId" | "virtualKeyId">, action: ContainmentAction2) => ({
  op: "agent_containment",
  action,
  containmentId: row.id,
  subjectKind: row.subjectKind,
  subjectId: subjectIdOf(row),
});
const digestOf = (args: ReturnType<typeof argumentsOf>) => approvalArgumentsDigest({ projectId: null, arguments: args });
/** the approver's MFA step-up: bound to the approval, the decision and the digest of what will run */
export const containmentDecideStepUp = (approvalId: string, decision: "approved" | "denied", argumentsDigest: string): StepUpCheckArgs => ({
  kind: "approval_decide",
  facts: { op: "agent_containment", approvalId, decision, argumentsDigest },
});

// ---------------------------------------------------------------------------
// filing: from an open monitor episode to a containment (the automatic path is separate, fail-closed and audited)
// ---------------------------------------------------------------------------

export interface ContainmentPassResult {
  autoContained: number;
  proposed: number;
  unrouted: number;
  skipped: number;
  failed: number;
}

/**
 * THE MONITOR'S HOOK, every pass: every OPEN episode of a containment-signal rule that has no containment yet is filed
 * now. Owner decision 2026-11-21: the automatic halt runs on its own path and does not wait for approval, and it is
 * FAIL-CLOSED: a signal whose filing fails (a lost connection, a lock timeout) is audited `containment-failed` and is
 * still unfiled, so the next pass files it again; nothing is ever dropped because one attempt failed. Runs under
 * `system_task`: the containment is the platform acting, whoever's request ran the pass.
 */
export async function containOpenSignals(db: Db, now = new Date()): Promise<ContainmentPassResult> {
  return runWithRlsSystem("system_task", "rogue-containment.open", async () => {
    const open = await db
      .select({ id: governanceAlerts.id })
      .from(governanceAlerts)
      .leftJoin(
        agentContainments,
        and(eq(agentContainments.signalSource, "monitor"), eq(agentContainments.signalRefId, sql`${governanceAlerts.id}::text`)),
      )
      .where(
        and(
          ne(governanceAlerts.status, "resolved"),
          inArray(governanceAlerts.ruleId, [...CONTAINMENT_SIGNAL_RULES]),
          isNull(agentContainments.id),
        ),
      )
      .orderBy(asc(governanceAlerts.firstDetectedAt))
      .limit(500);
    return containAlerts(db, open.map((a) => a.id), now);
  });
}

/** File the containments for these episodes (unique per signal, so a concurrent pass files nothing twice). */
export async function containAlerts(db: Db, alertIds: readonly string[], now = new Date()): Promise<ContainmentPassResult> {
  const out: ContainmentPassResult = { autoContained: 0, proposed: 0, unrouted: 0, skipped: 0, failed: 0 };
  if (alertIds.length === 0) return out;
  return runWithRlsSystem("system_task", "rogue-containment.pass", async () => {
    const alerts = await db
      .select({ id: governanceAlerts.id, ruleId: governanceAlerts.ruleId, subjectKey: governanceAlerts.subjectKey, severity: governanceAlerts.severity, detail: governanceAlerts.detail })
      .from(governanceAlerts)
      .where(inArray(governanceAlerts.id, [...alertIds]));
    const signals = alerts
      .map((a) => ({ alertId: a.id, signal: containmentSignalFromAlert({ ...a, detail: (a.detail ?? {}) as Record<string, unknown> }) }))
      .filter((s): s is { alertId: string; signal: ContainmentSignal } => s.signal !== null);
    if (signals.length === 0) return out;
    // the policy is read once per pass; a failed read fails the pass (audited by the caller) and every signal stays
    // unfiled for the next pass, never filed under a guessed threshold
    const settings = await loadOrgSettings(db);
    const threshold = settings.containmentAutoSeverity as ContainmentAutoThreshold;
    for (const { alertId, signal } of signals) {
      try {
        const r = await fileContainment(db, signal, { alertId, threshold, approverUserId: settings.containmentApproverUserId ?? null, now });
        out[r] += 1;
      } catch (err) {
        out.failed += 1;
        await db
          .insert(auditLog)
          .values({
            userId: NO_IDENTITY,
            objectType: "agent_containment",
            objectId: null,
            detail: { alertId, signal: { ruleId: signal.source.ruleId, refId: signal.source.refId }, subject: signal.subject, severity: signal.severity, error: errMessage(err).slice(0, 500) },
            effect: "deny",
            ruleId: CONTAINMENT_RULE_IDS.failed,
            ruleChain: [],
            reason: `containment of ${signal.subject.kind} ${signal.subject.id} could not be filed; it stays unfiled and the next monitor pass files it again`,
          })
          .catch(() => undefined);
      }
    }
    return out;
  });
}

/**
 * File one containment for one signal. Public so a later producer (behaviour baselines, lane E40) files through the
 * same path; it must already run under `system_task` or an admin principal. Throws when it cannot file (the caller
 * audits and the signal is retried); returns `skipped` only for a subject that no longer exists or a signal already
 * filed.
 */
export async function fileContainment(
  db: Db,
  signal: ContainmentSignal,
  ctx: { alertId: string | null; threshold: ContainmentAutoThreshold; approverUserId: string | null; now: Date },
): Promise<Exclude<keyof ContainmentPassResult, "failed">> {
  const subject = await subjectOf(db, signal);
  if (!subject.exists) return "skipped";
  const action = decideContainmentAction(signal.severity, ctx.threshold);
  const subjectCols =
    signal.subject.kind === "agent"
      ? { agentId: signal.subject.id }
      : signal.subject.kind === "virtual_key"
        ? { virtualKeyId: signal.subject.id }
        : { builderAgentId: signal.subject.id };
  const baseDetail = {
    signal: { source: signal.source.kind, ruleId: signal.source.ruleId, refId: signal.source.refId },
    subject: signal.subject,
    severity: signal.severity,
    threshold: ctx.threshold,
    alertId: ctx.alertId,
  };

  return db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const [row] = await tx
      .insert(agentContainments)
      .values({
        subjectKind: signal.subject.kind,
        ...subjectCols,
        signalSource: signal.source.kind,
        signalRuleId: signal.source.ruleId,
        signalRefId: signal.source.refId,
        alertId: ctx.alertId,
        severity: signal.severity,
        thresholdAtDecision: ctx.threshold,
        automatic: action === "auto_contain",
        status: action === "auto_contain" ? "contained" : "proposed",
        containedAt: action === "auto_contain" ? ctx.now : null,
        explanation: signal.explanation.slice(0, 1000),
        evidence: { ...signal.evidence },
      })
      .onConflictDoNothing()
      .returning();
    if (!row) return "skipped"; // a concurrent pass filed this signal first

    if (action === "auto_contain") {
      // the separate automatic path: no approval, one transaction, audited; a failure rolls the row back too
      const halted = await haltSubject(tx, row, { userId: null, detail: { automatic: true, alertId: ctx.alertId } });
      if (!halted) throw new Error("containment subject vanished inside the transaction");
      await tx.update(agentContainments).set({ haltApplied: halted.changed }).where(eq(agentContainments.id, row.id));
      await tx.insert(auditLog).values({
        userId: NO_IDENTITY,
        objectType: "agent_containment",
        objectId: row.id,
        detail: { ...baseDetail, automatic: true, haltApplied: halted.changed },
        effect: "deny",
        ruleId: CONTAINMENT_RULE_IDS.autoContained,
        ruleChain: [],
        reason: `${subject.label} CONTAINED automatically (${signal.severity} at threshold ${ctx.threshold}): ${row.explanation}`,
      });
      return "autoContained";
    }

    // a proposal: the requester is the agent's steward (the person whose work it gates), who may never decide it.
    // Routed to the named approver, else to the tenant's admins. Unrouted only when the agent has no steward (the
    // queue row needs a requester) or no eligible admin exists; the alert still notifies either way.
    const route = subject.ownerUserId ? await routeApprover(tx, ctx.approverUserId, [subject.ownerUserId]) : null;
    if (!route) {
      await tx.insert(auditLog).values({
        userId: NO_IDENTITY,
        objectType: "agent_containment",
        objectId: row.id,
        detail: { ...baseDetail, why: subject.ownerUserId === null ? "agent_has_no_steward" : "no_eligible_admin" },
        effect: "require_approval",
        ruleId: CONTAINMENT_RULE_IDS.unrouted,
        ruleChain: [],
        reason: `containment of ${subject.label} proposed but not routed: ${subject.ownerUserId === null ? "the agent has no steward" : "no active administrator other than its steward"}`,
      });
      return "unrouted";
    }
    const args = argumentsOf(row, "contain");
    const [approval] = await tx
      .insert(approvals)
      .values({
        userId: subject.ownerUserId!,
        objectType: "agent_containment",
        approverUserId: route.approverUserId,
        stageId: `${CONTAINMENT_APPROVAL_PREFIX}${row.id}`,
        argumentsDigest: digestOf(args),
        argumentsPreview: approvalArgumentsPreview({ ...args }),
        argumentsPreviewKind: "arguments_v1",
      })
      .returning({ id: approvals.id });
    await tx.update(agentContainments).set({ approvalId: approval!.id }).where(eq(agentContainments.id, row.id));
    await tx.insert(auditLog).values({
      userId: NO_IDENTITY,
      objectType: "agent_containment",
      objectId: row.id,
      detail: { ...baseDetail, approvalId: approval!.id, approverUserId: route.approverUserId, adminFallback: route.fallback },
      effect: "require_approval",
      ruleId: CONTAINMENT_RULE_IDS.proposed,
      ruleChain: [],
      reason: `containment of ${subject.label} proposed for approval (${signal.severity}${route.fallback ? ", routed to the tenant's admins" : ""}): ${row.explanation}`,
    });
    return "proposed";
  });
}

// ---------------------------------------------------------------------------
// the decide path's two hooks (POST /v1/approvals/:approvalId/decide), for both kinds of containment approval
// ---------------------------------------------------------------------------

async function approvalTarget(db: Db, approvalId: string): Promise<{ row: AgentContainmentRow; action: ContainmentAction2 } | null> {
  const [row] = await db
    .select()
    .from(agentContainments)
    .where(or(eq(agentContainments.approvalId, approvalId), eq(agentContainments.releaseApprovalId, approvalId)));
  if (!row) return null;
  return { row, action: row.releaseApprovalId === approvalId ? "release" : "contain" };
}

async function stewardOf(db: Db, row: Pick<AgentContainmentRow, "subjectKind" | "agentId" | "builderAgentId" | "virtualKeyId">): Promise<string | null> {
  if (row.subjectKind === "virtual_key") {
    const [k] = await db.select({ o: virtualKeys.userId }).from(virtualKeys).where(eq(virtualKeys.id, row.virtualKeyId!));
    return k?.o ?? null;
  }
  if (row.subjectKind === "agent") {
    const [a] = await db.select({ o: agents.ownerUserId }).from(agents).where(eq(agents.id, row.agentId!));
    return a?.o ?? null;
  }
  const [b] = await db.select({ o: builderAgents.ownerUserId }).from(builderAgents).where(eq(builderAgents.id, row.builderAgentId!));
  return b?.o ?? null;
}

type ApprovalLike = { id: string; argumentsDigest?: string | null };
type Refusal = { status: number; body: Record<string, unknown> };

/**
 * Refused BY NAME before anything is written: only an active administrator decides; never the agent's steward;
 * never the admin who asked for a release; a release is approved only while the execution dial is `normal` (it widens
 * access, ADR-0338 §7); and every decision carries an MFA `approval_decide` step-up bound to {approval, decision,
 * digest} (owner decision 2026-11-21), checked here without being spent.
 */
export async function precheckContainmentDecision(
  db: Db,
  approval: ApprovalLike,
  deciderUserId: string,
  decision: "approved" | "denied",
  req: FastifyRequest | undefined,
): Promise<Refusal | null> {
  const t = await approvalTarget(db, approval.id);
  if (!t) return { status: 409, body: { error: "containment_not_found", detail: "this approval names no containment" } };
  const { row, action } = t;
  if (!(await activeAdmin(db, deciderUserId))) {
    return { status: 403, body: { error: "not_an_eligible_approver", detail: "a rogue-agent containment is decided by an active administrator" } };
  }
  if ((await stewardOf(db, row)) === deciderUserId) {
    return {
      status: 403,
      body: { error: "cannot_decide_own_agent_containment", detail: "the decider is this agent's steward; another administrator must decide it" },
    };
  }
  if (action === "release") {
    if (row.releaseRequestedByUserId === deciderUserId) {
      return { status: 403, body: { error: "cannot_approve_own_release", detail: "the decider asked for this release; another administrator must decide it" } };
    }
    if (!CONTAINMENT_MACHINE.can(row.status, "approve_release")) return { status: 409, body: { error: "release_not_pending", status: row.status } };
    if (decision === "approved") {
      const guard = killSwitchNarrowingOnly({ dial: (await loadOrgSettings(db)).executionMode as "normal", direction: "widening" });
      if (guard) return { status: 409, body: { error: "execution_dial_not_normal", detail: guard } };
    }
  } else {
    if (!CONTAINMENT_MACHINE.can(row.status, "approve")) return { status: 409, body: { error: "containment_not_pending", status: row.status } };
    const subject = await subjectOf(db, { subject: { kind: row.subjectKind, id: subjectIdOf(row) } });
    if (!subject.exists) {
      return { status: 409, body: { error: "containment_subject_gone", detail: "the agent this containment names is archived or no longer exists" } };
    }
  }
  if (!req) return { status: 403, body: { error: "step_up_required", actionKind: "approval_decide", methods: [], detail: "decide a containment from the approval itself, confirming it is you" } };
  if (!approval.argumentsDigest) return { status: 409, body: { error: "approval_unbound", detail: "this approval carries no arguments digest" } };
  const su = await checkStepUp(db, req, containmentDecideStepUp(approval.id, decision, approval.argumentsDigest), { spend: false });
  if (!su.ok) return { status: su.status, body: su.body };
  return null;
}

/** the decision's own failure inside its transaction: the whole decision rolls back */
export class ContainmentDecideError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string) {
    super(message);
    this.name = "ContainmentDecideError";
  }
}

/** inside the decision's transaction; the approver's step-up is spent here, with the writes */
export async function applyContainmentDecision(
  tx: Db,
  approval: ApprovalLike,
  decision: "approved" | "denied",
  deciderUserId: string,
  req: FastifyRequest | undefined,
): Promise<void> {
  const [row] = await tx
    .select()
    .from(agentContainments)
    .where(or(eq(agentContainments.approvalId, approval.id), eq(agentContainments.releaseApprovalId, approval.id)))
    .for("update");
  if (!row) return;
  const action: ContainmentAction2 = row.releaseApprovalId === approval.id ? "release" : "contain";
  if (!req || !approval.argumentsDigest) throw new ContainmentDecideError(403, "step_up_required", "a containment decision needs the approver's step-up");
  const su = await checkStepUp(tx, req, containmentDecideStepUp(approval.id, decision, approval.argumentsDigest), { spend: true });
  if (!su.ok) throw new ContainmentDecideError(su.status, String(su.body.error ?? "step_up_required"), "the approver's step-up was not accepted");
  const now = new Date();
  const signal = { ruleId: row.signalRuleId, refId: row.signalRefId };
  const audit = (ruleId: string, effect: "allow" | "deny", reason: string, detail: Record<string, unknown> = {}) =>
    tx.insert(auditLog).values({
      userId: deciderUserId,
      objectType: "agent_containment",
      objectId: row.id,
      detail: { approvalId: approval.id, severity: row.severity, signal, stepUp: su.method, ...detail },
      effect,
      ruleId,
      ruleChain: [],
      reason,
    });

  if (action === "contain") {
    if (decision === "denied") {
      await tx
        .update(agentContainments)
        .set({ status: CONTAINMENT_MACHINE.next(row.status, "decline"), decidedByUserId: deciderUserId, decidedAt: now })
        .where(and(eq(agentContainments.id, row.id), inArray(agentContainments.status, [...CONTAINMENT_MACHINE.sourcesOf("decline")])));
      await audit(CONTAINMENT_RULE_IDS.declined, "allow", `containment declined: ${row.explanation}`);
      return;
    }
    const halted = await haltSubject(tx, row, { userId: deciderUserId, detail: { approvalId: approval.id } });
    if (!halted) throw new ContainmentDecideError(409, "containment_subject_gone", "the agent this containment names no longer exists");
    await tx
      .update(agentContainments)
      .set({ status: CONTAINMENT_MACHINE.next(row.status, "approve"), containedAt: now, haltApplied: halted.changed, decidedByUserId: deciderUserId, decidedAt: now })
      .where(and(eq(agentContainments.id, row.id), inArray(agentContainments.status, [...CONTAINMENT_MACHINE.sourcesOf("approve")])));
    await audit(CONTAINMENT_RULE_IDS.approved, "deny", `containment approved, agent halted: ${row.explanation}`, { haltApplied: halted.changed });
    return;
  }

  // a release
  if (decision === "denied") {
    await tx
      .update(agentContainments)
      .set({ status: CONTAINMENT_MACHINE.next(row.status, "deny_release"), releaseRequestedAt: null, releaseRequestedByUserId: null, releaseReason: null, releaseApprovalId: null })
      .where(and(eq(agentContainments.id, row.id), inArray(agentContainments.status, [...CONTAINMENT_MACHINE.sourcesOf("deny_release")])));
    await audit(CONTAINMENT_RULE_IDS.releaseDenied, "deny", `containment release refused; the agent stays halted (asked: ${row.releaseReason})`, {
      requestedByUserId: row.releaseRequestedByUserId,
    });
    return;
  }
  // the dial is read again under the decision's lock: a halt thrown since the precheck refuses the release
  const guard = killSwitchNarrowingOnly({ dial: (await loadOrgSettings(tx)).executionMode as "normal", direction: "widening" });
  if (guard) throw new ContainmentDecideError(409, "execution_dial_not_normal", guard);
  const lift = await liftContainmentHalt(tx, row);
  await tx
    .update(agentContainments)
    .set({ status: CONTAINMENT_MACHINE.next(row.status, "approve_release"), releasedAt: now, releasedByUserId: deciderUserId })
    .where(and(eq(agentContainments.id, row.id), inArray(agentContainments.status, [...CONTAINMENT_MACHINE.sourcesOf("approve_release")])));
  await audit(
    CONTAINMENT_RULE_IDS.released,
    "allow",
    `containment released${lift.haltLifted ? ", halt lifted" : lift.heldByOther ? ", halt kept: another containment holds this agent" : ", halt kept: it was not set by a containment"}: ${row.releaseReason}`,
    { haltLifted: lift.haltLifted, heldByOther: lift.heldByOther, requestedByUserId: row.releaseRequestedByUserId, receiptClass: "configuration" },
  );
}

/**
 * Lift the halt a released containment held, ONLY when the current halt was set by a containment (its reason carries
 * the prefix) and no other open containment (contained or release pending) still holds the same agent. A halt a person
 * threw by hand is never lifted here.
 */
async function liftContainmentHalt(tx: Db, row: AgentContainmentRow): Promise<{ haltLifted: boolean; heldByOther: string | null }> {
  const subjectWhere =
    row.subjectKind === "agent"
      ? eq(agentContainments.agentId, row.agentId!)
      : row.subjectKind === "virtual_key"
        ? eq(agentContainments.virtualKeyId, row.virtualKeyId!)
        : eq(agentContainments.builderAgentId, row.builderAgentId!);
  const [other] = await tx
    .select({ id: agentContainments.id })
    .from(agentContainments)
    .where(and(subjectWhere, inArray(agentContainments.status, ["contained", "release_pending"]), ne(agentContainments.id, row.id)))
    .limit(1);
  if (other) return { haltLifted: false, heldByOther: other.id };
  if (row.subjectKind === "agent") {
    const [a] = await tx.select({ r: agents.haltedReason }).from(agents).where(eq(agents.id, row.agentId!)).for("update");
    if (!a?.r?.startsWith(CONTAINMENT_HALT_PREFIX)) return { haltLifted: false, heldByOther: null };
    await tx.update(agents).set({ haltedAt: null, haltedReason: null, haltedByUserId: null }).where(eq(agents.id, row.agentId!));
    return { haltLifted: true, heldByOther: null };
  }
  if (row.subjectKind === "virtual_key") {
    const [k] = await tx.select({ r: virtualKeys.haltedReason }).from(virtualKeys).where(eq(virtualKeys.id, row.virtualKeyId!)).for("update");
    if (!k?.r?.startsWith(CONTAINMENT_HALT_PREFIX)) return { haltLifted: false, heldByOther: null };
    await tx.update(virtualKeys).set({ haltedAt: null, haltedReason: null, haltedByUserId: null }).where(eq(virtualKeys.id, row.virtualKeyId!));
    return { haltLifted: true, heldByOther: null };
  }
  const [b] = await tx.select({ r: builderAgents.haltedReason }).from(builderAgents).where(eq(builderAgents.id, row.builderAgentId!)).for("update");
  if (!b?.r?.startsWith(CONTAINMENT_HALT_PREFIX)) return { haltLifted: false, heldByOther: null };
  await tx.update(builderAgents).set({ haltedAt: null, haltedReason: null, haltedByUserId: null }).where(eq(builderAgents.id, row.builderAgentId!));
  return { haltLifted: true, heldByOther: null };
}

/** the approvals queue's label for each containment approval (a containment proposal or a release request) */
export async function containmentApprovalLabels(db: Db, stageIds: readonly (string | null)[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const parse = (prefix: string) =>
    stageIds
      .filter((s): s is string => !!s?.startsWith(prefix))
      .map((s) => s.slice(prefix.length))
      .filter((s) => /^[0-9a-f-]{36}$/i.test(s));
  const contain = parse(CONTAINMENT_APPROVAL_PREFIX);
  const release = parse(CONTAINMENT_RELEASE_APPROVAL_PREFIX);
  const ids = [...new Set([...contain, ...release])];
  if (ids.length === 0) return out;
  const rows = await db
    .select({ id: agentContainments.id, severity: agentContainments.severity, explanation: agentContainments.explanation })
    .from(agentContainments)
    .where(inArray(agentContainments.id, ids));
  for (const r of rows) {
    out.set(`${CONTAINMENT_APPROVAL_PREFIX}${r.id}`, `contain (halt), ${r.severity}: ${r.explanation}`);
    out.set(`${CONTAINMENT_RELEASE_APPROVAL_PREFIX}${r.id}`, `release a containment (lift the halt), ${r.severity}: ${r.explanation}`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// routes
// ---------------------------------------------------------------------------

const idParam = z.object({ id: z.string().uuid() });
const listQuery = z
  .object({
    status: z.enum(CONTAINMENT_STATES).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    /** keyset cursor: the `next` value of the previous page */
    before: z.string().max(200).optional(),
  })
  .strict();
const releaseBody = z
  .object({
    reason: z
      .string()
      .trim()
      .min(10, "state why it is safe to resume in at least a few words — this is the record of the release")
      .max(2000),
  })
  .strict();

/** the requester's step-up for a release request: bound to the containment */
export const containmentReleaseRequestStepUp = (containmentId: string): StepUpCheckArgs => ({
  kind: "settings_relax",
  facts: { containmentId, values: { released: true } },
});

const serialize = (r: AgentContainmentRow) => ({
  id: r.id,
  subject: { kind: r.subjectKind, id: subjectIdOf(r) },
  signal: { source: r.signalSource, ruleId: r.signalRuleId, refId: r.signalRefId },
  alertId: r.alertId,
  severity: r.severity,
  thresholdAtDecision: r.thresholdAtDecision,
  automatic: r.automatic,
  status: r.status,
  explanation: r.explanation,
  evidence: r.evidence,
  approvalId: r.approvalId,
  unrouted: r.status === "proposed" && r.approvalId === null,
  haltApplied: r.haltApplied,
  containedAt: r.containedAt?.toISOString() ?? null,
  decidedByUserId: r.decidedByUserId,
  decidedAt: r.decidedAt?.toISOString() ?? null,
  releaseRequestedByUserId: r.releaseRequestedByUserId,
  releaseRequestedAt: r.releaseRequestedAt?.toISOString() ?? null,
  releaseApprovalId: r.releaseApprovalId,
  releasedByUserId: r.releasedByUserId,
  releasedAt: r.releasedAt?.toISOString() ?? null,
  releaseReason: r.releaseReason,
  createdAt: r.createdAt.toISOString(),
});

const cursorOf = (r: AgentContainmentRow) => `${r.createdAt.toISOString()}_${r.id}`;
function parseCursor(c: string): { at: Date; id: string } | null {
  const i = c.lastIndexOf("_");
  if (i < 0) return null;
  const at = new Date(c.slice(0, i));
  const id = c.slice(i + 1);
  return Number.isNaN(at.getTime()) || !/^[0-9a-f-]{36}$/i.test(id) ? null : { at, id };
}

/** Admin-only through the default gate (none is in NON_ADMIN_ROUTES). */
export function registerContainmentRoutes(app: FastifyInstance, db: Db): void {
  app.get("/v1/containments", async (req, reply) => {
    const q = listQuery.parse(req.query);
    const cursor = q.before ? parseCursor(q.before) : null;
    if (q.before && !cursor) return reply.status(400).send({ error: "invalid_cursor" });
    const rows = await db
      .select()
      .from(agentContainments)
      .where(
        and(
          q.status ? eq(agentContainments.status, q.status) : undefined,
          cursor
            ? or(lt(agentContainments.createdAt, cursor.at), and(eq(agentContainments.createdAt, cursor.at), lt(agentContainments.id, cursor.id)))
            : undefined,
        ),
      )
      .orderBy(desc(agentContainments.createdAt), desc(agentContainments.id))
      .limit(q.limit + 1);
    const page = rows.slice(0, q.limit);
    return {
      containments: page.map(serialize),
      next: rows.length > q.limit ? cursorOf(page[page.length - 1]!) : null,
    };
  });

  app.get("/v1/containments/:id", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const [row] = await db.select().from(agentContainments).where(eq(agentContainments.id, id));
    if (!row) return reply.status(404).send({ error: "not_found" });
    return { containment: serialize(row), lifecycle: CONTAINMENT_MACHINE.describe(row.status) };
  });

  /**
   * Owner decision 2026-11-21: lifting a containment needs approval. This route REQUESTS the release (an admin, a
   * reason, a `settings_relax` step-up, refused while the dial is not `normal`); it files a release approval for the
   * named approver, else the tenant's admins, excluding the requester and the agent's steward. The agent stays halted
   * until a different administrator approves it with an MFA step-up.
   */
  app.post("/v1/containments/:id/release", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const body = releaseBody.parse(req.body);
    const actorUserId = req.authCtx.userId ?? null;
    if (!actorUserId) return reply.status(403).send({ error: "identity_required", detail: "a release request records who asked for it" });
    const [held] = await db.select().from(agentContainments).where(eq(agentContainments.id, id));
    if (!held) return reply.status(404).send({ error: "not_found" });
    if (!CONTAINMENT_MACHINE.can(held.status, "request_release")) {
      return reply.status(409).send({ error: "not_contained", lifecycle: CONTAINMENT_MACHINE.describe(held.status) });
    }
    // a release gives access back: refused while the execution dial is not `normal` (ADR-0338 §7's shared guard)
    const settings = await loadOrgSettings(db);
    const guard = killSwitchNarrowingOnly({ dial: settings.executionMode as "normal", direction: "widening" });
    if (guard) return reply.status(409).send({ error: "execution_dial_not_normal", detail: guard });
    const steward = await stewardOf(db, held);
    const route = await routeApprover(db, settings.containmentApproverUserId ?? null, [actorUserId, steward]);
    if (!route) {
      return reply.status(409).send({
        error: "no_eligible_approver",
        detail: "a release is approved by a different administrator than the requester and the agent's steward; there is none",
      });
    }
    const su = await requireStepUp(db, req, reply, containmentReleaseRequestStepUp(id));
    if (!su.ok) return;

    const result = await db.transaction(async (txRaw) => {
      const tx = txRaw as unknown as Db;
      const [row] = await tx.select().from(agentContainments).where(eq(agentContainments.id, id)).for("update");
      if (!row || !CONTAINMENT_MACHINE.can(row.status, "request_release")) return null;
      const args = argumentsOf(row, "release");
      const [approval] = await tx
        .insert(approvals)
        .values({
          userId: actorUserId,
          objectType: "agent_containment",
          approverUserId: route.approverUserId,
          stageId: `${CONTAINMENT_RELEASE_APPROVAL_PREFIX}${row.id}`,
          argumentsDigest: digestOf(args),
          argumentsPreview: approvalArgumentsPreview({ ...args }),
          argumentsPreviewKind: "arguments_v1",
        })
        .returning({ id: approvals.id });
      const [updated] = await tx
        .update(agentContainments)
        .set({
          status: CONTAINMENT_MACHINE.next(row.status, "request_release"),
          releaseRequestedAt: new Date(),
          releaseRequestedByUserId: actorUserId,
          releaseReason: body.reason,
          releaseApprovalId: approval!.id,
        })
        .where(and(eq(agentContainments.id, id), inArray(agentContainments.status, [...CONTAINMENT_MACHINE.sourcesOf("request_release")])))
        .returning();
      await tx.insert(auditLog).values({
        userId: actorUserId,
        objectType: "agent_containment",
        objectId: id,
        detail: { via: req.authCtx.via, approvalId: approval!.id, approverUserId: route.approverUserId, adminFallback: route.fallback, stepUp: su.method },
        effect: "require_approval",
        ruleId: CONTAINMENT_RULE_IDS.releaseRequested,
        ruleChain: [],
        reason: `containment release requested; the agent stays halted until another administrator approves it: ${body.reason}`,
      });
      return updated!;
    });
    if (!result) return reply.status(409).send({ error: "not_contained" });
    return reply.status(202).send({ containment: serialize(result), approvalId: result.releaseApprovalId, lifecycle: CONTAINMENT_MACHINE.describe(result.status) });
  });
}
