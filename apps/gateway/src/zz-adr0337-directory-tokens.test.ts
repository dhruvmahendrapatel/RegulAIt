/**
 * ADR-0337 §4 (security review of #884): the Google Directory token listing reads every user's OAuth grants with a
 * scope (`admin.directory.user.security`) that could also revoke them, so it sits behind its own org switch.
 * On a real database, through the real routes and the real worker:
 *
 *  - the switch `googleDirectoryTokens` is off by default; turning it on is a `settings_relax` step-up bound to exactly
 *    it (refused without one, refused with a grant for another relaxation), audited before/after; off is free;
 *  - while it is off, a Google Workspace source cannot be created, enabled, widened into or run with
 *    `directoryTokens: "on"` (409 `directory_tokens_not_allowed`), and a run queued before it was turned off fails
 *    in the worker before any credential is read;
 *  - the posture names every source configured for the listing;
 *  - on an enabled source, turning the listing OFF and changing nothing else narrows the read: no step-up.
 *
 * Global state (M-068): the identity family switch and the Directory switch are restored; sources are deleted.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  and,
  auditLog,
  authSessions,
  createDb,
  discoveryRuns,
  discoverySettings,
  discoverySources,
  eq,
  inArray,
  runMigrations,
  sql,
  stepUpGrants,
  users,
  type Db,
} from "@regulait/db";
import { DISCOVERY_STEP_UP_KEYS, stepUpActionDigest } from "@regulait/shared";
import { buildApp } from "./app.js";
import { scannerRegistry, type Scanner } from "./discovery-scanners.js";
import { runDiscoveryPass } from "./discovery-worker.js";
import type { StepUpCheckArgs } from "./step-up.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { hashToken } from "./token-hash.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = randomBytes(4).toString("hex");
const BOOT = `e18dir-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const CSRF = { "x-regulait-csrf": "1" };
const ORIGIN = "http://localhost";
const DATA_KEY = createHash("sha256").update(`e18dir-data-key-${RUN}`).digest("hex");
const ON = { directoryTokens: "on" };
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
const setSwitch = (on: boolean) => db.update(discoverySettings).set({ googleDirectoryTokensEnabled: on }).where(eq(discoverySettings.id, 1));
const dirStep: StepUpCheckArgs = { kind: "settings_relax", facts: { values: { [DISCOVERY_STEP_UP_KEYS.googleDirectoryTokens]: true } } };

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

/** a Google Workspace source written directly (enabling is SD0's step-up route, covered by its own suite) */
async function mkSource(target: Record<string, string>, enabled: boolean) {
  const [s] = await db
    .insert(discoverySources)
    .values({
      name: `e18dir-${RUN}-${createdSources.length}`,
      kind: "entitlement_google_workspace",
      target,
      scope: { orgLevel: true, include: [] },
      enabled,
      ...(enabled ? { enabledAt: new Date(), enabledBy: adminId } : {}),
      createdBy: adminId,
    })
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
      .set({ identitySourcesEnabled: s0.identitySourcesEnabled, googleDirectoryTokensEnabled: s0.googleDirectoryTokensEnabled })
      .where(eq(discoverySettings.id, 1));
  });
  await db.update(discoverySettings).set({ identitySourcesEnabled: true, googleDirectoryTokensEnabled: false }).where(eq(discoverySettings.id, 1));
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });
  await app.ready();
  const a = await inject("POST", "/v1/users", AUTH, { email: `e18dir-admin-${RUN}@example.com`, displayName: "e18 dir admin" });
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

