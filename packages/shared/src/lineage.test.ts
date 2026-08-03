import { describe, expect, it } from "vitest";
import {
  LINEAGE_COMPLETENESS_NOTE,
  directRunLineage,
  lineageNaturalKey,
  traverseLineage,
  type LineageEdgeLike,
} from "./lineage.js";

/**
 * ADR-0050, the pure half. Three things this file exists to make impossible:
 *
 *  1. A TRAVERSAL THAT NEVER TERMINATES. Cycles in a lineage graph are real,
 *     not hypothetical (a context item produced by a run that consumed an
 *     earlier version of itself), so a cycle and a deep chain are both walked
 *     here with assertions on termination, not just on the answer.
 *  2. AN EDGE THAT DISCLOSES A NODE THE CALLER CANNOT SEE. The visibility
 *     cases assert on the RETURNED EDGE LIST: an invisible endpoint must
 *     produce no edge at all, only a count. An id appearing anywhere in the
 *     payload would already be the leak.
 *  3. A GRAPH THAT SILENTLY FORKS. `lineageNaturalKey` is the dedupe identity;
 *     if two writes describing the same thing derived different keys, every
 *     traversal would under-report and look fine.
 */

const e = (id: string, from: string, to: string, kind: LineageEdgeLike["kind"]): LineageEdgeLike => ({
  id,
  fromNodeId: from,
  toNodeId: to,
  kind,
});

/**
 * The canonical cross-run chain from ADR-0050 §1:
 *
 *   docA ──flowed_into──▶ runA ──produced──▶ item(v1)
 *   item(v1) ──derived_from──▶ item(v2)     (v2 derives from v1; stored v1→v2,
 *                                            i.e. in the direction data flows)
 *   item(v2) ──flowed_into──▶ runB ──produced──▶ outB
 */
const chain: LineageEdgeLike[] = [
  e("e1", "docA", "runA", "flowed_into"),
  e("e2", "runA", "itemV1", "produced"),
  e("e3", "itemV1", "itemV2", "derived_from"),
  e("e4", "itemV2", "runB", "flowed_into"),
  e("e5", "runB", "outB", "produced"),
];

describe("ADR-0050 — natural keys are the graph's dedupe identity", () => {
  it("derives the same key for the same real thing, and different keys for different versions", () => {
    const v1 = lineageNaturalKey({ subtype: "context_item", refKey: "api-spec", version: 1 });
    const v1again = lineageNaturalKey({ subtype: "context_item", refKey: "api-spec", version: 1 });
    const v2 = lineageNaturalKey({ subtype: "context_item", refKey: "api-spec", version: 2 });
    expect(v1).toBe(v1again);
    expect(v1).not.toBe(v2);
    expect(v1).toBe("context_item:api-spec:v1");
  });

  it("distinguishes subtypes that happen to share a reference", () => {
    const id = "11111111-1111-1111-1111-111111111111";
    expect(lineageNaturalKey({ subtype: "run_node", refId: id })).not.toBe(
      lineageNaturalKey({ subtype: "dispatch_output", refId: id }),
    );
  });
});

describe("ADR-0050 — a traversal answers the supplied-inputs question", () => {
  it("walks BACKWARD from an output to the run, the item, the earlier run and its source", () => {
    const r = traverseLineage({ startNodeId: "outB", edges: chain, direction: "backward", maxDepth: 10 });
    expect(r.nodeIds).toEqual(["outB", "runB", "itemV2", "itemV1", "runA", "docA"]);
    expect(r.depths.runB).toBe(1);
    expect(r.depths.docA).toBe(5);
    expect(r.truncated).toBe(false);
    // every returned edge has both endpoints in the returned node set
    for (const edge of r.edges) {
      expect(r.nodeIds).toContain(edge.fromNodeId);
      expect(r.nodeIds).toContain(edge.toNodeId);
    }
  });

  it("walks FORWARD from a source to everything it reached", () => {
    const r = traverseLineage({ startNodeId: "docA", edges: chain, direction: "forward", maxDepth: 10 });
    // every edge points downstream, so forward from the original document
    // reaches the whole chain it eventually fed
    expect(r.nodeIds).toEqual(["docA", "runA", "itemV1", "itemV2", "runB", "outB"]);
  });

  it("'both' spans the whole connected component", () => {
    const r = traverseLineage({ startNodeId: "itemV1", edges: chain, direction: "both", maxDepth: 10 });
    expect(new Set(r.nodeIds)).toEqual(new Set(["itemV1", "runA", "docA", "itemV2", "runB", "outB"]));
  });

  it("carries the completeness note on every answer", () => {
    const r = traverseLineage({ startNodeId: "outB", edges: chain, direction: "backward", maxDepth: 1 });
    expect(r.note).toBe(LINEAGE_COMPLETENESS_NOTE);
    expect(r.note).toMatch(/not intra-model attribution/);
    expect(r.note).toMatch(/gateway visibility/);
  });
});

