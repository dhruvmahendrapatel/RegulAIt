/**
 * ADR-0189 R17 — THE AI BOM SNAPSHOT RELEASE. B5 (#297) and B4 (#344) have both
 * merged, so `AI_BOM_SNAPSHOTS_RELEASED` is true, and R17 requires that this
 * release's tests download EVERY format as a verified `export-bundle/3` (R7).
 *
 * One file, its own scratch database (M-040, M-042), real routes end to end:
 *  - a snapshot is taken through the real API (`POST .../snapshots`) of a
 *    subject whose records support every v1 renderer: CycloneDX 1.7, CycloneDX
 *    1.6 (the audited `cyclonedx_export_versions` relaxation) and SPDX 3.0.1
 *    (the B9 supplier-declared properties, written through their admin routes);
 *  - every format the download route serves (`AI_BOM_DOWNLOAD_FORMATS`) and the
 *    whole-snapshot bundle is downloaded and verified `valid` three ways: the
 *    shared B4 verifier under an out-of-band trust root, `scripts/verify-bom.mjs`
 *    (exit 0) and `POST /v1/boms/verify`;
 *  - NEGATIVE: a tampered download is `invalid` to all three (the script exits
 *    1); a member and an ungranted auditor are refused 403 `bom_export_forbidden`
 *    on every download (the strict `bom_export_roles = admins_only`), and a
 *    member cannot freeze; no receipt key is 409 and nothing is written;
 *  - R8: the drift route is live against the new snapshot, a change list with
 *    `evidence: false`, admins only, audited, and stores nothing.
 *
 * Needs the built packages (`pnpm -r build`): `scripts/verify-bom.mjs` imports the dist.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { gunzipSync, gzipSync } from "node:zlib";
import { agents, aiBomSnapshots, and, auditLog, createDb, eq, modelCards, runMigrations, sql, type Db } from "@regulait/db";
import {
  AI_BOM_DOWNLOAD_FORMATS,
  AI_BOM_SNAPSHOTS_RELEASED,
  bomBundleHeadersSchema,
  bomSpkiFingerprint,
  bomVerifyResponseSchema,
  readBomTar,
  verifyBomBundle,
  type BomVerifyTrust,
} from "@regulait/shared";
import { buildApp } from "./app.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { closeAll, dropScratchDatabase } from "./testing/scratch-db.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "../../..");
const VERIFY_BOM = path.join(ROOT, "scripts/verify-bom.mjs");
const migrationsFolder = path.join(ROOT, "packages/db/migrations");
const RUN = Math.random().toString(36).slice(2, 8);
const SCRATCH = `a189_r17_${process.pid}_${RUN}`;
const BOOT = `r17-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const urlFor = (name: string) => {
  const u = new URL(DATABASE_URL);
  u.pathname = `/${name}`;
  return u.toString();
};
const rowsOf = <T>(r: unknown) => (r as { rows: T[] }).rows;
const ENV_KEYS = ["REGULAIT_RECEIPT_SIGNING_KEY", "REGULAIT_RECEIPT_SIGNING_KEY_ID", "REGULAIT_EXPORT_SIGNING_KEY", "REGULAIT_EXPORT_SIGNING_KEY_ID", "REGULAIT_TSA_TRUST_BUNDLE", "REGULAIT_INSTALL_ID", "REGULAIT_EXPORT_VERIFY_PUBLIC_KEYS", "REGULAIT_EXPORT_VERIFY_PUBLIC_KEYS_FILE"] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
/** every format the download route serves, and the whole-snapshot bundle */
const RENDERED_FORMATS = AI_BOM_DOWNLOAD_FORMATS.filter((f) => f !== "native");

let admin: Db;
let db: Db;
let app: ReturnType<typeof buildApp>;
let dir: string;
let exportPublicPem: string;
let receiptKeyring: string;
const users = {} as Record<"member" | "auditor", { id: string; auth: { authorization: string } }>;
const ids = {} as Record<"agent" | "card" | "snapshot", string>;

type Method = "GET" | "POST" | "PUT";
const inject = (method: Method, url: string, headers: Record<string, string> = AUTH, payload?: unknown) =>
  app.inject({ method, url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });
