/**
 * ADR-0337 §5 (slice 3): the usage block of an entitlement batch, the Google method classifier and the frozen V1
 * finding rules (pinned: a change to a rule is a new version, never an in-place edit).
 */
import { describe, expect, it } from "vitest";
import {
  SAAS_FINDING_RULES_V1,
  SAAS_FINDING_RULE_IDS,
  SaasEntitlementBatchRefused,
  checkSaasEntitlementBatch,
  classifyGoogleApiMethod,
  copilotStudioExposure,
  parseSaasFindingWindowDays,
  renderRecommendationRationale,
  saasFindingRuleById,
} from "./index.js";

const batch = (usage: unknown) => ({
  platform: "google_workspace",
  tenant: "C01",
  complete: false,
  apps: [{ externalId: "client-1", appKind: "oauth_client", displayName: "Agent", publisher: null, publisherVerified: null, grants: [] }],
  usage,
});
const T1 = "2026-11-01T10:00:00Z";
const T2 = "2026-11-10T10:00:00.000Z";

describe("the usage block of a batch", () => {
  it("is optional, and kept when valid", () => {
    expect(checkSaasEntitlementBatch(batch(undefined), "google_workspace").usage).toBeUndefined();
    const u = checkSaasEntitlementBatch(batch({ coverage: "verb", windowStart: T1, note: "token activity events", apps: [{ externalId: "client-1", lastUseAt: "ignored", lastReadAt: T1, lastWriteAt: T2 }] }), "google_workspace").usage!;
    // under coverage verb the last use IS the later of read and write, whatever the reader said
    expect(u.apps).toEqual([{ externalId: "client-1", lastUseAt: T2, lastReadAt: T1, lastWriteAt: T2 }]);
  });

  it("merges duplicate entries to the latest times", () => {
    const u = checkSaasEntitlementBatch(
      batch({ coverage: "app", windowStart: null, note: "sign-ins", apps: [{ externalId: "a", lastUseAt: T2, lastReadAt: null, lastWriteAt: null }, { externalId: "a", lastUseAt: T1, lastReadAt: null, lastWriteAt: null }] }),
      "google_workspace",
    ).usage!;
    expect(u.apps).toEqual([{ externalId: "a", lastUseAt: T2, lastReadAt: null, lastWriteAt: null }]);
  });

  it.each([
    ["an unknown coverage", { coverage: "scope", windowStart: null, note: "x", apps: [] }],
    ["no note", { coverage: "none", windowStart: null, note: null, apps: [] }],
    ["use listed under coverage none", { coverage: "none", windowStart: null, note: "x", apps: [{ externalId: "a", lastUseAt: T1, lastReadAt: null, lastWriteAt: null }] }],
    ["a read/write split under coverage app", { coverage: "app", windowStart: null, note: "x", apps: [{ externalId: "a", lastUseAt: T1, lastReadAt: T1, lastWriteAt: null }] }],
    ["a time that is not ISO 8601", { coverage: "app", windowStart: null, note: "x", apps: [{ externalId: "a", lastUseAt: "yesterday", lastReadAt: null, lastWriteAt: null }] }],
    ["a time far in the future", { coverage: "app", windowStart: null, note: "x", apps: [{ externalId: "a", lastUseAt: "2999-01-01T00:00:00Z", lastReadAt: null, lastWriteAt: null }] }],
    ["a bad window start", { coverage: "app", windowStart: "soon", note: "x", apps: [] }],
    ["verb coverage with neither read nor write", { coverage: "verb", windowStart: T1, note: "x", apps: [{ externalId: "a", lastUseAt: T1, lastReadAt: null, lastWriteAt: null }] }],
  ])("refuses %s", (_, usage) => {
    expect(() => checkSaasEntitlementBatch(batch(usage), "google_workspace")).toThrow(SaasEntitlementBatchRefused);
  });
});

describe("classifyGoogleApiMethod (frozen with V1)", () => {
  it.each([
    ["gmail.users.messages.get", "read"],
    ["drive.files.list", "read"],
    ["drive.files.export", "read"],
    ["gmail.users.getProfile", "read"],
    ["sheets.spreadsheets.values.batchGet", "read"],
    ["gmail.users.messages.send", "write"],
    ["drive.files.delete", "write"],
    ["calendar.events.watch", "write"],
    ["drive.files.getaway", "write"],
    ["something.unfamiliar", "write"],
    ["", "write"],
  ])("%s is a %s", (method, cls) => expect(classifyGoogleApiMethod(method)).toBe(cls));
});

describe("the V1 finding rules", () => {
  it("are pinned: ids, severities, frozen", () => {
    expect(SAAS_FINDING_RULES_V1.map((r) => [r.id, r.severity])).toEqual([
      ["unused-grant", "review-suggested"],
      ["excessive-scope", "review-suggested"],
      ["oversharing", "review-suggested"],
      ["publicly-exposed-agent", "review-suggested"],
    ]);
    expect(SAAS_FINDING_RULES_V1.map((r) => r.id)).toEqual([...SAAS_FINDING_RULE_IDS]);
    expect(Object.isFrozen(SAAS_FINDING_RULES_V1) && SAAS_FINDING_RULES_V1.every(Object.isFrozen)).toBe(true);
    // a class, never a score: no numeric field anywhere on a rule
    for (const r of SAAS_FINDING_RULES_V1) for (const v of Object.values(r)) expect(typeof v).not.toBe("number");
  });

  it("render strictly: a missing evidence value throws", () => {
    const rule = saasFindingRuleById("oversharing")!;
    expect(renderRecommendationRationale(rule, { app: "A", scope: "s", access: "write", reason: "r", source: "S", publisher: "unverified" })).toContain("every user of S");
    expect(() => renderRecommendationRationale(rule, { app: "A" })).toThrow(/missing evidence value/);
    expect(saasFindingRuleById("nope")).toBeNull();
  });

  it("take the window as a bounded integer parameter", () => {
    expect(parseSaasFindingWindowDays(undefined)).toBe(90);
    expect(parseSaasFindingWindowDays("30")).toBe(30);
    for (const bad of ["6", "366", "1e2", "-9", "30.5", "abc"]) expect(parseSaasFindingWindowDays(bad)).toBeNull();
  });
});

describe("copilotStudioExposure", () => {
  it("names an unauthenticated or any-tenant published agent, and nothing else", () => {
    expect(copilotStudioExposure({ publishedOn: T1, authenticationMode: "none" })?.exposure).toBe("no authentication");
    expect(copilotStudioExposure({ publishedOn: T1, authenticationMode: "integrated", accessControlPolicy: "any_multi_tenant" })?.exposure).toMatch(/multi-tenant/);
    expect(copilotStudioExposure({ publishedOn: T1, authenticationMode: "integrated", accessControlPolicy: "any" })).toBeNull();
    // not published: nobody reaches it yet
    expect(copilotStudioExposure({ publishedOn: null, authenticationMode: "none" })).toBeNull();
  });
});
