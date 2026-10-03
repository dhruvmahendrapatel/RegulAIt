/**
 * The AI registry's row model and the pure rules the page applies to it —
 * labels, tones, the "valid until" reading and the filters — kept out of the
 * component so they are unit-tested without a browser (ADR-0168 item 2).
 */
import type { Tone } from "../../../ui/kit";

export type UseCaseStatus = "proposed" | "under_review" | "needs_info" | "approved" | "rejected" | "retired";
export type EuTier = "prohibited" | "high" | "limited" | "minimal";

export interface UseCaseRow {
  id: string;
  name: string;
  description: string;
  businessContext: string;
  ownerUserId: string;
  ownerName?: string | null;
  intendedAgentIds: string[];
  dataSensitivity: string;
  complianceTags: string[];
  projectId: string | null;
  status: UseCaseStatus;
  workflowInstanceId: string | null;
  euAiActTier: EuTier | null;
  decidedAt: string | null;
  retiredReason: string | null;
  createdAt: string;
  /** ADR-0168: set on approval (high → +6 months, minimal/limited → +12); absent on an older gateway */
  approvedUntil?: string | null;
  /** ADR-0168: open approval conditions; absent on an older gateway */
  openConditions?: number;
}

const STATUS_LABEL: Record<UseCaseStatus, string> = {
  proposed: "Proposed",
  under_review: "Under review",
  needs_info: "Needs information",
  approved: "Approved",
  rejected: "Rejected",
  retired: "Retired",
};
export const statusLabel = (s: string) => STATUS_LABEL[s as UseCaseStatus] ?? s.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

export const statusTone = (s: UseCaseStatus): Tone =>
  s === "approved" ? "ok" : s === "under_review" ? "info" : s === "needs_info" ? "warn" : s === "rejected" ? "danger" : s === "retired" ? "neutral" : "neutral";

export const tierTone = (t: EuTier): Tone => (t === "prohibited" ? "danger" : t === "high" ? "warn" : t === "limited" ? "info" : "ok");
export const tierLabel = (t: EuTier) => (t === "prohibited" ? "Prohibited" : `${t.charAt(0).toUpperCase()}${t.slice(1)}`);

/** "3 Oct 2026" — a date a reader scans in a column, never a timestamp */
export function fmtDay(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

/** what the "Valid until" column says: a date, "—" before approval, and an expired approval called out */
export function validity(approvedUntil: string | null | undefined, expiredFlag?: boolean, now: Date = new Date()): { text: string; expired: boolean } {
  if (!approvedUntil) return { text: "—", expired: false };
  const expired = expiredFlag ?? new Date(approvedUntil).getTime() < now.getTime();
  return { text: expired ? `Expired ${fmtDay(approvedUntil)}` : fmtDay(approvedUntil), expired };
}

/** the headline tiles: what a governance lead asks first */
export function headline(rows: readonly UseCaseRow[]) {
  return {
    total: rows.length,
    underReview: rows.filter((r) => r.status === "proposed" || r.status === "under_review" || r.status === "needs_info").length,
    approved: rows.filter((r) => r.status === "approved").length,
    highTier: rows.filter((r) => r.euAiActTier === "high" || r.euAiActTier === "prohibited").length,
  };
}

export type StatusFilter = "all" | "in_review" | UseCaseStatus;
export type TierFilter = "all" | EuTier | "unscreened" | "high_or_prohibited";

export interface RegistryFilters {
  search: string;
  status: StatusFilter;
  tier: TierFilter;
  owner: string; // "" = everyone
}
export const NO_FILTERS: RegistryFilters = { search: "", status: "all", tier: "all", owner: "" };

export const isFiltered = (f: RegistryFilters) => f.search.trim() !== "" || f.status !== "all" || f.tier !== "all" || f.owner !== "";

export function applyFilters(rows: readonly UseCaseRow[], f: RegistryFilters): UseCaseRow[] {
  const q = f.search.trim().toLowerCase();
  return rows.filter((r) => {
    if (f.status === "in_review" ? !(r.status === "proposed" || r.status === "under_review" || r.status === "needs_info") : f.status !== "all" && r.status !== f.status) return false;
    if (f.tier === "unscreened" ? r.euAiActTier !== null : f.tier === "high_or_prohibited" ? !(r.euAiActTier === "high" || r.euAiActTier === "prohibited") : f.tier !== "all" && r.euAiActTier !== f.tier) return false;
    if (f.owner && r.ownerUserId !== f.owner) return false;
    if (q && ![r.name, r.description, r.ownerName ?? ""].some((text) => text.toLowerCase().includes(q))) return false;
    return true;
  });
}
