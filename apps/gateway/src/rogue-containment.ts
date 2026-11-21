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
 * Every containment is reversible by an administrator only: `POST /v1/containments/:id/release` (a reason, a
 * `settings_relax` step-up, refused while the execution dial is not `normal`, because a release widens access;
 * ADR-0338 §7's guard). A release lifts the halt only when that halt was set by a containment and no other open
 * containment holds the same agent, so it never lifts a halt a person threw by hand.
 *
 *   GET  /v1/containments              list (admin), newest first, keyset-paginated
 *   GET  /v1/containments/:id          one containment, with its lifecycle (`CONTAINMENT_MACHINE.describe`)
 *   POST /v1/containments/:id/release  release (admin, step-up, audited)
 *
 * The decision itself is pure (`decideContainmentAction` in @regulait/shared). The monitor calls `containRaisedAlerts`
 * after a pass raises episodes; it runs under the `system_task` RLS reason because the containment is the platform
 * acting, whoever's request triggered the pass. Open-source comparison (ADR-0176) is in ADR-0366 §2: the trigger model
 * follows Falco Talon's and Wazuh active response's (a severity threshold selects an automatic response; everything
 * else is a notification), but neither is a library this process can call, and the action is our own halt.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  agentContainments,
  agents,
  and,
  approvals,
  auditLog,
  builderAgents,
  desc,
  eq,
  governanceAlerts,
  inArray,
  isNull,
  lt,
  ne,
  or,
  runWithRlsSystem,
  users,
  type AgentContainmentRow,
  type Db,
} from "@regulait/db";
import {
  CONTAINMENT_HALT_PREFIX,
  CONTAINMENT_MACHINE,
  CONTAINMENT_STATES,
  containmentSignalFromAlert,
  decideContainmentAction,
  killSwitchNarrowingOnly,
  type ContainmentAutoThreshold,
  type ContainmentSignal,
} from "@regulait/shared";
import { haltAgentInTx, type HaltActor } from "./execution-control.js";
import { loadOrgSettings } from "./org-settings.js";
import { requireStepUp } from "./step-up.js";

export const CONTAINMENT_APPROVAL_PREFIX = "agent-containment:";
const NO_IDENTITY = "00000000-0000-0000-0000-000000000000";

/** distinct rule ids per event, so an operator alerts on each separately */
export const CONTAINMENT_RULE_IDS = {
  autoContained: "containment-auto-contained",
  proposed: "containment-proposed",
  unrouted: "containment-proposal-unrouted",
  approved: "containment-approved",
  declined: "containment-declined",
  released: "containment-released",
  failed: "containment-failed",
  builderAgentHalted: "execution-builder-agent-halted",
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

/** halt the containment's subject; null = the subject no longer exists */
async function haltSubject(
  tx: Db,
  row: Pick<AgentContainmentRow, "id" | "subjectKind" | "agentId" | "builderAgentId" | "explanation">,
  actor: HaltActor,
): Promise<{ changed: boolean } | null> {
  const reason = `${CONTAINMENT_HALT_PREFIX}${row.explanation}`.slice(0, 2000);
  const detail = { ...actor.detail, containmentId: row.id };
  if (row.subjectKind === "agent") {
    const r = await haltAgentInTx(tx, row.agentId!, reason, { ...actor, detail });
    return r ? { changed: r.changed } : null;
  }
  const r = await haltBuilderAgentInTx(tx, row.builderAgentId!, reason, { ...actor, detail });
  return r ? { changed: r.changed } : null;
}

/** the subject's steward (the person whose agent it is) and whether the subject exists */
async function subjectOf(db: Db, signal: Pick<ContainmentSignal, "subject">): Promise<{ exists: boolean; ownerUserId: string | null; label: string }> {
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
// filing: from a raised monitor episode to a containment
// ---------------------------------------------------------------------------

export interface ContainmentPassResult {
  autoContained: number;
  proposed: number;
  unrouted: number;
  skipped: number;
}

/**
 * Called by the monitor for the episodes a pass newly RAISED. Each one that maps to a containment signal files one
 * containment (unique per signal, so a concurrent pass files nothing twice). Runs under `system_task`.
 */
export async function containRaisedAlerts(db: Db, alertIds: readonly string[], now = new Date()): Promise<ContainmentPassResult> {
  const out: ContainmentPassResult = { autoContained: 0, proposed: 0, unrouted: 0, skipped: 0 };
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
    const settings = await loadOrgSettings(db);
    const threshold = settings.containmentAutoSeverity as ContainmentAutoThreshold;
    for (const { alertId, signal } of signals) {
      const r = await fileContainment(db, signal, { alertId, threshold, approverUserId: settings.containmentApproverUserId ?? null, now });
      out[r] += 1;
    }
    return out;
  });
}

