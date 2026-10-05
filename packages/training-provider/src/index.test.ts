/**
 * ADR-0065 — the PURE half of RegulAIt-LLM, proved by attack.
 *
 * WHAT THIS FILE IS TRYING TO MAKE IMPOSSIBLE TO FAKE
 *
 *  1. A TRAINER THAT DOES NOT TRAIN. The classifier case asserts the loss curve
 *     actually DESCENDS and that the model then classifies held-out-shaped text
 *     correctly. A stub that returned constant weights would pass "a model
 *     exists" and fail both of these.
 *  2. AN INDEX THAT DOES NOT INDEX. The retrieval case asserts a specific,
 *     substantively correct answer pulled out of the corpus — and, just as
 *     importantly, that a query sharing no term with the corpus is reported as
 *     a MISS rather than answered with the least-bad row.
 *  3. A CREDENTIAL-LESS BACKEND THAT SILENTLY "WORKS". Every real adapter is
 *     started with no key and must throw `credential_required` BEFORE any fetch
 *     is attempted — asserted with a fetch spy that must record zero calls.
 *  4. A COST ESTIMATE THAT INVENTS A NUMBER. In-process methods must estimate
 *     exactly 0, and an unknown vendor price must yield null rather than a guess.
 *  5. A VALIDATOR THAT WAVES THINGS THROUGH. A one-label classification corpus,
 *     an unknown hyperparameter and a no-op hyperparameter on a method that
 *     updates no weights are all refused.
 */
import { describe, expect, it, vi } from "vitest";
import {
  ArtifactModelProvider,
  HYPERPARAMETER_DEFAULTS,
  LocalTrainingBackend,
  MockTrainingBackend,
  RemoteTrainingBackend,
  TrainingBackendError,
  buildRetrievalIndex,
  classifyText,
  datasetChecksum,
  defaultTrainingBaseUrl,
  estimateTrainingCostUsd,
  queryArtifact,
  queryRetrievalIndex,
  resolveTrainingBackend,
  scoreClassifier,
  splitDataset,
  tokenize,
  trainTextClassifier,
  trainingBackendRegistry,
  validateHyperparameters,
  validateTrainingDataset,
  type TrainingRow,
} from "./index.js";

// A small, REAL corpus. Each answer contains a distinctive token that appears
// nowhere else, so an assertion on the returned text cannot be satisfied by
// accident or by returning the first row.
const SUPPORT_CORPUS: TrainingRow[] = [
  { input: "How do I rotate an API key?", output: "Open Settings, choose Credentials, then press Rotate. The old key stops working after 24 hours." },
  { input: "What is the refund window for annual plans?", output: "Annual plans can be refunded within 30 days of the renewal date." },
  { input: "How do I invite a teammate?", output: "Go to Members and send an invitation to their work email address." },
  { input: "Where can I download an invoice?", output: "Invoices live under Billing, and every one of them can be exported as a PDF." },
  { input: "How do I enable two-factor authentication?", output: "Two-factor lives in Security; scan the QR code with an authenticator app." },
];

const SENTIMENT_CORPUS: TrainingRow[] = [
  { input: "this release is fantastic and the team shipped it early", output: "positive" },
  { input: "excellent work, the dashboard finally feels fast", output: "positive" },
  { input: "wonderful improvement, everything loads quickly now", output: "positive" },
  { input: "great job on the migration, zero downtime", output: "positive" },
  { input: "the build broke again and nobody noticed for hours", output: "negative" },
  { input: "terrible latency, every page takes forever to load", output: "negative" },
  { input: "awful experience, the export failed three times", output: "negative" },
  { input: "broken deploy, rollback took the whole afternoon", output: "negative" },
];

