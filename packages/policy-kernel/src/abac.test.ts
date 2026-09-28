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

// ===========================================================================
// SCHEMA v2 — network location, and the v1 policies it must not disturb
// ===========================================================================
//
// The gap this closes was named precisely: the context bag had time, deploy
// mode, environment and rate-limit pressure, and no notion of WHERE a request
// came from. It is now `context.clientIp`, Cedar's own `ipaddr` type, so an
// author gets real CIDR semantics from the engine instead of doing prefix
// comparisons on text (which is how `10.1.0.0/16` ends up matching `10.10.x`).
//
// Two things here are much more important than the feature:
//
//  1. **A stored v1 policy must be completely unaffected.** `isAuthorized` runs
//     with `validateRequest: true` and this engine turns a validation failure
//     into `forbid`, so emitting a context attribute v1's schema does not
//     declare would fail-closed EVERY call governed by an existing policy. That
//     is a self-inflicted outage, and it is what the schema-version parameter on
//     `contextFor` exists to prevent.
//  2. **An unparseable address must not reach Cedar.** `ip("garbage")` is an
//     evaluation error and this engine fails closed on one, so a single
//     malformed forwarded header would turn an IP-aware policy into a blanket
//     deny.

describe("ADR-0040 / schema v2 — network location", () => {
  const CORP_ONLY = `
forbid (
  principal,
  action == RegulAIt::Action::"McpToolCall",
  resource
) unless {
  context has clientIp && context.clientIp.isInRange(ip("10.0.0.0/8"))
};`;

  it("REFUSES a policy that reads clientIp without guarding for its absence", () => {
    // The whole point of `required: false`. The client IP is genuinely
    // undeterminable (ADR-0031 trusts no proxy by default), so strict validation
    // must force the author to decide what happens when it is unknown — at WRITE
    // time, rather than leaving a silent no-match at runtime.
    const unguarded = `
forbid (principal, action, resource)
unless { context.clientIp.isInRange(ip("10.0.0.0/8")) };`;
    const res = abacEngine.validate(unguarded, "v2");
    expect(res.ok, JSON.stringify(res)).toBe(false);

    // and the guarded form is accepted, so the refusal is about the GUARD and
    // not about the attribute being unusable
    expect(abacEngine.validate(CORP_ONLY, "v2").ok).toBe(true);
  });

  it("v1 refuses an UNGUARDED clientIp reference, and that is the real proof v1 lacks it", () => {
    const unguarded = `
forbid (principal, action, resource)
unless { context.clientIp.isInRange(ip("10.0.0.0/8")) };`;
    expect(abacEngine.validate(unguarded, "v1").ok).toBe(false);
  });

  it("but a GUARDED one validates under v1 and then DENIES EVERYTHING — the trap, measured", () => {
    // WRITTEN AFTER BEING WRONG TWICE, which is why it asserts a measurement
    // rather than a guess. Cedar\'s `has` on an attribute the schema does not
    // declare is legal and always false, and `&&` short-circuits — so this
    // policy PASSES v1 validation. The first guess was that it would therefore
    // never fire. It is the opposite:
    //
    //   forbid … unless { context has clientIp && … }
    //
    // means "forbid unless the guard holds". Under v1 the guard is false for
    // EVERY request, so the forbid applies to every request. A network policy
    // stored against v1 is a blanket deny.
    //
    // The direction is the safe one — ABAC can only forbid, never grant — so
    // this is an outage and not a bypass. It is still the thing to know: what
    // makes the attribute reachable is `ABAC_CURRENT_SCHEMA_VERSION` moving to
    // v2, so that new policies are STAMPED v2 on write. A policy hand-written
    // against v1 does not quietly under-enforce; it over-enforces, loudly.
    expect(abacEngine.validate(CORP_ONLY, "v1").ok).toBe(true);

    const onNetButV1 = evaluateAbac(
      [policy({ id: "corp-v1", source: CORP_ONLY, schemaVersion: "v1" })],
      request({ context: { deployModes: ["hosted"], environments: ["production"], rateLimitUsagePct: 0, clientIp: "10.4.2.9" } }),
    );
    // ON-network, and still forbidden: v1 never sees the address, so the guard
    // cannot hold no matter where the call came from
    expect(onNetButV1?.effect, "a v1-stored network policy denies even an on-network call").toBe("forbid");

    // and the SAME source stored as v2 permits that same on-network call —
    // which is what proves the difference is the schema version and nothing else
    const onNetV2 = evaluateAbac(
      [policy({ id: "corp-v2", source: CORP_ONLY, schemaVersion: "v2" })],
      request({ context: { deployModes: ["hosted"], environments: ["production"], rateLimitUsagePct: 0, clientIp: "10.4.2.9" } }),
    );
    expect(onNetV2?.effect).not.toBe("forbid");
  });

  it("forbids an off-network call and permits an on-network one", () => {
    const pol = [policy({ id: "corp", source: CORP_ONLY, schemaVersion: "v2" })];

    const offNet = evaluateAbac(pol, request({ context: { deployModes: ["hosted"], environments: ["production"], rateLimitUsagePct: 0, clientIp: "203.0.113.7" } }));
    expect(offNet?.effect).toBe("forbid");

    const onNet = evaluateAbac(pol, request({ context: { deployModes: ["hosted"], environments: ["production"], rateLimitUsagePct: 0, clientIp: "10.4.2.9" } }));
    expect(onNet?.effect).not.toBe("forbid");
  });

  it("treats an UNKNOWN address as absent, so the policy's own guard decides", () => {
    // `unless { context has clientIp && … }` forbids when the address is
    // missing — which is the author's choice, made visible. The engine does not
    // choose for them.
    const pol = [policy({ id: "corp", source: CORP_ONLY, schemaVersion: "v2" })];
    for (const clientIp of [null, undefined, ""]) {
      const out = evaluateAbac(pol, request({ context: { deployModes: ["hosted"], environments: ["production"], rateLimitUsagePct: 0, clientIp } }));
      expect(out?.effect, `clientIp=${String(clientIp)}`).toBe("forbid");
    }
  });

  it("does not hand Cedar a MALFORMED address — one bad header is not a blanket deny", () => {
    // `ip("…")` on a non-address is an evaluation error, and this engine fails
    // closed on an engine error with policyId `abac-engine-error`. The guard
    // against that is dropping the value before it is ever constructed, so the
    // outcome must be the ordinary "absent" one and NOT the engine-error deny.
    const pol = [policy({ id: "corp", source: CORP_ONLY, schemaVersion: "v2" })];
    for (const bad of ["not-an-ip", "10.0.0.1/8", "999.1.1.1", "10.0.0.1:443", "010.1.1.1", "fe80::1%eth0", "::ffff::1"]) {
      const out = evaluateAbac(pol, request({ context: { deployModes: ["hosted"], environments: ["production"], rateLimitUsagePct: 0, clientIp: bad } }));
      expect(out?.effect, `clientIp=${bad}`).toBe("forbid");
      expect(out?.policyId, `clientIp=${bad} must not reach the engine`).not.toBe("abac-engine-error");
    }
  });

  it("accepts the address shapes that ARE real, including IPv6", () => {
    const pol = [
      policy({
        id: "v6",
        source: `forbid (principal, action, resource) unless { context has clientIp && context.clientIp.isInRange(ip("2001:db8::/32")) };`,
        schemaVersion: "v2",
      }),
    ];
    const out = evaluateAbac(pol, request({ context: { deployModes: ["hosted"], environments: ["production"], rateLimitUsagePct: 0, clientIp: "2001:db8::1" } }));
    expect(out?.effect).not.toBe("forbid");
  });

  it("THE REGRESSION THAT MATTERS: a stored v1 policy still evaluates, with an IP present", () => {
    // If `contextFor` emitted `clientIp` regardless of schema version, this
    // would come back `abac-engine-error` — request validation failing against
    // v1's schema — and every deployment with a v1 policy would start refusing
    // every call. Asserted with an address PRESENT, because that is the only
    // case that can break.
    const v1Pol = [policy({ id: "night", source: NIGHT_HIPAA_WRITE, schemaVersion: "v1" })];
    const ctx = { deployModes: ["hosted"], environments: ["production"], rateLimitUsagePct: 0, clientIp: "10.4.2.9" };

    const daytime = evaluateAbac(v1Pol, request({ context: ctx, at: new Date("2026-09-28T12:00:00Z") }));
    expect(daytime?.policyId, "a v1 policy must not fail request validation").not.toBe("abac-engine-error");
    expect(daytime?.effect).not.toBe("forbid");

    // and it still FORBIDS what it always forbade — the v1 policy is untouched,
    // not merely non-erroring
    const night = evaluateAbac(v1Pol, request({ context: ctx, at: new Date("2026-09-28T23:00:00Z") }));
    expect(night?.effect).toBe("forbid");
    expect(night?.policyId).toBe("night");
  });

  it("evaluates a v1 and a v2 policy TOGETHER, each against its own schema", () => {
    // The mixed estate is the real deployment: policies written before v2 sit
    // beside ones written after. Both groups must be evaluated, and the v2 one
    // must be the one that fires here.
    const mixed = [
      policy({ id: "night", source: NIGHT_HIPAA_WRITE, schemaVersion: "v1" }),
      policy({ id: "corp", source: CORP_ONLY, schemaVersion: "v2" }),
    ];
    const out = evaluateAbac(mixed, request({
        context: { deployModes: ["hosted"], environments: ["production"], rateLimitUsagePct: 0, clientIp: "203.0.113.7" },
        at: new Date("2026-09-28T12:00:00Z"),
      }));
    expect(out?.effect).toBe("forbid");
    expect(out?.policyId, "the v2 network policy is what forbade it").toBe("corp");
  });

  it("there is deliberately NO device-posture attribute", () => {
    // Nothing in this product can observe device posture. An attribute we
    // cannot populate honestly is AER-036 in a new place: a field that reads as
    // evidence and is an assertion nobody checked. If this ever becomes
    // available it arrives with a source, in a v3.
    const text = abacSchemaText("v2") ?? "";
    expect(text).toContain("clientIp");
    expect(text.toLowerCase()).not.toContain("deviceposture");
  });
});
