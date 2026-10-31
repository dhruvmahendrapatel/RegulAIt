/**
 * The approvals queue reads only the Inbox, the Review workbench and Home use.
 * Kept apart from `approvalQueue.ts` (which the nav badge pulls into the entry
 * chunk) so these stay in the lazy page chunks.
 */
import { api } from "./client";
import type { Approval } from "./types";
import { queueTotal, type ApprovalQueuePage } from "./approvalQueue";

export const DECIDED_STATUSES = ["approved", "denied", "returned", "consumed", "superseded"] as const;

export const DECIDED_QUEUE_URL = `/v1/approvals?status=${DECIDED_STATUSES.join(",")}`;

/** decided approvals, newest first, for "Recently decided" */
export function decidedQueueQuery<T extends Approval = Approval>() {
  return {
    queryKey: ["approvals", DECIDED_QUEUE_URL] as const,
    queryFn: () => api.get<ApprovalQueuePage<T>>(DECIDED_QUEUE_URL),
  };
}

/** the decided rows of a page */
export const decidedRows = <T extends Approval>(page: ApprovalQueuePage<T> | undefined): T[] =>
  (page && Array.isArray(page.approvals) ? page.approvals : []).filter((a) => a.status !== "pending");

/**
 * The note shown when the pending queue holds more than one page, or null when
 * the page is the whole queue.
 */
export function pendingCapNote(page: ApprovalQueuePage | undefined, shown: number): string | null {
  const total = queueTotal(page, shown);
  if (total <= shown && page?.hasMore !== true) return null;
  return `Showing the oldest ${shown} of ${total} pending · narrow with filters`;
}
