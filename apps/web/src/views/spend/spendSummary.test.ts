import { describe, expect, it } from "vitest";
import { CHART_DAYS, RECENT_ROWS, SUMMARY_DAYS, agentBars, chartFrom, connectorBars, daySeries, ledgerSplit, mcpToolBars, projectGroups, summaryWindowLabel } from "./spendSummary";
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

describe("project, day, MCP tool and the ledger split", () => {
  const base = (groupBy: UsageSummaryResponse["groupBy"], groups: UsageSummaryResponse["groups"], extra: Partial<UsageSummaryResponse> = {}): UsageSummaryResponse => ({
    ...summary(groups),
    groupBy,
    ...extra,
  });

  it("projects keep the unattributed bucket", () => {
    const g = projectGroups(base("project", [{ projectId: "p1", costUsd: 1, events: 1 }, { projectId: null, costUsd: 2, events: 5 }]));
    expect(g).toEqual([
      { key: "unattributed", id: "", value: 2 },
      { key: "p1", id: "p1", value: 1 },
    ]);
  });

  it("the day series is 14 UTC days ending today, empty days kept", () => {
    const now = Date.parse("2026-10-30T15:00:00.000Z");
    const days = daySeries(base("day", [{ day: "2026-10-30", costUsd: 3, events: 2 }, { day: "2026-10-20", costUsd: 1, events: 1 }]), now);
    expect(days).toHaveLength(CHART_DAYS);
    expect(days[0]!.day).toBe("2026-10-17");
    expect(days[CHART_DAYS - 1]).toEqual({ day: "2026-10-30", value: 3 });
    expect(days.find((d) => d.day === "2026-10-20")!.value).toBe(1);
    expect(days.filter((d) => d.value === 0)).toHaveLength(12);
    expect(chartFrom(now)).toBe("2026-10-17T00:00:00.000Z");
  });

  it("MCP tools are their own bars", () => {
    expect(mcpToolBars(base("mcp_tool", [{ toolName: "lookup", costUsd: 3, events: 1 }]))).toEqual([{ key: "lookup", label: "lookup", value: 3 }]);
  });

  it("agents + connectors + MCP tools + other = the ledger, from the server's sums", () => {
    const ledger = {
      events: 10,
      costUsd: 10,
      byObjectType: [
        { objectType: "agent", events: 5, costUsd: 5 },
        { objectType: "connector", events: 2, costUsd: 1 },
        { objectType: "mcp_tool", events: 2, costUsd: 3 },
        { objectType: "training_job", events: 1, costUsd: 1 },
      ],
      other: { events: 1, costUsd: 1 },
    };
    const agent = base("agent", [{ agentId: "a", costUsd: 5, events: 5 }], { ledger });
    const connector = base("connector", [{ connectorId: "c", operation: "x", costUsd: 1, events: 2 }]);
    const mcp = base("mcp_tool", [{ toolName: "t", costUsd: 3, events: 2 }]);
    const split = ledgerSplit(agent, connector, mcp)!;
    expect(split.agents + split.connectors + split.mcpTools + split.other).toBe(split.total);
    expect(split.otherTypes).toEqual(["training_job"]);
    expect(ledgerSplit(agent, undefined, mcp)).toBeNull();
  });
});
