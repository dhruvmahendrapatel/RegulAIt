/**
 * ADR-0214 amendment — per-asset scores. GOLDEN figures: every number below is worked by hand from the published
 * weights (risk 20, adversarial 15, access 15, evaluation 10), so a change to a weight, a formula or the combiner
 * fails here. Pure: no database, no clock.
 */
import { describe, expect, it } from "vitest";
import { ASSET_OBJECTIVES, scoreAsset, type AgentAssetInput, type UseCaseAssetInput } from "./asset-score.js";
import { POSTURE_SCORE_DISCLAIMER, POSTURE_WEIGHTS } from "./posture-score.js";

const agent = (over: Partial<AgentAssetInput> = {}): AgentAssetInput => ({
  kind: "agent",
  id: "a-1",
  name: "triage-bot",
  risks: { open: 1, total: 4 },
  redteam: { hasRun: true, latestAsrUpper: 0.2, runsInWindow: 1 },
  groundedness: { runsInWindow: 2, latestPassRate: 0.9 },
  ownership: "owned",
  ...over,
});

const useCase = (over: Partial<UseCaseAssetInput> = {}): UseCaseAssetInput => ({
  kind: "use_case",
  id: "u-1",
  name: "Claims triage",
  risks: { open: 2, total: 2 },
  ownership: "owned",
  ...over,
});

describe("agent golden scores", () => {
  it("a measured agent: (20·75 + 15·80 + 15·100 + 10·90) ÷ 60 = 85", () => {
    const s = scoreAsset(agent());
    expect(s.score).toBe(85);
    expect(s.objectives.map((o) => [o.id, o.score, o.contribution])).toEqual([
      ["risk", 75, 25],
      ["adversarial", 80, 20],
      ["access", 100, 25],
      ["evaluation", 90, 15],
    ]);
    expect(s.weights).toEqual([
      { objective: "risk", title: "Risk treatment", weight: 20, sharePct: 33.3 },
      { objective: "adversarial", title: "Adversarial resilience", weight: 15, sharePct: 25 },
      { objective: "access", title: "Access hygiene", weight: 15, sharePct: 25 },
      { objective: "evaluation", title: "Answer quality", weight: 10, sharePct: 16.7 },
    ]);
    expect(s.actions.map((a) => [a.rank, a.key, a.points])).toEqual([
      [1, "risk:treat", 8.3],
      [2, "adversarial:harden", 5],
      [3, "evaluation:improve", 1.7],
    ]);
    expect(s.actions[0]!.reason).toBe(
      "Worth 8.3 points: 1 risk is open without a treatment. Risk treatment is at 75 of 100 and carries 33.3% of the estimate.",
    );
    expect(s.actions.every((a) => a.link.to.startsWith("/admin/"))).toBe(true);
  });

  it("an agent with no records scores 0, and every unmeasured objective is an action", () => {
    const s = scoreAsset(
      agent({ risks: { open: 0, total: 0 }, redteam: { hasRun: false, latestAsrUpper: null, runsInWindow: 0 }, groundedness: { runsInWindow: 0, latestPassRate: null }, ownership: "unowned" }),
    );
    expect(s.score).toBe(0);
    expect(s.objectives.filter((o) => o.measured).map((o) => o.id)).toEqual(["access"]);
    // ties (adversarial and access, both 25) break by the published objective order
    expect(s.actions.map((a) => [a.key, a.points])).toEqual([
      ["risk:register", 33.3],
      ["adversarial:probe", 25],
      ["access:owner", 25],
      ["evaluation:run", 16.7],
    ]);
    expect(s.actions[0]!.reason).toMatch(/^Worth up to 33.3 points once measured: /);
  });

  it("a stale red-team result counts at half: 80 → 40, and re-running is worth 10 points", () => {
    const s = scoreAsset(agent({ redteam: { hasRun: true, latestAsrUpper: 0.2, runsInWindow: 0 } }));
    expect(s.objectives.find((o) => o.id === "adversarial")!.score).toBe(40);
    // (20·75 + 15·40 + 15·100 + 10·90) ÷ 60 = 75
    expect(s.score).toBe(75);
    const pts = Object.fromEntries(s.actions.map((a) => [a.key, a.points]));
    expect(pts["adversarial:rerun"]).toBe(10);
    expect(pts["adversarial:harden"]).toBe(2.5);
  });

  it("an orphaned owner costs the whole access objective", () => {
    const s = scoreAsset(agent({ ownership: "orphaned" }));
    expect(s.objectives.find((o) => o.id === "access")!.score).toBe(0);
    // (1500 + 1200 + 0 + 900) ÷ 60 = 60
    expect(s.score).toBe(60);
    expect(s.actions.find((a) => a.key === "access:owner")).toMatchObject({ points: 25, link: { to: "/admin/inventory" } });
  });
});

describe("use-case golden scores", () => {
  it("two open risks and an active owner: 15·100 ÷ 35 = 42.9 → 43", () => {
    const s = scoreAsset(useCase());
    expect(s.score).toBe(43);
    expect(s.objectives.map((o) => [o.id, o.score, o.contribution])).toEqual([
      ["risk", 0, 0],
      ["access", 100, 42.9],
    ]);
    expect(s.actions).toEqual([
      expect.objectContaining({ rank: 1, key: "risk:treat", points: 57.1, link: { to: "/admin/governance/use-cases/u-1", label: "Open the use case" } }),
    ]);
  });

  it("no risks and a deactivated owner scores 0 with two actions", () => {
    const s = scoreAsset(useCase({ risks: { open: 0, total: 0 }, ownership: "orphaned" }));
    expect(s.score).toBe(0);
    expect(s.actions.map((a) => [a.key, a.points])).toEqual([
      ["risk:register", 57.1],
      ["access:owner", 42.9],
    ]);
  });

  it("all risks treated and an active owner is 100", () => {
    expect(scoreAsset(useCase({ risks: { open: 0, total: 3 } })).score).toBe(100);
  });
});

describe("the ADR-0214 principles, per asset", () => {
  it("uses only the published weights, and lists every other objective as not applicable with a reason", () => {
    for (const input of [agent(), useCase()]) {
      const s = scoreAsset(input);
      for (const w of s.weights) expect(w.weight).toBe(POSTURE_WEIGHTS[w.objective]);
      const all = [...s.objectives.map((o) => o.id), ...s.notApplicable.map((o) => o.objective)].sort();
      expect(all).toEqual(Object.keys(POSTURE_WEIGHTS).sort());
      expect(s.notApplicable.every((o) => o.why.length > 10)).toBe(true);
      expect(s.objectives.map((o) => o.id)).toEqual([...ASSET_OBJECTIVES[input.kind]]);
    }
  });

  it("is an estimate with the disclaimer, explains every objective, and never says compliant or certified", () => {
    for (const input of [agent(), useCase(), useCase({ risks: { open: 0, total: 0 }, ownership: "orphaned" })]) {
      const s = scoreAsset(input);
      expect(s.estimate).toBe(true);
      expect(s.disclaimer).toBe(POSTURE_SCORE_DISCLAIMER);
      for (const o of s.objectives) {
        expect(o.formula.length).toBeGreaterThan(20);
        expect(o.inputs.length).toBeGreaterThan(0);
      }
      expect(JSON.stringify(s)).not.toMatch(/\bcompliant\b|\bcertified\b/i);
    }
  });

  it("is deterministic: the same slice gives the same payload", () => {
    expect(scoreAsset(agent())).toEqual(scoreAsset(agent()));
  });
});
