import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  and,
  auditLog,
  costEvents,
  createDb,
  desc,
  eq,
  interceptionSettings,
  INTERCEPTION_SETTINGS_ID,
  runMigrations,
  usageEvents,
  type Db,
} from "@regulait/db";
import { buildApp } from "./app.js";
import { AGENT_HEADER, PROJECT_HEADER } from "./compat-core.js";

/**
 * ADR-0020 / ROADMAP Batch H — IDE / existing-agent interception, end to end.
 *
 * The claims under test, in order of how much damage getting them wrong would
 * do:
 *  1. A disabled compat surface is a 404 — indistinguishable from a route that
 *     was never registered. We do not advertise a surface an admin turned off.
 *  2. The compat endpoints create NO privilege path: a user without a grant is
 *     denied through them exactly as they are at /v1/agents/:id/invoke.
 *  3. An unmapped model is DEFAULT-DENY (403), never a silent pass-through to
 *     the vendor. That invariant is the entire point of the batch.
 *  4. Resolution mode is an ADMIN CHOICE and all three modes behave as
 *     specified, including router_decides DISCLOSING the model it served.
 *  5. Attribution, PII (incl. ADR-0019 block-mode streaming suppression) and
 *     the usage ledger behave identically to the invoke path.
 *  6. Writing the posture is admin-only; the developer-facing endpoints are not.
 *
 * Shares one database with the other gateway suites (fileParallelism off), so
 * every object here is name-prefixed ide-.
 */

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");

const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

const BOOT = "ide-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
const DATA_KEY = "c".repeat(64);

let db: Db;
let app: ReturnType<typeof buildApp>;

let devId: string;
let devAuth: { authorization: string };
let devKey: string;
let strangerAuth: { authorization: string };
let strangerId: string;
let premiumAgentId: string; // tier 3, model ide-premium
let cheapAgentId: string; // tier 1, model ide-cheap
let dupeLowId: string; // tier 1, model ide-dupe — the tie-break winner
let plainProject: string;
let blockProject: string;

async function makeUser(email: string) {
  const u = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/users",
    payload: { email, displayName: email.split("@")[0] },
  });
  const k = await app.inject({
    method: "POST",
    headers: AUTH,
    url: `/v1/users/${u.json().id}/keys`,
    payload: { name: "ide" },
  });
  return {
    id: u.json().id as string,
    token: k.json().token as string,
    auth: { authorization: `Bearer ${k.json().token}` },
  };
}

async function mkAgent(name: string, model: string, tier: number, priceIn: number) {
  const r = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/agents",
    payload: { name, provider: "mock", tier, model, costPerMTokIn: priceIn, costPerMTokOut: priceIn * 2 },
  });
  expect(r.statusCode).toBe(201);
  return r.json().id as string;
}

/** the admin lever under test — every posture axis is configuration */
async function setPosture(patch: Record<string, unknown>) {
  const r = await app.inject({
    method: "PUT",
    headers: AUTH,
    url: "/v1/interception/settings",
    payload: patch,
  });
  expect(r.statusCode).toBe(200);
  return r.json().settings;
}

const anthropicBody = (model: string, text = "ide probe", extra: Record<string, unknown> = {}) => ({
  model,
  max_tokens: 256,
  messages: [{ role: "user", content: text }],
  ...extra,
});

const openaiBody = (model: string, text = "ide probe", extra: Record<string, unknown> = {}) => ({
  model,
  messages: [{ role: "user", content: text }],
  ...extra,
});

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });

  const dev = await makeUser("ide-dev@example.com");
  devId = dev.id;
  devAuth = dev.auth;
  devKey = dev.token;
  const stranger = await makeUser("ide-stranger@example.com");
  strangerAuth = stranger.auth;
  strangerId = stranger.id;

  premiumAgentId = await mkAgent("ide-premium", "ide-premium", 3, 15);
  cheapAgentId = await mkAgent("ide-cheap", "ide-cheap", 1, 0.25);
  // two registry rows carrying the SAME model id, to exercise the documented
  // tie-break (lowest tier, then oldest createdAt, then id)
  dupeLowId = await mkAgent("ide-dupe-low", "ide-dupe", 1, 1);
  await mkAgent("ide-dupe-high", "ide-dupe", 4, 9);

  for (const agentId of [premiumAgentId, cheapAgentId, dupeLowId]) {
    const g = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/grants/agents",
      payload: { userId: devId, agentId },
    });
    expect(g.statusCode).toBe(201);
  }

  await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/compliance/profiles",
    payload: { tag: "ide-block", piiMode: "block" },
  });
  const mkProject = async (name: string, classifications?: string[]) => {
    const r = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/projects",
      payload: { name, ...(classifications ? { classifications } : {}) },
    });
    expect(r.statusCode).toBe(201);
    return r.json().id as string;
  };
  plainProject = await mkProject("ide-plain-proj");
  blockProject = await mkProject("ide-block-proj", ["ide-block"]);
  for (const p of [plainProject, blockProject]) {
    const m = await app.inject({
      method: "POST",
      headers: AUTH,
      url: `/v1/projects/${p}/members`,
      payload: { userId: devId, role: "contributor" },
    });
    expect(m.statusCode).toBe(201);
  }
});

