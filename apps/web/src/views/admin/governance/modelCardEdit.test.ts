import { describe, expect, it } from "vitest";
import { CARD_EDIT_REFUSALS, cardPatch, draftOfCard, isRedacted, redactedFields, type EditableCard } from "./modelCardEdit";

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

  it("never re-sends a field the presentation scrub masked, unless the person replaced it", () => {
    const MASK = "[redacted:aws_key:20:1a5d44a2dca1]";
    const masked: EditableCard = { ...card, limitations: `uses key ${MASK}`, dataClaims: { secret: MASK }, note: `see ${MASK}` };
    expect(redactedFields(masked)).toEqual(["limitations", "note", "dataClaims"]);
    expect(isRedacted("plain text")).toBe(false);
    // untouched: an edit elsewhere sends only that field, never the masks
    const d = { ...draftOfCard(masked), intendedUse: "triage tickets" };
    expect(cardPatch(masked, d)).toEqual({ body: { intendedUse: "triage tickets" }, problems: [] });
    // an edit that keeps the mask would write it over the original: refused, not sent
    const kept = cardPatch(masked, { ...draftOfCard(masked), limitations: `now uses key ${MASK}` });
    expect(kept.body).toEqual({});
    expect(kept.problems).toEqual(["Known limitations still contains redacted text. Replace the whole field, or leave it unchanged to keep the stored value."]);
    // replacing the whole field is sent as typed
    expect(cardPatch(masked, { ...draftOfCard(masked), note: "rotated; no key here" }).body).toEqual({ note: "rotated; no key here" });
    expect(cardPatch(masked, { ...draftOfCard(masked), limitations: "" }).body).toEqual({ limitations: null });
  });

  it("names a duplicate (model, intended use) and a generic conflict in words", () => {
    expect(CARD_EDIT_REFUSALS.model_card_exists).toMatch(/Another card for this model already has that intended use/);
    expect(CARD_EDIT_REFUSALS.conflict).toBeTruthy();
    // the gateway refuses a scrub marker in any card text field (PATCH and POST): a sentence, not the raw code
    expect(CARD_EDIT_REFUSALS.redacted_text_refused).toMatch(/redacted text/);
  });

  it("pins and unpins a model version, never on a card without an agent", () => {
    expect(cardPatch(card, { ...draftOfCard(card), pinnedModelVersion: "model-2026-01" }).body).toEqual({ pinnedModelVersion: "model-2026-01" });
    const pinned = { ...card, pinnedModelVersion: "model-2026-01" };
    expect(cardPatch(pinned, { ...draftOfCard(pinned), pinnedModelVersion: "" }).body).toEqual({ pinnedModelVersion: null });
    const provider = { ...card, agentId: null };
    expect(cardPatch(provider, { ...draftOfCard(provider), pinnedModelVersion: "x" }).problems).toHaveLength(1);
  });
});
