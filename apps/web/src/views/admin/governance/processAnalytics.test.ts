import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../../api/client";
import { analyticsQuery, fetchHeatmap, fetchTemplates, refreshAnalytics } from "./processAnalyticsApi";
import {
  analyticsReducer,
  cellsByPeriod,
  initialAnalyticsState,
  normaliseStages,
  normaliseTemplates,
  normaliseThroughput,
  pct,
  waitLevel,
  windowOf,
} from "./processAnalyticsModel";

const NOW = "2026-11-22T12:00:00.000Z";
const res = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const env = { window: { from: "2026-10-23T12:00:00.000Z", to: NOW }, scope: { kind: "org", id: null, templateId: null }, excluded: { diverged: 0, tooLong: 0 }, lastProjectedAt: NOW, basis: "workflow history" };
const template = {
  templateId: "t1",
  name: "Standard change",
  started: 4,
  ended: { total: 0, completed: 0, aborted: 0, denied: 0, rolledBack: 0 },
  open: 4,
  cycleTimeMs: { p50: null, p90: null, mean: null },
  reworkRate: null,
};

afterEach(() => vi.unstubAllGlobals());

describe("analyticsQuery", () => {
  it("sends only the window, a chosen template and the route's own params (the schemas are strict)", () => {
    const s = initialAnalyticsState(NOW);
    expect(analyticsQuery(s, { limit: 50, offset: 0 })).toBe("from=2026-10-23T12%3A00%3A00.000Z&to=2026-11-22T12%3A00%3A00.000Z&limit=50&offset=0");
    const q = new URLSearchParams(analyticsQuery({ ...s, templateId: "t1" }, { bucket: "week" }));
    expect([...q.keys()]).toEqual(["from", "to", "templateId", "bucket"]);
    expect(q.has("scope") || q.has("sort") || q.has("count")).toBe(false);
  });
});

describe("normalisers keep unknown as null, never 0", () => {
  it("a template with nothing ended has unmeasured cycle time and rework", () => {
    const out = normaliseTemplates({ ...env, total: 1, limit: 50, offset: 0, templates: [template] });
    expect(out.templates[0]!.cycleTimeMs).toEqual({ p50: null, p90: null, mean: null });
    expect(out.templates[0]!.reworkRate).toBeNull();
    expect(pct(out.templates[0]!.reworkRate)).toBe("Not measured");
    expect(pct(0)).toBe("0%");
    expect(pct(0.125)).toBe("12.5%");
  });

  it("a never-projected envelope keeps lastProjectedAt null", () => {
    const out = normaliseThroughput({ ...env, lastProjectedAt: null, bucket: "week", periods: [] });
    expect(out.lastProjectedAt).toBeNull();
  });

  it("a malformed answer is a failed read, not an empty one", () => {
    expect(() => normaliseTemplates({ ...env, total: 1, limit: 50, offset: 0 })).toThrow(/expected form/);
    expect(() => normaliseTemplates({ ...env, total: 1, limit: 50, offset: 0, templates: [{ ...template, started: "4" }] })).toThrow();
    expect(() => normaliseStages({ ...env, total: 0, limit: 50, offset: 0, stages: [{ rank: 1 }] })).toThrow();
    expect(() => normaliseThroughput({ ...env, bucket: "hour", periods: [] })).toThrow(/bucket/);
  });
});

describe("heatmap helpers", () => {
  it("a period the gateway did not send has no cell (No visits), not a zero cell", () => {
    const cells = [{ period: "b", visits: 2, medianDurationMs: 1000, waitMs: 500 }];
    expect(cellsByPeriod(["a", "b"], cells)).toEqual([{ period: "a", cell: null }, { period: "b", cell: cells[0] }]);
  });

  it("wait level steps 0..4 against the heaviest cell", () => {
    expect(waitLevel(0, 100)).toBe(0);
    expect(waitLevel(5, 0)).toBe(0);
    expect(waitLevel(1, 100)).toBe(1);
    expect(waitLevel(60, 100)).toBe(3);
    expect(waitLevel(100, 100)).toBe(4);
  });
});