afterAll(async () => {
  // restore the shipped defaults so a later suite sharing this database sees a
  // pristine posture (both compat surfaces off, MCP on)
  await db
    .update(interceptionSettings)
    .set({
      anthropicCompatEnabled: false,
      openaiCompatEnabled: false,
      mcpInterceptionEnabled: true,
      resolutionMode: "map_by_model",
      enforcementPosture: "voluntary",
      requireProjectAttribution: false,
    })
    .where(eq(interceptionSettings.id, INTERCEPTION_SETTINGS_ID));
  app.server.closeAllConnections();
  await app.close();
});

// =========================================================================
// posture: default-deny, admin-only, audited
// =========================================================================

describe("interception posture is admin-configurable and default-deny", () => {
  it("ships with both compat surfaces OFF and MCP interception ON", async () => {
    const r = await app.inject({ method: "GET", headers: AUTH, url: "/v1/interception/settings" });
    expect(r.statusCode).toBe(200);
    const s = r.json().settings;
    expect(s.anthropicCompatEnabled).toBe(false);
    expect(s.openaiCompatEnabled).toBe(false);
    expect(s.mcpInterceptionEnabled).toBe(true);
    expect(s.resolutionMode).toBe("map_by_model");
  });

  it("a DISABLED compat surface answers 404 — indistinguishable from not existing", async () => {
    const real = await app.inject({
      method: "POST",
      headers: devAuth,
      url: "/v1/messages",
      payload: anthropicBody("ide-premium"),
    });
    // the reference: a path that genuinely is not a route
    const fake = await app.inject({ method: "POST", headers: AUTH, url: "/v1/definitely-not-a-route" });
    expect(real.statusCode).toBe(404);
    expect(fake.statusCode).toBe(404);
    expect(real.json().error).toBe("Not Found");
    expect(real.json().statusCode).toBe(404);
    // byte-identical envelope, only the path inside the message differs — the
    // response never says "this exists but the admin turned it off"
    expect(Object.keys(real.json()).sort()).toEqual(Object.keys(fake.json()).sort());
    expect(real.json().message).toBe("Route POST:/v1/messages not found");
  });

  it("a disabled surface 404s BEFORE auth, so it leaks nothing to an unauthenticated probe", async () => {
    const r = await app.inject({ method: "POST", url: "/v1/chat/completions", payload: openaiBody("x") });
    expect(r.statusCode).toBe(404);
  });

  it("writing the posture is admin-only; reading it is too", async () => {
    const w = await app.inject({
      method: "PUT",
      headers: devAuth,
      url: "/v1/interception/settings",
      payload: { anthropicCompatEnabled: true },
    });
    expect(w.statusCode).toBe(403);
    expect(w.json().error).toBe("admin_only");
    const r = await app.inject({ method: "GET", headers: devAuth, url: "/v1/interception/settings" });
    expect(r.statusCode).toBe(403);
  });

  it("every posture change is audited", async () => {
    await setPosture({ anthropicCompatEnabled: true, openaiCompatEnabled: true });
    const rows = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.ruleId, "interception-settings-updated"));
    expect(rows.length).toBeGreaterThan(0);
    const detail = rows[rows.length - 1]!.detail as { changed?: Record<string, unknown> };
    expect(detail.changed).toBeDefined();
  });
});

// =========================================================================
// the Anthropic-shaped surface
// =========================================================================

