import { describe, expect, it } from "vitest";
import { findSimilar, tokens } from "./similarUseCases";

const existing = [
  { id: "a", name: "Support ticket summarizer", description: "Summarizes inbound support tickets for the queue." },
  { id: "b", name: "Credit-limit-increase assistant", description: "Recommends credit-limit increases with human review." },
  { id: "c", name: "HR hiring chatbot", description: "Answers candidate questions about open roles." },
  { id: "d", name: "Fraud detection model", description: null },
];

describe("ADR-0168 duplicate detection on the registration form", () => {
  it("compares words, not characters: lowercase, stop-words dropped, plurals folded", () => {
    expect([...tokens("The Support Tickets for AI use cases")]).toEqual(["support", "ticket"]);
    expect([...tokens("")]).toEqual([]);
    expect([...tokens(null)]).toEqual([]);
  });

  it("finds the obvious duplicate first and leaves unrelated records out", () => {
    const found = findSimilar({ name: "Summarize support tickets", description: "Drafts a summary of each support ticket." }, existing);
    expect(found.map((m) => m.useCase.id)).toEqual(["a"]);
    expect(found[0]!.shared).toContain("support");
  });

  it("weights a shared word in the name above a shared word in the purpose", () => {
    const found = findSimilar(
      { name: "Credit assistant", description: "Answers candidate questions about open roles." },
      existing,
      { threshold: 0 },
    );
    expect(found.map((m) => m.useCase.id)).toEqual(["b", "c"]);
  });

  it("says nothing until there are two words to compare", () => {
    expect(findSimilar({ name: "Support", description: "" }, existing)).toEqual([]);
    expect(findSimilar({ name: "", description: "" }, existing)).toEqual([]);
  });

  it("never lists the record this form already created, and caps the list", () => {
    const draft = { name: "Support ticket summarizer", description: "" };
    expect(findSimilar(draft, existing).map((m) => m.useCase.id)).toEqual(["a"]);
    expect(findSimilar(draft, existing, { excludeIds: ["a"] })).toEqual([]);
    const many = Array.from({ length: 20 }, (_, i) => ({ id: `x${i}`, name: `Support ticket bot ${i}`, description: "" }));
    expect(findSimilar(draft, many)).toHaveLength(8);
  });
});
