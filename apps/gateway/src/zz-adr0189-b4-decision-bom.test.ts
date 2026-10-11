/**
 * ADR-0189 slice B4 — the Decision BOM assembler, freeze, bundles and the online
 * verifier, end to end through the routes on a scratch database of its own.
 *
 * Proves, against real rows written by the real writers (B2's shared audit
 * writer captures the facts; the receipt sweep signs the receipts):
 *  - X01/X02: no receipt key is 409 `bom_signing_unavailable`; an unsigned
 *    receipt is 409 `bom_anchor_pending` `receipt_unsigned` with `Retry-After`;
 *  - the strict floor with no anchor is pending `anchor_not_flushed`; under the
 *    audited `chain_signed` relaxation the BOM freezes, and the read response
 *    meets the frozen contract; a second request returns the same version (X11);
 *    two concurrent first requests return one frozen version (X13);
 *  - an anchored decision freezes `anchored` (the emitted state, not the floor,
 *    X14), and its RFC 3161 token verifies `valid` under the right TSA trust
 *    bundle and `invalid` `timestamp_invalid` under another (#312 P08);
 *  - a late addendum blocks a new version until it is signed (X03), then a new
 *    version supersedes the first, which is never edited (X12);
 *  - an email shape in the body (X09) or in the operator's install id (X10)
 *    refuses the export naming the file and the path, never the value;
 *  - every bundle (Decision BOM and AI BOM, every format) verifies offline under
 *    an out-of-band trust root and online through `POST /v1/boms/verify`; a
 *    tampered bundle is `invalid`; verification needs no private key (R6);
 *  - access: admins only by default; an auditor grant only while relaxed; the
 *    drift view stays admins only (R8).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, createPrivateKey, generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { gunzipSync, gzipSync } from "node:zlib";
import { aiBomSnapshots, auditAnchors, auditLog, createDb, decisionBoms, decisionFacts, eq, runMigrations, sql, type Db } from "@regulait/db";
import {
  AI_BOM_INSTALL_SUBJECT_ID,
  bomBundleHeadersSchema,
  bomCanonicalBytes,
  bomRowDigest,
  bomSpkiFingerprint,
  bomVerifyResponseSchema,
  decisionBomReadResponseSchema,
  projectBomRow,
  readBomTar,
  verifyBomBundle,
  type BomVerifyTrust,
} from "@regulait/shared";
import { buildApp } from "./app.js";
import { anchorRecordFromRow, timestampRequest } from "./audit-timestamp.js";
import { verifyTimestampResponse, parseTimestampTrustBundle } from "./audit-timestamp-verify.js";
import { AI_BOM_SNAPSHOTS_RELEASED, takeAiBomSnapshot } from "./ai-bom.js";
import { releaseAiBomDownloadsForTest } from "./bom-routes.js";
import { runDecisionReceiptSignSweep } from "./decision-receipts.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { closeAll, dropScratchDatabase } from "./testing/scratch-db.js";
import { syntheticTsa } from "./testing/tsa-fixture.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");
const RUN = Math.random().toString(36).slice(2, 8);
const SCRATCH = `a189_b4_${process.pid}_${RUN}`;
const BOOT = `b4-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const urlFor = (name: string) => {
  const u = new URL(DATABASE_URL);
  u.pathname = `/${name}`;
  return u.toString();
};
const rows = <T>(r: unknown) => (r as { rows: T[] }).rows;
const ENV_KEYS = ["REGULAIT_RECEIPT_SIGNING_KEY", "REGULAIT_RECEIPT_SIGNING_KEY_ID", "REGULAIT_EXPORT_SIGNING_KEY", "REGULAIT_EXPORT_SIGNING_KEY_ID", "REGULAIT_TSA_TRUST_BUNDLE", "REGULAIT_INSTALL_ID", "REGULAIT_EXPORT_VERIFY_PUBLIC_KEYS", "REGULAIT_EXPORT_VERIFY_PUBLIC_KEYS_FILE"] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

let admin: Db;
let db: Db;
let app: ReturnType<typeof buildApp>;
let keyDir: string;
let receiptKeyFile: string;
let exportPublicPem: string;
let tsa: ReturnType<typeof syntheticTsa>;
let otherTsa: ReturnType<typeof syntheticTsa>;
const restores: Array<() => Promise<void>> = [];
const users = {} as Record<"member" | "auditor", { id: string; auth: { authorization: string } }>;
const RECEIPT_KEY_ID = `b4-receipt-${RUN}`;
const EXPORT_KEY_ID = `b4-export-${RUN}`;

type Method = "GET" | "POST";
const inject = (method: Method, url: string, headers: Record<string, string> = AUTH, payload?: unknown) =>
  app.inject({ method, url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });
const setReceiptKey = (on: boolean) => {
  if (on) {
    process.env.REGULAIT_RECEIPT_SIGNING_KEY = receiptKeyFile;
    process.env.REGULAIT_RECEIPT_SIGNING_KEY_ID = RECEIPT_KEY_ID;
  } else {
    delete process.env.REGULAIT_RECEIPT_SIGNING_KEY;
    delete process.env.REGULAIT_RECEIPT_SIGNING_KEY_ID;
  }
};
const setting = (assignment: string) => db.execute(sql.raw(`update org_settings set ${assignment}`));

/** a receipt-eligible governed decision, written through the shared audit writer (B2 captures its facts) */
async function decision(toolName = "search"): Promise<typeof auditLog.$inferSelect> {
  const [row] = await db
    .insert(auditLog)
    .values({ userId: users.member.id, objectType: "mcp_tool", serverId: "d0000000-0000-4000-8000-0000000000b4", toolName, effect: "allow", ruleId: "b4-rule", ruleChain: ["b4-rule"], reason: "b4 decision", detail: { receiptClass: "decision", argumentsDigest: "a".repeat(64) } })
    .returning();
  return row!;
}
const sweep = () => runDecisionReceiptSignSweep(db, { now: new Date() });

