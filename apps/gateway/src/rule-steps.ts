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
  asc,
  auditLog,
  desc,
  eq,
  getTableColumns,
  inArray,
  isNull,
  ruleStepSettings,
  ruleStepShadows,
  ruleStepSuggestions,
  sql,
  traceSpans,
  type Db,
  type RuleStepSettingsRow,
  type RuleStepShadowRow,
  type RuleStepSuggestionRow,
  type SQL,
  RULE_STEP_SUGGESTION_STATUSES,
} from "@regulait/db";
import {
  DEFAULT_RULE_INDUCTION_OPTIONS,
  RULE_INDUCTION_FLOORS,
  extractStepFields,
  renderInducedRule,
  tallyShadow,
  type InducedRule,
  type StepRun,
} from "@regulait/optimizer-kernel";
import { induceStepRuleOffThread } from "@regulait/optimizer-kernel/offload";
import { RULE_STEP_SUGGESTION_MACHINE, TRACE_TRUNCATION_MARKER } from "@regulait/shared";
import { whereFrom } from "./state-transition.js";
import { requireStepUp } from "./step-up.js";
import { SCAN_WINDOW_DAYS } from "./rule-step-retention.js";
import type { ListSpec } from "./list-contract.js";
import { answerListExport, answerListPage, type ContractList } from "./list-contract-route.js";

const SETTINGS_ID = "singleton";
const NO_IDENTITY = "00000000-0000-0000-0000-000000000000";
export const SCAN_MAX_STEPS = 10;
export const SCAN_MAX_RUNS = 5_000;
// one definition, shared with the retention prune (rule-step-retention.ts): the prune keys on the window start
export { SCAN_WINDOW_DAYS };
export const SCAN_SPACING_MINUTES = 10;
const MONTH_DAYS = 30;

/** ADR-0327: the suggestion lifecycle is `RULE_STEP_SUGGESTION_MACHINE` (ADR-0348, `@regulait/shared`); every status
 * change goes through `transitionSuggestion`, and nothing else writes `status`. */
export type RuleStepTransition = (typeof RULE_STEP_SUGGESTION_MACHINE.events)[number];

/**
 * Apply one declared transition atomically: the row moves only if it is still in a state the event may leave from
 * (ADR-0348 `whereFrom`, one compare-and-set UPDATE), so two concurrent requests cannot both move it. Returns the
 * updated row, or null when the suggestion does not exist or is not in such a state.
 */
async function transitionSuggestion(
  db: Db,
  id: string,
  event: RuleStepTransition,
  extra: { [K in keyof typeof ruleStepSuggestions.$inferInsert]?: (typeof ruleStepSuggestions.$inferInsert)[K] | SQL } = {},
): Promise<RuleStepSuggestionRow | null> {
  const [row] = await db
    .update(ruleStepSuggestions)
    .set({ ...extra, status: RULE_STEP_SUGGESTION_MACHINE.def.transitions[event].to })
    .where(and(eq(ruleStepSuggestions.id, id), whereFrom(ruleStepSuggestions.status, RULE_STEP_SUGGESTION_MACHINE, event)))
    .returning();
  return row ?? null;
}

