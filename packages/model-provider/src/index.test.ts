import { describe, expect, it } from "vitest";
import {
  AnthropicProvider,
  MockModelProvider,
  ModelProviderError,
  GoogleProvider,
  OpenAiProvider,
  XaiProvider,
  CONVERSATION_COMPACTION_SENTINEL,
  OPENAI_RESPONSES_ONLY_MODELS,
  TASK_DECOMPOSITION_SENTINEL,
  openAiUsesResponsesApi,
  CustomProvider,
  resolveModelProvider,
  ANTHROPIC_DEFAULT_BASE,
  OPENAI_DEFAULT_BASE,
  GOOGLE_DEFAULT_BASE,
  XAI_DEFAULT_BASE,
  defaultBaseUrlFor,
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

describe("multimodal attachments: image/document content blocks", () => {
  const okMessage = {
    id: "msg_mm_1",
    type: "message",
    role: "assistant",
    model: "claude-opus-5",
    content: [{ type: "text", text: "I see a red square." }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 20, output_tokens: 6 },
  };
  const IMG64 = "iVBORw0KGgoAAAANSU"; // truncated base64 stand-in — never sent to a network
  const PDF64 = "JVBERi0xLjQKJ";

  it("Anthropic maps image + document blocks to native base64 source blocks", async () => {
    let captured: Record<string, unknown> | null = null;
    const provider = new AnthropicProvider({
      apiKey: "test-key",
      fetchImpl: async (_url, init) => {
        captured = JSON.parse(String(init?.body));
        return anthropicJson(okMessage);
      },
    });
    await provider.dispatch({
      model: "claude-opus-5",
      // `input` is required by the contract but ignored whenever `messages` is
      // present (the newest turn rides inside `messages`); "" documents that.
      input: "",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "what's in these?" },
            { type: "image", mediaType: "image/png", dataBase64: IMG64, name: "square.png" },
            { type: "document", mediaType: "application/pdf", dataBase64: PDF64, name: "spec.pdf" },
          ],
        },
      ],
    });
    const blocks = (captured! as { messages: { content: unknown[] }[] }).messages[0]!.content;
    expect(blocks).toEqual([
      { type: "text", text: "what's in these?" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: IMG64 } },
      { type: "document", source: { type: "base64", media_type: "application/pdf", data: PDF64 } },
    ]);
  });

  it("providers without native vision degrade attachments to a named text placeholder, never dropping them", async () => {
    const mock = new MockModelProvider();
    const res = await mock.dispatch({
      model: "mock-1",
      input: "",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "describe" },
            { type: "image", mediaType: "image/png", dataBase64: IMG64, name: "square.png" },
          ],
        },
      ],
    });
    // the mock echoes the flattened turn text — the image is named, not silently lost
    expect(res.outputText).toContain("[attached image: square.png]");
    // the base64 bytes never appear in a non-vision provider's view of the turn
    expect(res.outputText).not.toContain(IMG64);
  });
});

