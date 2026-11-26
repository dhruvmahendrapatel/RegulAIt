/** ADR-0357 §4: the declared merge table, one row at a time, then the fold, setBy and the tighten-only check. */
import { describe, expect, it } from "vitest";
import {
  POLICY_RULES,
  POLICY_RULE_NAMES,
  effectivePolicy,
  governancePolicySchema,
  layerRelaxations,
  mergeRule,
  policyWidenings,
  ruleLoosens,
  type GovernancePolicy,
  type PolicyLayerInput,
} from "./governance-policy.js";

describe("the merge table", () => {
  // [rule, parent, child, merged, child-looser-than-parent?]
  const ROWS: Array<[keyof typeof POLICY_RULES, unknown, unknown, unknown, boolean]> = [
    ["allowedAgents", ["a", "b"], ["b", "c"], ["b"], true],
    ["allowedAgents", ["a", "b"], ["a"], ["a"], false],
    ["allowedConnectors", ["x"], [], [], false],
    ["allowedMcpServers", ["s1", "s2"], ["s2"], ["s2"], false],
    ["deniedTools", ["s/a"], ["s/b"], ["s/a", "s/b"], true],
    ["deniedTools", ["s/a"], ["s/a", "s/b"], ["s/a", "s/b"], false],
    ["maxBudgetUsd", 100, 50, 50, false],
    ["maxBudgetUsd", 100, 200, 100, true],
    ["maxCallsPerHour", 10, 20, 10, true],
    ["auditRetentionDays", 365, 90, 365, true],
    ["auditRetentionDays", 365, 730, 730, false],
    ["minApprovers", 2, 1, 2, true],
    ["requireHumanSignoff", true, false, true, true],
    ["requireHumanSignoff", false, true, true, false],
    ["requirePlanGate", false, false, false, false],
    ["maxDataSensitivity", "confidential", "internal", "internal", false],
    ["maxDataSensitivity", "internal", "regulated", "internal", true],
    ["piiMode", "warn", "block", "block", false],
    ["piiMode", "block", "log", "block", true],
  ];
  it.each(ROWS)("%s: %j ∘ %j = %j (child looser: %s)", (rule, parent, child, merged, looser) => {
    expect(mergeRule(rule, parent as never, child as never)).toEqual(merged);
    expect(ruleLoosens(rule, parent as never, child as never)).toBe(looser);
  });

  it("covers every rule in the table, and the schema knows exactly those rules", () => {
    expect(new Set(ROWS.map((r) => r[0]))).toEqual(new Set(POLICY_RULE_NAMES));
    expect(Object.keys(governancePolicySchema.shape).sort()).toEqual([...POLICY_RULE_NAMES].sort());
  });

  it("a merge is never looser than either side", () => {
    for (const [rule, parent, child, merged] of ROWS) {
      expect(ruleLoosens(rule, parent as never, merged as never), rule).toBe(false);
      expect(ruleLoosens(rule, child as never, merged as never), rule).toBe(false);
    }
  });

  it("the schema refuses unknown rules and malformed values", () => {
    expect(governancePolicySchema.safeParse({ allowEverything: true }).success).toBe(false);
    expect(governancePolicySchema.safeParse({ deniedTools: ["no-slash"] }).success).toBe(false);
    expect(governancePolicySchema.safeParse({ piiMode: "lenient" }).success).toBe(false);
  });
});

describe("the fold and setBy", () => {
  const layers: PolicyLayerInput[] = [
    { level: "use_case", subjectId: "uc", policy: { maxBudgetUsd: 10 } },
    { level: "org", subjectId: null, policy: { allowedAgents: ["a", "b", "c"], maxBudgetUsd: 1000, requirePlanGate: true } },
    { level: "business_unit", subjectId: "bu", policy: { allowedAgents: ["a", "b"], maxBudgetUsd: 1000 } },
    { level: "project", subjectId: "p", policy: { allowedAgents: ["a"] } },
  ];
  const eff = Object.fromEntries(effectivePolicy(layers).map((e) => [e.rule, e]));

  it("folds root first whatever the input order, naming the level that last tightened each rule", () => {
    expect(eff.allowedAgents).toMatchObject({ value: ["a"], setBy: { level: "project", subjectId: "p" } });
    expect(eff.maxBudgetUsd).toMatchObject({ value: 10, setBy: { level: "use_case", subjectId: "uc" } });
    // an equal value lower down does not take the credit
    expect(eff.maxBudgetUsd!.setAt.map((s) => s.level)).toEqual(["org", "business_unit", "use_case"]);
    expect(eff.requirePlanGate).toMatchObject({ value: true, setBy: { level: "org" } });
    expect(eff.piiMode).toMatchObject({ value: null, setBy: null, setAt: [] });
  });

  it("returns every rule, in the table's order (a stable shape agents can read)", () => {
    expect(effectivePolicy([]).map((e) => e.rule)).toEqual(POLICY_RULE_NAMES);
  });
});

describe("tighten-only and relaxations", () => {
  const parent = effectivePolicy([{ level: "org", subjectId: null, policy: { allowedAgents: ["a", "b"], maxBudgetUsd: 100, requireHumanSignoff: true } }]);

  it("a child that narrows passes; each rule it widens is named", () => {
    expect(policyWidenings(parent, { allowedAgents: ["a"], maxBudgetUsd: 50 })).toEqual([]);
    expect(policyWidenings(parent, { allowedAgents: ["a", "z"], maxBudgetUsd: 500, requireHumanSignoff: false })).toEqual([
      { rule: "allowedAgents", inherited: ["a", "b"], attempted: ["a", "z"] },
      { rule: "maxBudgetUsd", inherited: 100, attempted: 500 },
      { rule: "requireHumanSignoff", inherited: true, attempted: false },
    ]);
    // a rule the parent leaves unset is the child's to set
    expect(policyWidenings(parent, { piiMode: "log" })).toEqual([]);
  });

  it("an edit that loosens a layer against its previous self is a relaxation; removing a rule counts", () => {
    const before: GovernancePolicy = { maxBudgetUsd: 100, piiMode: "block", allowedAgents: ["a"] };
    expect(layerRelaxations(before, { maxBudgetUsd: 50, piiMode: "block", allowedAgents: ["a"] })).toEqual({});
    expect(layerRelaxations(before, { maxBudgetUsd: 150, allowedAgents: ["a", "b"] })).toEqual({ maxBudgetUsd: 150, piiMode: null, allowedAgents: ["a", "b"] });
    expect(layerRelaxations(before, null)).toEqual({ maxBudgetUsd: null, piiMode: null, allowedAgents: null });
    expect(layerRelaxations(null, { maxBudgetUsd: 1 })).toEqual({});
  });
});
