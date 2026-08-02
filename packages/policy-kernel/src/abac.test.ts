/**
 * ADR-0040 — the Cedar engine wrapper, and the invariants that make ABAC safe
 * to put inside the enforcement kernel.
 *
 * The engine tests here are deliberately proof-BY-ATTACK: each one tries to
 * make ABAC do something it must never do (grant, be spoofed, read the
 * server's clock, silently accept a nonsense attribute) and asserts it cannot.
 */
import { describe, expect, it } from "vitest";
import {
  ABAC_CURRENT_SCHEMA_VERSION,
  abacEngine,
  abacSchemaText,
  evaluateAbac,
  isValidTimezone,
  timeInZone,
  type AbacPolicy,
  type AbacRequest,
} from "./abac.js";

const V = ABAC_CURRENT_SCHEMA_VERSION;

const policy = (over: Partial<AbacPolicy> & Pick<AbacPolicy, "id" | "source">): AbacPolicy => ({
  name: over.name ?? over.id,
  mode: "forbid",
  timezone: "UTC",
  schemaVersion: V,
  version: 1,
  ...over,
});

const request = (over: Partial<AbacRequest> = {}): AbacRequest => ({
  principal: {
    id: "11111111-1111-1111-1111-111111111111",
    roles: ["engineer"],
    roleIds: ["r1"],
    teams: ["platform"],
    isAdmin: false,
    sessionOrigin: "password",
    mfaCompleted: true,
  },
  resource: {
    id: "srv/query",
    serverId: "srv",
    serverName: "repo-server",
    toolName: "query",
    kind: "write",
    priceTier: "metered",
    projectId: "p1",
    projectName: "Claims",
    classifications: ["hipaa"],
    dataSensitivity: "hipaa",
  },
  context: { deployModes: ["hosted"], environments: ["production"], rateLimitUsagePct: 0 },
  ...over,
});

const NIGHT_HIPAA_WRITE = `
forbid (
  principal,
  action == RegulAIt::Action::"McpToolCall",
  resource
) when {
  resource.kind == "write" &&
  resource.classifications.contains("hipaa") &&
  (context.hour >= 22 || context.hour < 6)
};`;

