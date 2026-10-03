/**
 * AER-015 — the adapter kinds the Connectors page OFFERS. Pure: the exported
 * list, no DOM. The cross-package half (this list versus the adapter union and
 * the strict egress posture) lives in the gateway's adr0121 suite, the only
 * package that can see both sides at once.
 */
import { describe, expect, it } from "vitest";
import { JSON_CREDENTIAL_FIELDS, PROVIDER_KINDS, credentialJsonHint, credentialJsonTemplate } from "./ConnectorsPage";

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

describe("ConnectorsPage — the credential card's JSON hint", () => {
  it("shows outlook's JSON shape, senderUpn and tenantId included", () => {
    const template = credentialJsonTemplate("outlook");
    expect(template).not.toBeNull();
    expect(Object.keys(JSON.parse(template!) as object)).toEqual(["appId", "appPassword", "tenantId", "senderUpn"]);
    const hint = credentialJsonHint("outlook")!;
    expect(hint).toMatch(/JSON object/);
    for (const k of ["appId", "appPassword", "tenantId", "senderUpn"]) expect(hint).toContain(k);
  });

  it("shows teams' JSON shape, naming tenantId as optional", () => {
    expect(Object.keys(JSON.parse(credentialJsonTemplate("teams")!) as object)).toEqual(["appId", "appPassword"]);
    const hint = credentialJsonHint("teams")!;
    for (const k of ["appId", "appPassword", "tenantId"]) expect(hint).toContain(k);
    expect(hint).toMatch(/optional: tenantId/);
    expect(hint).not.toContain("senderUpn");
  });

  it("stays a bare token field for every other adapter", () => {
    for (const k of PROVIDER_KINDS.filter((p) => !(p in JSON_CREDENTIAL_FIELDS))) {
      expect(credentialJsonTemplate(k), k).toBeNull();
      expect(credentialJsonHint(k), k).toBeNull();
    }
    expect(credentialJsonTemplate(undefined)).toBeNull();
    // every JSON-credential kind is one the page offers
    for (const k of Object.keys(JSON_CREDENTIAL_FIELDS)) expect(PROVIDER_KINDS).toContain(k);
  });
});
