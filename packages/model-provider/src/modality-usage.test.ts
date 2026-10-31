/**
 * ADR-0212 (P12 b): the adapters report an image/audio share of their token totals only
 * when the provider's own usage block carries one — absent otherwise, never inferred.
 */
import { describe, expect, it } from "vitest";
import { geminiModality, openAiChatModality } from "./index.js";

describe("modality usage from provider usage blocks", () => {
  it("OpenAI-style chat: audio (and image where sent) tokens become the split", () => {
    expect(
      openAiChatModality({
        prompt_tokens: 900,
        completion_tokens: 300,
        prompt_tokens_details: { audio_tokens: 400, image_tokens: 100, cached_tokens: 50 },
        completion_tokens_details: { audio_tokens: 200 },
      }),
    ).toEqual({
      modality: { image: { inputTokens: 100, outputTokens: 0 }, audio: { inputTokens: 400, outputTokens: 200 } },
    });
  });

  it("OpenAI-style chat: no details, or zero counts, report nothing", () => {
    expect(openAiChatModality({ prompt_tokens: 10, completion_tokens: 2 })).toEqual({});
    expect(openAiChatModality(undefined)).toEqual({});
    expect(
      openAiChatModality({ prompt_tokens_details: { audio_tokens: 0 }, completion_tokens_details: { audio_tokens: 0 } }),
    ).toEqual({});
  });

  it("Gemini: per-modality details sum by modality; video counts as image", () => {
    expect(
      geminiModality({
        promptTokenCount: 1000,
        candidatesTokenCount: 50,
        promptTokensDetails: [
          { modality: "TEXT", tokenCount: 300 },
          { modality: "IMAGE", tokenCount: 258 },
          { modality: "VIDEO", tokenCount: 100 },
          { modality: "AUDIO", tokenCount: 342 },
        ],
        candidatesTokensDetails: [{ modality: "TEXT", tokenCount: 50 }],
      }),
    ).toEqual({ modality: { image: { inputTokens: 358, outputTokens: 0 }, audio: { inputTokens: 342, outputTokens: 0 } } });
  });

  it("Gemini: text-only details, or none at all, report nothing", () => {
    expect(geminiModality({ promptTokenCount: 5, promptTokensDetails: [{ modality: "TEXT", tokenCount: 5 }] })).toEqual({});
    expect(geminiModality(undefined)).toEqual({});
  });
});
