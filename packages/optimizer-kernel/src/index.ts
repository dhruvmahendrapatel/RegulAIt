/**
 * @regulait/optimizer-kernel — pillar 6's pure decision core (EPIC-04,
 * TOKEN_OPTIMIZATION_SPEC §7/§8).
 *
 * Pure and zero-I/O like @regulait/policy-kernel: the gateway loads state,
 * this kernel decides, the gateway persists the decision. The kernel never
 * expands entitlement (§12): callers pass only candidates the policy kernel
 * has already allowed, and routeModel re-enforces the tier ceiling on top.
 *
 * Savings semantics (§7): model routing saves *cost*, not tokens — the same
 * request runs on a cheaper model. estimatedTokensSaved is reserved for
 * token-reducing techniques (compaction, dedup) landing later; routing always
 * reports it as 0 and carries the counterfactual in estimatedCostSavedUsd
 * with an explicit estimationBasis, so the number is never mistaken for a
 * measurement.
 */

export type Complexity = "low" | "medium" | "high";
export type CostSensitivity = "cost-sensitive" | "standard" | "quality-sensitive";
export type RoutingMode = "automatic" | "passthrough";

/** an agent the caller has verified the user is entitled to invoke (in this mode) */
export interface CandidateAgent {
  id: string;
  /** capability/cost rank, same ordinal as the governance ceiling (§4) */
  tier: number;
  /** USD per million input tokens; null = unpriced, ineligible as a routing target */
  costPerMTokIn: number | null;
  /** USD per million output tokens; null = unpriced */
  costPerMTokOut: number | null;
}

export interface TokenEstimate {
  in: number;
  out: number;
}

export interface RouteModelInput {
  /** the agent the user actually invoked — the baseline the counterfactual is measured against */
  requestedAgentId: string;
  /** entitlement-filtered by the caller; the kernel never selects outside this set */
  candidates: readonly CandidateAgent[];
  /** §12's off switch — "passthrough" disables routing entirely */
  routingMode: RoutingMode;
  complexity: Complexity;
  /** §9 workflow tag; defaults to "standard" */
  costSensitivity?: CostSensitivity;
  /** tier of the user's governance ceiling (§4); re-enforced here as defense in depth */
  ceilingTier?: number | null;
  estimate: TokenEstimate;
}

export type RoutingRuleName =
  | "routing-mode"
  | "baseline-entitled"
  | "cost-sensitivity"
  | "complexity-floor"
  | "cheapest-eligible";

export interface RoutingRuleTrace {
  rule: RoutingRuleName;
  outcome: "passthrough" | "applied" | "no-match" | "routed";
  agentId?: string;
}

export interface RoutingDecision {
  effect: "routed" | "passthrough";
  /** the agent that should serve the request; always ∈ candidates ∪ {requested} */
  selectedAgentId: string;
  baselineAgentId: string;
  ruleId: RoutingRuleName;
  ruleChain: RoutingRuleTrace[];
  reason: string;
  /** always 0 for routing — see module doc */
  estimatedTokensSaved: number;
  /** null when the baseline or comparison is unpriced */
  estimatedCostSavedUsd: number | null;
  estimationBasis: string;
}

const BASIS = "estimated-tokens-x-list-price-vs-baseline-model";
const TOOL_BASIS = "serialized-manifest-chars-of-withheld-tools/4";

/**
 * §8's "lightweight complexity classifier" — a deterministic heuristic, never
 * an LLM call (an LLM classifier would put an ungoverned model call inside the
 * interception point). No input text = no signal = no downgrade ("high").
 */
export function classifyComplexity(text: string | null | undefined): Complexity {
  const t = text?.trim();
  if (!t) return "high";
  const hasCode = t.includes("```");
  const lines = t.split("\n").length;
  if (t.length > 4000 || (hasCode && t.length > 800)) return "high";
  if (t.length < 240 && !hasCode && lines <= 2) return "low";
  return "medium";
}

/** crude chars/4 input estimate + complexity-scaled output allowance */
export function estimateTokens(text: string | null | undefined, complexity: Complexity): TokenEstimate {
  const inTokens = Math.ceil((text?.length ?? 0) / 4) + 200;
  const outTokens = complexity === "low" ? 300 : complexity === "medium" ? 800 : 2000;
  return { in: inTokens, out: outTokens };
}

function costOf(agent: CandidateAgent, est: TokenEstimate): number | null {
  if (agent.costPerMTokIn === null || agent.costPerMTokOut === null) return null;
  return (est.in * agent.costPerMTokIn + est.out * agent.costPerMTokOut) / 1_000_000;
}