describe("tokenisation and the content digest", () => {
  it("lowercases, drops stopwords and single characters", () => {
    expect(tokenize("How do I ROTATE an API key?")).toEqual(["rotate", "api", "key"]);
  });

  it("the checksum is order-sensitive — a reordered corpus is a different corpus", () => {
    const a = datasetChecksum(SUPPORT_CORPUS);
    const b = datasetChecksum([...SUPPORT_CORPUS].reverse());
    expect(a).not.toBe(b);
    expect(datasetChecksum(SUPPORT_CORPUS)).toBe(a);
  });

  it("the checksum is SHA-256 (ADR-0176), not a 32-bit FNV a different corpus can match", () => {
    const a = datasetChecksum(SUPPORT_CORPUS);
    expect(a).toMatch(new RegExp(`^sha256:[0-9a-f]{64}:${SUPPORT_CORPUS.length}$`));
  });

  it("the row framing is unambiguous: moving text across the input/output boundary changes it", () => {
    // under the old NUL/SOH-joined framing these two corpora were the same bytes
    const one = datasetChecksum([{ input: "a\u0000b", output: "c" }]);
    const two = datasetChecksum([{ input: "a", output: "b\u0000c" }]);
    expect(one).not.toBe(two);
    expect(datasetChecksum([{ input: "x", output: null }])).toBe(datasetChecksum([{ input: "x", output: "" }]));
  });

  it("the split is DETERMINISTIC — the same row count always yields the same split", () => {
    const one = splitDataset(50, 0.2);
    const two = splitDataset(50, 0.2);
    expect(one).toEqual(two);
    expect(one.trainIdx.length + one.evalIdx.length).toBe(50);
    expect(one.trainIdx.length).toBeGreaterThan(0);
  });

  it("a split that would leave nothing to train on falls back to training on everything", () => {
    const s = splitDataset(1, 0.5);
    expect(s.trainIdx.length).toBe(1);
  });
});

describe("the retrieval index is a REAL index", () => {
  it("answers a paraphrased question with the right row's answer", () => {
    const index = buildRetrievalIndex(SUPPORT_CORPUS);
    const r = queryRetrievalIndex(index, "how can I rotate the api key for my account?");
    expect(r.miss).toBe(false);
    // the SUBSTANCE, not just "something came back"
    expect(r.answer).toContain("Rotate");
    expect(r.answer).toContain("24 hours");
    expect(r.score).toBeGreaterThan(0);
  });

  it("discriminates between rows — a different question gets a different answer", () => {
    const index = buildRetrievalIndex(SUPPORT_CORPUS);
    expect(queryRetrievalIndex(index, "refund window annual plan").answer).toContain("30 days");
    expect(queryRetrievalIndex(index, "download the invoice as a pdf").answer).toContain("PDF");
    expect(queryRetrievalIndex(index, "two-factor authenticator qr").answer).toContain("QR code");
  });

  it("A MISS IS A MISS: a query sharing no term returns nothing, not the least-bad row", () => {
    const index = buildRetrievalIndex(SUPPORT_CORPUS);
    const r = queryRetrievalIndex(index, "zzzz qqqq wwww");
    expect(r.miss).toBe(true);
    expect(r.answer).toBeNull();
    expect(r.matches).toEqual([]);
  });

  it("IDF actually weights: a term in every document cannot dominate the ranking", () => {
    const rows: TrainingRow[] = [
      { input: "common common alpha", output: "A" },
      { input: "common common beta", output: "B" },
      { input: "common common gamma", output: "C" },
    ];
    const index = buildRetrievalIndex(rows);
    expect(index.idf["common"]!).toBeLessThan(index.idf["beta"]!);
    expect(queryRetrievalIndex(index, "common beta").answer).toBe("B");
  });
});

