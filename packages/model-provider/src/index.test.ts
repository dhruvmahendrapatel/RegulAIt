import { describe, expect, it } from "vitest";
import {
  AnthropicProvider,
  MockModelProvider,
  ModelProviderError,
  resolveModelProvider,
} from "./index.js";

function anthropicJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("MockModelProvider", () => {
  it("echoes deterministically and measures usage", async () => {
    const mock = new MockModelProvider();
    const result = await mock.dispatch({ model: "mock-1", input: "hello world" });
    expect(result.outputText).toBe("mock(mock-1): hello world");
    expect(result.stopReason).toBe("end_turn");
    expect(result.refusal).toBe(false);
    expect(result.usage.inputTokens).toBeGreaterThan(0);
    expect(result.usage.outputTokens).toBeGreaterThan(0);
    expect(mock.dispatches).toHaveLength(1);
  });

  it("<<refuse>> produces a refusal with empty output", async () => {
    const mock = new MockModelProvider();
    const result = await mock.dispatch({ model: "mock-1", input: "please <<refuse>> this" });
    expect(result.refusal).toBe(true);
    expect(result.stopReason).toBe("refusal");
    expect(result.outputText).toBe("");
    expect(result.usage.outputTokens).toBe(0);
  });
});

describe("AnthropicProvider (injectable fetch, no network)", () => {
  const message = {
    id: "msg_test_1",
    type: "message",
    role: "assistant",
    model: "claude-opus-5",
    content: [{ type: "text", text: "42" }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 17, output_tokens: 3 },
  };

  it("sends a Messages API request and normalizes the response", async () => {
    let captured: { url: string; body: Record<string, unknown> } | null = null;
    const provider = new AnthropicProvider({
      apiKey: "test-key",
      fetchImpl: async (url, init) => {
        captured = { url: String(url), body: JSON.parse(String(init?.body)) };
        return anthropicJson(message);
      },
    });
    const result = await provider.dispatch({
      model: "claude-opus-5",
      input: "what is 6*7?",
      system: "answer tersely",
      maxTokens: 64,
    });
    expect(captured!.url).toContain("/v1/messages");
    expect(captured!.body).toMatchObject({
      model: "claude-opus-5",
      max_tokens: 64,
      system: "answer tersely",
      messages: [{ role: "user", content: "what is 6*7?" }],
    });
    expect(result.outputText).toBe("42");
    expect(result.stopReason).toBe("end_turn");
    expect(result.refusal).toBe(false);
    expect(result.usage).toEqual({ inputTokens: 17, outputTokens: 3 });
    expect(result.providerMessageId).toBe("msg_test_1");
  });

  it("stop_reason=refusal never surfaces content as an answer", async () => {
    const provider = new AnthropicProvider({
      apiKey: "test-key",
      fetchImpl: async () =>
        anthropicJson({
          ...message,
          content: [{ type: "text", text: "partial before refusal" }],
          stop_reason: "refusal",
        }),
    });
    const result = await provider.dispatch({ model: "claude-opus-5", input: "x" });
    expect(result.refusal).toBe(true);
    expect(result.stopReason).toBe("refusal");
    expect(result.outputText).toBe("");
    expect(result.usage.inputTokens).toBe(17);
  });

  it("wraps API errors as ModelProviderError with status", async () => {
    const provider = new AnthropicProvider({
      apiKey: "bad-key",
      fetchImpl: async () =>
        anthropicJson(
          { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } },
          401,
        ),
    });
    await expect(provider.dispatch({ model: "claude-opus-5", input: "x" })).rejects.toThrowError(
      ModelProviderError,
    );
    await expect(provider.dispatch({ model: "claude-opus-5", input: "x" })).rejects.toMatchObject({
      status: 401,
    });
  });
});

describe("resolveModelProvider registry", () => {
  it("rejects interface-ready but unimplemented providers", () => {
    for (const provider of ["openai", "google", "xai"] as const) {
      expect(() => resolveModelProvider({ provider })).toThrowError(/not implemented/);
    }
  });

  it("anthropic without an apiKey is rejected", () => {
    expect(() => resolveModelProvider({ provider: "anthropic" })).toThrowError(/apiKey/);
  });

  it("mock resolves to a shared instance and needs no key", () => {
    const a = resolveModelProvider({ provider: "mock" });
    const b = resolveModelProvider({ provider: "mock" });
    expect(a).toBe(b);
  });
});
