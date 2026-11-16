/**
 * ADR-0314 (G6) — vendor agent registry import on a real database through the real app (`buildApp`):
 *
 *  - DEFAULT OFF: the `agent_registry` family switch is off after the migration; a registry source cannot be created
 *    while it is off, and turning it on needs a `settings_relax` step-up bound to that family.
 *  - STAGING: a run of an enabled `agent_registry_entra` source stages its agents in `agent_registry_records` with
 *    provenance (source, run) and an audit row; a later COMPLETE read marks what it no longer lists as absent, and an
 *    INCOMPLETE read never does (the negative control). A record the scanner contract refuses fails the run.
 *  - IMPORT: needs a step-up bound to the record and the name (refused without one and with one for another name);
 *    the agent is created disabled, `proposed`, with no grant of any kind (default-deny); the record links to it and
 *    the audit row carries the provenance; a second import is refused; deleting the agent re-opens the record.
 *
 * Global state (M-068): the family switch is restored, and every source, agent and user this file creates is deleted.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  agentGrants,
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
  identityAgentGrants,
  inArray,
  runMigrations,
  stepUpGrants,
  users,
  workloadIdentities,
  type Db,
} from "@regulait/db";
import { DISCOVERY_PSEUDONYM_PREFIX, DISCOVERY_STEP_UP_KEYS, stepUpActionDigest, type AgentRegistry } from "@regulait/shared";
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
const BOOT = `r314-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const CSRF = { "x-regulait-csrf": "1" };
const DATA_KEY = createHash("sha256").update(`r314-data-key-${RUN}`).digest("hex");
const TENANT = "00000000-0000-4000-8000-000000000314";
const CLIENT = "00000000-0000-4000-8000-000000000315";
const ID_A = `aaaaaaaa-0000-4000-8000-${randomBytes(6).toString("hex")}`;
const ID_B = `bbbbbbbb-0000-4000-8000-${randomBytes(6).toString("hex")}`;

let db: Db;
let app: ReturnType<typeof buildApp>;
let adminId: string;
let adminKey: { authorization: string };
const restores: Array<() => Promise<void>> = [];
const sourceIds: string[] = [];
const agentNames: string[] = [];

/** what the test scanner reports on its next run */
let next: { records: RegistryAgentRecord[]; complete: AgentRegistry[] } = { records: [], complete: [] };
const testScanner: Scanner = {
  kind: "agent_registry_entra",
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

const settingsRow = async () => (await db.select().from(discoverySettings).where(eq(discoverySettings.id, 1)))[0]!;
const familiesStep = (families: string[]): StepUpCheckArgs => ({ kind: "settings_relax", facts: { values: { [DISCOVERY_STEP_UP_KEYS.families]: families } } });
const recordsOf = (sourceId: string) => db.select().from(agentRegistryRecords).where(eq(agentRegistryRecords.sourceId, sourceId));
const latestRun = async (sourceId: string) => (await db.select().from(discoveryRuns).where(eq(discoveryRuns.sourceId, sourceId)).orderBy(desc(discoveryRuns.createdAt)))[0]!;

let sourceId: string;
/** a vendor-side owner, as the scanner stages it (a pseudonym): R1 says it never becomes the steward */
const VENDOR_OWNER = `${DISCOVERY_PSEUDONYM_PREFIX}${"ab".repeat(12)}`;
async function runNow(records: RegistryAgentRecord[], complete: AgentRegistry[]) {
  next = { records, complete };
  const r = await inject("POST", `/v1/discovery/sources/${sourceId}/runs`, adminKey, {});
  expect(r.statusCode, r.body).toBe(202);
  await runDiscoveryPass(db, { registry, dataKey: DATA_KEY, owner: `r314-${RUN}-${randomBytes(3).toString("hex")}`, limit: 20 });
  return latestRun(sourceId);
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restores.push(await relaxIdentityForTest(db, { mfaRequired: "off" }));
  const s0 = await settingsRow();
  restores.push(async () => {
    await db.update(discoverySettings).set({ agentRegistrySourcesEnabled: s0.agentRegistrySourcesEnabled }).where(eq(discoverySettings.id, 1));
  });
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY, discoveryScanners: registry });
  const u = await inject("POST", "/v1/users", AUTH, { email: `r314-admin-${RUN}@example.com`, displayName: "r314 admin" });
  expect(u.statusCode, u.body).toBe(201);
  adminId = u.json().id as string;
  await db.update(users).set({ isAdmin: true }).where(eq(users.id, adminId));
  adminKey = { authorization: `Bearer ${(await inject("POST", `/v1/users/${adminId}/keys`, AUTH, { name: "k" })).json().token}` };
  await db.update(users).set({ totpEnabled: true }).where(eq(users.id, adminId));
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

