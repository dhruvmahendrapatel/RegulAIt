/**
 * ADR-0337 (E18 slice 1): storing a SaaS entitlement read, on a real database, through the real discovery worker.
 *
 *  - The migration's widened kind CHECKs accept the entitlement kinds; the four graph tables are in place with
 *    row-level security forced.
 *  - A COMPLETE read stores apps, the scope dictionary, grants and user-consent principals (only pseudonym rows),
 *    commits with the run and writes a `saas-entitlements-recorded` audit row naming the run. A later complete read
 *    removes the grants and principals it did not see; the app (and an admin's agent link) stays.
 *  - A PARTIAL read removes nothing it did not see (a failed listing never looks like a revocation), refreshes what
 *    it saw, applies explicit revocations, and drops a user-consent grant nobody holds any more.
 *  - The worker refuses an entitlement graph from a kind that is not an entitlement reader, and a malformed one; the
 *    run fails and the graph is unchanged.
 *
 * Global state (M-068, M-077): the identity family switch is restored; every source, pseudonym and agent this file
 * creates is deleted in afterAll (sources cascade to their graph). Assertions are scoped to this file's own sources.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  agents,
  auditLog,
  createDb,
  desc,
  discoveryPseudonyms,
  discoveryRuns,
  discoverySettings,
  discoverySources,
  eq,
  inArray,
  runMigrations,
  saasEntitlementApps,
  saasEntitlementScopes,
  sql,
  and,
  type Db,
} from "@regulait/db";
import type { DiscoverySourceKind, SaasEntitlementBatch } from "@regulait/shared";
import { scannerRegistry, type Scanner } from "./discovery-scanners.js";
import { runDiscoveryPass } from "./discovery-worker.js";
import { loadSourceEntitlements } from "./saas-entitlements.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = randomBytes(4).toString("hex");
const NIL = "00000000-0000-0000-0000-000000000000";
const TENANT = "00000000-0000-4000-8000-000000000e18";
const psn = () => `psn:${randomBytes(12).toString("hex")}`;
const U1 = psn();
const U2 = psn();
const U3 = psn();
const AGENT_APP = `agent-${RUN}`;
const WIKI_APP = `wiki-${RUN}`;
const GRAPH = "00000003-0000-0000-c000-000000000000";

let db: Db;
const createdSources: string[] = [];
let agentId: string;
let restoreIdentity: boolean;

/** the batch the test scanner returns next (set by each test) */
let next: unknown;
const entitlementScanner = (kind: DiscoverySourceKind): Scanner => ({ kind, requiresCredential: false, run: async () => ({ observations: [], entitlements: next as SaasEntitlementBatch }) });

async function source(kind: DiscoverySourceKind, name: string) {
  const [s] = await db
    .insert(discoverySources)
    .values({ name: `${name}-${RUN}`, kind, target: { tenantId: TENANT }, scope: { orgLevel: true, include: [] }, enabled: true, enabledAt: new Date(), enabledBy: NIL, createdBy: NIL })
    .returning();
  createdSources.push(s!.id);
  return s!;
}

/** queue one manual run of `s` and run the worker with a registry holding only the test scanners */
async function runOnce(s: { id: string; version: number; kind: DiscoverySourceKind }, batch: unknown) {
  next = batch;
  const [r] = await db.insert(discoveryRuns).values({ sourceId: s.id, trigger: "manual", status: "queued", sourceVersion: s.version, kind: s.kind }).returning({ id: discoveryRuns.id });
  await runDiscoveryPass(db, { registry: scannerRegistry([entitlementScanner("entitlement_m365"), entitlementScanner("idp_entra")]), owner: `e18-${RUN}-${randomBytes(3).toString("hex")}`, limit: 20 });
  const [run] = await db.select().from(discoveryRuns).where(eq(discoveryRuns.id, r!.id));
  return run!;
}

const graphOf = async (sourceId: string) =>
  (await loadSourceEntitlements(db, sourceId)).map((r) => `${r.externalId} ${r.grantType} ${r.consent} ${r.scope} ${r.principals}`).sort();

