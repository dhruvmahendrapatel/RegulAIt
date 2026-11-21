/**
 * My actions summary: counts over the pending rows this page already loaded (server-filtered to the caller).
 * They are never organisation-wide totals. Due-date counts use the given clock (the browser's), because the
 * approvals list carries no server overdue flag; the page labels them as such and recomputes them each minute.
 */
import type { Approval } from "../../api/types";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export interface InboxSummary {
  pending: number;
  intake: number;
  tool: number;
  dueSoon: number;
  overdue: number;
}

export function inboxSummary(
  rows: readonly Approval[],
  now: number,
  isIntake: (a: Approval) => boolean,
  isTool: (a: Approval) => boolean,
): InboxSummary {
  let dueSoon = 0;
  let overdue = 0;
  for (const a of rows) {
    const raw = a.assignment?.dueAt;
    const due = raw ? Date.parse(raw) : Number.NaN;
    if (!Number.isFinite(due)) continue;
    if (due < now) overdue++;
    else if (due < now + WEEK_MS) dueSoon++;
  }
  return { pending: rows.length, intake: rows.filter(isIntake).length, tool: rows.filter(isTool).length, dueSoon, overdue };
}
