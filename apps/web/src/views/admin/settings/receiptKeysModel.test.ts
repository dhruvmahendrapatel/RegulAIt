import { describe, expect, it } from "vitest";
import { ApiError } from "../../../api/client";
import { parseReceiptKeys, receiptKeyRefusal, retireGate, type RecordedReceiptKey } from "./receiptKeysModel";

const key = (keyId: string, retiredAt: string | null = null): RecordedReceiptKey => ({ keyId, firstUsedAt: "2026-10-01T00:00:00.000Z", retiredAt });

describe("parseReceiptKeys", () => {
  it("reads the gateway's key list, public fields only", () => {
    const raw = { keys: [{ keyId: "op-1", jwk: { kty: "OKP", crv: "Ed25519", x: "x" }, firstUsedAt: "2026-10-01T00:00:00.000Z", retiredAt: null }] };
    expect(parseReceiptKeys(raw)).toEqual([{ keyId: "op-1", firstUsedAt: "2026-10-01T00:00:00.000Z", retiredAt: null }]);
    expect(parseReceiptKeys({ keys: [] })).toEqual([]);
  });
  it("is null for anything that is not a key list, never a guessed empty list", () => {
    for (const raw of [undefined, null, {}, { keys: "op-1" }, { keys: [{}] }, { keys: [{ keyId: "" }] }]) expect(parseReceiptKeys(raw)).toBeNull();
  });
});

describe("retireGate", () => {
  const keys = [key("old"), key("new"), key("gone", "2026-10-02T00:00:00.000Z")];
  it("offers retire for an active key that is not in use while another is active", () => {
    expect(retireGate(keys[0]!, keys, "new")).toEqual({ ok: true });
    expect(retireGate(keys[0]!, keys, null)).toEqual({ ok: true });
  });
  it("refuses the key this gateway signs with", () => {
    expect(retireGate(keys[1]!, keys, "new")).toMatchObject({ ok: false, reason: expect.stringContaining("signs with this key") });
  });
  it("refuses the only active key even when it is not in use", () => {
    const lone = [key("only"), key("gone", "2026-10-02T00:00:00.000Z")];
    expect(retireGate(lone[0]!, lone, null)).toMatchObject({ ok: false, reason: expect.stringContaining("only active key") });
  });
  it("a retired key is already retired", () => {
    expect(retireGate(keys[2]!, keys, "new")).toEqual({ ok: false, reason: "Already retired." });
  });
});

describe("receiptKeyRefusal", () => {
  it("names the gateway's refusals, and leaves anything else to the client", () => {
    expect(receiptKeyRefusal(new ApiError(409, { error: "receipt_key_only_active" }))).toContain("only active key");
    expect(receiptKeyRefusal(new ApiError(409, { error: "receipt_key_in_use" }))).toContain("signs with that key");
    expect(receiptKeyRefusal(new ApiError(409, { error: "something_else" }))).toBeNull();
    expect(receiptKeyRefusal(new Error("x"))).toBeNull();
  });
});
