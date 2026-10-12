import { describe, expect, it } from "vitest";
import { statementHeadline, statementLines } from "./billingDetailModel";

describe("statementLines", () => {
  it("reads the frozen usage lines", () => {
    const lines = statementLines({
      usage: { lines: [{ dimension: "model", matchKey: "*", events: 3, inputTokens: 10, outputTokens: 20, billedUsd: 1.5, unpriced: false, rateNote: "per 1M" }] },
    });
    expect(lines).toEqual([{ dimension: "model", matchKey: "*", events: 3, inputTokens: 10, outputTokens: 20, billedUsd: 1.5, unpriced: false, rateNote: "per 1M" }]);
  });

  it("keeps an unpriced line unpriced, never $0", () => {
    const [l] = statementLines({ usage: { lines: [{ dimension: "tool_call", events: 2, billedUsd: null, unpriced: true }] } });
    expect(l).toMatchObject({ billedUsd: null, unpriced: true, matchKey: "*" });
    const [m] = statementLines({ usage: { lines: [{ dimension: "seat" }] } });
    expect(m!.unpriced).toBe(true);
  });

  it("returns no lines for a payload that carries none", () => {
    expect(statementLines(null)).toEqual([]);
    expect(statementLines({ usage: { lines: "x" } })).toEqual([]);
  });

  it("reads the headline when present", () => {
    expect(statementHeadline({ periodLabel: "2026-09", disclaimer: "estimate" })).toEqual({ periodLabel: "2026-09", disclaimer: "estimate" });
    expect(statementHeadline([])).toEqual({ periodLabel: null, disclaimer: null });
  });
});
