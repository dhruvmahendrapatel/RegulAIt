import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDb, eq, interceptionSettings, INTERCEPTION_SETTINGS_ID, runMigrations, type Db } from "@regulait/db";
import { buildApp } from "./app.js";
import { reshapeCompat401 } from "./compat-auth-errors.js";

/**
 * ADR-0288 — provider-shaped 401s on the compat surfaces.
 *
 * Claims:
 *  1. A refused credential on `/v1/chat/completions` reads as an OpenAI error
 *     envelope, on `/v1/messages` as an Anthropic one, and on `/v1/models` as
 *     whichever dialect the request speaks (the `anthropic-version` header).
 *  2. The RegulAIt refusal code survives (`regulait_code`), and a refusal's own
 *     detail becomes the message.
 *  3. Nothing else changes: a non-compat route keeps RegulAIt's body, the MCP
 *     route keeps its body and its RFC 9728 challenge, and a valid key still
 *     authenticates (the auth hook itself is untouched).
 */

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const BOOT = "c401-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
const BAD = { authorization: "Bearer rgl_not-a-real-key" };

let db: Db;
let app: ReturnType<typeof buildApp>;

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "c".repeat(64) });
  const s = await app.inject({
    method: "PUT",
    headers: AUTH,
    url: "/v1/interception/settings",
    payload: { anthropicCompatEnabled: true, openaiCompatEnabled: true, mcpInterceptionEnabled: true },
  });
  expect(s.statusCode).toBe(200);
});

afterAll(async () => {
  await db
    .update(interceptionSettings)
    .set({ anthropicCompatEnabled: false, openaiCompatEnabled: false, mcpInterceptionEnabled: false })
    .where(eq(interceptionSettings.id, INTERCEPTION_SETTINGS_ID));
  app.server.closeAllConnections();
  await app.close();
});

describe("reshapeCompat401 (pure)", () => {
  it("envelopes a RegulAIt refusal in the OpenAI dialect, keeping the code", () => {
    const out = JSON.parse(reshapeCompat401(JSON.stringify({ error: "unauthenticated" }), "openai")!);
    expect(out.error.type).toBe("authentication_error");
    expect(out.error.code).toBe("unauthenticated");
    expect(out.error.regulait_code).toBe("unauthenticated");
    expect(out.error.message).toMatch(/API key/);
  });

  it("envelopes in the Anthropic dialect and uses the refusal's own detail as the message", () => {
    const out = JSON.parse(
      reshapeCompat401(JSON.stringify({ error: "api_key_expired", detail: "this API key has expired" }), "anthropic")!,
    );
    expect(out).toEqual({
      type: "error",
      error: { type: "authentication_error", message: "this API key has expired", regulait_code: "api_key_expired" },
    });
  });

  it("passes through anything that is not a RegulAIt refusal", () => {
    expect(reshapeCompat401("not json", "openai")).toBeNull();
    expect(reshapeCompat401(JSON.stringify({ error: { message: "already shaped" } }), "openai")).toBeNull();
    expect(reshapeCompat401(JSON.stringify([1]), "openai")).toBeNull();
    expect(reshapeCompat401(Buffer.from("{}"), "openai")).toBeNull();
  });
});

describe("compat routes answer a bad credential in their own dialect", () => {
  it("POST /v1/chat/completions -> OpenAI envelope", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: BAD,
      payload: { model: "x", messages: [{ role: "user", content: "hi" }] },
    });
    expect(r.statusCode).toBe(401);
    const b = r.json();
    expect(b.error.type).toBe("authentication_error");
    expect(b.error.regulait_code).toBe("unauthenticated");
    expect(typeof b.error.message).toBe("string");
    expect(Number(r.headers["content-length"])).toBe(Buffer.byteLength(r.body));
  });

  it("POST /v1/responses (ADR-0287) -> OpenAI envelope", async () => {
    const r = await app.inject({ method: "POST", url: "/v1/responses", headers: BAD, payload: { model: "x", input: "hi", store: false } });
    expect(r.statusCode).toBe(401);
    expect(r.json().error.type).toBe("authentication_error");
    expect(r.json().error.regulait_code).toBe("unauthenticated");
  });

  it("POST /v1/chat/completions with no credential at all -> OpenAI envelope", async () => {
    const r = await app.inject({ method: "POST", url: "/v1/chat/completions", payload: { model: "x", messages: [] } });
    expect(r.statusCode).toBe(401);
    expect(r.json().error.type).toBe("authentication_error");
  });

  it("POST /v1/messages (key in x-api-key) -> Anthropic envelope", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { "x-api-key": "rgl_not-a-real-key", "anthropic-version": "2023-06-01" },
      payload: { model: "x", max_tokens: 8, messages: [{ role: "user", content: "hi" }] },
    });
    expect(r.statusCode).toBe(401);
    const b = r.json();
    expect(b.type).toBe("error");
    expect(b.error.type).toBe("authentication_error");
    expect(b.error.regulait_code).toBe("unauthenticated");
  });

  it("GET /v1/models picks the dialect by anthropic-version", async () => {
    const oa = await app.inject({ method: "GET", url: "/v1/models", headers: BAD });
    expect(oa.statusCode).toBe(401);
    expect(oa.json().error.type).toBe("authentication_error");
    expect(oa.json().type).toBeUndefined();
    const an = await app.inject({ method: "GET", url: "/v1/models", headers: { ...BAD, "anthropic-version": "2023-06-01" } });
    expect(an.statusCode).toBe(401);
    expect(an.json().type).toBe("error");
  });
});

describe("nothing outside the compat surfaces changes", () => {
  it("a non-compat route keeps RegulAIt's own refusal body", async () => {
    const r = await app.inject({ method: "GET", url: "/v1/me", headers: BAD });
    expect(r.statusCode).toBe(401);
    expect(r.json()).toEqual({ error: "unauthenticated" });
  });

  it("the MCP route keeps its body and its RFC 9728 challenge", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/mcp/00000000-0000-4000-8000-000000000000",
      headers: BAD,
      payload: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    });
    expect(r.statusCode).toBe(401);
    expect(typeof r.json().error).toBe("string");
    expect(r.headers["www-authenticate"]).toBeDefined();
  });

  it("the auth hook still authenticates a valid credential on a compat route (no 401)", async () => {
    const r = await app.inject({ method: "GET", url: "/v1/models", headers: AUTH });
    expect(r.statusCode).not.toBe(401);
  });
});
