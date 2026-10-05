/**
 * CodeQL js/polynomial-redos (PR #117) — the mock provider's test triggers.
 *
 * The mock ships in the gateway image, and every trigger below is parsed out of
 * the caller's prompt, so a prompt is attacker-controlled input to them. Each
 * scan used to be a regex that backtracks quadratically on the input CodeQL
 * named; each is now a linear index scan in `./sentinels.ts`.
 *
 * Two kinds of test per scan:
 * - TIMING: the pathological input from the alert at 50k repetitions must
 *   finish well under 100 ms (the old regexes took seconds on it).
 * - EQUIVALENCE: the replacement agrees with the old regex, kept here as the
 *   oracle, on thousands of short random strings over the characters that
 *   matter. Short strings keep the oracle itself fast.
 */
import { describe, expect, it } from "vitest";
import { MockModelProvider, TASK_DECOMPOSITION_SENTINEL } from "./index.js";
import { findSentinel, stripSentinels, trimTrailingPunctuation } from "./sentinels.js";

const REPS = 50_000;
const BUDGET_MS = 100;

// Best of three: a shared CI runner (other packages' suites run in parallel)
// can stall one run past the budget; noise only ever ADDS time, so the minimum
// is the honest measure. A quadratic regression takes seconds on these inputs
// and still fails all three.
const TIMING_RUNS = 3;

function timed(fn: () => unknown): number {
  let best = Infinity;
  for (let i = 0; i < TIMING_RUNS; i++) {
    const start = performance.now();
    fn();
    best = Math.min(best, performance.now() - start);
  }
  return best;
}

async function timedAsync(fn: () => Promise<unknown>): Promise<number> {
  let best = Infinity;
  for (let i = 0; i < TIMING_RUNS; i++) {
    const start = performance.now();
    await fn();
    best = Math.min(best, performance.now() - start);
  }
  return best;
}

/** deterministic PRNG (mulberry32) so a failing case reproduces */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomStrings(alphabet: readonly string[], count: number, maxParts: number, seed: number): string[] {
  const next = rng(seed);
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const parts = Math.floor(next() * (maxParts + 1));
    let s = "";
    for (let j = 0; j < parts; j++) s += alphabet[Math.floor(next() * alphabet.length)]!;
    out.push(s);
  }
  return out;
}

const notGt = (c: string) => c !== ">";
const notGtOrSpace = (c: string) => c !== ">" && !/\s/.test(c);

describe("stripSentinels — was `.replace(/<<[^>]*>>/g, ' ')`", () => {
  const legacy = (s: string) => s.replace(/<<[^>]*>>/g, " ");

  it("is linear on '<<' repeated", () => {
    const input = "<<".repeat(REPS);
    expect(timed(() => stripSentinels(input))).toBeLessThan(BUDGET_MS);
    expect(stripSentinels(input)).toBe(input);
  });

  it("agrees with the old regex", () => {
    for (const s of randomStrings(["<", "<<", ">", ">>", "a", " ", "-"], 5000, 12, 1)) {
      expect(stripSentinels(s), JSON.stringify(s)).toBe(legacy(s));
    }
    expect(stripSentinels("plan <<rogueagent>> the <<>> api")).toBe("plan   the   api");
  });
});

describe("findSentinel — was `/<<serve-as:([^>\\s]+)>>/` and `/<<upstream-error:([^>]+)>>/`", () => {
  const cases = [
    { prefix: "<<serve-as:", isValueChar: notGtOrSpace, legacy: /<<serve-as:([^>\s]+)>>/ },
    { prefix: "<<upstream-error:", isValueChar: notGt, legacy: /<<upstream-error:([^>]+)>>/ },
  ];

  for (const { prefix, isValueChar, legacy } of cases) {
    it(`is linear on '${prefix}' repeated`, () => {
      const input = prefix.repeat(REPS);
      expect(timed(() => findSentinel(input, prefix, isValueChar))).toBeLessThan(BUDGET_MS);
      expect(findSentinel(input, prefix, isValueChar)).toBeNull();
    });

    it(`agrees with ${String(legacy)}`, () => {
      const alphabet = [prefix, "<", "<<", ">", ">>", "m", "x-1", " ", "\t", " ", ":"];
      for (const s of randomStrings(alphabet, 5000, 10, prefix.length)) {
        const m = legacy.exec(s);
        expect(findSentinel(s, prefix, isValueChar), JSON.stringify(s)).toEqual(m ? m[1] : null);
      }
    });
  }
});

describe("trimTrailingPunctuation — was `.replace(/[.?!,;:\\s]+$/, '')`", () => {
  const legacy = (s: string) => s.replace(/[.?!,;:\s]+$/, "");

  it("is linear on tabs repeated before a final character", () => {
    const input = "\t".repeat(REPS) + "x";
    expect(timed(() => trimTrailingPunctuation(input))).toBeLessThan(BUDGET_MS);
    expect(trimTrailingPunctuation(input)).toBe(input);
    // the same shape with punctuation, which (unlike tabs) survives mockTopic's
    // whitespace collapse and so reaches this scan through a prompt
    const dots = ".".repeat(REPS) + "x";
    expect(timed(() => trimTrailingPunctuation(dots))).toBeLessThan(BUDGET_MS);
    expect(trimTrailingPunctuation(dots + " ?!")).toBe(dots);
  });

  it("agrees with the old regex", () => {
    for (const s of randomStrings([".", "?", "!", ",", ";", ":", " ", "\t", "\n", " ", "a", "-"], 5000, 10, 7)) {
      expect(trimTrailingPunctuation(s), JSON.stringify(s)).toBe(legacy(s));
    }
  });
});

describe("the mock provider stays fast on the pathological prompts", () => {
  const prompts: Array<[string, string]> = [
    ["'<<serve-as:' repeated", "<<serve-as:".repeat(REPS)],
    ["'<<upstream-error:' repeated", "<<upstream-error:".repeat(REPS)],
    ["'<<' repeated", "<<".repeat(REPS)],
    ["'.' repeated before a final character", "summarize " + ".".repeat(REPS) + "x"],
  ];

  for (const [name, input] of prompts) {
    it(`plain dispatch: ${name}`, async () => {
      const p = new MockModelProvider();
      // generous: the whole canned dispatch, not just the scan — the old
      // regexes alone took seconds on these
      expect(await timedAsync(() => p.dispatch({ model: "fast-mock", input }))).toBeLessThan(1000);
    });

    it(`plan dispatch: ${name}`, async () => {
      const p = new MockModelProvider();
      const system = `${TASK_DECOMPOSITION_SENTINEL}\n- fast-mock (tier 0, $1 in / $5 out per MTok)`;
      expect(await timedAsync(() => p.dispatch({ model: "fast-mock", input, system }))).toBeLessThan(1000);
    });
  }

  it("still honours the triggers", async () => {
    const p = new MockModelProvider();
    const served = await p.dispatch({ model: "fast-mock", input: "hi <<serve-as:other-model>>" });
    expect(served.servedModel).toBe("other-model");
    const plain = await p.dispatch({ model: "fast-mock", input: "hi <<serve-as:>> there" });
    expect(plain.servedModel).toBe("fast-mock");
    await expect(p.dispatch({ model: "m1", input: "go <<upstream-error: m1 >>" })).rejects.toThrow(/simulated upstream/);
    await expect(p.dispatch({ model: "m2", input: "go <<upstream-error:m1>>" })).resolves.toBeTruthy();
    await expect(p.dispatch({ model: "m2", input: "go <<upstream-error>>" })).rejects.toThrow(/simulated upstream/);
  });
});
