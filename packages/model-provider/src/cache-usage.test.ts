/**
 * ADR-0173 batch 2c (trace standards) — the provider's own prompt-cache token
 * counts surface on `usage`, for the trace export's
 * `gen_ai.usage.cache_read.input_tokens` / `cache_creation.input_tokens`.
 * Present only when the provider reported a positive count, so every other
 * caller's `usage` shape is unchanged.
 */
import { describe, expect, it } from "vitest";
import { AnthropicProvider, OpenAiProvider } from "./index.js";

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

const anthropic = (usage: Record<string, unknown>) => ({
  id: "msg_c",
  type: "message",
  role: "assistant",
  model: "m",
  content: [{ type: "text", text: "ok" }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage,
});

describe("prompt-cache usage", () => {
  it("Anthropic: cache read and cache write, as reported", async () => {
    const p = new AnthropicProvider({
      apiKey: "k",
      fetchImpl: async () =>
        json(anthropic({ input_tokens: 3, output_tokens: 1, cache_read_input_tokens: 120, cache_creation_input_tokens: 40 })),
    });
    const r = await p.dispatch({ model: "m", input: "hi" });
    expect(r.usage).toEqual({ inputTokens: 3, outputTokens: 1, cacheReadInputTokens: 120, cacheCreationInputTokens: 40 });
  });

  it("Anthropic: zero or absent counts leave the shape unchanged", async () => {
    const p = new AnthropicProvider({
      apiKey: "k",
      fetchImpl: async () => json(anthropic({ input_tokens: 3, output_tokens: 1, cache_read_input_tokens: 0 })),
    });
    const r = await p.dispatch({ model: "m", input: "hi" });
    expect(r.usage).toEqual({ inputTokens: 3, outputTokens: 1 });
  });

  it("OpenAI chat completions: cached_tokens is a cache READ (no write is reported)", async () => {
    const p = new OpenAiProvider({
      apiKey: "k",
      fetchImpl: async () =>
        json({
          id: "c",
          object: "chat.completion",
          created: 1,
          model: "m",
          choices: [{ index: 0, message: { role: "assistant", content: "ok", refusal: null }, finish_reason: "stop", logprobs: null }],
          usage: { prompt_tokens: 50, completion_tokens: 2, total_tokens: 52, prompt_tokens_details: { cached_tokens: 32 } },
        }),
    });
    const r = await p.dispatch({ model: "m", input: "hi" });
    expect(r.usage).toEqual({ inputTokens: 50, outputTokens: 2, cacheReadInputTokens: 32 });
  });
});
