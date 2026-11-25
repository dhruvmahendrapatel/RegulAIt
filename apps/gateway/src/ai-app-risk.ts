/**
 * ADR-0363 slice 3 — risk attributes for AI apps, joined to THIS organisation's shadow-AI inventory.
 *
 *   GET /v1/ai-app-risk     the curated dataset as shipped: version, canonical digest, weights and every row with
 *                           each value's source and check date.
 *   GET /v1/shadow-ai/risk  the inventory ranked by risk: one entry per provider seen in `shadow_ai_findings`
 *                           (false positives and remediated findings left out), with the score, its factors and a
 *                           SUGGESTED site rule. Nothing here applies a rule or changes a finding.
 *
 * Read-only and admin-only (neither path is in NON_ADMIN_ROUTES). Bounded: at most `RISK_PROVIDER_CAP` providers.
 */
import type { FastifyInstance } from "fastify";
import { desc, inArray, shadowAiFindings, sql, type Db } from "@regulait/db";
import {
  AI_APP_RISK_DATASET,
  AI_APP_RISK_DATASET_VERSION,
  AI_APP_RISK_WEIGHTS,
  aiAppRiskDatasetDigest,
  scoreAiApp,
} from "@regulait/shared";

export const AI_APP_RISK_PATH = "/v1/ai-app-risk";
export const SHADOW_AI_RISK_PATH = "/v1/shadow-ai/risk";
export const RISK_PROVIDER_CAP = 500;

/** the dispositions that still describe AI use in the estate */
const IN_ESTATE = ["open", "confirmed", "sanctioned"] as const;

export function registerAiAppRiskRoutes(app: FastifyInstance, db: Db): void {
  // the dataset is a frozen module constant, so its digest is computed once
  const digest = aiAppRiskDatasetDigest();

  app.get(AI_APP_RISK_PATH, async () => ({
    version: AI_APP_RISK_DATASET_VERSION,
    digest,
    weights: AI_APP_RISK_WEIGHTS,
    rows: AI_APP_RISK_DATASET,
  }));

  app.get(SHADOW_AI_RISK_PATH, async () => {
    const groups = await db
      .select({
        provider: shadowAiFindings.provider,
        findings: sql<number>`count(*)::int`,
        observations: sql<number>`coalesce(sum(${shadowAiFindings.observationCount}), 0)::int`,
        sanctioned: sql<number>`count(*) FILTER (WHERE ${shadowAiFindings.disposition} = 'sanctioned')::int`,
        lastSeenAt: sql<string>`max(${shadowAiFindings.lastSeenAt})::text`,
      })
      .from(shadowAiFindings)
      .where(inArray(shadowAiFindings.disposition, [...IN_ESTATE]))
      .groupBy(shadowAiFindings.provider)
      .orderBy(desc(sql`count(*)`))
      .limit(RISK_PROVIDER_CAP + 1);
    const truncated = groups.length > RISK_PROVIDER_CAP;
    const ranked = groups
      .slice(0, RISK_PROVIDER_CAP)
      .map((g) => ({
        ...scoreAiApp(g.provider),
        inventory: {
          findings: g.findings,
          observations: g.observations,
          sanctionedFindings: g.sanctioned,
          lastSeenAt: g.lastSeenAt ? new Date(g.lastSeenAt).toISOString() : null,
        },
      }))
      .sort((a, b) => b.score - a.score || b.inventory.findings - a.inventory.findings || a.provider.localeCompare(b.provider));
    return {
      datasetVersion: AI_APP_RISK_DATASET_VERSION,
      datasetDigest: digest,
      providers: ranked,
      truncated,
      note: "Suggested site rules are suggestions only; nothing is applied. A provider not in the dataset scores as every attribute unknown.",
    };
  });
}