describe("analyticsReducer", () => {
  const s0 = initialAnalyticsState(NOW);

  it("starts at the last 30 days by week, page one", () => {
    expect(s0).toMatchObject({ days: 30, bucket: "week", templateId: "", templatesOffset: 0, stagesOffset: 0, refresh: { phase: "idle" } });
    expect(windowOf(s0)).toEqual({ from: "2026-10-23T12:00:00.000Z", to: NOW });
  });

  it("a new window or template goes back to page one and re-anchors the window", () => {
    const paged = analyticsReducer(analyticsReducer(s0, { type: "templatesPage", offset: 50 }), { type: "stagesPage", offset: 120 });
    expect(paged).toMatchObject({ templatesOffset: 50, stagesOffset: 100 });
    const w = analyticsReducer(paged, { type: "window", days: 7, now: "2026-11-22T13:00:00.000Z" });
    expect(w).toMatchObject({ days: 7, anchor: "2026-11-22T13:00:00.000Z", templatesOffset: 0, stagesOffset: 0 });
    expect(analyticsReducer(paged, { type: "template", templateId: "t1" })).toMatchObject({ templateId: "t1", templatesOffset: 0, stagesOffset: 0 });
    expect(analyticsReducer(s0, { type: "templatesPage", offset: -50 }).templatesOffset).toBe(0);
  });

  it("one refresh at a time; its outcome only lands on a running pass", () => {
    const run = analyticsReducer(s0, { type: "refreshStart" });
    expect(run.refresh.phase).toBe("running");
    expect(analyticsReducer(run, { type: "refreshStart" })).toBe(run);
    expect(analyticsReducer(run, { type: "refreshDismiss" })).toBe(run);
    const result = { projected: 3, diverged: 1, tooLong: 0, remaining: true };
    const done = analyticsReducer(run, { type: "refreshDone", result, now: "2026-11-22T12:05:00.000Z" });
    expect(done).toMatchObject({ refresh: { phase: "done", result }, anchor: "2026-11-22T12:05:00.000Z" });
    expect(analyticsReducer(s0, { type: "refreshDone", result, now: NOW })).toBe(s0);
    expect(analyticsReducer(run, { type: "refreshFailed", message: "no" }).refresh).toEqual({ phase: "failed", message: "no" });
    expect(analyticsReducer(done, { type: "refreshDismiss" }).refresh).toEqual({ phase: "idle" });
  });
});

describe("the calls", () => {
  it("reads templates with limit and offset, and a 403 is an ApiError", async () => {
    const fetchMock = vi.fn(async () => res({ ...env, total: 1, limit: 50, offset: 0, templates: [template] }));
    vi.stubGlobal("fetch", fetchMock);
    const out = await fetchTemplates(initialAnalyticsState(NOW), 0);
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toMatch(/^\/v1\/process-analytics\/templates\?from=.*&limit=50&offset=0$/);
    expect(out.templates).toHaveLength(1);
    vi.stubGlobal("fetch", vi.fn(async () => res({ error: "forbidden", detail: "admins only" }, 403)));
    await expect(fetchTemplates(initialAnalyticsState(NOW), 0)).rejects.toBeInstanceOf(ApiError);
  });

  it("asks the heatmap for its top 20 stages by the chosen period", async () => {
    const fetchMock = vi.fn(async () => res({ ...env, bucket: "day", periods: [], stages: [] }));
    vi.stubGlobal("fetch", fetchMock);
    await fetchHeatmap(initialAnalyticsState(NOW), "day");
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toMatch(/&bucket=day&limit=20$/);
  });

  it("refresh posts to the route and reads the pass's outcome", async () => {
    const fetchMock = vi.fn(async () => res({ projected: 2, diverged: 0, tooLong: 0, remaining: false }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await refreshAnalytics()).toEqual({ projected: 2, diverged: 0, tooLong: 0, remaining: false });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/v1/process-analytics/refresh");
    expect(init.method).toBe("POST");
  });
});
