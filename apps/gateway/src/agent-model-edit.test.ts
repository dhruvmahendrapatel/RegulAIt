import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  and,
  configActivationEvents,
  configVersions,
  createDb,
  eq,
  inArray,
  runMigrations,
  usageEvents,
  type Db,
} from "@regulait/db";
import { buildApp } from "./app.js";
import { relaxGovernanceGatesForTest } from "./testing/governance-gates.js";
// ADR-0181: the governance gates this suite would trip but does not test, relaxed by name
let restoreSb2Gates: () => Promise<void> = async () => {};

/**
 * B1.5 F2 — `PATCH /v1/agents/:agentId`, the admin affordance the live run
 * (LIVE_VERIFICATION_2026-08) found missing: no API route edited an agent's
 * MODEL, so when Google retired the seeded model id the only fix was psql.
 *
 * The route is deliberately NOT a column write. Batch B1 made model +
 * list-prices a VERSIONED dispatch-execution config (`agent_config`,
 * ADR-0073 amendment): dispatch resolves the ACTIVE version, so a raw row
 * write on a versioned agent would change every list surface and change
 * NOTHING about what dispatches — the silent divergence ADR-0074 exists to
 * remove. The route therefore rides `applyRuleEdit` (ADR-0074's one choke
 * point): versioned agent → mint + activate in one transaction; unversioned
 * agent → plain row write, byte-identical to pre-versioning semantics.
 *
 * The seed side of the same finding is a semantics NOTE, pinned here in prose:
 * the seed matches existing agents by name and never mutates them, so
 * refreshing an already-seeded database's stale model id is exactly THIS
 * route's job — the seed only fixes fresh installs.
 *
 * SHARED-DB DISCIPLINE: `ame-` prefixed users/agents; one agent per user (the
 * routing discipline); version/usage rows cleaned in afterAll; assertions on
 * what DISPATCH serves, never only on a column.
 */

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

const BOOT = "ame-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
const DATA_KEY = "f".repeat(64);

let db: Db;
let app: ReturnType<typeof buildApp>;
let plainAgentId: string;
let plainUserAuth: { authorization: string };
let versionedAgentId: string;
let versionedUserAuth: { authorization: string };
let nonAdminAuth: { authorization: string };

async function makeUser(email: string) {
  // never email-shaped: the shared-context directory suite asserts the
  // names-only surface leaks no "@example.com" from ANY row
  const displayName = email.split("@")[0]!.replace(/-/g, " ");
  const u = await app.inject({ method: "POST", headers: AUTH, url: "/v1/users", payload: { email, displayName } });
  expect(u.statusCode).toBe(201);
  const k = await app.inject({
    method: "POST",
    headers: AUTH,
    url: `/v1/users/${u.json().id}/keys`,
    payload: { name: "ame" },
  });
  return { id: u.json().id as string, auth: { authorization: `Bearer ${k.json().token}` } };
}

async function makeAgent(name: string, model: string, granteeId: string) {
  const a = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/agents",
    payload: { name, provider: "mock", tier: 1, modes: ["execute"], model, costPerMTokIn: 3, costPerMTokOut: 15 },
  });
  expect(a.statusCode).toBe(201);
  const id = a.json().id as string;
  await app.inject({ method: "POST", headers: AUTH, url: "/v1/grants/agents", payload: { userId: granteeId, agentId: id } });
  return id;
}

/** what actually dispatches — the response's served model, never a column read */
async function dispatchedModel(auth: { authorization: string }, agentId: string, input: string) {
  const res = await app.inject({
    method: "POST",
    headers: auth,
    url: `/v1/agents/${agentId}/invoke`,
    payload: { mode: "execute", input, dispatch: true },
  });
  expect(res.statusCode).toBe(200);
  return res.json().dispatch.model as string;
}

async function versionsOf(artifactId: string) {
  return db
    .select()
    .from(configVersions)
    .where(and(eq(configVersions.artifactType, "agent_config"), eq(configVersions.artifactId, artifactId)))
    .orderBy(configVersions.version);
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });
  restoreSb2Gates = await relaxGovernanceGatesForTest(db, { mrmEnforced: false, dispatchAttributionRequired: false });

  const plainUser = await makeUser("ame-plain@example.com");
  plainUserAuth = plainUser.auth;
  plainAgentId = await makeAgent("ame-plain-agent", "mock-balanced", plainUser.id);

  const versionedUser = await makeUser("ame-versioned@example.com");
  versionedUserAuth = versionedUser.auth;
  versionedAgentId = await makeAgent("ame-versioned-agent", "mock-balanced", versionedUser.id);

  const nonAdmin = await makeUser("ame-nonadmin@example.com");
  nonAdminAuth = nonAdmin.auth;

  // version the second agent through the authoring surface (batch B1): lazy
  // baseline v1 is captured from the row, v2 becomes the active truth
  const created = await app.inject({
    method: "POST",
    headers: AUTH,
    url: `/v1/config-versions/agent_config/${versionedAgentId}`,
    payload: { body: { model: "mock-premium" }, label: "ame v2", activate: true },
  });
  expect(created.statusCode).toBe(201);
});

