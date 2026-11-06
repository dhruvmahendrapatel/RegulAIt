import { describe, expect, it } from "vitest";
import { modelRateLimitBody } from "./ModelRateLimits";
import { modalityPriceBody, modalityPriceDraft } from "../integrations/AgentsPage";
import { modalityBars } from "../cost/CostDashboardPage";

const form = { userId: "u", roleId: "r", teamId: "t", agentId: "a", maxCalls: "5", windowSeconds: "60" };

describe("per-model limits and modality prices (UI helpers)", () => {
  it("posts only the target that matches the scope", () => {
    expect(modelRateLimitBody({ ...form, scope: "role" })).toEqual({ scope: "role", roleId: "r", agentId: "a", maxCalls: 5, windowSeconds: 60 });
    expect(modelRateLimitBody({ ...form, scope: "fleet" })).toEqual({ scope: "fleet", agentId: "a", maxCalls: 5, windowSeconds: 60 });
  });

  it("an empty modality price clears it (falls back to the text price); a set one round-trips", () => {
    const draft = modalityPriceDraft({ costPerMTokImageIn: 10, costPerMTokAudioOut: null });
    expect(draft).toEqual({ costPerMTokImageIn: "10", costPerMTokImageOut: "", costPerMTokAudioIn: "", costPerMTokAudioOut: "" });
    expect(modalityPriceBody({ ...draft, costPerMTokAudioIn: "2.5" })).toEqual({
      costPerMTokImageIn: 10,
      costPerMTokImageOut: null,
      costPerMTokAudioIn: 2.5,
      costPerMTokAudioOut: null,
    });
  });

  it("the dashboard bars keep unsplit spend apart and skip empty modalities", () => {
    expect(
      modalityBars({
        split: [
          { modality: "text", inputTokens: 10, outputTokens: 1, costUsd: 0.5 },
          { modality: "image", inputTokens: 0, outputTokens: 0, costUsd: 0 },
          { modality: "audio", inputTokens: 4, outputTokens: 0, costUsd: 0.25 },
        ],
        notSplit: { events: 2, costUsd: 0.1 },
      }),
    ).toEqual([
      { label: "Text", costUsd: 0.5 },
      { label: "Audio", costUsd: 0.25 },
      { label: "No split reported by the provider", costUsd: 0.1 },
    ]);
    expect(modalityBars(undefined)).toEqual([]);
  });
});
