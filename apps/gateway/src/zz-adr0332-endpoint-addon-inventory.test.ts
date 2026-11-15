/**
 * ADR-0332 (lane E14) — the endpoint AI add-on inventory, end to end (real database).
 *
 *  - the projection folds an endpoint MCP server entry and a device coding-agent finding into add-on / version /
 *    endpoint / sighting rows, idempotently, and drops a finding an admin marked a false positive;
 *  - a version's scan is joined by its EXACT content digest: no digest, no scanner for the kind, or no scan of that
 *    digest reads `not_yet_scanned` (never clear); a scan of a different digest of the same skill does not count;
 *  - filters (kind, severity, scan status, agent, endpoint, version) and keyset pagination;
 *  - the flagged contract: at-or-above a severity, with not-yet-scanned included by default and excludable;
 *  - no skill body, config path, key name or value is returned; secrets are types only;
 *  - every route is admin-only; row-level security admits an admin principal and `system_task` only;
 *  - deleting the evidence row (retention) deletes the sighting.
 *
 * Everything this suite creates is removed in afterAll.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  admissionEngineScans,
  auditLog,
  builderSkills,
  createDb,
  discoverySources,
  endpointAddonEndpoints,
  endpointAddons,
  endpointAddonSightings,
  endpointDevices,
  endpointEnrolmentTokens,
  endpointMcpServerLinks,
  endpointMcpServers,
  eq,
  inArray,
  mcpServers,
  runMigrations,
  shadowAiFindings,
  sql,
  users,
  withPrincipal,
  withSystemContext,
  type Db,
} from "@regulait/db";
import { buildApp } from "./app.js";
import { endpointAddonsFlagged, projectEndpointAddons, recordEndpointAddonSightings } from "./endpoint-addon-inventory.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { useTestIssuerKey } from "./testing/workload-client.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = randomBytes(3).toString("hex");
const BOOT = `e14-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const DATA_KEY = createHash("sha256").update(`e14-data-key-${RUN}`).digest("hex");
const hex = (s: string, n: number) => createHash("sha256").update(`${s}-${RUN}`).digest("hex").slice(0, n);
const PSN_A = `psn:${hex("a", 24)}`;
const PSN_B = `psn:${hex("b", 24)}`; // an osquery-only endpoint: no enrolled device
const PKG = `@e14-${RUN}/server`;
const PROVIDER = `e14agent-${RUN}`;
const SKILL = `e14-skill-${RUN}`;
const SKILL_DIGEST = hex("skill-body", 64);
const OTHER_DIGEST = hex("skill-other", 64);
const CONFIG_PATH = `.config/e14-${RUN}/mcp.json`;
const SKILL_BODY = `E14 SECRET SKILL BODY ${RUN}`;

let db: Db;
let app: ReturnType<typeof buildApp>;
let adminId: string;
let memberId: string;
let adminKey: { authorization: string };
let memberKey: { authorization: string };
let sourceId: string;
let deviceId: string;
let mcpEntryId: string;
let findingId: string;
let osqueryFindingId: string;
let registryId: string;
let skillId: string;

const get = (url: string, headers = adminKey) => app.inject({ method: "GET", url, headers });

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  await relaxIdentityForTest(db, { mfaRequired: "off" });
  await useTestIssuerKey(db);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });
  await app.ready();
  const a = await app.inject({ method: "POST", url: "/v1/users", headers: AUTH, payload: { email: `e14-admin-${RUN}@example.com`, displayName: "e14 admin" } });
  adminId = a.json().id;
  await db.update(users).set({ isAdmin: true }).where(eq(users.id, adminId));
  adminKey = { authorization: `Bearer ${(await app.inject({ method: "POST", url: `/v1/users/${adminId}/keys`, headers: AUTH, payload: { name: "k" } })).json().token}` };
  const m = await app.inject({ method: "POST", url: "/v1/users", headers: AUTH, payload: { email: `e14-member-${RUN}@example.com`, displayName: "e14 member" } });
  memberId = m.json().id;
  memberKey = { authorization: `Bearer ${(await app.inject({ method: "POST", url: `/v1/users/${memberId}/keys`, headers: AUTH, payload: { name: "k" } })).json().token}` };

  const [src] = await db
    .insert(discoverySources)
    .values({ name: `e14-${RUN}`, kind: "endpoint_agent", target: {}, scope: { orgLevel: true, include: [] }, createdBy: adminId })
    .returning({ id: discoverySources.id });
  sourceId = src!.id;
  const [tok] = await db
    .insert(endpointEnrolmentTokens)
    .values({ sourceId, label: "e14", tokenHash: hex("tok", 64), deviceCap: 5, expiresAt: new Date(Date.now() + 86_400_000) })
    .returning({ id: endpointEnrolmentTokens.id });
  const [dev] = await db
    .insert(endpointDevices)
    .values({ sourceId, tokenId: tok!.id, devicePseudonym: PSN_A, os: "linux", arch: "amd64", agentVersion: "1.0.0", ticketHash: hex("ticket", 64), ticketExpiresAt: new Date(Date.now() + 86_400_000) })
    .returning({ id: endpointDevices.id });
  deviceId = dev!.id;
  const seen = new Date(Date.now() - 60_000);
  const [entry] = await db
    .insert(endpointMcpServers)
    .values({
      deviceId,
      lastReportId: deviceId,
      signatureId: "sig.e14.host",
      provider: PROVIDER,
      configRoot: "home",
      configPath: CONFIG_PATH,
      serverName: "filesystem",
      transport: "stdio",
      command: "npx",
      package: PKG,
      packageVersion: "1.2.3",
      identityKind: "package",
      identity: PKG,
      risks: ["unpinned_package"],
      secretTypes: ["dlp.secret.provider_token"],
      firstSeenAt: seen,
      lastSeenAt: seen,
    })
    .returning({ id: endpointMcpServers.id });
  mcpEntryId = entry!.id;
  const finding = (subject: string, signal: string) => ({
    subjectKind: "device" as const,
    subject,
    provider: PROVIDER,
    signalSources: [signal],
    signatureKinds: ["cli_binary"],
    firstSeenAt: seen,
    lastSeenAt: seen,
    severity: "medium" as const,
    confidence: "high" as const,
    evidence: [],
  });
  const [f1] = await db.insert(shadowAiFindings).values(finding(PSN_A, "endpoint_agent")).returning({ id: shadowAiFindings.id });
  const [f2] = await db.insert(shadowAiFindings).values(finding(PSN_B, "endpoint_osquery")).returning({ id: shadowAiFindings.id });
  findingId = f1!.id;
  osqueryFindingId = f2!.id;
  const [srv] = await db.insert(mcpServers).values({ name: `e14-registry-${RUN}`, url: `https://e14-${RUN}.example.invalid/mcp` }).returning({ id: mcpServers.id });
  registryId = srv!.id;
  await db.insert(endpointMcpServerLinks).values({ identityKind: "package", identity: PKG, mcpServerId: registryId, linkedBy: adminId });
  const [sk] = await db.insert(builderSkills).values({ name: SKILL, body: SKILL_BODY, ownerUserId: adminId }).returning({ id: builderSkills.id });
  skillId = sk!.id;
  // a FAIL with a high finding for the exact digest the endpoint reports, and a critical one for a different digest
  await db.insert(admissionEngineScans).values([
    { engineId: "skillscanner", builderSkillId: skillId, subjectDigest: SKILL_DIGEST, engineVersion: "1.0.0", verdict: "fail", findings: [{ rule: "skill.exfil", severity: "high", tool: SKILL, where: "engine:skillscanner:body", count: 2 }, { rule: "skill.note", severity: "info", tool: SKILL, where: "engine:skillscanner:body", count: 1 }] },
    { engineId: "skillscanner", builderSkillId: skillId, subjectDigest: OTHER_DIGEST, engineVersion: "1.0.0", verdict: "fail", findings: [{ rule: "skill.rce", severity: "critical", tool: SKILL, where: "engine:skillscanner:body", count: 1 }] },
  ]);
});

afterAll(async () => {
  if (db) {
    const addonIds = (
      await db
        .select({ id: endpointAddons.id })
        .from(endpointAddons)
        .where(inArray(endpointAddons.identity, [PKG, PROVIDER, SKILL, `${SKILL}-unscanned`, `${SKILL}-plugin`]))
    ).map((r) => r.id);
    if (addonIds.length) await db.delete(endpointAddons).where(inArray(endpointAddons.id, addonIds));
    await db.delete(endpointAddonEndpoints).where(inArray(endpointAddonEndpoints.pseudonym, [PSN_A, PSN_B]));
    if (skillId) {
      await db.delete(admissionEngineScans).where(eq(admissionEngineScans.builderSkillId, skillId));
      await db.delete(builderSkills).where(eq(builderSkills.id, skillId));
    }
    await db.delete(endpointMcpServerLinks).where(eq(endpointMcpServerLinks.identity, PKG));
    if (registryId) await db.delete(mcpServers).where(eq(mcpServers.id, registryId));
    await db.delete(shadowAiFindings).where(inArray(shadowAiFindings.subject, [PSN_A, PSN_B]));
    if (sourceId) await db.delete(discoverySources).where(eq(discoverySources.id, sourceId)); // cascades tokens, devices, entries
    await db.delete(auditLog).where(eq(auditLog.ruleId, "endpoint-addon-inventory-refreshed"));
  }
  await app?.close();
  await db?.$client.end().catch(() => undefined);
});

type Sighting = {
  id: string;
  addon: { id: string; kind: string; identity: { kind: string; value: string } };
  version: { id: string; version: string | null; contentDigest: string | null };
  scan: { status: string; severity: string | null; notScannedReason: string | null; findings: Array<{ rule: string; severity: string; count: number }> };
  aiBom: { mcpServerId: string; bomRef: string } | null;
  endpoint: { id: string; pseudonym: string; deviceId: string | null };
  detection: { source: string; hostAgent: string | null; risks: string[]; secretTypes: string[] };
  firstSeenAt: string;
  lastSeenAt: string;
};
const mine = (items: Sighting[]) => items.filter((s) => [PSN_A, PSN_B].includes(s.endpoint.pseudonym));

describe("ADR-0332 projection and read model", () => {
  it("is admin-only: a member gets 403 on every route", async () => {
    for (const url of ["/v1/endpoint-addons/versions", "/v1/endpoint-addons/sightings", "/v1/endpoint-addons/flagged?atOrAbove=high"]) {
      expect((await get(url, memberKey)).statusCode).toBe(403);
    }
    expect((await app.inject({ method: "POST", url: "/v1/endpoint-addons/refresh", headers: memberKey })).statusCode).toBe(403);
  });

  it("refresh projects MCP servers and coding agents (audited, idempotent)", async () => {
    const r = await app.inject({ method: "POST", url: "/v1/endpoint-addons/refresh", headers: adminKey });
    expect(r.statusCode).toBe(200);
    expect(r.json().mcpServerSightings).toBeGreaterThanOrEqual(1);
    expect(r.json().codingAgentSightings).toBeGreaterThanOrEqual(2);
    const audit = await db.select().from(auditLog).where(eq(auditLog.ruleId, "endpoint-addon-inventory-refreshed"));
    expect(audit.some((x) => x.userId === adminId)).toBe(true);
    const before = await db.select({ id: endpointAddonSightings.id }).from(endpointAddonSightings);
    expect((await app.inject({ method: "POST", url: "/v1/endpoint-addons/refresh", headers: adminKey })).statusCode).toBe(200);
    const after = await db.select({ id: endpointAddonSightings.id }).from(endpointAddonSightings);
    expect(after.map((x) => x.id).sort()).toEqual(before.map((x) => x.id).sort());
  });

  it("the MCP server sighting: version, endpoint, source, host agent, risks and secret TYPES, never a path or name", async () => {
    const r = await get(`/v1/endpoint-addons/sightings?kind=mcp_server&endpointPseudonym=${PSN_A}`);
    expect(r.statusCode).toBe(200);
    const items = mine(r.json().items as Sighting[]);
    expect(items).toHaveLength(1);
    const s = items[0]!;
    expect(s.addon.identity).toEqual({ kind: "package", value: PKG });
    expect(s.version).toMatchObject({ version: "1.2.3", contentDigest: null });
    expect(s.endpoint).toMatchObject({ pseudonym: PSN_A, deviceId });
    expect(s.detection).toMatchObject({ source: "endpoint_agent", hostAgent: PROVIDER, risks: ["unpinned_package"], secretTypes: ["dlp.secret.provider_token"] });
    // the endpoint reported no digest, so the registry server's scan is not this content's: not yet scanned
    expect(s.scan).toMatchObject({ status: "not_yet_scanned", severity: null, notScannedReason: "no_content_digest" });
    expect(s.aiBom).toMatchObject({ mcpServerId: registryId, bomRef: `service:mcp:${registryId}` });
    expect(r.body).not.toContain(CONFIG_PATH);
  });

  it("coding agents from the endpoint agent and the osquery pack; a coding agent has no scanner", async () => {
    const items = mine((await get(`/v1/endpoint-addons/sightings?kind=coding_agent&agent=${PROVIDER}`)).json().items as Sighting[]);
    expect(items.map((s) => [s.endpoint.pseudonym, s.detection.source, s.endpoint.deviceId === deviceId]).sort()).toEqual(
      [
        [PSN_A, "endpoint_agent", true],
        [PSN_B, "endpoint_osquery", false],
      ].sort(),
    );
    for (const s of items) expect(s.scan).toMatchObject({ status: "not_yet_scanned", notScannedReason: "no_scanner_for_kind" });
  });

  it("a recorded skill joins the scan of its EXACT digest only; an unscanned digest stays not yet scanned", async () => {
    const seenAt = new Date().toISOString();
    await withPrincipal(db, { userId: adminId }, async (tx) => {
      await recordEndpointAddonSightings(tx as unknown as Db, [
        { kind: "skill", identityKind: "name", identity: SKILL, version: "3", contentDigest: SKILL_DIGEST, endpointPseudonym: PSN_A, deviceId, source: "endpoint_agent", hostAgent: PROVIDER, secretTypes: ["dlp.secret.provider_token"], seenAt },
        { kind: "skill", identityKind: "name", identity: `${SKILL}-unscanned`, contentDigest: hex("never-scanned", 64), endpointPseudonym: PSN_A, source: "endpoint_agent", hostAgent: PROVIDER, seenAt },
      ]);
    });
    const r = await get(`/v1/endpoint-addons/sightings?kind=skill&endpointPseudonym=${PSN_A}`);
    const byName = new Map((mine(r.json().items as Sighting[])).map((s) => [s.addon.identity.value, s]));
    expect(byName.get(SKILL)!.scan).toMatchObject({ status: "fail", severity: "high", notScannedReason: null });
    expect(byName.get(SKILL)!.scan.findings).toEqual([{ rule: "skill.exfil", severity: "high", tool: SKILL, count: 2 }]); // info dropped, no `where`
    expect(byName.get(SKILL)!.detection.secretTypes).toEqual(["dlp.secret.provider_token"]);
    expect(byName.get(`${SKILL}-unscanned`)!.scan).toMatchObject({ status: "not_yet_scanned", notScannedReason: "no_scan_for_digest" });
    expect(r.body).not.toContain(SKILL_BODY);
    expect(r.body).not.toContain("critical"); // the other digest's critical finding is not this content's
  });

  it("filters: severity, scan status, version; pagination walks every row once", async () => {
    const high = mine((await get(`/v1/endpoint-addons/sightings?severity=high`)).json().items as Sighting[]);
    expect(high.map((s) => s.addon.identity.value)).toEqual([SKILL]);
    const nys = mine((await get(`/v1/endpoint-addons/sightings?severity=not_yet_scanned&limit=200`)).json().items as Sighting[]);
    expect(nys.every((s) => s.scan.status === "not_yet_scanned")).toBe(true);
    expect(nys.some((s) => s.addon.identity.value === PKG)).toBe(true);
    const v = mine((await get(`/v1/endpoint-addons/sightings?version=1.2.3&kind=mcp_server`)).json().items as Sighting[]);
    expect(v).toHaveLength(1);
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page: { items: Sighting[]; nextCursor: string | null } = (await get(`/v1/endpoint-addons/sightings?limit=1${cursor ? `&cursor=${cursor}` : ""}`)).json();
      seen.push(...page.items.map((s) => s.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(new Set(seen).size).toBe(seen.length);
    expect(mine((await get(`/v1/endpoint-addons/sightings?limit=200`)).json().items).length).toBe(5);
    expect((await get(`/v1/endpoint-addons/sightings?severity=bogus`)).statusCode).toBe(400);
    expect((await get(`/v1/endpoint-addons/sightings?nope=1`)).statusCode).toBe(400);
  });

  it("versions: one row per version with its endpoint count and scan", async () => {
    const items = (await get(`/v1/endpoint-addons/versions?kind=skill&identity=${SKILL}`)).json().items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ endpoints: 1, scan: { status: "fail", severity: "high" }, version: { version: "3", contentDigest: SKILL_DIGEST } });
  });

  it("flagged contract: at or above, not yet scanned included by default and excludable", async () => {
    const incl = mine((await get(`/v1/endpoint-addons/flagged?atOrAbove=high&limit=200`)).json().items as Sighting[]);
    expect(incl.some((s) => s.addon.identity.value === SKILL)).toBe(true);
    expect(incl.some((s) => s.scan.status === "not_yet_scanned")).toBe(true);
    const excl = mine((await get(`/v1/endpoint-addons/flagged?atOrAbove=high&notYetScanned=exclude&limit=200`)).json().items as Sighting[]);
    expect(excl.map((s) => s.addon.identity.value)).toEqual([SKILL]);
    expect(mine((await get(`/v1/endpoint-addons/flagged?atOrAbove=critical&notYetScanned=exclude&limit=200`)).json().items)).toEqual([]);
    expect((await get(`/v1/endpoint-addons/flagged`)).statusCode).toBe(400); // atOrAbove is required
  });

  it("row-level security: an admin principal and system_task read; a member principal and credential_request see nothing", async () => {
    await db.execute(sql`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'regulait_app') THEN RAISE EXCEPTION 'no app role'; END IF; END $$`);
    const asAdmin = await withPrincipal(db, { userId: adminId }, (tx) => (tx as unknown as Db).select({ id: endpointAddonSightings.id }).from(endpointAddonSightings));
    expect(asAdmin.length).toBeGreaterThanOrEqual(5);
    const asMember = await withPrincipal(db, { userId: memberId }, (tx) => (tx as unknown as Db).select({ id: endpointAddonSightings.id }).from(endpointAddonSightings));
    expect(asMember).toEqual([]);
    const asCredential = await withSystemContext(db, "credential_request", "test.e14", (tx) =>
      (tx as unknown as Db).select({ id: endpointAddons.id }).from(endpointAddons),
    );
    expect(asCredential).toEqual([]);
    const asTask = await withSystemContext(db, "system_task", "test.e14", (tx) => endpointAddonsFlagged(tx as unknown as Db, { atOrAbove: "high", limit: 200 }));
    expect(mine(asTask.items as Sighting[]).length).toBeGreaterThanOrEqual(1);
    // a member principal cannot write either
    await expect(
      withPrincipal(db, { userId: memberId }, (tx) => (tx as unknown as Db).insert(endpointAddons).values({ kind: "plugin", identityKind: "name", identity: `${SKILL}-plugin` })),
    ).rejects.toThrow();
  });

  it("a false-positive finding leaves the inventory; a deleted evidence row deletes its sighting", async () => {
    await db.update(shadowAiFindings).set({ disposition: "false_positive", dispositionAt: new Date(), dispositionByUserId: adminId }).where(eq(shadowAiFindings.id, osqueryFindingId));
    await withPrincipal(db, { userId: adminId }, (tx) => projectEndpointAddons(tx as unknown as Db));
    expect(await db.select().from(endpointAddonSightings).where(eq(endpointAddonSightings.shadowAiFindingId, osqueryFindingId))).toEqual([]);
    await db.delete(endpointMcpServers).where(eq(endpointMcpServers.id, mcpEntryId)); // what retention does
    expect(await db.select().from(endpointAddonSightings).where(eq(endpointAddonSightings.endpointMcpServerId, mcpEntryId))).toEqual([]);
    expect(await db.select().from(endpointAddonSightings).where(eq(endpointAddonSightings.shadowAiFindingId, findingId))).toHaveLength(1);
  });
});
