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

// ── #723 review findings 1–3: Gemini continuation (`CONTINUATION`) over several HTTP hops ──
import { ModelProviderError, resolveModelProvider, setModelDispatchTimeoutMs, modelDispatchTimeout } from "./index.js";

const hop1 = {
  responseId: "r-c1",
  modelVersion: "gemini-x-001",
  candidates: [{ content: { parts: [{ text: "part one " }] }, finishReason: "CONTINUATION", continuationToken: "tok-1" }],
  usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 100 },
};
const hop2 = {
  responseId: "r-c2",
  modelVersion: "gemini-x-001",
  candidates: [{ content: { parts: [{ text: "part two" }] }, finishReason: "STOP" }],
  usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 40 },
};

describe("Gemini continuation: usage, usageSource and the deadline cover every hop", () => {
  it("non-streaming: usage is the sum of both hops, and usageSource carries the same sum", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const r = await new GoogleProvider({
      apiKey: "k",
      fetchImpl: async (_u, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return json(bodies.length === 1 ? hop1 : hop2);
      },
    }).dispatch({ model: "gemini-x", input: "write a lot" });
    expect(bodies).toHaveLength(2);
    expect(bodies[1]!.continuationToken).toBe("tok-1");
    expect(r.outputText).toBe("part one part two");
    expect(r.usage).toEqual({ inputTokens: 22, outputTokens: 140 });
    expect((r.usageSource as { usageMetadata: unknown }).usageMetadata).toMatchObject({
      promptTokenCount: 22,
      candidatesTokenCount: 140,
    });
  });

  it("streaming: usage is the sum of both hops (not just the last chunk), and usageSource agrees", async () => {
    const sse = (c: unknown) =>
      new Response("data: " + JSON.stringify(c) + "\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });
    let calls = 0;
    const deltas: string[] = [];
    const r = await new GoogleProvider({
      apiKey: "k",
      fetchImpl: async () => (++calls === 1 ? sse(hop1) : sse(hop2)),
    }).dispatch({ model: "gemini-x", input: "write a lot", onText: (d) => deltas.push(d) });
    expect(calls).toBe(2);
    expect(deltas.join("")).toBe("part one part two");
    expect(r.usage).toEqual({ inputTokens: 22, outputTokens: 140 });
    expect((r.usageSource as { usageMetadata: unknown }).usageMetadata).toMatchObject({
      promptTokenCount: 22,
      candidatesTokenCount: 140,
    });
  });

  it("the model deadline bounds the whole dispatch, not each hop", async () => {
    const prior = modelDispatchTimeout();
    setModelDispatchTimeoutMs(80);
    try {
      // every hop answers in 50 ms, inside the per-fetch deadline, but three hops take 150 ms
      const slowHop: typeof fetch = (_u, init) =>
        new Promise<Response>((resolve, reject) => {
          const t = setTimeout(() => resolve(json(hop1)), 50);
          init?.signal?.addEventListener("abort", () => {
            clearTimeout(t);
            reject(init.signal!.reason);
          });
        });
      const provider = resolveModelProvider({ provider: "google", apiKey: "k", baseUrl: null }, slowHop);
      const started = Date.now();
      const err = await provider.dispatch({ model: "gemini-x", input: "x" }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ModelProviderError);
      expect((err as ModelProviderError).status).toBe(504);
      expect(Date.now() - started).toBeLessThan(1_000);
    } finally {
      setModelDispatchTimeoutMs(prior);
    }
  });
});
