import { beforeAll, describe, expect, it, afterAll } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { costEvents, createDb, eq, runMigrations, type Db } from "@regulait/db";
import { resolveModelProvider, type MockModelProvider } from "@regulait/model-provider";
import { buildApp } from "./app.js";
import { relaxGovernanceGatesForTest } from "./testing/governance-gates.js";
// ADR-0181: the governance gates this suite would trip but does not test, relaxed by name
let restoreSb2Gates: () => Promise<void> = async () => {};

/**
 * PILLAR 6 §8/§10 — prompt caching, end to end: a dispatch carrying a large,
 * stable system prefix is marked cacheable (Anthropic ephemeral breakpoint)
 * and lands ONE prompt_caching estimate row in the per-technique ledger; a
 * short/absent prefix is never marked (below the min cacheable size); and the
 * per-user "passthrough" off switch disables caching entirely even for a large
 * prefix. Prompt caching is a pure cost annotation — it never changes the
 * served agent, model, entitlement, or output.
 *
 * Shares one database with the other gateway suites (fileParallelism is off);
 * everything here is prefixed pcache- and ledger asserts filter by user id. The
 * shared mock is process-wide, so wire asserts locate this suite's dispatch by
 * a unique input marker.
 */

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");

const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

const BOOT = "pcache-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
const DATA_KEY = "d".repeat(64);

// ≥ 4100 chars → ≥ 1024 estimated tokens (chars/4), clearing the 1024-token
// minimum cacheable size; a short prefix stays well under it.
const BIG_SYSTEM = "You are a governed worker agent. " + "Follow the signed-off scope precisely. ".repeat(120);
const SMALL_SYSTEM = "You are a terse assistant.";

let db: Db;
let app: ReturnType<typeof buildApp>;
let mock: MockModelProvider;

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

async function makeAgent(name: string) {
  const res = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/agents",
    payload: { name, provider: "mock", tier: 1, costPerMTokIn: 3, costPerMTokOut: 15, model: "mock-balanced" },
  });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

const grant = (userId: string, agentId: string) =>
  app.inject({ method: "POST", headers: AUTH, url: "/v1/grants/agents", payload: { userId, agentId } });

const setRoutingMode = (userId: string, routingMode: "automatic" | "passthrough") =>
  app.inject({
    method: "POST",
    headers: AUTH,
    url: `/v1/users/${userId}/agent-policy`,
    payload: { routingMode },
  });

let agentId: string;
let projectId: string;

async function invoke(
  auth: { authorization: string },
  payload: Record<string, unknown>,
) {
  const res = await app.inject({
    method: "POST",
    headers: auth,
    url: `/v1/agents/${agentId}/invoke`,
    payload: { mode: "chat", dispatch: true, projectId, ...payload },
  });
  expect(res.statusCode).toBe(200);
  return res.json();
}

const promptCacheRows = async (userId: string) =>
  (await db.select().from(costEvents).where(eq(costEvents.userId, userId))).filter(
    (r) => r.technique === "prompt_caching",
  );

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });
  restoreSb2Gates = await relaxGovernanceGatesForTest(db, { mrmEnforced: false, dispatchAttributionRequired: false });
  mock = resolveModelProvider({ provider: "mock" }) as MockModelProvider;

  agentId = await makeAgent("pcache-agent");

  const project = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/projects",
    payload: { name: "pcache-project" },
  });
  expect(project.statusCode).toBe(201);
  projectId = project.json().id;
});

describe("prompt caching estimate row + cache_control threading", () => {
  it("a large stable system prefix (automatic mode) writes a prompt_caching row and marks the wire cacheable", async () => {
    const u = await makeUser("pcache-large@example.com");
    await grant(u.id, agentId);
    const marker = "pcache-large-marker-abc";
    await invoke(u.auth, { input: marker, system: BIG_SYSTEM });

    const rows = await promptCacheRows(u.id);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.ruleId).toBe("prompt-caching");
    expect(row.servedAgentId).toBe(agentId);
    expect(row.projectId).toBe(projectId);
    expect(row.estimatedTokensSaved).toBeGreaterThan(0);
    expect(row.estimatedTokensSaved).toBe(Math.ceil(BIG_SYSTEM.length / 4));
    // dollars = saved tokens × served input price × cache-read discount
    expect(row.estimatedCostSavedUsd!).toBeGreaterThan(0);
    expect(row.estimationBasis).toContain("prompt-caching");
    expect((row.detail as { systemTokens?: number }).systemTokens).toBe(Math.ceil(BIG_SYSTEM.length / 4));

    // the outgoing dispatch actually received cacheSystem: true
    const wire = mock.dispatches.filter((d) => d.input === marker).at(-1)!;
    expect(wire).toBeDefined();
    expect(wire.cacheSystem).toBe(true);
    expect(wire.system).toBe(BIG_SYSTEM);
  });

  it("a short system prefix writes NO prompt_caching row and does not mark the wire", async () => {
    const u = await makeUser("pcache-small@example.com");
    await grant(u.id, agentId);
    const marker = "pcache-small-marker-def";
    await invoke(u.auth, { input: marker, system: SMALL_SYSTEM });

    expect(await promptCacheRows(u.id)).toHaveLength(0);
    const wire = mock.dispatches.filter((d) => d.input === marker).at(-1)!;
    expect(wire.cacheSystem).toBeUndefined();
  });

  it("an absent system prefix writes NO prompt_caching row", async () => {
    const u = await makeUser("pcache-none@example.com");
    await grant(u.id, agentId);
    await invoke(u.auth, { input: "pcache-none-marker-ghi" });
    expect(await promptCacheRows(u.id)).toHaveLength(0);
  });

  it("passthrough routing mode disables caching entirely, even with a large prefix (§12 off switch)", async () => {
    const u = await makeUser("pcache-pass@example.com");
    await grant(u.id, agentId);
    expect((await setRoutingMode(u.id, "passthrough")).statusCode).toBe(200);
    const marker = "pcache-pass-marker-jkl";
    await invoke(u.auth, { input: marker, system: BIG_SYSTEM });

    expect(await promptCacheRows(u.id)).toHaveLength(0);
    const wire = mock.dispatches.filter((d) => d.input === marker).at(-1)!;
    expect(wire.cacheSystem).toBeUndefined();
  });
});

afterAll(async () => {
  await restoreSb2Gates();
});
