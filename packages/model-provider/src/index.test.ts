import { describe, expect, it } from "vitest";
import {
  AnthropicProvider,
  MockModelProvider,
  ModelProviderError,
  GoogleProvider,
  OpenAiProvider,
  XaiProvider,
  TASK_DECOMPOSITION_SENTINEL,
  resolveModelProvider,
} from "./index.js";

function anthropicJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("MockModelProvider", () => {
  it("answers deterministically with a canned reply — never an echo — and measures usage", async () => {
    const mock = new MockModelProvider();
    const input = "hello world, tell me something interesting about governance layers today";
    const result = await mock.dispatch({ model: "mock-1", input });
    // responsive, not a restatement: references the request without repeating it
    expect(result.outputText).not.toContain(input);
    expect(result.outputText).toContain("hello world");
    expect(result.stopReason).toBe("end_turn");
    expect(result.refusal).toBe(false);
    // token accounting stays derived from text length, exactly as before
    expect(result.usage.inputTokens).toBe(Math.ceil(input.length / 4));
    expect(result.usage.outputTokens).toBe(Math.ceil(result.outputText.length / 4));
    expect(result.providerMessageId).toBe("mock-msg-1");
    expect(mock.dispatches).toHaveLength(1);

    // pure function of (model, input, system): a fresh instance answers identically
    const again = await new MockModelProvider().dispatch({ model: "mock-1", input });
    expect(again.outputText).toBe(result.outputText);
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

describe("MockModelProvider canned intent shapes", () => {
  const mock = new MockModelProvider();

  it("a plan request yields numbered steps", async () => {
    const r = await mock.dispatch({ model: "mock-balanced", input: "plan the payments migration" });
    expect(r.outputText).toContain("payments migration");
    expect(r.outputText).toMatch(/^1\./m);
    expect(r.outputText).toMatch(/^2\./m);
    expect(r.outputText).not.toContain("plan the payments migration"); // no echo
  });

  it("an implement/draft request yields a fenced code block with an explanation", async () => {
    const r = await mock.dispatch({ model: "mock-balanced", input: "please draft the api endpoints" });
    expect(r.outputText).toContain("api endpoints");
    // an opened AND closed fence, with prose around it
    expect(r.outputText.split("```").length).toBeGreaterThanOrEqual(3);
    expect(r.outputText).toContain("apiEndpoints"); // topic-derived identifier
  });

  it("a summarize request yields a crisp summary paragraph", async () => {
    const r = await mock.dispatch({ model: "mock-balanced", input: "summarize this short note" });
    expect(r.outputText).toContain("Summary");
    expect(r.outputText).toContain("short note");
    expect(r.outputText).not.toContain("summarize this short note"); // no echo
  });

  it("a review request yields bulleted findings", async () => {
    const r = await mock.dispatch({ model: "mock-balanced", input: "review this change for release risk" });
    expect(r.outputText).toContain("change for release risk");
    expect(r.outputText).toMatch(/^- \[major\]/m);
    expect(r.outputText).toMatch(/^- \[minor\]/m);
  });

  it("a test request yields a test plan", async () => {
    const r = await mock.dispatch({ model: "mock-balanced", input: "test the export endpoint" });
    expect(r.outputText).toContain("Test plan");
    expect(r.outputText).toContain("export endpoint");
  });

  it("an explain request yields an explanation referencing the topic", async () => {
    const r = await mock.dispatch({ model: "mock-balanced", input: "explain why the cache invalidates" });
    expect(r.outputText).toContain("why the cache invalidates");
  });

  it("anything else falls back to a generic reply that references key phrases", async () => {
    const r = await mock.dispatch({ model: "mock-balanced", input: "stream this back" });
    expect(r.outputText).toContain("stream this back");
    expect(r.outputText.length).toBeGreaterThan("stream this back".length * 3);
  });
});

describe("MockModelProvider tier differentiation", () => {
  const words = (s: string) => s.split(/\s+/).filter(Boolean).length;
  const INTENT_SAMPLES = [
    "summarize this short note",
    "review this change for release risk",
    "test the export endpoint",
    "plan the rollout of the new gateway",
    "please draft the api endpoints",
    "explain why the cache invalidates",
    "stream this back",
  ];

  it("fast is terse, balanced solid, premium structured — same intent, visibly better up-tier", async () => {
    const mock = new MockModelProvider();
    const input = "plan the rollout of the new gateway";
    const fast = await mock.dispatch({ model: "mock-fast", input });
    const balanced = await mock.dispatch({ model: "mock-balanced", input });
    const premium = await mock.dispatch({ model: "mock-premium", input });
    expect(words(fast.outputText)).toBeLessThan(words(balanced.outputText));
    expect(words(balanced.outputText)).toBeLessThan(words(premium.outputText));
    // premium is structured with headings; fast never is
    expect(premium.outputText).toContain("## ");
    expect(fast.outputText).not.toContain("## ");
    expect(balanced.outputText).not.toContain("## ");
  });

  it("every intent stays inside its tier's compact word budget", async () => {
    const mock = new MockModelProvider();
    for (const input of INTENT_SAMPLES) {
      const fast = words((await mock.dispatch({ model: "mock-fast", input })).outputText);
      const balanced = words((await mock.dispatch({ model: "mock-balanced", input })).outputText);
      const premium = words((await mock.dispatch({ model: "mock-premium", input })).outputText);
      expect(fast).toBeGreaterThanOrEqual(35);
      expect(fast).toBeLessThanOrEqual(85);
      expect(balanced).toBeGreaterThanOrEqual(85);
      expect(balanced).toBeLessThanOrEqual(155);
      expect(premium).toBeGreaterThanOrEqual(145);
      expect(premium).toBeLessThanOrEqual(260);
      expect(fast).toBeLessThan(balanced);
      expect(balanced).toBeLessThan(premium);
    }
  });

  it("an unlabelled model id gets the balanced middle tier", async () => {
    const mock = new MockModelProvider();
    const input = "plan the rollout of the new gateway";
    const unlabelled = await mock.dispatch({ model: "mock-1", input });
    const balanced = await mock.dispatch({ model: "mock-balanced", input });
    expect(unlabelled.outputText).toBe(balanced.outputText);
  });
});

describe("MockModelProvider system-prompt acknowledgement", () => {
  it("acknowledges a present system prompt in one opening line, then answers", async () => {
    const mock = new MockModelProvider();
    const system =
      "You are the worker agent for node 'impl' of run 'demo', executing the build stage.\n\n" +
      "--- signed-off artifact 'requirements_file' v1 ---\nDETAILS";
    const r = await mock.dispatch({
      model: "mock-fast",
      input: "please draft the api endpoints",
      system,
    });
    expect(r.outputText.startsWith("Working within the signed-off scope: ")).toBe(true);
    // the opening line carries the system context, proving it flowed through
    const opening = r.outputText.split("\n", 1)[0]!;
    expect(opening).toContain("the worker agent for node 'impl' of run 'demo'");
    // the canned answer still follows
    expect(r.outputText).toContain("api endpoints");
  });

  it("no system prompt, no acknowledgement line", async () => {
    const mock = new MockModelProvider();
    const r = await mock.dispatch({ model: "mock-fast", input: "please draft the api endpoints" });
    expect(r.outputText).not.toContain("Working within the signed-off scope");
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
  it("every real provider resolves with a key and is rejected without one", () => {
    for (const provider of ["anthropic", "openai", "google", "xai"] as const) {
      expect(() => resolveModelProvider({ provider })).toThrowError(/apiKey/);
      expect(resolveModelProvider({ provider, apiKey: "k" }).kind).toBe(provider);
    }
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

describe("GoogleProvider (raw injectable fetch, no network)", () => {
  const geminiResponse = {
    responseId: "resp-g1",
    candidates: [
      { content: { role: "model", parts: [{ text: "42" }] }, finishReason: "STOP" },
    ],
    usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 2, totalTokenCount: 9 },
  };
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it("sends a generateContent request and normalizes the response", async () => {
    let captured: { url: string; headers: Record<string, string>; body: Record<string, unknown> } | null = null;
    const provider = new GoogleProvider({
      apiKey: "goog-key",
      fetchImpl: async (url, init) => {
        captured = {
          url: String(url),
          headers: (init?.headers ?? {}) as Record<string, string>,
          body: JSON.parse(String(init?.body)),
        };
        return json(geminiResponse);
      },
    });
    const result = await provider.dispatch({
      model: "gemini-2.5-pro",
      input: "what is 6*7?",
      system: "answer tersely",
      maxTokens: 64,
    });
    expect(captured!.url).toContain("/models/gemini-2.5-pro:generateContent");
    expect(captured!.headers["x-goog-api-key"]).toBe("goog-key");
    expect(captured!.body).toMatchObject({
      contents: [{ role: "user", parts: [{ text: "what is 6*7?" }] }],
      systemInstruction: { parts: [{ text: "answer tersely" }] },
      generationConfig: { maxOutputTokens: 64 },
    });
    expect(result.outputText).toBe("42");
    expect(result.stopReason).toBe("end_turn");
    expect(result.usage).toEqual({ inputTokens: 7, outputTokens: 2 });
    expect(result.providerMessageId).toBe("resp-g1");
  });

  it("SAFETY finishes and prompt blocks are refusals with suppressed content", async () => {
    const safety = new GoogleProvider({
      apiKey: "k",
      fetchImpl: async () =>
        json({
          ...geminiResponse,
          candidates: [{ content: { parts: [{ text: "partial" }] }, finishReason: "SAFETY" }],
        }),
    });
    const refused = await safety.dispatch({ model: "gemini-2.5-pro", input: "x" });
    expect(refused.refusal).toBe(true);
    expect(refused.outputText).toBe("");

    const blocked = new GoogleProvider({
      apiKey: "k",
      fetchImpl: async () =>
        json({ promptFeedback: { blockReason: "SAFETY" }, usageMetadata: { promptTokenCount: 5 } }),
    });
    const b = await blocked.dispatch({ model: "gemini-2.5-pro", input: "x" });
    expect(b.refusal).toBe(true);
    expect(b.outputText).toBe("");

    const truncated = new GoogleProvider({
      apiKey: "k",
      fetchImpl: async () =>
        json({
          ...geminiResponse,
          candidates: [{ content: { parts: [{ text: "cut" }] }, finishReason: "MAX_TOKENS" }],
        }),
    });
    expect((await truncated.dispatch({ model: "gemini-2.5-pro", input: "x" })).stopReason).toBe("max_tokens");
  });

  it("streams SSE chunks through onText and returns the complete result", async () => {
    const chunk = (c: unknown) => "data: " + JSON.stringify(c) + "\n\n";
    const sse =
      chunk({ responseId: "resp-s1", candidates: [{ content: { parts: [{ text: "Hello " }] } }] }) +
      chunk({ candidates: [{ content: { parts: [{ text: "world" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 5 } });
    let streamUrl = "";
    const provider = new GoogleProvider({
      apiKey: "k",
      fetchImpl: async (url) => {
        streamUrl = String(url);
        return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
      },
    });
    const deltas: string[] = [];
    const result = await provider.dispatch({
      model: "gemini-2.5-pro",
      input: "greet",
      onText: (d) => deltas.push(d),
    });
    expect(streamUrl).toContain(":streamGenerateContent?alt=sse");
    expect(deltas).toEqual(["Hello ", "world"]);
    expect(result.outputText).toBe("Hello world");
    expect(result.stopReason).toBe("end_turn");
    expect(result.usage).toEqual({ inputTokens: 12, outputTokens: 5 });
    expect(result.providerMessageId).toBe("resp-s1");
  });

  it("wraps API errors as ModelProviderError with status", async () => {
    const provider = new GoogleProvider({
      apiKey: "bad",
      fetchImpl: async () =>
        json({ error: { code: 403, message: "API key not valid", status: "PERMISSION_DENIED" } }, 403),
    });
    await expect(provider.dispatch({ model: "gemini-2.5-pro", input: "x" })).rejects.toMatchObject({
      status: 403,
    });
  });
});

describe("XaiProvider (OpenAI-compatible core pointed at api.x.ai)", () => {
  it("defaults to the xAI base URL and normalizes like the shared core", async () => {
    let captured: { url: string; body: Record<string, unknown> } | null = null;
    const provider = new XaiProvider({
      apiKey: "xai-key",
      fetchImpl: async (url, init) => {
        captured = { url: String(url), body: JSON.parse(String(init?.body)) };
        return new Response(
          JSON.stringify({
            id: "chatcmpl-xai1",
            object: "chat.completion",
            created: 1,
            model: "grok-4",
            choices: [{ index: 0, message: { role: "assistant", content: "grok says 42", refusal: null }, finish_reason: "stop", logprobs: null }],
            usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });
    const result = await provider.dispatch({ model: "grok-4", input: "meaning of life?" });
    expect(captured!.url.startsWith("https://api.x.ai/v1")).toBe(true);
    expect(captured!.url).toContain("/chat/completions");
    expect(captured!.body).toMatchObject({ model: "grok-4" });
    expect(result.outputText).toBe("grok says 42");
    expect(result.stopReason).toBe("end_turn");
    expect(result.usage).toEqual({ inputTokens: 5, outputTokens: 4 });
    expect(result.providerMessageId).toBe("chatcmpl-xai1");
  });

  it("streams through the shared core with xai-labeled errors", async () => {
    const chunk = (c: unknown) => "data: " + JSON.stringify(c) + "\n\n";
    const sse =
      chunk({ id: "chatcmpl-xs1", object: "chat.completion.chunk", created: 1, model: "grok-4", choices: [{ index: 0, delta: { content: "grok " }, finish_reason: null }] }) +
      chunk({ id: "chatcmpl-xs1", object: "chat.completion.chunk", created: 1, model: "grok-4", choices: [{ index: 0, delta: { content: "streams" }, finish_reason: "stop" }] }) +
      chunk({ id: "chatcmpl-xs1", object: "chat.completion.chunk", created: 1, model: "grok-4", choices: [], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }) +
      "data: [DONE]\n\n";
    const provider = new XaiProvider({
      apiKey: "xai-key",
      fetchImpl: async () =>
        new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }),
    });
    const deltas: string[] = [];
    const result = await provider.dispatch({ model: "grok-4", input: "go", onText: (d) => deltas.push(d) });
    expect(deltas).toEqual(["grok ", "streams"]);
    expect(result.outputText).toBe("grok streams");
    expect(result.usage).toEqual({ inputTokens: 3, outputTokens: 2 });

    const failing = new XaiProvider({
      apiKey: "bad",
      fetchImpl: async () =>
        new Response(JSON.stringify({ error: { message: "invalid key" } }), {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
    });
    await expect(failing.dispatch({ model: "grok-4", input: "x" })).rejects.toThrowError(/xai dispatch failed/);
  });
});

describe("multi-turn messages contract (full history including newest turn; input ignored)", () => {
  const HISTORY = [
    { role: "user" as const, content: "plan the payments migration" },
    { role: "assistant" as const, content: "Plan — payments migration. Four steps: …" },
    { role: "user" as const, content: "now make it shorter" },
  ];

  it("anthropic sends the messages array verbatim (roles map 1:1) and ignores input", async () => {
    let captured: Record<string, unknown> | null = null;
    const provider = new AnthropicProvider({
      apiKey: "k",
      fetchImpl: async (_url, init) => {
        captured = JSON.parse(String(init?.body));
        return anthropicJson({
          id: "msg_mt_1",
          type: "message",
          role: "assistant",
          model: "claude-opus-5",
          content: [{ type: "text", text: "shorter plan" }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 30, output_tokens: 4 },
        });
      },
    });
    await provider.dispatch({
      model: "claude-opus-5",
      input: "IGNORED",
      messages: HISTORY,
      system: "answer tersely",
    });
    expect(captured!.system).toBe("answer tersely");
    expect(captured!.messages).toEqual([
      { role: "user", content: "plan the payments migration" },
      { role: "assistant", content: "Plan — payments migration. Four steps: …" },
      { role: "user", content: "now make it shorter" },
    ]);
    expect(JSON.stringify(captured)).not.toContain("IGNORED");
  });

  it("openai prepends system then the history; assistant stays assistant", async () => {
    let captured: Record<string, unknown> | null = null;
    const provider = new OpenAiProvider({
      apiKey: "sk",
      fetchImpl: async (_url, init) => {
        captured = JSON.parse(String(init?.body));
        return new Response(
          JSON.stringify({
            id: "chatcmpl-mt1",
            object: "chat.completion",
            created: 1,
            model: "gpt-5",
            choices: [{ index: 0, message: { role: "assistant", content: "ok", refusal: null }, finish_reason: "stop", logprobs: null }],
            usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });
    await provider.dispatch({ model: "gpt-5", input: "IGNORED", messages: HISTORY, system: "s" });
    expect(captured!.messages).toEqual([
      { role: "system", content: "s" },
      { role: "user", content: "plan the payments migration" },
      { role: "assistant", content: "Plan — payments migration. Four steps: …" },
      { role: "user", content: "now make it shorter" },
    ]);
  });

  it("xai (shared chat-completions core) carries the same history shape", async () => {
    let captured: Record<string, unknown> | null = null;
    const provider = new XaiProvider({
      apiKey: "xk",
      fetchImpl: async (_url, init) => {
        captured = JSON.parse(String(init?.body));
        return new Response(
          JSON.stringify({
            id: "chatcmpl-xmt1",
            object: "chat.completion",
            created: 1,
            model: "grok-4",
            choices: [{ index: 0, message: { role: "assistant", content: "ok", refusal: null }, finish_reason: "stop", logprobs: null }],
            usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });
    await provider.dispatch({ model: "grok-4", input: "IGNORED", messages: HISTORY });
    expect(captured!.messages).toEqual([
      { role: "user", content: "plan the payments migration" },
      { role: "assistant", content: "Plan — payments migration. Four steps: …" },
      { role: "user", content: "now make it shorter" },
    ]);
  });

  it("google maps assistant -> role 'model' in contents, user stays 'user'", async () => {
    let captured: Record<string, unknown> | null = null;
    const provider = new GoogleProvider({
      apiKey: "gk",
      fetchImpl: async (_url, init) => {
        captured = JSON.parse(String(init?.body));
        return new Response(
          JSON.stringify({
            responseId: "resp-mt1",
            candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }],
            usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });
    await provider.dispatch({ model: "gemini-2.5-pro", input: "IGNORED", messages: HISTORY });
    expect(captured!.contents).toEqual([
      { role: "user", parts: [{ text: "plan the payments migration" }] },
      { role: "model", parts: [{ text: "Plan — payments migration. Four steps: …" }] },
      { role: "user", parts: [{ text: "now make it shorter" }] },
    ]);
  });

  it("mock opens with a continuation line and a terse follow-up inherits the previous turn's topic", async () => {
    const mock = new MockModelProvider();
    const r = await mock.dispatch({ model: "mock-balanced", input: "", messages: HISTORY });
    // history is 3 turns, so 2 precede the newest
    expect(r.outputText).toContain("Continuing from the previous 2 turns");
    // "now make it shorter" is 4 words (< 8): the topic comes from turn 1
    expect(r.outputText).toContain("payments migration");
    // measured input covers the whole history, not just the newest turn
    const historyChars = HISTORY.map((m) => m.content).join("\n").length;
    expect(r.usage.inputTokens).toBe(Math.ceil(historyChars / 4));
    expect(r.stopReason).toBe("end_turn");
  });

  it("mock dispatches intent on the LAST user turn when it is not terse", async () => {
    const mock = new MockModelProvider();
    const r = await mock.dispatch({
      model: "mock-balanced",
      input: "",
      messages: [
        { role: "user", content: "plan the payments migration" },
        { role: "assistant", content: "Plan — payments migration. …" },
        { role: "user", content: "please review this follow-up change for regression risk" },
      ],
    });
    expect(r.outputText).toContain("Continuing from the previous 2 turns:");
    // a full sentence keeps its own intent + topic (review shape, own subject)
    expect(r.outputText).toMatch(/^- \[major\]/m);
    expect(r.outputText).toContain("follow-up change for regression risk");
  });

  it("mock refuses on <<refuse>> in the last user turn even with history (input ignored)", async () => {
    const mock = new MockModelProvider();
    const r = await mock.dispatch({
      model: "mock-balanced",
      input: "no refuse marker here",
      messages: [
        { role: "user", content: "plan the payments migration" },
        { role: "assistant", content: "Plan …" },
        { role: "user", content: "please <<refuse>> this" },
      ],
    });
    expect(r.refusal).toBe(true);
    expect(r.outputText).toBe("");
    expect(r.usage.outputTokens).toBe(0);
  });

  it("mock system ack still opens the reply, before the continuation line", async () => {
    const mock = new MockModelProvider();
    const r = await mock.dispatch({
      model: "mock-fast",
      input: "",
      messages: HISTORY,
      system: "You are the payments planning assistant.",
    });
    expect(r.outputText.startsWith("Working within the signed-off scope: ")).toBe(true);
    expect(r.outputText.indexOf("Working within")).toBeLessThan(
      r.outputText.indexOf("Continuing from the previous"),
    );
  });

  it("regression: a single-input request is byte-identical to the pre-messages behaviour", async () => {
    const mock = new MockModelProvider();
    const input = "plan the rollout of the new gateway";
    const single = await mock.dispatch({ model: "mock-balanced", input });
    expect(single.outputText).not.toContain("Continuing from the previous");
    expect(single.usage.inputTokens).toBe(Math.ceil(input.length / 4));
    // a one-element messages array is the same request said differently
    const viaMessages = await new MockModelProvider().dispatch({
      model: "mock-balanced",
      input: "IGNORED",
      messages: [{ role: "user", content: input }],
    });
    expect(viaMessages.outputText).toBe(single.outputText);
    expect(viaMessages.usage).toEqual(single.usage);
  });
});

describe("MockModelProvider task-decomposition planning (pillar 7)", () => {
  const PLAN_SYSTEM = [
    TASK_DECOMPOSITION_SENTINEL,
    "You are a Team-Lead agent. Decompose the user's goal into a task graph of 3-7 tasks for worker agents.",
    "Assign each task to one of the caller's granted agents BY NAME from this roster:",
    "- fast-mock (tier 0, $1 in / $5 out per MTok)",
    "- balanced-mock (tier 1, $3 in / $15 out per MTok)",
    "- premium-mock (tier 2, $15 in / $75 out per MTok)",
    'Return ONLY a JSON object.',
  ].join("\n");
  const GOAL = "Add rate-limit headers to the public API and document them";

  function parsePlan(text: string): any {
    // the mock fences the object on purpose — callers must tolerate that
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    expect(start).toBeGreaterThanOrEqual(0);
    return JSON.parse(text.slice(start, end + 1));
  }

  it("the sentinel flips the reply to a valid 4-node plan: analyze → two parallel middles → integrate", async () => {
    const mock = new MockModelProvider();
    const r = await mock.dispatch({ model: "mock-balanced", input: GOAL, system: PLAN_SYSTEM });
    expect(r.refusal).toBe(false);
    const plan = parsePlan(r.outputText);
    expect(typeof plan.name).toBe("string");
    expect(plan.nodes).toHaveLength(4);
    const [analyze, mid1, mid2, final] = plan.nodes;
    expect(analyze.dependsOn).toEqual([]);
    expect(mid1.dependsOn).toEqual([analyze.id]);
    expect(mid2.dependsOn).toEqual([analyze.id]);
    expect(final.dependsOn).toEqual([mid1.id, mid2.id]);
    // kebab-slug ids, topic-flavoured middles pulled from goal keywords
    for (const n of plan.nodes) expect(n.id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    expect(mid1.id).not.toBe(mid2.id);
    expect(mid1.id + mid2.id).toMatch(/rate|limit|headers|document/);
    // instructions are self-contained prose, not placeholders
    for (const n of plan.nodes) expect(n.instruction.length).toBeGreaterThan(40);
    // usage stays the measured contract
    expect(r.usage.outputTokens).toBe(Math.ceil(r.outputText.length / 4));
    expect(r.stopReason).toBe("end_turn");
  });

  it("roster names are respected: cheapest for analysis/verification, mid-tier for builds", async () => {
    const mock = new MockModelProvider();
    const r = await mock.dispatch({ model: "mock-balanced", input: GOAL, system: PLAN_SYSTEM });
    const plan = parsePlan(r.outputText);
    expect(plan.nodes[0].agent).toBe("fast-mock");
    expect(plan.nodes[3].agent).toBe("fast-mock");
    expect(plan.nodes[1].agent).toBe("balanced-mock");
    expect(plan.nodes[2].agent).toBe("balanced-mock");
  });

  it("is deterministic across instances, and tier shapes instruction verbosity", async () => {
    const a = await new MockModelProvider().dispatch({ model: "mock-balanced", input: GOAL, system: PLAN_SYSTEM });
    const b = await new MockModelProvider().dispatch({ model: "mock-balanced", input: GOAL, system: PLAN_SYSTEM });
    expect(a.outputText).toBe(b.outputText);
    const fast = parsePlan((await new MockModelProvider().dispatch({ model: "mock-fast", input: GOAL, system: PLAN_SYSTEM })).outputText);
    const premium = parsePlan((await new MockModelProvider().dispatch({ model: "mock-premium", input: GOAL, system: PLAN_SYSTEM })).outputText);
    for (let i = 0; i < 4; i++) {
      expect(premium.nodes[i].instruction.length).toBeGreaterThan(fast.nodes[i].instruction.length);
    }
  });

  it("<<badplan>> emits broken JSON every time — the retry path cannot be rescued", async () => {
    const mock = new MockModelProvider();
    for (let i = 0; i < 2; i++) {
      const r = await mock.dispatch({ model: "mock-balanced", input: `${GOAL} <<badplan>>`, system: PLAN_SYSTEM });
      expect(r.refusal).toBe(false);
      const start = r.outputText.indexOf("{");
      expect(() => JSON.parse(r.outputText.slice(start))).toThrow();
    }
  });

  it("<<rogueagent>> assigns one node an agent outside the roster (substitution exercise)", async () => {
    const r = await new MockModelProvider().dispatch({ model: "mock-balanced", input: `${GOAL} <<rogueagent>>`, system: PLAN_SYSTEM });
    const plan = parsePlan(r.outputText);
    const rogue = plan.nodes.filter((n: any) => n.agent === "shadow-unsanctioned-agent");
    expect(rogue).toHaveLength(1);
  });

  it("refusal keeps precedence over planning, and non-sentinel system prompts stay canned prose", async () => {
    const refused = await new MockModelProvider().dispatch({ model: "mock-balanced", input: `${GOAL} <<refuse>>`, system: PLAN_SYSTEM });
    expect(refused.refusal).toBe(true);
    expect(refused.outputText).toBe("");
    const normal = await new MockModelProvider().dispatch({
      model: "mock-balanced",
      input: GOAL,
      system: "You are the API planning assistant.",
    });
    expect(normal.outputText.startsWith("Working within the signed-off scope: ")).toBe(true);
    expect(normal.outputText).not.toContain('"nodes"');
  });
});