const snapshotCount = async () => rowsOf<{ n: number }>(await db.execute(sql`select count(*)::int as n from ai_bom_snapshots`))[0]!.n;

/** the out-of-band trust root an auditor holds: the receipt keys and the export key fingerprint */
async function offlineTrust(): Promise<BomVerifyTrust> {
  const keys = (await inject("GET", "/v1/receipts/keys")).json().keys as Array<{ keyId: string; jwk: { kty: string; crv: string; x: string } }>;
  return { receipt: { keys }, receiptV2FromAuditSeq: null, export: { pinnedFingerprints: [bomSpkiFingerprint(exportPublicPem)] }, timestamp: null, verificationTime: new Date().toISOString() };
}
async function download(url: string) {
  const res = await inject("GET", url);
  expect(res.statusCode, `${url}: ${res.body.slice(0, 300)}`).toBe(200);
  const headers = bomBundleHeadersSchema.parse(res.headers);
  expect(headers["x-regulait-bundle-subject"]).toBe("ai-bom");
  const archive = res.rawPayload;
  expect(headers["x-regulait-bundle-sha256"]).toBe(createHash("sha256").update(archive).digest("hex"));
  return archive;
}
/** `scripts/verify-bom.mjs`, the auditor's offline tool, on the downloaded bytes */
function verifyScript(name: string, archive: Buffer) {
  const file = path.join(dir, `${name}.tar.gz`);
  writeFileSync(file, archive);
  const r = spawnSync(process.execPath, [VERIFY_BOM, file, "--fingerprint", bomSpkiFingerprint(exportPublicPem), "--receipt-keyring", receiptKeyring, "--json"], { encoding: "utf8", timeout: 60_000 });
  const report = r.stdout ? (JSON.parse(r.stdout) as { outcome: string; checks: Array<{ check: string; status: string; reason?: string }> }) : null;
  return { status: r.status, stderr: r.stderr, outcome: report?.outcome ?? null, notValid: report?.checks.filter((c) => c.status !== "valid") ?? [] };
}
/** the offset of an entry's data in a ustar archive (the name may be split into the prefix field) */
function tarDataOffset(tar: Buffer, suffix: string): number {
  const field = (from: number, len: number) => tar.subarray(from, from + len).toString("utf8").replace(/\0.*$/s, "");
  for (let h = 0; h + 512 <= tar.length && tar[h] !== 0; ) {
    const [name, prefix] = [field(h, 100), field(h + 345, 155)];
    const size = parseInt(field(h + 124, 12).trim(), 8);
    if ((prefix ? `${prefix}/${name}` : name).endsWith(`/${suffix}`)) return h + 512;
    h += 512 + Math.ceil(size / 512) * 512;
  }
  return -1;
}
async function verifyOnline(archive: Buffer) {
  const res = await inject("POST", "/v1/boms/verify", AUTH, { source: "bundle", bundleBase64: archive.toString("base64") });
  expect(res.statusCode, res.body).toBe(200);
  return bomVerifyResponseSchema.parse(res.json());
}