describe("POST /v1/messages — Anthropic-shaped translation shim", () => {
  it("an entitled user gets a correctly shaped Anthropic response", async () => {
    const r = await app.inject({
      method: "POST",
      headers: devAuth,
      url: "/v1/messages",
      payload: anthropicBody("ide-premium", "summarize the release notes"),
    });
    expect(r.statusCode).toBe(200);
    const b = r.json();
    expect(b.type).toBe("message");
    expect(b.role).toBe("assistant");
    expect(b.model).toBe("ide-premium");
    expect(b.id.startsWith("msg_")).toBe(true);
    expect(Array.isArray(b.content)).toBe(true);
    expect(b.content[0].type).toBe("text");
    expect(typeof b.content[0].text).toBe("string");
    expect(b.content[0].text.length).toBeGreaterThan(0);
    expect(b.stop_reason).toBe("end_turn");
    expect(b.stop_sequence).toBeNull();
    expect(b.usage.input_tokens).toBeGreaterThan(0);
    expect(b.usage.output_tokens).toBeGreaterThan(0);
    // disclosure rides both the body and the headers
    expect(b.regulait.servedModel).toBe("ide-premium");
    expect(r.headers["x-regulait-served-model"]).toBe("ide-premium");
    expect(r.headers["x-regulait-resolution-mode"]).toBe("map_by_model");
  });

  it("accepts the SAME key via x-api-key, which is what Anthropic clients send", async () => {
    const r = await app.inject({
      method: "POST",
      headers: { "x-api-key": devKey },
      url: "/v1/messages",
      payload: anthropicBody("ide-premium"),
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().type).toBe("message");
  });

  it("x-api-key with a bogus value is still 401 — a second header name, not a weaker path", async () => {
    const r = await app.inject({
      method: "POST",
      headers: { "x-api-key": "rgl_not-a-real-key" },
      url: "/v1/messages",
      payload: anthropicBody("ide-premium"),
    });
    expect(r.statusCode).toBe(401);
  });

  it("round-trips content blocks: system, multi-turn, tool_use and tool_result", async () => {
    const r = await app.inject({
      method: "POST",
      headers: devAuth,
      url: "/v1/messages",
      payload: {
        model: "ide-premium",
        max_tokens: 256,
        system: [{ type: "text", text: "You are a release engineer.", cache_control: { type: "ephemeral" } }],
        messages: [
          { role: "user", content: [{ type: "text", text: "check the build" }] },
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "toolu_1", name: "ide_build", input: { target: "all" } }],
          },
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: "build ok" }] },
            ],
          },
        ],
      },
    });
    expect(r.statusCode).toBe(200);
    // the mock provider quotes the tool result back, proving the block
    // survived translation in BOTH directions
    expect(r.json().content[0].text).toContain("build ok");
  });

  it("translates a declared tool and returns a tool_use block when the model calls it", async () => {
    const r = await app.inject({
      method: "POST",
      headers: devAuth,
      url: "/v1/messages",
      payload: anthropicBody("ide-premium", "please <<use-tool:ide_lookup>> now", {
        tools: [
          {
            name: "ide_lookup",
            description: "look something up",
            input_schema: { type: "object", properties: {} },
          },
        ],
      }),
    });
    expect(r.statusCode).toBe(200);
    const b = r.json();
    expect(b.stop_reason).toBe("tool_use");
    const toolBlock = b.content.find((c: { type: string }) => c.type === "tool_use");
    expect(toolBlock.name).toBe("ide_lookup");
  });

  it("FAILS LOUDLY on an unsupported top-level field, naming it", async () => {
    const r = await app.inject({
      method: "POST",
      headers: devAuth,
      url: "/v1/messages",
      payload: anthropicBody("ide-premium", "hi", { tool_choice: { type: "any" } }),
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().type).toBe("error");
    expect(r.json().error.type).toBe("invalid_request_error");
    expect(r.json().error.message).toContain("tool_choice");
  });

  // temperature moved from "400" to "accepted, not honoured": IDE clients send
  // it from a settings default the developer never chose, so rejecting it
  // bounced the call over a field nobody meaningfully asked for. The honesty
  // requirement moved rather than disappeared — see the disclosure assertions.
  it("ACCEPTS temperature instead of 400ing, and does not honour it", async () => {
    const r = await app.inject({
      method: "POST",
      headers: devAuth,
      url: "/v1/messages",
      payload: anthropicBody("ide-premium", "hi", { temperature: 0.4 }),
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().type).toBe("message");
  });

  it("DISCLOSES an ignored temperature on the response header", async () => {
    const r = await app.inject({
      method: "POST",
      headers: devAuth,
      url: "/v1/messages",
      payload: anthropicBody("ide-premium", "hi", { temperature: 0.4 }),
    });
    expect(r.headers["x-regulait-ignored-fields"]).toBe("temperature");
  });

  it("omits the ignored-fields header when nothing was dropped", async () => {
    const r = await app.inject({
      method: "POST",
      headers: devAuth,
      url: "/v1/messages",
      payload: anthropicBody("ide-premium", "hi"),
    });
    expect(r.statusCode).toBe(200);
    expect(r.headers["x-regulait-ignored-fields"]).toBeUndefined();
  });

  it("RECORDS the ignored field on the audit row, so a drop is never silent", async () => {
    await app.inject({
      method: "POST",
      headers: devAuth,
      url: "/v1/messages",
      payload: anthropicBody("ide-premium", "audit the ignored field", { temperature: 0.9 }),
    });
    const rows = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.ruleId, "compat-dispatch"))
      .orderBy(desc(auditLog.at))
      .limit(5);
    const withIgnored = rows.find(
      (row) => Array.isArray((row.detail as { ignoredFields?: string[] }).ignoredFields),
    );
    expect(withIgnored).toBeDefined();
    expect((withIgnored!.detail as { ignoredFields: string[] }).ignoredFields).toEqual(["temperature"]);
  });

  it("still 400s a field that would change what the model CAN do", async () => {
    const r = await app.inject({
      method: "POST",
      headers: devAuth,
      url: "/v1/messages",
      payload: anthropicBody("ide-premium", "hi", { thinking: { type: "enabled" } }),
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.message).toContain("thinking");
  });

  it("FAILS LOUDLY on an unsupported content-block type", async () => {
    const r = await app.inject({
      method: "POST",
      headers: devAuth,
      url: "/v1/messages",
      payload: {
        model: "ide-premium",
        max_tokens: 64,
        messages: [{ role: "user", content: [{ type: "thinking", thinking: "hmm" }] }],
      },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.message).toContain("thinking");
  });

  it("streams a well-formed Anthropic SSE event sequence", async () => {
    const r = await app.inject({
      method: "POST",
      headers: devAuth,
      url: "/v1/messages",
      payload: anthropicBody("ide-premium", "write a paragraph about builds", { stream: true }),
    });
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toContain("text/event-stream");
    const body = r.body;
    const events = [...body.matchAll(/^event: (.+)$/gm)].map((m) => m[1]);
    expect(events[0]).toBe("message_start");
    expect(events[1]).toBe("content_block_start");
    expect(events).toContain("content_block_delta");
    expect(events).toContain("content_block_stop");
    expect(events[events.length - 2]).toBe("message_delta");
    expect(events[events.length - 1]).toBe("message_stop");
    // every frame is parseable JSON with the declared type
    const datas = [...body.matchAll(/^data: (.+)$/gm)].map((m) => JSON.parse(m[1]!));
    expect(datas[0].type).toBe("message_start");
    expect(datas[0].message.model).toBe("ide-premium");
    const delta = datas.find((d) => d.type === "content_block_delta");
    expect(delta.delta.type).toBe("text_delta");
    expect(typeof delta.delta.text).toBe("string");
    const md = datas.find((d) => d.type === "message_delta");
    expect(md.delta.stop_reason).toBe("end_turn");
    expect(md.usage.output_tokens).toBeGreaterThan(0);
  });

  it("ADR-0019: a block-mode PII project does NOT stream — it returns buffered JSON", async () => {
    const r = await app.inject({
      method: "POST",
      headers: { ...devAuth, [PROJECT_HEADER]: blockProject },
      url: "/v1/messages",
      payload: anthropicBody("ide-premium", "tell me a story", { stream: true }),
    });
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toContain("application/json");
    expect(r.body).not.toContain("event: content_block_delta");
    expect(r.json().regulait.streamingSuppressed).toBe(true);
    expect(r.headers["x-regulait-streaming-suppressed"]).toBe("true");
  });

  it("PII enforcement is identical to the invoke path — a leaking output is billed and withheld", async () => {
    const r = await app.inject({
      method: "POST",
      headers: { ...devAuth, [PROJECT_HEADER]: blockProject },
      url: "/v1/messages",
      payload: anthropicBody("ide-premium", "please <<emit-ssn>> for the record"),
    });
    expect(r.statusCode).toBe(200);
    const text = r.json().content[0].text;
    expect(text).not.toContain("123-45-6789");
    expect(r.json().regulait.pii.action).toBe("block");
  });
});

