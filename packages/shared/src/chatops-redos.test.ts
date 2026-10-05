/**
 * CodeQL js/polynomial-redos (PR #117) — inbound chat text is attacker-controlled
 * (anyone who can post in a bound Slack channel or Teams conversation), and the
 * mention/tag stripping ran regexes that backtrack quadratically on it.
 *
 * TIMING: the pathological input from each alert, at 50k repetitions, must finish
 * well under 100 ms (the old regexes took seconds).
 * EQUIVALENCE: the new code agrees with the old implementation, kept below as the
 * oracle, on thousands of short random strings over the characters that matter.
 */
import { describe, expect, it } from "vitest";
import { stripSlackMentions, teamsPlainText } from "./chatops.js";

const REPS = 50_000;
const BUDGET_MS = 100;

function timed(fn: () => unknown): number {
  const start = performance.now();
  fn();
  return performance.now() - start;
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

/** the implementations CodeQL flagged, verbatim — the oracle */
const legacySlack = (text: string) =>
  text.replace(/<@[A-Z0-9]+(\|[^>]*)?>/gi, " ").replace(/\s+/g, " ").trim();
const legacyTeams = (html: string) =>
  html
    .replace(/<at>[\s\S]*?<\/at>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();

describe("stripSlackMentions — linear time", () => {
  it("'<@0|' repeated (the alert's input)", () => {
    const input = "<@0|".repeat(REPS);
    expect(timed(() => stripSlackMentions(input))).toBeLessThan(BUDGET_MS);
    expect(stripSlackMentions(input)).toBe(input);
  });

  it("'<@' and '<@U1' repeated", () => {
    for (const input of ["<@".repeat(REPS), "<@U1".repeat(REPS), "<@U1|<@U1".repeat(REPS)]) {
      expect(timed(() => stripSlackMentions(input))).toBeLessThan(BUDGET_MS);
    }
  });

  it("agrees with the old regex", () => {
    const alphabet = ["<@", "<", "@", "U1", "w", "|", ">", " ", "\n", "x", "ſ", "K"];
    for (const s of randomStrings(alphabet, 8000, 10, 11)) {
      expect(stripSlackMentions(s), JSON.stringify(s)).toBe(legacySlack(s));
    }
    expect(stripSlackMentions("<@U1|bot>  hello <@u2> there <@U3|a<b> x")).toBe("hello there x");
  });
});

describe("teamsPlainText — linear time", () => {
  const pathological: Array<[string, string]> = [
    ["'<at>' repeated (the alert's input)", "<at>".repeat(REPS)],
    ["'<AT>' repeated", "<AT>".repeat(REPS)],
    ["'<' repeated (tag strip)", "<".repeat(REPS)],
    ["'\\r' repeated (line-break collapse)", "\r".repeat(REPS) + "x"],
    ["'\\u00a0' repeated", " ".repeat(REPS) + "x"],
    ["'<br' repeated", "<br".repeat(REPS)],
  ];
  for (const [name, input] of pathological) {
    it(name, () => {
      expect(timed(() => teamsPlainText(input))).toBeLessThan(BUDGET_MS);
    });
  }

  it("agrees with the old implementation", () => {
    const alphabet = ["<at>", "</at>", "<AT>", "</At>", "<", ">", "<br/>", "<br", "/", "a", " ", "\t", "\n", "\r", "&nbsp;", "&amp;", "&lt;"];
    for (const s of randomStrings(alphabet, 8000, 10, 13)) {
      expect(teamsPlainText(s), JSON.stringify(s)).toBe(legacyTeams(s));
    }
    expect(teamsPlainText("<at>Bot</at> run <b>it</b><br/> now &amp; then")).toBe("run it\nnow & then");
  });
});
