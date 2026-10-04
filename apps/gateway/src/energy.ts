/**
 * ADR-0175 A15 — ESTIMATED ENERGY AND EMISSIONS per project and per use case.
 *
 * A read-time estimate: model tokens on the usage ledger in a window ×
 * admin-entered per-model energy factors (Wh per 1k input and output tokens)
 * × a grid intensity (gCO2e per kWh: the org default, or the row for the
 * region `org_settings.energy_region` names). The arithmetic and its honesty
 * rules are in `@regulait/shared`'s energy-estimate.ts: a model with no factor
 * is unknown, never zero, and totals say "N of M calls estimated".
 *
 * The product ships NO factor rows. Every figure this file returns carries
 * the source note and version of each factor it used, and the label
 * "estimate". Admin-only (the default gate): factors are org configuration,
 * and the estimate exposes per-project token volumes.
 *
 * A use case's estimate is its project's: `ai_use_cases.project_id` is the
 * only join between the register and the ledger (see use-case-gate.ts), so a
 * use case with no project has no attributable traffic and says so.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  agents,
  aiUseCases,
  and,
  auditLog,
  eq,
  energyFactors,
  gte,
  projects,
  sql,
  usageEvents,
  type Db,
  type EnergyFactorRow,
} from "@regulait/db";
import { estimateEnergy, type EnergyEstimate, type EnergyGridInput } from "@regulait/shared";
import { loadOrgSettings } from "./org-settings.js";

export const ENERGY_DEFAULT_WINDOW_DAYS = 30;
export const ENERGY_MAX_WINDOW_DAYS = 366;
const NIL = "00000000-0000-0000-0000-000000000000";

export const ENERGY_NOTES = {
  shipped:
    "RegulAIt ships no energy factor for any model and no grid intensity. Every factor here was entered by an " +
    "administrator, with its source and version.",
  unknown: "A model with no factor is shown as unknown, never as zero.",
};

export async function loadEnergyFactors(db: Db): Promise<EnergyFactorRow[]> {
  return db.select().from(energyFactors).orderBy(energyFactors.kind, energyFactors.subject);
}

/** the grid intensity in force: the configured region's row, else `default` */
export function effectiveGrid(rows: EnergyFactorRow[], region: string | null): (EnergyGridInput & { region: string | null }) | null {
  const grid = rows.filter((r) => r.kind === "grid" && r.gCo2ePerKwh !== null);
  const pick = (subject: string) => grid.find((r) => r.subject.toLowerCase() === subject.toLowerCase());
  const row = (region ? pick(region) : undefined) ?? pick("default");
  if (!row) return null;
  return {
    subject: row.subject,
    region: row.subject.toLowerCase() === "default" ? null : row.subject,
    gCo2ePerKwh: row.gCo2ePerKwh!,
    sourceNote: row.sourceNote,
    version: row.version,
    demo: row.demo,
  };
}

