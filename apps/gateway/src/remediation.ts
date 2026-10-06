/**
 * ADR-0159 — REMEDIATION for governance-monitor alerts ("Respond").
 *
 *   GET  /v1/governance/alerts/:alertId/remediation   the planner's candidates
 *                                                      (computed) + this alert's
 *                                                      stored proposals
 *   POST /v1/governance/alerts/:alertId/remediation   propose ONE executable
 *                                                      candidate → approvals row
 *   GET  /v1/governance/remediations                   stored proposals
 *
 * Execution happens in the ONE decide path (`POST /v1/approvals/:id/decide`,
 * objectType `remediation`), inside the decision's transaction, exactly like
 * an SoD override: `precheckRemediationDecision` refuses the proposer BY NAME
 * (no delegation or admin override reaches their own proposal), and
 * `applyRemediationDecision` runs the stored kind+params — never a fresh
 * plan — so the approver signed the action that runs.
 *
 * A proposal must equal a CURRENT candidate for its alert: the API cannot be
 * used to smuggle an arbitrary control link or owner change under a monitor
 * alert's name. Admin-only through the default gate.
 *
 * ADR-0182 S5 (PF-03) — `halt_agent`, the SUGGESTED halt. A KRI set to
 * `on_breach = propose_halt` makes its breach episode carry
 * `detail.suggestedAction`; the planner turns that into one executable
 * candidate and the alerts page shows "Propose halt". Owner decision 4:
 *   - nothing files it but a person's click on this route, with THAT person
 *     recorded as proposer (the monitor never calls it);
 *   - ONE proposal per episode: a second click returns the first (200,
 *     `idempotent: true`), whatever its status;
 *   - the proposer cannot approve it (`precheckRemediationDecision`), and the
 *     decide path applies it through `haltAgentInTx` (ADR-0124's one halt);
 *   - nothing ever trips on its own.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  agents,
  aiRiskControls,
  aiRisks,
  aiUseCases,
  aiVendors,
  and,
  approvals,
  auditLog,
  compliancePackControls,
  compliancePacks,
  desc,
  eq,
  governanceAlerts,
  inArray,
  isNull,
  remediationProposals,
  sql,
  users,
  type Db,
} from "@regulait/db";
import {
  REMEDIATION_STATUSES,
  isExecutableRemediation,
  type ExecutableRemediationKind,
  proposeRemediations,
  type AiRiskCategory,
  type RemediationRiskInput,
} from "@regulait/shared";
import { RISK_RULE_IDS } from "./risks.js";
import { haltAgentInTx } from "./execution-control.js";

export const REMEDIATION_PREFIX = "__remediation__:";
export const REMEDIATION_RULE_IDS = {
  proposed: "remediation-proposed",
  applied: "remediation-applied",
  denied: "remediation-denied",
  failed: "remediation-failed",
} as const;

const alertParam = z.object({ alertId: z.string().uuid() });
const proposeBody = z
  .object({
    kind: z.string().min(1).max(64),
    params: z.record(z.string().max(200)),
    approverUserId: z.string().uuid(),
  })
  .strict();

async function activeControlTitles(db: Db): Promise<Map<string, string>> {
  const rows = await db
    .select({ ref: compliancePackControls.controlRef, title: compliancePackControls.title })
    .from(compliancePackControls)
    .innerJoin(compliancePacks, eq(compliancePacks.id, compliancePackControls.packId))
    .where(eq(compliancePacks.status, "active"));
  return new Map(rows.map((r) => [r.ref, r.title]));
}

async function loadRisks(db: Db, ids: string[]): Promise<Map<string, RemediationRiskInput>> {
  const out = new Map<string, RemediationRiskInput>();
  if (!ids.length) return out;
  const rows = await db
    .select({ id: aiRisks.id, title: aiRisks.title, category: aiRisks.category })
    .from(aiRisks)
    .where(inArray(aiRisks.id, ids));
  const links = await db
    .select({ riskId: aiRiskControls.riskId, ref: aiRiskControls.controlRef })
    .from(aiRiskControls)
    .where(inArray(aiRiskControls.riskId, ids));
  for (const r of rows) {
    out.set(r.id, {
      id: r.id,
      title: r.title,
      category: r.category as AiRiskCategory,
      linkedControls: links.filter((l) => l.riskId === r.id).map((l) => l.ref),
    });
  }
  return out;
}

/** the planner's candidates for one alert, from current state */
export async function candidatesForAlert(db: Db, alert: typeof governanceAlerts.$inferSelect) {
  const detail = (alert.detail ?? {}) as Record<string, unknown>;
  const parts = alert.subjectKey.split(">");
  const keyOf = (k: string) => {
    const i = k.indexOf(":");
    return { type: k.slice(0, i), id: k.slice(i + 1) };
  };
  const tail = keyOf(parts[parts.length - 1]!);
  const ctxKey = parts.length > 1 ? keyOf(parts[0]!) : null;

  const riskIds = [
    ...(tail.type === "risk" ? [tail.id] : []),
    ...(typeof detail.sourceRiskId === "string" ? [detail.sourceRiskId] : []),
  ];
  const labels = new Map<string, string>();
  let useCaseOwner: { id: string; name: string } | null = null;
  if (ctxKey?.type === "use_case") {
    const [uc] = await db
      .select({ name: aiUseCases.name, ownerUserId: aiUseCases.ownerUserId, ownerName: users.displayName, ownerEmail: users.email, disabledAt: users.disabledAt })
      .from(aiUseCases)
      .innerJoin(users, eq(users.id, aiUseCases.ownerUserId))
      .where(eq(aiUseCases.id, ctxKey.id));
    if (uc) {
      labels.set(parts[0]!, uc.name);
      if (!uc.disabledAt) useCaseOwner = { id: uc.ownerUserId, name: uc.ownerName || uc.ownerEmail };
    }
  }
  if (tail.type === "agent") {
    const [a] = await db.select({ name: agents.name }).from(agents).where(eq(agents.id, tail.id));
    if (a) labels.set(parts[parts.length - 1]!, a.name);
  } else if (tail.type === "vendor") {
    const [v] = await db.select({ name: aiVendors.name }).from(aiVendors).where(eq(aiVendors.id, tail.id));
    if (v) labels.set(parts[parts.length - 1]!, v.name);
  }
  // ADR-0182 S5 (PF-03): the suggested halt names its agent; label it
  const suggested = detail.suggestedAction as { kind?: unknown; agentId?: unknown } | undefined;
  if (suggested?.kind === "halt_agent" && typeof suggested.agentId === "string" && /^[0-9a-f-]{36}$/i.test(suggested.agentId)) {
    const [a] = await db.select({ name: agents.name }).from(agents).where(eq(agents.id, suggested.agentId));
    if (a) labels.set(`agent:${suggested.agentId}`, a.name);
  }
  if (typeof detail.sourceNodeKey === "string" && Array.isArray(detail.path) && Array.isArray(detail.pathLabels)) {
    const i = (detail.path as string[]).indexOf(detail.sourceNodeKey);
    if (i >= 0) labels.set(detail.sourceNodeKey, String((detail.pathLabels as string[])[i]));
  }
  return proposeRemediations({
    alert: { ruleId: alert.ruleId, subjectKey: alert.subjectKey, detail },
    risks: await loadRisks(db, riskIds),
    activeControls: await activeControlTitles(db),
    useCaseOwner,
    labels,
  });
}

