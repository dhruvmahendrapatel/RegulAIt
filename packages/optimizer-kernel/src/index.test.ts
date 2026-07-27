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
  classifyEditIntent,
  planEditVsRewrite,
  DEFAULT_MIN_EDITABLE_BASELINE_TOKENS,
  EDIT_DIFF_FRACTION,
  preprocessReference,
  planFilePreprocessing,
  DEFAULT_MIN_PREPROCESS_TOKENS,
  normalizeCacheInput,
  DEFAULT_SEMANTIC_CACHE_TTL_SECONDS,
  planRequestBatching,
  DEFAULT_BATCH_OVERHEAD_TOKENS,
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

describe("normalizeCacheInput", () => {
  it("trims, lowercases, and collapses whitespace runs to a single space", () => {
    expect(normalizeCacheInput("  Hello   World\n\tGoodbye  ")).toBe("hello world goodbye");
  });

  it("is idempotent (f(f(x)) === f(x))", () => {
    const raw = "\t Summarize   THE  Attached\n\n reference  ";
    const once = normalizeCacheInput(raw);
    expect(normalizeCacheInput(once)).toBe(once);
  });

  it("collapses case/whitespace-only differences to the same key", () => {
    expect(normalizeCacheInput("Fix the BUG")).toBe(normalizeCacheInput("fix   the\tbug"));
  });

  it("keeps a sane default TTL", () => {
    expect(DEFAULT_SEMANTIC_CACHE_TTL_SECONDS).toBe(3600);
  });
});

describe("planRequestBatching", () => {
  it("fewer than 2 same-model nodes is not batchable (0 saved)", () => {
    const plan = planRequestBatching({ models: ["mock-balanced"], routingMode: "automatic" });
    expect(plan.batchable).toBe(false);
    expect(plan.estimatedTokensSaved).toBe(0);
    expect(plan.groups).toEqual([{ model: "mock-balanced", count: 1 }]);
  });

  it("3 same-model nodes save (count - 1) * overhead", () => {
    const plan = planRequestBatching({
      models: ["m", "m", "m"],
      routingMode: "automatic",
    });
    expect(plan.batchable).toBe(true);
    expect(plan.estimatedTokensSaved).toBe(2 * DEFAULT_BATCH_OVERHEAD_TOKENS);
    expect(plan.groups).toEqual([{ model: "m", count: 3 }]);
  });

  it("honours a custom per-request overhead", () => {
    const plan = planRequestBatching({
      models: ["m", "m"],
      routingMode: "automatic",
      perRequestOverheadTokens: 500,
    });
    expect(plan.estimatedTokensSaved).toBe(500);
  });

  it("passthrough disables the estimate entirely (§12 off switch)", () => {
    const plan = planRequestBatching({ models: ["m", "m", "m"], routingMode: "passthrough" });
    expect(plan.batchable).toBe(false);
    expect(plan.estimatedTokensSaved).toBe(0);
    expect(plan.groups).toEqual([]);
    expect(plan.ruleChain[0]!.outcome).toBe("passthrough");
  });

  it("groups mixed models correctly and only counts batchable groups", () => {
    // a:3 (batchable, saves 2*overhead), b:2 (batchable, saves 1*overhead), c:1 (not)
    const plan = planRequestBatching({
      models: ["a", "b", "a", "c", "b", "a"],
      routingMode: "automatic",
    });
    expect(plan.batchable).toBe(true);
    expect(plan.estimatedTokensSaved).toBe(3 * DEFAULT_BATCH_OVERHEAD_TOKENS); // 2 + 1
    expect(plan.groups).toEqual([
      { model: "a", count: 3 },
      { model: "b", count: 2 },
      { model: "c", count: 1 },
    ]);
  });

  it("all-distinct models is not batchable", () => {
    const plan = planRequestBatching({ models: ["a", "b", "c"], routingMode: "automatic" });
    expect(plan.batchable).toBe(false);
    expect(plan.estimatedTokensSaved).toBe(0);
  });
});

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

describe("classifyEditIntent (edit vs rewrite §8)", () => {
  it("reads targeted-change verbs as an edit", () => {
    for (const t of [
      "fix the typo in the return statement",
      "rename the helper to parseInput",
      "add a null check before the loop",
      "update the copyright year",
    ]) {
      expect(classifyEditIntent(t)).toBe("edit");
    }
  });

  it("reads wholesale verbs (and phrases) as a rewrite", () => {
    for (const t of [
      "rewrite this module",
      "redo the whole thing",
      "regenerate the file",
      "start over from a blank slate",
      "please recreate this from scratch",
    ]) {
      expect(classifyEditIntent(t)).toBe("rewrite");
    }
  });

  it("no signal (or empty/missing) reads as unknown", () => {
    for (const t of [null, undefined, "", "   ", "the quick brown fox"]) {
      expect(classifyEditIntent(t)).toBe("unknown");
    }
  });

  it("rewrite wins when both an edit and a rewrite signal appear", () => {
    expect(classifyEditIntent("fix the bug, actually just rewrite the file")).toBe("rewrite");
    expect(classifyEditIntent("add the field, or start over if easier")).toBe("rewrite");
  });
});

