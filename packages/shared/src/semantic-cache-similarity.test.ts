import { describe, expect, it } from "vitest";
import {
  bestSimilar,
  cosine,
  embeddingClaimRefusal,
  normalise,
  parseEmbeddingReply,
} from "./semantic-cache-similarity.js";
import { createExternalScorerSchema } from "./external-scorer.js";

const v16 = (i: number) => Array.from({ length: 16 }, (_, k) => (k === i ? 1 : 0));

describe("ADR-0352 embed reply", () => {
  it("accepts a conforming reply and normalises the vector", () => {
    const r = parseEmbeddingReply(JSON.stringify({ embedding: [3, 4, ...new Array(14).fill(0)], model: "m@1" }));
    expect(r.model).toBe("m@1");
    expect(r.vector[0]).toBeCloseTo(0.6);
    expect(r.vector[1]).toBeCloseTo(0.8);
  });
  it("refuses everything outside the contract", () => {
    for (const body of [
      "not json",
      "[]",
      JSON.stringify({ model: "m" }),
      JSON.stringify({ embedding: [1, 2], model: "m" }),
      JSON.stringify({ embedding: [...v16(0).slice(0, 15), Number.NaN], model: "m" }).replace("null", '"x"'),
      JSON.stringify({ embedding: v16(0), model: "" }),
      JSON.stringify({ embedding: v16(0), model: "has space" }),
      JSON.stringify({ embedding: new Array(16).fill(0), model: "m" }),
    ]) {
      expect(() => parseEmbeddingReply(body)).toThrow();
    }
  });
});

describe("ADR-0352 similarity", () => {
  it("cosine of unit vectors; a width mismatch never matches", () => {
    expect(cosine(v16(1), v16(1))).toBe(1);
    expect(cosine(v16(1), v16(2))).toBe(0);
    expect(cosine(v16(1), [1])).toBe(-1);
    expect(cosine(normalise([1, 1]), normalise([1, 0]))).toBeCloseTo(Math.SQRT1_2);
  });
  it("picks the best candidate at or above the bar, else none", () => {
    const q = normalise([1, 0.1]);
    const rows = [
      { id: "old", embedding: normalise([1, 0.12]) },
      { id: "far", embedding: normalise([0, 1]) },
      { id: "exact", embedding: q },
    ];
    expect(bestSimilar(q, rows, 0.95)?.row.id).toBe("exact");
    expect(bestSimilar(q, [rows[1]!], 0.95)).toBeNull();
  });
});

describe("ADR-0352 registration", () => {
  it("text_embedding is claimed alone", () => {
    expect(embeddingClaimRefusal(["text_embedding"])).toBeNull();
    expect(embeddingClaimRefusal(["text_embedding", "guardrail_pii"])).toMatch(/alone/);
    const ok = createExternalScorerSchema.safeParse({ name: "e", baseUrl: "http://10.0.0.1/embed", scorerKinds: ["text_embedding"] });
    expect(ok.success).toBe(true);
    const mixed = createExternalScorerSchema.safeParse({
      name: "e",
      baseUrl: "http://10.0.0.1/embed",
      scorerKinds: ["text_embedding", "llm_as_judge"],
    });
    expect(mixed.success).toBe(false);
  });
});
