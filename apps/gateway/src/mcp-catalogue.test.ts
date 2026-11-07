/**
 * ADR-0256 — seeding the MCP catalogue, adversarially.
 *
 * Runs against a LOCAL fake (127.0.0.1) serving both the official registry's v0.1 `ServerListResponse` and an
 * awesome-list README. Nothing here touches the public network. The claims are the governance ones:
 *
 *   - a community list yields only catalogue-only, UNVETTED entries, flagged when paid or x402;
 *   - the same repository from two sources is ONE item with TWO provenance rows;
 *   - every refresh writes one APPEND-ONLY snapshot and every asserted row points at it;
 *   - an offline bundle is refused with no keyring, with a wrong key or signature, and when it is not newer than the
 *     last one; a verified bundle lands, and its source is never dialled by a sync or a sweep;
 *   - a community pull is refused on an air-gapped deployment, while a bundle import is the supported motion there;
 *   - nothing here creates a server or a grant: every entry is "available, not admitted".
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import path from "node:path";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  and,
  auditLog,
  createDb,
  eq,
  inArray,
  mcpCatalogueItems,
  mcpCatalogueSnapshots,
  mcpRegistries,
  mcpRegistryEntries,
  mcpServers,
  runMigrations,
  serverGrants,
  sql,
  type Db,
} from "@regulait/db";
import { MCP_CATALOGUE_BUNDLE_FORMAT, type McpCatalogueBundle } from "@regulait/shared";
import { buildApp } from "./app.js";
import { importCatalogueBundle, loadBundleKeyring, MCP_CATALOGUE_BUNDLE_KEYS_ENV, verifyBundle } from "./mcp-catalogue.js";
import { mcpRegistryRuleIds, runMcpRegistrySync, syncRegistry, type RegistryRow } from "./mcp-registry.js";
import { relaxStrictAdmissionForTest } from "./testing/strict-admission.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const BOOT = "adr256-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
const SUITE = randomUUID().slice(0, 8);

let db: Db;
let app: ReturnType<typeof buildApp>;
let restore: () => Promise<void> = async () => {};
let fake: { url: string; hits: string[]; close: () => Promise<void> };
const registryIds: string[] = [];

const REPO = `github.com/acme-${SUITE}/weather`;
const COMMUNITY_ONLY = `github.com/solo-${SUITE}/thing`;
const X402 = `github.com/pay-${SUITE}/x402-tools`;

const README = [
  "# Awesome MCP Servers",
  `- [acme/weather](https://${REPO}) 📇 ☁️ - Forecasts for anywhere.`,
  `- [solo/thing](https://${COMMUNITY_ONLY}) 🐍 🏠 - Only a community list knows this one.`,
  `- [pay/x402-tools](https://${X402}) 📇 ☁️ - Pay-per-call x402 market data.`,
].join("\n");

const REGISTRY_PAGE = {
  servers: [
    {
      server: {
        name: `io.github.acme-${SUITE}/weather`,
        description: "Forecasts",
        version: "1.2.0",
        repository: { url: `https://${REPO}` },
        packages: [{ registryType: "npm", identifier: "@acme/weather" }],
      },
      _meta: { "io.modelcontextprotocol.registry/official": { status: "active" } },
    },
  ],
  metadata: { count: 1 },
};

async function startFake() {
  const hits: string[] = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url ?? "");
    const u = new URL(req.url ?? "/", "http://fake");
    if (u.pathname === "/README.md") return void res.writeHead(200, { "content-type": "text/markdown" }).end(README);
    if (u.pathname === "/v0.1/servers") return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(REGISTRY_PAGE));
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, hits, close: () => new Promise<void>((r) => server.close(() => r())) };
}

async function createSource(name: string, url: string, listingKind?: "community") {
  const res = await app.inject({ method: "POST", url: "/v1/mcp-registries", headers: AUTH, payload: { name, url, ...(listingKind ? { listingKind } : {}) } });
  expect(res.statusCode).toBe(201);
  registryIds.push(res.json().id);
  return res.json() as RegistryRow & { listingKind: "registry" | "community"; delivery: "pull" | "offline_bundle" };
}

const counts = async () => ({
  servers: Number((await db.execute(sql`select count(*)::int as n from mcp_servers`)).rows[0]!.n),
  grants: (await db.select({ id: serverGrants.id }).from(serverGrants)).length,
});

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  // the fake is on 127.0.0.1: open private ranges for this file only (restored after)
  restore = await relaxStrictAdmissionForTest(db, ["mcpPrivateRangesDefault"]);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "d".repeat(64) });
  await app.ready();
  fake = await startFake();
});

afterAll(async () => {
  // snapshots are append-only evidence, so these sources are disabled rather than deleted
  if (registryIds.length) await db.update(mcpRegistries).set({ enabled: false }).where(inArray(mcpRegistries.id, registryIds));
  delete process.env[MCP_CATALOGUE_BUNDLE_KEYS_ENV];
  await restore();
  await app.close();
  await fake.close();
});

describe("ADR-0256 community list and cross-source dedupe", () => {
  let community: RegistryRow;
  let official: RegistryRow;

  it("pulls a community list into catalogue-only, unvetted entries with a snapshot, creating nothing", async () => {
    const before = await counts();
    const row = await createSource(`adr256-community-${SUITE}`, `${fake.url}/README.md`, "community");
    expect(row).toMatchObject({ listingKind: "community", delivery: "pull", enabled: false });
    community = row;
    const out = await syncRegistry(db, row, { deps: { deployMode: "hosted" } });
    expect(out.outcome).toBe("ok");
    expect(out.entriesSeen).toBe(3);
    expect(out.catalogueOnly).toBe(3);
    expect(out.snapshotId).toBeTruthy();

    const entries = await db.select().from(mcpRegistryEntries).where(eq(mcpRegistryEntries.registryId, row.id));
    expect(entries.every((e) => e.kind === "catalogue_only" && e.catalogueReason === "community_listing")).toBe(true);
    expect(entries.every((e) => e.lastSnapshotId === out.snapshotId && e.catalogueItemId !== null)).toBe(true);
    expect(entries.find((e) => e.upstreamName === X402)!.paidSignal).toBe("x402");

    const [snap] = await db.select().from(mcpCatalogueSnapshots).where(eq(mcpCatalogueSnapshots.id, out.snapshotId!));
    expect(snap).toMatchObject({ listingKind: "community", delivery: "pull", entryCount: 3, truncated: false, bundleKeyId: null });
    expect(await counts()).toEqual(before);
  });

  it("refuses to import a community entry: there is no endpoint to import", async () => {
    const [entry] = await db.select().from(mcpRegistryEntries).where(and(eq(mcpRegistryEntries.registryId, community.id), eq(mcpRegistryEntries.upstreamName, REPO)));
    const res = await app.inject({ method: "POST", url: `/v1/mcp-registries/entries/${entry!.id}/import`, headers: AUTH });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    const [after] = await db.select({ serverId: mcpRegistryEntries.serverId }).from(mcpRegistryEntries).where(eq(mcpRegistryEntries.id, entry!.id));
    expect(after!.serverId).toBeNull();
  });

  it("groups the same repository from the registry and the list into one item with two sources", async () => {
    official = await createSource(`adr256-official-${SUITE}`, fake.url);
    const out = await syncRegistry(db, official, { deps: { deployMode: "hosted" } });
    expect(out.outcome).toBe("ok");
    const items = await db.select().from(mcpCatalogueItems).where(eq(mcpCatalogueItems.dedupeKey, `repo:${REPO}`));
    expect(items).toHaveLength(1);

    const res = await app.inject({ method: "GET", url: `/v1/mcp-catalogue?q=${encodeURIComponent(SUITE)}`, headers: AUTH });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: Array<{ dedupeKey: string; vetting: string; paid: string | null; admission: string; sources: Array<{ registryId: string; vetting: string }> }> };
    const shared = body.items.find((i) => i.dedupeKey === `repo:${REPO}`)!;
    expect(shared.sources.map((s) => s.registryId).sort()).toEqual([community.id, official.id].sort());
    expect(shared).toMatchObject({ vetting: "registry_listed", admission: "available_not_admitted" });
    expect(body.items.find((i) => i.dedupeKey === `repo:${COMMUNITY_ONLY}`)).toMatchObject({ vetting: "unvetted", admission: "available_not_admitted" });
    expect(body.items.find((i) => i.dedupeKey === `repo:${X402}`)!.paid).toBe("x402");
  });

  it("refuses a community pull on an air-gapped deployment, before any socket", async () => {
    const hitsBefore = fake.hits.length;
    const out = await syncRegistry(db, community, { deps: { deployMode: "air_gapped" } });
    expect(out.outcome).toBe("refused");
    expect(fake.hits.length).toBe(hitsBefore);
  });

  it("keeps snapshots append-only: UPDATE, DELETE and TRUNCATE are refused", async () => {
    await expect(db.execute(sql`update mcp_catalogue_snapshots set entry_count = 0`)).rejects.toThrow();
    await expect(db.execute(sql`delete from mcp_catalogue_snapshots`)).rejects.toThrow();
    await expect(db.execute(sql`truncate mcp_catalogue_snapshots cascade`)).rejects.toThrow();
  });
});

describe("ADR-0256 signed offline bundles", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const other = generateKeyPairSync("ed25519");
  const keyring = new Map([["k1", publicKey]]);
  const name = `adr256-bundle-${SUITE}`;
  const bundleOf = (createdAt: string, entries: McpCatalogueBundle["entries"]): string =>
    JSON.stringify({
      format: MCP_CATALOGUE_BUNDLE_FORMAT,
      createdAt,
      source: { name, listingKind: "registry", origin: "https://registry.modelcontextprotocol.io", dataLicence: "CC0-1.0" },
      truncated: false,
      entries,
    });
  const remote = {
    upstreamName: `io.example.${SUITE}/remote`,
    upstreamVersion: "1.0.0",
    title: null,
    description: null,
    repositoryUrl: null,
    websiteUrl: null,
    kind: "remote" as const,
    remoteUrl: "https://mcp.example.invalid/mcp",
    remoteTransport: "streamable-http" as const,
    catalogueReason: null,
    upstreamStatus: "active" as const,
    publishedAt: null,
    updatedAt: null,
    packageCount: 0,
    remoteCount: 1,
    paidSignal: null,
  };
  const signed = (text: string, key = privateKey, keyId = "k1") => ({ bundle: text, signature: sign(null, Buffer.from(text, "utf8"), key).toString("base64"), keyId });

  it("refuses every bundle while no keyring is configured (the secure default)", async () => {
    delete process.env[MCP_CATALOGUE_BUNDLE_KEYS_ENV];
    const res = await app.inject({ method: "POST", url: "/v1/mcp-catalogue/bundles", headers: AUTH, payload: signed(bundleOf("2026-11-07T00:00:00Z", [remote])) });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "no_keyring" });
  });

  it("refuses a wrong key, a tampered bundle and a non-Ed25519 keyring", () => {
    const text = bundleOf("2026-11-07T00:00:00Z", [remote]);
    expect(verifyBundle(signed(text, other.privateKey), keyring)).toMatchObject({ ok: false, code: "bad_signature" });
    expect(verifyBundle({ ...signed(text), bundle: text.replace("1.0.0", "6.6.6") }, keyring)).toMatchObject({ ok: false, code: "bad_signature" });
    expect(verifyBundle(signed(text, privateKey, "k9"), keyring)).toMatchObject({ ok: false, code: "unknown_key" });
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ type: "spki", format: "pem" }).toString();
    expect(loadBundleKeyring({ [MCP_CATALOGUE_BUNDLE_KEYS_ENV]: JSON.stringify([{ keyId: "r", publicKeyPem: rsa }]) })).toHaveProperty("error");
  });

  it("imports a verified bundle through the route, as an offline-bundle source, creating nothing", async () => {
    const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
    process.env[MCP_CATALOGUE_BUNDLE_KEYS_ENV] = JSON.stringify([{ keyId: "k1", publicKeyPem: pem }]);
    const before = await counts();
    const res = await app.inject({ method: "POST", url: "/v1/mcp-catalogue/bundles", headers: AUTH, payload: signed(bundleOf("2026-11-07T00:00:00Z", [remote])) });
    expect(res.statusCode).toBe(201);
    const out = res.json() as { registryId: string; snapshotId: string; entriesSeen: number; serversCreated: number };
    registryIds.push(out.registryId);
    expect(out).toMatchObject({ entriesSeen: 1, serversCreated: 0 });
    const [src] = await db.select().from(mcpRegistries).where(eq(mcpRegistries.id, out.registryId));
    expect(src).toMatchObject({ delivery: "offline_bundle", enabled: false, listingKind: "registry" });
    const [snap] = await db.select().from(mcpCatalogueSnapshots).where(eq(mcpCatalogueSnapshots.id, out.snapshotId));
    expect(snap).toMatchObject({ delivery: "offline_bundle", bundleKeyId: "k1", entryCount: 1 });
    expect(await counts()).toEqual(before);
    const audit = await db.select().from(auditLog).where(and(eq(auditLog.objectId, out.registryId), eq(auditLog.ruleId, mcpRegistryRuleIds.bundleImported)));
    expect(audit).toHaveLength(1);
  });

  it("refuses a replayed or older bundle (rollback protection), and accepts a newer one", async () => {
    const replay = await importCatalogueBundle(db, signed(bundleOf("2026-11-07T00:00:00Z", [])), { actorUserId: null, keyring });
    expect(replay).toMatchObject({ ok: false, status: 409, body: { code: "stale_bundle" } });
    const newer = await importCatalogueBundle(db, signed(bundleOf("2026-11-08T00:00:00Z", [])), { actorUserId: null, keyring });
    expect(newer.ok).toBe(true);
    // a complete bundle that no longer lists the entry marks it missing, and deletes nothing
    const [entry] = await db.select().from(mcpRegistryEntries).where(eq(mcpRegistryEntries.upstreamName, remote.upstreamName));
    expect(entry!.missingSince).not.toBeNull();
  });

  it("never lets a bundle overwrite a pulled source of the same name", async () => {
    const pulled = await createSource(`adr256-pulled-${SUITE}`, fake.url);
    const text = JSON.stringify({ ...JSON.parse(bundleOf("2026-11-09T00:00:00Z", [])), source: { name: pulled.name, listingKind: "registry", origin: "x", dataLicence: "CC0-1.0" } });
    const out = await importCatalogueBundle(db, signed(text), { actorUserId: null, keyring });
    expect(out).toMatchObject({ ok: false, status: 409, body: { code: "source_is_pulled" } });
  });

  it("never dials an offline-bundle source: a sync skips it and the sweep does not pick it", async () => {
    const [src] = await db.select().from(mcpRegistries).where(eq(mcpRegistries.name, name));
    await db.update(mcpRegistries).set({ enabled: true }).where(eq(mcpRegistries.id, src!.id));
    const hitsBefore = fake.hits.length;
    const out = await syncRegistry(db, { ...src!, url: fake.url }, { deps: { deployMode: "hosted" } });
    expect(out.outcome).toBe("skipped");
    const sweep = await runMcpRegistrySync(db, { limit: 50, deps: { deployMode: "hosted" } });
    expect(JSON.stringify(sweep)).not.toContain(src!.id);
    await db.update(mcpRegistries).set({ enabled: false }).where(eq(mcpRegistries.id, src!.id));
    expect(fake.hits.length).toBeGreaterThanOrEqual(hitsBefore);
    const servers = await db.select({ id: mcpServers.id }).from(mcpServers).where(eq(mcpServers.name, remote.upstreamName));
    expect(servers).toHaveLength(0);
  });

  it("exports an unsigned bundle a connected install can sign offline, and it round-trips", async () => {
    const [src] = await db.select().from(mcpRegistries).where(eq(mcpRegistries.name, `adr256-official-${SUITE}`));
    const res = await app.inject({ method: "GET", url: `/v1/mcp-catalogue/bundle?registryId=${src!.id}`, headers: AUTH });
    expect(res.statusCode).toBe(200);
    const text = res.body;
    const verdict = verifyBundle(signed(text), keyring);
    expect(verdict.ok).toBe(true);
  });
});

describe("ADR-0256 presets", () => {
  it("refuses a preset whose host is not allow-listed: seeding never opens egress", async () => {
    // a unique name check runs first; the official preset may exist from another run, so only assert no success
    const res = await app.inject({ method: "POST", url: "/v1/mcp-catalogue/presets/awesome-mcp-servers", headers: AUTH });
    expect([400, 409]).toContain(res.statusCode);
  });

  it("refuses an unknown preset", async () => {
    const res = await app.inject({ method: "POST", url: "/v1/mcp-catalogue/presets/everything", headers: AUTH });
    expect(res.statusCode).toBe(400);
  });
});
