/**
 * ADR-0346 — the prompt-template scanner is linear (no regex on caller input, M-074). A wall-clock budget, so this file
 * runs in the serialized `timing` project (vitest.config.ts TIMING_FILES).
 */
import { expect, it } from "vitest";
import { parsePromptTemplate } from "./fairness-evaluation.js";

it("parses a hostile template of unclosed and empty placeholders well inside the budget", () => {
  const t0 = performance.now();
  expect(parsePromptTemplate("{{".repeat(4000))).toBeNull();
  expect(parsePromptTemplate("{{}}".repeat(2000))).toBeNull();
  expect(performance.now() - t0).toBeLessThan(500);
});