function passthrough(
  input: RouteModelInput,
  chain: RoutingRuleTrace[],
  ruleId: RoutingRuleName,
  reason: string,
): RoutingDecision {
  return {
    effect: "passthrough",
    selectedAgentId: input.requestedAgentId,
    baselineAgentId: input.requestedAgentId,
    ruleId,
    ruleChain: chain,
    reason,
    estimatedTokensSaved: 0,
    estimatedCostSavedUsd: 0,
    estimationBasis: BASIS,
  };
}

export function routeModel(input: RouteModelInput): RoutingDecision {
  const chain: RoutingRuleTrace[] = [];
  const sensitivity = input.costSensitivity ?? "standard";

  if (input.routingMode === "passthrough") {
    chain.push({ rule: "routing-mode", outcome: "passthrough" });
    return passthrough(input, chain, "routing-mode", "routing disabled for this user (passthrough mode)");
  }
  chain.push({ rule: "routing-mode", outcome: "applied" });

  const baseline = input.candidates.find((c) => c.id === input.requestedAgentId);
  if (!baseline) {
    // Fail safe: the caller should only route after governance allowed the
    // requested agent, so a missing baseline means inconsistent inputs — never
    // substitute a model in that state.
    chain.push({ rule: "baseline-entitled", outcome: "no-match" });
    return passthrough(input, chain, "baseline-entitled", "requested agent not in candidate set; no substitution");
  }
  chain.push({ rule: "baseline-entitled", outcome: "applied", agentId: baseline.id });

  if (sensitivity === "quality-sensitive") {
    chain.push({ rule: "cost-sensitivity", outcome: "passthrough" });
    return passthrough(input, chain, "cost-sensitivity", "quality-sensitive request; never downgraded");
  }
  chain.push({ rule: "cost-sensitivity", outcome: "applied" });

  // Minimum acceptable tier for this complexity, relative to the baseline —
  // tiers are deployment-defined ordinals, so the floor is relative, never an
  // absolute tier number. cost-sensitive (§9) lowers the floor one tier more.
  let floor =
    input.complexity === "high"
      ? baseline.tier
      : input.complexity === "medium"
        ? baseline.tier - 1
        : 0;
  if (sensitivity === "cost-sensitive") floor = Math.max(0, floor - 1);
  chain.push({ rule: "complexity-floor", outcome: "applied" });

  const baselineCost = costOf(baseline, input.estimate);
  if (baselineCost === null) {
    chain.push({ rule: "cheapest-eligible", outcome: "no-match" });
    return passthrough(input, chain, "cheapest-eligible", "baseline model unpriced; savings incomparable");
  }

  const ceiling = input.ceilingTier ?? Number.POSITIVE_INFINITY;
  let best: { agent: CandidateAgent; cost: number } | null = null;
  for (const c of input.candidates) {
    if (c.tier > ceiling) continue; // §12 defense in depth — never above the governance ceiling
    if (c.tier > baseline.tier) continue; // routing only ever goes down or sideways
    if (c.tier < floor) continue;
    const cost = costOf(c, input.estimate);
    if (cost === null || cost > baselineCost) continue;
    if (
      best === null ||
      cost < best.cost ||
      // tie-break: same price, prefer more capability, then stable id order
      (cost === best.cost && (c.tier > best.agent.tier || (c.tier === best.agent.tier && c.id < best.agent.id)))
    ) {
      best = { agent: c, cost };
    }
  }

  if (!best || best.agent.id === baseline.id) {
    chain.push({ rule: "cheapest-eligible", outcome: "no-match" });
    return passthrough(input, chain, "cheapest-eligible", "requested model is already the cheapest eligible");
  }

  chain.push({ rule: "cheapest-eligible", outcome: "routed", agentId: best.agent.id });
  const saved = baselineCost - best.cost;
  return {
    effect: "routed",
    selectedAgentId: best.agent.id,
    baselineAgentId: baseline.id,
    ruleId: "cheapest-eligible",
    ruleChain: chain,
    reason: `routed to cheaper eligible model (complexity ${input.complexity}, tier floor ${floor})`,
    estimatedTokensSaved: 0,
    estimatedCostSavedUsd: Number(saved.toFixed(6)),
    estimationBasis: BASIS,
  };
}

// ---------------------------------------------------------------------------
// §5 context compaction: the pure decision core behind the gateway's
// conversation compaction. The gateway loads the stored (model-bound) history,
// this plans WHETHER to compact and THROUGH WHICH message, the gateway runs
// the governed summarization dispatch and persists the summary. Stored
// messages are never deleted or altered — compaction only changes what is
// model-bound, so the plan is pure arithmetic over per-message token
// estimates.
// ---------------------------------------------------------------------------

