import { describe, expect, it } from "vitest";
import {
  AnthropicProvider,
  MockModelProvider,
  ModelProviderError,
  OpenAiProvider,
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
    for (const provider of ["google", "xai"] as const) {
      expect(() => resolveModelProvider({ provider })).toThrowError(/not implemented/);
    }
  });

  it("anthropic and openai without an apiKey are rejected", () => {
    expect(() => resolveModelProvider({ provider: "anthropic" })).toThrowError(/apiKey/);
    expect(() => resolveModelProvider({ provider: "openai" })).toThrowError(/apiKey/);
  });

  it("mock resolves to a shared instance and needs no key", () => {
    const a = resolveModelProvider({ provider: "mock" });
    const b = resolveModelProvider({ provider: "mock" });
    expect(a).toBe(b);
  });
});

describe("streaming dispatch", () => {
  it("mock streams deterministic deltas that concatenate to the full output", async () => {
    const mock = new MockModelProvider();
    const deltas: string[] = [];
    const result = await mock.dispatch({
      model: "mock-1",
      input: "stream me",
      onText: (d) => deltas.push(d),
    });
    expect(deltas.length).toBeGreaterThanOrEqual(2);
    expect(deltas.join("")).toBe(result.outputText);
  });

  it("anthropic adapter streams via SSE and returns the same complete result", async () => {
    const sse = [
      `event: message_start\ndata: {"type":"message_start","message":{"id":"msg_stream_1","type":"message","role":"assistant","model":"claude-opus-5","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":12,"output_tokens":1}}}\n\n`,
      `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n`,
      `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello "}}\n\n`,
      `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"world"}}\n\n`,
      `event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n`,
      `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":5}}\n\n`,
      `event: message_stop\ndata: {"type":"message_stop"}\n\n`,
    ].join("");
    let sawStreamFlag = false;
    const provider = new AnthropicProvider({
      apiKey: "test-key",
      fetchImpl: async (_url, init) => {
        sawStreamFlag = JSON.parse(String(init?.body)).stream === true;
        return new Response(sse, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      },
    });
    const deltas: string[] = [];
    const result = await provider.dispatch({
      model: "claude-opus-5",
      input: "greet",
      onText: (d) => deltas.push(d),
    });
    expect(sawStreamFlag).toBe(true);
    expect(deltas).toEqual(["Hello ", "world"]);
    expect(result.outputText).toBe("Hello world");
    expect(result.stopReason).toBe("end_turn");
    expect(result.usage).toEqual({ inputTokens: 12, outputTokens: 5 });
    expect(result.providerMessageId).toBe("msg_stream_1");
  });
});

describe("OpenAiProvider (injectable fetch, no network)", () => {
  const completion = {
    id: "chatcmpl-test1",
    object: "chat.completion",
    created: 1,
    model: "gpt-5",
    choices: [
      { index: 0, message: { role: "assistant", content: "42", refusal: null }, finish_reason: "stop", logprobs: null },
    ],
    usage: { prompt_tokens: 9, completion_tokens: 3, total_tokens: 12 },
  };

  it("sends a chat.completions request and normalizes the response", async () => {
    let captured: { url: string; body: Record<string, unknown> } | null = null;
    const provider = new OpenAiProvider({
      apiKey: "sk-test",
      fetchImpl: async (url, init) => {
        captured = { url: String(url), body: JSON.parse(String(init?.body)) };
        return new Response(JSON.stringify(completion), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    const result = await provider.dispatch({
      model: "gpt-5",
      input: "what is 6*7?",
      system: "answer tersely",
      maxTokens: 64,
    });
    expect(captured!.url).toContain("/chat/completions");
    expect(captured!.body).toMatchObject({
      model: "gpt-5",
      max_completion_tokens: 64,
      messages: [
        { role: "system", content: "answer tersely" },
        { role: "user", content: "what is 6*7?" },
      ],
    });
    expect(result.outputText).toBe("42");
    expect(result.stopReason).toBe("end_turn");
    expect(result.refusal).toBe(false);
    expect(result.usage).toEqual({ inputTokens: 9, outputTokens: 3 });
    expect(result.providerMessageId).toBe("chatcmpl-test1");
  });

  it("maps finish reasons: length -> max_tokens; content_filter/refusal never surface content", async () => {
    const withFinish = (finish_reason: string, refusal: string | null = null) =>
      new OpenAiProvider({
        apiKey: "sk-test",
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              ...completion,
              choices: [{ index: 0, message: { role: "assistant", content: "partial", refusal }, finish_reason, logprobs: null }],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      });
    const truncated = await withFinish("length").dispatch({ model: "gpt-5", input: "x" });
    expect(truncated.stopReason).toBe("max_tokens");
    expect(truncated.outputText).toBe("partial");

    const filtered = await withFinish("content_filter").dispatch({ model: "gpt-5", input: "x" });
    expect(filtered.refusal).toBe(true);
    expect(filtered.outputText).toBe("");

    const refused = await withFinish("stop", "I cannot help with that").dispatch({ model: "gpt-5", input: "x" });
    expect(refused.refusal).toBe(true);
    expect(refused.outputText).toBe("");
  });

  it("streams deltas and returns the same complete result with usage", async () => {
    const chunk = (c: Record<string, unknown>) => "data: " + JSON.stringify(c) + "\n\n";
    const sse =
      chunk({ id: "chatcmpl-s1", object: "chat.completion.chunk", created: 1, model: "gpt-5", choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] }) +
      chunk({ id: "chatcmpl-s1", object: "chat.completion.chunk", created: 1, model: "gpt-5", choices: [{ index: 0, delta: { content: "Hello " }, finish_reason: null }] }) +
      chunk({ id: "chatcmpl-s1", object: "chat.completion.chunk", created: 1, model: "gpt-5", choices: [{ index: 0, delta: { content: "world" }, finish_reason: null }] }) +
      chunk({ id: "chatcmpl-s1", object: "chat.completion.chunk", created: 1, model: "gpt-5", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) +
      chunk({ id: "chatcmpl-s1", object: "chat.completion.chunk", created: 1, model: "gpt-5", choices: [], usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 } }) +
      "data: [DONE]\n\n";
    let sawStreamFlag = false;
    const provider = new OpenAiProvider({
      apiKey: "sk-test",
      fetchImpl: async (_url, init) => {
        sawStreamFlag = JSON.parse(String(init?.body)).stream === true;
        return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
      },
    });
    const deltas: string[] = [];
    const result = await provider.dispatch({ model: "gpt-5", input: "greet", onText: (d) => deltas.push(d) });
    expect(sawStreamFlag).toBe(true);
    expect(deltas).toEqual(["Hello ", "world"]);
    expect(result.outputText).toBe("Hello world");
    expect(result.stopReason).toBe("end_turn");
    expect(result.usage).toEqual({ inputTokens: 12, outputTokens: 5 });
    expect(result.providerMessageId).toBe("chatcmpl-s1");
  });

  it("wraps API errors as ModelProviderError with status", async () => {
    const provider = new OpenAiProvider({
      apiKey: "sk-bad",
      fetchImpl: async () =>
        new Response(JSON.stringify({ error: { message: "Incorrect API key", type: "invalid_request_error" } }), {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
    });
    await expect(provider.dispatch({ model: "gpt-5", input: "x" })).rejects.toMatchObject({ status: 401 });
  });
});
