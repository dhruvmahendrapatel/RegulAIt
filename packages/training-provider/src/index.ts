/**
 * @regulait/training-provider — ADR-0065, the PURE half of RegulAIt-LLM.
 *
 * This package is to TRAINING what `@regulait/model-provider` is to INFERENCE:
 * a neutral interface, a registry that refuses to pretend, real adapters behind
 * a credential, an in-memory mock for tests — and, unlike model-provider, one
 * backend that genuinely does the work in this process.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * THE HONEST SENTENCE, WHICH THE REST OF THIS FILE IS BUILT AROUND
 * ══════════════════════════════════════════════════════════════════════════
 *
 * Fine-tuning a transformer needs GPUs and a training runtime. This is a
 * Node/Fastify process. It has neither. So there is NO code path here that
 * claims to have fine-tuned an LLM, and there is deliberately no "Train" button
 * that sleeps and reports success — that is the exact overclaiming ADR-0042's
 * `tier: 'heuristic'` labelling and ADR-0044's "mechanism-proven,
 * judgment-unverified" language exist in this codebase to prevent.
 *
 * What the `local` backend does instead is REAL, small-scale, and honestly
 * named:
 *
 *   `retrieval_index`   builds a genuine TF-IDF inverted index over the
 *                       uploaded rows, L2-normalised, with real IDF weighting.
 *                       The artifact is queryable: ask it a question and it
 *                       returns the answer from the corpus row whose input is
 *                       closest in cosine similarity. This is RAG-style
 *                       "training" — no weights are updated anywhere, and the
 *                       method id says exactly that.
 *   `text_classifier`   trains a multinomial logistic-regression classifier by
 *                       ACTUAL gradient descent over a bag-of-words feature
 *                       space: real epochs, a real cross-entropy loss that
 *                       really goes down, real L2 regularisation, and a real
 *                       held-out evaluation split. The learned weights are the
 *                       artifact and can be inspected.
 *
 * Both run to completion, both produce an artifact this deployment can actually
 * answer questions with, and neither is described as a fine-tuned LLM anywhere.
 *
 * The four REAL remote adapters (`huggingface`, `together`, `bedrock`,
 * `vertex`) carry the documented request/response shape and the poll loop, are
 * marked `requiresCredential: true`, and REFUSE with a typed
 * `TrainingBackendError('credential_required')` when nothing is configured —
 * the same posture `apps/gateway/src/custom-providers.ts` takes for BYO
 * endpoints. Their HTTP goes through an injected `fetchImpl`, which the gateway
 * supplies as the ADR-0034/0062 egress-guarded fetch.
 *
 * WHAT IS UNVERIFIED, STATED HERE RATHER THAN IN AN ADR NOBODY OPENS: no remote
 * training service is reachable from this environment. The four adapters'
 * URL/payload construction and status mapping are unit-tested against recorded
 * shapes; they have never spoken to the live service. Their plumbing is proven;
 * their compatibility is not.
 */

import type { ModelDispatchRequest, ModelDispatchResult, ModelProvider } from "@regulait/model-provider";

// ---------------------------------------------------------------------------
// Vocabularies
// ---------------------------------------------------------------------------

/**
 * What a training run actually DID.
 *
 * The split down the middle of this list is the whole point of it: the first
 * two are producible in-process and their artifacts are queryable here; the
 * last three are LLM fine-tuning and are reachable ONLY on a credentialed
 * remote backend. A reader can tell which they are looking at from the method
 * id alone, without trusting a label a human typed into a name field.
 */
export const TRAINING_METHODS = [
  "retrieval_index",
  "text_classifier",
  "lora_sft",
  "full_sft",
  "dpo",
] as const;
export type TrainingMethod = (typeof TRAINING_METHODS)[number];

/** methods this process can genuinely execute, with no GPU and no runtime */
export const IN_PROCESS_METHODS: readonly TrainingMethod[] = ["retrieval_index", "text_classifier"];

export function isInProcessMethod(m: TrainingMethod): boolean {
  return IN_PROCESS_METHODS.includes(m);
}

export const TRAINING_BACKEND_KINDS = [
  "local",
  "mock",
  "huggingface",
  "together",
  "bedrock",
  "vertex",
] as const;
export type TrainingBackendKind = (typeof TRAINING_BACKEND_KINDS)[number];

export function isTrainingBackendKind(v: string): v is TrainingBackendKind {
  return (TRAINING_BACKEND_KINDS as readonly string[]).includes(v);
}

export const TRAINING_DATASET_FORMATS = ["prompt_completion", "classification", "documents"] as const;
export type TrainingDatasetFormat = (typeof TRAINING_DATASET_FORMATS)[number];

/**
 * Every way this package refuses, as a CODE rather than a message.
 *
 * `credential_required` is the load-bearing one: it is what a real adapter
 * raises instead of faking a job, and the gateway turns it into a 409 with an
 * audit row. A backend that silently succeeded without a credential would be
 * indistinguishable from one that had trained something.
 */
export type TrainingErrorCode =
  | "credential_required"
  | "backend_disabled"
  | "method_unsupported"
  | "dataset_unusable"
  | "hyperparameters_invalid"
  | "unknown_job"
  | "cancel_unsupported"
  | "upstream_error"
  | "artifact_unavailable";

export class TrainingBackendError extends Error {
  constructor(
    message: string,
    readonly code: TrainingErrorCode,
    /** the HTTP status the gateway should surface. 409 = "your configuration
     * says this cannot happen", 502 = "the upstream said no". */
    readonly status: number = 409,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "TrainingBackendError";
  }
}

// ---------------------------------------------------------------------------
// The data
// ---------------------------------------------------------------------------

export interface TrainingRow {
  input: string;
  /** the completion / the label. NULL only for the `documents` format, where
   * there is nothing to predict and the corpus is retrieval material. */
  output: string | null;
  tags?: string[];
}

export interface DatasetValidation {
  ok: boolean;
  rowCount: number;
  charCount: number;
  /** sha-free, dependency-free content digest — see `datasetChecksum` */
  checksum: string;
  /** FATAL. A dataset with any of these cannot train. */
  errors: string[];
  /** non-fatal, but shown: "3 duplicate inputs", "one label has 1 example" */
  warnings: string[];
  /** distinct outputs, for `classification` — the classes the model will learn */
  labels: string[];
  split: DatasetSplit;
}

export interface DatasetSplit {
  trainIdx: number[];
  evalIdx: number[];
}

// ---------------------------------------------------------------------------
// The backend interface
// ---------------------------------------------------------------------------

export interface TrainingBackendCapabilities {
  kind: TrainingBackendKind;
  /** true = nothing at all happens until an admin configures a credential (and,
   * for the real vendors, actual compute). The gateway renders this next to the
   * choice so nobody picks a backend that will refuse them. */
  requiresCredential: boolean;
  /** true = the training runs INSIDE this process, so the artifact is queryable
   * here. This is what separates `local`/`mock` from the four remote adapters. */
  inProcess: boolean;
  methods: TrainingMethod[];
  /** base models this backend accepts. `null` = any string (the vendor decides);
   * `[]` = the concept does not apply (a retrieval index has no base model). */
  baseModels: string[] | null;
  producesQueryableArtifact: boolean;
  supportsCancel: boolean;
  supportsPoll: boolean;
  summary: string;
  /**
   * THE HONEST LIMITS STRING. Rendered verbatim beside the backend in the admin
   * screen, the same discipline `guardrailRegistry()` and `evalScorerRegistry()`
   * already use: a person choosing a backend reads what it cannot do at the
   * moment they decide, not in an ADR they will never open.
   */
  limits: string;
}

export interface StartJobRequest {
  jobId: string;
  name: string;
  method: TrainingMethod;
  /** null for a retrieval index, which derives from no model at all */
  baseModel: string | null;
  hyperparameters: Record<string, unknown>;
  rows: TrainingRow[];
  format: TrainingDatasetFormat;
}

export interface TrainingJobHandle {
  backend: TrainingBackendKind;
  jobId: string;
  /** the BACKEND's own id for the run, when it has one. null for `local`, whose
   * job never leaves this process. */
  externalJobId: string | null;
}

export interface TrainingJobStatusReport {
  status: "running" | "succeeded" | "failed" | "cancelled";
  /** 0..1 */
  progress: number;
  error?: string | null;
  /** whatever the backend MEASURED, when it reports anything */
  metrics?: Record<string, unknown>;
}

