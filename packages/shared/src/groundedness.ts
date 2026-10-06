/**
 * ADR-0067 — GROUNDEDNESS, FAITHFULNESS AND HALLUCINATION MEASUREMENT.
 *
 * The pure half. No I/O, no clock, no db, no provider, no key — exactly the
 * split ADR-0044's scorers, ADR-0042's guardrails and §8.4's PII classifier
 * already use, and for the same reason: a metric a regulated buyer is going to
 * cite must be executable in a unit test with no infrastructure, or nobody can
 * prove it measures anything.
 *
 * ============================================================================
 * WHAT THIS FILE CAN DETECT, AND WHAT IT CANNOT. READ BEFORE CITING A SCORE.
 * ============================================================================
 *
 * Everything here is LEXICAL: IDF-weighted token overlap between an answer's
 * sentences and the context those sentences were supposed to be grounded in.
 * That is a real method with real discriminative power, and it is not a model.
 *
 * IT GENUINELY DETECTS:
 *   - Fabricated entities and figures. A claim naming a person, product, date
 *     or number that appears NOWHERE in the supplied context scores near zero,
 *     and a numeric token absent from all context is called out by name
 *     (`unsupportedNumbers`) because a wrong figure is the hallucination a
 *     regulated reviewer cares about most.
 *   - Whole-cloth invention. A fluent answer over unrelated content has almost
 *     no IDF mass in common with the context and collapses to a low score.
 *   - Context that was never used (`context_precision`) and support the
 *     retriever failed to supply (`context_recall`).
 *   - Non-answers. "I don't know" / "I cannot help with that" is detected
 *     explicitly rather than being scored as a fluent irrelevance.
 *
 * IT CANNOT DETECT, AND WILL SCORE AS SUPPORTED:
 *   - NEGATION AND POLARITY FLIPS. "The system encrypts data at rest" and "The
 *     system does not encrypt data at rest" share nearly every content token.
 *     A parity MISMATCH is FLAGGED on the claim (`negationMismatch`) so a human
 *     sees it, but it deliberately does not move the score: a correct answer is
 *     often the negation of something the context says, and a metric that
 *     punished that would be wrong more often than right.
 *   - ATTRIBUTION AND ROLE SWAPS. "Ana approved Ben's change" vs "Ben approved
 *     Ana's change" are the same bag of tokens.
 *   - COMPOSITIONAL AND CAUSAL ERRORS. A conclusion validly-worded but not
 *     entailed by the premises reads as supported.
 *   - PARAPHRASE WITHOUT SHARED VOCABULARY. A correct claim restated entirely
 *     in synonyms scores LOW. This metric has false positives as well as false
 *     negatives, and the false positives are the direction that hurts.
 *
 * That list is why the judge-backed metrics exist and why they REFUSE instead
 * of degrading into these functions when no provider is configured. A number
 * produced here must never be reported under a metric name that promises
 * entailment. ADR-0067 §4.
 */

import { buildIdf, cosine, isNumericToken, tokenize, weightedVector } from "./text.js";
import { fencedBlockBody, firstBraceBlock } from "./linear-scan.js";

const round4 = (n: number) => Number(n.toFixed(4));
const clamp01 = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

/** how much of a claim is retained on a stored result row. Claims are slices of
 * model output, so they inherit the ADR-0044 truncation posture verbatim. */
export const CLAIM_SNIPPET_MAX = 300;
/** how many claims are retained on a result row's detail */
export const CLAIM_DETAIL_MAX = 50;

// ---------------------------------------------------------------------------
// Claim segmentation
// ---------------------------------------------------------------------------

/** Abbreviations whose trailing period must not end a sentence. Small and
 * explicit — a list that tried to be exhaustive would be wrong silently. */
const ABBREVIATIONS = new Set([
  "e.g", "i.e", "etc", "vs", "mr", "mrs", "ms", "dr", "prof", "inc", "ltd", "co", "no", "fig",
  "approx", "est", "cf", "al",
]);

/** a claim shorter than this many CONTENT tokens is not independently
 * verifiable ("Yes.", "See below.") and is reported as skipped rather than
 * silently counted as supported — the single easiest way to inflate a
 * groundedness score is to count fragments. */
export const MIN_CLAIM_TOKENS = 3;

