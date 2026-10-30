/**
 * The Spend page's server-aggregated breakdowns (`GET /v1/usage-events/summary`), turned into bars and labelled with
 * the window they cover. Pure functions, so the labelling is unit-tested.
 */
import type { UsageSummaryResponse } from "../../api/types";

/** the daily chart's length, in UTC days ending today */
export const CHART_DAYS = 14;

/** the gateway's default window for the summary (the page sends no `from`, so the server applies it) */
export const SUMMARY_DAYS = 30;
/** how many of the newest invocations the Recent invocations table lists */
export const RECENT_ROWS = 50;

/** "last 30 days" for the default window, otherwise the dates it spans */
export function summaryWindowLabel(w: UsageSummaryResponse["window"] | undefined): string {
  if (!w) return `last ${SUMMARY_DAYS} days`;
  const days = Math.round((Date.parse(w.to) - Date.parse(w.from)) / 86_400_000);
  if (w.defaulted) return `last ${days} days`;
  return `${w.from.slice(0, 10)} to ${w.to.slice(0, 10)}`;
}

/** the server's agent groups as bars; agent names come from the caller's own grants */
export function agentBars(data: UsageSummaryResponse | undefined, agentName: Map<string, string>) {
  return (data?.groups ?? [])
    .map((g) => {
      const key = g.agentId ?? "unknown";
      return { key, label: g.agentId ? (agentName.get(g.agentId) ?? g.agentId) : "unknown agent", value: g.costUsd };
    })
    .sort((a, b) => b.value - a.value);
}

/** the server's connector groups as bars, one per connector and operation */
export function connectorBars(data: UsageSummaryResponse | undefined, connectorName: Map<string, string>) {
  return (data?.groups ?? [])
    .map((g) => ({
      key: `${g.connectorId ?? "?"}:${g.operation ?? ""}`,
      label: `${(g.connectorId ? connectorName.get(g.connectorId) : undefined) ?? g.name ?? "connector"} · ${g.operation ?? ""}`,
      value: g.costUsd,
    }))
    .sort((a, b) => b.value - a.value);
}


/** the server's MCP tool groups as bars (an MCP row carries no agent, so it is its own breakdown) */
export function mcpToolBars(data: UsageSummaryResponse | undefined) {
  return (data?.groups ?? [])
    .map((g) => ({ key: g.toolName ?? "unknown", label: g.toolName ?? "unknown tool", value: g.costUsd }))
    .sort((a, b) => b.value - a.value);
}

/** the server's project groups, `id` empty for unattributed spend */
export function projectGroups(data: UsageSummaryResponse | undefined) {
  return (data?.groups ?? [])
    .map((g) => ({ key: g.projectId ?? "unattributed", id: g.projectId ?? "", value: g.costUsd }))
    .sort((a, b) => b.value - a.value);
}

/** the start of the chart's window: UTC midnight, `CHART_DAYS - 1` days before today */
export function chartFrom(now: number = Date.now()): string {
  const d = new Date(now);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - (CHART_DAYS - 1) * 86_400_000).toISOString();
}

/** one bar per UTC day ending today; a day with no event is an empty day, never dropped */
export function daySeries(data: UsageSummaryResponse | undefined, now: number = Date.now()) {
  const m = new Map((data?.groups ?? []).map((g) => [g.day ?? "", g.costUsd]));
  const out: Array<{ day: string; value: number }> = [];
  for (let i = CHART_DAYS - 1; i >= 0; i--) {
    const d = new Date(now - i * 86_400_000).toISOString().slice(0, 10);
    out.push({ day: d, value: m.get(d) ?? 0 });
  }
  return out;
}

/**
 * How the window's ledger splits into the typed breakdowns plus "other" (object types no breakdown names), or null
 * until all three breakdowns have answered. The parts are the server's sums, so they add up to the ledger.
 */
export function ledgerSplit(
  agent: UsageSummaryResponse | undefined,
  connector: UsageSummaryResponse | undefined,
  mcp: UsageSummaryResponse | undefined,
) {
  const ledger = agent?.ledger;
  if (!agent?.totals || !connector?.totals || !mcp?.totals || !ledger) return null;
  return {
    agents: agent.totals.costUsd,
    connectors: connector.totals.costUsd,
    mcpTools: mcp.totals.costUsd,
    other: ledger.other.costUsd,
    total: ledger.costUsd,
    otherTypes: ledger.byObjectType
      .filter((t) => !["agent", "connector", "mcp_tool"].includes(t.objectType))
      .map((t) => t.objectType),
  };
}
