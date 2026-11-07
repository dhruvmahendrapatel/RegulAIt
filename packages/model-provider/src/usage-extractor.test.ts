/**
 * ADR-0241 (P21) — the configurable usage extractor.
 *
 * 1. Golden tests: one mapping per major provider, applied to that provider's documented response shape (field names
 *    from each vendor's public API reference). Where the adapter in index.ts already reads the provider, the mapping's
 *    result must equal the adapter's own extraction, so an admin mapping can reproduce the built-in one exactly.
 * 2. Malicious and oversized mappings and bodies: each is refused as a value, never thrown, and never evaluated.
 */
import { describe, expect, it } from "vitest";
import {
  USAGE_EXTRACTOR_LIMITS as L,
  USAGE_MAPPING_FORMAT,
  checkUsageBody,
  extractUsage,
  validateUsageMapping,
  type UsageMapping,
} from "./usage-extractor.js";
import { geminiModality, openAiChatModality } from "./index.js";

const ok = (m: unknown): UsageMapping => {
  const v = validateUsageMapping(m);
  if (!v.ok) throw new Error(v.errors.join("; "));
  return v.mapping;
};
const extract = (m: unknown, body: unknown) => {
  const r = extractUsage(ok(m), body);
  if (!r.ok) throw new Error(r.reason);
  return r.usage;
};

// --- golden shapes (public API references) ---------------------------------------------------------------------

/** OpenAI Chat Completions (`usage` with prompt/completion details; audio-capable model) */
const OPENAI_CHAT = {
  id: "chatcmpl-abc",
  object: "chat.completion",
  model: "gpt-4o-audio-preview-2025-06-03",
  choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
  usage: {
    prompt_tokens: 1200,
    completion_tokens: 300,
    total_tokens: 1500,
    prompt_tokens_details: { cached_tokens: 1024, audio_tokens: 200 },
    completion_tokens_details: { reasoning_tokens: 0, audio_tokens: 120, accepted_prediction_tokens: 0, rejected_prediction_tokens: 0 },
  },
};
const OPENAI_CHAT_MAPPING = {
  format: USAGE_MAPPING_FORMAT,
  fields: {
    inputTokens: { pointer: "/usage/prompt_tokens" },
    outputTokens: { pointer: "/usage/completion_tokens" },
    cacheReadInputTokens: { pointer: "/usage/prompt_tokens_details/cached_tokens" },
    imageInputTokens: { pointer: "/usage/prompt_tokens_details/image_tokens" },
    imageOutputTokens: { pointer: "/usage/completion_tokens_details/image_tokens" },
    audioInputTokens: { pointer: "/usage/prompt_tokens_details/audio_tokens" },
    audioOutputTokens: { pointer: "/usage/completion_tokens_details/audio_tokens" },
  },
};

/** OpenAI Responses API */
const OPENAI_RESPONSES = {
  id: "resp_123",
  object: "response",
  status: "completed",
  model: "o3-pro",
  output: [],
  usage: {
    input_tokens: 328,
    input_tokens_details: { cached_tokens: 128 },
    output_tokens: 52,
    output_tokens_details: { reasoning_tokens: 40 },
    total_tokens: 380,
  },
};

/** Anthropic Messages (input_tokens excludes the cache counts, which are reported beside it) */
const ANTHROPIC = {
  id: "msg_01",
  type: "message",
  role: "assistant",
  model: "claude-opus-5-5",
  content: [{ type: "text", text: "hi" }],
  stop_reason: "end_turn",
  usage: { input_tokens: 2095, output_tokens: 503, cache_creation_input_tokens: 2051, cache_read_input_tokens: 4096 },
};

