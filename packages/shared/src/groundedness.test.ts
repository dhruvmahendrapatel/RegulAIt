import { describe, expect, it } from "vitest";
import {
  buildGroundednessJudgePrompt,
  hasNegation,
  isNoncommittal,
  parseGroundednessVerdict,
  scoreAnswerRelevance,
  scoreClaimSupport,
  scoreContextPrecision,
  scoreContextRecall,
  splitClaims,
} from "./groundedness.js";
import {
  DETERMINISTIC_SCORER_KINDS,
  JUDGE_BACKED_SCORER_KINDS,
  evalScorerRegistry,
  isJudgeBackedScorer,
  judgeAvailabilityFor,
  refusesWithoutJudge,
  scoreDeterministic,
  validateScorerConfig,
} from "./evals.js";

/**
 * ADR-0067 — GROUNDEDNESS, PROVED ADVERSARIALLY.
 *
 * The single thing this file exists to make impossible: a metric that returns a
 * plausible constant. Every score assertion below is paired with its opposite
 * over the SAME context, and the GAP is asserted — a metric that scored a
 * faithful answer and a fabricated one alike would pass a one-sided test and
 * fail every one of these.
 *
 * The second thing it exists to prove: the LIMITS in the registry are true.
 * There are explicit tests asserting that the lexical method DOES NOT catch
 * negation flips and DOES NOT catch swapped attribution — because a limitation
 * nobody tested is a limitation nobody knows is still there, and those two are
 * the whole reason the judge-backed metrics refuse rather than degrade.
 */

// A small, realistic RAG context.
const CONTEXT = [
  "The Helios payment gateway processes card transactions for the retail division. It was migrated to the eu-west-2 region on 14 March 2024 by the platform team.",
  "Helios retains cardholder data for 90 days, after which records are purged by the nightly reconciliation job. Retention is configured per merchant in the Helios admin console.",
  "Incident INC-4471 was raised when the reconciliation job failed twice in one week. The root cause was an expired service-account credential, and Priya Raman signed off the remediation.",
];

const QUESTION = "How long does the Helios gateway retain cardholder data, and who signed off the INC-4471 remediation?";

/** every claim is a restatement of something in exactly one chunk */
const GROUNDED_ANSWER =
  "Helios retains cardholder data for 90 days. The records are purged by the nightly reconciliation job. Priya Raman signed off the remediation for incident INC-4471.";

/** fluent, same topic, same shape — and every specific is invented */
const FABRICATED_ANSWER =
  "Helios retains cardholder data for 400 days. The records are purged by the quarterly archival sweep. Marcus Delaney signed off the remediation for incident INC-8892.";

describe("splitClaims", () => {
  it("splits on sentence terminators", () => {
    expect(splitClaims("Alpha is one. Beta is two! Gamma is three?")).toEqual([
      "Alpha is one.",
      "Beta is two!",
      "Gamma is three?",
    ]);
  });

  it("does not split inside decimals or version numbers", () => {
    expect(splitClaims("The threshold is 3.5 percent. It rose from 1.2.3 last year.")).toEqual([
      "The threshold is 3.5 percent.",
      "It rose from 1.2.3 last year.",
    ]);
  });

  it("does not split on a known abbreviation", () => {
    const claims = splitClaims("The rule applies to some regions, e.g. eu-west-2 and us-east-1. It does not apply elsewhere.");
    expect(claims).toHaveLength(2);
    expect(claims[0]).toContain("e.g. eu-west-2");
  });

  it("treats list items as separate claims and strips their markers", () => {
    expect(splitClaims("- Retention is 90 days\n- Purging is nightly\n2. Priya signed off")).toEqual([
      "Retention is 90 days",
      "Purging is nightly",
      "Priya signed off",
    ]);
  });
});

