/**
 * ADR-0332 (lane E14) — the endpoint AI add-on inventory, end to end (real database).
 *
 *  - the inventory is read from the evidence at call time: an endpoint MCP server entry (ADR-0259) and device
 *    coding-agent findings (ADR-0195, endpoint agent and osquery) appear with no refresh, and every fact (version,
 *    first/last seen, source, pseudonym, risks, secret types) is the evidence row's own; a false positive and a
 *    deleted evidence row leave the inventory at once;
 *  - a version's scan is joined by its EXACT content digest and decided by the gate's helper: no digest, no scanner
 *    for the kind, a scanner that is off, or no scan of that digest reads `not_yet_scanned` (never clear); a scan of
 *    a different digest of the same skill does not count; a stale verdict of a disabled engine reads `scanner_off`;
 *  - the direct-record contract refuses a device that is not an enrolled, unrevoked device, writing nothing;
 *  - filters (kind, severity, scan status, agent, device, pseudonym, version) and keyset pagination; the SQL filter
 *    agrees with the item's own scan view;
 *  - the flagged contract: at-or-above, not-yet-scanned included by default and excludable;
 *  - no skill body, config path, key name or value is returned; secrets are types only;
 *  - every route is admin-only; row-level security admits an admin principal and `system_task` only.
 *
 * Everything this suite creates is removed in afterAll; the engines' enabled flags are put back.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  admissionEngineScans,
  builderSkills,
  createDb,
  discoverySources,
  endpointAddons,
  endpointAddonSightings,
  endpointDevices,
  endpointEnrolmentTokens,
  endpointMcpServerLinks,
  endpointMcpServers,
  engines,
  eq,
  inArray,
  mcpServers,
  runMigrations,
  shadowAiFindings,
  users,
  withPrincipal,
  withSystemContext,
  type Db,
} from "@regulait/db";
import { buildApp } from "./app.js";
import { EndpointAddonDeviceError, endpointAddonsFlagged, recordEndpointAddonSightings } from "./endpoint-addon-inventory.js";
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
let revokedDeviceId: string;
let mcpEntryId: string;
let findingId: string;
let osqueryFindingId: string;
let registryId: string;
let skillId: string;
let enginesBefore: Array<{ id: (typeof engines.$inferSelect)["id"]; enabled: boolean; selfTestPassedAt: Date | null }> = [];

const get = (url: string, headers = adminKey) => app.inject({ method: "GET", url, headers });
// enabling needs a passed self-test (engines_enabled_needs_self_test_check); both are put back in afterAll
const setScanner = (id: "mcpscanner" | "skillscanner", enabled: boolean) =>
  db.update(engines).set(enabled ? { enabled, selfTestPassedAt: new Date() } : { enabled }).where(eq(engines.id, id));

type Sighting = {
  id: string;
  addon: { id: string; kind: string; identity: { kind: string; value: string } };
  version: { id: string; version: string | null; contentDigest: string | null };
  scan: { status: string; severity: string | null; notScannedReason: string | null; findings: Array<{ rule: string; severity: string; tool: string; count: number }> };
  aiBom: { mcpServerId: string; bomRef: string } | null;
  endpoint: { pseudonym: string; deviceId: string | null };
  detection: { source: string; hostAgent: string | null; risks: string[]; secretTypes: string[]; endpointMcpServerId: string | null; shadowAiFindingId: string | null };
  firstSeenAt: string;
  lastSeenAt: string;
};
const mine = (items: Sighting[]) => items.filter((s) => [PSN_A, PSN_B].includes(s.endpoint.pseudonym));
const sightings = async (q = "") => mine((await get(`/v1/endpoint-addons/sightings?limit=200${q}`)).json().items as Sighting[]);

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  await relaxIdentityForTest(db, { mfaRequired: "off" });
  await useTestIssuerKey(db);
  enginesBefore = await db.select({ id: engines.id, enabled: engines.enabled, selfTestPassedAt: engines.selfTestPassedAt }).from(engines).where(inArray(engines.id, ["mcpscanner", "skillscanner"]));
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
  const device = (psn: string, ticket: string) => ({
    sourceId,
    tokenId: tok!.id,
    devicePseudonym: psn,
    os: "linux" as const,
    arch: "amd64" as const,
    agentVersion: "1.0.0",
    ticketHash: hex(ticket, 64),
    ticketExpiresAt: new Date(Date.now() + 86_400_000),
  });
  const [dev] = await db.insert(endpointDevices).values(device(PSN_A, "ticket")).returning({ id: endpointDevices.id });
  deviceId = dev!.id;
  const [rev] = await db
    .insert(endpointDevices)
    .values({ ...device(`psn:${hex("revoked", 24)}`, "ticket-r"), revokedAt: new Date(Date.now() + 60_000) })
    .returning({ id: endpointDevices.id });
  revokedDeviceId = rev!.id;
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
    {
      engineId: "skillscanner",
      builderSkillId: skillId,
      subjectDigest: SKILL_DIGEST,
      engineVersion: "1.0.0",
      verdict: "fail",
      findings: [
        { rule: "skill.exfil", severity: "high", tool: SKILL, where: "engine:skillscanner:body", count: 2 },
        { rule: "skill.note", severity: "info", tool: SKILL, where: "engine:skillscanner:body", count: 1 },
      ],
    },
    { engineId: "skillscanner", builderSkillId: skillId, subjectDigest: OTHER_DIGEST, engineVersion: "1.0.0", verdict: "fail", findings: [{ rule: "skill.rce", severity: "critical", tool: SKILL, where: "engine:skillscanner:body", count: 1 }] },
  ]);
  await setScanner("skillscanner", true);
});

afterAll(async () => {
  if (db) {
    await db.delete(endpointAddons).where(inArray(endpointAddons.identity, [SKILL, `${SKILL}-unscanned`, `${SKILL}-plugin`]));
    if (skillId) {
      await db.delete(admissionEngineScans).where(eq(admissionEngineScans.builderSkillId, skillId));
      await db.delete(builderSkills).where(eq(builderSkills.id, skillId));
    }
    await db.delete(endpointMcpServerLinks).where(eq(endpointMcpServerLinks.identity, PKG));
    if (registryId) await db.delete(mcpServers).where(eq(mcpServers.id, registryId));
    await db.delete(shadowAiFindings).where(inArray(shadowAiFindings.subject, [PSN_A, PSN_B]));
    if (sourceId) await db.delete(discoverySources).where(eq(discoverySources.id, sourceId)); // cascades tokens, devices, entries
    for (const e of enginesBefore) await db.update(engines).set({ enabled: e.enabled, selfTestPassedAt: e.selfTestPassedAt }).where(eq(engines.id, e.id));
  }
  await app?.close();
  await db?.$client.end().catch(() => undefined);
});

describe("ADR-0332 endpoint add-on inventory", () => {
  it("is admin-only: a member gets 403 on every route", async () => {
    for (const url of ["/v1/endpoint-addons/versions", "/v1/endpoint-addons/sightings", "/v1/endpoint-addons/flagged?atOrAbove=high"]) {
      expect((await get(url, memberKey)).statusCode).toBe(403);
    }
  });

  it("MCP server: read from the evidence with no refresh; every fact is the evidence row's own; never a path", async () => {
    const r = await get(`/v1/endpoint-addons/sightings?kind=mcp_server&endpointPseudonym=${PSN_A}`);
    expect(r.statusCode).toBe(200);
    const items = mine(r.json().items as Sighting[]);
    expect(items).toHaveLength(1);
    const s = items[0]!;
    const [ev] = await db.select().from(endpointMcpServers).where(eq(endpointMcpServers.id, mcpEntryId));
    expect(s.id).toBe(mcpEntryId);
    expect(s.addon.identity).toEqual({ kind: "package", value: PKG });
    expect(s.version).toMatchObject({ version: "1.2.3", contentDigest: null });
    expect(s.endpoint).toEqual({ pseudonym: PSN_A, deviceId });
    expect(s.detection).toMatchObject({ source: "endpoint_agent", hostAgent: PROVIDER, risks: ["unpinned_package"], secretTypes: ["dlp.secret.provider_token"], endpointMcpServerId: mcpEntryId });
    expect([s.firstSeenAt, s.lastSeenAt]).toEqual([ev!.firstSeenAt.toISOString(), ev!.lastSeenAt.toISOString()]);
    // the endpoint reported no digest, so the registry server's scan is not this content's: not yet scanned
    expect(s.scan).toMatchObject({ status: "not_yet_scanned", severity: null });
    expect(s.aiBom).toMatchObject({ mcpServerId: registryId, bomRef: `service:mcp:${registryId}` });
    expect(r.body).not.toContain(CONFIG_PATH);
    // a newer report moves last seen and the version, and the inventory shows it at once (nothing to refresh)
    const later = new Date();
    await db.update(endpointMcpServers).set({ lastSeenAt: later, packageVersion: "1.2.4" }).where(eq(endpointMcpServers.id, mcpEntryId));
    const [after] = await sightings(`&kind=mcp_server&endpointPseudonym=${PSN_A}`);
    expect(after).toMatchObject({ id: mcpEntryId, lastSeenAt: later.toISOString(), version: { version: "1.2.4" } });
  });

  it("coding agents from the endpoint agent and the osquery pack; a coding agent has no scanner", async () => {
    const items = await sightings(`&kind=coding_agent&agent=${PROVIDER}`);
    expect(items.map((s) => [s.endpoint.pseudonym, s.detection.source, s.endpoint.deviceId]).sort()).toEqual(
      [
        [PSN_A, "endpoint_agent", deviceId],
        [PSN_B, "endpoint_osquery", null],
      ].sort(),
    );
    for (const s of items) expect(s.scan).toMatchObject({ status: "not_yet_scanned", notScannedReason: "no_scanner_for_kind" });
  });

  it("the direct record refuses a revoked or unknown device and writes nothing", async () => {
    const base = { kind: "skill" as const, identityKind: "name" as const, identity: `${SKILL}-plugin`, source: "endpoint_agent" as const, seenAt: new Date().toISOString() };
    for (const bad of [revokedDeviceId, randomUUID()]) {
      await expect(
        withPrincipal(db, { userId: adminId }, (tx) => recordEndpointAddonSightings(tx as unknown as Db, [{ ...base, deviceId }, { ...base, deviceId: bad }])),
      ).rejects.toBeInstanceOf(EndpointAddonDeviceError);
    }
    expect(await db.select().from(endpointAddons).where(eq(endpointAddons.identity, `${SKILL}-plugin`))).toEqual([]);
  });

  it("a recorded skill joins the scan of its EXACT digest only; an unscanned digest stays not yet scanned", async () => {
    const seenAt = new Date().toISOString();
    await withPrincipal(db, { userId: adminId }, async (tx) => {
      await recordEndpointAddonSightings(tx as unknown as Db, [
        { kind: "skill", identityKind: "name", identity: SKILL, version: "3", contentDigest: SKILL_DIGEST, deviceId, source: "endpoint_agent", hostAgent: PROVIDER, secretTypes: ["dlp.secret.provider_token"], seenAt },
        { kind: "skill", identityKind: "name", identity: `${SKILL}-unscanned`, contentDigest: hex("never-scanned", 64), deviceId, source: "endpoint_agent", hostAgent: PROVIDER, seenAt },
      ]);
    });
    const r = await get(`/v1/endpoint-addons/sightings?kind=skill&endpointPseudonym=${PSN_A}`);
    expect(r.json().scanners.skillscanner).toBe(true);
    const byName = new Map(mine(r.json().items as Sighting[]).map((s) => [s.addon.identity.value, s]));
    expect(byName.get(SKILL)!.endpoint).toEqual({ pseudonym: PSN_A, deviceId }); // joined from the device, not given
    expect(byName.get(SKILL)!.scan).toMatchObject({ status: "fail", severity: "high", notScannedReason: null });
    expect(byName.get(SKILL)!.scan.findings).toEqual([{ rule: "skill.exfil", severity: "high", tool: SKILL, count: 2 }]); // info dropped, no `where`
    expect(byName.get(SKILL)!.detection.secretTypes).toEqual(["dlp.secret.provider_token"]);
    expect(byName.get(`${SKILL}-unscanned`)!.scan).toMatchObject({ status: "not_yet_scanned", notScannedReason: "no_scan_for_digest" });
    expect(r.body).not.toContain(SKILL_BODY);
    expect(r.body).not.toContain("critical"); // the other digest's critical finding is not this content's
  });

  it("a stale FAIL of a disabled scanner reads not yet scanned (scanner_off), never as a verdict", async () => {
    await setScanner("skillscanner", false);
    try {
      const [s] = (await sightings(`&kind=skill&identity=${SKILL}`)).filter((x) => x.addon.identity.value === SKILL);
      expect(s!.scan).toMatchObject({ status: "not_yet_scanned", severity: null, notScannedReason: "scanner_off" });
      expect(mine((await get(`/v1/endpoint-addons/flagged?atOrAbove=high&notYetScanned=exclude&limit=200`)).json().items)).toEqual([]);
    } finally {
      await setScanner("skillscanner", true);
    }
  });

  it("filters: severity, scan status, version; the SQL filter agrees with each item's scan view; pagination walks every row once", async () => {
    const all = await sightings();
    expect(all).toHaveLength(5); // one MCP server, two coding agents, two skills
    for (const sev of ["low", "medium", "high", "critical", "not_yet_scanned"] as const) {
      const got = (await sightings(`&severity=${sev}`)).map((s) => s.id).sort();
      const want = all.filter((s) => (sev === "not_yet_scanned" ? s.scan.status === "not_yet_scanned" : s.scan.severity === sev)).map((s) => s.id).sort();
      expect([sev, got]).toEqual([sev, want]);
    }
    for (const st of ["not_yet_scanned", "pass", "fail", "unknown"] as const) {
      const got = (await sightings(`&scanStatus=${st}`)).map((s) => s.id).sort();
      expect([st, got]).toEqual([st, all.filter((s) => s.scan.status === st).map((s) => s.id).sort()]);
    }
    expect((await sightings(`&version=1.2.4&kind=mcp_server`)).map((s) => s.id)).toEqual([mcpEntryId]);
    expect((await sightings(`&deviceId=${deviceId}`)).every((s) => s.endpoint.deviceId === deviceId)).toBe(true);
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page: { items: Sighting[]; nextCursor: string | null } = (await get(`/v1/endpoint-addons/sightings?limit=1${cursor ? `&cursor=${cursor}` : ""}`)).json();
      seen.push(...page.items.map((s) => s.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(new Set(seen).size).toBe(seen.length);
    expect(all.every((s) => seen.includes(s.id))).toBe(true);
    expect((await get(`/v1/endpoint-addons/sightings?severity=bogus`)).statusCode).toBe(400);
    expect((await get(`/v1/endpoint-addons/sightings?nope=1`)).statusCode).toBe(400);
  });

  it("versions: one row per version with its endpoint count and scan; the id is stable across calls", async () => {
    const a = (await get(`/v1/endpoint-addons/versions?kind=skill&identity=${SKILL}`)).json().items;
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ endpoints: 1, scan: { status: "fail", severity: "high" }, version: { version: "3", contentDigest: SKILL_DIGEST } });
    const b = (await get(`/v1/endpoint-addons/versions?kind=skill&identity=${SKILL}`)).json().items;
    expect(b[0].version.id).toBe(a[0].version.id);
    const coding = (await get(`/v1/endpoint-addons/versions?kind=coding_agent&identity=${PROVIDER}`)).json().items;
    expect(coding).toHaveLength(1);
    expect(coding[0].endpoints).toBe(2);
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

  it("row-level security on the direct-record tables: an admin principal and system_task; a member and credential_request see nothing", async () => {
    const q = (tx: unknown) => (tx as Db).select({ id: endpointAddonSightings.id }).from(endpointAddonSightings).where(eq(endpointAddonSightings.deviceId, deviceId));
    expect((await withPrincipal(db, { userId: adminId }, q)).length).toBe(2);
    expect(await withPrincipal(db, { userId: memberId }, q)).toEqual([]);
    expect(await withSystemContext(db, "credential_request", "test.e14", q)).toEqual([]);
    const asTask = await withSystemContext(db, "system_task", "test.e14", (tx) => endpointAddonsFlagged(tx as unknown as Db, { atOrAbove: "high", limit: 200 }));
    expect(mine(asTask.items as Sighting[]).some((s) => s.addon.identity.value === SKILL)).toBe(true);
    await expect(
      withPrincipal(db, { userId: memberId }, (tx) => (tx as unknown as Db).insert(endpointAddons).values({ kind: "plugin", identityKind: "name", identity: `${SKILL}-plugin` })),
    ).rejects.toThrow();
  });

  it("a false-positive finding and a deleted evidence row leave the inventory at once", async () => {
    await db.update(shadowAiFindings).set({ disposition: "false_positive", dispositionAt: new Date(), dispositionByUserId: adminId }).where(eq(shadowAiFindings.id, osqueryFindingId));
    await db.delete(endpointMcpServers).where(eq(endpointMcpServers.id, mcpEntryId)); // what retention does
    const ids = (await sightings()).map((s) => s.id);
    expect(ids).not.toContain(osqueryFindingId);
    expect(ids).not.toContain(mcpEntryId);
    expect(ids).toContain(findingId);
  });
});