beforeAll(async () => {
  admin = createDb(DATABASE_URL);
  await admin.execute(sql.raw(`DROP DATABASE IF EXISTS ${SCRATCH} WITH (FORCE)`));
  await admin.execute(sql.raw(`CREATE DATABASE ${SCRATCH}`));
  db = createDb(urlFor(SCRATCH));
  await runMigrations(db, migrationsFolder);
  await relaxIdentityForTest(db, { mfaRequired: "off" });
  // this file makes more than the strict 30 BOM requests a minute; and it renders CycloneDX 1.6 too (the audited
  // relaxation an admin may make), so every format the route serves exists. Its own scratch database is dropped.
  await db.execute(sql`update org_settings set bom_export_rate_limit_per_minute = 600, cyclonedx_export_versions = '["1.7","1.6"]'::jsonb`);
  for (const k of ENV_KEYS) delete process.env[k];
  dir = mkdtempSync(path.join(tmpdir(), "r17-release-"));
  const receipt = generateKeyPairSync("ed25519");
  writeFileSync(path.join(dir, "receipt.pem"), receipt.privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
  const exportPair = generateKeyPairSync("ed25519");
  writeFileSync(path.join(dir, "export.pem"), exportPair.privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
  exportPublicPem = exportPair.publicKey.export({ type: "spki", format: "pem" }).toString();
  process.env.REGULAIT_RECEIPT_SIGNING_KEY = path.join(dir, "receipt.pem");
  process.env.REGULAIT_RECEIPT_SIGNING_KEY_ID = `r17-receipt-${RUN}`;
  process.env.REGULAIT_EXPORT_SIGNING_KEY = path.join(dir, "export.pem");
  process.env.REGULAIT_EXPORT_SIGNING_KEY_ID = `r17-export-${RUN}`;
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "b".repeat(64) });
  for (const k of ["member", "auditor"] as const) {
    const u = await inject("POST", "/v1/users", AUTH, { email: `r17-${k}-${RUN}@example.com`, displayName: `r17 ${k}`, isAdmin: false });
    expect(u.statusCode, u.body).toBe(201);
    const id = u.json().id as string;
    const token = (await inject("POST", `/v1/users/${id}/keys`, AUTH, { name: "r17" })).json().token as string;
    users[k] = { id, auth: { authorization: `Bearer ${token}` } };
  }
  // SYNTHETIC subject: one agent and its model card; the SPDX mandatory properties are declared through the B9 routes
  const [a] = await db.insert(agents).values({ name: `r17-agent-${RUN}`, provider: "provider-r17", tier: 1, model: "model-r17", ownerUserId: users.member.id }).returning({ id: agents.id });
  const [card] = await db.insert(modelCards).values({ agentId: a!.id, intendedUse: "R17 synthetic triage", dataClaims: { license: "Apache-2.0" }, pinnedModelVersion: "2026-09-01" }).returning({ id: modelCards.id });
  Object.assign(ids, { agent: a!.id, card: card!.id });
  for (const [property, value] of [["releaseTime", "2026-01-02T03:04:05Z"], ["downloadLocation", "https://models.supplier-r17.example"], ["packageVersion", "r17-2026.01"]] as const) {
    const r = await inject("PUT", `/v1/ai-bom/spdx-fields/model_card/${card!.id}/${property}`, AUTH, { value, source: "supplier_declared" });
    expect(r.statusCode, `${property}: ${r.body}`).toBe(200);
  }
}, 300_000);

afterAll(async () => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  await closeAll([
    async () => { app?.server.closeAllConnections(); await app?.close(); },
    async () => db?.$client.end(),
    async () => dropScratchDatabase(admin, SCRATCH),
    async () => admin?.$client.end(),
    async () => rmSync(dir, { recursive: true, force: true }),
  ]);
}, 120_000);