/** Gemini generateContent (`usageMetadata`, per-modality lists) */
const GEMINI = {
  candidates: [{ content: { parts: [{ text: "hi" }], role: "model" }, finishReason: "STOP" }],
  modelVersion: "gemini-2.5-pro",
  responseId: "r-1",
  usageMetadata: {
    promptTokenCount: 1800,
    candidatesTokenCount: 400,
    totalTokenCount: 2200,
    cachedContentTokenCount: 512,
    promptTokensDetails: [
      { modality: "TEXT", tokenCount: 500 },
      { modality: "IMAGE", tokenCount: 1032 },
      { modality: "VIDEO", tokenCount: 100 },
      { modality: "AUDIO", tokenCount: 168 },
    ],
    candidatesTokensDetails: [
      { modality: "TEXT", tokenCount: 300 },
      { modality: "AUDIO", tokenCount: 100 },
    ],
  },
};
const GEMINI_MAPPING = {
  format: USAGE_MAPPING_FORMAT,
  fields: {
    inputTokens: { pointer: "/usageMetadata/promptTokenCount" },
    outputTokens: { pointer: "/usageMetadata/candidatesTokenCount" },
    cacheReadInputTokens: { pointer: "/usageMetadata/cachedContentTokenCount" },
    imageInputTokens: {
      arraySum: { array: "/usageMetadata/promptTokensDetails", where: { pointer: "/modality", equals: ["IMAGE", "VIDEO"] }, value: "/tokenCount" },
    },
    imageOutputTokens: {
      arraySum: { array: "/usageMetadata/candidatesTokensDetails", where: { pointer: "/modality", equals: ["IMAGE"] }, value: "/tokenCount" },
    },
    audioInputTokens: {
      arraySum: { array: "/usageMetadata/promptTokensDetails", where: { pointer: "/modality", equals: ["AUDIO"] }, value: "/tokenCount" },
    },
    audioOutputTokens: {
      arraySum: { array: "/usageMetadata/candidatesTokensDetails", where: { pointer: "/modality", equals: ["AUDIO"] }, value: "/tokenCount" },
    },
  },
};

/** Amazon Bedrock Converse (camelCase, cache read and write beside the totals) */
const BEDROCK_CONVERSE = {
  output: { message: { role: "assistant", content: [{ text: "hi" }] } },
  stopReason: "end_turn",
  usage: { inputTokens: 120, outputTokens: 40, totalTokens: 160, cacheReadInputTokens: 900, cacheWriteInputTokens: 300 },
  metrics: { latencyMs: 512 },
};

/** Cohere Chat v2 (billed units beside raw tokens) */
const COHERE_V2 = {
  id: "c-1",
  finish_reason: "COMPLETE",
  message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
  usage: { billed_units: { input_tokens: 17, output_tokens: 9 }, tokens: { input_tokens: 230, output_tokens: 9 } },
};

