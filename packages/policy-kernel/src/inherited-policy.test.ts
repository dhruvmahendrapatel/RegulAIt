/**
 * ADR-0357 §4 enforcement (D-2026-11-23-02): the inherited policy at call time, pure. Each call type, deny and
 * tighten-only precedence, the level named on every applied rule, and the governed core and MCP kernel applying it.
 */
import { describe, expect, it } from "vitest";
import { composeResourceDecision, evaluate, inheritedPolicyVerdict, type InheritedPolicy, type InheritedPolicyRule } from "./index.js";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const BU = "22222222-2222-4222-8222-222222222222";
const chain = [
  { level: "org" as const, subjectId: null, name: null },
  { level: "business_unit" as const, subjectId: BU, name: "Retail" },
  { level: "project" as const, subjectId: PROJECT, name: "Checkout" },
];
const rule = (r: string, value: unknown, level: "org" | "business_unit" | "project" = "org"): InheritedPolicyRule => ({
  rule: r,
  value,
  setBy: { level, subjectId: level === "org" ? null : level === "business_unit" ? BU : PROJECT },
});
const policy = (...rules: InheritedPolicyRule[]): InheritedPolicy => ({ chain, rules });
const allow = { effect: "allow" as const, ruleId: "grant-1", reason: "granted", ruleChain: [] };

describe("inheritedPolicyVerdict: each call type", () => {
  it("model: allowedAgents decides by the agent's name; an unnamed agent is outside a set list", () => {
    const p = policy(rule("allowedAgents", ["gpt-safe"], "project"));
    expect(inheritedPolicyVerdict(p, { type: "model", name: "gpt-safe" })).toEqual({
      effect: "allow",
      trace: [{ rule: "inherited-policy", outcome: "allow", grantId: `allowedAgents@project:${PROJECT}` }],
    });
    const d = inheritedPolicyVerdict(p, { type: "model", name: "other" });
    expect(d).toMatchObject({ effect: "deny", ruleId: "inherited-policy" });
    expect(d.effect === "deny" && d.reason).toContain("project 'Checkout'");
    expect(inheritedPolicyVerdict(p, { type: "model", name: null }).effect).toBe("deny");
  });

  it("connector: allowedConnectors, by name", () => {
    const p = policy(rule("allowedConnectors", ["crm"], "business_unit"));
    expect(inheritedPolicyVerdict(p, { type: "connector", name: "crm" }).effect).toBe("allow");
    const d = inheritedPolicyVerdict(p, { type: "connector", name: "billing" });
    expect(d).toMatchObject({ effect: "deny", trace: [{ outcome: "deny", grantId: `allowedConnectors@business_unit:${BU}` }] });
    expect(d.effect === "deny" && d.reason).toContain("business unit 'Retail'");
  });

  it("MCP tool: allowedMcpServers by server name, then deniedTools as server/tool", () => {
    const p = policy(rule("allowedMcpServers", ["github", "jira"]), rule("deniedTools", ["github/delete_repo"], "project"));
    expect(inheritedPolicyVerdict(p, { type: "mcp_tool", serverName: "github", toolName: "create_issue" })).toEqual({
      effect: "allow",
      trace: [
        { rule: "inherited-policy", outcome: "allow", grantId: "allowedMcpServers@org" },
        { rule: "inherited-policy", outcome: "allow", grantId: `deniedTools@project:${PROJECT}` },
      ],
    });
    expect(inheritedPolicyVerdict(p, { type: "mcp_tool", serverName: "slack", toolName: "post" })).toMatchObject({ effect: "deny", trace: [{ grantId: "allowedMcpServers@org" }] });
    expect(inheritedPolicyVerdict(p, { type: "mcp_tool", serverName: "github", toolName: "delete_repo" })).toMatchObject({
      effect: "deny",
      trace: [{ outcome: "allow" }, { outcome: "deny", grantId: `deniedTools@project:${PROJECT}` }],
    });
    // an unnamed server cannot be shown to be off the deny-list (fail closed)
    expect(inheritedPolicyVerdict(policy(rule("deniedTools", ["github/delete_repo"])), { type: "mcp_tool", serverName: null, toolName: "delete_repo" }).effect).toBe("deny");
  });

  it("A2A: no inherited rule applies yet; nothing is traced and the call is not refused", () => {
    expect(inheritedPolicyVerdict(policy(rule("allowedAgents", ["x"]), rule("allowedConnectors", ["y"])), { type: "a2a", name: "remote" })).toEqual({ effect: "allow", trace: [] });
  });

  it("an unset rule (value null) applies nothing", () => {
    expect(inheritedPolicyVerdict(policy({ rule: "allowedAgents", value: null, setBy: null }), { type: "model", name: "any" })).toEqual({ effect: "allow", trace: [] });
  });
});