/** the out-of-band trust root an auditor holds: the receipt keys and the export key fingerprint */
async function offlineTrust(): Promise<BomVerifyTrust> {
  const keys = (await inject("GET", "/v1/receipts/keys")).json().keys as Array<{ keyId: string; jwk: { kty: string; crv: string; x: string } }>;
  return { receipt: { keys }, receiptV2FromAuditSeq: null, export: { pinnedFingerprints: [bomSpkiFingerprint(exportPublicPem)] }, timestamp: null, verificationTime: new Date().toISOString() };
}
async function verifyOnline(payload: Record<string, unknown>) {
  const res = await inject("POST", "/v1/boms/verify", AUTH, payload);
  expect(res.statusCode, res.body).toBe(200);
  return bomVerifyResponseSchema.parse(res.json());
}
async function bundleOf(url: string) {
  const res = await inject("GET", url);
  expect(res.statusCode, res.body.slice(0, 300)).toBe(200);
  const headers = bomBundleHeadersSchema.parse(res.headers);
  const archive = res.rawPayload;
  expect(headers["x-regulait-bundle-sha256"]).toBe(createHash("sha256").update(archive).digest("hex"));
  expect([...archive.subarray(0, 4)]).toEqual([0x1f, 0x8b, 0x08, 0x00]);
  return { archive, headers };
}

beforeAll(async () => {
  admin = createDb(DATABASE_URL);
  await admin.execute(sql.raw(`DROP DATABASE IF EXISTS ${SCRATCH} WITH (FORCE)`));
  await admin.execute(sql.raw(`CREATE DATABASE ${SCRATCH}`));
  db = createDb(urlFor(SCRATCH));
  await runMigrations(db, migrationsFolder);
  restores.push(await relaxIdentityForTest(db, { mfaRequired: "off" }));
  // this file makes more than the strict 30 BOM requests a minute; its own scratch database is dropped at the end
  await setting("bom_export_rate_limit_per_minute = 600");
  for (const k of ENV_KEYS) delete process.env[k];
  keyDir = mkdtempSync(path.join(tmpdir(), "b4-keys-"));
  receiptKeyFile = path.join(keyDir, "receipt.pem");
  writeFileSync(receiptKeyFile, generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
  const exportPair = generateKeyPairSync("ed25519");
  writeFileSync(path.join(keyDir, "export.pem"), exportPair.privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
  exportPublicPem = exportPair.publicKey.export({ type: "spki", format: "pem" }).toString();
  process.env.REGULAIT_EXPORT_SIGNING_KEY = path.join(keyDir, "export.pem");
  process.env.REGULAIT_EXPORT_SIGNING_KEY_ID = EXPORT_KEY_ID;
  tsa = syntheticTsa();
  otherTsa = syntheticTsa();
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "b".repeat(64) });
  for (const k of ["member", "auditor"] as const) {
    const u = await inject("POST", "/v1/users", AUTH, { email: `b4-${k}-${RUN}@example.com`, displayName: `b4 ${k}`, isAdmin: false });
    expect(u.statusCode, u.body).toBe(201);
    const id = u.json().id as string;
    const token = (await inject("POST", `/v1/users/${id}/keys`, AUTH, { name: "b4" })).json().token as string;
    users[k] = { id, auth: { authorization: `Bearer ${token}` } };
  }
}, 180_000);