// =========================================================================
// the OpenAI-shaped surface
// =========================================================================

describe("POST /v1/chat/completions — OpenAI-shaped translation shim", () => {
  it("an entitled user gets a correctly shaped Chat Completions response", async () => {
    const r = await app.inject({
      method: "POST",
      headers: devAuth,
      url: "/v1/chat/completions",
      payload: {
        model: "ide-premium",
        messages: [
          { role: "system", content: "You are terse." },
          { role: "user", content: "summarize the release notes" },
        ],
      },
    });
    expect(r.statusCode).toBe(200);
    const b = r.json();
    expect(b.object).toBe("chat.completion");
    expect(b.id.startsWith("chatcmpl-")).toBe(true);
    expect(typeof b.created).toBe("number");
    expect(b.model).toBe("ide-premium");
    expect(b.choices[0].index).toBe(0);
    expect(b.choices[0].message.role).toBe("assistant");
    expect(typeof b.choices[0].message.content).toBe("string");
    expect(b.choices[0].finish_reason).toBe("stop");
    expect(b.usage.prompt_tokens).toBeGreaterThan(0);
    expect(b.usage.completion_tokens).toBeGreaterThan(0);
    expect(b.usage.total_tokens).toBe(b.usage.prompt_tokens + b.usage.completion_tokens);
  });

  it("accepts max_completion_tokens as well as max_tokens", async () => {
    const r = await app.inject({
      method: "POST",
      headers: devAuth,
      url: "/v1/chat/completions",
      payload: openaiBody("ide-premium", "hi", { max_completion_tokens: 128 }),
    });
    expect(r.statusCode).toBe(200);
  });

  it("ACCEPTS temperature and discloses that it was not honoured", async () => {
    const r = await app.inject({
      method: "POST",
      headers: devAuth,
      url: "/v1/chat/completions",
      payload: openaiBody("ide-premium", "hi", { temperature: 0.2 }),
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().object).toBe("chat.completion");
    expect(r.headers["x-regulait-ignored-fields"]).toBe("temperature");
  });

  it("FAILS LOUDLY on an unsupported field, naming it", async () => {
    const r = await app.inject({
      method: "POST",
      headers: devAuth,
      url: "/v1/chat/completions",
      payload: openaiBody("ide-premium", "hi", { response_format: { type: "json_object" } }),
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.type).toBe("invalid_request_error");
    expect(r.json().error.message).toContain("response_format");
  });

  it("round-trips assistant tool_calls and a tool result turn", async () => {
    const r = await app.inject({
      method: "POST",
      headers: devAuth,
      url: "/v1/chat/completions",
      payload: {
        model: "ide-premium",
        messages: [
          { role: "user", content: "check the build" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              { id: "call_1", type: "function", function: { name: "ide_build", arguments: '{"target":"all"}' } },
            ],
          },
          { role: "tool", tool_call_id: "call_1", content: "build ok" },
        ],
      },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().choices[0].message.content).toContain("build ok");
  });

  it("emits tool_calls with finish_reason tool_calls when the model calls a tool", async () => {
    const r = await app.inject({
      method: "POST",
      headers: devAuth,
      url: "/v1/chat/completions",
      payload: openaiBody("ide-premium", "please <<use-tool:ide_lookup>> now", {
        tools: [
          {
            type: "function",
            function: { name: "ide_lookup", description: "look up", parameters: { type: "object" } },
          },
        ],
      }),
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().choices[0].finish_reason).toBe("tool_calls");
    expect(r.json().choices[0].message.tool_calls[0].function.name).toBe("ide_lookup");
  });

  it("streams chat.completion.chunk deltas terminated by data: [DONE]", async () => {
    const r = await app.inject({
      method: "POST",
      headers: devAuth,
      url: "/v1/chat/completions",
      payload: openaiBody("ide-premium", "write a paragraph about builds", { stream: true }),
    });
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toContain("text/event-stream");
    const lines = [...r.body.matchAll(/^data: (.+)$/gm)].map((m) => m[1]!);
    expect(lines[lines.length - 1]).toBe("[DONE]");
    const frames = lines.slice(0, -1).map((l) => JSON.parse(l));
    expect(frames.every((f) => f.object === "chat.completion.chunk")).toBe(true);
    expect(frames[0].choices[0].delta.role).toBe("assistant");
    expect(frames.some((f) => typeof f.choices[0].delta.content === "string" && f.choices[0].delta.content)).toBe(true);
    const last = frames[frames.length - 1];
    expect(last.choices[0].finish_reason).toBe("stop");
    expect(last.usage.total_tokens).toBeGreaterThan(0);
  });

  it("a block-mode PII project does not stream here either", async () => {
    const r = await app.inject({
      method: "POST",
      headers: { ...devAuth, [PROJECT_HEADER]: blockProject },
      url: "/v1/chat/completions",
      payload: openaiBody("ide-premium", "tell me a story", { stream: true }),
    });
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toContain("application/json");
    expect(r.json().regulait.streamingSuppressed).toBe(true);
  });
});

// =========================================================================
// THE governance invariants
// =========================================================================

describe("the compat surface creates NO privilege path", () => {
  it("an UNENTITLED user is 403 through /v1/messages, exactly as at /invoke", async () => {
    const compat = await app.inject({
      method: "POST",
      headers: strangerAuth,
      url: "/v1/messages",
      payload: anthropicBody("ide-premium"),
    });
    expect(compat.statusCode).toBe(403);
    expect(compat.json().error.type).toBe("permission_error");

    const invoke = await app.inject({
      method: "POST",
      headers: strangerAuth,
      url: `/v1/agents/${premiumAgentId}/invoke`,
      payload: { mode: "execute", input: "ide probe", dispatch: true },
    });
    expect(invoke.statusCode).toBe(403);
  });

  it("an UNENTITLED user is 403 through /v1/chat/completions too", async () => {
    const r = await app.inject({
      method: "POST",
      headers: strangerAuth,
      url: "/v1/chat/completions",
      payload: openaiBody("ide-premium"),
    });
    expect(r.statusCode).toBe(403);
  });

  it("the denial is audited against the resolved agent, not swallowed", async () => {
    const rows = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.userId, strangerId), eq(auditLog.objectId, premiumAgentId)));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((r) => r.effect === "deny")).toBe(true);
    expect(rows.some((r) => (r.detail as { surface?: string }).surface === "compat")).toBe(true);
  });

  it("a per-user REVOCATION denies through the compat surface as well", async () => {
    const rev = await app.inject({
      method: "POST",
      headers: AUTH,
      url: `/v1/users/${devId}/revocations/agents`,
      payload: { agentId: cheapAgentId, reason: "ide test" },
    });
    expect(rev.statusCode).toBe(201);
    const r = await app.inject({
      method: "POST",
      headers: devAuth,
      url: "/v1/messages",
      payload: anthropicBody("ide-cheap"),
    });
    expect(r.statusCode).toBe(403);
    await app.inject({
      method: "DELETE",
      headers: AUTH,
      url: `/v1/users/${devId}/revocations/agents/${rev.json().id}`,
    });
    const after = await app.inject({
      method: "POST",
      headers: devAuth,
      url: "/v1/messages",
      payload: anthropicBody("ide-cheap"),
    });
    expect(after.statusCode).toBe(200);
  });
});