describe("claim_support — the adversarial gap", () => {
  it("scores a grounded answer high and a fabricated answer over the SAME context low", () => {
    const grounded = scoreClaimSupport(GROUNDED_ANSWER, CONTEXT);
    const fabricated = scoreClaimSupport(FABRICATED_ANSWER, CONTEXT);

    // Both answers are the same length, same topic, same sentence structure.
    expect(grounded.verifiableClaims).toBe(fabricated.verifiableClaims);

    expect(grounded.ratio).toBeGreaterThanOrEqual(0.99);
    expect(fabricated.ratio).toBeLessThanOrEqual(0.34);
    // THE GAP. A metric returning a plausible constant cannot satisfy this.
    expect(grounded.ratio - fabricated.ratio).toBeGreaterThan(0.6);
  });

  it("names the claims that failed, not just how many", () => {
    const fabricated = scoreClaimSupport(FABRICATED_ANSWER, CONTEXT);
    expect(fabricated.unsupportedClaims.length).toBeGreaterThan(0);
    const texts = fabricated.unsupportedClaims.map((c) => c.claim).join(" ");
    expect(texts).toContain("400 days");
    expect(texts).toContain("Marcus Delaney");
  });

  it("calls out a fabricated FIGURE by name and caps that claim's score", () => {
    const r = scoreClaimSupport("Helios retains cardholder data for 400 days.", CONTEXT);
    const claim = r.claims[0]!;
    expect(claim.unsupportedNumbers).toContain("400");
    expect(claim.supported).toBe(false);
    // capped strictly below the support threshold whatever the prose does
    expect(claim.score).toBeLessThan(r.claimThreshold);
  });

  it("a whole-cloth answer about a different subject collapses to zero", () => {
    const r = scoreClaimSupport(
      "The quarterly marketing budget was reallocated toward brand awareness campaigns in Scandinavia.",
      CONTEXT,
    );
    expect(r.ratio).toBe(0);
  });

  it("SKIPS fragments rather than counting them as supported", () => {
    // "Yes." and "See above." are not verifiable claims; counting them as
    // supported is the single easiest way to inflate a groundedness score.
    const r = scoreClaimSupport("Yes. See above. Helios retains cardholder data for 90 days.", CONTEXT);
    expect(r.skippedClaims).toBe(2);
    expect(r.verifiableClaims).toBe(1);
    expect(r.ratio).toBe(1);
  });

  it("refuses rather than scoring when no context was supplied", () => {
    const r = scoreClaimSupport(GROUNDED_ANSWER, []);
    expect(r.refusal).toMatch(/no context/i);
    expect(r.ratio).toBe(0);
  });

  it("does NOT credit a claim stitched together out of two different chunks", () => {
    // Every token is present SOMEWHERE in the context, but no single chunk
    // supports the sentence. This is the fabrication mode a union-of-context
    // method scores as fully supported.
    const stitched = "Priya Raman configured the 90 day cardholder retention in the eu-west-2 region for the retail division.";
    const r = scoreClaimSupport(stitched, CONTEXT);
    expect(r.claims[0]!.supported).toBe(false);
  });

  it("the claimThreshold dial genuinely moves the verdict", () => {
    const answer = "Helios processes card transactions and retains data.";
    const strict = scoreClaimSupport(answer, CONTEXT, { claimThreshold: 0.95 });
    const loose = scoreClaimSupport(answer, CONTEXT, { claimThreshold: 0.2 });
    expect(loose.ratio).toBeGreaterThan(strict.ratio);
  });
});

describe("claim_support — the DISCLOSED blind spots are real", () => {
  it("CANNOT detect a negation flip: it scores the inversion as supported", () => {
    const flipped = "Helios does not retain cardholder data for 90 days.";
    const r = scoreClaimSupport(flipped, CONTEXT);
    // This assertion documents a LIMITATION, not a feature. If a future change
    // makes lexical scoring negation-aware, this test should be inverted
    // deliberately and the registry `limits` string updated in the same commit.
    expect(r.claims[0]!.supported).toBe(true);
    // ...but the parity mismatch IS flagged for a human.
    expect(r.claims[0]!.negationMismatch).toBe(true);
  });

  it("CANNOT detect swapped attribution", () => {
    const swapped = "The expired service-account credential signed off Priya Raman for incident INC-4471.";
    expect(scoreClaimSupport(swapped, CONTEXT).claims[0]!.supported).toBe(true);
  });

  it("scores a synonym-only paraphrase as UNSUPPORTED — a real false positive", () => {
    const paraphrase = "Payment card details are kept for roughly three months before deletion.";
    expect(scoreClaimSupport(paraphrase, CONTEXT).claims[0]!.supported).toBe(false);
  });
});