const grant = (scope: string, grantType: "delegated" | "application", consent: "tenant" | "user", principals: string[] = []) => ({ resource: GRAPH, scope, grantType, consent, principals });
const appOf = (externalId: string, grants: ReturnType<typeof grant>[]) => ({ externalId, appKind: "service_principal", displayName: externalId, publisher: null, publisherVerified: null, grants });
const m365 = (complete: boolean, apps: unknown[], revokedPrincipals: unknown[] = []) => ({ platform: "m365", tenant: TENANT, complete, apps, revokedPrincipals });

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  const [st] = await db.select().from(discoverySettings).where(eq(discoverySettings.id, 1));
  restoreIdentity = st!.identitySourcesEnabled;
  await db.update(discoverySettings).set({ identitySourcesEnabled: true }).where(eq(discoverySettings.id, 1));
  // pseudonym rows stand for users a reader pseudonymised (the worker's hook records them before the commit)
  await db.insert(discoveryPseudonyms).values([U1, U2, U3].map((p) => ({ kind: "idp_user" as const, pseudonym: p, displayNameCiphertext: "test-only" })));
  const [a] = await db.insert(agents).values({ name: `e18-agent-${RUN}`, provider: "test", tier: 1 } as typeof agents.$inferInsert).returning({ id: agents.id });
  agentId = a!.id;
}, 120_000);

afterAll(async () => {
  if (createdSources.length) await db.delete(discoverySources).where(inArray(discoverySources.id, createdSources));
  await db.delete(discoveryPseudonyms).where(inArray(discoveryPseudonyms.pseudonym, [U1, U2, U3]));
  if (agentId) await db.delete(agents).where(eq(agents.id, agentId));
  await db.update(discoverySettings).set({ identitySourcesEnabled: restoreIdentity }).where(eq(discoverySettings.id, 1));
});

