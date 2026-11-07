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
  RATE_LIMIT_CEDAR_SCHEMA_TEXT,
  rateLimitPolicySet,
} from "./rate-limit-cedar.js";

const USERS = ["u-1", "u-2", 'u-"3'];
const SERVERS = ["s-1", "s-2"];
const TOOLS = ["read_rows", "write_rows", 'x") || true || ("'];
const MODES = ["hosted", "byoc", "air_gapped"] as const;

const arbLimit: fc.Arbitrary<RateLimit> = fc.record({
  id: fc.uuid(),
  userId: fc.oneof(fc.constantFrom(...USERS), fc.constant(null)),
  serverId: fc.oneof(fc.constantFrom(...SERVERS), fc.constant(null)),
  roleId: fc.option(fc.constant("r-1"), { nil: undefined }),
  teamId: fc.option(fc.constant("t-1"), { nil: undefined }),
  scope: fc.option(fc.constantFrom("user", "role", "team", "fleet"), { nil: undefined }),
  serverScope: fc.option(fc.constantFrom("server", "all"), { nil: undefined }),
  deployMode: fc.oneof(fc.constantFrom(...MODES), fc.constant(null), fc.constant(undefined)),
  toolName: fc.oneof(fc.constantFrom(...TOOLS), fc.constant(null)),
  maxCalls: fc.integer({ min: 0, max: 4 }),
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
        const onCedar = cedarRateLimitEvaluator.firstExhausted(limits, ctx);
        expect(onCedar).toEqual(legacy);
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

  it("agrees past the cached policy-set size", () => {
    fc.assert(
      fc.property(arbCall, fc.array(arbLimit, { minLength: 257, maxLength: 300 }), (call, limits) => {
        const ctx = { ...call, deployContext: call.deployContext };
        expect(cedarRateLimitEvaluator.firstExhausted(limits, ctx)).toEqual(
          legacyRateLimitEvaluator.firstExhausted(limits, ctx),
        );
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
