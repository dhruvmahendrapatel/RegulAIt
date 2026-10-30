/**
 * The approvals queue reads, shared by the Inbox, the Review workbench, the
 * nav badge and Home.
 *
 * `GET /v1/approvals` answers at most 100 rows. Reading it unfiltered and
 * keeping the pending rows in the browser drops older pending approvals as
 * soon as 100 newer rows of any status exist. So the pending queue is asked
 * for by status, OLDEST FIRST (the longest-waiting decision matters most), and
 * the server's `total` gives the true count. "Recently decided" is its own
 * query over the decided statuses, newest first.
 *
 * One query key per URL: the same key always means the same request, and every
 * key sits under the ["approvals"] prefix every decide path invalidates.
 */
import { api } from "./client";
import type { Approval } from "./types";

export interface ApprovalQueuePage<T extends Approval = Approval> {
  approvals: T[];
  /** every row the same filters and visibility match (absent from an older gateway) */
  total?: number;
  /** true when `total` exceeds the rows returned */
  hasMore?: boolean;
  /** the server's page size */
  limit?: number;
}

export const DECIDED_STATUSES = ["approved", "denied", "returned", "consumed", "superseded"] as const;

export const PENDING_QUEUE_URL = "/v1/approvals?status=pending&order=asc";
export const DECIDED_QUEUE_URL = `/v1/approvals?status=${DECIDED_STATUSES.join(",")}`;

/** the pending queue, oldest first (the Inbox, the workbench, the nav badge and Home all share it) */
export function pendingQueueQuery<T extends Approval = Approval>() {
  return {
    queryKey: ["approvals", "pending", "oldest-first"] as const,
    queryFn: () => api.get<ApprovalQueuePage<T>>(PENDING_QUEUE_URL),
  };
}

/** decided approvals, newest first, for "Recently decided" */
export function decidedQueueQuery<T extends Approval = Approval>() {
  return {
    queryKey: ["approvals", "decided", "newest-first"] as const,
    queryFn: () => api.get<ApprovalQueuePage<T>>(DECIDED_QUEUE_URL),
  };
}

const rowsOf = <T extends Approval>(page: ApprovalQueuePage<T> | undefined): T[] =>
  Array.isArray(page?.approvals) ? page.approvals : [];

/** the pending rows of a page (defensive: a row that is no longer pending is never shown as waiting) */
export const pendingRows = <T extends Approval>(page: ApprovalQueuePage<T> | undefined): T[] =>
  rowsOf(page).filter((a) => a.status === "pending");

/** the decided rows of a page */
export const decidedRows = <T extends Approval>(page: ApprovalQueuePage<T> | undefined): T[] =>
  rowsOf(page).filter((a) => a.status !== "pending");

/** how many rows the server says match, never fewer than it returned */
export const queueTotal = (page: ApprovalQueuePage | undefined, shown: number): number =>
  typeof page?.total === "number" && page.total >= shown ? page.total : shown;

/**
 * The note shown when the pending queue holds more than one page, or null when
 * the page is the whole queue.
 */
export function pendingCapNote(page: ApprovalQueuePage | undefined, shown: number): string | null {
  const total = queueTotal(page, shown);
  if (total <= shown && page?.hasMore !== true) return null;
  return `Showing the oldest ${shown} of ${total} pending · narrow with filters`;
}
