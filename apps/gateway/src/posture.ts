/**
 * ADR-0082 — THE BOARDROOM POSTURE ONE-PAGER (gap L8,
 * docs/product/GAP_ANALYSIS_CREDO_AI_2026-08.md), riding ADR-0047's rails.
 *
 * One JSON document a board can read: pack coverage, open risks, red-team
 * posture, eval coverage, spend vs budget, governance activity, audit-chain
 * anchoring, and the AI use-case pipeline. PRESENTATION over data the
 * platform already holds — and the ADR-0047 principle is preserved to the
 * letter: EVERY number below is computed by SELECT at request time over the
 * real ledgers. There is no rollup table, no stored snapshot, and nothing
 * `GET /v1/reports/posture` could serve that a re-run would not recompute.
 *
 * THREE HONESTY RULES, enforced in the shape of the payload:
 *
 *  1. AN EMPTY LEDGER IS "UNMEASURED", NEVER ZERO-IMPLIES-GOOD. A deployment
 *     that never ran a red-team run gets `redteam.measured: false` with the
 *     ADR-0081 phrasing — "unmeasured, not resisted" — not an ASR of 0. The
 *     same rule holds for evals, packs, and spend ("none recorded").
 *  2. THE ASR RIDES WITH ITS INTERVAL AND QUALITY LABEL, VERBATIM from
 *     `redteam_runs` (ADR-0068): rate, Wilson bounds, trial denominator and
 *     measurement-quality label travel together, never a bare rate.
 *  3. TAMPER RESISTANCE IS OBSERVED, NEVER CONFIGURED: the anchoring section
 *     asks the sink's medium (the ADR-0060 `observe()` grading) exactly as
 *     `GET /v1/audit/anchors` does, and reports what came back.
 *
 * Scoping: the posture view is inherently ORG-WIDE, so the route is
 * admin-only through the default gate — the exact position ADR-0047 takes
 * for an org-scoped report (only an admin may generate one). There is no
 * narrower posture; a team-scoped view is the existing scorecard.
 */
import type { FastifyInstance } from "fastify";
import {
  agents,
  aiRisks,
  aiUseCases,
  and,
  approvals,
  auditAnchors,
  auditLog,
  compliancePackControls,
  compliancePacks,
  count,
  desc,
  eq,
  evalDatasets,
  evalRuns,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  projects,
  redteamRuns,
  sql,
  usageEvents,
  users,
  type Db,
} from "@regulait/db";
import {
  AI_RISK_REGISTER_DISCLAIMER,
  REPORT_ESTIMATE_DISCLAIMER,
  RISK_CATEGORY_EVIDENCE,
  resolveReportPeriod,
} from "@regulait/shared";
import { resolveAnchorSink, type AnchorSink } from "./audit-chain.js";
import { evaluatePack } from "./compliance-packs.js";
// ADR-0089 (gap L20): the ONE ownership-flag computation, shared with the
// inventory so the two surfaces can never disagree about what "orphaned" is.
import { ownershipFlagFor } from "./inventory.js";
// ADR-0090 (gap L22): the certification-campaign line — same shared-
// computation discipline, so posture and the campaigns page agree on what
// "expired-incomplete" is.
import { certificationPostureSection } from "./grant-certification.js";
// ADR-0091 (gap L23): the SoD line — rules active / current violators,
// computed at read time against effective holdings, never auto-revoked.
import { sodPostureSection } from "./sod.js";
// ADR-0092 (gap L24): the access-recommendations line — findings by rule,
// computed at read time by the SAME computation the endpoint serves, with
// "none" and "not assessable" stated outright rather than implied by zeros.
import { recommendationsPostureSection } from "./access-recommendations.js";
import { GROUNDEDNESS_SCORER_KINDS } from "./risks.js";

/** the rolling activity window the posture view reads (denials, PII blocks,
 * pack evidence, eval runs). Spend uses the current calendar month, because
 * that is the window budgets are argued about in. */
export const POSTURE_WINDOW_DAYS = 30;

export const POSTURE_UNMEASURED_REDTEAM =
  "unmeasured, not resisted — no red-team run has ever probed this deployment";

/**
 * Compute the whole posture document from the ledgers. Exported (and taking
 * `now`) so the suite can pin the arithmetic without HTTP in the way.
 */
