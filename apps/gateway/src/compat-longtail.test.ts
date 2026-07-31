import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createDb,
  desc,
  eq,
  interceptionSettings,
  INTERCEPTION_SETTINGS_ID,
  runMigrations,
  usageEvents,
  type Db,
} from "@regulait/db";
import { resolveModelProvider, type MockModelProvider } from "@regulait/model-provider";
import { buildApp } from "./app.js";

/**
 * ADR-0020 §5 amendment (2026-07-31) — the COMPAT LONG TAIL, end to end:
 * `tool_choice`, OpenAI `response_format` (structured outputs) and Anthropic
 * `thinking` move from "honest 400" to HONOURED, each with a real mapping.
 *
 * The claims under test:
 *  1. tool_choice is honoured OBSERVABLY through the full governed path (the
 *     mock forces/suppresses tool calls accordingly) on both surfaces, in all
 *     mappable variants — and every unmappable variant still 400s NAMING the
 *     exact variant. A named tool absent from the request's tools list is 400.
 *  2. response_format json_object / json_schema round-trip on the OpenAI
 *     surface; the Anthropic-shaped surface still rejects response_format (it
 *     is not that dialect); and an OpenAI-shaped request whose SERVED agent
 *     dispatches to the Anthropic adapter is a 400 naming the field — the
 *     documented per-surface/per-provider asymmetry, never a prompt-nudge.
 *  3. thinking round-trips on the Anthropic surface: request param honoured,
 *     thinking blocks (signature intact) in the response, correct SSE framing
 *     (thinking_delta / signature_delta before the text block), multi-turn
 *     history replay — and thinking on a provider without a mapping is a 400
 *     naming it. Thinking tokens are output tokens in the measured ledger.
 *  4. REGRESSION: temperature stays exactly the accept-and-disclose tier.
 *
 * Shares one database with the other gateway suites (fileParallelism off), so
 * every object here is name-prefixed clt-.
 */

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");

const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

const BOOT = "clt-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
const DATA_KEY = "d".repeat(64);

let db: Db;
let app: ReturnType<typeof buildApp>;
let mock: MockModelProvider;

let devId: string;
let devAuth: { authorization: string };
let mockAgentId: string; // provider mock — everything dispatchable runs here
let claudeAgentId: string; // provider anthropic — capability-gate 400s only
let gptAgentId: string; // provider openai — capability-gate 400s only

const TOOLS_ANTHROPIC = [
  { name: "clt_lookup", description: "look up", input_schema: { type: "object", properties: {} } },
  { name: "clt_write", description: "write", input_schema: { type: "object", properties: {} } },
];
const TOOLS_OPENAI = [
  { type: "function", function: { name: "clt_lookup", description: "look up", parameters: { type: "object" } } },
  { type: "function", function: { name: "clt_write", description: "write", parameters: { type: "object" } } },
];

const anthropicBody = (text = "clt probe", extra: Record<string, unknown> = {}) => ({
  model: "clt-mock",
  max_tokens: 256,
  messages: [{ role: "user", content: text }],
  ...extra,
});

const openaiBody = (text = "clt probe", extra: Record<string, unknown> = {}) => ({
  model: "clt-mock",
  messages: [{ role: "user", content: text }],
  ...extra,
});

async function mkAgent(name: string, provider: string, model: string) {
  const r = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/agents",
    payload: { name, provider, tier: 1, model, costPerMTokIn: 1, costPerMTokOut: 2 },
  });
  expect(r.statusCode).toBe(201);
  return r.json().id as string;
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });
  mock = resolveModelProvider({ provider: "mock" }) as MockModelProvider;

  const u = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/users",
    payload: { email: "clt-dev@example.com", displayName: "clt-dev" },
  });
  devId = u.json().id;
  const k = await app.inject({
    method: "POST",
    headers: AUTH,
    url: `/v1/users/${devId}/keys`,
    payload: { name: "clt" },
  });
  devAuth = { authorization: `Bearer ${k.json().token}` };

  mockAgentId = await mkAgent("clt-mock", "mock", "clt-mock");
  claudeAgentId = await mkAgent("clt-claude", "anthropic", "clt-claude");
  gptAgentId = await mkAgent("clt-gpt", "openai", "clt-gpt");
  for (const agentId of [mockAgentId, claudeAgentId, gptAgentId]) {
    const g = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/grants/agents",
      payload: { userId: devId, agentId },
    });
    expect(g.statusCode).toBe(201);
  }

  const s = await app.inject({
    method: "PUT",
    headers: AUTH,
    url: "/v1/interception/settings",
    payload: { anthropicCompatEnabled: true, openaiCompatEnabled: true },
  });
  expect(s.statusCode).toBe(200);
});

