import { describe, expect, it } from "vitest";
import {
  DECIDED_QUEUE_URL,
  PENDING_QUEUE_URL,
  decidedQueueQuery,
  decidedRows,
  pendingCapNote,
  pendingQueueQuery,
  pendingRows,
  queueTotal,
  type ApprovalQueuePage,
} from "./approvalQueue";
import type { Approval } from "./types";

const row = (id: string, status: Approval["status"]): Approval => ({ id, status, objectType: "workflow", stageId: null }) as unknown as Approval;

describe("the approvals queue reads", () => {
  it("asks the server for pending rows, oldest first, and decided rows separately", () => {
    expect(PENDING_QUEUE_URL).toBe("/v1/approvals?status=pending&order=asc");
    expect(DECIDED_QUEUE_URL).toBe("/v1/approvals?status=approved,denied,returned,consumed,superseded");
    expect(DECIDED_QUEUE_URL).not.toContain("pending");
  });

  it("gives each URL its own key under the invalidated [approvals] prefix", () => {
    const p = pendingQueueQuery().queryKey;
    const d = decidedQueueQuery().queryKey;
    expect(p[0]).toBe("approvals");
    expect(d[0]).toBe("approvals");
    expect(p).not.toEqual(d);
    // never the key an older caller used for a different URL
    expect(p).not.toEqual(["approvals", "pending"]);
  });

  it("keeps pending rows in the pending list and decided rows in the decided list", () => {
    const page: ApprovalQueuePage = { approvals: [row("a", "pending"), row("b", "approved"), row("c", "pending")] };
    expect(pendingRows(page).map((a) => a.id)).toEqual(["a", "c"]);
    expect(decidedRows(page).map((a) => a.id)).toEqual(["b"]);
    expect(pendingRows(undefined)).toEqual([]);
    expect(pendingRows({ approvals: "nope" as unknown as Approval[] })).toEqual([]);
  });

  it("counts from the server's total, never fewer than the rows shown", () => {
    expect(queueTotal({ approvals: [], total: 342 }, 100)).toBe(342);
    expect(queueTotal({ approvals: [] }, 7)).toBe(7);
    expect(queueTotal({ approvals: [], total: 2 }, 5)).toBe(5);
    expect(queueTotal(undefined, 0)).toBe(0);
  });

  it("says so when the queue holds more than the page", () => {
    expect(pendingCapNote({ approvals: [], total: 342, hasMore: true }, 100)).toBe(
      "Showing the oldest 100 of 342 pending · narrow with filters",
    );
    expect(pendingCapNote({ approvals: [], total: 3, hasMore: false }, 3)).toBeNull();
    // an older gateway with no total: no claim either way
    expect(pendingCapNote({ approvals: [] }, 3)).toBeNull();
  });
});
