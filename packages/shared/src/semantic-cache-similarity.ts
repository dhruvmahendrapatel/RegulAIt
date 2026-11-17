/**
 * ADR-0352 (lane E33 slice 2): the pure half of the meaning-based cache tier.
 *
 * The tier sits behind the exact cache (ADR-0119/0136/0146). It never widens what
 * a cache row may serve: a row is only a candidate inside its mandatory partition
 * (the same user, the same agent and a commitment to everything in the exact key
 * except the input text: project, options, planner dials and the serving
 * configuration), and every hit still runs the live governance gates (ADR-0138).
 * Only the input text is compared by meaning.
 */

/** The external-scorer kind an embedder registration claims. Exclusive: an
 * embedder is not a judge or a guardrail, and one row serves one contract. */
export const TEXT_EMBEDDING_SCORER_KIND = "text_embedding" as const;

/** The org setting's bounds and strict default. 0.95 cosine is deliberately tight:
 * close paraphrases match, a different question does not. Lowering it is the
 * audited relaxation. */
export const SIMILARITY_MIN_FLOOR = 0.8;
export const SIMILARITY_MIN_CEILING = 0.999;
export const SIMILARITY_MIN_DEFAULT = 0.95;

/** At most this many of the partition's newest live rows are compared per lookup,
 * so a lookup is bounded whatever the partition holds. */
export const SIMILARITY_CANDIDATES_MAX = 256;
/** Accepted embedding widths. */
export const EMBEDDING_DIMS_MIN = 16;
export const EMBEDDING_DIMS_MAX = 4096;
/** The longest input the tier embeds; longer inputs use the exact tier only. */
export const EMBED_INPUT_MAX_CHARS = 32_000;

/** Registration rule: `text_embedding` is claimed alone. Null = acceptable. */
export function embeddingClaimRefusal(scorerKinds: readonly string[]): string | null {
  if (scorerKinds.includes(TEXT_EMBEDDING_SCORER_KIND) && scorerKinds.length > 1) {
    return `'${TEXT_EMBEDDING_SCORER_KIND}' is claimed alone: an embedder speaks the /embed contract, not the scoring one`;
  }
  return null;
}

export interface EmbeddingReply {
  /** L2-normalised here, whatever the service sent */
  readonly vector: number[];
  /** the model identity the service reported (repository and revision) */
  readonly model: string;
}

/** Validate an /embed reply. Throws on anything outside the contract; it never
 * fabricates a vector. */
export function parseEmbeddingReply(text: string): EmbeddingReply {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error("embedder reply is not JSON");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new Error("embedder reply is not an object");
  const { embedding, model } = body as { embedding?: unknown; model?: unknown };
  if (!Array.isArray(embedding)) throw new Error("embedder reply has no `embedding` array");
  if (embedding.length < EMBEDDING_DIMS_MIN || embedding.length > EMBEDDING_DIMS_MAX) {
    throw new Error(`embedding width ${embedding.length} is outside ${EMBEDDING_DIMS_MIN}..${EMBEDDING_DIMS_MAX}`);
  }
  if (!embedding.every((x) => typeof x === "number" && Number.isFinite(x))) throw new Error("embedding holds a non-finite value");
  if (typeof model !== "string" || !/^[\x21-\x7e]{1,200}$/.test(model)) throw new Error("embedder reply has no valid `model`");
  return { vector: normalise(embedding as number[]), model };
}

export function normalise(v: readonly number[]): number[] {
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  if (!(n > 0)) throw new Error("zero embedding");
  return v.map((x) => x / n);
}

/** Cosine similarity of two unit vectors; -1 for a width mismatch (never a match). */
export function cosine(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) return -1;
  let s = 0;
  for (let i = 0; i < a.length; i += 1) s += a[i]! * b[i]!;
  return s;
}

/** The best candidate at or above `min`, ties to the newest (candidates arrive newest first). */
export function bestSimilar<T extends { embedding: readonly number[] }>(
  query: readonly number[],
  candidates: readonly T[],
  min: number,
): { row: T; similarity: number } | null {
  let best: { row: T; similarity: number } | null = null;
  for (const row of candidates) {
    const similarity = cosine(query, row.embedding);
    if (similarity >= min && (!best || similarity > best.similarity)) best = { row, similarity };
  }
  return best;
}