afterAll(async () => {
  await db
    .update(interceptionSettings)
    .set({ anthropicCompatEnabled: false, openaiCompatEnabled: false })
    .where(eq(interceptionSettings.id, INTERCEPTION_SETTINGS_ID));
  app.server.closeAllConnections();
  await app.close();
});

// =========================================================================
// 1. tool_choice — Anthropic surface
// =========================================================================

describe("tool_choice on /v1/messages is honoured end to end", () => {
  it("{type:'tool', name} forces that tool_use with NO sentinel — an observable effect", async () => {
    const r = await app.inject({
      method: "POST",
      headers: devAuth,
      url: "/v1/messages",
      payload: anthropicBody("just answer normally", {
        tools: TOOLS_ANTHROPIC,
        tool_choice: { type: "tool", name: "clt_write" },
      }),
    });
    expect(r.statusCode).toBe(200);
    const b = r.json();
    expect(b.stop_reason).toBe("tool_use");
    const call = b.content.find((c: { type: string }) => c.type === "tool_use");
    expect(call.name).toBe("clt_write");
  });

  it("{type:'any'} (our 'required') forces SOME declared tool", async () => {
    const r = await app.inject({
      method: "POST",
      headers: devAuth,
      url: "/v1/messages",
      payload: anthropicBody("just answer normally", {
        tools: TOOLS_ANTHROPIC,
        tool_choice: { type: "any" },
      }),
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().stop_reason).toBe("tool_use");
    const call = r.json().content.find((c: { type: string }) => c.type === "tool_use");
    expect(["clt_lookup", "clt_write"]).toContain(call.name);
  });

  it("{type:'none'} suppresses even a sentinel-requested tool call", async () => {
    const r = await app.inject({
      method: "POST",
      headers: devAuth,
      url: "/v1/messages",
      payload: anthropicBody("please <<use-tool:clt_lookup>> now", {
        tools: TOOLS_ANTHROPIC,
        tool_choice: { type: "none" },
      }),
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().stop_reason).toBe("end_turn");
    expect(r.json().content.every((c: { type: string }) => c.type !== "tool_use")).toBe(true);
  });

  it("a named tool NOT in the request's tools list is 400 naming it", async () => {
    const r = await app.inject({
      method: "POST",
      headers: devAuth,
      url: "/v1/messages",
      payload: anthropicBody("hi", {
        tools: TOOLS_ANTHROPIC,
        tool_choice: { type: "tool", name: "not_declared" },
      }),
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.type).toBe("invalid_request_error");
    expect(r.json().error.message).toContain("not_declared");
  });

  it("{type:'any'} with no tools at all is 400", async () => {
    const r = await app.inject({
      method: "POST",
      headers: devAuth,
      url: "/v1/messages",
      payload: anthropicBody("hi", { tool_choice: { type: "any" } }),
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.message).toContain("tool_choice");
  });

  it("the unmappable disable_parallel_tool_use:true still 400s naming the exact variant", async () => {
    const r = await app.inject({
      method: "POST",
      headers: devAuth,
      url: "/v1/messages",
      payload: anthropicBody("hi", {
        tools: TOOLS_ANTHROPIC,
        tool_choice: { type: "auto", disable_parallel_tool_use: true },
      }),
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.message).toContain("disable_parallel_tool_use");
  });

  it("an unknown tool_choice type still 400s naming it", async () => {
    const r = await app.inject({
      method: "POST",
      headers: devAuth,
      url: "/v1/messages",
      payload: anthropicBody("hi", { tools: TOOLS_ANTHROPIC, tool_choice: { type: "telepathy" } }),
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.message).toContain("telepathy");
  });
});

// =========================================================================
// 1b. tool_choice — OpenAI surface
// =========================================================================

describe("tool_choice on /v1/chat/completions is honoured end to end", () => {
  it("{type:'function', function:{name}} forces that tool call", async () => {
    const r = await app.inject({
      method: "POST",
      headers: devAuth,
      url: "/v1/chat/completions",
      payload: openaiBody("just answer normally", {
        tools: TOOLS_OPENAI,
        tool_choice: { type: "function", function: { name: "clt_write" } },
      }),
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().choices[0].finish_reason).toBe("tool_calls");
    expect(r.json().choices[0].message.tool_calls[0].function.name).toBe("clt_write");
  });

  it("'required' forces some declared tool; 'none' suppresses a sentinel call", async () => {
    const required = await app.inject({
      method: "POST",
      headers: devAuth,
      url: "/v1/chat/completions",
      payload: openaiBody("just answer normally", { tools: TOOLS_OPENAI, tool_choice: "required" }),
    });
    expect(required.statusCode).toBe(200);
    expect(required.json().choices[0].finish_reason).toBe("tool_calls");

    const none = await app.inject({
      method: "POST",
      headers: devAuth,
      url: "/v1/chat/completions",
      payload: openaiBody("please <<use-tool:clt_lookup>> now", {
        tools: TOOLS_OPENAI,
        tool_choice: "none",
      }),
    });
    expect(none.statusCode).toBe(200);
    expect(none.json().choices[0].finish_reason).toBe("stop");
    expect(none.json().choices[0].message.tool_calls).toBeUndefined();
  });

  it("a named tool NOT in the tools list is 400 naming it", async () => {
    const r = await app.inject({
      method: "POST",
      headers: devAuth,
      url: "/v1/chat/completions",
      payload: openaiBody("hi", {
        tools: TOOLS_OPENAI,
        tool_choice: { type: "function", function: { name: "ghost_tool" } },
      }),
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.message).toContain("ghost_tool");
  });

  it("an unknown string variant still 400s naming the exact variant", async () => {
    const r = await app.inject({
      method: "POST",
      headers: devAuth,
      url: "/v1/chat/completions",
      payload: openaiBody("hi", { tools: TOOLS_OPENAI, tool_choice: "allowed_tools" }),
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.message).toContain("allowed_tools");
  });
});

// =========================================================================
// 2. response_format — OpenAI surface honours it; the asymmetry is explicit
// =========================================================================

describe("response_format (structured outputs) on the OpenAI surface", () => {
  it("json_object round-trips: the reply is parseable JSON", async () => {
    const r = await app.inject({
      method: "POST",
      headers: devAuth,
      url: "/v1/chat/completions",
      payload: openaiBody("summarize the release notes", {
        response_format: { type: "json_object" },
      }),
    });
    expect(r.statusCode).toBe(200);
    const content = r.json().choices[0].message.content as string;
    expect(JSON.parse(content)).toMatchObject({ format: "json_object" });
  });

  it("json_schema round-trips, threading the schema name through the dispatch", async () => {
    const r = await app.inject({
      method: "POST",
      headers: devAuth,
      url: "/v1/chat/completions",
      payload: openaiBody("summarize the release notes", {
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "clt_release_summary",
            schema: { type: "object", properties: { summary: { type: "string" } } },
            strict: true,
          },
        },
      }),
    });
    expect(r.statusCode).toBe(200);
    const content = JSON.parse(r.json().choices[0].message.content as string);
    expect(content).toMatchObject({ format: "json_schema", schema: "clt_release_summary" });
    // the wire request the provider saw carried the full neutral shape
    const last = mock.dispatches.at(-1)!;
    expect(last.responseFormat).toMatchObject({
      type: "json_schema",
      name: "clt_release_summary",
      strict: true,
    });
  });

  it("{type:'text'} is a real mapping onto the default — an ordinary text reply", async () => {
    const r = await app.inject({
      method: "POST",
      headers: devAuth,
      url: "/v1/chat/completions",
      payload: openaiBody("summarize the release notes", { response_format: { type: "text" } }),
    });
    expect(r.statusCode).toBe(200);
    expect(() => JSON.parse(r.json().choices[0].message.content as string)).toThrow();
  });

  it("an unknown response_format type is 400 naming the exact variant", async () => {
    const r = await app.inject({
      method: "POST",
      headers: devAuth,
      url: "/v1/chat/completions",
      payload: openaiBody("hi", { response_format: { type: "xml" } }),
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.message).toContain("xml");
  });

  it("json_schema without a schema is 400 naming the missing field", async () => {
    const r = await app.inject({
      method: "POST",
      headers: devAuth,
      url: "/v1/chat/completions",
      payload: openaiBody("hi", { response_format: { type: "json_schema", json_schema: { name: "x" } } }),
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.message).toContain("json_schema.schema");
  });

  it("THE ASYMMETRY, provider side: response_format routed to an Anthropic-provider agent is 400 — no prompt-nudge pretence", async () => {
    const r = await app.inject({
      method: "POST",
      headers: devAuth,
      url: "/v1/chat/completions",
      payload: {
        model: "clt-claude",
        messages: [{ role: "user", content: "hi" }],
        response_format: { type: "json_object" },
      },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.message).toContain("response_format");
    expect(r.json().error.message).toContain("anthropic");
    // and the same agent WITHOUT response_format gets past the capability
    // gate (failing later on credentials, not on the field) — the 400 is
    // about the field, not the agent
    const without = await app.inject({
      method: "POST",
      headers: devAuth,
      url: "/v1/chat/completions",
      payload: { model: "clt-claude", messages: [{ role: "user", content: "hi" }] },
    });
    expect(without.statusCode).toBe(409);
    expect(without.json().error.regulait_code).toBe("no_model_credential");
  });

  it("THE ASYMMETRY, dialect side: response_format on the Anthropic-shaped surface stays a 400 naming it", async () => {
    const r = await app.inject({
      method: "POST",
      headers: devAuth,
      url: "/v1/messages",
      payload: anthropicBody("hi", { response_format: { type: "json_object" } }),
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.message).toContain("response_format");
  });
});

// =========================================================================
// 3. thinking — Anthropic surface
// =========================================================================

describe("thinking on /v1/messages is honoured end to end", () => {
  it("buffered: thinking blocks come FIRST with signatures, then the text answer", async () => {
    const r = await app.inject({
      method: "POST",
      headers: devAuth,
      url: "/v1/messages",
      payload: anthropicBody("summarize the release notes", {
        thinking: { type: "enabled", budget_tokens: 256 },
      }),
    });
    expect(r.statusCode).toBe(200);
    const b = r.json();
    expect(b.content[0].type).toBe("thinking");
    expect(b.content[0].thinking).toContain("budget 256");
    expect(b.content[0].signature).toBe("mock-signature");
    expect(b.content[1].type).toBe("text");
    expect(b.content[1].text.length).toBeGreaterThan(0);
    // the provider saw the real neutral param
    expect(mock.dispatches.at(-1)!.thinking).toEqual({ budgetTokens: 256 });
  });

  it("usage stays honest: thinking tokens are OUTPUT tokens, in the response AND the measured ledger", async () => {
    const bare = await app.inject({
      method: "POST",
      headers: devAuth,
      url: "/v1/messages",
      payload: anthropicBody("summarize the release notes"),
    });
    const withThinking = await app.inject({
      method: "POST",
      headers: devAuth,
      url: "/v1/messages",
      payload: anthropicBody("summarize the release notes", {
        thinking: { type: "enabled", budget_tokens: 256 },
      }),
    });
    const bareOut = bare.json().usage.output_tokens as number;
    const thinkOut = withThinking.json().usage.output_tokens as number;
    expect(thinkOut).toBeGreaterThan(bareOut);
    // the usage_events row records the same billed total
    const [row] = await db
      .select()
      .from(usageEvents)
      .where(eq(usageEvents.userId, devId))
      .orderBy(desc(usageEvents.at))
      .limit(1);
    expect(row!.outputTokens).toBe(thinkOut);
  });

  it("SSE: thinking_delta frames, then signature_delta, then the text block — vendor framing", async () => {
    const r = await app.inject({
      method: "POST",
      headers: devAuth,
      url: "/v1/messages",
      payload: anthropicBody("write a paragraph about builds", {
        stream: true,
        thinking: { type: "enabled", budget_tokens: 128 },
      }),
    });
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toContain("text/event-stream");
    const datas = [...r.body.matchAll(/^data: (.+)$/gm)].map((m) => JSON.parse(m[1]!));
    const starts = datas.filter((d) => d.type === "content_block_start");
    expect(starts[0].index).toBe(0);
    expect(starts[0].content_block.type).toBe("thinking");
    expect(starts[1].index).toBe(1);
    expect(starts[1].content_block.type).toBe("text");
    const deltas = datas.filter((d) => d.type === "content_block_delta");
    const kinds = deltas.map((d) => d.delta.type);
    // thinking deltas strictly precede the signature, which precedes any text
    expect(kinds[0]).toBe("thinking_delta");
    expect(kinds).toContain("signature_delta");
    expect(kinds).toContain("text_delta");
    expect(kinds.indexOf("signature_delta")).toBeGreaterThan(kinds.lastIndexOf("thinking_delta"));
    expect(kinds.indexOf("text_delta")).toBeGreaterThan(kinds.indexOf("signature_delta"));
    const sig = deltas.find((d) => d.delta.type === "signature_delta");
    expect(sig.delta.signature).toBe("mock-signature");
    // thinking deltas concatenate to the full thinking text
    const thinkingText = deltas
      .filter((d) => d.delta.type === "thinking_delta")
      .map((d) => d.delta.thinking)
      .join("");
    expect(thinkingText).toContain("budget 128");
    // both blocks close, and the message framing stays intact
    const stops = datas.filter((d) => d.type === "content_block_stop").map((d) => d.index);
    expect(stops).toEqual([0, 1]);
    const events = [...r.body.matchAll(/^event: (.+)$/gm)].map((m) => m[1]);
    expect(events[0]).toBe("message_start");
    expect(events[events.length - 1]).toBe("message_stop");
  });

  it("a plain stream (no thinking) keeps the original single-text-block framing", async () => {
    const r = await app.inject({
      method: "POST",
      headers: devAuth,
      url: "/v1/messages",
      payload: anthropicBody("write a paragraph about builds", { stream: true }),
    });
    expect(r.statusCode).toBe(200);
    const datas = [...r.body.matchAll(/^data: (.+)$/gm)].map((m) => JSON.parse(m[1]!));
    const starts = datas.filter((d) => d.type === "content_block_start");
    expect(starts).toHaveLength(1);
    expect(starts[0].index).toBe(0);
    expect(starts[0].content_block.type).toBe("text");
    expect(datas.some((d) => d.delta?.type === "thinking_delta")).toBe(false);
  });

  it("round-trips thinking + redacted_thinking blocks through multi-turn history, signature intact", async () => {
    const r = await app.inject({
      method: "POST",
      headers: devAuth,
      url: "/v1/messages",
      payload: {
        model: "clt-mock",
        max_tokens: 256,
        thinking: { type: "enabled", budget_tokens: 128 },
        messages: [
          { role: "user", content: "first question about deployments" },
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "CLT-EARLIER-REASONING", signature: "sig-turn-1" },
              { type: "redacted_thinking", data: "opaque-bytes" },
              { type: "text", text: "first answer" },
            ],
          },
          { role: "user", content: "now a follow up" },
        ],
      },
    });
    expect(r.statusCode).toBe(200);
    // the translation preserved the blocks into the dispatch history
    const last = mock.dispatches.at(-1)!;
    const assistant = last.messages![1]!;
    expect(assistant.content).toEqual([
      { type: "thinking", thinking: "CLT-EARLIER-REASONING", signature: "sig-turn-1" },
      { type: "redacted_thinking", data: "opaque-bytes" },
      { type: "text", text: "first answer" },
    ]);
    // ... and prior-turn reasoning never leaks into the new answer's text
    const textBlock = r.json().content.find((c: { type: string }) => c.type === "text");
    expect(textBlock.text).not.toContain("CLT-EARLIER-REASONING");
  });

  it("thinking blocks on a USER turn are 400 — only assistant turns may replay them", async () => {
    const r = await app.inject({
      method: "POST",
      headers: devAuth,
      url: "/v1/messages",
      payload: {
        model: "clt-mock",
        max_tokens: 64,
        messages: [{ role: "user", content: [{ type: "thinking", thinking: "hmm" }] }],
      },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.message).toContain("assistant");
  });

  it("{type:'disabled'} is a real mapping onto absent — no thinking blocks", async () => {
    const r = await app.inject({
      method: "POST",
      headers: devAuth,
      url: "/v1/messages",
      payload: anthropicBody("hello there friend", { thinking: { type: "disabled" } }),
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().content.every((c: { type: string }) => c.type !== "thinking")).toBe(true);
  });

  it("enabled without budget_tokens is 400 naming the missing field", async () => {
    const r = await app.inject({
      method: "POST",
      headers: devAuth,
      url: "/v1/messages",
      payload: anthropicBody("hi", { thinking: { type: "enabled" } }),
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.message).toContain("budget_tokens");
  });

  it("thinking routed to a provider WITHOUT a mapping is 400 naming it, never silently dropped", async () => {
    const r = await app.inject({
      method: "POST",
      headers: devAuth,
      url: "/v1/messages",
      payload: {
        model: "clt-gpt",
        max_tokens: 256,
        messages: [{ role: "user", content: "hi" }],
        thinking: { type: "enabled", budget_tokens: 128 },
      },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.message).toContain("thinking");
    expect(r.json().error.message).toContain("openai");
  });

  it("thinking is NOT in the OpenAI dialect — /v1/chat/completions still 400s it by name", async () => {
    const r = await app.inject({
      method: "POST",
      headers: devAuth,
      url: "/v1/chat/completions",
      payload: openaiBody("hi", { thinking: { type: "enabled", budget_tokens: 128 } }),
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.message).toContain("thinking");
  });
});

// =========================================================================
// 4. REGRESSION — temperature stays exactly the accept-and-disclose tier
// =========================================================================

describe("temperature accept-and-disclose regression", () => {
  it("Anthropic surface: accepted, not honoured, disclosed — even alongside honoured long-tail fields", async () => {
    const r = await app.inject({
      method: "POST",
      headers: devAuth,
      url: "/v1/messages",
      payload: anthropicBody("hi", {
        temperature: 0.4,
        tools: TOOLS_ANTHROPIC,
        tool_choice: { type: "tool", name: "clt_lookup" },
      }),
    });
    expect(r.statusCode).toBe(200);
    expect(r.headers["x-regulait-ignored-fields"]).toBe("temperature");
    // the honoured field still worked in the same request
    expect(r.json().stop_reason).toBe("tool_use");
  });

  it("OpenAI surface: accepted, not honoured, disclosed", async () => {
    const r = await app.inject({
      method: "POST",
      headers: devAuth,
      url: "/v1/chat/completions",
      payload: openaiBody("hi", { temperature: 0.2, response_format: { type: "json_object" } }),
    });
    expect(r.statusCode).toBe(200);
    expect(r.headers["x-regulait-ignored-fields"]).toBe("temperature");
    expect(JSON.parse(r.json().choices[0].message.content as string)).toMatchObject({
      format: "json_object",
    });
  });
});
