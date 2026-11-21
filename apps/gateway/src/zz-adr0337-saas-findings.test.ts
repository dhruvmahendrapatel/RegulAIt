/**
 * ADR-0337 §5 (E18 slice 3): observed use and the V1 findings, on a real database, through the real discovery worker
 * and the real route.
 *
 *  - A read's usage block is stored in the run's transaction: the source's coverage is replaced, an app's times only
 *    move forward (an older observation never makes an app look less used), and a read without one records `none`.
 *  - unused-grant judges only a grant old enough (first seen at least the window before the usage read), only where
 *    the read observed use over the window, and the window is a parameter (narrowing it makes a finding appear).
 *  - excessive-scope needs a read that tells reads from writes; Microsoft 365 (per-app sign-ins) is not assessable.
 *  - oversharing: a tenant consent to anything but a read; a user consent or a read scope is not.
 *  - publicly-exposed-agent: a published Copilot Studio agent with no authentication; Agentforce is not assessable.
 *  - Computing the report writes nothing (no audit row); the route is admin-only and bounds the window.
 *
 * Global state (M-068, M-077): the identity family switch is restored; every source, pseudonym and user this file
 * creates is deleted in afterAll (sources cascade). Assertions are scoped to this file's own sources.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { InjectOptions } from "fastify";
import {
  agentRegistryRecords,
  auditLog,
  createDb,
  discoveryPseudonyms,
  discoveryRuns,
  discoverySettings,
  discoverySources,
  eq,
  inArray,
  runMigrations,
  saasEntitlementAppUsage,
  saasEntitlementApps,
  saasEntitlementUsageReads,
  sql,
  users,
  type Db,
} from "@regulait/db";
import type { DiscoverySourceKind, SaasEntitlementBatch } from "@regulait/shared";
import { buildApp } from "./app.js";
import { scannerRegistry, type Scanner } from "./discovery-scanners.js";
import { runDiscoveryPass } from "./discovery-worker.js";
import { computeSaasFindings, type SaasFindingsReport } from "./saas-entitlement-findings.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = randomBytes(4).toString("hex");
const NIL = "00000000-0000-0000-0000-000000000000";
const BOOT = `e18f-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const DATA_KEY = createHash("sha256").update(`e18f-data-key-${RUN}`).digest("hex");
const TENANT = "00000000-0000-4000-8000-00000000e18f";
const GRAPH = "00000003-0000-0000-c000-000000000000";
const DAY = 86_400_000;
const U1 = `psn:${randomBytes(12).toString("hex")}`;
const ago = (d: number) => new Date(Date.now() - d * DAY).toISOString();

let db: Db;
let app: ReturnType<typeof buildApp>;
const createdSources: string[] = [];
const createdUsers: string[] = [];
let restoreIdentity: boolean;

let next: unknown;
const scanner = (kind: DiscoverySourceKind): Scanner => ({ kind, requiresCredential: false, run: async () => ({ observations: [], entitlements: next as SaasEntitlementBatch }) });

async function source(kind: DiscoverySourceKind, name: string, target: Record<string, string> = { tenantId: TENANT }) {
  const [s] = await db
    .insert(discoverySources)
    .values({ name: `${name}-${RUN}`, kind, target, scope: { orgLevel: true, include: [] }, enabled: true, enabledAt: new Date(), enabledBy: NIL, createdBy: NIL })
    .returning();
  createdSources.push(s!.id);
  return s!;
}

async function runOnce(s: { id: string; version: number; kind: DiscoverySourceKind }, batch: unknown) {
  next = batch;
  const [r] = await db.insert(discoveryRuns).values({ sourceId: s.id, trigger: "manual", status: "queued", sourceVersion: s.version, kind: s.kind }).returning({ id: discoveryRuns.id });
  await runDiscoveryPass(db, {
    registry: scannerRegistry([scanner("entitlement_m365"), scanner("entitlement_google_workspace")]),
    owner: `e18f-${RUN}-${randomBytes(3).toString("hex")}`,
    limit: 20,
  });
  const [run] = await db.select().from(discoveryRuns).where(eq(discoveryRuns.id, r!.id));
  return run!;
}

const app365 = (externalId: string, grants: Array<[string, "delegated" | "application", "tenant" | "user"]>) => ({
  externalId,
  appKind: "service_principal",
  displayName: externalId,
  publisher: "Contoso",
  publisherVerified: false,
  grants: grants.map(([scope, grantType, consent]) => ({ resource: GRAPH, scope, grantType, consent, principals: consent === "user" ? [U1] : [] })),
});
const appGoogle = (externalId: string, scope: string) => ({
  externalId,
  appKind: "oauth_client",
  displayName: externalId,
  publisher: null,
  publisherVerified: null,
  grants: [{ resource: "", scope, grantType: "delegated", consent: "user", principals: [U1] }],
});

/** grants first seen this many days ago (a read only ever stamps now(); the past is simulated) */
const backdateGrants = (sourceId: string, d: number) =>
  db.execute(sql`UPDATE saas_entitlement_grants g SET first_seen_at = now() - make_interval(days => ${d}) FROM saas_entitlement_apps a WHERE g.app_id = a.id AND a.source_id = ${sourceId}`);

