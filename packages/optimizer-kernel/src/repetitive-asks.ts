/**
 * ADR-0328 slice 1 — find repetitive asks: clusters of near-duplicate prompts sent to the same agent.
 *
 * Privacy: everything here runs in the gateway process on text it already holds. The output is ids, 64-bit
 * fingerprints and counts; no prompt text leaves this function, and nothing is sent to a model or a remote service.
 *
 * Method (deterministic, no model):
 *  0. Tokenize with the shared tokenizer and mask every numeric token (an id, a quantity, a date part) to `#`: an ask
 *     that differs only in such values is the same template, which is exactly what a smaller model can take over.
 *  1. Fingerprint each ask with SimHash (Charikar 2002) over the shared tokenizer's unigrams and adjacent bigrams,
 *     each feature hashed with 64-bit FNV-1a. Near-duplicate texts get fingerprints a few bits apart.
 *  2. Find candidate pairs by banding: the 64 bits split into `maxHamming + 1` bands, so by the pigeonhole principle two
 *     fingerprints within `maxHamming` bits agree exactly on at least one band. Only asks sharing a band are compared.
 *  3. Confirm each candidate pair twice: Hamming distance ≤ `maxHamming`, and TF-IDF cosine ≥ `minSimilarity` (the
 *     shared `weightedVector`/`cosine`). Confirmed pairs are joined with union-find.
 *  4. Keep clusters of at least `minClusterSize` asks. Each cluster's representative is the member closest to the others
 *     (its medoid by cosine, found among its first `maxBucket` members); cohesion is the mean cosine of all members to it.
 *
 * Bounded: at most `MAX_ASKS` asks per call, at most `MAX_BUCKET` asks compared within one band bucket (a larger
 * bucket is a very common template; it is compared against its first `MAX_BUCKET` members only, and the cut is
 * reported). Suggesting a smaller model for a cluster is the caller's job (later slices): this only measures.
 *
 * Open source (ADR-0176, compared in the ADR): `simhash-js`, `simhash`, `minhash` and `@agtabesh/lsh` (MIT) last
 * released in 2022 and fail "maintained"; `string-similarity` (ISC, 2023) is pairwise only (quadratic) and also outside
 * the window; Python `datasketch` (MIT, maintained) needs a Python engine image. SimHash with banding is about 100
 * lines on top of the repo's one tokenizer, so it is written here and re-checked when the ecosystem changes.
 */
import { buildIdf, cosine, isNumericToken, tokenize, weightedVector } from "@regulait/shared";

export const REPETITIVE_ASK_LIMITS = Object.freeze({
  /** asks per call */
  maxAsks: 5_000,
  /** asks compared inside one band bucket */
  maxBucket: 200,
  /** characters of an ask read for fingerprinting (the rest is ignored) */
  maxChars: 8_000,
});

export interface RepetitiveAskOptions {
  /** most differing fingerprint bits for two asks to count as near-duplicates (0–7) */
  maxHamming: number;
  /** least TF-IDF cosine for two asks to count as near-duplicates (0–1) */
  minSimilarity: number;
  /** least asks for a cluster to be reported */
  minClusterSize: number;
}

/** strict defaults: a cluster is a real template asked again and again, not a topic */
export const DEFAULT_REPETITIVE_ASK_OPTIONS: Readonly<RepetitiveAskOptions> = Object.freeze({
  maxHamming: 3,
  minSimilarity: 0.9,
  minClusterSize: 20,
});

/**
 * How far an admin may relax the defaults (ADR-0180: strict by default, relaxing is audited and bounded). The gateway's
 * settings schema and the database CHECKs hold the same bounds.
 */
export const REPETITIVE_ASK_FLOORS = Object.freeze({
  /** the most bits an admin may allow (wider than this pairs unrelated asks) */
  maxHamming: 5,
  minSimilarity: 0.8,
  minClusterSize: 10,
});

export interface Ask {
  readonly id: string;
  readonly text: string;
  /** measured cost of the AI call that answered it, when priced */
  readonly costUsd?: number | null;
}

