/**
 * ADR-0092 — the frozen v1 access-recommendation rule set (gap L24).
 *
 * What this file pins:
 *  - the set is VERSIONED and FROZEN: ids and severities exactly, deep-frozen
 *    objects (a runtime edit must throw), version constant = 1;
 *  - severity is a CLASS with both classes in actual use — no rule invents a
 *    third value and no numeric score exists anywhere on the shape;
 *  - the rationale renderer is STRICT: a placeholder with no evidence value
 *    throws rather than shipping a sentence with a hole in it;
 *  - the `from_recommendations` scope parser refuses unknown ids and empty
 *    lists, deduplicates, and returns canonical (frozen-set) order.
 */
import { describe, expect, it } from "vitest";
import {
  ACCESS_RECOMMENDATION_RULES_V1,
  ACCESS_RECOMMENDATION_RULES_VERSION,
  ACCESS_RECOMMENDATION_RULE_IDS,
  ACCESS_RECOMMENDATION_SEVERITIES,
  RECOMMENDATION_JUDGE_LIMITS,
  RECOMMENDATION_JUDGE_METHOD,
  UNUSED_GRANT_DEFAULT_WINDOW_DAYS,
  annotationsForFindings,
  buildRecommendationJudgePrompt,
  parseRecommendationJudgeReplies,
  accessRecommendationRuleById,
  parseRecommendationRuleIds,
  renderRecommendationRationale,
} from "./access-recommendations.js";

describe("the v1 rule set is frozen, versioned, and score-free", () => {
  it("pins the version, the ids, and their order", () => {
    expect(ACCESS_RECOMMENDATION_RULES_VERSION).toBe(1);
    expect(UNUSED_GRANT_DEFAULT_WINDOW_DAYS).toBe(90);
    expect(ACCESS_RECOMMENDATION_RULES_V1.map((r) => r.id)).toEqual([
      "unused-grant",
      "orphaned-agent-grants",
      "retired-agent-grants",
      "overreach",
      "sod-violation",
      "never-signed-in-holder",
    ]);
    expect([...ACCESS_RECOMMENDATION_RULE_IDS]).toEqual(ACCESS_RECOMMENDATION_RULES_V1.map((r) => r.id));
  });

  it("pins each rule's severity CLASS — both classes in use, no third value, no score field", () => {
    const byId = Object.fromEntries(ACCESS_RECOMMENDATION_RULES_V1.map((r) => [r.id, r.severity]));
    expect(byId).toEqual({
      "unused-grant": "review-suggested",
      "orphaned-agent-grants": "review-suggested",
      "retired-agent-grants": "informational",
      overreach: "review-suggested",
      "sod-violation": "review-suggested",
      "never-signed-in-holder": "review-suggested",
    });
    expect([...ACCESS_RECOMMENDATION_SEVERITIES]).toEqual(["informational", "review-suggested"]);
    for (const rule of ACCESS_RECOMMENDATION_RULES_V1) {
      expect(ACCESS_RECOMMENDATION_SEVERITIES).toContain(rule.severity);
      // no numeric anything: severity is a class, never an ordering claim
      for (const v of Object.values(rule)) expect(typeof v).not.toBe("number");
    }
  });

  it("is deep-frozen: mutating the set or a rule throws", () => {
    expect(Object.isFrozen(ACCESS_RECOMMENDATION_RULES_V1)).toBe(true);
    for (const rule of ACCESS_RECOMMENDATION_RULES_V1) expect(Object.isFrozen(rule)).toBe(true);
    expect(() => {
      (ACCESS_RECOMMENDATION_RULES_V1 as unknown as unknown[]).push({});
    }).toThrow();
    expect(() => {
      (ACCESS_RECOMMENDATION_RULES_V1[0] as { severity: string }).severity = "critical";
    }).toThrow();
  });

  it("every rule states its limits and carries a rationale template with at least one evidence slot", () => {
    for (const rule of ACCESS_RECOMMENDATION_RULES_V1) {
      expect(rule.limits.length).toBeGreaterThan(20);
      expect(rule.rationaleTemplate).toMatch(/\{[a-zA-Z]+\}/);
    }
  });

  it("looks a rule up by id, and returns null for the unknown", () => {
    expect(accessRecommendationRuleById("unused-grant")?.severity).toBe("review-suggested");
    expect(accessRecommendationRuleById("peer-analytics")).toBeNull();
  });
});

