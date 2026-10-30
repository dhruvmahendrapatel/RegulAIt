/**
 * The Spend page's server-aggregated breakdowns (`GET /v1/usage-events/summary`), turned into bars and labelled with
 * the window they cover. Pure functions, so the labelling is unit-tested.
 */
import type { UsageSummaryResponse } from "../../api/types";

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

