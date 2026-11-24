/**
 * Owner decisions 2026-11-22 (ADR-0337 §4a and §5a), on a real database through the real routes:
 *
 *  - Salesforce: no broad access by default. The org switch `salesforceOrgTokens` is off; turning it on is a
 *    `settings_relax` step-up bound to exactly it, audited with the trade-off the admin accepts; off is free. While it
 *    is off, a Salesforce source cannot be created or widened with `orgTokens: "on"`; the posture names the sources
 *    asking for it and carries the trade-off.
 *  - The read-setup view: for Salesforce, what the default read sees and plainly cannot see; for Microsoft 365, the
 *    guided activity-log setup (off by default), its exact steps and admin consent link, and the state the latest read
 *    observed, never a guess. Other kinds have no guided setup (409); an unknown source is 404.
 *
 * Global state (M-068): the identity family switch and the Salesforce switch are restored; sources are deleted.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  auditLog,
  authSessions,
  createDb,
  discoveryCredentials,
  discoverySettings,
  discoverySources,
  eq,
  inArray,
  runMigrations,
  saasEntitlementUsageReads,
  sql,
  stepUpGrants,
  users,
  type Db,
} from "@regulait/db";
import { DISCOVERY_STEP_UP_KEYS, M365_ACTIVITY_LOG_SETUP, SALESFORCE_DEFAULT_READ, SALESFORCE_ORG_TOKENS_TRADE_OFF, stepUpActionDigest } from "@regulait/shared";
import { buildApp } from "./app.js";
import type { StepUpCheckArgs } from "./step-up.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { hashToken } from "./token-hash.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = randomBytes(4).toString("hex");
const BOOT = `e18gr-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const CSRF = { "x-regulait-csrf": "1" };
const ORIGIN = "http://localhost";
const DATA_KEY = createHash("sha256").update(`e18gr-data-key-${RUN}`).digest("hex");
const TENANT = "11111111-2222-4333-8444-555555555555";
const CLIENT = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const SF = { environment: "production", myDomain: "https://acme.my.salesforce.com", orgId: "00D5g000004AbCdEAA" };
const prevPublicUrl = process.env.REGULAIT_PUBLIC_URL;
process.env.REGULAIT_PUBLIC_URL = ORIGIN;

let db: Db;
let app: ReturnType<typeof buildApp>;
let adminId: string;
let adminKey: { authorization: string };
const createdSources: string[] = [];
const restores: Array<() => Promise<void>> = [];

type Method = "GET" | "POST" | "PUT" | "PATCH";
const inject = (method: Method, url: string, headers: Record<string, string>, payload?: unknown) =>
  app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload: payload as object }) });
const settingsRow = async () => (await db.select().from(discoverySettings).where(eq(discoverySettings.id, 1)))[0]!;
const sotStep: StepUpCheckArgs = { kind: "settings_relax", facts: { values: { [DISCOVERY_STEP_UP_KEYS.salesforceOrgTokens]: true } } };

/** a browser session for the admin; with `args`, a step-up grant made for exactly that action */
async function session(args?: StepUpCheckArgs) {
  const sessionToken = "rgls_" + randomBytes(32).toString("hex");
  const [s] = await db
    .insert(authSessions)
    .values({
      tokenHash: hashToken(sessionToken),
      userId: adminId,
      origin: "password",
      expiresAt: new Date(Date.now() + 3_600_000),
      idleExpiresAt: new Date(Date.now() + 3_600_000),
      idleMinutes: 60,
    })
    .returning({ id: authSessions.id });
  let stepUpToken: string | null = null;
  if (args) {
    stepUpToken = "rgsu_" + randomBytes(24).toString("hex");
    await db.insert(stepUpGrants).values({
      tokenHash: hashToken(stepUpToken),
      userId: adminId,
      sessionId: s!.id,
      method: "totp",
      actionKind: args.kind,
      actionDigest: stepUpActionDigest(args.kind, args.facts),
      expiresAt: new Date(Date.now() + 120_000),
    });
  }
  return (method: Method, url: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      headers: { ...CSRF, ...(stepUpToken ? { "x-regulait-step-up": stepUpToken } : {}) },
      cookies: { regulait_session: sessionToken },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
}

async function mkSource(kind: "entitlement_salesforce" | "entitlement_m365" | "entitlement_slack", target: Record<string, string>, enabled = false) {
  const [s] = await db
    .insert(discoverySources)
    .values({ name: `e18gr-${RUN}-${createdSources.length}`, kind, target, scope: { orgLevel: true, include: [] }, enabled, ...(enabled ? { enabledAt: new Date(), enabledBy: adminId } : {}), createdBy: adminId })
    .returning();
  createdSources.push(s!.id);
  return s!;
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restores.push(await relaxIdentityForTest(db, { mfaRequired: "off" }));
  const s0 = await settingsRow();
  restores.push(async () => {
    await db
      .update(discoverySettings)
      .set({ identitySourcesEnabled: s0.identitySourcesEnabled, salesforceOrgTokensEnabled: s0.salesforceOrgTokensEnabled })
      .where(eq(discoverySettings.id, 1));
  });
  await db.update(discoverySettings).set({ identitySourcesEnabled: true, salesforceOrgTokensEnabled: false }).where(eq(discoverySettings.id, 1));
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });
  await app.ready();
  const a = await inject("POST", "/v1/users", AUTH, { email: `e18gr-admin-${RUN}@example.com`, displayName: "e18 guided reads admin" });
  expect(a.statusCode, a.body).toBe(201);
  adminId = a.json().id as string;
  await db.update(users).set({ isAdmin: true, totpEnabled: true }).where(eq(users.id, adminId));
  adminKey = { authorization: `Bearer ${(await inject("POST", `/v1/users/${adminId}/keys`, AUTH, { name: "k" })).json().token}` };
}, 120_000);

