/**
 * ADR-0241 (P21) on the ADR-0253 Gemini adapter: `usageSource` is the decoded vendor object the usage block came
 * from — the response body when not streaming, the last streamed event that carried `usageMetadata` when streaming —
 * exactly as the legacy raw-fetch adapter reported it, so an admin-defined usage mapping reads the same object.
 */
import { describe, expect, it } from "vitest";
import { GoogleProvider } from "./index.js";

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

describe("Gemini usageSource (P21 on @ai-sdk/google)", () => {
  it("non-streaming: the whole response body", async () => {
    const body = {
      responseId: "r-us1",
      candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2, thoughtsTokenCount: 9 },
    };
    const r = await new GoogleProvider({ apiKey: "k", fetchImpl: async () => json(body) }).dispatch({
      model: "gemini-2.5-pro",
      input: "x",
    });
    expect(r.usageSource).toEqual(body);
    expect(r.usage).toEqual({ inputTokens: 4, outputTokens: 2 });
  });

  it("streaming: the last event that carried usageMetadata", async () => {
    const chunk = (c: unknown) => "data: " + JSON.stringify(c) + "\n\n";
    const last = {
      candidates: [{ content: { parts: [{ text: "b" }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 6, candidatesTokenCount: 3 },
    };
    const sse = chunk({ responseId: "r-us2", candidates: [{ content: { parts: [{ text: "a" }] } }] }) + chunk(last);
    const r = await new GoogleProvider({
      apiKey: "k",
      fetchImpl: async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }),
    }).dispatch({ model: "gemini-2.5-pro", input: "x", onText: () => {} });
    expect(r.usageSource).toEqual(last);
    expect(r.usage).toEqual({ inputTokens: 6, outputTokens: 3 });
  });

  it("absent when the response carries no usage block", async () => {
    const r = await new GoogleProvider({
      apiKey: "k",
      fetchImpl: async () => json({ candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }] }),
    }).dispatch({ model: "gemini-2.5-pro", input: "x" });
    expect("usageSource" in r).toBe(false);
  });
});
