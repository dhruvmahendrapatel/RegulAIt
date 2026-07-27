import { describe, expect, it } from "vitest";
import {
  classifyComplexity,
  compactionSavings,
  COMPACTION_RECENT_WINDOW_MESSAGES,
  DEFAULT_COMPACTION_THRESHOLD_TOKENS,
  planCompaction,
  planPromptCache,
  CACHE_READ_DISCOUNT,
  DEFAULT_MIN_CACHEABLE_TOKENS,
  selectTools,
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

describe("selectTools (lazy tool-loading §8)", () => {
  const tools = [
    { name: "get_time", description: "Returns the current time", manifestChars: 400 },
    { name: "write_note", description: "Writes a note to storage", manifestChars: 600 },
    { name: "search_issues", description: "Search project issues", manifestChars: 1000 },
  ];
  const base = { intent: "what time is it now", tools, routingMode: "automatic" as const };

  it("narrows the manifest to intent-relevant tools and prices the withheld chars", () => {
    const d = selectTools(base);
    expect(d.effect).toBe("narrowed");
    expect(d.selected).toEqual(["get_time"]);
    expect(d.withheld.sort()).toEqual(["search_issues", "write_note"]);
    expect(d.estimatedTokensSaved).toBe(400); // (600 + 1000) / 4
    expect(d.estimationBasis).toContain("withheld-tools");
    expect(d.ruleChain.map((t) => t.rule)).toEqual(["routing-mode", "intent-signal", "relevance-match"]);
  });

  it("no intent means the full entitled manifest (no signal, no narrowing)", () => {
    for (const intent of [null, undefined, "", "   ", "is it the a"]) {
      const d = selectTools({ ...base, intent });
      expect(d.effect).toBe("passthrough");
      expect(d.selected).toHaveLength(3);
      expect(d.estimatedTokensSaved).toBe(0);
    }
  });

  it("passthrough mode disables narrowing (§12 off switch)", () => {
    const d = selectTools({ ...base, routingMode: "passthrough" });
    expect(d.effect).toBe("passthrough");
    expect(d.ruleId).toBe("routing-mode");
    expect(d.selected).toHaveLength(3);
  });

  it("fails open to the full manifest when nothing matches the intent", () => {
    const d = selectTools({ ...base, intent: "deploy the kubernetes cluster" });
    expect(d.effect).toBe("passthrough");
    expect(d.ruleId).toBe("relevance-match");
    expect(d.selected).toHaveLength(3);
    expect(d.withheld).toHaveLength(0);
  });

  it("reports passthrough when every tool is relevant", () => {
    const d = selectTools({ ...base, intent: "time note issues" });
    expect(d.effect).toBe("passthrough");
    expect(d.selected).toHaveLength(3);
    expect(d.estimatedTokensSaved).toBe(0);
  });

  it("selection and withheld partition the input set — nothing invented, nothing lost", () => {
    const d = selectTools({ ...base, intent: "write a note" });
    const union = [...d.selected, ...d.withheld].sort();
    expect(union).toEqual(tools.map((t) => t.name).sort());
    expect(d.selected.every((n) => tools.some((t) => t.name === n))).toBe(true);
  });

  it("caps the matched set at maxTools, keeping the highest scorers", () => {
    const many = Array.from({ length: 5 }, (_, i) => ({
      name: `time_tool_${i}`,
      description: "time related",
      manifestChars: 100,
    }));
    const d = selectTools({ intent: "time", tools: [...many, tools[1]!], routingMode: "automatic", maxTools: 2 });
    expect(d.effect).toBe("narrowed");
    expect(d.selected).toHaveLength(2);
    expect(d.withheld).toHaveLength(4);
  });
});

describe("planCompaction", () => {
  const msgs = (...tokens: number[]) => tokens;

  it("does not compact under the threshold, and not AT the exact boundary either", () => {
    const under = planCompaction({ messageTokens: msgs(400, 400, 400), thresholdTokens: 1600 });
    expect(under.shouldCompact).toBe(false);
    expect(under.compactThroughIndex).toBe(-1);
    expect(under.historyTokens).toBe(1200);

    // exactly 1600 = still within — strictly-greater semantics
    const exact = planCompaction({
      messageTokens: msgs(400, 400, 400, 200, 100, 100),
      thresholdTokens: 1600,
    });
    expect(exact.historyTokens).toBe(1600);
    expect(exact.shouldCompact).toBe(false);

    const over = planCompaction({
      messageTokens: msgs(400, 400, 400, 200, 100, 101),
      thresholdTokens: 1600,
    });
    expect(over.shouldCompact).toBe(true);
  });

  it("compacts everything except the recent verbatim window", () => {
    const plan = planCompaction({
      messageTokens: msgs(500, 500, 500, 100, 100, 100, 100),
      thresholdTokens: 1600,
      recentWindowMessages: 4,
    });
    expect(plan.shouldCompact).toBe(true);
    // 7 messages, keep the last 4 → compact through index 2
    expect(plan.compactThroughIndex).toBe(2);
    expect(plan.historyTokens).toBe(1900);
  });

  it("never compacts when the history has no messages older than the window", () => {
    // over threshold but only 4 messages — the window covers them all
    const plan = planCompaction({
      messageTokens: msgs(900, 900, 900, 900),
      thresholdTokens: 1600,
      recentWindowMessages: 4,
    });
    expect(plan.shouldCompact).toBe(false);
    expect(plan.compactThroughIndex).toBe(-1);

    // fewer messages than the window, same answer
    const few = planCompaction({ messageTokens: msgs(2000), thresholdTokens: 1600 });
    expect(few.shouldCompact).toBe(false);
  });

  it("re-compaction: the existing summary counts toward the threshold and the index stays slice-relative", () => {
    // post-summary slice alone is under threshold; summary tokens tip it over
    const without = planCompaction({ messageTokens: msgs(300, 300, 300, 300, 300) });
    expect(without.shouldCompact).toBe(false);
    const plan = planCompaction({
      messageTokens: msgs(300, 300, 300, 300, 300),
      summaryTokens: 200,
    });
    expect(plan.historyTokens).toBe(1700);
    expect(plan.shouldCompact).toBe(true);
    // 5 post-summary messages, keep 4 → compact through slice index 0
    expect(plan.compactThroughIndex).toBe(0);
  });

  it("uses the documented defaults (1600 tokens, 4-message window)", () => {
    expect(DEFAULT_COMPACTION_THRESHOLD_TOKENS).toBe(1600);
    expect(COMPACTION_RECENT_WINDOW_MESSAGES).toBe(4);
    const plan = planCompaction({ messageTokens: [500, 500, 500, 500, 500] });
    expect(plan.shouldCompact).toBe(true);
    expect(plan.compactThroughIndex).toBe(0);
  });
});

describe("compactionSavings", () => {
  it("is omitted minus summary, floored at zero", () => {
    expect(compactionSavings(1000, 150)).toBe(850);
    expect(compactionSavings(100, 150)).toBe(0);
    expect(compactionSavings(0, 0)).toBe(0);
  });
});

describe("planPromptCache (prompt caching §8/§10)", () => {
  it("passthrough disables caching entirely (§12 off switch)", () => {
    const p = planPromptCache({ systemTokens: 5000, routingMode: "passthrough" });
    expect(p.cacheSystem).toBe(false);
    expect(p.ruleId).toBe("routing-mode");
    expect(p.estimatedTokensSaved).toBe(0);
    expect(p.reason).toContain("passthrough");
    expect(p.ruleChain).toEqual([{ rule: "routing-mode", outcome: "passthrough" }]);
  });

  it("a system prefix below the minimum (including null/0) is never marked cacheable", () => {
    for (const systemTokens of [null, undefined, 0, 1023]) {
      const p = planPromptCache({ systemTokens, routingMode: "automatic" });
      expect(p.cacheSystem).toBe(false);
      expect(p.ruleId).toBe("prefix-size");
      expect(p.ruleChain.at(-1)!.outcome).toBe("too-small");
      expect(p.estimatedTokensSaved).toBe(0);
      expect(p.reason).toContain(`${DEFAULT_MIN_CACHEABLE_TOKENS}`);
    }
  });

  it("a prefix at or above the minimum is marked cacheable and saves the full prefix per reuse", () => {
    const at = planPromptCache({ systemTokens: DEFAULT_MIN_CACHEABLE_TOKENS, routingMode: "automatic" });
    expect(at.cacheSystem).toBe(true);
    expect(at.ruleId).toBe("prefix-size");
    expect(at.ruleChain.at(-1)!.outcome).toBe("applied");
    expect(at.estimatedTokensSaved).toBe(DEFAULT_MIN_CACHEABLE_TOKENS);
    expect(at.estimationBasis).toContain("prompt-caching");

    const above = planPromptCache({ systemTokens: 8000, routingMode: "automatic" });
    expect(above.cacheSystem).toBe(true);
    expect(above.estimatedTokensSaved).toBe(8000); // the full prefix, served from cache each reuse
  });

  it("honors a custom minCacheableTokens threshold", () => {
    const below = planPromptCache({ systemTokens: 500, routingMode: "automatic", minCacheableTokens: 2000 });
    expect(below.cacheSystem).toBe(false);
    const above = planPromptCache({ systemTokens: 2500, routingMode: "automatic", minCacheableTokens: 2000 });
    expect(above.cacheSystem).toBe(true);
    expect(above.estimatedTokensSaved).toBe(2500);
  });

  it("exposes the documented default constants", () => {
    expect(DEFAULT_MIN_CACHEABLE_TOKENS).toBe(1024);
    expect(CACHE_READ_DISCOUNT).toBe(0.9);
  });
});
