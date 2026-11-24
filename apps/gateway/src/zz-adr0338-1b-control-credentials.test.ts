/**
 * ADR-0338 slice 1b — a source's vendor CONTROL credential and the Copilot Studio control, on a real database with a
 * fake Entra and a fake Power Platform API behind the guarded fetch (fixtures only, no live tenant).
 *
 *  - THE TABLE: `purpose` defaults to `discovery_read` and is fixed at insert; `delegated` only on a `platform_write`
 *    row, with an expiry at most 90 days out and a secret; a `platform_write` row stays `unverified`; one live row per
 *    source AND purpose; the guard refuses any change but revoke, the write-scope verdict and a re-encrypted secret;
 *    a revoked row is never revived; TRUNCATE is refused.
 *  - THE PURPOSES NEVER CROSS: the scanner and the read-credential routes see only the read row; the control resolver
 *    sees only the `platform_write` row.
 *  - THE ROUTES: storing needs a `settings_relax` step-up bound to source, mode, app and the row replaced; the write
 *    app must be in the source's tenant and must not be the read app; delegated is not connectable yet; revoke is free.
 *  - THE RESOLVER: the delegated opt-in (off by default, a step-up) and the expiry; a federated token is asserted for
 *    the CONTROL subject only, through the guarded fetch.
 *  - END TO END: request (needs the record's environment id), approve, execute: the token is obtained before anything
 *    moves (a token failure moves nothing and sends nothing), then the documented quarantine calls; restore reverses it.
 *  - THE CONTRACT: every registered control shape-checks and path-encodes the vendor-reported ids.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  agentRegistryRecords,
  approvals,
  auditLog,
  createDb,
  discoveryCredentials,
  discoveryRuns,
  discoverySettings,
  discoverySources,
  egressAllowHosts,
  eq,
  inArray,
  orgSettings,
  ORG_SETTINGS_ID,
  runMigrations,
  sql,
  users,
  vendorAgentActions,
  type Db,
} from "@regulait/db";
import { BATCH4_STRICT_DEFAULTS, DISCOVERY_STEP_UP_KEYS, FEDERATION_AUDIENCES } from "@regulait/shared";
import { buildApp } from "./app.js";
import { AGENT_PLATFORM_CONTROLS } from "./agent-platform-adapters.js";
import { COPILOT_STUDIO_CONTROL, copilotStudioControlUrl, POWER_PLATFORM_API_SCOPE } from "./agent-platform-copilot-studio-control.js";
import { discoveryPosture } from "./discovery-posture.js";
import { scannerRegistry, type ScanCredential } from "./discovery-scanners.js";
import { runDiscoveryPass } from "./discovery-worker.js";
import { createGuardedFetch } from "./egress-guard.js";
import { decryptSecret, encryptSecret } from "./secrets.js";
import type { StepUpCheckArgs } from "./step-up.js";
import { grantSpent, grantStepUpForTest, sessionRequest, stepUpRequest } from "./testing/step-up-grant.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { removeEgressAllowEntry } from "./testing/egress-allow-cleanup.js";
import { relaxStepUpAround } from "./testing/step-up-posture.js";
import { requestActionSchema, vendorControlDecideStepUp, vendorControlExecuteStepUp, vendorControlRequestStepUp } from "./vendor-agent-control.js";
import { ControlTokenError, controlCredentialResolver, controlCredentialSchema, controlCredentialStepUp } from "./vendor-agent-control-credentials.js";
import type { VendorAgentRef } from "./vendor-agent-control-contract.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = randomBytes(3).toString("hex");
const BOOT = `a338b-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
// synthetic, derived at runtime: never a secret-shaped literal
const DATA_KEY = createHash("sha256").update(`a338b-data-key-${RUN}`).digest("hex");
const CLIENT_SECRET = `a338b-client-${randomBytes(12).toString("hex")}`;
const ACCESS_TOKEN = `a338b-access-${randomBytes(12).toString("hex")}`;
const TENANT = "00000000-0000-4000-8000-000000000338";
const READ_APP = "00000000-0000-4000-8000-0000000000a1";
const WRITE_APP = "00000000-0000-4000-8000-0000000000b2";
const ENV_ID = "e1000000-0000-4000-8000-000000000338";
const ORG_HOST = "contoso.crm4.dynamics.com";
const PP = "https://api.powerplatform.com";
const URL_ = "/v1/vendor-agent-control/actions";
const credUrl = (sourceId: string) => `/v1/discovery/sources/${sourceId}/control-credential`;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const urlOf = (input: string | URL | Request) => new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);

// ---- the fake vendor: Entra (instance discovery, OIDC metadata, token) and the Power Platform quarantine API ----
const vendor = {
  quarantined: new Map<string, boolean>(),
  tokenStatus: 200,
  tokenBodies: [] as URLSearchParams[],
  ppCalls: [] as Array<{ method: string; url: URL; auth: string | null }>,
};
const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = urlOf(input);
  const method = (init?.method ?? "GET").toUpperCase();
  if (url.hostname === "login.microsoftonline.com") {
    if (url.pathname.endsWith("/discovery/instance")) {
      return json({
        tenant_discovery_endpoint: `https://login.microsoftonline.com/${TENANT}/v2.0/.well-known/openid-configuration`,
        "api-version": "1.1",
        metadata: [{ preferred_network: "login.microsoftonline.com", preferred_cache: "login.windows.net", aliases: ["login.microsoftonline.com", "login.windows.net"] }],
      });
    }
    if (url.pathname.endsWith("/.well-known/openid-configuration")) {
      return json({
        token_endpoint: `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`,
        authorization_endpoint: `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/authorize`,
        issuer: `https://login.microsoftonline.com/${TENANT}/v2.0`,
        end_session_endpoint: `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/logout`,
        jwks_uri: `https://login.microsoftonline.com/${TENANT}/discovery/v2.0/keys`,
      });
    }
    if (url.pathname.endsWith("/oauth2/v2.0/token")) {
      vendor.tokenBodies.push(new URLSearchParams(String(init?.body ?? "")));
      if (vendor.tokenStatus !== 200) return json({ error: "invalid_client", error_description: "AADSTS7000215: Invalid client secret provided." }, vendor.tokenStatus);
      return json({ token_type: "Bearer", expires_in: 3600, ext_expires_in: 3600, access_token: ACCESS_TOKEN });
    }
  }
  if (url.origin === PP) {
    vendor.ppCalls.push({ method, url, auth: new Headers(init?.headers).get("authorization") });
    const m = /^\/copilotstudio\/environments\/([^/]+)\/bots\/([^/]+)\/api\/botQuarantine(\/SetAsQuarantined|\/SetAsUnquarantined)?$/.exec(url.pathname);
    if (!m || url.searchParams.get("api-version") !== "1") return json({}, 404);
    const key = `${m[1]}/${m[2]}`;
    if (!m[3] && method === "GET") return json({ isBotQuarantined: vendor.quarantined.get(key) ?? false, lastUpdateTimeUtc: "2026-11-20T00:00:00Z" });
    if (m[3] && method === "POST") {
      vendor.quarantined.set(key, m[3] === "/SetAsQuarantined");
      return json({ isBotQuarantined: vendor.quarantined.get(key) });
    }
  }
  return json({}, 404);
}) as typeof fetch;
const resolve = async () => [{ address: "20.190.0.1", family: 4 }];

let db: Db;
let app: ReturnType<typeof buildApp>;
let adminId: string;
let approverId: string;
let adminKey: { authorization: string };
const restores: Array<() => Promise<unknown>> = [];
const sourceIds: string[] = [];
/** the egress allow entries this suite created (none when another suite's row already allows the host) */
const egressAllowIds: string[] = [];

