/**
 * ADR-0351 slice 3 — the `endpoint_benchmark_check` collector's eight fleet-wide checks.
 *
 * The checks read the whole fleet, so this file runs on its OWN scratch database (prefix `e32_eb_`), dropped in
 * afterAll: rows other files leave in the shared database would otherwise decide the answers.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import {
  createDb,
  discoverySources,
  endpointAddons,
  endpointAddonSightings,
  endpointAddonSightingSecretTypes,
  endpointAddonVersions,
  endpointAgentIdentities,
  endpointDevices,
  endpointEnrolmentTokens,
  endpointMcpServerLinks,
  endpointMcpServers,
  eq,
  mcpDefinitionPins,
  mcpServers,
  runMigrations,
  sql,
  users,
  workloadIdentities,
  type Db,
} from "@regulait/db";
import { ENDPOINT_BENCHMARK_CHECKS, ENDPOINT_BENCHMARK_PACK } from "@regulait/shared";
import { closeAll, dropScratchDatabase } from "./testing/scratch-db.js";
import { runEndpointBenchmarkCheck } from "./endpoint-benchmark-checks.js";
import { runCollector } from "./compliance-packs.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");
const SCRATCH_DB = `e32_eb_${process.pid}_${Date.now()}`;
const scratchUrl = () => {
  const u = new URL(DATABASE_URL);
  u.pathname = "/" + SCRATCH_DB;
  return u.toString();
};
const hex = (seed: string, n: number) => Buffer.from(seed.repeat(n)).toString("hex").slice(0, n);
const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000);

let admin: Db;
let db: Db;
let sourceId: string;
let tokenId: string;
let userId: string;
let deviceId: string;
let mcpEntryId: string;
let serverId: string;

const run = (c: (typeof ENDPOINT_BENCHMARK_CHECKS)[number]) => runEndpointBenchmarkCheck(db, c);
const device = (psn: string) => ({
  sourceId,
  tokenId,
  devicePseudonym: `psn:${hex(psn, 24)}`,
  os: "linux" as const,
  arch: "amd64" as const,
  agentVersion: "1.0.0",
  ticketHash: hex(`t-${psn}`, 64),
  ticketExpiresAt: new Date(Date.now() + 86_400_000),
});

beforeAll(async () => {
  admin = createDb(DATABASE_URL);
  await admin.execute(sql.raw(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`));
  await admin.execute(sql.raw(`CREATE DATABASE ${SCRATCH_DB}`));
  db = createDb(scratchUrl());
  await runMigrations(db, migrationsFolder);
  const [u] = await db.insert(users).values({ email: `e32-eb-${Date.now()}@example.com`, displayName: "e32" }).returning({ id: users.id });
  userId = u!.id;
  const [src] = await db
    .insert(discoverySources)
    .values({ name: "e32-eb", kind: "endpoint_agent", target: {}, scope: { orgLevel: true, include: [] }, createdBy: userId })
    .returning({ id: discoverySources.id });
  sourceId = src!.id;
  const [tok] = await db
    .insert(endpointEnrolmentTokens)
    .values({ sourceId, label: "e32", tokenHash: hex("tok", 64), deviceCap: 5, expiresAt: new Date(Date.now() + 86_400_000) })
    .returning({ id: endpointEnrolmentTokens.id });
  tokenId = tok!.id;
});

afterAll(async () => {
  await closeAll([
    async () => db?.$client.end(),
    async () => dropScratchDatabase(admin, SCRATCH_DB),
    async () => admin?.$client.end(),
  ]);
});

describe("an empty fleet never passes", () => {
  it("every check is 0 with no enrolled device", async () => {
    for (const c of ENDPOINT_BENCHMARK_CHECKS) expect(await run(c), c).toBe(0);
  });
});

describe("with one enrolled device", () => {
  beforeAll(async () => {
    const [d] = await db.insert(endpointDevices).values({ ...device("a"), lastReportAt: new Date() }).returning({ id: endpointDevices.id });
    deviceId = d!.id;
    // a revoked device is out of every check, however bad it looks
    await db.insert(endpointDevices).values({ ...device("revoked"), lastReportAt: daysAgo(90), revokedAt: new Date(Date.now() + 60_000) });
  });

  it("devices_reporting_7d: passes when every unrevoked device reported in 7 days", async () => {
    expect(await run("devices_reporting_7d")).toBe(1);
    const [stale] = await db.insert(endpointDevices).values({ ...device("stale"), lastReportAt: daysAgo(8) }).returning({ id: endpointDevices.id });
    expect(await run("devices_reporting_7d")).toBe(0);
    await db.delete(endpointDevices).where(eq(endpointDevices.id, stale!.id));
    expect(await run("devices_reporting_7d")).toBe(1);
  });

  it("agent_keys_hardware: needs at least one identity, all in hardware", async () => {
    expect(await run("agent_keys_hardware")).toBe(0);
    const identity = async (protection: "hardware" | "software") => {
      const [w] = await db
        .insert(workloadIdentities)
        .values({ kind: "endpoint_agent", identifier: `spiffe://regulait.test/endpoint/${randomUUID()}`, sponsorUserIds: [userId] })
        .returning({ id: workloadIdentities.id });
      await db.insert(endpointAgentIdentities).values({
        identityId: w!.id,
        deviceId,
        deviceUserPseudonym: `psn:${hex(`${protection}-${randomUUID()}`, 24)}`,
        keyProtection: protection,
        keyProvider: protection === "hardware" ? "tpm" : "file",
        agentVersion: "1.0.0",
      });
      return w!.id;
    };
    await identity("hardware");
    expect(await run("agent_keys_hardware")).toBe(1);
    const soft = await identity("software");
    expect(await run("agent_keys_hardware")).toBe(0);
    await db.delete(endpointAgentIdentities).where(eq(endpointAgentIdentities.identityId, soft));
    expect(await run("agent_keys_hardware")).toBe(1);
  });

  it("the MCP configuration checks pass on a clean, linked server and fail on each flag", async () => {
    const [entry] = await db
      .insert(endpointMcpServers)
      .values({
        deviceId,
        lastReportId: deviceId,
        signatureId: "sig.e32",
        provider: "claude_code",
        configRoot: "home",
        configPath: ".claude.json",
        serverName: "files",
        transport: "stdio",
        command: "npx",
        package: "@example/mcp-files",
        identityKind: "package",
        identity: "@example/mcp-files",
        firstSeenAt: daysAgo(2),
        lastSeenAt: daysAgo(1),
      })
      .returning({ id: endpointMcpServers.id });
    mcpEntryId = entry!.id;
    expect(await run("mcp_no_auto_approved_tools")).toBe(1);
    expect(await run("mcp_no_inline_secrets")).toBe(1);
    expect(await run("mcp_no_risky_servers")).toBe(1);
    // not linked to an admitted server yet: shadow MCP
    expect(await run("mcp_servers_registered")).toBe(0);
    const [srv] = await db.insert(mcpServers).values({ name: `e32-files-${Date.now()}`, url: "https://mcp.example.com/files" }).returning({ id: mcpServers.id });
    serverId = srv!.id;
    await db.insert(endpointMcpServerLinks).values({ identityKind: "package", identity: "@example/mcp-files", mcpServerId: serverId });
    expect(await run("mcp_servers_registered")).toBe(1);

    const flag = async (set: Partial<typeof endpointMcpServers.$inferInsert>, check: (typeof ENDPOINT_BENCHMARK_CHECKS)[number]) => {
      await db.update(endpointMcpServers).set(set).where(eq(endpointMcpServers.id, mcpEntryId));
      expect(await run(check), check).toBe(0);
    };
    await flag({ autoApprovedTools: 2 }, "mcp_no_auto_approved_tools");
    await flag({ secretTypes: ["github_token"] }, "mcp_no_inline_secrets");
    await flag({ risks: ["shell_launcher"] }, "mcp_no_risky_servers");
    // a disabled entry, or one not seen for 30 days, is out of scope
    await db.update(endpointMcpServers).set({ disabled: true }).where(eq(endpointMcpServers.id, mcpEntryId));
    expect(await run("mcp_no_risky_servers")).toBe(1);
    await db.update(endpointMcpServers).set({ disabled: false, lastSeenAt: daysAgo(31), firstSeenAt: daysAgo(40) }).where(eq(endpointMcpServers.id, mcpEntryId));
    expect(await run("mcp_no_auto_approved_tools")).toBe(1);
    expect(await run("mcp_no_inline_secrets")).toBe(1);
  });

  it("addons_no_secrets: fails on a recent add-on sighting that carries a credential", async () => {
    expect(await run("addons_no_secrets")).toBe(1);
    const [addon] = await db.insert(endpointAddons).values({ kind: "plugin", identityKind: "name", identity: "e32-plugin" }).returning({ id: endpointAddons.id });
    const [ver] = await db.insert(endpointAddonVersions).values({ addonId: addon!.id, version: "1.0.0" }).returning({ id: endpointAddonVersions.id });
    const [s] = await db
      .insert(endpointAddonSightings)
      .values({ versionId: ver!.id, deviceId, source: "endpoint_agent", firstSeenAt: daysAgo(2), lastSeenAt: daysAgo(1) })
      .returning({ id: endpointAddonSightings.id });
    expect(await run("addons_no_secrets")).toBe(1);
    await db.insert(endpointAddonSightingSecretTypes).values({ sightingId: s!.id, secretType: "aws_access_key" });
    expect(await run("addons_no_secrets")).toBe(0);
  });

  it("mcp_definitions_unchanged: needs a pin, and fails on drift or an unapproved item", async () => {
    expect(await run("mcp_definitions_unchanged")).toBe(0);
    const def = { name: "read", inputSchema: {} };
    const [pin] = await db
      .insert(mcpDefinitionPins)
      .values({ serverId, kind: "tool", name: "read", approvedDigest: "a".repeat(64), approvedDefinition: def, observedDigest: "a".repeat(64), observedDefinition: def })
      .returning({ id: mcpDefinitionPins.id });
    expect(await run("mcp_definitions_unchanged")).toBe(1);
    await db.update(mcpDefinitionPins).set({ observedDigest: "b".repeat(64) }).where(eq(mcpDefinitionPins.id, pin!.id));
    expect(await run("mcp_definitions_unchanged")).toBe(0);
  });
});

describe("through the collector", () => {
  it("is counted only under an org-scoped report, and every pack check is one the gateway runs", async () => {
    const ctx = { periodStart: daysAgo(30), periodEnd: new Date(), memberIds: null, params: { endpointCheck: "devices_reporting_7d" as const } };
    expect(await runCollector(db, "endpoint_benchmark_check", { ...ctx, projectIds: null })).toBe(1);
    expect(await runCollector(db, "endpoint_benchmark_check", { ...ctx, projectIds: [randomUUID()], memberIds: [] })).toBe(0);
    for (const c of ENDPOINT_BENCHMARK_PACK.controls.filter((x) => x.collector === "endpoint_benchmark_check")) {
      const n = await runCollector(db, "endpoint_benchmark_check", { ...ctx, projectIds: null, params: c.collectorParams! });
      expect([0, 1], c.controlRef).toContain(n);
    }
  });
});
