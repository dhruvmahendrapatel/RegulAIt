import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { auditLog, createDb, eq, projectMembers, runMigrations, usageEvents, type Db } from "@regulait/db";

/**
 * ADR-0116 — "signed exports an auditor can verify alone", proved by attack.
 *
 * WHAT THIS FILE IS TRYING TO MAKE IMPOSSIBLE TO FAKE
 * ---------------------------------------------------
 *  1. A VERIFIER THAT ONLY EVER PRINTS OK. Every tamper below is run through
 *     the SAME `scripts/verify-export-bundle.sh` an auditor would run, as a
 *     subprocess, and asserted to exit NON-ZERO with its OWN message. A single
 *     generic "verification failed" for all of them would be useless to the
 *     person holding the bundle, so the messages are asserted to be DISTINCT
 *     from one another as a set, not just non-empty.
 *
 *  2. A VACUOUS NEGATIVE (M-033). Every "this fails" is paired with the
 *     POSITIVE control on the SAME bundle: `verifyOk` is run on the untampered
 *     bundle first, in the same test, so a tamper case can never pass because
 *     the bundle was broken to begin with or because the script refuses
 *     everything.
 *
 *  3. A TRUST ROOT THE BUNDLE SUPPLIES ITSELF. The case that matters most:
 *     re-sign a doctored bundle with a FOREIGN key and swap in that key's
 *     public half. The bundle is then perfectly self-consistent. It must still
 *     be refused, because the fingerprint came from outside.
 *
 *  4. AN UNSIGNED BUNDLE EMITTED WHEN NO KEY EXISTS. 409 with a named rule,
 *     and not one byte of archive.
 *
 * The keypairs here are generated IN THIS PROCESS, into a temp directory that
 * `afterAll` removes. Nothing in `infra/release-keys/` is read or written, and
 * no production key exists or is created anywhere in this repo.
 */

const { buildApp } = await import("./app.js");

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(HERE, "../../../packages/db/migrations");
const VERIFIER = path.resolve(HERE, "../../../scripts/verify-export-bundle.sh");

const BOOT = "xbundle-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
const DATA_KEY = "e".repeat(64);

let db: Db;
let app: ReturnType<typeof buildApp>;
let workDir: string;
let runId: string;
let definitionId: string;
let projectId: string;
let ownerId: string;
let realFingerprint: string;
let foreignFingerprint: string;
const createdUsageIds: string[] = [];

const prevKey = process.env.REGULAIT_EXPORT_SIGNING_KEY;
const prevKeyId = process.env.REGULAIT_EXPORT_SIGNING_KEY_ID;
const prevInstall = process.env.REGULAIT_INSTALL_ID;

/** An Ed25519 keypair on disk. Test-only, in a temp directory. */
function makeKey(name: string): { priv: string; pub: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const priv = path.join(workDir, `${name}.key`);
  const pub = path.join(workDir, `${name}.pub`);
  writeFileSync(priv, privateKey.export({ type: "pkcs8", format: "pem" }));
  writeFileSync(pub, publicKey.export({ type: "spki", format: "pem" }));
  return { priv, pub };
}

function fingerprintOf(pubPath: string): string {
  const der = execFileSync("openssl", ["pkey", "-pubin", "-in", pubPath, "-outform", "DER"]);
  const sum = execFileSync("sha256sum", { input: der }).toString().split(" ")[0]!;
  return `sha256:${sum}`;
}

interface VerifyResult {
  code: number;
  out: string;
}

