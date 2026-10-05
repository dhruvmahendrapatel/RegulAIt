/**
 * ADR-0173 batch 2c (Q) — the pure annotation rules: the rubric shape, the
 * submission bounds, disagreement and aggregation, and the queue schemas.
 */
import { describe, expect, it } from "vitest";
import {
  ANNOTATION_LIMITS,
  aggregateAnnotationScores,
  annotationDisagreement,
  annotationEnqueueSchema,
  annotationQueueCreateSchema,
  annotationRubricSchema,
  checkSubmission,
} from "./annotations.js";

const rubric = annotationRubricSchema.parse({
  criteria: [
    { name: "helpfulness", kind: "score", min: 1, max: 5, step: 1 },
    { name: "verdict", kind: "label", labels: ["good", "bad", "unsure"] },
  ],
});

describe("the rubric", () => {
  it("refuses duplicate criteria, an empty range, repeated labels, a bad name and more than 10 criteria", () => {
    const bad = [
      { criteria: [] },
      { criteria: [rubric.criteria[0], rubric.criteria[0]] },
      { criteria: [{ name: "s", kind: "score", min: 3, max: 3 }] },
      { criteria: [{ name: "l", kind: "label", labels: ["a", "a"] }] },
      { criteria: [{ name: "l", kind: "label", labels: ["only"] }] },
      { criteria: [{ name: "Has Space", kind: "score", min: 0, max: 1 }] },
      { criteria: Array.from({ length: ANNOTATION_LIMITS.criteria + 1 }, (_, i) => ({ name: `c${i}`, kind: "score", min: 0, max: 1 })) },
    ];
    for (const r of bad) expect(annotationRubricSchema.safeParse(r).success, JSON.stringify(r).slice(0, 60)).toBe(false);
    expect(rubric.commentRequired).toBe(false);
  });
});

describe("checkSubmission", () => {
  it("accepts an in-bounds review and returns its scores without the comment", () => {
    const out = checkSubmission(rubric, { values: { helpfulness: 4, verdict: "good" }, comment: "  fine  " });
    expect(out).toEqual({ ok: true, scores: [{ name: "helpfulness", value: 4 }, { name: "verdict", label: "good" }], comment: "fine" });
  });

  it.each([
    [{ helpfulness: 0, verdict: "good" }, "from 1 to 5"],
    [{ helpfulness: 5.5, verdict: "good" }, "from 1 to 5"],
    [{ helpfulness: 2.5, verdict: "good" }, "steps of 1"],
    [{ helpfulness: "4", verdict: "good" }, "is a score"],
    [{ helpfulness: 4, verdict: "great" }, "must be one of"],
    [{ helpfulness: 4 }, "needs an answer"],
    [{ helpfulness: 4, verdict: "good", other: 1 }, "not a criterion"],
  ])("refuses %j", (values, msg) => {
    const out = checkSubmission(rubric, { values: values as Record<string, number | string> });
    expect(out.ok).toBe(false);
    expect(!out.ok && out.errors.join(" ")).toContain(msg);
  });

  it("bounds the comment at 2000 characters and honours commentRequired", () => {
    const values = { helpfulness: 3, verdict: "good" };
    expect(checkSubmission(rubric, { values, comment: "c".repeat(ANNOTATION_LIMITS.commentChars) }).ok).toBe(true);
    expect(checkSubmission(rubric, { values, comment: "c".repeat(ANNOTATION_LIMITS.commentChars + 1) }).ok).toBe(false);
    const strict = { ...rubric, commentRequired: true };
    expect(checkSubmission(strict, { values, comment: "   " }).ok).toBe(false);
    expect(checkSubmission(strict, { values, comment: "why" }).ok).toBe(true);
  });
});

describe("disagreement and aggregation", () => {
  it("a label disagrees on any difference; a score only beyond a quarter of the range", () => {
    expect(annotationDisagreement(rubric, [{ values: { helpfulness: 3, verdict: "good" } }])).toEqual({ disagreement: false, detail: [] });
    // 3 vs 4 on 1-5 is a spread of 1 = exactly a quarter: agreement
    expect(annotationDisagreement(rubric, [{ values: { helpfulness: 3, verdict: "good" } }, { values: { helpfulness: 4, verdict: "good" } }]).disagreement).toBe(false);
    const d = annotationDisagreement(rubric, [{ values: { helpfulness: 1, verdict: "good" } }, { values: { helpfulness: 5, verdict: "bad" } }]);
    expect(d.disagreement).toBe(true);
    expect(d.detail).toEqual([
      { criterion: "helpfulness", kind: "score", values: [1, 5] },
      { criterion: "verdict", kind: "label", values: ["good", "bad"] },
    ]);
  });

  it("aggregates to the mean score and the majority label (ties: rubric order)", () => {
    const subs = [{ values: { helpfulness: 2, verdict: "bad" } }, { values: { helpfulness: 5, verdict: "good" } }];
    expect(aggregateAnnotationScores(rubric, subs)).toEqual([{ name: "helpfulness", value: 3.5 }, { name: "verdict", label: "good" }]);
    expect(aggregateAnnotationScores(rubric, [...subs, { values: { helpfulness: 2, verdict: "bad" } }])[1]).toEqual({ name: "verdict", label: "bad" });
  });
});

describe("queue and enqueue schemas", () => {
  it("needs N distinct reviewers for an N-person review, at most 5", () => {
    const base = { name: "q", rubric, reviewerUserIds: ["11111111-0000-4000-8000-000000000001", "11111111-0000-4000-8000-000000000002"] };
    expect(annotationQueueCreateSchema.safeParse({ ...base, requiredReviews: 2 }).success).toBe(true);
    expect(annotationQueueCreateSchema.safeParse({ ...base, requiredReviews: 3 }).success).toBe(false);
    expect(annotationQueueCreateSchema.safeParse({ ...base, reviewerUserIds: [base.reviewerUserIds[0], base.reviewerUserIds[0]] }).success).toBe(false);
    expect(annotationQueueCreateSchema.safeParse({ ...base, requiredReviews: 6 }).success).toBe(false);
    expect(annotationQueueCreateSchema.parse(base)).toMatchObject({ requiredReviews: 1, slaHours: null });
  });

  it("takes at most 500 subjects of the three kinds", () => {
    const id = "22222222-0000-4000-8000-000000000001";
    expect(annotationEnqueueSchema.safeParse({ subjects: Array(500).fill({ kind: "trace", id }) }).success).toBe(true);
    expect(annotationEnqueueSchema.safeParse({ subjects: Array(501).fill({ kind: "trace", id }) }).success).toBe(false);
    expect(annotationEnqueueSchema.safeParse({ subjects: [{ kind: "dataset", id }] }).success).toBe(false);
    expect(annotationEnqueueSchema.safeParse({ subjects: [] }).success).toBe(false);
  });
});
