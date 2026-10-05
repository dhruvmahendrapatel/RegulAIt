import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  costEvents,
  createDb,
  eq,
  runMigrations,
  semanticCache,
  usageEvents,
  type Db,
} from "@regulait/db";
import { buildApp } from "./app.js";
import { relaxGovernanceGatesForTest } from "./testing/governance-gates.js";
// ADR-0181: the governance gates this suite would trip but does not test, relaxed by name
let restoreSb2Gates: () => Promise<void> = async () => {};

/**
 * PILLAR 6 §8/§10 — semantic caching, end to end: a REAL per-(user,agent)
 * exact-match response cache. An opt-in (semanticCache:true) dispatch whose
 * byte-identical request (ADR-0146 — no case/whitespace normalisation; the
 * full request/configuration matrix lives in zz-aer041-native-cache-identity)
 * already has a fresh stored answer for the SAME user+agent is served straight
 * from the cache — the
 * provider is skipped (no usage_events, no spend), the response is flagged
 * cached:true, and ONE semantic_caching cost_events row records the whole-call
 * saving. The governance boundary is absolute (§12): the lookup is scoped by
 * BOTH userId AND agentId, so a hit NEVER crosses users or agents.
 *
 * Plus request_batching (ESTIMATE-ONLY): an orchestration auto-pass whose ready
 * set holds ≥2 same-model nodes records ONE request_batching cost_events row on
 * the run; distinct-model / single-node passes record none. Dispatch behaviour
 * is unchanged — the estimate is purely the batching opportunity.
 *
 * Shares one database with the other gateway suites (fileParallelism is off);
 * everything here is prefixed sc-/rb- and ledger asserts filter by user id.
 */

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");

const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

const BOOT = "sc-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
const DATA_KEY = "d".repeat(64);

let db: Db;
let app: ReturnType<typeof buildApp>;

async function makeUser(email: string) {
  const user = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/users",
    payload: { email, displayName: email.split("@")[0] },
  });
  expect(user.statusCode).toBe(201);
  const key = await app.inject({
    method: "POST",
    headers: AUTH,
    url: `/v1/users/${user.json().id}/keys`,
    payload: { name: "test" },
  });
  expect(key.statusCode).toBe(201);
  return { id: user.json().id as string, auth: { authorization: `Bearer ${key.json().token}` } };
}

async function makeAgent(name: string, model = "mock-balanced") {
  const res = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/agents",
    payload: { name, provider: "mock", tier: 1, modes: ["chat"], costPerMTokIn: 3, costPerMTokOut: 15, model },
  });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

const grant = (userId: string, agentId: string) =>
  app.inject({ method: "POST", headers: AUTH, url: "/v1/grants/agents", payload: { userId, agentId } });

async function invoke(
  auth: { authorization: string },
  agentId: string,
  payload: Record<string, unknown>,
) {
  const res = await app.inject({
    method: "POST",
    headers: auth,
    url: `/v1/agents/${agentId}/invoke`,
    payload: { mode: "chat", dispatch: true, ...payload },
  });
  expect(res.statusCode).toBe(200);
  return res.json();
}

const cacheHitRows = async (userId: string) =>
  (await db.select().from(costEvents).where(eq(costEvents.userId, userId))).filter(
    (r) => r.technique === "semantic_caching",
  );

const usageCount = async (userId: string) =>
  (await db.select().from(usageEvents).where(eq(usageEvents.userId, userId))).length;

const cacheRows = async (userId: string) =>
  await db.select().from(semanticCache).where(eq(semanticCache.userId, userId));

let agentId: string;
let otherAgentId: string;

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });
  restoreSb2Gates = await relaxGovernanceGatesForTest(db, { mrmEnforced: false, dispatchAttributionRequired: false });
  agentId = await makeAgent("sc-agent");
  otherAgentId = await makeAgent("sc-other-agent", "mock-fast");
});

afterAll(async () => {
  app.server.closeAllConnections();
  await restoreSb2Gates();
  await app.close();
});