export interface TrainingArtifactPayload {
  kind: "inline" | "remote";
  method: TrainingMethod;
  /** present iff kind === 'inline' — the real, queryable model */
  payload?: Record<string, unknown>;
  /** present iff kind === 'remote' — where it lives on the backend */
  location?: string;
  metrics: Record<string, unknown>;
}

export interface TrainingBackend {
  readonly capabilities: TrainingBackendCapabilities;
  /** PURE. No I/O, no clock — every backend delegates to the shared
   * `validateTrainingDataset` so "is this corpus usable" cannot answer
   * differently depending on where the training will happen. */
  validateDataset(rows: TrainingRow[], opts: { format: TrainingDatasetFormat; method: TrainingMethod; evalFraction?: number }): DatasetValidation;
  startJob(req: StartJobRequest): Promise<TrainingJobHandle>;
  pollJob(handle: TrainingJobHandle): Promise<TrainingJobStatusReport>;
  cancelJob(handle: TrainingJobHandle): Promise<void>;
  fetchArtifact(handle: TrainingJobHandle): Promise<TrainingArtifactPayload>;
}

// ---------------------------------------------------------------------------
// Pure: tokenisation
// ---------------------------------------------------------------------------

/** A deliberately small stop list. Big enough to stop "the" dominating every
 * TF-IDF vector, small enough that it cannot silently delete a domain term. */
const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "how", "in", "is", "it", "of",
  "on", "or", "that", "the", "this", "to", "was", "what", "when", "where", "which", "who", "will",
  "with", "you", "your", "do", "does", "did", "i", "we", "our",
]);

/**
 * Lowercase, split on non-alphanumerics, drop single characters and stopwords.
 *
 * Deliberately boring and deliberately shared: the index build and the query
 * MUST tokenise identically or a retrieval index silently returns nothing, and
 * the failure mode ("it answers, just always wrongly") is the kind that
 * survives a demo.
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

/** FNV-1a, 32-bit. A dependency-free content digest — this is a CHANGE
 * DETECTOR for dataset versions, not a security primitive, and it is labelled
 * `fnv1a32:` so nobody mistakes it for a cryptographic hash. */
export function fnv1a32(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** The canonical digest of a corpus VERSION. Order-sensitive on purpose: two
 * datasets with the same rows in a different order are different training
 * inputs for a method that consumes them in order. */
export function datasetChecksum(rows: TrainingRow[]): string {
  const canon = rows.map((r) => `${r.input} ${r.output ?? ""}`).join("");
  return `fnv1a32:${fnv1a32(canon)}:${rows.length}`;
}

// ---------------------------------------------------------------------------
// Pure: validation, splitting, hyperparameters, cost
// ---------------------------------------------------------------------------

export const MAX_TRAINING_ROWS = 20_000;
export const MAX_ROW_CHARS = 50_000;

/**
 * Deterministic train/eval split.
 *
 * Deterministic, not random, and the reason matters: a job records exactly the
 * dataset version it trained on (ADR-0044's discipline, reused), so re-running
 * the same version must produce the same split — otherwise "the eval accuracy
 * dropped" could mean nothing but a different coin toss. The bucket is derived
 * from the row index through the same FNV mix used everywhere else here.
 */
export function splitDataset(rowCount: number, evalFraction = 0.2): DatasetSplit {
  const trainIdx: number[] = [];
  const evalIdx: number[] = [];
  if (rowCount === 0) return { trainIdx, evalIdx };
  const frac = Math.min(0.5, Math.max(0, evalFraction));
  for (let i = 0; i < rowCount; i++) {
    // 0..1 from a stable hash of the index, so membership never moves
    const bucket = (parseInt(fnv1a32(`split:${i}`), 16) % 1000) / 1000;
    if (bucket < frac) evalIdx.push(i);
    else trainIdx.push(i);
  }
  // A split that leaves nothing to train on is not a split, it is a mistake.
  // Fall back to "everything trains, nothing is held out" and let the caller's
  // warnings say so rather than silently training on an empty set.
  if (trainIdx.length === 0) return { trainIdx: Array.from({ length: rowCount }, (_, i) => i), evalIdx: [] };
  return { trainIdx, evalIdx };
}

/**
 * Is this corpus usable, and what will it produce?
 *
 * Shared by every backend so that "usable" cannot mean two different things
 * depending on where the training was going to happen. Errors are FATAL and the
 * gateway turns them into a 422; warnings are surfaced and the job proceeds.
 */
export function validateTrainingDataset(
  rows: TrainingRow[],
  opts: { format: TrainingDatasetFormat; method: TrainingMethod; evalFraction?: number },
): DatasetValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  let charCount = 0;
  const seen = new Map<string, number>();
  const labelCounts = new Map<string, number>();

  if (rows.length === 0) errors.push("the dataset has no rows — there is nothing to train on");
  if (rows.length > MAX_TRAINING_ROWS) {
    errors.push(`${rows.length} rows exceeds the in-process ceiling of ${MAX_TRAINING_ROWS}`);
  }

  rows.forEach((r, i) => {
    const input = r.input ?? "";
    if (input.trim().length === 0) errors.push(`row ${i}: input is empty`);
    if (input.length > MAX_ROW_CHARS) errors.push(`row ${i}: input exceeds ${MAX_ROW_CHARS} characters`);
    charCount += input.length + (r.output?.length ?? 0);
    seen.set(input, (seen.get(input) ?? 0) + 1);
    if (opts.format !== "documents") {
      const out = (r.output ?? "").trim();
      if (out.length === 0) {
        errors.push(`row ${i}: output is required for the '${opts.format}' format`);
      } else if (opts.format === "classification") {
        labelCounts.set(out, (labelCounts.get(out) ?? 0) + 1);
      }
    }
  });

  const dupes = [...seen.values()].filter((n) => n > 1).length;
  if (dupes > 0) {
    warnings.push(
      `${dupes} input(s) appear more than once — duplicates skew a retrieval index toward whatever is repeated`,
    );
  }

  const labels = [...labelCounts.keys()].sort();
  if (opts.method === "text_classifier") {
    if (opts.format !== "classification") {
      errors.push(
        "method 'text_classifier' needs the 'classification' format — each row's output is the class label",
      );
    }
    if (labels.length < 2) {
      errors.push(
        `a classifier needs at least two distinct labels; this corpus has ${labels.length}. ` +
          "A one-class classifier is a constant function, not a model.",
      );
    }
    for (const [label, n] of labelCounts) {
      if (n < 2) warnings.push(`label '${label}' has only ${n} example — it will barely be learned`);
    }
  }
  if (opts.method === "retrieval_index" && opts.format === "classification") {
    warnings.push(
      "a retrieval index over a classification corpus returns the nearest row's LABEL, which works but " +
        "is a nearest-neighbour classifier, not a trained one — 'text_classifier' is the honest choice",
    );
  }

  return {
    ok: errors.length === 0,
    rowCount: rows.length,
    charCount,
    checksum: datasetChecksum(rows),
    errors,
    warnings,
    labels,
    split: splitDataset(rows.length, opts.evalFraction ?? 0.2),
  };
}

export interface NormalizedHyperparameters {
  epochs: number;
  learningRate: number;
  l2: number;
  /** retrieval only: how many neighbours a query considers */
  topK: number;
  evalFraction: number;
  /** cap on the learned vocabulary — the classifier's only capacity dial */
  maxVocabulary: number;
  /** remote fine-tuning only; carried through verbatim to the vendor payload */
  batchSize: number;
  loraRank: number;
}

export const HYPERPARAMETER_DEFAULTS: NormalizedHyperparameters = {
  epochs: 12,
  learningRate: 0.5,
  l2: 1e-4,
  topK: 3,
  evalFraction: 0.2,
  maxVocabulary: 4000,
  batchSize: 8,
  loraRank: 8,
};

interface Bound {
  min: number;
  max: number;
  integer?: boolean;
}
const BOUNDS: Record<keyof NormalizedHyperparameters, Bound> = {
  epochs: { min: 1, max: 200, integer: true },
  learningRate: { min: 1e-4, max: 10 },
  l2: { min: 0, max: 1 },
  topK: { min: 1, max: 25, integer: true },
  evalFraction: { min: 0, max: 0.5 },
  maxVocabulary: { min: 50, max: 50_000, integer: true },
  batchSize: { min: 1, max: 1024, integer: true },
  loraRank: { min: 1, max: 256, integer: true },
};

