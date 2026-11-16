/**
 * ADR-0310 (G2) — managed-settings bundles, end to end (real database).
 *
 *  - a user's bundle names exactly the servers on which the kernel shows them a tool, by gateway URL; a server with
 *    only a halted tool, a disabled server, a server in release-age quarantine and an ungranted server are absent;
 *  - a user with nothing entitled, and a disabled user, get an explicit deny-all for every vendor;
 *  - a role's bundle carries the role's own grants, plus the ADR-0236 MCP bundles granted to the role while the
 *    bundles switch is on (owner decision 2026-11-15, M1);
 *  - the manifest is Ed25519-signed with the export key and lists each file's sha256; the archive is byte-stable;
 *  - an unchanged policy returns the same version (200), a changed one takes the next version (201), audited;
 *  - with no signing key, or no public URL, the export is refused (never an unsigned bundle);
 *  - the routes are admin-only;
 *  - NEGATIVE (#850 review): a read-tier bundle naming only a write tool, an archived bundle, and a reserved `mcp:`
 *    protocol name each leave their server out; both tables are under forced row-level security (admin or `migration`).
 *
 * Everything this suite creates is removed in afterAll (users are disabled, as other suites leave them).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { createHash, createPublicKey, generateKeyPairSync, randomBytes, verify } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import {
  auditLog,
  createDb,
  eq,
  inArray,
  managedSettingsBundles,
  mcpBundleGrants,
  mcpBundles,
  mcpBundleVersionItems,
  mcpBundleVersions,
  mcpServers,
  ORG_SETTINGS_ID,
  orgSettings,
  mcpTools,
  roleAssignments,
  sql,
  roles,
  roleToolGrants,
  runMigrations,
  toolGrants,
  users,
  type Db,
} from "@regulait/db";
import { parseCodexRequirements as parseToml } from "@regulait/shared";
import { buildApp } from "./app.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = randomBytes(3).toString("hex");
const BOOT = `e1-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const ORIGIN = "http://localhost";
const DATA_KEY = createHash("sha256").update(`e1-data-key-${RUN}`).digest("hex");
const KEY_ID = `e1-export-${RUN}`;

const prevEnv = {
  url: process.env.REGULAIT_PUBLIC_URL,
  key: process.env.REGULAIT_EXPORT_SIGNING_KEY,
  keyId: process.env.REGULAIT_EXPORT_SIGNING_KEY_ID,
};
const keyDir = mkdtempSync(path.join(tmpdir(), "e1-key-"));
const keyPath = path.join(keyDir, "export.key");
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
writeFileSync(keyPath, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });

let db: Db;
let app: ReturnType<typeof buildApp>;
let adminKey: { authorization: string };
let memberKey: { authorization: string };
let memberId: string;
let adminId: string;
let loneId: string;
let roleId: string;
const userIds: string[] = [];
const serverIds: string[] = [];
type Srv = "a" | "b" | "halted" | "off" | "fresh" | "bundled" | "bundledWrite" | "archived" | "reserved";
const S = {} as Record<Srv, string>;
const bundleIds: string[] = [];
let bundlesWereEnabled = false;

const inject = (method: "GET" | "POST", url: string, headers: Record<string, string>, payload?: unknown) =>
  app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload: payload as object }) });
const exportFor = (kind: "user" | "role", id: string, extra: Record<string, unknown> = {}) =>
  inject("POST", "/v1/managed-settings/bundles", adminKey, { subject: { kind, id }, ...extra });

/** a ustar archive's files, by name */
function untar(gz: Buffer): Map<string, string> {
  const tar = gunzipSync(gz);
  const out = new Map<string, string>();
  for (let off = 0; off + 512 <= tar.length; ) {
    const name = tar.subarray(off, off + 100).toString("utf8").replace(/\0.*$/s, "");
    if (!name) break;
    const size = parseInt(tar.subarray(off + 124, off + 136).toString("utf8").replace(/\0.*$/s, "").trim(), 8);
    out.set(name, tar.subarray(off + 512, off + 512 + size).toString("utf8"));
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}

async function user(tag: string) {
  const r = await inject("POST", "/v1/users", AUTH, { email: `e1-${tag}-${RUN}@example.com`, displayName: `e1 ${tag}` });
  expect(r.statusCode, r.body).toBe(201);
  const id = r.json().id as string;
  userIds.push(id);
  return id;
}

async function server(tag: string, toolsSpec: Array<{ name: string; halted?: boolean; kind?: "read" | "write" }>, disabled = false) {
  const [s] = await db
    .insert(mcpServers)
    .values({
      name: `e1-${tag}-${RUN}`,
      url: `https://upstream-${tag}-${RUN}.example.invalid/mcp`,
      // past the release-age cooldown (min_release_age_days defaults to 7), except the one server that tests it
      releaseSeenAt: tag === "fresh" ? new Date() : new Date(Date.now() - 30 * 86_400_000),
      ...(disabled ? { disabledAt: new Date(), disabledReason: "e1 test: disabled server", disabledBy: adminId } : {}) })
    .returning({ id: mcpServers.id });
  serverIds.push(s!.id);
  for (const t of toolsSpec) {
    await db.insert(mcpTools).values({
      serverId: s!.id,
      name: t.name,
      kind: t.kind ?? "read",
      ...(t.halted ? { haltedAt: new Date(), haltedReason: "e1 test: halted tool" } : {}),
    });
  }
  return s!.id;
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  process.env.REGULAIT_PUBLIC_URL = ORIGIN;
  process.env.REGULAIT_EXPORT_SIGNING_KEY = keyPath;
  process.env.REGULAIT_EXPORT_SIGNING_KEY_ID = KEY_ID;
  restore = await relaxIdentityForTest(db, { mfaRequired: "off" });
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });
  await app.ready();

  adminId = await user("admin");
  await db.update(users).set({ isAdmin: true }).where(eq(users.id, adminId));
  adminKey = { authorization: `Bearer ${(await inject("POST", `/v1/users/${adminId}/keys`, AUTH, { name: "k" })).json().token}` };
  memberId = await user("member");
  loneId = await user("lone");
  // the lone user's key: the member is disabled (which revokes its keys) by a test below
  memberKey = { authorization: `Bearer ${(await inject("POST", `/v1/users/${loneId}/keys`, AUTH, { name: "k" })).json().token}` };

  S.a = await server("a", [{ name: "read_doc" }, { name: "write_doc" }]);
  S.b = await server("b", [{ name: "search" }]);
  S.halted = await server("halted", [{ name: "only", halted: true }]);
  S.off = await server("off", [{ name: "t" }], true);
  S.fresh = await server("fresh", [{ name: "new_tool" }]);
  await db.insert(toolGrants).values([
    { userId: memberId, serverId: S.a, toolName: "read_doc" },
    { userId: memberId, serverId: S.halted, toolName: "only" },
    { userId: memberId, serverId: S.off, toolName: "t" },
    { userId: memberId, serverId: S.fresh, toolName: "new_tool" },
  ]);
  // a reserved protocol name (the `mcp:` grants of mcp-protocol.ts) is never a tool a client lists: the server stays out
  S.reserved = await server("reserved", [{ name: "mcp:resources" }]);
  await db.insert(toolGrants).values({ userId: memberId, serverId: S.reserved, toolName: "mcp:resources" });
  const [r] = await db.insert(roles).values({ name: `e1-role-${RUN}` }).returning({ id: roles.id });
  roleId = r!.id;
  await db.insert(roleToolGrants).values({ roleId, serverId: S.b, toolName: "search" });

  // ADR-0236: a bundle granted to the role, naming a tool on a server the role has no direct grant on
  const roleBundle = async (tag: string, serverId: string, toolName: string, maxTier: "read" | "write", archived = false) => {
    const [b] = await db
      .insert(mcpBundles)
      .values({ name: `e1-${tag}-${RUN}`, currentVersion: 1, createdBy: adminId, ...(archived ? { archivedAt: new Date() } : {}) })
      .returning({ id: mcpBundles.id });
    bundleIds.push(b!.id);
    const [v] = await db.insert(mcpBundleVersions).values({ bundleId: b!.id, version: 1, createdBy: adminId }).returning({ id: mcpBundleVersions.id });
    await db.insert(mcpBundleVersionItems).values({ versionId: v!.id, serverId, toolName });
    await db.insert(mcpBundleGrants).values({ bundleId: b!.id, roleId, maxTier, grantedBy: adminId });
  };
  S.bundled = await server("bundled", [{ name: "bundled_tool" }]);
  await roleBundle("bundle", S.bundled, "bundled_tool", "read");
  // NEGATIVE: a read-tier grant of a bundle that names only a write tool reaches nothing on that server
  S.bundledWrite = await server("bundled-write", [{ name: "write_only", kind: "write" }]);
  await roleBundle("bundle-write", S.bundledWrite, "write_only", "read");
  // NEGATIVE: an archived bundle grants nothing, whatever its tier
  S.archived = await server("archived", [{ name: "arch_tool" }]);
  await roleBundle("bundle-archived", S.archived, "arch_tool", "write", true);
  const [o] = await db.select({ on: orgSettings.mcpBundlesEnabled }).from(orgSettings).where(eq(orgSettings.id, ORG_SETTINGS_ID));
  bundlesWereEnabled = o?.on === true;
}, 120_000);

