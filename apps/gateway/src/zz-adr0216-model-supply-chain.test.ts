/**
 * ADR-0216 (P14 + P15) — model-file signatures and the supply-chain block, against the real gateway on a real
 * database:
 *
 *   - a signature in the OpenSSF model-signing format verifies against an admin's key, and fails when tampered,
 *     signed by an unknown or revoked key, or not covering the file (unit, no database);
 *   - adding a trust root needs a step-up and is audited; a signature presented at upload or later is recorded and
 *     audited, pass or fail;
 *   - THE BLOCK HOLDS: a card citing an unsigned, unscanned or unsafe-format file refuses dispatch and sign-off
 *     (409 `model_supply_chain_blocked`, audited), and opens ONE supply-chain risk entry with an owner;
 *   - a signed, scanned safetensors file passes; revoking its key blocks it again at once;
 *   - an admin's relaxation needs a step-up and a reason, is audited, lets the model through, and stops applying
 *     when it expires; clearing it is audited.
 *
 * Every assertion over shared tables is scoped to this file's own rows (the suite shares one database).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  agents,
  aiRisks,
  artifactScans,
  auditLog,
  createDb,
  eq,
  modelArtifactSignatures,
  modelArtifacts,
  modelCardEvidence,
  modelCards,
  modelSigningKeys,
  runMigrations,
  sql,
  and,
  type Db,
} from "@regulait/db";
import { STEP_UP_HEADER } from "@regulait/shared";
import { buildApp } from "./app.js";
import { FileArtifactStore } from "./model-artifacts.js";
import { parseSigningKey, verifyModelSignature } from "./model-signing.js";
import { mrmDispatchGate } from "./mrm.js";
import { MODEL_SIGNATURE_HEADER, signingKeyAddStepUp, supplyChainRelaxStepUp } from "./model-supply-chain.js";
import { grantStepUpForTest, stepUpRequest } from "./testing/step-up-grant.js";
import { relaxGovernanceGatesForTest } from "./testing/governance-gates.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = randomBytes(3).toString("hex");
const BOOT = `a216-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

// ---------------------------------------------------------------------------
// A signer in the open model-signing format (key mode), as its tool writes a bundle
// ---------------------------------------------------------------------------

interface Signer {
  privateKey: KeyObject;
  pem: string;
  hint: string;
}
function newSigner(curve = "P-256"): Signer {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: curve });
  const pem = publicKey.export({ type: "spki", format: "pem" }) as string;
  return { privateKey, pem, hint: sha(pem) };
}
const pae = (type: string, body: Buffer) => Buffer.concat([Buffer.from(`DSSEv1 ${Buffer.byteLength(type)} ${type} ${body.length} `), body]);
function statementFor(files: Array<{ name: string; digest: string }>, opts: { subjectDigest?: string; predicateType?: string } = {}) {
  const root = createHash("sha256");
  for (const f of files) root.update(Buffer.from(f.digest, "hex"));
  return {
    _type: "https://in-toto.io/Statement/v1",
    subject: [{ name: "a216-model", digest: { sha256: opts.subjectDigest ?? root.digest("hex") } }],
    predicateType: opts.predicateType ?? "https://model_signing/signature/v1.0",
    predicate: {
      serialization: { method: "files", hash_type: "sha256", allow_symlinks: false, ignore_paths: [] },
      resources: files.map((f) => ({ algorithm: "sha256", digest: f.digest, name: f.name })),
    },
  };
}
function bundleFor(signer: Signer, statement: unknown, tamper?: (payload: Buffer) => Buffer) {
  const type = "application/vnd.in-toto+json";
  const payload = Buffer.from(JSON.stringify(statement));
  const sig = sign("sha256", pae(type, payload), signer.privateKey);
  return {
    mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
    verificationMaterial: { publicKey: { hint: signer.hint }, tlogEntries: [] },
    dsseEnvelope: { payload: (tamper ? tamper(payload) : payload).toString("base64"), payloadType: type, signatures: [{ sig: sig.toString("base64"), keyid: "" }] },
  };
}
const signFile = (signer: Signer, digest: string) => bundleFor(signer, statementFor([{ name: "model.safetensors", digest }]));

describe("ADR-0216 verification (no database)", () => {
  const signer = newSigner();
  const trusted = [{ id: "00000000-0000-4000-8000-000000000001", keyHint: signer.hint, publicKeyPem: signer.pem }];
  const digest = sha("weights");

  it("a signature from a trusted key that covers the file passes", () => {
    expect(parseSigningKey(signer.pem)).toEqual({ publicKeyPem: signer.pem, keyHint: signer.hint });
    // the signer signed the whole model directory: the file is one of its resources
    const many = bundleFor(signer, statementFor([{ name: "config.json", digest: sha("cfg") }, { name: "model.safetensors", digest }]));
    expect(verifyModelSignature(many, digest, trusted)).toMatchObject({ ok: true, keyHint: signer.hint, resourceName: "model.safetensors", signedName: "a216-model" });
  });

  it("a tampered, foreign, revoked, mismatched, inconsistent or keyless signature fails, each for its reason", () => {
    const fail = (b: unknown, revoked: Set<string> = new Set(), keys = trusted) => {
      const v = verifyModelSignature(b, digest, keys, revoked);
      return v.ok ? "ok" : v.failure;
    };
    expect(fail(bundleFor(signer, statementFor([{ name: "m", digest }]), (p) => Buffer.from(p.toString().replace("a216-model", "a216-other"))))).toBe("signature_invalid");
    const stranger = newSigner();
    expect(fail(signFile(stranger, digest))).toBe("unknown_key");
    expect(fail(signFile(signer, digest), new Set([signer.hint]), [])).toBe("key_revoked");
    expect(fail(signFile(signer, sha("other bytes")))).toBe("digest_mismatch");
    expect(fail(bundleFor(signer, statementFor([{ name: "m", digest }], { subjectDigest: sha("x") })))).toBe("manifest_inconsistent");
    expect(fail(bundleFor(signer, statementFor([{ name: "m", digest }], { predicateType: "https://model_signing/Digests/v0.1" })))).toBe("unsupported_predicate");
    const keyless = { ...signFile(signer, digest), verificationMaterial: { certificate: { rawBytes: Buffer.from("x").toString("base64") }, tlogEntries: [] } };
    expect(fail(keyless)).toBe("unsupported_bundle");
    expect(fail({ not: "a bundle" })).toBe("bundle_malformed");
  });

  it("only an ECDSA P-256 key is accepted as a trust root", () => {
    expect(parseSigningKey(newSigner("P-384").pem)).toBeNull();
    expect(parseSigningKey("not a key")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Against the gateway
// ---------------------------------------------------------------------------

let db: Db;
let app: ReturnType<typeof buildApp>;
let restoreGates: (() => Promise<void>) | undefined;
let restoreIdentity: (() => Promise<void>) | undefined;
let adminId: string;
/** the admin's own API key: a key cannot step up (the bootstrap token is exempt, so it is not used for step-up checks) */
let adminKey: { authorization: string };
let aliceId: string;
let aliceKey: { authorization: string };
let agentId: string;
const signer = newSigner();

