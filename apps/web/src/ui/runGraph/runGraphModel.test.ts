/**
 * ADR-0173 batch 2b — the run graph's words and layout, without a browser.
 * The keyboard and screen-reader behaviour in the page is covered by
 * e2e/run-graph.mock.spec.ts.
 */
import { describe, expect, it } from "vitest";
import { layoutRunGraph, NODE_WIDTH } from "./runGraphLayout";
import {
  edgeSentence,
  fmtCost,
  runGraphPath,
  stepSentence,
  summaryText,
  type RunPathGraph,
  type RunPathNode,
} from "./runGraphModel";

const node = (over: Partial<RunPathNode> & Pick<RunPathNode, "id" | "label">): RunPathNode => ({
  type: "task",
  status: "done",
  rawStatus: null,
  statusDetail: null,
  actor: null,
  at: null,
  endedAt: null,
  costUsd: null,
  links: { auditLogId: null, traceId: null, spanId: null, approvalId: null },
  facts: [],
  ...over,
});

describe("run graph words", () => {
  it("reads each step as one sentence: position, label, status, actor, cost", () => {
    const n = node({ id: "m", label: "Model step 1", actor: { kind: "model", id: "x", name: "claude-default" }, costUsd: 0.0012 });
    expect(stepSentence(n, 1, 6)).toBe("Step 2 of 6: Model step 1. Done. Model: claude-default. Cost $0.0012.");
    // an unrecorded name says so, never an id
    const anon = node({ id: "a", label: "Plan", status: "waiting", actor: { kind: "agent", id: "abc", name: null } });
    expect(stepSentence(anon, 0, 1)).toBe("Step 1 of 1: Plan. Waiting. Agent: Agent (name not recorded).");
  });

  it("never turns an unpriced step into $0, and keeps tiny costs visible", () => {
    expect(fmtCost(null)).toBeNull();
    expect(fmtCost(0)).toBe("$0");
    expect(fmtCost(0.00001)).toBe("under $0.0001");
    expect(fmtCost(1.5)).toBe("$1.5");
    expect(summaryText({ summary: { nodes: 3, costUsd: null, denied: 1, waiting: 0, errors: 2 } })).toBe(
      "3 steps · no measured cost · 1 denied · 2 with errors",
    );
  });

  it("names edges by what they mean", () => {
    const labels: Record<string, string> = { a: "Model step 1", b: "Read" };
    expect(edgeSentence({ from: "a", to: "b", kind: "tool_call" }, (id) => labels[id]!)).toBe("Model step 1 calls a tool: Read");
  });

  it("reads from the run-graph routes, ids encoded", () => {
    expect(runGraphPath({ kind: "builder_turn", threadId: "t1", turn: 3 })).toBe("/v1/run-graph/builder-turn/t1/3");
    expect(runGraphPath({ kind: "orchestration", runId: "r/1" })).toBe("/v1/run-graph/orchestration/r%2F1");
    expect(runGraphPath({ kind: "use_case", useCaseId: "u1" })).toBe("/v1/run-graph/use-case/u1");
  });
});

describe("run graph layout (dagre, left to right)", () => {
  const graph: Pick<RunPathGraph, "nodes" | "edges"> = {
    nodes: ["run", "a", "b", "c", "d"].map((id) => node({ id, label: id })),
    edges: [
      { from: "run", to: "a", kind: "starts" },
      { from: "run", to: "b", kind: "starts" },
      { from: "a", to: "c", kind: "depends_on" },
      { from: "b", to: "c", kind: "depends_on" },
      { from: "a", to: "c", kind: "leads" }, // a second edge between the same pair
      { from: "c", to: "d", kind: "escalated" },
      { from: "c", to: "ghost", kind: "depends_on" }, // an edge to a node not in the graph is ignored
    ],
  };

  it("places every edge's target to the right of its source, and parallel steps in one layer", () => {
    const out = layoutRunGraph(graph);
    const at = new Map(out.nodes.map((p) => [p.id, p]));
    expect(out.nodes).toHaveLength(5);
    for (const e of graph.edges.filter((x) => at.has(x.to))) expect(at.get(e.to)!.x).toBeGreaterThanOrEqual(at.get(e.from)!.x + NODE_WIDTH);
    expect(at.get("a")!.x).toBe(at.get("b")!.x);
    expect(at.get("a")!.y).not.toBe(at.get("b")!.y);
    expect(out.width).toBeGreaterThan(4 * NODE_WIDTH);
  });

  it("is deterministic", () => {
    expect(layoutRunGraph(graph)).toEqual(layoutRunGraph(graph));
  });
});
