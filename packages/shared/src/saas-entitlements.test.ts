/**
 * ADR-0337: the entitlement batch check (the worker refuses anything it does not accept) and the frozen V1 scope
 * classifier (pinned: a change to a rule is a new version, never an in-place edit).
 */
import { describe, expect, it } from "vitest";
import {
  DISCOVERY_KIND_SPECS,
  DISCOVERY_SOURCE_KINDS,
  SAAS_ENTITLEMENT_PLATFORMS,
  SAAS_ENTITLEMENT_SOURCE_PLATFORM,
  SAAS_APP_AGENT_LINK_MACHINE,
  SAAS_SCOPE_RULES_V1,
  STATE_MACHINES,
  AGENT_VENDOR_IDENTIFIER_PATTERN,
  SaasEntitlementBatchRefused,
  checkSaasEntitlementBatch,
  classifySaasScope,
  entitlementPlatformOf,
  federationUnsupportedReason,
  publicConfigProblem,
} from "./index.js";

const PSN = "psn:0123456789abcdef01234567";
const PSN2 = "psn:fedcba9876543210fedcba98";
const app = (over: Record<string, unknown> = {}) => ({
  externalId: "client-1",
  appKind: "oauth_client",
  displayName: "Agent",
  publisher: null,
  publisherVerified: null,
  grants: [{ resource: "", scope: "openid", grantType: "delegated", consent: "user", principals: [PSN] }],
  ...over,
});
const batch = (over: Record<string, unknown> = {}) => ({ platform: "slack", tenant: "T123", complete: true, apps: [app()], ...over });

describe("ADR-0337 vocabulary", () => {
  it("every entitlement kind is a discovery kind in the identity family that returns a batch, and maps to one platform", () => {
    const kinds = DISCOVERY_SOURCE_KINDS.filter((k) => DISCOVERY_KIND_SPECS[k].entitlements === true);
    expect(kinds.sort()).toEqual(Object.keys(SAAS_ENTITLEMENT_SOURCE_PLATFORM).sort());
    for (const k of kinds) {
      expect(DISCOVERY_KIND_SPECS[k].family).toBe("identity");
      expect(DISCOVERY_KIND_SPECS[k].evidenceKinds).toEqual([]);
      expect(SAAS_ENTITLEMENT_PLATFORMS).toContain(entitlementPlatformOf(k));
    }
    expect(entitlementPlatformOf("idp_entra")).toBeNull();
    expect(new Set(Object.values(SAAS_ENTITLEMENT_SOURCE_PLATFORM)).size).toBe(SAAS_ENTITLEMENT_PLATFORMS.length);
  });

  it("credentials: M365 federated by default with tenant and client; Google static with an admin subject only", () => {
    expect(federationUnsupportedReason("entitlement_m365")).toBeNull();
    expect(federationUnsupportedReason("entitlement_google_workspace")).toMatch(/static/);
    expect(publicConfigProblem("entitlement_m365", "federated", { tenantId: "00000000-0000-4000-8000-000000000001", clientId: "00000000-0000-4000-8000-000000000002" })).toBeNull();
    expect(publicConfigProblem("entitlement_google_workspace", "static", { adminSubject: "admin@acme.example" })).toBeNull();
    expect(publicConfigProblem("entitlement_google_workspace", "static", { adminSubject: "not an email" })).toMatch(/email/);
    expect(publicConfigProblem("entitlement_google_workspace", "static", {})).toMatch(/required/);
    expect(publicConfigProblem("entitlement_salesforce", "static", { clientId: "3MVG9consumerKeyForTests_000", username: "integration@acme.example" })).toBeNull();
    expect(publicConfigProblem("entitlement_salesforce", "static", { clientId: "short", username: "integration@acme.example" })).toMatch(/salesforce_consumer_key/);
    expect(publicConfigProblem("entitlement_salesforce", "federated", {})).toMatch(/OIDC/);
    expect(publicConfigProblem("entitlement_slack", "static", {})).toBeNull();
    expect(publicConfigProblem("entitlement_slack", "static", { token: "xoxp-1" })).toMatch(/not a public config field/);
    // a key never goes in public config
    expect(publicConfigProblem("entitlement_google_workspace", "static", { adminSubject: "a@b.example", private_key: "x" })).toMatch(/not a public config field/);
  });
});

