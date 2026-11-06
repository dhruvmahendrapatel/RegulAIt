/**
 * P3 with the I-2 tabs pattern (#453): the Licensing page keeps its current state above the tabs and puts the rest
 * behind them. Each tab's label carries what is unresolved inside it, read from the same fields the panel renders, so
 * a tab never hides a refusal or a warning without saying so (ADR-0180). `null` means "still loading": the label shows
 * the name until the read settles.
 */
import { plural } from "../../../api/format";

export const LICENSING_TABS = [
  { id: "classes", name: "Action classes" },
  { id: "seats", name: "Seats" },
  { id: "features", name: "Tier features" },
  { id: "install", name: "Install and verify" },
  { id: "history", name: "History" },
] as const;
export type LicensingTab = (typeof LICENSING_TABS)[number]["id"];

/** the tab named by `?tab=`; a missing or unknown value opens the first tab */
export function licensingTabFrom(value: string | null): LicensingTab {
  return LICENSING_TABS.find((t) => t.id === value)?.id ?? "classes";
}

/** the part of `/v1/licenses/status` the labels read */
export interface LicensingTabStatus {
  seats: { remaining: number | null; canProvision: boolean };
  actionClasses: Record<"read" | "governance" | "expansion", { allowed: boolean }>;
  schedulerPresent: boolean;
}

export interface LicensingTabCounts {
  /** the status read; undefined while loading or after a failed first read */
  status: LicensingTabStatus | undefined;
  /** refused verifications on the trail; null while the count is loading */
  refusedVerifications: number | null;
  /** the refused-count read failed: the label says the count is unavailable, never that nothing was refused */
  refusedCountFailed?: boolean;
}

function label(name: string, parts: Array<string | null>): string {
  const shown = parts.filter((p): p is string => p !== null);
  return shown.length ? `${name} · ${shown.join(" · ")}` : name;
}

/** "Action classes · 1 refused", "Seats · cannot provision", "History · 12 refused", or just the name */
export function licensingTabLabel(id: LicensingTab, c: LicensingTabCounts): string {
  const name = LICENSING_TABS.find((t) => t.id === id)!.name;
  const s = c.status;
  switch (id) {
    case "classes": {
      if (!s) return name;
      const refused = Object.values(s.actionClasses).filter((d) => !d.allowed).length;
      return label(name, [refused > 0 ? `${refused.toLocaleString()} refused` : null]);
    }
    case "seats":
      // the panel shows "Can provision a new user: no" and a zero "Remaining" as danger badges
      if (!s) return name;
      return label(name, [!s.seats.canProvision ? "cannot provision" : s.seats.remaining !== null && s.seats.remaining <= 0 ? "none remaining" : null]);
    case "install":
      // the panel shows "In-process scheduler: no" as a warning badge
      if (!s) return name;
      return label(name, [!s.schedulerPresent ? plural(1, "warning") : null]);
    case "history":
      if (c.refusedCountFailed) return label(name, ["refused count unavailable"]);
      return label(name, [c.refusedVerifications ? `${c.refusedVerifications.toLocaleString()} refused` : null]);
    case "features":
      // a closed feature is the licence's terms, not a warning
      return name;
  }
}