describe("the classifier is REALLY trained by gradient descent", () => {
  const validation = validateTrainingDataset(SENTIMENT_CORPUS, {
    format: "classification",
    method: "text_classifier",
  });

  it("the corpus validates and names its classes", () => {
    expect(validation.ok).toBe(true);
    expect(validation.labels).toEqual(["negative", "positive"]);
  });

  it("THE LOSS ACTUALLY GOES DOWN — a stub returning fixed weights cannot do this", () => {
    const model = trainTextClassifier(SENTIMENT_CORPUS, {
      trainIdx: validation.split.trainIdx,
      hyperparameters: { epochs: 60, learningRate: 2, l2: 1e-5, maxVocabulary: 500 },
    });
    expect(model.lossCurve).toHaveLength(60);
    expect(model.lossCurve[59]!).toBeLessThan(model.lossCurve[0]!);
    // and it converged rather than merely wobbling
    expect(model.lossCurve[59]!).toBeLessThan(model.lossCurve[0]! * 0.6);
  });

  it("classifies unseen text correctly, and reports a real posterior", () => {
    const model = trainTextClassifier(SENTIMENT_CORPUS, {
      trainIdx: SENTIMENT_CORPUS.map((_, i) => i),
      hyperparameters: { epochs: 200, learningRate: 3, l2: 1e-6, maxVocabulary: 500 },
    });
    expect(classifyText(model, "fantastic excellent work").label).toBe("positive");
    expect(classifyText(model, "terrible awful broken").label).toBe("negative");
    const scores = classifyText(model, "fantastic excellent work").scores;
    expect(scores.map((s) => s.label).sort()).toEqual(["negative", "positive"]);
    expect(scores.reduce((a, s) => a + s.probability, 0)).toBeCloseTo(1, 4);
  });

  it("training accuracy is MEASURED from real predictions", () => {
    const model = trainTextClassifier(SENTIMENT_CORPUS, {
      trainIdx: SENTIMENT_CORPUS.map((_, i) => i),
      hyperparameters: { epochs: 200, learningRate: 3, l2: 1e-6, maxVocabulary: 500 },
    });
    const scored = scoreClassifier(model, SENTIMENT_CORPUS, SENTIMENT_CORPUS.map((_, i) => i));
    expect(scored.total).toBe(SENTIMENT_CORPUS.length);
    expect(scored.accuracy).toBe(1);
  });

  it("training is DETERMINISTIC — same corpus, same weights", () => {
    const hp = { epochs: 20, learningRate: 1, l2: 1e-4, maxVocabulary: 200 };
    const a = trainTextClassifier(SENTIMENT_CORPUS, { trainIdx: [0, 1, 2, 4, 5, 6], hyperparameters: hp });
    const b = trainTextClassifier(SENTIMENT_CORPUS, { trainIdx: [0, 1, 2, 4, 5, 6], hyperparameters: hp });
    expect(a.weights).toEqual(b.weights);
    expect(a.lossCurve).toEqual(b.lossCurve);
  });
});

describe("validation refuses what cannot honestly train", () => {
  it("a one-label classification corpus is refused — a one-class classifier is a constant", () => {
    const v = validateTrainingDataset(
      [
        { input: "good", output: "positive" },
        { input: "great", output: "positive" },
      ],
      { format: "classification", method: "text_classifier" },
    );
    expect(v.ok).toBe(false);
    expect(v.errors.join(" ")).toMatch(/two distinct labels/);
  });

  it("a missing output on a prompt_completion corpus is fatal", () => {
    const v = validateTrainingDataset([{ input: "hi", output: null }], {
      format: "prompt_completion",
      method: "retrieval_index",
    });
    expect(v.ok).toBe(false);
    expect(v.errors.join(" ")).toMatch(/output is required/);
  });

  it("an empty corpus is fatal", () => {
    expect(validateTrainingDataset([], { format: "documents", method: "retrieval_index" }).ok).toBe(false);
  });

  it("duplicates warn but do not block", () => {
    const v = validateTrainingDataset(
      [
        { input: "same", output: "a" },
        { input: "same", output: "b" },
      ],
      { format: "prompt_completion", method: "retrieval_index" },
    );
    expect(v.ok).toBe(true);
    expect(v.warnings.join(" ")).toMatch(/appear more than once/);
  });
});

