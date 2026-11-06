/**
 * ADR-0205 (review of #611): the setup assistant parses a model's reply with indexOf/lastIndexOf, never a regex over
 * the reply (CodeQL js/polynomial-redos). A wall-clock budget, so it runs in the serialized `timing` project.
 */
import { expect, it } from "vitest";
import { parseAgentSetupReply } from "./agent-setup-assist.js";

it("rejects a 200k hostile reply (a fence and spaces) in linear time", () => {
  const started = performance.now();
  expect(parseAgentSetupReply("```" + " ".repeat(200_000))).toBeNull();
  expect(performance.now() - started).toBeLessThan(2_000);
});
