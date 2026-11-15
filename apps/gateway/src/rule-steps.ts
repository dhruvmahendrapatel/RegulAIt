/**
 * ADR-0327 slice 2 — rule-like AI step detection at the gateway: settings, an admin-triggered scan, and suggestions.
 *
 *  - Off by default (ADR-0180): with no settings row the scan is refused (409) and reads still answer.
 *  - Turning it on, or lowering any threshold, is a `settings_relax` step-up. Every settings change, scan and dismissal
 *    writes an audit row in the same transaction.
 *  - The scan reads recent `llm` trace spans grouped per step (agent + span name), keeps runs whose captured input is a
 *    JSON object and whose output preview is complete, and runs the kernel's `induceStepRule` on them. It writes
 *    suggestions only: nothing here changes routing, entitlement or any permission decision (ADR-0327 §Decision 5).
 *  - Bounded: at most `SCAN_MAX_STEPS` steps (the costliest first), `SCAN_MAX_RUNS` runs each, a `SCAN_WINDOW_DAYS`
 *    window, and scans spaced `SCAN_SPACING_MINUTES` apart by the database clock. Induction (seconds of CPU per step)
 *    runs on a worker thread (`induceStepRuleOffThread`), one step at a time, so the event loop that serves governance
 *    decisions and the proxy path never stalls; a step whose worker fails or times out is reported, not guessed.
 *  - The projected monthly saving is the step's measured span cost over the window, scaled to 30 days, times the share
 *    of runs the rule would answer (structured share × held-out coverage). It is an estimate and says so.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  agents,
  and,
  auditLog,
  desc,
  eq,
  ruleStepSettings,
  ruleStepSuggestions,
  sql,
  traceSpans,
  type Db,
  type RuleStepSettingsRow,
  type RuleStepSuggestionRow,
} from "@regulait/db";
import {
  DEFAULT_RULE_INDUCTION_OPTIONS,
  RULE_INDUCTION_FLOORS,
  extractStepFields,
  renderInducedRule,
  type InducedRule,
  type StepRun,
} from "@regulait/optimizer-kernel";
import { induceStepRuleOffThread } from "@regulait/optimizer-kernel/offload";
import { TRACE_TRUNCATION_MARKER } from "@regulait/shared";
import { requireStepUp } from "./step-up.js";

const SETTINGS_ID = "singleton";
const NO_IDENTITY = "00000000-0000-0000-0000-000000000000";
export const SCAN_MAX_STEPS = 10;
export const SCAN_MAX_RUNS = 5_000;
export const SCAN_WINDOW_DAYS = 30;
export const SCAN_SPACING_MINUTES = 10;
const MONTH_DAYS = 30;

export const RULE_STEP_AUDIT_RULE_IDS = {
  settings: "rule_step_settings_changed",
  scan: "rule_step_scan",
  dismiss: "rule_step_suggestion_dismissed",
} as const;

type Thresholds = { minRuns: number; minAgreement: number; minCoverage: number; minCellSupport: number };
export type RuleStepSettings = Thresholds & { enabled: boolean; lastScanAt: Date | null };

export const STRICT_RULE_STEP_SETTINGS: Readonly<Thresholds> = Object.freeze({
  minRuns: DEFAULT_RULE_INDUCTION_OPTIONS.minRuns,
  minAgreement: DEFAULT_RULE_INDUCTION_OPTIONS.minAgreement,
  minCoverage: DEFAULT_RULE_INDUCTION_OPTIONS.minCoverage,
  minCellSupport: DEFAULT_RULE_INDUCTION_OPTIONS.minCellSupport,
});

const settingsBody = z
  .object({
    enabled: z.boolean().optional(),
    minRuns: z.number().int().min(RULE_INDUCTION_FLOORS.minRuns).max(100_000).optional(),
    minAgreement: z.number().min(RULE_INDUCTION_FLOORS.minAgreement).max(1).optional(),
    minCoverage: z.number().min(RULE_INDUCTION_FLOORS.minCoverage).max(1).optional(),
    minCellSupport: z.number().int().min(RULE_INDUCTION_FLOORS.minCellSupport).max(1_000).optional(),
  })
  .strict();
const listQuery = z
  .object({
    status: z.enum(["suggested", "dismissed"]).default("suggested"),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    offset: z.coerce.number().int().min(0).max(10_000).default(0),
  })
  .strict();
const idParam = z.object({ id: z.string().uuid() }).strict();

export async function loadRuleStepSettings(db: Db): Promise<RuleStepSettings> {
  const [row] = await db.select().from(ruleStepSettings).where(eq(ruleStepSettings.id, SETTINGS_ID));
  if (!row) return { enabled: false, ...STRICT_RULE_STEP_SETTINGS, lastScanAt: null };
  return pick(row);
}

function pick(row: RuleStepSettingsRow): RuleStepSettings {
  return {
    enabled: row.enabled,
    minRuns: row.minRuns,
    minAgreement: row.minAgreement,
    minCoverage: row.minCoverage,
    minCellSupport: row.minCellSupport,
    lastScanAt: row.lastScanAt,
  };
}

/** what a change loosens: switching on, or any threshold moved below its current value */
export function relaxedRuleStepSettings(body: z.infer<typeof settingsBody>, current: RuleStepSettings): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (body.enabled === true && !current.enabled) out.enabled = true;
  for (const k of ["minRuns", "minAgreement", "minCoverage", "minCellSupport"] as const) {
    const v = body[k];
    if (v !== undefined && v < current[k]) out[k] = v;
  }
  return out;
}