describe("an unresolvable model is DEFAULT-DENY, never a pass-through", () => {
  it("an unmapped model string is 403 on the Anthropic surface", async () => {
    const r = await app.inject({
      method: "POST",
      headers: devAuth,
      url: "/v1/messages",
      payload: anthropicBody("gpt-9-turbo-does-not-exist"),
    });
    expect(r.statusCode).toBe(403);
    expect(r.json().error.regulait_code).toBe("model_not_mapped");
    expect(r.json().error.message).toContain("denied rather than forwarded");
  });

  it("an unmapped model string is 403 on the OpenAI surface", async () => {
    const r = await app.inject({
      method: "POST",
      headers: devAuth,
      url: "/v1/chat/completions",
      payload: openaiBody("gpt-9-turbo-does-not-exist"),
    });
    expect(r.statusCode).toBe(403);
    expect(r.json().error.regulait_code).toBe("model_not_mapped");
  });

  it("an unmapped model writes NO usage row — nothing reached a provider", async () => {
    const before = await db.select().from(usageEvents).where(eq(usageEvents.userId, devId));
    await app.inject({
      method: "POST",
      headers: devAuth,
      url: "/v1/messages",
      payload: anthropicBody("another-unmapped-model"),
    });
    const after = await db.select().from(usageEvents).where(eq(usageEvents.userId, devId));
    expect(after.length).toBe(before.length);
  });

  it("a bogus x-regulait-agent-id is 403, not a 404-shaped hint", async () => {
    const r = await app.inject({
      method: "POST",
      headers: { ...devAuth, [AGENT_HEADER]: "00000000-0000-0000-0000-0000000000ff" },
      url: "/v1/messages",
      payload: anthropicBody("ide-premium"),
    });
    expect(r.statusCode).toBe(403);
    expect(r.json().error.regulait_code).toBe("agent_not_resolvable");
  });
});