/**
 * Which dials a METHOD actually reads.
 *
 * This table is what makes a no-op impossible rather than merely discouraged:
 * a retrieval index updates no weights, so `epochs` on one is not a harmless
 * extra — it is a number a person chose that nothing will ever read, and
 * accepting it silently is how somebody comes to believe they tuned something.
 */
export const METHOD_HYPERPARAMETERS: Record<TrainingMethod, Array<keyof NormalizedHyperparameters>> = {
  retrieval_index: ["topK", "evalFraction"],
  text_classifier: ["epochs", "learningRate", "l2", "evalFraction", "maxVocabulary"],
  lora_sft: ["epochs", "learningRate", "batchSize", "loraRank", "evalFraction"],
  full_sft: ["epochs", "learningRate", "batchSize", "evalFraction"],
  dpo: ["epochs", "learningRate", "batchSize", "evalFraction"],
};

/**
 * Validate and normalise hyperparameters against the METHOD.
 *
 * Refusing here rather than at training time is the same argument
 * `validateScorerConfig` makes in ADR-0044: it is far cheaper to reject a
 * configuration that cannot discriminate now than to explain the resulting
 * meaningless number later. An unknown key is an ERROR, not a shrug — a typo'd
 * `learning_rate` that is silently ignored produces a model trained at a rate
 * nobody chose — and so is a key this METHOD would never read.
 *
 * `applied` is the subset the method actually consumes, defaults filled in. It
 * is what gets STORED on the job, which means feeding a stored job back through
 * this validator is a fixed point: a re-run, a resumed poll and an approved
 * start all re-validate to exactly the same thing rather than tripping over a
 * dial the first pass helpfully added.
 */
export function validateHyperparameters(
  method: TrainingMethod,
  raw: Record<string, unknown>,
):
  | { ok: true; value: NormalizedHyperparameters; applied: Record<string, number> }
  | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const value: NormalizedHyperparameters = { ...HYPERPARAMETER_DEFAULTS };
  const relevant = METHOD_HYPERPARAMETERS[method];
  for (const [k, v] of Object.entries(raw ?? {})) {
    if (!(k in BOUNDS)) {
      errors.push(`unknown hyperparameter '${k}' — a silently ignored typo trains a model nobody chose`);
      continue;
    }
    const key = k as keyof NormalizedHyperparameters;
    if (!relevant.includes(key)) {
      errors.push(
        `hyperparameter '${k}' does nothing for method '${method}' — it would be accepted and then never ` +
          `read, which is exactly the silent no-op this validator exists to refuse. ` +
          `'${method}' reads: ${relevant.join(", ")}`,
      );
      continue;
    }
    if (typeof v !== "number" || !Number.isFinite(v)) {
      errors.push(`hyperparameter '${k}' must be a finite number`);
      continue;
    }
    const b = BOUNDS[key];
    if (v < b.min || v > b.max) {
      errors.push(`hyperparameter '${k}' must be between ${b.min} and ${b.max} (got ${v})`);
      continue;
    }
    if (b.integer && !Number.isInteger(v)) {
      errors.push(`hyperparameter '${k}' must be an integer`);
      continue;
    }
    value[key] = v;
  }
  if (errors.length > 0) return { ok: false, errors };
  const applied: Record<string, number> = {};
  for (const key of relevant) applied[key] = value[key];
  return { ok: true, value, applied };
}

/**
 * The pre-flight cost estimate the approval gate compares against.
 *
 * IN-PROCESS METHODS COST ZERO DOLLARS AND SAY SO. There is no cloud bill for
 * arithmetic this process does itself; charging a made-up number for it would
 * put fiction into the one ledger pillar 5 asks people to trust. Remote methods
 * are estimated from the vendor's published per-million-token training rate,
 * characters→tokens at the same 4:1 ratio used elsewhere in this codebase, and
 * the estimate is labelled an ESTIMATE everywhere it is shown.
 */
export function estimateTrainingCostUsd(input: {
  method: TrainingMethod;
  backend: TrainingBackendKind;
  charCount: number;
  epochs: number;
  /** vendor list price per MILLION training tokens. null = unknown, and an
   * unknown price yields null rather than a guess. */
  pricePerMTokUsd?: number | null;
}): number | null {
  if (input.backend === "local" || input.backend === "mock" || isInProcessMethod(input.method)) {
    return 0;
  }
  const price = input.pricePerMTokUsd ?? null;
  if (price == null) return null;
  const tokens = Math.ceil(input.charCount / 4);
  const passes = Math.max(1, input.epochs);
  // LoRA touches a small fraction of the parameters; the multiplier is the
  // vendor-agnostic rule of thumb and is stated as such, not measured here.
  const multiplier = input.method === "lora_sft" ? 0.35 : input.method === "dpo" ? 0.6 : 1;
  return Number((((tokens * passes) / 1_000_000) * price * multiplier).toFixed(6));
}

// ---------------------------------------------------------------------------
// Pure: the TF-IDF retrieval index — a REAL one
// ---------------------------------------------------------------------------

export interface RetrievalIndex extends Record<string, unknown> {
  kind: "tfidf_index_v1";
  /** term → inverse document frequency */
  idf: Record<string, number>;
  docs: Array<{
    idx: number;
    /** L2-normalised sparse TF-IDF vector */
    vector: Record<string, number>;
    /** the row's input, kept so a match can be shown */
    input: string;
    /** the row's output — THE ANSWER this index returns */
    output: string | null;
  }>;
  topK: number;
  builtRows: number;
  vocabularySize: number;
}

/**
 * Build a genuine TF-IDF index. Nothing here is simulated: term frequencies are
 * counted, IDF is `ln((N+1)/(df+1)) + 1` (the smoothed form, so a term present
 * in every document still carries a small positive weight rather than
 * annihilating the vector), and every document vector is L2-normalised so a
 * later cosine similarity is a plain dot product.
 */