/**
 * File one containment for one signal. Public so a later producer (behaviour baselines, lane E40) files through the
 * same path; it must already run under `system_task` or an admin principal.
 */
export async function fileContainment(
  db: Db,
  signal: ContainmentSignal,
  ctx: { alertId: string | null; threshold: ContainmentAutoThreshold; approverUserId: string | null; now: Date },
): Promise<keyof ContainmentPassResult> {
  const subject = await subjectOf(db, signal);
  if (!subject.exists) return "skipped";
  const action = decideContainmentAction(signal.severity, ctx.threshold);
  const subjectCols = signal.subject.kind === "agent" ? { agentId: signal.subject.id } : { builderAgentId: signal.subject.id };
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

    // a proposal goes to the org's named administrator; the approval's requester is the agent's steward (the person
    // whose work it gates). Unrouted when no approver is named, the approver is no longer an active admin, the agent
    // has no steward, or the approver IS the steward (who may not decide a containment of their own agent).
    const routable =
      ctx.approverUserId !== null &&
      subject.ownerUserId !== null &&
      subject.ownerUserId !== ctx.approverUserId &&
      (await activeAdmin(tx, ctx.approverUserId));
    if (!routable) {
      await tx.insert(auditLog).values({
        userId: NO_IDENTITY,
        objectType: "agent_containment",
        objectId: row.id,
        detail: {
          ...baseDetail,
          why: ctx.approverUserId === null ? "no_containment_approver" : subject.ownerUserId === null ? "agent_has_no_steward" : "approver_not_eligible",
        },
        effect: "require_approval",
        ruleId: CONTAINMENT_RULE_IDS.unrouted,
        ruleChain: [],
        reason: `containment of ${subject.label} proposed but not routed: name an active administrator as the containment approver`,
      });
      return "unrouted";
    }
    const [approval] = await tx
      .insert(approvals)
      .values({
        userId: subject.ownerUserId!,
        objectType: "agent_containment",
        approverUserId: ctx.approverUserId!,
        stageId: `${CONTAINMENT_APPROVAL_PREFIX}${row.id}`,
      })
      .returning({ id: approvals.id });
    await tx.update(agentContainments).set({ approvalId: approval!.id }).where(eq(agentContainments.id, row.id));
    await tx.insert(auditLog).values({
      userId: NO_IDENTITY,
      objectType: "agent_containment",
      objectId: row.id,
      detail: { ...baseDetail, approvalId: approval!.id, approverUserId: ctx.approverUserId },
      effect: "require_approval",
      ruleId: CONTAINMENT_RULE_IDS.proposed,
      ruleChain: [],
      reason: `containment of ${subject.label} proposed for approval (${signal.severity}): ${row.explanation}`,
    });
    return "proposed";
  });
}

// ---------------------------------------------------------------------------
// the decide path's two hooks (POST /v1/approvals/:approvalId/decide)
// ---------------------------------------------------------------------------

async function containmentOfApproval(db: Db, approvalId: string): Promise<AgentContainmentRow | undefined> {
  const [row] = await db.select().from(agentContainments).where(eq(agentContainments.approvalId, approvalId));
  return row;
}

async function stewardOf(db: Db, row: Pick<AgentContainmentRow, "subjectKind" | "agentId" | "builderAgentId">): Promise<string | null> {
  if (row.subjectKind === "agent") {
    const [a] = await db.select({ o: agents.ownerUserId }).from(agents).where(eq(agents.id, row.agentId!));
    return a?.o ?? null;
  }
  const [b] = await db.select({ o: builderAgents.ownerUserId }).from(builderAgents).where(eq(builderAgents.id, row.builderAgentId!));
  return b?.o ?? null;
}