let restore: () => Promise<void> = async () => {};

afterAll(async () => {
  if (userIds.length) {
    await db.delete(managedSettingsBundles).where(inArray(managedSettingsBundles.userId, userIds));
    await db.delete(roleAssignments).where(inArray(roleAssignments.userId, userIds));
    await db.delete(toolGrants).where(inArray(toolGrants.userId, userIds));
    await db.update(users).set({ disabledAt: new Date() }).where(inArray(users.id, userIds));
  }
  await db.update(orgSettings).set({ mcpBundlesEnabled: bundlesWereEnabled }).where(eq(orgSettings.id, ORG_SETTINGS_ID));
  if (bundleIds.length) await db.delete(mcpBundles).where(inArray(mcpBundles.id, bundleIds));
  if (roleId) await db.delete(managedSettingsBundles).where(eq(managedSettingsBundles.roleId, roleId));
  if (roleId) await db.delete(roles).where(eq(roles.id, roleId));
  if (serverIds.length) await db.delete(mcpServers).where(inArray(mcpServers.id, serverIds));
  await restore();
  await app?.close();
  rmSync(keyDir, { recursive: true, force: true });
  for (const [k, v] of [
    ["REGULAIT_PUBLIC_URL", prevEnv.url],
    ["REGULAIT_EXPORT_SIGNING_KEY", prevEnv.key],
    ["REGULAIT_EXPORT_SIGNING_KEY_ID", prevEnv.keyId],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("ADR-0310: a user's bundle", () => {
  it("names only the servers the kernel shows the user a tool on, by gateway URL, and is signed", async () => {
    const r = await exportFor("user", memberId);
    expect(r.statusCode, r.body).toBe(201);
    const b = r.json();
    expect(b).toMatchObject({ version: 1, created: true, keyId: KEY_ID, serverCount: 1, subject: { kind: "user", id: memberId } });

    const a = await inject("GET", `/v1/managed-settings/bundles/${b.id}/archive`, adminKey);
    expect(a.statusCode).toBe(200);
    expect(a.headers["content-type"]).toBe("application/gzip");
    const files = untar(a.rawPayload);
    const manifest = files.get("manifest.json")!;
    const sig = Buffer.from(files.get("manifest.json.sig")!.trim(), "base64");
    expect(verify(null, Buffer.from(manifest, "utf8"), createPublicKey(publicKey.export({ type: "spki", format: "pem" })), sig)).toBe(true);
    const m = JSON.parse(manifest);
    for (const f of m.files as Array<{ path: string; sha256: string }>) {
      expect(createHash("sha256").update(files.get(f.path)!).digest("hex"), f.path).toBe(f.sha256);
    }

    const cc = JSON.parse(files.get("claude-code/managed-settings.json")!);
    expect(cc.allowManagedMcpServersOnly).toBe(true);
    expect(cc.allowedMcpServers).toEqual([{ serverUrl: `${ORIGIN}/mcp/${S.a}` }]);
    const copilot = JSON.parse(files.get("github-copilot/managed-settings.json")!);
    expect(copilot.allowedMcpServers).toEqual([{ serverUrl: `${ORIGIN}/mcp/${S.a}` }]);
    const codex = parseToml(files.get("openai-codex/requirements.toml")!) as { mcp_servers: Record<string, { identity: { url: string } }> };
    expect(Object.values(codex.mcp_servers).map((s) => s.identity.url)).toEqual([`${ORIGIN}/mcp/${S.a}`]);
    const cursor = JSON.parse(files.get("cursor/dashboard-worksheet.json")!);
    expect(cursor.servers).toEqual([{ url: `${ORIGIN}/mcp/${S.a}`, tools: ["read_doc"] }]);

    // byte-stable: the same archive on every download
    const again = await inject("GET", `/v1/managed-settings/bundles/${b.id}/archive`, adminKey);
    expect(Buffer.compare(again.rawPayload, a.rawPayload)).toBe(0);

    const [audit] = await db.select().from(auditLog).where(eq(auditLog.objectId, b.id));
    expect(audit).toMatchObject({ objectType: "managed_settings_bundle", ruleId: "managed-settings-bundle-exported", effect: "allow" });
  });

  it("returns the same version while the policy is unchanged, and the next version when it changes", async () => {
    const same = await exportFor("user", memberId);
    expect(same.statusCode, same.body).toBe(200);
    expect(same.json()).toMatchObject({ version: 1, created: false });

    await db.insert(toolGrants).values({ userId: memberId, serverId: S.b, toolName: "search" });
    const next = await exportFor("user", memberId);
    expect(next.statusCode, next.body).toBe(201);
    expect(next.json()).toMatchObject({ version: 2, serverCount: 2 });

    const pinned = await exportFor("user", memberId, { claudeCodeMinimumVersion: "2.1.300" });
    expect(pinned.json()).toMatchObject({ version: 3, created: true });

    const list = await inject("GET", `/v1/managed-settings/bundles?subjectKind=user&subjectId=${memberId}&limit=2`, adminKey);
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json().bundles.map((x: { version: number }) => x.version)).toEqual([3, 2]);
    const page2 = await inject("GET", `/v1/managed-settings/bundles?subjectKind=user&subjectId=${memberId}&limit=2&before=${list.json().next}`, adminKey);
    expect(page2.json().bundles.map((x: { version: number }) => x.version)).toEqual([1]);
    expect(page2.json().next).toBeNull();
  });

  it("is an explicit deny-all for a user with nothing entitled, and for a disabled user", async () => {
    for (const id of [loneId]) {
      const r = await exportFor("user", id);
      expect(r.statusCode, r.body).toBe(201);
      expect(r.json().serverCount).toBe(0);
      const files = untar((await inject("GET", `/v1/managed-settings/bundles/${r.json().id}/archive`, adminKey)).rawPayload);
      expect(JSON.parse(files.get("claude-code/managed-settings.json")!).allowedMcpServers).toEqual([]);
      expect(JSON.parse(files.get("github-copilot/managed-settings.json")!).allowedMcpServers).toEqual([]);
      expect(parseToml(files.get("openai-codex/requirements.toml")!)).toEqual({ mcp_servers: {} });
    }
    await db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, memberId));
    const d = await exportFor("user", memberId);
    expect(d.json()).toMatchObject({ serverCount: 0, created: true });
    await db.update(users).set({ disabledAt: null }).where(eq(users.id, memberId));
  });
});

describe("ADR-0310: a role's bundle", () => {
  const allowedFor = async (id: string) => {
    const files = untar((await inject("GET", `/v1/managed-settings/bundles/${id}/archive`, adminKey)).rawPayload);
    return JSON.parse(files.get("claude-code/managed-settings.json")!).allowedMcpServers;
  };

  it("carries the role's own grants, and no ADR-0236 bundle while the bundles switch is off", async () => {
    await db.update(orgSettings).set({ mcpBundlesEnabled: false }).where(eq(orgSettings.id, ORG_SETTINGS_ID));
    const r = await exportFor("role", roleId);
    expect(r.statusCode, r.body).toBe(201);
    expect(await allowedFor(r.json().id)).toEqual([{ serverUrl: `${ORIGIN}/mcp/${S.b}` }]);
  });

  it("includes the MCP bundles granted to the role once the switch is on (owner decision M1), as a new version", async () => {
    await db.update(orgSettings).set({ mcpBundlesEnabled: true }).where(eq(orgSettings.id, ORG_SETTINGS_ID));
    const r = await exportFor("role", roleId);
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json()).toMatchObject({ created: true, serverCount: 2 });
    const want = [S.b, S.bundled].map((id) => ({ serverUrl: `${ORIGIN}/mcp/${id}` })).sort((x, y) => (x.serverUrl < y.serverUrl ? -1 : 1));
    expect(await allowedFor(r.json().id)).toEqual(want);
  });

  it("NEGATIVE: leaves out a read-tier bundle naming only a write tool, and an archived bundle (#850 review)", async () => {
    await db.update(orgSettings).set({ mcpBundlesEnabled: true }).where(eq(orgSettings.id, ORG_SETTINGS_ID));
    const r = await exportFor("role", roleId);
    expect(r.statusCode, r.body).toBe(200);
    const urls = (await allowedFor(r.json().id)).map((e: { serverUrl: string }) => e.serverUrl);
    expect(urls).not.toContain(`${ORIGIN}/mcp/${S.bundledWrite}`);
    expect(urls).not.toContain(`${ORIGIN}/mcp/${S.archived}`);
    // positive control: the same role does reach the read-tier bundle
    expect(urls).toContain(`${ORIGIN}/mcp/${S.bundled}`);
  });
});

