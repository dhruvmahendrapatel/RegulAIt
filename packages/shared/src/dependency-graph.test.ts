import { describe, expect, it } from "vitest";
import { effectiveRiskRating, propagateRisk, rateRisk, type GraphEdgeInput } from "./dependency-graph.js";

const own = (entries: Array<[string, number, string]>) =>
  new Map(
    entries.map(([k, score, riskId]) => [
      k,
      { rating: { score, band: score >= 6 ? ("high" as const) : score >= 3 ? ("medium" as const) : ("low" as const) }, riskId },
    ]),
  );

describe("ADR-0156 risk rating", () => {
  it("uses the 3×3 matrix bands", () => {
    expect(rateRisk("low", "low")).toEqual({ score: 1, band: "low" });
    expect(rateRisk("low", "medium")).toEqual({ score: 2, band: "low" });
    expect(rateRisk("medium", "low")).toEqual({ score: 2, band: "low" });
    expect(rateRisk("low", "high")).toEqual({ score: 3, band: "medium" });
    expect(rateRisk("medium", "medium")).toEqual({ score: 4, band: "medium" });
    expect(rateRisk("medium", "high")).toEqual({ score: 6, band: "high" });
    expect(rateRisk("high", "high")).toEqual({ score: 9, band: "high" });
  });

  it("prefers residual, excludes closed, keeps accepted", () => {
    const base = { id: "r", title: "t", likelihood: "high", impact: "high", residualLikelihood: null, residualImpact: null } as const;
    expect(effectiveRiskRating({ ...base, status: "open" })).toMatchObject({ score: 9, basis: "inherent" });
    expect(
      effectiveRiskRating({ ...base, status: "mitigating", residualLikelihood: "low", residualImpact: "medium" }),
    ).toMatchObject({ score: 2, band: "low", basis: "residual" });
    expect(effectiveRiskRating({ ...base, status: "accepted" })).toMatchObject({ score: 9 });
    expect(effectiveRiskRating({ ...base, status: "closed" })).toBeNull();
  });
});

describe("ADR-0156 propagation", () => {
  it("a use case inherits the worst rating of its transitive dependencies, with the path", () => {
    const nodes = ["uc", "agent", "model", "vendor"];
    const edges: GraphEdgeInput[] = [
      { from: "uc", to: "agent", kind: "uses_agent", basis: "declared" },
      { from: "agent", to: "model", kind: "runs_on", basis: "declared" },
      { from: "model", to: "vendor", kind: "supplied_by", basis: "declared" },
    ];
    const p = propagateRisk(nodes, own([["agent", 4, "r-agent"], ["vendor", 9, "r-vendor"]]), edges);
    expect(p.get("uc")).toMatchObject({ score: 9, band: "high", sourceNodeKey: "vendor", sourceRiskId: "r-vendor" });
    expect(p.get("uc")!.path).toEqual(["uc", "agent", "model", "vendor"]);
    expect(p.get("vendor")).toMatchObject({ score: 9, sourceNodeKey: "vendor", path: ["vendor"] });
  });

  it("propagation runs only toward dependents, never to dependencies", () => {
    const p = propagateRisk(
      ["uc", "agent"],
      own([["uc", 9, "r-uc"]]),
      [{ from: "uc", to: "agent", kind: "uses_agent", basis: "declared" }],
    );
    expect(p.get("agent")).toMatchObject({ score: 0, band: "none", sourceNodeKey: null });
  });

  it("a node's own risk wins a tie against an inherited one", () => {
    const p = propagateRisk(
      ["uc", "agent"],
      own([["uc", 6, "r-uc"], ["agent", 6, "r-agent"]]),
      [{ from: "uc", to: "agent", kind: "uses_agent", basis: "declared" }],
    );
    expect(p.get("uc")).toMatchObject({ sourceNodeKey: "uc", sourceRiskId: "r-uc" });
  });

  it("is a maximum, not a sum: two mediums stay medium", () => {
    const p = propagateRisk(
      ["uc", "a", "b"],
      own([["a", 4, "ra"], ["b", 4, "rb"]]),
      [
        { from: "uc", to: "a", kind: "uses_agent", basis: "declared" },
        { from: "uc", to: "b", kind: "uses_agent", basis: "declared" },
      ],
    );
    expect(p.get("uc")).toMatchObject({ score: 4, band: "medium" });
  });

  it("terminates on cycles and does not route a path through itself", () => {
    const edges: GraphEdgeInput[] = [
      { from: "a", to: "b", kind: "consumes_output", basis: "observed" },
      { from: "b", to: "a", kind: "consumes_output", basis: "observed" },
      { from: "b", to: "c", kind: "consumes_output", basis: "observed" },
    ];
    const p = propagateRisk(["a", "b", "c"], own([["c", 9, "rc"]]), edges);
    expect(p.get("a")).toMatchObject({ score: 9, path: ["a", "b", "c"] });
    expect(p.get("b")).toMatchObject({ score: 9, path: ["b", "c"] });
    for (const v of p.values()) expect(new Set(v.path).size).toBe(v.path.length);
  });

  it("ignores edges to unknown nodes and self-loops", () => {
    const p = propagateRisk(
      ["a"],
      own([]),
      [
        { from: "a", to: "ghost", kind: "uses_agent", basis: "declared" },
        { from: "a", to: "a", kind: "consumes_output", basis: "observed" },
      ],
    );
    expect(p.get("a")).toMatchObject({ score: 0 });
  });

  it("is independent of edge order", () => {
    const edges: GraphEdgeInput[] = [
      { from: "uc", to: "a", kind: "uses_agent", basis: "declared" },
      { from: "uc", to: "b", kind: "uses_agent", basis: "declared" },
      { from: "b", to: "m", kind: "runs_on", basis: "declared" },
      { from: "a", to: "m", kind: "runs_on", basis: "declared" },
    ];
    const o = own([["m", 6, "rm"]]);
    const x = propagateRisk(["uc", "a", "b", "m"], o, edges).get("uc");
    const y = propagateRisk(["uc", "a", "b", "m"], o, [...edges].reverse()).get("uc");
    expect(x).toEqual(y);
  });
});
