/**
 * ADR-0148 — THE TRUST DASHBOARD: six dimensions, risks found vs mitigated,
 * evidence coverage, and the declared likelihood × impact heatmap.
 *
 * Presentation over ledgers the platform already holds, in the posture
 * report's discipline (ADR-0082): every number is a SELECT at request time,
 * nothing is stored, and an empty ledger is UNMEASURED, never zero-is-good.
 *
 * WHAT THE RADAR NUMBER IS, AND IS NOT. Per dimension, `evidenceCoveragePct`
 * is the share of APPLICABLE controls (across active compliance packs, each
 * control classified to one dimension by `dimensionForControl`) that are
 * currently satisfied by ledger evidence or by a live attestation — exactly
 * the posture report's `evidencedPct`, sliced. It is COVERAGE, not a trust
 * score and not compliance: an auditor judges effectiveness; this counts
 * evidence. A dimension with no applicable control is `measured: false` with
 * `evidenceCoveragePct: null`, and the UI must draw a gap, not a zero.
 *
 * WHAT "MITIGATED" MEANS. A risk counts as mitigated when it is closed, or
 * when it is still live but has at least one linked control AND a declared
 * residual position (ADR-0147). An ACCEPTED risk is not mitigated — it is a
 * recorded decision to carry the risk — and is reported separately.
 *
 * Scope: org-wide by default (admin-only through the default gate, the
 * posture route's position); `?projectId=` narrows risks and pack evidence to
 * one project.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  aiRiskControls,
  aiRisks,
  aiUseCases,
  compliancePackControls,
  compliancePacks,
  count,
  eq,
  inArray,
  projects,
  type Db,
} from "@regulait/db";
import {
  AI_RISK_LEVELS,
  RISK_CATEGORY_DIMENSION,
  TRUST_DIMENSIONS,
  TRUST_DIMENSION_LABELS,
  dimensionForControl,
  type AiRiskCategory,
  type TrustDimension,
} from "@regulait/shared";
import { evaluatePack } from "./compliance-packs.js";
import { POSTURE_WINDOW_DAYS } from "./posture.js";

const RISK_STATUSES = ["open", "mitigating", "accepted", "closed"] as const;
type RiskStatus = (typeof RISK_STATUSES)[number];

export const TRUST_DEFINITIONS = {
  evidenceCoveragePct:
    "controls currently satisfied by ledger evidence or a live attestation / controls applicable, " +
    "across active compliance packs, for controls classified to this dimension (ADR-0148). " +
    "Coverage, not compliance and not a trust score.",
  risksMitigated:
    "risks that are closed, or live with at least one linked control and a declared residual " +
    "position (ADR-0147). Accepted risks are counted separately — acceptance is a decision to " +
    "carry a risk, not a mitigation.",
  heatmap:
    "live (not closed) risks by DECLARED likelihood and impact — human judgments on a three-level " +
    "scale, never arithmetic. `residualHeatmap` uses the declared residual position where one exists.",
  measured:
    "false when no active pack has a control for this dimension — draw a gap, not a zero",
} as const;

export async function computeTrustDashboard(
  db: Db,
  opts: { projectId?: string | null; now?: Date } = {},
) {
  const now = opts.now ?? new Date();
  const windowStart = new Date(now.getTime() - POSTURE_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const projectId = opts.projectId ?? null;

  // --- control coverage per dimension, from the packs' own evaluator --------
  const coverage = new Map<TrustDimension, { applicable: number; evidenced: number }>(
    TRUST_DIMENSIONS.map((d) => [d, { applicable: 0, evidenced: 0 }]),
  );
  const activePacks = await db.select().from(compliancePacks).where(eq(compliancePacks.status, "active"));
  const packsEvaluated: Array<{ framework: string; version: number; controls: number }> = [];
  for (const pack of activePacks) {
    const controls = await db
      .select()
      .from(compliancePackControls)
      .where(eq(compliancePackControls.packId, pack.id));
    const scorecard = await evaluatePack(db, {
      pack,
      controls,
      projectIds: projectId ? [projectId] : null,
      periodStart: windowStart,
      periodEnd: now,
      period: "custom",
      periodLabel: `last ${POSTURE_WINDOW_DAYS} days`,
      scopeKind: projectId ? "project" : "org",
      scopeId: projectId,
      now,
    });
    const byRef = new Map(controls.map((c) => [c.controlRef, c]));
    for (const result of scorecard.controls) {
      const row = byRef.get(result.controlRef);
      const dim = dimensionForControl({
        controlRef: result.controlRef,
        collector: row?.collector ?? result.collector,
        collectorParams: (row?.collectorParams ?? {}) as Record<string, unknown>,
      });
      const slot = coverage.get(dim)!;
      slot.applicable += 1;
      if (result.status === "satisfied" || result.status === "attested") slot.evidenced += 1;
    }
    packsEvaluated.push({ framework: pack.framework, version: pack.version, controls: controls.length });
  }

  // --- risks: by dimension and status; mitigation; heatmaps -----------------
  const riskRows = await db
    .select({
      id: aiRisks.id,
      category: aiRisks.category,
      status: aiRisks.status,
      likelihood: aiRisks.likelihood,
      impact: aiRisks.impact,
      residualLikelihood: aiRisks.residualLikelihood,
      residualImpact: aiRisks.residualImpact,
    })
    .from(aiRisks)
    .where(projectId ? eq(aiRisks.projectId, projectId) : undefined);
  const linked = riskRows.length
    ? new Set(
        (
          await db
            .selectDistinct({ riskId: aiRiskControls.riskId })
            .from(aiRiskControls)
            .where(inArray(aiRiskControls.riskId, riskRows.map((r) => r.id)))
        ).map((r) => r.riskId),
      )
    : new Set<string>();

  const risksByDim = new Map<TrustDimension, Record<RiskStatus, number>>(
    TRUST_DIMENSIONS.map((d) => [d, { open: 0, mitigating: 0, accepted: 0, closed: 0 }]),
  );
  const heat = new Map<string, number>();
  const residualHeat = new Map<string, number>();
  let mitigated = 0;
  let accepted = 0;
  for (const r of riskRows) {
    const dim = RISK_CATEGORY_DIMENSION[r.category as AiRiskCategory] ?? "compliance";
    risksByDim.get(dim)![r.status as RiskStatus] += 1;
    if (r.status === "accepted") accepted += 1;
    const hasResidual = r.residualLikelihood !== null && r.residualImpact !== null;
    if (r.status === "closed" || (r.status !== "accepted" && linked.has(r.id) && hasResidual)) mitigated += 1;
    if (r.status !== "closed") {
      const k = `${r.likelihood}|${r.impact}`;
      heat.set(k, (heat.get(k) ?? 0) + 1);
      const rk = hasResidual ? `${r.residualLikelihood}|${r.residualImpact}` : k;
      residualHeat.set(rk, (residualHeat.get(rk) ?? 0) + 1);
    }
  }
  const grid = (m: Map<string, number>) =>
    AI_RISK_LEVELS.flatMap((likelihood) =>
      AI_RISK_LEVELS.map((impact) => ({ likelihood, impact, count: m.get(`${likelihood}|${impact}`) ?? 0 })),
    );

  // --- use-case pipeline ------------------------------------------------------
  const ucCounts = await db
    .select({ status: aiUseCases.status, n: count() })
    .from(aiUseCases)
    .where(projectId ? eq(aiUseCases.projectId, projectId) : undefined)
    .groupBy(aiUseCases.status);
  const useCases: Record<string, number> = { proposed: 0, under_review: 0, approved: 0, rejected: 0, retired: 0 };
  for (const u of ucCounts) useCases[u.status] = u.n;

  const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 100) : null);
  const dimensions = TRUST_DIMENSIONS.map((key) => {
    const c = coverage.get(key)!;
    return {
      key,
      label: TRUST_DIMENSION_LABELS[key],
      measured: c.applicable > 0,
      evidenceCoveragePct: pct(c.evidenced, c.applicable),
      controlsEvidenced: c.evidenced,
      controlsApplicable: c.applicable,
      risks: risksByDim.get(key)!,
    };
  });
  const totalApplicable = dimensions.reduce((a, d) => a + d.controlsApplicable, 0);
  const totalEvidenced = dimensions.reduce((a, d) => a + d.controlsEvidenced, 0);

  return {
    generatedAt: now.toISOString(),
    window: { start: windowStart.toISOString(), end: now.toISOString(), days: POSTURE_WINDOW_DAYS },
    scope: { projectId, label: projectId ? "Project" : "Organization" },
    packsEvaluated,
    dimensions,
    totals: {
      risksFound: riskRows.length,
      risksMitigated: mitigated,
      risksAccepted: accepted,
      risksOpen: riskRows.filter((r) => r.status === "open" || r.status === "mitigating").length,
      evidenceCoveragePct: pct(totalEvidenced, totalApplicable),
      controlsEvidenced: totalEvidenced,
      controlsApplicable: totalApplicable,
      useCases,
    },
    heatmap: grid(heat),
    residualHeatmap: grid(residualHeat),
    definitions: TRUST_DEFINITIONS,
  };
}

export function registerTrustDashboardRoutes(app: FastifyInstance, db: Db): void {
  /** admin-only via the default gate (not in NON_ADMIN_ROUTES) — org-wide
   * evidence, the posture report's position (ADR-0082) */
  app.get("/v1/reports/trust", async (req, reply) => {
    const q = z.object({ projectId: z.string().uuid().optional() }).parse(req.query);
    if (q.projectId) {
      const [p] = await db.select({ id: projects.id }).from(projects).where(eq(projects.id, q.projectId));
      if (!p) return reply.status(404).send({ error: "unknown_project" });
    }
    return computeTrustDashboard(db, { projectId: q.projectId ?? null });
  });
}