describe("ADR-0310: refusals", () => {
  it("refuses with no signing key, and with no public URL — never an unsigned bundle", async () => {
    delete process.env.REGULAIT_EXPORT_SIGNING_KEY;
    const k = await exportFor("user", loneId);
    process.env.REGULAIT_EXPORT_SIGNING_KEY = keyPath;
    expect(k.statusCode, k.body).toBe(409);
    expect(k.json().error).toBe("export-signing-key-absent");

    delete process.env.REGULAIT_PUBLIC_URL;
    const u = await exportFor("user", loneId);
    process.env.REGULAIT_PUBLIC_URL = ORIGIN;
    expect(u.statusCode, u.body).toBe(409);
    expect(u.json().error).toBe("public_url_unset");
  });

  it("validates input and answers 404 for unknown subjects and bundles", async () => {
    expect((await inject("POST", "/v1/managed-settings/bundles", adminKey, { subject: { kind: "team", id: loneId } })).statusCode).toBe(400);
    expect((await exportFor("user", loneId, { claudeCodeMinimumVersion: "latest" })).statusCode).toBe(400);
    expect((await exportFor("user", "00000000-0000-4000-8000-000000000000")).statusCode).toBe(404);
    expect((await inject("GET", "/v1/managed-settings/bundles/00000000-0000-4000-8000-000000000000/archive", adminKey)).statusCode).toBe(404);
    expect((await inject("GET", "/v1/managed-settings/bundles?subjectKind=user", adminKey)).statusCode).toBe(400);
  });

  it("is admin-only", async () => {
    expect((await inject("POST", "/v1/managed-settings/bundles", memberKey, { subject: { kind: "user", id: memberId } })).statusCode).toBe(403);
    expect((await inject("GET", "/v1/managed-settings/bundles", memberKey)).statusCode).toBe(403);
  });
});

