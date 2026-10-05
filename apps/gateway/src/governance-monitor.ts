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
  aiUseCases,
  and,
  auditLog,
  count,
  desc,
  eq,
  governanceAlerts,
  inArray,
  isNull,
  kris,
  modelCardApprovals,
  modelCards,
  ne,
  or,
  gt,
  sql,
  projects,
  usageEvents,
  users,
  virtualKeys,
  gte,
  isNotNull,
  type Db,
} from "@regulait/db";
import {
  MONITOR_RULES,
  MONITOR_RULE_IDS,
  effectiveRiskRating,
  evaluateMonitorRules,
  kriStates,
  kriSubjectKey,
  reconcileAlerts,
  type MonitorAgentInput,
  type MonitorCredentialInput,
  type MonitorKriInput,
  type MonitorRuleId,
  type MonitorServedModelInput,
  type MonitorTrafficInput,
  type MonitorVendorInput,
  type OffStackServing,
} from "@regulait/shared";
import { computeDependencyGraph } from "./dependency-graph.js";
import { computeTrustDashboard } from "./trust-dashboard.js";
import { ownershipFlagFor } from "./inventory.js";
import { TRACE_EVAL_WINDOW_DAYS, traceSummaryForAgents } from "./trace-evaluation.js";
import { notifyGovernanceAlerts } from "./chatops.js";
import { computeCredentialInventory } from "./credential-inventory.js";
import { loadOrgSettings } from "./org-settings.js";
import { kriMonitorInput } from "./kri.js";

const NO_IDENTITY = "00000000-0000-0000-0000-000000000000";

export const MONITOR_AUDIT_RULE_IDS = {
  raised: "governance-alert-raised",
  resolved: "governance-alert-resolved",
  acknowledged: "governance-alert-acknowledged",
  evaluated: "governance-monitor-evaluated",
  /** review fix: an optional rule input failed; that rule was not evaluated */
  inputFailed: "governance-monitor-input-failed",
} as const;

export interface MonitorRunResult {
  evaluatedAt: string;
  /** ADR-0162 — chat deliveries of newly raised alerts */
  notified: { posted: number; failed: number };
  raised: number;
  refreshed: number;
  resolved: number;
  active: number;
  /** rules whose optional input failed this pass: not evaluated, so their
   * open episodes were left as they were (review fix) */
  notEvaluated: string[];
}

/** the optional rule inputs: each feeds exactly one rule, and a failure to
 * load it skips that rule for the pass instead of failing every rule */
export interface MonitorOptionalInputs {
  servedModels: (db: Db, now: Date) => Promise<MonitorServedModelInput[]>;
  traffic: (db: Db, now: Date) => Promise<MonitorTrafficInput>;
  credentials: (db: Db, now: Date) => Promise<MonitorCredentialInput>;
  /** ADR-0173 batch 2c — every KRI, measured */
  kris: (db: Db, now: Date) => Promise<MonitorKriInput[]>;
}
const OPTIONAL_INPUT_RULE: Record<keyof MonitorOptionalInputs, MonitorRuleId> = {
  servedModels: "served_model_drift",
  traffic: "unregistered_ai_traffic",
  credentials: "stale_credentials",
  kris: "kri_threshold_breached",
};