describe("ADR-0337 §4 the Google Directory token listing org switch", () => {
  it("is off by default; on needs the step-up bound to it (audited); off is free", async () => {
    expect((await inject("GET", "/v1/discovery/settings", adminKey)).json().googleDirectoryTokens).toBe(false);
    const v0 = (await settingsRow()).version;
    // NEGATIVE CONTROLS: no grant, and a grant for another relaxation
    expect((await inject("PUT", "/v1/discovery/settings", adminKey, { version: v0, googleDirectoryTokens: true })).statusCode).toBe(403);
    const wrong = await session({ kind: "settings_relax", facts: { values: { [DISCOVERY_STEP_UP_KEYS.endpointMcpConfig]: true } } });
    expect((await wrong("PUT", "/v1/discovery/settings", { version: v0, googleDirectoryTokens: true })).statusCode).toBe(403);
    expect((await settingsRow()).googleDirectoryTokensEnabled).toBe(false);

    const on = await session(dirStep);
    const r = await on("PUT", "/v1/discovery/settings", { version: v0, googleDirectoryTokens: true });
    expect(r.statusCode, r.body).toBe(200);
    expect((await settingsRow()).googleDirectoryTokensEnabled).toBe(true);
    const [relaxed] = await db
      .select({ detail: auditLog.detail })
      .from(auditLog)
      .where(
        sql`${auditLog.objectType} = 'discovery_settings' AND ${auditLog.ruleId} = 'discovery-settings-relaxed' AND ${auditLog.detail}->'after'->>'googleDirectoryTokens' = 'true' AND ${auditLog.detail}->'before'->>'googleDirectoryTokens' = 'false' AND ${auditLog.userId} = ${adminId}`,
      );
    expect(relaxed).toBeDefined();

    const off = await inject("PUT", "/v1/discovery/settings", adminKey, { version: v0 + 1, googleDirectoryTokens: false });
    expect(off.statusCode, off.body).toBe(200);
    expect((await settingsRow()).googleDirectoryTokensEnabled).toBe(false);
  });

  it("while off, a source cannot be created, widened into, enabled or run with the listing", async () => {
    await setSwitch(false);
    const create = await inject("POST", "/v1/discovery/sources", AUTH, { name: `e18dir-create-${RUN}`, kind: "entitlement_google_workspace", target: ON, scope: { orgLevel: true, include: [] } });
    expect([create.statusCode, create.json().error]).toEqual([409, "directory_tokens_not_allowed"]);
    // the same source without the listing is fine
    const plain = await inject("POST", "/v1/discovery/sources", AUTH, { name: `e18dir-plain-${RUN}`, kind: "entitlement_google_workspace", target: { customerId: "my_customer" }, scope: { orgLevel: true, include: [] } });
    expect(plain.statusCode, plain.body).toBe(201);
    createdSources.push(plain.json().id);
    const widen = await inject("PATCH", `/v1/discovery/sources/${plain.json().id}`, AUTH, { version: plain.json().version, target: { customerId: "my_customer", ...ON } });
    expect([widen.statusCode, widen.json().error]).toEqual([409, "directory_tokens_not_allowed"]);

    // a source configured while the switch was on stays visible, but is neither enabled nor run while it is off
    const parked = await mkSource(ON, false);
    const enable = await inject("POST", `/v1/discovery/sources/${parked.id}/enable`, AUTH, { version: parked.version });
    expect([enable.statusCode, enable.json().error]).toEqual([409, "directory_tokens_not_allowed"]);
    const live = await mkSource(ON, true);
    const run = await inject("POST", `/v1/discovery/sources/${live.id}/runs`, AUTH, {});
    expect([run.statusCode, run.json().error]).toEqual([409, "directory_tokens_not_allowed"]);

    // the posture names both sources configured for the listing
    const posture = (await inject("GET", "/v1/discovery/sources", adminKey)).json().posture;
    expect(posture.googleDirectoryTokens).toBe(false);
    const named = (posture.directoryTokenSources as Array<{ sourceId: string }>).map((s) => s.sourceId);
    expect(named).toEqual(expect.arrayContaining([parked.id, live.id]));
    expect(named).not.toContain(plain.json().id);
  });

  it("a run queued before the switch was turned off fails in the worker, before any credential is read", async () => {
    await setSwitch(true);
    const s = await mkSource(ON, true);
    const [r] = await db.insert(discoveryRuns).values({ sourceId: s.id, trigger: "manual", status: "queued", sourceVersion: s.version, kind: s.kind }).returning({ id: discoveryRuns.id });
    await setSwitch(false);
    let ran = false;
    const scanner: Scanner = {
      kind: "entitlement_google_workspace",
      requiresCredential: true,
      run: async () => {
        ran = true;
        return { observations: [] };
      },
    };
    await runDiscoveryPass(db, { registry: scannerRegistry([scanner]), owner: `e18dir-${RUN}`, limit: 20 });
    const [done] = await db.select().from(discoveryRuns).where(and(eq(discoveryRuns.id, r!.id)));
    expect([done!.status, done!.errorCode]).toEqual(["failed", "directory_tokens_not_allowed"]);
    expect(ran).toBe(false);
  });

  it("on an enabled source, turning the listing off (and nothing else) needs no step-up; turning it on does", async () => {
    await setSwitch(true);
    const s = await mkSource({ ...ON, customerId: "my_customer" }, true);
    const narrow = await inject("PATCH", `/v1/discovery/sources/${s.id}`, adminKey, { version: s.version, target: { customerId: "my_customer", directoryTokens: "off" } });
    expect(narrow.statusCode, narrow.body).toBe(200);
    const [row] = await db.select().from(discoverySources).where(eq(discoverySources.id, s.id));
    expect(row!.target).toEqual({ customerId: "my_customer", directoryTokens: "off" });
    const [a] = await db
      .select({ ruleId: auditLog.ruleId })
      .from(auditLog)
      .where(and(eq(auditLog.objectType, "discovery_source"), eq(auditLog.objectId, s.id)));
    expect(a?.ruleId).toBe("discovery-source-updated");
    // turning it back on widens an enabled source: the enable step-up
    const widen = await inject("PATCH", `/v1/discovery/sources/${s.id}`, adminKey, { version: row!.version, target: { customerId: "my_customer", directoryTokens: "on" } });
    expect(widen.statusCode).toBe(403);
  });
});
