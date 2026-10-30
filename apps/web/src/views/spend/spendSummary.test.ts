import { describe, expect, it } from "vitest";
import { RECENT_ROWS, SUMMARY_DAYS, agentBars, connectorBars, summaryWindowLabel } from "./spendSummary";
import type { UsageSummaryResponse } from "../../api/types";

const summary = (groups: UsageSummaryResponse["groups"], defaulted = true): UsageSummaryResponse => ({
  groupBy: "agent",
  userId: "u",
  window: { from: "2026-09-30T12:00:00.000Z", to: "2026-10-30T12:00:00.000Z", defaulted },
  groups,
  totals: { events: groups.reduce((a, g) => a + g.events, 0), costUsd: groups.reduce((a, g) => a + g.costUsd, 0) },
});

describe("the Spend page's server-aggregated breakdowns", () => {
  it("labels the totals with their window", () => {
    expect(summaryWindowLabel(summary([]).window)).toBe("last 30 days");
    expect(summaryWindowLabel(summary([], false).window)).toBe("2026-09-30 to 2026-10-30");
    expect(summaryWindowLabel(undefined)).toBe(`last ${SUMMARY_DAYS} days`);
    expect(RECENT_ROWS).toBe(50);
  });

  it("shows the server's sums as they are, largest first, with agent names from the caller's grants", () => {
    const bars = agentBars(
      summary([
        { agentId: "a1", costUsd: 1.5, events: 300 },
        { agentId: "a2", costUsd: 4.25, events: 12 },
        { agentId: null, costUsd: 0.1, events: 1 },
      ]),
      new Map([["a1", "Claude"]]),
    );
    expect(bars).toEqual([
      { key: "a2", label: "a2", value: 4.25 },
      { key: "a1", label: "Claude", value: 1.5 },
      { key: "unknown", label: "unknown agent", value: 0.1 },
    ]);
  });

  it("one connector bar per connector and operation, falling back to the server's name", () => {
    const bars = connectorBars(
      summary([
        { connectorId: "c1", name: "Search API", operation: "search", costUsd: 0.2, events: 40 },
        { connectorId: "c1", name: "Search API", operation: "fetch", costUsd: 0.3, events: 10 },
      ]),
      new Map(),
    );
    expect(bars.map((b) => b.label)).toEqual(["Search API · fetch", "Search API · search"]);
    expect(bars.map((b) => b.key)).toEqual(["c1:fetch", "c1:search"]);
  });
});