afterAll(async () => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  await closeAll([
    ...restores.reverse().map((r) => async () => r()),
    async () => { app?.server.closeAllConnections(); await app?.close(); },
    async () => db?.$client.end(),
    async () => dropScratchDatabase(admin, SCRATCH),
    async () => admin?.$client.end(),
    async () => tsa?.close(),
    async () => otherTsa?.close(),
    async () => rmSync(keyDir, { recursive: true, force: true }),
  ]);
}, 120_000);

describe("ADR-0189 B4: freezing a Decision BOM", () => {
  let first: typeof auditLog.$inferSelect;

  it("X01/X02: no receipt key is bom_signing_unavailable; an unsigned receipt is pending receipt_unsigned with Retry-After", async () => {
    first = await decision();
    setReceiptKey(false);
    const none = await inject("GET", `/v1/decisions/${first.id}/bom`);
    expect(none.statusCode, none.body).toBe(409);
    expect(none.json()).toMatchObject({ error: "bom_signing_unavailable", missingKey: "receipt" });
    setReceiptKey(true);
    const unsigned = await inject("GET", `/v1/decisions/${first.id}/bom`);
    expect(unsigned.statusCode, unsigned.body).toBe(409);
    expect(unsigned.json()).toMatchObject({ error: "bom_anchor_pending", reason: "receipt_unsigned" });
    expect(Number(unsigned.headers["retry-after"])).toBeGreaterThan(0);
  });

  it("the strict floor with no anchor stays pending anchor_not_flushed; nothing is frozen", async () => {
    await sweep();
    const res = await inject("GET", `/v1/decisions/${first.id}/bom`);
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json()).toMatchObject({ error: "bom_anchor_pending", reason: "anchor_not_flushed" });
    expect(await db.select().from(decisionBoms).where(eq(decisionBoms.auditId, first.id))).toEqual([]);
  });

  it("under the audited chain_signed relaxation it freezes, meets the read contract, and a second request returns it unchanged (X11)", async () => {
    await setting("decision_bom_finality = 'chain_signed'");
    const res = await inject("GET", `/v1/decisions/${first.id}/bom`);
    expect(res.statusCode, res.body).toBe(200);
    const out = decisionBomReadResponseSchema.parse(res.json());
    expect(out.bom).toMatchObject({ version: 1, supersedes: null, finality: "chain_signed", keyId: RECEIPT_KEY_ID, reportedFinality: "chain_signed" });
    expect(out.capabilities).toMatchObject({ access: "admin", canExport: true, canVerify: true, canViewDrift: true });
    // the facts B2 captured are carried exactly (R37), and the receipt is v1 (B2 still emits v1)
    const [facts] = await db.select().from(decisionFacts).where(eq(decisionFacts.auditId, first.id));
    expect(out.document.facts.payload).toBe(bomCanonicalBytes(facts!.facts));
    expect(JSON.parse(out.document.receipt.payload).v).toBe("regulait.receipt.v1");
    const again = decisionBomReadResponseSchema.parse((await inject("GET", `/v1/decisions/${first.id}/bom`)).json());
    expect(again.bom.id).toBe(out.bom.id);
    expect(again.versions.map((v) => v.version)).toEqual([1]);
  });

  it("X13: two concurrent first requests return one frozen version", async () => {
    const d = await decision();
    await sweep();
    const [a, b] = await Promise.all([inject("GET", `/v1/decisions/${d.id}/bom`), inject("GET", `/v1/decisions/${d.id}/bom`)]);
    expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
    expect(a.json().bom.id).toBe(b.json().bom.id);
    expect((await db.select().from(decisionBoms).where(eq(decisionBoms.auditId, d.id))).length).toBe(1);
  });

  it("X03 then X12: a late addendum waits for its signature, then freezes version 2; version 1 is never edited", async () => {
    const [v1] = await db.select().from(decisionBoms).where(eq(decisionBoms.auditId, first.id));
    const [facts] = await db.select().from(decisionFacts).where(eq(decisionFacts.auditId, first.id));
    const usage = projectBomRow("usage_events", {
      id: "e0000000-0000-4000-8000-0000000000b4", at: new Date(first.at.getTime() + 250), userId: users.member.id, objectType: "mcp_tool", operation: "tool_call",
      inputTokens: 12, outputTokens: 34, costUsd: 0.000123, configCanary: false,
    });
    const addendum = { v: "regulait.decision-facts-addendum.v1", auditId: first.id, n: 1, prev: facts!.factsHash, rows: [{ table: "usage_events", id: usage.id, projection: usage, digest: bomRowDigest("usage_events", usage) }], postActionVerification: null };
    const bytes = bomCanonicalBytes(addendum);
    const hash = createHash("sha256").update(bytes).digest("hex");
    await db.execute(sql`insert into decision_fact_addenda (audit_id, n, prev_hash, facts, facts_hash, expires_at) values (${first.id}, 1, ${facts!.factsHash}, ${JSON.stringify(addendum)}::jsonb, ${hash}, ${facts!.expiresAt})`);
    const waiting = await inject("GET", `/v1/decisions/${first.id}/bom`);
    expect(waiting.statusCode, waiting.body).toBe(409);
    expect(waiting.json()).toMatchObject({ error: "bom_anchor_pending", reason: "receipt_unsigned" });
    const signature = sign(null, Buffer.from(bytes, "utf8"), createPrivateKey(readFileSync(receiptKeyFile, "utf8"))).toString("base64url");
    await db.execute(sql`insert into decision_fact_addendum_signatures (audit_id, n, facts_hash, signature, key_id, expires_at) values (${first.id}, 1, ${hash}, ${signature}, ${RECEIPT_KEY_ID}, ${facts!.expiresAt})`);
    const res = await inject("GET", `/v1/decisions/${first.id}/bom`);
    expect(res.statusCode, res.body).toBe(200);
    const out = decisionBomReadResponseSchema.parse(res.json());
    expect(out.bom).toMatchObject({ version: 2, supersedes: v1!.id });
    expect(out.document.cost).toMatchObject({ usageEventIds: [usage.id], costUsd: "0.000123", inputTokens: 12 });
    const [v1After] = await db.select().from(decisionBoms).where(eq(decisionBoms.id, v1!.id));
    expect(v1After!.body).toBe(v1!.body);
    // a named version is read without assembling
    const named = decisionBomReadResponseSchema.parse((await inject("GET", `/v1/decisions/${first.id}/bom?version=1`)).json());
    expect(named.bom.id).toBe(v1!.id);
    expect((await inject("GET", `/v1/decisions/${first.id}/bom?version=9`)).json()).toMatchObject({ error: "bom_version_not_found" });
  });

  it("X09: an email shape in the assembled body refuses it, naming the file and the path, never the value", async () => {
    const d = await decision("search@v2.example");
    await sweep();
    const res = await inject("GET", `/v1/decisions/${d.id}/bom`);
    expect(res.statusCode, res.body).toBe(422);
    expect(res.json()).toMatchObject({ error: "bom_export_refused", reason: "email_shape", file: "body", path: "$.decision.toolName" });
    expect(res.body).not.toContain("search@v2.example");
  });

  it("an id that is not a governed decision is refused (404 unknown, 422 not receipt-eligible)", async () => {
    expect((await inject("GET", `/v1/decisions/00000000-0000-4000-8000-00000000dead/bom`)).json()).toMatchObject({ error: "bom_decision_not_found" });
    const [row] = await db.insert(auditLog).values({ userId: users.member.id, objectType: "audit_export", effect: "allow", ruleId: "b4-plain", ruleChain: [], reason: "not a decision" }).returning();
    const res = await inject("GET", `/v1/decisions/${row!.id}/bom`);
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ error: "bom_decision_not_eligible" });
    expect((await inject("GET", "/v1/decisions/not-a-uuid/bom")).json()).toMatchObject({ error: "invalid_audit_id" });
  });
});

