/**
 * Duplicate detection for the registration form (ADR-0168 item 3): which
 * existing use cases look like the one being typed. Client-side and advisory —
 * it never blocks a submission, it only puts the likely duplicates in front of
 * the person before they create one.
 *
 * Similarity is token overlap: the words of a name and purpose, lowercased,
 * stop-words and very short words dropped, a plural "s" folded. A shared word
 * in the NAME counts double, because two records called "Support ticket
 * summarizer" are a likelier duplicate than two descriptions that both say
 * "customer". Pure, so it is unit-tested without a browser.
 */

export interface SimilarCandidate {
  id: string;
  name: string;
  description?: string | null;
}

export interface SimilarMatch<T extends SimilarCandidate> {
  useCase: T;
  score: number;
  /** the shared words, for a tooltip or a test — never shown as the reason on its own */
  shared: string[];
}

const STOP = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "our", "their", "will", "are", "was", "has", "have",
  "its", "use", "uses", "using", "case", "cases", "system", "every", "each", "any", "all", "can", "may", "who",
  "what", "when", "which", "how", "not", "but", "per", "via", "a", "an", "of", "to", "in", "on", "by", "or", "is", "be",
  "ai", "help", "helps",
]);

/** the comparable words of a text: lowercase, ≥3 letters, no stop-words, plural folded */
export function tokens(text: string | null | undefined): Set<string> {
  const out = new Set<string>();
  for (const raw of (text ?? "").toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 3 || STOP.has(raw)) continue;
    const word = raw.length > 4 && raw.endsWith("s") && !raw.endsWith("ss") ? raw.slice(0, -1) : raw;
    if (!STOP.has(word)) out.add(word);
  }
  return out;
}

/**
 * Existing use cases similar to `draft`, best first. A draft with fewer than
 * two words to compare returns nothing — one word matches too much to help.
 */
export function findSimilar<T extends SimilarCandidate>(
  draft: { name: string; description: string },
  existing: readonly T[],
  opts: { threshold?: number; limit?: number; excludeIds?: readonly string[] } = {},
): Array<SimilarMatch<T>> {
  const threshold = opts.threshold ?? 0.25;
  const limit = opts.limit ?? 8;
  const draftName = tokens(draft.name);
  const draftAll = new Set([...draftName, ...tokens(draft.description)]);
  if (draftAll.size < 2) return [];
  const exclude = new Set(opts.excludeIds ?? []);
  const matches: Array<SimilarMatch<T>> = [];
  for (const useCase of existing) {
    if (exclude.has(useCase.id)) continue;
    const theirName = tokens(useCase.name);
    const theirAll = new Set([...theirName, ...tokens(useCase.description)]);
    if (theirAll.size === 0) continue;
    const shared = [...draftAll].filter((word) => theirAll.has(word));
    if (shared.length === 0) continue;
    const nameShared = [...draftName].filter((word) => theirName.has(word)).length;
    // cosine over word sets, with the name overlap weighted in
    const cosine = shared.length / Math.sqrt(draftAll.size * theirAll.size);
    const nameScore = draftName.size && theirName.size ? nameShared / Math.sqrt(draftName.size * theirName.size) : 0;
    const score = Math.min(1, 0.6 * cosine + 0.4 * nameScore + (nameShared > 0 && shared.length > 1 ? 0.1 : 0));
    if (score >= threshold) matches.push({ useCase, score, shared });
  }
  return matches.sort((a, b) => b.score - a.score || a.useCase.name.localeCompare(b.useCase.name)).slice(0, limit);
}