export interface AskCluster {
  /** the representative's fingerprint, 16 lowercase hex characters */
  readonly fingerprint: string;
  /** the representative ask's id (the medoid) */
  readonly representativeId: string;
  readonly memberIds: readonly string[];
  readonly size: number;
  /** mean cosine of the members to the representative (1 = identical wording) */
  readonly cohesion: number;
  /** total and mean measured cost of the members' AI calls; null when none was priced */
  readonly totalCostUsd: number | null;
  readonly meanCostUsd: number | null;
}

export interface RepetitiveAskResult {
  readonly clusters: readonly AskCluster[];
  /** asks considered (after the `maxAsks` cut and dropping asks with no tokens) */
  readonly considered: number;
  /** asks left out because the call passed more than `maxAsks` */
  readonly truncated: number;
  /** band buckets cut at `maxBucket` */
  readonly cappedBuckets: number;
}

const MASK64 = (1n << 64n) - 1n;
const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;

/** 64-bit FNV-1a over the UTF-16 code units of `s` */
function fnv1a64(s: string): bigint {
  let h = FNV_OFFSET;
  for (let i = 0; i < s.length; i++) {
    h ^= BigInt(s.charCodeAt(i));
    h = (h * FNV_PRIME) & MASK64;
  }
  return h;
}

/** the shared tokenizer's tokens with numeric ones masked; the one input to both the fingerprint and the cosine */
function askTokens(text: string): string[] {
  return tokenize(text.slice(0, REPETITIVE_ASK_LIMITS.maxChars)).map((t) => (isNumericToken(t) ? "#" : t));
}

function features(tokens: readonly string[]): string[] {
  const out = [...tokens];
  for (let i = 0; i + 1 < tokens.length; i++) out.push(`${tokens[i]} ${tokens[i + 1]}`);
  return out;
}

/** SimHash of the given tokens: each bit is the sign of the summed ±1 votes of the features' hashes */
function simhash(tokens: readonly string[]): bigint {
  const votes = new Array<number>(64).fill(0);
  for (const f of features(tokens)) {
    const h = fnv1a64(f);
    for (let b = 0; b < 64; b++) votes[b]! += (h >> BigInt(b)) & 1n ? 1 : -1;
  }
  let out = 0n;
  for (let b = 0; b < 64; b++) if (votes[b]! > 0) out |= 1n << BigInt(b);
  return out;
}

/** The 64-bit SimHash fingerprint of one ask, as 16 hex characters. Empty when the text has no tokens. */
export function askFingerprint(text: string): string {
  const tokens = askTokens(text);
  return tokens.length === 0 ? "" : simhash(tokens).toString(16).padStart(16, "0");
}

function hamming(a: bigint, b: bigint): number {
  let x = a ^ b;
  let n = 0;
  while (x) {
    x &= x - 1n;
    n++;
  }
  return n;
}

/** The validation errors in `opts`, or none. */
export function repetitiveAskOptionProblems(opts: RepetitiveAskOptions): string[] {
  const out: string[] = [];
  if (!Number.isInteger(opts.maxHamming) || opts.maxHamming < 0 || opts.maxHamming > 7) out.push("maxHamming must be an integer from 0 to 7");
  if (!(opts.minSimilarity >= 0 && opts.minSimilarity <= 1)) out.push("minSimilarity must be between 0 and 1");
  if (!Number.isInteger(opts.minClusterSize) || opts.minClusterSize < 2) out.push("minClusterSize must be an integer of at least 2");
  return out;
}

