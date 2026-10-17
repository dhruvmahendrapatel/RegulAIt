/**
 * Migration 0207 — the `key_management` step-up kind, on a real database,
 * through the real app (`buildApp`) and its hooks:
 *
 *  - THE KIND: every signing-key operation (retire a receipt key, rotate or
 *    revoke the issuer key) asks for `key_management`, bound to `{op, keyId}`.
 *    The strict default and the existing org row both require it, and the
 *    three CHECKs accept it.
 *  - NEGATIVE CONTROLS: a `settings_relax` (or `identity_manage`) grant made
 *    for the same facts is refused for a key operation and is NOT spent; a
 *    `key_management` grant made for another key or another op is refused and
 *    NOT spent. The right grant is spent once.
 *  - EXACT BINDING: a rotation with no `kid` is bound to the key it would
 *    rotate TO, resolved before the step-up; a refused rotation or revoke
 *    asks for no step-up and spends nothing.
 *  - AUDIT: the allow rows name the kind (`stepUpKind: "key_management"`).
 *
 * Global state (M-068): org settings and the active issuer key are put back in
 * afterAll. Keys and grants are this run's own (random ids).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import os from "node:os";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  and,
  auditLog,
  authSessions,
  createDb,
  desc,
  eq,
  identitySigningKeys,
  orgSettings,
  ORG_SETTINGS_ID,
  receiptSigningKeys,
  runMigrations,
  sql,
  stepUpGrants,
  users,
  type Db,
} from "@regulait/db";
import { BATCH4_STRICT_DEFAULTS, IDENTITY_SIGNING_KEY_ENV, stepUpActionDigest } from "@regulait/shared";
import { buildApp } from "./app.js";
import { receiptKeyRetireStepUp, RECEIPT_KEY_RETIRED_RULE_ID } from "./decision-receipts.js";
import { configuredIdentitySigningKeys, rotateIdentitySigningKey, signingKeyRevokeStepUp, signingKeyRotateStepUp } from "./identity-signing-keys.js";
import type { StepUpCheckArgs } from "./step-up.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { hashToken } from "./token-hash.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = Math.random().toString(36).slice(2, 8);
const BOOT = `km-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const CSRF = { "x-regulait-csrf": "1" };
const SYSTEM = "00000000-0000-0000-0000-000000000000";
const RK_A = `km-${RUN}-a`;
const RK_B = `km-${RUN}-b`;

let db: Db;
let app: ReturnType<typeof buildApp>;
let adminId: string;
let keyDir: string;
let kidA: string;
let kidB: string;
const restores: Array<() => Promise<void>> = [];

const rows = <R>(r: unknown) => (r as { rows: R[] }).rows;
const ed25519X = () => generateKeyPairSync("ed25519").publicKey.export({ format: "jwk" }).x!;

/** a browser session for the admin and a step-up token made for exactly `args` (the real tables, no shortcut) */
async function grantFor(args: StepUpCheckArgs) {
  const sessionToken = "rgls_" + randomBytes(32).toString("hex");
  const [session] = await db
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
  const stepUpToken = "rgsu_" + randomBytes(24).toString("hex");
  const [grant] = await db
    .insert(stepUpGrants)
    .values({
      tokenHash: hashToken(stepUpToken),
      userId: adminId,
      sessionId: session!.id,
      method: "totp",
      actionKind: args.kind,
      actionDigest: stepUpActionDigest(args.kind, args.facts),
      expiresAt: new Date(Date.now() + 120_000),
    })
    .returning({ id: stepUpGrants.id });
  return { sessionToken, stepUpToken, grantId: grant!.id };
}

const post = (url: string, su: { sessionToken: string; stepUpToken: string }, payload: object = {}) =>
  app.inject({ method: "POST", url, headers: { ...CSRF, "x-regulait-step-up": su.stepUpToken }, cookies: { regulait_session: su.sessionToken }, payload });
const spent = async (grantId: string) => (await db.select({ usedAt: stepUpGrants.usedAt }).from(stepUpGrants).where(eq(stepUpGrants.id, grantId)))[0]!.usedAt !== null;
const activeKid = async () =>
  rows<{ kid: string }>(await db.execute(sql`select kid from identity_signing_keys where activated_at is not null and retired_at is null and revoked_at is null`))[0]?.kid;

/**
 * The grant is refused for this request and stays unspent, and the refusal is
 * audited under `key_management`. The admin has no enrolled method (enrolling
 * one would close the bootstrap door for every other suite sharing this
 * database), so the refusal is 422 `step_up_unavailable`, decided after the
 * grant was looked at.
 */
