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
  // review fix: who SERVED each call, from the agent row — a demo factor
  // applies only to calls a mock-provider agent served
  const servedByMock = sql<boolean>`coalesce(${agents.provider} = 'mock', false)`;
  const usage = await db
    .select({
      model: usageEvents.model,
      servedByMock,
      calls: sql<number>`count(*)::int`,
      callsWithTokens: sql<number>`(count(*) FILTER (WHERE ${withTokens}))::int`,
      inputTokens: sql<number>`coalesce(sum(${usageEvents.inputTokens}) FILTER (WHERE ${withTokens}), 0)::bigint`,
      outputTokens: sql<number>`coalesce(sum(${usageEvents.outputTokens}) FILTER (WHERE ${withTokens}), 0)::bigint`,
    })
    .from(usageEvents)
    .leftJoin(agents, eq(agents.id, usageEvents.agentId))
    .where(
      and(
        eq(usageEvents.objectType, "agent"),
        gte(usageEvents.at, since),
        opts.projectId === null ? undefined : eq(usageEvents.projectId, opts.projectId),
      ),
    )
    .groupBy(usageEvents.model, servedByMock);
  const rows = await loadEnergyFactors(db);
  const org = await loadOrgSettings(db);
  return estimateEnergy({
    windowDays: opts.windowDays,
    usage: usage.map((u) => ({
      model: u.model,
      servedByMock: u.servedByMock === true,
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
      // never a real model, whatever it is called. Review fix: a mock agent
      // naming the model is not enough; NO other agent may name it either,
      // or a real model could borrow the demo value by sharing its id. (The
      // estimate also applies a demo factor to mock-served calls only.)
      const named = await db
        .select({ provider: agents.provider })
        .from(agents)
        .where(sql`lower(${agents.model}) = lower(${body.subject})`);
      if (!named.some((a) => a.provider === "mock")) {
        return reply.status(422).send({
          error: "demo_factor_not_mock",
          detail: "a demo factor may only be set for a model served by the mock provider. Nothing was saved.",
        });
      }
      if (named.some((a) => a.provider !== "mock")) {
        return reply.status(422).send({
          error: "demo_factor_not_mock",
          detail:
            "a demo factor may only be set for a model no real provider serves: an agent of another provider uses " +
            "this model id. Nothing was saved.",
        });
      }
    }
    const wIn = body.kind === "model" ? body.whPer1kInput : null;
    const wOut = body.kind === "model" ? body.whPer1kOutput : null;
    const grid = body.kind === "grid" ? body.gCo2ePerKwh : null;
    const by = req.authCtx.userId ?? null;
    // Review fix: ONE UPSERT on the (kind, lower(subject)) unique index, so two
    // concurrent writes of the same factor never collide into a 500. The
    // per-factor advisory lock serialises writers of that one factor, so the
    // audit's "before" is exactly the row this write replaced.
    const { existing, row } = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`energy_factor:${body.kind}:${body.subject.toLowerCase()}`}))`);
      const [before] = await tx
        .select()
        .from(energyFactors)
        .where(and(eq(energyFactors.kind, body.kind), sql`lower(${energyFactors.subject}) = lower(${body.subject})`));
      const res = await tx.execute(sql`
        INSERT INTO ${energyFactors} ("kind", "subject", "wh_per_1k_input", "wh_per_1k_output", "g_co2e_per_kwh",
                                      "source_note", "version", "demo", "updated_by", "updated_at")
        VALUES (${body.kind}, ${body.subject}, ${wIn}, ${wOut}, ${grid}, ${body.sourceNote}, ${body.version}, ${demo}, ${by}, now())
        ON CONFLICT ("kind", lower("subject")) DO UPDATE SET
          "subject" = EXCLUDED."subject",
          "wh_per_1k_input" = EXCLUDED."wh_per_1k_input",
          "wh_per_1k_output" = EXCLUDED."wh_per_1k_output",
          "g_co2e_per_kwh" = EXCLUDED."g_co2e_per_kwh",
          "source_note" = EXCLUDED."source_note",
          "version" = EXCLUDED."version",
          "demo" = EXCLUDED."demo",
          "updated_by" = EXCLUDED."updated_by",
          "updated_at" = EXCLUDED."updated_at"
        RETURNING "id"`);
      const id = (res.rows[0] as { id: string }).id;
      const [after] = await tx.select().from(energyFactors).where(eq(energyFactors.id, id));
      await tx.insert(auditLog).values({
        userId: req.authCtx.userId ?? NIL,
        objectType: "energy_factor",
        objectId: id,
        detail: { before: before ? publicFactor(before) : null, after: publicFactor(after!) },
        effect: "allow",
        ruleId: before ? "energy-factor-updated" : "energy-factor-created",
        ruleChain: [],
        reason: `${body.kind} energy factor for '${body.subject}' ${before ? "updated" : "set"} (version ${body.version})`,
      });
      return { existing: before, row: after! };
    });
    return reply.status(existing ? 200 : 201).send({ factor: publicFactor(row) });
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