const serialize = (p: typeof remediationProposals.$inferSelect) => ({
  id: p.id,
  alertId: p.alertId,
  kind: p.kind,
  params: p.params,
  title: p.title,
  rationale: p.rationale,
  status: p.status,
  approvalId: p.approvalId,
  proposedByUserId: p.proposedByUserId,
  decidedByUserId: p.decidedByUserId,
  decidedAt: p.decidedAt?.toISOString() ?? null,
  result: p.result,
  createdAt: p.createdAt.toISOString(),
});

// ---------------------------------------------------------------------------
// the decide path's two hooks
// ---------------------------------------------------------------------------

export async function precheckRemediationDecision(
  db: Db,
  approval: { id: string },
  deciderUserId: string,
): Promise<{ status: number; body: Record<string, unknown> } | null> {
  const [p] = await db.select().from(remediationProposals).where(eq(remediationProposals.approvalId, approval.id));
  if (!p) return null;
  if (p.proposedByUserId === deciderUserId) {
    return {
      status: 403,
      body: {
        error: "cannot_approve_own_remediation",
        detail:
          "the decider proposed this remediation — approving one's own change to governed state is not a review; " +
          "another approver must decide it",
      },
    };
  }
  return null;
}

/** runs inside the decision's transaction; never throws for an execution
 * failure — the proposal records `failed` with the reason instead */
