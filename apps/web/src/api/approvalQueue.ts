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
 * One query key per URL (the key IS the URL): the same key always means the
 * same request, and every key sits under the ["approvals"] prefix every decide
 * path invalidates.
 *
 * This module is in the entry chunk (the nav badge reads it), so it holds only
 * what the badge needs. The decided queue and the cap note live in
 * `approvalQueuePages.ts`, which only the lazy pages import.
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

export const PENDING_QUEUE_URL = "/v1/approvals?status=pending&order=asc";

/** the pending queue, oldest first (the Inbox, the workbench, the nav badge and Home all share it) */
export function pendingQueueQuery<T extends Approval = Approval>() {
  return {
    queryKey: ["approvals", PENDING_QUEUE_URL] as const,
    queryFn: () => api.get<ApprovalQueuePage<T>>(PENDING_QUEUE_URL),
  };
}

/** the rows of a page, or none when the answer has no list */
const rowsOf = <T extends Approval>(page: ApprovalQueuePage<T> | undefined): T[] =>
  page && Array.isArray(page.approvals) ? page.approvals : [];

/** the pending rows of a page (defensive: a row that is no longer pending is never shown as waiting) */
export const pendingRows = <T extends Approval>(page: ApprovalQueuePage<T> | undefined): T[] =>
  rowsOf(page).filter((a) => a.status === "pending");

/** how many rows the server says match, never fewer than it returned */
export const queueTotal = (page: ApprovalQueuePage | undefined, shown: number): number =>
  page && typeof page.total === "number" && page.total >= shown ? page.total : shown;