describe("golden: major providers' documented response shapes", () => {
  it("OpenAI chat completions: equals the adapter's own extraction (totals, cache read, audio split)", () => {
    const u = extract(OPENAI_CHAT_MAPPING, OPENAI_CHAT);
    expect(u).toEqual({
      inputTokens: 1200,
      outputTokens: 300,
      cacheReadInputTokens: 1024,
      ...openAiChatModality(OPENAI_CHAT.usage),
    });
    expect(u.modality).toEqual({ audio: { inputTokens: 200, outputTokens: 120 } });
  });

  it("the same mapping reads the final streamed chunk, which carries the same top-level usage", () => {
    const chunk = { id: "chatcmpl-abc", object: "chat.completion.chunk", choices: [], usage: OPENAI_CHAT.usage };
    expect(extract(OPENAI_CHAT_MAPPING, chunk)).toEqual(extract(OPENAI_CHAT_MAPPING, OPENAI_CHAT));
  });

  it("OpenAI Responses API: totals and cached input; no modality split is reported", () => {
    const u = extract(
      {
        format: USAGE_MAPPING_FORMAT,
        fields: {
          inputTokens: { pointer: "/usage/input_tokens" },
          outputTokens: { pointer: "/usage/output_tokens" },
          cacheReadInputTokens: { pointer: "/usage/input_tokens_details/cached_tokens" },
        },
      },
      OPENAI_RESPONSES,
    );
    expect(u).toEqual({ inputTokens: 328, outputTokens: 52, cacheReadInputTokens: 128 });
  });

  it("Anthropic Messages: equals the adapter (input_tokens as reported, cache read and write beside it)", () => {
    const u = extract(
      {
        format: USAGE_MAPPING_FORMAT,
        fields: {
          inputTokens: { pointer: "/usage/input_tokens" },
          outputTokens: { pointer: "/usage/output_tokens" },
          cacheReadInputTokens: { pointer: "/usage/cache_read_input_tokens" },
          cacheCreationInputTokens: { pointer: "/usage/cache_creation_input_tokens" },
        },
      },
      ANTHROPIC,
    );
    expect(u).toEqual({ inputTokens: 2095, outputTokens: 503, cacheReadInputTokens: 4096, cacheCreationInputTokens: 2051 });
  });

  it("Gemini: the arraySum step equals the adapter's geminiModality (IMAGE+VIDEO as image, AUDIO as audio)", () => {
    const u = extract(GEMINI_MAPPING, GEMINI);
    expect(u).toEqual({ inputTokens: 1800, outputTokens: 400, cacheReadInputTokens: 512, ...geminiModality(GEMINI.usageMetadata) });
    expect(u.modality).toEqual({ image: { inputTokens: 1132, outputTokens: 0 }, audio: { inputTokens: 168, outputTokens: 100 } });
  });

  it("Bedrock Converse: camelCase usage and cache write — a provider no built-in adapter reads", () => {
    const u = extract(
      {
        format: USAGE_MAPPING_FORMAT,
        fields: {
          inputTokens: { pointer: "/usage/inputTokens" },
          outputTokens: { pointer: "/usage/outputTokens" },
          cacheReadInputTokens: { pointer: "/usage/cacheReadInputTokens" },
          cacheCreationInputTokens: { pointer: "/usage/cacheWriteInputTokens" },
        },
      },
      BEDROCK_CONVERSE,
    );
    expect(u).toEqual({ inputTokens: 120, outputTokens: 40, cacheReadInputTokens: 900, cacheCreationInputTokens: 300 });
  });

  it("Cohere v2: the admin chooses billed units over raw tokens", () => {
    const u = extract(
      {
        format: USAGE_MAPPING_FORMAT,
        fields: { inputTokens: { pointer: "/usage/billed_units/input_tokens" }, outputTokens: { pointer: "/usage/billed_units/output_tokens" } },
      },
      COHERE_V2,
    );
    expect(u).toEqual({ inputTokens: 17, outputTokens: 9 });
  });

  it("totalsInclude text_only: a provider that reports text apart from modality counts gets them added to the totals", () => {
    const body = { usage: { text_in: 100, text_out: 10, image_in: 50, audio_out: 5 } };
    const u = extract(
      {
        format: USAGE_MAPPING_FORMAT,
        totalsInclude: "text_only",
        fields: {
          inputTokens: { pointer: "/usage/text_in" },
          outputTokens: { pointer: "/usage/text_out" },
          imageInputTokens: { pointer: "/usage/image_in" },
          audioOutputTokens: { pointer: "/usage/audio_out" },
        },
      },
      body,
    );
    expect(u).toEqual({
      inputTokens: 150,
      outputTokens: 15,
      modality: { image: { inputTokens: 50, outputTokens: 0 }, audio: { inputTokens: 0, outputTokens: 5 } },
    });
  });

  it("sum adds the named counts, and an absent term is skipped", () => {
    const u = extract(
      {
        format: USAGE_MAPPING_FORMAT,
        fields: {
          inputTokens: { sum: ["/usage/input_tokens", "/usage/cache_read_input_tokens", "/usage/absent"] },
          outputTokens: { pointer: "/usage/output_tokens" },
        },
      },
      ANTHROPIC,
    );
    expect(u.inputTokens).toBe(2095 + 4096);
  });

  it("RFC 6901 escapes: ~1 is '/', ~0 is '~'", () => {
    const body = { "u/s": { "a~b": 7 }, out: 1 };
    expect(extract({ format: USAGE_MAPPING_FORMAT, fields: { inputTokens: { pointer: "/u~1s/a~0b" }, outputTokens: { pointer: "/out" } } }, body).inputTokens).toBe(7);
  });
});

