import { describe, expect, it } from "vitest";
import { nextFromSeq, parseFromSeq, receiptRow, type ReceiptEnvelope } from "./receiptsModel";

const AUDIT = "11111111-1111-4111-8111-111111111111";
const env = (seq: number, payload: unknown = {}): ReceiptEnvelope => ({ receiptSeq: seq, payload, signature: "sig", keyId: "k1" });

describe("receiptRow", () => {
  it("flattens a v1 envelope", () => {
    const row = receiptRow(
      env(7, {
        v: 1,
        receiptSeq: 7,
        audit: { id: AUDIT, seq: 42, rowHash: "r", contentHash: "c" },
        decision: { at: "2026-10-12T10:00:00.000Z", userId: "u", objectType: "agent", objectId: "a", serverId: null, toolName: null, effect: "deny", ruleId: "default-deny" },
        prev: "abc",
        keyId: "k1",
      }),
    );
    expect(row).toMatchObject({ receiptSeq: 7, version: 1, auditId: AUDIT, auditSeq: 42, effect: "deny", ruleId: "default-deny", prev: "abc", toolName: null });
  });

  it("shows a hashed (oversized) tool name or rule as its hash, never as missing", () => {
    const row = receiptRow(env(1, { v: 2, audit: {}, decision: { toolNameHash: "ff", ruleIdHash: "ee" } }));
    expect(row.toolName).toBe("sha256:ff");
    expect(row.ruleId).toBe("sha256:ee");
  });

  it("reports what a malformed payload does not say as missing", () => {
    const row = receiptRow(env(3, "not an object"));
    expect(row).toMatchObject({ version: null, auditId: null, at: null, effect: null });
  });
});

describe("paging", () => {
  it("starts the next page one past the last receipt of a full page", () => {
    expect(nextFromSeq([env(5), env(6)], 2)).toBe(7);
  });
  it("has no next page after a short page", () => {
    expect(nextFromSeq([env(5)], 2)).toBeNull();
    expect(nextFromSeq([], 25)).toBeNull();
  });
  it("accepts only a positive integer first sequence", () => {
    expect(parseFromSeq(" 12 ")).toBe(12);
    for (const bad of ["0", "-1", "1.5", "", "abc", "99999999999999999"]) expect(parseFromSeq(bad)).toBeNull();
  });
});
