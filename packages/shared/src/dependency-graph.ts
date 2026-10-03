/**
 * ADR-0156 — THE AI-SYSTEM DEPENDENCY GRAPH and RISK PROPAGATION over it.
 *
 * Pure half: the vocabularies, the risk rating, and the propagation. The
 * gateway (`apps/gateway/src/dependency-graph.ts`) builds the nodes and edges
 * from records the platform already keeps and hands them here.
 *
 * WHAT "PROPAGATION" MEANS HERE, AND WHAT IT DOES NOT.
 * A node's PROPAGATED rating is the worst rating among itself and everything
 * it DEPENDS ON, transitively — a use case is at least as exposed as the
 * riskiest agent, model, vendor or tool it relies on. It is a MAX, not a sum
 * and not a probability: stacking two "medium" risks does not make a "high"
 * one, and pretending otherwise would manufacture precision the register
 * does not have. Every propagated rating names the node it came FROM, so a
 * reviewer can walk to the actual risk instead of trusting the colour.
 *
 * Ratings are DECLARED human judgments (likelihood × impact on the
 * register's three-level scale), never measurements. Residual is used when a
 * reviewer has set it (ADR-0147); otherwise inherent. Closed risks do not
 * count; accepted risks DO — accepting a risk is a decision to carry it, and
 * a graph that hid carried risk would be the one place it disappears.
 */
import { AI_RISK_LEVELS, type AiRiskLevel, type AiRiskStatus } from "./risks.js";

export const GRAPH_NODE_TYPES = [
  "use_case",
  "agent",
  "model",
  "vendor",
  "mcp_server",
  "connector",
] as const;
export type GraphNodeType = (typeof GRAPH_NODE_TYPES)[number];

/**
 * Edge kinds, each pointing FROM the dependent TO the dependency.
 *  - `uses_agent`     use case → agent       (declared: intended agents)
 *  - `runs_on`        agent → model          (declared: registry provider/model)
 *  - `supplied_by`    model → vendor         (declared: vendor's linked providers)
 *  - `calls_tool`     agent → mcp_server     (observed: trace spans)
 *  - `calls_connector` agent → connector     (observed: trace spans)
 *  - `consumes_output` agent → agent         (observed: orchestration feeds)
 */
export const GRAPH_EDGE_KINDS = [
  "uses_agent",
  "runs_on",
  "supplied_by",
  "calls_tool",
  "calls_connector",
  "consumes_output",
] as const;
export type GraphEdgeKind = (typeof GRAPH_EDGE_KINDS)[number];

/** declared = a register says so; observed = the trace ledger saw it happen */
export type GraphEdgeBasis = "declared" | "observed";

export const RISK_BANDS = ["none", "low", "medium", "high"] as const;
export type RiskBand = (typeof RISK_BANDS)[number];

export interface RiskRating {
  /** (likelihood index + 1) × (impact index + 1): 1..9; 0 when no risk */
  score: number;
  band: RiskBand;
}

export const NO_RISK: RiskRating = Object.freeze({ score: 0, band: "none" as const });

/** The standard 3×3 matrix: 1–2 low, 3–4 medium, 6–9 high. */
export function rateRisk(likelihood: AiRiskLevel, impact: AiRiskLevel): RiskRating {
  const score = (AI_RISK_LEVELS.indexOf(likelihood) + 1) * (AI_RISK_LEVELS.indexOf(impact) + 1);
  return { score, band: score >= 6 ? "high" : score >= 3 ? "medium" : "low" };
}

export interface GraphRiskInput {
  id: string;
  title: string;
  status: AiRiskStatus;
  likelihood: AiRiskLevel;
  impact: AiRiskLevel;
  residualLikelihood: AiRiskLevel | null;
  residualImpact: AiRiskLevel | null;
}

/** The rating a risk contributes right now, or null when it contributes none. */
export function effectiveRiskRating(
  r: GraphRiskInput,
): (RiskRating & { basis: "residual" | "inherent" }) | null {
  if (r.status === "closed") return null;
  if (r.residualLikelihood && r.residualImpact) {
    return { ...rateRisk(r.residualLikelihood, r.residualImpact), basis: "residual" };
  }
  return { ...rateRisk(r.likelihood, r.impact), basis: "inherent" };
}

export interface GraphNodeKey {
  key: string;
}

export interface GraphEdgeInput {
  from: string;
  to: string;
  kind: GraphEdgeKind;
  basis: GraphEdgeBasis;
}

export interface PropagatedRating extends RiskRating {
  /** node key the worst rating came from — the node itself when it is its own worst */
  sourceNodeKey: string | null;
  /** risk id behind it, so a reviewer can open the actual entry */
  sourceRiskId: string | null;
  /** dependency path from this node to the source, inclusive at both ends */
  path: string[];
}

/**
 * Propagate the worst own-rating along dependency edges (from → to means
 * `from` depends on `to`). Cycle-safe: an orchestration feed can run both
 * ways between two agents. Max-propagation over a finite lattice is
 * monotone, so a Bellman-Ford style relaxation converges in at most |V|
 * rounds; the bound is enforced rather than assumed.
 *
 * Ties keep the shorter path, then the node's own risk — so the answer is
 * deterministic for a fixed input regardless of edge order.
 */
export function propagateRisk(
  nodeKeys: readonly string[],
  own: ReadonlyMap<string, { rating: RiskRating; riskId: string | null }>,
  edges: readonly GraphEdgeInput[],
): Map<string, PropagatedRating> {
  const out = new Map<string, PropagatedRating>();
  for (const k of nodeKeys) {
    const o = own.get(k);
    out.set(
      k,
      o && o.rating.score > 0
        ? { ...o.rating, sourceNodeKey: k, sourceRiskId: o.riskId, path: [k] }
        : { ...NO_RISK, sourceNodeKey: null, sourceRiskId: null, path: [k] },
    );
  }
  const known = new Set(nodeKeys);
  const usable = edges
    .filter((e) => known.has(e.from) && known.has(e.to) && e.from !== e.to)
    .sort((a, b) => (a.from + a.to).localeCompare(b.from + b.to));
  for (let round = 0; round < nodeKeys.length; round++) {
    let changed = false;
    for (const e of usable) {
      const dep = out.get(e.to)!;
      const cur = out.get(e.from)!;
      if (dep.score === 0) continue;
      const better =
        dep.score > cur.score ||
        (dep.score === cur.score && cur.sourceNodeKey !== null && dep.path.length + 1 < cur.path.length);
      if (!better) continue;
      // never route a path back through the node itself (cycles)
      if (dep.path.includes(e.from)) continue;
      out.set(e.from, {
        score: dep.score,
        band: dep.band,
        sourceNodeKey: dep.sourceNodeKey,
        sourceRiskId: dep.sourceRiskId,
        path: [e.from, ...dep.path],
      });
      changed = true;
    }
    if (!changed) break;
  }
  return out;
}

export const DEPENDENCY_GRAPH_NOTES = {
  propagation:
    "A node's propagated rating is the worst declared rating among itself and everything it depends on, " +
    "transitively. It is a maximum, not a sum or a probability.",
  ratings:
    "Ratings are declared likelihood × impact from the risk register (residual when set, otherwise inherent). " +
    "Closed risks are excluded; accepted risks are included because accepting a risk means carrying it.",
  observed:
    "Observed edges come from the trace ledger and orchestration history in the inventory window; an " +
    "absence of an observed edge is not evidence the dependency cannot exist.",
} as const;
