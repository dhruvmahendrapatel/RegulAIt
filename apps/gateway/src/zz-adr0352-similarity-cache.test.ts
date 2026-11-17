/**
 * ADR-0352 (lane E33 slice 2): the meaning-based cache tier.
 *
 * A stand-in for the trained-detectors `/embed` route runs on loopback (the real
 * image is not built in CI, as for ADR-0220). Its "model" counts words from a small
 * vocabulary, so paraphrases land on (nearly) the same unit vector and a different
 * question does not. The suite pins: off by default and refused without an
 * embedder; a paraphrase is a hit only inside its partition (same user, agent,
 * options); a hit re-runs the live gates (a revoked grant is refused); the
 * embedder must be local; and a failing embedder is a miss, never an error.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  and,
  auditLog,
  costEvents,
  createDb,
  eq,
  externalScorers,
  runMigrations,
  semanticCacheEmbeddings,
  usageEvents,
  type Db,
} from "@regulait/db";
import { buildApp } from "./app.js";
import { removeEgressAllowEntry } from "./testing/egress-allow-cleanup.js";
import { relaxGovernanceGatesForTest } from "./testing/governance-gates.js";
import { relaxStepUpAround } from "./testing/step-up-posture.js";
import { relaxDataPostureForTest } from "./testing/strict-data-posture.js";
import { createGuardedFetch } from "./egress-guard.js";
import { embedText, localLiteralRefusal, localOnlyResolver } from "./semantic-cache-similarity.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = Math.random().toString(36).slice(2, 8);
const BOOT = `adr0352-sim-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const DATA_KEY = "e".repeat(64);

// word -> dimension; synonyms share one
const VOCAB: Record<string, number> = {
  what: 0, whats: 0, is: 1, the: 2, our: 2, refund: 3, refunds: 3, policy: 4, policies: 4, rules: 4,
  how: 5, do: 6, i: 7, reset: 8, my: 9, password: 10,
};
function fakeEmbed(text: string): number[] {
  const v = new Array<number>(16).fill(0);
  for (const w of text.toLowerCase().replace(/[^a-z\s]/g, "").split(/\s+/)) if (w in VOCAB) v[VOCAB[w]!]! += 1;
  v[15] = 0.01; // never a zero vector
  return v;
}

let db: Db;
let app: ReturnType<typeof buildApp>;
let server: Server;
let embedCalls = 0;
let embedFails = false;
let allowId: string | undefined;
let embedderId = "";
let restore: Array<() => Promise<void>> = [];

const post = (url: string, payload: unknown, headers = AUTH) => app.inject({ method: "POST", url, headers, payload: payload as object });

async function user(tag: string) {
  const u = await post("/v1/users", { email: `adr0352-${tag}-${RUN}@example.com`, displayName: tag });
  expect(u.statusCode).toBe(201);
  const id = u.json().id as string;
  const token = (await post(`/v1/users/${id}/keys`, { name: "k" })).json().token as string;
  return { id, auth: { authorization: `Bearer ${token}` } };
}

async function agentFor(...userIds: string[]) {
  const res = await post("/v1/agents", {
    name: `adr0352-sim-${RUN}-${Math.random().toString(36).slice(2, 6)}`,
    provider: "mock",
    tier: 1,
    modes: ["chat"],
    costPerMTokIn: 3,
    costPerMTokOut: 15,
    model: "mock-balanced",
  });
  expect(res.statusCode).toBe(201);
  const id = res.json().id as string;
  const grants: Record<string, string> = {};
  for (const u of userIds) {
    const g = await post("/v1/grants/agents", { userId: u, agentId: id });
    expect(g.statusCode).toBeLessThan(300);
    grants[u] = g.json().id;
  }
  return { id, grants };
}

async function invoke(agentId: string, who: { id: string; auth: { authorization: string } }, input: string, extra: Record<string, unknown> = {}) {
  const before = (await db.select({ id: usageEvents.id }).from(usageEvents).where(eq(usageEvents.userId, who.id))).length;
  const res = await app.inject({
    method: "POST",
    url: `/v1/agents/${agentId}/invoke`,
    headers: who.auth,
    payload: { mode: "chat", dispatch: true, input, ...extra },
  });
  const after = (await db.select({ id: usageEvents.id }).from(usageEvents).where(eq(usageEvents.userId, who.id))).length;
  return { status: res.statusCode, body: res.json(), dispatched: after - before };
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });
  restore.push(await relaxGovernanceGatesForTest(db, { mrmEnforced: false, dispatchAttributionRequired: false }));

  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c.toString("utf8")));
    req.on("end", () => {
      embedCalls += 1;
      res.setHeader("content-type", "application/json");
      if (embedFails) {
        res.statusCode = 500;
        return res.end(JSON.stringify({ error: "model failure" }));
      }
      const body = JSON.parse(raw) as { scorerKind: string; input: string };
      if (body.scorerKind !== "text_embedding") {
        res.statusCode = 400;
        return res.end("{}");
      }
      res.end(JSON.stringify({ embedding: fakeEmbed(body.input), dims: 16, model: "fake/vocab@1" }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const allowed = await relaxStepUpAround(db, () =>
    post("/v1/egress-allow-hosts", { host: "127.0.0.1", allowPrivateRanges: true, allowPlaintextHttp: true, note: "adr0352: fake embedder" }),
  );
  expect(allowed.statusCode).toBe(201);
  allowId = allowed.json().id;

  const reg = await post("/v1/external-scorers", {
    name: `adr0352-embedder-${RUN}`,
    baseUrl: `${base}/embed`,
    scorerKinds: ["text_embedding"],
    allowPlaintextHttp: true,
  });
  expect(reg.statusCode, reg.body).toBe(201);
  embedderId = reg.json().id;
}, 120_000);

afterAll(async () => {
  const allow = await removeEgressAllowEntry(app, AUTH, { id: allowId });
  try {
    for (const r of restore.reverse()) await r();
    await db.delete(externalScorers).where(eq(externalScorers.id, embedderId));
    app.server.closeAllConnections();
    await app.close();
    await new Promise<void>((r) => server.close(() => r()));
  } finally {
    allow.assertRemoved();
  }
});

describe("ADR-0352 registration and settings", () => {
  it("an embedder claims text_embedding alone", async () => {
    const mixed = await post("/v1/external-scorers", {
      name: `adr0352-mixed-${RUN}`,
      baseUrl: "http://127.0.0.1:1/embed",
      scorerKinds: ["text_embedding", "guardrail_pii"],
      allowPlaintextHttp: true,
    });
    expect(mixed.statusCode).toBe(400);
  });

  it("is off by default, and cannot be turned on without an enabled embedder", async () => {
    const settings = await app.inject({ method: "GET", url: "/v1/org/settings", headers: AUTH });
    expect(settings.json().settings.semanticCacheSimilarityEnabled).toBe(false);
    expect(settings.json().settings.semanticCacheSimilarityMin).toBe(0.95);

    const put = (payload: object) => relaxStepUpAround(db, () => app.inject({ method: "PUT", url: "/v1/org/settings", headers: AUTH, payload }));
    expect((await put({ semanticCacheSimilarityEnabled: true })).json().error).toBe("embedder_required");
    expect((await put({ semanticCacheSimilarityEnabled: true, semanticCacheEmbedderId: embedderId })).json().error).toBe("embedder_disabled");

    // the connection test speaks /embed and enables the gate
    const test = await post(`/v1/external-scorers/${embedderId}/test`, {});
    expect(test.statusCode, test.body).toBe(200);
    expect(test.json()).toMatchObject({ ok: true, dims: 16, model: "fake/vocab@1" });
    const en = await relaxStepUpAround(db, () =>
      app.inject({ method: "POST", url: `/v1/external-scorers/${embedderId}/enabled`, headers: AUTH, payload: { enabled: true } }),
    );
    expect(en.statusCode, en.body).toBeLessThan(300);
  });
});

describe("ADR-0352 the meaning-based tier on the native invoke path", () => {
  beforeAll(async () => {
    restore.push(
      await relaxDataPostureForTest(db, {
        org: {
          semanticCachePolicy: "always",
          defaultPiiMode: "none",
          semanticCacheSimilarityEnabled: true,
          semanticCacheEmbedderId: embedderId,
          semanticCacheSimilarityMin: 0.95,
        },
        interception: false,
        guardrails: false,
      }),
    );
  });

  it("serves a paraphrase from the cache, governed and recorded as the similarity tier", async () => {
    const a = await user("a");
    const ag = await agentFor(a.id);
    const first = await invoke(ag.id, a, "What is the refund policy?");
    expect(first.status).toBe(200);
    expect(first.dispatched).toBe(1);
    expect(first.body.cached).not.toBe(true);
    const indexed = await db.select().from(semanticCacheEmbeddings);
    expect(indexed.some((r) => r.embedderModel === "fake/vocab@1")).toBe(true);

    const para = await invoke(ag.id, a, "what is our refunds policy");
    expect(para.status).toBe(200);
    expect(para.body.cached).toBe(true);
    expect(para.dispatched).toBe(0);
    expect(para.body.dispatch.outputText).toBe(first.body.dispatch.outputText);

    const saved = await db
      .select()
      .from(costEvents)
      .where(and(eq(costEvents.userId, a.id), eq(costEvents.ruleId, "semantic-cache-similar-hit")));
    expect(saved.length).toBe(1);
    expect(saved[0]!.detail).toMatchObject({ tier: "similarity" });
    const audits = await db.select().from(auditLog).where(and(eq(auditLog.userId, a.id), eq(auditLog.objectId, ag.id)));
    const hitRow = audits.find((r) => (r.detail as { semanticCache?: { tier?: string } }).semanticCache?.tier === "similarity");
    expect(hitRow?.effect).toBe("allow");
    expect(JSON.stringify(hitRow?.detail)).not.toContain("refund");

    // a different question is not a match
    const other = await invoke(ag.id, a, "How do I reset my password?");
    expect(other.body.cached).not.toBe(true);
    expect(other.dispatched).toBe(1);
  });

  it("never matches across users, or across request options", async () => {
    const a = await user("pa");
    const b = await user("pb");
    const ag = await agentFor(a.id, b.id);
    expect((await invoke(ag.id, a, "What is the refund policy?")).dispatched).toBe(1);
    // another user with the same grant and a paraphrase: a miss
    const other = await invoke(ag.id, b, "what is our refunds policy");
    expect(other.status).toBe(200);
    expect(other.body.cached).not.toBe(true);
    expect(other.dispatched).toBe(1);
    // the same user with a different option: a miss
    const opt = await invoke(ag.id, a, "what is our refunds policy", { maxTokens: 64 });
    expect(opt.body.cached).not.toBe(true);
    expect(opt.dispatched).toBe(1);
  });

  it("re-runs the live gates on a hit: a revoked grant is refused, not served from the cache", async () => {
    const a = await user("rv");
    const ag = await agentFor(a.id);
    expect((await invoke(ag.id, a, "What is the refund policy?")).dispatched).toBe(1);
    const del = await app.inject({ method: "DELETE", url: `/v1/grants/agents/${ag.grants[a.id]}`, headers: AUTH });
    expect(del.statusCode).toBeLessThan(300);
    const denied = await invoke(ag.id, a, "what is our refunds policy");
    expect(denied.status).toBe(403);
    expect(denied.body.cached).not.toBe(true);
  });

  it("a failing embedder is a miss: the call is dispatched, not failed", async () => {
    const a = await user("ef");
    const ag = await agentFor(a.id);
    embedFails = true;
    try {
      const r = await invoke(ag.id, a, "What is the refund policy?");
      expect(r.status).toBe(200);
      expect(r.dispatched).toBe(1);
    } finally {
      embedFails = false;
    }
  });
});

describe("ADR-0352 the embedder must be local", () => {
  it("a host that resolves to a public address is refused before any request", async () => {
    const publicResolver = async () => [{ address: "93.184.215.14", family: 4 }];
    await expect(localOnlyResolver(publicResolver)("embedder.example")).rejects.toThrow(/must be local/);
    // composed as resolveLocalEmbedder composes it: the guarded fetch refuses before connecting
    let reached = 0;
    const embedder = {
      id: "x",
      name: "public",
      baseUrl: "https://embedder.example/embed",
      apiKey: null,
      fetchImpl: createGuardedFetch({
        allowList: [{ host: "embedder.example", allowPrivateRanges: false, allowPlaintextHttp: false } as never],
        resolve: localOnlyResolver(publicResolver),
        fetchImpl: async () => {
          reached += 1;
          return new Response("{}");
        },
      }),
    };
    await expect(embedText(embedder, "x")).rejects.toThrow();
    expect(reached).toBe(0);
    // an IP-literal URL never reaches a resolver, so it is classified directly
    expect(localLiteralRefusal("http://8.8.8.8:8080/embed")).toMatch(/must be local/);
    expect(localLiteralRefusal("http://[2001:4860:4860::8888]/embed")).toMatch(/must be local/);
    expect(localLiteralRefusal("http://169.254.169.254/embed")).toMatch(/must be local/);
    expect(localLiteralRefusal("http://10.1.2.3:8080/embed")).toBeNull();
    expect(localLiteralRefusal("http://127.0.0.1:8080/embed")).toBeNull();
    expect(localLiteralRefusal("http://detectors.internal:8080/embed")).toBeNull();
    // and a mixed answer (one private, one public) is refused too
    await expect(
      localOnlyResolver(async () => [
        { address: "10.0.0.5", family: 4 },
        { address: "8.8.8.8", family: 4 },
      ])("h"),
    ).rejects.toThrow(/8\.8\.8\.8/);
    await expect(localOnlyResolver(async () => [{ address: "127.0.0.1", family: 4 }])("h")).resolves.toHaveLength(1);
  });
});