export async function applyRemediationDecision(
  tx: Db,
  approval: { id: string },
  decision: "approved" | "denied",
  deciderUserId: string,
): Promise<boolean> {
  const [p] = await tx.select().from(remediationProposals).where(eq(remediationProposals.approvalId, approval.id));
  if (!p || p.status !== "pending_approval") return false;
  const now = new Date();
  const finish = async (status: "applied" | "denied" | "failed", result: Record<string, unknown>) => {
    await tx
      .update(remediationProposals)
      .set({ status, result, decidedByUserId: deciderUserId, decidedAt: now })
      .where(eq(remediationProposals.id, p.id));
    await tx.insert(auditLog).values({
      userId: deciderUserId,
      objectType: "remediation",
      objectId: p.id,
      detail: { kind: p.kind, params: p.params, alertId: p.alertId, approvalId: approval.id, result },
      effect: status === "applied" ? "allow" : "deny",
      ruleId: REMEDIATION_RULE_IDS[status],
      ruleChain: [],
      reason: `remediation ${status}: ${p.title}${status === "failed" ? ` — ${String(result.error)}` : ""}`,
    });
  };
  if (decision === "denied") {
    await finish("denied", {});
    return false;
  }

  if (p.kind === "link_control") {
    const { riskId, controlRef } = p.params;
    const [risk] = await tx.select({ id: aiRisks.id, title: aiRisks.title }).from(aiRisks).where(eq(aiRisks.id, riskId!));
    const active = await activeControlTitles(tx);
    if (!risk) return (await finish("failed", { error: "risk_not_found" }), false);
    if (!active.has(controlRef!)) return (await finish("failed", { error: "control_not_in_active_pack" }), false);
    const inserted = await tx
      .insert(aiRiskControls)
      .values({ riskId: riskId!, controlRef: controlRef!, linkedByUserId: deciderUserId })
      .onConflictDoNothing()
      .returning({ riskId: aiRiskControls.riskId });
    if (inserted.length) {
      // the same audit row the manual link writes, so the risk's history reads the same either way
      await tx.insert(auditLog).values({
        userId: deciderUserId,
        objectType: "ai_risk",
        objectId: riskId!,
        detail: { phase: "control", controlRef, remediationId: p.id, approvalId: approval.id },
        effect: "allow",
        ruleId: RISK_RULE_IDS.controlLinked,
        ruleChain: [],
        reason: `control ${controlRef} linked to AI risk '${risk.title}' by approved remediation`,
      });
    }
    await finish("applied", { linked: inserted.length > 0, alreadyLinked: inserted.length === 0 });
    return true;
  }

  if (p.kind === "assign_agent_owner") {
    const { agentId, ownerUserId } = p.params;
    const [owner] = await tx.select({ disabledAt: users.disabledAt }).from(users).where(eq(users.id, ownerUserId!));
    if (!owner || owner.disabledAt) return (await finish("failed", { error: "owner_not_active" }), false);
    const [agent] = await tx
      .select({ id: agents.id, name: agents.name, ownerUserId: agents.ownerUserId, ownerDisabledAt: users.disabledAt })
      .from(agents)
      .leftJoin(users, eq(users.id, agents.ownerUserId))
      .where(eq(agents.id, agentId!));
    if (!agent) return (await finish("failed", { error: "agent_not_found" }), false);
    // someone named an active owner since the proposal: do not overwrite a human decision
    if (agent.ownerUserId && !agent.ownerDisabledAt && agent.ownerUserId !== ownerUserId) {
      return (await finish("failed", { error: "agent_already_owned", currentOwnerUserId: agent.ownerUserId }), false);
    }
    // ADR-0168 item 6: if the new owner (steward) is the agent's successor,
    // the successor stepped up — clear the slot, in the same statement, so the
    // steward≠successor CHECK can never turn an approved fix into a 500
    await tx
      .update(agents)
      .set({
        ownerUserId: ownerUserId!,
        successorUserId: sql`CASE WHEN ${agents.successorUserId} = ${ownerUserId!} THEN NULL ELSE ${agents.successorUserId} END`,
      })
      .where(eq(agents.id, agentId!));
    await tx.insert(auditLog).values({
      userId: deciderUserId,
      objectType: "agent",
      objectId: agentId!,
      detail: { phase: "owner", from: agent.ownerUserId, to: ownerUserId, remediationId: p.id, approvalId: approval.id },
      effect: "allow",
      ruleId: "agent-owner-set",
      ruleChain: [],
      reason: `owner of agent '${agent.name}' set by approved remediation`,
    });
    await finish("applied", { previousOwnerUserId: agent.ownerUserId });
    return true;
  }

  if (p.kind === "halt_agent") {
    // ADR-0182 S5 (PF-03): the halt a PERSON proposed from a KRI breach's
    // suggestion, applied only now that a DIFFERENT person approved it
    // (`precheckRemediationDecision` refused the proposer). ADR-0124's one
    // halt, inside the decision's transaction; already halted = no change.
    const { agentId } = p.params;
    const halted = await haltAgentInTx(
      tx,
      agentId!,
      `halted by approved remediation: proposed from governance alert ${p.alertId ?? "(deleted)"} by a user (id ${p.proposedByUserId}), approved by a user (id ${deciderUserId})`,
      { userId: deciderUserId, detail: { remediationId: p.id, approvalId: approval.id, alertId: p.alertId, proposedByUserId: p.proposedByUserId } },
    );
    if (!halted) return (await finish("failed", { error: "agent_not_found" }), false);
    await finish("applied", { halted: true, changed: halted.changed });
    return true;
  }

  await finish("failed", { error: "unknown_kind" });
  return false;
}

