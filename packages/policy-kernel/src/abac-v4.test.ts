/**
 * ADR-0188 S2 (decision 18) — Cedar schema v4: the `Agent` principal and the delegation context.
 */
import { describe, expect, it } from "vitest";
import {
  ABAC_AGENT_SCHEMA_VERSIONS,
  ABAC_CURRENT_SCHEMA_VERSION,
  ABAC_SCHEMA_VERSIONS,
  ABAC_V4_PRINCIPAL_HELP,
  abacEngine,
  abacSchema,
  abacSchemaText,
  type AbacAgentAttrs,
  type AbacPolicy,
  type AbacRequest,
} from "./abac.js";

const policy = (id: string, source: string, schemaVersion: string, mode: AbacPolicy["mode"] = "forbid"): AbacPolicy => ({
  id,
  name: id,
  source,
  mode,
  timezone: "UTC",
  schemaVersion,
  version: 1,
  ...(mode === "require_approval" ? { approverUserId: "approver-1" } : {}),
});

const AGENT: AbacAgentAttrs = {
  id: "11111111-1111-4111-8111-111111111111",
  kind: "agent",
  identifier: "spiffe://t.local/regulait/agent/a1",
  environments: ["staging"],
  stewards: ["22222222-2222-4222-8222-222222222222"],
};

const sponsor = (over: Partial<AbacRequest> = {}): AbacRequest => ({
  principal: {
    id: "22222222-2222-4222-8222-222222222222",
    roles: ["engineer"],
    roleIds: ["r1"],
    teams: [],
    isAdmin: true,
    sessionOrigin: "password",
    mfaCompleted: true,
    aiTrainingCurrent: true,
  },
  resource: {
    id: "srv/deploy",
    serverId: "srv",
    serverName: "ops",
    toolName: "deploy",
    kind: "write",
    priceTier: "metered",
    classifications: [],
  },
  context: { deployModes: [], environments: ["production"], rateLimitUsagePct: 0 },
  ...over,
});
const asAgent = (a: AbacAgentAttrs = AGENT, over: Partial<AbacRequest> = {}) =>
  sponsor({ agent: a, delegation: { actorChain: [a.id], delegationDepth: 1 }, ...over });

const DEEP_WRITES = `forbid (principal, action == RegulAIt::Action::"McpToolCall", resource)
  when { resource.kind == "write" && context.delegationDepth > 1 };`;
const AGENTS_NOT_IN_PROD = `forbid (principal is RegulAIt::Agent, action == RegulAIt::Action::"McpToolCall", resource)
  when { context.environments.contains("production") && !principal.environments.contains("production") };`;
const ADMINS_ONLY_PERSON = `forbid (principal is RegulAIt::User, action == RegulAIt::Action::"McpToolCall", resource)
  unless { principal.isAdmin };`;

