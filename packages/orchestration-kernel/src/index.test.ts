import { describe, expect, it } from "vitest";
import {
  estimateGraphCost,
  initialRunState,
  readyNodes,
  transitionRun,
  validateGraph,
  RunStateError,
  type RunState,
  type TaskGraph,
} from "./index.js";

const AGENT = "11111111-1111-4111-8111-111111111111";
const APPROVER = "22222222-2222-4222-8222-222222222222";

function graph(nodes: Array<Record<string, unknown>>): TaskGraph {
  return validateGraph({ run: "test-run", escalationApproverUserId: APPROVER, nodes });
}

const node = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  title: `task ${id}`,
  ownerAgentId: AGENT,
  mode: "execute",
  ...extra,
});

describe("task graph validation (§3/§4)", () => {
  it("accepts a DAG and defaults parallelizable/dependsOn", () => {
    const g = graph([node("a"), node("b", { dependsOn: ["a"] })]);
    expect(g.nodes[0]!.parallelizable).toBe(true);
    expect(g.nodes[0]!.dependsOn).toEqual([]);
  });

  it("rejects duplicate ids, unknown deps, self-deps, and cycles", () => {
    expect(() => graph([node("a"), node("a")])).toThrow(/duplicate/);
    expect(() => graph([node("a", { dependsOn: ["ghost"] })])).toThrow(/unknown node/);
    expect(() => graph([node("a", { dependsOn: ["a"] })])).toThrow(/depends on itself/);
    expect(() =>
      graph([node("a", { dependsOn: ["b"] }), node("b", { dependsOn: ["a"] })]),
    ).toThrow(/cycle/);
  });

  it("rejects unordered shared file ownership, accepts it when a dependency orders it", () => {
    expect(() =>
      graph([node("a", { files: ["src/x.ts"] }), node("b", { files: ["src/x.ts"] })]),
    ).toThrow(/share ownership/);
    const ok = graph([
      node("a", { files: ["src/x.ts"] }),
      node("b", { files: ["src/x.ts"], dependsOn: ["a"] }),
    ]);
    expect(ok.nodes).toHaveLength(2);
  });
});

describe("ready-set scheduling (§3/§4)", () => {
  const g = graph([
    node("a"),
    node("b"),
    node("c", { dependsOn: ["a", "b"] }),
    node("d", { dependsOn: ["c"], parallelizable: false }),
    node("e", { dependsOn: ["c"] }),
  ]);

  function running(): RunState {
    const { state } = transitionRun(g, initialRunState(g), { kind: "start" });
    return state;
  }

  it("roots are ready in parallel after start; dependents wait", () => {
    const state = running();
    expect(readyNodes(g, state)).toEqual(["a", "b"]);
  });

  it("a completed dependency unlocks dependents", () => {
    let s = running();
    for (const [kind, nodeId] of [
      ["node_started", "a"],
      ["node_submitted", "a"],
      ["node_accepted", "a"],
      ["node_started", "b"],
      ["node_submitted", "b"],
    ] as const) {
      s = transitionRun(g, s, { kind, nodeId }).state;
    }
    expect(readyNodes(g, s)).toEqual([]); // c waits on b (in_review ≠ done)
    const { state: afterB, effects } = transitionRun(g, s, { kind: "node_accepted", nodeId: "b" });
    expect(readyNodes(g, afterB)).toEqual(["c"]);
    expect(effects).toEqual([{ kind: "dispatch_nodes", nodeIds: ["c"] }]);
  });

  it("a non-parallelizable node serializes the run in both directions", () => {
    let s = running();
    for (const nodeId of ["a", "b"]) {
      s = transitionRun(g, s, { kind: "node_started", nodeId }).state;
      s = transitionRun(g, s, { kind: "node_submitted", nodeId }).state;
      s = transitionRun(g, s, { kind: "node_accepted", nodeId }).state;
    }
    s = transitionRun(g, s, { kind: "node_started", nodeId: "c" }).state;
    // d (non-parallelizable) not ready while c is in progress — and neither is e
    expect(readyNodes(g, s)).toEqual([]);
    s = transitionRun(g, s, { kind: "node_submitted", nodeId: "c" }).state;
    s = transitionRun(g, s, { kind: "node_accepted", nodeId: "c" }).state;
    expect(readyNodes(g, s)).toEqual(["d", "e"]);
    // e starts → the serializing d must wait for an idle run
    s = transitionRun(g, s, { kind: "node_started", nodeId: "e" }).state;
    expect(readyNodes(g, s)).toEqual([]);
    expect(() => transitionRun(g, s, { kind: "node_started", nodeId: "d" })).toThrow(RunStateError);
  });
});

