import { describe, expect, it } from "vitest";
import { absoluteLink, claimWords, fieldsFor, publishBlockers, tokenFromHash } from "./trustModel";

describe("trust model", () => {
  it("finds the claim words the gateway refuses, and passes factual text", () => {
    expect(claimWords("We are certified and fully compliant")).toEqual(["certified", "compliant"]);
    expect(claimWords("Quarterly access certification; 12 evidence records")).toEqual([]);
  });

  it("lists what blocks publishing: empty fields by label, then claim words", () => {
    const content = { purpose: "x", limits: "", oversight: "We guarantee review", dataUse: "y", evaluationSummary: "z" };
    expect(publishBlockers({ kind: "ai_card", title: "T", content })).toEqual([
      "Fill in: Known limits.",
      "Reword the claim words: guarantee. Trust pages state facts, never a certification or compliance.",
    ]);
    expect(publishBlockers({ kind: "control", title: "T", content: { statement: "a", evidenceSummary: "b" } })).toEqual([]);
  });

  it("card and control fields", () => {
    expect(fieldsFor("ai_card")).toEqual(["purpose", "limits", "oversight", "dataUse", "evaluationSummary"]);
    expect(fieldsFor("evidence_summary")).toEqual(["statement", "evidenceSummary"]);
  });

  it("reads the sign-in token only from a well-formed fragment", () => {
    const t = `rgal_${"a".repeat(64)}`;
    expect(tokenFromHash(`#${t}`)).toBe(t);
    expect(tokenFromHash("#rgal_short")).toBeNull();
    expect(tokenFromHash("")).toBeNull();
  });

  it("builds the copyable link from the page origin", () => {
    expect(absoluteLink("https://regulait.<domain>/", "/ui/audit#x")).toBe("https://regulait.<domain>/ui/audit#x");
  });
});
