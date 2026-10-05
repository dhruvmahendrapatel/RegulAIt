/**
 * ADR-0173 batch 2c (F) — the shared trace filter schema and the reader scope.
 * The SQL side (and the scoping invariant against a real database) is
 * apps/gateway/src/trace-scores.test.ts.
 */
import { describe, expect, it } from "vitest";
import { refineTraceFilter, resolveTraceScope, traceFilterBaseSchema, traceFilterSchema } from "./trace-filters.js";

const ME = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

describe("resolveTraceScope", () => {
  it("a non-admin is always scoped to themself", () => {
    expect(resolveTraceScope({ userId: ME, isAdmin: false }, {})).toEqual({ ok: true, scopeUserId: ME });
    expect(resolveTraceScope({ userId: ME, isAdmin: false }, { userId: ME })).toEqual({ ok: true, scopeUserId: ME });
  });
  it("a non-admin naming somebody else is refused, not silently re-scoped", () => {
    expect(resolveTraceScope({ userId: ME, isAdmin: false }, { userId: OTHER }).ok).toBe(false);
  });
  it("an admin is unscoped", () => {
    expect(resolveTraceScope({ userId: ME, isAdmin: true }, { userId: OTHER })).toEqual({ ok: true, scopeUserId: null });
  });
});

describe("traceFilterSchema", () => {
  it("parses query-string values, and 'false' means false", () => {
    const f = traceFilterSchema.parse({ minCostUsd: "0.5", minLatencyMs: "100", flagged: "false", deniedOnly: "1", scoreName: "q", scoreMin: "0" });
    expect(f).toMatchObject({ minCostUsd: 0.5, minLatencyMs: 100, flagged: false, deniedOnly: true, scoreMin: 0 });
  });
  it("refuses a score range without a name, an inverted range, a value without a key and a bad tag key", () => {
    expect(traceFilterSchema.safeParse({ scoreMin: 1 }).success).toBe(false);
    expect(traceFilterSchema.safeParse({ scoreName: "q", scoreMin: 2, scoreMax: 1 }).success).toBe(false);
    expect(traceFilterSchema.safeParse({ tagValue: "x" }).success).toBe(false);
    expect(traceFilterSchema.safeParse({ tagKey: "Bad Key" }).success).toBe(false);
    expect(traceFilterSchema.safeParse({ minCostUsd: "-1" }).success).toBe(false);
  });
  it("can be extended by a route and keep its cross-field rules", () => {
    const q = traceFilterBaseSchema.extend({ limit: traceFilterBaseSchema.shape.minLatencyMs }).superRefine(refineTraceFilter);
    expect(q.safeParse({ tagValue: "x", limit: "5" }).success).toBe(false);
    expect(q.parse({ limit: "5" })).toEqual({ limit: 5 });
  });
});