describe("ADR-0310: row-level security on the bundle tables (#850 review)", () => {
  type Counts = { b: number; f: number };
  const COUNT = sql`select (select count(*)::int from managed_settings_bundles) as b, (select count(*)::int from managed_settings_bundle_files) as f`;
  const countAs = async (opts: { userId?: string; reason?: string }) =>
    db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('role', 'regulait_app', true)`);
      if (opts.userId) await tx.execute(sql`select set_config('regulait.user_id', ${opts.userId}, true)`);
      if (opts.reason) await tx.execute(sql`select set_config('regulait.system_context', ${opts.reason}, true)`);
      return ((await tx.execute(COUNT)).rows as Counts[])[0]!;
    });

  it("both tables have row-level security ENABLED and FORCED", async () => {
    const r = await db.execute(sql`
      select relname, relrowsecurity as on, relforcerowsecurity as forced from pg_class
       where relnamespace = 'public'::regnamespace and relname in ('managed_settings_bundles', 'managed_settings_bundle_files') order by relname`);
    expect(r.rows).toEqual([
      { relname: "managed_settings_bundle_files", on: true, forced: true },
      { relname: "managed_settings_bundles", on: true, forced: true },
    ]);
  });

  it("NEGATIVE: a plain regulait_app connection, a non-admin principal and another system reason see no row", async () => {
    const all = ((await db.execute(COUNT)).rows as Counts[])[0]!;
    expect(all.b).toBeGreaterThan(0);
    expect(all.f).toBeGreaterThan(0);
    expect(await countAs({})).toEqual({ b: 0, f: 0 });
    expect(await countAs({ userId: loneId })).toEqual({ b: 0, f: 0 });
    expect(await countAs({ reason: "public_ingest" })).toEqual({ b: 0, f: 0 });
    // positive controls: an active admin principal and the migration reason reach every row
    expect(await countAs({ userId: adminId })).toEqual(all);
    expect(await countAs({ reason: "migration" })).toEqual(all);
  });

  it("NEGATIVE: a non-admin principal cannot write either table", async () => {
    const [anyBundle] = await db.select({ id: managedSettingsBundles.id }).from(managedSettingsBundles).where(inArray(managedSettingsBundles.userId, userIds)).limit(1);
    const writeAs = (stmt: ReturnType<typeof sql>) =>
      db
        .transaction(async (tx) => {
          await tx.execute(sql`select set_config('role', 'regulait_app', true)`);
          await tx.execute(sql`select set_config('regulait.user_id', ${loneId}, true)`);
          await tx.execute(stmt);
        })
        .then(
          () => null,
          (e: unknown) => e as { message?: string; cause?: { message?: string } },
        );
    const b = await writeAs(sql`insert into managed_settings_bundles (subject_kind, user_id, version, policy_digest, manifest, signature, key_id)
      values ('user', ${loneId}, 999, 'd', '{}', 's', 'k')`);
    expect(String(b?.cause?.message ?? b?.message)).toMatch(/row-level security/);
    const f = await writeAs(sql`insert into managed_settings_bundle_files (bundle_id, path, body, sha256) values (${anyBundle!.id}, 'x', 'x', 'x')`);
    expect(String(f?.cause?.message ?? f?.message)).toMatch(/row-level security/);
  });
});