/** §5 threshold: compact once the model-bound history exceeds this many
 * estimated tokens. Per-user/per-project tuning is deferred — the agent-policy
 * row has no natural home for it without a migration, and a dial nobody can
 * see yet isn't worth one (see COMPACTION notes in the gateway). */
export const DEFAULT_COMPACTION_THRESHOLD_TOKENS = 1600;
/** §5 conservative-by-default: the newest turns always ride verbatim — only
 * messages OLDER than this window are ever summarized away. */
export const COMPACTION_RECENT_WINDOW_MESSAGES = 4;

const COMPACTION_BASIS = "estimated-tokens-of-omitted-history-minus-summary-tokens";

export interface PlanCompactionInput {
  /** per-message token estimates of the stored model-bound history, in order.
   * On re-compaction the caller passes only the messages AFTER the existing
   * summary boundary — the returned index is relative to this slice. */
  messageTokens: readonly number[];
  /** tokens of the existing summary that already rides every dispatch (0 = none) */
  summaryTokens?: number;
  thresholdTokens?: number;
  recentWindowMessages?: number;
}

export interface CompactionPlan {
  shouldCompact: boolean;
  /** compact messages [0..compactThroughIndex] inclusive; -1 = nothing to compact */
  compactThroughIndex: number;
  /** what the model would currently carry: existing summary + history */
  historyTokens: number;
  reason: string;
  estimationBasis: string;
}

/** Decide whether the history has outgrown the threshold and, if so, how far
 * to compact: everything except the last `recentWindowMessages` messages.
 * Strictly-greater on the threshold — a history AT the threshold still rides
 * verbatim (no downgrade without a clear signal, like routeModel). */
export function planCompaction(input: PlanCompactionInput): CompactionPlan {
  const threshold = input.thresholdTokens ?? DEFAULT_COMPACTION_THRESHOLD_TOKENS;
  const window = input.recentWindowMessages ?? COMPACTION_RECENT_WINDOW_MESSAGES;
  const historyTokens =
    (input.summaryTokens ?? 0) + input.messageTokens.reduce((s, t) => s + t, 0);
  const none = (reason: string): CompactionPlan => ({
    shouldCompact: false,
    compactThroughIndex: -1,
    historyTokens,
    reason,
    estimationBasis: COMPACTION_BASIS,
  });
  if (historyTokens <= threshold) {
    return none(`history ~${historyTokens} tokens is within the ${threshold}-token threshold`);
  }
  if (input.messageTokens.length <= window) {
    return none(
      `history exceeds the threshold but only ${input.messageTokens.length} message(s) exist — the ${window}-message verbatim window leaves nothing to compact`,
    );
  }
  return {
    shouldCompact: true,
    compactThroughIndex: input.messageTokens.length - window - 1,
    historyTokens,
    reason: `history ~${historyTokens} tokens exceeds the ${threshold}-token threshold; compacting all but the ${window} newest messages`,
    estimationBasis: COMPACTION_BASIS,
  };
}

/** §7 savings claim for a dispatch that rode a summary instead of the full
 * history: the omitted messages' estimated tokens minus the summary that
 * replaced them, floored at 0 — a verbose summary never reports negative
 * savings as if it were a win. */
export function compactionSavings(omittedTokens: number, summaryTokens: number): number {
  return Math.max(0, omittedTokens - summaryTokens);
}

// ---------------------------------------------------------------------------
// §8/§10 prompt caching: mark a large, stable system prefix cacheable so
// repeated dispatches reusing it read it from cache instead of re-billing the
// prefix each turn. This is the PURE decision — whether the system prefix
// clears the provider's minimum cacheable size — and an ESTIMATE of the input
// tokens saved per subsequent reuse. The gateway applies the cache_control and
// writes the cost_events estimate; the model adapter emits the real breakpoint.
// ---------------------------------------------------------------------------

/** Anthropic's minimum cacheable prompt size for the models we route to; below
 * this the provider won't cache, so we don't mark it. */
export const DEFAULT_MIN_CACHEABLE_TOKENS = 1024;

/** Fraction of the cached prefix's input cost saved on a cache READ (Anthropic
 * ephemeral cache read ≈ 0.1x list, i.e. ~90% off). Used to estimate reuse
 * savings. There is a ~1.25x write surcharge on the FIRST call — the estimate
 * is explicitly the STEADY-STATE reuse saving, labeled as such. */