describe("run lifecycle + failure handling (§3)", () => {
  const g = graph([node("only")]);

  it("start → work → accept completes the run; terminal states reject events", () => {
    let s = initialRunState(g);
    expect(s.status).toBe("planned");
    const started = transitionRun(g, s, { kind: "start" });
    expect(started.effects).toEqual([{ kind: "dispatch_nodes", nodeIds: ["only"] }]);
    s = started.state;
    s = transitionRun(g, s, { kind: "node_started", nodeId: "only" }).state;
    s = transitionRun(g, s, { kind: "node_submitted", nodeId: "only" }).state;
    s = transitionRun(g, s, { kind: "node_accepted", nodeId: "only" }).state;
    expect(s.status).toBe("completed");
    expect(() => transitionRun(g, s, { kind: "abort" })).toThrow(/terminal/);
  });

  it("failure → blocked; retry increments attempts; reassign changes the owner", () => {
    let s = transitionRun(g, initialRunState(g), { kind: "start" }).state;
    s = transitionRun(g, s, { kind: "node_started", nodeId: "only" }).state;
    s = transitionRun(g, s, { kind: "node_failed", nodeId: "only", error: "boom" }).state;
    expect(s.nodeStatuses.only).toBe("blocked");
    expect(s.lastError.only).toBe("boom");

    const retried = transitionRun(g, s, { kind: "retry_node", nodeId: "only" });
    expect(retried.state.attempts.only).toBe(1);
    expect(retried.effects).toEqual([{ kind: "dispatch_nodes", nodeIds: ["only"] }]);

    const other = "33333333-3333-4333-8333-333333333333";
    const reassigned = transitionRun(g, s, { kind: "reassign_node", nodeId: "only", ownerAgentId: other });
    expect(reassigned.state.owners.only).toBe(other);
    expect(reassigned.state.nodeStatuses.only).toBe("not_started");
  });

  it("escalation emits a request_approval effect and leaves the node blocked", () => {
    let s = transitionRun(g, initialRunState(g), { kind: "start" }).state;
    s = transitionRun(g, s, { kind: "node_started", nodeId: "only" }).state;
    s = transitionRun(g, s, { kind: "node_failed", nodeId: "only", error: "boom" }).state;
    const { state, effects } = transitionRun(g, s, { kind: "escalate_node", nodeId: "only" });
    expect(effects).toEqual([{ kind: "request_approval", nodeId: "only" }]);
    expect(state.nodeStatuses.only).toBe("blocked");
    // escalating a healthy node is invalid
    expect(() =>
      transitionRun(g, transitionRun(g, initialRunState(g), { kind: "start" }).state, {
        kind: "escalate_node",
        nodeId: "only",
      }),
    ).toThrow(RunStateError);
  });

  it("guards status transitions: no skipping review, no double start", () => {
    let s = transitionRun(g, initialRunState(g), { kind: "start" }).state;
    expect(() => transitionRun(g, s, { kind: "node_accepted", nodeId: "only" })).toThrow(RunStateError);
    expect(() => transitionRun(g, s, { kind: "start" })).toThrow(/already started/);
    s = transitionRun(g, s, { kind: "node_started", nodeId: "only" }).state;
    expect(() => transitionRun(g, s, { kind: "node_started", nodeId: "only" })).toThrow(RunStateError);
  });
});

describe("graph cost estimation (§5.2)", () => {
  const OTHER = "44444444-4444-4444-8444-444444444444";
  const g = graph([
    node("a", { estimate: { in: 1000, out: 1000 } }),
    node("b", { estimate: { in: 2000, out: 500 }, dependsOn: ["a"] }),
  ]);
  const pricing = { [AGENT]: { costPerMTokIn: 10, costPerMTokOut: 30 } };
  const fallback = () => ({ in: 100, out: 100 });

  it("sums per-node cost from declared estimates and current owners", () => {
    const c = estimateGraphCost(g, initialRunState(g).owners, pricing, fallback);
    // a: (1000*10 + 1000*30)/1e6 = 0.04; b: (2000*10 + 500*30)/1e6 = 0.035
    expect(c.perNodeUsd.a).toBeCloseTo(0.04, 6);
    expect(c.perNodeUsd.b).toBeCloseTo(0.035, 6);
    expect(c.totalUsd).toBeCloseTo(0.075, 6);
    expect(c.unpricedNodes).toEqual([]);
  });

  it("uses the fallback token estimator when a node declares none", () => {
    const g2 = graph([node("x")]);
    const c = estimateGraphCost(g2, initialRunState(g2).owners, pricing, fallback);
    expect(c.perNodeUsd.x).toBeCloseTo((100 * 10 + 100 * 30) / 1e6, 9);
  });

  it("an unpriced owner nullifies the total (fail-closed under a cap)", () => {
    const c = estimateGraphCost(g, { ...initialRunState(g).owners, b: OTHER }, pricing, fallback);
    expect(c.totalUsd).toBeNull();
    expect(c.unpricedNodes).toEqual(["b"]);
    expect(c.perNodeUsd.a).toBeCloseTo(0.04, 6);
  });

  it("reassignment changes the estimate through the owners map", () => {
    const richer = { ...pricing, [OTHER]: { costPerMTokIn: 1, costPerMTokOut: 3 } };
    const c = estimateGraphCost(g, { ...initialRunState(g).owners, b: OTHER }, richer, fallback);
    expect(c.perNodeUsd.b).toBeCloseTo((2000 * 1 + 500 * 3) / 1e6, 9);
  });
});