describe("ADR-0337 checkSaasEntitlementBatch", () => {
  it("accepts a well-formed batch and merges duplicate grants (a tenant consent wins and names nobody)", () => {
    const b = checkSaasEntitlementBatch(
      batch({
        apps: [
          app({
            grants: [
              { resource: "", scope: "chat:write", grantType: "delegated", consent: "user", principals: [PSN] },
              { resource: "", scope: "chat:write", grantType: "delegated", consent: "user", principals: [PSN2, PSN] },
              { resource: "", scope: "files:read", grantType: "delegated", consent: "user", principals: [PSN] },
              { resource: "", scope: "files:read", grantType: "delegated", consent: "tenant", principals: [] },
            ],
          }),
        ],
      }),
      "slack",
    );
    expect(b.apps[0]!.grants).toEqual([
      { resource: "", scope: "chat:write", grantType: "delegated", consent: "user", principals: [PSN, PSN2] },
      { resource: "", scope: "files:read", grantType: "delegated", consent: "tenant", principals: [] },
    ]);
    expect(b.revokedPrincipals).toEqual([]);
  });

  it.each([
    ["another platform", batch({ platform: "m365" })],
    ["no tenant", batch({ tenant: "" })],
    ["no completeness flag", batch({ complete: undefined })],
    ["a duplicate app", batch({ apps: [app(), app()] })],
    ["an unknown app kind", batch({ apps: [app({ appKind: "robot" })] })],
    ["a raw person", batch({ apps: [app({ grants: [{ resource: "", scope: "openid", grantType: "delegated", consent: "user", principals: ["alice@acme.example"] }] })] })],
    ["a named tenant consent", batch({ apps: [app({ grants: [{ resource: "", scope: "openid", grantType: "delegated", consent: "tenant", principals: [PSN] }] })] })],
    ["an unknown grant type", batch({ apps: [app({ grants: [{ resource: "", scope: "openid", grantType: "owner", consent: "user", principals: [] }] })] })],
    ["a control character in a scope", batch({ apps: [app({ grants: [{ resource: "", scope: "a\nb", grantType: "delegated", consent: "user", principals: [] }] })] })],
    ["a raw revoker", batch({ revokedPrincipals: [{ externalId: "client-1", principal: "bob" }] })],
    ["too many apps", batch({ apps: Array.from({ length: 5001 }, (_, i) => app({ externalId: `c${i}` })) })],
  ])("refuses %s", (_label, b) => {
    expect(() => checkSaasEntitlementBatch(b, "slack")).toThrow(SaasEntitlementBatchRefused);
  });

  it("app ids are exact (case-sensitive vendor ids are two different apps)", () => {
    const b = checkSaasEntitlementBatch(batch({ apps: [app({ externalId: "0Ha5g000000AbCd" }), app({ externalId: "0Ha5g000000abcd" })] }), "slack");
    expect(b.apps).toHaveLength(2);
  });
});