export const CACHE_READ_DISCOUNT = 0.9;

export interface PlanPromptCacheInput {
  /** estimated token count of the stable system prefix (0/undefined = none) */
  systemTokens: number | null | undefined;
  /** §12 off switch — "passthrough" disables caching entirely */
  routingMode: RoutingMode;
  /** override the min cacheable size (default DEFAULT_MIN_CACHEABLE_TOKENS) */
  minCacheableTokens?: number;
}

export type PromptCacheRuleName = "routing-mode" | "prefix-size";

export interface PromptCachePlan {
  /** true = mark the system prefix cacheable on the outgoing request */
  cacheSystem: boolean;
  ruleId: PromptCacheRuleName;
  ruleChain: Array<{ rule: PromptCacheRuleName; outcome: "passthrough" | "applied" | "too-small" }>;
  reason: string;
  /** estimated input tokens saved PER subsequent reuse of the cached prefix */
  estimatedTokensSaved: number;
  estimationBasis: string;
}

const PROMPT_CACHE_BASIS =
  "prompt-caching: estimated input-token reuse savings on the cached system prefix (Anthropic ephemeral cache; realized only on repeat within the cache window)";

/** Decide whether the stable system prefix is worth caching. Like routeModel,
 * "passthrough" is the §12 off switch and a below-threshold prefix is never
 * marked (no downgrade without a clear signal). When marked, the estimate is
 * the FULL prefix served from cache on each reuse; the gateway converts it to
 * USD at the served agent's input price × CACHE_READ_DISCOUNT. */
export function planPromptCache(input: PlanPromptCacheInput): PromptCachePlan {
  const minCacheable = input.minCacheableTokens ?? DEFAULT_MIN_CACHEABLE_TOKENS;
  const systemTokens = input.systemTokens ?? 0;

  if (input.routingMode === "passthrough") {
    return {
      cacheSystem: false,
      ruleId: "routing-mode",
      ruleChain: [{ rule: "routing-mode", outcome: "passthrough" }],
      reason: "prompt caching disabled for this user (passthrough mode)",
      estimatedTokensSaved: 0,
      estimationBasis: PROMPT_CACHE_BASIS,
    };
  }

  if (systemTokens < minCacheable) {
    return {
      cacheSystem: false,
      ruleId: "prefix-size",
      ruleChain: [
        { rule: "routing-mode", outcome: "applied" },
        { rule: "prefix-size", outcome: "too-small" },
      ],
      reason: `system prefix ~${systemTokens} tokens is below the ${minCacheable}-token minimum cacheable size; not marked`,
      estimatedTokensSaved: 0,
      estimationBasis: PROMPT_CACHE_BASIS,
    };
  }

  return {
    cacheSystem: true,
    ruleId: "prefix-size",
    ruleChain: [
      { rule: "routing-mode", outcome: "applied" },
      { rule: "prefix-size", outcome: "applied" },
    ],
    reason: `system prefix ~${systemTokens} tokens clears the ${minCacheable}-token minimum; marked cacheable (savings realized on repeat reuse within the cache window)`,
    estimatedTokensSaved: systemTokens,
    estimationBasis: PROMPT_CACHE_BASIS,
  };
}

// ---------------------------------------------------------------------------
// §8 lazy tool-loading: expose only the entitled tools relevant to the
// caller's declared intent. Withheld tools remain fully callable — this trims
// the manifest a model has to read, never the entitlement (§12). No intent =
// no signal = the full entitled manifest, mirroring routeModel's no-downgrade
// rule.
// ---------------------------------------------------------------------------

export interface SelectableTool {
  name: string;
  description: string | null;
  /** length in characters of the tool's full serialized manifest entry (schema included) */
  manifestChars: number;
}

export interface SelectToolsInput {
  /** the caller's declared intent for this session/request; null = no signal */
  intent: string | null | undefined;
  /** entitlement-filtered by the caller; selection never adds to this set */
  tools: readonly SelectableTool[];
  /** the same §12 per-user off switch used for model routing */
  routingMode: RoutingMode;
  /** cap on how many matched tools to keep (default 20) */
  maxTools?: number;
}

export type ToolSelectionRuleName = "routing-mode" | "intent-signal" | "relevance-match";

export interface ToolSelectionRuleTrace {
  rule: ToolSelectionRuleName;
  outcome: "passthrough" | "applied" | "no-match" | "narrowed";
}