function view(row: RuleStepSuggestionRow & { agentName: string | null }) {
  const rule = row.rule as InducedRule;
  return {
    id: row.id,
    agentId: row.agentId,
    agentName: row.agentName,
    stepName: row.stepName,
    status: row.status,
    fields: rule.fields,
    ruleLines: renderInducedRule(rule),
    /** each trusted cell is a test case drawn from history: these inputs gave this output in held-out agreement */
    testCases: rule.cells.map((c) => ({ input: Object.fromEntries(rule.fields.map((f, i) => [f, c.key[i]])), expected: c.output, support: c.support })),
    evidence: {
      runs: row.runs,
      structuredRuns: row.structuredRuns,
      outputClasses: row.outputClasses,
      agreement: row.agreement,
      coverage: row.coverage,
    },
    savings: {
      windowDays: SCAN_WINDOW_DAYS,
      windowCostUsd: row.windowCostUsd,
      projectedMonthlySavingsUsd: row.projectedMonthlySavingsUsd,
      basis: "estimate: measured span cost over the window, scaled to 30 days, times the share of runs the rule answers",
    },
    detectedAt: row.detectedAt,
    dismissedAt: row.dismissedAt,
  };
}

type SuggestionValues = Omit<typeof ruleStepSuggestions.$inferInsert, "id" | "agentId" | "stepName" | "status" | "detectedAt" | "dismissedBy" | "dismissedAt">;
type StepScan =
  | { agentId: string; stepName: string; outcome: "rule_like"; projectedMonthlySavingsUsd: number; values: SuggestionValues }
  | { agentId: string; stepName: string; outcome: "not_rule_like"; reason: string; runs: number; structuredRuns: number };

/** Turn a step's recorded spans into kernel runs: JSON-object inputs and complete, non-empty outputs only. */
export function spansToRuns(rows: ReadonlyArray<{ inputPreview: string | null; outputPreview: string | null }>): StepRun[] {
  const runs: StepRun[] = [];
  for (const r of rows) {
    if (r.inputPreview == null || r.outputPreview == null) continue;
    if (r.outputPreview.endsWith(TRACE_TRUNCATION_MARKER) || r.outputPreview.trim() === "") continue;
    const fields = extractStepFields(r.inputPreview);
    if (fields === null) continue;
    runs.push({ fields, output: r.outputPreview });
  }
  return runs;
}