describe("semantic caching — real per-(user,agent) exact-match cache", () => {
  it("rechecks current output PII policy on the native invoke hit before serving or recording savings", async () => {
    const suffix = Math.random().toString(36).slice(2, 8);
    const u = await makeUser(`sc-policy-${suffix}@example.com`);
    await grant(u.id, agentId);
    const prompt = `native cache output pii ${suffix}`;
    const settings = await app.inject({ method: "GET", url: "/v1/org/settings", headers: AUTH });
    const prior = settings.json().settings.defaultPiiMode as string;
    try {
      const first = await invoke(u.auth, agentId, { input: prompt, semanticCache: true });
      expect(first.cached).toBeFalsy();
      const row = (await cacheRows(u.id))[0];
      expect(row).toBeDefined();
      const cachedText = `native-sensitive-${suffix}@example.com`;
      await db.update(semanticCache).set({ outputText: cachedText }).where(eq(semanticCache.id, row!.id));
      const policy = await app.inject({
        method: "PUT", url: "/v1/org/settings", headers: AUTH, payload: { defaultPiiMode: "block" },
      });
      expect(policy.statusCode).toBe(200);
      const beforeUsage = await usageCount(u.id);
      const beforeSavings = (await cacheHitRows(u.id)).length;
      const denied = await app.inject({
        method: "POST", url: `/v1/agents/${agentId}/invoke`, headers: u.auth,
        payload: { mode: "chat", dispatch: true, input: prompt, semanticCache: true },
      });
      expect(denied.statusCode).toBe(403);
      expect(denied.json().error).toBe("pii_blocked");
      expect(denied.body).not.toContain(cachedText);
      expect(await usageCount(u.id)).toBe(beforeUsage);
      expect((await cacheHitRows(u.id)).length).toBe(beforeSavings);
    } finally {
      const restored = await app.inject({
        method: "PUT", url: "/v1/org/settings", headers: AUTH, payload: { defaultPiiMode: prior },
      });
      expect(restored.statusCode).toBe(200);
    }
  });

  it("(a) MISS then a byte-identical re-ask is a HIT: served from cache, no new usage row, one cost row", async () => {
    const u = await makeUser("sc-hit@example.com");
    await grant(u.id, agentId);

    // FIRST: a miss — dispatches, stores; no semantic_caching cost row yet
    const first = await invoke(u.auth, agentId, {
      input: "Explain the CAP theorem clearly",
      semanticCache: true,
    });
    expect(first.cached).toBeFalsy();
    expect(first.dispatch.outputText.length).toBeGreaterThan(0);
    expect(await cacheHitRows(u.id)).toHaveLength(0);
    const afterMissUsage = await usageCount(u.id);
    expect(afterMissUsage).toBe(1); // one real dispatch billed
    const storedOutput = first.dispatch.outputText;

    // one cache row was stored for this (user, agent)
    expect(await cacheRows(u.id)).toHaveLength(1);

    // SECOND: same user+agent, byte-identical input. This used to send a
    // case/whitespace VARIANT and expect a hit — that pinned AER-041's defect
    // (case-sensitive identifiers collided). A variant now misses; see
    // zz-aer041-native-cache-identity.test.ts.
    const second = await invoke(u.auth, agentId, {
      input: "Explain the CAP theorem clearly",
      semanticCache: true,
    });
    expect(second.cached).toBe(true);
    expect(second.dispatch.cached).toBe(true);
    expect(second.dispatch.outputText).toBe(storedOutput); // identical output served
    expect(second.dispatch.stopReason).toBe("cached");

    // NO new usage_events row (the provider was skipped, no spend)
    expect(await usageCount(u.id)).toBe(afterMissUsage);

    // exactly one semantic_caching cost row, with a positive whole-call saving
    const rows = await cacheHitRows(u.id);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.ruleId).toBe("semantic-cache-hit");
    expect(row.servedAgentId).toBe(agentId);
    expect(row.estimatedTokensSaved).toBeGreaterThan(0);
    // priced at the invoked agent's list price
    expect(row.estimatedCostSavedUsd!).toBeGreaterThan(0);
    expect(row.estimationBasis).toContain("semantic-caching");
  });

  it("(b) ISOLATION: a DIFFERENT user issuing the same input is a MISS — never the first user's cached response", async () => {
    const u1 = await makeUser("sc-iso-1@example.com");
    const u2 = await makeUser("sc-iso-2@example.com");
    await grant(u1.id, agentId);
    await grant(u2.id, agentId);

    const shared = "What is idempotency in HTTP?";
    // u1 seeds the cache
    const s1 = await invoke(u1.auth, agentId, { input: shared, semanticCache: true });
    expect(s1.cached).toBeFalsy();
    expect(await cacheRows(u1.id)).toHaveLength(1);

    // u2 issues the identical input — MUST NOT be served u1's cached response
    const u2UsageBefore = await usageCount(u2.id);
    const s2 = await invoke(u2.auth, agentId, { input: shared, semanticCache: true });
    expect(s2.cached).toBeFalsy(); // NOT a cross-user hit
    expect(await usageCount(u2.id)).toBe(u2UsageBefore + 1); // u2 really dispatched
    expect(await cacheHitRows(u2.id)).toHaveLength(0); // no hit cost row for u2
    // u2's miss stored ITS OWN row, scoped to u2
    expect(await cacheRows(u2.id)).toHaveLength(1);
  });

  it("(c) a different AGENT, same user+input, is a MISS (cache is per-agent)", async () => {
    const u = await makeUser("sc-agent-scope@example.com");
    await grant(u.id, agentId);
    await grant(u.id, otherAgentId);

    const q = "Describe eventual consistency";
    // seed on agentId
    const a = await invoke(u.auth, agentId, { input: q, semanticCache: true });
    expect(a.cached).toBeFalsy();

    // same user + same input, DIFFERENT agent → MISS (no cross-agent hit)
    const usageBefore = await usageCount(u.id);
    const b = await invoke(u.auth, otherAgentId, { input: q, semanticCache: true });
    expect(b.cached).toBeFalsy();
    expect(await usageCount(u.id)).toBe(usageBefore + 1); // real dispatch on the other agent
  });

  it("(d) semanticCache absent → no lookup, no store (byte-identical to today)", async () => {
    const u = await makeUser("sc-off@example.com");
    await grant(u.id, agentId);

    // two identical calls with NO semanticCache flag — both dispatch, nothing cached
    await invoke(u.auth, agentId, { input: "off-switch identical prompt" });
    const second = await invoke(u.auth, agentId, { input: "off-switch identical prompt" });
    expect(second.cached).toBeFalsy();
    expect(await cacheRows(u.id)).toHaveLength(0); // nothing stored
    expect(await cacheHitRows(u.id)).toHaveLength(0); // no hit rows
    expect(await usageCount(u.id)).toBe(2); // both really dispatched
  });
});

