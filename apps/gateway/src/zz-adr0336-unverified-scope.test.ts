/**
 * ADR-0336 decision 5 (slice 3) — a credential whose scope no API can check (OpenAI, n8n) is accepted only as a
 * recorded relaxation, on a real database through the real app:
 *
 *  - the stored-secret step-up and the enable step-up each name `credentialScope: "unverified"` in their binding: a
 *    grant confirmed without it is refused, so the admin confirms that relaxation itself;
 *  - the credential-stored and source-enabled audit rows carry the same field;
 *  - the source's API representation (and its credential's) carries `credentialScope: "unverified"`;
 *  - a kind whose scope is checked (Copilot Studio) keeps its bindings unchanged and reads `checked`.
 *
 * Global state (M-068): the family switch is restored, and every source and user this file creates is deleted.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { auditLog, authSessions, createDb, discoveryCredentials, discoverySettings, discoverySources, eq, inArray, runMigrations, stepUpGrants, users, type Db } from "@regulait/db";
import { DISCOVERY_STEP_UP_KEYS, discoveryCredentialScope, stepUpActionDigest } from "@regulait/shared";
import { buildApp } from "./app.js";
import { enableStepUpArgs, staticCredentialStepUpArgs } from "./discovery-routes.js";
import { scannerRegistry, type Scanner } from "./discovery-scanners.js";
import type { StepUpCheckArgs } from "./step-up.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { hashToken } from "./token-hash.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = Math.random().toString(36).slice(2, 8);
const BOOT = `r336u-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const CSRF = { "x-regulait-csrf": "1" };
const DATA_KEY = createHash("sha256").update(`r336u-data-key-${RUN}`).digest("hex");
const KEY = ["n8n", "api", "synthetic", RUN].join("_");

let db: Db;
let app: ReturnType<typeof buildApp>;
let adminId: string;
let adminKey: { authorization: string };
const restores: Array<() => Promise<void>> = [];
const sourceIds: string[] = [];

const stub = (kind: Scanner["kind"]): Scanner => ({ kind, requiresCredential: true, run: async () => ({ observations: [], registryAgents: [], registriesComplete: [], credentialWriteScope: "unverified" }) });
const registry = scannerRegistry([stub("agent_registry_n8n"), stub("agent_registry_copilot_studio")]);

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
const inject = (method: Method, url: string, headers: Record<string, string>, payload?: unknown) =>
  app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload: payload as object }) });

async function session(args: StepUpCheckArgs) {
  const sessionToken = "rgls_" + randomBytes(32).toString("hex");
  const [s] = await db
    .insert(authSessions)
    .values({ tokenHash: hashToken(sessionToken), userId: adminId, origin: "password", expiresAt: new Date(Date.now() + 3_600_000), idleExpiresAt: new Date(Date.now() + 3_600_000), idleMinutes: 60 })
    .returning({ id: authSessions.id });
  const stepUpToken = "rgsu_" + randomBytes(24).toString("hex");
  await db.insert(stepUpGrants).values({
    tokenHash: hashToken(stepUpToken),
    userId: adminId,
    sessionId: s!.id,
    method: "totp",
    actionKind: args.kind,
    actionDigest: stepUpActionDigest(args.kind, args.facts),
    expiresAt: new Date(Date.now() + 120_000),
  });
  return (method: Method, url: string, payload?: unknown) =>
    app.inject({ method, url, headers: { ...CSRF, "x-regulait-step-up": stepUpToken }, cookies: { regulait_session: sessionToken }, ...(payload === undefined ? {} : { payload: payload as object }) });
}

/** the binding a careless route would use: the same facts with the relaxation left out */
function withoutScope(args: StepUpCheckArgs): StepUpCheckArgs {
  const values = (args.facts as { values: Record<string, Record<string, unknown>> }).values;
  const [k] = Object.keys(values);
  const { credentialScope: _drop, ...rest } = values[k!]!;
  return { kind: args.kind, facts: { values: { [k!]: rest } } };
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restores.push(await relaxIdentityForTest(db, { mfaRequired: "off" }));
  const [s0] = await db.select().from(discoverySettings).where(eq(discoverySettings.id, 1));
  restores.push(async () => {
    await db.update(discoverySettings).set({ agentRegistrySourcesEnabled: s0!.agentRegistrySourcesEnabled }).where(eq(discoverySettings.id, 1));
  });
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY, discoveryScanners: registry });
  const u = await inject("POST", "/v1/users", AUTH, { email: `r336u-admin-${RUN}@example.com`, displayName: "r336u admin" });
  expect(u.statusCode, u.body).toBe(201);
  adminId = u.json().id as string;
  await db.update(users).set({ isAdmin: true }).where(eq(users.id, adminId));
  adminKey = { authorization: `Bearer ${(await inject("POST", `/v1/users/${adminId}/keys`, AUTH, { name: "k" })).json().token}` };
  await db.update(users).set({ totpEnabled: true }).where(eq(users.id, adminId));
  const v0 = (await db.select().from(discoverySettings).where(eq(discoverySettings.id, 1)))[0]!.version;
  const on = await session({ kind: "settings_relax", facts: { values: { [DISCOVERY_STEP_UP_KEYS.families]: ["agent_registry"] } } });
  const f = await on("PUT", "/v1/discovery/settings", { version: v0, families: { agent_registry: true } });
  // already on from another file is fine; anything else is not
  expect([200, 409], f.body).toContain(f.statusCode);
}, 120_000);