describe("precedence: deny wins, and the inherited policy never grants", () => {
  it("the governed core refuses an entitled call outside the policy, before attribution, rate limits, ABAC and approval", () => {
    const d = composeResourceDecision({
      resource: { type: "connector", id: "c1", name: "billing", operation: "write" },
      base: allow,
      projectId: null,
      attributionRequired: true,
      canQueue: true,
      approvalRules: [],
      abacDecision: { effect: "require_approval", policyId: "p", approverUserId: "a" },
      inheritedPolicy: policy(rule("allowedConnectors", ["crm"], "project")),
    });
    expect(d).toMatchObject({ effect: "deny", ruleId: "inherited-policy" });
    expect(d.ruleChain.at(-1)).toEqual({ rule: "inherited-policy", outcome: "deny", grantId: `allowedConnectors@project:${PROJECT}` });
  });

  it("an entitlement deny stays the deny it was, and nothing the inherited policy allows turns it into an allow", () => {
    const deny = { effect: "deny" as const, ruleId: "default-deny", reason: "no grant", ruleChain: [] };
    const d = composeResourceDecision({
      resource: { type: "connector", id: "c1", name: "crm", operation: "read" },
      base: deny,
      projectId: "p1",
      attributionRequired: true,
      canQueue: true,
      inheritedPolicy: policy(rule("allowedConnectors", ["crm"])),
    });
    expect(d).toMatchObject({ effect: "deny", ruleId: "default-deny" });
  });

  it("a call inside the policy is decided as before, with the applied rule traced", () => {
    const d = composeResourceDecision({
      resource: { type: "model", id: "m1", name: "gpt-safe", mode: "chat" },
      base: allow,
      projectId: "p1",
      attributionRequired: true,
      canQueue: true,
      inheritedPolicy: policy(rule("allowedAgents", ["gpt-safe"], "project")),
    });
    expect(d.effect).toBe("allow");
    expect(d.ruleChain).toContainEqual({ rule: "inherited-policy", outcome: "allow", grantId: `allowedAgents@project:${PROJECT}` });
  });

  it("the MCP kernel refuses an allowed or held tool call outside the policy, and keeps its own deny", () => {
    const base = {
      userId: "u1",
      serverId: "s1",
      serverName: "github",
      execution: { mode: "normal" } as never,
      actor: null,
      tool: { serverId: "s1", name: "delete_repo", kind: "write" as const },
      toolGrants: [{ id: "g1", userId: "u1", serverId: "s1", toolName: "delete_repo" }],
      serverGrants: [],
      roleToolGrants: [],
      roleServerGrants: [],
      revocations: [],
    } as unknown as Parameters<typeof evaluate>[0];
    const granted = evaluate(base);
    expect(granted.effect).toBe("allow");
    const refused = evaluate({ ...base, inheritedPolicy: policy(rule("deniedTools", ["github/delete_repo"], "project")) });
    expect(refused).toMatchObject({ effect: "deny", ruleId: "inherited-policy" });
    expect(refused.ruleChain.at(-1)).toEqual({ rule: "inherited-policy", outcome: "deny", grantId: `deniedTools@project:${PROJECT}` });
    // the kernel's own deny (no grant) keeps its rule id
    const ungranted = evaluate({ ...base, toolGrants: [], inheritedPolicy: policy(rule("deniedTools", ["github/delete_repo"])) });
    expect(ungranted.ruleId).not.toBe("inherited-policy");
  });
});
