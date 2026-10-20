import { describe, expect, it } from "vitest";
import { anchorsStatus, receiptsStatus, retentionStatus } from "./auditEvidenceStatus";

const q = <T,>(data: T, extra: Partial<{ isError: boolean; isLoading: boolean }> = {}) => ({ data, isError: false, isLoading: false, ...extra });

describe("folded audit evidence never hides a warning (G8 f)", () => {
  it("receipts: every unsigned state is a warning, and an unreadable state is never good news", () => {
    expect(receiptsStatus(q({ state: "signing" }))).toEqual({ label: "Signing configured", tone: "ok" });
    expect(receiptsStatus(q({ state: "no_key" })).tone).toBe("warn");
    expect(receiptsStatus(q({ state: "off" })).tone).toBe("warn");
    expect(receiptsStatus(q({ state: "stalled" })).tone).toBe("danger");
    expect(receiptsStatus(q({ state: "something-new" }))).toEqual({ label: "State not reported", tone: "warn" });
    expect(receiptsStatus(q(undefined, { isError: true })).tone).toBe("warn");
  });
  it("anchors: any anchor without a verified timestamp is counted, failures first", () => {
    expect(anchorsStatus(q({ anchors: [] })).label).toBe("No anchors yet");
    expect(anchorsStatus(q({ anchors: [{ timestamp: { status: "granted", verified: true } }, { timestamp: { status: "not_configured", verified: false } }] }))).toEqual({ label: "1 of 2 not timestamped", tone: "warn" });
    expect(anchorsStatus(q({ anchors: [{ timestamp: { status: "granted", verified: false } }] })).tone).toBe("warn");
    expect(anchorsStatus(q({ anchors: [{ timestamp: { status: "failed", verified: false } }] })).tone).toBe("danger");
    expect(anchorsStatus(q({ anchors: [{ timestamp: { status: "granted", verified: true } }] })).tone).toBe("ok");
    // L5: a failed write-out is danger with its own wording, alongside any timestamp failure
    expect(anchorsStatus(q({ anchors: [{ status: "failed", timestamp: { status: "pending", verified: false } }] }))).toEqual({ label: "1 anchor failed to write out", tone: "danger" });
    expect(anchorsStatus(q({ anchors: [
      { status: "failed", timestamp: { status: "pending", verified: false } },
      { status: "failed", timestamp: { status: "pending", verified: false } },
      { status: "flushed", timestamp: { status: "failed", verified: false } },
    ] }))).toEqual({ label: "2 anchors failed to write out · 1 timestamp failed", tone: "danger" });
    expect(anchorsStatus(q({} as { anchors?: [] })).label).toBe("State not reported");
  });
  it("retention says when nothing is set and how many rows a prune would remove", () => {
    expect(retentionStatus({ retainedDays: null, prunable: 0 }).label).toBe("No retention set: all rows kept");
    expect(retentionStatus({ retainedDays: 365, prunable: 12 }).label).toBe("365-day floor · 12 rows prunable");
    expect(retentionStatus(undefined, true).label).toBe("State not reported");
  });
});
