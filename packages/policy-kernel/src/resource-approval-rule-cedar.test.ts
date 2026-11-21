/**
 * ADR-0239 slice 2b — the Cedar approval-rule MATCH for model, connector and A2A calls against the hand-written one
 * (`matchingResourceApprovalRules`).
 *
 * The differential properties generate rules and calls from small pools (so matches, near-misses, every resource
 * binding and both write kinds occur often) and require the two to agree: on the matched set in specificity order, and
 * on the whole `composeResourceDecision` answer.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import * as cedar from "@cedar-policy/cedar-wasm/nodejs";
import {
  composeResourceDecision,
  matchingResourceApprovalRules,
  matchingResourceApprovalRulesWith,
  RESOURCE_RULE_IDS,
  type AbacDecision,
  type ComposeResourceInput,
  type EntitlementDecision,
  type GovernedResource,
  type ResourceApprovalRule,
  type ResourceApprovalRuleEvaluator,
  type ResourceRateLimit,
} from "./index.js";
import {
  cedarResourceApprovalRuleEvaluator,
  cedarResourceApprovalRuleEvaluatorUnfiltered,
  perCallResourceApprovalRuleEvaluator,
  RESOURCE_APPROVAL_RULE_CEDAR_SCHEMA_TEXT,
  resourceApprovalRuleCedarCallCount,
  resourceApprovalRulePolicySet,
} from "./resource-approval-rule-cedar.js";

const TYPES = ["model", "connector", "a2a"] as const;
const IDS = ["r-1", "r-2", 'x") || true || ("'];

const arbRule: fc.Arbitrary<ResourceApprovalRule> = fc.record({
  id: fc.constantFrom("ar-a", "ar-b", "ar-c", "ar-d", "ar-e").chain((p) => fc.uuid().map((u) => `${p}-${u}`)),
  resourceType: fc.constantFrom(...TYPES),
  // `undefined` is not in the type, but a row read loosely can carry it: it must bind no resource on both engines
  resourceId: fc.oneof(fc.constantFrom(...IDS), fc.constant(null), fc.constant(undefined as unknown as null)),
  scope: fc.constantFrom("user", "role", "team", "fleet"),
  writeOnly: fc.boolean(),
  approverUserId: fc.constantFrom("a-1", "a-2"),
  approverName: fc.option(fc.constantFrom("Ana", "Bo"), { nil: undefined }),
}) as fc.Arbitrary<ResourceApprovalRule>;

const arbResource: fc.Arbitrary<GovernedResource> = fc.oneof(
  fc.record({ type: fc.constant("model" as const), id: fc.constantFrom(...IDS), mode: fc.constantFrom("chat", "execute") }),
  fc.record({ type: fc.constant("connector" as const), id: fc.constantFrom(...IDS), operation: fc.constantFrom("read" as const, "write" as const) }),
  fc.record({ type: fc.constant("a2a" as const), id: fc.constantFrom(...IDS), skillId: fc.option(fc.constant("s-1"), { nil: null }) }),
);

const arbBase: fc.Arbitrary<EntitlementDecision> = fc.constantFrom<EntitlementDecision>(
  { effect: "allow", ruleId: "g-1", reason: "granted", ruleChain: [{ rule: "allow-list", outcome: "allow", grantId: "g-1" }] },
  { effect: "deny", ruleId: "default-deny", reason: "no grant", ruleChain: [{ rule: "default-deny", outcome: "deny" }] },
  { effect: "require_approval", ruleId: "execution-require-approval", reason: "dial holds", ruleChain: [], approverUserId: "a-9" },
);

const arbAbac: fc.Arbitrary<AbacDecision | null> = fc.constantFrom<AbacDecision | null>(
  null,
  { effect: "permit" },
  { effect: "forbid", policyId: "pol-f" },
  { effect: "require_approval", policyId: "pol-h" },
);

const arbLimit = (resource: GovernedResource): fc.Arbitrary<ResourceRateLimit> =>
  fc.record({
    id: fc.constantFrom("lim-1", "lim-2"),
    resourceType: fc.constant(resource.type),
    resourceId: fc.oneof(fc.constant(resource.id), fc.constant(null)),
    scope: fc.constant("user" as const),
    maxCalls: fc.integer({ min: 1, max: 3 }),
    windowSeconds: fc.constantFrom(60, 3600),
    currentCount: fc.integer({ min: 0, max: 4 }),
  }) as fc.Arbitrary<ResourceRateLimit>;

const arbCompose: fc.Arbitrary<ComposeResourceInput> = arbResource.chain((resource) =>
  fc.record({
    resource: fc.constant(resource),
    base: arbBase,
    projectId: fc.option(fc.constant("p-1"), { nil: null }),
    attributionRequired: fc.boolean(),
    rateLimits: fc.array(arbLimit(resource), { maxLength: 2 }),
    approvalRules: fc.array(arbRule, { maxLength: 8 }),
    abacDecision: arbAbac,
    approvedApprovalId: fc.option(fc.constant("appr-1"), { nil: null }),
    canQueue: fc.boolean(),
  }),
);

const PROPERTY_TIMEOUT_MS = 120_000;
const ids = (rs: readonly ResourceApprovalRule[]) => rs.map((r) => r.id);

describe("ADR-0239 slice 2b — Cedar resource approval-rule matching agrees with the hand-written predicate", () => {
  it("returns the same matched rules, in the same specificity order", () => {
    fc.assert(
      fc.property(arbResource, fc.array(arbRule, { maxLength: 12 }), (resource, rules) => {
        const legacy = ids(matchingResourceApprovalRules(resource, rules));
        for (const ev of [cedarResourceApprovalRuleEvaluator, cedarResourceApprovalRuleEvaluatorUnfiltered, perCallResourceApprovalRuleEvaluator()]) {
          const v = matchingResourceApprovalRulesWith(ev, resource, rules);
          expect(v.kind).toBe("matched");
          if (v.kind === "matched") expect(ids(v.rules)).toEqual(legacy);
        }
      }),
      { numRuns: 5000 },
    );
  }, PROPERTY_TIMEOUT_MS);

  it("produces the same composeResourceDecision (effect, rule id, approver, trace, reason, matched ids)", () => {
    fc.assert(
      fc.property(arbCompose, (input) => {
        const legacy = composeResourceDecision(input);
        expect(composeResourceDecision({ ...input, approvalRuleEvaluator: cedarResourceApprovalRuleEvaluator })).toEqual(legacy);
        expect(composeResourceDecision({ ...input, approvalRuleEvaluator: perCallResourceApprovalRuleEvaluator() })).toEqual(legacy);
      }),
      { numRuns: 2000 },
    );
  }, PROPERTY_TIMEOUT_MS);

  it("agrees past the cached policy-set size", () => {
    fc.assert(
      fc.property(arbResource, fc.array(arbRule, { minLength: 257, maxLength: 300 }), (resource, rules) => {
        const v = matchingResourceApprovalRulesWith(cedarResourceApprovalRuleEvaluatorUnfiltered, resource, rules);
        expect(v.kind === "matched" ? ids(v.rules) : v).toEqual(ids(matchingResourceApprovalRules(resource, rules)));
      }),
      { numRuns: 10 },
    );
  }, PROPERTY_TIMEOUT_MS);

  it("makes no wasm call when no rule can bind (another type, or bound to another resource)", () => {
    const elsewhere: ResourceApprovalRule[] = Array.from({ length: 300 }, (_, i) => ({
      id: `ar-${i}`,
      resourceType: i % 2 ? "a2a" : "connector",
      resourceId: i % 2 ? null : "r-2",
      scope: "fleet",
      writeOnly: false,
      approverUserId: "a-1",
    }));
    const before = resourceApprovalRuleCedarCallCount();
    const v = matchingResourceApprovalRulesWith(cedarResourceApprovalRuleEvaluator, { type: "connector", id: "r-1", operation: "write" }, elsewhere);
    expect(v).toEqual({ kind: "matched", rules: [] });
    expect(resourceApprovalRuleCedarCallCount()).toBe(before);
  });
});

describe("ADR-0239 slice 2b — one batched Cedar request per governed call", () => {
  const resource: GovernedResource = { type: "connector", id: "r-1", operation: "write" };
  const rules: ResourceApprovalRule[] = [
    { id: "ar-wide", resourceType: "connector", resourceId: null, scope: "fleet", writeOnly: true, approverUserId: "a-2" },
    { id: "ar-one", resourceType: "connector", resourceId: "r-1", scope: "user", writeOnly: false, approverUserId: "a-1" },
  ];

  it("evaluates every rule in one request, and later reads of the same call reuse it", () => {
    const ev = perCallResourceApprovalRuleEvaluator();
    const before = resourceApprovalRuleCedarCallCount();
    const first = matchingResourceApprovalRulesWith(ev, resource, rules);
    const base: EntitlementDecision = { effect: "allow", ruleId: "g-1", reason: "granted", ruleChain: [] };
    const input: ComposeResourceInput = { resource, base, projectId: "p-1", attributionRequired: true, approvalRules: rules, approvalRuleEvaluator: ev, canQueue: true };
    const d1 = composeResourceDecision(input);
    const d2 = composeResourceDecision({ ...input, rateLimits: [] });
    expect(resourceApprovalRuleCedarCallCount() - before).toBe(1);
    expect(first.kind === "matched" && ids(first.rules)).toEqual(["ar-one", "ar-wide"]);
    expect(d1).toMatchObject({ effect: "require_approval", ruleId: "ar-one", approverUserId: "a-1", matchedApprovalRuleIds: ["ar-one", "ar-wide"] });
    expect(d2).toEqual(d1);
  });

  it("never reuses an answer for another call or a changed rule set", () => {
    const ev = perCallResourceApprovalRuleEvaluator();
    const read = matchingResourceApprovalRulesWith(ev, { ...resource, operation: "read" }, rules);
    const write = matchingResourceApprovalRulesWith(ev, resource, rules);
    const other = matchingResourceApprovalRulesWith(ev, { ...resource, id: "r-2" }, rules);
    const grown = [...rules, { ...rules[1]!, id: "ar-two" }];
    const more = matchingResourceApprovalRulesWith(ev, resource, grown);
    expect([read, write, other, more].map((v) => (v.kind === "matched" ? ids(v.rules) : v))).toEqual([
      ["ar-one"],
      ["ar-one", "ar-wide"],
      ["ar-wide"],
      ["ar-one", "ar-two", "ar-wide"],
    ]);
  });
});

describe("ADR-0239 slice 2b — fail closed", () => {
  const resource: GovernedResource = { type: "model", id: "r-1", mode: "chat" };
  const rule: ResourceApprovalRule = { id: "ar-1", resourceType: "model", resourceId: "r-1", scope: "user", writeOnly: false, approverUserId: "a-1" };
  const base: EntitlementDecision = { effect: "allow", ruleId: "g-1", reason: "granted", ruleChain: [] };
  const input = (approvalRuleEvaluator: ResourceApprovalRuleEvaluator): ComposeResourceInput => ({
    resource,
    base,
    projectId: "p-1",
    attributionRequired: true,
    approvalRules: [rule],
    approvalRuleEvaluator,
    approvedApprovalId: "appr-1",
    canQueue: true,
  });

  it("an evaluator error refuses the call, even with a consent in hand (never reads as 'no rule binds')", () => {
    const broken: ResourceApprovalRuleEvaluator = { engine: "broken", matching: () => ({ kind: "error", message: "engine down" }) };
    const d = composeResourceDecision(input(broken));
    expect(d).toMatchObject({ effect: "deny", ruleId: RESOURCE_RULE_IDS.approvalEngineError, matchedApprovalRuleIds: [] });
    expect(d.reason).toContain("engine down");
    expect(d.ruleChain.at(-1)).toEqual({ rule: RESOURCE_RULE_IDS.approvalRule, outcome: "deny", grantId: RESOURCE_RULE_IDS.approvalEngineError });
  });

  it("an evaluator that throws refuses the call", () => {
    const throwing: ResourceApprovalRuleEvaluator = {
      engine: "throwing",
      matching() {
        throw new Error("wasm trap");
      },
    };
    expect(composeResourceDecision(input(throwing))).toMatchObject({ effect: "deny", ruleId: RESOURCE_RULE_IDS.approvalEngineError });
  });

  it("an answer naming a rule it was not given refuses the call", () => {
    const lying: ResourceApprovalRuleEvaluator = { engine: "lying", matching: () => ({ kind: "matched", rules: [{ ...rule }] }) };
    expect(composeResourceDecision(input(lying))).toMatchObject({ effect: "deny", ruleId: RESOURCE_RULE_IDS.approvalEngineError });
  });

  it("an error is not kept by the per-call evaluator: the next read asks the engine again", () => {
    let calls = 0;
    const flaky: ResourceApprovalRuleEvaluator = { engine: "flaky", matching: () => (++calls === 1 ? { kind: "error", message: "once" } : { kind: "matched", rules: [rule] }) };
    const ev = perCallResourceApprovalRuleEvaluator(flaky);
    expect(matchingResourceApprovalRulesWith(ev, resource, [rule]).kind).toBe("error");
    expect(matchingResourceApprovalRulesWith(ev, resource, [rule]).kind).toBe("matched");
    expect(calls).toBe(2);
  });

  it("a binding rule holds a model call on Cedar exactly as before", () => {
    const d = composeResourceDecision({ ...input(cedarResourceApprovalRuleEvaluator), approvedApprovalId: null });
    expect(d).toMatchObject({ effect: "require_approval", ruleId: "ar-1", approverUserId: "a-1" });
  });
});

describe("ADR-0239 slice 2b — the policies", () => {
  it("validate against the schema, and no stored value reaches policy text", () => {
    const answer = cedar.validate({
      schema: RESOURCE_APPROVAL_RULE_CEDAR_SCHEMA_TEXT,
      policies: { staticPolicies: resourceApprovalRulePolicySet(3) },
      validationSettings: { mode: "strict" },
    });
    expect(answer.type).toBe("success");
    if (answer.type === "success") expect(answer.validationErrors).toEqual([]);
    for (const text of Object.values(resourceApprovalRulePolicySet(3))) expect(text).not.toMatch(/r-1|connector|model|a2a/);
  });
});
