/**
 * ADR-0239 — the rate-limit evaluator setting. Cedar is the only engine since decision 4 removed the hand-written
 * one (2026-11-14): `legacy` and any unrecognised value refuse the boot.
 */
import { describe, expect, it } from "vitest";
import { evaluate, RATE_LIMIT_ENGINE_ERROR_RULE_ID } from "@regulait/policy-kernel";
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

  it("refuses `legacy` at boot, naming the removal, and logs the Cedar engine", () => {
    expect(() => resolveRateLimitEvaluator({ REGULAIT_RATE_LIMIT_EVALUATOR: "legacy" })).toThrow(/was removed \(ADR-0239 decision 4\)/);
    expect(describeRateLimitEvaluator(cedarRateLimitEvaluator)).toMatch(/^Cedar \(cedar-wasm@/);
  });

  it("refuses the boot on an unrecognised value", () => {
    expect(() => resolveRateLimitEvaluator({ REGULAIT_RATE_LIMIT_EVALUATOR: "off" })).toThrow(
      RateLimitEvaluatorBootError,
    );
  });

  it("an exhausted limit denies through the Cedar evaluator; with no evaluator the kernel refuses", () => {
    for (const rateLimitEvaluator of [cedarRateLimitEvaluator]) {
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
    const none = evaluate({
      userId: "u-1",
      serverId: "s-1",
      execution: { mode: "normal" },
      tool: { serverId: "s-1", name: "query", kind: "read" },
      toolGrants: [{ id: "g-1", userId: "u-1", serverId: "s-1", toolName: "query" }],
      serverGrants: [],
      rateLimits: [{ id: "rl-1", userId: "u-1", serverId: "s-1", toolName: null, maxCalls: 3, windowSeconds: 60, currentCount: 0 }],
      actor: null,
    });
    expect(none).toMatchObject({ effect: "deny", ruleId: RATE_LIMIT_ENGINE_ERROR_RULE_ID });
  });
});