afterAll(async () => {
  if (adminId) await db.update(users).set({ totpEnabled: false }).where(eq(users.id, adminId));
  if (createdSources.length) {
    await db.update(discoverySources).set({ enabled: false }).where(inArray(discoverySources.id, createdSources));
    await db.delete(discoverySources).where(inArray(discoverySources.id, createdSources));
  }
  for (const r of restores.reverse()) await r();
  await app?.close();
  if (prevPublicUrl === undefined) delete process.env.REGULAIT_PUBLIC_URL;
  else process.env.REGULAIT_PUBLIC_URL = prevPublicUrl;
});

describe("Salesforce: no broad access by default (owner decision 2026-11-22)", () => {
  it("the org-wide token switch is off; on needs the step-up bound to it and is audited with its trade-off; off is free", async () => {
    expect((await inject("GET", "/v1/discovery/settings", adminKey)).json().salesforceOrgTokens).toBe(false);
    const v0 = (await settingsRow()).version;
    // NEGATIVE CONTROLS: no grant, and a grant for another relaxation
    expect((await inject("PUT", "/v1/discovery/settings", adminKey, { version: v0, salesforceOrgTokens: true })).statusCode).toBe(403);
    const wrong = await session({ kind: "settings_relax", facts: { values: { [DISCOVERY_STEP_UP_KEYS.googleDirectoryTokens]: true } } });
    expect((await wrong("PUT", "/v1/discovery/settings", { version: v0, salesforceOrgTokens: true })).statusCode).toBe(403);
    expect((await settingsRow()).salesforceOrgTokensEnabled).toBe(false);

    const on = await session(sotStep);
    const r = await on("PUT", "/v1/discovery/settings", { version: v0, salesforceOrgTokens: true });
    expect(r.statusCode, r.body).toBe(200);
    expect((await settingsRow()).salesforceOrgTokensEnabled).toBe(true);
    const [relaxed] = await db
      .select({ detail: auditLog.detail, reason: auditLog.reason })
      .from(auditLog)
      .where(
        sql`${auditLog.objectType} = 'discovery_settings' AND ${auditLog.ruleId} = 'discovery-settings-relaxed' AND ${auditLog.detail}->'after'->>'salesforceOrgTokens' = 'true' AND ${auditLog.detail}->'before'->>'salesforceOrgTokens' = 'false' AND ${auditLog.userId} = ${adminId}`,
      );
    expect(relaxed).toBeDefined();
    expect((relaxed!.detail as Record<string, unknown>).salesforceOrgTokensTradeOff).toBe(SALESFORCE_ORG_TOKENS_TRADE_OFF);
    expect(relaxed!.reason).toContain("Customize Application");

    const off = await inject("PUT", "/v1/discovery/settings", adminKey, { version: v0 + 1, salesforceOrgTokens: false });
    expect(off.statusCode, off.body).toBe(200);
    expect((await settingsRow()).salesforceOrgTokensEnabled).toBe(false);
  });

  it("while off, a source cannot be created or widened with orgTokens; the posture names who asks and the trade-off", async () => {
    await db.update(discoverySettings).set({ salesforceOrgTokensEnabled: false }).where(eq(discoverySettings.id, 1));
    const create = await inject("POST", "/v1/discovery/sources", AUTH, { name: `e18gr-create-${RUN}`, kind: "entitlement_salesforce", target: { ...SF, orgTokens: "on" }, scope: { orgLevel: true, include: [] } });
    expect([create.statusCode, create.json().error]).toEqual([409, "salesforce_org_tokens_not_allowed"]);
    const plain = await inject("POST", "/v1/discovery/sources", AUTH, { name: `e18gr-plain-${RUN}`, kind: "entitlement_salesforce", target: SF, scope: { orgLevel: true, include: [] } });
    expect(plain.statusCode, plain.body).toBe(201);
    createdSources.push(plain.json().id);
    const widen = await inject("PATCH", `/v1/discovery/sources/${plain.json().id}`, AUTH, { version: plain.json().version, target: { ...SF, orgTokens: "on" } });
    expect([widen.statusCode, widen.json().error]).toEqual([409, "salesforce_org_tokens_not_allowed"]);

    const asking = await mkSource("entitlement_salesforce", { ...SF, orgTokens: "on" });
    const enable = await inject("POST", `/v1/discovery/sources/${asking.id}/enable`, AUTH, { version: asking.version });
    expect([enable.statusCode, enable.json().error]).toEqual([409, "salesforce_org_tokens_not_allowed"]);
    const live = await mkSource("entitlement_salesforce", { ...SF, orgTokens: "on" }, true);
    const run = await inject("POST", `/v1/discovery/sources/${live.id}/runs`, AUTH, {});
    expect([run.statusCode, run.json().error]).toEqual([409, "salesforce_org_tokens_not_allowed"]);
    const posture = (await inject("GET", "/v1/discovery/sources", adminKey)).json().posture;
    expect(posture.salesforceOrgTokens).toBe(false);
    expect(posture.salesforceOrgTokensTradeOff).toBe(SALESFORCE_ORG_TOKENS_TRADE_OFF);
    expect(posture.salesforceOrgTokenSources.map((s: { sourceId: string }) => s.sourceId)).toContain(asking.id);
    expect(posture.salesforceOrgTokenSources.map((s: { sourceId: string }) => s.sourceId)).not.toContain(plain.json().id);
  });

  it("the read-setup view says plainly what the default read sees and cannot see", async () => {
    const s = await mkSource("entitlement_salesforce", SF);
    const r = await inject("GET", `/v1/discovery/entitlements/sources/${s.id}/read-setup`, adminKey);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({
      platform: "salesforce",
      orgTokens: { requested: false, allowed: false, permission: "Customize Application", tradeOff: SALESFORCE_ORG_TOKENS_TRADE_OFF },
      sees: [...SALESFORCE_DEFAULT_READ.sees],
      cannotSee: [...SALESFORCE_DEFAULT_READ.cannotSee],
      lastRead: null,
    });
    // asking is not enough: the token read is claimed only once the org switch also allows it
    const asking = await mkSource("entitlement_salesforce", { ...SF, orgTokens: "on" });
    expect((await inject("GET", `/v1/discovery/entitlements/sources/${asking.id}/read-setup`, adminKey)).json().cannotSee).toHaveLength(2);
    await db.update(discoverySettings).set({ salesforceOrgTokensEnabled: true }).where(eq(discoverySettings.id, 1));
    const allowed = (await inject("GET", `/v1/discovery/entitlements/sources/${asking.id}/read-setup`, adminKey)).json();
    expect(allowed.cannotSee).toEqual([SALESFORCE_DEFAULT_READ.cannotSee[0]]);
    expect(allowed.sees).toHaveLength(3);
    await db.update(discoverySettings).set({ salesforceOrgTokensEnabled: false }).where(eq(discoverySettings.id, 1));
  });
});