const mine = (rep: SaasFindingsReport, ruleId: string, sourceId: string) => rep.rules.find((r) => r.id === ruleId)!.findings.filter((f) => f.source.id === sourceId);
const notAssessed = (rep: SaasFindingsReport, ruleId: string, sourceId: string) => rep.rules.find((r) => r.id === ruleId)!.notAssessable.find((n) => n.source.id === sourceId);
const subjects = (rep: SaasFindingsReport, ruleId: string, sourceId: string) => mine(rep, ruleId, sourceId).map((f) => `${f.app?.externalId} ${f.grant?.scope}`).sort();

let m365Src: Awaited<ReturnType<typeof source>>;
let googleSrc: Awaited<ReturnType<typeof source>>;
let shortSrc: Awaited<ReturnType<typeof source>>;

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });
  await app.ready();
  const [st] = await db.select().from(discoverySettings).where(eq(discoverySettings.id, 1));
  restoreIdentity = st!.identitySourcesEnabled;
  await db.update(discoverySettings).set({ identitySourcesEnabled: true }).where(eq(discoverySettings.id, 1));
  await db.insert(discoveryPseudonyms).values({ kind: "idp_user", pseudonym: U1, displayNameCiphertext: "test-only" });

  // Microsoft 365: per-app sign-in activity (coverage app, not window-bounded)
  m365Src = await source("entitlement_m365", "e18f-m365");
  const m = await runOnce(m365Src, {
    platform: "m365",
    tenant: TENANT,
    complete: true,
    apps: [app365("idle", [["Mail.Send", "application", "tenant"], ["User.Read", "delegated", "user"]]), app365("busy", [["Files.ReadWrite.All", "application", "tenant"]]), app365("monthly", [["User.Read.All", "application", "tenant"]])],
    usage: {
      coverage: "app",
      windowStart: null,
      note: "sign-ins",
      apps: [
        { externalId: "busy", lastUseAt: ago(1), lastReadAt: null, lastWriteAt: null },
        { externalId: "monthly", lastUseAt: ago(30), lastReadAt: null, lastWriteAt: null },
        // use of an app the graph does not hold is not stored
        { externalId: "stranger", lastUseAt: ago(1), lastReadAt: null, lastWriteAt: null },
      ],
    },
  });
  expect(m.status).toBe("succeeded");
  await backdateGrants(m365Src.id, 120);

  // Google Workspace: token activity events (coverage verb, a 180-day window)
  googleSrc = await source("entitlement_google_workspace", "e18f-google", {});
  const g = await runOnce(googleSrc, {
    platform: "google_workspace",
    tenant: "my_customer",
    complete: false,
    apps: [appGoogle("reader", "https://www.googleapis.com/auth/gmail.send"), appGoogle("writer", "https://www.googleapis.com/auth/drive"), appGoogle("idle-g", "https://www.googleapis.com/auth/gmail.readonly")],
    usage: {
      coverage: "verb",
      windowStart: ago(180),
      note: "token activity",
      apps: [
        { externalId: "reader", lastUseAt: ago(2), lastReadAt: ago(2), lastWriteAt: null },
        { externalId: "writer", lastUseAt: ago(3), lastReadAt: ago(5), lastWriteAt: ago(3) },
      ],
    },
  });
  expect(g.status).toBe("succeeded");
  await backdateGrants(googleSrc.id, 120);

  // a Google read that could look back only 30 days (cut short): the 90-day rules cannot judge it
  shortSrc = await source("entitlement_google_workspace", "e18f-short", {});
  await runOnce(shortSrc, {
    platform: "google_workspace",
    tenant: "my_customer",
    complete: false,
    apps: [appGoogle("x", "https://www.googleapis.com/auth/drive")],
    usage: { coverage: "verb", windowStart: ago(30), note: "cut short", apps: [] },
  });
  await backdateGrants(shortSrc.id, 120);
}, 180_000);

