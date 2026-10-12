import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { EXPECTED_SERVED_MODEL_MAX, expectedServedModelBody } from "./ExpectedServedModelCard";

describe("expected served model", () => {
  it("sends a trimmed id, or null to clear back to the configured model", () => {
    expect(expectedServedModelBody("  gpt-4o-2024-08-06 ")).toEqual({ body: { expectedServedModel: "gpt-4o-2024-08-06" } });
    expect(expectedServedModelBody("   ")).toEqual({ body: { expectedServedModel: null } });
    expect(expectedServedModelBody("x".repeat(EXPECTED_SERVED_MODEL_MAX + 1))).toHaveProperty("error");
  });

  it("matches setExpectedServedModelSchema", () => {
    const shared = readFileSync(new URL("../../../../../../packages/shared/src/index.ts", import.meta.url), "utf8");
    expect(shared).toContain(`expectedServedModel: z.string().trim().min(1).max(${EXPECTED_SERVED_MODEL_MAX}).nullable()`);
  });
});