describe("model to agent resolution is an ADMIN CHOICE — all three modes ship", () => {
  it("map_by_model tie-breaks deterministically on lowest tier and discloses which it picked", async () => {
    await setPosture({ resolutionMode: "map_by_model" });
    const r = await app.inject({
      method: "POST",
      headers: devAuth,
      url: "/v1/messages",
      payload: anthropicBody("ide-dupe"),
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().regulait.servedAgentId).toBe(dupeLowId);
    expect(r.json().regulait.tieBreak.candidates).toBe(2);
    expect(r.json().regulait.tieBreak.picked).toBe("ide-dupe-low");
  });

  it("require_agent without the header is 400 naming the header", async () => {
    await setPosture({ resolutionMode: "require_agent" });
    const r = await app.inject({
      method: "POST",
      headers: devAuth,
      url: "/v1/messages",
      payload: anthropicBody("ide-premium"),
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.regulait_code).toBe("agent_header_required");
    expect(r.json().error.message).toContain(AGENT_HEADER);
  });

  it("require_agent WITH the header serves the named agent, model string advisory", async () => {
    const r = await app.inject({
      method: "POST",
      headers: { ...devAuth, [AGENT_HEADER]: cheapAgentId },
      url: "/v1/messages",
      // deliberately asks for the premium model; the header wins
      payload: anthropicBody("ide-premium"),
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().model).toBe("ide-cheap");
    expect(r.json().regulait.requestedModel).toBe("ide-premium");
    expect(r.json().regulait.servedAgentId).toBe(cheapAgentId);
  });

  it("router_decides may serve a different model — and ALWAYS discloses it", async () => {
    await setPosture({ resolutionMode: "router_decides" });
    const r = await app.inject({
      method: "POST",
      headers: devAuth,
      url: "/v1/messages",
      // a trivial request over a tier-3 agent: the pillar-6 router downroutes
      payload: anthropicBody("ide-premium", "hi"),
    });
    expect(r.statusCode).toBe(200);
    const b = r.json();
    expect(b.regulait.requestedModel).toBe("ide-premium");
    // whatever was served, the top-level `model` names it and never lies
    expect(b.model).toBe(b.regulait.servedModel);
    if (b.regulait.routerOverrode) {
      expect(b.regulait.servedModel).not.toBe("ide-premium");
      expect(r.headers["x-regulait-served-model"]).toBe(b.regulait.servedModel);
    }
    // routing lands in the SAME pillar-6 ledger the invoke path writes
    const rows = await db
      .select()
      .from(costEvents)
      .where(and(eq(costEvents.userId, devId), eq(costEvents.technique, "model_routing")));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((x) => (x.detail as { surface?: string }).surface === "compat")).toBe(true);

    // ... and the audit trail records requested-vs-served for that same call,
    // so a router override is legible in the log as well as in the response
    const audits = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.userId, devId), eq(auditLog.ruleId, "compat-dispatch")));
    const routed = audits.filter(
      (x) => (x.detail as { resolution?: { mode?: string } }).resolution?.mode === "router_decides",
    );
    expect(routed.length).toBeGreaterThan(0);
    for (const row of routed) {
      const res = (row.detail as { resolution?: { requestedModel?: string; servedModel?: string } })
        .resolution!;
      expect(res.requestedModel).toBeDefined();
      expect(res.servedModel).toBeDefined();
    }
  });

  it("router_decides still default-denies an unmapped model", async () => {
    const r = await app.inject({
      method: "POST",
      headers: devAuth,
      url: "/v1/messages",
      payload: anthropicBody("nope-not-a-model"),
    });
    expect(r.statusCode).toBe(403);
    expect(r.json().error.regulait_code).toBe("model_not_mapped");
    await setPosture({ resolutionMode: "map_by_model" });
  });
});

