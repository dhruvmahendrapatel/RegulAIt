import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  and,
  configActivationEvents,
  configCanaryObservations,
  configVersions,
  createDb,
  desc,
  eq,
  inArray,
  runMigrations,
  usageEvents,
  type Db,
} from "@regulait/db";
import { buildApp } from "./app.js";

/**
 * Batch B7c — the B1 amendment's own residual, closed: "usage_events still
 * stamps only the PROMPT version (one stamp column, two artifact types)".
 *
 * `usage_events.agent_config_version_id` / `agent_config_version` now carry
 * the agent_config version that ACTUALLY SERVED each dispatch, stamped at the
 * one dispatch core where the resolution happens. What this file pins:
 *
 *  1. UNVERSIONED = NULL, byte-identical pre-B7c behaviour.
 *  2. THE STAMP FOLLOWS ACTIVATION: a versioned agent's rows carry the active
 *     version's id + integer, and activating a NEWER version moves the stamp
 *     on the very next row.
 *  3. THE CANDIDATE IS NEVER STAMPED. With a shadow canary running, the row
 *     still names the ACTIVE version — the column means "what served", and an
 *     agent_config candidate never serves (ADR-0073's invariant).
 *  4. TWO ARTIFACT TYPES, TWO STAMPS: the prompt stamp (`config_version_id`)
 *     and the config stamp coexist on one row and name different versions.
 *
 * SHARED-STATE DISCIPLINE: `ucs-` prefixed objects; row assertions scoped to
 * this suite's agent + user; afterAll removes usage rows, observations,
 * events and versions.
 */

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

const BOOT = "ucs-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
const DATA_KEY = "d".repeat(64);

let db: Db;
let app: ReturnType<typeof buildApp>;
let agentId: string;
let danaId: string;
let danaAuth: { authorization: string };

async function invoke() {
  return app.inject({
    method: "POST",
    url: `/v1/agents/${agentId}/invoke`,
    headers: danaAuth,
    payload: { mode: "execute", input: "ucs probe", dispatch: true },
  });
}

async function latestUsage() {
  const [row] = await db
    .select()
    .from(usageEvents)
    .where(and(eq(usageEvents.agentId, agentId), eq(usageEvents.userId, danaId)))
    .orderBy(desc(usageEvents.at), desc(usageEvents.id))
    .limit(1);
  return row;
}

async function versionRow(version: number) {
  const [row] = await db
    .select()
    .from(configVersions)
    .where(
      and(
        eq(configVersions.artifactType, "agent_config"),
        eq(configVersions.artifactId, agentId),
        eq(configVersions.version, version),
      ),
    );
  return row;
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });

  const u = await app.inject({
    method: "POST",
    url: "/v1/users",
    headers: AUTH,
    payload: { email: "ucs-dana@example.com", displayName: "ucs dana" },
  });
  expect(u.statusCode).toBe(201);
  danaId = u.json().id;
  const k = await app.inject({
    method: "POST",
    url: `/v1/users/${danaId}/keys`,
    headers: AUTH,
    payload: { name: "ucs" },
  });
  danaAuth = { authorization: `Bearer ${k.json().token}` };

  const a = await app.inject({
    method: "POST",
    url: "/v1/agents",
    headers: AUTH,
    payload: { name: "ucs-agent", provider: "mock", tier: 1, model: "mock-balanced", costPerMTokIn: 3, costPerMTokOut: 15 },
  });
  expect(a.statusCode).toBe(201);
  agentId = a.json().id;
  await app.inject({
    method: "POST",
    url: "/v1/grants/agents",
    headers: AUTH,
    payload: { userId: danaId, agentId },
  });
});

afterAll(async () => {
  if (agentId) {
    await db.delete(usageEvents).where(eq(usageEvents.agentId, agentId));
    await db.delete(configCanaryObservations).where(eq(configCanaryObservations.artifactId, agentId));
    await db.delete(configActivationEvents).where(eq(configActivationEvents.artifactId, agentId));
    await db.delete(configVersions).where(eq(configVersions.artifactId, agentId));
  }
});