describe("ADR-0189 B4: bundles verify offline and online", () => {
  let auditId: string;
  const snapshotIds: { first?: string } = {};
  afterAll(() => releaseAiBomDownloadsForTest(false));

  it("the Decision BOM bundle verifies offline under an out-of-band trust root, and online", async () => {
    const d = await decision();
    await sweep();
    auditId = d.id;
    const { archive, headers } = await bundleOf(`/v1/decisions/${d.id}/bom/bundle`);
    expect(headers["x-regulait-bundle-subject"]).toBe("decision-bom");
    expect(headers["content-disposition"]).toBe(`attachment; filename="regulait-export-decision-bom-${d.id}-v1.tar.gz"`);
    const read = readBomTar(gunzipSync(archive));
    expect(read.ok && [...read.files.keys()].sort()).toEqual(["README.txt", "audit/chain.tsv", "content/decision-bom.json", "content/decision-bom.json.sig", "manifest.json", "manifest.json.sig", "receipt-keys.json", "signing-key.pub"]);
    const offline = await verifyBomBundle(archive, await offlineTrust());
    expect(offline.outcome, JSON.stringify(offline.checks.filter((c) => c.status !== "valid"))).toBe("valid");
    expect(offline.cannotProve).toContain("facts_recorded_at_decision_time");
    const online = await verifyOnline({ source: "bundle", bundleBase64: archive.toString("base64") });
    expect(online).toMatchObject({ trust: "deployment_registry", source: "bundle", outcome: "valid" });
    const stored = await verifyOnline({ source: "decision_bom", auditId: d.id });
    expect(stored.outcome).toBe("valid");
    expect(stored.checks.some((c) => c.check.startsWith("bundle_"))).toBe(false);
  });

  it("a tampered bundle is invalid online; a bundle signed by a key the deployment does not hold is unknown_key", async () => {
    const { archive } = await bundleOf(`/v1/decisions/${auditId}/bom/bundle`);
    const tar = gunzipSync(archive);
    const at = tar.indexOf(Buffer.from('"effect":"allow"'));
    expect(at).toBeGreaterThan(0);
    tar.write('"effect":"deny" ', at, "latin1");
    const tampered = await verifyOnline({ source: "bundle", bundleBase64: gzipSync(tar).toString("base64") });
    expect(tampered.outcome).toBe("invalid");
    // another export key signs the next bundle: the deployment's own key no longer matches it
    const other = generateKeyPairSync("ed25519");
    writeFileSync(path.join(keyDir, "export2.pem"), other.privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
    process.env.REGULAIT_EXPORT_SIGNING_KEY = path.join(keyDir, "export2.pem");
    process.env.REGULAIT_EXPORT_SIGNING_KEY_ID = `${EXPORT_KEY_ID}-2`;
    const { archive: second } = await bundleOf(`/v1/decisions/${auditId}/bom/bundle`);
    process.env.REGULAIT_EXPORT_SIGNING_KEY = path.join(keyDir, "export.pem");
    process.env.REGULAIT_EXPORT_SIGNING_KEY_ID = EXPORT_KEY_ID;
    const out = await verifyOnline({ source: "bundle", bundleBase64: second.toString("base64") });
    expect(out.checks.find((c) => c.check === "bundle_manifest_signature")).toMatchObject({ status: "invalid", reason: "unknown_key" });
    // B4.2: listing that key in the verification keyring trusts it
    process.env.REGULAIT_EXPORT_VERIFY_PUBLIC_KEYS = JSON.stringify([{ keyId: `${EXPORT_KEY_ID}-2`, publicKeyPem: other.publicKey.export({ type: "spki", format: "pem" }).toString() }]);
    try {
      expect((await verifyOnline({ source: "bundle", bundleBase64: second.toString("base64") })).outcome).toBe("valid");
    } finally {
      delete process.env.REGULAIT_EXPORT_VERIFY_PUBLIC_KEYS;
    }
  });

  it("review item 2: crafted input is reported invalid online, never a 500 (deep JSON, two gzip members, garbage)", async () => {
    const deep = gzipSync(Buffer.from("[".repeat(200_000) + "]".repeat(200_000)));
    const twoMembers = Buffer.concat([gzipSync(Buffer.alloc(1024)), gzipSync(Buffer.alloc(512))]);
    for (const bytes of [deep, twoMembers, Buffer.from("not a bundle at all")]) {
      const out = await verifyOnline({ source: "bundle", bundleBase64: bytes.toString("base64") });
      expect(out.outcome).toBe("invalid");
    }
  });

  it("R6: verification needs no private key", async () => {
    setReceiptKey(false);
    const exportKey = process.env.REGULAIT_EXPORT_SIGNING_KEY;
    delete process.env.REGULAIT_EXPORT_SIGNING_KEY;
    try {
      expect((await verifyOnline({ source: "decision_bom", auditId })).outcome).toBe("valid");
      // and reading an already-frozen version needs no key either
      expect((await inject("GET", `/v1/decisions/${auditId}/bom?version=1`)).statusCode).toBe(200);
      const bundle = await inject("GET", `/v1/decisions/${auditId}/bom/bundle`);
      expect(bundle.json()).toMatchObject({ error: "bom_signing_unavailable", missingKey: "export" });
    } finally {
      setReceiptKey(true);
      process.env.REGULAIT_EXPORT_SIGNING_KEY = exportKey;
    }
  });

  it("X10: an email-shaped REGULAIT_INSTALL_ID refuses the bundle, naming manifest.json and the path", async () => {
    process.env.REGULAIT_INSTALL_ID = "ops@example.org";
    try {
      const res = await inject("GET", `/v1/decisions/${auditId}/bom/bundle`);
      expect(res.statusCode, res.body).toBe(422);
      expect(res.json()).toMatchObject({ error: "bom_export_refused", reason: "email_shape", file: "manifest.json", path: "$.installId" });
      expect(res.body).not.toContain("ops@example.org");
    } finally {
      delete process.env.REGULAIT_INSTALL_ID;
    }
  });

  it("R17: while the release switch is off, both snapshot downloads answer 501 bom_snapshots_not_released", async () => {
    snapshotIds.first = (await takeAiBomSnapshot(db, { subject: { kind: "install", id: AI_BOM_INSTALL_SUBJECT_ID }, trigger: "on_demand", actorUserId: null })).id;
    expect(AI_BOM_SNAPSHOTS_RELEASED).toBe(false);
    for (const url of [`/v1/ai-bom/snapshots/${snapshotIds.first}?format=native`, `/v1/ai-bom/snapshots/${snapshotIds.first}/bundle`]) {
      const res = await inject("GET", url);
      expect(res.statusCode, url).toBe(501);
      expect(res.json()).toMatchObject({ error: "bom_snapshots_not_released" });
    }
  });

  it("an AI BOM snapshot downloads in every rendered format, each a verified bundle; an unrendered format is refused", async () => {
    releaseAiBomDownloadsForTest(true);
    const [first] = await db.select().from(aiBomSnapshots).where(eq(aiBomSnapshots.id, snapshotIds.first!));
    const second = await takeAiBomSnapshot(db, { subject: { kind: "install", id: AI_BOM_INSTALL_SUBJECT_ID }, trigger: "on_demand", actorUserId: null });
    const trust = await offlineTrust();
    const rendered = Object.entries((JSON.parse(first!.body) as { renderings: Record<string, { status: string }> }).renderings).filter(([, r]) => r.status === "rendered").map(([f]) => f);
    expect(rendered).toContain("cyclonedx-1.7");
    for (const format of ["native", ...rendered.filter((f) => f !== "in-toto")]) {
      const { archive } = await bundleOf(`/v1/ai-bom/snapshots/${first!.id}?format=${format}`);
      const r = await verifyBomBundle(archive, trust);
      expect(r.outcome, `${format}: ${JSON.stringify(r.checks.filter((c) => c.status !== "valid"))}`).toBe("valid");
      expect((await verifyOnline({ source: "bundle", bundleBase64: archive.toString("base64") })).outcome).toBe("valid");
    }
    const all = await bundleOf(`/v1/ai-bom/snapshots/${second.id}/bundle`);
    const r2 = await verifyBomBundle(all.archive, trust);
    expect(r2.outcome).toBe("valid");
    expect(r2.checks.find((c) => c.check === "supersedes")).toMatchObject({ status: "unverifiable", reason: "earlier_snapshot_not_in_bundle" });
    expect(r2.checks.filter((c) => c.check === "rendering_hashes").map((c) => c.ref).sort()).toEqual(rendered.filter((f) => f !== "in-toto").sort());
    const missing = await inject("GET", `/v1/ai-bom/snapshots/${first!.id}?format=cyclonedx-1.6`);
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ error: "format_not_rendered_for_snapshot" });
    // the stored source checks supersedes against the subject's previous version
    const stored = await verifyOnline({ source: "ai_bom_snapshot", snapshotId: second.id });
    expect(stored.outcome).toBe("valid");
    expect(stored.checks.find((c) => c.check === "supersedes")).toMatchObject({ status: "valid" });
  });
});