async function expectRefusedUnspent(url: string, args: StepUpCheckArgs, payload: object = {}) {
  const su = await grantFor(args);
  const res = await post(url, su, payload);
  expect(res.statusCode, res.body).toBe(422);
  expect(res.json()).toMatchObject({ error: "step_up_unavailable", actionKind: "key_management" });
  expect(await spent(su.grantId), `${args.kind} ${JSON.stringify(args.facts)} must not be spent`).toBe(false);
  const [deny] = await db.select().from(auditLog).where(and(eq(auditLog.ruleId, "step-up-grant-refused"), eq(auditLog.userId, adminId))).orderBy(desc(auditLog.seq)).limit(1);
  expect(deny).toMatchObject({ userId: adminId, effect: "deny", detail: expect.objectContaining({ actionKind: "key_management" }) });
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restores.push(await relaxIdentityForTest(db, { mfaRequired: "off" }));
  // the strict step-up posture, explicitly (another file may have relaxed it and not yet put it back)
  const [before] = await db.select({ mode: orgSettings.stepUpMode, actions: orgSettings.stepUpActions }).from(orgSettings).where(eq(orgSettings.id, ORG_SETTINGS_ID));
  await db.update(orgSettings).set({ stepUpMode: "required", stepUpActions: [...BATCH4_STRICT_DEFAULTS.stepUpActions] }).where(eq(orgSettings.id, ORG_SETTINGS_ID));
  restores.push(async () => {
    await db.update(orgSettings).set({ stepUpMode: before!.mode, stepUpActions: before!.actions }).where(eq(orgSettings.id, ORG_SETTINGS_ID));
  });
  app = buildApp(db, { bootstrapToken: BOOT });

  const u = await app.inject({ method: "POST", url: "/v1/users", headers: AUTH, payload: { email: `km-admin-${RUN}@example.com`, displayName: "km admin" } });
  expect(u.statusCode, u.body).toBe(201);
  adminId = u.json().id as string;
  await db.update(users).set({ isAdmin: true }).where(eq(users.id, adminId));

  // two receipt keys of this run, neither the one this gateway signs with
  await db.insert(receiptSigningKeys).values([
    { keyId: RK_A, publicJwk: { kty: "OKP", crv: "Ed25519", x: ed25519X() } },
    { keyId: RK_B, publicJwk: { kty: "OKP", crv: "Ed25519", x: ed25519X() } },
  ]);

  // two issuer keys of this run: A is made the signer, B is the one a rotation with no kid resolves to
  keyDir = mkdtempSync(path.join(os.tmpdir(), "km-issuer-"));
  const pems = [0, 1].map(() => generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" }).toString());
  writeFileSync(path.join(keyDir, "issuer.pem"), pems.join("\n"), { mode: 0o600 });
  process.env[IDENTITY_SIGNING_KEY_ENV] = path.join(keyDir, "issuer.pem");
  const configured = await configuredIdentitySigningKeys();
  kidA = configured[0]!.kid;
  kidB = configured[1]!.kid;
  await rotateIdentitySigningKey(db, { kid: kidA, actorUserId: SYSTEM });
}, 120_000);

afterAll(async () => {
  await db.execute(sql`update identity_signing_keys set retired_at = now() where activated_at is not null and retired_at is null and revoked_at is null`);
  for (const r of restores.reverse()) await r();
  await app?.close();
  if (keyDir) rmSync(keyDir, { recursive: true, force: true });
  delete process.env[IDENTITY_SIGNING_KEY_ENV];
});

