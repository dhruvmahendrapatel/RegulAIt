/**
 * ADR-0173 batch 2b — the run graph's left-to-right layered layout.
 *
 * The layering is @dagrejs/dagre's (MIT; see apps/web/THIRD_PARTY.md), not
 * ours: a hand-written column layout cannot route a DAG with fan-out, fan-in
 * and back-references without crossings. Imported only by the lazy-loaded
 * canvas, so dagre stays out of the main bundle.
 */
import dagre from "@dagrejs/dagre";

export const NODE_WIDTH = 220;
export const NODE_HEIGHT = 72;

export interface PlacedNode {
  id: string;
  /** top-left, as the canvas positions nodes */
  x: number;
  y: number;
}

export interface RunGraphLayout {
  nodes: PlacedNode[];
  width: number;
  height: number;
}

/** what the layout reads: node ids and directed edges (the run graph, and since ADR-0341 the pipeline builder) */
export interface LayoutInput {
  nodes: ReadonlyArray<{ id: string }>;
  edges: ReadonlyArray<{ from: string; to: string; kind: string }>;
}

export function layoutRunGraph(graph: LayoutInput): RunGraphLayout {
  const g = new dagre.graphlib.Graph({ multigraph: true });
  g.setGraph({ rankdir: "LR", ranksep: 56, nodesep: 20, marginx: 8, marginy: 8 });
  g.setDefaultEdgeLabel(() => ({}));
  const ids = new Set(graph.nodes.map((n) => n.id));
  for (const n of graph.nodes) g.setNode(n.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  graph.edges.forEach((e, i) => {
    if (ids.has(e.from) && ids.has(e.to) && e.from !== e.to) g.setEdge(e.from, e.to, {}, `${e.kind}:${i}`);
  });
  dagre.layout(g);
  const nodes = graph.nodes.map((n) => {
    const p = g.node(n.id) as { x: number; y: number };
    return { id: n.id, x: Math.round(p.x - NODE_WIDTH / 2), y: Math.round(p.y - NODE_HEIGHT / 2) };
  });
  const label = g.graph() as { width?: number; height?: number };
  return { nodes, width: label.width ?? 0, height: label.height ?? 0 };
}