describe("ADR-0189 B4: an anchored Decision BOM and its RFC 3161 token (#312 P08)", () => {
  let auditId: string;

  it("X14: an anchored decision freezes the emitted state, anchored, with the token in the signed proof", async () => {
    await setting("decision_bom_finality = 'anchored', default_audit_retention_days = 365, audit_anchor_timestamp_mode = 'required'");
    const d = await decision();
    auditId = d.id;
    await sweep();
    const [anchor] = await db
      .insert(auditAnchors)
      .values({ seq: d.seq!, rowHash: d.rowHash!, headAt: d.at, destination: "s3_object_lock", status: "flushed", flushedAt: new Date(), tamperResistant: true, tamperObservationMode: "compliance", tamperObservedAt: new Date(), retainUntil: new Date("2100-01-01T00:00:00.000Z") })
      .returning();
    const record = anchorRecordFromRow(anchor!);
    const sentAt = rows<{ now: Date }>(await db.execute(sql`select now() as "now"`))[0]!.now;
    const request = timestampRequest(record);
    const reply = tsa.issue(new Uint8Array(request.request.toSchema().toBER(false)));
    const checked = await verifyTimestampResponse(reply, { bytes: request.bytes, nonceHex: request.nonceHex, trust: parseTimestampTrustBundle(readFileSync(tsa.trustBundle, "utf8")), now: new Date(), sentAt: new Date(sentAt) });
    await db
      .update(auditAnchors)
      .set({ tsaStatus: "granted", tsaUrl: "https://tsa.invalid/", tsaToken: JSON.stringify({ format: "regulait.timestamp.v1", payloadVersion: record.payloadVersion, replyDer: checked.tokenBase64 }), tsaGenTime: checked.genTime, tsaSerial: checked.serial, tsaPolicyOid: checked.policyOid, tsaMessageImprint: checked.imprint, tsaNonce: request.nonceHex, tsaRequestSentAt: new Date(sentAt) })
      .where(eq(auditAnchors.id, anchor!.id));
    const res = await inject("GET", `/v1/decisions/${d.id}/bom`);
    expect(res.statusCode, res.body).toBe(200);
    const out = decisionBomReadResponseSchema.parse(res.json());
    expect(out.bom.finality).toBe("anchored");
    expect(out.document.proof.anchor).toMatchObject({ id: anchor!.id, tamperResistant: true, tsa: { messageImprint: checked.imprint, requestFactsLegacy: false } });
  });

  it("the token verifies valid under the TSA's trust bundle, timestamp_invalid under another, and unverifiable with none", async () => {
    process.env.REGULAIT_TSA_TRUST_BUNDLE = tsa.trustBundle;
    try {
      const good = await verifyOnline({ source: "decision_bom", auditId });
      expect(good.checks.find((c) => c.check === "tsa_token")).toMatchObject({ status: "valid" });
      expect(good.checks.find((c) => c.check === "anchor_imprint")).toMatchObject({ status: "valid" });
      expect(good.outcome).toBe("valid");
      process.env.REGULAIT_TSA_TRUST_BUNDLE = otherTsa.trustBundle;
      const wrong = await verifyOnline({ source: "decision_bom", auditId });
      expect(wrong.checks.find((c) => c.check === "tsa_token")).toMatchObject({ status: "invalid", reason: "timestamp_invalid" });
      expect(wrong.outcome).toBe("invalid");
    } finally {
      delete process.env.REGULAIT_TSA_TRUST_BUNDLE;
    }
    const none = await verifyOnline({ source: "decision_bom", auditId });
    expect(none.checks.find((c) => c.check === "tsa_token")).toMatchObject({ status: "unverifiable", reason: "no_tsa_trust_bundle" });
    expect(none.outcome).toBe("unverifiable");
  });
});