describe("ADR-0188 S2 — Cedar schema v4", () => {
  it("v4 is offered and is the default for new policies; only v4 evaluates agents", () => {
    expect(ABAC_SCHEMA_VERSIONS).toEqual(["v1", "v2", "v3", "v4"]);
    expect(ABAC_CURRENT_SCHEMA_VERSION).toBe("v4");
    expect(ABAC_AGENT_SCHEMA_VERSIONS).toEqual(["v4"]);
    const text = abacSchemaText("v4")!;
    expect(text).toContain("entity Agent");
    expect(text).toContain("delegationDepth");
    expect(abacSchemaText("v3")).not.toContain("Agent");
  });

  it("the Agent entity carries ONLY its own attributes — no human attribute exists on it", () => {
    const v4 = abacSchema("v4") as { RegulAIt: { entityTypes: Record<string, { shape: { attributes: Record<string, unknown> } }> } };
    expect(Object.keys(v4.RegulAIt.entityTypes.Agent!.shape.attributes).sort()).toEqual(
      ["autonomyClass", "environments", "identifier", "kind", "stewards"].sort(),
    );
    for (const human of ["isAdmin", "mfaCompleted", "sessionOrigin", "aiTrainingCurrent", "roles", "roleIds", "teams"]) {
      expect(v4.RegulAIt.entityTypes.Agent!.shape.attributes).not.toHaveProperty(human);
    }
    // and a policy cannot reach one through an Agent principal
    const r = abacEngine.validate(
      `forbid (principal is RegulAIt::Agent, action == RegulAIt::Action::"McpToolCall", resource) unless { principal.mfaCompleted };`,
      "v4",
    );
    expect(r.ok).toBe(false);
  });

  it("an unscoped v4 policy reading a person attribute is refused at write time, with help that says what to write", () => {
    const r = abacEngine.validate(
      `forbid (principal, action == RegulAIt::Action::"McpToolCall", resource) unless { principal.isAdmin };`,
      "v4",
    );
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => (e.help ?? "").includes(ABAC_V4_PRINCIPAL_HELP))).toBe(true);
    // the same policy is fine under v3, and narrowed with `is RegulAIt::User` it is fine under v4
    expect(abacEngine.validate(`forbid (principal, action == RegulAIt::Action::"McpToolCall", resource) unless { principal.isAdmin };`, "v3").ok).toBe(true);
    expect(abacEngine.validate(ADMINS_ONLY_PERSON, "v4").ok).toBe(true);
    expect(abacEngine.validate(DEEP_WRITES, "v4").ok).toBe(true);
    expect(abacEngine.validate(AGENTS_NOT_IN_PROD, "v4").ok).toBe(true);
    // v3 cannot name the new context or entity
    expect(abacEngine.validate(DEEP_WRITES, "v3").ok).toBe(false);
  });

  it("an optional agent attribute must be guarded with `has` (autonomyClass is absent for most kinds)", () => {
    const unguarded = `forbid (principal is RegulAIt::Agent, action == RegulAIt::Action::"McpToolCall", resource) when { principal.autonomyClass == "autonomous" };`;
    const guarded = `forbid (principal is RegulAIt::Agent, action == RegulAIt::Action::"McpToolCall", resource) when { principal has autonomyClass && principal.autonomyClass == "autonomous" };`;
    expect(abacEngine.validate(unguarded, "v4").ok).toBe(false);
    expect(abacEngine.validate(guarded, "v4").ok).toBe(true);
    expect(abacEngine.evaluate([policy("g", guarded, "v4")], asAgent({ ...AGENT, autonomyClass: "autonomous" })).effect).toBe("forbid");
    expect(abacEngine.evaluate([policy("g", guarded, "v4")], asAgent()).effect).toBe("permit");
  });

  it("an Agent is evaluated against v4 policies ONLY: a legacy v1–v3 forbid binds the sponsor, never the agent", () => {
    const legacy = policy("legacy-writes", `forbid (principal, action == RegulAIt::Action::"McpToolCall", resource) when { resource.kind == "write" };`, "v2");
    expect(abacEngine.evaluate([legacy], sponsor()).effect).toBe("forbid");
    expect(abacEngine.evaluate([legacy], asAgent()).effect).toBe("permit");
  });

  it("with no Agent policy, agent evaluation is neutral; a v4 Agent policy narrows", () => {
    const personOnly = policy("person", ADMINS_ONLY_PERSON, "v4");
    expect(abacEngine.evaluate([personOnly], asAgent()).effect).toBe("permit");
    const prod = policy("prod", AGENTS_NOT_IN_PROD, "v4");
    expect(abacEngine.evaluate([prod], asAgent()).effect).toBe("forbid");
    expect(abacEngine.evaluate([prod], asAgent({ ...AGENT, environments: ["production"] })).effect).toBe("permit");
    // the sponsor is a User, so an `is RegulAIt::Agent` policy never binds them
    expect(abacEngine.evaluate([prod], sponsor()).effect).toBe("permit");
  });

  it("context.delegationDepth and actorChain reach both principals; a person acting directly is depth 0", () => {
    const deep = policy("deep", DEEP_WRITES, "v4");
    expect(abacEngine.evaluate([deep], sponsor()).effect).toBe("permit");
    const twoHops = { actorChain: ["a0", AGENT.id], delegationDepth: 2 };
    expect(abacEngine.evaluate([deep], sponsor({ delegation: twoHops })).effect).toBe("forbid");
    expect(abacEngine.evaluate([deep], asAgent(AGENT, { delegation: twoHops })).effect).toBe("forbid");
    expect(abacEngine.evaluate([deep], asAgent()).effect).toBe("permit");
    const chainPolicy = policy(
      "chain",
      `forbid (principal, action == RegulAIt::Action::"McpToolCall", resource) when { context.actorChain.contains("a0") };`,
      "v4",
    );
    expect(abacEngine.evaluate([chainPolicy], sponsor({ delegation: twoHops })).effect).toBe("forbid");
    expect(abacEngine.evaluate([chainPolicy], sponsor()).effect).toBe("permit");
  });

  it("v1–v3 groups never see the v4 context, so mixing versions does not fail closed", () => {
    const v1 = policy("v1-writes", `forbid (principal, action == RegulAIt::Action::"McpToolCall", resource) when { resource.toolName == "other" };`, "v1");
    const v3 = policy("v3-training", `forbid (principal, action == RegulAIt::Action::"McpToolCall", resource) unless { principal.aiTrainingCurrent };`, "v3");
    const d = abacEngine.evaluate([v1, v3, policy("deep", DEEP_WRITES, "v4")], sponsor({ delegation: { actorChain: ["x"], delegationDepth: 1 } }));
    expect(d.effect).toBe("permit");
  });

  it("an Agent policy may require approval; a v4 group that cannot be evaluated fails closed with abac-engine-error", () => {
    const hold = policy("hold", AGENTS_NOT_IN_PROD, "v4", "require_approval");
    expect(abacEngine.evaluate([hold], asAgent()).effect).toBe("require_approval");
    // a stored v4 policy whose source no longer validates (e.g. edited outside the API) refuses the call
    const broken = policy("broken", `forbid (principal, action == RegulAIt::Action::"McpToolCall", resource) when { principal.isAdmin };`, "v4");
    const d = abacEngine.evaluate([broken], asAgent());
    expect(d.effect).toBe("forbid");
    expect(d.policyId).toBe("abac-engine-error");
  });
});
