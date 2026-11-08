/**
 * ADR-0239 slice 1 — the Cedar rate-limit evaluator against the hand-written one.
 *
 * The differential properties generate limits and calls from small pools (so matches, near-misses and every scope
 * shape occur often) and require the two evaluators to agree: on the raw verdict, and on the whole kernel Decision.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import * as cedar from "@cedar-policy/cedar-wasm/nodejs";
import {
  evaluate,
  legacyRateLimitEvaluator,
  RATE_LIMIT_ENGINE_ERROR_RULE_ID,
  type EvaluationInput,
  type RateLimit,
  type RateLimitEvaluator,
} from "./index.js";
import {
  cedarRateLimitEvaluator,
  cedarRateLimitEvaluatorUnfiltered,
  RATE_LIMIT_CEDAR_SCHEMA_TEXT,
  rateLimitCedarCallCount,
  rateLimitPolicySet,
} from "./rate-limit-cedar.js";

const USERS = ["u-1", "u-2", 'u-"3'];
const SERVERS = ["s-1", "s-2"];
const TOOLS = ["read_rows", "write_rows", 'x") || true || ("'];
const MODES = ["hosted", "byoc", "air_gapped"] as const;

const arbLimit: fc.Arbitrary<RateLimit> = fc.record({
  id: fc.uuid(),
  userId: fc.oneof(fc.constantFrom(...USERS), fc.constant(null), fc.constant(undefined)),
  serverId: fc.oneof(fc.constantFrom(...SERVERS), fc.constant(null), fc.constant(undefined)),
  roleId: fc.option(fc.constant("r-1"), { nil: undefined }),
  teamId: fc.option(fc.constant("t-1"), { nil: undefined }),
  scope: fc.option(fc.constantFrom("user", "role", "team", "fleet"), { nil: undefined }),
  serverScope: fc.option(fc.constantFrom("server", "all"), { nil: undefined }),
  deployMode: fc.oneof(fc.constantFrom(...MODES), fc.constant(null), fc.constant(undefined)),
  toolName: fc.oneof(fc.constantFrom(...TOOLS), fc.constant(null), fc.constant(undefined)),
  maxCalls: fc.integer({ min: -2, max: 4 }),
  windowSeconds: fc.constantFrom(60, 3600),
  currentCount: fc.integer({ min: 0, max: 5 }),
}) as fc.Arbitrary<RateLimit>;

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
  deployContext: fc.oneof(
    fc.constant(null),
    fc.constant(undefined),
    fc.subarray([...MODES]),
  ) as fc.Arbitrary<readonly string[] | null | undefined>,
});

function inputFor(
  call: Call,
  limits: RateLimit[],
  rateLimitEvaluator: RateLimitEvaluator,
): EvaluationInput {
  return {
    userId: call.userId,
    serverId: call.serverId,
    execution: { mode: "normal" },
    tool: { serverId: call.serverId, name: call.toolName, kind: call.kind },
    toolGrants: [{ id: "g-1", userId: call.userId, serverId: call.serverId, toolName: call.toolName }],
    serverGrants: [],
    rateLimits: limits,
    deployContext: call.deployContext,
    rateLimitEvaluator,
    actor: null,
  } as EvaluationInput;
}

/** The property tests make thousands of wasm calls; on a loaded CI runner that outlasts vitest's 5 s default. */
const PROPERTY_TIMEOUT_MS = 120_000;

