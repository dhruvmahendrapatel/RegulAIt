/**
 * ADR-0218 (P9) — the wider discovery sources on a real database through the real app (`buildApp`):
 *
 *  - DEFAULT OFF: after migration 0238 every family switch is off; a source of a switched-off family cannot be
 *    created (409 `family_disabled`), and the settings read says so.
 *  - STEP-UP, with a negative control: turning a family on needs a `settings_relax` step-up bound to exactly the
 *    families being turned on (refused without one, refused with a grant for another family); turning one off is free.
 *  - THE WORKER: an enabled `idp_entra` source runs; its `oauth_app` sighting matches an admin catalogue row (the
 *    widened CHECKs accept the new signature, evidence and pseudonym kinds) and becomes a `saas_app` finding through
 *    the import path; once the family is switched off, the run route refuses, nothing is queued by schedule, a
 *    queued run fails `family_disabled`, and the posture no longer names the source.
 *
 * Global state (M-068): the family switches are restored, and every source and catalogue row this file creates is
 * deleted, in afterAll.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  aiEndpointSignatures,
  authSessions,
  createDb,
  desc,
  discoveryCredentials,
  discoveryRuns,
  discoverySettings,
  discoverySources,
  eq,
  inArray,
  runMigrations,
  sql,
  shadowAiFindings,
  shadowAiImports,
  stepUpGrants,
  users,
  type Db,
} from "@regulait/db";
import { DISCOVERY_STEP_UP_KEYS, stepUpActionDigest } from "@regulait/shared";
import { buildApp } from "./app.js";
import { enableStepUpArgs } from "./discovery-routes.js";
import { noopTestScanner, scannerRegistry, type ScanObservation } from "./discovery-scanners.js";
import { runDiscoveryPass } from "./discovery-worker.js";
import type { StepUpCheckArgs } from "./step-up.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { hashToken } from "./token-hash.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = Math.random().toString(36).slice(2, 8);
const BOOT = `w218-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const CSRF = { "x-regulait-csrf": "1" };
const DATA_KEY = createHash("sha256").update(`w218-data-key-${RUN}`).digest("hex");
const TENANT = "00000000-0000-4000-8000-000000000218";
const CLIENT = "00000000-0000-4000-8000-000000000219";
const APP_ID = `00000000-0000-4000-8000-${randomBytes(6).toString("hex")}`;
const PROVIDER = `w218prov-${RUN}`;

let db: Db;
let app: ReturnType<typeof buildApp>;
let adminId: string;
let adminKey: { authorization: string };
const restores: Array<() => Promise<void>> = [];
const createdIds: string[] = [];

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
const inject = (method: Method, url: string, headers: Record<string, string>, payload?: unknown) =>
  app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload: payload as object }) });

/** a browser session for the admin; with `args`, a step-up grant made for exactly that action */
async function session(args?: StepUpCheckArgs) {
  const sessionToken = "rgls_" + randomBytes(32).toString("hex");
  const [s] = await db
    .insert(authSessions)
    .values({
      tokenHash: createHash("sha256").update(sessionToken).digest("hex"),
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

const settingsRow = async () => (await db.select().from(discoverySettings).where(eq(discoverySettings.id, 1)))[0]!;
const familiesStep = (families: string[]): StepUpCheckArgs => ({ kind: "settings_relax", facts: { values: { [DISCOVERY_STEP_UP_KEYS.families]: families } } });

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restores.push(await relaxIdentityForTest(db, { mfaRequired: "off" }));
  const s0 = await settingsRow();
  restores.push(async () => {
    await db
      .update(discoverySettings)
      .set({ saasSourcesEnabled: s0.saasSourcesEnabled, identitySourcesEnabled: s0.identitySourcesEnabled, mlPlatformSourcesEnabled: s0.mlPlatformSourcesEnabled })
      .where(eq(discoverySettings.id, 1));
  });
  // no pseudonym is minted here: the per-tenant pseudonym key is wrapped under the first data key that asks for it,
  // and other suites sharing this database use their own (the scanner unit test covers `idp_user` pseudonyms)
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY, discoveryScanners: scannerRegistry([noopTestScanner("idp_entra", [], { requiresCredential: true })]) });
  const u = await inject("POST", "/v1/users", AUTH, { email: `w218-admin-${RUN}@example.com`, displayName: "w218 admin" });
  expect(u.statusCode, u.body).toBe(201);
  adminId = u.json().id as string;
  await db.update(users).set({ isAdmin: true }).where(eq(users.id, adminId));
  adminKey = { authorization: `Bearer ${(await inject("POST", `/v1/users/${adminId}/keys`, AUTH, { name: "k" })).json().token}` };
  await db.update(users).set({ totpEnabled: true }).where(eq(users.id, adminId));
  // the widened CHECK accepts the new identifier kind
  await db.insert(aiEndpointSignatures).values({ provider: PROVIDER, kind: "oauth_app", value: APP_ID, matchType: "identifier", provenance: "admin" });
}, 120_000);