describe("ADR-0314 agent registry import", () => {
  it("the family is off by default; turning it on needs its own step-up", async () => {
    await db.update(discoverySettings).set({ agentRegistrySourcesEnabled: false }).where(eq(discoverySettings.id, 1));
    expect((await inject("GET", "/v1/discovery/settings", adminKey)).json().families.agent_registry).toBe(false);
    const body = { name: `reg-${RUN}`, kind: "agent_registry_entra", target: { tenantId: TENANT }, scope: { orgLevel: true, include: [] } };
    const c = await inject("POST", "/v1/discovery/sources", adminKey, body);
    expect(c.statusCode, c.body).toBe(409);
    expect(c.json().error).toBe("family_disabled");

    const v0 = (await settingsRow()).version;
    // NEGATIVE CONTROLS: no grant; a grant for another family
    expect((await inject("PUT", "/v1/discovery/settings", adminKey, { version: v0, families: { agent_registry: true } })).statusCode).toBe(403);
    const wrong = await session(familiesStep(["identity"]));
    expect((await wrong("PUT", "/v1/discovery/settings", { version: v0, families: { agent_registry: true } })).statusCode).toBe(403);
    const on = await session(familiesStep(["agent_registry"]));
    const r = await on("PUT", "/v1/discovery/settings", { version: v0, families: { agent_registry: true } });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().families.agent_registry).toBe(true);

    const ok = await inject("POST", "/v1/discovery/sources", adminKey, body);
    expect(ok.statusCode, ok.body).toBe(201);
    const s = ok.json() as { id: string; version: number; kind: string; target: Record<string, string>; scope: unknown };
    sourceId = s.id;
    sourceIds.push(s.id);
    const cr = await inject("PUT", `/v1/discovery/sources/${s.id}/credential`, adminKey, { mode: "federated", publicConfig: { tenantId: TENANT, clientId: CLIENT }, replacesCredentialId: null });
    expect(cr.statusCode, cr.body).toBe(200);
    const credId = (await db.select().from(discoveryCredentials).where(eq(discoveryCredentials.sourceId, s.id)))[0]!.id;
    const en = await session(enableStepUpArgs(s.id, s.kind, s.target, s.scope, credId));
    expect((await en("POST", `/v1/discovery/sources/${s.id}/enable`, { version: s.version })).statusCode).toBe(200);
  });

  it("a run stages records with provenance; only a complete read marks a missing record absent", async () => {
    const a: RegistryAgentRecord = { registry: "entra_agent_id", externalId: ID_A, displayName: `HR helper ${RUN}`, attributes: { appId: CLIENT, accountEnabled: true, owners: [VENDOR_OWNER] } };
    const b: RegistryAgentRecord = { registry: "entra_agent_id", externalId: ID_B, displayName: `Invoice bot ${RUN}` };
    const run1 = await runNow([a, b], ["entra_agent_id"]);
    expect(run1.status, run1.errorDetail ?? "").toBe("succeeded");
    let recs = await recordsOf(sourceId);
    expect(recs.map((r) => r.externalId).sort()).toEqual([ID_A, ID_B].sort());
    expect(recs.every((r) => r.lastRunId === run1.id && r.agentId === null && r.absentSince === null)).toBe(true);
    const staged = await db.select().from(auditLog).where(eq(auditLog.objectId, run1.id));
    expect(staged.map((x) => x.ruleId)).toContain("agent-registry-records-staged");

    // NEGATIVE CONTROL: an incomplete read that misses B leaves B present
    const run2 = await runNow([a], []);
    expect(run2.status).toBe("succeeded");
    expect((await recordsOf(sourceId)).find((r) => r.externalId === ID_B)!.absentSince).toBeNull();
    // a complete read that misses B marks it absent; A is refreshed
    const run3 = await runNow([{ ...a, displayName: `HR helper v2 ${RUN}` }], ["entra_agent_id"]);
    expect(run3.status).toBe("succeeded");
    recs = await recordsOf(sourceId);
    expect(recs.find((r) => r.externalId === ID_B)!.absentSince).not.toBeNull();
    const ra = recs.find((r) => r.externalId === ID_A)!;
    expect(ra.displayName).toBe(`HR helper v2 ${RUN}`);
    expect(ra.lastRunId).toBe(run3.id);
    // listed again: no longer absent
    await runNow([a, b], ["entra_agent_id"]);
    expect((await recordsOf(sourceId)).find((r) => r.externalId === ID_B)!.absentSince).toBeNull();
  });

  it("a record the scanner contract refuses fails the run and stages nothing", async () => {
    const before = (await recordsOf(sourceId)).length;
    const bad = await runNow([{ registry: "gemini_enterprise", externalId: "projects/x/agents/y", displayName: "wrong registry" }], []);
    expect(bad.status).toBe("failed");
    expect(bad.errorCode).toBe("observation_refused");
    const named = await runNow([{ registry: "entra_agent_id", externalId: "cccccccc-0000-4000-8000-000000000001", displayName: "x", attributes: { owners: ["Avery Admin"] } }], []);
    expect(named.status).toBe("failed");
    expect((await recordsOf(sourceId)).length).toBe(before);
  });

  it("lists open records, and imports one only with the step-up bound to it: disabled, proposed, no grants", async () => {
    const list = await inject("GET", `/v1/agent-registry/records?status=open&sourceId=${sourceId}`, adminKey);
    expect(list.statusCode, list.body).toBe(200);
    const rec = (list.json().records as Array<{ id: string; externalId: string; source: { name: string } }>).find((r) => r.externalId === ID_A)!;
    expect(rec.source.name).toBe(`reg-${RUN}`);
    const name = `imported-hr-${RUN}`;
    agentNames.push(name, `other-${RUN}`);

    // NEGATIVE CONTROLS: no step-up; a step-up for another name
    const none = await inject("POST", `/v1/agent-registry/records/${rec.id}/import`, adminKey, { name, tier: 2 });
    expect(none.statusCode).toBe(403);
    const bound = { recordId: rec.id, name, tier: 2, stewardUserId: null };
    for (const other of [{ name: `other-${RUN}` }, { tier: 3 }, { stewardUserId: adminId }]) {
      const wrong = await session(agentRegistryImportStepUpArgs({ ...bound, ...other }));
      expect((await wrong("POST", `/v1/agent-registry/records/${rec.id}/import`, { name, tier: 2 })).statusCode, JSON.stringify(other)).toBe(403);
    }
    // the shared owner check (checkOwnerTarget): an unknown steward is a 422 before any step-up is spent
    const ghost = await inject("POST", `/v1/agent-registry/records/${rec.id}/import`, adminKey, { name, tier: 2, stewardUserId: randomUUID() });
    expect(ghost.statusCode).toBe(422);
    expect(ghost.json().error).toBe("unknown_owner");
    expect((await db.select().from(agents).where(eq(agents.name, name))).length).toBe(0);

    // the staged record carries a vendor owner; R1: it is never made the steward
    const [staged] = await db.select().from(agentRegistryRecords).where(eq(agentRegistryRecords.id, rec.id));
    expect((staged!.vendorAttributes as { owners?: string[] }).owners).toEqual([VENDOR_OWNER]);
    const ok = await session(agentRegistryImportStepUpArgs(bound));
    const r = await ok("POST", `/v1/agent-registry/records/${rec.id}/import`, { name, tier: 2 });
    expect(r.statusCode, r.body).toBe(201);
    const agentId = r.json().agent.id as string;
    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    expect(agent).toMatchObject({ name, provider: "microsoft", tier: 2, enabled: false, lifecycleStatus: "proposed", ownerUserId: null, model: null });
    expect(agent!.lifecycleReason).toContain("Microsoft Entra Agent ID");
    // default-deny: no grant of any kind names the new agent
    expect(await db.select().from(agentGrants).where(eq(agentGrants.agentId, agentId))).toEqual([]);
    expect(await db.select().from(identityAgentGrants).where(eq(identityAgentGrants.agentId, agentId))).toEqual([]);
    expect(await db.select().from(workloadIdentities).where(eq(workloadIdentities.agentId, agentId))).toEqual([]);
    // provenance: the record links to it, the audit row names source, registry, vendor id and run
    const [linked] = await db.select().from(agentRegistryRecords).where(eq(agentRegistryRecords.id, rec.id));
    expect(linked!.agentId).toBe(agentId);
    expect(linked!.importedByUserId).toBe(adminId);
    const [a] = await db.select().from(auditLog).where(eq(auditLog.objectId, agentId));
    expect(a!.ruleId).toBe("agent-registry-imported");
    expect((a!.detail as { provenance: Record<string, unknown> }).provenance).toMatchObject({ recordId: rec.id, sourceId, registry: "entra_agent_id", externalId: ID_A });
    const prov = await inject("GET", `/v1/agent-registry/records?status=imported&agentId=${agentId}`, adminKey);
    expect(prov.json().records.map((x: { id: string }) => x.id)).toEqual([rec.id]);

    // R2: the vendor renames the agent after import; only the staged record moves, the agent keeps its name
    const renamed = `HR helper renamed ${RUN}`;
    expect((await runNow([{ registry: "entra_agent_id", externalId: ID_A, displayName: renamed }], [])).status).toBe("succeeded");
    const [afterRename] = await db.select().from(agentRegistryRecords).where(eq(agentRegistryRecords.id, rec.id));
    expect(afterRename!.displayName).toBe(renamed);
    expect(afterRename!.agentId).toBe(agentId);
    expect((await db.select().from(agents).where(eq(agents.id, agentId)))[0]!.name).toBe(name);

    // a second import is refused before any step-up is asked
    const again = await inject("POST", `/v1/agent-registry/records/${rec.id}/import`, adminKey, { name: `other-${RUN}`, tier: 1 });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe("already_imported");

    // deleting the agent re-opens the record (ON DELETE SET NULL), keeping when it was imported
    await db.delete(agents).where(eq(agents.id, agentId));
    const [reopened] = await db.select().from(agentRegistryRecords).where(eq(agentRegistryRecords.id, rec.id));
    expect(reopened!.agentId).toBeNull();
    expect(reopened!.importedAt).not.toBeNull();
  });

  it("validates input and paginates", async () => {
    expect((await inject("GET", "/v1/agent-registry/records?limit=1000", adminKey)).statusCode).toBe(400);
    expect((await inject("GET", "/v1/agent-registry/records/not-a-uuid", adminKey)).statusCode).toBe(400);
    expect((await inject("GET", `/v1/agent-registry/records/${randomUUID()}`, adminKey)).statusCode).toBe(404);
    const p1 = await inject("GET", `/v1/agent-registry/records?status=all&sourceId=${sourceId}&limit=1`, adminKey);
    expect(p1.json().records).toHaveLength(1);
    const cursor = p1.json().nextCursor as string;
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect((await inject("GET", `/v1/agent-registry/records?cursor=${Buffer.from('["x","y"]').toString("base64url")}`, adminKey)).statusCode).toBe(400);
    const p2 = await inject("GET", `/v1/agent-registry/records?status=all&sourceId=${sourceId}&limit=1&cursor=${cursor}`, adminKey);
    expect(p2.json().records).toHaveLength(1);
    expect(p2.json().records[0].id).not.toBe(p1.json().records[0].id);
  });
});
