// ADR-0257 — the official OpenAI and Anthropic SDKs, unmodified, pointed at the
// RegulAIt gateway's provider-compatible surfaces (`/v1/chat/completions`,
// `/v1/responses` (ADR-0287), `/v1/messages`). Each check prints one JSON line; the harness asserts them and
// then checks the ledger and audit rows itself. Nothing here talks to a real
// provider: the gateway's agent is the `mock` provider.
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";

const env = (k) => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} must be set`);
  return v;
};
const GATEWAY = env("GATEWAY_URL");
const MODEL = env("MODEL");
const PROJECT = env("PROJECT_ID");
const TOOL = env("TOOL_NAME");
const headers = { "x-regulait-project-id": PROJECT };

const results = [];
async function check(name, fn) {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail });
  } catch (e) {
    results.push({ name, ok: false, detail: String(e?.stack ?? e) });
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
/** A refusal the client can read: the SDK's typed error, the HTTP status, and a non-empty message. */
function readableRefusal(e, status, Klass) {
  assert(e instanceof Klass, `expected ${Klass.name}, got ${e?.constructor?.name}: ${e?.message}`);
  assert(e.status === status, `expected status ${status}, got ${e.status}`);
  assert(typeof e.message === "string" && e.message.length > 10, `unreadable message: ${JSON.stringify(e.message)}`);
  return { status: e.status, type: e.constructor.name, message: e.message.slice(0, 200) };
}

// ---------------------------------------------------------------- OpenAI SDK
const oa = (key) =>
  new OpenAI({ apiKey: key, baseURL: `${GATEWAY}/v1`, defaultHeaders: headers, maxRetries: 0, timeout: 30_000 });
const oaAllow = oa(env("OPENAI_ALLOW_KEY"));

await check("openai.auth", async () => {
  try {
    await oa("rgk_not-a-real-key").chat.completions.create({ model: MODEL, messages: [{ role: "user", content: "hi" }] });
  } catch (e) {
    return readableRefusal(e, 401, OpenAI.AuthenticationError);
  }
  throw new Error("an invalid key was accepted");
});
await check("openai.allow", async () => {
  const r = await oaAllow.chat.completions.create({ model: MODEL, messages: [{ role: "user", content: "p33 openai allow" }] });
  const text = r.choices[0]?.message?.content ?? "";
  assert(text.length > 0, "empty completion");
  assert(r.usage && r.usage.total_tokens > 0, "no usage block");
  return { text: text.slice(0, 80), usage: r.usage };
});
await check("openai.deny", async () => {
  try {
    await oa(env("OPENAI_DENY_KEY")).chat.completions.create({ model: MODEL, messages: [{ role: "user", content: "p33 openai deny" }] });
  } catch (e) {
    return readableRefusal(e, 403, OpenAI.PermissionDeniedError);
  }
  throw new Error("an ungranted caller was allowed");
});
await check("openai.stream", async () => {
  const stream = await oaAllow.chat.completions.create({
    model: MODEL,
    stream: true,
    messages: [{ role: "user", content: "p33 openai stream" }],
  });
  let text = "";
  let chunks = 0;
  for await (const chunk of stream) {
    chunks += 1;
    text += chunk.choices[0]?.delta?.content ?? "";
  }
  assert(chunks > 1 && text.length > 0, `stream produced ${chunks} chunks, text ${JSON.stringify(text)}`);
  return { chunks, text: text.slice(0, 80) };
});
await check("openai.tools", async () => {
  const r = await oaAllow.chat.completions.create({
    model: MODEL,
    messages: [{ role: "user", content: `look it up <<use-tool:${TOOL}>>` }],
    tools: [{ type: "function", function: { name: TOOL, description: "look up a record", parameters: { type: "object", properties: {} } } }],
  });
  const call = r.choices[0]?.message?.tool_calls?.[0];
  assert(r.choices[0]?.finish_reason === "tool_calls", `finish_reason ${r.choices[0]?.finish_reason}`);
  assert(call?.function?.name === TOOL, `tool call ${JSON.stringify(call)}`);
  return { tool: call.function.name };
});

// ------------------------------------------------- OpenAI SDK, Responses API
// ADR-0287: the gateway keeps no conversation state, so the tool loop sends
// `store: false` and replays the prior output items in `input`.
const oaResponses = oa(env("RESPONSES_ALLOW_KEY"));
const responsesTool = { type: "function", name: TOOL, description: "look up a record", parameters: { type: "object", properties: {} }, strict: false };

await check("responses.auth", async () => {
  try {
    await oa("rgk_not-a-real-key").responses.create({ model: MODEL, input: "hi", store: false });
  } catch (e) {
    return readableRefusal(e, 401, OpenAI.AuthenticationError);
  }
  throw new Error("an invalid key was accepted");
});
await check("responses.allow", async () => {
  const r = await oaResponses.responses.create({ model: MODEL, instructions: "You are terse.", input: "p33 responses allow", store: false });
  assert(r.object === "response" && r.status === "completed", `status ${r.status}`);
  assert(r.output_text.length > 0, "empty output_text");
  assert(r.usage && r.usage.total_tokens > 0, "no usage block");
  return { text: r.output_text.slice(0, 80), usage: r.usage };
});
await check("responses.deny", async () => {
  try {
    await oa(env("RESPONSES_DENY_KEY")).responses.create({ model: MODEL, input: "p33 responses deny", store: false });
  } catch (e) {
    return readableRefusal(e, 403, OpenAI.PermissionDeniedError);
  }
  throw new Error("an ungranted caller was allowed");
});
await check("responses.stream", async () => {
  const stream = await oaResponses.responses.create({ model: MODEL, input: "p33 responses stream", stream: true, store: false });
  let deltas = 0;
  let text = "";
  let completed = false;
  for await (const ev of stream) {
    if (ev.type === "response.output_text.delta") {
      deltas += 1;
      text += ev.delta;
    }
    if (ev.type === "response.completed") completed = true;
  }
  assert(deltas > 0 && text.length > 0 && completed, `stream produced ${deltas} deltas, completed ${completed}`);
  return { deltas, text: text.slice(0, 80) };
});
await check("responses.tools", async () => {
  const input = [{ role: "user", content: `look it up <<use-tool:${TOOL}>>` }];
  const first = await oaResponses.responses.create({ model: MODEL, input, tools: [responsesTool], store: false });
  const call = first.output.find((o) => o.type === "function_call");
  assert(call?.name === TOOL, `tool call ${JSON.stringify(first.output)}`);
  const second = await oaResponses.responses.create({
    model: MODEL,
    input: [...input, ...first.output, { type: "function_call_output", call_id: call.call_id, output: "record: p33" }],
    tools: [responsesTool],
    store: false,
  });
  assert(second.status === "completed", `second turn status ${second.status}`);
  return { tool: call.name, final: second.output_text.slice(0, 80) };
});

// ------------------------------------------------------------- Anthropic SDK
const an = (key) =>
  new Anthropic({ apiKey: key, baseURL: GATEWAY, defaultHeaders: headers, maxRetries: 0, timeout: 30_000 });
const anAllow = an(env("ANTHROPIC_ALLOW_KEY"));

await check("anthropic.auth", async () => {
  try {
    await an("rgk_not-a-real-key").messages.create({ model: MODEL, max_tokens: 64, messages: [{ role: "user", content: "hi" }] });
  } catch (e) {
    return readableRefusal(e, 401, Anthropic.AuthenticationError);
  }
  throw new Error("an invalid key was accepted");
});
await check("anthropic.allow", async () => {
  const r = await anAllow.messages.create({ model: MODEL, max_tokens: 256, messages: [{ role: "user", content: "p33 anthropic allow" }] });
  const text = r.content.find((b) => b.type === "text")?.text ?? "";
  assert(text.length > 0, "empty message");
  assert(r.usage.input_tokens > 0, "no usage block");
  return { text: text.slice(0, 80), usage: r.usage };
});
await check("anthropic.deny", async () => {
  try {
    await an(env("ANTHROPIC_DENY_KEY")).messages.create({ model: MODEL, max_tokens: 64, messages: [{ role: "user", content: "p33 anthropic deny" }] });
  } catch (e) {
    return readableRefusal(e, 403, Anthropic.PermissionDeniedError);
  }
  throw new Error("an ungranted caller was allowed");
});
await check("anthropic.stream", async () => {
  const stream = anAllow.messages.stream({ model: MODEL, max_tokens: 256, messages: [{ role: "user", content: "p33 anthropic stream" }] });
  let deltas = 0;
  stream.on("text", () => (deltas += 1));
  const final = await stream.finalMessage();
  const text = final.content.find((b) => b.type === "text")?.text ?? "";
  assert(deltas > 0 && text.length > 0, `stream produced ${deltas} deltas, text ${JSON.stringify(text)}`);
  return { deltas, text: text.slice(0, 80) };
});
await check("anthropic.tools", async () => {
  const r = await anAllow.messages.create({
    model: MODEL,
    max_tokens: 256,
    messages: [{ role: "user", content: `look it up <<use-tool:${TOOL}>>` }],
    tools: [{ name: TOOL, description: "look up a record", input_schema: { type: "object", properties: {} } }],
  });
  const call = r.content.find((b) => b.type === "tool_use");
  assert(r.stop_reason === "tool_use", `stop_reason ${r.stop_reason}`);
  assert(call?.name === TOOL, `tool_use ${JSON.stringify(call)}`);
  return { tool: call.name };
});

process.stdout.write(`${JSON.stringify({ client: "node-sdks", results })}\n`);
