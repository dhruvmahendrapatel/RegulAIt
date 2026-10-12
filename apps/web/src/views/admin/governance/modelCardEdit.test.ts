import { describe, expect, it } from "vitest";
import { cardPatch, draftOfCard, type EditableCard } from "./modelCardEdit";

const card: EditableCard = {
  intendedUse: "summarize tickets",
  limitations: "English only",
  note: null,
  dataClaims: { retention: "30 days", training: "none" },
  standardRefs: ["nist-ai-rmf:MAP-1.1"],
  pinnedModelVersion: null,
  agentId: "a1",
};

describe("cardPatch", () => {
  it("sends nothing for an untouched draft", () => {
    expect(cardPatch(card, draftOfCard(card))).toEqual({ body: {}, problems: [] });
  });

  it("sends only the edited fields", () => {
    const d = { ...draftOfCard(card), intendedUse: "triage tickets", standardRefs: "nist-ai-rmf:MAP-1.1, iso-42001:8.3" };
    expect(cardPatch(card, d)).toEqual({ body: { intendedUse: "triage tickets", standardRefs: ["nist-ai-rmf:MAP-1.1", "iso-42001:8.3"] }, problems: [] });
  });

  it("clears an optional text as null, and refuses an empty intended use", () => {
    const d = { ...draftOfCard(card), limitations: "  ", intendedUse: "" };
    const out = cardPatch(card, d);
    expect(out.body).toEqual({ limitations: null });
    expect(out.problems).toEqual(["Intended use is required."]);
  });

  it("treats re-ordered data claims as unchanged and rejects a non-object", () => {
    expect(cardPatch(card, { ...draftOfCard(card), dataClaims: '{"training":"none","retention":"30 days"}' }).body).toEqual({});
    expect(cardPatch(card, { ...draftOfCard(card), dataClaims: "[1]" }).problems[0]).toMatch(/JSON object/);
    expect(cardPatch(card, { ...draftOfCard(card), dataClaims: "{" }).problems[0]).toMatch(/not valid JSON/);
    expect(cardPatch(card, { ...draftOfCard(card), dataClaims: "" }).body).toEqual({ dataClaims: {} });
  });

  it("pins and unpins a model version, never on a card without an agent", () => {
    expect(cardPatch(card, { ...draftOfCard(card), pinnedModelVersion: "model-2026-01" }).body).toEqual({ pinnedModelVersion: "model-2026-01" });
    const pinned = { ...card, pinnedModelVersion: "model-2026-01" };
    expect(cardPatch(pinned, { ...draftOfCard(pinned), pinnedModelVersion: "" }).body).toEqual({ pinnedModelVersion: null });
    const provider = { ...card, agentId: null };
    expect(cardPatch(provider, { ...draftOfCard(provider), pinnedModelVersion: "x" }).problems).toHaveLength(1);
  });
});
