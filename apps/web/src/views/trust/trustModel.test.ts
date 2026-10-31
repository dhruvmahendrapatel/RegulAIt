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

// the SPA does not depend on @regulait/shared, so the gateway's guard is loaded from source here (as bomModel.test.ts does)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sharedTrust = async (): Promise<any> =>
  import(/* @vite-ignore */ new URL("../../../../../packages/shared/src/trust-pages.ts", import.meta.url).pathname);

describe("the claim words match the gateway's guard (review of #631)", () => {
  const corpus = [
    "We are ISO 27001 certified.",
    "We hold ISO 27001 certification.",
    "Our SOC 2 certificate is available on request.",
    "The service conforms to ISO/IEC 42001.",
    "This process ensures compliance with the Act.",
    "The system meets the requirements of Article 9.",
    "Fully compliant and accredited; we guarantee review.",
    "In compliance with the regulation.",
    "Certificate rotation runs every 30 days; 4 evidence records on file.",
    "Quarterly access certification campaigns; 12 evidence records.",
    "Approved through the organisation's AI review on 2026-10-30.",
    "A certificate of conformity was issued.",
    "We achieved the HITRUST certification last year.",
  ];
  it("every sentence gives the same words in the SPA and the gateway", async () => {
    const s = await sharedTrust();
    for (const text of corpus) expect(claimWords(text), text).toEqual(s.claimWordingProblems(text));
  });
  it("the factual sentences pass and the claims are caught", () => {
    expect(claimWords("Certificate rotation runs every 30 days; 4 evidence records on file.")).toEqual([]);
    expect(claimWords("Quarterly access certification campaigns; 12 evidence records.")).toEqual([]);
    for (const text of corpus.slice(0, 8)) expect(claimWords(text).length, text).toBeGreaterThan(0);
  });
});
