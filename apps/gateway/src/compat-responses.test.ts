import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  and,
  auditLog,
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
import { relaxGovernanceGatesForTest } from "./testing/governance-gates.js";
import { relaxDataPostureForTest } from "./testing/strict-data-posture.js";

/**
 * ADR-0287 — `POST /v1/responses`, the OpenAI Responses compatibility shim.
 *
 * The claims under test:
 *  1. The surface rides the OpenAI switch: off -> the indistinguishable 404;
 *     on -> a governed dispatch (allow for a granted model, deny for an
 *     ungranted one) with the Responses envelope, cost attribution on the
 *     usage ledger and an audit row tagged `compat_openai_responses`.
 *  2. Streaming speaks the Responses event dialect (created, deltas,
 *     completed) and a denial before the first byte is a real HTTP error.
 *  3. Tool calls round-trip statelessly: a function_call output item, sent
 *     back with its function_call_output, dispatches as one tool loop.
 *  4. Stateful or ungovernable fields are a 400 naming them:
 *     previous_response_id, store:true, built-in tools, unknown include values.
 *
 * Shares one database with the other gateway suites, so objects are
 * name-prefixed crs-.
 */

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");

const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const BOOT = "crs-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
const DATA_KEY = "e".repeat(64);

let db: Db;
let app: ReturnType<typeof buildApp>;
let devId: string;
let devAuth: { authorization: string };
let mockAgentId: string;

const TOOLS = [
  { type: "function", name: "crs_lookup", description: "look up", parameters: { type: "object", properties: {} } },
];

const post = (payload: Record<string, unknown>, headers: Record<string, string> = devAuth) =>
  app.inject({ method: "POST", url: "/v1/responses", headers, payload });

async function mkAgent(name: string, model: string) {
  const r = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/agents",
    payload: { name, provider: "mock", tier: 1, model, costPerMTokIn: 1, costPerMTokOut: 2 },
  });
  expect(r.statusCode).toBe(201);
  return r.json().id as string;
}

async function setOpenAi(enabled: boolean) {
  const s = await app.inject({
    method: "PUT",
    headers: AUTH,
    url: "/v1/interception/settings",
    payload: { openaiCompatEnabled: enabled },
  });
  expect(s.statusCode).toBe(200);
}

let restorePosture: (() => Promise<void>) | undefined;
let restoreGates: () => Promise<void> = async () => {};
beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restorePosture = await relaxDataPostureForTest(db, {
    org: { defaultPiiMode: "none" },
    interception: { strictFieldRejection: false },
    guardrails: false,
  });
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });
  restoreGates = await relaxGovernanceGatesForTest(db, {
    mrmEnforced: false,
    dispatchAttributionRequired: false,
    requireProjectAttribution: false,
  });
  const u = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/users",
    payload: { email: "crs-dev@example.com", displayName: "crs-dev" },
  });
  devId = u.json().id;
  const k = await app.inject({ method: "POST", headers: AUTH, url: `/v1/users/${devId}/keys`, payload: { name: "crs" } });
  devAuth = { authorization: `Bearer ${k.json().token}` };
  mockAgentId = await mkAgent("crs-mock", "crs-mock");
  await mkAgent("crs-ungranted", "crs-ungranted");
  const g = await app.inject({ method: "POST", headers: AUTH, url: "/v1/grants/agents", payload: { userId: devId, agentId: mockAgentId } });
  expect(g.statusCode).toBe(201);
});

afterAll(async () => {
  await restorePosture?.();
  await db
    .update(interceptionSettings)
    .set({ openaiCompatEnabled: false })
    .where(eq(interceptionSettings.id, INTERCEPTION_SETTINGS_ID));
  app.server.closeAllConnections();
  await restoreGates();
  await app.close();
});

describe("the surface rides the OpenAI-compatible switch", () => {
  it("is the indistinguishable 404 while openaiCompatEnabled is off", async () => {
    await setOpenAi(false);
    const r = await post({ model: "crs-mock", input: "hi" });
    expect(r.statusCode).toBe(404);
    expect(r.json()).toEqual({ message: "Route POST:/v1/responses not found", error: "Not Found", statusCode: 404 });
  });
});