describe("extraction failures are values, and fail closed", () => {
  const m = ok(OPENAI_CHAT_MAPPING);
  it.each([
    ["a required count is absent", { usage: { completion_tokens: 1 } }, /inputTokens/],
    ["a count is a string", { usage: { prompt_tokens: "12", completion_tokens: 1 } }, /token count/],
    ["a count is negative", { usage: { prompt_tokens: -1, completion_tokens: 1 } }, /token count/],
    ["a count is fractional", { usage: { prompt_tokens: 1.5, completion_tokens: 1 } }, /token count/],
    ["a count is above the cap", { usage: { prompt_tokens: L.countMax + 1, completion_tokens: 1 } }, /token count/],
    ["the modality split exceeds the total", { usage: { prompt_tokens: 10, completion_tokens: 1, prompt_tokens_details: { audio_tokens: 11 } } }, /exceed/],
    ["the body is a scalar", 42, /not a JSON object/],
    ["there is no body", undefined, /no response body/],
  ])("%s", (_name, body, reason) => {
    const r = extractUsage(m, body);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(reason);
  });

  it("a pointer through a scalar is absent, not a crash", () => {
    const r = extractUsage(m, { usage: 5 });
    expect(r).toEqual({ ok: false, reason: "inputTokens: the response has no value at the mapped location" });
  });

  it("an inherited property is never read (the library checks own properties only)", () => {
    const mm = ok({ format: USAGE_MAPPING_FORMAT, fields: { inputTokens: { pointer: "/usage/constructor/length" }, outputTokens: { pointer: "/usage/x" } } });
    expect(extractUsage(mm, { usage: { x: 1 } }).ok).toBe(false);
    const proto = ok({ format: USAGE_MAPPING_FORMAT, fields: { inputTokens: { pointer: "/__proto__/x" }, outputTokens: { pointer: "/o" } } });
    expect(extractUsage(proto, { o: 1 }).ok).toBe(false);
  });

  it("an arraySum over a non-array, or over too many elements, is refused", () => {
    const g = ok(GEMINI_MAPPING);
    expect(extractUsage(g, { usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, promptTokensDetails: { a: 1 } } }).ok).toBe(false);
    const many = Array.from({ length: L.arrayMaxElements + 1 }, () => ({ modality: "IMAGE", tokenCount: 0 }));
    const r = extractUsage(g, { usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, promptTokensDetails: many } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/more than 256 elements/);
  });
});

describe("bounded input: oversized or pathological bodies are refused before any pointer runs", () => {
  it("too many values", () => {
    const body = { usage: { prompt_tokens: 1, completion_tokens: 1 }, pad: Array.from({ length: L.bodyMaxNodes }, () => 0) };
    expect(checkUsageBody(body)).toEqual({ ok: false, reason: `the response body has more than ${L.bodyMaxNodes} values` });
  });
  it("too deep", () => {
    let deep: Record<string, unknown> = {};
    const root = deep;
    for (let i = 0; i < L.bodyMaxDepth + 2; i++) {
      deep.n = {};
      deep = deep.n as Record<string, unknown>;
    }
    expect(checkUsageBody(root).ok).toBe(false);
  });
  it("too much text", () => {
    expect(checkUsageBody({ s: "x".repeat(L.bodyMaxStringChars + 1) }).ok).toBe(false);
    expect(checkUsageBody({ ["k".repeat(L.bodyMaxStringChars + 1)]: 1 }).ok).toBe(false);
  });
  it("a cyclic in-memory object is stopped by the node bound, not looped forever", () => {
    const a: Record<string, unknown> = { usage: { prompt_tokens: 1, completion_tokens: 1 } };
    a.self = a;
    expect(checkUsageBody(a).ok).toBe(false);
  });
  it("a real response of normal size passes", () => {
    for (const b of [OPENAI_CHAT, OPENAI_RESPONSES, ANTHROPIC, GEMINI, BEDROCK_CONVERSE, COHERE_V2]) expect(checkUsageBody(b)).toEqual({ ok: true });
  });
});