describe("planEditVsRewrite (edit vs rewrite §8)", () => {
  const editReq = "fix the typo in the return statement";

  it("passthrough disables the optimization entirely (§12 off switch)", () => {
    const p = planEditVsRewrite({ baselineTokens: 5000, requestText: editReq, routingMode: "passthrough" });
    expect(p.mode).toBe("rewrite");
    expect(p.applyDiffDirective).toBe(false);
    expect(p.ruleId).toBe("routing-mode");
    expect(p.estimatedTokensSaved).toBe(0);
    expect(p.reason).toContain("passthrough");
  });

  it("no baseline (null/undefined/0) means a full rewrite — nothing to diff", () => {
    for (const baselineTokens of [null, undefined, 0]) {
      const p = planEditVsRewrite({ baselineTokens, requestText: editReq, routingMode: "automatic" });
      expect(p.mode).toBe("rewrite");
      expect(p.applyDiffDirective).toBe(false);
      expect(p.ruleId).toBe("no-baseline");
      expect(p.reason).toContain("nothing to diff");
    }
  });

  it("a rewrite or unknown intent stays a full rewrite even with a big baseline", () => {
    for (const requestText of ["rewrite this from scratch", "the quick brown fox"]) {
      const p = planEditVsRewrite({ baselineTokens: 5000, requestText, routingMode: "automatic" });
      expect(p.mode).toBe("rewrite");
      expect(p.applyDiffDirective).toBe(false);
      expect(p.ruleId).toBe("intent");
      expect(p.estimatedTokensSaved).toBe(0);
    }
  });

  it("an edit intent over a too-small baseline stays a full rewrite (already cheap)", () => {
    const p = planEditVsRewrite({
      baselineTokens: DEFAULT_MIN_EDITABLE_BASELINE_TOKENS - 1,
      requestText: editReq,
      routingMode: "automatic",
    });
    expect(p.mode).toBe("rewrite");
    expect(p.applyDiffDirective).toBe(false);
    expect(p.ruleId).toBe("baseline-size");
    expect(p.ruleChain.at(-1)!.outcome).toBe("too-small");
    expect(p.estimatedTokensSaved).toBe(0);
  });

  it("an edit intent over a large baseline diffs, saving round(baseline*(1-fraction)) output tokens", () => {
    const p = planEditVsRewrite({ baselineTokens: 4000, requestText: editReq, routingMode: "automatic" });
    expect(p.mode).toBe("edit");
    expect(p.applyDiffDirective).toBe(true);
    expect(p.ruleId).toBe("baseline-size");
    expect(p.ruleChain.at(-1)!.outcome).toBe("applied");
    expect(p.estimatedTokensSaved).toBe(Math.round(4000 * (1 - EDIT_DIFF_FRACTION)));
    expect(p.estimatedTokensSaved).toBe(3000); // 4000 * 0.75
    expect(p.estimationBasis).toContain("edit-vs-rewrite");
  });

  it("honors a custom minBaselineTokens threshold", () => {
    const below = planEditVsRewrite({
      baselineTokens: 300,
      requestText: editReq,
      routingMode: "automatic",
      minBaselineTokens: 500,
    });
    expect(below.mode).toBe("rewrite");
    expect(below.ruleId).toBe("baseline-size");
    const above = planEditVsRewrite({
      baselineTokens: 600,
      requestText: editReq,
      routingMode: "automatic",
      minBaselineTokens: 500,
    });
    expect(above.mode).toBe("edit");
    expect(above.estimatedTokensSaved).toBe(Math.round(600 * 0.75));
  });

  it("exposes the documented default constants", () => {
    expect(DEFAULT_MIN_EDITABLE_BASELINE_TOKENS).toBe(200);
    expect(EDIT_DIFF_FRACTION).toBe(0.25);
  });
});

