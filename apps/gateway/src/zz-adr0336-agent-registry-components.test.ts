/**
 * ADR-0336 slice 1 — the components of a staged registry agent, on a real database through the real app and worker:
 *
 *  - REPLACE ON COMPLETE, KEEP ON PARTIAL (decision 3): a run that read an agent's components completely replaces the
 *    stored set (an empty list clears it); a run that read them partially (`components` undefined) leaves them as
 *    they were. A component the scanner contract refuses fails the run and stages nothing.
 *  - FORCED row-level security: the table is enabled AND forced; a plain app principal, a non-admin and another
 *    system reason see and write nothing; an admin and the worker's `system_task` do.
 *  - CASCADE: deleting the record's source deletes its components.
 *  - The record detail returns its components; the import audit row carries the component count (decision 7).
 *
 * Global state (M-068): the family switch is restored, and every source, agent and user this file creates is deleted.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  agentRegistryRecordComponents,
  agentRegistryRecords,
  agents,
  auditLog,
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
  stepUpGrants,
  users,
  type Db,
} from "@regulait/db";
import { DISCOVERY_STEP_UP_KEYS, stepUpActionDigest, type AgentRegistry } from "@regulait/shared";
import { buildApp } from "./app.js";
import { enableStepUpArgs } from "./discovery-routes.js";
import { scannerRegistry, type RegistryAgentRecord, type Scanner } from "./discovery-scanners.js";
import { runDiscoveryPass } from "./discovery-worker.js";
import { agentRegistryImportStepUpArgs } from "./agent-registry-routes.js";
import type { StepUpCheckArgs } from "./step-up.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { hashToken } from "./token-hash.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = Math.random().toString(36).slice(2, 8);
const BOOT = `r336-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const CSRF = { "x-regulait-csrf": "1" };
const DATA_KEY = createHash("sha256").update(`r336-data-key-${RUN}`).digest("hex");
const TENANT = "00000000-0000-4000-8000-000000000336";
const CLIENT = "00000000-0000-4000-8000-000000000337";
const ORG = "https://contoso.crm4.dynamics.com";
const BOT = `contoso.crm4.dynamics.com/b0000000-0000-4000-8000-${randomBytes(6).toString("hex")}`;
const MAIL = "/providers/Microsoft.PowerApps/apis/shared_office365";

let db: Db;
let app: ReturnType<typeof buildApp>;
let adminId: string;
let memberId: string;
let adminKey: { authorization: string };
const restores: Array<() => Promise<void>> = [];
const sourceIds: string[] = [];
const agentNames: string[] = [];

let next: { records: RegistryAgentRecord[]; complete: AgentRegistry[] } = { records: [], complete: [] };
const testScanner: Scanner = {
  kind: "agent_registry_copilot_studio",
  requiresCredential: true,
  run: async (ctx) => {
    ctx.recordRaw(JSON.stringify(next.records));
    return { observations: [], registryAgents: next.records, registriesComplete: next.complete, credentialWriteScope: "read_only" };
  },
};
const registry = scannerRegistry([testScanner]);

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

let sourceId: string;
const componentsOf = async (externalId: string) => {
  const [rec] = await db.select().from(agentRegistryRecords).where(eq(agentRegistryRecords.externalId, externalId));
  if (!rec) return [];
  return (await db.select().from(agentRegistryRecordComponents).where(eq(agentRegistryRecordComponents.recordId, rec.id)))
    .map((c) => `${c.kind}:${c.vendorRef}:${c.displayName}:${c.enabled}`)
    .sort();
};
async function runNow(records: RegistryAgentRecord[], complete: AgentRegistry[]) {
  next = { records, complete };
  const r = await inject("POST", `/v1/discovery/sources/${sourceId}/runs`, adminKey, {});
  expect(r.statusCode, r.body).toBe(202);
  await runDiscoveryPass(db, { registry, dataKey: DATA_KEY, owner: `r336-${RUN}-${randomBytes(3).toString("hex")}`, limit: 20 });
  return (await db.select().from(discoveryRuns).where(eq(discoveryRuns.sourceId, sourceId)).orderBy(desc(discoveryRuns.createdAt)))[0]!;
}
const agent = (components?: RegistryAgentRecord["components"]): RegistryAgentRecord => ({ registry: "copilot_studio", externalId: BOT, displayName: `HR helper ${RUN}`, ...(components ? { components } : {}) });

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restores.push(await relaxIdentityForTest(db, { mfaRequired: "off" }));
  const [s0] = await db.select().from(discoverySettings).where(eq(discoverySettings.id, 1));
  restores.push(async () => {
    await db.update(discoverySettings).set({ agentRegistrySourcesEnabled: s0!.agentRegistrySourcesEnabled }).where(eq(discoverySettings.id, 1));
  });
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY, discoveryScanners: registry });
  const u = await inject("POST", "/v1/users", AUTH, { email: `r336-admin-${RUN}@example.com`, displayName: "r336 admin" });
  expect(u.statusCode, u.body).toBe(201);
  adminId = u.json().id as string;
  await db.update(users).set({ isAdmin: true }).where(eq(users.id, adminId));
  const m = await inject("POST", "/v1/users", AUTH, { email: `r336-member-${RUN}@example.com`, displayName: "r336 member" });
  memberId = m.json().id as string;
  adminKey = { authorization: `Bearer ${(await inject("POST", `/v1/users/${adminId}/keys`, AUTH, { name: "k" })).json().token}` };
  await db.update(users).set({ totpEnabled: true }).where(eq(users.id, adminId));

  // the family on (its own step-up), one Copilot Studio source with a federated credential, enabled (its step-up)
  const v0 = (await db.select().from(discoverySettings).where(eq(discoverySettings.id, 1)))[0]!.version;
  const on = await session({ kind: "settings_relax", facts: { values: { [DISCOVERY_STEP_UP_KEYS.families]: ["agent_registry"] } } });
  const f = await on("PUT", "/v1/discovery/settings", { version: v0, families: { agent_registry: true } });
  expect(f.statusCode, f.body).toBe(200);
  const c = await inject("POST", "/v1/discovery/sources", adminKey, { name: `cs-${RUN}`, kind: "agent_registry_copilot_studio", target: { tenantId: TENANT, orgUrls: ORG }, scope: { orgLevel: true, include: [] } });
  expect(c.statusCode, c.body).toBe(201);
  const s = c.json() as { id: string; version: number; kind: string; target: Record<string, string>; scope: unknown };
  sourceId = s.id;
  sourceIds.push(s.id);
  const cr = await inject("PUT", `/v1/discovery/sources/${s.id}/credential`, adminKey, { mode: "federated", publicConfig: { tenantId: TENANT, clientId: CLIENT }, replacesCredentialId: null });
  expect(cr.statusCode, cr.body).toBe(200);
  const credId = (await db.select().from(discoveryCredentials).where(eq(discoveryCredentials.sourceId, s.id)))[0]!.id;
  const en = await session(enableStepUpArgs(s.id, s.kind, s.target, s.scope, credId));
  expect((await en("POST", `/v1/discovery/sources/${s.id}/enable`, { version: s.version })).statusCode).toBe(200);
}, 120_000);

afterAll(async () => {
  if (agentNames.length) await db.delete(agents).where(inArray(agents.name, agentNames));
  if (sourceIds.length) {
    await db.update(discoverySources).set({ enabled: false }).where(inArray(discoverySources.id, sourceIds));
    await db.delete(discoverySources).where(inArray(discoverySources.id, sourceIds));
  }
  if (adminId) await db.update(users).set({ totpEnabled: false }).where(eq(users.id, adminId));
  for (const r of restores.reverse()) await r();
  await app?.close();
});

describe("ADR-0336 decision 3: an agent's components are replaced on a complete read and kept on a partial one", () => {
  it("stages, keeps, replaces and clears", async () => {
    const full = [
      { kind: "knowledge" as const, vendorRef: "d-1", displayName: "HR handbook", enabled: true },
      { kind: "connected_app" as const, vendorRef: MAIL, displayName: "Contoso mail", enabled: true },
    ];
    const r1 = await runNow([agent(full)], ["copilot_studio"]);
    expect(r1.status, r1.errorDetail ?? "").toBe("succeeded");
    expect(await componentsOf(BOT)).toEqual([`connected_app:${MAIL}:Contoso mail:true`, "knowledge:d-1:HR handbook:true"]);

    // NEGATIVE CONTROL: a partial component read (components undefined) keeps the stored set exactly
    const r2 = await runNow([agent()], ["copilot_studio"]);
    expect(r2.status).toBe("succeeded");
    expect(await componentsOf(BOT)).toEqual([`connected_app:${MAIL}:Contoso mail:true`, "knowledge:d-1:HR handbook:true"]);

    // a complete read replaces it: one gone, one changed, one new
    const r3 = await runNow([agent([{ kind: "knowledge", vendorRef: "d-1", displayName: "HR handbook v2", enabled: false }, { kind: "tool", vendorRef: "d-2", displayName: "Payroll skill" }])], ["copilot_studio"]);
    expect(r3.status).toBe("succeeded");
    expect(await componentsOf(BOT)).toEqual(["knowledge:d-1:HR handbook v2:false", "tool:d-2:Payroll skill:null"]);

    // a complete read with none clears it
    await runNow([agent([])], ["copilot_studio"]);
    expect(await componentsOf(BOT)).toEqual([]);
  });

  it("a component the scanner contract refuses fails the run and changes nothing", async () => {
    await runNow([agent([{ kind: "knowledge", vendorRef: "d-1", displayName: "HR handbook" }])], ["copilot_studio"]);
    const bad = await runNow([agent([{ kind: "secret" as never, vendorRef: "x", displayName: "x" }])], ["copilot_studio"]);
    expect(bad.status).toBe("failed");
    expect(bad.errorCode).toBe("observation_refused");
    const tooLong = await runNow([agent([{ kind: "tool", vendorRef: "x".repeat(513), displayName: "x" }])], ["copilot_studio"]);
    expect(tooLong.status).toBe("failed");
    expect(await componentsOf(BOT)).toEqual(["knowledge:d-1:HR handbook:null"]);
  });
});

describe("ADR-0336 decision 3: row-level security on agent_registry_record_components", () => {
  const countAs = async (opts: { userId?: string; reason?: string }) =>
    db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('role', 'regulait_app', true)`);
      if (opts.userId) await tx.execute(sql`select set_config('regulait.user_id', ${opts.userId}, true)`);
      if (opts.reason) await tx.execute(sql`select set_config('regulait.system_context', ${opts.reason}, true)`);
      return ((await tx.execute(sql`select count(*)::int as n from agent_registry_record_components`)).rows[0] as { n: number }).n;
    });

  it("is ENABLED and FORCED", async () => {
    const r = await db.execute(sql`select relrowsecurity as on, relforcerowsecurity as forced from pg_class where oid = 'public.agent_registry_record_components'::regclass`);
    expect(r.rows).toEqual([{ on: true, forced: true }]);
  });

  it("NEGATIVE: a plain app principal, a non-admin and another system reason see nothing; an admin and system_task see all", async () => {
    const all = ((await db.execute(sql`select count(*)::int as n from agent_registry_record_components`)).rows[0] as { n: number }).n;
    expect(all).toBeGreaterThan(0);
    expect(await countAs({})).toBe(0);
    expect(await countAs({ userId: memberId })).toBe(0);
    expect(await countAs({ reason: "public_ingest" })).toBe(0);
    expect(await countAs({ userId: adminId })).toBe(all);
    expect(await countAs({ reason: "system_task" })).toBe(all);
  });

  it("NEGATIVE: a non-admin cannot write a component", async () => {
    const [rec] = await db.select({ id: agentRegistryRecords.id }).from(agentRegistryRecords).where(eq(agentRegistryRecords.externalId, BOT));
    const err = await db
      .transaction(async (tx) => {
        await tx.execute(sql`select set_config('role', 'regulait_app', true)`);
        await tx.execute(sql`select set_config('regulait.user_id', ${memberId}, true)`);
        await tx.execute(sql`insert into agent_registry_record_components (record_id, kind, vendor_ref, display_name) values (${rec!.id}, 'tool', 'forged', 'forged')`);
      })
      .then(
        () => "no error",
        (e: unknown) => String((e as { cause?: unknown }).cause ?? e),
      );
    expect(err).toMatch(/row-level security/);
  });
});

describe("ADR-0336: the API shows components; the import audit counts them", () => {
  it("record detail lists the components, and import records how many in the same transaction", async () => {
    const [rec] = await db.select().from(agentRegistryRecords).where(eq(agentRegistryRecords.externalId, BOT));
    const d = await inject("GET", `/v1/agent-registry/records/${rec!.id}`, adminKey);
    expect(d.statusCode, d.body).toBe(200);
    expect(d.json().components).toEqual([{ kind: "knowledge", vendorRef: "d-1", displayName: "HR handbook", enabled: null, providedBy: null }]);

    const name = `cs-agent-${RUN}`;
    agentNames.push(name);
    const imp = await session(agentRegistryImportStepUpArgs({ recordId: rec!.id, name, tier: 2, stewardUserId: null }));
    const r = await imp("POST", `/v1/agent-registry/records/${rec!.id}/import`, { name, tier: 2 });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json().agent).toMatchObject({ provider: "microsoft", enabled: false, lifecycleStatus: "proposed" });
    const [row] = await db.select().from(auditLog).where(eq(auditLog.objectId, r.json().agent.id as string));
    expect((row!.detail as { components: number; grants: number }).components).toBe(1);
    expect((row!.detail as { grants: number }).grants).toBe(0);
  });

  it("deleting the source deletes its records' components (cascade)", async () => {
    const [rec] = await db.select({ id: agentRegistryRecords.id }).from(agentRegistryRecords).where(eq(agentRegistryRecords.externalId, BOT));
    await db.update(discoverySources).set({ enabled: false }).where(eq(discoverySources.id, sourceId));
    await db.delete(discoverySources).where(eq(discoverySources.id, sourceId));
    expect(await db.select().from(agentRegistryRecordComponents).where(eq(agentRegistryRecordComponents.recordId, rec!.id))).toEqual([]);
  });
});