async function scan(db: Db, settings: RuleStepSettings): Promise<StepScan[]> {
  const since = sql`now() - make_interval(days => ${SCAN_WINDOW_DAYS})`;
  const steps = await db
    .select({
      agentId: traceSpans.agentId,
      stepName: traceSpans.name,
      runs: sql<number>`count(*)::int`,
      costUsd: sql<number>`coalesce(sum(${traceSpans.costUsd}), 0)::float8`,
    })
    .from(traceSpans)
    .where(
      and(
        eq(traceSpans.kind, "llm"),
        sql`${traceSpans.agentId} IS NOT NULL`,
        eq(traceSpans.status, "ok"),
        eq(traceSpans.contentWithheld, false),
        sql`${traceSpans.startedAt} >= ${since}`,
      ),
    )
    .groupBy(traceSpans.agentId, traceSpans.name)
    .having(sql`count(*) >= ${settings.minRuns}`)
    .orderBy(sql`coalesce(sum(${traceSpans.costUsd}), 0) DESC`, traceSpans.agentId, traceSpans.name)
    .limit(SCAN_MAX_STEPS);

  const results: StepScan[] = [];
  for (const step of steps) {
    const agentId = step.agentId!;
    const rows = await db
      .select({ inputPreview: traceSpans.inputPreview, outputPreview: traceSpans.outputPreview })
      .from(traceSpans)
      .where(
        and(
          eq(traceSpans.kind, "llm"),
          eq(traceSpans.agentId, agentId),
          eq(traceSpans.name, step.stepName),
          eq(traceSpans.status, "ok"),
          eq(traceSpans.contentWithheld, false),
          sql`${traceSpans.startedAt} >= ${since}`,
        ),
      )
      .orderBy(desc(traceSpans.startedAt), desc(traceSpans.id))
      .limit(SCAN_MAX_RUNS);
    const runs = spansToRuns(rows);
    // seconds of CPU per step: run it on a worker thread so the gateway's event loop keeps serving (review #862)
    const options = {
      minRuns: settings.minRuns,
      minAgreement: settings.minAgreement,
      minCoverage: settings.minCoverage,
      minCellSupport: settings.minCellSupport,
      maxRuns: SCAN_MAX_RUNS,
    };
    let result: Awaited<ReturnType<typeof induceStepRuleOffThread>>;
    try {
      result = await induceStepRuleOffThread(runs, options);
    } catch {
      // a failed or timed-out worker yields no rule: reported in the scan's audit, never guessed
      results.push({ agentId, stepName: step.stepName, outcome: "not_rule_like", reason: "induction_failed", runs: rows.length, structuredRuns: runs.length });
      continue;
    }
    if (result.status !== "rule_like") {
      results.push({ agentId, stepName: step.stepName, outcome: "not_rule_like", reason: result.reason, runs: rows.length, structuredRuns: runs.length });
      continue;
    }
    const answeredShare = rows.length === 0 ? 0 : (runs.length / rows.length) * result.evidence.coverage;
    const projected = Math.round(((step.costUsd * MONTH_DAYS) / SCAN_WINDOW_DAYS) * answeredShare * 1e6) / 1e6;
    const values = {
      rule: result.rule,
      runs: rows.length,
      structuredRuns: runs.length,
      outputClasses: result.evidence.outputClasses,
      agreement: result.evidence.agreement,
      coverage: result.evidence.coverage,
      windowCostUsd: step.costUsd,
      projectedMonthlySavingsUsd: projected,
    };
    results.push({ agentId, stepName: step.stepName, outcome: "rule_like", projectedMonthlySavingsUsd: projected, values });
  }
  return results;
}