export interface ToolSelectionDecision {
  effect: "narrowed" | "passthrough";
  /** tool names to expose in the manifest; always ⊆ input tools */
  selected: string[];
  /** tool names trimmed from the manifest — still callable, never blocked */
  withheld: string[];
  ruleId: ToolSelectionRuleName;
  ruleChain: ToolSelectionRuleTrace[];
  reason: string;
  estimatedTokensSaved: number;
  estimationBasis: string;
}

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "for", "to", "of", "in", "on", "with",
  "is", "it", "this", "that", "my", "me", "i", "please", "what", "how",
  "do", "does", "can", "you", "get", "use",
]);

function terms(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 2 && !STOPWORDS.has(w));
}

function allTools(input: SelectToolsInput, chain: ToolSelectionRuleTrace[], ruleId: ToolSelectionRuleName, reason: string): ToolSelectionDecision {
  return {
    effect: "passthrough",
    selected: input.tools.map((t) => t.name),
    withheld: [],
    ruleId,
    ruleChain: chain,
    reason,
    estimatedTokensSaved: 0,
    estimationBasis: TOOL_BASIS,
  };
}

export function selectTools(input: SelectToolsInput): ToolSelectionDecision {
  const chain: ToolSelectionRuleTrace[] = [];

  if (input.routingMode === "passthrough") {
    chain.push({ rule: "routing-mode", outcome: "passthrough" });
    return allTools(input, chain, "routing-mode", "optimization disabled for this user (passthrough mode)");
  }
  chain.push({ rule: "routing-mode", outcome: "applied" });

  const intentTerms = terms(input.intent ?? "");
  if (intentTerms.length === 0) {
    chain.push({ rule: "intent-signal", outcome: "no-match" });
    return allTools(input, chain, "intent-signal", "no intent declared; full entitled manifest");
  }
  chain.push({ rule: "intent-signal", outcome: "applied" });

  const scored = input.tools.map((tool) => {
    const toolTerms = new Set(terms(`${tool.name} ${tool.description ?? ""}`));
    const score = intentTerms.filter((t) => toolTerms.has(t)).length;
    return { tool, score };
  });

  const maxTools = input.maxTools ?? 20;
  const matched = scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name))
    .slice(0, maxTools);

  if (matched.length === 0) {
    // Fail open: a bad intent match must never hide the whole toolbox.
    chain.push({ rule: "relevance-match", outcome: "no-match" });
    return allTools(input, chain, "relevance-match", "no tool matched the intent; failing open to the full entitled manifest");
  }
  if (matched.length === input.tools.length) {
    chain.push({ rule: "relevance-match", outcome: "no-match" });
    return allTools(input, chain, "relevance-match", "every entitled tool matches the intent");
  }

  chain.push({ rule: "relevance-match", outcome: "narrowed" });
  const selectedNames = new Set(matched.map((m) => m.tool.name));
  const withheld = input.tools.filter((t) => !selectedNames.has(t.name));
  const savedChars = withheld.reduce((sum, t) => sum + t.manifestChars, 0);
  return {
    effect: "narrowed",
    selected: matched.map((m) => m.tool.name),
    withheld: withheld.map((t) => t.name),
    ruleId: "relevance-match",
    ruleChain: chain,
    reason: `manifest narrowed to ${matched.length} of ${input.tools.length} entitled tools relevant to the declared intent`,
    estimatedTokensSaved: Math.ceil(savedChars / 4),
    estimationBasis: TOOL_BASIS,
  };
}

// ---------------------------------------------------------------------------
// §8 edit vs rewrite: when the user asks to MODIFY existing content, detecting
// a targeted EDIT (vs a wholesale rewrite) lets the gateway instruct the model
// to return a compact DIFF instead of re-emitting the whole file — saving
// OUTPUT tokens. The baseline (existing content) must be sent to the model
// either way (you can't edit what the model can't see), so the baseline's
// INPUT cost is NOT attributable here — the saving is purely OUTPUT (a small
// diff vs a full rewrite ≈ the whole baseline re-emitted). This is the PURE
// decision — whether to diff — and an ESTIMATE of the output tokens saved; the
// gateway injects the diff directive + baseline and writes the cost_events
// estimate.
// ---------------------------------------------------------------------------

/** Below this many baseline tokens a diff saves too little output to bother —
 * a full rewrite of a tiny file is already cheap. */
export const DEFAULT_MIN_EDITABLE_BASELINE_TOKENS = 200;
/** Estimated size of an edit DIFF as a fraction of the baseline it edits — a
 * targeted edit re-emits only the changed lines plus a little context. Used to
 * estimate the OUTPUT tokens a diff saves vs a full rewrite. */
