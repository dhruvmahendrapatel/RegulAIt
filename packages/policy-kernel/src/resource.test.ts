import { describe, expect, it } from "vitest";
import {
  A2A_KERNEL_RULE_IDS,
  composeResourceDecision,
  evaluateA2a,
  governedCoreErrorDecision,
  RESOURCE_RULE_IDS,
  type ComposeResourceInput,
  type GovernedResource,
  type ResourceApprovalRule,
  type ResourceRateLimit,
} from "./index.js";

const C1 = "11111111-1111-4111-8111-111111111111";
const C2 = "22222222-2222-4222-8222-222222222222";
const APPROVER = "33333333-3333-4333-8333-333333333333";
const write: GovernedResource = { type: "connector", id: C1, name: "crm", operation: "write" };
const read: GovernedResource = { type: "connector", id: C1, name: "crm", operation: "read" };
const allow = { effect: "allow" as const, ruleId: "grant-1", reason: "granted", ruleChain: [{ rule: "connector-allow-list", outcome: "allow", grantId: "grant-1" }] };
const deny = { effect: "deny" as const, ruleId: "default-deny", reason: "no grant", ruleChain: [{ rule: "default-deny", outcome: "deny" }] };

const input = (over: Partial<ComposeResourceInput> = {}): ComposeResourceInput => ({
  resource: write,
  base: allow,
  projectId: "p1",
  attributionRequired: true,
  canQueue: true,
  ...over,
});
const limit = (over: Partial<ResourceRateLimit> = {}): ResourceRateLimit => ({
  id: "lim-1", resourceType: "connector", resourceId: C1, scope: "user", maxCalls: 2, windowSeconds: 60, currentCount: 0, ...over,
});
const rule = (over: Partial<ResourceApprovalRule> = {}): ResourceApprovalRule => ({
  id: "rule-1", resourceType: "connector", resourceId: C1, scope: "user", writeOnly: false, approverUserId: APPROVER, ...over,
});

describe("ADR-0251 composeResourceDecision", () => {
  it("passes an entitlement allow through when nothing restricts it", () => {
    const d = composeResourceDecision(input());
    expect(d.effect).toBe("allow");
    expect(d.ruleId).toBe("grant-1");
    expect(d.ruleChain[0]).toEqual(allow.ruleChain[0]);
  });

  it("never rescues an entitlement deny, whatever else is configured", () => {
    const d = composeResourceDecision(input({ base: deny, approvedApprovalId: "a1", approvalRules: [rule()] }));
    expect(d).toMatchObject({ effect: "deny", ruleId: "default-deny" });
  });

  it("refuses an unattributed call under the mandate and allows it when relaxed", () => {
    expect(composeResourceDecision(input({ projectId: null })).ruleId).toBe(RESOURCE_RULE_IDS.attribution);
    expect(composeResourceDecision(input({ projectId: null, attributionRequired: false })).effect).toBe("allow");
  });

  it("refuses at the limit, counts only limits bound to this resource, and picks the tightest window", () => {
    expect(composeResourceDecision(input({ rateLimits: [limit({ currentCount: 1 })] })).effect).toBe("allow");
    expect(composeResourceDecision(input({ rateLimits: [limit({ currentCount: 2 })] })).ruleId).toBe("lim-1");
    expect(composeResourceDecision(input({ rateLimits: [limit({ resourceId: C2, currentCount: 9 })] })).effect).toBe("allow");
    expect(composeResourceDecision(input({ rateLimits: [limit({ resourceType: "a2a", resourceId: null, currentCount: 9 })] })).effect).toBe("allow");
    const both = [limit({ id: "long", windowSeconds: 3600, currentCount: 9 }), limit({ id: "short", windowSeconds: 1, currentCount: 9 })];
    expect(composeResourceDecision(input({ rateLimits: both })).ruleId).toBe("short");
    expect(composeResourceDecision(input({ rateLimits: [limit({ resourceId: null, currentCount: 2 })] })).ruleId).toBe("lim-1");
  });

  it("refuses over the limit before any approval is considered", () => {
    const d = composeResourceDecision(input({ rateLimits: [limit({ currentCount: 2 })], approvalRules: [rule()] }));
    expect(d.effect).toBe("deny");
  });

  it("ABAC forbid refuses; ABAC permit changes nothing", () => {
    expect(composeResourceDecision(input({ abacDecision: { effect: "forbid", policyId: "pol-1" } })).ruleId).toBe("pol-1");
    expect(composeResourceDecision(input({ abacDecision: { effect: "permit" } })).effect).toBe("allow");
  });

  it("an approval rule holds the call with its approver, and a bound consent releases it", () => {
    const held = composeResourceDecision(input({ approvalRules: [rule({ approverName: "Ana" })] }));
    expect(held).toMatchObject({ effect: "require_approval", ruleId: "rule-1", approverUserId: APPROVER, approverName: "Ana", matchedApprovalRuleIds: ["rule-1"] });
    const released = composeResourceDecision(input({ approvalRules: [rule()], approvedApprovalId: "appr-1" }));
    expect(released.effect).toBe("allow");
    expect(released.ruleChain.at(-1)).toEqual({ rule: "approval", outcome: "satisfied-by-approval", grantId: "appr-1" });
  });

  it("a write-only rule does not hold a read; the most specific rule names the approver", () => {
    expect(composeResourceDecision(input({ resource: read, approvalRules: [rule({ writeOnly: true })] })).effect).toBe("allow");
    const d = composeResourceDecision(input({ approvalRules: [rule({ id: "a-wide", resourceId: null, approverUserId: "w" }), rule({ id: "z-specific" })] }));
    expect(d.ruleId).toBe("z-specific");
    expect(d.matchedApprovalRuleIds).toEqual(["z-specific", "a-wide"]);
  });

  it("refuses rather than queues where the path cannot queue (model, A2A)", () => {
    const d = composeResourceDecision(input({ resource: { type: "model", id: C2, mode: "execute" }, approvalRules: [rule({ resourceType: "model", resourceId: C2 })], canQueue: false }));
    expect(d).toMatchObject({ effect: "deny", ruleId: "rule-1" });
    expect(d.reason).toContain("no per-call approval queue");
  });

  it("keeps the entitlement's own hold (the execution dial) and its approver", () => {
    const base = { effect: "require_approval" as const, ruleId: "execution-require-approval", reason: "dial", ruleChain: [], approverUserId: "dial-approver" };
    const d = composeResourceDecision(input({ base, approvalRules: [rule()] }));
    expect(d).toMatchObject({ effect: "require_approval", ruleId: "execution-require-approval", approverUserId: "dial-approver", matchedApprovalRuleIds: ["rule-1"] });
  });

  it("an error is a deny", () => {
    const d = governedCoreErrorDecision(write, new TypeError("boom"));
    expect(d).toMatchObject({ effect: "deny", ruleId: RESOURCE_RULE_IDS.coreError });
    expect(d.reason).not.toContain("boom");
  });
});

