import { describe, expect, it } from "vitest";
import {
  DETERMINISTIC_TRACE_SCORERS,
  EMPTY_SCORER_FORM,
  TRACE_SCORER_MAX_SPANS,
  detectorList,
  modelCallSpanIds,
  parseSpanIds,
  scorerBody,
  skipWords,
  sweepSentence,
} from "./traceEvaluationModel";
import { holdsQuery, isActiveHold, releaseBody, releaseConsequence, type RetentionHold } from "./retentionHoldsModel";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

describe("trace scorer form", () => {
  it("offers exactly the gateway's deterministic scorers and span limit", async () => {
    const shared = await import(new URL("../../../../../../packages/shared/src/evals.ts", import.meta.url).pathname);
    expect([...DETERMINISTIC_TRACE_SCORERS]).toEqual([...shared.DETERMINISTIC_SCORER_KINDS]);
    expect(TRACE_SCORER_MAX_SPANS).toBe(shared.EVAL_TRACE_ROWS_MAX);
  });

  it("reads span ids one per line or comma-separated, de-duplicated", () => {
    expect(parseSpanIds(`${A}\n${B}, ${A.toUpperCase()}  nope`)).toEqual({ ids: [A, B], invalid: ["nope"], duplicates: 1 });
  });

  it("builds a body the gateway's strict schema accepts", async () => {
    const shared = await import(new URL("../../../../../../packages/shared/src/evals.ts", import.meta.url).pathname);
    const built = scorerBody({ ...EMPTY_SCORER_FORM, spanIds: `${A}\n${B}`, scoreName: "refund.mention" });
    expect(built).toEqual({
      ok: true,
      body: { scorerKind: "contains", scorerConfig: { needles: ["refund"] }, spanIds: [A, B], scoreName: "refund.mention" },
    });
    expect(built.ok && shared.evaluateTracesSchema.safeParse(built.body).success).toBe(true);
    const exact = scorerBody({ ...EMPTY_SCORER_FORM, scorerKind: "exact", config: "", spanIds: A, expected: '{"a":1}', expectedIsJson: true });
    expect(exact.ok && exact.body).toEqual({ scorerKind: "exact", scorerConfig: {}, spanIds: [A], expected: { a: 1 } });
    expect(exact.ok && shared.evaluateTracesSchema.safeParse(exact.body).success).toBe(true);
  });

  it("says what is wrong before sending", () => {
    expect(scorerBody({ ...EMPTY_SCORER_FORM, spanIds: "" })).toMatchObject({ ok: false });
    expect(scorerBody({ ...EMPTY_SCORER_FORM, spanIds: "abc" })).toEqual({ ok: false, problem: "Not a span id: abc." });
    expect(scorerBody({ ...EMPTY_SCORER_FORM, spanIds: A, config: "[]" })).toMatchObject({ ok: false });
    expect(scorerBody({ ...EMPTY_SCORER_FORM, spanIds: A, config: "{" })).toMatchObject({ ok: false });
    expect(scorerBody({ ...EMPTY_SCORER_FORM, spanIds: A, scoreName: "Has Spaces" })).toMatchObject({ ok: false });
    expect(scorerBody({ ...EMPTY_SCORER_FORM, spanIds: A, expected: "{", expectedIsJson: true })).toMatchObject({ ok: false });
    const tooMany = Array.from({ length: TRACE_SCORER_MAX_SPANS + 1 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`).join("\n");
    expect(scorerBody({ ...EMPTY_SCORER_FORM, spanIds: tooMany })).toMatchObject({ ok: false });
  });

  it("finds the model-call spans in a trace tree", () => {
    const tree = [{ id: "root", kind: "orchestration", children: [{ id: "m1", kind: "llm", children: [{ id: "f1", kind: "fallback_hop", children: [] }] }, { id: "t1", kind: "tool", children: [] }] }];
    expect(modelCallSpanIds(tree)).toEqual(["m1", "f1"]);
  });

  it("words", () => {
    expect(skipWords("content_withheld")).toBe("content withheld (a block fired)");
    expect(skipWords("something_new")).toBe("something new");
    expect(detectorList({})).toBe("none");
    expect(detectorList({ pii: 1, semantic_dlp: 3 })).toBe("semantic dlp 3 · pii 1");
    expect(sweepSentence({ scanned: 0, evaluated: 0, flagged: 0, withheld: 0, noContent: 0, capped: false })).toBe("No completed model calls were waiting for evaluation.");
    expect(sweepSentence({ scanned: 5, evaluated: 4, flagged: 1, withheld: 1, noContent: 0, capped: true })).toBe(
      "5 model calls examined: 4 evaluated, 1 flagged, 1 withheld (a block fired). The batch limit was reached; run again to continue.",
    );
  });
});

describe("retention hold release", () => {
  const hold = (over: Partial<RetentionHold> = {}): RetentionHold => ({
    traceId: A,
    traceUserId: "u1",
    holdUntil: new Date(Date.now() + 86_400_000).toISOString(),
    ruleId: "r1",
    createdByUserId: null,
    releasedAt: null,
    releaseReason: null,
    ...over,
  });

  it("only an unreleased, unexpired hold can be selected", () => {
    expect(isActiveHold(hold())).toBe(true);
    expect(isActiveHold(hold({ releasedAt: new Date().toISOString() }))).toBe(false);
    expect(isActiveHold(hold({ holdUntil: "2020-01-01T00:00:00.000Z" }))).toBe(false);
  });

  it("builds each arm of the gateway's discriminated union, and only one at a time", () => {
    expect(releaseBody({ scope: "selected", erasure: false, userId: "", reference: "TCK-1" }, [A, B])).toEqual({
      ok: true,
      body: { reason: "admin", traceIds: [A, B], reference: "TCK-1" },
    });
    expect(releaseBody({ scope: "person", erasure: true, userId: "u1", reference: "DSR-9" }, [A])).toEqual({
      ok: true,
      body: { reason: "erasure", userId: "u1", reference: "DSR-9" },
    });
    expect(releaseBody({ scope: "person", erasure: false, userId: "u1", reference: "TCK-2" }, [])).toEqual({
      ok: true,
      body: { reason: "admin", userId: "u1", reference: "TCK-2" },
    });
  });

  it("needs a reference, a selection or a person", () => {
    expect(releaseBody({ scope: "selected", erasure: false, userId: "", reference: " " }, [A])).toMatchObject({ ok: false });
    expect(releaseBody({ scope: "selected", erasure: false, userId: "", reference: "x" }, [])).toMatchObject({ ok: false });
    expect(releaseBody({ scope: "person", erasure: true, userId: "", reference: "x" }, [])).toMatchObject({ ok: false });
  });

  it("states the consequence and filters by valid ids only", () => {
    expect(releaseConsequence({ reason: "admin", traceIds: [A], reference: "x" }, null)).toContain("The hold on 1 trace ends now");
    expect(releaseConsequence({ reason: "erasure", userId: "u1", reference: "x" }, "Ada")).toContain("Ada's traces ends now, for their erasure request");
    expect(holdsQuery({ traceId: "nope", userId: "" })).toMatchObject({ ok: false });
    expect(holdsQuery({ traceId: A, userId: "u1" })).toEqual({ ok: true, qs: `traceId=${A}&userId=u1&limit=200` });
  });
});