describe("ADR-0239 — Cedar rate limits agree with the hand-written evaluator", () => {
  it("returns the same verdict on a large generated input set", () => {
    fc.assert(
      fc.property(arbCall, fc.array(arbLimit, { maxLength: 12 }), (call, limits) => {
        const ctx = {
          userId: call.userId,
          serverId: call.serverId,
          toolName: call.toolName,
          deployContext: call.deployContext,
        };
        const legacy = legacyRateLimitEvaluator.firstExhausted(limits, ctx);
        // ADR-0239 review finding 1: the filtered default and the unfiltered engine path both agree with legacy,
        // and the reported limit is the caller's own object
        const onCedar = cedarRateLimitEvaluator.firstExhausted(limits, ctx);
        const unfiltered = cedarRateLimitEvaluatorUnfiltered.firstExhausted(limits, ctx);
        expect(onCedar).toEqual(legacy);
        expect(unfiltered).toEqual(legacy);
        if (legacy.kind === "exhausted" && onCedar.kind === "exhausted") expect(onCedar.limit).toBe(legacy.limit);
      }),
      { numRuns: 5000 },
    );
  }, PROPERTY_TIMEOUT_MS);

  it("produces the same kernel Decision (effect, rule id, trace and reason)", () => {
    fc.assert(
      fc.property(arbCall, fc.array(arbLimit, { maxLength: 8 }), (call, limits) => {
        const a = evaluate(inputFor(call, limits, legacyRateLimitEvaluator));
        const b = evaluate(inputFor(call, limits, cedarRateLimitEvaluator));
        expect(b).toEqual(a);
      }),
      { numRuns: 2000 },
    );
  }, PROPERTY_TIMEOUT_MS);

  it("makes no wasm call when no limit is exhausted", () => {
    const calm: RateLimit[] = Array.from({ length: 1000 }, (_, i) => ({
      id: `rl-${i}`,
      userId: "u-1",
      serverId: "s-1",
      toolName: null,
      maxCalls: 10,
      windowSeconds: 60,
      currentCount: 3,
    }));
    const before = rateLimitCedarCallCount();
    const ctx = { userId: "u-1", serverId: "s-1", toolName: "read_rows", deployContext: null };
    expect(cedarRateLimitEvaluator.firstExhausted(calm, ctx)).toEqual({ kind: "none" });
    expect(rateLimitCedarCallCount()).toBe(before);
    // one exhausted limit among them: one call, and Cedar names it
    const hot = [...calm.slice(0, 500), { ...calm[0]!, id: "rl-hot", currentCount: 10 }, ...calm.slice(500)];
    const v = cedarRateLimitEvaluator.firstExhausted(hot, ctx);
    expect(v).toEqual({ kind: "exhausted", limit: hot[500] });
    expect(rateLimitCedarCallCount()).toBe(before + 1);
  });

  it("agrees past the cached policy-set size", () => {
    fc.assert(
      fc.property(arbCall, fc.array(arbLimit, { minLength: 257, maxLength: 300 }), (call, limits) => {
        const ctx = { ...call, deployContext: call.deployContext };
        const legacy = legacyRateLimitEvaluator.firstExhausted(limits, ctx);
        expect(cedarRateLimitEvaluator.firstExhausted(limits, ctx)).toEqual(legacy);
        expect(cedarRateLimitEvaluatorUnfiltered.firstExhausted(limits, ctx)).toEqual(legacy);
      }),
      { numRuns: 20 },
    );
  }, PROPERTY_TIMEOUT_MS);
});

describe("ADR-0239 — the Cedar rate-limit policies", () => {
  it("validate against their schema", () => {
    const answer = cedar.validate({
      schema: RATE_LIMIT_CEDAR_SCHEMA_TEXT,
      policies: { staticPolicies: rateLimitPolicySet(3) },
    });
    expect(answer.type).toBe("success");
    if (answer.type === "success") expect(answer.validationErrors).toEqual([]);
  });

  it("carry no stored value in their source", () => {
    const text = Object.values(rateLimitPolicySet(4)).join("\n");
    for (const v of [...USERS, ...SERVERS, ...TOOLS]) expect(text).not.toContain(v);
  });
});

describe("ADR-0239 — default-deny holds when the rate-limit evaluator fails", () => {
  const call: Call = { userId: "u-1", serverId: "s-1", toolName: "read_rows", kind: "read" as const, deployContext: null };
  const limit: RateLimit = {
    id: "rl-1",
    userId: "u-1",
    serverId: "s-1",
    toolName: null,
    maxCalls: 10,
    windowSeconds: 60,
    currentCount: 1.5,
  };

  it("denies when Cedar cannot represent a count (the legacy evaluator would allow)", () => {
    expect(evaluate(inputFor(call, [limit], legacyRateLimitEvaluator)).effect).toBe("allow");
    const d = evaluate(inputFor(call, [limit], cedarRateLimitEvaluator));
    expect(d.effect).toBe("deny");
    expect(d.ruleId).toBe(RATE_LIMIT_ENGINE_ERROR_RULE_ID);
    expect(d.ruleChain.at(-1)).toEqual({ rule: "rate-limit", outcome: "deny", grantId: RATE_LIMIT_ENGINE_ERROR_RULE_ID });
  });

  it("denies when an evaluator throws", () => {
    const throwing: RateLimitEvaluator = {
      engine: "broken",
      firstExhausted() {
        throw new Error("boom");
      },
    };
    const d = evaluate(inputFor(call, [{ ...limit, currentCount: 1 }], throwing));
    expect(d.effect).toBe("deny");
    expect(d.ruleId).toBe(RATE_LIMIT_ENGINE_ERROR_RULE_ID);
    expect(d.reason).toContain("boom");
  });

  it("does not call the evaluator when there are no limits", () => {
    const throwing: RateLimitEvaluator = {
      engine: "broken",
      firstExhausted() {
        throw new Error("must not run");
      },
    };
    expect(evaluate(inputFor(call, [], throwing)).effect).toBe("allow");
  });
});