describe("context_precision — retrieval utilisation", () => {
  it("drops when the context is padded with chunks nothing rests on", () => {
    const tight = scoreContextPrecision("Helios retains cardholder data for 90 days.", [CONTEXT[1]!]);
    const padded = scoreContextPrecision("Helios retains cardholder data for 90 days.", [
      ...CONTEXT,
      "The staff canteen menu rotates on a four-week cycle.",
      "Parking permits are issued annually by facilities.",
    ]);
    expect(tight.score).toBe(1);
    expect(padded.score).toBeLessThan(0.35);
    expect(tight.score - padded.score).toBeGreaterThan(0.6);
    expect(padded.unusedChunks.length).toBeGreaterThanOrEqual(4);
  });

  it("reports WHICH chunk carried the answer", () => {
    const r = scoreContextPrecision("Helios retains cardholder data for 90 days.", CONTEXT);
    expect(r.usedChunks).toEqual([1]);
  });
});

describe("context_recall — measuring the retriever, not the model", () => {
  it("is high when the context contains the reference answer and low when it does not", () => {
    const reference = "Helios retains cardholder data for 90 days. Priya Raman signed off the INC-4471 remediation.";
    const withSupport = scoreContextRecall(reference, CONTEXT);
    const withoutSupport = scoreContextRecall(reference, [
      "The Helios payment gateway processes card transactions for the retail division.",
      "The staff canteen menu rotates on a four-week cycle.",
    ]);
    expect(withSupport.score).toBe(1);
    expect(withoutSupport.score).toBe(0);
    expect(withSupport.score - withoutSupport.score).toBeGreaterThan(0.6);
    expect(withoutSupport.missing.length).toBe(2);
  });

  it("refuses without a reference answer instead of returning a number", () => {
    const r = scoreContextRecall("", CONTEXT);
    expect(r.refusal).toMatch(/reference answer/i);
    expect(r.score).toBe(0);
  });
});

describe("answer_relevance", () => {
  it("separates an on-topic answer from a fluent off-topic one", () => {
    const onTopic = scoreAnswerRelevance(QUESTION, GROUNDED_ANSWER);
    const offTopic = scoreAnswerRelevance(
      QUESTION,
      "The quarterly marketing budget was reallocated toward brand awareness campaigns in Scandinavia.",
    );
    expect(onTopic.score).toBeGreaterThan(0.45);
    expect(offTopic.score).toBeLessThan(0.1);
    expect(onTopic.score - offTopic.score).toBeGreaterThan(0.4);
  });

  it("scores a non-committal answer 0 and says why", () => {
    const r = scoreAnswerRelevance(QUESTION, "I don't know — the provided context does not contain that information.");
    expect(r.score).toBe(0);
    expect(r.noncommittal).toBe(true);
    expect(r.refusal).toMatch(/non-committal/i);
  });

  it("a FABRICATED answer still scores relevant — this is the documented limit", () => {
    // Relevance is topical overlap, not correctness. Pairing it with
    // claim_support is the whole point; on its own it proves only that the
    // model did not change the subject.
    expect(scoreAnswerRelevance(QUESTION, FABRICATED_ANSWER).score).toBeGreaterThan(0.4);
    expect(scoreClaimSupport(FABRICATED_ANSWER, CONTEXT).ratio).toBeLessThan(0.34);
  });
});

describe("negation and non-committal detectors", () => {
  it("hasNegation finds the common forms", () => {
    expect(hasNegation("The system does not encrypt data")).toBe(true);
    expect(hasNegation("The system doesn't encrypt data")).toBe(true);
    expect(hasNegation("No retention policy is configured")).toBe(true);
    expect(hasNegation("The system encrypts data at rest")).toBe(false);
  });

  it("isNoncommittal does not fire on an ordinary answer", () => {
    expect(isNoncommittal("Helios retains cardholder data for 90 days.")).toBe(false);
    expect(isNoncommittal("I cannot determine that from the context.")).toBe(true);
  });
});