describe("ADR-0337 scope classifier V1 (frozen)", () => {
  it("is frozen", () => {
    expect(Object.isFrozen(SAAS_SCOPE_RULES_V1)).toBe(true);
    for (const rules of Object.values(SAAS_SCOPE_RULES_V1)) {
      expect(Object.isFrozen(rules)).toBe(true);
      for (const r of rules) expect(Object.isFrozen(r)).toBe(true);
    }
  });

  it.each([
    ["m365", "User.Read", "read"],
    ["m365", "User.ReadBasic.All", "read"],
    ["m365", "Mail.Read.Shared", "read"],
    ["m365", "offline_access", "read"],
    ["m365", "Mail.Send", "write"],
    ["m365", "Files.ReadWrite.All", "write"],
    ["m365", "Sites.FullControl.All", "admin"],
    ["m365", "EWS.AccessAsUser.All", "admin"],
    ["m365", "Directory.ReadWrite.All", "admin"],
    ["m365", "AppRoleAssignment.ReadWrite.All", "admin"],
    ["m365", "full_access_as_app", "admin"],
    ["m365", "Something.Odd", "unknown"],
    ["google_workspace", "https://www.googleapis.com/auth/drive.readonly", "read"],
    ["google_workspace", "https://www.googleapis.com/auth/gmail.metadata", "read"],
    ["google_workspace", "https://www.googleapis.com/auth/admin.reports.audit.readonly", "read"],
    ["google_workspace", "openid", "read"],
    ["google_workspace", "https://www.googleapis.com/auth/drive", "write"],
    ["google_workspace", "https://www.googleapis.com/auth/gmail.send", "write"],
    ["google_workspace", "https://mail.google.com/", "admin"],
    ["google_workspace", "https://www.googleapis.com/auth/admin.directory.user", "admin"],
    ["google_workspace", "https://www.googleapis.com/auth/cloud-platform", "admin"],
    ["google_workspace", "https://evil.example/auth/drive", "unknown"],
    ["salesforce", "id", "read"],
    ["salesforce", "refresh_token", "read"],
    ["salesforce", "api", "write"],
    ["salesforce", "full", "admin"],
    ["slack", "channels:read", "read"],
    ["slack", "channels:history", "read"],
    ["slack", "users:read.email", "read"],
    ["slack", "chat:write", "write"],
    ["slack", "chat:write.public", "write"],
    ["slack", "admin.conversations:write", "admin"],
    ["slack", "admin", "admin"],
    ["slack", "client", "write"],
    ["slack", "weird", "unknown"],
  ] as const)("%s %s is %s", (platform, scope, access) => {
    const c = classifySaasScope(platform, scope);
    expect(c.access).toBe(access);
    expect(c.reason.length).toBeGreaterThan(5);
  });

  it("an over-long name is unknown, never matched", () => {
    expect(classifySaasScope("slack", `${"a".repeat(600)}:read`).access).toBe("unknown");
  });
});

describe("ADR-0337 §6 agent link machine (owner decision 2026-11-17)", () => {
  const m = SAAS_APP_AGENT_LINK_MACHINE;
  it("is declared and listed with the other machines", () => {
    expect(STATE_MACHINES[m.def.id]).toBe(m);
    expect(m.def.stored).toBe("saas_entitlement_apps.agent_link_state");
  });
  it("auto-links only an app nobody linked or unlinked; an admin may link from anywhere and unlink a link", () => {
    expect(m.sourcesOf("auto_link")).toEqual(["none"]);
    expect(m.can("unlinked", "auto_link")).toBe(false);
    expect(m.can("admin", "auto_link")).toBe(false);
    for (const s of m.def.states) expect(m.can(s, "link")).toBe(true);
    expect(m.can("none", "unlink")).toBe(false);
    expect(m.next("auto", "unlink")).toBe("unlinked");
    expect(m.describe("unlinked").transitions.find((t) => t.event === "auto_link")!.allowed).toBe(false);
  });
  it("an identifier is printable, no spaces, at most 255 characters (compared exactly)", () => {
    expect(AGENT_VENDOR_IDENTIFIER_PATTERN.test("1234-abc.apps.googleusercontent.com")).toBe(true);
    expect(AGENT_VENDOR_IDENTIFIER_PATTERN.test("has space")).toBe(false);
    expect(AGENT_VENDOR_IDENTIFIER_PATTERN.test("x".repeat(256))).toBe(false);
  });
});