/**
 * Split an answer into candidate claims: sentences, plus list items and
 * newline-delimited fragments, with abbreviation and decimal guards.
 *
 * This is SEGMENTATION, not claim extraction. A sentence carrying two
 * independent assertions is scored as one claim, which means a half-fabricated
 * sentence scores in the middle rather than being split into a supported half
 * and an unsupported half. Stated here because it is the most consequential
 * simplification in the file.
 */
export function splitClaims(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\r?\n+/)) {
    // strip list markers so "- The total is 42" segments like a sentence
    const body = line.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "").trim();
    if (!body) continue;
    let buf = "";
    for (let i = 0; i < body.length; i++) {
      const ch = body[i]!;
      buf += ch;
      if (ch !== "." && ch !== "!" && ch !== "?" && ch !== ";") continue;
      const next = body[i + 1];
      // a decimal point / version number: 3.5, 1.2.3
      if (ch === "." && /\d/.test(body[i - 1] ?? "") && /\d/.test(next ?? "")) continue;
      // an abbreviation
      const lastWord = buf.slice(0, -1).split(/[\s(]/).pop()?.toLowerCase() ?? "";
      if (ch === "." && ABBREVIATIONS.has(lastWord)) continue;
      // a terminator must be followed by whitespace or end-of-line
      if (next !== undefined && !/\s/.test(next)) continue;
      const claim = buf.trim();
      if (claim) out.push(claim);
      buf = "";
    }
    const tail = buf.trim();
    if (tail) out.push(tail);
  }
  return out;
}

const NEGATIONS = new Set([
  "not", "no", "never", "cannot", "without", "neither", "nor", "none", "nothing", "nobody",
  "unsupported", "unable", "denied", "disabled", "excluded", "absent",
]);

