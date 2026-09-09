import { beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { and, createDb, eq, modelCredentials, runMigrations, userModelCredentials, type Db } from "@regulait/db";
import { buildApp } from "./app.js";

/**
 * The credential + key layer as the two UIs actually drive it (ADR-0012: the
 * portals are pure API clients, so every surface they render has to be
 * reachable with exactly these calls). Covers the write-only discipline on
 * both credential surfaces, the one-time API-key reveal, and the agent-policy
 * round trip the /admin editor depends on.
 *
 * Shares one database with the other gateway suites (fileParallelism is off),
 * so every platform credential this file creates is removed again before it
 * ends — a leftover would make another file's `no_model_credential` case
 * silently dispatch instead.
 */

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");

const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

const BOOT = "creds-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };

// ADR-0034 amendment — these stand in for "some non-default endpoint". They
// are loopback literals rather than public hostnames on purpose: the guard
// RESOLVES every destination at write time, so a public hostname here would
// make this suite depend on DNS, and a `.invalid` one would fail closed.
// Port 1 is never listening — nothing is ever dispatched to them.
const XAI_BASE = "https://127.0.0.1:1/v1";
const BYO_BASE = "https://127.0.0.1:1/byo";
const DATA_KEY = "b".repeat(64);

let db: Db;
let app: ReturnType<typeof buildApp>;
let ninaId: string;
let ninaAuth: { authorization: string };
let ninaKeyId: string;
let ninaToken: string;
let agentId: string;

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });

  // ADR-0034 amendment — a credential `baseUrl` override is now behind the
  // egress guard, and the guard is DEFAULT-DENY: no allow entry, no
  // destination. This suite stores overrides pointed at a loopback address, so
  // it allow-lists that host explicitly with the private-range opt-in, exactly
  // as an air-gapped operator would (the same pattern as custom-providers.test.ts).
  const allowed = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/egress-allow-hosts",
    payload: {
      host: "127.0.0.1",
      allowPrivateRanges: true,
      allowPlaintextHttp: true,
      note: "credential-surface suite: local fake endpoints",
    },
  });
  expect(allowed.statusCode).toBe(201);

  const nina = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/users",
    payload: { email: "creds-nina@example.com", displayName: "Creds Nina" },
  });
  expect(nina.statusCode).toBe(201);
  ninaId = nina.json().id;

  const key = await app.inject({
    method: "POST",
    headers: AUTH,
    url: `/v1/users/${ninaId}/keys`,
    payload: { name: "portal" },
  });
  expect(key.statusCode).toBe(201);
  ninaKeyId = key.json().id;
  ninaToken = key.json().token;
  ninaAuth = { authorization: `Bearer ${ninaToken}` };

  const agent = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/agents",
    payload: {
      name: "creds-worker",
      provider: "mock",
      tier: 1,
      costPerMTokIn: 3,
      costPerMTokOut: 15,
      model: "mock-balanced",
    },
  });
  expect(agent.statusCode).toBe(201);
  agentId = agent.json().id;
  await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/grants/agents",
    payload: { userId: ninaId, agentId },
  });
});

describe("/admin platform model credentials", () => {
  it("adds, lists, rotates and removes a provider without ever echoing the key", async () => {
    // exactly what the Model Credentials form POSTs
    const created = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/model-credentials",
      payload: { provider: "xai", apiKey: "xai-portal-secret-1" },
    });
    expect(created.statusCode).toBe(201);
    expect(JSON.stringify(created.json())).not.toContain("xai-portal-secret-1");

    const listed = await app.inject({ method: "GET", headers: AUTH, url: "/v1/model-credentials" });
    expect(listed.statusCode).toBe(200);
    const row = listed
      .json()
      .credentials.find((c: { provider: string }) => c.provider === "xai");
    // the panel shows provider + endpoint + configured-at, and there is no
    // fourth field it could accidentally render
    expect(row).toBeTruthy();
    expect(row.createdAt).toBeTruthy();
    expect(Object.keys(row).sort()).toEqual(["baseUrl", "createdAt", "id", "provider"]);
    expect(JSON.stringify(listed.json())).not.toContain("xai-portal-secret-1");

    // re-posting the same provider is the rotate path: one row, new secret
    const rotated = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/model-credentials",
      payload: { provider: "xai", apiKey: "xai-portal-secret-2", baseUrl: XAI_BASE },
    });
    expect(rotated.statusCode).toBe(201);
    expect(rotated.json().id).toBe(created.json().id);
    expect(rotated.json().baseUrl).toBe(XAI_BASE);

    const stored = await db.select().from(modelCredentials);
    const xai = stored.find((c) => c.provider === "xai");
    expect(xai!.keyCiphertext).not.toContain("xai-portal-secret-2");

    // the remove button
    const removed = await app.inject({
      method: "DELETE",
      headers: AUTH,
      url: "/v1/model-credentials/xai",
    });
    expect(removed.statusCode).toBe(200);
    expect(removed.json().removed).toBe(true);

    const gone = await app.inject({
      method: "DELETE",
      headers: AUTH,
      url: "/v1/model-credentials/xai",
    });
    expect(gone.statusCode).toBe(404);
    expect(gone.json().error).toBe("unknown_credential");

    const after = await app.inject({ method: "GET", headers: AUTH, url: "/v1/model-credentials" });
    expect(after.json().credentials.some((c: { provider: string }) => c.provider === "xai")).toBe(
      false,
    );
  });

  it("keeps the platform surface admin-only, including the new remove path", async () => {
    const read = await app.inject({ method: "GET", headers: ninaAuth, url: "/v1/model-credentials" });
    expect(read.statusCode).toBe(403);
    const write = await app.inject({
      method: "POST",
      headers: ninaAuth,
      url: "/v1/model-credentials",
      payload: { provider: "xai", apiKey: "nope" },
    });
    expect(write.statusCode).toBe(403);
    const remove = await app.inject({
      method: "DELETE",
      headers: ninaAuth,
      url: "/v1/model-credentials/xai",
    });
    expect(remove.statusCode).toBe(403);
  });
});