type Method = "GET" | "POST" | "PUT" | "DELETE";
async function as(who: string, args: StepUpCheckArgs | null, method: Method, url: string, payload?: unknown) {
  const g = await grantStepUpForTest(db, who, args ?? { kind: "settings_relax", facts: { unused: RUN } });
  const r = args ? stepUpRequest(g) : sessionRequest(g);
  const res = await app.inject({ method, url, headers: r.headers, cookies: r.cookies, ...(payload === undefined ? {} : { payload: payload as object }) });
  return { res, grantId: g.grantId };
}

/** a Copilot Studio source and one staged agent on it; `environmentId` false = the record has no locator */
async function seedCopilot(opts: { environmentId?: boolean } = {}) {
  const [src] = await db
    .insert(discoverySources)
    .values({ name: `a338b-${RUN}-${randomUUID().slice(0, 8)}`, kind: "agent_registry_copilot_studio", target: { tenantId: TENANT, orgUrls: `https://${ORG_HOST}` }, scope: { orgLevel: true, include: [] }, createdBy: adminId, enabled: false })
    .returning({ id: discoverySources.id });
  sourceIds.push(src!.id);
  const botId = randomUUID();
  const [rec] = await db
    .insert(agentRegistryRecords)
    .values({ sourceId: src!.id, registry: "copilot_studio", externalId: `${ORG_HOST}/${botId}`, displayName: `a338b agent ${RUN}`, vendorAttributes: opts.environmentId === false ? { environment: ORG_HOST } : { environment: ORG_HOST, environmentId: ENV_ID } })
    .returning({ id: agentRegistryRecords.id });
  return { sourceId: src!.id, recordId: rec!.id, botId };
}
const putBody = (b: Record<string, unknown> = {}) => ({ mode: "static", publicConfig: { tenantId: TENANT, clientId: WRITE_APP }, secret: CLIENT_SECRET, replacesCredentialId: null, ...b });
async function storeCredential(sourceId: string, b: Record<string, unknown> = {}, expected = 201) {
  const payload = putBody(b);
  const { res, grantId } = await as(adminId, controlCredentialStepUp(sourceId, controlCredentialSchema.parse(payload)), "PUT", credUrl(sourceId), payload);
  expect(res.statusCode, res.body).toBe(expected);
  return { res, grantId };
}
const insertCred = (v: Partial<typeof discoveryCredentials.$inferInsert> & { sourceId: string }) =>
  db.insert(discoveryCredentials).values({ credentialMode: "federated", publicConfig: { tenantId: TENANT, clientId: READ_APP }, createdBy: adminId, ...v }).returning();