// ---------------------------------------------------------------------------

describe("B7c — usage_events stamps the agent_config version that SERVED", () => {
  it("an UNVERSIONED agent stamps null — byte-identical pre-existing behaviour", async () => {
    expect((await invoke()).statusCode).toBe(200);
    const row = await latestUsage();
    expect(row!.agentConfigVersionId).toBeNull();
    expect(row!.agentConfigVersion).toBeNull();
  });

  it("after activation the row carries the id + integer of the version that served", async () => {
    const created = await app.inject({
      method: "POST",
      headers: AUTH,
      url: `/v1/config-versions/agent_config/${agentId}`,
      payload: { body: { model: "mock-premium" }, label: "ucs v2", activate: true },
    });
    expect(created.statusCode).toBe(201);

    expect((await invoke()).statusCode).toBe(200);
    const row = await latestUsage();
    const v2 = await versionRow(2);
    expect(row!.agentConfigVersionId).toBe(v2!.id);
    expect(row!.agentConfigVersion).toBe(2);
    // and the served model on the same row is the version's — the stamp names
    // the config that genuinely executed, not a column copy
    expect(row!.model).toBe("mock-premium");
  });

  it("activating a NEWER version moves the stamp on the very next row", async () => {
    const created = await app.inject({
      method: "POST",
      headers: AUTH,
      url: `/v1/config-versions/agent_config/${agentId}`,
      payload: { body: { model: "mock-fast" }, label: "ucs v3", activate: true },
    });
    expect(created.statusCode).toBe(201);

    expect((await invoke()).statusCode).toBe(200);
    const row = await latestUsage();
    const v3 = await versionRow(3);
    expect(row!.agentConfigVersionId).toBe(v3!.id);
    expect(row!.agentConfigVersion).toBe(3);
    expect(row!.model).toBe("mock-fast");
  });

  it("a shadow canary NEVER reaches the stamp — the column means 'what served'", async () => {
    const draft = await app.inject({
      method: "POST",
      headers: AUTH,
      url: `/v1/config-versions/agent_config/${agentId}`,
      payload: { body: { model: "mock-balanced" }, label: "ucs candidate" },
    });
    expect(draft.statusCode).toBe(201);
    const candidateVersion = draft.json().version.version as number;
    const canary = await app.inject({
      method: "POST",
      headers: AUTH,
      url: `/v1/config-versions/agent_config/${agentId}/canary`,
      payload: { version: candidateVersion, pct: 99 },
    });
    expect(canary.statusCode).toBe(200);

    expect((await invoke()).statusCode).toBe(200);
    const row = await latestUsage();
    const v3 = await versionRow(3);
    const candidate = await versionRow(candidateVersion);
    // whether or not this caller fell inside the 99% shadow sample, the stamp
    // must name the ACTIVE version and never the candidate
    expect(row!.agentConfigVersionId).toBe(v3!.id);
    expect(row!.agentConfigVersionId).not.toBe(candidate!.id);
    expect(row!.model).toBe("mock-fast");
  });

  it("two artifact types, two stamps: the prompt stamp and the config stamp coexist and differ", async () => {
    const prompt = await app.inject({
      method: "POST",
      headers: AUTH,
      url: `/v1/agents/${agentId}/system-prompt`,
      payload: { systemPrompt: "ucs base prompt" },
    });
    expect(prompt.statusCode).toBe(200);

    expect((await invoke()).statusCode).toBe(200);
    const row = await latestUsage();
    expect(row!.configVersionId).not.toBeNull(); // ADR-0048's prompt stamp
    expect(row!.agentConfigVersionId).not.toBeNull(); // B7c's config stamp
    expect(row!.configVersionId).not.toBe(row!.agentConfigVersionId);
  });
});
