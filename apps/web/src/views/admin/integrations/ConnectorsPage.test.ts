/**
 * AER-015 — the adapter kinds the Connectors page OFFERS. Pure: the exported
 * list, no DOM. The cross-package half (this list versus the adapter union and
 * the strict egress posture) lives in the gateway's adr0121 suite, the only
 * package that can see both sides at once.
 */
import { describe, expect, it } from "vitest";
import {
  JSON_CREDENTIAL_FIELDS,
  PROVIDER_KINDS,
  credentialBaseUrlChoice,
  credentialJsonHint,
  credentialJsonTemplate,
  noCredentialStatus,
} from "./ConnectorsPage";

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

describe("ConnectorsPage — credential base URL and no-credential copy (INT-003, INT-004)", () => {
  it("a rotation that leaves the prefilled override alone sends it back, so the override is kept", () => {
    expect(credentialBaseUrlChoice("https://eu.example.test", "https://eu.example.test", false)).toEqual({
      baseUrl: "https://eu.example.test",
    });
  });
  it("clearing the override is an explicit choice that omits baseUrl", () => {
    expect(credentialBaseUrlChoice("https://eu.example.test", "https://eu.example.test", true)).toEqual({});
  });
  it("an emptied field with an override stored is refused, never a silent clear", () => {
    expect(credentialBaseUrlChoice("https://eu.example.test", "  ", false)).toHaveProperty("error");
  });
  it("with no override stored, an empty field sends nothing and a typed one is trimmed", () => {
    expect(credentialBaseUrlChoice(null, "", false)).toEqual({});
    expect(credentialBaseUrlChoice(null, " https://x.example.test ", false)).toEqual({ baseUrl: "https://x.example.test" });
  });
  it("keyless kinds do not warn that invokes will fail; credentialed kinds do", () => {
    for (const k of [null, "", "mock", "http", "generic", "webhook"]) {
      expect(noCredentialStatus(k).tone).not.toBe("warn");
      expect(noCredentialStatus(k).text).not.toMatch(/will fail/);
    }
    for (const k of ["github", "slack", "snowflake", "piece_jira_cloud"]) expect(noCredentialStatus(k).tone).toBe("warn");
  });
});