/** Find clusters of near-duplicate asks. Pure and deterministic: the same asks in the same order give the same result. */
export function findRepetitiveAsks(asks: readonly Ask[], options: Partial<RepetitiveAskOptions> = {}): RepetitiveAskResult {
  const opts: RepetitiveAskOptions = { ...DEFAULT_REPETITIVE_ASK_OPTIONS, ...options };
  const problems = repetitiveAskOptionProblems(opts);
  if (problems.length > 0) throw new RangeError(problems.join("; "));

  const kept = asks.slice(0, REPETITIVE_ASK_LIMITS.maxAsks);
  const truncated = asks.length - kept.length;
  const items = kept
    .map((a) => ({ ask: a, tokens: askTokens(a.text) }))
    .filter((x) => x.tokens.length > 0);
  const idf = buildIdf(items.map((x) => x.tokens));
  const vecs = items.map((x) => weightedVector(x.tokens, idf));
  const prints = items.map((x) => simhash(x.tokens));

  // union-find over item indexes
  const parent = items.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]!]!;
      i = parent[i]!;
    }
    return i;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };

  const bands = opts.maxHamming + 1;
  const width = Math.floor(64 / bands);
  let cappedBuckets = 0;
  const compared = new Set<string>();
  for (let band = 0; band < bands; band++) {
    const shift = BigInt(band * width);
    const bits = band === bands - 1 ? 64 - band * width : width;
    const mask = (1n << BigInt(bits)) - 1n;
    const buckets = new Map<bigint, number[]>();
    prints.forEach((p, i) => {
      const key = (p >> shift) & mask;
      const list = buckets.get(key);
      if (list) list.push(i);
      else buckets.set(key, [i]);
    });
    for (const members of buckets.values()) {
      if (members.length < 2) continue;
      const list = members.length > REPETITIVE_ASK_LIMITS.maxBucket ? members.slice(0, REPETITIVE_ASK_LIMITS.maxBucket) : members;
      if (list !== members) {
        cappedBuckets++;
        // the rest of a capped bucket joins through its first member when it is a confirmed near-duplicate of it
        for (const j of members.slice(REPETITIVE_ASK_LIMITS.maxBucket)) {
          const i = members[0]!;
          if (hamming(prints[i]!, prints[j]!) <= opts.maxHamming && cosine(vecs[i]!, vecs[j]!) >= opts.minSimilarity) union(i, j);
        }
      }
      for (let x = 0; x < list.length; x++) {
        for (let y = x + 1; y < list.length; y++) {
          const i = list[x]!;
          const j = list[y]!;
          const key = `${i}:${j}`;
          if (compared.has(key)) continue;
          compared.add(key);
          if (hamming(prints[i]!, prints[j]!) <= opts.maxHamming && cosine(vecs[i]!, vecs[j]!) >= opts.minSimilarity) union(i, j);
        }
      }
    }
  }

  const groups = new Map<number, number[]>();
  items.forEach((_, i) => {
    const r = find(i);
    const g = groups.get(r);
    if (g) g.push(i);
    else groups.set(r, [i]);
  });

  const clusters: AskCluster[] = [];
  for (const members of groups.values()) {
    if (members.length < opts.minClusterSize) continue;
    // the medoid of the first `maxBucket` members (bounded: quadratic only in that sample), then cohesion over every
    // member against it (linear); the first member wins a tie
    const sample = members.slice(0, REPETITIVE_ASK_LIMITS.maxBucket);
    let best = sample[0]!;
    let bestSum = -1;
    for (const i of sample) {
      let sum = 0;
      for (const j of sample) if (i !== j) sum += cosine(vecs[i]!, vecs[j]!);
      if (sum > bestSum) {
        bestSum = sum;
        best = i;
      }
    }
    let toBest = 0;
    for (const j of members) if (j !== best) toBest += cosine(vecs[best]!, vecs[j]!);
    const cohesion = members.length > 1 ? toBest / (members.length - 1) : 1;
    const priced = members.map((i) => items[i]!.ask.costUsd).filter((c): c is number => typeof c === "number" && Number.isFinite(c) && c >= 0);
    const total = priced.reduce((s, c) => s + c, 0);
    clusters.push({
      fingerprint: prints[best]!.toString(16).padStart(16, "0"),
      representativeId: items[best]!.ask.id,
      memberIds: members.map((i) => items[i]!.ask.id),
      size: members.length,
      cohesion: Number(cohesion.toFixed(4)),
      totalCostUsd: priced.length > 0 ? Number(total.toFixed(6)) : null,
      meanCostUsd: priced.length > 0 ? Number((total / priced.length).toFixed(6)) : null,
    });
  }
  // largest first, then by fingerprint, so the order never depends on hashing
  clusters.sort((a, b) => b.size - a.size || a.fingerprint.localeCompare(b.fingerprint));
  return { clusters, considered: items.length, truncated, cappedBuckets };
}