async function makeUser(email: string, isAdmin = false) {
  const u = await app.inject({ method: "POST", url: "/v1/users", headers: AUTH, payload: { email, displayName: email.split("@")[0], isAdmin } });
  expect(u.statusCode, u.body).toBe(201);
  const id = u.json().id as string;
  const k = await app.inject({ method: "POST", url: `/v1/users/${id}/keys`, headers: AUTH, payload: { name: "a216" } });
  expect(k.statusCode, k.body).toBe(201);
  return { id, key: { authorization: `Bearer ${k.json().token}` } };
}
/** an admin request carrying a step-up grant for exactly `args` */
async function asAdminSteppedUp(method: "POST" | "PUT", url: string, payload: object, args: Parameters<typeof grantStepUpForTest>[2]) {
  const r = stepUpRequest(await grantStepUpForTest(db, adminId, args));
  return app.inject({ method, url, headers: r.headers, cookies: r.cookies, payload });
}
/** an artifact row as an upload writes it (the format is what the bytes decided) */
async function artifactRow(format: string, tag: string) {
  const digest = sha(`a216 ${RUN} ${tag}`);
  const [a] = await db
    .insert(modelArtifacts)
    .values({ sha256: digest, sizeBytes: 10, format, filename: `${tag}.bin`, storageKey: `sha256/${digest}`, uploadedByUserId: aliceId })
    .returning();
  return a!;
}
async function scan(a: { id: string; sha256: string; format: string }, verdict: "clean" | "unknown" | "no_known_unsafe") {
  const [s] = await db.insert(artifactScans).values({ artifactId: a.id, artifactSha256: a.sha256, format: a.format, verdict, scannerVersion: "0.8.8" }).returning();
  return s!;
}
/** a card on the agent that cites the scan (the model is built from that file) */
async function cardCiting(scanId: string, use: string) {
  const [c] = await db.insert(modelCards).values({ agentId, intendedUse: `a216 ${RUN} ${use}`, createdByUserId: adminId }).returning();
  await db.insert(modelCardEvidence).values({ cardId: c!.id, kind: "engine_scan", artifactScanId: scanId });
  return c!;
}
async function dropCard(cardId: string) {
  await db.delete(modelCardEvidence).where(eq(modelCardEvidence.cardId, cardId));
  await db.delete(modelCards).where(eq(modelCards.id, cardId));
}
const gate = (now?: Date) => mrmDispatchGate(db, { userId: adminId, agentId, agentName: "a216-agent", model: "mock-balanced", customProviderId: null }, now);
const audits = (ruleId: string, objectId: string) => db.select().from(auditLog).where(and(eq(auditLog.ruleId, ruleId), eq(auditLog.objectId, objectId)));

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restoreIdentity = await relaxIdentityForTest(db, { mfaRequired: "off" });
  restoreGates = await relaxGovernanceGatesForTest(db, { mrmEnforced: false, dispatchAttributionRequired: false, useCaseGateMode: "off" });
  app = buildApp(db, { bootstrapToken: BOOT, artifactStore: new FileArtifactStore(await mkdtemp(path.join(tmpdir(), "a216-store-"))) });
  await app.ready();
  const admin = await makeUser(`a216-admin-${RUN}@example.com`, true);
  adminId = admin.id;
  adminKey = admin.key;
  const alice = await makeUser(`a216-alice-${RUN}@example.com`);
  aliceId = alice.id;
  aliceKey = alice.key;
  const a = await app.inject({ method: "POST", url: "/v1/agents", headers: AUTH, payload: { name: `a216-agent-${RUN}`, provider: "mock", tier: 1, costPerMTokIn: 3, costPerMTokOut: 15, model: "mock-balanced" } });
  expect(a.statusCode, a.body).toBe(201);
  agentId = a.json().id;
}, 180_000);