afterAll(async () => {
  if (sourceIds.length) {
    await db.update(discoverySources).set({ enabled: false }).where(inArray(discoverySources.id, sourceIds));
    await db.delete(discoverySources).where(inArray(discoverySources.id, sourceIds));
  }
  if (adminId) await db.update(users).set({ totpEnabled: false }).where(eq(users.id, adminId));
  for (const r of restores.reverse()) await r();
  await app?.close();
});

describe("ADR-0336 decision 5: credentialScope unverified is a recorded relaxation", () => {
  it("the declared kinds: OpenAI and n8n unverified, the rest checked", () => {
    expect(discoveryCredentialScope("agent_registry_openai")).toBe("unverified");
    expect(discoveryCredentialScope("agent_registry_n8n")).toBe("unverified");
    expect(discoveryCredentialScope("agent_registry_copilot_studio")).toBe("checked");
    expect(discoveryCredentialScope("repo_github")).toBe("checked");
    // a checked kind's bindings are unchanged: no credentialScope key at all
    expect(JSON.stringify(enableStepUpArgs("s", "agent_registry_copilot_studio", {}, {}, null))).not.toContain("credentialScope");
    expect(JSON.stringify(staticCredentialStepUpArgs("s", "agent_registry_copilot_studio", null))).not.toContain("credentialScope");
  });

  it("an n8n key is stored and enabled only with step-ups that name the unverified scope; audit rows and the API say so", async () => {
    const c = await inject("POST", "/v1/discovery/sources", adminKey, { name: `n8n-${RUN}`, kind: "agent_registry_n8n", target: { baseUrl: "https://acme.app.n8n.cloud" }, scope: { orgLevel: true, include: [] } });
    expect(c.statusCode, c.body).toBe(201);
    const s = c.json() as { id: string; version: number; kind: string; target: Record<string, string>; scope: unknown; credentialScope: string };
    sourceIds.push(s.id);
    expect(s.credentialScope).toBe("unverified");
    const body = { mode: "static", publicConfig: {}, secret: KEY, replacesCredentialId: null };

    // storing: a grant bound without the relaxation is refused, the full binding passes
    const storeArgs = staticCredentialStepUpArgs(s.id, s.kind, null);
    expect(JSON.stringify(storeArgs)).toContain('"credentialScope":"unverified"');
    const bad = await (await session(withoutScope(storeArgs)))("PUT", `/v1/discovery/sources/${s.id}/credential`, body);
    expect(bad.statusCode, bad.body).toBe(403);
    expect(await db.select().from(discoveryCredentials).where(eq(discoveryCredentials.sourceId, s.id))).toHaveLength(0);
    const ok = await (await session(storeArgs))("PUT", `/v1/discovery/sources/${s.id}/credential`, body);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({ mode: "static", hasSecret: true, writeScope: "unverified", credentialScope: "unverified" });
    expect(ok.body).not.toContain(KEY);
    const credId = ok.json().id as string;
    const [stored] = await db.select().from(auditLog).where(eq(auditLog.objectId, credId));
    expect(stored!.detail).toMatchObject({ kind: "agent_registry_n8n", credentialScope: "unverified" });

    // enabling: the same rule
    const enArgs = enableStepUpArgs(s.id, s.kind, s.target, s.scope, credId);
    const badEn = await (await session(withoutScope(enArgs)))("POST", `/v1/discovery/sources/${s.id}/enable`, { version: s.version });
    expect(badEn.statusCode, badEn.body).toBe(403);
    const en = await (await session(enArgs))("POST", `/v1/discovery/sources/${s.id}/enable`, { version: s.version });
    expect(en.statusCode, en.body).toBe(200);
    expect(en.json()).toMatchObject({ enabled: true, credentialScope: "unverified", credential: { credentialScope: "unverified" } });
    const enabledRows = (await db.select().from(auditLog).where(eq(auditLog.objectId, s.id))).filter((r) => (r.detail as { credentialScope?: string } | null)?.credentialScope === "unverified");
    expect(enabledRows.length).toBeGreaterThanOrEqual(1);

    // the list representation carries it too
    const list = await inject("GET", "/v1/discovery/sources", adminKey);
    const mine = (list.json().sources as Array<{ id: string; credentialScope: string }>).find((x) => x.id === s.id);
    expect(mine?.credentialScope).toBe("unverified");
  });

  it("a checked kind (Copilot Studio) reads checked in the API", async () => {
    const c = await inject("POST", "/v1/discovery/sources", adminKey, { name: `cs-${RUN}`, kind: "agent_registry_copilot_studio", target: { tenantId: "00000000-0000-4000-8000-000000000336", orgUrls: "https://contoso.crm4.dynamics.com" }, scope: { orgLevel: true, include: [] } });
    expect(c.statusCode, c.body).toBe(201);
    sourceIds.push(c.json().id as string);
    expect(c.json().credentialScope).toBe("checked");
  });
});