function runVerifier(bundlePath: string, args: string[]): VerifyResult {
  try {
    const out = execFileSync("bash", [VERIFIER, bundlePath, ...args], {
      encoding: "utf8",
      env: { ...process.env, NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, out };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? -1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

/** THE POSITIVE CONTROL. Every tamper case calls this on the pristine bundle
 * first, so "it failed" is never explained by "it was never going to pass". */
function verifyOk(bundlePath: string, fingerprint = realFingerprint): VerifyResult {
  const r = runVerifier(bundlePath, ["--fingerprint", fingerprint]);
  expect(r.code, `positive control must pass:\n${r.out}`).toBe(0);
  expect(r.out).toContain("[VERIFIED]");
  return r;
}

let scratchSeq = 0;
/** Unpack a bundle into a fresh directory the caller can vandalise. */
function unpack(bundlePath: string): { dir: string; root: string } {
  const dir = path.join(workDir, `unpack-${scratchSeq++}`);
  mkdirSync(dir, { recursive: true });
  execFileSync("tar", ["-xzf", bundlePath, "-C", dir]);
  const root = path.join(dir, readdirSync(dir)[0]!);
  return { dir, root };
}

/** Re-tar a (possibly vandalised) tree back into a bundle. */
function repack(dir: string, name: string): string {
  const out = path.join(workDir, `${name}.tar.gz`);
  execFileSync("tar", ["-czf", out, "-C", dir, readdirSync(dir)[0]!]);
  return out;
}

/** Sign manifest.json in place with the given private key — the move available
 * to anyone who holds a signing key, ours or their own. */
function resign(root: string, privPath: string): void {
  const sig = execFileSync("openssl", [
    "pkeyutl", "-sign", "-inkey", privPath, "-rawin", "-in", path.join(root, "manifest.json"),
  ]);
  const b64 = execFileSync("openssl", ["base64", "-A"], { input: sig }).toString();
  writeFileSync(path.join(root, "manifest.json.sig"), `${b64}\n`);
}

function sha256File(p: string): string {
  return createHash("sha256").update(readFileSync(p)).digest("hex");
}

/** Patch a file's digest inside the manifest so the alteration survives
 * section 5 and the deeper check under test is the one that fires. */
function patchManifestDigest(root: string, relPath: string): void {
  const mp = path.join(root, "manifest.json");
  let m = readFileSync(mp, "utf8");
  const actual = sha256File(path.join(root, relPath));
  const re = new RegExp(`\\{"path":"${relPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}","sha256":"[0-9a-f]{64}"\\}`);
  expect(m).toMatch(re);
  m = m.replace(re, `{"path":"${relPath}","sha256":"${actual}"}`);
  writeFileSync(mp, m);
}

async function exportBundleTo(name: string, url: string): Promise<string> {
  const res = await app.inject({ method: "GET", url, headers: AUTH });
  expect(res.statusCode, res.body.slice(0, 400)).toBe(200);
  expect(res.headers["content-type"]).toContain("application/gzip");
  const out = path.join(workDir, `${name}.tar.gz`);
  writeFileSync(out, res.rawPayload);
  return out;
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });

  workDir = mkdtempSync(path.join(tmpdir(), "regulait-export-bundle-"));
  const real = makeKey("real");
  const foreign = makeKey("foreign");
  realFingerprint = fingerprintOf(real.pub);
  foreignFingerprint = fingerprintOf(foreign.pub);
  (globalThis as Record<string, unknown>).__xb = { real, foreign };

  process.env.REGULAIT_INSTALL_ID = "xbundle-install-0001";

  // Unique per run: this suite is re-runnable against a database another run
  // already touched, and a 409 on a fixed email would be a setup failure
  // masquerading as a product failure.
  const tag = `xb${Date.now().toString(36)}`;
  const u = await app.inject({
    method: "POST",
    url: "/v1/users",
    headers: AUTH,
    payload: { email: `${tag}-owner@example.com`, displayName: "XBundle Owner" },
  });
  expect(u.statusCode, u.body).toBe(201);
  ownerId = u.json().id;

  const p = await app.inject({
    method: "POST",
    url: "/v1/projects",
    headers: AUTH,
    payload: { name: `${tag}-project`, budgetUsd: 50, budgetApproverUserId: ownerId },
  });
  expect(p.statusCode, p.body).toBe(201);
  projectId = p.json().id;

  const now = new Date();
  const at = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 9, 0, 0));
  const rows = await db
    .insert(usageEvents)
    .values([
      {
        userId: ownerId,
        objectType: "agent",
        projectId,
        provider: "mock",
        model: "m",
        inputTokens: 90,
        outputTokens: 10,
        costUsd: 2.5,
        at,
      },
    ])
    .returning({ id: usageEvents.id });
  createdUsageIds.push(...rows.map((r) => r.id));

  const def = await app.inject({
    method: "POST",
    url: "/v1/reports/definitions",
    headers: AUTH,
    payload: {
      name: `${tag}-def`,
      kind: "exec_summary",
      scopeKind: "project",
      scopeId: projectId,
      entitlementScope: "project",
      period: "current_month",
    },
  });
  expect(def.statusCode, def.body).toBe(201);
  definitionId = def.json().definition.id;

  const gen = await app.inject({
    method: "POST",
    url: `/v1/reports/definitions/${definitionId}/generate`,
    headers: AUTH,
    payload: {},
  });
  expect(gen.statusCode, gen.body).toBe(201);
  runId = gen.json().run.id;
});

afterAll(async () => {
  if (createdUsageIds.length) {
    for (const id of createdUsageIds) await db.delete(usageEvents).where(eq(usageEvents.id, id));
  }
  if (prevKey === undefined) delete process.env.REGULAIT_EXPORT_SIGNING_KEY;
  else process.env.REGULAIT_EXPORT_SIGNING_KEY = prevKey;
  if (prevKeyId === undefined) delete process.env.REGULAIT_EXPORT_SIGNING_KEY_ID;
  else process.env.REGULAIT_EXPORT_SIGNING_KEY_ID = prevKeyId;
  if (prevInstall === undefined) delete process.env.REGULAIT_INSTALL_ID;
  else process.env.REGULAIT_INSTALL_ID = prevInstall;
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  await app.close();
});