afterAll(async () => {
  if (createdSources.length) await db.delete(discoverySources).where(inArray(discoverySources.id, createdSources));
  if (createdUsers.length) await db.delete(users).where(inArray(users.id, createdUsers));
  await db.delete(discoveryPseudonyms).where(eq(discoveryPseudonyms.pseudonym, U1));
  await db.update(discoverySettings).set({ identitySourcesEnabled: restoreIdentity }).where(eq(discoverySettings.id, 1));
  await app?.close();
});

describe("storing observed use", () => {
  it("the new tables have row-level security forced", async () => {
    const r = await db.execute(sql`SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
       WHERE relname IN ('saas_entitlement_usage_reads', 'saas_entitlement_app_usage') ORDER BY relname`);
    expect(r.rows).toEqual(["saas_entitlement_app_usage", "saas_entitlement_usage_reads"].map((relname) => ({ relname, relrowsecurity: true, relforcerowsecurity: true })));
  });

  it("records the coverage and each held app's use, never an app the graph does not hold", async () => {
    const [read] = await db.select().from(saasEntitlementUsageReads).where(eq(saasEntitlementUsageReads.sourceId, m365Src.id));
    expect(read).toMatchObject({ coverage: "app", windowStart: null, note: "sign-ins" });
    const used = await db
      .select({ externalId: saasEntitlementApps.externalId })
      .from(saasEntitlementAppUsage)
      .innerJoin(saasEntitlementApps, eq(saasEntitlementApps.id, saasEntitlementAppUsage.appId))
      .where(eq(saasEntitlementApps.sourceId, m365Src.id));
    expect(used.map((u) => u.externalId).sort()).toEqual(["busy", "monthly"]);
  });

  it("only moves an app's times forward, and a read without usage records 'none'", async () => {
    const src = await source("entitlement_google_workspace", "e18f-forward", {});
    const apps = [appGoogle("fw", "https://www.googleapis.com/auth/drive")];
    await runOnce(src, { platform: "google_workspace", tenant: "my_customer", complete: false, apps, usage: { coverage: "verb", windowStart: ago(180), note: "n", apps: [{ externalId: "fw", lastUseAt: ago(1), lastReadAt: ago(1), lastWriteAt: ago(4) }] } });
    // an older observation with no write: nothing moves back, and the earlier write is not erased
    await runOnce(src, { platform: "google_workspace", tenant: "my_customer", complete: false, apps, usage: { coverage: "verb", windowStart: ago(180), note: "n", apps: [{ externalId: "fw", lastUseAt: ago(9), lastReadAt: ago(9), lastWriteAt: null }] } });
    const [u] = await db
      .select({ lastUseAt: saasEntitlementAppUsage.lastUseAt, lastReadAt: saasEntitlementAppUsage.lastReadAt, lastWriteAt: saasEntitlementAppUsage.lastWriteAt })
      .from(saasEntitlementAppUsage)
      .innerJoin(saasEntitlementApps, eq(saasEntitlementApps.id, saasEntitlementAppUsage.appId))
      .where(eq(saasEntitlementApps.sourceId, src.id));
    expect(Date.now() - u!.lastUseAt.getTime()).toBeLessThan(2 * DAY);
    expect(Date.now() - u!.lastWriteAt!.getTime()).toBeLessThan(5 * DAY);
    // a read with no usage block: coverage none, with the reason
    await runOnce(src, { platform: "google_workspace", tenant: "my_customer", complete: false, apps });
    const [read] = await db.select().from(saasEntitlementUsageReads).where(eq(saasEntitlementUsageReads.sourceId, src.id));
    expect(read!.coverage).toBe("none");
    await backdateGrants(src.id, 120);
    const rep = await computeSaasFindings(db, { windowDays: 90 });
    expect(notAssessed(rep, "unused-grant", src.id)?.reason).toMatch(/no read-only usage source/);
    expect(mine(rep, "unused-grant", src.id)).toEqual([]);
  });
});

