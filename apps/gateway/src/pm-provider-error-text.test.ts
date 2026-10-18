/**
 * ADR-0167 N8 S4 (#413 recheck L2) — a provider's refusal text is bounded and
 * scrubbed before pm.ts stores it in an audit row or returns it. The source
 * scan in log-error-text.test.ts cannot see this path (the text is neither in a
 * log call nor an assignment), so it is pinned here, offline.
 */
import { PmProviderError } from "@regulait/pm-provider";
import { describe, expect, it } from "vitest";
import { PROVIDER_TEXT_MAX, providerErrorText } from "./pm.js";

describe("providerErrorText", () => {
  it("cuts a long provider message to the bound and scrubs a query credential", () => {
    const marker = "synthetic-pm-token-4f1c";
    const err = new PmProviderError(`work item refused: GET /items?access_token=${marker} ${"x".repeat(400)}`, 400);
    const out = providerErrorText(err);
    expect(out.length).toBeLessThanOrEqual(PROVIDER_TEXT_MAX);
    expect(PROVIDER_TEXT_MAX).toBe(300);
    expect(out).not.toContain(marker);
    expect(out).toContain("access_token=[redacted]");
  });

  it("keeps a short message without a credential as it is", () => {
    expect(providerErrorText(new PmProviderError("work item 42 not found", 404))).toBe("work item 42 not found");
  });
});