describe("ADR-0189 R17: the release switch is on, and a snapshot is taken through the real API", () => {
  it("the switch is released", () => {
    expect(AI_BOM_SNAPSHOTS_RELEASED).toBe(true);
  });

  it("no receipt key: the freeze is refused 409 bom_signing_unavailable and nothing is written (never unsigned)", async () => {
    const before = await snapshotCount();
    const [key, keyId] = [process.env.REGULAIT_RECEIPT_SIGNING_KEY, process.env.REGULAIT_RECEIPT_SIGNING_KEY_ID];
    delete process.env.REGULAIT_RECEIPT_SIGNING_KEY;
    delete process.env.REGULAIT_RECEIPT_SIGNING_KEY_ID;
    try {
      const res = await inject("POST", `/v1/ai-bom/agent/${ids.agent}/snapshots`, AUTH, {});
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json()).toMatchObject({ error: "bom_signing_unavailable" });
    } finally {
      process.env.REGULAIT_RECEIPT_SIGNING_KEY = key;
      process.env.REGULAIT_RECEIPT_SIGNING_KEY_ID = keyId;
    }
    expect(await snapshotCount()).toBe(before);
  });

  it("a member cannot freeze (admin-only route class) and writes nothing", async () => {
    const before = await snapshotCount();
    expect((await inject("POST", `/v1/ai-bom/agent/${ids.agent}/snapshots`, users.member.auth, {})).statusCode).toBe(403);
    expect((await inject("POST", `/v1/ai-bom/agent/${ids.agent}/snapshots`, {}, {})).statusCode).toBe(401);
    expect(await snapshotCount()).toBe(before);
  });

  it("an admin freezes a snapshot with every v1 rendering: CycloneDX 1.7, CycloneDX 1.6 and SPDX 3.0.1", async () => {
    const res = await inject("POST", `/v1/ai-bom/agent/${ids.agent}/snapshots`, AUTH, {});
    expect(res.statusCode, res.body).toBe(201);
    const taken = res.json() as { id: string; version: number; bodySha256: string };
    expect(taken.version).toBe(1);
    ids.snapshot = taken.id;
    const list = await inject("GET", `/v1/ai-bom/agent/${ids.agent}/snapshots`);
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json()).toMatchObject({ released: true, snapshots: [expect.objectContaining({ id: taken.id, version: 1, trigger: "on_demand" })] });
    expect(list.json().snapshots[0].formats).toEqual([...RENDERED_FORMATS].sort());
    const [row] = await db.select().from(aiBomSnapshots).where(eq(aiBomSnapshots.id, taken.id));
    const commitments = (JSON.parse(row!.body) as { renderings: Record<string, { status: string }> }).renderings;
    for (const f of RENDERED_FORMATS) expect(commitments[f]?.status, f).toBe("rendered");
    expect((await db.select().from(auditLog).where(and(eq(auditLog.ruleId, "ai-bom-snapshot-taken"), eq(auditLog.objectId, taken.id)))).length).toBe(1);
    // the receipt keyring the auditor obtains out of band (the key is recorded when it first signs), for verify-bom.mjs
    receiptKeyring = path.join(dir, "receipt-keys.json");
    writeFileSync(receiptKeyring, (await inject("GET", "/v1/receipts/keys")).body);
  });
});

describe("ADR-0189 R17 / R7: every format downloads as a verified export-bundle/3", () => {
  const archives = new Map<string, Buffer>();

  for (const format of AI_BOM_DOWNLOAD_FORMATS) {
    it(`format=${format}: valid under the shared verifier, scripts/verify-bom.mjs and the online verifier`, async () => {
      const archive = await download(`/v1/ai-bom/snapshots/${ids.snapshot}?format=${format}`);
      archives.set(format, archive);
      const tar = readBomTar(gunzipSync(archive));
      expect(tar.ok).toBe(true);
      const names = tar.ok ? [...tar.files.keys()] : [];
      // the signed native body travels in every bundle; a rendering only inside one, never bare (R7)
      expect(names).toEqual(expect.arrayContaining(["manifest.json", "manifest.json.sig", "content/ai-bom.json", "content/ai-bom.json.sig"]));
      const renderings = names.filter((n) => /^content\/ai-bom\.[^/]+\.json$/.test(n) && !n.endsWith(".sig"));
      expect(renderings).toEqual(format === "native" ? [] : [`content/ai-bom.${format}.json`]);
      const offline = await verifyBomBundle(archive, await offlineTrust());
      expect(offline.outcome, JSON.stringify(offline.checks.filter((c) => c.status !== "valid"))).toBe("valid");
      if (format !== "native") expect(offline.checks.filter((c) => c.check === "rendering_hashes").map((c) => c.ref)).toEqual([format]);
      const script = verifyScript(`r17-${format}`, archive);
      expect(script, JSON.stringify(script)).toMatchObject({ status: 0, outcome: "valid" });
      expect((await verifyOnline(archive)).outcome).toBe("valid");
    });
  }

  it("the whole-snapshot bundle carries every rendering and verifies valid three ways", async () => {
    const archive = await download(`/v1/ai-bom/snapshots/${ids.snapshot}/bundle`);
    archives.set("bundle", archive);
    const tar = readBomTar(gunzipSync(archive));
    expect(tar.ok && [...tar.files.keys()].filter((n) => /^content\/ai-bom\.[^/]+\.json$/.test(n)).sort()).toEqual(RENDERED_FORMATS.map((f) => `content/ai-bom.${f}.json`).sort());
    const offline = await verifyBomBundle(archive, await offlineTrust());
    expect(offline.outcome, JSON.stringify(offline.checks.filter((c) => c.status !== "valid"))).toBe("valid");
    expect(offline.checks.filter((c) => c.check === "rendering_hashes").map((c) => c.ref).sort()).toEqual([...RENDERED_FORMATS].sort());
    expect(verifyScript("r17-bundle", archive)).toMatchObject({ status: 0, outcome: "valid" });
    expect((await verifyOnline(archive)).outcome).toBe("valid");
  });

  it("NEGATIVE: a tampered download of each rendering is invalid to all three verifiers (the script exits 1)", async () => {
    for (const format of [...RENDERED_FORMATS, "bundle"]) {
      const tar = gunzipSync(archives.get(format)!);
      // the first byte of a rendering's payload (its opening brace) becomes a space: the tar stays well formed,
      // and only the content's hash is wrong
      const entry = format === "bundle" ? "content/ai-bom.spdx-3.0.1.json" : `content/ai-bom.${format}.json`;
      const at = tarDataOffset(tar, entry);
      expect(at, entry).toBeGreaterThan(0);
      expect(tar[at], entry).toBe(0x7b);
      tar[at] = 0x20;
      const tampered = gzipSync(tar);
      const offline = await verifyBomBundle(tampered, await offlineTrust());
      expect(offline.outcome, format).toBe("invalid");
      expect(verifyScript(`r17-tampered-${format}`, tampered), format).toMatchObject({ status: 1, outcome: "invalid" });
      expect((await verifyOnline(tampered)).outcome, format).toBe("invalid");
    }
  });
});

