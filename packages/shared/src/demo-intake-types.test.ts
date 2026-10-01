import { describe, expect, it } from "vitest";
import { AI_USE_CASE_DATA_SENSITIVITIES } from "./index.js";
import { DEMO_DATA_SENSITIVITIES } from "./demo-intake-types.js";

describe("demo fixture contract", () => {
  it("mirrors the API's data-sensitivity enum exactly", () => {
    expect([...DEMO_DATA_SENSITIVITIES]).toEqual([...AI_USE_CASE_DATA_SENSITIVITIES]);
  });
});
