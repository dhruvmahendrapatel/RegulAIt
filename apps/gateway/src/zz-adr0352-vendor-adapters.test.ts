/**
 * ADR-0352 (lane E33, slice 1): the five native vendor adapters ride the one governed
 * dispatch core. A fake Bedrock endpoint on loopback stands in for AWS; the test
 * asserts the parts the lane brief names: entitlement (no grant, no call), SigV4 on
 * the wire with the stored credential, cost attribution (a priced usage row) and
 * audit, plus store-time validation that never echoes a secret.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, auditLog, createDb, eq, modelCredentials, runMigrations, usageEvents, type Db } from "@regulait/db";
import { MODEL_PROVIDER_KINDS } from "@regulait/model-provider";
import { ENV_FALLBACK_MODEL_PROVIDERS, VENDOR_MODEL_PROVIDERS } from "@regulait/shared";
import { buildApp } from "./app.js";
import { removeEgressAllowEntry } from "./testing/egress-allow-cleanup.js";
import { relaxGovernanceGatesForTest } from "./testing/governance-gates.js";
import { relaxStepUpAround } from "./testing/step-up-posture.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const BOOT = "adr0352-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
const DATA_KEY = "c".repeat(64);
// synthetic, never a real key (ADR-0184: obviously fake, low entropy)
const SECRET = "synthetic-never-echoed-secret-access-key-adr0352";

let db: Db;
let app: ReturnType<typeof buildApp>;
let server: Server;
let base: string;
let allowId: string | undefined;
let restoreGates: () => Promise<void> = async () => {};
let agentId: string;
let granted: { id: string; auth: { authorization: string } };
let ungranted: { id: string; auth: { authorization: string } };
const wire: Array<{ path: string; authorization: string | undefined; body: string }> = [];

async function user(email: string): Promise<{ id: string; auth: { authorization: string } }> {
  const u = await app.inject({ method: "POST", headers: AUTH, url: "/v1/users", payload: { email, displayName: email } });
  expect(u.statusCode).toBe(201);
  const k = await app.inject({ method: "POST", headers: AUTH, url: `/v1/users/${u.json().id}/keys`, payload: { name: "t" } });
  expect(k.statusCode).toBe(201);
  return { id: u.json().id, auth: { authorization: `Bearer ${k.json().token}` } };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let b = "";
    req.on("data", (c: Buffer) => (b += c.toString("utf8")));
    req.on("end", () => resolve(b));
  });
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });
  restoreGates = await relaxGovernanceGatesForTest(db);

  server = createServer(async (req, res) => {
    const body = await readBody(req);
    wire.push({ path: req.url ?? "", authorization: req.headers.authorization, body });
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        output: { message: { role: "assistant", content: [{ text: "governed hello" }] } },
        stopReason: "end_turn",
        usage: { inputTokens: 1000, outputTokens: 500, totalTokens: 1500 },
      }),
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  // the egress guard is default-deny: an air-gapped operator allow-lists the private endpoint
  const allowed = await relaxStepUpAround(db, () =>
    app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/egress-allow-hosts",
      payload: { host: "127.0.0.1", allowPrivateRanges: true, allowPlaintextHttp: true, note: "adr0352: fake bedrock endpoint" },
    }),
  );
  expect(allowed.statusCode).toBe(201);
  allowId = allowed.json().id;

  granted = await user("adr0352-granted@example.com");
  ungranted = await user("adr0352-ungranted@example.com");
  const agent = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/agents",
    payload: {
      name: "adr0352-bedrock",
      provider: "bedrock",
      tier: 1,
      costPerMTokIn: 3,
      costPerMTokOut: 15,
      model: "anthropic.claude-sonnet-4-5-v1:0",
    },
  });
  expect(agent.statusCode).toBe(201);
  agentId = agent.json().id;
  const g = await app.inject({ method: "POST", headers: AUTH, url: "/v1/grants/agents", payload: { userId: granted.id, agentId } });
  expect(g.statusCode).toBeLessThan(300);
});

afterAll(async () => {
  const allow = await removeEgressAllowEntry(app, AUTH, { id: allowId });
  try {
    await db.delete(modelCredentials).where(eq(modelCredentials.provider, "bedrock"));
    await restoreGates();
    await new Promise<void>((r) => server.close(() => r()));
  } finally {
    allow.assertRemoved();
  }
});

describe("ADR-0352 vocabulary", () => {
  it("the shared vendor list is exactly the package's vendor kinds", () => {
    const nonVendor = new Set(["custom", "regulait_llm", "mock"]);
    expect([...VENDOR_MODEL_PROVIDERS].sort()).toEqual(MODEL_PROVIDER_KINDS.filter((k) => !nonVendor.has(k)).sort());
    for (const k of ENV_FALLBACK_MODEL_PROVIDERS) expect(VENDOR_MODEL_PROVIDERS).toContain(k);
    expect(ENV_FALLBACK_MODEL_PROVIDERS).not.toContain("bedrock");
    expect(ENV_FALLBACK_MODEL_PROVIDERS).not.toContain("vertex");
  });
});

describe("ADR-0352 store-time validation", () => {
  it("refuses a malformed Bedrock secret and a missing baseUrl, without echoing the secret", async () => {
    const bad = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/model-credentials",
      payload: { provider: "bedrock", apiKey: JSON.stringify({ accessKeyId: "AKIAADR0352ONLY" }), baseUrl: base },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe("invalid_credential");
    expect(bad.body).not.toContain("AKIAADR0352ONLY");

    const noBase = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/model-credentials",
      payload: { provider: "bedrock", apiKey: "bedrock-api-key" },
    });
    expect(noBase.statusCode).toBe(400);
    expect(noBase.json().detail).toMatch(/requires a baseUrl/);

    const userBad = await app.inject({
      method: "POST",
      headers: granted.auth,
      url: `/v1/users/${granted.id}/model-credentials`,
      payload: { provider: "vertex", apiKey: JSON.stringify({ type: "authorized_user" }) },
    });
    expect(userBad.statusCode).toBe(400);
    expect(userBad.json().error).toBe("invalid_credential");
  });
});

describe("ADR-0352 Bedrock through the governed dispatch core", () => {
  it("stores the SigV4 credential encrypted, denies the ungranted user, and serves, prices and audits the granted one", async () => {
    const stored = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/model-credentials",
      payload: {
        provider: "bedrock",
        apiKey: JSON.stringify({ accessKeyId: "AKIDADR0352", secretAccessKey: SECRET, region: "eu-west-1" }),
        baseUrl: base,
      },
    });
    expect(stored.statusCode).toBe(201);
    expect(stored.body).not.toContain(SECRET);
    const [row] = await db.select().from(modelCredentials).where(eq(modelCredentials.provider, "bedrock"));
    expect(row!.keyCiphertext).not.toContain(SECRET);

    // entitlement first: no grant, no vendor call
    const before = wire.length;
    const denied = await app.inject({
      method: "POST",
      headers: ungranted.auth,
      url: `/v1/agents/${agentId}/invoke`,
      payload: { mode: "chat", input: "hello", dispatch: true },
    });
    expect(denied.statusCode).toBe(403);
    expect(wire.length).toBe(before);

    const ok = await app.inject({
      method: "POST",
      headers: granted.auth,
      url: `/v1/agents/${agentId}/invoke`,
      payload: { mode: "chat", input: "hello", dispatch: true },
    });
    expect(ok.statusCode).toBe(200);
    expect(JSON.stringify(ok.json())).toContain("governed hello");

    const call = wire.at(-1)!;
    expect(call.path).toBe(`/model/${encodeURIComponent("anthropic.claude-sonnet-4-5-v1:0")}/converse`);
    expect(call.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDADR0352\/\d{8}\/eu-west-1\/bedrock\/aws4_request/);
    expect(call.body).toContain("hello");

    // cost attribution: the measured tokens, priced from the agent row
    const usage = await db
      .select()
      .from(usageEvents)
      .where(and(eq(usageEvents.agentId, agentId), eq(usageEvents.userId, granted.id)));
    expect(usage.length).toBe(1);
    expect(usage[0]).toMatchObject({ provider: "bedrock", inputTokens: 1000, outputTokens: 500 });
    expect(usage[0]!.costUsd).toBeCloseTo((1000 * 3 + 500 * 15) / 1_000_000, 10);

    // audit: one allow row for the granted dispatch, and the denial on record
    const audits = await db.select().from(auditLog).where(eq(auditLog.objectId, agentId));
    expect(audits.some((a) => a.userId === granted.id && a.effect === "allow")).toBe(true);
    expect(audits.some((a) => a.userId === ungranted.id && a.effect === "deny")).toBe(true);
    expect(JSON.stringify(audits)).not.toContain(SECRET);
  });
});