export function buildRetrievalIndex(rows: TrainingRow[], opts: { topK?: number } = {}): RetrievalIndex {
  const tokenised = rows.map((r) => tokenize(r.input));
  const df = new Map<string, number>();
  for (const toks of tokenised) {
    for (const t of new Set(toks)) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const n = rows.length;
  const idf: Record<string, number> = {};
  for (const [term, d] of df) idf[term] = Math.log((n + 1) / (d + 1)) + 1;

  const docs: RetrievalIndex["docs"] = [];
  tokenised.forEach((toks, i) => {
    const vector = weightedVector(toks, idf);
    docs.push({
      idx: i,
      vector,
      input: rows[i]!.input,
      output: rows[i]!.output ?? null,
    });
  });

  return {
    kind: "tfidf_index_v1",
    idf,
    docs,
    topK: opts.topK ?? HYPERPARAMETER_DEFAULTS.topK,
    builtRows: n,
    vocabularySize: Object.keys(idf).length,
  };
}

/** term-frequency × idf, then L2-normalised. Shared by build and query so the
 * two cannot disagree about what a vector is. */
function weightedVector(tokens: string[], idf: Record<string, number>): Record<string, number> {
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

export interface RetrievalMatch {
  idx: number;
  score: number;
  input: string;
  output: string | null;
}

export interface RetrievalAnswer {
  /** the best match's output (or its input, for a `documents` corpus) */
  answer: string | null;
  score: number;
  matches: RetrievalMatch[];
  /** true when NOTHING in the corpus shared a single term with the query. The
   * honest answer is "I do not have this", not the least-bad row. */
  miss: boolean;
}

export function queryRetrievalIndex(
  index: RetrievalIndex,
  query: string,
  opts: { topK?: number } = {},
): RetrievalAnswer {
  const qv = weightedVector(tokenize(query), index.idf);
  const k = opts.topK ?? index.topK ?? 3;
  const scored: RetrievalMatch[] = [];
  for (const doc of index.docs) {
    let dot = 0;
    for (const [term, w] of Object.entries(qv)) {
      const dw = doc.vector[term];
      if (dw !== undefined) dot += w * dw;
    }
    if (dot > 0) scored.push({ idx: doc.idx, score: Number(dot.toFixed(6)), input: doc.input, output: doc.output });
  }
  scored.sort((a, b) => b.score - a.score || a.idx - b.idx);
  const matches = scored.slice(0, k);
  const best = matches[0];
  if (!best) return { answer: null, score: 0, matches: [], miss: true };
  return { answer: best.output ?? best.input, score: best.score, matches, miss: false };
}

// ---------------------------------------------------------------------------
// Pure: the logistic-regression classifier — REAL gradient descent
// ---------------------------------------------------------------------------

export interface ClassifierModel extends Record<string, unknown> {
  kind: "logreg_bow_v1";
  labels: string[];
  vocabulary: string[];
  /** labels × (vocabulary + 1). The trailing element of each row is the bias. */
  weights: number[][];
  epochs: number;
  learningRate: number;
  l2: number;
  /** cross-entropy after each epoch — a REAL loss curve, and the thing that
   * makes "did this actually train?" checkable rather than asserted */
  lossCurve: number[];
}

function featurise(tokens: string[], vocabIndex: Map<string, number>, dim: number): Float64Array {
  const x = new Float64Array(dim + 1);
  let total = 0;
  for (const t of tokens) {
    const i = vocabIndex.get(t);
    if (i === undefined) continue;
    x[i] = (x[i] ?? 0) + 1;
    total++;
  }
  if (total > 0) {
    for (let i = 0; i < dim; i++) if (x[i]) x[i] = x[i]! / total;
  }
  x[dim] = 1; // bias
  return x;
}

function softmax(scores: number[]): number[] {
  const max = Math.max(...scores);
  const exps = scores.map((s) => Math.exp(s - max));
  const sum = exps.reduce((a, b) => a + b, 0) || 1;
  return exps.map((e) => e / sum);
}

/**
 * Train a multinomial logistic-regression classifier by real gradient descent.
 *
 * Full-batch, cross-entropy, L2-regularised, deterministic. Full-batch rather
 * than stochastic on purpose: SGD needs a shuffle, a shuffle needs a seed, and
 * a seeded shuffle is one more thing that can silently differ between two runs
 * on the same dataset version. The corpora this is for are small enough that
 * full batch is both faster and reproducible.
 *
 * `lossCurve` is returned because it is the evidence: a caller can see the loss
 * actually descending rather than take "trained: true" on faith.
 */
export function trainTextClassifier(
  rows: TrainingRow[],
  opts: {
    trainIdx: number[];
    hyperparameters: Pick<NormalizedHyperparameters, "epochs" | "learningRate" | "l2" | "maxVocabulary">;
  },
): ClassifierModel {
  const { epochs, learningRate, l2, maxVocabulary } = opts.hyperparameters;
  const train = opts.trainIdx.map((i) => rows[i]!).filter((r) => (r.output ?? "").trim().length > 0);
  const labels = [...new Set(train.map((r) => r.output!.trim()))].sort();
  const labelIndex = new Map(labels.map((l, i) => [l, i]));

  // vocabulary: the most frequent terms, capped. Sorted by (count desc, term
  // asc) so the cap is deterministic even when counts tie.
  const counts = new Map<string, number>();
  const docTokens = train.map((r) => tokenize(r.input));
  for (const toks of docTokens) for (const t of toks) counts.set(t, (counts.get(t) ?? 0) + 1);
  const vocabulary = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, maxVocabulary)
    .map(([t]) => t);
  const vocabIndex = new Map(vocabulary.map((t, i) => [t, i]));
  const dim = vocabulary.length;

  const X = docTokens.map((toks) => featurise(toks, vocabIndex, dim));
  const y = train.map((r) => labelIndex.get(r.output!.trim())!);

  const weights: number[][] = labels.map(() => new Array<number>(dim + 1).fill(0));
  const lossCurve: number[] = [];
  const nSamples = X.length || 1;

  for (let epoch = 0; epoch < epochs; epoch++) {
    const grads = labels.map(() => new Float64Array(dim + 1));
    let loss = 0;
    for (let s = 0; s < X.length; s++) {
      const x = X[s]!;
      const scores = weights.map((w) => {
        let z = 0;
        for (let j = 0; j <= dim; j++) {
          const xv = x[j]!;
          if (xv !== 0) z += w[j]! * xv;
        }
        return z;
      });
      const probs = softmax(scores);
      const target = y[s]!;
      loss -= Math.log(Math.max(probs[target]!, 1e-12));
      for (let c = 0; c < labels.length; c++) {
        const err = probs[c]! - (c === target ? 1 : 0);
        if (err === 0) continue;
        const g = grads[c]!;
        for (let j = 0; j <= dim; j++) {
          const xv = x[j]!;
          if (xv !== 0) g[j] = g[j]! + err * xv;
        }
      }
    }
    for (let c = 0; c < labels.length; c++) {
      const w = weights[c]!;
      const g = grads[c]!;
      for (let j = 0; j <= dim; j++) {
        // L2 on the weights, never on the bias — regularising the bias pulls
        // every prediction toward uniform for no principled reason
        const reg = j < dim ? l2 * w[j]! : 0;
        w[j] = w[j]! - learningRate * (g[j]! / nSamples + reg);
      }
    }
    lossCurve.push(Number((loss / nSamples).toFixed(6)));
  }

  return {
    kind: "logreg_bow_v1",
    labels,
    vocabulary,
    weights,
    epochs,
    learningRate,
    l2,
    lossCurve,
  };
}

export interface ClassificationAnswer {
  label: string | null;
  score: number;
  scores: Array<{ label: string; probability: number }>;
}

export function classifyText(model: ClassifierModel, text: string): ClassificationAnswer {
  const dim = model.vocabulary.length;
  const vocabIndex = new Map(model.vocabulary.map((t, i) => [t, i]));
  const x = featurise(tokenize(text), vocabIndex, dim);
  const raw = model.weights.map((w) => {
    let z = 0;
    for (let j = 0; j <= dim; j++) {
      const xv = x[j]!;
      if (xv !== 0) z += (w[j] ?? 0) * xv;
    }
    return z;
  });
  const probs = softmax(raw);
  const scores = model.labels.map((label, i) => ({ label, probability: Number(probs[i]!.toFixed(6)) }));
  let bestI = 0;
  for (let i = 1; i < probs.length; i++) if (probs[i]! > probs[bestI]!) bestI = i;
  const label = model.labels[bestI] ?? null;
  return { label, score: Number((probs[bestI] ?? 0).toFixed(6)), scores };
}

/** train/eval accuracy, MEASURED — the only two numbers reported as metrics
 * for a classifier, and both computed from real predictions. */
export function scoreClassifier(
  model: ClassifierModel,
  rows: TrainingRow[],
  idx: number[],
): { accuracy: number; correct: number; total: number } {
  let correct = 0;
  let total = 0;
  for (const i of idx) {
    const row = rows[i];
    const expected = (row?.output ?? "").trim();
    if (!row || expected.length === 0) continue;
    total++;
    if (classifyText(model, row.input).label === expected) correct++;
  }
  return { accuracy: total === 0 ? 0 : Number((correct / total).toFixed(6)), correct, total };
}

// ---------------------------------------------------------------------------
// Pure: querying whatever artifact came out
// ---------------------------------------------------------------------------

export interface ArtifactQueryResult {
  method: TrainingMethod;
  answer: string | null;
  score: number;
  /** the supporting evidence: the matched corpus rows, or the class posterior */
  detail: Record<string, unknown>;
}

/**
 * THE ONE PLACE AN ARTIFACT IS QUERIED. Both the `POST /artifacts/:id/query`
 * endpoint and the inference path that serves a registered artifact as an agent
 * come through here, so a model cannot answer one way through the admin screen
 * and another way through a dispatch.
 */
export function queryArtifact(
  payload: Record<string, unknown>,
  query: string,
  opts: { topK?: number } = {},
): ArtifactQueryResult {
  const kind = payload["kind"];
  if (kind === "tfidf_index_v1") {
    const index = payload as unknown as RetrievalIndex;
    const r = queryRetrievalIndex(index, query, opts);
    return {
      method: "retrieval_index",
      answer: r.answer,
      score: r.score,
      detail: {
        miss: r.miss,
        matches: r.matches.map((m) => ({ idx: m.idx, score: m.score, input: m.input })),
      },
    };
  }
  if (kind === "logreg_bow_v1") {
    const model = payload as unknown as ClassifierModel;
    const r = classifyText(model, query);
    return {
      method: "text_classifier",
      answer: r.label,
      score: r.score,
      detail: { scores: r.scores, vocabularySize: model.vocabulary.length },
    };
  }
  throw new TrainingBackendError(
    `artifact payload kind '${String(kind)}' cannot be queried by this deployment`,
    "artifact_unavailable",
    409,
  );
}

// ---------------------------------------------------------------------------
// The LOCAL backend — the one that genuinely runs
// ---------------------------------------------------------------------------

interface LocalJobState {
  status: TrainingJobStatusReport["status"];
  progress: number;
  error: string | null;
  artifact: TrainingArtifactPayload | null;
}

export const LOCAL_CAPABILITIES: TrainingBackendCapabilities = {
  kind: "local",
  requiresCredential: false,
  inProcess: true,
  methods: ["retrieval_index", "text_classifier"],
  baseModels: [],
  producesQueryableArtifact: true,
  supportsCancel: true,
  supportsPoll: true,
  summary:
    "Runs entirely inside this gateway process. Builds a real TF-IDF retrieval index over your rows, " +
    "or trains a real multinomial logistic-regression classifier by gradient descent. The artifact is " +
    "queryable here and can be registered as an agent the platform dispatches to.",
  limits:
    "IT DOES NOT FINE-TUNE A LANGUAGE MODEL, and never claims to. There is no GPU and no training " +
    "runtime in a Node process, so no transformer weights are updated by anything here. A retrieval " +
    "index updates no weights at all — it answers with the closest row from your own corpus, which is " +
    "RAG-style customisation, not learning. The classifier is a bag-of-words linear model: it has no " +
    "word order, no semantics beyond term overlap, and will be beaten by any real language model on " +
    "any task where phrasing matters. Both are useful, small, inspectable and honest; neither is a " +
    "custom LLM.",
};

export class LocalTrainingBackend implements TrainingBackend {
  readonly capabilities = LOCAL_CAPABILITIES;
  private readonly jobs = new Map<string, LocalJobState>();

  validateDataset(
    rows: TrainingRow[],
    opts: { format: TrainingDatasetFormat; method: TrainingMethod; evalFraction?: number },
  ): DatasetValidation {
    return validateTrainingDataset(rows, opts);
  }

  /**
   * THE TRAINING ACTUALLY HAPPENS HERE, SYNCHRONOUSLY.
   *
   * There is no queue, no worker and no sleep: by the time this resolves, the
   * index is built or the classifier's loss curve has descended, and the
   * artifact exists. A caller that polls sees `succeeded` immediately, which is
   * the truth — a `running` state this backend never occupies would be theatre.
   */
  async startJob(req: StartJobRequest): Promise<TrainingJobHandle> {
    if (!this.capabilities.methods.includes(req.method)) {
      throw new TrainingBackendError(
        `the local backend cannot perform '${req.method}'. It supports ${this.capabilities.methods.join(", ")} — ` +
          "everything else needs a GPU and a training runtime this process does not have.",
        "method_unsupported",
        409,
      );
    }
    const hp = validateHyperparameters(req.method, req.hyperparameters);
    if (!hp.ok) {
      throw new TrainingBackendError(hp.errors.join("; "), "hyperparameters_invalid", 422);
    }
    const validation = validateTrainingDataset(req.rows, {
      format: req.format,
      method: req.method,
      evalFraction: hp.value.evalFraction,
    });
    if (!validation.ok) {
      throw new TrainingBackendError(validation.errors.join("; "), "dataset_unusable", 422);
    }

    const started = Date.now();
    try {
      const artifact =
        req.method === "retrieval_index"
          ? this.buildIndex(req, hp.value, validation)
          : this.trainClassifier(req, hp.value, validation);
      artifact.metrics["durationMs"] = Date.now() - started;
      artifact.metrics["warnings"] = validation.warnings;
      this.jobs.set(req.jobId, { status: "succeeded", progress: 1, error: null, artifact });
    } catch (err) {
      this.jobs.set(req.jobId, {
        status: "failed",
        progress: 0,
        error: err instanceof Error ? err.message : String(err),
        artifact: null,
      });
    }
    return { backend: "local", jobId: req.jobId, externalJobId: null };
  }

  private buildIndex(
    req: StartJobRequest,
    hp: NormalizedHyperparameters,
    validation: DatasetValidation,
  ): TrainingArtifactPayload {
    const index = buildRetrievalIndex(req.rows, { topK: hp.topK });
    // MEASURED, not asserted: how many held-out rows retrieve THEMSELVES as the
    // nearest neighbour. It is a sanity check on the index, and it is labelled
    // as such rather than dressed up as accuracy on a task.
    let selfHits = 0;
    for (const i of validation.split.evalIdx) {
      const row = req.rows[i];
      if (!row) continue;
      const r = queryRetrievalIndex(index, row.input, { topK: 1 });
      if (r.matches[0]?.idx === i) selfHits++;
    }
    const held = validation.split.evalIdx.length;
    return {
      kind: "inline",
      method: "retrieval_index",
      payload: index,
      metrics: {
        rows: index.builtRows,
        vocabularySize: index.vocabularySize,
        topK: index.topK,
        heldOutRows: held,
        selfRetrievalRate: held === 0 ? null : Number((selfHits / held).toFixed(6)),
        note:
          "selfRetrievalRate is a sanity check on the index (does a held-out row retrieve itself?), " +
          "NOT task accuracy. No weights were updated; nothing was fine-tuned.",
      },
    };
  }

  private trainClassifier(
    req: StartJobRequest,
    hp: NormalizedHyperparameters,
    validation: DatasetValidation,
  ): TrainingArtifactPayload {
    const model = trainTextClassifier(req.rows, {
      trainIdx: validation.split.trainIdx,
      hyperparameters: hp,
    });
    const train = scoreClassifier(model, req.rows, validation.split.trainIdx);
    const evaluation = scoreClassifier(model, req.rows, validation.split.evalIdx);
    return {
      kind: "inline",
      method: "text_classifier",
      payload: model,
      metrics: {
        labels: model.labels,
        vocabularySize: model.vocabulary.length,
        epochs: model.epochs,
        initialLoss: model.lossCurve[0] ?? null,
        finalLoss: model.lossCurve[model.lossCurve.length - 1] ?? null,
        lossCurve: model.lossCurve,
        trainAccuracy: train.accuracy,
        trainExamples: train.total,
        evalAccuracy: evaluation.total === 0 ? null : evaluation.accuracy,
        evalExamples: evaluation.total,
        note:
          "A bag-of-words multinomial logistic regression trained by full-batch gradient descent. " +
          "Accuracies are measured on a deterministic split of YOUR rows. It has no word order and " +
          "no semantics beyond term overlap; it is not a language model.",
      },
    };
  }

  async pollJob(handle: TrainingJobHandle): Promise<TrainingJobStatusReport> {
    const state = this.jobs.get(handle.jobId);
    if (!state) throw new TrainingBackendError(`local job ${handle.jobId} is not known to this process`, "unknown_job", 404);
    return {
      status: state.status,
      progress: state.progress,
      error: state.error,
      ...(state.artifact ? { metrics: state.artifact.metrics } : {}),
    };
  }

  async cancelJob(handle: TrainingJobHandle): Promise<void> {
    const state = this.jobs.get(handle.jobId);
    // A local job is already finished by the time anything could cancel it.
    // Saying so is better than reporting a cancellation that did nothing.
    if (!state) throw new TrainingBackendError(`local job ${handle.jobId} is not known to this process`, "unknown_job", 404);
    if (state.status === "succeeded" || state.status === "failed") return;
    state.status = "cancelled";
  }

  async fetchArtifact(handle: TrainingJobHandle): Promise<TrainingArtifactPayload> {
    const state = this.jobs.get(handle.jobId);
    if (!state?.artifact) {
      throw new TrainingBackendError(
        `local job ${handle.jobId} produced no artifact`,
        "artifact_unavailable",
        409,
      );
    }
    return state.artifact;
  }
}

// ---------------------------------------------------------------------------
// The MOCK backend — for tests and air-gapped development
// ---------------------------------------------------------------------------

export const MOCK_CAPABILITIES: TrainingBackendCapabilities = {
  kind: "mock",
  requiresCredential: false,
  inProcess: true,
  methods: [...TRAINING_METHODS],
  baseModels: null,
  producesQueryableArtifact: true,
  supportsCancel: true,
  supportsPoll: true,
  summary: "Deterministic in-memory backend for tests and air-gapped development.",
  limits:
    "It trains NOTHING. It exists so the lifecycle — validate, start, poll, cancel, fetch — can be " +
    "exercised end to end without a provider. Never enable it as a way to 'get a model'.",
};

/**
 * The mock mirrors `MockModelProvider`: deterministic, stateful across
 * resolutions in one process, and never mistakable for a real result. Its
 * artifact is a real (tiny) TF-IDF index over the supplied rows so callers get
 * something queryable, but the metrics say `mock: true` so nothing downstream
 * can present it as a measurement.
 */
export class MockTrainingBackend implements TrainingBackend {
  readonly capabilities = MOCK_CAPABILITIES;
  private readonly jobs = new Map<string, { polls: number; artifact: TrainingArtifactPayload; cancelled: boolean }>();
  /** how many polls before the job reports success — 1 by default so a test
   * that polls once sees a terminal state */
  constructor(private readonly pollsToFinish = 1) {}

  validateDataset(
    rows: TrainingRow[],
    opts: { format: TrainingDatasetFormat; method: TrainingMethod; evalFraction?: number },
  ): DatasetValidation {
    return validateTrainingDataset(rows, opts);
  }

  async startJob(req: StartJobRequest): Promise<TrainingJobHandle> {
    const index = buildRetrievalIndex(req.rows, { topK: 3 });
    this.jobs.set(req.jobId, {
      polls: 0,
      cancelled: false,
      artifact: {
        kind: "inline",
        method: req.method,
        payload: index,
        metrics: { mock: true, rows: req.rows.length, method: req.method },
      },
    });
    return { backend: "mock", jobId: req.jobId, externalJobId: `mock-${req.jobId}` };
  }

  async pollJob(handle: TrainingJobHandle): Promise<TrainingJobStatusReport> {
    const state = this.jobs.get(handle.jobId);
    if (!state) throw new TrainingBackendError(`mock job ${handle.jobId} unknown`, "unknown_job", 404);
    if (state.cancelled) return { status: "cancelled", progress: state.polls / this.pollsToFinish, error: null };
    state.polls++;
    if (state.polls >= this.pollsToFinish) {
      return { status: "succeeded", progress: 1, error: null, metrics: state.artifact.metrics };
    }
    return { status: "running", progress: Number((state.polls / this.pollsToFinish).toFixed(4)), error: null };
  }

  async cancelJob(handle: TrainingJobHandle): Promise<void> {
    const state = this.jobs.get(handle.jobId);
    if (!state) throw new TrainingBackendError(`mock job ${handle.jobId} unknown`, "unknown_job", 404);
    state.cancelled = true;
  }

  async fetchArtifact(handle: TrainingJobHandle): Promise<TrainingArtifactPayload> {
    const state = this.jobs.get(handle.jobId);
    if (!state) throw new TrainingBackendError(`mock job ${handle.jobId} unknown`, "unknown_job", 404);
    return state.artifact;
  }
}

// ---------------------------------------------------------------------------
// The REAL remote adapters
// ---------------------------------------------------------------------------

/**
 * The per-vendor wire shape, as ONE table rather than four near-identical
 * classes. Every field here is the vendor's DOCUMENTED shape; none of it has
 * been exercised against the live service from this environment, which is why
 * `limits` on each capability entry says so out loud.
 */
interface RemoteSpec {
  kind: TrainingBackendKind;
  defaultBaseUrl: string;
  methods: TrainingMethod[];
  /** how the credential is presented */
  authHeader: (key: string) => Record<string, string>;
  startPath: (settings: Record<string, unknown>) => string;
  statusPath: (externalId: string, settings: Record<string, unknown>) => string;
  cancelPath: ((externalId: string, settings: Record<string, unknown>) => string) | null;
  body: (req: StartJobRequest, hp: NormalizedHyperparameters, settings: Record<string, unknown>) => Record<string, unknown>;
  /** vendor status string → our four states */
  mapStatus: (raw: unknown) => TrainingJobStatusReport;
  /** where the finished model lives, from the status payload */
  location: (raw: unknown) => string | null;
  summary: string;
  limits: string;
}

const s = (v: unknown, fallback: string) => (typeof v === "string" && v.length > 0 ? v : fallback);

function terminalFrom(
  raw: unknown,
  running: string[],
  succeeded: string[],
  cancelled: string[],
): TrainingJobStatusReport {
  const body = (raw ?? {}) as Record<string, unknown>;
  const status = String(body["status"] ?? body["state"] ?? "").toLowerCase();
  const progress = typeof body["progress"] === "number" ? Math.max(0, Math.min(1, body["progress"])) : undefined;
  if (succeeded.includes(status)) return { status: "succeeded", progress: 1 };
  if (cancelled.includes(status)) return { status: "cancelled", progress: progress ?? 0 };
  if (running.includes(status)) return { status: "running", progress: progress ?? 0.5 };
  // Anything unrecognised is a FAILURE, not a "probably still running". A poll
  // loop that treats an unknown status as running never terminates, and the
  // symptom is a job that is forever 50% done.
  return {
    status: "failed",
    progress: progress ?? 0,
    error: String(body["error"] ?? body["failure_reason"] ?? body["message"] ?? `unrecognised status '${status}'`),
  };
}

const REMOTE_SPECS: Record<"huggingface" | "together" | "bedrock" | "vertex", RemoteSpec> = {
  huggingface: {
    kind: "huggingface",
    defaultBaseUrl: "https://api.huggingface.co",
    methods: ["lora_sft", "full_sft"],
    authHeader: (key) => ({ authorization: `Bearer ${key}` }),
    startPath: (st) => `/autotrain/projects/${encodeURIComponent(s(st["namespace"], "me"))}/jobs`,
    statusPath: (id, st) => `/autotrain/projects/${encodeURIComponent(s(st["namespace"], "me"))}/jobs/${encodeURIComponent(id)}`,
    cancelPath: (id, st) =>
      `/autotrain/projects/${encodeURIComponent(s(st["namespace"], "me"))}/jobs/${encodeURIComponent(id)}/stop`,
    body: (req, hp) => ({
      job_name: req.name,
      task: req.method === "lora_sft" ? "lm_training:peft" : "lm_training:full",
      base_model: req.baseModel,
      params: { epochs: hp.epochs, lr: hp.learningRate, batch_size: hp.batchSize, lora_r: hp.loraRank },
      data: req.rows.map((r) => ({ prompt: r.input, completion: r.output })),
    }),
    mapStatus: (raw) => terminalFrom(raw, ["queued", "running", "processing"], ["success", "succeeded", "completed"], ["stopped", "cancelled"]),
    location: (raw) => {
      const b = (raw ?? {}) as Record<string, unknown>;
      return typeof b["model_repo"] === "string" ? b["model_repo"] : null;
    },
    summary: "Hugging Face AutoTrain — LoRA and full supervised fine-tuning on HF-hosted compute.",
    limits:
      "REQUIRES a Hugging Face token AND a paid AutoTrain namespace with compute attached. Without " +
      "both, this adapter refuses with credential_required and starts nothing. The request/response " +
      "shape below is the documented one and is unit-tested against recorded payloads; it has never " +
      "been exercised against the live service from this deployment.",
  },
  together: {
    kind: "together",
    defaultBaseUrl: "https://api.together.xyz",
    methods: ["lora_sft", "full_sft", "dpo"],
    authHeader: (key) => ({ authorization: `Bearer ${key}` }),
    startPath: () => "/v1/fine-tunes",
    statusPath: (id) => `/v1/fine-tunes/${encodeURIComponent(id)}`,
    cancelPath: (id) => `/v1/fine-tunes/${encodeURIComponent(id)}/cancel`,
    body: (req, hp) => ({
      model: req.baseModel,
      suffix: req.name,
      n_epochs: hp.epochs,
      learning_rate: hp.learningRate,
      batch_size: hp.batchSize,
      training_method: req.method === "dpo" ? "dpo" : "sft",
      lora: req.method === "lora_sft",
      lora_r: hp.loraRank,
      training_data: req.rows.map((r) => ({ text: `${r.input}\n${r.output ?? ""}` })),
    }),
    mapStatus: (raw) => terminalFrom(raw, ["pending", "queued", "running", "compressing", "uploading"], ["completed"], ["cancelled", "user_error"]),
    location: (raw) => {
      const b = (raw ?? {}) as Record<string, unknown>;
      return typeof b["output_name"] === "string" ? b["output_name"] : null;
    },
    summary: "Together AI fine-tuning — LoRA, full SFT and DPO on Together-hosted GPUs.",
    limits:
      "REQUIRES a Together API key and a funded account. Refuses with credential_required otherwise. " +
      "Shape is documented-and-unit-tested, never exercised live from here.",
  },
  bedrock: {
    kind: "bedrock",
    // The regional control-plane host. `settings.region` selects it; the
    // default is deliberately explicit rather than inherited from an ambient
    // AWS config, because an ambient region is a destination nobody chose.
    defaultBaseUrl: "https://bedrock.us-east-1.amazonaws.com",
    methods: ["lora_sft", "full_sft"],
    // SigV4 is NOT implemented here. A bearer token is what a customer-side
    // proxy in front of Bedrock takes, and that is the supported shape; a
    // half-written SigV4 signer would be worse than an honest refusal.
    authHeader: (key) => ({ authorization: `Bearer ${key}` }),
    startPath: () => "/model-customization-jobs",
    statusPath: (id) => `/model-customization-jobs/${encodeURIComponent(id)}`,
    cancelPath: (id) => `/model-customization-jobs/${encodeURIComponent(id)}/stop`,
    body: (req, hp, st) => ({
      jobName: req.name,
      customModelName: req.name,
      baseModelIdentifier: req.baseModel,
      customizationType: req.method === "lora_sft" ? "FINE_TUNING" : "CONTINUED_PRE_TRAINING",
      roleArn: s(st["roleArn"], ""),
      hyperParameters: {
        epochCount: String(hp.epochs),
        learningRate: String(hp.learningRate),
        batchSize: String(hp.batchSize),
      },
      trainingDataConfig: { s3Uri: s(st["trainingDataS3Uri"], "") },
      outputDataConfig: { s3Uri: s(st["outputS3Uri"], "") },
    }),
    mapStatus: (raw) => terminalFrom(raw, ["inprogress", "in_progress"], ["completed"], ["stopped", "stopping"]),
    location: (raw) => {
      const b = (raw ?? {}) as Record<string, unknown>;
      return typeof b["outputModelArn"] === "string" ? b["outputModelArn"] : null;
    },
    summary: "Amazon Bedrock model customization — fine-tuning and continued pre-training.",
    limits:
      "REQUIRES a credential, an IAM role ARN, and S3 URIs for training input and output — Bedrock " +
      "reads the corpus from S3, so the rows uploaded here are NOT what it trains on unless you also " +
      "stage them there. SigV4 request signing is NOT implemented; this speaks bearer auth, which " +
      "suits a customer-side proxy in front of Bedrock. Refuses with credential_required otherwise.",
  },
  vertex: {
    kind: "vertex",
    defaultBaseUrl: "https://us-central1-aiplatform.googleapis.com",
    methods: ["lora_sft"],
    authHeader: (key) => ({ authorization: `Bearer ${key}` }),
    startPath: (st) =>
      `/v1/projects/${encodeURIComponent(s(st["gcpProject"], "unset"))}/locations/${encodeURIComponent(s(st["location"], "us-central1"))}/tuningJobs`,
    statusPath: (id, st) =>
      `/v1/projects/${encodeURIComponent(s(st["gcpProject"], "unset"))}/locations/${encodeURIComponent(s(st["location"], "us-central1"))}/tuningJobs/${encodeURIComponent(id)}`,
    cancelPath: (id, st) =>
      `/v1/projects/${encodeURIComponent(s(st["gcpProject"], "unset"))}/locations/${encodeURIComponent(s(st["location"], "us-central1"))}/tuningJobs/${encodeURIComponent(id)}:cancel`,
    body: (req, hp, st) => ({
      baseModel: req.baseModel,
      tunedModelDisplayName: req.name,
      supervisedTuningSpec: {
        trainingDatasetUri: s(st["trainingDatasetUri"], ""),
        hyperParameters: {
          epochCount: hp.epochs,
          learningRateMultiplier: hp.learningRate,
          adapterSize: `ADAPTER_SIZE_${hp.loraRank}`,
        },
      },
    }),
    mapStatus: (raw) =>
      terminalFrom(
        raw,
        ["job_state_pending", "job_state_running", "job_state_queued"],
        ["job_state_succeeded"],
        ["job_state_cancelled", "job_state_cancelling"],
      ),
    location: (raw) => {
      const b = (raw ?? {}) as Record<string, unknown>;
      const tuned = b["tunedModel"] as Record<string, unknown> | undefined;
      return typeof tuned?.["model"] === "string" ? (tuned["model"] as string) : null;
    },
    summary: "Google Vertex AI supervised tuning — LoRA adapters over Gemini base models.",
    limits:
      "REQUIRES an OAuth access token, a GCP project id, a location and a GCS training dataset URI — " +
      "Vertex reads the corpus from GCS, so the rows uploaded here are NOT what it trains on unless " +
      "you also stage them there. Refuses with credential_required otherwise.",
  },
};

/**
 * ONE class for all four vendors, driven by the table above.
 *
 * Every HTTP call goes through the INJECTED `fetchImpl`, which the gateway
 * supplies as the ADR-0034/0062 egress-guarded fetch — so a training backend's
 * base URL is adjudicated by exactly the same guard that adjudicates a BYO
 * inference endpoint, on every request, not once at registration.
 */
export class RemoteTrainingBackend implements TrainingBackend {
  readonly capabilities: TrainingBackendCapabilities;
  private readonly spec: RemoteSpec;

  constructor(
    private readonly config: {
      backend: "huggingface" | "together" | "bedrock" | "vertex";
      apiKey?: string | null;
      baseUrl?: string | null;
      settings?: Record<string, unknown>;
      fetchImpl?: typeof fetch;
    },
  ) {
    this.spec = REMOTE_SPECS[config.backend];
    this.capabilities = {
      kind: this.spec.kind,
      requiresCredential: true,
      inProcess: false,
      methods: this.spec.methods,
      baseModels: null,
      // We hold a REFERENCE to the tuned model, never the weights. Saying we
      // could query it here would be the second-most-tempting lie available.
      producesQueryableArtifact: false,
      supportsCancel: this.spec.cancelPath !== null,
      supportsPoll: true,
      summary: this.spec.summary,
      limits: this.spec.limits,
    };
  }

  get baseUrl(): string {
    return (this.config.baseUrl ?? this.spec.defaultBaseUrl).replace(/\/+$/, "");
  }

  private get settings(): Record<string, unknown> {
    return this.config.settings ?? {};
  }

  /** THE HONEST REFUSAL. Called before any URL is built, so an unconfigured
   * backend never even resolves a hostname. */
  private requireCredential(): string {
    const key = this.config.apiKey ?? null;
    if (!key) {
      throw new TrainingBackendError(
        `the '${this.spec.kind}' training backend has no credential configured, so no job was started. ` +
          `Real fine-tuning needs the vendor's compute: register a credential for this backend in ` +
          `RegulAIt-LLM → Backends, or use the 'local' backend, which runs in-process and is honest ` +
          `about producing a retrieval index or a small classifier rather than a fine-tuned LLM.`,
        "credential_required",
        409,
      );
    }
    return key;
  }

  private async call(
    method: "GET" | "POST",
    path: string,
    body?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const key = this.requireCredential();
    const doFetch = this.config.fetchImpl ?? fetch;
    const res = await doFetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...this.spec.authHeader(key),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = { raw: text };
    }
    if (!res.ok) {
      throw new TrainingBackendError(
        `${this.spec.kind} returned ${res.status}: ${text.slice(0, 500)}`,
        "upstream_error",
        502,
      );
    }
    return (parsed ?? {}) as Record<string, unknown>;
  }

  validateDataset(
    rows: TrainingRow[],
    opts: { format: TrainingDatasetFormat; method: TrainingMethod; evalFraction?: number },
  ): DatasetValidation {
    return validateTrainingDataset(rows, opts);
  }

  async startJob(req: StartJobRequest): Promise<TrainingJobHandle> {
    if (!this.spec.methods.includes(req.method)) {
      throw new TrainingBackendError(
        `${this.spec.kind} does not offer '${req.method}' (it offers ${this.spec.methods.join(", ")})`,
        "method_unsupported",
        409,
      );
    }
    const hp = validateHyperparameters(req.method, req.hyperparameters);
    if (!hp.ok) throw new TrainingBackendError(hp.errors.join("; "), "hyperparameters_invalid", 422);
    // credential check FIRST — before a URL is built or a name resolved
    this.requireCredential();
    const payload = await this.call("POST", this.spec.startPath(this.settings), this.spec.body(req, hp.value, this.settings));
    const externalJobId =
      (typeof payload["id"] === "string" && payload["id"]) ||
      (typeof payload["name"] === "string" && payload["name"]) ||
      (typeof payload["jobArn"] === "string" && payload["jobArn"]) ||
      null;
    if (!externalJobId) {
      throw new TrainingBackendError(
        `${this.spec.kind} accepted the job but returned no id to poll — nothing can be tracked`,
        "upstream_error",
        502,
      );
    }
    return { backend: this.spec.kind, jobId: req.jobId, externalJobId };
  }

  async pollJob(handle: TrainingJobHandle): Promise<TrainingJobStatusReport> {
    if (!handle.externalJobId) {
      throw new TrainingBackendError("no external job id to poll", "unknown_job", 409);
    }
    const payload = await this.call("GET", this.spec.statusPath(handle.externalJobId, this.settings));
    const report = this.spec.mapStatus(payload);
    return report;
  }

  async cancelJob(handle: TrainingJobHandle): Promise<void> {
    if (!this.spec.cancelPath) {
      throw new TrainingBackendError(`${this.spec.kind} exposes no cancel endpoint`, "cancel_unsupported", 409);
    }
    if (!handle.externalJobId) {
      throw new TrainingBackendError("no external job id to cancel", "unknown_job", 409);
    }
    await this.call("POST", this.spec.cancelPath(handle.externalJobId, this.settings));
  }

  async fetchArtifact(handle: TrainingJobHandle): Promise<TrainingArtifactPayload> {
    if (!handle.externalJobId) {
      throw new TrainingBackendError("no external job id", "unknown_job", 409);
    }
    const payload = await this.call("GET", this.spec.statusPath(handle.externalJobId, this.settings));
    const location = this.spec.location(payload);
    if (!location) {
      throw new TrainingBackendError(
        `${this.spec.kind} reports no output model location for ${handle.externalJobId}`,
        "artifact_unavailable",
        409,
      );
    }
    return {
      kind: "remote",
      method: "lora_sft",
      location,
      metrics: {
        remote: true,
        backend: this.spec.kind,
        note:
          "The weights live on the training backend. RegulAIt holds a REFERENCE and whatever metrics " +
          "the backend reported — it cannot query this artifact locally and does not claim to.",
      },
    };
  }
}

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