describe("the V1 findings", () => {
  it("unused-grant: flags the idle app's grants only, with evidence", async () => {
    const rep = await computeSaasFindings(db, { windowDays: 90 });
    expect(subjects(rep, "unused-grant", m365Src.id)).toEqual(["idle Mail.Send", "idle User.Read"]);
    const f = mine(rep, "unused-grant", m365Src.id)[0]!;
    expect(f.key).toBe(`unused-grant:grant:${f.grant!.id}`);
    expect(f.evidence).toMatchObject({ usageCoverage: "app", windowDays: 90, lastUseAt: null });
    expect(f.rationale).toMatch(/no use by the app in the last 90 days/);
    expect(f.action.kind).toBe("vendor-console");
    // Google: the app with no activity at all
    expect(subjects(rep, "unused-grant", googleSrc.id)).toEqual(["idle-g https://www.googleapis.com/auth/gmail.readonly"]);
  });

  it("the window is a parameter: narrowing it to 7 days flags the app last used 30 days ago", async () => {
    const rep = await computeSaasFindings(db, { windowDays: 7 });
    expect(subjects(rep, "unused-grant", m365Src.id)).toEqual(["idle Mail.Send", "idle User.Read", "monthly User.Read.All"]);
  });

  it("a grant younger than the window is not judged", async () => {
    await backdateGrants(m365Src.id, 10);
    try {
      expect(subjects(await computeSaasFindings(db, { windowDays: 90 }), "unused-grant", m365Src.id)).toEqual([]);
    } finally {
      await backdateGrants(m365Src.id, 120);
    }
  });

  it("a read that covered less than the window is not assessable, never unused", async () => {
    const rep = await computeSaasFindings(db, { windowDays: 90 });
    expect(mine(rep, "unused-grant", shortSrc.id)).toEqual([]);
    expect(notAssessed(rep, "unused-grant", shortSrc.id)?.reason).toMatch(/covers only 30 days/);
    expect(notAssessed(rep, "excessive-scope", shortSrc.id)?.reason).toMatch(/covers only 30 days/);
  });

  it("excessive-scope: a write scope held by an app that only read; Microsoft 365 is not assessable", async () => {
    const rep = await computeSaasFindings(db, { windowDays: 90 });
    expect(subjects(rep, "excessive-scope", googleSrc.id)).toEqual(["reader https://www.googleapis.com/auth/gmail.send"]);
    expect(mine(rep, "excessive-scope", googleSrc.id)[0]!.evidence).toMatchObject({ access: "write", lastWriteAt: null });
    expect(mine(rep, "excessive-scope", m365Src.id)).toEqual([]);
    expect(notAssessed(rep, "excessive-scope", m365Src.id)?.reason).toMatch(/does not tell reads from writes/);
  });

  it("oversharing: tenant consents to write or admin scopes, not read scopes or user consents", async () => {
    const rep = await computeSaasFindings(db, { windowDays: 90 });
    expect(subjects(rep, "oversharing", m365Src.id)).toEqual(["busy Files.ReadWrite.All", "idle Mail.Send"]);
    expect(mine(rep, "oversharing", m365Src.id)[0]!.rationale).toMatch(/Contoso \(NOT verified\)/);
    expect(mine(rep, "oversharing", googleSrc.id)).toEqual([]);
  });

  it("publicly-exposed-agent: a published, unauthenticated Copilot Studio agent; Agentforce is not assessable", async () => {
    const cs = await source("agent_registry_copilot_studio", "e18f-cs", { environment: "org.crm.dynamics.com" });
    const af = await source("agent_registry_agentforce", "e18f-af", { instance: "acme.my.salesforce.com" });
    await db.insert(agentRegistryRecords).values([
      { sourceId: cs.id, registry: "copilot_studio", externalId: `cs/open-${RUN}`, displayName: "Open bot", vendorAttributes: { publishedOn: ago(3), authenticationMode: "none" } },
      { sourceId: cs.id, registry: "copilot_studio", externalId: `cs/draft-${RUN}`, displayName: "Draft bot", vendorAttributes: { publishedOn: null, authenticationMode: "none" } },
      { sourceId: cs.id, registry: "copilot_studio", externalId: `cs/internal-${RUN}`, displayName: "Internal bot", vendorAttributes: { publishedOn: ago(3), authenticationMode: "integrated", accessControlPolicy: "agent_readers" } },
      { sourceId: af.id, registry: "agentforce", externalId: `af/1-${RUN}`, displayName: "Service agent", vendorAttributes: {} },
    ]);
    const rep = await computeSaasFindings(db, { windowDays: 90 });
    const found = mine(rep, "publicly-exposed-agent", cs.id);
    expect(found.map((f) => f.agentRecord!.displayName)).toEqual(["Open bot"]);
    expect(found[0]!.rationale).toMatch(/without signing in/);
    expect(notAssessed(rep, "publicly-exposed-agent", af.id)?.reason).toMatch(/agentforce registry reader records no publication audience/);
  });

  it("computing the report writes nothing", async () => {
    const count = async () => Number((await db.execute(sql`SELECT count(*)::int AS n FROM audit_log`)).rows[0]!.n);
    const before = await count();
    await computeSaasFindings(db, { windowDays: 90 });
    expect(await count()).toBe(before);
    void auditLog;
  });
});

