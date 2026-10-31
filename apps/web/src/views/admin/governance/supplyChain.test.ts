import { describe, expect, it } from "vitest";
import { parseBundle, relaxationExpiry, signatureText, supplyChainBadge, type SupplyChainState } from "./supplyChain";

const state = (over: Partial<SupplyChainState["assessment"]>, relaxation: SupplyChainState["relaxation"] = null): SupplyChainState => ({
  assessment: { failing: [], uncovered: [], passes: true, relaxed: false, relaxationExpired: false, ...over },
  signature: { status: "none", failure: null, failureLabel: null, keyName: null, signedName: null, presentedAt: null, createdAt: null },
  relaxation,
});

describe("ADR-0216 supply-chain wording", () => {
  it("never reads as passing unless the gateway said so", () => {
    expect(supplyChainBadge(undefined)).toEqual({ tone: "neutral", label: "Not checked" });
    expect(supplyChainBadge({} as SupplyChainState).label).toBe("Not checked");
    expect(supplyChainBadge(state({ failing: ["unsigned"], uncovered: ["unsigned"], passes: false }))).toEqual({ tone: "danger", label: "Blocked" });
    expect(supplyChainBadge(state({})).label).toBe("Passes");
    const relaxed = state({ failing: ["unsigned"], relaxed: true }, { id: "r", conditions: ["unsigned"], reason: "x", expiresAt: "2026-11-06T00:00:00Z", expired: false, createdAt: "2026-10-30T00:00:00Z" });
    expect(supplyChainBadge(relaxed).tone).toBe("warn");
  });

  it("names a failed signature by the gateway's reason", () => {
    expect(signatureText({ ...state({}).signature, status: "failed", failureLabel: "Signed by a signing key that has been revoked" })).toBe("Not verified: Signed by a signing key that has been revoked");
    expect(signatureText({ ...state({}).signature, status: "verified", keyName: "release" })).toBe("Verified against release");
  });

  it("caps a relaxation at 30 days and refuses a past or malformed day", () => {
    const now = new Date("2026-10-30T12:00:00Z");
    expect(relaxationExpiry("2026-11-05", now)).toBe("2026-11-05T23:59:59.000Z");
    expect(relaxationExpiry("2027-01-30", now)).toBe("2026-11-29T12:00:00.000Z");
    expect(relaxationExpiry("2026-10-01", now)).toBeNull();
    expect(relaxationExpiry("tomorrow", now)).toBeNull();
    expect(parseBundle("[1]")).toBeNull();
    expect(parseBundle('{"mediaType":"x"}')).toEqual({ mediaType: "x" });
  });
});