export const EDIT_DIFF_FRACTION = 0.25;

export type EditIntent = "edit" | "rewrite" | "unknown";

const EDIT_VERBS = new Set([
  "fix", "rename", "add", "remove", "change", "update", "tweak",
  "adjust", "correct", "replace", "insert", "delete",
]);
const REWRITE_VERBS = new Set(["rewrite", "redo", "regenerate", "rework", "recreate"]);
const REWRITE_PHRASES = ["from scratch", "start over"];

/** Keyword heuristic over the request text. "edit" = targeted-change verbs
 * (fix, rename, add, remove, change, update, tweak, adjust, correct, replace,
 * insert, delete a…); "rewrite" = wholesale verbs (rewrite, redo, regenerate,
 * rework, "from scratch", start over, recreate). Rewrite signals WIN when both
 * appear (a rewrite is the safe, non-optimizing default — never diff when the
 * user asked for a full rewrite). No signal => "unknown". */
export function classifyEditIntent(text: string | null | undefined): EditIntent {
  const t = text?.toLowerCase();
  if (!t || !t.trim()) return "unknown";
  const words = new Set(t.split(/[^a-z0-9]+/).filter((w) => w.length > 0));
  const hasRewrite =
    REWRITE_PHRASES.some((p) => t.includes(p)) || [...REWRITE_VERBS].some((v) => words.has(v));
  if (hasRewrite) return "rewrite"; // rewrite wins when both signals appear
  const hasEdit = [...EDIT_VERBS].some((v) => words.has(v));
  if (hasEdit) return "edit";
  return "unknown";
}

export interface PlanEditVsRewriteInput {
  /** estimated token count of the baseline being modified (0/undefined = none) */
  baselineTokens: number | null | undefined;
  /** the user's change request text (intent is classified from it) */
  requestText: string | null | undefined;
  /** §12 off switch — "passthrough" disables the optimization entirely */
  routingMode: RoutingMode;
  /** override the min editable baseline (default DEFAULT_MIN_EDITABLE_BASELINE_TOKENS) */
  minBaselineTokens?: number;
}

export type EditRewriteRuleName = "routing-mode" | "no-baseline" | "intent" | "baseline-size";

export interface EditVsRewritePlan {
  /** "edit" = instruct the model to return a compact diff; "rewrite" = leave the
   * dispatch unchanged (full generation). */
  mode: "edit" | "rewrite";
  /** true = the gateway should inject the compact-diff directive for this dispatch */
  applyDiffDirective: boolean;
  ruleId: EditRewriteRuleName;
  ruleChain: Array<{ rule: EditRewriteRuleName; outcome: string }>;
  reason: string;
  /** estimated OUTPUT tokens saved by a diff vs a full rewrite of the baseline */
  estimatedTokensSaved: number;
  estimationBasis: string;
}

const EDIT_VS_REWRITE_BASIS =
  "edit-vs-rewrite: estimated OUTPUT tokens saved by returning a diff (~EDIT_DIFF_FRACTION of baseline) instead of re-emitting the full baseline";

/** Decide whether a modification request is a targeted edit worth diffing.
 * Like routeModel/planPromptCache, "passthrough" is the §12 off switch and the
 * default is the non-optimizing full rewrite — a diff is only chosen on a clear
 * edit signal over a large-enough baseline (no downgrade without a clear
 * signal). When chosen, a rewrite would re-emit ≈ baselineTokens of output; a
 * diff emits ≈ EDIT_DIFF_FRACTION×baseline; saved ≈ baseline×(1−fraction). */