describe("Microsoft 365: guided activity-log setup, off by default (owner decision 2026-11-22)", () => {
  it("shows off, then 'not checked' until a read observes it, then what the read saw; with the exact steps and consent link", async () => {
    const off = await mkSource("entitlement_m365", { tenantId: TENANT });
    await db.insert(discoveryCredentials).values({ sourceId: off.id, credentialMode: "federated", publicConfig: { tenantId: TENANT, clientId: CLIENT }, createdBy: adminId });
    const v0 = (await inject("GET", `/v1/discovery/entitlements/sources/${off.id}/read-setup`, adminKey)).json();
    expect(v0).toMatchObject({
      platform: "m365",
      activityLogs: {
        requested: false,
        state: "off",
        permission: "AuditLog.Read.All",
        permissionType: "application",
        license: M365_ACTIVITY_LOG_SETUP.license,
        consentUrl: `https://login.microsoftonline.com/${TENANT}/adminconsent?client_id=${CLIENT}`,
      },
    });
    expect(v0.activityLogs.steps.map((s: { id: string }) => s.id)).toEqual(M365_ACTIVITY_LOG_SETUP.steps.map((s) => s.id));

    const on = await mkSource("entitlement_m365", { tenantId: TENANT, activityLogs: "on" });
    const v1 = (await inject("GET", `/v1/discovery/entitlements/sources/${on.id}/read-setup`, adminKey)).json();
    expect(v1.activityLogs).toMatchObject({ requested: true, state: "not_checked", consentUrl: null });
    // a read from before the source asked (state off) is not taken as an answer
    await db.insert(saasEntitlementUsageReads).values({ sourceId: on.id, coverage: "none", note: "off", activityLogState: "off", recordedAt: new Date() });
    expect((await inject("GET", `/v1/discovery/entitlements/sources/${on.id}/read-setup`, adminKey)).json().activityLogs.state).toBe("not_checked");
    await db.update(saasEntitlementUsageReads).set({ activityLogState: "not_enabled", note: "Entra refused the activity-log read" }).where(eq(saasEntitlementUsageReads.sourceId, on.id));
    const v2 = (await inject("GET", `/v1/discovery/entitlements/sources/${on.id}/read-setup`, adminKey)).json();
    expect(v2.activityLogs.state).toBe("not_enabled");
    expect(v2.lastRead).toMatchObject({ coverage: "none", note: "Entra refused the activity-log read" });
  });

  it("the stored state is pinned by a CHECK and agrees with its vocabulary", async () => {
    const s = await mkSource("entitlement_m365", { tenantId: TENANT });
    await expect(db.insert(saasEntitlementUsageReads).values({ sourceId: s.id, coverage: "none", note: "n", activityLogState: "maybe" as never, recordedAt: new Date() })).rejects.toThrow();
  });

  it("other kinds have no guided setup (409); an unknown source is 404; a malformed id is 400", async () => {
    const slack = await mkSource("entitlement_slack", { enterpriseId: "E0ACME123" });
    expect((await inject("GET", `/v1/discovery/entitlements/sources/${slack.id}/read-setup`, adminKey)).statusCode).toBe(409);
    expect((await inject("GET", `/v1/discovery/entitlements/sources/00000000-0000-4000-8000-000000000000/read-setup`, adminKey)).statusCode).toBe(404);
    expect((await inject("GET", `/v1/discovery/entitlements/sources/nope/read-setup`, adminKey)).statusCode).toBe(400);
  });
});