export async function runGovernanceMonitor(
  db: Db,
  opts: {
    now?: Date;
    actorUserId?: string | null;
    /** AER-043 TEST SEAM: awaited after the active-alert read and the plan,
     *  before any write — lets a test hold this pass while a concurrent one
     *  commits. Absent in production (never passed). */
    afterPlan?: (plan: ReturnType<typeof reconcileAlerts>) => Promise<void>;
    /** TEST SEAM: replace an optional input's loader (e.g. one that throws).
     *  Absent in production. */
    optionalInputs?: Partial<MonitorOptionalInputs>;
  } = {},
): Promise<MonitorRunResult> {
  const now = opts.now ?? new Date();
  const actor = opts.actorUserId ?? NO_IDENTITY;

  // Review fix: an OPTIONAL input (one rule's own ledger read) that fails
  // leaves that rule unevaluated for this pass — its open episodes are neither
  // refreshed nor resolved — and is audited; every other rule still runs.
  const loaders: MonitorOptionalInputs = {
    servedModels: servedModelsByAgent,
    traffic: unregisteredTrafficInput,
    credentials: (d, n) => staleCredentialsInput(d, n),
    kris: kriMonitorInput,
    ...opts.optionalInputs,
  };
  const failedInputs: Array<{ input: keyof MonitorOptionalInputs; ruleId: MonitorRuleId; error: string }> = [];
  const optional = async <K extends keyof MonitorOptionalInputs>(
    input: K,
  ): Promise<Awaited<ReturnType<MonitorOptionalInputs[K]>> | undefined> => {
    try {
      return (await loaders[input](db, now)) as Awaited<ReturnType<MonitorOptionalInputs[K]>>;
    } catch (err) {
      failedInputs.push({ input, ruleId: OPTIONAL_INPUT_RULE[input], error: (err instanceof Error ? err.message : String(err)).slice(0, 500) });
      return undefined;
    }
  };

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
  // ADR-0164 — approved-use-case traffic that routing served off the approved stack
  const offStack = await offStackServingByUseCase(db, now);
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
        servedOutsideStack: offStack.get(n.id!) ?? [],
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
    // ADR-0160 — what each agent actually returned, per continuous trace evaluation
    const traces = new Map(
      (await traceSummaryForAgents(db, { now, agentIds: relevantAgentIds })).map((t) => [t.agentId, t]),
    );
    for (const a of rows) {
      agentMap.set(a.id, {
        id: a.id,
        name: a.name,
        halted: a.haltedAt !== null,
        enabled: a.enabled,
        lifecycleStatus: a.lifecycleStatus,
        ownership: ownershipFlagFor(a.ownerUserId, a.ownerDisabledAt !== null),
        modelCardApproved: approvedSet.has(a.id),
        outputLeaks: traces.has(a.id)
          ? {
              flagged: traces.get(a.id)!.flagged,
              evaluated: traces.get(a.id)!.evaluated,
              byDetector: traces.get(a.id)!.leaksByDetector,
            }
          : null,
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
  // ADR-0173 batch 2c — KRIs; one below its minimum samples HOLDS its episode
  const kriInput = await optional("kris");
  const heldSubjects = new Set(
    kriStates(kriInput ?? [])
      .filter((s) => s.state === "insufficient")
      .map((s) => `kri_threshold_breached|${kriSubjectKey(s.kri.id)}`),
  );

  const findings = evaluateMonitorRules({
    useCases,
    agents: agentMap,
    vendors: vendorMap,
    risks,
    dimensions: trust.dimensions,
    labels,
    // ADR-0175 A4 / A9 — read from the usage ledger; both observe only
    servedModels: await optional("servedModels"),
    traffic: await optional("traffic"),
    // ADR-0175 A7 — always evaluated (an explicit "not alerting" input when
    // the org has it off), so turning alerting off resolves the open episodes
    credentials: await optional("credentials"),
    kris: kriInput,
  });
  const notEvaluated = new Set<string>(failedInputs.map((f) => f.ruleId));
  for (const f of failedInputs) {
    await db.insert(auditLog).values({
      userId: actor,
      objectType: "governance_monitor",
      objectId: null,
      detail: { ruleId: f.ruleId, input: f.input, error: f.error },
      effect: "deny",
      ruleId: MONITOR_AUDIT_RULE_IDS.inputFailed,
      ruleChain: [],
      reason: `governance monitor: rule ${f.ruleId} NOT evaluated this pass — its input (${f.input}) failed: ${f.error}`,
    });
  }

  // -- reconcile -------------------------------------------------------------
  const active = await db
    .select({ id: governanceAlerts.id, ruleId: governanceAlerts.ruleId, subjectKey: governanceAlerts.subjectKey, title: governanceAlerts.title })
    .from(governanceAlerts)
    .where(ne(governanceAlerts.status, "resolved"));
  const plan = reconcileAlerts(active, findings, new Set(MONITOR_RULE_IDS.filter((r) => !notEvaluated.has(r))), heldSubjects);
  if (opts.afterPlan) await opts.afterPlan(plan);

  const raisedIds: string[] = [];
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
    raisedIds.push(inserted[0].id);
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
  // AER-043: counts are the rows THIS pass actually changed, not what it
  // planned — a concurrent pass (scheduler + manual evaluate) may have raised
  // or resolved the same alert first, and the loser must not report or audit
  // an effect it did not have.
  let refreshedCount = 0;
  let resolvedCount = 0;
  for (const { id, finding } of plan.refresh) {
    const touched = await db
      .update(governanceAlerts)
      .set({ lastDetectedAt: now, title: finding.title, detail: finding.detail, severity: finding.severity })
      .where(and(eq(governanceAlerts.id, id), ne(governanceAlerts.status, "resolved")))
      .returning({ id: governanceAlerts.id });
    refreshedCount += touched.length;
  }
  for (const id of plan.resolve) {
    const [row] = await db
      .update(governanceAlerts)
      .set({ status: "resolved", resolvedAt: now })
      .where(and(eq(governanceAlerts.id, id), ne(governanceAlerts.status, "resolved")))
      .returning({ title: governanceAlerts.title, ruleId: governanceAlerts.ruleId, subjectKey: governanceAlerts.subjectKey });
    if (!row) continue;
    resolvedCount += 1;
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
    detail: { raised: raisedIds.length, refreshed: refreshedCount, resolved: resolvedCount, active: n, notEvaluated: [...notEvaluated] },
    effect: "allow",
    ruleId: MONITOR_AUDIT_RULE_IDS.evaluated,
    ruleChain: [],
    reason: `governance monitor evaluated: ${n} active alert(s)`,
  });

  // ADR-0162 — newly RAISED alerts go to opted-in chat workspaces. Best
  // effort: a chat outage must never fail a monitor pass (each failure is
  // audited by the courier).
  let notified = { posted: 0, failed: 0 };
  try {
    notified = await notifyGovernanceAlerts(db, raisedIds, opts.actorUserId ?? null);
  } catch {
    /* audited inside the courier where it can be; never fatal here */
  }

  return {
    evaluatedAt: now.toISOString(),
    notified,
    raised: raisedIds.length,
    refreshed: refreshedCount,
    resolved: resolvedCount,
    active: n,
    notEvaluated: [...notEvaluated],
  };
}

/**
 * ADR-0175 A7 — the credential inventory's flagged credentials. With the org's
 * `stale_credential_alerts` off (the default) the rule is observe-only: the
 * flags are on the inventory page and no episode is raised.
 */
export async function staleCredentialsInput(
  db: Db,
  now: Date,
  compute: typeof computeCredentialInventory = computeCredentialInventory,
): Promise<MonitorCredentialInput> {
  // review fix: observe-only costs nothing. With alerting off the inventory
  // is not computed; the explicit "not alerting" input still lets the rule
  // run, so any open episode resolves cleanly instead of being stranded.
  if (!(await loadOrgSettings(db)).staleCredentialAlerts) return { alerting: false, credentials: [] };
  const inv = await compute(db, { now });
  return {
    alerting: inv.alerting,
    credentials: inv.credentials
      .filter((c) => c.flags.length > 0)
      .map((c) => ({
        id: c.id,
        typeLabel: c.typeLabel,
        name: c.name,
        flags: c.flags,
        reasons: c.flagReasons as Record<string, string>,
        manageAt: c.manageAt,
      })),
  };
}

/**
 * ADR-0164 — measured dispatches, per APPROVED use case, that were requested
 * for an agent of its approved stack (`intended_agent_ids`) and served by an
 * agent outside it. Read from the usage ledger, which stamps both the
 * requested and the served agent on every dispatch; nothing here reads or
 * changes routing. Same window as continuous trace evaluation.
 */
export async function offStackServingByUseCase(db: Db, now: Date): Promise<Map<string, OffStackServing[]>> {
  const out = new Map<string, OffStackServing[]>();
  const ucs = await db
    .select({ id: aiUseCases.id, intendedAgentIds: aiUseCases.intendedAgentIds })
    .from(aiUseCases)
    .where(eq(aiUseCases.status, "approved"));
  const stackIds = [...new Set(ucs.flatMap((u) => (u.intendedAgentIds ?? []) as string[]))];
  if (stackIds.length === 0) return out;
  const since = new Date(now.getTime() - TRACE_EVAL_WINDOW_DAYS * 86_400_000);
  const rows = await db
    .select({
      requested: usageEvents.requestedAgentId,
      served: usageEvents.agentId,
      calls: count(),
      last: sql<Date>`max(${usageEvents.at})`,
    })
    .from(usageEvents)
    .where(
      and(
        eq(usageEvents.objectType, "agent"),
        inArray(usageEvents.requestedAgentId, stackIds),
        isNotNull(usageEvents.agentId),
        ne(usageEvents.agentId, usageEvents.requestedAgentId),
        gte(usageEvents.at, since),
      ),
    )
    .groupBy(usageEvents.requestedAgentId, usageEvents.agentId);
  if (rows.length === 0) return out;
  const nameIds = [...new Set(rows.flatMap((r) => [r.requested!, r.served!]))];
  const names = new Map(
    (await db.select({ id: agents.id, name: agents.name }).from(agents).where(inArray(agents.id, nameIds))).map((a) => [a.id, a.name]),
  );
  const nameOf = (id: string) => names.get(id) ?? id;
  for (const uc of ucs) {
    const stack = new Set((uc.intendedAgentIds ?? []) as string[]);
    const byServed = new Map<string, OffStackServing>();
    for (const r of rows) {
      if (!stack.has(r.requested!) || stack.has(r.served!)) continue;
      const calls = Number(r.calls);
      const last = new Date(r.last).toISOString();
      const o = byServed.get(r.served!) ?? {
        servedAgentId: r.served!,
        servedAgentName: nameOf(r.served!),
        requested: [],
        calls: 0,
        lastServedAt: last,
        windowDays: TRACE_EVAL_WINDOW_DAYS,
      };
      o.requested.push({ agentId: r.requested!, name: nameOf(r.requested!), calls });
      o.calls += calls;
      if (last > o.lastServedAt) o.lastServedAt = last;
      byServed.set(r.served!, o);
    }
    if (byServed.size) {
      out.set(
        uc.id,
        [...byServed.values()].map((o) => ({ ...o, requested: o.requested.sort((a, b) => a.name.localeCompare(b.name)) })),
      );
    }
  }
  return out;
}

/**
 * ADR-0175 A4 — what the providers SAID they served, per agent, over the
 * monitor window: ledger rows that carry a provider-reported model, grouped by
 * (configured id, served id). Each row is compared with the configured id it
 * was dispatched under (`usage_events.model`), not the agent's current one, so
 * a config change inside the window is not mistaken for drift. Rows where the
 * provider reported nothing are skipped — never guessed. The pins come from
 * APPROVED, unexpired model cards (`pinned_model_version`).
 */
export async function servedModelsByAgent(db: Db, now: Date): Promise<MonitorServedModelInput[]> {
  const since = new Date(now.getTime() - TRACE_EVAL_WINDOW_DAYS * 86_400_000);
  const rows = await db
    .select({
      agentId: usageEvents.agentId,
      configured: usageEvents.model,
      served: usageEvents.servedModel,
      calls: count(),
      last: sql<Date>`max(${usageEvents.at})`,
    })
    .from(usageEvents)
    .where(
      and(
        eq(usageEvents.objectType, "agent"),
        isNotNull(usageEvents.agentId),
        isNotNull(usageEvents.model),
        isNotNull(usageEvents.servedModel),
        gte(usageEvents.at, since),
      ),
    )
    .groupBy(usageEvents.agentId, usageEvents.model, usageEvents.servedModel);
  if (rows.length === 0) return [];
  const agentIds = [...new Set(rows.map((r) => r.agentId!))];
  const agentRows = await db
    .select({ id: agents.id, name: agents.name, expected: agents.expectedServedModel })
    .from(agents)
    .where(inArray(agents.id, agentIds));
  const names = new Map(agentRows.map((a) => [a.id, a.name]));
  const expected = new Map(agentRows.map((a) => [a.id, a.expected]));
  const pins = new Map<string, string[]>();
  for (const p of await db
    .selectDistinct({ agentId: modelCards.agentId, pin: modelCards.pinnedModelVersion })
    .from(modelCardApprovals)
    .innerJoin(modelCards, eq(modelCards.id, modelCardApprovals.cardId))
    .where(
      and(
        inArray(modelCards.agentId, agentIds),
        isNotNull(modelCards.pinnedModelVersion),
        eq(modelCardApprovals.status, "approved"),
        or(isNull(modelCardApprovals.validUntil), gt(modelCardApprovals.validUntil, now)),
      ),
    )) {
    if (p.agentId && p.pin) pins.set(p.agentId, [...(pins.get(p.agentId) ?? []), p.pin]);
  }
  const byAgent = new Map<string, MonitorServedModelInput>();
  for (const r of rows) {
    const id = r.agentId!;
    const entry = byAgent.get(id) ?? {
      agentId: id,
      agentName: names.get(id) ?? id,
      expectedServedModel: expected.get(id) ?? null,
      pinnedModelVersions: pins.get(id) ?? [],
      windowDays: TRACE_EVAL_WINDOW_DAYS,
      observations: [],
    };
    entry.observations.push({
      configuredModel: r.configured!,
      servedModel: r.served!,
      calls: Number(r.calls),
      lastServedAt: new Date(r.last).toISOString(),
    });
    byAgent.set(id, entry);
  }
  return [...byAgent.values()];
}

/**
 * ADR-0175 A9 — model (`agent`) and MCP (`mcp_tool`) ledger rows over the
 * monitor window, grouped by attribution, plus the projects an APPROVED use
 * case links. The link is `ai_use_cases.project_id` — the ONLY join between
 * the register and dispatch attribution (see use-case-gate.ts's header), so
 * the rule reports spend outside that join; it cannot prove a call ungoverned.
 * The ledger records the calling user and the virtual key, not which of a
 * user's API keys was used, so key-less projectless traffic is grouped by
 * caller. Observe-only: nothing here, or downstream of the alert, blocks.
 *
 * COVERAGE matches the use-case gate (use-case-gate.ts): a use case covers its
 * project only while it is `approved` AND its approval has not run out
 * (`approved_until` NULL or in the future). The window scan is served by
 * `usage_events_object_type_at_idx` (object_type, at).
 */
/** the A9 window scan over model and MCP ledger rows (exported so a test can
 * EXPLAIN exactly this query against `usage_events_object_type_at_idx`) */
export function unregisteredTrafficQuery(db: Db, since: Date) {
  return db
    .select({
      projectId: usageEvents.projectId,
      virtualKeyId: usageEvents.virtualKeyId,
      userId: usageEvents.userId,
      objectType: usageEvents.objectType,
      calls: count(),
      cost: sql<number | null>`sum(${usageEvents.costUsd})`,
      last: sql<Date>`max(${usageEvents.at})`,
    })
    .from(usageEvents)
    .where(and(inArray(usageEvents.objectType, ["agent", "mcp_tool"]), gte(usageEvents.at, since)))
    .groupBy(usageEvents.projectId, usageEvents.virtualKeyId, usageEvents.userId, usageEvents.objectType);
}

export async function unregisteredTrafficInput(db: Db, now: Date): Promise<MonitorTrafficInput> {
  const since = new Date(now.getTime() - TRACE_EVAL_WINDOW_DAYS * 86_400_000);
  const grouped = await unregisteredTrafficQuery(db, since);
  const linked = await db
    .select({
      id: aiUseCases.id,
      name: aiUseCases.name,
      status: aiUseCases.status,
      projectId: aiUseCases.projectId,
      approvedUntil: aiUseCases.approvedUntil,
    })
    .from(aiUseCases)
    .where(isNotNull(aiUseCases.projectId));
  // the gate's rule: approved and not past its approval's lifetime
  const lapsed = (u: (typeof linked)[number]) =>
    u.status === "approved" && u.approvedUntil !== null && u.approvedUntil.getTime() <= now.getTime();
  const covering = (u: (typeof linked)[number]) => u.status === "approved" && !lapsed(u);
  const covered = new Set(linked.filter(covering).map((u) => u.projectId!));
  const linkedNotApproved = new Map<string, Array<{ id: string; name: string; status: string; approvalExpired?: true }>>();
  for (const u of linked) {
    if (covering(u)) continue;
    linkedNotApproved.set(u.projectId!, [
      ...(linkedNotApproved.get(u.projectId!) ?? []),
      { id: u.id, name: u.name, status: u.status, ...(lapsed(u) ? { approvalExpired: true as const } : {}) },
    ]);
  }
  const rows = grouped.map((r) => ({
    projectId: r.projectId,
    virtualKeyId: r.virtualKeyId,
    userId: r.userId,
    kind: r.objectType === "mcp_tool" ? ("mcp" as const) : ("model" as const),
    calls: Number(r.calls),
    costUsd: r.cost === null ? null : Number(r.cost),
    lastAt: new Date(r.last).toISOString(),
  }));
  const uncovered = rows.filter((r) => !(r.projectId && covered.has(r.projectId)));
  const projectIds = [...new Set(uncovered.flatMap((r) => (r.projectId ? [r.projectId] : [])))];
  const keyIds = [...new Set(uncovered.flatMap((r) => (r.virtualKeyId ? [r.virtualKeyId] : [])))];
  const userIds = [...new Set(uncovered.map((r) => r.userId))].filter((id) => id !== NO_IDENTITY);
  const projectNames = new Map(
    projectIds.length
      ? (await db.select({ id: projects.id, name: projects.name }).from(projects).where(inArray(projects.id, projectIds))).map((p) => [p.id, p.name])
      : [],
  );
  const virtualKeyNames = new Map(
    keyIds.length
      ? (await db.select({ id: virtualKeys.id, name: virtualKeys.name }).from(virtualKeys).where(inArray(virtualKeys.id, keyIds))).map((k) => [k.id, k.name])
      : [],
  );
  const userNames = new Map<string, string>([[NO_IDENTITY, "Platform (no user identity)"]]);
  if (userIds.length) {
    for (const u of await db
      .select({ id: users.id, name: users.displayName, email: users.email })
      .from(users)
      .where(inArray(users.id, userIds))) {
      userNames.set(u.id, u.name || u.email);
    }
  }
  return {
    windowDays: TRACE_EVAL_WINDOW_DAYS,
    rows: uncovered,
    coveredProjectIds: covered,
    linkedNotApproved,
    projectNames,
    virtualKeyNames,
    userNames,
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
      // ADR-0175 A9 subjects: projects, virtual keys and callers
      const idsOf = (prefix: string) =>
        [...new Set(rows.flatMap((r) => (r.a.subjectKey.startsWith(prefix) ? [r.a.subjectKey.slice(prefix.length)] : [])))];
      const projectIds = idsOf("project:");
      if (projectIds.length) {
        for (const p of await db.select({ id: projects.id, name: projects.name }).from(projects).where(inArray(projects.id, projectIds))) {
          labels.set(`project:${p.id}`, p.name);
        }
      }
      const keyIds = idsOf("virtual_key:");
      if (keyIds.length) {
        for (const k of await db.select({ id: virtualKeys.id, name: virtualKeys.name }).from(virtualKeys).where(inArray(virtualKeys.id, keyIds))) {
          labels.set(`virtual_key:${k.id}`, k.name);
        }
      }
      // ADR-0173 batch 2c — KRI subjects
      const kriIds = idsOf("kri:");
      if (kriIds.length) {
        for (const k of await db.select({ id: kris.id, name: kris.name }).from(kris).where(inArray(kris.id, kriIds))) {
          labels.set(`kri:${k.id}`, k.name);
        }
      }
      const callerIds = idsOf("caller:").filter((id) => id !== NO_IDENTITY);
      if (idsOf("caller:").includes(NO_IDENTITY)) labels.set(`caller:${NO_IDENTITY}`, "Platform (no user identity)");
      if (callerIds.length) {
        for (const u of await db.select({ id: users.id, name: users.displayName, email: users.email }).from(users).where(inArray(users.id, callerIds))) {
          labels.set(`caller:${u.id}`, u.name || u.email);
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