afterAll(async () => {
  await db.delete(agents).where(eq(agents.id, agentId)).catch(() => undefined);
  await restoreGates?.();
  await restoreIdentity?.();
  app.server.closeAllConnections();
  await app.close();
});

describe("ADR-0216 trust roots and signatures", () => {
  it("adding a signing key needs a step-up and is audited; a P-384 key is refused", async () => {
    const plain = await app.inject({ method: "POST", url: "/v1/model-signing-keys", headers: adminKey, payload: { name: "release key", publicKeyPem: signer.pem } });
    expect(plain.statusCode, plain.body).toBe(403);
    expect(plain.json()).toMatchObject({ error: "step_up_required", actionKind: "settings_relax" });
    const p384 = await app.inject({ method: "POST", url: "/v1/model-signing-keys", headers: AUTH, payload: { name: "wrong curve", publicKeyPem: newSigner("P-384").pem } });
    expect(p384.statusCode).toBe(422);
    const added = await asAdminSteppedUp("POST", "/v1/model-signing-keys", { name: `a216 release ${RUN}`, publicKeyPem: signer.pem }, signingKeyAddStepUp(signer.hint));
    expect(added.statusCode, added.body).toBe(201);
    expect(added.json().key).toMatchObject({ keyHint: signer.hint, revokedAt: null });
    expect(await audits("model-signing-key-added", added.json().key.id)).toHaveLength(1);
    // a regular user cannot list or add keys
    expect((await app.inject({ method: "GET", url: "/v1/model-signing-keys", headers: aliceKey })).statusCode).toBe(403);
  });

  it("a signature riding the upload is verified in the upload; a bad one is recorded as failed and audited", async () => {
    const bytes = Buffer.from(`a216 upload ${RUN} ${randomBytes(8).toString("hex")}`);
    const up = (bundle: unknown) =>
      app.inject({
        method: "POST",
        url: "/v1/model-artifacts?filename=model.bin",
        headers: { ...aliceKey, "content-type": "application/octet-stream", [MODEL_SIGNATURE_HEADER]: Buffer.from(JSON.stringify(bundle)).toString("base64") },
        payload: bytes,
      });
    const good = await up(signFile(signer, sha(bytes)));
    expect(good.statusCode, good.body).toBe(201);
    expect(good.json().signature).toMatchObject({ status: "verified", failure: null });
    expect(good.json().artifact.supplyChain.signature).toMatchObject({ status: "verified", presentedAt: "upload" });
    // signed, but never scanned and not a safe format: it still fails the other two conditions
    expect(good.json().artifact.supplyChain.assessment.failing).toEqual(["unscanned", "unsafe_format"]);
    expect(await audits("model-signature-verified", good.json().artifact.id)).toHaveLength(1);

    const bad = await up(signFile(newSigner(), sha(bytes)));
    expect(bad.statusCode, bad.body).toBe(201);
    expect(bad.json().signature).toMatchObject({ status: "failed", failure: "unknown_key" });
    expect(bad.json().artifact.supplyChain.assessment.failing).toContain("unsigned");
    const [denied] = await audits("model-signature-failed", bad.json().artifact.id);
    expect(denied).toMatchObject({ effect: "deny" });
  });

  it("a bundle over the size cap is refused and not kept: only its size is recorded", async () => {
    const a = await artifactRow("safetensors", "oversized");
    const huge = { ...signFile(signer, a.sha256), padding: "x".repeat(70 * 1024) };
    const r = await app.inject({ method: "POST", url: `/v1/model-artifacts/${a.id}/signature`, headers: aliceKey, payload: { bundle: huge } });
    expect(r.statusCode, r.body).toBe(422);
    expect(r.json().signature).toMatchObject({ status: "failed", failure: "bundle_malformed" });
    const [row] = await db.select().from(modelArtifactSignatures).where(eq(modelArtifactSignatures.artifactId, a.id));
    expect(row!.bundle).toMatchObject({ oversized: true });
    expect(JSON.stringify(row!.bundle).length).toBeLessThan(200);
  });

  it("a signature attached later is verified (the uploader may attach; a mismatch is refused 422)", async () => {
    const a = await artifactRow("safetensors", "attach");
    const wrong = await app.inject({ method: "POST", url: `/v1/model-artifacts/${a.id}/signature`, headers: aliceKey, payload: { bundle: signFile(signer, sha("not it")) } });
    expect(wrong.statusCode, wrong.body).toBe(422);
    expect(wrong.json()).toMatchObject({ error: "signature_not_verified", signature: { failure: "digest_mismatch" } });
    const ok = await app.inject({ method: "POST", url: `/v1/model-artifacts/${a.id}/signature`, headers: aliceKey, payload: { bundle: signFile(signer, a.sha256) } });
    expect(ok.statusCode, ok.body).toBe(201);
    expect(ok.json().supplyChain.signature.status).toBe("verified");
  });
});

