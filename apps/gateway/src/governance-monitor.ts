/**
 * ADR-0157 — THE GOVERNANCE MONITOR (Phase 3, "Monitor & Respond").
 *
 * Gathers the standing picture — the ADR-0156 dependency graph, the ADR-0148
 * trust coverage, the risk register with its ADR-0147 control links, agent
 * ownership and model-card approvals — runs the pure rules in
 * `packages/shared/src/governance-monitor.ts`, and reconciles the findings
 * against `governance_alerts`:
 *
 *   new condition      → a row (status open) + a `governance-alert-raised` audit row
 *   persisting         → last_detected_at / title / detail refreshed; status
 *                        untouched, so an acknowledgement survives
 *   cleared            → status resolved + a `governance-alert-resolved` audit row
 *
 * One implementation, reached two ways: the ADR-0064 scheduler job
 * (`governance-monitor-sweep`) and `POST /v1/governance/monitor/evaluate`.
 * Alerts go to the audit log (and so to every SIEM stream that reads it);
 * this file sends nothing anywhere else. It is a monitor, not a control —
 * no dispatch decision reads these rows.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  agents,
  aiRiskControls,
  aiRisks,
  and,
  auditLog,
  count,
  desc,
  eq,
  governanceAlerts,
  inArray,
  isNull,
  modelCardApprovals,
  modelCards,
  ne,
  or,
  gt,
  sql,
  users,
  type Db,
} from "@regulait/db";
import {
  MONITOR_RULES,
  MONITOR_RULE_IDS,
  effectiveRiskRating,
  evaluateMonitorRules,
  reconcileAlerts,
  type MonitorAgentInput,
  type MonitorVendorInput,
} from "@regulait/shared";
import { computeDependencyGraph } from "./dependency-graph.js";
import { computeTrustDashboard } from "./trust-dashboard.js";
import { ownershipFlagFor } from "./inventory.js";

const NO_IDENTITY = "00000000-0000-0000-0000-000000000000";

export const MONITOR_AUDIT_RULE_IDS = {
  raised: "governance-alert-raised",
  resolved: "governance-alert-resolved",
  acknowledged: "governance-alert-acknowledged",
  evaluated: "governance-monitor-evaluated",
} as const;

export interface MonitorRunResult {
  evaluatedAt: string;
  raised: number;
  refreshed: number;
  resolved: number;
  active: number;
}

export async function runGovernanceMonitor(
  db: Db,
  opts: { now?: Date; actorUserId?: string | null } = {},
): Promise<MonitorRunResult> {
  const now = opts.now ?? new Date();
  const actor = opts.actorUserId ?? NO_IDENTITY;

  // -- inputs ----------------------------------------------------------------
  const graph = await computeDependencyGraph(db, { includeObserved: true, now });
  const labels = new Map(graph.nodes.map((n) => [n.key, n.label]));
  const deps = new Map<string, string[]>();
  for (const e of graph.edges) deps.set(e.from, [...(deps.get(e.from) ?? []), e.to]);
  const reach = (start: string) => {
    const seen = new Set<string>([start]);
    const q = [start];
    while (q.length) for (const n of deps.get(q.shift()!) ?? []) if (!seen.has(n)) (seen.add(n), q.push(n));
    return seen;
  };
  const useCases = graph.nodes
    .filter((n) => n.type === "use_case")
    .map((n) => {
      const r = [...reach(n.key)];
      return {
        id: n.id!,
        name: n.label,
        status: String(n.attributes.status),
        propagated: n.propagatedRisk,
        agentIds: r.filter((k) => k.startsWith("agent:")).map((k) => k.slice(6)),
        vendorIds: r.filter((k) => k.startsWith("vendor:")).map((k) => k.slice(7)),
      };
    });

  const relevantAgentIds = [...new Set(useCases.filter((u) => u.status === "approved").flatMap((u) => u.agentIds))];
  const agentMap = new Map<string, MonitorAgentInput>();
  if (relevantAgentIds.length) {
    const rows = await db
      .select({
        id: agents.id,
        name: agents.name,
        enabled: agents.enabled,
        haltedAt: agents.haltedAt,
        lifecycleStatus: agents.lifecycleStatus,
        ownerUserId: agents.ownerUserId,
        ownerDisabledAt: users.disabledAt,
      })
      .from(agents)
      .leftJoin(users, eq(users.id, agents.ownerUserId))
      .where(inArray(agents.id, relevantAgentIds));
    const approved = await db
      .selectDistinct({ agentId: modelCards.agentId })
      .from(modelCardApprovals)
      .innerJoin(modelCards, eq(modelCards.id, modelCardApprovals.cardId))
      .where(
        and(
          inArray(modelCards.agentId, relevantAgentIds),
          eq(modelCardApprovals.status, "approved"),
          or(isNull(modelCardApprovals.validUntil), gt(modelCardApprovals.validUntil, now)),
        ),
      );
    const approvedSet = new Set(approved.map((a) => a.agentId));
    for (const a of rows) {
      agentMap.set(a.id, {
        id: a.id,
        name: a.name,
        halted: a.haltedAt !== null,
        enabled: a.enabled,
        lifecycleStatus: a.lifecycleStatus,
        ownership: ownershipFlagFor(a.ownerUserId, a.ownerDisabledAt !== null),
        modelCardApproved: approvedSet.has(a.id),
      });
    }
  }
  const vendorMap = new Map<string, MonitorVendorInput>(
    graph.nodes
      .filter((n) => n.type === "vendor")
      .map((n) => [n.id!, { id: n.id!, name: n.label, status: String(n.attributes.status) }]),
  );

  const riskRows = await db
    .select({
      id: aiRisks.id,
      title: aiRisks.title,
      status: aiRisks.status,
      likelihood: aiRisks.likelihood,
      impact: aiRisks.impact,
      residualLikelihood: aiRisks.residualLikelihood,
      residualImpact: aiRisks.residualImpact,
      controls: sql<number>`(select count(*)::int from ${aiRiskControls} where ${aiRiskControls.riskId} = ${aiRisks.id})`,
    })
    .from(aiRisks)
    .where(inArray(aiRisks.status, ["open", "mitigating"]));
  const risks = riskRows.map((r) => ({
    id: r.id,
    title: r.title,
    status: r.status,
    band: effectiveRiskRating(r)?.band ?? ("none" as const),
    controls: Number(r.controls),
  }));

  const trust = await computeTrustDashboard(db, { now });

  const findings = evaluateMonitorRules({
    useCases,
    agents: agentMap,
    vendors: vendorMap,
    risks,
    dimensions: trust.dimensions,
    labels,
  });

  // -- reconcile -------------------------------------------------------------
  const active = await db
    .select({ id: governanceAlerts.id, ruleId: governanceAlerts.ruleId, subjectKey: governanceAlerts.subjectKey, title: governanceAlerts.title })
    .from(governanceAlerts)
    .where(ne(governanceAlerts.status, "resolved"));
  const plan = reconcileAlerts(active, findings, new Set(MONITOR_RULE_IDS));

  for (const f of plan.raise) {
    // ON CONFLICT: a concurrent pass (scheduler + manual evaluate) may have
    // opened the same episode a moment ago — the partial unique index is the
    // dedupe, so the loser simply does nothing
    const inserted = await db
      .insert(governanceAlerts)
      .values({
        ruleId: f.ruleId,
        subjectKey: f.subjectKey,
        severity: f.severity,
        title: f.title,
        detail: f.detail,
        firstDetectedAt: now,
        lastDetectedAt: now,
      })
      .onConflictDoNothing()
      .returning({ id: governanceAlerts.id });
    if (!inserted[0]) continue;
    await db.insert(auditLog).values({
      userId: actor,
      objectType: "governance_alert",
      objectId: inserted[0].id,
      detail: { ruleId: f.ruleId, subjectKey: f.subjectKey, severity: f.severity },
      effect: "allow",
      ruleId: MONITOR_AUDIT_RULE_IDS.raised,
      ruleChain: [],
      reason: `governance alert raised (${f.severity}): ${f.title}`,
    });
  }
  for (const { id, finding } of plan.refresh) {
    await db
      .update(governanceAlerts)
      .set({ lastDetectedAt: now, title: finding.title, detail: finding.detail, severity: finding.severity })
      .where(eq(governanceAlerts.id, id));
  }
  for (const id of plan.resolve) {
    const [row] = await db
      .update(governanceAlerts)
      .set({ status: "resolved", resolvedAt: now })
      .where(and(eq(governanceAlerts.id, id), ne(governanceAlerts.status, "resolved")))
      .returning({ title: governanceAlerts.title, ruleId: governanceAlerts.ruleId, subjectKey: governanceAlerts.subjectKey });
    if (!row) continue;
    await db.insert(auditLog).values({
      userId: actor,
      objectType: "governance_alert",
      objectId: id,
      detail: { ruleId: row.ruleId, subjectKey: row.subjectKey },
      effect: "allow",
      ruleId: MONITOR_AUDIT_RULE_IDS.resolved,
      ruleChain: [],
      reason: `governance alert resolved — condition cleared: ${row.title}`,
    });
  }

  const [{ n }] = (await db
    .select({ n: count() })
    .from(governanceAlerts)
    .where(ne(governanceAlerts.status, "resolved"))) as [{ n: number }];

  await db.insert(auditLog).values({
    userId: actor,
    objectType: "governance_monitor",
    objectId: null,
    detail: { raised: plan.raise.length, refreshed: plan.refresh.length, resolved: plan.resolve.length, active: n },
    effect: "allow",
    ruleId: MONITOR_AUDIT_RULE_IDS.evaluated,
    ruleChain: [],
    reason: `governance monitor evaluated: ${n} active alert(s)`,
  });

  return {
    evaluatedAt: now.toISOString(),
    raised: plan.raise.length,
    refreshed: plan.refresh.length,
    resolved: plan.resolve.length,
    active: n,
  };
}

/** `use_case:<id>>agent:<id>` → the dependency is the subject; the use case is context */
function describeSubject(subjectKey: string, labels: Map<string, string>) {
  const parts = subjectKey.split(">");
  const last = parts[parts.length - 1]!;
  const [type, ...rest] = last.split(":");
  const id = rest.join(":");
  const ctx = parts.length > 1 ? parts[0]! : null;
  return {
    key: subjectKey,
    type: type!,
    id,
    label: labels.get(last) ?? null,
    context: ctx ? { key: ctx, id: ctx.split(":").slice(1).join(":"), label: labels.get(ctx) ?? null } : null,
  };
}