/** refused BY NAME before anything is written: only an active administrator decides, never the agent's steward */
export async function precheckContainmentDecision(
  db: Db,
  approval: { id: string },
  deciderUserId: string,
): Promise<{ status: number; body: Record<string, unknown> } | null> {
  const row = await containmentOfApproval(db, approval.id);
  if (!row) return { status: 409, body: { error: "containment_not_found", detail: "this approval names no containment" } };
  if (!(await activeAdmin(db, deciderUserId))) {
    return { status: 403, body: { error: "not_an_eligible_approver", detail: "a rogue-agent containment is decided by an active administrator" } };
  }
  if ((await stewardOf(db, row)) === deciderUserId) {
    return {
      status: 403,
      body: {
        error: "cannot_decide_own_agent_containment",
        detail: "the decider is this agent's steward; another administrator must decide whether to contain it",
      },
    };
  }
  if (!CONTAINMENT_MACHINE.can(row.status, "approve")) {
    return { status: 409, body: { error: "containment_not_pending", status: row.status } };
  }
  const subject = await subjectOf(db, { subject: { kind: row.subjectKind, id: (row.agentId ?? row.builderAgentId)! } });
  if (!subject.exists) {
    return { status: 409, body: { error: "containment_subject_gone", detail: "the agent this containment names is archived or no longer exists" } };
  }
  return null;
}

/** inside the decision's transaction: approved = halt the agent; denied = declined, the agent keeps running */
export async function applyContainmentDecision(
  tx: Db,
  approval: { id: string },
  decision: "approved" | "denied",
  deciderUserId: string,
): Promise<void> {
  const [row] = await tx.select().from(agentContainments).where(eq(agentContainments.approvalId, approval.id)).for("update");
  if (!row) return;
  const event = decision === "approved" ? "approve" : "decline";
  CONTAINMENT_MACHINE.next(row.status, event); // throws IllegalTransitionError: the decision rolls back
  const now = new Date();
  if (decision === "denied") {
    await tx
      .update(agentContainments)
      .set({ status: "declined", decidedByUserId: deciderUserId, decidedAt: now })
      .where(and(eq(agentContainments.id, row.id), inArray(agentContainments.status, [...CONTAINMENT_MACHINE.sourcesOf("decline")])));
    await tx.insert(auditLog).values({
      userId: deciderUserId,
      objectType: "agent_containment",
      objectId: row.id,
      detail: { approvalId: approval.id, severity: row.severity, signal: { ruleId: row.signalRuleId, refId: row.signalRefId } },
      effect: "allow",
      ruleId: CONTAINMENT_RULE_IDS.declined,
      ruleChain: [],
      reason: `containment declined: ${row.explanation}`,
    });
    return;
  }
  const halted = await haltSubject(tx, row, { userId: deciderUserId, detail: { approvalId: approval.id } });
  if (!halted) throw new ContainmentDecideError(409, "containment_subject_gone", "the agent this containment names no longer exists");
  await tx
    .update(agentContainments)
    .set({ status: "contained", containedAt: now, haltApplied: halted.changed, decidedByUserId: deciderUserId, decidedAt: now })
    .where(and(eq(agentContainments.id, row.id), inArray(agentContainments.status, [...CONTAINMENT_MACHINE.sourcesOf("approve")])));
  await tx.insert(auditLog).values({
    userId: deciderUserId,
    objectType: "agent_containment",
    objectId: row.id,
    detail: { approvalId: approval.id, severity: row.severity, haltApplied: halted.changed, signal: { ruleId: row.signalRuleId, refId: row.signalRefId } },
    effect: "deny",
    ruleId: CONTAINMENT_RULE_IDS.approved,
    ruleChain: [],
    reason: `containment approved, agent halted: ${row.explanation}`,
  });
}

/** the decision's own failure inside its transaction: the whole decision rolls back */
export class ContainmentDecideError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string) {
    super(message);
  }
}