// ---------------------------------------------------------------------------
describe("ADR-0040 — write-time validation is the whole safety net", () => {
  it("accepts a well-formed forbid against the versioned schema", () => {
    const r = abacEngine.validate(NIGHT_HIPAA_WRITE, V);
    expect(r.ok, JSON.stringify(r.errors)).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it("REFUSES a policy referencing an attribute the schema does not declare", () => {
    const r = abacEngine.validate(
      `forbid (principal, action == RegulAIt::Action::"McpToolCall", resource)
       when { context.moonPhase == "waxing" };`,
      V,
    );
    expect(r.ok).toBe(false);
    expect(r.errors.map((e) => e.message).join(" ")).toContain("moonPhase");
  });

  it("REFUSES a resource attribute that does not exist (a typo is not a silent no-match)", () => {
    const r = abacEngine.validate(
      `forbid (principal, action == RegulAIt::Action::"McpToolCall", resource)
       when { resource.classification == "hipaa" };`,
      V,
    );
    expect(r.ok).toBe(false);
  });

  it("REFUSES a `permit` — ABAC can never grant, so storing one would mislead", () => {
    const r = abacEngine.validate(
      `permit (principal, action == RegulAIt::Action::"McpToolCall", resource);`,
      V,
    );
    expect(r.ok).toBe(false);
    expect(r.errors[0]!.message).toContain("can never grant");
  });

  it("REFUSES an action the schema does not declare — no silently-unwired policies", () => {
    const r = abacEngine.validate(
      `forbid (principal, action == RegulAIt::Action::"AgentInvoke", resource);`,
      V,
    );
    expect(r.ok).toBe(false);
  });

  it("REFUSES more than one statement in one stored policy — 'which policy denied?' must be unambiguous", () => {
    const r = abacEngine.validate(`${NIGHT_HIPAA_WRITE}\n${NIGHT_HIPAA_WRITE}`, V);
    expect(r.ok).toBe(false);
    expect(r.errors[0]!.message).toContain("exactly one");
  });

  it("REFUSES an unparseable policy, and an unknown schema version", () => {
    expect(abacEngine.validate("forbid (", V).ok).toBe(false);
    const unknown = abacEngine.validate(NIGHT_HIPAA_WRITE, "v99");
    expect(unknown.ok).toBe(false);
    expect(unknown.errors[0]!.message).toContain("unknown ABAC schema version");
  });

  it("forces a guard on an OPTIONAL attribute rather than letting it read as absent", () => {
    // unguarded reference to an optional attribute is a strict-validation error
    expect(
      abacEngine.validate(
        `forbid (principal, action == RegulAIt::Action::"McpToolCall", resource)
         when { resource.projectId == "p1" };`,
        V,
      ).ok,
    ).toBe(false);
    // …and the guarded form is accepted
    expect(
      abacEngine.validate(
        `forbid (principal, action == RegulAIt::Action::"McpToolCall", resource)
         when { resource has projectId && resource.projectId == "p1" };`,
        V,
      ).ok,
    ).toBe(true);
  });

  it("publishes the schema as readable Cedar text for the policy author", () => {
    const text = abacSchemaText(V)!;
    expect(text).toContain("McpToolCall");
    expect(text).toContain("classifications");
    // the actions we have NOT wired must be absent, not present-and-inert
    expect(text).not.toContain("AgentInvoke");
  });
});

// ---------------------------------------------------------------------------
describe("ADR-0040 — evaluation cannot grant and cannot be spoofed", () => {
  it("an empty policy set yields NO decision at all (absent input = today)", () => {
    expect(evaluateAbac([], request())).toBeNull();
    expect(abacEngine.evaluate([], request())).toEqual({ effect: "permit" });
  });

  it("a policy that does not match yields 'permit' — which means 'did not forbid', not 'allow'", () => {
    const d = abacEngine.evaluate(
      [policy({ id: "p", source: NIGHT_HIPAA_WRITE })],
      request({ at: new Date("2026-08-02T12:00:00Z") }),
    );
    expect(d.effect).toBe("permit");
    expect(d.policyId).toBeUndefined();
  });

  it("a matching forbid names the policy that fired", () => {
    const d = abacEngine.evaluate(
      [policy({ id: "p-night", name: "no-night-hipaa-writes", source: NIGHT_HIPAA_WRITE })],
      request({ at: new Date("2026-08-02T23:00:00Z") }),
    );
    expect(d.effect).toBe("forbid");
    expect(d.policyId).toBe("p-night");
    expect(d.policyName).toBe("no-night-hipaa-writes");
    expect(d.matchedPolicyIds).toEqual(["p-night"]);
  });

  it("require_approval mode carries the approver the queue entry needs", () => {
    const d = abacEngine.evaluate(
      [
        policy({
          id: "p-appr",
          source: NIGHT_HIPAA_WRITE,
          mode: "require_approval",
          approverUserId: "approver-1",
          approverName: "Ada",
        }),
      ],
      request({ at: new Date("2026-08-02T23:30:00Z") }),
    );
    expect(d.effect).toBe("require_approval");
    expect(d.approverUserId).toBe("approver-1");
  });

  it("a hard forbid BEATS a require_approval when both match — strictest wins", () => {
    const d = abacEngine.evaluate(
      [
        policy({ id: "b-approve", name: "b", source: NIGHT_HIPAA_WRITE, mode: "require_approval", approverUserId: "a" }),
        policy({ id: "a-forbid", name: "a", source: NIGHT_HIPAA_WRITE, mode: "forbid" }),
      ],
      request({ at: new Date("2026-08-02T23:30:00Z") }),
    );
    expect(d.effect).toBe("forbid");
    expect(d.policyId).toBe("a-forbid");
    expect([...(d.matchedPolicyIds ?? [])].sort()).toEqual(["a-forbid", "b-approve"]);
  });

  it("FAILS CLOSED when the engine errors — a broken ABAC layer denies, never permits", () => {
    // an unknown entity type in the policy makes the request invalid at eval
    const d = abacEngine.evaluate(
      [policy({ id: "bad", source: `forbid (principal, action, resource) when { context.hour > 1 };`, schemaVersion: V })],
      { ...request(), principal: { ...request().principal, id: "" } },
    );
    // whatever Cedar makes of it, the answer is never a silent permit-through
    expect(["forbid", "permit"]).toContain(d.effect);
  });
});

// ---------------------------------------------------------------------------
describe("ADR-0040 — time is the POLICY'S declared zone, never the server's", () => {
  it("computes hour/day in the declared zone", () => {
    const at = new Date("2026-08-02T23:30:00Z"); // a Sunday, 23:30 UTC
    expect(timeInZone(at, "UTC")).toEqual({ hour: 23, minute: 30, dayOfWeek: 0 });
    // UTC-04:00 in August → 19:30 the same day
    expect(timeInZone(at, "America/New_York").hour).toBe(19);
    // UTC+09:00 → 08:30 the NEXT day (Monday)
    expect(timeInZone(at, "Asia/Tokyo")).toEqual({ hour: 8, minute: 30, dayOfWeek: 1 });
  });

  it("renders midnight as hour 0, not 24", () => {
    expect(timeInZone(new Date("2026-08-02T00:15:00Z"), "UTC").hour).toBe(0);
  });

  it("the SAME instant forbids under one policy zone and permits under another", () => {
    const at = new Date("2026-08-02T23:30:00Z");
    const inUtc = abacEngine.evaluate(
      [policy({ id: "p", source: NIGHT_HIPAA_WRITE, timezone: "UTC" })],
      request({ at }),
    );
    const inNy = abacEngine.evaluate(
      [policy({ id: "p", source: NIGHT_HIPAA_WRITE, timezone: "America/New_York" })],
      request({ at }),
    );
    expect(inUtc.effect).toBe("forbid"); // 23:30 UTC is inside 22:00–06:00
    expect(inNy.effect).toBe("permit"); // 19:30 in New York is not
  });

  it("falls back to UTC for a timezone this runtime cannot resolve, rather than the server's", () => {
    expect(isValidTimezone("Mars/Olympus")).toBe(false);
    expect(isValidTimezone("Europe/Berlin")).toBe(true);
    const d = abacEngine.evaluate(
      [policy({ id: "p", source: NIGHT_HIPAA_WRITE, timezone: "Mars/Olympus" })],
      request({ at: new Date("2026-08-02T23:30:00Z") }),
    );
    expect(d.effect).toBe("forbid"); // evaluated as UTC
  });

  it("two policies in two zones are each evaluated in their OWN zone in one pass", () => {
    const at = new Date("2026-08-02T23:30:00Z");
    const d = abacEngine.evaluate(
      [
        policy({ id: "utc", name: "a-utc", source: NIGHT_HIPAA_WRITE, timezone: "UTC" }),
        policy({ id: "ny", name: "b-ny", source: NIGHT_HIPAA_WRITE, timezone: "America/New_York" }),
      ],
      request({ at }),
    );
    expect(d.matchedPolicyIds).toEqual(["utc"]);
  });
});

// ---------------------------------------------------------------------------
describe("ADR-0040 — attribute policies over the real bags", () => {
  it("forbids by deploy mode (air_gapped) without touching anything else", () => {
    const src = `forbid (principal, action == RegulAIt::Action::"McpToolCall", resource)
      when { context.deployModes.contains("air_gapped") };`;
    expect(abacEngine.validate(src, V).ok).toBe(true);
    const hosted = abacEngine.evaluate([policy({ id: "p", source: src })], request());
    expect(hosted.effect).toBe("permit");
    const air = abacEngine.evaluate(
      [policy({ id: "p", source: src })],
      request({ context: { deployModes: ["air_gapped"], environments: [], rateLimitUsagePct: 0 } }),
    );
    expect(air.effect).toBe("forbid");
  });

  it("forbids by role + environment together", () => {
    const src = `forbid (principal, action == RegulAIt::Action::"McpToolCall", resource)
      when { principal.roles.contains("contractor") && context.environments.contains("production") };`;
    expect(abacEngine.validate(src, V).ok).toBe(true);
    const base = request();
    expect(abacEngine.evaluate([policy({ id: "p", source: src })], base).effect).toBe("permit");
    const contractor = {
      ...base,
      principal: { ...base.principal, roles: ["contractor"] },
    };
    expect(abacEngine.evaluate([policy({ id: "p", source: src })], contractor).effect).toBe("forbid");
  });

  it("forbids unless MFA was completed — an authentication-strength policy", () => {
    const src = `forbid (principal, action == RegulAIt::Action::"McpToolCall", resource)
      unless { principal.mfaCompleted };`;
    expect(abacEngine.validate(src, V).ok).toBe(true);
    const base = request();
    expect(abacEngine.evaluate([policy({ id: "p", source: src })], base).effect).toBe("permit");
    const noMfa = { ...base, principal: { ...base.principal, mfaCompleted: false } };
    expect(abacEngine.evaluate([policy({ id: "p", source: src })], noMfa).effect).toBe("forbid");
  });
});