describe("scoreDeterministic wiring", () => {
  it("routes the four groundedness kinds and carries the evidence into `detail`", () => {
    const r = scoreDeterministic({
      kind: "claim_support",
      expected: null,
      output: FABRICATED_ANSWER,
      config: { threshold: 0.8 },
      context: CONTEXT,
      caseInput: QUESTION,
    });
    expect(r.passed).toBe(false);
    expect(r.detail.method).toBe("lexical-idf-overlap");
    expect(Array.isArray(r.detail.unsupportedClaims)).toBe(true);
    expect((r.detail.unsupportedClaims as unknown[]).length).toBeGreaterThan(0);
  });

  it("answer_relevance measures against the case input, not the output alone", () => {
    const relevant = scoreDeterministic({
      kind: "answer_relevance",
      expected: null,
      output: GROUNDED_ANSWER,
      config: {},
      caseInput: QUESTION,
    });
    const irrelevant = scoreDeterministic({
      kind: "answer_relevance",
      expected: null,
      output: GROUNDED_ANSWER,
      config: {},
      caseInput: "What is the parking permit renewal process?",
    });
    expect(relevant.score - irrelevant.score).toBeGreaterThan(0.3);
  });

  it("a groundedness kind with NO context scores 0 and says so rather than inventing a number", () => {
    const r = scoreDeterministic({
      kind: "claim_support",
      expected: null,
      output: GROUNDED_ANSWER,
      config: {},
      context: [],
    });
    expect(r.score).toBe(0);
    expect(String(r.detail.note)).toMatch(/no context/i);
  });
});

describe("the registry and the honesty line", () => {
  it("classifies the judge-backed kinds EXPLICITLY, not by exclusion", () => {
    expect([...JUDGE_BACKED_SCORER_KINDS]).toEqual([
      "llm_as_judge",
      "groundedness_judge",
      "answer_relevance_judge",
    ]);
    for (const k of JUDGE_BACKED_SCORER_KINDS) {
      expect(DETERMINISTIC_SCORER_KINDS).not.toContain(k);
      expect(isJudgeBackedScorer(k)).toBe(true);
    }
    expect(isJudgeBackedScorer("claim_support")).toBe(false);
  });

  it("every registry entry states a limit, and modelBacked matches the judge set", () => {
    for (const entry of evalScorerRegistry()) {
      expect(entry.limits.length).toBeGreaterThan(40);
      expect(entry.modelBacked).toBe(isJudgeBackedScorer(entry.id));
      expect(entry.deterministic).toBe(!isJudgeBackedScorer(entry.id));
    }
  });

  it("the registry has an entry for every kind and no orphans", () => {
    const ids = evalScorerRegistry().map((e) => e.id).sort();
    const kinds = [...DETERMINISTIC_SCORER_KINDS, ...JUDGE_BACKED_SCORER_KINDS].sort();
    expect(ids).toEqual(kinds);
  });

  it("refuses a groundedness case authored with no context", () => {
    expect(validateScorerConfig("claim_support", {}, null, [])).toMatch(/needs the case to carry/);
    expect(validateScorerConfig("claim_support", {}, null, ["some context"])).toBeNull();
    expect(validateScorerConfig("groundedness_judge", {}, null, [])).toMatch(/needs the case to carry/);
  });

  it("refuses context_recall with no reference answer", () => {
    expect(validateScorerConfig("context_recall", {}, null, ["ctx"])).toMatch(/reference answer/);
    expect(validateScorerConfig("context_recall", {}, "a reference", ["ctx"])).toBeNull();
  });
});