export interface TrainingBackendConfig {
  backend: TrainingBackendKind;
  apiKey?: string | null;
  baseUrl?: string | null;
  settings?: Record<string, unknown>;
}

const sharedLocal = new LocalTrainingBackend();
const sharedMock = new MockTrainingBackend();

/**
 * Resolve a backend. Mirrors `resolveModelProvider` down to the shape of the
 * switch: a closed vocabulary, no default case, and no silent promises. The
 * credential check for a remote backend is deliberately NOT here — it fires at
 * `startJob`, so a capability query, a dataset validation and an admin listing
 * all work on an unconfigured backend and only the act that would need compute
 * refuses.
 */
export function resolveTrainingBackend(
  config: TrainingBackendConfig,
  fetchImpl?: typeof fetch,
): TrainingBackend {
  switch (config.backend) {
    case "local":
      return sharedLocal;
    case "mock":
      return sharedMock;
    case "huggingface":
    case "together":
    case "bedrock":
    case "vertex":
      return new RemoteTrainingBackend({
        backend: config.backend,
        apiKey: config.apiKey ?? null,
        baseUrl: config.baseUrl ?? null,
        settings: config.settings ?? {},
        ...(fetchImpl ? { fetchImpl } : {}),
      });
  }
}

/** Every backend's declared capabilities, INCLUDING its honest `limits` string.
 * The admin screen renders this verbatim — the same discipline as
 * `guardrailRegistry()` and `evalScorerRegistry()`. */