describe("governed dispatch in the Responses envelope", () => {
  beforeAll(async () => {
    await setOpenAi(true);
  });

  it("allows a granted model: Responses envelope, cost on the ledger, audit tagged compat_openai_responses", async () => {
    const r = await post({ model: "crs-mock", instructions: "be terse", input: "crs allow probe", store: false });
    expect(r.statusCode).toBe(200);
    const b = r.json();
    expect(b.object).toBe("response");
    expect(b.id).toMatch(/^resp_[0-9a-f]{32}$/);
    expect(b.status).toBe("completed");
    expect(b.store).toBe(false);
    expect(b.model).toBe("crs-mock");
    const msg = b.output.find((o: { type: string }) => o.type === "message");
    expect(msg.role).toBe("assistant");
    expect(msg.content[0].type).toBe("output_text");
    expect(typeof msg.content[0].text).toBe("string");
    expect(b.usage.total_tokens).toBe(b.usage.input_tokens + b.usage.output_tokens);
    expect(b.regulait.servedAgentId).toBe(mockAgentId);

    const [ev] = await db
      .select()
      .from(usageEvents)
      .where(eq(usageEvents.userId, devId))
      .orderBy(desc(usageEvents.at))
      .limit(1);
    expect(ev?.agentId).toBe(mockAgentId);
    expect(Number(ev?.costUsd ?? 0)).toBeGreaterThan(0);

    const [a] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.userId, devId), eq(auditLog.ruleId, "compat-dispatch")))
      .orderBy(desc(auditLog.at))
      .limit(1);
    expect((a?.detail as { surface?: string }).surface).toBe("compat_openai_responses");
    expect(a?.effect).toBe("allow");
  });

  it("denies an ungranted model with an OpenAI-shaped 403", async () => {
    const r = await post({ model: "crs-ungranted", input: "crs deny probe" });
    expect(r.statusCode).toBe(403);
    expect(r.json().error.type).toBe("permission_error");
  });

  it("streams in the Responses event dialect", async () => {
    const r = await post({ model: "crs-mock", input: "crs stream probe", stream: true });
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toContain("text/event-stream");
    const events = r.body
      .split("\n\n")
      .filter((f) => f.startsWith("event: "))
      .map((f) => {
        const [ev, data] = f.split("\n");
        return { event: ev!.slice(7), data: JSON.parse(data!.slice(6)) as Record<string, unknown> };
      });
    const types = events.map((e) => e.event);
    expect(types[0]).toBe("response.created");
    expect(types).toContain("response.output_text.delta");
    expect(types[types.length - 1]).toBe("response.completed");
    for (const e of events) expect(e.data["type"]).toBe(e.event);
    const seqs = events.map((e) => e.data["sequence_number"] as number);
    expect(seqs).toEqual(seqs.map((_, i) => i));
    const deltas = events.filter((e) => e.event === "response.output_text.delta").map((e) => e.data["delta"]).join("");
    const done = events.find((e) => e.event === "response.output_text.done")!.data["text"];
    expect(deltas).toBe(done);
  });

  it("a streamed request that is denied before the first byte is a real HTTP error", async () => {
    const r = await post({ model: "crs-ungranted", input: "crs stream deny", stream: true });
    expect(r.statusCode).toBe(403);
    expect(r.json().error.type).toBe("permission_error");
  });

  it("round-trips a tool call statelessly: function_call out, function_call_output back in", async () => {
    const first = await post({ model: "crs-mock", input: "crs please <<use-tool:crs_lookup>>", tools: TOOLS, tool_choice: "auto" });
    expect(first.statusCode).toBe(200);
    const call = first.json().output.find((o: { type: string }) => o.type === "function_call");
    expect(call).toBeTruthy();
    expect(call.name).toBe("crs_lookup");
    expect(call.id).toMatch(/^fc_/);
    expect(typeof call.call_id).toBe("string");
    expect(() => JSON.parse(call.arguments)).not.toThrow();

    const second = await post({
      model: "crs-mock",
      input: [
        { role: "user", content: [{ type: "input_text", text: "crs please <<use-tool:crs_lookup>>" }] },
        ...first.json().output,
        { type: "function_call_output", call_id: call.call_id, output: "record: crs" },
      ],
      tools: TOOLS,
      store: false,
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().status).toBe("completed");
  });

  it("forces a named function with tool_choice {type:'function', name}", async () => {
    const r = await post({ model: "crs-mock", input: "just answer", tools: TOOLS, tool_choice: { type: "function", name: "crs_lookup" } });
    expect(r.statusCode).toBe(200);
    expect(r.json().output.some((o: { type: string; name?: string }) => o.type === "function_call" && o.name === "crs_lookup")).toBe(true);
  });

  it("honours text.format json_object on a provider with a native mechanism", async () => {
    const r = await post({ model: "crs-mock", input: "give json", text: { format: { type: "json_object" } } });
    expect(r.statusCode).toBe(200);
  });
});

describe("stateful or ungovernable fields are a 400 naming them", () => {
  beforeAll(async () => {
    await setOpenAi(true);
  });

  const cases: Array<[string, Record<string, unknown>, string]> = [
    ["previous_response_id", { previous_response_id: "resp_x" }, "previous_response_id"],
    ["store: true", { store: true }, "store"],
    ["a built-in tool", { tools: [{ type: "web_search" }] }, "web_search"],
    ["an unknown include value", { include: ["file_search_call.results"] }, "file_search_call.results"],
    ["a reasoning input item", { input: [{ type: "reasoning", id: "rs_1", summary: [] }] }, "reasoning"],
    ["a remote image URL", { input: [{ role: "user", content: [{ type: "input_image", image_url: "https://x.test/a.png" }] }] }, "image_url"],
    ["text.verbosity", { text: { verbosity: "low" } }, "verbosity"],
    ["a tool_choice naming an undeclared tool", { tools: TOOLS, tool_choice: { type: "function", name: "nope" } }, "nope"],
  ];
  for (const [label, extra, needle] of cases) {
    it(label, async () => {
      const r = await post({ model: "crs-mock", input: "hi", ...extra });
      expect(r.statusCode).toBe(400);
      expect(r.json().error.type).toBe("invalid_request_error");
      expect(r.json().error.message).toContain(needle);
    });
  }

  it("include reasoning.encrypted_content is accepted (no reasoning items are emitted, so nothing to include)", async () => {
    const r = await post({ model: "crs-mock", input: "hi", include: ["reasoning.encrypted_content"] });
    expect(r.statusCode).toBe(200);
    expect(r.json().output.every((o: { type: string }) => o.type !== "reasoning")).toBe(true);
  });
});