describe("hyperparameters", () => {
  it("defaults through when nothing is supplied, and `applied` names only what the method reads", () => {
    const r = validateHyperparameters("text_classifier", {});
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toEqual(HYPERPARAMETER_DEFAULTS);
      expect(Object.keys(r.applied).sort()).toEqual(
        ["epochs", "evalFraction", "l2", "learningRate", "maxVocabulary"],
      );
    }
  });

  it("`applied` is a FIXED POINT — re-validating a stored job's dials changes nothing", () => {
    for (const method of ["retrieval_index", "text_classifier", "lora_sft"] as const) {
      const first = validateHyperparameters(method, {});
      expect(first.ok).toBe(true);
      if (!first.ok) continue;
      const second = validateHyperparameters(method, first.applied);
      expect(second.ok, `${method} did not round-trip: ${second.ok ? "" : second.errors.join("; ")}`).toBe(true);
      if (second.ok) expect(second.applied).toEqual(first.applied);
    }
  });

  it("an UNKNOWN key is an error, not a shrug — a typo must not train a model nobody chose", () => {
    const r = validateHyperparameters("text_classifier", { learning_rate: 0.1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(" ")).toMatch(/unknown hyperparameter 'learning_rate'/);
  });

  it("out-of-range and non-integer values are refused with the bound named", () => {
    const a = validateHyperparameters("text_classifier", { epochs: 5000 });
    expect(a.ok).toBe(false);
    const b = validateHyperparameters("text_classifier", { epochs: 2.5 });
    expect(b.ok).toBe(false);
  });

  it("a NO-OP hyperparameter on a method that would never read it is refused", () => {
    const r = validateHyperparameters("retrieval_index", { epochs: 10 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(" ")).toMatch(/does nothing for method 'retrieval_index'/);
    // and a classifier dial on a fine-tune, which is the same mistake the other way
    const q = validateHyperparameters("full_sft", { maxVocabulary: 100 });
    expect(q.ok).toBe(false);
  });
});

describe("cost estimation never invents a number", () => {
  it("in-process methods cost exactly zero, on any backend", () => {
    expect(estimateTrainingCostUsd({ method: "retrieval_index", backend: "local", charCount: 1e6, epochs: 1 })).toBe(0);
    expect(estimateTrainingCostUsd({ method: "text_classifier", backend: "together", charCount: 1e6, epochs: 50 })).toBe(0);
  });

  it("an unknown vendor price yields NULL, not a guess", () => {
    expect(
      estimateTrainingCostUsd({ method: "lora_sft", backend: "together", charCount: 1e6, epochs: 3 }),
    ).toBeNull();
  });

  it("a known price scales with tokens, epochs and the method's multiplier", () => {
    const full = estimateTrainingCostUsd({ method: "full_sft", backend: "together", charCount: 4_000_000, epochs: 2, pricePerMTokUsd: 10 })!;
    const lora = estimateTrainingCostUsd({ method: "lora_sft", backend: "together", charCount: 4_000_000, epochs: 2, pricePerMTokUsd: 10 })!;
    expect(full).toBeCloseTo(20, 5); // 1M tokens × 2 epochs × $10/MTok
    expect(lora).toBeLessThan(full);
  });
});

describe("the LOCAL backend runs to completion, for real", () => {
  it("builds a retrieval index and the artifact ANSWERS from the corpus", async () => {
    const backend = new LocalTrainingBackend();
    const handle = await backend.startJob({
      jobId: "job-retrieval-1",
      name: "support-kb",
      method: "retrieval_index",
      baseModel: null,
      hyperparameters: { topK: 3 },
      rows: SUPPORT_CORPUS,
      format: "prompt_completion",
    });
    const status = await backend.pollJob(handle);
    expect(status.status).toBe("succeeded");
    expect(status.progress).toBe(1);

    const artifact = await backend.fetchArtifact(handle);
    expect(artifact.kind).toBe("inline");
    expect(artifact.method).toBe("retrieval_index");
    expect(artifact.metrics["vocabularySize"]).toBeGreaterThan(5);

    const answered = queryArtifact(artifact.payload!, "how do I rotate my api key");
    expect(answered.answer).toContain("Rotate");
    expect(answered.answer).toContain("24 hours");
  });

  it("trains a classifier and the artifact CLASSIFIES", async () => {
    const backend = new LocalTrainingBackend();
    const handle = await backend.startJob({
      jobId: "job-classifier-1",
      name: "sentiment",
      method: "text_classifier",
      baseModel: null,
      hyperparameters: { epochs: 150, learningRate: 3, evalFraction: 0.25 },
      rows: SENTIMENT_CORPUS,
      format: "classification",
    });
    const artifact = await backend.fetchArtifact(handle);
    expect(artifact.metrics["labels"]).toEqual(["negative", "positive"]);
    expect(artifact.metrics["trainAccuracy"]).toBeGreaterThan(0.8);
    expect((artifact.metrics["lossCurve"] as number[]).at(-1)!).toBeLessThan(
      (artifact.metrics["lossCurve"] as number[])[0]!,
    );
    expect(queryArtifact(artifact.payload!, "fantastic excellent shipped early").answer).toBe("positive");
    expect(queryArtifact(artifact.payload!, "broken terrible awful rollback").answer).toBe("negative");
  });

  it("REFUSES a method it cannot perform, naming what it can", async () => {
    const backend = new LocalTrainingBackend();
    await expect(
      backend.startJob({
        jobId: "job-nope",
        name: "x",
        method: "lora_sft",
        baseModel: "some-model",
        hyperparameters: {},
        rows: SUPPORT_CORPUS,
        format: "prompt_completion",
      }),
    ).rejects.toMatchObject({ code: "method_unsupported" });
  });

  it("refuses an unusable dataset instead of producing an empty model", async () => {
    const backend = new LocalTrainingBackend();
    await expect(
      backend.startJob({
        jobId: "job-bad",
        name: "x",
        method: "text_classifier",
        baseModel: null,
        hyperparameters: {},
        rows: [{ input: "a", output: "only" }],
        format: "classification",
      }),
    ).rejects.toMatchObject({ code: "dataset_unusable" });
  });

  it("its declared limits SAY it does not fine-tune an LLM", () => {
    const caps = new LocalTrainingBackend().capabilities;
    expect(caps.limits).toMatch(/DOES NOT FINE-TUNE/);
    expect(caps.methods).toEqual(["retrieval_index", "text_classifier"]);
    expect(caps.requiresCredential).toBe(false);
  });
});

describe("the REAL adapters refuse honestly and never fake a job", () => {
  const kinds = ["huggingface", "together", "bedrock", "vertex"] as const;

  for (const kind of kinds) {
    it(`${kind}: startJob with no credential throws credential_required and makes ZERO fetches`, async () => {
      const fetchImpl = vi.fn<typeof fetch>();
      const backend = new RemoteTrainingBackend({ backend: kind, apiKey: null, fetchImpl });
      const method = backend.capabilities.methods[0]!;
      await expect(
        backend.startJob({
          jobId: "j1",
          name: "n",
          method,
          baseModel: "base",
          hyperparameters: {},
          rows: SUPPORT_CORPUS,
          format: "prompt_completion",
        }),
      ).rejects.toMatchObject({ code: "credential_required", status: 409 });
      // THE POINT: not one request left the process
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it(`${kind}: declares requiresCredential and does NOT claim a queryable artifact`, () => {
      const caps = new RemoteTrainingBackend({ backend: kind }).capabilities;
      expect(caps.requiresCredential).toBe(true);
      expect(caps.inProcess).toBe(false);
      expect(caps.producesQueryableArtifact).toBe(false);
      expect(caps.limits.length).toBeGreaterThan(40);
    });
  }

  it("with a credential it builds the documented request and returns the vendor's job id", async () => {
    const seen: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), init });
      return new Response(JSON.stringify({ id: "ft-123" }), { status: 200 });
    }) as unknown as typeof fetch;
    const backend = new RemoteTrainingBackend({
      backend: "together",
      apiKey: "tk-secret",
      baseUrl: "https://training.internal/",
      fetchImpl,
    });
    const handle = await backend.startJob({
      jobId: "j2",
      name: "my-tune",
      method: "lora_sft",
      baseModel: "base-7b",
      hyperparameters: { epochs: 3 },
      rows: SUPPORT_CORPUS,
      format: "prompt_completion",
    });
    expect(handle.externalJobId).toBe("ft-123");
    expect(seen[0]!.url).toBe("https://training.internal/v1/fine-tunes");
    const headers = seen[0]!.init!.headers as Record<string, string>;
    expect(headers["authorization"]).toBe("Bearer tk-secret");
    const body = JSON.parse(String(seen[0]!.init!.body)) as Record<string, unknown>;
    expect(body["model"]).toBe("base-7b");
    expect(body["n_epochs"]).toBe(3);
    expect(body["lora"]).toBe(true);
  });

  it("EVERY http call goes through the INJECTED fetch — which is how the egress guard applies", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ status: "running", progress: 0.4 }), { status: 200 }),
    ) as unknown as typeof fetch;
    const backend = new RemoteTrainingBackend({ backend: "together", apiKey: "k", fetchImpl });
    const report = await backend.pollJob({ backend: "together", jobId: "j", externalJobId: "ft-9" });
    expect(report).toEqual({ status: "running", progress: 0.4 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("an UNRECOGNISED vendor status is a FAILURE, never a forever-running job", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ status: "quantum_superposition" }), { status: 200 }),
    ) as unknown as typeof fetch;
    const backend = new RemoteTrainingBackend({ backend: "together", apiKey: "k", fetchImpl });
    const report = await backend.pollJob({ backend: "together", jobId: "j", externalJobId: "ft-9" });
    expect(report.status).toBe("failed");
    expect(report.error).toMatch(/unrecognised status/);
  });

  it("an upstream error is surfaced with its body, as a 502 — not swallowed", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("no quota left", { status: 402 }),
    ) as unknown as typeof fetch;
    const backend = new RemoteTrainingBackend({ backend: "together", apiKey: "k", fetchImpl });
    await expect(
      backend.pollJob({ backend: "together", jobId: "j", externalJobId: "ft-9" }),
    ).rejects.toMatchObject({ code: "upstream_error", status: 502 });
  });

  it("a job accepted with no id to poll is a failure, not a silent success", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
    const backend = new RemoteTrainingBackend({ backend: "together", apiKey: "k", fetchImpl });
    await expect(
      backend.startJob({
        jobId: "j",
        name: "n",
        method: "lora_sft",
        baseModel: "b",
        hyperparameters: {},
        rows: SUPPORT_CORPUS,
        format: "prompt_completion",
      }),
    ).rejects.toMatchObject({ code: "upstream_error" });
  });

  it("a remote artifact is a REFERENCE and says so — it is never claimed to be queryable", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ status: "completed", output_name: "org/tuned-7b" }), { status: 200 }),
    ) as unknown as typeof fetch;
    const backend = new RemoteTrainingBackend({ backend: "together", apiKey: "k", fetchImpl });
    const artifact = await backend.fetchArtifact({ backend: "together", jobId: "j", externalJobId: "ft-9" });
    expect(artifact.kind).toBe("remote");
    expect(artifact.location).toBe("org/tuned-7b");
    expect(artifact.payload).toBeUndefined();
    expect(String(artifact.metrics["note"])).toMatch(/cannot query this artifact locally/);
  });
});