export function planEditVsRewrite(input: PlanEditVsRewriteInput): EditVsRewritePlan {
  const minBaseline = input.minBaselineTokens ?? DEFAULT_MIN_EDITABLE_BASELINE_TOKENS;
  const baselineTokens = input.baselineTokens ?? 0;

  const rewrite = (
    ruleId: EditRewriteRuleName,
    ruleChain: Array<{ rule: EditRewriteRuleName; outcome: string }>,
    reason: string,
  ): EditVsRewritePlan => ({
    mode: "rewrite",
    applyDiffDirective: false,
    ruleId,
    ruleChain,
    reason,
    estimatedTokensSaved: 0,
    estimationBasis: EDIT_VS_REWRITE_BASIS,
  });

  if (input.routingMode === "passthrough") {
    return rewrite(
      "routing-mode",
      [{ rule: "routing-mode", outcome: "passthrough" }],
      "edit-vs-rewrite disabled for this user (passthrough mode)",
    );
  }

  if (baselineTokens <= 0) {
    return rewrite(
      "no-baseline",
      [
        { rule: "routing-mode", outcome: "applied" },
        { rule: "no-baseline", outcome: "no-baseline" },
      ],
      "no baseline supplied; nothing to diff against",
    );
  }

  const intent = classifyEditIntent(input.requestText);
  if (intent !== "edit") {
    return rewrite(
      "intent",
      [
        { rule: "routing-mode", outcome: "applied" },
        { rule: "no-baseline", outcome: "applied" },
        { rule: "intent", outcome: intent },
      ],
      `request intent is '${intent}', not a targeted edit; defaulting to a full rewrite`,
    );
  }

  if (baselineTokens < minBaseline) {
    return rewrite(
      "baseline-size",
      [
        { rule: "routing-mode", outcome: "applied" },
        { rule: "no-baseline", outcome: "applied" },
        { rule: "intent", outcome: "edit" },
        { rule: "baseline-size", outcome: "too-small" },
      ],
      `baseline ~${baselineTokens} tokens is below the ${minBaseline}-token minimum; a full rewrite is already cheap`,
    );
  }

  return {
    mode: "edit",
    applyDiffDirective: true,
    ruleId: "baseline-size",
    ruleChain: [
      { rule: "routing-mode", outcome: "applied" },
      { rule: "no-baseline", outcome: "applied" },
      { rule: "intent", outcome: "edit" },
      { rule: "baseline-size", outcome: "applied" },
    ],
    reason: `baseline ~${baselineTokens} tokens reads as a targeted edit; instructing a compact diff instead of a full rewrite`,
    estimatedTokensSaved: Math.round(baselineTokens * (1 - EDIT_DIFF_FRACTION)),
    estimationBasis: EDIT_VS_REWRITE_BASIS,
  };
}

// ---------------------------------------------------------------------------
// §8 file preprocessing: when a caller attaches large reference/file content to
// a dispatch, deterministically pre-processing it (collapse redundant
// whitespace, dedupe blank lines, trim trailing spaces, elide very long inlined
// data/base64 blobs) shrinks the INPUT tokens the model sees WITHOUT changing
// meaning. The reduced content is really what's sent (like edit-vs-rewrite
// transforms the dispatch), so the saving is a real INPUT-token reduction. This
// is the PURE transform + decision — whether it's worth preprocessing and an
// ESTIMATE of the input tokens saved; the gateway attaches the processed
// content and writes the cost_events estimate.
// ---------------------------------------------------------------------------

/** Below this many tokens of reference content, preprocessing saves too little to bother. */
export const DEFAULT_MIN_PREPROCESS_TOKENS = 200;

/** Elision marker substituted for very long unbroken tokens (base64/data URIs).
 * Contains no whitespace and is far shorter than the elision threshold, so
 * preprocessing stays idempotent. */
const LONG_TOKEN_ELISION = "[…elided-long-token…]";

/** Deterministically shrink reference/file content WITHOUT changing meaning:
 * collapse runs of 3+ blank lines to 1, collapse runs of spaces/tabs to a single
 * space (but NOT inside fenced code blocks ```...```), trim trailing whitespace
 * per line, and replace very long unbroken tokens (>512 chars, e.g. base64/data
 * URIs) with a short elision marker. Returns the reduced text. Pure + idempotent
 * (f(f(x)) === f(x)). */