export async function computePostureReport(
  db: Db,
  opts: { sink?: AnchorSink | null; now?: Date } = {},
): Promise<Record<string, unknown>> {
  const now = opts.now ?? new Date();
  const windowStart = new Date(now.getTime() - POSTURE_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const month = resolveReportPeriod("current_month", now);

  // --- compliance packs: computed statuses per ACTIVE pack (ADR-0058) ------
  const activePacks = await db
    .select()
    .from(compliancePacks)
    .where(eq(compliancePacks.status, "active"))
    .orderBy(compliancePacks.framework);
  const packSection = [];
  for (const pack of activePacks) {
    const controls = await db
      .select()
      .from(compliancePackControls)
      .where(eq(compliancePackControls.packId, pack.id))
      .orderBy(compliancePackControls.controlRef);
    const scorecard = await evaluatePack(db, {
      pack,
      controls,
      projectIds: null, // org-wide — this route is admin-only (see header)
      periodStart: windowStart,
      periodEnd: now,
      period: "custom",
      periodLabel: `last ${POSTURE_WINDOW_DAYS} days`,
      scopeKind: "org",
      scopeId: null,
      now,
    });
    const t = scorecard.totals;
    packSection.push({
      packId: pack.id,
      framework: pack.framework,
      version: pack.version,
      title: pack.title,
      totals: t,
      /** COVERAGE, not compliance: the share of mapped controls with current
       * ledger evidence or a live attestation. The statement below recites
       * the counts; there is no verdict field to quote. */
      evidencedPct:
        t.controls > 0 ? Math.round(((t.satisfied + t.attested) / t.controls) * 100) : null,
      statement: scorecard.statement,
    });
  }

  // --- AI risk register: status counts + the attestation-only count --------
  const attestationOnlyCategories = Object.entries(RISK_CATEGORY_EVIDENCE)
    .filter(([, resolvers]) => resolvers.length === 1 && resolvers[0] === "none")
    .map(([category]) => category);
  const [riskCounts, attestationOnly] = await Promise.all([
    db.select({ status: aiRisks.status, n: count() }).from(aiRisks).groupBy(aiRisks.status),
    attestationOnlyCategories.length
      ? db
          .select({ n: count() })
          .from(aiRisks)
          .where(
            inArray(aiRisks.category, attestationOnlyCategories as (typeof aiRisks.category.enumValues)[number][]),
          )
      : Promise.resolve([{ n: 0 }]),
  ]);
  const riskByStatus = new Map(riskCounts.map((r) => [r.status, r.n]));
  const risks = {
    open: riskByStatus.get("open") ?? 0,
    mitigating: riskByStatus.get("mitigating") ?? 0,
    accepted: riskByStatus.get("accepted") ?? 0,
    closed: riskByStatus.get("closed") ?? 0,
    total: riskCounts.reduce((a, r) => a + r.n, 0),
    /** named, per ADR-0081: risks in categories NO ledger measures — their
     * evidence is "none — attestation only", and the board should know how
     * many of its risks rest on attestation rather than measurement */
    attestationOnly: attestationOnly[0]?.n ?? 0,
    disclaimer: AI_RISK_REGISTER_DISCLAIMER,
  };

  // --- red-team posture: latest ASR verbatim, or unmeasured outright -------
  const [latestRedteam] = await db
    .select({
      id: redteamRuns.id,
      agentName: redteamRuns.agentName,
      asr: redteamRuns.asr,
      asrLower: redteamRuns.asrLower,
      asrUpper: redteamRuns.asrUpper,
      asrTrials: redteamRuns.asrTrials,
      measurementQuality: redteamRuns.measurementQuality,
      platformHeld: redteamRuns.platformHeld,
      startedAt: redteamRuns.startedAt,
    })
    .from(redteamRuns)
    .orderBy(desc(redteamRuns.startedAt))
    .limit(1);
  const [redteamInWindow, asrTrend] = await Promise.all([
    db.select({ n: count() }).from(redteamRuns).where(gte(redteamRuns.startedAt, windowStart)),
    db
      .select({
        startedAt: redteamRuns.startedAt,
        asr: redteamRuns.asr,
        measurementQuality: redteamRuns.measurementQuality,
        agentName: redteamRuns.agentName,
      })
      .from(redteamRuns)
      .where(isNotNull(redteamRuns.asr))
      .orderBy(desc(redteamRuns.startedAt))
      .limit(12),
  ]);
  const redteam = latestRedteam
    ? {
        measured: true as const,
        runsInWindow: redteamInWindow[0]?.n ?? 0,
        latest: latestRedteam,
        /** newest-first when read from the ledger; reversed so a chart reads
         * left-to-right in time */
        trend: [...asrTrend].reverse(),
        note:
          "attack-success rate verbatim from the latest run (ADR-0068): the rate never travels " +
          "without its Wilson interval, trial denominator and measurement-quality label",
      }
    : {
        measured: false as const,
        runsInWindow: 0,
        latest: null,
        trend: [],
        note: POSTURE_UNMEASURED_REDTEAM,
      };

  // --- eval / groundedness summary -----------------------------------------
  const [evalCount, groundedRuns] = await Promise.all([
    db.select({ n: count() }).from(evalRuns).where(gte(evalRuns.startedAt, windowStart)),
    db
      .select({
        passRate: evalRuns.passRate,
        cases: evalRuns.cases,
        scorerKind: evalDatasets.scorerKind,
        startedAt: evalRuns.startedAt,
      })
      .from(evalRuns)
      .innerJoin(
        evalDatasets,
        and(eq(evalRuns.datasetId, evalDatasets.id), eq(evalRuns.datasetVersion, evalDatasets.version)),
      )
      .where(
        and(
          gte(evalRuns.startedAt, windowStart),
          inArray(evalDatasets.scorerKind, [...GROUNDEDNESS_SCORER_KINDS]),
        ),
      )
      .orderBy(desc(evalRuns.startedAt)),
  ]);
  const evals = {
    runsInWindow: evalCount[0]?.n ?? 0,
    groundedness: {
      runsInWindow: groundedRuns.length,
      latest: groundedRuns[0] ?? null,
      note:
        groundedRuns.length === 0
          ? "unmeasured — no groundedness eval ran in the window; hallucination risk is unmeasured here, not absent"
          : undefined,
    },
    note: (evalCount[0]?.n ?? 0) === 0 ? "unmeasured — no eval run in the window" : undefined,
  };

  // --- spend vs budget: the current calendar month, per the ONE ledger -----
  const [monthAgg, monthByProject, unattributed, budgetedProjects, dailyRows] = await Promise.all([
    db
      .select({
        n: count(),
        costUsd: sql<number>`coalesce(sum(${usageEvents.costUsd}), 0)::float8`,
      })
      .from(usageEvents)
      .where(and(gte(usageEvents.at, month.start), lt(usageEvents.at, month.end))),
    db
      .select({
        projectId: usageEvents.projectId,
        costUsd: sql<number>`coalesce(sum(${usageEvents.costUsd}), 0)::float8`,
      })
      .from(usageEvents)
      .where(
        and(gte(usageEvents.at, month.start), lt(usageEvents.at, month.end), isNotNull(usageEvents.projectId)),
      )
      .groupBy(usageEvents.projectId),
    db
      .select({ costUsd: sql<number>`coalesce(sum(${usageEvents.costUsd}), 0)::float8` })
      .from(usageEvents)
      .where(
        and(gte(usageEvents.at, month.start), lt(usageEvents.at, month.end), isNull(usageEvents.projectId)),
      ),
    db
      .select({ id: projects.id, name: projects.name, budgetUsd: projects.budgetUsd, budgetPeriod: projects.budgetPeriod })
      .from(projects)
      .where(isNotNull(projects.budgetUsd)),
    db
      .select({
        day: sql<string>`to_char(date_trunc('day', ${usageEvents.at}), 'YYYY-MM-DD')`,
        costUsd: sql<number>`coalesce(sum(${usageEvents.costUsd}), 0)::float8`,
      })
      .from(usageEvents)
      .where(gte(usageEvents.at, new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000)))
      .groupBy(sql`date_trunc('day', ${usageEvents.at})`)
      .orderBy(sql`date_trunc('day', ${usageEvents.at})`),
  ]);
  // per-project budget standing, honoured PER THE PROJECT'S OWN SEMANTICS:
  // budget_period='monthly' compares this month's spend; 'none' is a LIFETIME
  // cumulative budget, so the comparison is all-time — the same windows the
  // pillar-5 enforcement gate applies.
  const monthSpend = new Map(monthByProject.map((r) => [r.projectId!, r.costUsd]));
  const lifetimeIds = budgetedProjects.filter((p) => p.budgetPeriod !== "monthly").map((p) => p.id);
  const lifetimeByProject = lifetimeIds.length
    ? await db
        .select({
          projectId: usageEvents.projectId,
          costUsd: sql<number>`coalesce(sum(${usageEvents.costUsd}), 0)::float8`,
        })
        .from(usageEvents)
        .where(inArray(usageEvents.projectId, lifetimeIds))
        .groupBy(usageEvents.projectId)
    : [];
  const lifetimeSpend = new Map(lifetimeByProject.map((r) => [r.projectId!, r.costUsd]));
  const budgets = budgetedProjects.map((p) => {
    const spentUsd = p.budgetPeriod === "monthly" ? (monthSpend.get(p.id) ?? 0) : (lifetimeSpend.get(p.id) ?? 0);
    return {
      projectId: p.id,
      projectName: p.name,
      budgetUsd: p.budgetUsd!,
      budgetPeriod: p.budgetPeriod,
      spentUsd,
      overBudget: spentUsd > p.budgetUsd!,
    };
  });
  const spend = {
    period: { label: month.label, start: month.start.toISOString(), end: month.end.toISOString() },
    totalCostUsd: monthAgg[0]?.costUsd ?? 0,
    events: monthAgg[0]?.n ?? 0,
    unattributedCostUsd: unattributed[0]?.costUsd ?? 0,
    budgets,
    overBudgetProjects: budgets.filter((b) => b.overBudget).length,
    dailyTrend: dailyRows,
    estimate: true,
    disclaimer: REPORT_ESTIMATE_DISCLAIMER,
    note: (monthAgg[0]?.n ?? 0) === 0 ? "none recorded — no metered call this month" : undefined,
  };

  // --- governance activity over the window ---------------------------------
  const windowAudit = and(gte(auditLog.at, windowStart), lt(auditLog.at, now));
  const [denials, piiBlocks, decidedInWindow, pendingApprovals] = await Promise.all([
    db.select({ n: count() }).from(auditLog).where(and(windowAudit, eq(auditLog.effect, "deny"))),
    db
      .select({ n: count() })
      .from(auditLog)
      .where(and(windowAudit, eq(auditLog.effect, "deny"), sql`${auditLog.ruleId} LIKE 'pii-%'`)),
    db
      .select({ n: count() })
      .from(approvals)
      .where(
        and(
          gte(approvals.requestedAt, windowStart),
          lt(approvals.requestedAt, now),
          inArray(approvals.status, ["approved", "denied"]),
        ),
      ),
    db.select({ n: count() }).from(approvals).where(eq(approvals.status, "pending")),
  ]);
  const governance = {
    denials: denials[0]?.n ?? 0,
    piiBlocks: piiBlocks[0]?.n ?? 0,
    approvalsPending: pendingApprovals[0]?.n ?? 0, // current, not windowed
    approvalsDecidedInWindow: decidedInWindow[0]?.n ?? 0,
    note:
      "counts from the one hash-chained audit trail and the one approvals queue — every governed " +
      "decision the gateway actually took in the window",
  };

  // --- audit-chain anchoring: OBSERVED grading, never configuration --------
  const sink = opts.sink === undefined ? resolveAnchorSink() : opts.sink;
  const [anchorAgg] = await db
    .select({ n: count(), lastAt: sql<string>`max(${auditAnchors.createdAt})` })
    .from(auditAnchors);
  const observation = sink ? ((await sink.observe?.()) ?? null) : null;
  const tamperResistant = observation?.tamperResistant ?? sink?.tamperResistant ?? false;
  const auditChain = {
    anchors: anchorAgg?.n ?? 0,
    latestAnchorAt: anchorAgg?.lastAt ?? null,
    sink: sink ? { destination: sink.destination, tamperResistant, mode: observation?.mode ?? null } : null,
    disclosure: sink
      ? (observation?.disclosure ??
        (tamperResistant
          ? "Anchors are externalized to tamper-resistant storage."
          : "Anchors are buffered to a medium this host can still rewrite. Until they reach WORM storage they are a consistency check, not evidence."))
      : "No anchor sink is configured: anchors exist only in this database and are NOT tamper-resistant.",
  };

  // --- ADR-0089 (gap L20): agent ownership coverage ------------------------
  // Computed at read time from the agent rows joined to the users table —
  // every count is a fact about recorded governance state, and "unowned" is
  // an explicit figure, never an implied gap. Ownership is a governance
  // record, not authentication.
  const agentRows = await db
    .select({ id: agents.id, ownerUserId: agents.ownerUserId, lifecycleStatus: agents.lifecycleStatus })
    .from(agents);
  const agentOwnerIds = [...new Set(agentRows.map((a) => a.ownerUserId).filter((o): o is string => o !== null))];
  const agentOwnerRows = agentOwnerIds.length
    ? await db
        .select({ id: users.id, disabledAt: users.disabledAt })
        .from(users)
        .where(inArray(users.id, agentOwnerIds))
    : [];
  const disabledOwners = new Set(agentOwnerRows.filter((u) => u.disabledAt !== null).map((u) => u.id));
  const ownershipCounts = { owned: 0, unowned: 0, orphaned: 0 };
  const lifecycleCounts = { active: 0, deprecated: 0, retired: 0 };
  for (const a of agentRows) {
    ownershipCounts[ownershipFlagFor(a.ownerUserId, a.ownerUserId !== null && disabledOwners.has(a.ownerUserId))] += 1;
    lifecycleCounts[a.lifecycleStatus] += 1;
  }
  const agentOwnership = {
    total: agentRows.length,
    ...ownershipCounts,
    lifecycle: lifecycleCounts,
    note:
      "ownership is a governance record, not authentication: 'unowned' agents have no recorded " +
      "owner (a flag, never a default); 'orphaned' agents have an owner whose account is " +
      "deactivated. Retired agents refuse dispatch; deprecated agents only warn. Orphan " +
      "detection sees only this deployment's own user rows.",
  };

  // --- ADR-0090 (gap L22): grant certification campaigns -------------------
  // Computed at read time via the ONE effective-status projection the
  // campaigns API uses: 'expired-incomplete' (past due with undecided items)
  // is a visible posture fact, and "none run" is stated outright rather than
  // implied by a zero.
  const certificationCampaigns = await certificationPostureSection(db, now);

  // --- ADR-0091 (gap L23): toxic-combination SoD ---------------------------
  // Rules active / current violations, computed at read time against
  // effective holdings (direct ∪ role-derived − revocations). "None defined"
  // is stated outright; existing violators are surfaced, never auto-revoked.
  const sod = await sodPostureSection(db);

  // --- ADR-0092 (gap L24): access recommendations --------------------------
  // Findings by deterministic rule (queries with reasons), computed at read
  // time; "none" is a computed fact, "not assessable" is stated, and nothing
  // in the recommendation layer ever executes on its own.
  const accessRecommendations = await recommendationsPostureSection(db, now);

  // --- AI use-case pipeline ------------------------------------------------
  const useCaseCounts = await db
    .select({ status: aiUseCases.status, n: count() })
    .from(aiUseCases)
    .groupBy(aiUseCases.status);
  const ucByStatus = new Map(useCaseCounts.map((r) => [r.status, r.n]));
  const useCases = {
    proposed: ucByStatus.get("proposed") ?? 0,
    underReview: ucByStatus.get("under_review") ?? 0,
    approved: ucByStatus.get("approved") ?? 0,
    rejected: ucByStatus.get("rejected") ?? 0,
    retired: ucByStatus.get("retired") ?? 0,
    total: useCaseCounts.reduce((a, r) => a + r.n, 0),
  };

  return {
    generatedAt: now.toISOString(),
    window: { start: windowStart.toISOString(), end: now.toISOString(), days: POSTURE_WINDOW_DAYS },
    packs: {
      active: packSection,
      note:
        packSection.length === 0
          ? "no active compliance pack — control coverage is unmeasured here, not satisfied"
          : "coverage counts against each pack's control mapping (ADR-0058), never a compliance verdict",
    },
    risks,
    redteam,
    evals,
    spend,
    governance,
    auditChain,
    agentOwnership,
    certificationCampaigns,
    sod,
    accessRecommendations,
    useCases,
    note:
      "computed live from this deployment's own ledgers at request time — no rollup table, no " +
      "stored snapshot (ADR-0047's principle). This is a window over what the ledgers hold, not " +
      "a measure of real-world exposure.",
  };
}

export function registerPostureRoutes(
  app: FastifyInstance,
  db: Db,
  opts: { sink?: AnchorSink | null } = {},
): void {
  /** admin-only via the default gate (not in NON_ADMIN_ROUTES) — the org-wide
   * posture, the exact position ADR-0047 takes for an org-scoped report */
  app.get("/v1/reports/posture", async () =>
    computePostureReport(db, opts.sink !== undefined ? { sink: opts.sink } : {}),
  );
}