describe("ADR-0251 evaluateA2a (S-05: A2A meets the kill switch)", () => {
  const AG = "44444444-4444-4444-8444-444444444444";
  const U = "55555555-5555-4555-8555-555555555555";
  const grant = { id: "gr-1", userId: U, agentId: AG, skillId: null };
  const base = { userId: U, agent: { id: AG, name: "joule" }, skillId: null as string | null, grants: [grant], execution: { mode: "normal" as const } };

  it("allows with a whole-agent grant; a skill grant covers only its skill", () => {
    expect(evaluateA2a(base)).toMatchObject({ effect: "allow", ruleId: "gr-1" });
    const skillOnly = { ...base, grants: [{ ...grant, skillId: "s1" }] };
    expect(evaluateA2a({ ...skillOnly, skillId: "s1" }).effect).toBe("allow");
    expect(evaluateA2a({ ...skillOnly, skillId: "s2" }).ruleId).toBe(A2A_KERNEL_RULE_IDS.noGrant);
    expect(evaluateA2a(skillOnly).ruleId).toBe(A2A_KERNEL_RULE_IDS.noGrant);
  });

  it("default-denies another person's grant and narrows by the lead ceiling", () => {
    expect(evaluateA2a({ ...base, grants: [{ ...grant, userId: "x" }] }).ruleId).toBe(A2A_KERNEL_RULE_IDS.noGrant);
    expect(evaluateA2a({ ...base, ceilingAgentIds: ["other"] }).ruleId).toBe(A2A_KERNEL_RULE_IDS.leadCeiling);
    expect(evaluateA2a({ ...base, ceilingAgentIds: [AG] }).effect).toBe("allow");
  });

  it("is refused by every stop: halted, read-only (a message is a write), the approval dial (no queue), literacy", () => {
    expect(evaluateA2a({ ...base, execution: { mode: "halted" } }).ruleId).toBe("execution-halted");
    expect(evaluateA2a({ ...base, execution: { mode: "read_only" } }).ruleId).toBe("execution-read-only");
    expect(evaluateA2a({ ...base, execution: { mode: "require_approval", approverUserId: "a" } })).toMatchObject({ effect: "deny", ruleId: "execution-require-approval" });
    expect(evaluateA2a({ ...base, execution: { mode: "normal", literacy: { required: true, current: false } } }).ruleId).toBe("ai-literacy-not-current");
  });
});