export function trainingBackendRegistry(): TrainingBackendCapabilities[] {
  return TRAINING_BACKEND_KINDS.map((kind) => resolveTrainingBackend({ backend: kind }).capabilities);
}

/** The endpoint a remote backend reaches when no `baseUrl` override is stored —
 * the value the ADR-0062 compiled-default guard must adjudicate. `null` = it
 * makes no outbound call of its own (`local`, `mock`). */
export function defaultTrainingBaseUrl(kind: TrainingBackendKind): string | null {
  if (kind === "local" || kind === "mock") return null;
  return REMOTE_SPECS[kind].defaultBaseUrl;
}

// ---------------------------------------------------------------------------
// Serving an artifact — the inference half
// ---------------------------------------------------------------------------


/**
 * A trained artifact, served as an ORDINARY `ModelProvider`.
 *
 * This is the whole point of registering an artifact as an agent: once it is a
 * provider, `executeGovernedDispatch` treats it exactly like a vendor model —
 * entitlement, the ADR-0045 MRM gate, project budget, §8.4 PII, ADR-0042
 * guardrails and the one `usage_events` ledger all apply, with no special case
 * anywhere in the dispatch core. A model somebody trained here is governed by
 * the same machinery as a model somebody bought.
 *
 * THREE HONESTY PROPERTIES, ENFORCED IN CODE BELOW
 *
 *  1. Usage is MEASURED, not invented: `inputTokens`/`outputTokens` are a
 *     4-chars-per-token count of the actual strings, and cost is zero because
 *     nothing was billed by anyone. A fabricated token count would poison
 *     pillar 5's ledger with numbers no vendor ever charged.
 *  2. A MISS IS A MISS. When the corpus shares no term with the query, the
 *     answer says so instead of returning the least-bad row. A retrieval model
 *     that always answers is a retrieval model that is always wrong somewhere.
 *  3. It never pretends to be a chat model: tools, structured outputs and
 *     extended thinking are not silently ignored, because a caller that asked
 *     for a tool call and got prose has been misled.
 */
