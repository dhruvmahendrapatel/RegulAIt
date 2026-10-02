/**
 * ADR-0158 — REGULATORY INTELLIGENCE, the gateway half: the curated feed
 * (demo task G4) joined to this organisation's active packs, per-control
 * evaluation and live use cases. Pure join in
 * `packages/shared/src/regulatory-intel.ts`; this file only gathers inputs.
 *
 * The feed is read by name from `@regulait/shared` so the route works — with
 * an honest empty list — before the dataset lands, exactly like the
 * `demo:intake` CLI does for its fixtures.
 *
 * Admin-only through the default gate: it reads org-wide pack evidence, the
 * posture report's position.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { aiUseCases, compliancePackControls, compliancePacks, eq, type Db } from "@regulait/db";
import * as shared from "@regulait/shared";
import {
  REGULATORY_INTEL_NOTES,
  REGULATORY_UPDATE_STATUSES,
  computeRegulatoryImpact,
  type ControlEvaluationStatus,
  type EuAiActTier,
  type RegulatoryUpdate,
} from "@regulait/shared";
import { evaluatePack } from "./compliance-packs.js";
import { POSTURE_WINDOW_DAYS } from "./posture.js";

/** the G4 dataset, when it is exported; [] until then */
export function regulatoryFeed(): RegulatoryUpdate[] {
  const feed = (shared as unknown as { REGULATORY_UPDATES?: RegulatoryUpdate[] }).REGULATORY_UPDATES;
  return Array.isArray(feed) ? feed : [];
}

export async function computeRegulatoryFeed(
  db: Db,
  opts: { now?: Date; feed?: RegulatoryUpdate[] } = {},
) {
  const now = opts.now ?? new Date();
  const feed = opts.feed ?? regulatoryFeed();
  const windowStart = new Date(now.getTime() - POSTURE_WINDOW_DAYS * 86_400_000);

  const activePacks = await db.select().from(compliancePacks).where(eq(compliancePacks.status, "active"));
  const packVersions = new Map<string, number>();
  const controls = new Map<string, { title: string; framework: string; status: ControlEvaluationStatus }>();
  for (const pack of activePacks) {
    packVersions.set(pack.framework, pack.version);
    const rows = await db.select().from(compliancePackControls).where(eq(compliancePackControls.packId, pack.id));
    const scorecard = await evaluatePack(db, {
      pack,
      controls: rows,
      projectIds: null,
      periodStart: windowStart,
      periodEnd: now,
      period: "custom",
      periodLabel: `last ${POSTURE_WINDOW_DAYS} days`,
      scopeKind: "org",
      scopeId: null,
      now,
    });
    const titles = new Map(rows.map((r) => [r.controlRef, r.title]));
    for (const c of scorecard.controls) {
      controls.set(c.controlRef, {
        title: titles.get(c.controlRef) ?? c.controlRef,
        framework: pack.framework,
        status: c.status as ControlEvaluationStatus,
      });
    }
  }

  const useCases = await db
    .select({ id: aiUseCases.id, name: aiUseCases.name, status: aiUseCases.status, euAiActTier: aiUseCases.euAiActTier })
    .from(aiUseCases);

  const updates = computeRegulatoryImpact(feed, {
    activePacks: packVersions,
    controls,
    useCases: useCases.map((u) => ({ ...u, euAiActTier: (u.euAiActTier ?? null) as EuAiActTier | null })),
    today: now.toISOString().slice(0, 10),
  });
  return {
    generatedAt: now.toISOString(),
    window: { days: POSTURE_WINDOW_DAYS },
    summary: {
      total: updates.length,
      inForce: updates.filter((u) => u.status === "in_force").length,
      upcoming: updates.filter((u) => u.status === "upcoming").length,
      proposed: updates.filter((u) => u.status === "proposed").length,
      withControlGaps: updates.filter((u) => u.impact.controlGaps > 0).length,
      nextEffective: updates.find((u) => u.daysUntilEffective >= 0)?.key ?? null,
    },
    updates,
    notes: {
      ...REGULATORY_INTEL_NOTES,
      feed:
        feed.length === 0
          ? "No regulatory feed is loaded in this build — the list is empty, not 'nothing applies'."
          : `${feed.length} curated entries.`,
    },
  };
}

const query = z.object({
  status: z.enum(REGULATORY_UPDATE_STATUSES).optional(),
  framework: z.string().min(1).max(64).optional(),
});

export function registerRegulatoryIntelRoutes(app: FastifyInstance, db: Db): void {
  app.get("/v1/regulatory/updates", async (req) => {
    const q = query.parse(req.query);
    const out = await computeRegulatoryFeed(db);
    const updates = out.updates.filter(
      (u) => (!q.status || u.status === q.status) && (!q.framework || u.frameworks.some((f) => f.framework === q.framework)),
    );
    return { ...out, updates, filter: { status: q.status ?? null, framework: q.framework ?? null } };
  });
}
