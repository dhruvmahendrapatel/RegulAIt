/**
 * ADR-0173 batch 2c (K) — the pure rules: KRI enums and bounds, the
 * minimum-sample rule and the held episode, series bounds and the top-20 fold,
 * dashboard validation, the deterministic sampling decision, action and
 * backfill bounds, and the retention-hold bound.
 */
import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  AUTOMATION_LIMITS,
  SERIES_LIMITS,
  automationBackfillSchema,
  automationRuleCreateSchema,
  automationSampled,
  dashboardSchema,
  evaluateKri,
  evaluateMonitorRules,
  foldTopGroups,
  kriCreateSchema,
  kriStates,
  maxRetentionHoldDays,
  reconcileAlerts,
  retentionHoldUntil,
  seriesQuerySchema,
  type MonitorInput,
  type MonitorKriInput,
} from "./index.js";

const ID = "11111111-1111-4111-8111-111111111111";

describe("KRIs: enums and bounds", () => {
  it("metric, scope and window are enums; the window is at most 90 days", () => {
    const ok = { name: "p99", metric: "latency_p99", threshold: 2000 };
    expect(kriCreateSchema.safeParse(ok).success).toBe(true);
    expect(kriCreateSchema.safeParse({ ...ok, metric: "latency_p95" }).success).toBe(false);
    expect(kriCreateSchema.safeParse({ ...ok, scope: "team" }).success).toBe(false);
    expect(kriCreateSchema.safeParse({ ...ok, windowDays: 90 }).success).toBe(true);
    expect(kriCreateSchema.safeParse({ ...ok, windowDays: 91 }).success).toBe(false);
    expect(kriCreateSchema.safeParse({ ...ok, scope: "agent" }).success).toBe(false); // needs the agent
    expect(kriCreateSchema.safeParse({ ...ok, scope: "agent", scopeId: ID }).success).toBe(true);
    expect(kriCreateSchema.safeParse({ ...ok, scopeId: ID }).success).toBe(false); // fleet names none
  });

  it("below minSamples a KRI is insufficient, whatever its value", () => {
    const k = { comparator: "above" as const, threshold: 10, minSamples: 20 };
    expect(evaluateKri(k, { value: 99, samples: 19 })).toBe("insufficient");
    expect(evaluateKri(k, { value: 99, samples: 20 })).toBe("breached");
    expect(evaluateKri(k, { value: 5, samples: 20 })).toBe("ok");
    expect(evaluateKri({ ...k, comparator: "below" }, { value: 5, samples: 20 })).toBe("breached");
    expect(evaluateKri(k, { value: null, samples: 500 })).toBe("insufficient");
  });

  it("an insufficient KRI's open episode is neither refreshed nor resolved; an ok one resolves", () => {
    const kri = (id: string, samples: number, value: number): MonitorKriInput => ({
      id,
      name: `kri ${id}`,
      metric: "error_rate",
      scope: "fleet",
      scopeId: null,
      scopeLabel: null,
      windowDays: 7,
      comparator: "above",
      threshold: 5,
      minSamples: 20,
      severity: "high",
      enabled: true,
      value,
      samples,
    });
    const input: MonitorInput = {
      useCases: [],
      agents: new Map(),
      vendors: new Map(),
      risks: [],
      dimensions: [],
      kris: [kri("a", 5, 50), kri("b", 30, 1), kri("c", 30, 50)],
    };
    const findings = evaluateMonitorRules(input);
    expect(findings.map((f) => f.subjectKey)).toEqual(["kri:c"]);
    expect(findings[0]!.severity).toBe("high");
    const held = new Set(
      kriStates(input.kris!)
        .filter((s) => s.state === "insufficient")
        .map((s) => `kri_threshold_breached|kri:${s.kri.id}`),
    );
    const active = [
      { id: "1", ruleId: "kri_threshold_breached", subjectKey: "kri:a" },
      { id: "2", ruleId: "kri_threshold_breached", subjectKey: "kri:b" },
    ];
    const plan = reconcileAlerts(active, findings, undefined, held);
    expect(plan.resolve).toEqual(["2"]); // a: held (too few samples); b: below threshold → resolves
    expect(plan.raise.map((f) => f.subjectKey)).toEqual(["kri:c"]);
  });
});