describe("pillar-5 attribution rides the compat surface", () => {
  it("an attributed call writes exactly ONE usage row that rolls into the project total", async () => {
    const before = await db.select().from(usageEvents).where(eq(usageEvents.projectId, plainProject));
    const r = await app.inject({
      method: "POST",
      headers: { ...devAuth, [PROJECT_HEADER]: plainProject },
      url: "/v1/messages",
      payload: anthropicBody("ide-premium", "attributed probe"),
    });
    expect(r.statusCode).toBe(200);
    const after = await db.select().from(usageEvents).where(eq(usageEvents.projectId, plainProject));
    expect(after.length).toBe(before.length + 1);
    const seen = new Set(before.map((x) => x.id));
    const row = after.find((x) => !seen.has(x.id))!;
    expect(row.agentId).toBe(premiumAgentId);
    expect((row.detail as { surface?: string }).surface).toBe("compat_anthropic");
    expect(row.costUsd).toBeGreaterThan(0);

    const costs = await app.inject({
      method: "GET",
      headers: AUTH,
      url: `/v1/projects/${plainProject}/costs`,
    });
    expect(costs.statusCode).toBe(200);
    expect(costs.json().measured.costUsd).toBeGreaterThan(0);
    // and it appears in the per-agent breakdown under the served agent
    expect(
      costs.json().byAgent.some((a: { agentId: string }) => a.agentId === premiumAgentId),
    ).toBe(true);
  });

  it("a project the caller may not bill to is refused", async () => {
    const r = await app.inject({
      method: "POST",
      headers: { ...strangerAuth, [PROJECT_HEADER]: plainProject },
      url: "/v1/messages",
      payload: anthropicBody("ide-premium"),
    });
    expect(r.statusCode).toBe(403);
    expect(r.json().error.regulait_code).toBe("not_a_project_member");
  });

  it("require_project_attribution REJECTS an unattributed call", async () => {
    await setPosture({ requireProjectAttribution: true });
    const bare = await app.inject({
      method: "POST",
      headers: devAuth,
      url: "/v1/messages",
      payload: anthropicBody("ide-premium"),
    });
    expect(bare.statusCode).toBe(400);
    expect(bare.json().error.regulait_code).toBe("project_attribution_required");

    const bareOpenAi = await app.inject({
      method: "POST",
      headers: devAuth,
      url: "/v1/chat/completions",
      payload: openaiBody("ide-premium"),
    });
    expect(bareOpenAi.statusCode).toBe(400);

    // ... and an attributed one still succeeds
    const attributed = await app.inject({
      method: "POST",
      headers: { ...devAuth, [PROJECT_HEADER]: plainProject },
      url: "/v1/messages",
      payload: anthropicBody("ide-premium"),
    });
    expect(attributed.statusCode).toBe(200);
    await setPosture({ requireProjectAttribution: false });
  });
});

describe("turning a surface off takes it away again", () => {
  it("disabling the OpenAI surface 404s it while the Anthropic one keeps working", async () => {
    await setPosture({ openaiCompatEnabled: false });
    const off = await app.inject({
      method: "POST",
      headers: devAuth,
      url: "/v1/chat/completions",
      payload: openaiBody("ide-premium"),
    });
    expect(off.statusCode).toBe(404);
    const on = await app.inject({
      method: "POST",
      headers: devAuth,
      url: "/v1/messages",
      payload: anthropicBody("ide-premium"),
    });
    expect(on.statusCode).toBe(200);
    await setPosture({ openaiCompatEnabled: true });
  });

  it("mcp_interception_enabled=false 404s the MCP proxy the same way", async () => {
    await setPosture({ mcpInterceptionEnabled: false });
    const r = await app.inject({
      method: "POST",
      headers: devAuth,
      url: "/mcp/00000000-0000-0000-0000-000000000001",
      payload: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    });
    expect(r.statusCode).toBe(404);
    expect(r.json().error).toBe("Not Found");
    await setPosture({ mcpInterceptionEnabled: true });
  });
});
