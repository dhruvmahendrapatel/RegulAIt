import { describe, expect, it } from "vitest";
import type { AbacPolicyVersion } from "../../../api/adminTypes";
import {
  ABAC_LIMITS,
  EMPTY_SIMULATE_FORM,
  simulateBody,
  simulationSentence,
  validationErrorsOf,
  versionBody,
  versionFormFrom,
  type VersionForm,
} from "./abacModel";

const version = (n: number, over: Partial<AbacPolicyVersion> = {}): AbacPolicyVersion => ({
  id: `v${n}`,
  policyId: "p",
  version: n,
  source: `forbid (principal, action, resource); // v${n}`,
  schemaVersion: "v3",
  mode: "forbid",
  timezone: "UTC",
  approverUserId: null,
  testCases: null,
  authorUserId: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  ...over,
});

const form = (over: Partial<VersionForm> = {}): VersionForm => ({
  source: "forbid (principal, action, resource);",
  mode: "forbid",
  timezone: "UTC",
  approverUserId: "",
  testCases: "",
  ...over,
});

describe("ABAC new-version form", () => {
  it("opens on the newest version, whatever order the versions arrive in", () => {
    const f = versionFormFrom([version(1), version(3, { timezone: "Europe/London", testCases: [{ name: "t" }] }), version(2)]);
    expect(f.source).toContain("v3");
    expect(f.timezone).toBe("Europe/London");
    expect(JSON.parse(f.testCases)).toEqual([{ name: "t" }]);
  });

  it("builds exactly the body the versions route accepts, with no approver on a deny version", () => {
    const built = versionBody(form({ approverUserId: "u1" }));
    expect(built).toEqual({ ok: true, body: { source: "forbid (principal, action, resource);", mode: "forbid", timezone: "UTC", approverUserId: null } });
  });

  it("requires an approver for a pause-for-approval version", () => {
    expect(versionBody(form({ mode: "require_approval" }))).toMatchObject({ ok: false });
    expect(versionBody(form({ mode: "require_approval", approverUserId: "u1" }))).toMatchObject({
      ok: true,
      body: { mode: "require_approval", approverUserId: "u1" },
    });
  });

  it("refuses an empty policy, an empty timezone and an over-long source before sending", () => {
    expect(versionBody(form({ source: "   " }))).toMatchObject({ ok: false });
    expect(versionBody(form({ timezone: "" }))).toMatchObject({ ok: false });
    expect(versionBody(form({ source: "x".repeat(ABAC_LIMITS.sourceMax + 1) }))).toMatchObject({ ok: false });
  });

  it("parses stored test cases as a JSON array of objects, and says what is wrong otherwise", () => {
    const ok = versionBody(form({ testCases: '[{"name":"a","principal":{},"resource":{"toolName":"t","kind":"read"},"expect":"no_match"}]' }));
    expect(ok.ok && ok.body.testCases).toHaveLength(1);
    expect(versionBody(form({ testCases: "{" }))).toEqual({ ok: false, problem: expect.stringContaining("not valid JSON") });
    expect(versionBody(form({ testCases: '{"name":"a"}' }))).toEqual({ ok: false, problem: expect.stringContaining("array") });
    expect(versionBody(form({ testCases: "[1]" }))).toEqual({ ok: false, problem: "Test case 1 is not an object." });
    const many = JSON.stringify(Array.from({ length: ABAC_LIMITS.testCasesMax + 1 }, () => ({})));
    expect(versionBody(form({ testCases: many }))).toMatchObject({ ok: false });
  });
});

describe("ABAC simulate form", () => {
  it("needs a user, a server and a tool", () => {
    expect(simulateBody(EMPTY_SIMULATE_FORM)).toMatchObject({ ok: false });
    expect(simulateBody({ ...EMPTY_SIMULATE_FORM, userId: "u", serverId: "s" })).toMatchObject({ ok: false });
  });

  it("sends only what was stated, with the hypothetical time as an ISO instant", () => {
    const base = { ...EMPTY_SIMULATE_FORM, userId: "u", serverId: "s", toolName: "write_record" };
    expect(simulateBody(base)).toEqual({ ok: true, body: { userId: "u", serverId: "s", toolName: "write_record" } });
    const full = simulateBody({ ...base, projectId: "p", at: "2026-10-12T23:00", sessionOrigin: " web ", mfa: "no" });
    expect(full).toEqual({
      ok: true,
      body: {
        userId: "u",
        serverId: "s",
        toolName: "write_record",
        projectId: "p",
        at: new Date("2026-10-12T23:00").toISOString(),
        sessionOrigin: "web",
        mfaCompleted: false,
      },
    });
    expect(simulateBody({ ...base, at: "not a date" })).toMatchObject({ ok: false });
  });

  it("never reads a permit as an allow", () => {
    const sim = { attributes: {}, activePolicies: [], note: "" };
    expect(simulationSentence({ ...sim, abacDecision: null })).toContain("entitlement model alone");
    expect(simulationSentence({ ...sim, abacDecision: { effect: "permit" } })).toContain("That is not an allow");
    expect(simulationSentence({ ...sim, abacDecision: { effect: "forbid", policyName: "night", policyVersion: 2 } })).toBe(
      "Denied by 'night' v2. The call would be refused even if the user holds a grant for it.",
    );
    expect(simulationSentence({ ...sim, abacDecision: { effect: "require_approval", approverName: "Ada" } })).toContain("by Ada");
  });

  it("reads the validator's errors out of an invalid_policy refusal", () => {
    expect(validationErrorsOf({ error: "invalid_policy", errors: [{ message: "unknown attribute", help: "declare it" }, { nope: 1 }] })).toEqual([
      { message: "unknown attribute", help: "declare it" },
    ]);
    expect(validationErrorsOf(null)).toEqual([]);
  });
});
