import { describe, expect, it } from "vitest";
import { fencedBlockBody, firstBraceBlock, trimTrailingSlashes } from "./linear-scan.js";
import { parseRecommendationJudgeReplies } from "./access-recommendations.js";
import { parseNarration } from "./copilot.js";
import { parseJudgeVerdict } from "./evals.js";
import { parseGroundednessVerdict } from "./groundedness.js";
import { findMcpEndpoints } from "./mcp-discovery.js";

// CodeQL js/polynomial-redos (ADR-0184). Each replaced regex took about 2 s on
// 50,000 characters and grows with the square of the input; every timing below
// uses 400,000, where the regexes take minutes.
const N = 400_000;
const within = (fn: () => unknown, ms = 1000) => {
  const t0 = performance.now();
  fn();
  expect(performance.now() - t0).toBeLessThan(ms);
};

// deterministic generator over an alphabet, so a failing case reproduces
function samples(alphabet: string[], seed: number, count: number, maxParts: number): string[] {
  let a = seed >>> 0;
  const next = () => (a = (a * 1103515245 + 12345) >>> 0) / 4294967296;
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    let s = "";
    for (let j = 0, n = Math.floor(next() * maxParts); j < n; j++) s += alphabet[Math.floor(next() * alphabet.length)]!;
    out.push(s);
  }
  return out;
}

describe("linear-scan helpers return exactly what the replaced regexes returned", () => {
  it("trimTrailingSlashes === s.replace(/\\/+$/, '')", () => {
    for (const s of ["", "/", "/mcp/", "/sse///", "a//b", ...samples(["/", "x", "?", " "], 3, 4000, 12)]) {
      expect(trimTrailingSlashes(s), JSON.stringify(s)).toBe(s.replace(/\/+$/, ""));
    }
  });

  const FENCE_ALPHABET = ["```", "`", "json", "JSON", "Json", "js", " ", "\n", "\t", " ", "x", "{", "}", '"a":1'];
  const representative = [
    "",
    '{"score": 4}',
    '```json\n{"score": 4}\n```',
    '```JSON\n{"score": 4}\n```',
    'Here you go:\n```\n{"a":1}\n```\nthanks',
    "```json```",
    "````json\n{}\n````",
    "```  \n  ```",
    "``` unclosed",
    "text ```json {} ``` more ``` {} ```",
  ];

  it("fencedBlockBody(text) === text.match(/```(?:json)?\\s*([\\s\\S]*?)```/)?.[1]", () => {
    for (const s of [...representative, ...samples(FENCE_ALPHABET, 5, 8000, 10)]) {
      expect(fencedBlockBody(s), JSON.stringify(s)).toBe(s.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1]);
    }
  });

  it("fencedBlockBody(text, true) === the /i form", () => {
    for (const s of [...representative, ...samples(FENCE_ALPHABET, 7, 8000, 10)]) {
      expect(fencedBlockBody(s, true), JSON.stringify(s)).toBe(s.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]);
    }
  });

  it("firstBraceBlock(text) === text.match(/\\{[\\s\\S]*\\}/)?.[0]", () => {
    const reps = ["", "{}", "}{", 'say {"a": {"b": 1}} ok', "{{{", "}}}", "a { b } c { d } e"];
    for (const s of [...reps, ...samples(["{", "}", "x", " ", "\n", '"'], 9, 8000, 12)]) {
      expect(firstBraceBlock(s), JSON.stringify(s)).toBe(s.match(/\{[\s\S]*\}/)?.[0]);
    }
  });
});

describe("the helpers and every caller are linear on pathological input", () => {
  it("the helpers", () => {
    within(() => trimTrailingSlashes("/".repeat(N) + "x"));
    within(() => fencedBlockBody("```" + " ".repeat(N)));
    within(() => fencedBlockBody("```json" + "\n".repeat(N), true));
    within(() => firstBraceBlock("{".repeat(N)));
  });

  it("access-recommendations: parseRecommendationJudgeReplies", () => {
    within(() => parseRecommendationJudgeReplies("```" + " ".repeat(N)));
  });

  it("copilot: parseNarration", () => {
    within(() => parseNarration("```" + " ".repeat(N)));
  });

  it("evals: parseJudgeVerdict (fenced block and first-brace fallback)", () => {
    within(() => parseJudgeVerdict("```" + " ".repeat(N), 0.5));
    within(() => parseJudgeVerdict("{{".repeat(N / 2), 0.5));
    const v = parseJudgeVerdict('The verdict:\n```json\n{"score": 0.9, "reason": "grounded"}\n```', 0.5);
    expect(v.ok).toBe(true);
  });

  it("groundedness: parseGroundednessVerdict (fenced block and first-brace fallback)", () => {
    within(() => parseGroundednessVerdict("```" + " ".repeat(N), 0.5));
    within(() => parseGroundednessVerdict("{{".repeat(N / 2), 0.5));
  });

  it("mcp-discovery: findMcpEndpoints on a path of slashes", () => {
    within(() => findMcpEndpoints("GET https://tools.example/" + "/".repeat(N) + "x 200"));
    const found = findMcpEndpoints("GET https://tools.example/mcp/// 200");
    expect(found.map((f) => f.path)).toEqual(["/mcp"]);
  });
});
