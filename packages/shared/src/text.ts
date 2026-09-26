/**
 * THE ONE TOKENIZER, and the TF-IDF weighting built on it.
 *
 * This module was HOISTED here from `packages/training-provider` by ADR-0067
 * rather than copied. The reason is the same one that made it worth sharing
 * inside that package in the first place: an index built with one tokenizer and
 * queried with another silently returns nothing, and the failure mode
 * ("it answers, just always wrongly") survives a demo. ADR-0067 needed exactly
 * these primitives for groundedness scoring, and a THIRD tokenizer in the
 * codebase would have meant three different opinions about what a word is.
 *
 * `@regulait/shared` is the right home because it is the leaf package with no
 * workspace dependencies — training-provider now imports from here and
 * re-exports `tokenize`, so every existing caller is unchanged.
 *
 * Nothing in this file is simulated. IDF is the smoothed
 * `ln((N+1)/(df+1)) + 1`, term frequency is sub-linear (`1 + ln(count)`), and
 * vectors are L2-normalised so a cosine similarity is a plain dot product.
 */

/** A deliberately small stop list. Big enough to stop "the" dominating every
 * TF-IDF vector, small enough that it cannot silently delete a domain term. */
export const STOPWORDS: ReadonlySet<string> = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "how", "in", "is", "it", "of",
  "on", "or", "that", "the", "this", "to", "was", "what", "when", "where", "which", "who", "will",
  "with", "you", "your", "do", "does", "did", "i", "we", "our",
]);

/**
 * Lowercase, split on non-alphanumerics, drop single characters and stopwords.
 *
 * Deliberately boring and deliberately shared: the index build and the query
 * MUST tokenise identically or a retrieval index silently returns nothing.
 *
 * NOTE FOR GROUNDEDNESS (ADR-0067): numerals SURVIVE this (they are alphanumeric
 * and usually longer than one character), which is load-bearing — a fabricated
 * figure is one of the few hallucinations a lexical method can actually catch.
 * Negation words do NOT survive intact as a structure: "not" is two characters
 * so it is kept as a token, but token-bag overlap is blind to what it scopes.
 * That blindness is disclosed, not papered over — see `negationParity`.
 */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 2) continue;
    if (STOPWORDS.has(raw)) continue;
    out.push(raw);
  }
  return out;
}

/** Terms that look like a quantity or an identifier: the class of token whose
 * absence from the context is the strongest lexical hallucination signal
 * available without a model. */
export function isNumericToken(t: string): boolean {
  return /\d/.test(t);
}

/**
 * Smoothed inverse document frequency over a document set.
 * `ln((N+1)/(df+1)) + 1` — a term present in every document still carries a
 * small positive weight rather than annihilating the vector.
 */
export function buildIdf(documents: ReadonlyArray<ReadonlyArray<string>>): Record<string, number> {
  const df = new Map<string, number>();
  for (const toks of documents) {
    for (const t of new Set(toks)) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const n = documents.length;
  const idf: Record<string, number> = {};
  for (const [term, d] of df) idf[term] = Math.log((n + 1) / (d + 1)) + 1;
  return idf;
}

/** term-frequency × idf, then L2-normalised. */
export function weightedVector(
  tokens: ReadonlyArray<string>,
  idf: Record<string, number>,
): Record<string, number> {
  const tf = new Map<string, number>();
  for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
  const vec: Record<string, number> = {};
  let norm = 0;
  for (const [term, count] of tf) {
    const w = (idf[term] ?? 0) * (1 + Math.log(count));
    if (w === 0) continue;
    vec[term] = w;
    norm += w * w;
  }
  norm = Math.sqrt(norm);
  if (norm === 0) return {};
  for (const term of Object.keys(vec)) vec[term] = vec[term]! / norm;
  return vec;
}

/** cosine similarity of two L2-normalised sparse vectors = their dot product */
export function cosine(a: Record<string, number>, b: Record<string, number>): number {
  let dot = 0;
  const [small, large] = Object.keys(a).length <= Object.keys(b).length ? [a, b] : [b, a];
  for (const [term, w] of Object.entries(small)) {
    const o = large[term];
    if (o !== undefined) dot += w * o;
  }
  return dot;
}