// ---------------------------------------------------------------------------
// routes
// ---------------------------------------------------------------------------

export function registerRemediationRoutes(app: FastifyInstance, db: Db): void {
  app.get("/v1/governance/alerts/:alertId/remediation", async (req, reply) => {
    const { alertId } = alertParam.parse(req.params);
    const [alert] = await db.select().from(governanceAlerts).where(eq(governanceAlerts.id, alertId));
    if (!alert) return reply.status(404).send({ error: "not_found" });
    const candidates = alert.status === "resolved" ? [] : await candidatesForAlert(db, alert);
    const proposals = await db
      .select()
      .from(remediationProposals)
      .where(eq(remediationProposals.alertId, alertId))
      .orderBy(desc(remediationProposals.createdAt));
    return {
      alert: { id: alert.id, ruleId: alert.ruleId, status: alert.status, title: alert.title },
      candidates,
      proposals: proposals.map(serialize),
      note:
        "Executable candidates change governed state and run only after a different human approves them on the " +
        "approvals queue. Guidance candidates are steps for a person; the platform does not perform them.",
    };
  });

  app.post("/v1/governance/alerts/:alertId/remediation", async (req, reply) => {
    const { alertId } = alertParam.parse(req.params);
    const body = proposeBody.parse(req.body);
    const proposerId = req.authCtx.userId ?? null;
    if (!proposerId) {
      return reply.status(403).send({ error: "identity_required", detail: "a proposal records who proposed it" });
    }
    if (body.approverUserId === proposerId) {
      return reply.status(409).send({
        error: "approver_is_proposer",
        detail: "name a different approver — the proposer cannot approve their own remediation",
      });
    }
    const [alert] = await db.select().from(governanceAlerts).where(eq(governanceAlerts.id, alertId));
    if (!alert) return reply.status(404).send({ error: "not_found" });
    if (alert.status === "resolved") return reply.status(409).send({ error: "alert_resolved" });
    if (!isExecutableRemediation(body.kind)) {
      return reply.status(422).send({ error: "not_executable", detail: "guidance candidates are not proposed for execution" });
    }
    const candidates = await candidatesForAlert(db, alert);
    const match = candidates.find(
      (c) =>
        c.executable &&
        c.kind === body.kind &&
        Object.keys(c.params).length === Object.keys(body.params).length &&
        Object.entries(c.params).every(([k, v]) => body.params[k] === v),
    );
    if (!match) {
      return reply.status(422).send({
        error: "not_a_current_candidate",
        detail: "a proposal must equal one of this alert's current executable candidates (GET …/remediation)",
      });
    }
    // ADR-0182 S5 (PF-03): ONE halt proposal per episode — a second click
    // (by anyone, naming any approver) returns the first, whatever its status
    if (match.kind === "halt_agent") {
      const [existing] = await db
        .select()
        .from(remediationProposals)
        .where(and(eq(remediationProposals.alertId, alertId), eq(remediationProposals.kind, "halt_agent")))
        .orderBy(remediationProposals.createdAt)
        .limit(1);
      if (existing) return reply.status(200).send({ ...serialize(existing), idempotent: true });
    }
    const [approver] = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.id, body.approverUserId), isNull(users.disabledAt)));
    if (!approver) return reply.status(422).send({ error: "unknown_approver" });

    const [samePending] = await db
      .select()
      .from(remediationProposals)
      .where(
        and(
          eq(remediationProposals.kind, match.kind as ExecutableRemediationKind),
          eq(remediationProposals.status, "pending_approval"),
          sql`${remediationProposals.params} = ${JSON.stringify(match.params)}::jsonb`,
        ),
      );
    if (samePending) {
      return reply.status(409).send({ error: "already_pending", proposal: serialize(samePending) });
    }

    const created = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(remediationProposals)
        .values({
          alertId,
          kind: match.kind as ExecutableRemediationKind,
          params: match.params,
          title: match.title,
          rationale: match.rationale,
          proposedByUserId: proposerId,
        })
        .onConflictDoNothing()
        .returning();
      if (!row) return null;
      const [approval] = await tx
        .insert(approvals)
        .values({
          userId: proposerId,
          objectType: "remediation",
          approverUserId: body.approverUserId,
          stageId: `${REMEDIATION_PREFIX}${row.id}`,
        })
        .returning({ id: approvals.id });
      const [updated] = await tx
        .update(remediationProposals)
        .set({ approvalId: approval!.id })
        .where(eq(remediationProposals.id, row.id))
        .returning();
      await tx.insert(auditLog).values({
        userId: proposerId,
        objectType: "remediation",
        objectId: row.id,
        detail: { kind: row.kind, params: row.params, alertId, approvalId: approval!.id, approverUserId: body.approverUserId },
        effect: "require_approval",
        ruleId: REMEDIATION_RULE_IDS.proposed,
        ruleChain: [],
        reason: `remediation proposed for approval: ${row.title}`,
      });
      return updated!;
    });
    if (!created) {
      // a concurrent click on the same episode won the insert: same answer as a second click
      if (match.kind === "halt_agent") {
        const [first] = await db
          .select()
          .from(remediationProposals)
          .where(and(eq(remediationProposals.alertId, alertId), eq(remediationProposals.kind, "halt_agent")))
          .orderBy(remediationProposals.createdAt)
          .limit(1);
        if (first) return reply.status(200).send({ ...serialize(first), idempotent: true });
      }
      return reply.status(409).send({ error: "already_pending" });
    }
    return reply.status(201).send(serialize(created));
  });

  app.get("/v1/governance/remediations", async (req) => {
    const q = z.object({ status: z.enum(REMEDIATION_STATUSES).optional() }).parse(req.query);
    const rows = await db
      .select()
      .from(remediationProposals)
      .where(q.status ? eq(remediationProposals.status, q.status) : undefined)
      .orderBy(desc(remediationProposals.createdAt))
      .limit(200);
    return { proposals: rows.map(serialize) };
  });
}
