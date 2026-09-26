import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  and,
  costEvents,
  createDb,
  eq,
  runMigrations,
  usageEvents,
  type Db,
} from "@regulait/db";
import { buildApp } from "./app.js";
import { AGENT_HEADER } from "./compat-core.js";

/**
 * ADR-0119 — THE SEMANTIC CACHE ON THE COMPAT / IDE PATH.
 *
 * THE LOAD-BEARING EVIDENCE IS "NO PROVIDER CALL", not "the answer matched".
 * Two identical requests return the same text whether or not a cache exists,
 * so asserting equality proves nothing. Every hit assertion below is paired
 * with a `usage_events` delta of ZERO — measured spend is what distinguishes a
 * cache hit from a fast model — and every MISS assertion is paired with a
 * delta of one, so "no new usage row" can never be the zero of a request that
 * failed for an unrelated reason (M-033).
 *
 * Fixtures are resolved by ids created here, and the compat calls NAME their
 * agent rather than relying on the model string, which in a shared database
 * resolves to whatever another file happened to register (M-037).
 */

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

const RUN = Math.random().toString(36).slice(2, 8);
const BOOT = `adr0119-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };

let db: Db;
let app: ReturnType<typeof buildApp>;
let userA: string;
let authA: { authorization: string };
let userB: string;
let authB: { authorization: string };
let agentId: string;

const usageCount = async (userId: string) =>
  (await db.select().from(usageEvents).where(eq(usageEvents.userId, userId))).length;

const cacheSavingsCount = async (userId: string) =>
  (
    await db
      .select()
      .from(costEvents)
      .where(and(eq(costEvents.userId, userId), eq(costEvents.technique, "semantic_caching")))
  ).length;

async function setPolicy(policy: "off" | "opt_in" | "always") {
  const r = await app.inject({
    method: "PUT",
    url: "/v1/org/settings",
    headers: AUTH,
    payload: { semanticCachePolicy: policy },
  });
  expect(r.statusCode).toBe(200);
}

/** One Anthropic-shaped call, naming the agent so resolution is unambiguous. */
function ask(auth: { authorization: string }, text: string, extra: Record<string, unknown> = {}) {
  return app.inject({
    method: "POST",
    url: "/v1/messages",
    headers: { ...auth, [AGENT_HEADER]: agentId },
    payload: {
      model: `adr0119-model-${RUN}`,
      max_tokens: 64,
      messages: [{ role: "user", content: text }],
      ...extra,
    },
  });
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "e".repeat(64) });

  const mk = async (tag: string) => {
    const u = await app.inject({
      method: "POST",
      url: "/v1/users",
      headers: AUTH,
      payload: { email: `adr0119-${tag}-${RUN}@example.com`, displayName: `ADR119 ${tag}` },
    });
    const id = u.json().id;
    const k = await app.inject({
      method: "POST",
      url: `/v1/users/${id}/keys`,
      headers: AUTH,
      payload: { name: `adr0119-${tag}` },
    });
    return { id, auth: { authorization: `Bearer ${k.json().token}` } };
  };
  const a = await mk("a");
  userA = a.id;
  authA = a.auth;
  const b = await mk("b");
  userB = b.id;
  authB = b.auth;

  // ADR-0020 ships both compat surfaces OFF — turn the Anthropic one on, since
  // this file is entirely about that surface.
  const ic = await app.inject({
    method: "PUT",
    url: "/v1/interception/settings",
    headers: AUTH,
    payload: { anthropicCompatEnabled: true },
  });
  expect(ic.statusCode).toBe(200);

  const ag = await app.inject({
    method: "POST",
    url: "/v1/agents",
    headers: AUTH,
    payload: {
      name: `adr0119-mock-${RUN}`,
      provider: "mock",
      tier: 1,
      costPerMTokIn: 3,
      costPerMTokOut: 15,
      model: `adr0119-model-${RUN}`,
    },
  });
  agentId = ag.json().id;
  for (const uid of [userA, userB]) {
    await app.inject({
      method: "POST",
      url: "/v1/grants/agents",
      headers: AUTH,
      payload: { userId: uid, agentId },
    });
  }
});

afterAll(async () => {
  await setPolicy("opt_in");
  await app.close();
});

describe("the technique the IDE path was missing", () => {
  it("a repeat question is served from cache — no provider call, and the saving is recorded", async () => {
    await setPolicy("always");
    const prompt = `what does adr0119-${RUN} do`;

    const beforeUsage = await usageCount(userA);
    const beforeSavings = await cacheSavingsCount(userA);

    const first = await ask(authA, prompt);
    expect(first.statusCode).toBe(200);
    // MISS: exactly one new usage row — the provider really was called, which
    // is what makes the zero below meaningful rather than incidental.
    expect(await usageCount(userA)).toBe(beforeUsage + 1);
    expect(await cacheSavingsCount(userA)).toBe(beforeSavings);

    const second = await ask(authA, prompt);
    expect(second.statusCode).toBe(200);
    // HIT: no NEW usage row at all, and one savings row
    expect(await usageCount(userA)).toBe(beforeUsage + 1);
    expect(await cacheSavingsCount(userA)).toBe(beforeSavings + 1);

    // and the wire contract is untouched — an IDE cannot tell a hit from a
    // very fast model
    const body = second.json();
    expect(body.type).toBe("message");
    expect(body.role).toBe("assistant");
    expect(Array.isArray(body.content)).toBe(true);
    expect(body.content[0].text).toBe(first.json().content[0].text);
  });

  it("normalisation means casing and whitespace still hit", async () => {
    await setPolicy("always");
    const prompt = `normalised question ${RUN}`;
    await ask(authA, prompt);

    const beforeUsage = await usageCount(userA);
    const res = await ask(authA, `   ${prompt.toUpperCase()}   `);
    expect(res.statusCode).toBe(200);
    expect(await usageCount(userA)).toBe(beforeUsage);
  });
});

describe("the governance boundary the shared module exists to protect", () => {
  it("one user's cached answer is NEVER served to another", async () => {
    await setPolicy("always");
    const prompt = `cross user secret ${RUN}`;

    await ask(authA, prompt);
    // prove A is now cached, so B's miss below is about SCOPE and not about an
    // empty cache
    const aUsage = await usageCount(userA);
    await ask(authA, prompt);
    expect(await usageCount(userA)).toBe(aUsage);

    const beforeB = await usageCount(userB);
    const res = await ask(authB, prompt);
    expect(res.statusCode).toBe(200);
    // B paid for a real provider call — it did not read A's row
    expect(await usageCount(userB)).toBe(beforeB + 1);
  });
});

describe("what this surface deliberately does NOT do", () => {
  it("`opt_in` cannot engage here — the vendor wire format has no opt-in field", async () => {
    await setPolicy("opt_in");
    const prompt = `opt in question ${RUN}`;

    await ask(authA, prompt);
    const afterFirst = await usageCount(userA);
    await ask(authA, prompt);
    // still billed: under opt_in this surface behaves exactly as it did before
    expect(await usageCount(userA)).toBe(afterFirst + 1);

    // positive control on the SAME prompt: under `always` it does hit, so the
    // assertion above is about the policy and not about an unrelated failure
    await setPolicy("always");
    await ask(authA, prompt);
    const primed = await usageCount(userA);
    await ask(authA, prompt);
    expect(await usageCount(userA)).toBe(primed);
  });

  it("a tool-bearing turn is never cached", async () => {
    await setPolicy("always");
    const prompt = `tool question ${RUN}`;
    const tools = [
      {
        name: "lookup",
        description: "look something up",
        input_schema: { type: "object", properties: {} },
      },
    ];

    const first = await ask(authA, prompt, { tools });
    expect(first.statusCode).toBe(200);
    const afterFirst = await usageCount(userA);

    const second = await ask(authA, prompt, { tools });
    expect(second.statusCode).toBe(200);
    // billed again: the answer to a tool-bearing turn is not a pure function
    // of the prompt, so serving a previous one would be wrong, not just stale
    expect(await usageCount(userA)).toBe(afterFirst + 1);
  });

  it("`off` disables it entirely", async () => {
    await setPolicy("off");
    const prompt = `disabled question ${RUN}`;
    await ask(authA, prompt);
    const afterFirst = await usageCount(userA);
    await ask(authA, prompt);
    expect(await usageCount(userA)).toBe(afterFirst + 1);
  });
});