const listQuery = z.object({
  status: z.enum(["active", "open", "acknowledged", "resolved", "all"]).default("active"),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});
const idParam = z.object({ alertId: z.string().uuid() });
const ackBody = z.object({ note: z.string().trim().min(1).max(500) }).strict();

export function registerGovernanceMonitorRoutes(app: FastifyInstance, db: Db): void {
  /** admin-only via the default gate */
  app.get("/v1/governance/alerts", async (req) => {
    const q = listQuery.parse(req.query);
    const where =
      q.status === "all"
        ? undefined
        : q.status === "active"
          ? ne(governanceAlerts.status, "resolved")
          : eq(governanceAlerts.status, q.status);
    const rows = await db
      .select({
        a: governanceAlerts,
        ackName: users.displayName,
        ackEmail: users.email,
      })
      .from(governanceAlerts)
      .leftJoin(users, eq(users.id, governanceAlerts.acknowledgedByUserId))
      .where(where)
      .orderBy(
        sql`case ${governanceAlerts.severity} when 'high' then 0 when 'medium' then 1 else 2 end`,
        desc(governanceAlerts.lastDetectedAt),
      )
      .limit(q.limit);

    const counts = { open: 0, acknowledged: 0, resolved: 0 };
    for (const c of await db
      .select({ status: governanceAlerts.status, n: count() })
      .from(governanceAlerts)
      .groupBy(governanceAlerts.status)) {
      counts[c.status] = Number(c.n);
    }
    const [last] = await db
      .select({ at: auditLog.at })
      .from(auditLog)
      .where(eq(auditLog.ruleId, MONITOR_AUDIT_RULE_IDS.evaluated))
      .orderBy(desc(auditLog.at))
      .limit(1);

    // labels for subjects, current as of now (a renamed agent shows its new name)
    const labels = new Map<string, string>();
    if (rows.length) {
      const graph = await computeDependencyGraph(db, { includeObserved: false });
      for (const n of graph.nodes) labels.set(n.key, n.label);
      const riskIds = rows.flatMap((r) => (r.a.subjectKey.startsWith("risk:") ? [r.a.subjectKey.slice(5)] : []));
      if (riskIds.length) {
        for (const r of await db.select({ id: aiRisks.id, title: aiRisks.title }).from(aiRisks).where(inArray(aiRisks.id, riskIds))) {
          labels.set(`risk:${r.id}`, r.title);
        }
      }
    }

    return {
      alerts: rows.map(({ a, ackName, ackEmail }) => ({
        id: a.id,
        ruleId: a.ruleId,
        ruleLabel: (MONITOR_RULES as Record<string, { label: string }>)[a.ruleId]?.label ?? a.ruleId,
        severity: a.severity,
        status: a.status,
        subject: describeSubject(a.subjectKey, labels),
        title: a.title,
        detail: a.detail,
        firstDetectedAt: a.firstDetectedAt.toISOString(),
        lastDetectedAt: a.lastDetectedAt.toISOString(),
        acknowledgedAt: a.acknowledgedAt?.toISOString() ?? null,
        acknowledgedBy: a.acknowledgedByUserId
          ? { id: a.acknowledgedByUserId, name: ackName || ackEmail || null }
          : null,
        ackNote: a.ackNote,
        resolvedAt: a.resolvedAt?.toISOString() ?? null,
      })),
      counts,
      lastEvaluatedAt: last?.at?.toISOString() ?? null,
      rules: MONITOR_RULE_IDS.map((id) => ({ id, ...MONITOR_RULES[id] })),
    };
  });

  app.post("/v1/governance/monitor/evaluate", async (req) => {
    return runGovernanceMonitor(db, { actorUserId: req.authCtx.userId ?? null });
  });

  app.post("/v1/governance/alerts/:alertId/acknowledge", async (req, reply) => {
    const { alertId } = idParam.parse(req.params);
    const body = ackBody.parse(req.body);
    const userId = req.authCtx.userId ?? null;
    if (!userId) {
      return reply.status(403).send({
        error: "identity_required",
        detail: "an acknowledgement records who looked — the bootstrap token has no identity",
      });
    }
    const [row] = await db.select().from(governanceAlerts).where(eq(governanceAlerts.id, alertId));
    if (!row) return reply.status(404).send({ error: "not_found" });
    if (row.status === "resolved") return reply.status(409).send({ error: "already_resolved" });
    const now = new Date();
    const [updated] = await db
      .update(governanceAlerts)
      .set({ status: "acknowledged", acknowledgedByUserId: userId, acknowledgedAt: now, ackNote: body.note })
      .where(and(eq(governanceAlerts.id, alertId), ne(governanceAlerts.status, "resolved")))
      .returning();
    if (!updated) return reply.status(409).send({ error: "already_resolved" });
    await db.insert(auditLog).values({
      userId,
      objectType: "governance_alert",
      objectId: alertId,
      detail: { ruleId: row.ruleId, subjectKey: row.subjectKey, note: body.note, previousStatus: row.status },
      effect: "allow",
      ruleId: MONITOR_AUDIT_RULE_IDS.acknowledged,
      ruleChain: [],
      reason: `governance alert acknowledged: ${row.title}`,
    });
    return {
      id: updated.id,
      status: updated.status,
      acknowledgedAt: updated.acknowledgedAt?.toISOString() ?? null,
      ackNote: updated.ackNote,
    };
  });
}