/** true when the text carries a negation marker. Used for a FLAG only. */
export function hasNegation(text: string): boolean {
  const lowered = ` ${text.toLowerCase().replace(/[^a-z0-9']+/g, " ")} `;
  if (/\b\w+n't\b/.test(lowered)) return true;
  for (const n of NEGATIONS) {
    if (lowered.includes(` ${n} `)) return true;
  }
  return false;
}

/** Non-committal answers. Ragas treats these specially and so do we: an
 * abstention is not an irrelevant answer, and scoring it as one would push
 * agents toward confident wrongness — the opposite of what this metric is for. */
const NONCOMMITTAL = [
  /\bi (?:do not|don't) know\b/i,
  /\bi (?:cannot|can't|am unable to)\b/i,
  /\bno (?:information|answer|data|context) (?:is )?(?:available|provided|found)\b/i,
  /\bnot (?:enough|sufficient) (?:information|context)\b/i,
  /\bunable to (?:answer|determine|find)\b/i,
  /\bthe (?:context|provided context|documents?) (?:does|do) not (?:contain|mention|say)\b/i,
];

export function isNoncommittal(text: string): boolean {
  return NONCOMMITTAL.some((re) => re.test(text));
}

// ---------------------------------------------------------------------------
// Per-claim support
// ---------------------------------------------------------------------------

export interface ClaimSupport {
  /** the claim text, TRUNCATED to CLAIM_SNIPPET_MAX (it is model output) */
  claim: string;
  /** IDF-weighted fraction of the claim's content mass found in the single
   * best-matching context chunk, in [0,1] */
  score: number;
  supported: boolean;
  /** index of the chunk that supported it best, or null when nothing did */
  bestChunk: number | null;
  /** the claim's content terms that appear in NO context chunk at all */
  missingTerms: string[];
  /** the subset of missingTerms that look like quantities or identifiers — the
   * strongest lexical hallucination signal this method has */
  unsupportedNumbers: string[];
  /** true when claim and best chunk disagree about negation. FLAG ONLY: it
   * does not move the score. See the header. */
  negationMismatch: boolean;
  /** true when the claim had fewer than MIN_CLAIM_TOKENS content tokens and was
   * excluded from the ratio rather than counted either way */
  skipped: boolean;
}

export interface ClaimSupportOptions {
  /** a claim at or above this weighted-coverage score counts as supported.
   * Default 0.6 — chosen so a claim must share most of its rare vocabulary
   * with one chunk, not merely brush against it. */
  claimThreshold?: number;
  /** cap on the claims scored, so a runaway answer cannot make a result row
   * unbounded. Excess claims are counted in `truncatedClaims`. */
  maxClaims?: number;
}

export const DEFAULT_CLAIM_THRESHOLD = 0.6;

export interface ClaimSupportReport {
  /** supportedClaims / verifiableClaims, or 0 when there is nothing to verify */
  ratio: number;
  claims: ClaimSupport[];
  /** the claims that failed — THE THING A COMPLIANCE REVIEWER READS */
  unsupportedClaims: ClaimSupport[];
  verifiableClaims: number;
  supportedClaims: number;
  skippedClaims: number;
  truncatedClaims: number;
  claimThreshold: number;
  /** null when a report is well-formed; a stated reason when it is not */
  refusal: string | null;
}

/**
 * Score every claim in `answer` against `chunks`.
 *
 * THE CENTRAL CHOICE: a claim is scored against the SINGLE best chunk, never
 * against the union of all chunks. A claim whose evidence has to be stitched
 * together out of fragments of three different documents is precisely the
 * fabrication mode this metric exists to catch, and a union-of-context method
 * scores that as fully supported. The cost of the choice is that a legitimately
 * multi-hop answer scores low; that is the safer direction to be wrong in.
 */
export function scoreClaimSupport(
  answer: string,
  chunks: ReadonlyArray<string>,
  opts: ClaimSupportOptions = {},
): ClaimSupportReport {
  const claimThreshold = opts.claimThreshold ?? DEFAULT_CLAIM_THRESHOLD;
  const maxClaims = opts.maxClaims ?? CLAIM_DETAIL_MAX;
  const empty: ClaimSupportReport = {
    ratio: 0,
    claims: [],
    unsupportedClaims: [],
    verifiableClaims: 0,
    supportedClaims: 0,
    skippedClaims: 0,
    truncatedClaims: 0,
    claimThreshold,
    refusal: null,
  };
  if (chunks.length === 0) {
    return { ...empty, refusal: "no context was supplied — groundedness is undefined without it" };
  }

  const chunkTokens = chunks.map((c) => tokenize(c));
  const allSegments = splitClaims(answer);
  const segments = allSegments.slice(0, maxClaims);
  const truncatedClaims = allSegments.length - segments.length;
  const claimTokens = segments.map((s) => tokenize(s));

  // IDF over the context chunks PLUS the answer's own claims, so a term that
  // is boilerplate across the whole exchange is down-weighted and a term that
  // appears in exactly one place carries the weight it deserves.
  const idf = buildIdf([...chunkTokens, ...claimTokens]);
  const contextVocabulary = new Set<string>();
  for (const toks of chunkTokens) for (const t of toks) contextVocabulary.add(t);

  const chunkSets = chunkTokens.map((toks) => new Set(toks));
  const chunkNegated = chunks.map((c) => hasNegation(c));

  const claims: ClaimSupport[] = segments.map((claim, i) => {
    const toks = claimTokens[i]!;
    const unique = [...new Set(toks)];
    const total = unique.reduce((a, t) => a + (idf[t] ?? 0), 0);
    const truncated = claim.length > CLAIM_SNIPPET_MAX ? `${claim.slice(0, CLAIM_SNIPPET_MAX)}…` : claim;
    if (unique.length < MIN_CLAIM_TOKENS || total === 0) {
      return {
        claim: truncated,
        score: 0,
        supported: false,
        bestChunk: null,
        missingTerms: [],
        unsupportedNumbers: [],
        negationMismatch: false,
        skipped: true,
      };
    }
    let bestChunk: number | null = null;
    let best = 0;
    chunkSets.forEach((set, ci) => {
      const covered = unique.reduce((a, t) => a + (set.has(t) ? (idf[t] ?? 0) : 0), 0);
      const s = covered / total;
      if (s > best) {
        best = s;
        bestChunk = ci;
      }
    });
    const missingTerms = unique.filter((t) => !contextVocabulary.has(t));
    const unsupportedNumbers = missingTerms.filter(isNumericToken);
    // A FABRICATED FIGURE IS A HARD SIGNAL, not a rounding error in the token
    // bag. A claim carrying a quantity or identifier that appears nowhere in
    // the context is capped well below the support threshold whatever its
    // surrounding prose does — this is the single most common real-world
    // hallucination and IDF-weighted coverage alone under-penalises it,
    // because one number is one term among many.
    const capped = unsupportedNumbers.length > 0 ? Math.min(best, claimThreshold * 0.5) : best;
    const score = round4(clamp01(capped));
    return {
      claim: truncated,
      score,
      supported: score >= claimThreshold,
      bestChunk,
      missingTerms: missingTerms.slice(0, 20),
      unsupportedNumbers: unsupportedNumbers.slice(0, 20),
      negationMismatch:
        bestChunk !== null && hasNegation(claim) !== chunkNegated[bestChunk as number]!,
      skipped: false,
    };
  });

  const verifiable = claims.filter((c) => !c.skipped);
  const supported = verifiable.filter((c) => c.supported);
  return {
    ratio: verifiable.length === 0 ? 0 : round4(supported.length / verifiable.length),
    claims,
    unsupportedClaims: verifiable.filter((c) => !c.supported),
    verifiableClaims: verifiable.length,
    supportedClaims: supported.length,
    skippedClaims: claims.length - verifiable.length,
    truncatedClaims,
    claimThreshold,
    refusal:
      verifiable.length === 0
        ? "the answer contained no claim long enough to verify — a fragment is not evidence"
        : null,
  };
}

// ---------------------------------------------------------------------------
// context precision / recall
// ---------------------------------------------------------------------------

export interface ContextPrecisionReport {
  /** used chunks / supplied chunks */
  score: number;
  usedChunks: number[];
  unusedChunks: number[];
  totalChunks: number;
  refusal: string | null;
}

/**
 * CONTEXT UTILISATION, reported as `context_precision`.
 *
 * A chunk counts as USED when it is the best supporting chunk for at least one
 * SUPPORTED claim in the answer. Precision is used/supplied.
 *
 * HONEST NAMING NOTE: Ragas's `context_precision` is rank-aware relevance of
 * retrieved chunks against a ground truth, and it needs either a labelled
 * relevance judgement or a model. This is not that. It is retrieval
 * utilisation, measured from the answer, and the registry entry says so in the
 * text an admin actually reads. It answers "how much of what you retrieved did
 * any of your answer rest on" — which is the question a person tuning a
 * retriever's `k` is really asking — and nothing more.
 */
export function scoreContextPrecision(
  answer: string,
  chunks: ReadonlyArray<string>,
  opts: ClaimSupportOptions = {},
): ContextPrecisionReport {
  if (chunks.length === 0) {
    return { score: 0, usedChunks: [], unusedChunks: [], totalChunks: 0, refusal: "no context was supplied" };
  }
  const support = scoreClaimSupport(answer, chunks, opts);
  const used = new Set<number>();
  for (const c of support.claims) {
    if (c.supported && c.bestChunk !== null) used.add(c.bestChunk);
  }
  const usedChunks = [...used].sort((a, b) => a - b);
  const unusedChunks = chunks.map((_, i) => i).filter((i) => !used.has(i));
  return {
    score: round4(usedChunks.length / chunks.length),
    usedChunks,
    unusedChunks,
    totalChunks: chunks.length,
    refusal: support.refusal,
  };
}

export interface ContextRecallReport {
  /** fraction of the REFERENCE answer's claims the supplied context supports */
  score: number;
  attributable: number;
  total: number;
  /** reference claims the context does NOT support — i.e. what the retriever
   * failed to fetch. The other half of a RAG post-mortem. */
  missing: ClaimSupport[];
  refusal: string | null;
}

/**
 * CONTEXT RECALL — of the claims in the REFERENCE answer (`expected`), how many
 * could have been derived from the supplied context?
 *
 * This is the one metric here that is measured against ground truth rather than
 * against the model's own output, which makes it a statement about the
 * RETRIEVER, not the generator. A low recall with a high claim-support ratio is
 * the diagnostic signature of "the model is faithful to context that did not
 * contain the answer" — the failure a groundedness score alone hides.
 */
export function scoreContextRecall(
  reference: string,
  chunks: ReadonlyArray<string>,
  opts: ClaimSupportOptions = {},
): ContextRecallReport {
  if (chunks.length === 0) {
    return { score: 0, attributable: 0, total: 0, missing: [], refusal: "no context was supplied" };
  }
  if (!reference.trim()) {
    return {
      score: 0,
      attributable: 0,
      total: 0,
      missing: [],
      refusal: "context_recall needs a reference answer (`expected`) — it measures the retriever against ground truth, not the model",
    };
  }
  const support = scoreClaimSupport(reference, chunks, opts);
  return {
    score: support.ratio,
    attributable: support.supportedClaims,
    total: support.verifiableClaims,
    missing: support.unsupportedClaims,
    refusal: support.refusal,
  };
}

// ---------------------------------------------------------------------------
// answer relevance
// ---------------------------------------------------------------------------

export interface AnswerRelevanceReport {
  score: number;
  /** fraction of the QUESTION's distinct content terms the answer addresses */
  questionCoverage: number;
  /** cosine of the question and answer TF-IDF vectors */
  similarity: number;
  /** question terms the answer never touches */
  unaddressedTerms: string[];
  noncommittal: boolean;
  refusal: string | null;
}

/**
 * ANSWER RELEVANCE — does this answer address the question at all?
 *
 * Two lexical signals, combined as `max(coverage, similarity)`:
 *   - COVERAGE: the fraction of the question's DISTINCT content terms that
 *     appear in the answer. Unweighted on purpose — an IDF built over a corpus
 *     of two documents assigns the LOWEST weight to exactly the terms that were
 *     covered, which would invert the metric. This is the signal that catches a
 *     fluent answer to a different question.
 *   - SIMILARITY: cosine of the two TF-IDF vectors, which rescues a short
 *     answer that is tightly on-topic without restating the question.
 * `max` rather than a blend because each is a sufficient reason to believe the
 * answer is on topic, and requiring both would punish the terse correct answer.
 *
 * A NONCOMMITTAL answer scores 0 with the reason stated — not because
 * abstention is bad, but because it is not an answer to the question, and a
 * relevance metric that scored "I don't know" as relevant would be useless.
 *
 * HONEST LIMIT: this is topical overlap, not correctness and not
 * responsiveness. An answer that restates the question and then says something
 * false scores HIGH here. Pair it with claim-support; alone it proves only that
 * the model did not change the subject.
 */
export function scoreAnswerRelevance(question: string, answer: string): AnswerRelevanceReport {
  const q = tokenize(question);
  const a = tokenize(answer);
  if (q.length === 0) {
    return {
      score: 0,
      questionCoverage: 0,
      similarity: 0,
      unaddressedTerms: [],
      noncommittal: false,
      refusal: "the case input carried no content terms to be relevant to",
    };
  }
  if (isNoncommittal(answer)) {
    return {
      score: 0,
      questionCoverage: 0,
      similarity: 0,
      unaddressedTerms: [...new Set(q)],
      noncommittal: true,
      refusal: "the answer is non-committal — it declines rather than addresses the question",
    };
  }
  const idf = buildIdf([q, a]);
  const answerSet = new Set(a);
  const uniqueQ = [...new Set(q)];
  const covered = uniqueQ.filter((t) => answerSet.has(t)).length;
  const questionCoverage = uniqueQ.length === 0 ? 0 : covered / uniqueQ.length;
  const similarity = cosine(weightedVector(q, idf), weightedVector(a, idf));
  const score = round4(clamp01(Math.max(questionCoverage, similarity)));
  return {
    score,
    questionCoverage: round4(questionCoverage),
    similarity: round4(similarity),
    unaddressedTerms: uniqueQ.filter((t) => !answerSet.has(t)).slice(0, 20),
    noncommittal: false,
    refusal: null,
  };
}

// ---------------------------------------------------------------------------
// The JUDGE-BACKED metrics — the deterministic halves only
// ---------------------------------------------------------------------------

/**
 * ADR-0067 §4 — THE HONESTY LINE.
 *
 * These two functions are the prompt builder and the verdict parser for the
 * metrics that need a model. They are here so they can be unit-tested; the
 * JUDGMENT itself is executed by the gateway through the one governed dispatch
 * core, and when no provider is configured the run REFUSES with a typed error
 * before a single row is written.
 *
 * What must never happen, and what the gateway suite asserts cannot: a
 * judge-backed metric silently falling back to `scoreClaimSupport` and
 * reporting the result under the judged metric's name. A lexical proxy is a
 * DIFFERENT MEASUREMENT and it is available under a different name
 * (`claim_support`) that states its limits. Telling a regulated buyer their
 * hallucination rate is *measured* when it was *estimated* is the specific
 * failure this whole ADR exists to prevent.
 */
export interface GroundednessJudgeRequest {
  question: string;
  answer: string;
  context: ReadonlyArray<string>;
  /** which judged metric is being asked for */
  metric: "groundedness_judge" | "answer_relevance_judge";
  instructions?: string | null | undefined;
}

export interface JudgedClaimVerdict {
  claim: string;
  supported: boolean;
  reason: string;
}

export interface GroundednessJudgeVerdict {
  score: number;
  passed: boolean;
  rationale: string;
  /** per-claim verdicts — present for groundedness_judge, empty otherwise */
  claims: JudgedClaimVerdict[];
}

export function buildGroundednessJudgePrompt(
  req: GroundednessJudgeRequest,
  threshold: number,
): string {
  const context = req.context.map((c, i) => `[${i + 1}] ${c}`).join("\n\n");
  const parts: string[] = [];
  if (req.metric === "groundedness_judge") {
    parts.push(
      "You are auditing an AI answer for GROUNDEDNESS. Decide, for each factual claim in the " +
        "answer, whether that claim is ENTAILED BY the supplied context. Judge entailment, not " +
        "plausibility and not truth in the world: a claim that is true but absent from the " +
        "context is NOT supported. Pay explicit attention to negation, to who did what to whom, " +
        "and to every number, date and name.",
      "",
      `QUESTION:\n${req.question}`,
      `CONTEXT:\n${context || "(none supplied)"}`,
      `ANSWER UNDER AUDIT:\n${req.answer}`,
    );
    if (req.instructions) parts.push(`ADDITIONAL INSTRUCTIONS:\n${req.instructions}`);
    parts.push(
      "",
      "Reply with ONLY a JSON object and nothing else:",
      `{"score": <supported claims / total claims, between 0 and 1>, "passed": <true if score >= ${threshold}>, ` +
        `"rationale": "<one or two sentences>", "claims": [{"claim": "<the claim, verbatim>", "supported": <true|false>, "reason": "<why>"}]}`,
    );
  } else {
    parts.push(
      "You are auditing an AI answer for RELEVANCE. Decide how directly the answer addresses the " +
        "question that was asked. Do not reward fluency, length, or restating the question. An " +
        "answer that declines to answer is NOT relevant, however appropriate the decline may be.",
      "",
      `QUESTION:\n${req.question}`,
      `ANSWER UNDER AUDIT:\n${req.answer}`,
    );
    if (req.instructions) parts.push(`ADDITIONAL INSTRUCTIONS:\n${req.instructions}`);
    parts.push(
      "",
      "Reply with ONLY a JSON object and nothing else:",
      `{"score": <between 0 and 1>, "passed": <true if score >= ${threshold}>, "rationale": "<one or two sentences>"}`,
    );
  }
  return parts.join("\n\n");
}

/**
 * Parse a judged-groundedness reply. Deliberately INTOLERANT: no numeric score,
 * or no parseable object, is an ERROR. An unparseable verdict must never become
 * a silent pass, and it must never fall through to a lexical estimate.
 */
export function parseGroundednessVerdict(
  text: string,
  threshold: number,
): { ok: true; verdict: GroundednessJudgeVerdict } | { ok: false; error: string } {
  let obj: Record<string, unknown> | null = null;
  for (const candidate of [fencedBlockBody(text, true)?.trim(), text.trim(), firstBraceBlock(text)]) {
    if (!candidate || obj) continue;
    try {
      const v = JSON.parse(candidate) as unknown;
      if (v !== null && typeof v === "object" && !Array.isArray(v)) obj = v as Record<string, unknown>;
    } catch {
      /* try the next candidate */
    }
  }
  if (!obj) return { ok: false, error: "judge reply is not a JSON object" };
  const raw = obj.score;
  const score = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(score)) return { ok: false, error: "judge reply has no numeric score" };
  const clamped = round4(clamp01(score));
  const claims: JudgedClaimVerdict[] = Array.isArray(obj.claims)
    ? (obj.claims as unknown[])
        .filter((c): c is Record<string, unknown> => c !== null && typeof c === "object")
        .slice(0, CLAIM_DETAIL_MAX)
        .map((c) => ({
          claim: String(c.claim ?? "").slice(0, CLAIM_SNIPPET_MAX),
          supported: c.supported === true,
          reason: String(c.reason ?? "").slice(0, CLAIM_SNIPPET_MAX),
        }))
    : [];
  return {
    ok: true,
    verdict: {
      score: clamped,
      passed: typeof obj.passed === "boolean" ? obj.passed && clamped >= threshold : clamped >= threshold,
      rationale: typeof obj.rationale === "string" ? obj.rationale : "",
      claims,
    },
  };
}
