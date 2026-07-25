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
