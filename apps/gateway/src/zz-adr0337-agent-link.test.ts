/**
 * ADR-0337 §6 (owner decision 2026-11-17): a vendor app is linked to a RegulAIt agent automatically on an EXACT
 * identifier match, each auto-link is audited, an admin can unlink it, and a partial or fuzzy match stays admin-only.
 * On a real database, through the real worker and the real routes:
 *
 *  - the link column's CHECK equals the declared machine (ADR-0348's test also covers it), and the pairing CHECK makes
 *    "linked" mean "names an agent";
 *  - a read auto-links an app whose vendor id equals a declared identifier, with one audit row per link; a case
 *    variant or a prefix is not linked;
 *  - declaring an identifier links the already-stored apps at once, audited; the declaration's own audit row names
 *    every app and source it linked (it applies to every source of its platform);
 *  - an M365 GUID is stored lowercase; an agent with an identifier cannot be deleted (RESTRICT);
 *  - an admin unlinks (audited) and a later read does not link the app again; an admin links a partial match;
 *  - a transition the machine does not allow is refused (409) and changes nothing; a non-admin is refused (403).
 *
 * Global state (M-068): the identity family switch is restored; sources (cascading to apps), identifiers and agents
 * this file creates are deleted in afterAll.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  agentVendorIdentifiers,
  agents,
  and,
  asc,
  auditLog,
  createDb,
  discoveryRuns,
  discoverySettings,
  discoverySources,
  eq,
  inArray,
  runMigrations,
  saasEntitlementApps,
  users,
  type Db,
} from "@regulait/db";
import { SAAS_APP_AGENT_LINK_MACHINE, type DiscoverySourceKind, type SaasEntitlementBatch } from "@regulait/shared";
import { buildApp } from "./app.js";
import { scannerRegistry, type Scanner } from "./discovery-scanners.js";
import { runDiscoveryPass } from "./discovery-worker.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = randomBytes(4).toString("hex");
const NIL = "00000000-0000-0000-0000-000000000000";
const BOOT = `e18link-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const DATA_KEY = createHash("sha256").update(`e18link-data-key-${RUN}`).digest("hex");
const TENANT = "00000000-0000-4000-8000-000000000e18";
const GRAPH = "00000003-0000-0000-c000-000000000000";
const EXACT = `Agent-${RUN}`;
const LATER = `later-${RUN}`;

let db: Db;
let app: ReturnType<typeof buildApp>;
let memberKey: { authorization: string };
const createdSources: string[] = [];
const createdAgents: string[] = [];
let restoreIdentity: boolean;
let next: unknown;
const scanner = (kind: DiscoverySourceKind): Scanner => ({ kind, requiresCredential: false, run: async () => ({ observations: [], entitlements: next as SaasEntitlementBatch }) });

const appOf = (externalId: string) => ({
  externalId,
  appKind: "service_principal",
  displayName: externalId,
  publisher: null,
  publisherVerified: null,
  grants: [{ resource: GRAPH, scope: "User.Read", grantType: "delegated", consent: "tenant", principals: [] }],
});
const m365 = (apps: unknown[]) => ({ platform: "m365", tenant: TENANT, complete: false, apps, revokedPrincipals: [] });

async function mkAgent(label: string) {
  const [a] = await db.insert(agents).values({ name: `e18link-${label}-${RUN}`, provider: "test", tier: 1 } as typeof agents.$inferInsert).returning({ id: agents.id });
  createdAgents.push(a!.id);
  return a!.id;
}

async function mkSource() {
  const [s] = await db
    .insert(discoverySources)
    .values({ name: `e18link-${RUN}-${createdSources.length}`, kind: "entitlement_m365", target: { tenantId: TENANT }, scope: { orgLevel: true, include: [] }, enabled: true, enabledAt: new Date(), enabledBy: NIL, createdBy: NIL })
    .returning();
  createdSources.push(s!.id);
  return s!;
}

async function runOnce(s: { id: string; version: number; kind: DiscoverySourceKind }, batch: unknown) {
  next = batch;
  const [r] = await db.insert(discoveryRuns).values({ sourceId: s.id, trigger: "manual", status: "queued", sourceVersion: s.version, kind: s.kind }).returning({ id: discoveryRuns.id });
  await runDiscoveryPass(db, { registry: scannerRegistry([scanner("entitlement_m365")]), owner: `e18link-${RUN}-${randomBytes(3).toString("hex")}`, limit: 20 });
  const [run] = await db.select().from(discoveryRuns).where(eq(discoveryRuns.id, r!.id));
  expect(run!.status, run!.errorDetail ?? "").toBe("succeeded");
}

const appRow = async (sourceId: string, externalId: string) =>
  (await db.select().from(saasEntitlementApps).where(and(eq(saasEntitlementApps.sourceId, sourceId), eq(saasEntitlementApps.externalId, externalId))))[0]!;
const auditFor = async (appId: string) =>
  (await db.select({ ruleId: auditLog.ruleId, detail: auditLog.detail }).from(auditLog).where(and(eq(auditLog.objectType, "saas_entitlement_app"), eq(auditLog.objectId, appId))).orderBy(asc(auditLog.seq))).map((r) => r.ruleId);

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  const [st] = await db.select().from(discoverySettings).where(eq(discoverySettings.id, 1));
  restoreIdentity = st!.identitySourcesEnabled;
  await db.update(discoverySettings).set({ identitySourcesEnabled: true }).where(eq(discoverySettings.id, 1));
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });
  const u = await app.inject({ method: "POST", url: "/v1/users", headers: AUTH, payload: { email: `e18link-member-${RUN}@example.com`, displayName: "e18 member" } });
  const id = u.json().id as string;
  const k = await app.inject({ method: "POST", url: `/v1/users/${id}/keys`, headers: AUTH, payload: { name: "k" } });
  memberKey = { authorization: `Bearer ${k.json().token}` };
  void users;
}, 120_000);

afterAll(async () => {
  if (createdSources.length) await db.delete(discoverySources).where(inArray(discoverySources.id, createdSources));
  if (createdAgents.length) {
    await db.delete(agentVendorIdentifiers).where(inArray(agentVendorIdentifiers.agentId, createdAgents));
    await db.delete(agents).where(inArray(agents.id, createdAgents));
  }
  await db.update(discoverySettings).set({ identitySourcesEnabled: restoreIdentity }).where(eq(discoverySettings.id, 1));
  await app?.close();
});

describe("ADR-0337 §6 vendor app to agent link", () => {
  it("'linked' always names an agent: the pairing CHECK refuses a state without one and an agent without a state", async () => {
    const s = await mkSource();
    await runOnce(s, m365([appOf(`pair-${RUN}`)]));
    const a = await appRow(s.id, `pair-${RUN}`);
    expect(a.agentLinkState).toBe("none");
    const agentId = await mkAgent("pair");
    await expect(db.update(saasEntitlementApps).set({ agentLinkState: "auto" }).where(eq(saasEntitlementApps.id, a.id))).rejects.toThrow();
    await expect(db.update(saasEntitlementApps).set({ agentId }).where(eq(saasEntitlementApps.id, a.id))).rejects.toThrow();
    // a linked agent cannot be deleted out from under its link (it is retired through its lifecycle instead)
    await db.update(saasEntitlementApps).set({ agentId, agentLinkState: "admin" }).where(eq(saasEntitlementApps.id, a.id));
    await expect(db.delete(agents).where(eq(agents.id, agentId))).rejects.toThrow();
    await db.update(saasEntitlementApps).set({ agentId: null, agentLinkState: "unlinked" }).where(eq(saasEntitlementApps.id, a.id));
  });

  it("a read auto-links on an EXACT match only (audited); a case variant or a prefix is not linked", async () => {
    const agentId = await mkAgent("exact");
    const decl = await app.inject({ method: "POST", url: "/v1/discovery/agent-identifiers", headers: AUTH, payload: { agentId, platform: "m365", externalId: EXACT } });
    expect(decl.statusCode, decl.body).toBe(201);
    expect(decl.json().autoLinked).toEqual([]);
    const s = await mkSource();
    await runOnce(s, m365([appOf(EXACT), appOf(EXACT.toLowerCase()), appOf(`${EXACT}-2`), appOf(EXACT.slice(0, -1))]));
    const exact = await appRow(s.id, EXACT);
    expect([exact.agentLinkState, exact.agentId]).toEqual(["auto", agentId]);
    for (const other of [EXACT.toLowerCase(), `${EXACT}-2`, EXACT.slice(0, -1)]) {
      const r = await appRow(s.id, other);
      expect([other, r.agentLinkState, r.agentId]).toEqual([other, "none", null]);
    }
    expect(await auditFor(exact.id)).toEqual(["saas-entitlement-agent-auto-linked"]);
  });

  it("declaring an identifier links the apps already stored, at once, each audited", async () => {
    const s = await mkSource();
    await runOnce(s, m365([appOf(LATER)]));
    expect((await appRow(s.id, LATER)).agentLinkState).toBe("none");
    const agentId = await mkAgent("later");
    const decl = await app.inject({ method: "POST", url: "/v1/discovery/agent-identifiers", headers: AUTH, payload: { agentId, platform: "m365", externalId: LATER } });
    expect(decl.statusCode, decl.body).toBe(201);
    const a = await appRow(s.id, LATER);
    expect(decl.json().autoLinked).toEqual([a.id]);
    expect([a.agentLinkState, a.agentId]).toEqual(["auto", agentId]);
    expect(await auditFor(a.id)).toEqual(["saas-entitlement-agent-auto-linked"]);
    // the same identifier on the same platform cannot name a second agent
    const dup = await app.inject({ method: "POST", url: "/v1/discovery/agent-identifiers", headers: AUTH, payload: { agentId: await mkAgent("dup"), platform: "m365", externalId: LATER } });
    expect(dup.statusCode).toBe(409);
  });

  it("a declaration applies to every source of its platform, and its own audit row names each app and source it linked", async () => {
    const id = `cross-${RUN}`;
    const [s1, s2] = [await mkSource(), await mkSource()];
    await runOnce(s1, m365([appOf(id)]));
    await runOnce(s2, m365([appOf(id)]));
    const agentId = await mkAgent("cross");
    const decl = await app.inject({ method: "POST", url: "/v1/discovery/agent-identifiers", headers: AUTH, payload: { agentId, platform: "m365", externalId: id } });
    expect(decl.statusCode, decl.body).toBe(201);
    const [a1, a2] = [await appRow(s1.id, id), await appRow(s2.id, id)];
    expect([...decl.json().autoLinked].sort()).toEqual([a1.id, a2.id].sort());
    expect([...decl.json().autoLinkedSources].sort()).toEqual([s1.id, s2.id].sort());
    const [row] = await db
      .select({ detail: auditLog.detail, reason: auditLog.reason })
      .from(auditLog)
      .where(and(eq(auditLog.ruleId, "agent-vendor-identifier-declared"), eq(auditLog.objectId, decl.json().identifier.id)));
    const detail = row!.detail as { autoLinkedApps: string[]; autoLinkedSources: string[]; scope: string };
    expect([...detail.autoLinkedApps].sort()).toEqual([a1.id, a2.id].sort());
    expect([...detail.autoLinkedSources].sort()).toEqual([s1.id, s2.id].sort());
    expect(detail.scope).toBe("every entitlement source of this platform");
    expect(row!.reason).toContain("2 app(s) in 2 source(s)");
  });

  it("an M365 GUID identifier is stored lowercase, so an upper-case declaration still matches Graph's lowercase app id", async () => {
    const guid = `${RUN}-aaaa-4bbb-8ccc-${RUN}dddd`;
    const s = await mkSource();
    await runOnce(s, m365([appOf(guid)]));
    const agentId = await mkAgent("guid");
    const decl = await app.inject({ method: "POST", url: "/v1/discovery/agent-identifiers", headers: AUTH, payload: { agentId, platform: "m365", externalId: guid.toUpperCase() } });
    expect(decl.statusCode, decl.body).toBe(201);
    expect(decl.json().identifier.externalId).toBe(guid);
    expect((await appRow(s.id, guid)).agentLinkState).toBe("auto");
    // the same GUID in the other case is the same identifier
    const dup = await app.inject({ method: "POST", url: "/v1/discovery/agent-identifiers", headers: AUTH, payload: { agentId: await mkAgent("guid2"), platform: "m365", externalId: guid } });
    expect(dup.statusCode).toBe(409);
  });

  it("a retired agent is never linked: declaring or linking is refused (409), and a read does not auto-link it", async () => {
    const id = `retired-${RUN}`;
    const agentId = await mkAgent("retired");
    const decl = await app.inject({ method: "POST", url: "/v1/discovery/agent-identifiers", headers: AUTH, payload: { agentId, platform: "m365", externalId: id } });
    expect(decl.statusCode, decl.body).toBe(201);
    await db.update(agents).set({ lifecycleStatus: "retired", lifecycleReason: "test" } as Partial<typeof agents.$inferInsert>).where(eq(agents.id, agentId));
    const s = await mkSource();
    await runOnce(s, m365([appOf(id)]));
    const a = await appRow(s.id, id);
    expect([a.agentLinkState, a.agentId]).toEqual(["none", null]);
    const ln = await app.inject({ method: "PUT", url: `/v1/discovery/entitlements/apps/${a.id}/agent-link`, headers: AUTH, payload: { agentId } });
    expect([ln.statusCode, ln.json().error]).toEqual([409, "agent_retired"]);
    const again = await app.inject({ method: "POST", url: "/v1/discovery/agent-identifiers", headers: AUTH, payload: { agentId, platform: "m365", externalId: `${id}-2` } });
    expect([again.statusCode, again.json().error]).toEqual([409, "agent_retired"]);
  });

  it("an agent with a declared identifier cannot be deleted out from under it (RESTRICT, not a silent cascade)", async () => {
    const agentId = await mkAgent("restrict");
    const decl = await app.inject({ method: "POST", url: "/v1/discovery/agent-identifiers", headers: AUTH, payload: { agentId, platform: "m365", externalId: `restrict-${RUN}` } });
    expect(decl.statusCode, decl.body).toBe(201);
    await expect(db.delete(agents).where(eq(agents.id, agentId))).rejects.toThrow();
    const [still] = await db.select().from(agentVendorIdentifiers).where(eq(agentVendorIdentifiers.agentId, agentId));
    expect(still?.externalId).toBe(`restrict-${RUN}`);
  });

  it("an admin unlinks (audited) and a later read never re-links it; an admin links a partial match by hand", async () => {
    const agentId = await mkAgent("unlink");
    const id = `unlink-${RUN}`;
    await app.inject({ method: "POST", url: "/v1/discovery/agent-identifiers", headers: AUTH, payload: { agentId, platform: "m365", externalId: id } });
    const s = await mkSource();
    await runOnce(s, m365([appOf(id), appOf(`${id}-preview`)]));
    const a = await appRow(s.id, id);
    expect(a.agentLinkState).toBe("auto");

    const un = await app.inject({ method: "DELETE", url: `/v1/discovery/entitlements/apps/${a.id}/agent-link`, headers: AUTH });
    expect(un.statusCode, un.body).toBe(200);
    expect(un.json()).toMatchObject({ agentLinkState: "unlinked", agentId: null });
    await runOnce(s, m365([appOf(id)]));
    expect(await appRow(s.id, id)).toMatchObject({ agentLinkState: "unlinked", agentId: null });
    expect(await auditFor(a.id)).toEqual(["saas-entitlement-agent-auto-linked", "saas-entitlement-agent-unlinked"]);

    // a partial match ("-preview") is never auto-linked; an admin links it by hand
    const partial = await appRow(s.id, `${id}-preview`);
    expect(partial.agentLinkState).toBe("none");
    const ln = await app.inject({ method: "PUT", url: `/v1/discovery/entitlements/apps/${partial.id}/agent-link`, headers: AUTH, payload: { agentId } });
    expect(ln.statusCode, ln.body).toBe(200);
    expect(ln.json()).toMatchObject({ agentLinkState: "admin", agentId });
    expect(await auditFor(partial.id)).toEqual(["saas-entitlement-agent-linked"]);
    // the unlinked app can be linked again only by an admin
    const re = await app.inject({ method: "PUT", url: `/v1/discovery/entitlements/apps/${a.id}/agent-link`, headers: AUTH, payload: { agentId } });
    expect(re.json()).toMatchObject({ agentLinkState: "admin" });
  });

  it("the listing shows each app's state and what the machine allows next; a disallowed transition is refused", async () => {
    const s = await mkSource();
    await runOnce(s, m365([appOf(`list-${RUN}`)]));
    const l = await app.inject({ method: "GET", url: `/v1/discovery/entitlements/apps?sourceId=${s.id}`, headers: AUTH });
    expect(l.statusCode, l.body).toBe(200);
    const item = l.json().items[0];
    expect(item.agentLinkState).toBe("none");
    const views = Object.fromEntries((item.lifecycle.transitions as Array<{ event: string; allowed: boolean }>).map((v) => [v.event, v.allowed]));
    expect(views).toEqual({ auto_link: true, link: true, unlink: false });
    expect(l.json().machine.id).toBe(SAAS_APP_AGENT_LINK_MACHINE.def.id);
    // unlinking an app that is not linked is not a transition the machine has
    const un = await app.inject({ method: "DELETE", url: `/v1/discovery/entitlements/apps/${item.id}/agent-link`, headers: AUTH });
    expect(un.statusCode).toBe(409);
    expect(un.json().error).toBe("illegal_transition");
    expect((await appRow(s.id, `list-${RUN}`)).agentLinkState).toBe("none");
    // an unknown agent is refused before anything changes
    const bad = await app.inject({ method: "PUT", url: `/v1/discovery/entitlements/apps/${item.id}/agent-link`, headers: AUTH, payload: { agentId: NIL } });
    expect(bad.statusCode).toBe(404);
  });

  it("the routes are admin-only", async () => {
    for (const [method, url] of [
      ["GET", "/v1/discovery/agent-identifiers"],
      ["POST", "/v1/discovery/agent-identifiers"],
      ["GET", `/v1/discovery/entitlements/apps?sourceId=${NIL}`],
      ["DELETE", `/v1/discovery/entitlements/apps/${NIL}/agent-link`],
    ] as const) {
      const r = await app.inject({ method, url, headers: memberKey, ...(method === "POST" ? { payload: {} } : {}) });
      expect([url, r.statusCode]).toEqual([url, 403]);
    }
  });
});