describe("/app self-service BYO keys", () => {
  it("a non-admin adds, lists and removes their own key; the key itself never comes back", async () => {
    // the Settings form, called with the caller's own identity
    const added = await app.inject({
      method: "POST",
      headers: ninaAuth,
      url: `/v1/users/${ninaId}/model-credentials`,
      payload: { provider: "anthropic", apiKey: "sk-nina-own-key", baseUrl: BYO_BASE },
    });
    expect(added.statusCode).toBe(201);
    expect(JSON.stringify(added.json())).not.toContain("sk-nina-own-key");

    const listed = await app.inject({
      method: "GET",
      headers: ninaAuth,
      url: `/v1/users/${ninaId}/model-credentials`,
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().credentials).toHaveLength(1);
    expect(listed.json().credentials[0].provider).toBe("anthropic");
    expect(listed.json().credentials[0].baseUrl).toBe(BYO_BASE);
    expect(JSON.stringify(listed.json())).not.toContain("sk-nina-own-key");

    // ADR-0108: measured at TWO rows under the full suite — this table holds
    // every user's credential, not just Nina's. An unordered read could hand
    // back somebody else's row, and `not.toContain("sk-nina-own-key")` would
    // then pass without ever looking at the row it claims to be about. Pin the
    // row this test means; (user_id, provider) is
    // `user_model_credentials_user_provider_uq`, so this is provably single.
    const [stored] = await db
      .select()
      .from(userModelCredentials)
      .where(and(eq(userModelCredentials.userId, ninaId), eq(userModelCredentials.provider, "anthropic")));
    expect(stored!.keyCiphertext).not.toContain("sk-nina-own-key");

    // the admin's per-user viewer reads the same list
    const asAdmin = await app.inject({
      method: "GET",
      headers: AUTH,
      url: `/v1/users/${ninaId}/model-credentials`,
    });
    expect(asAdmin.statusCode).toBe(200);
    expect(asAdmin.json().credentials).toHaveLength(1);
    expect(JSON.stringify(asAdmin.json())).not.toContain("sk-nina-own-key");

    const removed = await app.inject({
      method: "DELETE",
      headers: ninaAuth,
      url: `/v1/users/${ninaId}/model-credentials/anthropic`,
    });
    expect(removed.statusCode).toBe(200);
    const empty = await app.inject({
      method: "GET",
      headers: ninaAuth,
      url: `/v1/users/${ninaId}/model-credentials`,
    });
    expect(empty.json().credentials).toHaveLength(0);
  });
});

describe("/admin API key issuance", () => {
  it("returns the plaintext exactly once, lists keys without it, and revokes", async () => {
    // the "issue key" row action
    const issued = await app.inject({
      method: "POST",
      headers: AUTH,
      url: `/v1/users/${ninaId}/keys`,
      payload: { name: "portal" },
    });
    expect(issued.statusCode).toBe(201);
    const secondToken = issued.json().token;
    expect(secondToken).toMatch(/^rgl_/);

    // the keys table: everything the panel renders, and no token anywhere
    const listed = await app.inject({ method: "GET", headers: AUTH, url: "/v1/keys" });
    expect(listed.statusCode).toBe(200);
    const mine = listed.json().keys.filter((k: { userId: string }) => k.userId === ninaId);
    expect(mine).toHaveLength(2);
    // ADR-0098 added `expiresAt` (null = never, the shipped default) and the
    // derived lifecycle `state` — still no token field of any kind.
    expect(Object.keys(mine[0]).sort()).toEqual([
      "createdAt",
      "expiresAt",
      "id",
      "lastUsedAt",
      "name",
      "revokedAt",
      "state",
      "userId",
    ]);
    expect(mine.every((k: { expiresAt: string | null }) => k.expiresAt === null)).toBe(true);
    expect(mine.every((k: { state: string }) => k.state === "active")).toBe(true);
    expect(listed.body).not.toContain(secondToken);
    expect(listed.body).not.toContain(ninaToken);

    // scoped read, as the panel would filter it
    const scoped = await app.inject({
      method: "GET",
      headers: AUTH,
      url: `/v1/keys?userId=${ninaId}`,
    });
    expect(scoped.json().keys).toHaveLength(2);

    // the revoke button
    const revoked = await app.inject({
      method: "POST",
      headers: AUTH,
      url: `/v1/keys/${issued.json().id}/revoke`,
      payload: {},
    });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json().revokedAt).toBeTruthy();

    const dead = await app.inject({
      method: "GET",
      headers: { authorization: `Bearer ${secondToken}` },
      url: "/v1/me",
    });
    expect(dead.statusCode).toBe(401);

    // revoking twice is a 404, not a silent success
    const again = await app.inject({
      method: "POST",
      headers: AUTH,
      url: `/v1/keys/${issued.json().id}/revoke`,
      payload: {},
    });
    expect(again.statusCode).toBe(404);

    // the key this suite authenticates with is untouched
    const alive = await app.inject({ method: "GET", headers: ninaAuth, url: "/v1/me" });
    expect(alive.statusCode).toBe(200);
    expect(alive.json().userId).toBe(ninaId);
    expect(ninaKeyId).toBeTruthy();
  });
});

