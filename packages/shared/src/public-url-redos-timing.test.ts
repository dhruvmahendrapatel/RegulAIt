/**
 * ADR-0188 S7 (review of #380): REGULAIT_PUBLIC_URL's trailing slashes are trimmed by a bounded loop, never a
 * repeating regex (CodeQL js/polynomial-redos). A wall-clock budget, so it runs in the serialized `timing` project.
 */
import { expect, it } from "vitest";
import { parsePublicUrl } from "./public-url.js";

it("trims a 200k run of trailing slashes in linear time", () => {
  const started = performance.now();
  expect(parsePublicUrl(`https://host.example/base${"/".repeat(200_000)}`)).toBe("https://host.example/base");
  expect(performance.now() - started).toBeLessThan(2_000);
});
