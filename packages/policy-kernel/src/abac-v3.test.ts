/**
 * ADR-0182 A14 — Cedar schema v3: `principal.aiTrainingCurrent`. v1/v2 unchanged; a v3 policy that requires
 * current training forbids a person who is not current and permits one who is; a v2 policy is unaffected.
 */
import { describe, expect, it } from "vitest";
import {
  ABAC_CURRENT_SCHEMA_VERSION,
  ABAC_SCHEMA_VERSIONS,
  abacEngine,
  abacSchemaText,
  evaluateAbac,
  type AbacPolicy,
  type AbacRequest,
} from "./abac.js";

const REQUIRE_TRAINING_FOR_WRITES = `forbid (principal, action == RegulAIt::Action::"McpToolCall", resource)
  when { resource.kind == "write" } unless { principal.aiTrainingCurrent };`;
const V2_WRITES = `forbid (principal, action == RegulAIt::Action::"McpToolCall", resource)
  when { resource.kind == "write" && principal.isAdmin };`;

const policy = (id: string, source: string, schemaVersion: string): AbacPolicy => ({
  id,
  name: id,
  source,
  mode: "forbid",
  timezone: "UTC",
  schemaVersion,
  version: 1,
});
const request = (aiTrainingCurrent?: boolean): AbacRequest => ({
  principal: {
    id: "11111111-1111-1111-1111-111111111111",
    roles: [],
    roleIds: [],
    teams: [],
    isAdmin: false,
    sessionOrigin: "password",
    mfaCompleted: true,
    ...(aiTrainingCurrent === undefined ? {} : { aiTrainingCurrent }),
  },
  resource: {
    id: "srv/write",
    serverId: "srv",
    serverName: "srv",
    toolName: "write",
    kind: "write",
    priceTier: "unpriced",
    classifications: [],
  },
  context: { deployModes: [], environments: [], rateLimitUsagePct: 0 },
});

describe("ADR-0182 A14: Cedar schema v3", () => {
  it("v3 exists, and v1/v2 are still offered (ADR-0188 S2 moved the current version on to v4)", () => {
    expect(ABAC_SCHEMA_VERSIONS).toEqual(["v1", "v2", "v3", "v4"]);
    expect(ABAC_CURRENT_SCHEMA_VERSION).toBe("v4");
    expect(abacSchemaText("v3")).toContain("aiTrainingCurrent");
    expect(abacSchemaText("v2")).not.toContain("aiTrainingCurrent");
    expect(abacSchemaText("v1")).not.toContain("aiTrainingCurrent");
  });

  it("a policy using the attribute validates against v3 and is refused against v2", () => {
    expect(abacEngine.validate(REQUIRE_TRAINING_FOR_WRITES, "v3").ok).toBe(true);
    const v2 = abacEngine.validate(REQUIRE_TRAINING_FOR_WRITES, "v2");
    expect(v2.ok).toBe(false);
    expect(JSON.stringify(v2.errors)).toContain("aiTrainingCurrent");
  });

  it("a v3 policy requiring current training forbids a person who is not current, permits one who is", () => {
    const p = [policy("need-training", REQUIRE_TRAINING_FOR_WRITES, "v3")];
    expect(evaluateAbac(p, request(false))?.effect).toBe("forbid");
    expect(evaluateAbac(p, request(true))?.effect).toBe("permit");
    // absent reads as false — the strict answer
    expect(evaluateAbac(p, request())?.effect).toBe("forbid");
  });

  it("a v2 (and v1) policy is unaffected: evaluated, not failed closed, whatever the attribute says", () => {
    for (const version of ["v1", "v2"]) {
      const p = [policy(`plain-${version}`, V2_WRITES, version)];
      expect(evaluateAbac(p, request(false))?.effect, version).toBe("permit");
      expect(evaluateAbac(p, request(true))?.effect, version).toBe("permit");
    }
  });

  it("v2 and v3 policies evaluated together each see their own principal bag", () => {
    const p = [policy("plain-v2", V2_WRITES, "v2"), policy("need-training", REQUIRE_TRAINING_FOR_WRITES, "v3")];
    const d = evaluateAbac(p, request(false));
    expect(d?.effect).toBe("forbid");
    expect(d?.policyId).toBe("need-training");
    expect(evaluateAbac(p, request(true))?.effect).toBe("permit");
  });
});