describe("the registry", () => {
  it("resolves every declared kind, and the two in-process ones are shared instances", () => {
    expect(resolveTrainingBackend({ backend: "local" })).toBe(resolveTrainingBackend({ backend: "local" }));
    expect(resolveTrainingBackend({ backend: "mock" }).capabilities.kind).toBe("mock");
    expect(resolveTrainingBackend({ backend: "vertex" }).capabilities.kind).toBe("vertex");
  });

  it("every entry carries a non-empty honest limits string", () => {
    const registry = trainingBackendRegistry();
    expect(registry).toHaveLength(6);
    for (const c of registry) {
      expect(c.limits.length).toBeGreaterThan(30);
      expect(c.summary.length).toBeGreaterThan(10);
    }
  });

  it("names the compiled default endpoint of each remote backend, and NULL for in-process ones", () => {
    expect(defaultTrainingBaseUrl("local")).toBeNull();
    expect(defaultTrainingBaseUrl("mock")).toBeNull();
    expect(defaultTrainingBaseUrl("together")).toMatch(/^https:\/\//);
    expect(defaultTrainingBaseUrl("bedrock")).toMatch(/^https:\/\//);
  });
});

describe("the MOCK backend mirrors the model-provider mock", () => {
  it("runs the whole lifecycle and marks its metrics as mock", async () => {
    const backend = new MockTrainingBackend(2);
    const handle = await backend.startJob({
      jobId: "m1",
      name: "n",
      method: "lora_sft",
      baseModel: "b",
      hyperparameters: {},
      rows: SUPPORT_CORPUS,
      format: "prompt_completion",
    });
    expect((await backend.pollJob(handle)).status).toBe("running");
    expect((await backend.pollJob(handle)).status).toBe("succeeded");
    const artifact = await backend.fetchArtifact(handle);
    expect(artifact.metrics["mock"]).toBe(true);
  });

  it("cancel is honoured and reported", async () => {
    const backend = new MockTrainingBackend(5);
    const handle = await backend.startJob({
      jobId: "m2",
      name: "n",
      method: "lora_sft",
      baseModel: "b",
      hyperparameters: {},
      rows: SUPPORT_CORPUS,
      format: "prompt_completion",
    });
    await backend.cancelJob(handle);
    expect((await backend.pollJob(handle)).status).toBe("cancelled");
  });
});

describe("serving an artifact as an ordinary ModelProvider", () => {
  const index = buildRetrievalIndex(SUPPORT_CORPUS, { topK: 3 });

  it("answers a dispatch from the training data", async () => {
    const provider = new ArtifactModelProvider({
      id: "art-1",
      name: "support-kb",
      method: "retrieval_index",
      payload: index,
    });
    const res = await provider.dispatch({ model: "support-kb", input: "how do I invite a teammate?" });
    expect(res.outputText).toContain("Members");
    expect(res.stopReason).toBe("end_turn");
    expect(res.usage.inputTokens).toBeGreaterThan(0);
    expect(res.providerMessageId).toBe("regulait-llm:art-1");
  });

  it("uses the NEWEST user turn of a multi-turn history, like every other adapter", async () => {
    const provider = new ArtifactModelProvider({ id: "a", name: "kb", method: "retrieval_index", payload: index });
    const res = await provider.dispatch({
      model: "kb",
      input: "ignored",
      messages: [
        { role: "user", content: "what is the refund window" },
        { role: "assistant", content: "…" },
        { role: "user", content: "where do I download an invoice as a pdf" },
      ],
    });
    expect(res.outputText).toContain("PDF");
  });

  it("SAYS SO when the corpus cannot answer — no least-bad row is passed off as an answer", async () => {
    const provider = new ArtifactModelProvider({ id: "a", name: "kb", method: "retrieval_index", payload: index });
    const res = await provider.dispatch({ model: "kb", input: "zzzz qqqq" });
    expect(res.outputText).toMatch(/no answer/i);
    expect(res.refusal).toBe(false);
  });

  it("refuses tools / structured output rather than silently ignoring them", async () => {
    const provider = new ArtifactModelProvider({ id: "a", name: "kb", method: "retrieval_index", payload: index });
    await expect(
      provider.dispatch({ model: "kb", input: "x", tools: [{ name: "t", inputSchema: {} }] }),
    ).rejects.toBeInstanceOf(TrainingBackendError);
    await expect(
      provider.dispatch({ model: "kb", input: "x", responseFormat: { type: "json_object" } }),
    ).rejects.toBeInstanceOf(TrainingBackendError);
  });

  it("an unqueryable payload kind is refused, never guessed at", () => {
    expect(() => queryArtifact({ kind: "something_else" }, "q")).toThrow(TrainingBackendError);
  });
});