export class ArtifactModelProvider implements ModelProvider {
  // Its own provider KIND, so the ledger, the audit rows and the registry all
  // say where an answer came from rather than filing it under a vendor.
  readonly kind = "regulait_llm" as const;

  constructor(
    private readonly artifact: {
      id: string;
      name: string;
      method: TrainingMethod;
      payload: Record<string, unknown>;
      topK?: number;
    },
  ) {}

  async dispatch(req: ModelDispatchRequest): Promise<ModelDispatchResult> {
    if (req.tools?.length) {
      throw new TrainingBackendError(
        `artifact '${this.artifact.name}' is a ${this.artifact.method}; it cannot call tools`,
        "method_unsupported",
        409,
      );
    }
    if (req.responseFormat || req.thinking) {
      throw new TrainingBackendError(
        `artifact '${this.artifact.name}' supports neither structured outputs nor extended thinking`,
        "method_unsupported",
        409,
      );
    }
    // the newest user turn, matching the model-provider messages-vs-input rule
    const turns = req.messages && req.messages.length > 0 ? req.messages : [{ role: "user" as const, content: req.input }];
    const lastUser = [...turns].reverse().find((t) => t.role === "user");
    const query =
      typeof lastUser?.content === "string"
        ? lastUser.content
        : (lastUser?.content ?? [])
            .map((b) => (b.type === "text" ? b.text : ""))
            .join(" ")
            .trim();

    const result = queryArtifact(this.artifact.payload, query, {
      ...(this.artifact.topK !== undefined ? { topK: this.artifact.topK } : {}),
    });
    const miss = result.answer == null || result.detail["miss"] === true;
    const outputText = miss
      ? `No row in this model's training corpus shares any term with that query, so it has no answer. ` +
        `(${this.artifact.method} '${this.artifact.name}')`
      : result.answer!;

    return {
      outputText,
      stopReason: "end_turn",
      refusal: false,
      // MEASURED from the real strings at the same 4:1 ratio used elsewhere in
      // this codebase. Nothing here was billed, so the caller's cost row is
      // zero — see the gateway's pricing, which leaves cost_per_mtok null.
      usage: {
        inputTokens: Math.ceil(query.length / 4),
        outputTokens: Math.ceil(outputText.length / 4),
      },
      providerMessageId: `regulait-llm:${this.artifact.id}`,
    };
  }
}