export const RULE_STEP_AUDIT_RULE_IDS = {
  settings: "rule_step_settings_changed",
  scan: "rule_step_scan",
  dismiss: "rule_step_suggestion_dismissed",
  shadowStarted: "rule_step_shadow_started",
  shadowStopped: "rule_step_shadow_stopped",
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
/** the list's one filter beside the ADR-0226 contract's own params; absent means the open suggestions */
const suggestionFilters = z.object({ status: z.enum(RULE_STEP_SUGGESTION_STATUSES).optional() }).strict();
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

/** a shadow period as the API shows it: counts and the two rates (null until there is something to divide) */
function shadowView(s: RuleStepShadowRow | undefined) {
  if (!s) return null;
  return {
    id: s.id,
    startedAt: s.startedAt,
    stoppedAt: s.stoppedAt,
    evaluatedThrough: s.evaluatedThrough,
    runs: s.runs,
    covered: s.covered,
    agreed: s.agreed,
    coverage: s.runs > 0 ? s.covered / s.runs : null,
    agreement: s.covered > 0 ? s.agreed / s.covered : null,
  };
}

/** the latest shadow period of each suggestion, in one query (no N+1) */
async function latestShadows(db: Db, suggestionIds: readonly string[]): Promise<Map<string, RuleStepShadowRow>> {
  if (suggestionIds.length === 0) return new Map();
  const rows = await db
    .selectDistinctOn([ruleStepShadows.suggestionId])
    .from(ruleStepShadows)
    .where(inArray(ruleStepShadows.suggestionId, [...suggestionIds]))
    .orderBy(ruleStepShadows.suggestionId, desc(ruleStepShadows.startedAt));
  return new Map(rows.map((r) => [r.suggestionId, r]));
}

/** a refusal the table alone cannot know, shown beside the lifecycle (ADR-0348 `describe`) */
const DETECTION_OFF = "rule-like step detection is off; an admin turns it on in the rule-step settings";

function view(row: RuleStepSuggestionRow & { agentName: string | null }, shadow: RuleStepShadowRow | undefined, detectionOn: boolean) {
  const rule = row.rule as InducedRule;
  return {
    id: row.id,
    agentId: row.agentId,
    agentName: row.agentName,
    stepName: row.stepName,
    status: row.status,
    /** read-only (ADR-0348): every event, whether it is allowed now, and why not */
    lifecycle: RULE_STEP_SUGGESTION_MACHINE.describe(row.status, detectionOn ? {} : { shadow_start: DETECTION_OFF }),
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
    /** ADR-0327 slice 3b: the latest shadow period (live agreement), or null if it was never shadowed */
    shadow: shadowView(shadow),
  };
}

export type RuleStepSuggestionView = ReturnType<typeof view>;

/**
 * ADR-0226: the suggestions list under the shared list contract. The export carries the summary columns only, never
 * the rule's cells (they copy captured input values; ADR-0327 retention note).
 */
export const RULE_STEP_SUGGESTIONS_LIST: ListSpec<RuleStepSuggestionView> = {
  id: "rule-step-suggestions",
  sorts: {
    savings: { expr: ruleStepSuggestions.projectedMonthlySavingsUsd },
    agent: { expr: sql`lower(${agents.name})` },
    step: { expr: ruleStepSuggestions.stepName },
    coverage: { expr: ruleStepSuggestions.coverage },
    agreement: { expr: ruleStepSuggestions.agreement },
    runs: { expr: ruleStepSuggestions.runs },
    detected: { expr: ruleStepSuggestions.detectedAt, keysetAt: ruleStepSuggestions.detectedAt },
  },
  columns: {
    agent: { label: "Agent", value: (r) => r.agentName ?? r.agentId },
    step: { label: "Step", value: (r) => r.stepName },
    status: { label: "Status", value: (r) => r.status },
    savings: { label: "Projected monthly saving (USD, estimate)", value: (r) => r.savings.projectedMonthlySavingsUsd },
    coverage: { label: "Coverage", value: (r) => r.evidence.coverage },
    agreement: { label: "Agreement", value: (r) => r.evidence.agreement },
    runs: { label: "Runs", value: (r) => r.evidence.runs },
    detected: { label: "Detected", value: (r) => r.detectedAt },
  },
  filters: ["status"],
  defaultSort: { col: "savings", dir: "desc" },
  idCol: ruleStepSuggestions.id,
};

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

export interface ShadowEvaluation {
  shadowId: string;
  /** the last span counted, as (start time as Postgres text, id): the next pass starts after it */
  through: string;
  throughId: string;
  suggestionId: string;
  agentId: string;
  stepName: string;
  /** what this pass added */
  runs: number;
  covered: number;
  agreed: number;
}

/**
 * ADR-0327 slice 3b, SHADOW MODE. For each open shadow period (at most `SCAN_MAX_STEPS`, oldest first), measure the
 * suggestion's rule against the step's model spans recorded since the period's cursor, at most `SCAN_MAX_RUNS` per
 * pass, and add the counts. Nothing changes routing: the AI already answered every one of these runs.
 *
 * The cursor is the last counted span's (start time, id), a keyset in the same order the spans are read, so a span is
 * never counted twice and none is skipped, even when more spans than one pass reads share a start time. The time is
 * Postgres text (microseconds), never a JS Date (milliseconds).
 *
 * Read-only: it returns what to add, and `applyShadowEvaluations` writes it in the scan's transaction, with the audit
 * row.
 */
export async function measureShadows(db: Db): Promise<ShadowEvaluation[]> {
  const open = await db
    .select({
      shadowId: ruleStepShadows.id,
      fromAt: sql<string>`coalesce(${ruleStepShadows.evaluatedThrough}, ${ruleStepShadows.startedAt})::text`,
      fromId: ruleStepShadows.evaluatedThroughId,
      suggestionId: ruleStepSuggestions.id,
      agentId: ruleStepSuggestions.agentId,
      stepName: ruleStepSuggestions.stepName,
      rule: ruleStepSuggestions.rule,
    })
    .from(ruleStepShadows)
    .innerJoin(ruleStepSuggestions, eq(ruleStepSuggestions.id, ruleStepShadows.suggestionId))
    .where(and(isNull(ruleStepShadows.stoppedAt), eq(ruleStepSuggestions.status, RULE_STEP_SUGGESTION_MACHINE.def.transitions.shadow_start.to)))
    .orderBy(asc(ruleStepShadows.startedAt))
    .limit(SCAN_MAX_STEPS);
  const out: ShadowEvaluation[] = [];
  for (const o of open) {
    const rows = await db
      .select({ id: traceSpans.id, inputPreview: traceSpans.inputPreview, outputPreview: traceSpans.outputPreview, at: sql<string>`${traceSpans.startedAt}::text` })
      .from(traceSpans)
      .where(
        and(
          eq(traceSpans.kind, "llm"),
          eq(traceSpans.agentId, o.agentId),
          eq(traceSpans.name, o.stepName),
          eq(traceSpans.status, "ok"),
          eq(traceSpans.contentWithheld, false),
          // nothing counted yet: every span after the start; else the keyset after the last counted span
          o.fromId === null
            ? sql`${traceSpans.startedAt} > ${o.fromAt}::timestamptz`
            : sql`(${traceSpans.startedAt}, ${traceSpans.id}) > (${o.fromAt}::timestamptz, ${o.fromId}::uuid)`,
        ),
      )
      .orderBy(asc(traceSpans.startedAt), asc(traceSpans.id))
      .limit(SCAN_MAX_RUNS);
    if (rows.length === 0) continue;
    const last = rows[rows.length - 1]!;
    const t = tallyShadow(o.rule as InducedRule, spansToRuns(rows));
    out.push({ shadowId: o.shadowId, through: last.at, throughId: last.id, suggestionId: o.suggestionId, agentId: o.agentId, stepName: o.stepName, ...t });
  }
  return out;
}

/** add the measured counts and advance each cursor; a period stopped meanwhile is left as it was */
export async function applyShadowEvaluations(db: Db, evaluations: readonly ShadowEvaluation[]): Promise<void> {
  for (const e of evaluations) {
    await db
      .update(ruleStepShadows)
      .set({
        runs: sql`${ruleStepShadows.runs} + ${e.runs}`,
        covered: sql`${ruleStepShadows.covered} + ${e.covered}`,
        agreed: sql`${ruleStepShadows.agreed} + ${e.agreed}`,
        evaluatedThrough: sql`${e.through}::timestamptz`,
        evaluatedThroughId: e.throughId,
      })
      .where(and(eq(ruleStepShadows.id, e.shadowId), isNull(ruleStepShadows.stoppedAt)));
  }
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
    // slice 3b: measure every open shadow on the spans recorded since its last pass (counts only)
    const shadows = await measureShadows(db);
    const steps = results.map((r) => (r.outcome === "rule_like" ? { agentId: r.agentId, stepName: r.stepName, outcome: r.outcome, projectedMonthlySavingsUsd: r.projectedMonthlySavingsUsd } : r));
    const found = results.filter((r) => r.outcome === "rule_like").length;
    await db.transaction(async (tx) => {
      for (const r of results) {
        if (r.outcome !== "rule_like") continue;
        // a dismissed suggestion stays dismissed: its evidence refreshes, its status does not. A suggestion in shadow
        // is not touched at all, so its shadow counts always describe the one rule under test (slice 3b).
        await tx
          .insert(ruleStepSuggestions)
          .values({ agentId: r.agentId, stepName: r.stepName, ...r.values })
          .onConflictDoUpdate({
            target: [ruleStepSuggestions.agentId, ruleStepSuggestions.stepName],
            set: { ...r.values, detectedAt: sql`now()` },
            setWhere: sql`${ruleStepSuggestions.status} <> ${RULE_STEP_SUGGESTION_MACHINE.def.transitions.shadow_start.to}`,
          });
      }
      await applyShadowEvaluations(tx as unknown as Db, shadows);
      await tx.insert(auditLog).values({
        userId: userId ?? NO_IDENTITY,
        objectType: "org_settings",
        objectId: null,
        detail: {
          scope: "rule_steps",
          stepsScanned: results.length,
          ruleLike: found,
          steps,
          shadows: shadows.map((x) => ({ suggestionId: x.suggestionId, runs: x.runs, covered: x.covered, agreed: x.agreed })),
        },
        effect: "allow",
        ruleId: RULE_STEP_AUDIT_RULE_IDS.scan,
        ruleChain: [],
        reason: `rule-like step scan: ${results.length} steps scanned, ${found} rule-like`,
      });
    });
    return {
      stepsScanned: results.length,
      ruleLike: found,
      steps,
      shadows: shadows.map((x) => ({ suggestionId: x.suggestionId, agentId: x.agentId, stepName: x.stepName, runs: x.runs, covered: x.covered, agreed: x.agreed })),
    };
  });

  // ADR-0226: the shared list contract (sort, cursor or offset, count, export); the status filter defaults to open
  const suggestionsList: ContractList<RuleStepSuggestionView, z.infer<typeof suggestionFilters>> = {
    spec: RULE_STEP_SUGGESTIONS_LIST,
    filters: suggestionFilters,
    reader: {
      fetch: async (q) => {
        const rows = await db
          .select({ ...getTableColumns(ruleStepSuggestions), agentName: agents.name, _cursorAt: q.cursorAt })
          .from(ruleStepSuggestions)
          .leftJoin(agents, eq(agents.id, ruleStepSuggestions.agentId))
          .where(q.where)
          .orderBy(...q.orderBy)
          .limit(q.limit)
          .offset(q.offset);
        const [shadows, settings] = await Promise.all([latestShadows(db, rows.map((r) => r.id)), loadRuleStepSettings(db)]);
        return rows.map(({ _cursorAt, ...r }) => ({ ...view(r, shadows.get(r.id), settings.enabled), _cursorAt }));
      },
      countable: (where) =>
        db.select({ one: sql`1` }).from(ruleStepSuggestions).leftJoin(agents, eq(agents.id, ruleStepSuggestions.agentId)).where(where),
      idOf: (r) => r.id,
    },
    where: (_req, f) => eq(ruleStepSuggestions.status, f.status ?? "suggested"),
  };
  app.get("/v1/rule-steps/suggestions/export.xlsx", async (req, reply) => answerListExport(db, req, reply, suggestionsList));
  app.get("/v1/rule-steps/suggestions", async (req, reply) => answerListPage(db, req, reply, suggestionsList));

  app.post("/v1/rule-steps/suggestions/:id/dismiss", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const userId = req.authCtx.userId ?? null;
    const out = await db.transaction(async (tx) => {
      const row = await transitionSuggestion(tx as unknown as Db, id, "dismiss", { dismissedAt: sql`now()`, dismissedBy: userId });
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

  /**
   * ADR-0327 slice 3b: start a shadow period. The suggestion's rule is measured against live model spans by every
   * later scan, and frozen meanwhile; the AI still answers every request. Refused while detection is off. Audited in the
   * same transaction. No step-up: shadow mode changes no routing and relaxes nothing (switching, slice 4, is an
   * approval).
   */
  app.post("/v1/rule-steps/suggestions/:id/shadow", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const userId = req.authCtx.userId ?? null;
    if (!(await loadRuleStepSettings(db)).enabled) {
      return reply.status(409).send({ error: "rule_steps_disabled", detail: DETECTION_OFF });
    }
    const out = await db.transaction(async (tx) => {
      const row = await transitionSuggestion(tx as unknown as Db, id, "shadow_start");
      if (!row) return null;
      const [shadow] = await tx.insert(ruleStepShadows).values({ suggestionId: id, startedBy: userId }).returning();
      await tx.insert(auditLog).values({
        userId: userId ?? NO_IDENTITY,
        objectType: "org_settings",
        objectId: null,
        detail: { scope: "rule_steps", suggestionId: id, shadowId: shadow!.id, agentId: row.agentId, stepName: row.stepName },
        effect: "allow",
        ruleId: RULE_STEP_AUDIT_RULE_IDS.shadowStarted,
        ruleChain: [],
        reason: "rule-like step suggestion put in shadow mode (measured only; the AI still answers)",
      });
      return { row, shadow: shadow! };
    });
    if (!out) return reply.status(404).send({ error: "unknown_or_not_open_suggestion" });
    return { id: out.row.id, status: out.row.status, shadow: shadowView(out.shadow) };
  });

  /** ADR-0327 slice 3b: stop the open shadow period; the suggestion is open again and its counts are kept. Audited. */
  app.post("/v1/rule-steps/suggestions/:id/shadow/stop", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const userId = req.authCtx.userId ?? null;
    const out = await db.transaction(async (tx) => {
      const row = await transitionSuggestion(tx as unknown as Db, id, "shadow_stop");
      if (!row) return null;
      const [shadow] = await tx
        .update(ruleStepShadows)
        .set({ stoppedAt: sql`now()`, stoppedBy: userId })
        .where(and(eq(ruleStepShadows.suggestionId, id), isNull(ruleStepShadows.stoppedAt)))
        .returning();
      await tx.insert(auditLog).values({
        userId: userId ?? NO_IDENTITY,
        objectType: "org_settings",
        objectId: null,
        detail: {
          scope: "rule_steps",
          suggestionId: id,
          shadowId: shadow?.id ?? null,
          runs: shadow?.runs ?? 0,
          covered: shadow?.covered ?? 0,
          agreed: shadow?.agreed ?? 0,
        },
        effect: "allow",
        ruleId: RULE_STEP_AUDIT_RULE_IDS.shadowStopped,
        ruleChain: [],
        reason: "rule-like step shadow mode stopped",
      });
      return { row, shadow };
    });
    if (!out) return reply.status(404).send({ error: "unknown_or_not_shadowing_suggestion" });
    return { id: out.row.id, status: out.row.status, shadow: shadowView(out.shadow) };
  });
}