describe("judgeAvailabilityFor — the typed refusal", () => {
  it("is available when no judged metric is present, judge or not", () => {
    expect(judgeAvailabilityFor(["claim_support", "contains"], { named: false, dispatchable: false }))
      .toEqual({ available: true });
  });

  it("refuses judge_required when a judged metric has no judge named", () => {
    const a = judgeAvailabilityFor(["claim_support", "groundedness_judge"], {
      named: false,
      dispatchable: false,
    });
    expect(a.available).toBe(false);
    if (a.available) throw new Error("unreachable");
    expect(a.error).toBe("judge_required");
    expect(a.metrics).toEqual(["groundedness_judge"]);
    // The reason must say, in words, that it will not silently estimate.
    expect(a.reason).toMatch(/NOT fall back/);
  });

  it("refuses judge_not_dispatchable when the named judge has no reachable model", () => {
    const a = judgeAvailabilityFor(["answer_relevance_judge"], {
      named: true,
      dispatchable: false,
      detail: "no model credential for provider 'anthropic'",
    });
    expect(a.available).toBe(false);
    if (a.available) throw new Error("unreachable");
    expect(a.error).toBe("judge_not_dispatchable");
    expect(a.reason).toContain("no model credential");
    expect(a.reason).toMatch(/refused rather than estimated/);
  });

  it("names EVERY REFUSING metric in play, deduplicated", () => {
    const a = judgeAvailabilityFor(
      ["groundedness_judge", "groundedness_judge", "answer_relevance_judge", "exact"],
      { named: false, dispatchable: false },
    );
    if (a.available) throw new Error("unreachable");
    expect(a.metrics.sort()).toEqual(["answer_relevance_judge", "groundedness_judge"]);
  });

  it("does NOT refuse for ADR-0044's llm_as_judge — that kind keeps its own behaviour", () => {
    // The asymmetry is deliberate and disclosed (ADR-0067 §4): `llm_as_judge`
    // already had an accepted, tested behaviour — score 0 with a named error,
    // which is loud rather than silent. Unifying the two would change an
    // accepted ADR's contract from inside a slice about a different metric, so
    // it is named as follow-up rather than taken. This test pins the boundary
    // so the asymmetry cannot drift by accident in either direction.
    expect(judgeAvailabilityFor(["llm_as_judge"], { named: false, dispatchable: false }))
      .toEqual({ available: true });
    expect(refusesWithoutJudge("llm_as_judge")).toBe(false);
    expect(refusesWithoutJudge("groundedness_judge")).toBe(true);
    // …but it is still classified as model-backed, so it is never in the
    // deterministic set and the registry never calls it free or offline.
    expect(isJudgeBackedScorer("llm_as_judge")).toBe(true);
    expect(DETERMINISTIC_SCORER_KINDS).not.toContain("llm_as_judge");
  });
});

describe("the groundedness judge's deterministic halves", () => {
  it("builds an entailment prompt carrying the numbered context", () => {
    const p = buildGroundednessJudgePrompt(
      { question: QUESTION, answer: GROUNDED_ANSWER, context: CONTEXT, metric: "groundedness_judge" },
      0.8,
    );
    expect(p).toContain("ENTAILED BY");
    expect(p).toContain("[1] The Helios payment gateway");
    expect(p).toContain("[3] Incident INC-4471");
    expect(p).toContain(GROUNDED_ANSWER);
    // it must ask for per-claim verdicts, not just a number
    expect(p).toContain('"claims"');
  });

  it("the relevance prompt does NOT carry the context — a different question", () => {
    const p = buildGroundednessJudgePrompt(
      { question: QUESTION, answer: GROUNDED_ANSWER, context: CONTEXT, metric: "answer_relevance_judge" },
      0.8,
    );
    expect(p).toContain("RELEVANCE");
    expect(p).not.toContain("Incident INC-4471 was raised");
  });

  it("parses a fenced verdict with per-claim reasons", () => {
    const reply = '```json\n{"score":0.5,"passed":false,"rationale":"one claim is invented","claims":[{"claim":"A","supported":true,"reason":"in [1]"},{"claim":"B","supported":false,"reason":"nowhere"}]}\n```';
    const r = parseGroundednessVerdict(reply, 0.8);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.verdict.score).toBe(0.5);
    expect(r.verdict.passed).toBe(false);
    expect(r.verdict.claims).toHaveLength(2);
    expect(r.verdict.claims[1]!.supported).toBe(false);
  });

  it("an unparseable verdict is an ERROR, never a silent pass", () => {
    expect(parseGroundednessVerdict("I think it's mostly fine.", 0.8)).toEqual({
      ok: false,
      error: "judge reply is not a JSON object",
    });
    expect(parseGroundednessVerdict('{"rationale":"fine"}', 0.8)).toEqual({
      ok: false,
      error: "judge reply has no numeric score",
    });
  });

  it("a judge cannot pass a case by asserting `passed` under the threshold", () => {
    const r = parseGroundednessVerdict('{"score":0.2,"passed":true,"rationale":"trust me"}', 0.8);
    if (!r.ok) throw new Error("unreachable");
    expect(r.verdict.passed).toBe(false);
  });
});
