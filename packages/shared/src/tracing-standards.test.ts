/**
 * ADR-0173 batch 2c / ADR-0177 step 1 — the emitter gaps, closed, and the
 * OpenInference export profile. Pure: the gateway's export route only feeds
 * rows (plus the served model, agent names and scores it joins) into
 * `buildOtlpPayload`, so every rule here is decided by this package.
 */
import { describe, expect, it } from "vitest";
import {
  buildOtlpPayload,
  isContentAttributeKey,
  otelAttributesForSpan,
  otelProviderName,
  type SpanRecord,
  type TraceExportProfile,
  type TraceRecord,
  type TraceScoreRecord,
} from "./tracing.js";

const U = (n: number) => `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;
const T = U(900);

function span(over: Partial<SpanRecord> & { id: string }): SpanRecord {
  return {
    traceId: T,
    parentSpanId: null,
    seq: 0,
    kind: "llm",
    name: "s",
    status: "ok",
    statusReason: null,
    startedAt: "2026-10-05T00:00:00.000Z",
    endedAt: "2026-10-05T00:00:01.000Z",
    durationMs: 1000,
    ...over,
  };
}

const trace: TraceRecord = {
  id: T,
  sessionId: "sess-1",
  kind: "run",
  rootRefId: null,
  name: "t",
  userId: U(77),
  projectId: U(78),
  status: "ok",
  startedAt: "2026-10-05T00:00:00.000Z",
  endedAt: "2026-10-05T00:00:02.000Z",
  durationMs: 2000,
  spanCount: 3,
  deniedSpanCount: 0,
  inputTokens: 10,
  outputTokens: 20,
  costUsd: 0.25,
};

type Attr = { key: string; value: Record<string, unknown> };
type WireSpan = { spanId: string; attributes: Attr[]; events?: Array<{ name: string; attributes: Attr[] }> };

function wireSpans(body: Record<string, unknown>): WireSpan[] {
  const rs = body["resourceSpans"] as Array<Record<string, unknown>>;
  return ((rs[0]!["scopeSpans"] as Array<Record<string, unknown>>)[0]!["spans"]) as WireSpan[];
}
const attrMap = (attrs: Attr[]) => Object.fromEntries(attrs.map((a) => [a.key, a.value]));

/** a model call, an MCP tool call, a connector call and a governance refusal,
 * each carrying a distinct content nonce */
const NONCE = { in: "nonce-prompt-41", out: "nonce-answer-42", args: "nonce-args-43", result: "nonce-result-44", conn: "nonce-conn-45" };
const SPANS: SpanRecord[] = [
  span({ id: U(1), seq: 1, kind: "run", name: "run" }),
  span({
    id: U(2),
    seq: 2,
    parentSpanId: U(1),
    provider: "anthropic",
    model: "model-configured",
    servedModel: "model-configured-20260901",
    agentId: U(50),
    agentName: "Main model",
    inputTokens: 10,
    outputTokens: 20,
    costUsd: 0.25,
    inputPreview: NONCE.in,
    outputPreview: NONCE.out,
    attributes: { stopReason: "end_turn", cacheReadInputTokens: 6, cacheCreationInputTokens: 4, compaction: { active: true } },
  }),
  span({
    id: U(3),
    seq: 3,
    parentSpanId: U(2),
    kind: "tool",
    name: "search_docs",
    mcpServerId: U(60),
    inputPreview: NONCE.args,
    outputPreview: NONCE.result,
    attributes: { toolCallId: "call_1" },
  }),
  span({ id: U(4), seq: 4, parentSpanId: U(1), kind: "connector", name: "crm.read", connectorId: U(70), inputPreview: NONCE.conn }),
  span({ id: U(5), seq: 5, parentSpanId: U(1), kind: "policy", name: "entitlement", status: "denied", statusReason: "not entitled", agentId: U(51), attributes: { ruleId: "r-1" } }),
];

function build(profile: TraceExportProfile, includeContent: boolean, scores: TraceScoreRecord[] = []) {
  return buildOtlpPayload({ serviceName: "svc", traces: [{ trace, spans: SPANS }], includeContent, profile, scores });
}

describe("ADR-0177 gap 1 — gen_ai.provider.name, with gen_ai.system kept for the transition", () => {
  it("maps our provider kinds to the convention's well-known values and passes the rest through", () => {
    expect(otelProviderName("anthropic")).toBe("anthropic");
    expect(otelProviderName("openai")).toBe("openai");
    expect(otelProviderName("google")).toBe("gcp.gemini");
    expect(otelProviderName("xai")).toBe("x_ai");
    expect(otelProviderName("custom")).toBe("custom");
    const a = otelAttributesForSpan(span({ id: U(1), provider: "google" }), { includeContent: false });
    expect(a["gen_ai.provider.name"]).toBe("gcp.gemini");
    expect(a["gen_ai.system"]).toBe("google");
  });
});

describe("ADR-0177 gap 2 — finish_reasons is an array on the wire", () => {
  it("encodes it as an OTLP arrayValue of strings", () => {
    const llm = wireSpans(build("otel_genai", false).body).find((s) => s.spanId === U(2).replace(/-/g, "").slice(0, 16))!;
    expect(attrMap(llm.attributes)["gen_ai.response.finish_reasons"]).toEqual({
      arrayValue: { values: [{ stringValue: "end_turn" }] },
    });
  });
});

describe("ADR-0177 gap 3 — gen_ai.response.model is the SERVED model", () => {
  it("uses the provider-reported model, and never copies the request model into it", () => {
    const served = otelAttributesForSpan(span({ id: U(1), model: "asked", servedModel: "served-snapshot" }), { includeContent: false });
    expect(served["gen_ai.request.model"]).toBe("asked");
    expect(served["gen_ai.response.model"]).toBe("served-snapshot");
    const unknown = otelAttributesForSpan(span({ id: U(1), model: "asked", servedModel: null }), { includeContent: false });
    expect(unknown["gen_ai.request.model"]).toBe("asked");
    expect(unknown["gen_ai.response.model"], "a semantic-cache hit or pre-A4 row says nothing").toBeUndefined();
  });
});

describe("ADR-0177 gap 4 — structured message parts", () => {
  it("emits role + parts on a model call, with the finish reason on the output message", () => {
    const a = otelAttributesForSpan(SPANS[1]!, { includeContent: true });
    expect(JSON.parse(a["gen_ai.input.messages"] as string)).toEqual([
      { role: "user", parts: [{ type: "text", content: NONCE.in }] },
    ]);
    expect(JSON.parse(a["gen_ai.output.messages"] as string)).toEqual([
      { role: "assistant", parts: [{ type: "text", content: NONCE.out }], finish_reason: "end_turn" },
    ]);
  });

  it("uses the tool convention's argument/result keys on a tool call, not message keys", () => {
    const a = otelAttributesForSpan(SPANS[2]!, { includeContent: true });
    expect(a["gen_ai.tool.call.arguments"]).toBe(NONCE.args);
    expect(a["gen_ai.tool.call.result"]).toBe(NONCE.result);
    expect(a["gen_ai.input.messages"]).toBeUndefined();
    const c = otelAttributesForSpan(SPANS[3]!, { includeContent: true });
    expect(c["gen_ai.input.messages"], "a connector call is not a GenAI operation").toBeUndefined();
    expect(c["regulait.input.preview"]).toBe(NONCE.conn);
  });
});

describe("ADR-0177 gap 5 — the missing keys", () => {
  it("gen_ai.agent.* from the registry agent on a GenAI span, and from the builder agent when one ran it", () => {
    const a = otelAttributesForSpan(SPANS[1]!, { includeContent: false });
    expect(a["gen_ai.agent.id"]).toBe(U(50));
    expect(a["gen_ai.agent.name"]).toBe("Main model");
    const b = otelAttributesForSpan(
      span({ id: U(1), agentId: U(50), attributes: { builderAgentId: U(80), builderAgentName: "Release helper" } }),
      { includeContent: false },
    );
    expect(b["gen_ai.agent.id"]).toBe(U(80));
    expect(b["gen_ai.agent.name"]).toBe("Release helper");
    const policy = otelAttributesForSpan(SPANS[4]!, { includeContent: false });
    expect(policy["gen_ai.agent.id"], "a policy decision is not a GenAI operation").toBeUndefined();
    expect(policy["regulait.agent.id"]).toBe(U(51));
  });

  it("cache-read and cache-write token counts", () => {
    const a = otelAttributesForSpan(SPANS[1]!, { includeContent: false });
    expect(a["gen_ai.usage.cache_read.input_tokens"]).toBe(6);
    expect(a["gen_ai.usage.cache_creation.input_tokens"]).toBe(4);
    const none = otelAttributesForSpan(span({ id: U(1) }), { includeContent: false });
    expect(Object.keys(none).some((k) => k.includes("cache"))).toBe(false);
  });

  it("compaction rides regulait.conversation.compacted (the pinned convention has no key)", () => {
    const a = otelAttributesForSpan(SPANS[1]!, { includeContent: false });
    expect(a["regulait.conversation.compacted"]).toBe(true);
    expect(a["gen_ai.conversation.compacted"]).toBeUndefined();
    const inactive = otelAttributesForSpan(span({ id: U(1), attributes: { compaction: { active: false } } }), { includeContent: false });
    expect(inactive["regulait.conversation.compacted"]).toBe(false);
  });

  it("mcp.method.name on an MCP tool span only", () => {
    const a = otelAttributesForSpan(SPANS[2]!, { includeContent: false });
    expect(a["mcp.method.name"]).toBe("tools/call");
    expect(a["regulait.mcp_server.id"]).toBe(U(60));
    expect(a["gen_ai.tool.call.id"]).toBe("call_1");
    const nonMcp = otelAttributesForSpan(span({ id: U(1), kind: "tool", name: "t" }), { includeContent: false });
    expect(nonMcp["mcp.method.name"]).toBeUndefined();
  });

  it("evaluations are gen_ai.evaluation.result events with score and label ONLY", () => {
    const scores = [
      { traceId: T, spanId: U(2), source: "annotation", name: "helpful", value: 4, label: "good", comment: "nonce-comment-46" },
      { traceId: T, spanId: null, source: "trace_eval", name: "groundedness", value: null, label: "flagged" },
      { traceId: U(901), spanId: null, source: "judge", name: "other-trace", value: 1, label: null },
    ] as unknown as TraceScoreRecord[];
    const body = build("otel_genai", true, scores).body;
    const wire = JSON.stringify(body);
    expect(wire, "a reviewer comment must never leave").not.toContain("nonce-comment-46");
    expect(wire).not.toContain("gen_ai.evaluation.explanation");
    expect(wire, "a score of another trace lands nowhere in this one").not.toContain("other-trace");
    const spans = wireSpans(body);
    const sid = (n: number) => U(n).replace(/-/g, "").slice(0, 16);
    const llm = spans.find((s) => s.spanId === sid(2))!;
    expect(llm.events).toHaveLength(1);
    expect(llm.events![0]!.name).toBe("gen_ai.evaluation.result");
    expect(attrMap(llm.events![0]!.attributes)).toEqual({
      "gen_ai.evaluation.name": { stringValue: "helpful" },
      // the convention types the score as a double, even when it is whole
      "gen_ai.evaluation.score.value": { doubleValue: 4 },
      "gen_ai.evaluation.score.label": { stringValue: "good" },
      "regulait.evaluation.source": { stringValue: "annotation" },
    });
    const root = spans.find((s) => s.spanId === sid(1))!;
    expect(root.events!.map((e) => attrMap(e.attributes)["gen_ai.evaluation.name"])).toEqual([{ stringValue: "groundedness" }]);
  });
});

describe("the OpenInference profile", () => {
  it("adds the OpenInference keys and the cost key; the default profile has neither", () => {
    const oi = wireSpans(build("openinference", true).body);
    const otel = wireSpans(build("otel_genai", true).body);
    const llmOi = attrMap(oi[1]!.attributes);
    expect(llmOi["openinference.span.kind"]).toEqual({ stringValue: "LLM" });
    expect(llmOi["llm.model_name"]).toEqual({ stringValue: "model-configured-20260901" });
    expect(llmOi["llm.cost.total"]).toEqual({ doubleValue: 0.25 });
    expect(llmOi["llm.token_count.prompt_details.cache_read"]).toEqual({ intValue: "6" });
    expect(llmOi["gen_ai.provider.name"], "the OTel keys stay").toEqual({ stringValue: "anthropic" });
    expect(attrMap(oi[2]!.attributes)["openinference.span.kind"]).toEqual({ stringValue: "TOOL" });
    expect(attrMap(oi[4]!.attributes)["openinference.span.kind"]).toEqual({ stringValue: "GUARDRAIL" });
    expect(attrMap(oi[0]!.attributes)["openinference.span.kind"]).toEqual({ stringValue: "CHAIN" });
    for (const s of otel) {
      const keys = s.attributes.map((a) => a.key);
      expect(keys.filter((k) => k.startsWith("llm.") || k.startsWith("openinference.") || k.includes("cost.total"))).toEqual([]);
    }
  });

  it("stamps the project on the resource only in the OpenInference profile", () => {
    const res = (p: TraceExportProfile) =>
      attrMap(((build(p, false).body["resourceSpans"] as Array<Record<string, unknown>>)[0]!["resource"] as { attributes: Attr[] }).attributes);
    expect(res("openinference")["openinference.project.name"]).toEqual({ stringValue: "svc" });
    expect(res("otel_genai")["openinference.project.name"]).toBeUndefined();
  });
});

describe("RULE: with content capture off, NEITHER profile emits any message or input/output value", () => {
  for (const profile of ["otel_genai", "openinference"] as const) {
    it(`${profile}: no content key and no content byte, on any span kind`, () => {
      const on = JSON.stringify(build(profile, true).body);
      // positive control: with capture on the content really is on the wire
      for (const n of Object.values(NONCE)) expect(on).toContain(n);
      const off = build(profile, false).body;
      const wire = JSON.stringify(off);
      for (const n of Object.values(NONCE)) expect(wire).not.toContain(n);
      for (const s of wireSpans(off)) {
        const contentKeys = s.attributes.map((a) => a.key).filter(isContentAttributeKey);
        expect(contentKeys).toEqual([]);
      }
      expect(wire).not.toMatch(/"(input|output)\.value"/);
      expect(wire).not.toMatch(/llm\.(input|output)_messages/);
    });
  }
});