describe("ADR-0050 — cycles and deep chains terminate", () => {
  it("terminates on a direct cycle rather than looping", () => {
    const cyclic = [
      e("c1", "a", "b", "flowed_into"),
      e("c2", "b", "c", "produced"),
      e("c3", "c", "a", "derived_from"), // back to the start
    ];
    const r = traverseLineage({ startNodeId: "a", edges: cyclic, direction: "forward", maxDepth: 50 });
    expect(new Set(r.nodeIds)).toEqual(new Set(["a", "b", "c"]));
    expect(r.nodeIds.length).toBe(3); // each node exactly once
    expect(r.edges.length).toBe(3);
  });

  it("terminates on a self-referential item version chain", () => {
    const selfish = [e("s1", "x", "x", "derived_from")];
    const r = traverseLineage({ startNodeId: "x", edges: selfish, direction: "both", maxDepth: 50 });
    expect(r.nodeIds).toEqual(["x"]);
  });

  it("stops at maxDepth and SAYS the answer is partial", () => {
    // a 20-long chain n0 -> n1 -> ... -> n20
    const long: LineageEdgeLike[] = Array.from({ length: 20 }, (_, i) =>
      e(`l${i}`, `n${i}`, `n${i + 1}`, "produced"),
    );
    const r = traverseLineage({ startNodeId: "n0", edges: long, direction: "forward", maxDepth: 3 });
    expect(r.nodeIds).toEqual(["n0", "n1", "n2", "n3"]);
    expect(r.maxDepthReached).toBe(3);
    expect(r.truncated).toBe(true);

    // ...and a walk that genuinely reaches the end is NOT marked truncated
    const full = traverseLineage({ startNodeId: "n0", edges: long, direction: "forward", maxDepth: 30 });
    expect(full.truncated).toBe(false);
    expect(full.nodeIds.length).toBe(21);
  });

  it("stops at maxNodes on a wide fan-out and says so", () => {
    const wide: LineageEdgeLike[] = Array.from({ length: 100 }, (_, i) =>
      e(`w${i}`, "hub", `leaf${i}`, "produced"),
    );
    const r = traverseLineage({
      startNodeId: "hub",
      edges: wide,
      direction: "forward",
      maxDepth: 5,
      maxNodes: 10,
    });
    expect(r.nodeIds.length).toBe(10);
    expect(r.truncated).toBe(true);
  });
});

describe("ADR-0050 — lineage never reveals context the caller cannot access", () => {
  /** the same chain, but `itemV2` belongs to a project the caller is not on */
  const hidden = new Set(["itemV2"]);
  const isVisible = (id: string) => !hidden.has(id);

  it("omits the invisible node AND the edge that would reveal it exists", () => {
    const r = traverseLineage({
      startNodeId: "outB",
      edges: chain,
      direction: "backward",
      maxDepth: 10,
      isVisible,
    });
    expect(r.nodeIds).toEqual(["outB", "runB"]);
    expect(r.nodeIds).not.toContain("itemV2");
    // the invisible id appears NOWHERE — not as an endpoint of a returned edge,
    // not in the depths map. Its existence is reported only as a count.
    const serialized = JSON.stringify(r);
    expect(serialized).not.toContain("itemV2");
    expect(r.withheldEdges).toBe(1);
  });

  it("does not let the walk CONTINUE THROUGH an invisible node to visible ancestors", () => {
    // docA, runA and itemV1 are all visible, but the ONLY path to them from
    // outB runs through the hidden itemV2. A traversal that "skipped over" the
    // hidden node would disclose the shape of a graph the caller cannot see.
    const r = traverseLineage({
      startNodeId: "outB",
      edges: chain,
      direction: "backward",
      maxDepth: 10,
      isVisible,
    });
    for (const id of ["itemV1", "runA", "docA"]) expect(r.nodeIds).not.toContain(id);
  });

  it("returns nothing at all when the START node is invisible", () => {
    const r = traverseLineage({
      startNodeId: "itemV2",
      edges: chain,
      direction: "both",
      maxDepth: 10,
      isVisible,
    });
    expect(r.nodeIds).toEqual([]);
    expect(r.edges).toEqual([]);
  });

  it("counts each withheld edge once, however many times the walk meets it", () => {
    const shared = [
      e("x1", "secret", "run1", "flowed_into"),
      e("x2", "secret", "run2", "flowed_into"),
      e("x3", "run1", "art", "produced"),
      e("x4", "run2", "art", "produced"),
    ];
    const r = traverseLineage({
      startNodeId: "art",
      edges: shared,
      direction: "backward",
      maxDepth: 5,
      isVisible: (id) => id !== "secret",
    });
    expect(new Set(r.nodeIds)).toEqual(new Set(["art", "run1", "run2"]));
    expect(r.withheldEdges).toBe(2); // two distinct edges, not four visits
    expect(JSON.stringify(r)).not.toContain("secret");
  });
});

describe("ADR-0050 — the direct per-run answer", () => {
  it("separates supplied inputs from produced outputs", () => {
    const r = directRunLineage({ runNodeId: "runB", edges: chain });
    expect(r.inputs).toEqual(["itemV2"]);
    expect(r.outputs).toEqual(["outB"]);
    expect(r.withheldEdges).toBe(0);
  });

  it("withholds an input the caller cannot see, as a count only", () => {
    const r = directRunLineage({ runNodeId: "runB", edges: chain, isVisible: (id) => id !== "itemV2" });
    expect(r.inputs).toEqual([]);
    expect(r.withheldEdges).toBe(1);
    expect(JSON.stringify(r)).not.toContain("itemV2");
  });
});