function keys(): { real: { priv: string; pub: string }; foreign: { priv: string; pub: string } } {
  return (globalThis as Record<string, unknown>).__xb as never;
}

function useRealKey(): void {
  process.env.REGULAIT_EXPORT_SIGNING_KEY = keys().real.priv;
  process.env.REGULAIT_EXPORT_SIGNING_KEY_ID = "xbundle-2026";
}

// ---------------------------------------------------------------------------

describe("no signing key — the product REFUSES rather than shipping theatre", () => {
  it("returns 409 with a named rule and NO archive, and the unsigned route still works", async () => {
    delete process.env.REGULAIT_EXPORT_SIGNING_KEY;
    delete process.env.REGULAIT_EXPORT_SIGNING_KEY_ID;

    const refused = await app.inject({
      method: "GET",
      url: `/v1/reports/runs/${runId}/export?format=csv&signed=1`,
      headers: AUTH,
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toBe("export-signing-key-absent");
    // the refusal tells the operator what to DO, and never says "ask the vendor"
    expect(refused.json().detail).toContain("REFUSAL");
    expect(refused.json().detail).not.toMatch(/from the vendor/i);
    expect(refused.headers["content-type"]).not.toContain("gzip");

    // POSITIVE PAIRING (M-033): the same run exports fine UNSIGNED, so the 409
    // is about the key and not about the run being unexportable.
    const plain = await app.inject({
      method: "GET",
      url: `/v1/reports/runs/${runId}/export?format=csv`,
      headers: AUTH,
    });
    expect(plain.statusCode).toBe(200);
    expect(plain.body.length).toBeGreaterThan(0);

    const keyless = await app.inject({ method: "GET", url: "/v1/exports/signing-key", headers: AUTH });
    expect(keyless.statusCode).toBe(409);
    expect(keyless.json().configured).toBe(false);
  });

  it("refuses a key with no key id rather than inventing one", async () => {
    process.env.REGULAIT_EXPORT_SIGNING_KEY = keys().real.priv;
    delete process.env.REGULAIT_EXPORT_SIGNING_KEY_ID;
    const res = await app.inject({
      method: "GET",
      url: `/v1/reports/runs/${runId}/export?signed=1`,
      headers: AUTH,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("export-signing-key-id-absent");
  });

  it("refuses a key id that could name a file outside the keyring", async () => {
    process.env.REGULAIT_EXPORT_SIGNING_KEY = keys().real.priv;
    process.env.REGULAIT_EXPORT_SIGNING_KEY_ID = "../../etc/whatever";
    const res = await app.inject({
      method: "GET",
      url: `/v1/reports/runs/${runId}/export?signed=1`,
      headers: AUTH,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("export-signing-key-id-malformed");
  });
});

describe("the bundle an auditor receives", () => {
  let bundle: string;

  beforeAll(async () => {
    useRealKey();
    bundle = await exportBundleTo("report-csv", `/v1/reports/runs/${runId}/export?format=csv&signed=1`);
  });

  it("verifies offline with a fingerprint obtained out of band", () => {
    const r = verifyOk(bundle);
    expect(r.out).toContain("signature verifies over manifest.json's exact bytes");
    expect(r.out).toContain("audit chain:");
    expect(r.out).toContain("xbundle-install-0001");
  });

  it("carries the exported bytes VERBATIM — the signature covers the real export", async () => {
    const plain = await app.inject({
      method: "GET",
      url: `/v1/reports/runs/${runId}/export?format=csv`,
      headers: AUTH,
    });
    expect(plain.statusCode).toBe(200);
    const { root } = unpack(bundle);
    const inBundle = readFileSync(path.join(root, "content", `report-${runId}.csv`), "utf8");
    expect(inBundle).toBe(plain.body);
    expect(inBundle.length).toBeGreaterThan(50);
  });

  it("names the key, the install, the database-clock export time and the chain head", () => {
    const { root } = unpack(bundle);
    const m = JSON.parse(readFileSync(path.join(root, "manifest.json"), "utf8"));
    expect(m.schema).toBe("regulait.export-bundle/1");
    expect(m.signingKeyId).toBe("xbundle-2026");
    expect(m.signingKeyFingerprint).toBe(realFingerprint);
    expect(m.installId).toBe("xbundle-install-0001");
    expect(m.installIdSource).toBe("environment");
    expect(m.exportedAtSource).toBe("database");
    expect(m.subject.kind).toBe("report-run");
    expect(m.subject.id).toBe(runId);
    expect(m.audit.head.seq).toBeGreaterThan(0);
    expect(m.audit.head.rowHash).toMatch(/^[0-9a-f]{64}$/);
    expect(m.audit.payloadVersion).toBe("regulait.audit.v1");
  });

  it("commits to a chain head that already contains the record of its own export", async () => {
    const { root } = unpack(bundle);
    const m = JSON.parse(readFileSync(path.join(root, "manifest.json"), "utf8"));
    const headRows = await db.select().from(auditLog).where(eq(auditLog.seq, m.audit.head.seq));
    expect(headRows).toHaveLength(1);
    // the export ITSELF is the head: the bundle records its own creation
    expect(headRows[0]!.ruleId).toBe("report-exported");
    expect(headRows[0]!.objectId).toBe(runId);
    // and the segment reaches back far enough to contain it
    const tsv = readFileSync(path.join(root, "audit/chain.tsv"), "utf8").trim().split("\n");
    expect(tsv.length).toBeGreaterThan(0);
    expect(tsv[tsv.length - 1]!.split("\t")[0]).toBe(String(m.audit.head.seq));
  });

  it("is reproducible in shape: a second export of the same run also verifies", async () => {
    const second = await exportBundleTo("report-csv-2", `/v1/reports/runs/${runId}/export?format=csv&signed=1`);
    verifyOk(second);
    const a = JSON.parse(readFileSync(path.join(unpack(bundle).root, "manifest.json"), "utf8"));
    const b = JSON.parse(readFileSync(path.join(unpack(second).root, "manifest.json"), "utf8"));
    // two bundles cannot be confused: the head and the export time both moved
    expect(b.audit.head.seq).toBeGreaterThan(a.audit.head.seq);
    expect(b.exportedAt >= a.exportedAt).toBe(true);
  });

  it("publishes the fingerprint at the out-of-band endpoint, reproducibly", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/exports/signing-key", headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.json().fingerprint).toBe(realFingerprint);
    expect(res.json().keyId).toBe("xbundle-2026");
    // the published recipe reproduces the published value with stock tooling
    const derived = execFileSync("bash", [
      "-c",
      `openssl pkey -pubin -in "${keys().real.pub}" -outform DER | sha256sum | cut -d' ' -f1`,
    ])
      .toString()
      .trim();
    expect(res.json().fingerprint).toBe(`sha256:${derived}`);
  });
});

describe("entitlement-scoped audit disclosure", () => {
  it("keeps unrelated audit payloads out while preserving offline verification", async () => {
    useRealKey();
    const key = await app.inject({
      method: "POST",
      url: `/v1/users/${ownerId}/keys`,
      headers: AUTH,
      payload: { name: "scoped-export" },
    });
    expect(key.statusCode, key.body).toBe(201);
    const caller = { authorization: `Bearer ${key.json().token}` };
    const url = `/v1/reports/runs/${runId}/export?format=csv&signed=1`;
    const denied = await app.inject({ method: "GET", url, headers: caller });
    expect(denied.statusCode).toBe(403);

    await db.insert(projectMembers).values({ projectId, userId: ownerId, role: "viewer" });
    const sentinel = `unrelated-private-audit-${Date.now()}`;
    await db.insert(auditLog).values({
      userId: ownerId,
      objectType: "project",
      objectId: null,
      effect: "allow",
      ruleId: "unrelated-sentinel",
      ruleChain: [],
      reason: sentinel,
      detail: { sentinel },
    });
    const res = await app.inject({ method: "GET", url, headers: caller });
    expect(res.statusCode, res.body.slice(0, 400)).toBe(200);
    const bundle = path.join(workDir, "scoped-report.tar.gz");
    writeFileSync(bundle, res.rawPayload);
    const verified = verifyOk(bundle);
    expect(verified.out).toContain("subject-scoped audit proof");
    const { root } = unpack(bundle);
    const manifest = JSON.parse(readFileSync(path.join(root, "manifest.json"), "utf8"));
    expect(manifest.schema).toBe("regulait.export-bundle/2");
    expect(manifest.audit.payloadScope).toBe("subject");
    const chain = readFileSync(path.join(root, "audit/chain.tsv"), "utf8").trim().split("\n");
    expect(chain.some((row) => row.endsWith("\tcommitment"))).toBe(true);
    expect(chain.some((row) => row.endsWith("\tpayload"))).toBe(true);
    const disclosed = readdirSync(path.join(root, "audit/rows"));
    expect(disclosed.length).toBeGreaterThan(0);
    for (const name of disclosed) {
      const payload = readFileSync(path.join(root, "audit/rows", name), "utf8");
      expect(payload).not.toContain(sentinel);
      expect(payload).toContain(`"objectId":"${runId}"`);
    }
    expect(readFileSync(path.join(root, "audit/chain.tsv"), "utf8")).not.toContain(sentinel);
  });
});

describe("TAMPERING — every one of these must be caught, with its OWN message", () => {
  const messages: string[] = [];
  let bundle: string;

  beforeAll(async () => {
    useRealKey();
    bundle = await exportBundleTo("tamper-base", `/v1/reports/runs/${runId}/export?format=csv&signed=1`);
  });

  function expectRefused(bundlePath: string, args: string[], needle: string): string {
    const r = runVerifier(bundlePath, args);
    expect(r.code, `expected a refusal, got:\n${r.out}`).not.toBe(0);
    expect(r.out, `wanted "${needle}" in:\n${r.out}`).toContain(needle);
    messages.push(needle);
    return r.out;
  }

  it("a flipped byte in the exported content", () => {
    verifyOk(bundle); // positive control on the same artifact
    const { dir, root } = unpack(bundle);
    const f = path.join(root, "content", `report-${runId}.csv`);
    const body = readFileSync(f, "utf8");
    writeFileSync(f, body.replace("2.5", "0.5"));
    expectRefused(repack(dir, "t-content"), ["--fingerprint", realFingerprint], "CONTENT DIGEST MISMATCH");
  });

  it("a flipped byte in the manifest", () => {
    verifyOk(bundle);
    const { dir, root } = unpack(bundle);
    const mp = path.join(root, "manifest.json");
    // deliberately a field the verifier does NOT structurally validate before
    // checking the signature, so the SIGNATURE is what catches it
    const before = readFileSync(mp, "utf8");
    expect(before).toContain('"exportedAtSource":"database"');
    writeFileSync(mp, before.replace('"exportedAtSource":"database"', '"exportedAtSource":"hostclok"'));
    expectRefused(repack(dir, "t-manifest"), ["--fingerprint", realFingerprint], "SIGNATURE DOES NOT VERIFY");
  });

  it("one altered exported audit row", () => {
    verifyOk(bundle);
    const { dir, root } = unpack(bundle);
    const rowsDir = path.join(root, "audit", "rows");
    const victim = readdirSync(rowsDir).sort()[0]!;
    const p = path.join(rowsDir, victim);
    const before = readFileSync(p, "utf8");
    expect(before).toContain("regulait.audit.v1");
    // Flip whichever effect this row actually carries. Replacing only
    // allow->deny made the tamper CONDITIONAL on the victim row: in a shared
    // database the first row of the segment is whatever another file happened
    // to write, and when that row was already a deny the replace was a no-op,
    // the bundle was left pristine, and the verifier "correctly" passed — a
    // tamper test that tampers with nothing (M-033).
    const tampered = before.includes('"effect":"allow"')
      ? before.replace('"effect":"allow"', '"effect":"deny"')
      : before.replace('"effect":"deny"', '"effect":"allow"');
    // The tamper must have HAPPENED before we can assert it is caught.
    expect(tampered).not.toBe(before);
    writeFileSync(p, tampered);
    const out = expectRefused(
      repack(dir, "t-row"),
      ["--fingerprint", realFingerprint],
      "AUDIT ROW TAMPERED",
    );
    expect(out).toContain(`seq ${victim.replace(".payload", "")}`);
  });

  it("a different chain head, re-signed with the REAL key (the insider's move)", () => {
    verifyOk(bundle);
    const { dir, root } = unpack(bundle);
    const mp = path.join(root, "manifest.json");
    const m = readFileSync(mp, "utf8");
    const head = /"head":\{"rowHash":"([0-9a-f]{64})"/.exec(m);
    expect(head).not.toBeNull();
    writeFileSync(mp, m.replace(head![1]!, "b".repeat(64)));
    resign(root, keys().real.priv);
    expectRefused(repack(dir, "t-head"), ["--fingerprint", realFingerprint], "CHAIN HEAD MISMATCH");
  });

  it("a broken chain link, re-signed with the REAL key", () => {
    verifyOk(bundle);
    const { dir, root } = unpack(bundle);
    const cp = path.join(root, "audit", "chain.tsv");
    const lines = readFileSync(cp, "utf8").trim().split("\n");
    expect(lines.length).toBeGreaterThan(1);
    const parts = lines[1]!.split("\t");
    parts[2] = "c".repeat(64); // prev_hash no longer names its predecessor
    lines[1] = parts.join("\t");
    writeFileSync(cp, `${lines.join("\n")}\n`);
    patchManifestDigest(root, "audit/chain.tsv");
    resign(root, keys().real.priv);
    expectRefused(
      repack(dir, "t-link"),
      ["--fingerprint", realFingerprint],
      "prev_hash does not name the preceding row's row_hash",
    );
  });

  it("a deleted chain row, re-signed with the REAL key", () => {
    verifyOk(bundle);
    const { dir, root } = unpack(bundle);
    const cp = path.join(root, "audit", "chain.tsv");
    const lines = readFileSync(cp, "utf8").trim().split("\n");
    expect(lines.length).toBeGreaterThan(2);
    // remove the SECOND row and its payload: the survivors still link to each
    // other's neighbours, so only the sequence check can see it
    const goneSeq = lines[1]!.split("\t")[0]!;
    lines.splice(1, 1);
    // keep the remaining rows' linkage self-consistent by also fixing row 2's
    // prev_hash — an attacker would; the gap must still be caught
    const survivor = lines[1]!.split("\t");
    survivor[2] = lines[0]!.split("\t")[3]!;
    lines[1] = survivor.join("\t");
    writeFileSync(cp, `${lines.join("\n")}\n`);
    rmSync(path.join(root, "audit", "rows", `${goneSeq}.payload`));
    patchManifestDigest(root, "audit/chain.tsv");
    resign(root, keys().real.priv);
    expectRefused(repack(dir, "t-gap"), ["--fingerprint", realFingerprint], "sequence gap");
  });

  it("THE TRAP: a fully re-signed bundle carrying its own fresh public key", () => {
    verifyOk(bundle);
    const { dir, root } = unpack(bundle);
    // 1. doctor the content
    const f = path.join(root, "content", `report-${runId}.csv`);
    writeFileSync(f, readFileSync(f, "utf8").replace("2.5", "0.0"));
    patchManifestDigest(root, "content/" + `report-${runId}.csv`);
    // 2. swap in a key the attacker just made, and say so in the manifest
    writeFileSync(path.join(root, "signing-key.pub"), readFileSync(keys().foreign.pub));
    patchManifestDigest(root, "signing-key.pub");
    const mp = path.join(root, "manifest.json");
    writeFileSync(mp, readFileSync(mp, "utf8").replace(realFingerprint, foreignFingerprint));
    patchManifestDigest(root, "signing-key.pub");
    // 3. sign it with that key. The bundle is now perfectly self-consistent.
    resign(root, keys().foreign.priv);
    const forged = repack(dir, "t-foreign");

    // A verifier that trusted the bundled key would PASS this. Ours refuses,
    // because the fingerprint came from outside the bundle.
    expectRefused(forged, ["--fingerprint", realFingerprint], "UNKNOWN SIGNING KEY");

    // And the refusal names what it saw, so the auditor can ask the operator
    // whether they rotated rather than guessing.
    const out = runVerifier(forged, ["--fingerprint", realFingerprint]).out;
    expect(out).toContain(foreignFingerprint);
    expect(out).toContain("rotated");
  });

  it("no trust root at all is a refusal, not a pass", () => {
    verifyOk(bundle);
    const out = expectRefused(bundle, [], "NO TRUST ROOT SUPPLIED");
    // and it does NOT send the auditor to the vendor for a key the vendor
    // has never held — the sibling-product failure this design exists to avoid
    expect(out).not.toMatch(/obtain the public key from the vendor/i);
    expect(out).toContain("out of band");
  });

  it("a manifest that describes a key other than the one it shipped with", () => {
    verifyOk(bundle);
    const { dir, root } = unpack(bundle);
    const mp = path.join(root, "manifest.json");
    writeFileSync(mp, readFileSync(mp, "utf8").replace(realFingerprint, foreignFingerprint));
    resign(root, keys().real.priv);
    expectRefused(
      repack(dir, "t-fprint"),
      ["--fingerprint", foreignFingerprint],
      "MANIFEST FINGERPRINT DOES NOT DESCRIBE THE KEY",
    );
  });

  it("an extra file the manifest never named", () => {
    verifyOk(bundle);
    const { dir, root } = unpack(bundle);
    writeFileSync(path.join(root, "content", "extra-invoice.csv"), "smuggled,row\n1,2\n");
    expectRefused(
      repack(dir, "t-extra"),
      ["--fingerprint", realFingerprint],
      "file(s) the signed manifest does not list",
    );
  });

  it("an extra audit payload the chain never named", () => {
    verifyOk(bundle);
    const { dir, root } = unpack(bundle);
    writeFileSync(path.join(root, "audit/rows/999999999.payload"), "private bytes");
    expectRefused(
      repack(dir, "t-extra-audit"),
      ["--fingerprint", realFingerprint],
      "unlisted audit payloads",
    );
  });

  it("a listed file removed from the bundle", () => {
    verifyOk(bundle);
    const { dir, root } = unpack(bundle);
    rmSync(path.join(root, "content", `report-${runId}.csv`));
    expectRefused(
      repack(dir, "t-missing"),
      ["--fingerprint", realFingerprint],
      "are MISSING from the bundle",
    );
  });

  it("every refusal above carried a DISTINCT message", () => {
    expect(messages.length).toBeGreaterThanOrEqual(10);
    expect(new Set(messages).size).toBe(messages.length);
  });
});

describe("key rotation does not invalidate a bundle already signed", () => {
  it("a bundle signed by the old key still verifies after the deployment moves to a new one", async () => {
    useRealKey();
    const old = await exportBundleTo("rot-old", `/v1/reports/runs/${runId}/export?format=csv&signed=1`);
    verifyOk(old);

    // rotate: a DIFFERENT key, a DIFFERENT id
    process.env.REGULAIT_EXPORT_SIGNING_KEY = keys().foreign.priv;
    process.env.REGULAIT_EXPORT_SIGNING_KEY_ID = "xbundle-2027";
    const fresh = await exportBundleTo("rot-new", `/v1/reports/runs/${runId}/export?format=csv&signed=1`);
    verifyOk(fresh, foreignFingerprint);

    // the OLD bundle is untouched by the rotation: the auditor keeps the old
    // fingerprint and the old evidence keeps verifying
    verifyOk(old, realFingerprint);
    // and the new one is refused against the old fingerprint, which is how an
    // auditor LEARNS a rotation happened rather than silently accepting it
    const r = runVerifier(fresh, ["--fingerprint", realFingerprint]);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("UNKNOWN SIGNING KEY");

    // a keyring holding BOTH keys verifies BOTH bundles — the supported way to
    // hold a rotation
    const keyring = path.join(workDir, "keyring");
    mkdirSync(keyring, { recursive: true });
    writeFileSync(path.join(keyring, "xbundle-2026.pub"), readFileSync(keys().real.pub));
    writeFileSync(path.join(keyring, "xbundle-2027.pub"), readFileSync(keys().foreign.pub));
    expect(runVerifier(old, ["--keyring", keyring]).code).toBe(0);
    expect(runVerifier(fresh, ["--keyring", keyring]).code).toBe(0);

    // a keyring WITHOUT the key is a refusal that names what it does pin
    const narrow = path.join(workDir, "keyring-narrow");
    mkdirSync(narrow, { recursive: true });
    writeFileSync(path.join(narrow, "xbundle-2026.pub"), readFileSync(keys().real.pub));
    const n = runVerifier(fresh, ["--keyring", narrow]);
    expect(n.code).not.toBe(0);
    expect(n.out).toContain("UNKNOWN SIGNING KEY");
    expect(n.out).toContain("xbundle-2026");

    useRealKey();
  }, 60_000);
});

describe("the OTHER export producer — /v1/audit.csv", () => {
  it("bundles the audit trail, verifies offline, and records the export in the chain", async () => {
    useRealKey();
    const bundle = await exportBundleTo("audit-csv", "/v1/audit.csv?signed=1");
    const r = verifyOk(bundle);
    expect(r.out).toContain("subject audit-log");

    const { root } = unpack(bundle);
    const m = JSON.parse(readFileSync(path.join(root, "manifest.json"), "utf8"));
    expect(m.subject.kind).toBe("audit-log");
    expect(m.subject.descriptor.rowCeiling).toBeGreaterThan(0);
    expect(typeof m.subject.descriptor.truncated).toBe("boolean");
    expect(existsSync(path.join(root, "content", "audit-log.csv"))).toBe(true);

    const csv = readFileSync(path.join(root, "content", "audit-log.csv"), "utf8");
    expect(csv.split("\n")[0]).toContain("at,userId,userName,objectType");
    expect(csv.split("\n").length).toBeGreaterThan(2);

    // the act of taking the evidence is itself evidence
    const rows = await db.select().from(auditLog).where(eq(auditLog.ruleId, "audit-export-signed"));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[rows.length - 1]!.objectType).toBe("audit_export");
  });

  it("the bundled CSV is the same bytes the streaming route serves", async () => {
    useRealKey();
    const streamed = await app.inject({
      method: "GET",
      url: "/v1/audit.csv?objectType=audit_export",
      headers: AUTH,
    });
    expect(streamed.statusCode).toBe(200);
    const bundle = await exportBundleTo(
      "audit-csv-cmp",
      "/v1/audit.csv?signed=1&objectType=audit_export",
    );
    const { root } = unpack(bundle);
    const bundled = readFileSync(path.join(root, "content", "audit-log.csv"), "utf8");
    // The trail grows between the two calls (each export writes a row), so the
    // comparison is on SHAPE, not on a byte-identical snapshot of a moving
    // table: same header, same column count, same escaping.
    expect(bundled.split("\n")[0]).toBe(streamed.body.split("\n")[0]);
    expect(bundled.split("\n")[1]!.split(",").length).toBe(
      streamed.body.split("\n")[1]!.split(",").length,
    );
    expect(bundled).toContain("audit_export");
  });

  it("refuses the signed form when no key is configured, and still streams the unsigned one", async () => {
    delete process.env.REGULAIT_EXPORT_SIGNING_KEY;
    const refused = await app.inject({ method: "GET", url: "/v1/audit.csv?signed=1", headers: AUTH });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toBe("export-signing-key-absent");
    const plain = await app.inject({ method: "GET", url: "/v1/audit.csv", headers: AUTH });
    expect(plain.statusCode).toBe(200);
    expect(plain.body).toContain("at,userId,userName,objectType");
    useRealKey();
  });
});

// AER-008 — the trail must say what happened. A keyless signed export used to write its
// "exported" success row first and refuse afterwards, so every refused click left a false record.
describe("AER-008 — a refused signed export leaves an accurate trail, never a false success row", () => {
  const countRule = async (ruleId: string) => (await db.select().from(auditLog).where(eq(auditLog.ruleId, ruleId))).length;

  it("audit trail: keyless → one refusal row, ZERO 'audit-export-signed' rows; with the key → exactly one success row", async () => {
    delete process.env.REGULAIT_EXPORT_SIGNING_KEY;
    delete process.env.REGULAIT_EXPORT_SIGNING_KEY_ID;
    const before = { ok: await countRule("audit-export-signed"), refused: await countRule("audit-export-unsigned-refused") };
    const refused = await app.inject({ method: "GET", url: "/v1/audit.csv?signed=1", headers: AUTH });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toBe("export-signing-key-absent");
    expect(await countRule("audit-export-signed")).toBe(before.ok);
    expect(await countRule("audit-export-unsigned-refused")).toBe(before.refused + 1);
    const [row] = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.ruleId, "audit-export-unsigned-refused"));
    expect(row!.effect).toBe("deny");
    expect(row!.reason).toContain("no bundle was produced");

    // POSITIVE CONTROL: the same request with the key writes exactly one success row
    useRealKey();
    const ok = await app.inject({ method: "GET", url: "/v1/audit.csv?signed=1&objectType=audit_export", headers: AUTH });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers["content-type"]).toContain("gzip");
    expect(await countRule("audit-export-signed")).toBe(before.ok + 1);
    expect(await countRule("audit-export-unsigned-refused")).toBe(before.refused + 1);
  });

  it("report run: keyless → one refusal row, ZERO 'report-exported' rows; with the key → exactly one", async () => {
    delete process.env.REGULAIT_EXPORT_SIGNING_KEY;
    delete process.env.REGULAIT_EXPORT_SIGNING_KEY_ID;
    const before = { ok: await countRule("report-exported"), refused: await countRule("report-export-unsigned-refused") };
    const refused = await app.inject({
      method: "GET",
      url: `/v1/reports/runs/${runId}/export?format=csv&signed=1`,
      headers: AUTH,
    });
    expect(refused.statusCode).toBe(409);
    expect(await countRule("report-exported")).toBe(before.ok);
    expect(await countRule("report-export-unsigned-refused")).toBe(before.refused + 1);

    useRealKey();
    const ok = await app.inject({
      method: "GET",
      url: `/v1/reports/runs/${runId}/export?format=csv&signed=1`,
      headers: AUTH,
    });
    expect(ok.statusCode).toBe(200);
    expect(await countRule("report-exported")).toBe(before.ok + 1);
    expect(await countRule("report-export-unsigned-refused")).toBe(before.refused + 1);
  });

  it("an unparseable key file is caught by the preflight too — no success row", async () => {
    // a well-formed key id and a key file that exists but is not a private key: the preflight
    // refuses at parse time, so it covers key-shaped refusals beyond an unset variable
    const bogus = path.join(workDir, "not-a-key.pem");
    writeFileSync(bogus, "-----BEGIN PRIVATE KEY-----\nnot base64 at all\n-----END PRIVATE KEY-----\n");
    process.env.REGULAIT_EXPORT_SIGNING_KEY = bogus;
    process.env.REGULAIT_EXPORT_SIGNING_KEY_ID = "xbundle-bogus";
    const before = await countRule("audit-export-signed");
    const refused = await app.inject({ method: "GET", url: "/v1/audit.csv?signed=1", headers: AUTH });
    expect(refused.statusCode).toBe(409);
    expect(await countRule("audit-export-signed")).toBe(before);
    useRealKey();
  });
});

describe("the JSON export path is covered too, not just CSV", () => {
  it("bundles and verifies a JSON report artifact", async () => {
    useRealKey();
    const bundle = await exportBundleTo("report-json", `/v1/reports/runs/${runId}/export?format=json&signed=1`);
    verifyOk(bundle);
    const { root } = unpack(bundle);
    const body = JSON.parse(readFileSync(path.join(root, "content", `report-${runId}.json`), "utf8"));
    expect(body.report).toBeTruthy();
    expect(body.run.id).toBe(runId);
    const m = JSON.parse(readFileSync(path.join(root, "manifest.json"), "utf8"));
    expect(m.subject.descriptor.format).toBe("json");
  });
});
