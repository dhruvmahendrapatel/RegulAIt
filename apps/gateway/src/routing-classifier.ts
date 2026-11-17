/**
 * ADR-0353 part 2 — THE PLUGGABLE ROUTING CLASSIFIER.
 *
 * `routeModel` (optimizer-kernel, pillar 6 §8) takes a complexity. By default it comes from the deterministic
 * `classifyComplexity` heuristic. An admin may name one registered ADR-0088 external scorer that claims the
 * `routing_complexity` kind (`org_settings.routing_classifier_scorer_id`, null = off); its score in [0, 1] then picks
 * the complexity. Nothing else changes: `routeModel` still decides among entitlement-filtered candidates, under the
 * tier ceiling and never above the requested model, so a classifier cannot widen a grant or raise a cost.
 *
 * The call is the ADR-0088 contract verbatim (strict reply parser, egress guard re-checked per request, the scorer's
 * own register → test → enable gate). It is bounded at ROUTING_CLASSIFIER_TIMEOUT_MS because it sits on the dispatch
 * path. Every failure falls back to the heuristic with its reason; nothing here ever refuses a dispatch.
 *
 * Every dispatch that ran with a classifier configured writes one `routing-classified` audit row (the scorer, the
 * score, the complexity, the source and the routing decision), so "why was this request served by that model" is
 * answerable from the audit trail and not only from the cost ledger.
 */
import { auditLog, eq, externalScorers, type Db } from "@regulait/db";
import { ROUTING_SCORER_KIND, routingClassifierProblem } from "@regulait/shared";
import { classifyComplexity, complexityFromScore, type Complexity, type RoutingDecision } from "@regulait/optimizer-kernel";
import { callExternalScorer, resolveExternalScorersByName } from "./external-scorers.js";
import { errMessage } from "./err-serializer.js";
import type { EgressResolver } from "./egress-guard.js";

/** the bound on one classifier call: it is on the dispatch path, so a slow scorer falls back rather than stalls */
export const ROUTING_CLASSIFIER_TIMEOUT_MS = 1_500;
/** the most prompt text sent to a classifier (a classifier needs the gist, not a whole attachment) */
export const ROUTING_CLASSIFIER_MAX_INPUT_CHARS = 16_000;
export const ROUTING_CLASSIFIED_RULE_ID = "routing-classified";

export interface RoutingClassification {
  complexity: Complexity;
  /** `heuristic`: no classifier configured; `external`: the scorer decided; `heuristic-fallback`: it was configured and could not */
  source: "heuristic" | "external" | "heuristic-fallback";
  scorerId: string | null;
  scorerName: string | null;
  score: number | null;
  fallbackReason: string | null;
}

export interface RoutingClassifierDeps {
  resolve?: EgressResolver;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** pick the dispatch's complexity: the configured classifier when there is one and it answers, else the heuristic */
export async function classifyForRouting(
  db: Db,
  dataKey: string | undefined,
  org: { routingClassifierScorerId: string | null },
  text: string | null | undefined,
  deps: RoutingClassifierDeps = {},
): Promise<RoutingClassification> {
  const heuristic = classifyComplexity(text);
  const scorerId = org.routingClassifierScorerId;
  if (!scorerId) {
    return { complexity: heuristic, source: "heuristic", scorerId: null, scorerName: null, score: null, fallbackReason: null };
  }
  const fallback = (scorerName: string | null, fallbackReason: string): RoutingClassification => ({
    complexity: heuristic,
    source: "heuristic-fallback",
    scorerId,
    scorerName,
    score: null,
    fallbackReason: fallbackReason.slice(0, 500),
  });
  const [row] = await db
    .select({
      name: externalScorers.name,
      enabled: externalScorers.enabled,
      scorerKinds: externalScorers.scorerKinds,
      adapter: externalScorers.adapter,
    })
    .from(externalScorers)
    .where(eq(externalScorers.id, scorerId));
  // re-checked per dispatch: a scorer disabled or re-pointed after it was configured is not used
  const problem = routingClassifierProblem(row ? { ...row, scorerKinds: row.scorerKinds ?? [] } : null);
  if (problem) return fallback(row?.name ?? null, problem.detail);
  const { facts, resolved } = await resolveExternalScorersByName(db, dataKey, [row!.name], deps);
  const scorer = resolved.get(row!.name);
  if (!scorer) return fallback(row!.name, facts[0]?.detail ?? "the scorer is not reachable");
  try {
    const verdict = await callExternalScorer(
      scorer,
      { input: (text ?? "").slice(0, ROUTING_CLASSIFIER_MAX_INPUT_CHARS), output: "", context: [], scorerKind: ROUTING_SCORER_KIND },
      { timeoutMs: deps.timeoutMs ?? ROUTING_CLASSIFIER_TIMEOUT_MS },
    );
    const complexity = complexityFromScore(verdict.score);
    if (!complexity) return fallback(row!.name, `the score ${String(verdict.score)} is not in [0, 1]`);
    return { complexity, source: "external", scorerId, scorerName: row!.name, score: verdict.score, fallbackReason: null };
  } catch (err) {
    // a non-2xx reply body may echo the prompt: keep the status, never the body
    const message = errMessage(err);
    const status = /returned HTTP (\d{3})/.exec(message);
    return fallback(row!.name, status ? `external scorer '${row!.name}' returned HTTP ${status[1]}` : message);
  }
}

/** the classifier fields carried on the `model_routing` cost-ledger detail (absent when no classifier is configured) */
export function routingClassifierDetail(c: RoutingClassification): Record<string, unknown> {
  if (c.source === "heuristic") return {};
  return {
    classifier: {
      source: c.source,
      scorerId: c.scorerId,
      scorerName: c.scorerName,
      score: c.score,
      ...(c.fallbackReason ? { fallbackReason: c.fallbackReason } : {}),
    },
  };
}

/**
 * The one audit row of a dispatch routed with a classifier configured. Written for a fallback too, so an outage of
 * the scorer is visible. No row when no classifier is configured: the routing decision is then the heuristic's, as
 * before, and stays in the cost ledger only.
 */
export async function auditRoutingClassification(
  db: Db,
  args: {
    userId: string;
    requestedAgentId: string;
    projectId: string | null;
    classification: RoutingClassification;
    routing: Pick<RoutingDecision, "effect" | "selectedAgentId" | "baselineAgentId" | "ruleId">;
    surface: "invoke" | "compat";
  },
): Promise<void> {
  const c = args.classification;
  if (c.source === "heuristic") return;
  await db.insert(auditLog).values({
    userId: args.userId,
    objectType: "agent",
    objectId: args.requestedAgentId,
    effect: "allow",
    ruleId: ROUTING_CLASSIFIED_RULE_ID,
    ruleChain: [],
    reason:
      c.source === "external"
        ? `routing classifier '${c.scorerName}' scored ${c.score} (${c.complexity}); routing ${args.routing.effect} to ${args.routing.selectedAgentId}`
        : `routing classifier unavailable (${c.fallbackReason}); the built-in heuristic chose ${c.complexity}`,
    detail: {
      phase: "routing",
      receiptClass: "decision",
      surface: args.surface,
      projectId: args.projectId,
      complexity: c.complexity,
      ...routingClassifierDetail(c),
      routing: {
        effect: args.routing.effect,
        requestedAgentId: args.requestedAgentId,
        selectedAgentId: args.routing.selectedAgentId,
        baselineAgentId: args.routing.baselineAgentId,
        ruleId: args.routing.ruleId,
      },
    },
  });
}
