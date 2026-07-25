import { describe, expect, it } from "vitest";
import {
  classifyComplexity,
  estimateTokens,
  routeModel,
  type CandidateAgent,
  type RouteModelInput,
} from "./index.js";

// Tiered fleet: haiku-ish (cheap, tier 0) → sonnet-ish (tier 1) → opus-ish (tier 2).
const cheap: CandidateAgent = { id: "a-cheap", tier: 0, costPerMTokIn: 1, costPerMTokOut: 5 };
const mid: CandidateAgent = { id: "a-mid", tier: 1, costPerMTokIn: 3, costPerMTokOut: 15 };
const big: CandidateAgent = { id: "a-big", tier: 2, costPerMTokIn: 15, costPerMTokOut: 75 };

const est = { in: 1000, out: 1000 };

function base(overrides: Partial<RouteModelInput> = {}): RouteModelInput {
  return {
    requestedAgentId: "a-big",
    candidates: [cheap, mid, big],
    routingMode: "automatic",
    complexity: "low",
    estimate: est,
    ...overrides,
  };
}

describe("classifyComplexity", () => {
  it("treats missing input as high (no signal, no downgrade)", () => {
    expect(classifyComplexity(undefined)).toBe("high");
    expect(classifyComplexity("")).toBe("high");
    expect(classifyComplexity("   ")).toBe("high");
  });

  it("classifies short single-line prompts low", () => {
    expect(classifyComplexity("what is the capital of France?")).toBe("low");
  });

  it("classifies long or code-heavy prompts high", () => {
    expect(classifyComplexity("x".repeat(5000))).toBe("high");
    expect(classifyComplexity("refactor this:\n```ts\n" + "x".repeat(900) + "\n```")).toBe("high");
  });

  it("classifies the middle ground medium", () => {
    expect(classifyComplexity("line one\nline two\nline three of a moderately sized request")).toBe("medium");
  });
});

describe("estimateTokens", () => {
  it("scales input with text length and output with complexity", () => {
    const low = estimateTokens("abcd".repeat(100), "low");
    expect(low.in).toBe(300); // 400 chars / 4 + 200 overhead
    expect(low.out).toBe(300);
    expect(estimateTokens(null, "high").out).toBe(2000);
  });
});

describe("routeModel", () => {
  it("routes a low-complexity request to the cheapest candidate with exact savings", () => {
    const d = routeModel(base());
    expect(d.effect).toBe("routed");
    expect(d.selectedAgentId).toBe("a-cheap");
    expect(d.baselineAgentId).toBe("a-big");
    // baseline: (1000*15 + 1000*75)/1e6 = 0.09; cheap: (1000*1 + 1000*5)/1e6 = 0.006
    expect(d.estimatedCostSavedUsd).toBeCloseTo(0.084, 6);
    expect(d.estimatedTokensSaved).toBe(0);
    expect(d.ruleChain.map((t) => t.rule)).toEqual([
      "routing-mode",
      "baseline-entitled",
      "cost-sensitivity",
      "complexity-floor",
      "cheapest-eligible",
    ]);
  });

  it("passthrough mode disables routing entirely (§12 off switch)", () => {
    const d = routeModel(base({ routingMode: "passthrough" }));
    expect(d.effect).toBe("passthrough");
    expect(d.selectedAgentId).toBe("a-big");
    expect(d.ruleId).toBe("routing-mode");
    expect(d.estimatedCostSavedUsd).toBe(0);
  });

  it("quality-sensitive requests are never downgraded (§9)", () => {
    const d = routeModel(base({ costSensitivity: "quality-sensitive" }));
    expect(d.effect).toBe("passthrough");
    expect(d.ruleId).toBe("cost-sensitivity");
  });

  it("medium complexity floors at one tier below the baseline", () => {
    const d = routeModel(base({ complexity: "medium" }));
    expect(d.selectedAgentId).toBe("a-mid"); // tier 1 = floor; tier-0 cheap is below it
  });

  it("high complexity only allows a same-tier cheaper substitute", () => {
    const bigCheaper: CandidateAgent = { id: "a-big2", tier: 2, costPerMTokIn: 10, costPerMTokOut: 50 };
    const d = routeModel(base({ complexity: "high", candidates: [cheap, mid, big, bigCheaper] }));
    expect(d.effect).toBe("routed");
    expect(d.selectedAgentId).toBe("a-big2");
    const none = routeModel(base({ complexity: "high" }));
    expect(none.effect).toBe("passthrough");
    expect(none.ruleId).toBe("cheapest-eligible");
  });

  it("cost-sensitive lowers the complexity floor one extra tier (§9)", () => {
    const d = routeModel(base({ complexity: "medium", costSensitivity: "cost-sensitive" }));
    expect(d.selectedAgentId).toBe("a-cheap"); // floor 1-1=0 admits the tier-0 model
  });

  it("never selects above the governance ceiling even if a candidate slips through (§12)", () => {
    const d = routeModel(
      base({ requestedAgentId: "a-mid", complexity: "high", ceilingTier: 1, candidates: [mid, big] }),
    );
    expect(d.selectedAgentId).toBe("a-mid");
    for (const t of d.ruleChain) expect(t.agentId === "a-big").toBe(false);
  });

  it("never routes upward to a more capable tier, even when it is cheaper", () => {
    const weirdBig: CandidateAgent = { id: "a-odd", tier: 2, costPerMTokIn: 0.1, costPerMTokOut: 0.1 };
    const d = routeModel(base({ requestedAgentId: "a-mid", candidates: [mid, weirdBig], complexity: "low" }));
    expect(d.effect).toBe("passthrough");
  });

  it("unpriced baseline means passthrough, not a guess", () => {
    const unpriced: CandidateAgent = { id: "a-x", tier: 2, costPerMTokIn: null, costPerMTokOut: null };
    const d = routeModel(base({ requestedAgentId: "a-x", candidates: [cheap, unpriced] }));
    expect(d.effect).toBe("passthrough");
    expect(d.reason).toContain("unpriced");
  });

  it("unpriced candidates are never routing targets", () => {
    const unpriced: CandidateAgent = { id: "a-x", tier: 0, costPerMTokIn: null, costPerMTokOut: null };
    const d = routeModel(base({ candidates: [unpriced, mid, big] }));
    expect(d.selectedAgentId).toBe("a-mid");
  });

  it("fails safe to passthrough when the requested agent is missing from candidates", () => {
    const d = routeModel(base({ requestedAgentId: "a-ghost" }));
    expect(d.effect).toBe("passthrough");
    expect(d.selectedAgentId).toBe("a-ghost");
    expect(d.ruleId).toBe("baseline-entitled");
  });

  it("reports passthrough when the requested model is already cheapest", () => {
    const d = routeModel(base({ requestedAgentId: "a-cheap" }));
    expect(d.effect).toBe("passthrough");
    expect(d.ruleId).toBe("cheapest-eligible");
    expect(d.estimatedCostSavedUsd).toBe(0);
  });

  it("tie-break prefers the more capable model at equal price", () => {
    const twin: CandidateAgent = { id: "a-twin", tier: 1, costPerMTokIn: 1, costPerMTokOut: 5 };
    const d = routeModel(base({ candidates: [cheap, twin, big] }));
    expect(d.selectedAgentId).toBe("a-twin");
  });
});