describe("ADR-0216 the block", () => {
  it("an unsigned, unscanned file cited by a card blocks dispatch and sign-off, audited, opening one supply-chain risk", async () => {
    const a = await artifactRow("pickle", "unsigned");
    const s = await scan(a, "unknown");
    const card = await cardCiting(s.id, "unsigned");
    try {
      // the block does not depend on the MRM toggle (it is off in this file)
      const refused = await gate();
      expect(refused).toMatchObject({ status: 409, error: "model_supply_chain_blocked" });
      expect(refused!.detail).toContain("unsigned.bin");
      const [audit] = await audits("model-supply-chain-blocked", agentId).then((r) => r.filter((x) => JSON.stringify(x.detail).includes(a.id)));
      expect(audit).toMatchObject({ effect: "deny" });
      expect((audit!.detail as { blocks: Array<{ conditions: string[] }> }).blocks[0]!.conditions).toEqual(["unsigned", "unscanned", "unsafe_format"]);
      const risks = await db.select().from(aiRisks).where(eq(aiRisks.modelArtifactId, a.id));
      expect(risks).toHaveLength(1);
      expect(risks[0]).toMatchObject({ category: "supply_chain", status: "open", ownerUserId: aliceId, agentId });
      expect(await audits("risk-registered", risks[0]!.id)).toHaveLength(1);
      // a second block does not open a second entry
      expect(await gate()).not.toBeNull();
      expect(await db.select().from(aiRisks).where(eq(aiRisks.modelArtifactId, a.id))).toHaveLength(1);
      // the model-risk check: the card is not signed off
      const signOff = await app.inject({ method: "POST", url: `/v1/mrm/cards/${card.id}/sign-off`, headers: AUTH, payload: { approverUserId: adminId, acknowledgeNoExpiry: true } });
      expect(signOff.statusCode, signOff.body).toBe(409);
      expect(signOff.json()).toMatchObject({ error: "model_supply_chain_blocked" });
      // the register's evidence for that risk measures the file
      const ev = await app.inject({ method: "GET", url: `/v1/risks/${risks[0]!.id}`, headers: AUTH });
      expect(ev.statusCode, ev.body).toBe(200);
      expect(JSON.stringify(ev.json())).toContain("model_supply_chain");
    } finally {
      await dropCard(card.id);
    }
  });

  it("a signed, scanned safetensors file passes; revoking its key blocks it again at once", async () => {
    const extra = newSigner();
    const added = await asAdminSteppedUp("POST", "/v1/model-signing-keys", { name: `a216 temp ${RUN}`, publicKeyPem: extra.pem }, signingKeyAddStepUp(extra.hint));
    expect(added.statusCode, added.body).toBe(201);
    const a = await artifactRow("safetensors", "signed");
    const attach = await app.inject({ method: "POST", url: `/v1/model-artifacts/${a.id}/signature`, headers: aliceKey, payload: { bundle: signFile(extra, a.sha256) } });
    expect(attach.statusCode, attach.body).toBe(201);
    const card = await cardCiting((await scan(a, "clean")).id, "signed");
    try {
      expect(await gate()).toBeNull();
      const revoked = await app.inject({ method: "POST", url: `/v1/model-signing-keys/${added.json().key.id}/revoke`, headers: AUTH });
      expect(revoked.statusCode, revoked.body).toBe(200);
      expect(await audits("model-signing-key-revoked", added.json().key.id)).toHaveLength(1);
      const after = await gate();
      expect(after).toMatchObject({ error: "model_supply_chain_blocked" });
      const view = await app.inject({ method: "GET", url: `/v1/model-artifacts/${a.id}`, headers: aliceKey });
      expect(view.json().artifact.supplyChain.signature).toMatchObject({ status: "failed", failure: "key_revoked" });
      // a revoked key is never re-added, and its row is never deleted
      await expect(db.delete(modelSigningKeys).where(eq(modelSigningKeys.id, added.json().key.id))).rejects.toThrow();
    } finally {
      await dropCard(card.id);
    }
  });

  it("an admin's relaxation needs a step-up and a reason, is audited, lets the model through, and expires; clearing is audited", async () => {
    const a = await artifactRow("safetensors", "relaxed");
    const card = await cardCiting((await scan(a, "clean")).id, "relaxed");
    try {
      expect((await gate())?.error).toBe("model_supply_chain_blocked");
      const url = `/v1/model-artifacts/${a.id}/supply-chain-relaxation`;
      const expiresAt = new Date(Date.now() + 7 * 86_400_000).toISOString();
      const body = { conditions: ["unsigned"], reason: "internal fine-tune; signing pipeline lands next sprint", expiresAt };
      // not an admin: not found; an admin without a step-up: refused
      expect((await app.inject({ method: "PUT", url, headers: aliceKey, payload: body })).statusCode).toBe(403);
      const noStep = await app.inject({ method: "PUT", url, headers: adminKey, payload: body });
      expect(noStep.statusCode, noStep.body).toBe(403);
      expect(noStep.json()).toMatchObject({ error: "step_up_required" });
      // no reason, no end date (the step-up is bound to it), or past the 30-day bound: refused
      const { expiresAt: _omit, ...noExpiry } = body;
      void _omit;
      expect((await app.inject({ method: "PUT", url, headers: AUTH, payload: noExpiry })).statusCode).toBe(400);
      expect((await app.inject({ method: "PUT", url, headers: AUTH, payload: { ...body, reason: " " } })).statusCode).toBe(400);
      expect((await app.inject({ method: "PUT", url, headers: AUTH, payload: { ...body, expiresAt: new Date(Date.now() + 31 * 86_400_000).toISOString() } })).statusCode).toBe(422);
      const relaxed = await asAdminSteppedUp("PUT", url, body, supplyChainRelaxStepUp(a.id, a.sha256, ["unsigned"], expiresAt));
      expect(relaxed.statusCode, relaxed.body).toBe(200);
      expect(relaxed.json().supplyChain.assessment).toMatchObject({ passes: true, relaxed: true, failing: ["unsigned"], uncovered: [] });
      const [audit] = await audits("model-supply-chain-relaxed", a.id);
      expect(audit!.detail).toMatchObject({ conditions: ["unsigned"], reason: body.reason, relaxation: true });
      expect(await gate()).toBeNull();
      // it expires: after its end the same file blocks again
      expect((await gate(new Date(Date.now() + 8 * 86_400_000)))?.error).toBe("model_supply_chain_blocked");
      // the database bounds it too: a row past 30 days is refused
      await expect(
        db.execute(sql`INSERT INTO model_artifact_supply_chain_relaxations (artifact_id, artifact_sha256, conditions, reason, expires_at) VALUES (${a.id}, ${a.sha256}, ARRAY['unsigned'], 'x', now() + interval '31 days')`),
      ).rejects.toThrow();
      // clearing tightens: no step-up, audited
      const cleared = await app.inject({ method: "DELETE", url, headers: AUTH });
      expect(cleared.statusCode, cleared.body).toBe(200);
      expect(cleared.json().cleared).toBe(true);
      expect(await audits("model-supply-chain-relaxation-cleared", a.id)).toHaveLength(1);
      expect((await gate())?.error).toBe("model_supply_chain_blocked");
    } finally {
      await dropCard(card.id);
    }
  });
});