describe("prompt caching (pillar 6): system-prefix cache_control", () => {
  const okMessage = {
    id: "msg_pc_1",
    type: "message",
    role: "assistant",
    model: "claude-opus-5",
    content: [{ type: "text", text: "ok" }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 5, output_tokens: 1 },
  };

  it("anthropic marks the system prefix cacheable with an ephemeral breakpoint when cacheSystem is set", async () => {
    let captured: Record<string, unknown> | null = null;
    const provider = new AnthropicProvider({
      apiKey: "k",
      fetchImpl: async (_url, init) => {
        captured = JSON.parse(String(init?.body));
        return anthropicJson(okMessage);
      },
    });
    await provider.dispatch({
      model: "claude-opus-5",
      input: "hello",
      system: "STABLE INSTRUCTIONS",
      cacheSystem: true,
    });
    expect(captured!.system).toEqual([
      { type: "text", text: "STABLE INSTRUCTIONS", cache_control: { type: "ephemeral" } },
    ]);
  });

  it("without cacheSystem the system prefix stays a plain string (byte-identical)", async () => {
    let captured: Record<string, unknown> | null = null;
    const provider = new AnthropicProvider({
      apiKey: "k",
      fetchImpl: async (_url, init) => {
        captured = JSON.parse(String(init?.body));
        return anthropicJson(okMessage);
      },
    });
    await provider.dispatch({ model: "claude-opus-5", input: "hello", system: "STABLE INSTRUCTIONS" });
    expect(captured!.system).toBe("STABLE INSTRUCTIONS");
  });

  it("mock records the cacheSystem flag it received so callers can assert it was set", async () => {
    const mock = new MockModelProvider();
    await mock.dispatch({ model: "mock-1", input: "hi", system: "s", cacheSystem: true });
    expect(mock.dispatches.at(-1)!.cacheSystem).toBe(true);
    await mock.dispatch({ model: "mock-1", input: "hi", system: "s" });
    expect(mock.dispatches.at(-1)!.cacheSystem).toBeUndefined();
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

describe("MockModelProvider conversation compaction (pillar 6)", () => {
  const COMPACT_SYSTEM = `${CONVERSATION_COMPACTION_SENTINEL}\nSummarize this conversation faithfully for continued assistance; preserve decisions, constraints, names, and numbers. Reply with only the summary.`;
  const TRANSCRIPT = [
    "user: plan the payments migration to the new gateway with zero downtime",
    "",
    "assistant: Plan — payments migration. Four steps: baseline, design, build, verify.",
    "",
    "user: review the rollback strategy for the vault_token cutover",
    "",
    "assistant: Review — rollback strategy. Solid direction, one issue to fix before sign-off.",
  ].join("\n");

  it("the sentinel flips the mock into a deterministic transcript-derived summary", async () => {
    const mock = new MockModelProvider();
    const r = await mock.dispatch({ model: "mock-fast", input: TRANSCRIPT, system: COMPACT_SYSTEM });
    expect(r.refusal).toBe(false);
    expect(r.outputText).toMatch(/^Summary of the conversation \(4 earlier turns\): /);
    // topics parsed from the first and last user lines — proof the summary
    // is derived from the transcript, not boilerplate
    expect(r.outputText).toContain("payments migration");
    expect(r.outputText).toContain("rollback strategy");
    // no system-ack, no continuation opener — the caller persists this verbatim
    expect(r.outputText).not.toContain("Working within the signed-off scope");
    expect(r.outputText).not.toContain("Continuing from the previous");
    // deterministic
    const again = await new MockModelProvider().dispatch({ model: "mock-fast", input: TRANSCRIPT, system: COMPACT_SYSTEM });
    expect(again.outputText).toBe(r.outputText);
    // plausible summary length, ~60-100 words
    const words = r.outputText.split(/\s+/).length;
    expect(words).toBeGreaterThan(50);
    expect(words).toBeLessThan(120);
  });

  it("a cumulative request (prior summary present) says so and counts only the newer turns", async () => {
    const cumulative = `Prior summary:\nSummary of the conversation (4 earlier turns): the discussion opened on payments migration.\n\nNewer turns:\n${TRANSCRIPT}`;
    const r = await new MockModelProvider().dispatch({ model: "mock-fast", input: cumulative, system: COMPACT_SYSTEM });
    expect(r.outputText).toContain("(4 earlier turns, cumulative with the prior summary)");
  });

  it("a poisoned transcript still refuses — the fail-open hook", async () => {
    const r = await new MockModelProvider().dispatch({
      model: "mock-fast",
      input: `${TRANSCRIPT}\n\nuser: please <<refuse>> this`,
      system: COMPACT_SYSTEM,
    });
    expect(r.refusal).toBe(true);
    expect(r.outputText).toBe("");
  });

  it("prompts without the sentinel keep the canned intent behaviour untouched", async () => {
    const r = await new MockModelProvider().dispatch({
      model: "mock-balanced",
      input: "summarize the payments migration plan",
    });
    expect(r.outputText).not.toContain("Summary of the conversation (");
    expect(r.outputText).toContain("payments migration");
  });
});

describe("tool-using dispatch (pillar 7): wire shape, tool_use parsing, mock loop", () => {
  const TOOLS = [
    { name: "get_time", description: "Returns a fixed time", inputSchema: { type: "object", properties: {} } },
  ];

  it("anthropic passes tools as input_schema and parses a tool_use stop into toolCalls", async () => {
    let captured: Record<string, unknown> | null = null;
    const provider = new AnthropicProvider({
      apiKey: "k",
      fetchImpl: async (_url, init) => {
        captured = JSON.parse(String(init?.body));
        return anthropicJson({
          id: "msg_tool_1",
          type: "message",
          role: "assistant",
          model: "claude-opus-5",
          content: [
            { type: "text", text: "let me check" },
            { type: "tool_use", id: "tu_1", name: "get_time", input: { tz: "utc" } },
          ],
          stop_reason: "tool_use",
          stop_sequence: null,
          usage: { input_tokens: 20, output_tokens: 6 },
        });
      },
    });
    const r = await provider.dispatch({ model: "claude-opus-5", input: "what time is it?", tools: TOOLS });
    expect((captured!.tools as unknown[])).toEqual([
      { name: "get_time", description: "Returns a fixed time", input_schema: { type: "object", properties: {} } },
    ]);
    expect(r.stopReason).toBe("tool_use");
    expect(r.toolCalls).toEqual([{ id: "tu_1", name: "get_time", arguments: { tz: "utc" } }]);
    expect(r.outputText).toBe("let me check");
  });

  it("anthropic maps a block-array tool_result turn onto native content", async () => {
    let captured: Record<string, unknown> | null = null;
    const provider = new AnthropicProvider({
      apiKey: "k",
      fetchImpl: async (_url, init) => {
        captured = JSON.parse(String(init?.body));
        return anthropicJson({
          id: "msg_tool_2", type: "message", role: "assistant", model: "claude-opus-5",
          content: [{ type: "text", text: "it is 12:00" }],
          stop_reason: "end_turn", stop_sequence: null,
          usage: { input_tokens: 40, output_tokens: 4 },
        });
      },
    });
    await provider.dispatch({
      model: "claude-opus-5",
      input: "IGNORED",
      messages: [
        { role: "user", content: "what time is it?" },
        { role: "assistant", content: [{ type: "tool_use", id: "tu_1", name: "get_time", input: {} }] },
        { role: "user", content: [{ type: "tool_result", toolUseId: "tu_1", content: "12:00" }] },
      ],
    });
    expect(captured!.messages).toEqual([
      { role: "user", content: "what time is it?" },
      { role: "assistant", content: [{ type: "tool_use", id: "tu_1", name: "get_time", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_1", content: "12:00" }] },
    ]);
  });

  it("openai maps tools to function tools and tool_calls into toolCalls; block turns flatten", async () => {
    let captured: Record<string, unknown> | null = null;
    const provider = new OpenAiProvider({
      apiKey: "k",
      fetchImpl: async (_url, init) => {
        captured = JSON.parse(String(init?.body));
        return new Response(
          JSON.stringify({
            id: "cc_tool_1",
            choices: [
              {
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    { id: "call_1", type: "function", function: { name: "get_time", arguments: '{"tz":"utc"}' } },
                  ],
                },
                finish_reason: "tool_calls",
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 3 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });
    const r = await provider.dispatch({
      model: "gpt-x",
      input: "IGNORED",
      tools: TOOLS,
      messages: [
        { role: "user", content: "what time is it?" },
        { role: "assistant", content: [{ type: "tool_use", id: "call_0", name: "get_time", input: {} }] },
        { role: "user", content: [{ type: "tool_result", toolUseId: "call_0", content: "11:00" }] },
      ],
    });
    const tools = captured!.tools as Array<{ type: string; function: { name: string } }>;
    expect(tools[0]!.type).toBe("function");
    expect(tools[0]!.function.name).toBe("get_time");
    const msgs = captured!.messages as Array<Record<string, unknown>>;
    // assistant tool_use flattened to tool_calls, tool_result to a tool message
    expect(msgs.some((m) => m.role === "assistant" && Array.isArray(m.tool_calls))).toBe(true);
    expect(msgs.some((m) => m.role === "tool" && m.tool_call_id === "call_0" && m.content === "11:00")).toBe(true);
    expect(r.stopReason).toBe("tool_use");
    expect(r.toolCalls).toEqual([{ id: "call_1", name: "get_time", arguments: { tz: "utc" } }]);
  });

  it("a tools-free request is byte-identical: no tools field, content stays a string", async () => {
    let captured: Record<string, unknown> | null = null;
    const provider = new AnthropicProvider({
      apiKey: "k",
      fetchImpl: async (_url, init) => {
        captured = JSON.parse(String(init?.body));
        return anthropicJson({
          id: "m", type: "message", role: "assistant", model: "claude-opus-5",
          content: [{ type: "text", text: "hi" }], stop_reason: "end_turn", stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        });
      },
    });
    const r = await provider.dispatch({ model: "claude-opus-5", input: "hello" });
    expect("tools" in captured!).toBe(false);
    expect(captured!.messages).toEqual([{ role: "user", content: "hello" }]);
    expect(r.toolCalls).toBeUndefined();
    expect(r.stopReason).toBe("end_turn");
  });

  it("mock emits ONE tool_use on the sentinel, then finalizes quoting the tool result", async () => {
    const mock = new MockModelProvider();
    const first = await mock.dispatch({
      model: "mock-1",
      input: "please <<use-tool:get_time>> and answer",
      tools: TOOLS,
    });
    expect(first.stopReason).toBe("tool_use");
    expect(first.toolCalls).toHaveLength(1);
    expect(first.toolCalls![0]!.name).toBe("get_time");
    expect(first.outputText).toBe("");

    const second = await mock.dispatch({
      model: "mock-1",
      input: "IGNORED",
      tools: TOOLS,
      messages: [
        { role: "user", content: "please <<use-tool:get_time>> and answer" },
        { role: "assistant", content: [{ type: "tool_use", id: first.toolCalls![0]!.id, name: "get_time", input: {} }] },
        { role: "user", content: [{ type: "tool_result", toolUseId: first.toolCalls![0]!.id, content: "12:00" }] },
      ],
    });
    expect(second.stopReason).toBe("end_turn");
    expect(second.toolCalls).toBeUndefined();
    expect(second.outputText).toContain("12:00");
  });

  it("mock loop sentinel keeps requesting the tool even after a tool_result (maxTurns fuel)", async () => {
    const mock = new MockModelProvider();
    const r = await mock.dispatch({
      model: "mock-1",
      input: "IGNORED",
      tools: TOOLS,
      messages: [
        { role: "user", content: "keep going <<use-tool-loop:get_time>>" },
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "get_time", input: {} }] },
        { role: "user", content: [{ type: "tool_result", toolUseId: "t1", content: "12:00" }] },
      ],
    });
    expect(r.stopReason).toBe("tool_use");
    expect(r.toolCalls![0]!.name).toBe("get_time");
  });

  it("<<refuse>> still takes precedence over a tool sentinel", async () => {
    const r = await new MockModelProvider().dispatch({
      model: "mock-1",
      input: "please <<use-tool:get_time>> but also <<refuse>>",
      tools: TOOLS,
    });
    expect(r.refusal).toBe(true);
    expect(r.stopReason).toBe("refusal");
    expect(r.toolCalls).toBeUndefined();
  });
});

describe("OpenAI Responses API surface (Responses-only models)", () => {
  /** a complete terminal Response object as the Responses API returns it */
  const responsesResult = (overrides: Record<string, unknown> = {}) => ({
    id: "resp_1",
    object: "response",
    created_at: 1,
    status: "completed",
    error: null,
    incomplete_details: null,
    instructions: null,
    metadata: null,
    model: "o3-pro",
    output: [
      { type: "reasoning", id: "rs_1", summary: [] },
      {
        type: "message",
        id: "msg_1",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text: "42", annotations: [] }],
      },
    ],
    parallel_tool_calls: true,
    temperature: null,
    tool_choice: "auto",
    tools: [],
    top_p: null,
    usage: {
      input_tokens: 17,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 20,
      output_tokens_details: { reasoning_tokens: 12 },
      total_tokens: 37,
    },
    ...overrides,
  });
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it("selection rule: only the static Responses-only list routes to Responses, incl. dated variants", () => {
    for (const m of OPENAI_RESPONSES_ONLY_MODELS) expect(openAiUsesResponsesApi(m)).toBe(true);
    expect(openAiUsesResponsesApi("o3-pro-2025-06-10")).toBe(true);
    expect(openAiUsesResponsesApi("gpt-5-pro-2025-10-06")).toBe(true);
    // everything chat-capable today stays on chat completions — behavior-preserving
    for (const m of ["gpt-5", "gpt-5-mini", "gpt-4o", "gpt-4.1", "o1", "o1-preview", "o3", "o3-mini", "o4-mini", "grok-4"]) {
      expect(openAiUsesResponsesApi(m)).toBe(false);
    }
  });

  it("dispatches a Responses-only model via /responses with instructions, input items, and store:false", async () => {
    let captured: { url: string; body: Record<string, unknown> } | null = null;
    const provider = new OpenAiProvider({
      apiKey: "sk-test",
      fetchImpl: async (url, init) => {
        captured = { url: String(url), body: JSON.parse(String(init?.body)) };
        return json(responsesResult());
      },
    });
    const result = await provider.dispatch({
      model: "o3-pro",
      input: "what is 6*7?",
      system: "answer tersely",
      maxTokens: 64,
    });
    expect(captured!.url).toContain("/responses");
    expect(captured!.url).not.toContain("/chat/completions");
    expect(captured!.body).toMatchObject({
      model: "o3-pro",
      max_output_tokens: 64,
      instructions: "answer tersely",
      input: [{ type: "message", role: "user", content: "what is 6*7?" }],
      store: false,
    });
    expect(result.outputText).toBe("42");
    expect(result.stopReason).toBe("end_turn");
    expect(result.refusal).toBe(false);
    expect(result.providerMessageId).toBe("resp_1");
  });

  it("usage extraction: outputTokens stays the provider's billed total; reasoning tokens surface distinctly", async () => {
    const provider = new OpenAiProvider({
      apiKey: "sk-test",
      fetchImpl: async () => json(responsesResult()),
    });
    const r = await provider.dispatch({ model: "o3-pro", input: "x" });
    // OpenAI's output_tokens already INCLUDES reasoning; never folded twice
    expect(r.usage.inputTokens).toBe(17);
    expect(r.usage.outputTokens).toBe(20);
    expect(r.usage.reasoningTokens).toBe(12);
  });

  it("zero reasoning tokens leaves the reasoningTokens field absent (other adapters' shape unchanged)", async () => {
    const provider = new OpenAiProvider({
      apiKey: "sk-test",
      fetchImpl: async () =>
        json(
          responsesResult({
            usage: {
              input_tokens: 9,
              input_tokens_details: { cached_tokens: 0 },
              output_tokens: 3,
              output_tokens_details: { reasoning_tokens: 0 },
              total_tokens: 12,
            },
          }),
        ),
    });
    const r = await provider.dispatch({ model: "o3-pro", input: "x" });
    expect(r.usage).toEqual({ inputTokens: 9, outputTokens: 3 });
    expect("reasoningTokens" in r.usage).toBe(false);
  });

  it("regression: a chat-capable model keeps the existing chat-completions path, byte-identical", async () => {
    let captured: { url: string; body: Record<string, unknown> } | null = null;
    const provider = new OpenAiProvider({
      apiKey: "sk-test",
      fetchImpl: async (url, init) => {
        captured = { url: String(url), body: JSON.parse(String(init?.body)) };
        return json({
          id: "chatcmpl-keep",
          object: "chat.completion",
          created: 1,
          model: "gpt-5",
          choices: [{ index: 0, message: { role: "assistant", content: "ok", refusal: null }, finish_reason: "stop", logprobs: null }],
          usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
        });
      },
    });
    const r = await provider.dispatch({ model: "gpt-5", input: "hi", system: "s" });
    expect(captured!.url).toContain("/chat/completions");
    // the chat request shape is untouched: messages + max_completion_tokens, no Responses fields
    expect(captured!.body).toMatchObject({
      model: "gpt-5",
      messages: [
        { role: "system", content: "s" },
        { role: "user", content: "hi" },
      ],
    });
    expect("input" in captured!.body).toBe(false);
    expect("instructions" in captured!.body).toBe(false);
    expect(r.providerMessageId).toBe("chatcmpl-keep");
  });

  it("xai never consults the Responses list — even a Responses-only id rides chat completions there", async () => {
    let url = "";
    const provider = new XaiProvider({
      apiKey: "xk",
      fetchImpl: async (u) => {
        url = String(u);
        return json({
          id: "chatcmpl-x",
          object: "chat.completion",
          created: 1,
          model: "o3-pro",
          choices: [{ index: 0, message: { role: "assistant", content: "ok", refusal: null }, finish_reason: "stop", logprobs: null }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });
      },
    });
    await provider.dispatch({ model: "o3-pro", input: "x" });
    expect(url).toContain("/chat/completions");
    expect(url).not.toMatch(/\/responses$/);
  });

  it("tool defs flatten to the Responses tool format and a function_call item parses into toolCalls", async () => {
    let captured: Record<string, unknown> | null = null;
    const provider = new OpenAiProvider({
      apiKey: "sk-test",
      fetchImpl: async (_url, init) => {
        captured = JSON.parse(String(init?.body));
        return json(
          responsesResult({
            output: [
              { type: "function_call", id: "fc_1", call_id: "call_1", name: "get_time", arguments: '{"tz":"utc"}', status: "completed" },
            ],
          }),
        );
      },
    });
    const r = await provider.dispatch({
      model: "o3-pro",
      input: "what time is it?",
      tools: [{ name: "get_time", description: "Returns a fixed time", inputSchema: { type: "object", properties: {} } }],
    });
    // flattened: no nested `function` object, unlike chat completions
    expect(captured!.tools).toEqual([
      {
        type: "function",
        name: "get_time",
        description: "Returns a fixed time",
        parameters: { type: "object", properties: {} },
        strict: false,
      },
    ]);
    expect(r.stopReason).toBe("tool_use");
    expect(r.toolCalls).toEqual([{ id: "call_1", name: "get_time", arguments: { tz: "utc" } }]);
  });

  it("tool round-trip history translates to function_call / function_call_output input items", async () => {
    let captured: Record<string, unknown> | null = null;
    const provider = new OpenAiProvider({
      apiKey: "sk-test",
      fetchImpl: async (_url, init) => {
        captured = JSON.parse(String(init?.body));
        return json(
          responsesResult({
            output: [
              {
                type: "message",
                id: "msg_2",
                status: "completed",
                role: "assistant",
                content: [{ type: "output_text", text: "it is 12:00", annotations: [] }],
              },
            ],
          }),
        );
      },
    });
    const r = await provider.dispatch({
      model: "o3-pro",
      input: "IGNORED",
      messages: [
        { role: "user", content: "what time is it?" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "let me check" },
            { type: "tool_use", id: "call_1", name: "get_time", input: { tz: "utc" } },
          ],
        },
        { role: "user", content: [{ type: "tool_result", toolUseId: "call_1", content: "12:00" }] },
      ],
    });
    expect(captured!.input).toEqual([
      { type: "message", role: "user", content: "what time is it?" },
      { type: "message", role: "assistant", content: "let me check" },
      { type: "function_call", call_id: "call_1", name: "get_time", arguments: '{"tz":"utc"}' },
      { type: "function_call_output", call_id: "call_1", output: "12:00" },
    ]);
    expect(JSON.stringify(captured)).not.toContain("IGNORED");
    expect(r.outputText).toBe("it is 12:00");
    expect(r.stopReason).toBe("end_turn");
  });

  it("streams output_text deltas onto onText and normalizes the terminal response.completed snapshot", async () => {
    const chunk = (c: unknown) => "data: " + JSON.stringify(c) + "\n\n";
    const final = responsesResult({
      id: "resp_s1",
      output: [
        {
          type: "message",
          id: "msg_s1",
          status: "completed",
          role: "assistant",
          content: [{ type: "output_text", text: "Hello world", annotations: [] }],
        },
      ],
      usage: {
        input_tokens: 12,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens: 9,
        output_tokens_details: { reasoning_tokens: 4 },
        total_tokens: 21,
      },
    });
    const sse =
      chunk({ type: "response.created", response: responsesResult({ id: "resp_s1", status: "in_progress", output: [], usage: null }), sequence_number: 0 }) +
      chunk({ type: "response.output_text.delta", delta: "Hello ", content_index: 0, item_id: "msg_s1", output_index: 0, logprobs: [], sequence_number: 1 }) +
      chunk({ type: "response.output_text.delta", delta: "world", content_index: 0, item_id: "msg_s1", output_index: 0, logprobs: [], sequence_number: 2 }) +
      chunk({ type: "response.completed", response: final, sequence_number: 3 });
    let sawStreamFlag = false;
    const provider = new OpenAiProvider({
      apiKey: "sk-test",
      fetchImpl: async (_url, init) => {
        sawStreamFlag = JSON.parse(String(init?.body)).stream === true;
        return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
      },
    });
    const deltas: string[] = [];
    const result = await provider.dispatch({ model: "o3-pro", input: "greet", onText: (d) => deltas.push(d) });
    expect(sawStreamFlag).toBe(true);
    expect(deltas).toEqual(["Hello ", "world"]);
    expect(result.outputText).toBe("Hello world");
    expect(result.stopReason).toBe("end_turn");
    expect(result.usage).toEqual({ inputTokens: 12, outputTokens: 9, reasoningTokens: 4 });
    expect(result.providerMessageId).toBe("resp_s1");
  });

  it("incomplete_details max_output_tokens maps to max_tokens without suppressing partial text", async () => {
    const provider = new OpenAiProvider({
      apiKey: "sk-test",
      fetchImpl: async () =>
        json(
          responsesResult({
            status: "incomplete",
            incomplete_details: { reason: "max_output_tokens" },
            output: [
              {
                type: "message",
                id: "msg_3",
                status: "incomplete",
                role: "assistant",
                content: [{ type: "output_text", text: "partial", annotations: [] }],
              },
            ],
          }),
        ),
    });
    const r = await provider.dispatch({ model: "o3-pro", input: "x" });
    expect(r.stopReason).toBe("max_tokens");
    expect(r.refusal).toBe(false);
    expect(r.outputText).toBe("partial");
  });

  it("a refusal content part or a content_filter incomplete never surfaces content as an answer", async () => {
    const refusalPart = new OpenAiProvider({
      apiKey: "sk-test",
      fetchImpl: async () =>
        json(
          responsesResult({
            output: [
              {
                type: "message",
                id: "msg_4",
                status: "completed",
                role: "assistant",
                content: [
                  { type: "output_text", text: "partial before refusal", annotations: [] },
                  { type: "refusal", refusal: "I cannot help with that" },
                ],
              },
            ],
          }),
        ),
    });
    const a = await refusalPart.dispatch({ model: "o3-pro", input: "x" });
    expect(a.refusal).toBe(true);
    expect(a.stopReason).toBe("refusal");
    expect(a.outputText).toBe("");

    const filtered = new OpenAiProvider({
      apiKey: "sk-test",
      fetchImpl: async () =>
        json(
          responsesResult({
            status: "incomplete",
            incomplete_details: { reason: "content_filter" },
          }),
        ),
    });
    const b = await filtered.dispatch({ model: "o3-pro", input: "x" });
    expect(b.refusal).toBe(true);
    expect(b.outputText).toBe("");
  });

  it("wraps Responses API errors as ModelProviderError with status", async () => {
    const provider = new OpenAiProvider({
      apiKey: "sk-bad",
      fetchImpl: async () =>
        json({ error: { message: "Incorrect API key", type: "invalid_request_error" } }, 401),
    });
    await expect(provider.dispatch({ model: "o3-pro", input: "x" })).rejects.toThrowError(
      ModelProviderError,
    );
    await expect(provider.dispatch({ model: "o3-pro", input: "x" })).rejects.toMatchObject({
      status: 401,
    });
  });
});

describe("Google tool-use mapping (functionDeclarations / functionCall / functionResponse)", () => {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const okText = (text: string) => ({
    responseId: "resp-gt1",
    candidates: [{ content: { role: "model", parts: [{ text }] }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 },
  });
  const capture = (body: unknown = okText("ok")) => {
    const box: { body: Record<string, unknown> | null } = { body: null };
    const provider = new GoogleProvider({
      apiKey: "gk",
      fetchImpl: async (_url, init) => {
        box.body = JSON.parse(String(init?.body));
        return json(body);
      },
    });
    return { box, provider };
  };

  it("translates a nested JSON schema (objects/arrays/enum/required) into Gemini's dialect", async () => {
    const { box, provider } = capture();
    await provider.dispatch({
      model: "gemini-2.5-pro",
      input: "book it",
      tools: [
        {
          name: "book_meeting",
          description: "Books a meeting",
          inputSchema: {
            $schema: "http://json-schema.org/draft-07/schema#",
            type: "object",
            additionalProperties: false,
            properties: {
              title: { type: "string", description: "Meeting title" },
              attendees: {
                type: "array",
                minItems: 1,
                items: {
                  type: "object",
                  properties: {
                    email: { type: "string", format: "email" },
                    role: { type: "string", enum: ["organizer", "guest"] },
                  },
                  required: ["email"],
                  additionalProperties: false,
                },
              },
            },
            required: ["title", "attendees"],
          },
        },
      ],
    });
    const decls = (box.body!.tools as Array<{ functionDeclarations: unknown[] }>)[0]!
      .functionDeclarations as Array<Record<string, unknown>>;
    expect(decls[0]!.name).toBe("book_meeting");
    expect(decls[0]!.description).toBe("Books a meeting");
    // Gemini's dialect: uppercase type enums, required preserved, unknown
    // keywords ($schema, additionalProperties) dropped so proto parsing
    // cannot 400 — at every nesting level
    expect(decls[0]!.parameters).toEqual({
      type: "OBJECT",
      required: ["title", "attendees"],
      properties: {
        title: { type: "STRING", description: "Meeting title" },
        attendees: {
          type: "ARRAY",
          minItems: 1,
          items: {
            type: "OBJECT",
            required: ["email"],
            properties: {
              email: { type: "STRING", format: "email" },
              role: { type: "STRING", enum: ["organizer", "guest"] },
            },
          },
        },
      },
    });
  });

  it("handles nullable, const, and oneOf: union-with-null becomes nullable, const becomes enum, oneOf becomes anyOf", async () => {
    const { box, provider } = capture();
    await provider.dispatch({
      model: "gemini-2.5-pro",
      input: "go",
      tools: [
        {
          name: "configure",
          inputSchema: {
            type: "object",
            properties: {
              note: { type: ["string", "null"] },
              mode: { type: "string", const: "fast" },
              limit: { oneOf: [{ type: "integer" }, { type: "null" }] },
            },
            required: ["mode"],
          },
        },
      ],
    });
    const decl = (box.body!.tools as Array<{ functionDeclarations: Array<Record<string, unknown>> }>)[0]!
      .functionDeclarations[0]!;
    const props = (decl.parameters as { properties: Record<string, unknown> }).properties;
    expect(props.note).toEqual({ type: "STRING", nullable: true });
    expect(props.mode).toEqual({ type: "STRING", enum: ["fast"] });
    expect(props.limit).toEqual({ anyOf: [{ type: "INTEGER" }, { nullable: true }] });
  });

  it("a no-arg tool omits `parameters` entirely — Gemini rejects an empty OBJECT schema", async () => {
    const { box, provider } = capture();
    await provider.dispatch({
      model: "gemini-2.5-pro",
      input: "time?",
      tools: [{ name: "get_time", description: "Returns the time", inputSchema: { type: "object", properties: {} } }],
    });
    const decl = (box.body!.tools as Array<{ functionDeclarations: Array<Record<string, unknown>> }>)[0]!
      .functionDeclarations[0]!;
    expect(decl).toEqual({ name: "get_time", description: "Returns the time" });
    expect("parameters" in decl).toBe(false);
  });

  it("an assistant tool_use turn becomes a model-role functionCall part; non-object args coerce to {}", async () => {
    const { box, provider } = capture();
    await provider.dispatch({
      model: "gemini-2.5-pro",
      input: "IGNORED",
      messages: [
        { role: "user", content: "what time is it in utc?" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "checking" },
            { type: "tool_use", id: "fc-0", name: "get_time", input: { tz: "utc" } },
            { type: "tool_use", id: "fc-1", name: "get_time", input: "not-an-object" },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", toolUseId: "fc-0", content: "12:00" },
            { type: "tool_result", toolUseId: "fc-1", content: "13:00" },
          ],
        },
      ],
    });
    const contents = box.body!.contents as Array<{ role: string; parts: unknown[] }>;
    expect(contents[1]).toEqual({
      role: "model",
      parts: [
        { text: "checking" },
        { functionCall: { name: "get_time", args: { tz: "utc" } } },
        { functionCall: { name: "get_time", args: {} } },
      ],
    });
  });

  it("tool_result turns become user-role functionResponse parts paired by tool NAME, in call order", async () => {
    const { box, provider } = capture();
    await provider.dispatch({
      model: "gemini-2.5-pro",
      input: "IGNORED",
      messages: [
        { role: "user", content: "weather and time please" },
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "resp-1-fc-0", name: "get_weather", input: { city: "Oslo" } },
            { type: "tool_use", id: "resp-1-fc-1", name: "get_time", input: {} },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", toolUseId: "resp-1-fc-0", content: "rainy" },
            { type: "tool_result", toolUseId: "resp-1-fc-1", content: "12:00" },
          ],
        },
      ],
    });
    const contents = box.body!.contents as Array<{ role: string; parts: unknown[] }>;
    // Gemini requires the role/name pairing exactly: functionResponses ride in
    // a USER turn, each named after the tool that was CALLED — never the call id
    expect(contents[2]).toEqual({
      role: "user",
      parts: [
        { functionResponse: { name: "get_weather", response: { output: "rainy" } } },
        { functionResponse: { name: "get_time", response: { output: "12:00" } } },
      ],
    });
  });

  it("an isError tool_result maps to the documented { error: … } response convention", async () => {
    const { box, provider } = capture();
    await provider.dispatch({
      model: "gemini-2.5-pro",
      input: "IGNORED",
      messages: [
        { role: "user", content: "look this up" },
        { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "lookup", input: {} }] },
        { role: "user", content: [{ type: "tool_result", toolUseId: "c1", content: "boom: upstream 500", isError: true }] },
      ],
    });
    const contents = box.body!.contents as Array<{ role: string; parts: unknown[] }>;
    expect(contents[2]!.parts).toEqual([
      { functionResponse: { name: "lookup", response: { error: "boom: upstream 500" } } },
    ]);
  });

  it("a tool_result with no matching tool_use in history degrades to the raw id as name, never dropped", async () => {
    const { box, provider } = capture();
    await provider.dispatch({
      model: "gemini-2.5-pro",
      input: "IGNORED",
      messages: [
        { role: "user", content: [{ type: "tool_result", toolUseId: "orphan-1", content: "data" }] },
      ],
    });
    const contents = box.body!.contents as Array<{ role: string; parts: unknown[] }>;
    expect(contents[0]!.parts).toEqual([
      { functionResponse: { name: "orphan-1", response: { output: "data" } } },
    ]);
  });

  it("parallel functionCall parts in one candidate become distinct toolCalls with stopReason tool_use", async () => {
    const provider = new GoogleProvider({
      apiKey: "gk",
      fetchImpl: async () =>
        json({
          responseId: "resp-par1",
          candidates: [
            {
              content: {
                role: "model",
                parts: [
                  { functionCall: { name: "get_weather", args: { city: "Oslo" } } },
                  { functionCall: { name: "get_time", args: {} } },
                ],
              },
              finishReason: "STOP",
            },
          ],
          usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 6 },
        }),
    });
    const r = await provider.dispatch({
      model: "gemini-2.5-pro",
      input: "weather and time please",
      tools: [
        { name: "get_weather", inputSchema: { type: "object", properties: { city: { type: "string" } } } },
        { name: "get_time", inputSchema: { type: "object", properties: {} } },
      ],
    });
    // the model stopped TO CALL TOOLS: finishReason STOP + functionCall parts
    expect(r.stopReason).toBe("tool_use");
    expect(r.refusal).toBe(false);
    expect(r.toolCalls).toHaveLength(2);
    expect(r.toolCalls![0]).toMatchObject({ name: "get_weather", arguments: { city: "Oslo" } });
    expect(r.toolCalls![1]).toMatchObject({ name: "get_time", arguments: {} });
    expect(r.toolCalls![0]!.id).not.toBe(r.toolCalls![1]!.id);
    expect(r.usage).toEqual({ inputTokens: 11, outputTokens: 6 });
  });

  it("full round trip: call → result → follow-up turn keeps every wire shape exact", async () => {
    const { box, provider } = capture({
      responseId: "resp-rt2",
      candidates: [
        { content: { role: "model", parts: [{ text: "It is rainy in Oslo." }] }, finishReason: "STOP" },
      ],
      usageMetadata: { promptTokenCount: 40, candidatesTokenCount: 7 },
    });
    const r = await provider.dispatch({
      model: "gemini-2.5-pro",
      input: "IGNORED",
      system: "be brief",
      tools: [{ name: "get_weather", inputSchema: { type: "object", properties: { city: { type: "string" } } } }],
      messages: [
        { role: "user", content: "what's the weather in Oslo?" },
        { role: "assistant", content: [{ type: "tool_use", id: "resp-rt1-fc-0", name: "get_weather", input: { city: "Oslo" } }] },
        { role: "user", content: [{ type: "tool_result", toolUseId: "resp-rt1-fc-0", content: "rainy" }] },
      ],
    });
    expect(box.body!.contents).toEqual([
      { role: "user", parts: [{ text: "what's the weather in Oslo?" }] },
      { role: "model", parts: [{ functionCall: { name: "get_weather", args: { city: "Oslo" } } }] },
      { role: "user", parts: [{ functionResponse: { name: "get_weather", response: { output: "rainy" } } }] },
    ]);
    expect(box.body!.systemInstruction).toEqual({ parts: [{ text: "be brief" }] });
    // the follow-up finalizes as plain text — a normal end_turn answer
    expect(r.outputText).toBe("It is rainy in Oslo.");
    expect(r.stopReason).toBe("end_turn");
    expect(r.toolCalls).toBeUndefined();
    expect(r.usage).toEqual({ inputTokens: 40, outputTokens: 7 });
  });

  it("streamed functionCall parts accumulate into toolCalls exactly like the non-streaming path", async () => {
    const chunk = (c: unknown) => "data: " + JSON.stringify(c) + "\n\n";
    const sse =
      chunk({ responseId: "resp-st1", candidates: [{ content: { parts: [{ text: "checking " }] } }] }) +
      chunk({
        candidates: [
          {
            content: { parts: [{ functionCall: { name: "get_time", args: { tz: "utc" } } }] },
            finishReason: "STOP",
          },
        ],
        usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 3 },
      });
    const provider = new GoogleProvider({
      apiKey: "gk",
      fetchImpl: async () =>
        new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }),
    });
    const deltas: string[] = [];
    const r = await provider.dispatch({
      model: "gemini-2.5-pro",
      input: "time?",
      tools: [{ name: "get_time", inputSchema: { type: "object", properties: { tz: { type: "string" } } } }],
      onText: (d) => deltas.push(d),
    });
    expect(deltas).toEqual(["checking "]);
    expect(r.stopReason).toBe("tool_use");
    expect(r.toolCalls).toEqual([
      { id: "resp-st1-fc-0", name: "get_time", arguments: { tz: "utc" } },
    ]);
  });

  it("a Gemini error shape mid-tool-flow still wraps as ModelProviderError with status", async () => {
    const provider = new GoogleProvider({
      apiKey: "gk",
      fetchImpl: async () =>
        json(
          {
            error: {
              code: 400,
              message: 'Invalid JSON payload received. Unknown name "additionalProperties"',
              status: "INVALID_ARGUMENT",
            },
          },
          400,
        ),
    });
    await expect(
      provider.dispatch({
        model: "gemini-2.5-pro",
        input: "x",
        tools: [{ name: "t", inputSchema: { type: "object", properties: { a: { type: "string" } } } }],
      }),
    ).rejects.toMatchObject({ status: 400 });
  });
});

