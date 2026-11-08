/**
 * ADR-0239 slice 1 — the rate-limit evaluator switch. Cedar by default, the hand-written evaluator only when
 * explicitly asked for, and an unrecognised value refuses the boot.
 */
import { describe, expect, it } from "vitest";
import { evaluate, legacyRateLimitEvaluator, RATE_LIMIT_ENGINE_ERROR_RULE_ID } from "@regulait/policy-kernel";
import { cedarRateLimitEvaluator } from "@regulait/policy-kernel/rate-limit-cedar";
import {
  RateLimitEvaluatorBootError,
  describeRateLimitEvaluator,
  resolveRateLimitEvaluator,
} from "./rate-limit-evaluator.js";

describe("ADR-0239 — REGULAIT_RATE_LIMIT_EVALUATOR", () => {
  it("defaults to Cedar", () => {
    expect(resolveRateLimitEvaluator({})).toBe(cedarRateLimitEvaluator);
    expect(resolveRateLimitEvaluator({ REGULAIT_RATE_LIMIT_EVALUATOR: "" })).toBe(cedarRateLimitEvaluator);
    expect(resolveRateLimitEvaluator({ REGULAIT_RATE_LIMIT_EVALUATOR: " Cedar " })).toBe(cedarRateLimitEvaluator);
  });

  it("keeps the hand-written evaluator only by explicit setting, and says so in the boot log", () => {
    const ev = resolveRateLimitEvaluator({ REGULAIT_RATE_LIMIT_EVALUATOR: "legacy" });
    expect(ev).toBe(legacyRateLimitEvaluator);
    expect(describeRateLimitEvaluator(ev)).toContain("legacy");
    expect(describeRateLimitEvaluator(cedarRateLimitEvaluator)).toMatch(/^Cedar \(cedar-wasm@/);
  });

  it("refuses the boot on an unrecognised value", () => {
    expect(() => resolveRateLimitEvaluator({ REGULAIT_RATE_LIMIT_EVALUATOR: "off" })).toThrow(
      RateLimitEvaluatorBootError,
    );
  });

  it("an exhausted limit denies through the Cedar evaluator, as it did through the hand-written one", () => {
    for (const rateLimitEvaluator of [cedarRateLimitEvaluator, legacyRateLimitEvaluator]) {
      const d = evaluate({
        userId: "u-1",
        serverId: "s-1",
        execution: { mode: "normal" },
        tool: { serverId: "s-1", name: "query", kind: "read" },
        toolGrants: [{ id: "g-1", userId: "u-1", serverId: "s-1", toolName: "query" }],
        serverGrants: [],
        rateLimits: [
          { id: "rl-1", userId: "u-1", serverId: "s-1", toolName: null, maxCalls: 3, windowSeconds: 60, currentCount: 3 },
        ],
        rateLimitEvaluator,
        actor: null,
      });
      expect(d.effect).toBe("deny");
      expect(d.ruleId).toBe("rl-1");
      expect(d.ruleId).not.toBe(RATE_LIMIT_ENGINE_ERROR_RULE_ID);
    }
  });
});