afterAll(async () => {
  if (adminId) await db.update(users).set({ totpEnabled: false }).where(eq(users.id, adminId));
  if (createdIds.length) {
    await db.update(discoverySources).set({ enabled: false }).where(inArray(discoverySources.id, createdIds));
    await db.delete(discoverySources).where(inArray(discoverySources.id, createdIds));
  }
  await db.delete(shadowAiFindings).where(eq(shadowAiFindings.provider, PROVIDER));
  await db.delete(aiEndpointSignatures).where(eq(aiEndpointSignatures.value, APP_ID));
  for (const r of restores.reverse()) await r();
  await app?.close();
});

describe("ADR-0218 wider discovery sources", () => {
  it("every family is off by default, and a source of a switched-off family cannot be created", async () => {
    // start from the migration's default for this file (other suites never turn a family on)
    await db.update(discoverySettings).set({ saasSourcesEnabled: false, identitySourcesEnabled: false, mlPlatformSourcesEnabled: false }).where(eq(discoverySettings.id, 1));
    const st = await inject("GET", "/v1/discovery/settings", adminKey);
    expect(st.json().families).toEqual({ saas: false, identity: false, ml_platform: false });
    const c = await inject("POST", "/v1/discovery/sources", adminKey, { name: `entra-${RUN}`, kind: "idp_entra", target: { tenantId: TENANT }, scope: { orgLevel: true, include: [] } });
    expect(c.statusCode, c.body).toBe(409);
    expect(c.json().error).toBe("family_disabled");
    expect((await db.select().from(discoverySources).where(eq(discoverySources.name, `entra-${RUN}`))).length).toBe(0);
  });

  it("turning a family on needs the step-up bound to exactly that family; turning it off is free", async () => {
    const v0 = (await settingsRow()).version;
    // NEGATIVE CONTROLS: no grant, and a grant for another family
    const none = await inject("PUT", "/v1/discovery/settings", adminKey, { version: v0, families: { identity: true } });
    expect(none.statusCode).toBe(403);
    const wrong = await session(familiesStep(["saas"]));
    expect((await wrong("PUT", "/v1/discovery/settings", { version: v0, families: { identity: true } })).statusCode).toBe(403);
    expect((await settingsRow()).identitySourcesEnabled).toBe(false);

    const on = await session(familiesStep(["identity"]));
    const r = await on("PUT", "/v1/discovery/settings", { version: v0, families: { identity: true } });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().families).toEqual({ saas: false, identity: true, ml_platform: false });

    // off is free (no grant), then back on for the next test
    const off = await inject("PUT", "/v1/discovery/settings", adminKey, { version: v0 + 1, families: { identity: false } });
    expect(off.statusCode, off.body).toBe(200);
    const again = await session(familiesStep(["identity"]));
    expect((await again("PUT", "/v1/discovery/settings", { version: v0 + 2, families: { identity: true } })).statusCode).toBe(200);
  });

  it("an enabled source runs into the finding lifecycle; switching its family off stops it everywhere", async () => {
    const c = await inject("POST", "/v1/discovery/sources", adminKey, { name: `entra-${RUN}`, kind: "idp_entra", target: { tenantId: TENANT }, scope: { orgLevel: true, include: [] } });
    expect(c.statusCode, c.body).toBe(201);
    const s = c.json() as { id: string; version: number; kind: string; target: Record<string, string>; scope: { orgLevel: boolean; include: string[] } };
    createdIds.push(s.id);
    // a federated Entra credential is free; its tenant must match the source's
    const mismatch = await inject("PUT", `/v1/discovery/sources/${s.id}/credential`, adminKey, { mode: "federated", publicConfig: { tenantId: CLIENT, clientId: CLIENT }, replacesCredentialId: null });
    expect(mismatch.statusCode).toBe(400);
    const cr = await inject("PUT", `/v1/discovery/sources/${s.id}/credential`, adminKey, { mode: "federated", publicConfig: { tenantId: TENANT, clientId: CLIENT }, replacesCredentialId: null });
    expect(cr.statusCode, cr.body).toBe(200);
    const credId = (await db.select().from(discoveryCredentials).where(eq(discoveryCredentials.sourceId, s.id)))[0]!.id;
    const en = await session(enableStepUpArgs(s.id, s.kind, s.target, s.scope, credId));
    expect((await en("POST", `/v1/discovery/sources/${s.id}/enable`, { version: s.version })).statusCode).toBe(200);

    const pass = await runDiscoveryPass(db, { registry: scannerRegistry([noopTestScanner("idp_entra", [], { requiresCredential: true })]), dataKey: DATA_KEY, owner: `w218-a-${RUN}`, limit: 20 });
    expect(pass.claimed).toBeGreaterThanOrEqual(1);
    const [run] = await db.select().from(discoveryRuns).where(eq(discoveryRuns.sourceId, s.id)).orderBy(desc(discoveryRuns.createdAt));
    expect(run!.status, run!.errorDetail ?? "").toBe("succeeded");

    // run now: an app consent becomes a saas_app finding through the import path
    expect((await inject("POST", `/v1/discovery/sources/${s.id}/runs`, adminKey, {})).statusCode).toBe(202);
    const observations: ScanObservation[] = [
      { evidenceKind: "idp_app_grant", subjectKind: "saas_app", subject: `AI notetaker (${APP_ID})`, artifact: { kind: "oauth_app", value: APP_ID }, count: 1, names: ["Mail.Read"] },
    ];
    await runDiscoveryPass(db, { registry: scannerRegistry([noopTestScanner("idp_entra", observations, { requiresCredential: true })]), dataKey: DATA_KEY, owner: `w218-b-${RUN}`, limit: 20 });
    const [run2] = await db.select().from(discoveryRuns).where(eq(discoveryRuns.sourceId, s.id)).orderBy(desc(discoveryRuns.createdAt));
    expect(run2!.status, run2!.errorDetail ?? "").toBe("succeeded");
    expect(run2!.matched).toBe(1);
    const [imp] = await db.select().from(shadowAiImports).where(eq(shadowAiImports.discoveryRunId, run2!.id));
    expect(imp!.kind).toBe("idp_app_grant");
    const [finding] = await db.select().from(shadowAiFindings).where(eq(shadowAiFindings.provider, PROVIDER));
    expect(finding!.subjectKind).toBe("saas_app");
    expect(finding!.signalSources).toContain("idp_app_grant");
    expect(finding!.evidence[0]).toMatchObject({ source: "idp_app_grant", names: ["Mail.Read"] });
    // migration 0238 widened the pseudonym kinds for the consenting user
    const def = await db.execute<{ def: string }>(sql`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'discovery_pseudonyms_kind_check'`);
    expect(def.rows[0]!.def).toContain("idp_user");
    const postureOn = await inject("GET", "/v1/discovery/sources", adminKey);
    expect(postureOn.json().posture.sourcesEnabled.map((x: { sourceId: string }) => x.sourceId)).toContain(s.id);

    // switch the family off (free): the run route refuses, nothing is queued, a queued run fails, posture drops it
    await db.insert(discoveryRuns).values({ sourceId: s.id, trigger: "manual", status: "queued", sourceVersion: s.version + 1, kind: "idp_entra" });
    const v = (await settingsRow()).version;
    expect((await inject("PUT", "/v1/discovery/settings", adminKey, { version: v, families: { identity: false } })).statusCode).toBe(200);
    const refused = await inject("POST", `/v1/discovery/sources/${s.id}/runs`, adminKey, {});
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toBe("family_disabled");
    await db.update(discoverySources).set({ nextRunAt: new Date(Date.now() - 60_000) }).where(eq(discoverySources.id, s.id));
    const off = await runDiscoveryPass(db, { registry: scannerRegistry([noopTestScanner("idp_entra", observations, { requiresCredential: true })]), dataKey: DATA_KEY, owner: `w218-c-${RUN}`, limit: 20 });
    const runs = await db.select().from(discoveryRuns).where(eq(discoveryRuns.sourceId, s.id)).orderBy(desc(discoveryRuns.createdAt));
    expect(runs[0]!.status).toBe("failed");
    expect(runs[0]!.errorCode).toBe("family_disabled");
    expect(runs.filter((r) => r.trigger === "schedule" && r.status === "queued")).toEqual([]);
    expect(off.failed).toBeGreaterThanOrEqual(1);
    const postureOff = await inject("GET", "/v1/discovery/sources", adminKey);
    expect(postureOff.json().posture.sourcesEnabled.map((x: { sourceId: string }) => x.sourceId)).not.toContain(s.id);
    expect(postureOff.json().posture.families.identity).toBe(false);
  });
});
