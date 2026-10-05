/**
 * ADR-0175 A4 — every adapter surfaces the model the PROVIDER says it served,
 * verbatim, and null when the response does not say. Never the requested id
 * copied over: a guess would hide the very change the field exists to show.
 */
import { describe, expect, it } from "vitest";
import { AnthropicProvider, CustomProvider, GoogleProvider, MockModelProvider, OpenAiProvider } from "./index.js";

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const sse = (chunks: unknown[]) =>
  new Response(chunks.map((c) => "data: " + JSON.stringify(c) + "\n\n").join("") + "data: [DONE]\n\n", {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });

const anthropicMessage = (model: unknown) => ({
  id: "msg_a4",
  type: "message",
  role: "assistant",
  ...(model === undefined ? {} : { model }),
  content: [{ type: "text", text: "ok" }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 3, output_tokens: 1 },
});

const chatCompletion = (model: unknown) => ({
  id: "chatcmpl-a4",
  object: "chat.completion",
  created: 1,
  ...(model === undefined ? {} : { model }),
  choices: [{ index: 0, message: { role: "assistant", content: "ok", refusal: null }, finish_reason: "stop", logprobs: null }],
  usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
});

describe("served model — Anthropic Messages `model`", () => {
  it("reports the dated snapshot the alias resolved to", async () => {
    const p = new AnthropicProvider({ apiKey: "k", fetchImpl: async () => json(anthropicMessage("model-a-20250101")) });
    const r = await p.dispatch({ model: "model-a", input: "hi" });
    expect(r.servedModel).toBe("model-a-20250101");
  });

  it("is null when the response carries no model — never the requested id", async () => {
    const p = new AnthropicProvider({ apiKey: "k", fetchImpl: async () => json(anthropicMessage("")) });
    const r = await p.dispatch({ model: "model-a", input: "hi" });
    expect(r.servedModel).toBeNull();
  });
});

describe("served model — OpenAI-compatible `model`", () => {
  it("chat completions (non-streaming)", async () => {
    const p = new OpenAiProvider({ apiKey: "k", fetchImpl: async () => json(chatCompletion("model-b-2025-08-07")) });
    const r = await p.dispatch({ model: "model-b", input: "hi" });
    expect(r.servedModel).toBe("model-b-2025-08-07");
  });

  it("chat completions (streaming) reads it from the chunks", async () => {
    const chunk = (extra: Record<string, unknown>) => ({
      id: "chatcmpl-s",
      object: "chat.completion.chunk",
      created: 1,
      model: "model-b-2025-08-07",
      ...extra,
    });
    const p = new OpenAiProvider({
      apiKey: "k",
      fetchImpl: async () =>
        sse([
          chunk({ choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }] }),
          chunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
          chunk({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } }),
        ]),
    });
    const r = await p.dispatch({ model: "model-b", input: "hi", onText: () => {} });
    expect(r.servedModel).toBe("model-b-2025-08-07");
  });

  it("is null when the response omits it", async () => {
    const p = new OpenAiProvider({ apiKey: "k", fetchImpl: async () => json(chatCompletion(undefined)) });
    const r = await p.dispatch({ model: "model-b", input: "hi" });
    expect(r.servedModel).toBeNull();
  });

  it("Responses API surface", async () => {
    const p = new OpenAiProvider({
      apiKey: "k",
      fetchImpl: async () =>
        json({
          id: "resp_a4",
          object: "response",
          created_at: 1,
          status: "completed",
          error: null,
          incomplete_details: null,
          model: "o3-pro-2025-06-10",
          output: [
            { type: "message", id: "m", status: "completed", role: "assistant", content: [{ type: "output_text", text: "ok", annotations: [] }] },
          ],
          usage: { input_tokens: 3, output_tokens: 1, output_tokens_details: { reasoning_tokens: 0 } },
        }),
    });
    const r = await p.dispatch({ model: "o3-pro", input: "hi" });
    expect(r.servedModel).toBe("o3-pro-2025-06-10");
  });

  it("a custom endpoint (e.g. a hosted or proxied deployment) reports it when present", async () => {
    const present = new CustomProvider({
      baseUrl: "http://custom.example/v1",
      wireProtocol: "openai_chat",
      fetchImpl: async () => json(chatCompletion("deployment-x-0613")),
    });
    expect((await present.dispatch({ model: "deployment-x", input: "hi" })).servedModel).toBe("deployment-x-0613");
    const absent = new CustomProvider({
      baseUrl: "http://custom.example/v1",
      wireProtocol: "openai_chat",
      fetchImpl: async () => json(chatCompletion(undefined)),
    });
    expect((await absent.dispatch({ model: "deployment-x", input: "hi" })).servedModel).toBeNull();
    const anthropicDialect = new CustomProvider({
      baseUrl: "http://custom.example",
      wireProtocol: "anthropic_messages",
      fetchImpl: async () => json(anthropicMessage("bridge-model-7")),
    });
    expect((await anthropicDialect.dispatch({ model: "bridge-model", input: "hi" })).servedModel).toBe("bridge-model-7");
  });
});

describe("served model — Google `modelVersion`", () => {
  const gemini = (extra: Record<string, unknown>) => ({
    responseId: "g-a4",
    candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1 },
    ...extra,
  });

  it("non-streaming", async () => {
    const p = new GoogleProvider({ apiKey: "k", fetchImpl: async () => json(gemini({ modelVersion: "model-g-001" })) });
    expect((await p.dispatch({ model: "model-g", input: "hi" })).servedModel).toBe("model-g-001");
  });

  it("streaming", async () => {
    const p = new GoogleProvider({
      apiKey: "k",
      fetchImpl: async () =>
        new Response(
          ["data: " + JSON.stringify(gemini({ modelVersion: "model-g-002" })), ""].join("\n") + "\n",
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
    });
    expect((await p.dispatch({ model: "model-g", input: "hi", onText: () => {} })).servedModel).toBe("model-g-002");
  });

  it("is null when absent", async () => {
    const p = new GoogleProvider({ apiKey: "k", fetchImpl: async () => json(gemini({})) });
    expect((await p.dispatch({ model: "model-g", input: "hi" })).servedModel).toBeNull();
  });
});

describe("served model — the mock", () => {
  it("reports the requested model by default", async () => {
    const r = await new MockModelProvider().dispatch({ model: "mock-balanced", input: "summarize the note" });
    expect(r.servedModel).toBe("mock-balanced");
  });

  it("<<serve-as:NAME>> reports a different served model (a silent swap, reproducible offline)", async () => {
    const r = await new MockModelProvider().dispatch({ model: "mock-balanced", input: "summarize <<serve-as:mock-fast-2>>" });
    expect(r.servedModel).toBe("mock-fast-2");
    expect(r.stopReason).toBe("end_turn");
  });

  it("the sentinel holds across a multi-turn history", async () => {
    const r = await new MockModelProvider().dispatch({
      model: "mock-premium",
      input: "",
      messages: [
        { role: "user", content: "start <<serve-as:other-model>>" },
        { role: "assistant", content: "ok" },
        { role: "user", content: "continue" },
      ],
    });
    expect(r.servedModel).toBe("other-model");
  });
});