export function preprocessReference(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let inFence = false;
  let blankRun = 0;
  const flushBlanks = () => {
    if (blankRun > 0) {
      // collapse a run of 3+ blank lines to a single blank line; keep 1–2 as-is
      const keep = blankRun >= 3 ? 1 : blankRun;
      for (let i = 0; i < keep; i++) out.push("");
      blankRun = 0;
    }
  };
  for (const raw of lines) {
    if (/^\s*```/.test(raw)) {
      // fence delimiter: flush pending blanks, toggle, emit (trailing-trim only)
      flushBlanks();
      inFence = !inFence;
      out.push(raw.replace(/[ \t]+$/, ""));
      continue;
    }
    if (inFence) {
      // inside a fenced code block: preserve the line verbatim (no whitespace
      // collapse, no blank-line collapse, no elision — code meaning is exact)
      out.push(raw);
      continue;
    }
    // outside a fence: collapse space/tab runs, trim trailing whitespace, elide
    // very long unbroken tokens
    const line = raw
      .replace(/[ \t]+/g, " ")
      .replace(/[ \t]+$/, "")
      .replace(/\S{513,}/g, LONG_TOKEN_ELISION);
    if (line === "") {
      blankRun++;
      continue;
    }
    flushBlanks();
    out.push(line);
  }
  flushBlanks();
  return out.join("\n");
}

export interface PlanFilePreprocessingInput {
  /** the reference/file content attached to the dispatch (null/undefined/"" = none) */
  referenceText: string | null | undefined;
  /** §12 off switch — "passthrough" disables preprocessing entirely */
  routingMode: RoutingMode;
  /** override the min reference size (default DEFAULT_MIN_PREPROCESS_TOKENS) */
  minTokens?: number;
}

export type FilePreprocessRuleName = "routing-mode" | "no-content" | "content-size" | "no-reduction";

export interface FilePreprocessingPlan {
  /** true = send the preprocessed content + book the estimate */
  apply: boolean;
  /** the reduced text (=== input when apply is false) */
  processedText: string;
  ruleId: FilePreprocessRuleName;
  ruleChain: Array<{ rule: FilePreprocessRuleName; outcome: string }>;
  reason: string;
  /** estimated INPUT tokens saved by sending the reduced reference */
  estimatedTokensSaved: number;
  estimationBasis: string;
}

const FILE_PREPROCESSING_BASIS =
  "file-preprocessing: estimated INPUT tokens saved by collapsing redundant whitespace / eliding long data blobs before the model sees the reference";

/** Decide whether attached reference content is worth preprocessing. Like
 * routeModel/planPromptCache/planEditVsRewrite, "passthrough" is the §12 off
 * switch and the default is to leave the reference unchanged — the reduced
 * content is only sent when preprocessing a large-enough reference actually
 * shrinks it (no change without a clear signal). When applied, the estimate is
 * the INPUT tokens the smaller reference saves; the gateway converts it to USD
 * at the served agent's input price. */
export function planFilePreprocessing(input: PlanFilePreprocessingInput): FilePreprocessingPlan {
  const minTokens = input.minTokens ?? DEFAULT_MIN_PREPROCESS_TOKENS;
  const text = input.referenceText ?? "";

  const skip = (
    ruleId: FilePreprocessRuleName,
    ruleChain: Array<{ rule: FilePreprocessRuleName; outcome: string }>,
    reason: string,
    processedText = text,
  ): FilePreprocessingPlan => ({
    apply: false,
    processedText,
    ruleId,
    ruleChain,
    reason,
    estimatedTokensSaved: 0,
    estimationBasis: FILE_PREPROCESSING_BASIS,
  });

  if (input.routingMode === "passthrough") {
    return skip(
      "routing-mode",
      [{ rule: "routing-mode", outcome: "passthrough" }],
      "file preprocessing disabled for this user (passthrough mode)",
    );
  }

  if (!text) {
    return skip(
      "no-content",
      [
        { rule: "routing-mode", outcome: "applied" },
        { rule: "no-content", outcome: "no-content" },
      ],
      "no reference content supplied; nothing to preprocess",
    );
  }

  const contentTokens = Math.ceil(text.length / 4);
  if (contentTokens < minTokens) {
    return skip(
      "content-size",
      [
        { rule: "routing-mode", outcome: "applied" },
        { rule: "no-content", outcome: "applied" },
        { rule: "content-size", outcome: "too-small" },
      ],
      `reference ~${contentTokens} tokens is below the ${minTokens}-token minimum; preprocessing saves too little to bother`,
    );
  }

  const processedText = preprocessReference(text);
  const saved = Math.max(0, Math.ceil((text.length - processedText.length) / 4));
  if (saved <= 0) {
    return skip(
      "no-reduction",
      [
        { rule: "routing-mode", outcome: "applied" },
        { rule: "no-content", outcome: "applied" },
        { rule: "content-size", outcome: "applied" },
        { rule: "no-reduction", outcome: "no-reduction" },
      ],
      "preprocessing produced no meaningful reduction; sending the reference unchanged",
      processedText,
    );
  }

  return {
    apply: true,
    processedText,
    ruleId: "no-reduction",
    ruleChain: [
      { rule: "routing-mode", outcome: "applied" },
      { rule: "no-content", outcome: "applied" },
      { rule: "content-size", outcome: "applied" },
      { rule: "no-reduction", outcome: "applied" },
    ],
    reason: `reference ~${contentTokens} tokens preprocessed; ~${saved} input tokens saved by collapsing redundant whitespace / eliding long data blobs before the model sees it`,
    estimatedTokensSaved: saved,
    estimationBasis: FILE_PREPROCESSING_BASIS,
  };
}