// --- request batching (ESTIMATE-ONLY) on an orchestration auto pass ---

let approverId: string;

const mkNode = (id: string, agentId: string) => ({
  id,
  title: `rb task ${id}`,
  ownerAgentId: agentId,
  mode: "execute",
  estimate: { in: 1, out: 1 },
});

const batchingRows = async (runId: string) =>
  (await db.select().from(costEvents).where(eq(costEvents.objectId, runId))).filter(
    (r) => r.technique === "request_batching",
  );

async function planAndAuto(auth: { authorization: string }, graph: unknown) {
  const created = await app.inject({ method: "POST", headers: auth, url: "/v1/runs", payload: { graph } });
  expect(created.statusCode).toBe(201);
  const runId = created.json().id as string;
  const auto = await app.inject({
    method: "POST",
    headers: auth,
    url: `/v1/runs/${runId}/auto`,
    payload: { acceptReviews: true },
  });
  expect(auto.statusCode).toBe(200);
  return runId;
}

describe("request batching estimate — orchestration auto pass", () => {
  it("a ready wave with ≥2 same-model nodes writes one request_batching row; distinct-model writes none", async () => {
    const u = await makeUser("rb-user@example.com");
    approverId = (await makeUser("rb-approver@example.com")).id;
    // orchestration nodes run in mode "execute", so these workers advertise it
    const mkExecAgent = async (name: string, model: string) => {
      const r = await app.inject({
        method: "POST",
        headers: AUTH,
        url: "/v1/agents",
        payload: { name, provider: "mock", tier: 0, modes: ["execute"], costPerMTokIn: 1, costPerMTokOut: 5, model },
      });
      expect(r.statusCode).toBe(201);
      return r.json().id as string;
    };
    const worker = await mkExecAgent("rb-worker", "mock-worker");
    const workerFastId = await mkExecAgent("rb-worker-fast", "mock-distinct");
    await grant(u.id, worker);
    await grant(u.id, workerFastId);

    // POSITIVE: two nodes owned by the SAME model, both ready in wave 1
    const sameModelRun = await planAndAuto(u.auth, {
      run: "rb-same-model",
      escalationApproverUserId: approverId,
      nodes: [mkNode("a", worker), mkNode("b", worker)],
    });
    const posRows = await batchingRows(sameModelRun);
    expect(posRows).toHaveLength(1);
    const row = posRows[0]!;
    expect(row.ruleId).toBe("request-batching");
    expect(row.objectType).toBe("run");
    expect(row.estimatedTokensSaved).toBeGreaterThan(0);
    expect(row.estimationBasis).toContain("request-batching");
    expect((row.detail as { groups?: Array<{ model: string; count: number }> }).groups).toEqual([
      { model: "mock-worker", count: 2 },
    ]);

    // NEGATIVE: two nodes on DISTINCT models → no batchable group → no row
    const distinctRun = await planAndAuto(u.auth, {
      run: "rb-distinct-model",
      escalationApproverUserId: approverId,
      nodes: [mkNode("a", worker), mkNode("b", workerFastId)],
    });
    expect(await batchingRows(distinctRun)).toHaveLength(0);
  });
});