describe("ADR-0337 SaaS entitlement graph", () => {
  it("the graph tables exist with row-level security forced", async () => {
    const r = await db.execute<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(sql`
      SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
       WHERE relname IN ('saas_entitlement_apps', 'saas_entitlement_scopes', 'saas_entitlement_grants', 'saas_entitlement_grant_principals') ORDER BY relname`);
    expect(r.rows).toEqual(
      ["saas_entitlement_apps", "saas_entitlement_grant_principals", "saas_entitlement_grants", "saas_entitlement_scopes"].map((relname) => ({ relname, relrowsecurity: true, relforcerowsecurity: true })),
    );
  });

  it("complete reads store the graph with an audit row, then remove what a later complete read did not see", async () => {
    const s = await source("entitlement_m365", "m365");
    const run1 = await runOnce(s, m365(true, [
      appOf(AGENT_APP, [grant("Mail.ReadWrite", "application", "tenant"), grant("Mail.Read", "delegated", "user", [U1, U2]), grant("Mail.Send", "delegated", "user", [U1])]),
      appOf(WIKI_APP, [grant("User.Read", "delegated", "tenant")]),
    ]));
    expect(run1.status, run1.errorDetail ?? "").toBe("succeeded");
    expect(await graphOf(s.id)).toEqual([
      `${AGENT_APP} application tenant Mail.ReadWrite 0`,
      `${AGENT_APP} delegated user Mail.Read 2`,
      `${AGENT_APP} delegated user Mail.Send 1`,
      `${WIKI_APP} delegated tenant User.Read 0`,
    ]);
    const [audit] = await db.select().from(auditLog).where(and(eq(auditLog.ruleId, "saas-entitlements-recorded"), eq(auditLog.objectId, run1.id)));
    expect(audit!.detail).toMatchObject({ sourceId: s.id, platform: "m365", complete: true, apps: 2, grants: 4, principals: 3, grantsRemoved: 0 });
    // the scope dictionary holds one row per (platform, resource, name), shared by every source
    expect((await db.select().from(saasEntitlementScopes).where(and(eq(saasEntitlementScopes.platform, "m365"), eq(saasEntitlementScopes.name, "Mail.Read")))).length).toBe(1);

    // an admin links the vendor app to a registered agent; the link survives later reads
    await db.update(saasEntitlementApps).set({ agentId, agentLinkState: "admin" }).where(and(eq(saasEntitlementApps.sourceId, s.id), eq(saasEntitlementApps.externalId, AGENT_APP)));

    // U2 withdrew consent, Mail.Send was revoked, the wiki lost its grant entirely
    const run2 = await runOnce(s, m365(true, [appOf(AGENT_APP, [grant("Mail.ReadWrite", "application", "tenant"), grant("Mail.Read", "delegated", "user", [U1])])]));
    expect(run2.status, run2.errorDetail ?? "").toBe("succeeded");
    expect(await graphOf(s.id)).toEqual([`${AGENT_APP} application tenant Mail.ReadWrite 0`, `${AGENT_APP} delegated user Mail.Read 1`]);
    const apps = await db.select().from(saasEntitlementApps).where(eq(saasEntitlementApps.sourceId, s.id));
    expect(apps.map((a) => [a.externalId, a.agentId]).sort()).toEqual([[AGENT_APP, agentId], [WIKI_APP, null]].sort());
    const [audit2] = await db.select().from(auditLog).where(and(eq(auditLog.ruleId, "saas-entitlements-recorded"), eq(auditLog.objectId, run2.id)));
    expect(audit2!.detail).toMatchObject({ grantsRemoved: 2, principalsRemoved: 2 });
  });

  it("a partial read removes nothing unseen, applies explicit revocations, and drops a grant nobody holds", async () => {
    const s = await source("entitlement_m365", "m365-partial");
    expect((await runOnce(s, m365(true, [appOf(AGENT_APP, [grant("Files.Read.All", "application", "tenant"), grant("Mail.Read", "delegated", "user", [U1, U2]), grant("Calendars.Read", "delegated", "user", [U3])])]))).status).toBe("succeeded");
    // the next read could not list application permissions (partial): Files.Read.All must survive; U3 revoked the app
    const run = await runOnce(s, m365(false, [appOf(AGENT_APP, [grant("Mail.Read", "delegated", "user", [U1])])], [{ externalId: AGENT_APP, principal: U3 }]));
    expect(run.status, run.errorDetail ?? "").toBe("succeeded");
    expect(await graphOf(s.id)).toEqual([`${AGENT_APP} application tenant Files.Read.All 0`, `${AGENT_APP} delegated user Mail.Read 2`]);
  });

  it("refuses a graph from a kind that is not an entitlement reader, and a malformed graph; nothing is written", async () => {
    const entra = await source("idp_entra", "entra");
    const refused = await runOnce(entra, m365(true, [appOf(AGENT_APP, [grant("Mail.Read", "delegated", "tenant")])]));
    expect([refused.status, refused.errorCode]).toEqual(["failed", "entitlements_refused"]);
    expect(await db.select().from(saasEntitlementApps).where(eq(saasEntitlementApps.sourceId, entra.id))).toEqual([]);

    const s = await source("entitlement_m365", "m365-bad");
    const bad = await runOnce(s, m365(true, [appOf(AGENT_APP, [grant("Mail.Read", "delegated", "user", ["alice@acme.example"])])]));
    expect([bad.status, bad.errorCode]).toEqual(["failed", "entitlements_refused"]);
    expect(bad.errorDetail).toMatch(/not a pseudonym/);
    const missing = await runOnce(s, undefined);
    expect([missing.status, missing.errorCode]).toEqual(["failed", "entitlements_missing"]);
    expect(await db.select().from(saasEntitlementApps).where(eq(saasEntitlementApps.sourceId, s.id))).toEqual([]);
    const runs = await db.select().from(discoveryRuns).where(eq(discoveryRuns.sourceId, s.id)).orderBy(desc(discoveryRuns.createdAt));
    expect(runs.every((r) => r.status === "failed")).toBe(true);
  });
});
