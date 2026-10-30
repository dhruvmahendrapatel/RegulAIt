import { describe, expect, it } from "vitest";
import { hasModalityData, priceDispatchUsage, setAgentModalityPricingSchema } from "./modality-pricing.js";

const TEXT = { costPerMTokIn: 3, costPerMTokOut: 15 };
/** the pre-ADR-0212 formula, verbatim */
const legacy = (i: number, o: number) => (i / 1e6) * TEXT.costPerMTokIn + (o / 1e6) * TEXT.costPerMTokOut;

describe("ADR-0212 modality pricing", () => {
  it("prices each modality at its own price and records the split", () => {
    const out = priceDispatchUsage(
      { ...TEXT, costPerMTokImageIn: 10, costPerMTokAudioIn: 40, costPerMTokAudioOut: 80 },
      {
        inputTokens: 1_000_000,
        outputTokens: 500_000,
        modality: { image: { inputTokens: 200_000, outputTokens: 0 }, audio: { inputTokens: 100_000, outputTokens: 50_000 } },
      },
    );
    expect(out.modality).toEqual({
      text: { inputTokens: 700_000, outputTokens: 450_000, costUsd: 0.7 * 3 + 0.45 * 15 },
      image: { inputTokens: 200_000, outputTokens: 0, costUsd: 0.2 * 10 },
      audio: { inputTokens: 100_000, outputTokens: 50_000, costUsd: 0.1 * 40 + 0.05 * 80 },
    });
    expect(out.costUsd).toBeCloseTo(0.7 * 3 + 0.45 * 15 + 2 + 4 + 4, 10);
  });

  it("without modality data the cost is the pre-0212 formula to the bit, and no split is stored", () => {
    for (const modality of [undefined, null, {}, { image: { inputTokens: 0, outputTokens: 0 } }]) {
      const out = priceDispatchUsage(
        { ...TEXT, costPerMTokImageIn: 99 },
        { inputTokens: 123_457, outputTokens: 9_871, modality },
      );
      expect(out).toEqual({ costUsd: legacy(123_457, 9_871), modality: null });
    }
  });

  it("with a split but no modality prices the total is unchanged; the split only says where it went", () => {
    const out = priceDispatchUsage(TEXT, {
      inputTokens: 123_457,
      outputTokens: 9_871,
      modality: { audio: { inputTokens: 3_333, outputTokens: 11 } },
    });
    expect(out.costUsd).toBe(legacy(123_457, 9_871));
    expect(out.modality?.audio).toEqual({ inputTokens: 3_333, outputTokens: 11, costUsd: (3_333 / 1e6) * 3 + (11 / 1e6) * 15 });
    expect(out.modality?.text.inputTokens).toBe(123_457 - 3_333);
  });

  it("an unpriced agent stays unpriced, with the token split still recorded", () => {
    const out = priceDispatchUsage(
      { costPerMTokIn: null, costPerMTokOut: null, costPerMTokImageIn: 10 },
      { inputTokens: 100, outputTokens: 10, modality: { image: { inputTokens: 40, outputTokens: 0 } } },
    );
    expect(out.costUsd).toBeNull();
    expect(out.modality?.image).toEqual({ inputTokens: 40, outputTokens: 0, costUsd: null });
    expect(out.modality?.text).toEqual({ inputTokens: 60, outputTokens: 10, costUsd: null });
  });

  it("a sub-count larger than the provider's own total is clamped, never priced twice", () => {
    const out = priceDispatchUsage(TEXT, {
      inputTokens: 100,
      outputTokens: 0,
      modality: { image: { inputTokens: 80, outputTokens: 5 }, audio: { inputTokens: 80, outputTokens: 0 } },
    });
    expect(out.modality?.image.inputTokens).toBe(80);
    expect(out.modality?.audio.inputTokens).toBe(20);
    expect(out.modality?.text.inputTokens).toBe(0);
    expect(out.modality?.image.outputTokens).toBe(0);
  });

  it("hasModalityData is false for absent or all-zero counts", () => {
    expect(hasModalityData(undefined)).toBe(false);
    expect(hasModalityData({ audio: { inputTokens: 0, outputTokens: 0 } })).toBe(false);
    expect(hasModalityData({ audio: { inputTokens: 0, outputTokens: 1 } })).toBe(true);
  });

  it("the admin write refuses negative prices and unknown keys; null clears", () => {
    expect(setAgentModalityPricingSchema.safeParse({ costPerMTokImageIn: -1 }).success).toBe(false);
    expect(setAgentModalityPricingSchema.safeParse({ costPerMTokVideoIn: 1 }).success).toBe(false);
    expect(setAgentModalityPricingSchema.parse({ costPerMTokAudioOut: null })).toEqual({ costPerMTokAudioOut: null });
  });
});