describe("ADR-0189 §7 / R17: who may download, with the switch on", () => {
  it("bom_export_roles stays strict (admins_only), and a member and an ungranted auditor get 403 bom_export_forbidden", async () => {
    const [s] = rowsOf<{ roles: string }>(await db.execute(sql`select bom_export_roles as roles from org_settings`));
    expect(s!.roles).toBe("admins_only");
    await db.execute(sql`insert into bom_auditor_grants (user_id, granted_by) values (${users.auditor.id}, ${users.member.id})`);
    const exported = async () => (await db.select({ id: auditLog.id }).from(auditLog).where(eq(auditLog.ruleId, "ai-bom-exported"))).length;
    const before = await exported();
    for (const who of ["member", "auditor"] as const) {
      for (const url of [...AI_BOM_DOWNLOAD_FORMATS.map((f) => `/v1/ai-bom/snapshots/${ids.snapshot}?format=${f}`), `/v1/ai-bom/snapshots/${ids.snapshot}/bundle`]) {
        const res = await inject("GET", url, users[who].auth);
        expect(res.statusCode, `${who} ${url}`).toBe(403);
        expect(res.json()).toMatchObject({ error: "bom_export_forbidden" });
      }
    }
    expect(await exported()).toBe(before);
  });
});

describe("ADR-0189 R8: the drift route is live against the released snapshot", () => {
  it("a change list with evidence:false, admins only, audited, and nothing stored", async () => {
    const before = await snapshotCount();
    const unchanged = await inject("GET", `/v1/ai-bom/agent/${ids.agent}/drift`);
    expect(unchanged.statusCode, unchanged.body).toBe(200);
    expect(unchanged.json()).toMatchObject({ evidence: false, baseline: { snapshotId: ids.snapshot, version: 1 }, changes: [] });
    await db.update(modelCards).set({ pinnedModelVersion: "2026-10-01" }).where(eq(modelCards.id, ids.card));
    const drift = await inject("GET", `/v1/ai-bom/agent/${ids.agent}/drift`);
    expect(drift.statusCode, drift.body).toBe(200);
    expect(drift.json().changes).toEqual(expect.arrayContaining([expect.objectContaining({ ref: `model:${ids.card}`, change: "changed_version" })]));
    expect((await inject("GET", `/v1/ai-bom/agent/${ids.agent}/drift`, users.member.auth)).statusCode).toBe(403);
    expect((await db.select().from(auditLog).where(eq(auditLog.ruleId, "ai-bom-drift-viewed"))).length).toBeGreaterThanOrEqual(2);
    expect(await snapshotCount()).toBe(before);
  });
});
