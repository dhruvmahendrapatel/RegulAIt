import { describe, expect, it } from "vitest";
import { semanticDlpDetector } from "./guardrails.js";

// Synthetic-only corpus. A detector match is a lead, not proof a credential is live.
const corpus = [
  { name: "AWS access key", text: "AKIAABCDEFGHIJKLMNOP", secret: true },
  { name: "provider token", text: `sk-${"A".repeat(24)}`, secret: true },
  { name: "GitHub token", text: `ghp_${"a".repeat(24)}`, secret: true },
  { name: "RegulAIt token", text: `rgl_${"a".repeat(32)}`, secret: true },
  { name: "assigned password", text: "password=correct-horse-battery-staple", secret: true },
  { name: "short assignment", text: "password=short", secret: false },
  { name: "AWS-shaped near miss", text: "AKIAABCDEFGHIJKLMNO", secret: false },
  { name: "ordinary UUID", text: "550e8400-e29b-41d4-a716-446655440000", secret: false },
  { name: "ordinary prose", text: "The deployment finished at noon.", secret: false },
  { name: "public URL", text: "https://example.test/path/to/document", secret: false },
] as const;

describe("outbound credential-material detection baseline", () => {
  it("reports the synthetic confusion matrix and pins rule-family behavior", () => {
    const results = corpus.map(({ name, text, secret }) => ({
      name,
      secret,
      detected: semanticDlpDetector.detect(text).some((hit) => hit.category === "credential_material"),
    }));
    const matrix = {
      truePositive: results.filter((r) => r.secret && r.detected).length,
      falsePositive: results.filter((r) => !r.secret && r.detected).length,
      falseNegative: results.filter((r) => r.secret && !r.detected).length,
      trueNegative: results.filter((r) => !r.secret && !r.detected).length,
    };
    expect(matrix).toEqual({ truePositive: 5, falsePositive: 0, falseNegative: 0, trueNegative: 5 });
  });

  it("makes known misses explicit instead of presenting the sample as general recall", () => {
    const unknownServiceToken = "tkn_example_verylongopaquevalue123456789";
    expect(semanticDlpDetector.detect(unknownServiceToken)).toEqual([]);
    expect(semanticDlpDetector.detect("password=short")).toEqual([]);
  });
});
