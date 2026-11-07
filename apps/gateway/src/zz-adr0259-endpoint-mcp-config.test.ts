/**
 * ADR-0259 (P35) — MCP client configs on employee machines, end to end (real database).
 *
 *  - the org switch is off by default; turning it on is a `settings_relax` step-up bound to it (refused without one,
 *    refused with a grant for something else), audited; turning it off is free;
 *  - while it is off, a signed report's mcp_config facts are counted and refused: nothing is stored, no sighting;
 *  - while it is on, each configured server is stored per device with the registry diff (`registered` by host,
 *    `linked` by an admin, else `unregistered`), feeds the host config's shadow-AI device finding, and keeps a
 *    secret only as its TYPE: no key name, no value, no argument anywhere in storage or audit;
 *  - linking and unlinking are admin-only and audited; the list filters by status, risk and secrets;
 *  - a newer complete report prunes servers no longer configured; a report with an mcp_config gap prunes nothing;
 *    an older report never overwrites a newer row;
 *  - malformed server facts (a path as a command, a fact without a server) are refused with the fixed code;
 *  - the endpoint retention deletes rows not seen within it.
 *
 * Everything this suite creates is removed in afterAll.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  aiEndpointSignatures,
  auditLog,
  authSessions,
  createDb,
  discoveryPseudonymKeys,
  discoveryRuns,
  discoverySettings,
  discoverySources,
  endpointAgentReports,
  endpointDevices,
  endpointMcpServerLinks,
  endpointMcpServers,
  eq,
  inArray,
  mcpServers,
  runMigrations,
  shadowAiFindings,
  shadowAiImports,
  sql,
  stepUpGrants,
  users,
  type Db,
} from "@regulait/db";
import { DISCOVERY_STEP_UP_KEYS, stepUpActionDigest } from "@regulait/shared";
import { buildApp } from "./app.js";
import { runEndpointAgentIngest } from "./endpoint-agent-routes.js";
import { endpointOrgPolicy, mcpSightingsOf, type McpConfigFact } from "./endpoint-mcp-config.js";
import { runEndpointRetention } from "./discovery-worker.js";
import type { StepUpCheckArgs } from "./step-up.js";
import { endpointAgentKeys } from "./testing/endpoint-agent-client.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { useTestIssuerKey } from "./testing/workload-client.js";
import { hashToken } from "./token-hash.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = randomBytes(3).toString("hex");
const BOOT = `p35-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const CSRF = { "x-regulait-csrf": "1" };
const ORIGIN = "http://localhost";
// synthetic, derived at runtime: never a secret-shaped literal
const DATA_KEY = createHash("sha256").update(`p35-data-key-${RUN}`).digest("hex");
const PROVIDER = `p35prov-${RUN}`;
const CONFIG = `.config/p35-${RUN}/mcp.json`;
const KEY_NAME = `P35_SECRET_NAME_${RUN.toUpperCase()}`;
const REGISTERED_HOST = `mcp-${RUN}.example.invalid`;
const PKG = `@p35-${RUN}/server`;
const prevPublicUrl = process.env.REGULAIT_PUBLIC_URL;
process.env.REGULAIT_PUBLIC_URL = ORIGIN;

let db: Db;
let app: ReturnType<typeof buildApp>;
let adminId: string;
let adminKey: { authorization: string };
let memberKey: { authorization: string };
const restores: Array<() => Promise<void>> = [];
const sourceIds: string[] = [];
const serverIds: string[] = [];
let signatureId: string;

type Method = "GET" | "POST" | "PUT";
const inject = (method: Method, url: string, headers: Record<string, string>, payload?: unknown) =>
  app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload: payload as object }) });
const AgentKey = endpointAgentKeys(() => app, DATA_KEY, ORIGIN);

const settingsRow = async () => (await db.select().from(discoverySettings).where(eq(discoverySettings.id, 1)))[0]!;
const mcpStep: StepUpCheckArgs = { kind: "settings_relax", facts: { values: { [DISCOVERY_STEP_UP_KEYS.endpointMcpConfig]: true } } };
const setSwitch = (on: boolean) => db.update(discoverySettings).set({ endpointMcpConfigEnabled: on }).where(eq(discoverySettings.id, 1));

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

const now = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString().replace(/\.\d{3}Z$/, "Z");

const server = (over: Record<string, unknown>) => ({
  kind: "mcp_config",
  signatureId: "sig.p35.host",
  provider: PROVIDER,
  matchedOn: "mcpServer",
  identifier: CONFIG,
  location: { root: "home", path: CONFIG },
  server: over,
});

const SERVERS = {
  fs: server({ name: "filesystem", transport: "stdio", command: "npx", package: PKG, risks: ["host_root_mount", "unpinned_package"], keys: [{ keyName: KEY_NAME, ruleId: "dlp.secret.provider_token", present: true }] }),
  remote: server({ name: "remote", transport: "http", host: REGISTERED_HOST, keys: [{ keyName: "Authorization", ruleId: "mcp.secret.authorization_header", present: true }] }),
  shell: server({ name: "shell", transport: "stdio", command: "bash", risks: ["shell_launcher", "risky_tool_auto_approved"], riskyTools: ["run_command"], autoApprovedTools: 2 }),
};

const reportBody = (o: { snapshotId: string; collectedAt?: string; facts: unknown[]; gaps?: unknown[] }) =>
  JSON.stringify({
    schema: "regulait.endpoint-report/1",
    snapshotId: o.snapshotId,
    collectedAt: o.collectedAt ?? now(),
    agentVersion: "0.1.0",
    os: "linux",
    arch: "amd64",
    manifestVersion: "1.0.0",
    manifestDigest: "0".repeat(64),
    keyProtection: "hardware",
    droppedSnapshots: 0,
    facts: o.facts,
    gaps: o.gaps ?? [],
    factsDigest: "1".repeat(64),
  });

let seq = 0;
async function enrolled() {
  const r = await inject("POST", "/v1/discovery/sources", AUTH, { name: `p35-agent-${RUN}-${++seq}`, kind: "endpoint_agent", target: { fleet: `fleet-${RUN}` }, scope: { orgLevel: true, include: [] } });
  expect(r.statusCode, r.body).toBe(201);
  const sourceId = r.json().id as string;
  sourceIds.push(sourceId);
  // enabling is SD0's step-up route (covered by SD0's suite); here the row is set directly
  await db.update(discoverySources).set({ enabled: true, enabledAt: new Date(), enabledBy: adminId }).where(eq(discoverySources.id, sourceId));
  const tok = await inject("POST", `/v1/discovery/sources/${sourceId}/enrolment-tokens`, AUTH, { label: `p35-${RUN}`, deviceCap: 5 });
  expect(tok.statusCode, tok.body).toBe(201);
  const t = await inject("POST", "/v1/endpoint-agent/enrolment-tickets", { authorization: `Bearer ${tok.json().enrolFile.token}` }, { hostname: `p35-host-${RUN}`, os: "linux", arch: "amd64", agentVersion: "0.1.0" });
  expect(t.statusCode, t.body).toBe(201);
  const key = await AgentKey.make();
  const reg = await inject("POST", "/v1/endpoint-agent/register", { authorization: `Bearer ${t.json().ticket}` }, {
    publicJwk: key.jwk,
    keyProtection: "hardware",
    keyProvider: "tpm",
    agentVersion: "0.1.0",
    os: "linux",
    arch: "amd64",
    deviceUser: `p35user${RUN}`,
  });
  expect(reg.statusCode, reg.body).toBe(201);
  return { sourceId, deviceId: t.json().ticketId as string, key };
}

async function send(a: Awaited<ReturnType<typeof enrolled>>, facts: unknown[], o: { collectedAt?: string; gaps?: unknown[] } = {}) {
  const snapshotId = randomUUID();
  const r = await a.key.report(reportBody({ snapshotId, facts, ...o }), snapshotId);
  expect(r.statusCode, r.body).toBe(202);
  return snapshotId;
}

const rowsOf = (deviceId: string) => db.select().from(endpointMcpServers).where(eq(endpointMcpServers.deviceId, deviceId));
const list = (q = "") => inject("GET", `/v1/discovery/endpoint-mcp-servers${q}`, adminKey);

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restores.push(await relaxIdentityForTest(db, { mfaRequired: "off" }));
  restores.push(await useTestIssuerKey(db));
  // the per-tenant pseudonym key is wrapped under the first data key that asks for it, and a gateway shard runs
  // several suites with different data keys on one database: set the existing key aside, put it back afterwards
  const priorPseudonymKeys = await db.select().from(discoveryPseudonymKeys);
  await db.delete(discoveryPseudonymKeys);
  restores.push(async () => {
    await db.delete(discoveryPseudonymKeys);
    if (priorPseudonymKeys.length) await db.insert(discoveryPseudonymKeys).values(priorPseudonymKeys);
  });
  const s0 = await settingsRow();
  restores.push(async () => {
    await setSwitch(s0.endpointMcpConfigEnabled);
  });
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });
  await app.ready();
  const a = await inject("POST", "/v1/users", AUTH, { email: `p35-admin-${RUN}@example.com`, displayName: "p35 admin" });
  expect(a.statusCode, a.body).toBe(201);
  adminId = a.json().id as string;
  await db.update(users).set({ isAdmin: true }).where(eq(users.id, adminId));
  adminKey = { authorization: `Bearer ${(await inject("POST", `/v1/users/${adminId}/keys`, AUTH, { name: "k" })).json().token}` };
  await db.update(users).set({ totpEnabled: true }).where(eq(users.id, adminId));
  const m = await inject("POST", "/v1/users", AUTH, { email: `p35-member-${RUN}@example.com`, displayName: "p35 member" });
  memberKey = { authorization: `Bearer ${(await inject("POST", `/v1/users/${m.json().id}/keys`, AUTH, { name: "k" })).json().token}` };
  const [sig] = await db
    .insert(aiEndpointSignatures)
    .values({ provider: PROVIDER, kind: "assistant_config", value: CONFIG, matchType: "identifier", provenance: "admin", enabled: true })
    .returning({ id: aiEndpointSignatures.id });
  signatureId = sig!.id;
  const [srv] = await db.insert(mcpServers).values({ name: `p35-registered-${RUN}`, url: `https://${REGISTERED_HOST}/mcp` }).returning({ id: mcpServers.id });
  serverIds.push(srv!.id);
}, 120_000);

afterAll(async () => {
  if (adminId) await db.update(users).set({ totpEnabled: false }).where(eq(users.id, adminId));
  if (sourceIds.length) {
    const runs = (await db.select({ id: discoveryRuns.id }).from(discoveryRuns).where(inArray(discoveryRuns.sourceId, sourceIds))).map((r) => r.id);
    if (runs.length) {
      const imports = (await db.select({ id: shadowAiImports.id }).from(shadowAiImports).where(inArray(shadowAiImports.discoveryRunId, runs))).map((r) => r.id);
      if (imports.length) {
        await db.delete(shadowAiFindings).where(inArray(shadowAiFindings.lastImportId, imports));
        await db.delete(shadowAiImports).where(inArray(shadowAiImports.id, imports));
      }
    }
    await db.update(discoverySources).set({ enabled: false }).where(inArray(discoverySources.id, sourceIds));
    await db.delete(discoverySources).where(inArray(discoverySources.id, sourceIds));
  }
  await db.delete(endpointMcpServerLinks).where(sql`${endpointMcpServerLinks.identity} LIKE ${`%${RUN}%`}`);
  if (serverIds.length) await db.delete(mcpServers).where(inArray(mcpServers.id, serverIds));
  if (signatureId) await db.delete(aiEndpointSignatures).where(eq(aiEndpointSignatures.id, signatureId));
  for (const r of restores.reverse()) await r();
  await app?.close();
  if (prevPublicUrl === undefined) delete process.env.REGULAIT_PUBLIC_URL;
  else process.env.REGULAIT_PUBLIC_URL = prevPublicUrl;
});

describe("ADR-0259: the org switch", () => {
  it("is off by default; on needs the step-up bound to it (audited); off is free", async () => {
    await setSwitch(false);
    expect((await inject("GET", "/v1/discovery/settings", adminKey)).json().endpointMcpConfig).toBe(false);
    const v0 = (await settingsRow()).version;
    // NEGATIVE CONTROLS: no grant, and a grant for another relaxation
    expect((await inject("PUT", "/v1/discovery/settings", adminKey, { version: v0, endpointMcpConfig: true })).statusCode).toBe(403);
    const wrong = await session({ kind: "settings_relax", facts: { values: { [DISCOVERY_STEP_UP_KEYS.families]: ["saas"] } } });
    expect((await wrong("PUT", "/v1/discovery/settings", { version: v0, endpointMcpConfig: true })).statusCode).toBe(403);
    expect((await settingsRow()).endpointMcpConfigEnabled).toBe(false);

    const on = await session(mcpStep);
    const r = await on("PUT", "/v1/discovery/settings", { version: v0, endpointMcpConfig: true });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().endpointMcpConfig).toBe(true);
    const [relaxed] = await db
      .select()
      .from(auditLog)
      .where(sql`${auditLog.objectType} = 'discovery_settings' AND ${auditLog.ruleId} = 'discovery-settings-relaxed' AND ${auditLog.detail}->'after'->>'endpointMcpConfig' = 'true' AND ${auditLog.userId} = ${adminId}`);
    expect(relaxed).toBeDefined();

    const off = await inject("PUT", "/v1/discovery/settings", adminKey, { version: v0 + 1, endpointMcpConfig: false });
    expect(off.statusCode, off.body).toBe(200);
    expect(off.json().endpointMcpConfig).toBe(false);
    // the policy the agent is served follows the switch
    expect(endpointOrgPolicy({ endpointMcpConfig: false }).enabledOptInKinds).toEqual([]);
    expect(endpointOrgPolicy({ endpointMcpConfig: true }).enabledOptInKinds).toEqual(["mcp_config"]);
  });
});

describe("ADR-0259: reports", () => {
  it("while off: counts and refuses mcp_config facts, stores nothing", async () => {
    await setSwitch(false);
    const a = await enrolled();
    const snapshotId = await send(a, [SERVERS.fs, SERVERS.remote]);
    await runEndpointAgentIngest(db);
    const [stored] = await db.select().from(endpointAgentReports).where(eq(endpointAgentReports.snapshotId, snapshotId));
    expect(stored!.factsMcpRefused).toBe(2);
    expect(stored!.sightings).toEqual([]);
    expect(await rowsOf(a.deviceId)).toEqual([]);
    const [device] = await db.select().from(endpointDevices).where(eq(endpointDevices.id, a.deviceId));
    expect(await db.select().from(shadowAiFindings).where(eq(shadowAiFindings.subject, device!.devicePseudonym))).toEqual([]);
    const page = (await list(`?deviceId=${a.deviceId}`)).json();
    expect(page.enabled).toBe(false);
    expect(page.items).toEqual([]);
  });

  it("while on: stores each server with the registry diff, feeds the device finding, keeps secrets as types only", async () => {
    await setSwitch(true);
    const a = await enrolled();
    await send(a, [SERVERS.fs, SERVERS.remote, SERVERS.shell]);
    await runEndpointAgentIngest(db);
    const rows = await rowsOf(a.deviceId);
    expect(rows.map((r) => r.serverName).sort()).toEqual(["filesystem", "remote", "shell"]);
    const fs = rows.find((r) => r.serverName === "filesystem")!;
    expect(fs).toMatchObject({ identityKind: "package", identity: PKG, transport: "stdio", command: "npx", secretTypes: ["dlp.secret.provider_token"], risks: ["host_root_mount", "unpinned_package"] });

    const page = (await list(`?deviceId=${a.deviceId}`)).json();
    expect(page.enabled).toBe(true);
    const by = new Map<string, { registry: { status: string; mcpServerId: string | null }; findingId: string | null; verdict: string }>(
      page.items.map((i: { serverName: string }) => [i.serverName, i]),
    );
    expect(by.get("remote")!.registry).toMatchObject({ status: "registered", mcpServerId: serverIds[0] });
    expect(by.get("filesystem")!.registry.status).toBe("unregistered");
    expect(by.get("filesystem")!.verdict).toMatch(/^UNREGISTERED/);
    // the host config's catalogue sighting fed the existing shadow-AI device finding
    const [device] = await db.select().from(endpointDevices).where(eq(endpointDevices.id, a.deviceId));
    const [finding] = await db.select().from(shadowAiFindings).where(eq(shadowAiFindings.subject, device!.devicePseudonym));
    expect(finding!.provider).toBe(PROVIDER);
    expect(finding!.signalSources).toContain("endpoint_agent");
    expect(by.get("filesystem")!.findingId).toBe(finding!.id);

    // filters
    const risky = (await list(`?deviceId=${a.deviceId}&risky=true`)).json().items.map((i: { serverName: string }) => i.serverName).sort();
    expect(risky).toEqual(["filesystem", "shell"]);
    const unreg = (await list(`?deviceId=${a.deviceId}&status=unregistered`)).json().items.map((i: { serverName: string }) => i.serverName).sort();
    expect(unreg).toEqual(["filesystem", "shell"]);
    const secrets = (await list(`?deviceId=${a.deviceId}&secrets=true`)).json().items.map((i: { serverName: string }) => i.serverName).sort();
    expect(secrets).toEqual(["filesystem", "remote"]);

    // a secret is stored only as its type: the key's name appears nowhere
    const reports = await db.select().from(endpointAgentReports).where(eq(endpointAgentReports.deviceId, a.deviceId));
    const audits = await db.select({ d: auditLog.detail, r: auditLog.reason }).from(auditLog).where(sql`${auditLog.detail}->>'subsystem' = 'shadow-ai-discovery'`);
    expect(JSON.stringify({ rows, reports, audits, page })).not.toContain(KEY_NAME);
  });

  it("links and unlinks an identity to an approved server: admin-only, audited", async () => {
    await setSwitch(true);
    const a = await enrolled();
    await send(a, [SERVERS.fs]);
    const link = { identityKind: "package", identity: PKG, mcpServerId: serverIds[0] };
    expect((await inject("POST", "/v1/discovery/endpoint-mcp-server-links", memberKey, link)).statusCode).toBe(403);
    expect((await inject("GET", "/v1/discovery/endpoint-mcp-servers", memberKey)).statusCode).toBe(403);
    expect((await inject("POST", "/v1/discovery/endpoint-mcp-server-links", adminKey, { ...link, mcpServerId: randomUUID() })).statusCode).toBe(404);
    expect((await inject("POST", "/v1/discovery/endpoint-mcp-server-links", adminKey, { ...link, identity: "free text with spaces" })).statusCode).toBe(400);
    const r = await inject("POST", "/v1/discovery/endpoint-mcp-server-links", adminKey, link);
    expect(r.statusCode, r.body).toBe(201);
    const item = (await list(`?deviceId=${a.deviceId}`)).json().items[0];
    expect(item.registry).toMatchObject({ status: "linked", mcpServerId: serverIds[0] });
    expect((await list(`?deviceId=${a.deviceId}&status=linked`)).json().items.length).toBe(1);
    const linkedAudit = await db.select().from(auditLog).where(sql`${auditLog.ruleId} = 'endpoint-mcp-server-linked' AND ${auditLog.detail}->>'identity' = ${PKG}`);
    expect(linkedAudit.length).toBe(1);
    const u = await inject("POST", "/v1/discovery/endpoint-mcp-server-links/remove", adminKey, { identityKind: "package", identity: PKG });
    expect(u.statusCode, u.body).toBe(200);
    expect((await list(`?deviceId=${a.deviceId}`)).json().items[0].registry.status).toBe("unregistered");
    expect((await inject("POST", "/v1/discovery/endpoint-mcp-server-links/remove", adminKey, { identityKind: "package", identity: PKG })).statusCode).toBe(404);
    expect((await db.select().from(auditLog).where(sql`${auditLog.ruleId} = 'endpoint-mcp-server-unlinked' AND ${auditLog.detail}->>'identity' = ${PKG}`)).length).toBe(1);
  });

  it("prunes servers a newer complete report no longer lists; a gap prunes nothing; an older report never overwrites", async () => {
    await setSwitch(true);
    const a = await enrolled();
    await send(a, [SERVERS.fs, SERVERS.shell], { collectedAt: now(-60_000) });
    expect((await rowsOf(a.deviceId)).length).toBe(2);
    // a report that could not read every config: nothing is pruned
    await send(a, [SERVERS.fs], { collectedAt: now(-30_000), gaps: [{ kind: "mcp_config", reason: "permission_denied" }] });
    expect((await rowsOf(a.deviceId)).length).toBe(2);
    // a complete newer report without `shell`: it is pruned
    await send(a, [SERVERS.fs], { collectedAt: now() });
    expect((await rowsOf(a.deviceId)).map((r) => r.serverName)).toEqual(["filesystem"]);
    // an older report (still fresh) carrying a changed entry does not overwrite the newer row
    const older = server({ name: "filesystem", transport: "stdio", command: "npx", package: PKG, packageVersion: "9.9.9" });
    await send(a, [older], { collectedAt: now(-90_000) });
    const [fs] = await rowsOf(a.deviceId);
    expect(fs!.packageVersion).toBeNull();
  });

  it("refuses malformed server facts with the fixed code", async () => {
    await setSwitch(true);
    const a = await enrolled();
    for (const bad of [
      server({ name: "x", transport: "stdio", command: "/home/alice/bin/server" }),
      server({ name: "x", transport: "stdio", package: "../../etc/passwd" }),
      server({ name: "x", transport: "stdio", risks: ["not_a_risk"] }),
      { ...SERVERS.fs, server: undefined },
      { ...SERVERS.fs, matchedOn: "file" },
      { kind: "assistant_config", signatureId: "s", provider: PROVIDER, matchedOn: "file", identifier: CONFIG, location: { root: "home", path: CONFIG }, server: { name: "x", transport: "stdio" } },
    ]) {
      const snapshotId = randomUUID();
      const r = await a.key.report(reportBody({ snapshotId, facts: [bad] }), snapshotId);
      expect(r.statusCode, JSON.stringify(bad)).toBe(400);
      expect(r.json()).toEqual({ error: "invalid_body" });
    }
  });

  it("the endpoint retention deletes rows not seen within it", async () => {
    await setSwitch(true);
    const a = await enrolled();
    await send(a, [SERVERS.shell]);
    await db.update(endpointMcpServers).set({ firstSeenAt: new Date(Date.now() - 400 * 86_400_000), lastSeenAt: new Date(Date.now() - 400 * 86_400_000) }).where(eq(endpointMcpServers.deviceId, a.deviceId));
    const out = await runEndpointRetention(db);
    expect(out.mcpServersDeleted).toBeGreaterThanOrEqual(1);
    expect(await rowsOf(a.deviceId)).toEqual([]);
  });
});

describe("ADR-0259: reduction (no database)", () => {
  it("keeps a secret's type, never its name, and picks the package, host or command as the identity", () => {
    const out = mcpSightingsOf([
      SERVERS.fs as unknown as McpConfigFact,
      SERVERS.remote as unknown as McpConfigFact,
      SERVERS.shell as unknown as McpConfigFact,
    ]);
    expect(out.map((s) => [s.identityKind, s.identity])).toEqual([
      ["package", PKG],
      ["host", REGISTERED_HOST],
      ["command", "bash"],
    ]);
    expect(JSON.stringify(out)).not.toContain(KEY_NAME);
    expect(out[1]!.secretTypes).toEqual(["mcp.secret.authorization_header"]);
  });
});