afterAll(async () => {
  const ids = [plainAgentId, versionedAgentId].filter(Boolean);
  await db.delete(usageEvents).where(inArray(usageEvents.agentId, ids));
  await db.delete(configActivationEvents).where(inArray(configActivationEvents.artifactId, ids));
  await db.delete(configVersions).where(inArray(configVersions.artifactId, ids));
  await restoreSb2Gates();
});

describe("PATCH /v1/agents/:agentId — versioned agent_config edit surface", () => {
  it("an UNVERSIONED agent gets the plain row write (invariant 4) and the new model genuinely dispatches", async () => {
    const res = await app.inject({
      method: "PATCH",
      headers: AUTH,
      url: `/v1/agents/${plainAgentId}`,
      payload: { model: "mock-premium" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().model).toBe("mock-premium");
    // no version minted — this agent has no stored versions, its row IS the truth
    expect(res.json().versionMinted).toBeNull();
    expect(res.json().note).toContain("no stored versions");
    expect(await versionsOf(plainAgentId)).toEqual([]);
    expect(await dispatchedModel(plainUserAuth, plainAgentId, "ame plain probe")).toBe("mock-premium");
  });

  it("a VERSIONED agent's edit MINTS + ACTIVATES an agent_config version — and dispatch serves the minted config", async () => {
    // control first: the active v2 is what dispatches before the edit
    expect(await dispatchedModel(versionedUserAuth, versionedAgentId, "ame pre-edit probe")).toBe("mock-premium");

    const res = await app.inject({
      method: "PATCH",
      headers: AUTH,
      url: `/v1/agents/${versionedAgentId}`,
      payload: { model: "mock-fast", costPerMTokIn: 0.5 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().versionMinted).toBe(3);
    expect(res.json().note).toContain("minted");

    const rows = await versionsOf(versionedAgentId);
    const active = rows.find((r) => r.status === "active");
    expect(active!.version).toBe(3);
    expect(active!.body).toMatchObject({ model: "mock-fast", costPerMTokIn: 0.5 });
    // v2 is history, not deleted
    expect(rows.find((r) => r.version === 2)!.status).toBe("superseded");

    // THE ASSERTION A RAW COLUMN WRITE CANNOT FAKE: the dispatch core resolves
    // the ACTIVE version, so the edit only counts if the minted config serves
    expect(await dispatchedModel(versionedUserAuth, versionedAgentId, "ame post-edit probe")).toBe("mock-fast");
    // and the row stays a synced read-model for the list surfaces
    const list = await app.inject({ method: "GET", headers: AUTH, url: "/v1/agents" });
    const row = list.json().agents.find((a: { id: string }) => a.id === versionedAgentId);
    expect(row.model).toBe("mock-fast");
  });

  it("an edit that changes nothing mints nothing", async () => {
    const res = await app.inject({
      method: "PATCH",
      headers: AUTH,
      url: `/v1/agents/${versionedAgentId}`,
      payload: { model: "mock-fast" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().versionMinted).toBeNull();
    expect((await versionsOf(versionedAgentId)).length).toBe(3);
  });

  it("refuses every non-config column with the remedy named — the ADR-0073 scope line at the route", async () => {
    for (const payload of [
      { provider: "openai" },
      { tier: 3 },
      { enabled: false },
      { name: "renamed" },
      { systemPrompt: "x" },
      { customProviderId: "00000000-0000-4000-8000-000000000001" },
    ]) {
      const res = await app.inject({
        method: "PATCH",
        headers: AUTH,
        url: `/v1/agents/${versionedAgentId}`,
        payload,
      });
      expect(res.statusCode, JSON.stringify(payload)).toBe(422);
      expect(res.json().error).toBe("field_not_editable");
    }
    // scope refusals minted nothing
    expect((await versionsOf(versionedAgentId)).length).toBe(3);
  });

  it("unknown agent → 404; non-admin → 403 (admin-only via the global gate)", async () => {
    const missing = await app.inject({
      method: "PATCH",
      headers: AUTH,
      url: "/v1/agents/00000000-0000-4000-8000-0000000000aa",
      payload: { model: "x" },
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error).toBe("unknown_agent");

    const forbidden = await app.inject({
      method: "PATCH",
      headers: nonAdminAuth,
      url: `/v1/agents/${plainAgentId}`,
      payload: { model: "x" },
    });
    expect(forbidden.statusCode).toBe(403);
  });
});