describe("migration 0207: the key_management step-up kind", () => {
  it("is strict by default, required on the existing row, and accepted by all three CHECKs", async () => {
    expect(BATCH4_STRICT_DEFAULTS.stepUpActions).toContain("key_management");
    const def = await db.execute(sql`select column_default as d from information_schema.columns where table_name = 'org_settings' and column_name = 'step_up_actions'`);
    expect(rows<{ d: string }>(def)[0]!.d).toContain("key_management");
    for (const c of ["step_up_grants_action_kind_check", "webauthn_challenges_action_kind_check", "org_settings_step_up_actions_check"]) {
      const d = await db.execute(sql`select pg_get_constraintdef(oid) as d from pg_constraint where conname = ${c}`);
      expect(rows<{ d: string }>(d)[0]!.d, c).toContain("key_management");
      expect(rows<{ d: string }>(d)[0]!.d, c).toContain("identity_manage");
    }
  });

  it("retiring a receipt key: a settings_relax grant or a key_management grant for another key or op is refused and not spent", async () => {
    const url = `/v1/receipts/keys/${RK_A}/retire`;
    // the pre-0207 shape: settings_relax with the very same facts
    await expectRefusedUnspent(url, { kind: "settings_relax", facts: { op: "receipt_key_retire", keyId: RK_A } });
    await expectRefusedUnspent(url, { kind: "identity_manage", facts: { op: "receipt_key_retire", keyId: RK_A } });
    // the right kind for the wrong key, and for the wrong op on the right key
    await expectRefusedUnspent(url, receiptKeyRetireStepUp(RK_B));
    await expectRefusedUnspent(url, signingKeyRevokeStepUp(RK_A));
    expect((await db.select().from(receiptSigningKeys).where(eq(receiptSigningKeys.keyId, RK_A)))[0]!.retiredAt).toBeNull();

    // the exact grant: spent once, the key retired, the allow row names the kind
    const su = await grantFor(receiptKeyRetireStepUp(RK_A));
    const ok = await post(url, su);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(await spent(su.grantId)).toBe(true);
    const [row] = await db.select().from(auditLog).where(eq(auditLog.ruleId, RECEIPT_KEY_RETIRED_RULE_ID)).orderBy(desc(auditLog.seq)).limit(1);
    expect(row!.detail).toMatchObject({ keyId: RK_A, stepUp: "totp", stepUpKind: "key_management" });
    // used: the same token can never retire again (and the key is retired anyway: refused before any step-up)
    expect((await post(url, su)).statusCode).toBe(409);
  });

  it("rotating the issuer key: bound to the key rotated TO; settings_relax, identity_manage, another key or op are refused and not spent", async () => {
    const url = "/v1/identity/signing-keys/rotate";
    expect(await activeKid()).toBe(kidA);
    // no kid: the gateway resolves B before asking, so only a grant naming B is valid
    await expectRefusedUnspent(url, { kind: "settings_relax", facts: { op: "signing_key_rotate", keyId: kidB } });
    await expectRefusedUnspent(url, { kind: "identity_manage", facts: { op: "signing_key_rotate", keyId: kidB } });
    // the pre-0207 facts (kid: null) bind nothing exact
    await expectRefusedUnspent(url, { kind: "key_management", facts: { op: "signing_key_rotate", kid: null } });
    await expectRefusedUnspent(url, signingKeyRotateStepUp(kidA));
    await expectRefusedUnspent(url, signingKeyRevokeStepUp(kidB));
    expect(await activeKid()).toBe(kidA);

    const su = await grantFor(signingKeyRotateStepUp(kidB));
    const ok = await post(url, su);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({ kid: kidB, previousKid: kidA });
    expect(await spent(su.grantId)).toBe(true);
    const [row] = await db.select().from(auditLog).where(eq(auditLog.ruleId, "identity-signing-key-rotate")).orderBy(desc(auditLog.seq)).limit(1);
    expect(row!.detail).toMatchObject({ kid: kidB, previousKid: kidA, stepUp: "totp", stepUpKind: "key_management" });

    // nothing left to rotate to: refused before any step-up, and a valid-looking grant is not spent
    const idle = await grantFor(signingKeyRotateStepUp(kidB));
    const none = await post(url, idle);
    expect(none.statusCode, none.body).toBe(503);
    expect(none.json().error).toBe("signing_key_unavailable");
    expect(await spent(idle.grantId)).toBe(false);
  });

  it("revoking the issuer key: bound to the key; another key or op is refused and not spent; an unknown key asks for nothing", async () => {
    const url = `/v1/identity/signing-keys/${kidA}/revoke`;
    await expectRefusedUnspent(url, { kind: "settings_relax", facts: { op: "signing_key_revoke", keyId: kidA } });
    await expectRefusedUnspent(url, signingKeyRevokeStepUp(kidB));
    await expectRefusedUnspent(url, signingKeyRotateStepUp(kidA));
    expect((await db.select().from(identitySigningKeys).where(eq(identitySigningKeys.kid, kidA)))[0]!.revokedAt).toBeNull();

    const unknown = `km-${RUN}-missing`;
    const stray = await grantFor(signingKeyRevokeStepUp(unknown));
    const nf = await post(`/v1/identity/signing-keys/${unknown}/revoke`, stray);
    expect(nf.statusCode).toBe(404);
    expect(await spent(stray.grantId)).toBe(false);

    const su = await grantFor(signingKeyRevokeStepUp(kidA));
    const ok = await post(url, su);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(await spent(su.grantId)).toBe(true);
    const [row] = await db.select().from(auditLog).where(eq(auditLog.ruleId, "identity-signing-key-revoke")).orderBy(desc(auditLog.seq)).limit(1);
    expect(row!.detail).toMatchObject({ kid: kidA, stepUp: "totp", stepUpKind: "key_management" });
    // already revoked: refused before any step-up
    expect((await post(url, su)).statusCode).toBe(409);
  });
});
