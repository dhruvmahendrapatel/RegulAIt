/**
 * AER-015 — the adapter kinds the Connectors page OFFERS. Pure: the exported
 * list, no DOM. The cross-package half (this list versus the adapter union and
 * the strict egress posture) lives in the gateway's adr0121 suite, the only
 * package that can see both sides at once.
 */
import { describe, expect, it } from "vitest";
import { PROVIDER_KINDS } from "./ConnectorsPage";

describe("ConnectorsPage — the providerKind options", () => {
  it("offers governance-only first, then every execution adapter exactly once", () => {
    expect(PROVIDER_KINDS[0]).toBe("");
    const kinds = PROVIDER_KINDS.slice(1);
    expect(kinds.length).toBeGreaterThan(0);
    expect(kinds.every((k) => k.trim().length > 0)).toBe(true);
    expect(new Set(kinds).size).toBe(kinds.length);
  });

  it("offers the two Microsoft couriers the create-connector schema already accepted", () => {
    // the defect: both adapters shipped, both were accepted by POST /v1/connectors,
    // and neither could be picked in the product
    expect(PROVIDER_KINDS).toContain("teams");
    expect(PROVIDER_KINDS).toContain("outlook");
  });
});