describe("GET /v1/discovery/entitlements/findings", () => {
  const get = (url: string, headers: Record<string, string>) => app.inject({ method: "GET", url, headers } as InjectOptions);

  it("serves the report to an admin, bounding the window", async () => {
    const ok = await get("/v1/discovery/entitlements/findings?windowDays=30&limit=5", AUTH);
    expect(ok.statusCode).toBe(200);
    const body = ok.json() as SaasFindingsReport;
    expect(body.windowDays).toBe(30);
    expect(body.rules.map((r) => r.id)).toEqual(["unused-grant", "excessive-scope", "oversharing", "publicly-exposed-agent"]);
    expect(body.rules.every((r) => r.findings.length <= 5)).toBe(true);
    for (const bad of ["3", "400", "ninety"]) expect((await get(`/v1/discovery/entitlements/findings?windowDays=${bad}`, AUTH)).statusCode).toBe(400);
    expect((await get("/v1/discovery/entitlements/findings?other=1", AUTH)).statusCode).toBe(400);
  });

  it("is admin-only", async () => {
    const u = await app.inject({ method: "POST", url: "/v1/users", headers: AUTH, payload: { email: `e18f-user-${RUN}@example.com`, displayName: "e18f user" } });
    const userId = u.json().id as string;
    createdUsers.push(userId);
    const key = (await app.inject({ method: "POST", url: `/v1/users/${userId}/keys`, headers: AUTH, payload: { name: "k" } })).json().token as string;
    expect((await get("/v1/discovery/entitlements/findings", { authorization: `Bearer ${key}` })).statusCode).toBe(403);
  });
});