async function pgError(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    const c = (e as { cause?: { constraint?: string; message?: string } }).cause;
    return c?.constraint ?? c?.message ?? String(e);
  }
  return "no error";
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restores.push(await relaxIdentityForTest(db, { mfaRequired: "off" }));
  const [s0] = await db.select().from(discoverySettings).where(eq(discoverySettings.id, 1));
  restores.push(() =>
    db
      .update(discoverySettings)
      .set({ vendorAgentControlEnabled: s0!.vendorAgentControlEnabled, vendorAgentControlDelegatedEnabled: s0!.vendorAgentControlDelegatedEnabled, agentRegistrySourcesEnabled: s0!.agentRegistrySourcesEnabled })
      .where(eq(discoverySettings.id, 1)),
  );
  const [o0] = await db.select().from(orgSettings).where(eq(orgSettings.id, ORG_SETTINGS_ID));
  restores.push(() => db.update(orgSettings).set({ stepUpMode: o0!.stepUpMode, stepUpActions: o0!.stepUpActions, executionMode: o0!.executionMode, executionModeReason: o0!.executionModeReason }).where(eq(orgSettings.id, ORG_SETTINGS_ID)));
  // the production control map and resolver; only the guarded fetch's transport and DNS are test seams
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY, vendorAgentControl: { fetchImpl: fakeFetch, resolve } });
  await app.ready();
  for (const host of ["api.powerplatform.com", "login.microsoftonline.com"]) {
    const [existing] = await db.select().from(egressAllowHosts).where(eq(egressAllowHosts.host, host));
    if (existing) continue;
    const allow = await relaxStepUpAround(db, () => app.inject({ method: "POST", url: "/v1/egress-allow-hosts", headers: AUTH, payload: { host, note: `ADR-0338 slice 1b suite: the fake ${host}` } }));
    expect([200, 201], allow.body).toContain(allow.statusCode);
    egressAllowIds.push(allow.json().id);
  }
  await db.update(orgSettings).set({ stepUpMode: "required", stepUpActions: [...BATCH4_STRICT_DEFAULTS.stepUpActions], executionMode: "normal", executionModeReason: null }).where(eq(orgSettings.id, ORG_SETTINGS_ID));
  const ids: string[] = [];
  for (const who of ["admin", "approver"]) {
    const u = await app.inject({ method: "POST", url: "/v1/users", headers: AUTH, payload: { email: `a338b-${who}-${RUN}@example.com`, displayName: `a338b ${who}` } });
    expect(u.statusCode, u.body).toBe(201);
    await db.update(users).set({ isAdmin: true, totpEnabled: true }).where(eq(users.id, u.json().id));
    ids.push(u.json().id);
  }
  [adminId, approverId] = ids as [string, string];
  adminKey = { authorization: `Bearer ${(await app.inject({ method: "POST", url: `/v1/users/${adminId}/keys`, headers: AUTH, payload: { name: "k" } })).json().token}` };
  await db.update(discoverySettings).set({ vendorAgentControlEnabled: true }).where(eq(discoverySettings.id, 1));
}, 120_000);

afterAll(async () => {
  const removals = [];
  for (const id of egressAllowIds) removals.push(await removeEgressAllowEntry(app, AUTH, { id }));
  try {
    await teardown();
  } finally {
    for (const r of removals) r.assertRemoved();
  }
});
async function teardown() {
  if (db) {
    if (sourceIds.length) {
      const recs = await db.select({ id: agentRegistryRecords.id }).from(agentRegistryRecords).where(inArray(agentRegistryRecords.sourceId, sourceIds));
      if (recs.length) {
        const rows = await db.select({ id: vendorAgentActions.id, approvalId: vendorAgentActions.approvalId }).from(vendorAgentActions).where(inArray(vendorAgentActions.recordId, recs.map((r) => r.id)));
        if (rows.length) {
          await db.delete(vendorAgentActions).where(sql`${vendorAgentActions.id} IN (${sql.join(rows.map((r) => sql`${r.id}`), sql`, `)}) AND ${vendorAgentActions.reversesActionId} IS NOT NULL`);
          await db.delete(vendorAgentActions).where(inArray(vendorAgentActions.id, rows.map((r) => r.id)));
          await db.delete(approvals).where(inArray(approvals.id, rows.map((r) => r.approvalId)));
        }
      }
      await db.delete(discoverySources).where(inArray(discoverySources.id, sourceIds));
    }
    for (const id of [adminId, approverId]) if (id) await db.update(users).set({ totpEnabled: false }).where(eq(users.id, id));
    for (const r of restores.reverse()) await r();
  }
  await app?.close();
}

