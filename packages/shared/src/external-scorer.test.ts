/**
 * ADR-0088 — the external-scorer contract's pure halves, proved adversarially.
 *
 * What this file makes impossible to fake:
 *  - a NON-CONFORMING reply becoming a score (missing/NaN/out-of-range score,
 *    non-JSON, wrong reasons shape — every one is an ERROR, never a clamp);
 *  - a named-but-unusable instrument slipping past the pre-flight (unknown,
 *    disabled, kind not claimed, egress-refused — each refusal is asserted
 *    with its OWN error code, and the happy path is asserted beside it);
 *  - `externalScorer` attaching to a lexical metric (refused at authoring
 *    time for EVERY deterministic kind, allowed for every judge-backed one).
 */
import { describe, expect, it } from "vitest";
import {
  DETERMINISTIC_SCORER_KINDS,
  JUDGE_BACKED_SCORER_KINDS,
  createExternalScorerSchema,
  evalScorerConfigSchema,
  externalScorerAvailabilityFor,
  externalScorerMethod,
  parseExternalScorerResponse,
  validateScorerConfig,
  type EvalScorerKind,
} from "./index.js";

describe("parseExternalScorerResponse — strict, never a silent 0 or 1", () => {
  it("accepts a conforming verdict, boundary scores included", () => {
    for (const score of [0, 0.5, 1]) {
      const r = parseExternalScorerResponse(JSON.stringify({ score }));
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.verdict.score).toBe(score);
    }
    const withReasons = parseExternalScorerResponse(
      JSON.stringify({ score: 0.25, reasons: ["claim 2 contradicts chunk 1"] }),
    );
    expect(withReasons.ok).toBe(true);
    if (withReasons.ok) expect(withReasons.verdict.reasons).toEqual(["claim 2 contradicts chunk 1"]);
  });

  it("refuses every non-conforming shape as an ERROR — no default, no clamp", () => {
    const bad: Array<[string, RegExp]> = [
      ["not json at all", /not JSON/],
      ["[0.9]", /not a JSON object/],
      ["null", /not a JSON object/],
      [JSON.stringify({ verdict: "good" }), /no numeric `score`/],
      [JSON.stringify({ score: "0.9" }), /no numeric `score`/], // a string is not a number
      ['{"score": null}', /no numeric `score`/],
      [JSON.stringify({ score: 1.2 }), /outside \[0,1\]/],
      [JSON.stringify({ score: -0.1 }), /outside \[0,1\]/],
      ['{"score": 1e999}', /not a finite number|no numeric/], // Infinity via JSON
      [JSON.stringify({ score: 0.5, reasons: "because" }), /array of strings/],
      [JSON.stringify({ score: 0.5, reasons: [1, 2] }), /array of strings/],
    ];
    for (const [raw, why] of bad) {
      const r = parseExternalScorerResponse(raw);
      expect(r.ok, `should refuse: ${raw}`).toBe(false);
      if (!r.ok) expect(r.error).toMatch(why);
    }
  });

  it("caps a vendor's reasons rather than storing unbounded text", () => {
    const r = parseExternalScorerResponse(
      JSON.stringify({ score: 0.1, reasons: Array.from({ length: 50 }, () => "x".repeat(1000)) }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.verdict.reasons).toHaveLength(20);
    expect(r.verdict.reasons[0]!.length).toBeLessThanOrEqual(501); // 500 + ellipsis
  });
});

describe("externalScorerAvailabilityFor — the pre-flight refusal, mirrored on judgeAvailabilityFor", () => {
  const use = (kind: string, scorer = "fiddler-shim") => ({ kind, scorer });
  const facts = (over: Partial<Parameters<typeof externalScorerAvailabilityFor>[1][number]> = {}) => [
    {
      name: "fiddler-shim",
      enabled: true,
      scorerKinds: ["groundedness_judge", "answer_relevance_judge"],
      reachable: true,
      ...over,
    },
  ];

  it("no uses → available (the external path never blocks an ordinary run)", () => {
    expect(externalScorerAvailabilityFor([], []).available).toBe(true);
  });

  it("available when registered, enabled, claiming the kind, and reachable", () => {
    expect(externalScorerAvailabilityFor([use("groundedness_judge")], facts()).available).toBe(true);
  });

  it("unknown scorer → external_scorer_unknown, naming the scorer and metrics", () => {
    const r = externalScorerAvailabilityFor([use("groundedness_judge", "nobody")], facts());
    expect(r.available).toBe(false);
    if (r.available) return;
    expect(r.error).toBe("external_scorer_unknown");
    expect(r.scorer).toBe("nobody");
    expect(r.metrics).toEqual(["groundedness_judge"]);
    expect(r.reason).toMatch(/will NOT fall back/);
  });

  it("disabled scorer → external_scorer_disabled (register→test→enable is not optional)", () => {
    const r = externalScorerAvailabilityFor([use("groundedness_judge")], facts({ enabled: false }));
    expect(r.available).toBe(false);
    if (!r.available) expect(r.error).toBe("external_scorer_disabled");
  });

  it("a kind the instrument never claimed → external_scorer_kind_mismatch", () => {
    const r = externalScorerAvailabilityFor([use("llm_as_judge")], facts());
    expect(r.available).toBe(false);
    if (!r.available) {
      expect(r.error).toBe("external_scorer_kind_mismatch");
      expect(r.metrics).toEqual(["llm_as_judge"]);
    }
  });

  it("egress-refused → external_scorer_unreachable, carrying the guard's reason", () => {
    const r = externalScorerAvailabilityFor(
      [use("groundedness_judge")],
      facts({ reachable: false, detail: "host 'scoring.evil' is not in the egress allow-list" }),
    );
    expect(r.available).toBe(false);
    if (!r.available) {
      expect(r.error).toBe("external_scorer_unreachable");
      expect(r.reason).toMatch(/egress allow-list/);
    }
  });

  it("one bad use among many still refuses the whole run", () => {
    const r = externalScorerAvailabilityFor(
      [use("groundedness_judge"), use("answer_relevance_judge", "ghost")],
      facts(),
    );
    expect(r.available).toBe(false);
    if (!r.available) expect(r.scorer).toBe("ghost");
  });
});

describe("method provenance and the lexical boundary", () => {
  it("stamps the instrument's name, never a family another method owns", () => {
    expect(externalScorerMethod("fiddler-shim")).toBe("external:fiddler-shim");
  });

  it("`externalScorer` is REFUSED on every deterministic kind and ACCEPTED on every judge-backed kind", () => {
    const config = evalScorerConfigSchema.parse({ externalScorer: "fiddler-shim" });
    for (const kind of DETERMINISTIC_SCORER_KINDS) {
      const err = validateScorerConfig(kind as EvalScorerKind, config, "expected", ["some context"]);
      expect(err, `${kind} must refuse externalScorer`).toMatch(/only legal on a judge-backed/);
    }
    for (const kind of JUDGE_BACKED_SCORER_KINDS) {
      const err = validateScorerConfig(
        kind as EvalScorerKind,
        config,
        "expected",
        ["some context"],
      );
      expect(err, `${kind} must accept externalScorer`).toBeNull();
    }
  });

  it("the registration schema cannot even express a deterministic kind claim", () => {
    const r = createExternalScorerSchema.safeParse({
      name: "x",
      baseUrl: "https://scorer.example/v1/score",
      scorerKinds: ["claim_support"],
    });
    expect(r.success).toBe(false);
  });
});