export function registerRuleStepRoutes(app: FastifyInstance, db: Db): void {
  app.get("/v1/rule-steps/settings", async () => ({
    settings: await loadRuleStepSettings(db),
    strict: STRICT_RULE_STEP_SETTINGS,
    floors: RULE_INDUCTION_FLOORS,
  }));

  app.put("/v1/rule-steps/settings", async (req, reply) => {
    const body = settingsBody.parse(req.body);
    const current = await loadRuleStepSettings(db);
    const relaxed = relaxedRuleStepSettings(body, current);
    if (
      Object.keys(relaxed).length > 0 &&
      !(await requireStepUp(db, req, reply, { kind: "settings_relax", facts: { ruleSteps: "settings", values: relaxed } })).ok
    ) {
      return reply;
    }
    const next = {
      enabled: body.enabled ?? current.enabled,
      minRuns: body.minRuns ?? current.minRuns,
      minAgreement: body.minAgreement ?? current.minAgreement,
      minCoverage: body.minCoverage ?? current.minCoverage,
      minCellSupport: body.minCellSupport ?? current.minCellSupport,
    };
    const userId = req.authCtx.userId ?? null;
    const saved = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(ruleStepSettings)
        .values({ id: SETTINGS_ID, ...next, updatedBy: userId })
        .onConflictDoUpdate({ target: ruleStepSettings.id, set: { ...next, updatedBy: userId, updatedAt: sql`now()` } })
        .returning();
      const { lastScanAt: _ignored, ...from } = current;
      await tx.insert(auditLog).values({
        userId: userId ?? NO_IDENTITY,
        objectType: "org_settings",
        objectId: null,
        detail: { scope: "rule_steps", from, to: next, relaxed: Object.keys(relaxed) },
        effect: Object.keys(relaxed).length > 0 ? "deny" : "allow",
        ruleId: RULE_STEP_AUDIT_RULE_IDS.settings,
        ruleChain: [],
        reason: `rule-like step detection settings changed${Object.keys(relaxed).length > 0 ? ` (relaxed: ${Object.keys(relaxed).join(", ")})` : ""}`,
      });
      return row as RuleStepSettingsRow;
    });
    return { settings: pick(saved) };
  });

  app.post("/v1/rule-steps/scan", async (req, reply) => {
    const userId = req.authCtx.userId ?? null;
    // claim the scan slot atomically by the database clock, so two concurrent scans cannot both run
    const [claimed] = await db
      .update(ruleStepSettings)
      .set({ lastScanAt: sql`now()` })
      .where(
        and(
          eq(ruleStepSettings.id, SETTINGS_ID),
          eq(ruleStepSettings.enabled, true),
          sql`(${ruleStepSettings.lastScanAt} IS NULL OR ${ruleStepSettings.lastScanAt} <= now() - make_interval(mins => ${SCAN_SPACING_MINUTES}))`,
        ),
      )
      .returning();
    if (!claimed) {
      const current = await loadRuleStepSettings(db);
      if (!current.enabled) return reply.status(409).send({ error: "rule_steps_disabled", detail: "rule-like step detection is off" });
      return reply.status(429).send({ error: "rule_steps_scan_too_soon", detail: `scans are at least ${SCAN_SPACING_MINUTES} minutes apart` });
    }
    // reads and induction first (no transaction held open), then every write and the audit row together
    const results = await scan(db, pick(claimed));
    const steps = results.map((r) => (r.outcome === "rule_like" ? { agentId: r.agentId, stepName: r.stepName, outcome: r.outcome, projectedMonthlySavingsUsd: r.projectedMonthlySavingsUsd } : r));
    const found = results.filter((r) => r.outcome === "rule_like").length;
    await db.transaction(async (tx) => {
      for (const r of results) {
        if (r.outcome !== "rule_like") continue;
        // a dismissed suggestion stays dismissed: its evidence refreshes, its status does not
        await tx
          .insert(ruleStepSuggestions)
          .values({ agentId: r.agentId, stepName: r.stepName, ...r.values })
          .onConflictDoUpdate({
            target: [ruleStepSuggestions.agentId, ruleStepSuggestions.stepName],
            set: { ...r.values, detectedAt: sql`now()` },
          });
      }
      await tx.insert(auditLog).values({
        userId: userId ?? NO_IDENTITY,
        objectType: "org_settings",
        objectId: null,
        detail: { scope: "rule_steps", stepsScanned: results.length, ruleLike: found, steps },
        effect: "allow",
        ruleId: RULE_STEP_AUDIT_RULE_IDS.scan,
        ruleChain: [],
        reason: `rule-like step scan: ${results.length} steps scanned, ${found} rule-like`,
      });
    });
    return { stepsScanned: results.length, ruleLike: found, steps };
  });

  app.get("/v1/rule-steps/suggestions", async (req) => {
    const q = listQuery.parse(req.query);
    const rows = await db
      .select({ s: ruleStepSuggestions, agentName: agents.name })
      .from(ruleStepSuggestions)
      .leftJoin(agents, eq(agents.id, ruleStepSuggestions.agentId))
      .where(eq(ruleStepSuggestions.status, q.status))
      .orderBy(desc(ruleStepSuggestions.projectedMonthlySavingsUsd), ruleStepSuggestions.id)
      .limit(q.limit + 1)
      .offset(q.offset);
    const page = rows.slice(0, q.limit).map((r) => view({ ...r.s, agentName: r.agentName }));
    return { suggestions: page, nextOffset: rows.length > q.limit ? q.offset + q.limit : null };
  });

  app.post("/v1/rule-steps/suggestions/:id/dismiss", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const userId = req.authCtx.userId ?? null;
    const out = await db.transaction(async (tx) => {
      const [row] = await tx
        .update(ruleStepSuggestions)
        .set({ status: "dismissed", dismissedAt: sql`now()`, dismissedBy: userId })
        .where(and(eq(ruleStepSuggestions.id, id), eq(ruleStepSuggestions.status, "suggested")))
        .returning();
      if (!row) return null;
      await tx.insert(auditLog).values({
        userId: userId ?? NO_IDENTITY,
        objectType: "org_settings",
        objectId: null,
        detail: { scope: "rule_steps", suggestionId: id, agentId: row.agentId, stepName: row.stepName },
        effect: "allow",
        ruleId: RULE_STEP_AUDIT_RULE_IDS.dismiss,
        ruleChain: [],
        reason: "rule-like step suggestion dismissed",
      });
      return row;
    });
    if (!out) return reply.status(404).send({ error: "unknown_or_dismissed_suggestion" });
    return { id: out.id, status: out.status, dismissedAt: out.dismissedAt };
  });
}
