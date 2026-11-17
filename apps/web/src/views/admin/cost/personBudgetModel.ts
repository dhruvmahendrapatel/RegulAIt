/**
 * Spend by person (lane UI-D, D3): the pure model behind PersonBudgetsPage.
 *
 * Contract (ADR-0312 pilot addendum, #848): a person's spend budget is alert-only. Nothing is refused on it.
 *  - GET    /v1/user-spend-budgets               every budget row with the person's display name (admin)
 *  - GET    /v1/users/:userId/spend-budget       one person's budget, window, metered and imported spend (404: none)
 *  - PUT    /v1/users/:userId/spend-budget       set or change: { budgetUsd > 0, budgetPeriod?, alertThresholdPct? }
 *  - DELETE /v1/users/:userId/spend-budget       remove: a relaxation, so the gateway asks for a step-up
 *
 * Metered spend is compared with the budget; imported spend is shown beside it and NEVER added (ADR-0069).
 */
import { fmtUsd } from "../../../api/format";

export type BudgetPeriod = "monthly" | "none";

export interface PersonBudget {
  id: string;
  userId: string;
  displayName?: string | null;
  budgetUsd: number;
  budgetPeriod: BudgetPeriod | string;
  alertThresholdPct: number;
  createdAt?: string;
  updatedAt?: string;
}

export interface PersonBudgetView {
  budget: PersonBudget;
  window: { period: string; from?: string };
  metered: { basis: "metered"; usd: number; pctOfBudget: number };
  imported: { basis: "imported"; usd: number; nonUsdLines: number };
  note?: string;
}

export const MAX_BUDGET_USD = 10_000_000;
export const DEFAULT_THRESHOLD_PCT = 80;

export const PERIOD_WORDS: Record<BudgetPeriod, string> = {
  monthly: "Per calendar month (UTC)",
  none: "Lifetime, never resets",
};

export const periodWords = (p: string): string => (p === "monthly" || p === "none" ? PERIOD_WORDS[p] : p);

/** the budget line in a table row: "$500.00 a month, alert at 80%" */
export function budgetLine(b: Pick<PersonBudget, "budgetUsd" | "budgetPeriod" | "alertThresholdPct">): string {
  const per = b.budgetPeriod === "monthly" ? " a month" : " in total";
  return `${fmtUsd(b.budgetUsd)}${per}, alert at ${b.alertThresholdPct}%`;
}

/** Inline checks for the budget form (shown on blur or submit). Null is valid. */
export function amountProblem(raw: string): string | null {
  const t = raw.trim();
  if (!t) return "Enter an amount in US dollars.";
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return "Use digits only, with at most two decimal places.";
  const n = Number(t);
  if (!(n > 0)) return "The budget must be more than zero.";
  if (n > MAX_BUDGET_USD) return `The budget can be at most ${fmtUsd(MAX_BUDGET_USD)}.`;
  return null;
}

export function thresholdProblem(raw: string): string | null {
  const t = raw.trim();
  if (!/^\d{1,3}$/.test(t)) return "Enter a whole percentage from 1 to 100.";
  const n = Number(t);
  if (n < 1 || n > 100) return "Enter a whole percentage from 1 to 100.";
  return null;
}

/** the PUT body; call only once both checks pass */
export function budgetBody(amount: string, period: BudgetPeriod, threshold: string) {
  return { budgetUsd: Number(amount.trim()), budgetPeriod: period, alertThresholdPct: Number(threshold.trim()) };
}

export type BudgetStanding = "over" | "alerting" | "below";

/**
 * Where metered spend stands against the budget, mirroring the gateway's own crossing rule (budget-alerts.ts
 * `budgetCrossing`): at or above the budget is "over", at or above the threshold is "alerting", else "below".
 */
export function standing(view: Pick<PersonBudgetView, "metered" | "budget">): BudgetStanding {
  const spent = view.metered.usd;
  const { budgetUsd, alertThresholdPct } = view.budget;
  if (spent >= budgetUsd) return "over";
  if (spent >= (budgetUsd * alertThresholdPct) / 100) return "alerting";
  return "below";
}

export const STANDING_WORDS: Record<BudgetStanding, string> = {
  over: "Over budget: alert raised",
  alerting: "Past the alert threshold: alert raised",
  below: "Below the alert threshold",
};

export const STANDING_TONE: Record<BudgetStanding, "danger" | "warn" | "ok"> = {
  over: "danger",
  alerting: "warn",
  below: "ok",
};

/** "42% of the budget", rounded down so a figure never reads as past a line it has not crossed */
export const pctWords = (pct: number): string => `${Math.floor(Math.max(0, pct))}% of the budget`;

/** the people a budget can be set for: everyone without one yet, by name */
export function peopleWithoutBudget<U extends { id: string; displayName?: string | null; email?: string | null }>(
  users: U[],
  budgets: Pick<PersonBudget, "userId">[],
): U[] {
  const has = new Set(budgets.map((b) => b.userId));
  return users
    .filter((u) => !has.has(u.id))
    .sort((a, b) => (a.displayName || a.email || "").localeCompare(b.displayName || b.email || ""));
}

/** a client-side filter over names (the list is bounded at 1,000 rows by the server) */
export function matchesName(b: Pick<PersonBudget, "displayName">, q: string): boolean {
  const t = q.trim().toLowerCase();
  return !t || (b.displayName ?? "").toLowerCase().includes(t);
}

/**
 * What the page has open, as one declared state (rule 12): nothing, one person's drawer, the budget form, or the
 * form over the drawer ("Change budget" from inside it). Every overlay change goes through pageReducer.
 */
export interface PageState {
  viewing: string | null;
  editing: PersonBudget | "new" | null;
}
export type PageEvent =
  | { type: "view"; userId: string }
  | { type: "closeView" }
  | { type: "edit"; target: PersonBudget | "new" }
  | { type: "closeEdit" };
export const PAGE_IDLE: PageState = { viewing: null, editing: null };

export function pageReducer(s: PageState, e: PageEvent): PageState {
  switch (e.type) {
    case "view":
      // the form is modal: a row cannot be opened behind it
      return s.editing ? s : { ...s, viewing: e.userId };
    case "closeView":
      return { ...s, viewing: null };
    case "edit":
      return { ...s, editing: e.target };
    case "closeEdit":
      return { ...s, editing: null };
  }
}

/**
 * Removing a budget: idle → confirming → removing → (closed on success | idle on failure). The step-up and the
 * request run only from "removing"; any other event in a state that does not allow it leaves the state unchanged.
 */
export type RemoveState = "idle" | "confirming" | "removing";
export type RemoveEvent = "ask" | "cancel" | "confirm" | "failed";
const REMOVE_NEXT: Record<RemoveState, Partial<Record<RemoveEvent, RemoveState>>> = {
  idle: { ask: "confirming" },
  confirming: { cancel: "idle", confirm: "removing" },
  removing: { failed: "idle" },
};
export const removeReducer = (s: RemoveState, e: RemoveEvent): RemoveState => REMOVE_NEXT[s][e] ?? s;

/** why the Remove button cannot be pressed now, or null when it can */
export const removeBlockedReason = (s: RemoveState): string | null =>
  s === "removing" ? "Removing the budget; wait for it to finish." : null;
