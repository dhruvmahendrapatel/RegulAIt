/**
 * ADR-0214 (PENDING P3) — the posture estimate is deterministic, its ranking
 * is stable, and every figure explains itself. Pure: no database, no clock.
 */
import { describe, expect, it } from "vitest";
import {
  ACCESS_DEDUCTION_PER_ITEM,
  POSTURE_SCORE_DISCLAIMER,
  POSTURE_WEIGHTS,
  scorePosture,
  type PostureScoreInput,
} from "./posture-score.js";

function doc(over: Partial<PostureScoreInput> = {}): PostureScoreInput {
  return {
    packs: {
      active: [
        { packId: "p-b", title: "Pack B", totals: { controls: 10, unaddressed: 4 }, evidencedPct: 60 },
        { packId: "p-a", title: "Pack A", totals: { controls: 10, unaddressed: 2 }, evidencedPct: 80 },
      ],
    },
    risks: { open: 2, mitigating: 3, accepted: 1, closed: 4, total: 10 },
    redteam: { measured: true, runsInWindow: 1, latest: { agentName: "triage-bot", asrUpper: 0.2 } },
    evals: { groundedness: { runsInWindow: 2, latest: { passRate: 0.9 } } },
    spend: {
      budgets: [
        { projectId: "pr-1", projectName: "Alpha", overBudget: false },
        { projectId: "pr-2", projectName: "Beta", overBudget: true },
      ],
    },
    auditChain: { anchors: 5, sink: { tamperResistant: false } },
    agentOwnership: { total: 4, owned: 3, unowned: 1, orphaned: 0 },
    certificationCampaigns: { expiredIncomplete: 0 },
    sod: { currentViolations: 1 },
    ...over,
  };
}

const empty: PostureScoreInput = {
  packs: { active: [] },
  risks: { open: 0, mitigating: 0, accepted: 0, closed: 0, total: 0 },
  redteam: { measured: false, runsInWindow: 0, latest: null },
  evals: { groundedness: { runsInWindow: 0, latest: null } },
  spend: { budgets: [] },
  auditChain: { anchors: 0, sink: null },
  agentOwnership: { total: 0, owned: 0, unowned: 0, orphaned: 0 },
  certificationCampaigns: { expiredIncomplete: 0 },
  sod: { currentViolations: 0 },
};