/** the approvals queue's label for each containment approval */
export async function containmentApprovalLabels(db: Db, stageIds: readonly (string | null)[]): Promise<Map<string, string>> {
  const ids = [
    ...new Set(
      stageIds
        .filter((s): s is string => !!s?.startsWith(CONTAINMENT_APPROVAL_PREFIX))
        .map((s) => s.slice(CONTAINMENT_APPROVAL_PREFIX.length))
        .filter((s) => /^[0-9a-f-]{36}$/i.test(s)),
    ),
  ];
  const out = new Map<string, string>();
  if (ids.length === 0) return out;
  const rows = await db
    .select({ id: agentContainments.id, severity: agentContainments.severity, explanation: agentContainments.explanation })
    .from(agentContainments)
    .where(inArray(agentContainments.id, ids));
  for (const r of rows) out.set(`${CONTAINMENT_APPROVAL_PREFIX}${r.id}`, `contain (halt), ${r.severity}: ${r.explanation}`);
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

const serialize = (r: AgentContainmentRow) => ({
  id: r.id,
  subject: { kind: r.subjectKind, id: r.agentId ?? r.builderAgentId },
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

  app.post("/v1/containments/:id/release", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const body = releaseBody.parse(req.body);
    const actorUserId = req.authCtx.userId ?? null;
    if (!actorUserId) return reply.status(403).send({ error: "identity_required", detail: "a release records who released it" });
    const [held] = await db.select().from(agentContainments).where(eq(agentContainments.id, id));
    if (!held) return reply.status(404).send({ error: "not_found" });
    if (!CONTAINMENT_MACHINE.can(held.status, "release")) {
      return reply.status(409).send({ error: "not_contained", lifecycle: CONTAINMENT_MACHINE.describe(held.status) });
    }
    // a release gives access back: refused while the execution dial is not `normal` (ADR-0338 §7's shared guard)
    const settings = await loadOrgSettings(db);
    const guard = killSwitchNarrowingOnly({ dial: settings.executionMode as "normal", direction: "widening" });
    if (guard) return reply.status(409).send({ error: "execution_dial_not_normal", detail: guard });
    // ADR-0186 A: lifting a halt loosens a protection — a settings_relax step-up bound to this containment
    const stepUp = { kind: "settings_relax" as const, facts: { containmentId: id, values: { released: true } } };
    const su = await requireStepUp(db, req, reply, stepUp);
    if (!su.ok) return;

    const result = await db.transaction(async (txRaw) => {
      const tx = txRaw as unknown as Db;
      const [row] = await tx.select().from(agentContainments).where(eq(agentContainments.id, id)).for("update");
      if (!row || !CONTAINMENT_MACHINE.can(row.status, "release")) return { conflict: true as const };
      const now = new Date();
      await tx
        .update(agentContainments)
        .set({ status: "released", releasedAt: now, releasedByUserId: actorUserId, releaseReason: body.reason })
        .where(and(eq(agentContainments.id, id), inArray(agentContainments.status, [...CONTAINMENT_MACHINE.sourcesOf("release")])));
      // lift the halt only when a containment set it and no other open containment still holds this agent
      const subjectWhere =
        row.subjectKind === "agent" ? eq(agentContainments.agentId, row.agentId!) : eq(agentContainments.builderAgentId, row.builderAgentId!);
      const [other] = await tx
        .select({ id: agentContainments.id })
        .from(agentContainments)
        .where(and(subjectWhere, eq(agentContainments.status, "contained"), ne(agentContainments.id, id)))
        .limit(1);
      let haltLifted = false;
      if (!other) {
        if (row.subjectKind === "agent") {
          const [a] = await tx.select({ r: agents.haltedReason }).from(agents).where(eq(agents.id, row.agentId!)).for("update");
          if (a?.r?.startsWith(CONTAINMENT_HALT_PREFIX)) {
            await tx.update(agents).set({ haltedAt: null, haltedReason: null, haltedByUserId: null }).where(eq(agents.id, row.agentId!));
            haltLifted = true;
          }
        } else {
          const [b] = await tx
            .select({ r: builderAgents.haltedReason })
            .from(builderAgents)
            .where(eq(builderAgents.id, row.builderAgentId!))
            .for("update");
          if (b?.r?.startsWith(CONTAINMENT_HALT_PREFIX)) {
            await tx
              .update(builderAgents)
              .set({ haltedAt: null, haltedReason: null, haltedByUserId: null })
              .where(eq(builderAgents.id, row.builderAgentId!));
            haltLifted = true;
          }
        }
      }
      await tx.insert(auditLog).values({
        userId: actorUserId,
        objectType: "agent_containment",
        objectId: id,
        detail: { via: req.authCtx.via, haltLifted, heldByOther: other?.id ?? null, receiptClass: "configuration" },
        effect: "allow",
        ruleId: CONTAINMENT_RULE_IDS.released,
        ruleChain: [],
        reason: `containment released${haltLifted ? ", halt lifted" : other ? ", halt kept: another containment holds this agent" : ", halt kept: it was not set by a containment"}: ${body.reason}`,
      });
      const [updated] = await tx.select().from(agentContainments).where(eq(agentContainments.id, id));
      return { row: updated!, haltLifted };
    });
    if ("conflict" in result) return reply.status(409).send({ error: "not_contained" });
    return { containment: serialize(result.row), haltLifted: result.haltLifted };
  });
}
