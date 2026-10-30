/**
 * ADR-0212 (P12 b) — pricing a measured dispatch by MODALITY.
 *
 * A provider that reports how many of its tokens were image or audio tokens lets
 * pillar 5 price each modality at its own list price. Everything not reported as
 * image or audio is text. Three rules keep this honest:
 *
 *   1. No modality data from the provider = the cost is computed by exactly the
 *      pre-ADR-0212 formula (total tokens x the text price) and no split is
 *      recorded. Nothing is inferred from the prompt.
 *   2. A modality with no price of its own is priced at the text price, so an
 *      agent with no modality prices costs exactly what it did before, and the
 *      split only says where that money went.
 *   3. No text price = unpriced (null), as before: a measured token count never
 *      becomes an invented dollar figure. The token split is still recorded.
 */
import { z } from "zod";

export const MODALITIES = ["text", "image", "audio"] as const;
export type Modality = (typeof MODALITIES)[number];

/** non-text token counts as the provider reported them; text is the remainder */
export interface ModalityTokenCounts {
  image?: { inputTokens: number; outputTokens: number };
  audio?: { inputTokens: number; outputTokens: number };
}

/** an agent's list prices per million tokens; null = no price of its own */
export interface ModalityPrices {
  costPerMTokIn: number | null;
  costPerMTokOut: number | null;
  costPerMTokImageIn?: number | null;
  costPerMTokImageOut?: number | null;
  costPerMTokAudioIn?: number | null;
  costPerMTokAudioOut?: number | null;
}

export interface ModalityLine {
  inputTokens: number;
  outputTokens: number;
  /** null when the agent is unpriced */
  costUsd: number | null;
}

/** what `usage_events.modality_usage` stores: one line per modality */
export type ModalitySplit = Record<Modality, ModalityLine>;

export interface PricedDispatch {
  costUsd: number | null;
  /** null = the provider reported no modality data (rule 1) */
  modality: ModalitySplit | null;
}

const nonNegative = (n: unknown): number => (typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0);

/** the pre-ADR-0212 formula, kept as the one definition of a text-only price */
function textOnlyCost(prices: ModalityPrices, inputTokens: number, outputTokens: number): number | null {
  if (prices.costPerMTokIn == null || prices.costPerMTokOut == null) return null;
  return (inputTokens / 1e6) * prices.costPerMTokIn + (outputTokens / 1e6) * prices.costPerMTokOut;
}

/** has the provider reported any non-text token at all? */
export function hasModalityData(m: ModalityTokenCounts | null | undefined): m is ModalityTokenCounts {
  if (!m) return false;
  return [m.image, m.audio].some((x) => x != null && (nonNegative(x.inputTokens) > 0 || nonNegative(x.outputTokens) > 0));
}

export function priceDispatchUsage(
  prices: ModalityPrices,
  usage: { inputTokens: number; outputTokens: number; modality?: ModalityTokenCounts | null },
): PricedDispatch {
  const totalIn = nonNegative(usage.inputTokens);
  const totalOut = nonNegative(usage.outputTokens);
  if (!hasModalityData(usage.modality)) {
    return { costUsd: textOnlyCost(prices, usage.inputTokens, usage.outputTokens), modality: null };
  }
  const m = usage.modality;
  // a provider's sub-count can never exceed its own total: clamp, image first
  const imageIn = Math.min(nonNegative(m.image?.inputTokens), totalIn);
  const audioIn = Math.min(nonNegative(m.audio?.inputTokens), totalIn - imageIn);
  const imageOut = Math.min(nonNegative(m.image?.outputTokens), totalOut);
  const audioOut = Math.min(nonNegative(m.audio?.outputTokens), totalOut - imageOut);
  const textIn = totalIn - imageIn - audioIn;
  const textOut = totalOut - imageOut - audioOut;
  const priced = prices.costPerMTokIn != null && prices.costPerMTokOut != null;
  const line = (inTok: number, outTok: number, pIn: number | null | undefined, pOut: number | null | undefined): ModalityLine => ({
    inputTokens: inTok,
    outputTokens: outTok,
    costUsd: priced
      ? (inTok / 1e6) * (pIn ?? prices.costPerMTokIn!) + (outTok / 1e6) * (pOut ?? prices.costPerMTokOut!)
      : null,
  });
  const modality: ModalitySplit = {
    text: line(textIn, textOut, prices.costPerMTokIn, prices.costPerMTokOut),
    image: line(imageIn, imageOut, prices.costPerMTokImageIn, prices.costPerMTokImageOut),
    audio: line(audioIn, audioOut, prices.costPerMTokAudioIn, prices.costPerMTokAudioOut),
  };
  if (!priced) return { costUsd: null, modality };
  const ownPrices = [
    prices.costPerMTokImageIn,
    prices.costPerMTokImageOut,
    prices.costPerMTokAudioIn,
    prices.costPerMTokAudioOut,
  ].some((p) => p != null);
  // rule 2: with no modality price of its own the total is the text-only figure, to the bit
  const costUsd = ownPrices
    ? MODALITIES.reduce((sum, k) => sum + (modality[k].costUsd ?? 0), 0)
    : textOnlyCost(prices, totalIn, totalOut);
  return { costUsd, modality };
}

const price = z.number().nonnegative().finite().nullable().optional();

/** `PUT /v1/agents/:agentId/modality-pricing` — admin, audited; null clears a price (it falls back to text) */
export const setAgentModalityPricingSchema = z
  .object({
    costPerMTokImageIn: price,
    costPerMTokImageOut: price,
    costPerMTokAudioIn: price,
    costPerMTokAudioOut: price,
  })
  .strict();
