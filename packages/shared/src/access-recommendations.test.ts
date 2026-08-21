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
  UNUSED_GRANT_DEFAULT_WINDOW_DAYS,
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