describe("the rationale renderer is strict", () => {
  const rule = accessRecommendationRuleById("orphaned-agent-grants")!;

  it("fills every placeholder from the evidence", () => {
    const s = renderRecommendationRationale(rule, {
      object: "agent 'billing-summarizer'",
      ownershipProblem: "a deactivated owner",
      flag: "orphaned",
    });
    expect(s).toContain("agent 'billing-summarizer'");
    expect(s).toContain("'orphaned'");
    expect(s).not.toMatch(/\{[a-zA-Z]+\}/);
  });

  it("throws on a missing evidence value instead of shipping a sentence with a hole", () => {
    expect(() => renderRecommendationRationale(rule, { object: "agent 'x'" })).toThrow(/missing evidence value/);
  });
});

describe("the from_recommendations scope parser", () => {
  it("accepts known ids, deduplicates, and returns canonical order", () => {
    const res = parseRecommendationRuleIds("sod-violation, unused-grant ,unused-grant");
    expect(res).toEqual({ ok: true, ids: ["unused-grant", "sod-violation"] });
  });

  it("refuses unknown ids by name and refuses an empty list", () => {
    const bad = parseRecommendationRuleIds("unused-grant,peer-analytics");
    expect(bad).toEqual({ ok: false, invalid: ["peer-analytics"] });
    expect(parseRecommendationRuleIds("  ,")).toEqual({ ok: false, invalid: [] });
  });
});

// ---------------------------------------------------------------------------
// L6c (ADR-0092 amendment) — the model-judged ANNOTATION, pure half.
//
// What these pin is containment, not fluency: the judged layer may only ever
// attach to a finding the deterministic rules already made, it is labelled so
// nobody can mistake it for evidence, and an unparseable or off-key reply
// yields NOTHING rather than a quietly-empty annotation set.
// ---------------------------------------------------------------------------
describe("L6c — the judged layer annotates; it can never create a recommendation", () => {
  const keys = ["unused-grant:agent:g1", "overreach:agent:g2"];

  it("labels every annotation `model-judged` and carries its limits paragraph", () => {
    const anns = annotationsForFindings(
      keys,
      [{ key: keys[0]!, verdict: "agree", note: "the grant has genuinely not been used" }],
      "model:judge-agent",
    );
    const a = anns.get(keys[0]!)!;
    expect(a.method).toBe(RECOMMENDATION_JUDGE_METHOD);
    expect(a.method).toBe("model-judged");
    expect(a.judge).toBe("model:judge-agent");
    expect(a.verdict).toBe("agree");
    expect(a.limits).toBe(RECOMMENDATION_JUDGE_LIMITS);
    expect(a.limits).toMatch(/not evidence/i);
  });

  it("DROPS a verdict keyed to a finding the deterministic rules never produced", () => {
    const anns = annotationsForFindings(
      keys,
      [
        { key: "peer-analytics:user:u9", verdict: "disagree", note: "this person's peers all have it" },
        { key: keys[1]!, verdict: "unclear", note: "" },
      ],
      "j",
    );
    // the invented finding is gone; only the deterministic key survives
    expect([...anns.keys()]).toEqual([keys[1]!]);
  });

  it("keeps the FIRST verdict per key, so a repeated key cannot double-annotate", () => {
    const anns = annotationsForFindings(
      keys,
      [
        { key: keys[0]!, verdict: "agree", note: "first" },
        { key: keys[0]!, verdict: "disagree", note: "second" },
      ],
      "j",
    );
    expect(anns.size).toBe(1);
    expect(anns.get(keys[0]!)!.note).toBe("first");
  });

  it("parses a fenced array, and treats an unusable reply as an ERROR not as zero verdicts", () => {
    const ok = parseRecommendationJudgeReplies(
      '```json\n[{"key":"k1","verdict":"agree","note":"n"}]\n```',
    );
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.replies).toEqual([{ key: "k1", verdict: "agree", note: "n" }]);

    expect(parseRecommendationJudgeReplies("I broadly agree with these findings.").ok).toBe(false);
    expect(parseRecommendationJudgeReplies("[]").ok).toBe(false);
    // a verdict outside the closed vocabulary is not a verdict
    expect(parseRecommendationJudgeReplies('[{"key":"k","verdict":"probably","note":""}]').ok).toBe(false);
  });

  it("the judge prompt forbids adding, removing or altering findings", () => {
    const p = buildRecommendationJudgePrompt([
      { key: keys[0]!, ruleId: "unused-grant", rationale: "r", evidence: { governedCallsInWindow: 0 } },
    ]);
    expect(p).toMatch(/may NOT add findings, remove findings, or change any evidence value/);
    expect(p).toMatch(/does NOT clear the grant/);
    expect(p).toContain(keys[0]!);
  });
});
