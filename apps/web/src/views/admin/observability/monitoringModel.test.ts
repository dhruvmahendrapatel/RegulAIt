import { describe, expect, it } from "vitest";
import {
  EMPTY_KRI_FORM,
  EMPTY_RULE_FORM,
  filterSentence,
  formatMetricValue,
  kriFormProblem,
  kriPayload,
  pivotSeries,
  ruleFormFrom,
  ruleFormProblem,
  rulePayload,
  seriesPath,
  type AutomationRule,
} from "./monitoringModel";

describe("monitoring model", () => {
  it("formats each metric in its unit", () => {
    expect(formatMetricValue("error_rate", 12.345)).toBe("12.3%");
    expect(formatMetricValue("latency_p99", 1234.6)).toBe("1235 ms");
    expect(formatMetricValue("cost_usd", 3.5)).toBe("$3.50");
    expect(formatMetricValue("trace_volume", null)).toBe("no data");
  });

  it("mirrors the KRI bounds: window 1–90, a scoped KRI names its target", () => {
    const f = { ...EMPTY_KRI_FORM, name: "errors", threshold: "5" };
    expect(kriFormProblem(f)).toBeNull();
    expect(kriFormProblem({ ...f, windowDays: "91" })).toMatch(/1 to 90/);
    expect(kriFormProblem({ ...f, scope: "agent" })).toMatch(/Pick the agent/);
    expect(kriPayload({ ...f, scoreName: "x" })).toMatchObject({ scopeId: null, windowDays: 7, threshold: 5, scoreName: null });
  });

  it("aligns the series window to its bucket and keeps it under 500 buckets", () => {
    const p = new URL(seriesPath({ metric: "trace_volume", groupBy: "agent", rangeDays: 1, bucket: "hour" }, new Date("2026-10-05T10:20:00Z")), "http://x");
    expect(p.searchParams.get("to")).toBe("2026-10-05T11:00:00.000Z");
    expect(p.searchParams.get("from")).toBe("2026-10-04T11:00:00.000Z");
  });

  it("pivots points into chart rows for the first six groups only", () => {
    const groups = Array.from({ length: 8 }, (_, i) => ({ key: `g${i}`, label: `G${i}` }));
    const s = {
      metric: "trace_volume",
      unit: "traces",
      bucket: "day" as const,
      groups,
      points: groups.flatMap((g, i) => [
        { bucket: "2026-10-02T00:00:00Z", group: g.key, value: i, samples: i },
        { bucket: "2026-10-01T00:00:00Z", group: g.key, value: i + 1, samples: i },
      ]),
      folded: 0,
      otherIsApproximate: false,
    };
    const out = pivotSeries(s);
    expect(out.charted.map((c) => c.key)).toEqual(["g0", "g1", "g2", "g3", "g4", "g5"]);
    expect(out.rows.map((r) => r["bucket"])).toEqual(["2026-10-01T00:00:00Z", "2026-10-02T00:00:00Z"]);
    expect(out.rows[0]).not.toHaveProperty("g7");
  });

  it("builds a rule payload, and round-trips a stored rule", () => {
    const f = { ...EMPTY_RULE_FORM, name: "low scores", scoreName: "helpfulness", scoreMax: "2", samplingPct: "12.5", queueId: "q1", retentionDays: "60" };
    expect(ruleFormProblem(f, 180)).toBeNull();
    expect(ruleFormProblem(f, null)).toMatch(/No retention floor/);
    expect(ruleFormProblem({ ...f, retentionDays: "181" }, 180)).toMatch(/1 to 180 days/);
    expect(ruleFormProblem({ ...f, queueId: "", retentionDays: "" }, 180)).toMatch(/at least one action/);
    const payload = rulePayload(f);
    expect(payload).toEqual({
      name: "low scores",
      filter: { scoreName: "helpfulness", scoreMax: 2 },
      samplingRate: 0.125,
      actions: [{ type: "queue", queueId: "q1" }, { type: "retention", days: 60 }],
      dailyActionCap: 500,
    });
    const stored = { ...(payload as object), id: "r1", status: "active", pausedReason: null, author: { id: "u", name: "A" }, backfillUntil: null } as unknown as AutomationRule;
    expect(rulePayload(ruleFormFrom(stored))).toEqual(payload);
    expect(filterSentence(payload["filter"] as Record<string, unknown>)).toBe("score helpfulness ≤ 2");
    expect(filterSentence({})).toBe("every finished trace");
  });
});
