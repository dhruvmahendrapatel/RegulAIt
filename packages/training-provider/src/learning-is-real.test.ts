/**
 * INDEPENDENT adversarial check, written by the reviewing session, not the author.
 * The question is not "do the author's tests pass" but "could a stub pass them".
 * A real learner must do BOTH; a stub can only ever do one:
 *   1. generalize to inputs it never saw, when the data carries signal
 *   2. FAIL to generalize when the labels are noise
 * Memorization passes (1) and fails (2). Constant weights fail (1).
 * The split is held by THIS file, so accuracy is not the author's number.
 */
import { describe, it, expect } from "vitest";
import { trainTextClassifier, classifyText, buildRetrievalIndex, queryRetrievalIndex } from "@regulait/training-provider";

const HP = { epochs: 80, learningRate: 0.5, l2: 0.0001, maxVocabulary: 5000 };

function corpus(signal: boolean) {
  const rows: Array<{ input: string; output: string }> = [];
  const pos = ["refund", "chargeback", "invoice", "billing", "payment"];
  const neg = ["latency", "timeout", "crash", "outage", "bug"];
  for (let i = 0; i < 60; i++) {
    const p = pos[i % pos.length]!, n = neg[i % neg.length]!;
    rows.push({ input: `customer asks about ${p} number ${i}`, output: signal ? "billing" : (i % 2 ? "billing" : "support") });
    rows.push({ input: `service had a ${n} at hour ${i}`, output: signal ? "support" : (i % 2 ? "support" : "billing") });
  }
  return rows;
}

/** train on the first 80%, score the last 20% — a split I choose, not the author */
function heldOutAccuracy(signal: boolean): number {
  const rows = corpus(signal);
  const cut = Math.floor(rows.length * 0.8);
  const trainIdx = [...Array(cut).keys()];
  const model = trainTextClassifier(rows, { trainIdx, hyperparameters: HP });
  let ok = 0;
  for (let i = cut; i < rows.length; i++) {
    if (classifyText(model, rows[i]!.input).label === rows[i]!.output) ok++;
  }
  return ok / (rows.length - cut);
}

describe("ADVERSARIAL: the classifier learns rather than memorizes", () => {
  it("generalizes on SIGNAL to sentences that appear nowhere in training", () => {
    const rows = corpus(true);
    const model = trainTextClassifier(rows, { trainIdx: [...rows.keys()], hyperparameters: HP });
    const unseen: Array<[string, string]> = [
      ["please help me with this billing invoice", "billing"],
      ["there was a crash and an outage last night", "support"],
      ["i need a refund for my payment", "billing"],
      ["the timeout caused a bug", "support"],
    ];
    for (const [q, want] of unseen) expect(classifyText(model, q).label).toBe(want);
  });

  it("scores near CHANCE on noise — a memorizer would score high on both", () => {
    const s = heldOutAccuracy(true);
    const n = heldOutAccuracy(false);
    expect(s).toBeGreaterThan(0.9);
    expect(n).toBeLessThan(0.75);
    expect(s - n).toBeGreaterThan(0.2);
  });

  it("the loss curve descends monotonically-ish — fixed weights cannot", () => {
    const rows = corpus(true);
    const m = trainTextClassifier(rows, { trainIdx: [...rows.keys()], hyperparameters: HP });
    expect(m.lossCurve.length).toBe(HP.epochs);
    expect(m.lossCurve.at(-1)!).toBeLessThan(m.lossCurve[0]! * 0.5);
    expect(new Set(m.weights.flat()).size).toBeGreaterThan(10); // not constant
  });

  it("retrieval answers substantively and MISSES honestly", () => {
    const idx = buildRetrievalIndex([
      { input: "how do I rotate the data key", output: "Set REGULAIT_DATA_KEY_ROTATED_FROM and restart." },
      { input: "how do I enable the scheduler", output: "Set REGULAIT_SCHEDULER=on." },
    ]);
    const hit = queryRetrievalIndex(idx, "enable the scheduler");
    expect(hit.matches.length).toBeGreaterThan(0);
    expect(hit.answer).toContain("REGULAIT_SCHEDULER");
    const miss = queryRetrievalIndex(idx, "zzz quantum bicycle photosynthesis");
    expect(miss.matches.length).toBe(0);
  });
});