describe("ADR-0189 B4: who may read, export and verify (§7, §9)", () => {
  it("admins only by default: a member and an ungranted auditor are refused bom_export_forbidden", async () => {
    await setting("bom_export_roles = 'admins_only'");
    const [bom] = await db.select().from(decisionBoms).limit(1);
    const [snap] = await db.select({ id: aiBomSnapshots.id }).from(aiBomSnapshots).limit(1);
    for (const who of ["member", "auditor"] as const) {
      const res = await inject("POST", "/v1/boms/verify", users[who].auth, { source: "decision_bom", auditId: "00000000-0000-4000-8000-000000000000" });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ error: "bom_export_forbidden" });
      // review item 5: the bundle and both snapshot downloads, before anything is read (the release switch included)
      for (const url of [`/v1/decisions/${bom!.auditId}/bom/bundle`, `/v1/ai-bom/snapshots/${snap!.id}?format=native`, `/v1/ai-bom/snapshots/${snap!.id}/bundle`]) {
        const r = await inject("GET", url, users[who].auth);
        expect(r.statusCode, `${who} ${url}`).toBe(403);
        expect(r.json()).toMatchObject({ error: "bom_export_forbidden" });
      }
    }
  });
  it("an auditor grant counts only while bom_export_roles is relaxed, and never reaches the drift view (R8)", async () => {
    await db.execute(sql`insert into bom_auditor_grants (user_id, granted_by) values (${users.auditor.id}, ${users.member.id})`);
    expect((await inject("GET", "/v1/decisions/00000000-0000-4000-8000-000000000000/bom", users.auditor.auth)).json()).toMatchObject({ error: "bom_export_forbidden" });
    await setting("bom_export_roles = 'admins_and_auditors'");
    try {
      const [bom] = await db.select().from(decisionBoms).limit(1);
      const res = await inject("GET", `/v1/decisions/${bom!.auditId}/bom?version=1`, users.auditor.auth);
      expect(res.statusCode, res.body).toBe(200);
      expect(decisionBomReadResponseSchema.parse(res.json()).capabilities).toMatchObject({ access: "auditor_grant", canViewDrift: false });
      expect((await inject("GET", `/v1/decisions/${bom!.auditId}/bom`, users.member.auth)).statusCode).toBe(403);
      const drift = await inject("GET", `/v1/ai-bom/install/${AI_BOM_INSTALL_SUBJECT_ID}/drift`, users.auditor.auth);
      expect(drift.statusCode).toBe(403);
      // review item 5: the bundle and both snapshot downloads refuse a member with no grant, while the setting is
      // relaxed, and admit the auditor (the downloads opened for this test as in the release PR)
      const [snap] = await db.select({ id: aiBomSnapshots.id }).from(aiBomSnapshots).limit(1);
      releaseAiBomDownloadsForTest(true);
      try {
        const urls = [`/v1/decisions/${bom!.auditId}/bom/bundle?version=1`, `/v1/ai-bom/snapshots/${snap!.id}?format=native`, `/v1/ai-bom/snapshots/${snap!.id}/bundle`];
        for (const url of urls) {
          const refused = await inject("GET", url, users.member.auth);
          expect(refused.statusCode, url).toBe(403);
          expect(refused.json(), url).toMatchObject({ error: "bom_export_forbidden" });
          expect((await inject("GET", url, users.auditor.auth)).statusCode, url).toBe(200);
        }
      } finally {
        releaseAiBomDownloadsForTest(false);
      }
    } finally {
      await setting("bom_export_roles = 'admins_only'");
    }
  });
  it("every read, export and verify is audited", async () => {
    const audited = await db.select({ ruleId: auditLog.ruleId }).from(auditLog).where(eq(auditLog.objectType, "audit_export"));
    const ids = new Set(audited.map((a) => a.ruleId));
    for (const r of ["decision-bom-read", "decision-bom-exported", "ai-bom-exported", "bom-verified"]) expect(ids.has(r), r).toBe(true);
  });
});