describe("posture estimate (ADR-0214)", () => {
  it("weights are published, sum to 100, and ride with the payload", () => {
    const s = scorePosture(doc());
    expect(Object.values(POSTURE_WEIGHTS).reduce((a, b) => a + b, 0)).toBe(100);
    expect(s.weights.map((w) => w.weight).reduce((a, b) => a + b, 0)).toBe(100);
    for (const w of s.weights) expect(w.weight).toBe(POSTURE_WEIGHTS[w.objective]);
  });

  it("is deterministic: the same document always gives the same payload", () => {
    const a = scorePosture(doc());
    const b = scorePosture(structuredClone(doc()));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("computes each sub-score by its stated formula and the total as their weighted mean", () => {
    const s = scorePosture(doc());
    const by = Object.fromEntries(s.objectives.map((o) => [o.id, o.score]));
    expect(by).toEqual({
      coverage: 70, // mean of 60 and 80
      risk: 80, // 8 of 10 treated
      adversarial: 80, // 1 − 0.2
      access: 75 - ACCESS_DEDUCTION_PER_ITEM, // 3 of 4 owned, one SoD violation
      evaluation: 90,
      audit: 50, // anchored, rewritable
      spend: 50, // 1 of 2 within budget
    });
    const expected = s.objectives.reduce((acc, o) => acc + (o.weight * o.score) / 100, 0);
    expect(s.score).toBe(Math.round(expected));
    expect(s.score).toBe(71); // 14 + 16 + 12 + 9.75 + 9 + 5 + 5 = 70.75
  });

  it("halves a red-team result older than the window", () => {
    const fresh = scorePosture(doc()).objectives.find((o) => o.id === "adversarial")!;
    const stale = scorePosture(doc({ redteam: { measured: true, runsInWindow: 0, latest: { agentName: "triage-bot", asrUpper: 0.2 } } }))
      .objectives.find((o) => o.id === "adversarial")!;
    expect(stale.score).toBe(fresh.score / 2);
  });

  it("an empty deployment scores 0 with every objective unmeasured — empty never reads as good", () => {
    const s = scorePosture(empty);
    expect(s.score).toBe(0);
    for (const o of s.objectives.filter((x) => x.id !== "audit")) {
      expect(o.measured).toBe(false);
      expect(o.metric.value).toMatch(/unmeasured/);
    }
    expect(s.objectives.find((o) => o.id === "audit")!.metric.value).toBe("not anchored");
    // every objective offers its way out, worth its full weight
    expect(s.actions).toHaveLength(7);
    expect(s.actions.reduce((a, x) => a + x.points, 0)).toBe(100);
    for (const a of s.actions.filter((x) => x.objective !== "audit")) expect(a.reason).toMatch(/once measured/);
  });

  it("a perfect document scores 100 and has nothing to fix", () => {
    const s = scorePosture(
      doc({
        packs: { active: [{ packId: "p", title: "P", totals: { controls: 3, unaddressed: 0 }, evidencedPct: 100 }] },
        risks: { open: 0, mitigating: 0, accepted: 0, closed: 3, total: 3 },
        redteam: { measured: true, runsInWindow: 1, latest: { agentName: "a", asrUpper: 0 } },
        evals: { groundedness: { runsInWindow: 1, latest: { passRate: 1 } } },
        spend: { budgets: [{ projectId: "x", projectName: "X", overBudget: false }] },
        auditChain: { anchors: 1, sink: { tamperResistant: true } },
        agentOwnership: { total: 1, owned: 1, unowned: 0, orphaned: 0 },
        sod: { currentViolations: 0 },
      }),
    );
    expect(s.score).toBe(100);
    expect(s.actions).toEqual([]);
  });

  it("ranks actions by counterfactual points, ranks are 1..n, and ties break by objective order then key", () => {
    const s = scorePosture(doc());
    expect(s.actions.map((a) => a.rank)).toEqual(s.actions.map((_, i) => i + 1));
    for (let i = 1; i < s.actions.length; i++) expect(s.actions[i - 1]!.points).toBeGreaterThanOrEqual(s.actions[i]!.points);
    expect(s.actions.map((a) => [a.key, a.points])).toEqual([
      ["audit:anchor", 5], // equal points: audit precedes spend in the published objective order
      ["spend:pr-2", 5],
      ["coverage:p-b", 4], // equal points: coverage precedes risk
      ["risk:treat", 4],
      ["access:owners", 3.8], // 65 → 90 on a weight of 15
      ["adversarial:harden", 3],
      ["coverage:p-a", 2],
      ["access:sod", 1.5],
      ["evaluation:improve", 1],
    ]);
  });

  it("the ranking is stable regardless of the order the ledgers return rows in", () => {
    const base = doc({
      spend: {
        budgets: [
          { projectId: "pr-2", projectName: "Beta", overBudget: true },
          { projectId: "pr-1", projectName: "Alpha", overBudget: true },
          { projectId: "pr-3", projectName: "Gamma", overBudget: false },
        ],
      },
    });
    const reversed = { ...base, spend: { budgets: [...base.spend.budgets].reverse() }, packs: { active: [...base.packs.active].reverse() } };
    const keys = (d: PostureScoreInput) => scorePosture(d).actions.map((a) => a.key);
    expect(keys(reversed)).toEqual(keys(base));
    const spendKeys = keys(base).filter((k) => k.startsWith("spend:"));
    expect(spendKeys).toEqual(["spend:pr-1", "spend:pr-2"]); // equal points → by name
  });

  it("every objective and action explains itself, and nothing claims compliance", () => {
    const s = scorePosture(doc());
    expect(s.estimate).toBe(true);
    expect(s.disclaimer).toBe(POSTURE_SCORE_DISCLAIMER);
    expect(s.disclaimer).toMatch(/estimate/i);
    for (const o of s.objectives) {
      expect(o.title).not.toBe("");
      expect(o.outcome).not.toBe("");
      expect(o.formula).not.toBe("");
      expect(o.inputs.length).toBeGreaterThan(0);
      expect(o.metric.label).not.toBe("");
      expect(o.link.to).toMatch(/^\/admin\//);
      expect(o.contribution).toBe(Math.round(o.weight * o.score * 10 / 100) / 10);
    }
    for (const a of s.actions) {
      expect(a.reason).toMatch(/^Worth (up to )?[\d.]+ points/);
      expect(a.reason).toContain(`carries ${POSTURE_WEIGHTS[a.objective]}% of the estimate`);
      expect(a.link.to).toMatch(/^\/admin\//);
    }
    // the disclaimer says what the estimate is NOT; nothing else may use the words
    const text = JSON.stringify({ ...s, disclaimer: "" }).toLowerCase();
    expect(text).not.toMatch(/\bcompliant\b|\bcertified\b|\bcompliance verdict\b|\bobserved\b|\bimmutable\b|live oversight|agents monitored/i);
  });
});
