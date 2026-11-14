/**
 * ADR-0239 slice 2 — the Cedar approval-rule MATCH against the hand-written one (`matchingApprovalRules`).
 *
 * The differential properties generate rules and calls from small pools (so matches, near-misses and every scope
 * shape occur often) and require the two to agree: on the matched set in precedence order, and on the whole kernel
 * Decision.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import * as cedar from "@cedar-policy/cedar-wasm/nodejs";
import {
  APPROVAL_RULE_ENGINE_ERROR_RULE_ID,
  evaluate,
  matchingApprovalRules,
  matchingApprovalRulesWith,
  type ApprovalRule,
  type ApprovalRuleEvaluator,
  type EvaluationInput,
} from "./index.js";
import {
  APPROVAL_RULE_CEDAR_SCHEMA_TEXT,
  approvalRuleCedarCallCount,
  approvalRulePolicySet,
  cedarApprovalRuleEvaluator,
  cedarApprovalRuleEvaluatorUnfiltered,
} from "./approval-rule-cedar.js";

const USERS = ["u-1", "u-2", 'u-"3'];
const SERVERS = ["s-1", "s-2"];
const TOOLS = ["read_rows", "write_rows", 'x") || true || ("'];
const MODES = ["hosted", "byoc", "air_gapped"] as const;

const arbRule: fc.Arbitrary<ApprovalRule> = fc.record({
  id: fc.uuid(),
  userId: fc.oneof(fc.constantFrom(...USERS), fc.constant(null)),
  serverId: fc.oneof(fc.constantFrom(...SERVERS), fc.constant(null)),
  roleId: fc.option(fc.constant("r-1"), { nil: undefined }),
  teamId: fc.option(fc.constant("t-1"), { nil: undefined }),
  scope: fc.option(fc.constantFrom("user", "role", "team", "fleet"), { nil: undefined }),
  serverScope: fc.option(fc.constantFrom("server", "all"), { nil: undefined }),
  deployMode: fc.oneof(fc.constantFrom(...MODES), fc.constant(null), fc.constant(undefined)),
  // `undefined` is not in the type, but a row read loosely can carry it: it must match no tool on both engines
  toolName: fc.oneof(fc.constantFrom(...TOOLS), fc.constant(null), fc.constant(undefined as unknown as null)),
  writeOnly: fc.boolean(),
  approverUserId: fc.constantFrom("a-1", "a-2"),
}) as fc.Arbitrary<ApprovalRule>;

interface Call {
  userId: string;
  serverId: string;
  toolName: string;
  kind: "read" | "write";
  deployContext: readonly string[] | null | undefined;
}

const arbCall: fc.Arbitrary<Call> = fc.record({
  userId: fc.constantFrom(...USERS),
  serverId: fc.constantFrom(...SERVERS),
  toolName: fc.constantFrom(...TOOLS),
  kind: fc.constantFrom("read", "write") as fc.Arbitrary<"read" | "write">,
  deployContext: fc.oneof(fc.constant(null), fc.constant(undefined), fc.subarray([...MODES])) as fc.Arbitrary<readonly string[] | null | undefined>,
});

const ctxOf = (c: Call) => ({ userId: c.userId, serverId: c.serverId, tool: { serverId: c.serverId, name: c.toolName, kind: c.kind }, deployContext: c.deployContext });

function inputFor(call: Call, rules: ApprovalRule[], approvalRuleEvaluator?: ApprovalRuleEvaluator): EvaluationInput {
  return {
    userId: call.userId,
    serverId: call.serverId,
    execution: { mode: "normal" },
    tool: { serverId: call.serverId, name: call.toolName, kind: call.kind },
    toolGrants: [{ id: "g-1", userId: call.userId, serverId: call.serverId, toolName: call.toolName }],
    serverGrants: [],
    approvalRules: rules,
    deployContext: call.deployContext,
    ...(approvalRuleEvaluator ? { approvalRuleEvaluator } : {}),
    actor: null,
  } as EvaluationInput;
}

const PROPERTY_TIMEOUT_MS = 120_000;
const ids = (rs: readonly ApprovalRule[]) => rs.map((r) => r.id);

describe("ADR-0239 slice 2 — Cedar approval-rule matching agrees with the hand-written predicate", () => {
  it("returns the same matched rules, in the same precedence order", () => {
    fc.assert(
      fc.property(arbCall, fc.array(arbRule, { maxLength: 12 }), (call, rules) => {
        const legacy = ids(matchingApprovalRules(rules, ctxOf(call)));
        for (const ev of [cedarApprovalRuleEvaluator, cedarApprovalRuleEvaluatorUnfiltered]) {
          const v = matchingApprovalRulesWith(ev, rules, ctxOf(call));
          expect(v.kind).toBe("matched");
          if (v.kind === "matched") expect(ids(v.rules)).toEqual(legacy);
        }
      }),
      { numRuns: 5000 },
    );
  }, PROPERTY_TIMEOUT_MS);

  it("produces the same kernel Decision (effect, rule id, approver, trace and reason)", () => {
    fc.assert(
      fc.property(arbCall, fc.array(arbRule, { maxLength: 8 }), (call, rules) => {
        expect(evaluate(inputFor(call, rules, cedarApprovalRuleEvaluator))).toEqual(evaluate(inputFor(call, rules)));
      }),
      { numRuns: 2000 },
    );
  }, PROPERTY_TIMEOUT_MS);

  it("agrees past the cached policy-set size", () => {
    fc.assert(
      fc.property(arbCall, fc.array(arbRule, { minLength: 257, maxLength: 300 }), (call, rules) => {
        const v = matchingApprovalRulesWith(cedarApprovalRuleEvaluatorUnfiltered, rules, ctxOf(call));
        expect(v.kind === "matched" ? ids(v.rules) : v).toEqual(ids(matchingApprovalRules(rules, ctxOf(call))));
      }),
      { numRuns: 10 },
    );
  }, PROPERTY_TIMEOUT_MS);

  it("makes no wasm call when every rule is on another server or for another user", () => {
    const elsewhere: ApprovalRule[] = Array.from({ length: 500 }, (_, i) => ({
      id: `ar-${i}`,
      userId: i % 2 ? "u-2" : null,
      serverId: "s-2",
      scope: i % 2 ? "user" : "fleet",
      toolName: null,
      writeOnly: false,
      approverUserId: "a-1",
    }));
    const before = approvalRuleCedarCallCount();
    const v = matchingApprovalRulesWith(cedarApprovalRuleEvaluator, elsewhere, ctxOf({ userId: "u-1", serverId: "s-1", toolName: "read_rows", kind: "read", deployContext: null }));
    expect(v).toEqual({ kind: "matched", rules: [] });
    expect(approvalRuleCedarCallCount()).toBe(before);
  });
});

describe("ADR-0239 slice 2 — fail closed", () => {
  const call: Call = { userId: "u-1", serverId: "s-1", toolName: "write_rows", kind: "write", deployContext: null };
  const rule: ApprovalRule = { id: "ar-1", userId: "u-1", serverId: "s-1", toolName: null, writeOnly: false, approverUserId: "a-1" };

  it("an evaluator error refuses the call (never reads as 'no rule binds')", () => {
    const broken: ApprovalRuleEvaluator = { engine: "broken", matching: () => ({ kind: "error", message: "engine down" }) };
    const d = evaluate(inputFor(call, [rule], broken));
    expect(d).toMatchObject({ effect: "deny", ruleId: APPROVAL_RULE_ENGINE_ERROR_RULE_ID });
    expect(d.reason).toContain("engine down");
  });

  it("an evaluator that throws refuses the call", () => {
    const throwing: ApprovalRuleEvaluator = {
      engine: "throwing",
      matching() {
        throw new Error("wasm trap");
      },
    };
    expect(evaluate(inputFor(call, [rule], throwing))).toMatchObject({ effect: "deny", ruleId: APPROVAL_RULE_ENGINE_ERROR_RULE_ID });
  });

  it("a matching rule pauses the call on Cedar exactly as before", () => {
    expect(evaluate(inputFor(call, [rule], cedarApprovalRuleEvaluator))).toMatchObject({ effect: "require_approval", ruleId: "ar-1", approverUserId: "a-1" });
  });
});

describe("ADR-0239 slice 2 — the policies", () => {
  it("validate against the schema, and no stored value reaches policy text", () => {
    const answer = cedar.validate({
      schema: APPROVAL_RULE_CEDAR_SCHEMA_TEXT,
      policies: { staticPolicies: approvalRulePolicySet(3) },
      validationSettings: { mode: "strict" },
    });
    expect(answer.type).toBe("success");
    if (answer.type === "success") expect(answer.validationErrors).toEqual([]);
    for (const text of Object.values(approvalRulePolicySet(3))) expect(text).not.toMatch(/u-1|s-1|read_rows/);
  });
});
