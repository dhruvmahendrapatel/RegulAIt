/**
 * ADR-0223 (P13b) — the classical-model drift settings row and the ADR-0157 governance-monitor input for
 * `classical_model_drift`. Kept apart from `classical-drift.ts` (the routes) so `governance-monitor.ts` can import it
 * without an import cycle through the routes' dependencies.
 */
import {
  and,
  desc,
  eq,
  governanceAlerts,
  inArray,
  lte,
  modelCards,
  modelDriftMonitors,
  modelDriftReports,
  modelDriftSettings,
  ne,
  sql,
  type Db,
  type ModelDriftReportRow,
} from "@regulait/db";
import { MODEL_DRIFT_MONITOR_RULE_ID, MONITOR_RULES, type MonitorAssuranceInput, type MonitorFinding } from "@regulait/shared";
import type { DriftFeatureResult } from "./classical-drift-stats.js";

const SETTINGS_ID = "singleton";

export interface DriftSettings {
  enabled: boolean;
  maxReportsPerHour: number;
  minSamples: number;
}
/** the strict values, which are also what an absent row means */
export const STRICT_DRIFT_SETTINGS: Readonly<DriftSettings> = Object.freeze({ enabled: false, maxReportsPerHour: 12, minSamples: 100 });

export async function loadDriftSettings(db: Db): Promise<DriftSettings & { updatedAt: Date | null }> {
  const [row] = await db.select().from(modelDriftSettings).where(eq(modelDriftSettings.id, SETTINGS_ID));
  return row
    ? { enabled: row.enabled, maxReportsPerHour: row.maxReportsPerHour, minSamples: row.minSamples, updatedAt: row.updatedAt }
    : { ...STRICT_DRIFT_SETTINGS, updatedAt: null };
}

export async function latestReports(db: Db, monitorIds: string[]): Promise<Map<string, ModelDriftReportRow>> {
  if (monitorIds.length === 0) return new Map();
  const rows = await db
    .selectDistinctOn([modelDriftReports.monitorId])
    .from(modelDriftReports)
    .where(inArray(modelDriftReports.monitorId, monitorIds))
    .orderBy(modelDriftReports.monitorId, desc(modelDriftReports.createdAt), desc(modelDriftReports.id));
  return new Map(rows.map((r) => [r.monitorId, r]));
}

/** `agent:<id>>model_card:<id>>model_drift_monitor:<id>`: the agent part lets alert ownership find a steward */
export function driftSubjectKey(card: { id: string; agentId: string | null }, monitorId: string): string {
  return `${card.agentId ? `agent:${card.agentId}>` : ""}model_card:${card.id}>model_drift_monitor:${monitorId}`;
}

export function driftFinding(
  card: { id: string; agentId: string | null },
  monitor: { id: string; name: string },
  report: { id: string; driftedFeatures: number; results: DriftFeatureResult[] },
): MonitorFinding {
  const features = report.results.filter((r) => r.status === "drift").map((r) => ({ feature: r.feature, breached: r.breached }));
  return {
    ruleId: MODEL_DRIFT_MONITOR_RULE_ID,
    subjectKey: driftSubjectKey(card, monitor.id),
    severity: MONITOR_RULES[MODEL_DRIFT_MONITOR_RULE_ID].severity,
    title: `Drift on monitor '${monitor.name}': ${report.driftedFeatures} feature${report.driftedFeatures === 1 ? "" : "s"} past an alert threshold`,
    detail: { cardId: card.id, ...(card.agentId ? { agentId: card.agentId } : {}), monitorId: monitor.id, reportId: report.id, features: features.slice(0, 20) },
  };
}

/**
 * This many reports in a row with too few samples make a monitor "not evaluable": a low-severity breach, so a
 * pipeline that starves the monitor (sends summaries below `min_samples`) is seen instead of silently holding.
 */
export const INSUFFICIENT_STREAK = 3;