describe("/admin agent-policy editor", () => {
  it("writes every field the form offers and reads them all back", async () => {
    const saved = await app.inject({
      method: "POST",
      headers: AUTH,
      url: `/v1/users/${ninaId}/agent-policy`,
      payload: {
        defaultAgentId: agentId,
        ceilingAgentId: agentId,
        routingMode: "passthrough",
        runBudgetUsd: 0.5,
        runBudgetBreachAction: "replan",
      },
    });
    expect(saved.statusCode).toBe(200);

    // the editor has to be able to show the stored values before changing
    // them — all five live on this read
    const view = await app.inject({
      method: "GET",
      headers: AUTH,
      url: `/v1/users/${ninaId}/agents`,
    });
    expect(view.statusCode).toBe(200);
    expect(view.json()).toMatchObject({
      defaultAgentId: agentId,
      ceilingAgentId: agentId,
      routingMode: "passthrough",
      runBudgetUsd: 0.5,
      runBudgetBreachAction: "replan",
    });

    // a form left on "leave unchanged" omits the field entirely
    const partial = await app.inject({
      method: "POST",
      headers: AUTH,
      url: `/v1/users/${ninaId}/agent-policy`,
      payload: { routingMode: "automatic" },
    });
    expect(partial.statusCode).toBe(200);
    const afterPartial = await app.inject({
      method: "GET",
      headers: AUTH,
      url: `/v1/users/${ninaId}/agents`,
    });
    expect(afterPartial.json()).toMatchObject({
      ceilingAgentId: agentId,
      routingMode: "automatic",
      runBudgetUsd: 0.5,
      runBudgetBreachAction: "replan",
    });

    // "— clear —" is the only way to null one out, and it must not touch
    // the neighbouring field
    const cleared = await app.inject({
      method: "POST",
      headers: AUTH,
      url: `/v1/users/${ninaId}/agent-policy`,
      payload: { defaultAgentId: null },
    });
    expect(cleared.statusCode).toBe(200);
    const afterClear = await app.inject({
      method: "GET",
      headers: AUTH,
      url: `/v1/users/${ninaId}/agents`,
    });
    expect(afterClear.json().defaultAgentId).toBeNull();
    expect(afterClear.json().ceilingAgentId).toBe(agentId);

    // a user reading their own policy sees it; nobody else's
    const own = await app.inject({
      method: "GET",
      headers: ninaAuth,
      url: `/v1/users/${ninaId}/agents`,
    });
    expect(own.statusCode).toBe(200);
    expect(own.json().runBudgetUsd).toBe(0.5);
  });

  it("reports an unset policy as nulls rather than inventing defaults", async () => {
    const fresh = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/users",
      payload: { email: "creds-owen@example.com", displayName: "Creds Owen" },
    });
    const view = await app.inject({
      method: "GET",
      headers: AUTH,
      url: `/v1/users/${fresh.json().id}/agents`,
    });
    expect(view.json()).toMatchObject({
      agents: [],
      defaultAgentId: null,
      ceilingAgentId: null,
      routingMode: null,
      runBudgetUsd: null,
      runBudgetBreachAction: null,
    });
  });
});