describe("series and dashboards", () => {
  it("a series has at most 500 buckets and spans at most 90 days", () => {
    const from = "2026-09-01T00:00:00Z";
    expect(seriesQuerySchema.safeParse({ metric: "trace_volume", from, to: "2026-09-21T19:00:00Z", bucket: "hour" }).success).toBe(true); // 499
    expect(seriesQuerySchema.safeParse({ metric: "trace_volume", from, to: "2026-09-21T21:00:00Z", bucket: "hour" }).success).toBe(false); // 501
    expect(seriesQuerySchema.safeParse({ metric: "trace_volume", from, to: "2026-12-01T00:00:00Z", bucket: "day" }).success).toBe(false);
    expect(seriesQuerySchema.safeParse({ metric: "content", from, to: "2026-09-02T00:00:00Z" }).success).toBe(false);
  });

  it("keeps the top 20 groups and folds the rest into 'other'", () => {
    const points = Array.from({ length: 25 }, (_, i) => ({ bucket: "b1", group: `g${String(i).padStart(2, "0")}`, value: 100 - i, samples: 1 }));
    const f = foldTopGroups(points, true);
    expect(f.groups).toHaveLength(SERIES_LIMITS.topGroups + 1);
    expect(f.groups.at(-1)).toBe("other");
    expect(f.folded).toBe(5);
    const other = f.points.find((p) => p.group === "other")!;
    expect(other.value).toBe(80 + 79 + 78 + 77 + 76);
    // a non-additive metric folds as the sample-weighted mean
    const g = foldTopGroups(
      [...points.slice(0, 20).map((p) => ({ ...p, samples: 5 })), { bucket: "b1", group: "x", value: 10, samples: 1 }, { bucket: "b1", group: "y", value: 40, samples: 3 }],
      false,
      20,
    );
    expect(g.points.find((p) => p.group === "other")!.value).toBe((10 + 120) / 4);
  });

  it("a dashboard has at most 24 panels, each validated", () => {
    const panel = { kind: "series", title: "Volume", metric: "trace_volume" };
    expect(dashboardSchema.safeParse({ name: "Ops", panels: Array(24).fill(panel) }).success).toBe(true);
    expect(dashboardSchema.safeParse({ name: "Ops", panels: Array(25).fill(panel) }).success).toBe(false);
    expect(dashboardSchema.safeParse({ name: "Ops", panels: [{ ...panel, metric: "input_preview" }] }).success).toBe(false);
    expect(dashboardSchema.safeParse({ name: "Ops", panels: [{ ...panel, sql: "select 1" }] }).success).toBe(false);
    expect(dashboardSchema.safeParse({ name: "Ops", panels: [{ ...panel, bucket: "hour", rangeDays: 30 }] }).success).toBe(false); // 720 buckets
    expect(dashboardSchema.safeParse({ name: "Ops", panels: [{ kind: "kri", title: "p99", kriId: "nope" }] }).success).toBe(false);
  });
});

describe("automation sampling", () => {
  const rule = "22222222-2222-4222-8222-222222222222";
  const traceIds = Array.from({ length: 10_000 }, (_, i) =>
    crypto.createHash("md5").update(`trace-${i}`).digest("hex").replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5"),
  );

  it("is deterministic per (rule, trace)", () => {
    for (const t of traceIds.slice(0, 200)) expect(automationSampled(rule, t, 0.37)).toBe(automationSampled(rule, t, 0.37));
  });

  it("a rate of 0 never matches and 1 always does", () => {
    expect(traceIds.some((t) => automationSampled(rule, t, 0))).toBe(false);
    expect(traceIds.every((t) => automationSampled(rule, t, 1))).toBe(true);
  });

  it("0.1 samples 10% ± 2% of 10k traces", () => {
    const n = traceIds.filter((t) => automationSampled(rule, t, 0.1)).length;
    expect(n).toBeGreaterThanOrEqual(800);
    expect(n).toBeLessThanOrEqual(1200);
  });
});

describe("automation rule bounds", () => {
  const base = { name: "r", actions: [{ type: "queue", queueId: ID }] };
  it("one to four actions, one of each type", () => {
    expect(automationRuleCreateSchema.safeParse(base).success).toBe(true);
    expect(automationRuleCreateSchema.safeParse({ ...base, actions: [] }).success).toBe(false);
    expect(automationRuleCreateSchema.safeParse({ ...base, actions: [base.actions[0], { type: "queue", queueId: ID }] }).success).toBe(false);
    expect(automationRuleCreateSchema.safeParse({ ...base, actions: [{ type: "delete", traceId: ID }] }).success).toBe(false);
    expect(automationRuleCreateSchema.safeParse({ ...base, samplingRate: 1.5 }).success).toBe(false);
    expect(automationRuleCreateSchema.safeParse({ ...base, filter: { scoreMin: 1 } }).success).toBe(false); // the shared filter's refinements apply
  });

  it("an explicit backfill reaches back at most 7 days", () => {
    expect(automationBackfillSchema.safeParse({ days: AUTOMATION_LIMITS.maxBackfillDays }).success).toBe(true);
    expect(automationBackfillSchema.safeParse({ days: 8 }).success).toBe(false);
    expect(automationBackfillSchema.safeParse({ days: 0 }).success).toBe(false);
  });

  it("a hold is at most 2x the floor and at most 3 years; no floor means no hold", () => {
    expect(maxRetentionHoldDays(90)).toBe(180);
    expect(maxRetentionHoldDays(1000)).toBe(1095);
    expect(maxRetentionHoldDays(null)).toBeNull();
    const start = new Date("2026-01-01T00:00:00Z");
    expect(retentionHoldUntil(start, 180, 90)).toEqual({ ok: true, holdUntil: new Date("2026-06-30T00:00:00Z") });
    expect(retentionHoldUntil(start, 181, 90)).toEqual({ ok: false, reason: "hold_exceeds_bound", maxDays: 180 });
    expect(retentionHoldUntil(start, 1096, 1000)).toEqual({ ok: false, reason: "hold_exceeds_bound", maxDays: 1095 });
    expect(retentionHoldUntil(start, 30, null)).toEqual({ ok: false, reason: "no_retention_floor", maxDays: null });
    expect(automationRuleCreateSchema.safeParse({ ...base, actions: [{ type: "retention", days: 1096 }] }).success).toBe(false);
  });
});