// ===========================================================================
// ADR-0020 COMPAT LONG TAIL — toolChoice / responseFormat / thinking.
// Every mapping below is a REAL wire assertion against a fake upstream (the
// same injectable-fetch discipline as everything above): the neutral field
// either lands as the provider's native parameter, or the adapter throws —
// never a silent drop.
// ===========================================================================

describe("toolChoice wire mappings (ADR-0020 long tail)", () => {
  const anthropicOk = {
    id: "msg_tc_1",
    type: "message",
    role: "assistant",
    model: "claude-opus-5",
    content: [{ type: "text", text: "ok" }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 5, output_tokens: 1 },
  };
  const openaiOk = {
    id: "chatcmpl-tc1",
    object: "chat.completion",
    created: 1,
    model: "gpt-5",
    choices: [
      { index: 0, message: { role: "assistant", content: "ok", refusal: null }, finish_reason: "stop", logprobs: null },
    ],
    usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
  };
  const TOOLS = [{ name: "lookup", inputSchema: { type: "object", properties: {} } }];

  async function capturedAnthropic(toolChoice: "auto" | "none" | "required" | { name: string }) {
    let captured: Record<string, unknown> | null = null;
    const provider = new AnthropicProvider({
      apiKey: "k",
      fetchImpl: async (_url, init) => {
        captured = JSON.parse(String(init?.body));
        return anthropicJson(anthropicOk);
      },
    });
    await provider.dispatch({ model: "claude-opus-5", input: "x", tools: TOOLS, toolChoice });
    return captured!;
  }

  it("anthropic: auto/none map onto the native {type} shapes", async () => {
    expect((await capturedAnthropic("auto")).tool_choice).toEqual({ type: "auto" });
    expect((await capturedAnthropic("none")).tool_choice).toEqual({ type: "none" });
  });

  it("anthropic: 'required' maps onto {type:'any'}", async () => {
    expect((await capturedAnthropic("required")).tool_choice).toEqual({ type: "any" });
  });

  it("anthropic: a named tool maps onto {type:'tool', name}", async () => {
    expect((await capturedAnthropic({ name: "lookup" })).tool_choice).toEqual({
      type: "tool",
      name: "lookup",
    });
  });

  it("anthropic: no toolChoice sends NO tool_choice field (byte-identical to before)", async () => {
    let captured: Record<string, unknown> | null = null;
    const provider = new AnthropicProvider({
      apiKey: "k",
      fetchImpl: async (_url, init) => {
        captured = JSON.parse(String(init?.body));
        return anthropicJson(anthropicOk);
      },
    });
    await provider.dispatch({ model: "claude-opus-5", input: "x", tools: TOOLS });
    expect("tool_choice" in captured!).toBe(false);
  });

  async function capturedOpenAi(toolChoice: "auto" | "none" | "required" | { name: string }) {
    let captured: Record<string, unknown> | null = null;
    const provider = new OpenAiProvider({
      apiKey: "k",
      fetchImpl: async (_url, init) => {
        captured = JSON.parse(String(init?.body));
        return new Response(JSON.stringify(openaiOk), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    await provider.dispatch({ model: "gpt-5", input: "x", tools: TOOLS, toolChoice });
    return captured!;
  }

  it("openai: the string variants pass through verbatim", async () => {
    expect((await capturedOpenAi("auto")).tool_choice).toBe("auto");
    expect((await capturedOpenAi("none")).tool_choice).toBe("none");
    expect((await capturedOpenAi("required")).tool_choice).toBe("required");
  });

  it("openai: a named tool maps onto {type:'function', function:{name}}", async () => {
    expect((await capturedOpenAi({ name: "lookup" })).tool_choice).toEqual({
      type: "function",
      function: { name: "lookup" },
    });
  });

  it("openai responses API: a named tool flattens to {type:'function', name}", async () => {
    let captured: Record<string, unknown> | null = null;
    const provider = new OpenAiProvider({
      apiKey: "k",
      fetchImpl: async (_url, init) => {
        captured = JSON.parse(String(init?.body));
        return new Response(
          JSON.stringify({
            id: "resp_tc1",
            object: "response",
            status: "completed",
            output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
            usage: { input_tokens: 5, output_tokens: 1 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });
    await provider.dispatch({ model: "o3-pro", input: "x", tools: TOOLS, toolChoice: { name: "lookup" } });
    expect(captured!.tool_choice).toEqual({ type: "function", name: "lookup" });
  });

  it("xai: same OpenAI-compatible shapes, pointed at api.x.ai", async () => {
    let captured: { url: string; body: Record<string, unknown> } | null = null;
    const provider = new XaiProvider({
      apiKey: "k",
      fetchImpl: async (url, init) => {
        captured = { url: String(url), body: JSON.parse(String(init?.body)) };
        return new Response(JSON.stringify({ ...openaiOk, model: "grok-4" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    await provider.dispatch({ model: "grok-4", input: "x", tools: TOOLS, toolChoice: { name: "lookup" } });
    expect(captured!.url.startsWith("https://api.x.ai/v1")).toBe(true);
    expect(captured!.body.tool_choice).toEqual({ type: "function", function: { name: "lookup" } });
  });

  async function capturedGoogle(toolChoice: "auto" | "none" | "required" | { name: string }) {
    let captured: Record<string, unknown> | null = null;
    const provider = new GoogleProvider({
      apiKey: "k",
      fetchImpl: async (_url, init) => {
        captured = JSON.parse(String(init?.body));
        return new Response(
          JSON.stringify({
            responseId: "resp-tc1",
            candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
            usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 1 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });
    await provider.dispatch({ model: "gemini-2.5-pro", input: "x", tools: TOOLS, toolChoice });
    return captured!;
  }

  it("google: auto/none/required map onto functionCallingConfig AUTO/NONE/ANY", async () => {
    expect((await capturedGoogle("auto")).toolConfig).toEqual({
      functionCallingConfig: { mode: "AUTO" },
    });
    expect((await capturedGoogle("none")).toolConfig).toEqual({
      functionCallingConfig: { mode: "NONE" },
    });
    expect((await capturedGoogle("required")).toolConfig).toEqual({
      functionCallingConfig: { mode: "ANY" },
    });
  });

  it("google: a named tool maps onto ANY + allowedFunctionNames", async () => {
    expect((await capturedGoogle({ name: "lookup" })).toolConfig).toEqual({
      functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["lookup"] },
    });
  });

  it("mock: a named toolChoice forces that tool_use with no sentinel, observably", async () => {
    const mock = new MockModelProvider();
    const r = await mock.dispatch({
      model: "mock-1",
      input: "just answer normally",
      tools: TOOLS,
      toolChoice: { name: "lookup" },
    });
    expect(r.stopReason).toBe("tool_use");
    expect(r.toolCalls).toEqual([expect.objectContaining({ name: "lookup" })]);
  });

  it("mock: 'required' forces the first declared tool", async () => {
    const mock = new MockModelProvider();
    const r = await mock.dispatch({
      model: "mock-1",
      input: "just answer normally",
      tools: [{ name: "first_tool", inputSchema: {} }, { name: "second_tool", inputSchema: {} }],
      toolChoice: "required",
    });
    expect(r.stopReason).toBe("tool_use");
    expect(r.toolCalls![0]!.name).toBe("first_tool");
  });

  it("mock: 'none' suppresses even a sentinel-requested tool call", async () => {
    const mock = new MockModelProvider();
    const r = await mock.dispatch({
      model: "mock-1",
      input: "please <<use-tool:lookup>> now",
      tools: TOOLS,
      toolChoice: "none",
    });
    expect(r.stopReason).toBe("end_turn");
    expect(r.toolCalls).toBeUndefined();
  });

  it("mock: a forced choice stops forcing once a tool_result is in history — loops terminate", async () => {
    const mock = new MockModelProvider();
    const r = await mock.dispatch({
      model: "mock-1",
      input: "",
      messages: [
        { role: "user", content: "look this up" },
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "lookup", input: {} }] },
        { role: "user", content: [{ type: "tool_result", toolUseId: "t1", content: "found it" }] },
      ],
      tools: TOOLS,
      toolChoice: { name: "lookup" },
    });
    expect(r.stopReason).toBe("end_turn");
    expect(r.outputText).toContain("found it");
  });
});

describe("responseFormat wire mappings (ADR-0020 long tail)", () => {
  const openaiOk = {
    id: "chatcmpl-rf1",
    object: "chat.completion",
    created: 1,
    model: "gpt-5",
    choices: [
      { index: 0, message: { role: "assistant", content: '{"a":1}', refusal: null }, finish_reason: "stop", logprobs: null },
    ],
    usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
  };
  const SCHEMA = { type: "object", properties: { a: { type: "number" } }, required: ["a"] };

  it("openai: json_object passes through natively", async () => {
    let captured: Record<string, unknown> | null = null;
    const provider = new OpenAiProvider({
      apiKey: "k",
      fetchImpl: async (_url, init) => {
        captured = JSON.parse(String(init?.body));
        return new Response(JSON.stringify(openaiOk), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    const r = await provider.dispatch({
      model: "gpt-5",
      input: "x",
      responseFormat: { type: "json_object" },
    });
    expect(captured!.response_format).toEqual({ type: "json_object" });
    expect(r.outputText).toBe('{"a":1}');
  });

  it("openai: json_schema passes through with name, schema and strict", async () => {
    let captured: Record<string, unknown> | null = null;
    const provider = new OpenAiProvider({
      apiKey: "k",
      fetchImpl: async (_url, init) => {
        captured = JSON.parse(String(init?.body));
        return new Response(JSON.stringify(openaiOk), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    await provider.dispatch({
      model: "gpt-5",
      input: "x",
      responseFormat: { type: "json_schema", name: "answer", schema: SCHEMA, strict: true },
    });
    expect(captured!.response_format).toEqual({
      type: "json_schema",
      json_schema: { name: "answer", schema: SCHEMA, strict: true },
    });
  });

  it("openai responses API: responseFormat rides as text.format", async () => {
    let captured: Record<string, unknown> | null = null;
    const provider = new OpenAiProvider({
      apiKey: "k",
      fetchImpl: async (_url, init) => {
        captured = JSON.parse(String(init?.body));
        return new Response(
          JSON.stringify({
            id: "resp_rf1",
            object: "response",
            status: "completed",
            output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "{}" }] }],
            usage: { input_tokens: 5, output_tokens: 1 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });
    await provider.dispatch({
      model: "o3-pro",
      input: "x",
      responseFormat: { type: "json_schema", name: "answer", schema: SCHEMA },
    });
    expect(captured!.text).toEqual({
      format: { type: "json_schema", name: "answer", schema: SCHEMA },
    });
  });

  it("xai: response_format passes through on the OpenAI-compatible wire", async () => {
    let captured: Record<string, unknown> | null = null;
    const provider = new XaiProvider({
      apiKey: "k",
      fetchImpl: async (_url, init) => {
        captured = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ ...openaiOk, model: "grok-4" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    await provider.dispatch({ model: "grok-4", input: "x", responseFormat: { type: "json_object" } });
    expect(captured!.response_format).toEqual({ type: "json_object" });
  });

  it("google: json_object maps onto responseMimeType application/json", async () => {
    let captured: Record<string, unknown> | null = null;
    const provider = new GoogleProvider({
      apiKey: "k",
      fetchImpl: async (_url, init) => {
        captured = JSON.parse(String(init?.body));
        return new Response(
          JSON.stringify({
            responseId: "resp-rf1",
            candidates: [{ content: { parts: [{ text: "{}" }] }, finishReason: "STOP" }],
            usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 1 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });
    await provider.dispatch({
      model: "gemini-2.5-pro",
      input: "x",
      responseFormat: { type: "json_object" },
    });
    const cfg = captured!.generationConfig as Record<string, unknown>;
    expect(cfg.responseMimeType).toBe("application/json");
    expect(cfg.responseSchema).toBeUndefined();
  });

  it("google: json_schema additionally maps the schema into Gemini's dialect", async () => {
    let captured: Record<string, unknown> | null = null;
    const provider = new GoogleProvider({
      apiKey: "k",
      fetchImpl: async (_url, init) => {
        captured = JSON.parse(String(init?.body));
        return new Response(
          JSON.stringify({
            responseId: "resp-rf2",
            candidates: [{ content: { parts: [{ text: "{}" }] }, finishReason: "STOP" }],
            usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 1 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });
    await provider.dispatch({
      model: "gemini-2.5-pro",
      input: "x",
      responseFormat: { type: "json_schema", name: "answer", schema: SCHEMA },
    });
    const cfg = captured!.generationConfig as Record<string, unknown>;
    expect(cfg.responseMimeType).toBe("application/json");
    // translated to the Gemini Schema dialect (uppercase types), exactly as
    // tool input schemas are
    expect(cfg.responseSchema).toEqual({
      type: "OBJECT",
      required: ["a"],
      properties: { a: { type: "NUMBER" } },
    });
  });

  it("anthropic: responseFormat FAILS LOUDLY — no native mechanism, no prompt-nudge pretence", async () => {
    const provider = new AnthropicProvider({
      apiKey: "k",
      fetchImpl: async () => {
        throw new Error("must not reach the wire");
      },
    });
    await expect(
      provider.dispatch({ model: "claude-opus-5", input: "x", responseFormat: { type: "json_object" } }),
    ).rejects.toThrowError(/responseFormat/);
  });

  it("mock: echo compliance — the reply is pure parseable JSON naming the honoured format", async () => {
    const mock = new MockModelProvider();
    const obj = await mock.dispatch({
      model: "mock-1",
      input: "summarize the release notes",
      responseFormat: { type: "json_object" },
    });
    expect(JSON.parse(obj.outputText)).toMatchObject({ format: "json_object" });

    const schema = await mock.dispatch({
      model: "mock-1",
      input: "summarize the release notes",
      responseFormat: { type: "json_schema", name: "release_summary", schema: SCHEMA },
    });
    expect(JSON.parse(schema.outputText)).toMatchObject({
      format: "json_schema",
      schema: "release_summary",
    });
  });
});

describe("thinking (ADR-0020 long tail): Anthropic extended thinking", () => {
  const thinkingMessage = {
    id: "msg_th_1",
    type: "message",
    role: "assistant",
    model: "claude-opus-5",
    content: [
      { type: "thinking", thinking: "Let me reason about this.", signature: "sig-abc" },
      { type: "text", text: "The answer is 42." },
    ],
    stop_reason: "end_turn",
    stop_sequence: null,
    // per Anthropic, output_tokens INCLUDES the thinking tokens
    usage: { input_tokens: 10, output_tokens: 57 },
  };

  it("sends the real thinking parameter and surfaces thinking blocks with signatures", async () => {
    let captured: Record<string, unknown> | null = null;
    const provider = new AnthropicProvider({
      apiKey: "k",
      fetchImpl: async (_url, init) => {
        captured = JSON.parse(String(init?.body));
        return anthropicJson(thinkingMessage);
      },
    });
    const r = await provider.dispatch({
      model: "claude-opus-5",
      input: "think about it",
      maxTokens: 2048,
      thinking: { budgetTokens: 1024 },
    });
    expect(captured!.thinking).toEqual({ type: "enabled", budget_tokens: 1024 });
    expect(r.thinking).toEqual([
      { type: "thinking", thinking: "Let me reason about this.", signature: "sig-abc" },
    ]);
    expect(r.outputText).toBe("The answer is 42.");
    // the ledger stays honest: output_tokens is the provider's billed total,
    // thinking INCLUDED, carried unchanged
    expect(r.usage).toEqual({ inputTokens: 10, outputTokens: 57 });
  });

  it("round-trips thinking + redacted_thinking history blocks natively, signature intact", async () => {
    let captured: Record<string, unknown> | null = null;
    const provider = new AnthropicProvider({
      apiKey: "k",
      fetchImpl: async (_url, init) => {
        captured = JSON.parse(String(init?.body));
        return anthropicJson(thinkingMessage);
      },
    });
    await provider.dispatch({
      model: "claude-opus-5",
      input: "",
      thinking: { budgetTokens: 1024 },
      messages: [
        { role: "user", content: "step one" },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "prior reasoning", signature: "sig-prev" },
            { type: "redacted_thinking", data: "opaque-bytes" },
            { type: "text", text: "step one done" },
          ],
        },
        { role: "user", content: "step two" },
      ],
    });
    const assistant = (captured! as { messages: { content: unknown }[] }).messages[1]!;
    expect(assistant.content).toEqual([
      { type: "thinking", thinking: "prior reasoning", signature: "sig-prev" },
      { type: "redacted_thinking", data: "opaque-bytes" },
      { type: "text", text: "step one done" },
    ]);
  });

  it("streams thinking_delta and signature_delta through onThinking, then text through onText", async () => {
    const sse = [
      `event: message_start\ndata: {"type":"message_start","message":{"id":"msg_th_s1","type":"message","role":"assistant","model":"claude-opus-5","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":10,"output_tokens":1}}}\n\n`,
      `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}\n\n`,
      `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Let me "}}\n\n`,
      `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"reason."}}\n\n`,
      `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig-stream"}}\n\n`,
      `event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n`,
      `event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}\n\n`,
      `event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Answer."}}\n\n`,
      `event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n`,
      `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":42}}\n\n`,
      `event: message_stop\ndata: {"type":"message_stop"}\n\n`,
    ].join("");
    const provider = new AnthropicProvider({
      apiKey: "k",
      fetchImpl: async () =>
        new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }),
    });
    const thinkingDeltas: string[] = [];
    let signature = "";
    const textDeltas: string[] = [];
    const r = await provider.dispatch({
      model: "claude-opus-5",
      input: "think",
      thinking: { budgetTokens: 1024 },
      onThinking: (d) => {
        if (d.thinking) thinkingDeltas.push(d.thinking);
        if (d.signature) signature = d.signature;
      },
      onText: (d) => textDeltas.push(d),
    });
    expect(thinkingDeltas.join("")).toBe("Let me reason.");
    expect(signature).toBe("sig-stream");
    expect(textDeltas.join("")).toBe("Answer.");
    expect(r.thinking).toEqual([
      { type: "thinking", thinking: "Let me reason.", signature: "sig-stream" },
    ]);
    expect(r.outputText).toBe("Answer.");
    expect(r.usage.outputTokens).toBe(42);
  });

  it("adapters WITHOUT a thinking mapping fail loudly, never dropping the budget", async () => {
    const neverReach = async () => {
      throw new Error("must not reach the wire");
    };
    const openai = new OpenAiProvider({ apiKey: "k", fetchImpl: neverReach as unknown as typeof fetch });
    const xai = new XaiProvider({ apiKey: "k", fetchImpl: neverReach as unknown as typeof fetch });
    const google = new GoogleProvider({ apiKey: "k", fetchImpl: neverReach as unknown as typeof fetch });
    for (const [provider, model] of [
      [openai, "gpt-5"],
      [openai, "o3-pro"],
      [xai, "grok-4"],
      [google, "gemini-2.5-pro"],
    ] as const) {
      await expect(
        provider.dispatch({ model, input: "x", thinking: { budgetTokens: 512 } }),
      ).rejects.toThrowError(/thinking/);
    }
  });

  it("mock: emits a deterministic thinking block, streams it, and bills it as output tokens", async () => {
    const mock = new MockModelProvider();
    const thinkingDeltas: string[] = [];
    let signature = "";
    const r = await mock.dispatch({
      model: "mock-1",
      input: "summarize the release notes",
      thinking: { budgetTokens: 256 },
      onThinking: (d) => {
        if (d.thinking) thinkingDeltas.push(d.thinking);
        if (d.signature) signature = d.signature;
      },
    });
    expect(r.thinking).toHaveLength(1);
    const block = r.thinking![0]!;
    expect(block.type).toBe("thinking");
    if (block.type === "thinking") {
      expect(block.thinking).toContain("budget 256");
      expect(block.signature).toBe("mock-signature");
      expect(thinkingDeltas.join("")).toBe(block.thinking);
      // thinking tokens are OUTPUT tokens — the mock's ledger includes them
      const bare = await new MockModelProvider().dispatch({
        model: "mock-1",
        input: "summarize the release notes",
      });
      expect(r.usage.outputTokens).toBe(
        bare.usage.outputTokens + Math.max(1, Math.ceil(block.thinking.length / 4)),
      );
    }
    expect(signature).toBe("mock-signature");
  });

  it("mock: no thinking request, no thinking block (byte-identical to before)", async () => {
    const mock = new MockModelProvider();
    const r = await mock.dispatch({ model: "mock-1", input: "hello there friend" });
    expect(r.thinking).toBeUndefined();
  });

  it("history thinking blocks never leak into a non-thinking provider's text view", async () => {
    const mock = new MockModelProvider();
    const r = await mock.dispatch({
      model: "mock-1",
      input: "",
      messages: [
        { role: "user", content: "first question about deployments" },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "SECRET-REASONING-TOKEN", signature: "s" },
            { type: "text", text: "first answer" },
          ],
        },
        { role: "user", content: "now shorter" },
      ],
    });
    expect(r.outputText).not.toContain("SECRET-REASONING-TOKEN");
  });
});

// ---------------------------------------------------------------------------
// ADR-0034 — CustomProvider: an ADMIN-REGISTERED endpoint the platform ships
// no adapter for. The point of these tests is that it implements NO protocol
// of its own: openai_chat IS the shared chat-completions core and
// anthropic_messages IS the AnthropicProvider, both aimed at the admin's
// baseUrl. So what is asserted here is the WIRING — dialect selection, where
// the bytes go, and how a key (or the absence of one) reaches the wire.
// ---------------------------------------------------------------------------

describe("CustomProvider (ADR-0034)", () => {
  const completion = {
    id: "chatcmpl-custom",
    object: "chat.completion",
    created: 1,
    model: "llama-3.3-70b",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "hi from vllm", refusal: null },
        finish_reason: "stop",
        logprobs: null,
      },
    ],
    usage: { prompt_tokens: 7, completion_tokens: 4, total_tokens: 11 },
  };

  it("openai_chat rides the shared chat-completions core against the admin's baseUrl", async () => {
    let captured: { url: string; auth: string | null; body: Record<string, unknown> } | null = null;
    const provider = new CustomProvider({
      apiKey: "sk-selfhosted",
      baseUrl: "https://vllm.corp.example/v1",
      wireProtocol: "openai_chat",
      fetchImpl: async (url, init) => {
        captured = {
          url: String(url),
          auth: new Headers(init?.headers).get("authorization"),
          body: JSON.parse(String(init?.body)),
        };
        return new Response(JSON.stringify(completion), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    const result = await provider.dispatch({ model: "llama-3.3-70b", input: "hello", maxTokens: 32 });
    expect(provider.kind).toBe("custom");
    expect(captured!.url).toBe("https://vllm.corp.example/v1/chat/completions");
    expect(captured!.auth).toBe("Bearer sk-selfhosted");
    expect(captured!.body).toMatchObject({ model: "llama-3.3-70b", max_completion_tokens: 32 });
    // identical normalization to the shipped adapters — nothing re-derived
    expect(result.outputText).toBe("hi from vllm");
    expect(result.stopReason).toBe("end_turn");
    expect(result.usage).toEqual({ inputTokens: 7, outputTokens: 4 });
  });

  it("a KEYLESS endpoint sends no Authorization header at all — not a bogus one", async () => {
    let auth: string | null | undefined;
    let sawSentinel = false;
    const provider = new CustomProvider({
      baseUrl: "http://localhost:11434/v1",
      wireProtocol: "openai_chat",
      fetchImpl: async (url, init) => {
        const h = new Headers(init?.headers);
        auth = h.get("authorization");
        sawSentinel = JSON.stringify([...h.entries()]).includes("regulait-keyless");
        return new Response(JSON.stringify(completion), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    await provider.dispatch({ model: "llama3.2", input: "hi" });
    expect(auth).toBeNull();
    expect(sawSentinel).toBe(false);
  });

  it("anthropic_messages delegates to the real Anthropic adapter at the admin's baseUrl", async () => {
    let captured: { url: string; key: string | null } | null = null;
    const provider = new CustomProvider({
      apiKey: "bridge-key",
      baseUrl: "https://bedrock-bridge.corp.example",
      wireProtocol: "anthropic_messages",
      fetchImpl: async (url, init) => {
        captured = { url: String(url), key: new Headers(init?.headers).get("x-api-key") };
        return anthropicJson({
          id: "msg_custom",
          type: "message",
          role: "assistant",
          model: "claude-via-bridge",
          content: [{ type: "text", text: "bridged" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 5, output_tokens: 2 },
        });
      },
    });
    const result = await provider.dispatch({ model: "claude-via-bridge", input: "hi" });
    expect(captured!.url).toContain("bedrock-bridge.corp.example");
    expect(captured!.url).toContain("/v1/messages");
    expect(captured!.key).toBe("bridge-key");
    expect(result.outputText).toBe("bridged");
    expect(result.usage).toEqual({ inputTokens: 5, outputTokens: 2 });
  });

  it("the registry resolves 'custom' WITHOUT a key but never without a baseUrl or wireProtocol", () => {
    expect(() => resolveModelProvider({ provider: "custom" })).toThrowError(/baseUrl/);
    expect(() =>
      resolveModelProvider({ provider: "custom", baseUrl: "https://x.example/v1" }),
    ).toThrowError(/wireProtocol/);
    // keyless is legitimate — that is the local-Ollama / air-gapped case
    const p = resolveModelProvider({
      provider: "custom",
      baseUrl: "https://x.example/v1",
      wireProtocol: "openai_chat",
    });
    expect(p.kind).toBe("custom");
  });

  it("labels its errors 'custom' so a failure is attributable to the admin's endpoint", async () => {
    const provider = new CustomProvider({
      baseUrl: "https://x.example/v1",
      wireProtocol: "openai_chat",
      fetchImpl: async () =>
        new Response(JSON.stringify({ error: { message: "model not loaded" } }), {
          status: 500,
          headers: { "content-type": "application/json" },
        }),
    });
    await expect(provider.dispatch({ model: "m", input: "hi" })).rejects.toThrowError(
      /custom dispatch failed/,
    );
  });
});

// ---------------------------------------------------------------------------
// ADR-0062 — the compiled vendor defaults
// ---------------------------------------------------------------------------

describe("ADR-0062 compiled vendor defaults", () => {
  it("DRIFT CHECK: the constants are what the SDKs themselves default to", async () => {
    // The whole guard rests on this. If an SDK upgrade moves its default and
    // this constant does not, a strict deployment would adjudicate a host the
    // adapter never contacts — i.e. it would allow-list the wrong thing and
    // block the right one. Asked of the SDKs directly, not asserted from
    // memory.
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const { default: OpenAI } = await import("openai");
    // constructed with an explicitly EMPTY baseURL environment, so this
    // measures the compiled default rather than whatever the box exports
    const savedA = process.env["ANTHROPIC_BASE_URL"];
    const savedO = process.env["OPENAI_BASE_URL"];
    delete process.env["ANTHROPIC_BASE_URL"];
    delete process.env["OPENAI_BASE_URL"];
    try {
      expect(new Anthropic({ apiKey: "x" }).baseURL).toBe(ANTHROPIC_DEFAULT_BASE);
      expect(new OpenAI({ apiKey: "x" }).baseURL).toBe(OPENAI_DEFAULT_BASE);
    } finally {
      if (savedA !== undefined) process.env["ANTHROPIC_BASE_URL"] = savedA;
      if (savedO !== undefined) process.env["OPENAI_BASE_URL"] = savedO;
    }
  });

  it("the Google and xAI adapters reach the base this registry reports", async () => {
    let seen: string | null = null;
    const spy = (async (url: string | URL | Request) => {
      seen = String(url);
      return new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: "hi" }] }, finishReason: "STOP" }],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    const google = new GoogleProvider({ apiKey: "k", fetchImpl: spy });
    await google.dispatch({ model: "gemini-x", input: "hi" });
    expect(seen).not.toBeNull();
    expect(String(seen).startsWith(GOOGLE_DEFAULT_BASE)).toBe(true);
    expect(new URL(XAI_DEFAULT_BASE).hostname).toBe("api.x.ai");
  });

  it("the tri-state distinguishes 'no network call' from 'we cannot say'", () => {
    expect(defaultBaseUrlFor("mock", {})).toBeNull();
    expect(defaultBaseUrlFor("custom", {})).toBeNull();
    expect(defaultBaseUrlFor("a-kind-that-does-not-exist", {})).toBeUndefined();
  });
});