export async function computeEnergyEstimate(
  db: Db,
  opts: { projectId: string | null; windowDays: number; now?: Date },
): Promise<EnergyEstimate> {
  const now = opts.now ?? new Date();
  const since = new Date(now.getTime() - opts.windowDays * 86_400_000);
  const withTokens = sql`${usageEvents.inputTokens} IS NOT NULL AND ${usageEvents.outputTokens} IS NOT NULL`;
  const usage = await db
    .select({
      model: usageEvents.model,
      calls: sql<number>`count(*)::int`,
      callsWithTokens: sql<number>`(count(*) FILTER (WHERE ${withTokens}))::int`,
      inputTokens: sql<number>`coalesce(sum(${usageEvents.inputTokens}) FILTER (WHERE ${withTokens}), 0)::bigint`,
      outputTokens: sql<number>`coalesce(sum(${usageEvents.outputTokens}) FILTER (WHERE ${withTokens}), 0)::bigint`,
    })
    .from(usageEvents)
    .where(
      and(
        eq(usageEvents.objectType, "agent"),
        gte(usageEvents.at, since),
        opts.projectId === null ? undefined : eq(usageEvents.projectId, opts.projectId),
      ),
    )
    .groupBy(usageEvents.model);
  const rows = await loadEnergyFactors(db);
  const org = await loadOrgSettings(db);
  return estimateEnergy({
    windowDays: opts.windowDays,
    usage: usage.map((u) => ({
      model: u.model,
      calls: Number(u.calls),
      callsWithTokens: Number(u.callsWithTokens),
      inputTokens: Number(u.inputTokens),
      outputTokens: Number(u.outputTokens),
    })),
    factors: rows
      .filter((r) => r.kind === "model" && r.whPer1kInput !== null && r.whPer1kOutput !== null)
      .map((r) => ({
        subject: r.subject,
        whPer1kInput: r.whPer1kInput!,
        whPer1kOutput: r.whPer1kOutput!,
        sourceNote: r.sourceNote,
        version: r.version,
        demo: r.demo,
      })),
    grid: effectiveGrid(rows, org.energyRegion),
  });
}

const publicFactor = (r: EnergyFactorRow) => ({
  id: r.id,
  kind: r.kind,
  subject: r.subject,
  whPer1kInput: r.whPer1kInput,
  whPer1kOutput: r.whPer1kOutput,
  gCo2ePerKwh: r.gCo2ePerKwh,
  sourceNote: r.sourceNote,
  version: r.version,
  demo: r.demo,
  updatedBy: r.updatedBy,
  updatedAt: r.updatedAt,
});

const factorBody = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("model"),
      /** the model id exactly as the usage ledger records it (case-insensitive) */
      subject: z.string().trim().min(1).max(200),
      whPer1kInput: z.number().finite().min(0).max(1_000_000),
      whPer1kOutput: z.number().finite().min(0).max(1_000_000),
      sourceNote: z.string().trim().min(1).max(1000),
      version: z.string().trim().min(1).max(64),
      /** a value for a MOCK model only, labelled a demo value everywhere */
      demo: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("grid"),
      /** 'default' or a region name */
      subject: z.string().trim().min(1).max(64),
      gCo2ePerKwh: z.number().finite().min(0).max(10_000),
      sourceNote: z.string().trim().min(1).max(1000),
      version: z.string().trim().min(1).max(64),
    })
    .strict(),
]);

const estimateQuery = z
  .object({
    projectId: z.string().uuid().optional(),
    useCaseId: z.string().uuid().optional(),
    windowDays: z.coerce.number().int().min(1).max(ENERGY_MAX_WINDOW_DAYS).default(ENERGY_DEFAULT_WINDOW_DAYS),
  })
  .strict()
  .refine((q) => !(q.projectId && q.useCaseId), { message: "pass projectId or useCaseId, not both" });