describe("preprocessReference (file preprocessing §8)", () => {
  it("collapses redundant whitespace, blank-line runs, and trailing spaces in prose", () => {
    const out = preprocessReference("hello    world  \n\n\n\n\nfoo\t\tbar   ");
    expect(out).toBe("hello world\n\nfoo bar");
  });

  it("preserves fenced code blocks verbatim (no space or blank-line collapse inside)", () => {
    const src = [
      "prose   with    spaces",
      "```ts",
      "const  x   =   1;", // multiple spaces inside a fence must survive
      "",
      "",
      "",
      "const  y = 2;",
      "```",
      "more     prose",
    ].join("\n");
    const out = preprocessReference(src);
    expect(out).toContain("const  x   =   1;"); // exact spacing preserved
    expect(out).toContain("\n\n\n"); // the 3 blank lines inside the fence survive
    expect(out.startsWith("prose with spaces")).toBe(true); // outside collapsed
    expect(out.endsWith("more prose")).toBe(true);
  });

  it("elides very long unbroken tokens (base64/data URIs) but keeps normal words", () => {
    const blob = "A".repeat(2000);
    const out = preprocessReference(`before ${blob} after`);
    expect(out).not.toContain(blob);
    expect(out).toContain("before");
    expect(out).toContain("after");
    expect(out.length).toBeLessThan(`before ${blob} after`.length);
  });

  it("is idempotent: f(f(x)) === f(x)", () => {
    const src = [
      "a    b   c   ",
      "",
      "",
      "",
      "",
      "```py",
      "x  =  " + "Z".repeat(1000),
      "```",
      "tail   " + "Q".repeat(900),
    ].join("\n");
    const once = preprocessReference(src);
    expect(preprocessReference(once)).toBe(once);
  });

  it("leaves already-clean prose unchanged", () => {
    const clean = "the quick brown fox\n\njumps over the lazy dog";
    expect(preprocessReference(clean)).toBe(clean);
  });
});

describe("planFilePreprocessing (file preprocessing §8)", () => {
  // > 200 tokens (chars/4) of redundant content that really shrinks.
  const REDUNDANT = ("word     word     word     word\n\n\n\n\n".repeat(40));

  it("passthrough disables preprocessing entirely (§12 off switch)", () => {
    const p = planFilePreprocessing({ referenceText: REDUNDANT, routingMode: "passthrough" });
    expect(p.apply).toBe(false);
    expect(p.ruleId).toBe("routing-mode");
    expect(p.processedText).toBe(REDUNDANT);
    expect(p.estimatedTokensSaved).toBe(0);
    expect(p.reason).toContain("passthrough");
  });

  it("no reference content (null/undefined/empty) means nothing to preprocess", () => {
    for (const referenceText of [null, undefined, ""]) {
      const p = planFilePreprocessing({ referenceText, routingMode: "automatic" });
      expect(p.apply).toBe(false);
      expect(p.ruleId).toBe("no-content");
      expect(p.estimatedTokensSaved).toBe(0);
    }
  });

  it("a below-minimum reference is left unchanged (too small to bother)", () => {
    const small = "a   b\n\n\n\nc"; // well under 200 tokens
    const p = planFilePreprocessing({ referenceText: small, routingMode: "automatic" });
    expect(p.apply).toBe(false);
    expect(p.ruleId).toBe("content-size");
    expect(p.ruleChain.at(-1)!.outcome).toBe("too-small");
    expect(p.processedText).toBe(small);
    expect(p.estimatedTokensSaved).toBe(0);
  });

  it("a large redundant reference is preprocessed, saving >0 input tokens and shrinking the text", () => {
    const p = planFilePreprocessing({ referenceText: REDUNDANT, routingMode: "automatic" });
    expect(p.apply).toBe(true);
    expect(p.ruleId).toBe("no-reduction");
    expect(p.ruleChain.at(-1)!.outcome).toBe("applied");
    expect(p.estimatedTokensSaved).toBeGreaterThan(0);
    expect(p.estimatedTokensSaved).toBe(
      Math.max(0, Math.ceil((REDUNDANT.length - p.processedText.length) / 4)),
    );
    expect(p.processedText.length).toBeLessThan(REDUNDANT.length);
    expect(p.estimationBasis).toContain("file-preprocessing");
  });

  it("a large reference with nothing to strip yields no reduction (apply:false)", () => {
    // clean prose, over the minimum, with no redundant whitespace to collapse
    const clean = ("the quick brown fox jumps over the lazy dog\n").repeat(40);
    const p = planFilePreprocessing({ referenceText: clean, routingMode: "automatic" });
    expect(p.apply).toBe(false);
    expect(p.ruleId).toBe("no-reduction");
    expect(p.ruleChain.at(-1)!.outcome).toBe("no-reduction");
    expect(p.estimatedTokensSaved).toBe(0);
  });

  it("honors a custom minTokens threshold", () => {
    const mid = "x    y\n\n\n\nz    w\n".repeat(20); // between the two thresholds
    const below = planFilePreprocessing({ referenceText: mid, routingMode: "automatic", minTokens: 10_000 });
    expect(below.apply).toBe(false);
    expect(below.ruleId).toBe("content-size");
  });

  it("exposes the documented default constant", () => {
    expect(DEFAULT_MIN_PREPROCESS_TOKENS).toBe(200);
  });
});