// ---------------------------------------------------------------------------------------------------------------------
describe("ADR-0338 slice 1b: the table holds the rules", () => {
  it("purpose defaults to discovery_read; delegated only on a platform_write row with an expiry and a secret", async () => {
    const { sourceId } = await seedCopilot();
    const [read] = await insertCred({ sourceId });
    expect(read!.purpose).toBe("discovery_read");
    expect(await pgError(db.execute(sql`INSERT INTO discovery_credentials (source_id, credential_mode, public_config, created_by, purpose) VALUES (${sourceId}, 'federated', '{}'::jsonb, ${adminId}, 'admin')`))).toBe("discovery_credentials_purpose_check");
    const cipher = encryptSecret(DATA_KEY, "refresh");
    // delegated on a read row, without an expiry, past 90 days, without a secret: all refused
    expect(await pgError(insertCred({ sourceId: (await seedCopilot()).sourceId, credentialMode: "delegated", secretCiphertext: cipher, expiresAt: new Date(Date.now() + 86_400_000) }))).toBe("discovery_credentials_delegated_check");
    expect(await pgError(insertCred({ sourceId, purpose: "platform_write", credentialMode: "delegated", secretCiphertext: cipher }))).toBe("discovery_credentials_delegated_check");
    expect(await pgError(insertCred({ sourceId, purpose: "platform_write", credentialMode: "delegated", secretCiphertext: cipher, expiresAt: new Date(Date.now() + 91 * 86_400_000) }))).toBe("discovery_credentials_delegated_check");
    expect(await pgError(insertCred({ sourceId, purpose: "platform_write", credentialMode: "delegated", expiresAt: new Date(Date.now() + 86_400_000) }))).toBe("discovery_credentials_delegated_check");
    // a platform_write row stays unverified: the scanner's read-only verdict never applies to it
    expect(await pgError(insertCred({ sourceId, purpose: "platform_write", writeScope: "read_only" }))).toBe("discovery_credentials_write_purpose_scope_check");
  });

  it("one live row per source and purpose: a read and a control row live side by side, a second of either is refused", async () => {
    const { sourceId } = await seedCopilot();
    await insertCred({ sourceId });
    await insertCred({ sourceId, purpose: "platform_write", publicConfig: { tenantId: TENANT, clientId: WRITE_APP } });
    expect(await pgError(insertCred({ sourceId }))).toBe("discovery_credentials_live_uq");
    expect(await pgError(insertCred({ sourceId, purpose: "platform_write" }))).toBe("discovery_credentials_live_uq");
  });

  it("the guard: purpose, mode, config and expiry are fixed; revoke, the write-scope verdict and a re-encrypted secret are not; a revoked row stays revoked", async () => {
    const { sourceId } = await seedCopilot();
    const [row] = await insertCred({ sourceId, credentialMode: "static", secretCiphertext: encryptSecret(DATA_KEY, "s1") });
    const upd = (set: Record<string, unknown>) => db.update(discoveryCredentials).set(set).where(eq(discoveryCredentials.id, row!.id));
    for (const set of [{ purpose: "platform_write" }, { credentialMode: "federated" }, { publicConfig: { tenantId: TENANT, clientId: WRITE_APP } }, { expiresAt: new Date(Date.now() + 86_400_000) }, { sourceId: (await seedCopilot()).sourceId }]) {
      expect(await pgError(upd(set)), JSON.stringify(set)).toMatch(/only gains its revocation/);
    }
    await upd({ secretCiphertext: encryptSecret(DATA_KEY, "s2") });
    await upd({ writeScope: "read_only" });
    await upd({ revokedAt: new Date(), revokedBy: adminId, secretCiphertext: null });
    expect(await pgError(upd({ revokedAt: null, revokedBy: null }))).toMatch(/only gains its revocation/);
    const trunc = await db.$client.connect();
    try {
      await trunc.query("BEGIN");
      await expect(trunc.query("TRUNCATE TABLE discovery_credentials CASCADE")).rejects.toThrow();
    } finally {
      await trunc.query("ROLLBACK");
      trunc.release();
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("ADR-0338 slice 1b: the purposes never cross", () => {
  it("the read-credential routes and the discovery list see only the read row", async () => {
    const { sourceId } = await seedCopilot();
    await insertCred({ sourceId, purpose: "platform_write", publicConfig: { tenantId: TENANT, clientId: WRITE_APP } });
    const list = await app.inject({ method: "GET", url: "/v1/discovery/sources", headers: adminKey });
    expect(list.statusCode, list.body).toBe(200);
    const mine = (list.json().sources as Array<{ id: string; credential: unknown }>).find((s) => s.id === sourceId)!;
    expect(mine.credential).toBeNull();
    const del = await app.inject({ method: "DELETE", url: `/v1/discovery/sources/${sourceId}/credential`, headers: adminKey });
    expect(del.statusCode).toBe(404);
    expect(del.json().error).toBe("no_credential");
  });

  it("the scanner never receives the control credential: with only a control row the run fails credential_missing", async () => {
    await db.update(discoverySettings).set({ agentRegistrySourcesEnabled: true }).where(eq(discoverySettings.id, 1));
    const seen: Array<ScanCredential | null> = [];
    const registry = scannerRegistry([{ kind: "agent_registry_copilot_studio", requiresCredential: true, run: async (ctx) => (seen.push(ctx.credential), { observations: [], credentialWriteScope: "read_only" }) }]);
    const { sourceId } = await seedCopilot();
    await db.update(discoverySources).set({ enabled: true, enabledAt: new Date(), enabledBy: adminId }).where(eq(discoverySources.id, sourceId));
    await insertCred({ sourceId, purpose: "platform_write", credentialMode: "static", publicConfig: { tenantId: TENANT, clientId: WRITE_APP }, secretCiphertext: encryptSecret(DATA_KEY, CLIENT_SECRET) });
    const [r1] = await db.insert(discoveryRuns).values({ sourceId, trigger: "manual", sourceVersion: 1, kind: "agent_registry_copilot_studio" }).returning();
    await runDiscoveryPass(db, { registry, dataKey: DATA_KEY, owner: `a338b-1-${RUN}`, limit: 20 });
    const [done1] = await db.select().from(discoveryRuns).where(eq(discoveryRuns.id, r1!.id));
    expect(done1).toMatchObject({ status: "failed", errorCode: "credential_missing" });
    expect(seen).toEqual([]);
    // with a read row too, the scanner gets the READ app, never the control app or its secret
    await insertCred({ sourceId, credentialMode: "federated", publicConfig: { tenantId: TENANT, clientId: READ_APP } });
    const [r2] = await db.insert(discoveryRuns).values({ sourceId, trigger: "manual", sourceVersion: 1, kind: "agent_registry_copilot_studio" }).returning();
    await runDiscoveryPass(db, { registry, dataKey: DATA_KEY, owner: `a338b-2-${RUN}`, limit: 20 });
    expect((await db.select().from(discoveryRuns).where(eq(discoveryRuns.id, r2!.id)))[0]!.status).toBe("succeeded");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ mode: "federated", publicConfig: { clientId: READ_APP }, secret: null });
    // the verdict lands on the read row only; the control row stays unverified
    const rows = await db.select().from(discoveryCredentials).where(eq(discoveryCredentials.sourceId, sourceId));
    expect(Object.fromEntries(rows.filter((r) => !r.revokedAt).map((r) => [r.purpose, r.writeScope]))).toEqual({ discovery_read: "read_only", platform_write: "unverified" });
    await db.update(discoverySources).set({ enabled: false }).where(eq(discoverySources.id, sourceId));
  });

  it("the control resolver sees only the platform_write row", async () => {
    const { sourceId } = await seedCopilot();
    await insertCred({ sourceId, credentialMode: "static", secretCiphertext: encryptSecret(DATA_KEY, CLIENT_SECRET) });
    const resolver = controlCredentialResolver({ dataKey: DATA_KEY, fetch: async () => fakeFetch });
    expect(await resolver(db, sourceId, COPILOT_STUDIO_CONTROL)).toMatchObject({ ok: false, code: "no_control_credential" });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("ADR-0338 slice 1b: storing, reading and revoking a control credential", () => {
  it("storing is a settings_relax step-up bound to it; the secret is encrypted and never returned; it is audited", async () => {
    const { sourceId } = await seedCopilot();
    const payload = putBody();
    const none = await as(adminId, null, "PUT", credUrl(sourceId), payload);
    expect(none.res.statusCode, none.res.body).toBe(403);
    // a grant for another app is not this store's grant
    const other = await as(adminId, controlCredentialStepUp(sourceId, controlCredentialSchema.parse(putBody({ publicConfig: { tenantId: TENANT, clientId: READ_APP } }))), "PUT", credUrl(sourceId), payload);
    expect(other.res.statusCode, other.res.body).toBe(403);
    expect(await grantSpent(db, other.grantId)).toBe(false);
    const { res, grantId } = await storeCredential(sourceId);
    expect(await grantSpent(db, grantId)).toBe(true);
    const view = res.json().credential;
    expect(view).toMatchObject({ purpose: "platform_write", mode: "static", publicConfig: { tenantId: TENANT, clientId: WRITE_APP }, hasSecret: true, controlScope: "unverified", usable: true, expiresAt: null });
    expect(res.body).not.toContain(CLIENT_SECRET);
    const [row] = await db.select().from(discoveryCredentials).where(eq(discoveryCredentials.id, view.id));
    expect(row!.purpose).toBe("platform_write");
    expect(decryptSecret(DATA_KEY, row!.secretCiphertext!)).toBe(CLIENT_SECRET);
    const got = await app.inject({ method: "GET", url: credUrl(sourceId), headers: adminKey });
    expect(got.statusCode).toBe(200);
    expect(got.body).not.toContain(CLIENT_SECRET);
    expect(got.body).not.toContain(row!.secretCiphertext!);
    const [a] = await db.select().from(auditLog).where(sql`${auditLog.objectId} = ${view.id} AND ${auditLog.ruleId} = 'vendor-control-credential-stored'`);
    expect(a!.detail).toMatchObject({ sourceId, mode: "static", clientId: WRITE_APP, purpose: "platform_write" });
    expect(JSON.stringify(a!.detail)).not.toContain(CLIENT_SECRET);
    // replacing names the live row; revoking is free, destroys the secret and is audited
    expect((await storeCredential(sourceId, {}, 409)).res.json().error).toBe("credential_conflict");
    const replaced = await storeCredential(sourceId, { mode: "federated", secret: undefined, replacesCredentialId: view.id });
    expect((await db.select().from(discoveryCredentials).where(eq(discoveryCredentials.id, view.id)))[0]).toMatchObject({ secretCiphertext: null, revokedBy: adminId });
    const del = await as(adminId, null, "DELETE", credUrl(sourceId));
    expect(del.res.statusCode, del.res.body).toBe(200);
    expect(del.res.json().revoked).toBe(replaced.res.json().credential.id);
    expect((await app.inject({ method: "GET", url: credUrl(sourceId), headers: adminKey })).statusCode).toBe(404);
  });

  it("refuses delegated (not connectable yet), another tenant, the read app, a federated secret and a source with no control", async () => {
    const { sourceId } = await seedCopilot();
    await insertCred({ sourceId, publicConfig: { tenantId: TENANT, clientId: READ_APP } });
    const refusedWith = async (b: Record<string, unknown>, status: number, error: string, sid = sourceId) => {
      const payload = putBody(b);
      const { res } = await as(adminId, controlCredentialStepUp(sid, controlCredentialSchema.parse(payload)), "PUT", credUrl(sid), payload);
      expect(res.statusCode, res.body).toBe(status);
      expect(res.json().error).toBe(error);
    };
    await refusedWith({ mode: "delegated" }, 409, "delegated_connect_not_available");
    await refusedWith({ publicConfig: { tenantId: "00000000-0000-4000-8000-00000000ffff", clientId: WRITE_APP } }, 400, "credential_target_mismatch");
    await refusedWith({ publicConfig: { tenantId: TENANT, clientId: READ_APP } }, 400, "write_app_is_read_app");
    await refusedWith({ mode: "federated" }, 400, "federated_has_no_secret");
    await refusedWith({ mode: "static", secret: undefined }, 400, "secret_required");
    // an Entra Agent ID source: its registry declares no control (slice 2)
    const [entra] = await db
      .insert(discoverySources)
      .values({ name: `a338b-entra-${RUN}`, kind: "agent_registry_entra", target: { tenantId: TENANT }, scope: { orgLevel: true, include: [] }, createdBy: adminId, enabled: false })
      .returning({ id: discoverySources.id });
    sourceIds.push(entra!.id);
    await refusedWith({}, 409, "control_not_offered", entra!.id);
    // an unknown member of the body is refused before anything else
    const bad = await as(adminId, null, "PUT", credUrl(sourceId), { ...putBody(), token: "x" });
    expect(bad.res.statusCode).toBe(400);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("ADR-0338 slice 1b: the resolver", () => {
  it("delegated: off by default (a step-up to turn on, free to turn off), refused once expired, and not usable for a token yet", async () => {
    const { sourceId } = await seedCopilot();
    const resolver = controlCredentialResolver({ dataKey: DATA_KEY, fetch: async () => fakeFetch });
    const [row] = await insertCred({ sourceId, purpose: "platform_write", credentialMode: "delegated", publicConfig: { tenantId: TENANT, clientId: WRITE_APP }, secretCiphertext: encryptSecret(DATA_KEY, "refresh"), expiresAt: new Date(Date.now() + 86_400_000) });
    await db.update(discoverySettings).set({ vendorAgentControlDelegatedEnabled: false }).where(eq(discoverySettings.id, 1));
    expect(await resolver(db, sourceId, COPILOT_STUDIO_CONTROL)).toMatchObject({ ok: false, code: "credential_mode_disabled" });
    // turning the opt-in on is a settings_relax step-up bound to its key; off is free
    const v = async () => (await app.inject({ method: "GET", url: "/v1/discovery/settings", headers: adminKey })).json().version as number;
    expect((await as(adminId, null, "PUT", "/v1/discovery/settings", { version: await v(), vendorAgentControlDelegated: true })).res.statusCode).toBe(403);
    const step: StepUpCheckArgs = { kind: "settings_relax", facts: { values: { [DISCOVERY_STEP_UP_KEYS.vendorAgentControlDelegated]: true } } };
    const on = await as(adminId, step, "PUT", "/v1/discovery/settings", { version: await v(), vendorAgentControlDelegated: true });
    expect(on.res.statusCode, on.res.body).toBe(200);
    expect(on.res.json().vendorAgentControlDelegated).toBe(true);
    const ok = await resolver(db, sourceId, COPILOT_STUDIO_CONTROL);
    expect(ok.ok).toBe(true);
    if (ok.ok) await expect(ok.credential.acquire(AbortSignal.timeout(5000))).rejects.toMatchObject({ code: "delegated_connect_not_available" });
    // the posture lists it as a finding, and never as a read credential
    const posture = await discoveryPosture(db);
    expect(posture.delegatedControlCredentials).toContainEqual(expect.objectContaining({ sourceId, usable: true }));
    expect(posture.writeScopeUnverified.map((s) => s.sourceId)).not.toContain(sourceId);
    // a control mode the vendor does not accept is refused
    expect(await resolver(db, sourceId, { ...COPILOT_STUDIO_CONTROL, acceptedModes: ["federated"] })).toMatchObject({ ok: false, code: "credential_mode_not_accepted" });
    // expired (stored 10 days ago, expiring yesterday): refused
    await db.update(discoveryCredentials).set({ revokedAt: new Date(), revokedBy: adminId, secretCiphertext: null }).where(eq(discoveryCredentials.id, row!.id));
    await db.execute(sql`INSERT INTO discovery_credentials (source_id, purpose, credential_mode, public_config, secret_ciphertext, created_by, created_at, expires_at)
      VALUES (${sourceId}, 'platform_write', 'delegated', ${JSON.stringify({ tenantId: TENANT, clientId: WRITE_APP })}::jsonb, ${encryptSecret(DATA_KEY, "refresh")}, ${adminId}, now() - interval '10 days', now() - interval '1 day')`);
    expect(await resolver(db, sourceId, COPILOT_STUDIO_CONTROL)).toMatchObject({ ok: false, code: "credential_expired" });
    const off = await as(adminId, null, "PUT", "/v1/discovery/settings", { version: await v(), vendorAgentControlDelegated: false });
    expect(off.res.statusCode, off.res.body).toBe(200);
  });

  it("federated: the assertion is minted for the CONTROL subject and Entra's exchange audience; the token is for the control's scope", async () => {
    const { sourceId } = await seedCopilot();
    await insertCred({ sourceId, purpose: "platform_write", credentialMode: "federated", publicConfig: { tenantId: TENANT, clientId: WRITE_APP } });
    const minted: Array<{ sourceId: string; audience: string }> = [];
    const assertion = `a338b-assertion-${RUN}`;
    const guarded = async () => createGuardedFetch({ allowList: [{ host: "login.microsoftonline.com", allowPrivateRanges: false, allowPlaintextHttp: false }], fetchImpl: fakeFetch, resolve });
    const resolver = controlCredentialResolver({ fetch: guarded, federationToken: (_db, sid) => async (audience) => (minted.push({ sourceId: sid, audience }), assertion) });
    const look = await resolver(db, sourceId, COPILOT_STUDIO_CONTROL);
    expect(look.ok).toBe(true);
    vendor.tokenBodies.length = 0;
    const token = look.ok ? await look.credential.acquire(AbortSignal.timeout(10_000)) : null;
    expect(token).toBe(ACCESS_TOKEN);
    // @azure/identity may ask for the assertion more than once; every one is for this source's control subject only
    expect(minted.length).toBeGreaterThan(0);
    for (const m of minted) expect(m).toEqual({ sourceId, audience: FEDERATION_AUDIENCES.azure });
    const sent = vendor.tokenBodies.at(-1)!;
    expect(sent.get("client_id")).toBe(WRITE_APP);
    expect(sent.get("client_assertion")).toBe(assertion);
    expect(sent.get("scope")).toBe(POWER_PLATFORM_API_SCOPE);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("ADR-0338 slice 1b: Copilot Studio quarantine, end to end", () => {
  const reqBody = (recordId: string, extra: Record<string, unknown> = {}) => ({ recordId, action: "quarantine", approverUserId: approverId, reason: `a338b ${RUN}`, ...extra });
  async function request(b: Record<string, unknown>, expected = 201) {
    const { res } = await as(adminId, vendorControlRequestStepUp(requestActionSchema.parse(b)), "POST", URL_, b);
    expect(res.statusCode, res.body).toBe(expected);
    return res.json();
  }
  async function approve(action: { approvalId: string }) {
    const [ap] = await db.select().from(approvals).where(eq(approvals.id, action.approvalId));
    const g = await grantStepUpForTest(db, approverId, vendorControlDecideStepUp(ap!.id, "approved", ap!.argumentsDigest!));
    const r = stepUpRequest(g);
    const d = await app.inject({ method: "POST", url: `/v1/approvals/${ap!.id}/decide`, headers: r.headers, cookies: r.cookies, payload: { decision: "approved" } });
    expect(d.statusCode, d.body).toBe(200);
  }
  const execute = async (id: string) => {
    const [row] = await db.select().from(vendorAgentActions).where(eq(vendorAgentActions.id, id));
    return as(adminId, vendorControlExecuteStepUp(row!), "POST", `${URL_}/${id}/execute`, {});
  };

  it("a record without the environment id cannot be asked for (vendor_locator_missing); nothing is queued", async () => {
    const { sourceId, recordId } = await seedCopilot({ environmentId: false });
    await storeCredential(sourceId);
    const out = await request(reqBody(recordId), 409);
    expect(out.error).toBe("vendor_locator_missing");
    expect(await db.select().from(vendorAgentActions).where(eq(vendorAgentActions.recordId, recordId))).toEqual([]);
  });

  it("with no control credential the request is refused no_control_credential", async () => {
    const { recordId } = await seedCopilot();
    expect((await request(reqBody(recordId), 409)).error).toBe("no_control_credential");
  });

  it("a token failure moves nothing and sends nothing; once the token works, the documented calls quarantine the agent; restore reverses it", async () => {
    const { sourceId, recordId, botId } = await seedCopilot();
    await storeCredential(sourceId);
    const { action } = await request(reqBody(recordId));
    expect((await db.select().from(vendorAgentActions).where(eq(vendorAgentActions.id, action.id)))[0]!.vendorLocator).toBe(ENV_ID);
    await approve(action);
    // Entra refuses the secret: 502, the action stays approved, the approval is not consumed, nothing reached the vendor
    vendor.tokenStatus = 401;
    vendor.ppCalls.length = 0;
    const failed = await execute(action.id);
    expect(failed.res.statusCode, failed.res.body).toBe(502);
    expect(failed.res.json()).toMatchObject({ error: "control_token_failed", code: "control_token_failed" });
    expect(failed.res.body).toContain("AADSTS7000215");
    expect(failed.res.body).not.toContain(CLIENT_SECRET);
    expect((await db.select().from(vendorAgentActions).where(eq(vendorAgentActions.id, action.id)))[0]!.status).toBe("approved");
    expect((await db.select().from(approvals).where(eq(approvals.id, action.approvalId)))[0]!.status).toBe("approved");
    expect(vendor.ppCalls).toEqual([]);
    // the token works: prior read, SetAsQuarantined, observed read, all with the Power Platform token
    vendor.tokenStatus = 200;
    vendor.tokenBodies.length = 0;
    const done = await execute(action.id);
    expect(done.res.statusCode, done.res.body).toBe(200);
    expect(done.res.json().action).toMatchObject({ status: "succeeded", priorState: "active", observedState: "quarantined" });
    const base = `/copilotstudio/environments/${ENV_ID}/bots/${botId}/api/botQuarantine`;
    expect(vendor.ppCalls.map((c) => `${c.method} ${c.url.pathname}`)).toEqual([`GET ${base}`, `POST ${base}/SetAsQuarantined`, `GET ${base}`]);
    expect(vendor.ppCalls.every((c) => c.auth === `Bearer ${ACCESS_TOKEN}` && c.url.searchParams.get("api-version") === "1")).toBe(true);
    expect(vendor.tokenBodies.at(-1)!.get("scope")).toBe(POWER_PLATFORM_API_SCOPE);
    expect(vendor.tokenBodies.at(-1)!.get("client_secret")).toBe(CLIENT_SECRET);
    // restore: SetAsUnquarantined
    const { action: back } = await request(reqBody(recordId, { action: "restore", reverses: action.id }));
    await approve(back);
    vendor.ppCalls.length = 0;
    const restored = await execute(back.id);
    expect(restored.res.statusCode, restored.res.body).toBe(200);
    expect(restored.res.json().action).toMatchObject({ status: "succeeded", priorState: "quarantined", observedState: "active" });
    expect(vendor.ppCalls.map((c) => `${c.method} ${c.url.pathname}`)).toContain(`POST ${base}/SetAsUnquarantined`);
  });

  it("a credential replaced after approval refuses the execute; the locator moving refuses it too", async () => {
    const { sourceId, recordId } = await seedCopilot();
    const first = await storeCredential(sourceId);
    const { action } = await request(reqBody(recordId));
    await approve(action);
    await storeCredential(sourceId, { replacesCredentialId: first.res.json().credential.id });
    const refused = await execute(action.id);
    expect(refused.res.statusCode, refused.res.body).toBe(409);
    expect(refused.res.json().error).toBe("approval_payload_mismatch");
    const other = await seedCopilot();
    await storeCredential(other.sourceId);
    const { action: a2 } = await request(reqBody(other.recordId));
    await approve(a2);
    await db.update(agentRegistryRecords).set({ vendorAttributes: { environment: ORG_HOST, environmentId: randomUUID() } }).where(eq(agentRegistryRecords.id, other.recordId));
    const moved = await execute(a2.id);
    expect(moved.res.statusCode, moved.res.body).toBe(409);
    expect(moved.res.json().why).toBe("record_changed");
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("ADR-0338 slice 1b: every control shape-checks and path-encodes the vendor-reported ids", () => {
  const HOSTILE: Array<Partial<VendorAgentRef>> = [
    { externalId: `${ORG_HOST}/../../environments/x/bots/y`, locator: ENV_ID },
    { externalId: `${ORG_HOST}/${randomUUID()}?api-version=2&x=`, locator: ENV_ID },
    { externalId: `${ORG_HOST}/${randomUUID()}`, locator: "../../tenants" },
    { externalId: `${ORG_HOST}/${randomUUID()}`, locator: `${ENV_ID}/bots/x#` },
    { externalId: `${ORG_HOST}/${randomUUID()}`, locator: null },
    { externalId: "https://evil.example/x", locator: ENV_ID },
  ];

  it.each(Object.entries(AGENT_PLATFORM_CONTROLS))("%s: a hostile id is refused before any request, or sent only path-encoded", async (registry, control) => {
    for (const h of HOSTILE) {
      const calls: URL[] = [];
      const f = (async (input: string | URL | Request) => (calls.push(urlOf(input)), json({ isBotQuarantined: false }))) as typeof fetch;
      const ctx = { fetch: f, signal: AbortSignal.timeout(5000), token: "t" };
      const ref: VendorAgentRef = { recordId: randomUUID(), sourceId: randomUUID(), registry, externalId: "x", locator: null, ...h };
      for (const action of control.actions) {
        await control.readState(ctx, ref).catch(() => undefined);
        const applied = await control.apply(ctx, ref, action).catch(() => null);
        const reversed = await control.reverse(ctx, ref, action).catch(() => null);
        for (const r of [applied, reversed]) if (r) expect(r.outcome, JSON.stringify(h)).not.toBe("applied");
      }
      for (const u of calls) {
        expect(u.pathname, JSON.stringify(h)).not.toMatch(/\/\.\.?(\/|$)/);
        expect([...u.searchParams.keys()], JSON.stringify(h)).toEqual(["api-version"]);
      }
    }
  });

  it("Copilot Studio: the URL builder encodes every vendor segment", () => {
    const u = new URL(copilotStudioControlUrl({ environmentId: "a/../b?c", botId: "d#e" }, "quarantine"));
    expect(u.origin).toBe(PP);
    expect(u.pathname).toBe("/copilotstudio/environments/a%2F..%2Fb%3Fc/bots/d%23e/api/botQuarantine/SetAsQuarantined");
    expect([...u.searchParams.entries()]).toEqual([["api-version", "1"]]);
  });

  it("Copilot Studio: a definite vendor answer ends the action; a 5xx is left for a read; an unreadable status throws", async () => {
    const ref: VendorAgentRef = { recordId: randomUUID(), sourceId: randomUUID(), registry: "copilot_studio", externalId: `${ORG_HOST}/${randomUUID()}`, locator: ENV_ID };
    const answering = (status: number, body: unknown = {}) => ({ fetch: (async () => (status === 204 ? new Response(null, { status }) : json(body, status))) as typeof fetch, signal: AbortSignal.timeout(5000), token: "t" });
    expect(await COPILOT_STUDIO_CONTROL.apply(answering(204), ref, "quarantine")).toMatchObject({ outcome: "applied", httpStatus: 204 });
    expect(await COPILOT_STUDIO_CONTROL.apply(answering(200), ref, "quarantine")).toMatchObject({ outcome: "applied" });
    expect(await COPILOT_STUDIO_CONTROL.apply(answering(403), ref, "quarantine")).toMatchObject({ outcome: "refused", code: "vendor_refused_credential" });
    expect(await COPILOT_STUDIO_CONTROL.apply(answering(405), ref, "quarantine")).toMatchObject({ outcome: "refused", code: "vendor_action_unsupported" });
    expect(await COPILOT_STUDIO_CONTROL.reverse(answering(404), ref, "quarantine")).toMatchObject({ outcome: "refused", code: "vendor_agent_not_found" });
    await expect(COPILOT_STUDIO_CONTROL.apply(answering(503), ref, "quarantine")).rejects.toThrow();
    await expect(COPILOT_STUDIO_CONTROL.apply(answering(429), ref, "quarantine")).rejects.toThrow();
    expect(await COPILOT_STUDIO_CONTROL.readState(answering(200, { isBotQuarantined: true }), ref)).toEqual({ state: "quarantined" });
    await expect(COPILOT_STUDIO_CONTROL.readState(answering(200, { isBotQuarantined: "yes" }), ref)).rejects.toThrow();
    // only the documented host: anything else is refused before it is sent
    expect(COPILOT_STUDIO_CONTROL.locatorOf!({ environmentId: ENV_ID.toUpperCase() })).toBe(ENV_ID);
    expect(COPILOT_STUDIO_CONTROL.locatorOf!({ environmentId: "../x" })).toBeNull();
    expect(new ControlTokenError("x", "y").code).toBe("x");
  });
});