export function registerEnergyRoutes(app: FastifyInstance, db: Db): void {
  app.get("/v1/energy/factors", async () => {
    const rows = await loadEnergyFactors(db);
    const org = await loadOrgSettings(db);
    return {
      factors: rows.map(publicFactor),
      region: org.energyRegion,
      grid: effectiveGrid(rows, org.energyRegion),
      notes: ENERGY_NOTES,
    };
  });

  app.put("/v1/energy/factors", async (req, reply) => {
    const body = factorBody.parse(req.body);
    const demo = body.kind === "model" ? body.demo === true : false;
    if (demo) {
      // a demo value may only describe a model the MOCK provider serves —
      // never a real model, whatever it is called
      const [mock] = await db
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.provider, "mock"), sql`lower(${agents.model}) = lower(${body.subject})`))
        .limit(1);
      if (!mock) {
        return reply.status(422).send({
          error: "demo_factor_not_mock",
          detail: "a demo factor may only be set for a model served by the mock provider. Nothing was saved.",
        });
      }
    }
    const values = {
      kind: body.kind,
      subject: body.subject,
      whPer1kInput: body.kind === "model" ? body.whPer1kInput : null,
      whPer1kOutput: body.kind === "model" ? body.whPer1kOutput : null,
      gCo2ePerKwh: body.kind === "grid" ? body.gCo2ePerKwh : null,
      sourceNote: body.sourceNote,
      version: body.version,
      demo,
      updatedBy: req.authCtx.userId,
      updatedAt: new Date(),
    };
    const [existing] = await db
      .select()
      .from(energyFactors)
      .where(and(eq(energyFactors.kind, body.kind), sql`lower(${energyFactors.subject}) = lower(${body.subject})`));
    const [row] = existing
      ? await db.update(energyFactors).set(values).where(eq(energyFactors.id, existing.id)).returning()
      : await db.insert(energyFactors).values(values).returning();
    await db.insert(auditLog).values({
      userId: req.authCtx.userId ?? NIL,
      objectType: "energy_factor",
      objectId: row!.id,
      detail: { before: existing ? publicFactor(existing) : null, after: publicFactor(row!) },
      effect: "allow",
      ruleId: existing ? "energy-factor-updated" : "energy-factor-created",
      ruleChain: [],
      reason: `${body.kind} energy factor for '${body.subject}' ${existing ? "updated" : "set"} (version ${body.version})`,
    });
    return reply.status(existing ? 200 : 201).send({ factor: publicFactor(row!) });
  });

  app.delete("/v1/energy/factors/:factorId", async (req, reply) => {
    const { factorId } = z.object({ factorId: z.string().uuid() }).parse(req.params);
    const [row] = await db.delete(energyFactors).where(eq(energyFactors.id, factorId)).returning();
    if (!row) return reply.status(404).send({ error: "unknown_energy_factor" });
    await db.insert(auditLog).values({
      userId: req.authCtx.userId ?? NIL,
      objectType: "energy_factor",
      objectId: row.id,
      detail: { before: publicFactor(row) },
      effect: "allow",
      ruleId: "energy-factor-removed",
      ruleChain: [],
      reason: `${row.kind} energy factor for '${row.subject}' removed — its calls are unknown from now on`,
    });
    return { removed: true };
  });

  app.get("/v1/energy/estimate", async (req, reply) => {
    const q = estimateQuery.parse(req.query);
    let projectId: string | null = null;
    let scope: { kind: "org" | "project" | "use_case"; id: string | null; name: string | null; projectId: string | null } = {
      kind: "org",
      id: null,
      name: null,
      projectId: null,
    };
    if (q.useCaseId) {
      const [uc] = await db
        .select({ id: aiUseCases.id, name: aiUseCases.name, projectId: aiUseCases.projectId })
        .from(aiUseCases)
        .where(eq(aiUseCases.id, q.useCaseId));
      if (!uc) return reply.status(404).send({ error: "unknown_use_case" });
      scope = { kind: "use_case", id: uc.id, name: uc.name, projectId: uc.projectId };
      if (!uc.projectId) {
        return {
          scope,
          estimate: null,
          note: "This use case links no project, so no ledger traffic can be attributed to it. Energy is unknown.",
        };
      }
      projectId = uc.projectId;
    } else if (q.projectId) {
      const [p] = await db.select({ id: projects.id, name: projects.name }).from(projects).where(eq(projects.id, q.projectId));
      if (!p) return reply.status(404).send({ error: "unknown_project" });
      scope = { kind: "project", id: p.id, name: p.name, projectId: p.id };
      projectId = p.id;
    }
    const estimate = await computeEnergyEstimate(db, { projectId, windowDays: q.windowDays });
    return {
      scope,
      estimate,
      note:
        scope.kind === "use_case"
          ? "A use case's estimate is its project's traffic: the project is the only link between the register and the usage ledger."
          : null,
    };
  });
}
