import { describe, expect, it } from "vitest";
import { generateKeyPairSync, sign } from "node:crypto";
import { RECEIPT_GENESIS_PREV, RECEIPT_PAYLOAD_VERSION, receiptCanonicalBytes, type DecisionReceiptPayload } from "../batch4.js";
import { isReceiptBundle, receiptPayloadHash, verifyReceiptBundle, type ReceiptBundle, type ReceiptPublicKey } from "./verify.js";

function fixture(): ReceiptBundle {
  const pairs = [generateKeyPairSync("ed25519"), generateKeyPairSync("ed25519")];
  const keys = pairs.map((pair, i) => ({ keyId: `key-${i}`, jwk: pair.publicKey.export({ format: "jwk" }) as ReceiptPublicKey["jwk"] }));
  let prev = RECEIPT_GENESIS_PREV;
  const receipts = [0, 1, 1].map((key, i) => {
    const payload: DecisionReceiptPayload = { v: RECEIPT_PAYLOAD_VERSION, receiptSeq: i + 1, audit: { id: `audit-${i}`, seq: i * 3 + 1, rowHash: "1".repeat(64), contentHash: "2".repeat(64) }, decision: { at: "2026-10-07T10:00:00.000Z", userId: "actor", objectType: "mcp_tool", objectId: null, serverId: null, toolName: "fixture", effect: "allow", ruleId: "fixture-rule" }, prev, keyId: keys[key]!.keyId };
    prev = receiptPayloadHash(payload);
    return { receiptSeq: payload.receiptSeq, payload, keyId: payload.keyId, signature: sign(null, Buffer.from(receiptCanonicalBytes(payload)), pairs[key]!.privateKey).toString("base64url") };
  });
  return { verifier: RECEIPT_PAYLOAD_VERSION, receipts, keys };
}
const copy = (bundle: ReceiptBundle): ReceiptBundle => JSON.parse(JSON.stringify(bundle));

describe("ADR-0186 offline receipts", () => {
  it("verifies a complete prefix across signing-key rotation and non-receipt audit gaps", () => {
    const out = verifyReceiptBundle(fixture());
    expect(out.results.map((r) => r.status)).toEqual(["valid", "valid", "valid"]);
    expect(out.cannotProve.join(" ")).toContain("Omission after the last receipt");
    expect(out.cannotProve.join(" ")).toContain("independent pinning");
  });
  it("detects modified decisions and does not call their successors valid", () => {
    const bundle = fixture(); bundle.receipts[0]!.payload.decision.effect = "deny";
    expect(verifyReceiptBundle(bundle).results.map((r) => r.status)).toEqual(["invalid", "invalid", "unverifiable"]);
  });
  it("detects omitted interior receipts, reordering and envelope substitution", () => {
    const base = fixture();
    const gap = copy(base); gap.receipts.splice(1, 1);
    expect(verifyReceiptBundle(gap).results.map((r) => r.status)).toEqual(["valid", "invalid"]);
    const order = copy(base); order.receipts.reverse();
    expect(verifyReceiptBundle(order).results.every((r) => r.status !== "valid")).toBe(true);
    const swap = copy(base); swap.receipts[0]!.keyId = "key-1";
    expect(verifyReceiptBundle(swap).results[0]!.status).toBe("invalid");
  });
  it("reports a bounded suffix or missing public key as unverifiable", () => {
    const suffix = fixture(); suffix.receipts.shift();
    expect(verifyReceiptBundle(suffix).results.map((r) => r.status)).toEqual(["unverifiable", "unverifiable"]);
    const missing = fixture(); missing.keys.shift();
    expect(verifyReceiptBundle(missing).results.every((r) => r.status === "unverifiable")).toBe(true);
  });
  it("rejects conflicting duplicate key IDs and public-key substitution", () => {
    const duplicate = fixture(); duplicate.keys.push(duplicate.keys[0]!);
    expect(verifyReceiptBundle(duplicate).results[0]!.status).toBe("invalid");
    const substituted = fixture(); substituted.keys[0]!.jwk = substituted.keys[1]!.jwk;
    expect(verifyReceiptBundle(substituted).results[0]!.status).toBe("invalid");
  });
  it("never accepts private JWKs, added free text, unsafe positions or malformed dates", () => {
    for (const mutate of [
      (b: any) => { b.keys[0].jwk.d = "private"; },
      (b: any) => { b.receipts[0].payload.decision.reason = "excluded text"; },
      (b: any) => { b.receipts[0].payload.receiptSeq = Number.MAX_SAFE_INTEGER + 1; },
      (b: any) => { b.receipts[0].payload.decision.at = "invalid"; },
    ]) { const b = fixture(); mutate(b); expect(isReceiptBundle(b)).toBe(false); expect(verifyReceiptBundle(b).results[0]!.status).toBe("invalid"); }
    expect(verifyReceiptBundle(null).results[0]!.status).toBe("invalid");
    expect(verifyReceiptBundle({}).results[0]!.status).toBe("invalid");
  });
  it("cannot detect deletion after the last included receipt and explicitly says so", () => {
    const bundle = fixture(); bundle.receipts.pop();
    expect(verifyReceiptBundle(bundle).results.every((r) => r.status === "valid")).toBe(true);
    expect(verifyReceiptBundle(bundle).cannotProve[0]).toContain("after the last receipt");
  });
});