describe("malicious and oversized mappings are refused at validation", () => {
  const base = OPENAI_CHAT_MAPPING;
  const withField = (src: unknown) => ({ ...base, fields: { ...base.fields, inputTokens: src } });
  it.each([
    ["not an object", "x"],
    ["an array", [base]],
    ["wrong format tag", { ...base, format: "v2" }],
    ["an unknown top-level key (no code, no script)", { ...base, script: "return 1" }],
    ["an unknown field", { ...base, fields: { ...base.fields, dollars: { pointer: "/a" } } }],
    ["a missing required field", { format: USAGE_MAPPING_FORMAT, fields: { inputTokens: { pointer: "/a" } } }],
    ["a bad totalsInclude", { ...base, totalsInclude: "some" }],
    ["a source with two kinds", withField({ pointer: "/a", sum: ["/b"] })],
    ["a source with an extra key", withField({ pointer: "/a", eval: "1+1" })],
    ["a JSONPath expression instead of a pointer", withField({ pointer: "$.usage[?(@.x)]" })],
    ["a JavaScript expression", withField({ pointer: "constructor.constructor('return process')()" })],
    ["an invalid escape", withField({ pointer: "/a~2b" })],
    ["an empty pointer (the whole document)", withField({ pointer: "" })],
    ["an over-long pointer", withField({ pointer: "/" + "a".repeat(L.pointerMaxLength) })],
    ["too many segments", withField({ pointer: "/a".repeat(L.pointerMaxSegments + 1) })],
    ["too many sum terms", withField({ sum: Array.from({ length: L.sumMaxTerms + 1 }, () => "/a") })],
    ["an empty sum", withField({ sum: [] })],
    ["too many equals values", withField({ arraySum: { array: "/a", value: "/v", where: { pointer: "/m", equals: Array.from({ length: L.equalsMaxValues + 1 }, (_, i) => `v${i}`) } } })],
    ["a non-string equals value", withField({ arraySum: { array: "/a", value: "/v", where: { pointer: "/m", equals: [{ $ne: 1 }] } } })],
    ["an arraySum with an unknown key", withField({ arraySum: { array: "/a", value: "/v", map: "x" } })],
    ["a document over the byte cap", { ...base, fields: { ...base.fields, inputTokens: { sum: ["/" + "a".repeat(250), "/" + "b".repeat(250), "/" + "c".repeat(250), "/" + "d".repeat(250)] }, outputTokens: { sum: ["/" + "a".repeat(250), "/" + "b".repeat(250), "/" + "c".repeat(250), "/" + "d".repeat(250)] }, cacheReadInputTokens: { sum: ["/" + "a".repeat(250), "/" + "b".repeat(250), "/" + "c".repeat(250), "/" + "d".repeat(250)] }, audioInputTokens: { sum: ["/" + "a".repeat(250), "/" + "b".repeat(250), "/" + "c".repeat(250), "/" + "d".repeat(250)] }, audioOutputTokens: { sum: ["/" + "a".repeat(250)] } } }],
  ])("%s", (_name, mapping) => {
    const v = validateUsageMapping(mapping);
    expect(v.ok).toBe(false);
  });

  it("a cyclic mapping object is refused without throwing", () => {
    const m: Record<string, unknown> = { ...base };
    m.self = m;
    expect(validateUsageMapping(m)).toEqual({ ok: false, errors: ["the mapping is not JSON-serialisable"] });
  });

  it("a __proto__ key is an unknown key, and the stored copy carries no prototype tricks", () => {
    const evil = JSON.parse(`{"format":"${USAGE_MAPPING_FORMAT}","fields":{"inputTokens":{"pointer":"/a"},"outputTokens":{"pointer":"/b"},"__proto__":{"pointer":"/c"}}}`);
    expect(validateUsageMapping(evil).ok).toBe(false);
  });

  it("errors never echo a long input", () => {
    const v = validateUsageMapping({ ...base, ["k".repeat(1000)]: 1 });
    expect(v.ok).toBe(false);
    if (!v.ok) for (const e of v.errors) expect(e.length).toBeLessThan(200);
  });

  it("every golden mapping validates", () => {
    expect(validateUsageMapping(OPENAI_CHAT_MAPPING).ok).toBe(true);
    expect(validateUsageMapping(GEMINI_MAPPING).ok).toBe(true);
  });
});