/** monitors whose last INSUFFICIENT_STREAK reports were all `insufficient` */
async function starvedMonitors(db: Db, monitorIds: string[]): Promise<Set<string>> {
  if (monitorIds.length === 0) return new Set();
  const ranked = db
    .select({
      monitorId: modelDriftReports.monitorId,
      status: modelDriftReports.status,
      rn: sql<number>`row_number() OVER (PARTITION BY ${modelDriftReports.monitorId} ORDER BY ${modelDriftReports.createdAt} DESC, ${modelDriftReports.id} DESC)`.as("rn"),
    })
    .from(modelDriftReports)
    .where(inArray(modelDriftReports.monitorId, monitorIds))
    .as("ranked");
  const rows = await db.select({ monitorId: ranked.monitorId, status: ranked.status }).from(ranked).where(lte(ranked.rn, INSUFFICIENT_STREAK));
  const tally = new Map<string, { n: number; insufficient: number }>();
  for (const r of rows) {
    const t = tally.get(r.monitorId) ?? { n: 0, insufficient: 0 };
    t.n++;
    if (r.status === "insufficient") t.insufficient++;
    tally.set(r.monitorId, t);
  }
  return new Set([...tally].filter(([, t]) => t.n === INSUFFICIENT_STREAK && t.insufficient === INSUFFICIENT_STREAK).map(([id]) => id));
}

/**
 * ADR-0157 monitor input for `classical_model_drift`: one breach per monitor whose LATEST report drifted. A latest
 * report with too few samples holds its episode, until INSUFFICIENT_STREAK in a row, which raises a low-severity
 * "not evaluable" breach. Off = every open episode is HELD (switching the feature off never dismisses an alert).
 */
export async function modelDriftMonitorInput(db: Db, _now: Date): Promise<MonitorAssuranceInput> {
  if (!(await loadDriftSettings(db)).enabled) {
    const open = await db
      .select({ subjectKey: governanceAlerts.subjectKey })
      .from(governanceAlerts)
      .where(and(eq(governanceAlerts.ruleId, MODEL_DRIFT_MONITOR_RULE_ID), ne(governanceAlerts.status, "resolved")));
    return { breaches: [], heldSubjectKeys: open.map((a) => a.subjectKey) };
  }
  const monitors = await db
    .select({ id: modelDriftMonitors.id, name: modelDriftMonitors.name, cardId: modelCards.id, agentId: modelCards.agentId })
    .from(modelDriftMonitors)
    .innerJoin(modelCards, eq(modelCards.id, modelDriftMonitors.cardId));
  const latest = await latestReports(db, monitors.map((m) => m.id));
  const starved = await starvedMonitors(db, monitors.map((m) => m.id));
  const breaches: MonitorAssuranceInput["breaches"] = [];
  const heldSubjectKeys: string[] = [];
  for (const m of monitors) {
    const r = latest.get(m.id);
    if (!r) continue;
    const card = { id: m.cardId, agentId: m.agentId };
    if (starved.has(m.id)) {
      breaches.push({
        subjectKey: driftSubjectKey(card, m.id),
        title: `Drift monitor '${m.name}' is not evaluable: the last ${INSUFFICIENT_STREAK} summaries had too few samples`,
        severity: "low",
        detail: { cardId: card.id, ...(card.agentId ? { agentId: card.agentId } : {}), monitorId: m.id, reportId: r.id, notEvaluable: true, insufficientStreak: INSUFFICIENT_STREAK },
      });
      continue;
    }
    if (r.status === "insufficient") heldSubjectKeys.push(driftSubjectKey(card, m.id));
    if (r.status !== "drift") continue;
    const f = driftFinding(card, m, { id: r.id, driftedFeatures: r.driftedFeatures, results: r.results as DriftFeatureResult[] });
    breaches.push({ subjectKey: f.subjectKey, title: f.title, severity: f.severity, detail: f.detail });
  }
  return { breaches, heldSubjectKeys };
}
