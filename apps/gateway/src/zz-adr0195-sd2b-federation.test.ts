/**
 * ADR-0195 SD2b (migration 0205) — the cloud federation signer on a real database, through the real app:
 *
 *  - THE TABLE: a private JWK member, a deleted key, a TRUNCATE and a destroyed private half coming back are all
 *    refused (the 0185 rules: the guard pins its search_path; TRUNCATE is refused beside the row guard).
 *  - OFF BY DEFAULT: with no active key nothing can be minted (`federation_off`).
 *  - STEP-UPS: turning federation on is `settings_relax` `{op: "federation_enable", keyId}`; rotating is
 *    `key_management` `{op: "federation_key_rotate", keyId}`; revoking is `key_management`
 *    `{op: "federation_key_revoke", keyId}`. A grant of another kind, op or key is refused and NOT spent; the right
 *    grant is spent once. Generating a key and turning federation off are free. Every change is audited.
 *  - ROUND TRIP: a minted token verifies against the JWKS route's body with its issuer and audience; a rotated-out
 *    key stays published inside the overlap with its private half destroyed; a revoked key leaves the JWKS at once.
 *
 * Global state (M-068): federation is turned off and org settings are put back in afterAll. Keys and grants are
 * this run's own.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createLocalJWKSet, jwtVerify } from "jose";
import {
  and,
  auditLog,
  authSessions,
  createDb,
  desc,
  eq,
  federationSigningKeys,
  orgSettings,
  ORG_SETTINGS_ID,
  runMigrations,
  sql,
  stepUpGrants,
  users,
  type Db,
} from "@regulait/db";
import { BATCH4_STRICT_DEFAULTS, federationSourceSubject, stepUpActionDigest } from "@regulait/shared";
import { buildApp } from "./app.js";
import { federationTokenMinter, mintFederationToken } from "./federation-signing-keys.js";
import type { StepUpCheckArgs } from "./step-up.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { hashToken } from "./token-hash.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = Math.random().toString(36).slice(2, 8);
const BOOT = `fed-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const CSRF = { "x-regulait-csrf": "1" };
const DATA_KEY = createHash("sha256").update(`sd2b-data-key-${RUN}`).digest("hex");
const PUBLIC_URL = "https://regulait.example.test";
const ISSUER = `${PUBLIC_URL}/federation`;
const SUBJECT = federationSourceSubject("00000000-0000-4000-8000-0000000000f1");

let db: Db;
let app: ReturnType<typeof buildApp>;
let adminId: string;
const restores: Array<() => Promise<void>> = [];
const previousPublicUrl = process.env.REGULAIT_PUBLIC_URL;

const rows = <R>(r: unknown) => (r as { rows: R[] }).rows;
/** drizzle wraps a database error as "Failed query: ..." and keeps the server's message in `cause` */
const errText = (e: unknown) => `${String((e as Error)?.message ?? e)} ${String((e as { cause?: Error })?.cause?.message ?? "")}`;
async function refusedWith(p: Promise<unknown>, re: RegExp): Promise<void> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err, `expected a refusal matching ${re}`).not.toBeNull();
  expect(errText(err)).toMatch(re);
}

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

const post = (url: string, su: { sessionToken: string; stepUpToken: string }) =>
  app.inject({ method: "POST", url, headers: { ...CSRF, "x-regulait-step-up": su.stepUpToken }, cookies: { regulait_session: su.sessionToken }, payload: {} });
const spent = async (grantId: string) => (await db.select({ usedAt: stepUpGrants.usedAt }).from(stepUpGrants).where(eq(stepUpGrants.id, grantId)))[0]!.usedAt !== null;

/** a grant made for other facts is refused for this request (422: the admin has no enrolled method) and NOT spent */
async function expectRefusedUnspent(url: string, args: StepUpCheckArgs, wantKind: string) {
  const su = await grantFor(args);
  const res = await post(url, su);
  expect(res.statusCode, res.body).toBe(422);
  expect(res.json()).toMatchObject({ error: "step_up_unavailable", actionKind: wantKind });
  expect(await spent(su.grantId), `${args.kind} ${JSON.stringify(args.facts)} must not be spent`).toBe(false);
}

const generate = async (): Promise<string> => {
  const res = await app.inject({ method: "POST", url: "/v1/discovery/federation/keys", headers: { ...AUTH, ...CSRF }, payload: {} });
  expect(res.statusCode, res.body).toBe(201);
  expect(res.json()).toMatchObject({ state: "pending", published: false, algorithm: "RS256" });
  return res.json().kid as string;
};
const jwks = async () => {
  const res = await app.inject({ method: "GET", url: "/federation/.well-known/jwks.json" });
  expect(res.statusCode).toBe(200);
  return res.json() as { keys: Array<{ kid: string; kty: string; alg: string; d?: string }> };
};
const keyRow = async (kid: string) => (await db.select().from(federationSigningKeys).where(eq(federationSigningKeys.kid, kid)))[0]!;
const lastAudit = async (ruleId: string) => (await db.select().from(auditLog).where(eq(auditLog.ruleId, ruleId)).orderBy(desc(auditLog.seq)).limit(1))[0];

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  process.env.REGULAIT_PUBLIC_URL = PUBLIC_URL;
  restores.push(await relaxIdentityForTest(db, { mfaRequired: "off" }));
  const [before] = await db.select({ mode: orgSettings.stepUpMode, actions: orgSettings.stepUpActions }).from(orgSettings).where(eq(orgSettings.id, ORG_SETTINGS_ID));
  await db.update(orgSettings).set({ stepUpMode: "required", stepUpActions: [...BATCH4_STRICT_DEFAULTS.stepUpActions] }).where(eq(orgSettings.id, ORG_SETTINGS_ID));
  restores.push(async () => {
    await db.update(orgSettings).set({ stepUpMode: before!.mode, stepUpActions: before!.actions }).where(eq(orgSettings.id, ORG_SETTINGS_ID));
  });
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });
  const u = await app.inject({ method: "POST", url: "/v1/users", headers: AUTH, payload: { email: `fed-admin-${RUN}@example.com`, displayName: "fed admin" } });
  expect(u.statusCode, u.body).toBe(201);
  adminId = u.json().id as string;
  await db.update(users).set({ isAdmin: true }).where(eq(users.id, adminId));
  // a clean start: no active or pending federation key left by another suite
  await db.execute(sql`update federation_signing_keys set retired_at = GREATEST(now(), activated_at), private_key_ciphertext = null where activated_at is not null and retired_at is null and revoked_at is null`);
  await db.execute(sql`update federation_signing_keys set revoked_at = now(), private_key_ciphertext = null where activated_at is null and revoked_at is null`);
}, 120_000);

afterAll(async () => {
  await db.execute(sql`update federation_signing_keys set retired_at = GREATEST(now(), activated_at), private_key_ciphertext = null where activated_at is not null and retired_at is null and revoked_at is null`);
  await db.execute(sql`update federation_signing_keys set revoked_at = now(), private_key_ciphertext = null where activated_at is null and revoked_at is null`);
  for (const r of restores.reverse()) await r();
  await app?.close();
  if (previousPublicUrl === undefined) delete process.env.REGULAIT_PUBLIC_URL;
  else process.env.REGULAIT_PUBLIC_URL = previousPublicUrl;
});

describe("ADR-0195 SD2b: the federation signer", () => {
  it("migration 0205: CHECKs and the guard refuse private members, deletes, TRUNCATE and a destroyed key coming back", async () => {
    const n = "x".repeat(342);
    await expect(db.execute(sql`insert into federation_signing_keys (kid, public_jwk, private_key_ciphertext, created_by) values (${`t-${RUN}-d`}, ${JSON.stringify({ kty: "RSA", e: "AQAB", n, d: "secret" })}::jsonb, 'c', ${adminId})`)).rejects.toThrow();
    await expect(db.execute(sql`insert into federation_signing_keys (kid, public_jwk, private_key_ciphertext, created_by) values (${`t-${RUN}-nopriv`}, ${JSON.stringify({ kty: "RSA", e: "AQAB", n })}::jsonb, null, ${adminId})`)).rejects.toThrow();
    const kid = `t-${RUN}-g`;
    await db.execute(sql`insert into federation_signing_keys (kid, public_jwk, private_key_ciphertext, created_by) values (${kid}, ${JSON.stringify({ kty: "RSA", e: "AQAB", n })}::jsonb, 'c', ${adminId})`);
    try {
      await refusedWith(db.execute(sql`delete from federation_signing_keys where kid = ${kid}`), /never deleted/);
      await refusedWith(db.execute(sql`truncate federation_signing_keys`), /TRUNCATE/);
      // the guard itself (not a CHECK) keeps the public half fixed (#420 review finding 1)
      const other = JSON.stringify({ kty: "RSA", e: "AQAB", n: "y".repeat(342) });
      await refusedWith(db.execute(sql`update federation_signing_keys set public_jwk = ${other}::jsonb where kid = ${kid}`), /written once/);
    } finally {
      // never leave this pending fixture behind: a pending key blocks every later generate
      await db.execute(sql`update federation_signing_keys set revoked_at = now(), private_key_ciphertext = null where kid = ${kid} and revoked_at is null`);
    }
    await expect(db.execute(sql`update federation_signing_keys set private_key_ciphertext = 'c' where kid = ${kid}`)).rejects.toThrow();
    await refusedWith(db.execute(sql`update federation_signing_keys set revoked_at = now() + interval '1 day' where kid = ${kid}`), /written once/);
    // activated_at is written once too: the first stamp is allowed, a second is refused (no CHECK is in play here)
    await db.execute(sql`update federation_signing_keys set activated_at = now() where kid = ${kid}`);
    await refusedWith(db.execute(sql`update federation_signing_keys set activated_at = now() + interval '1 hour' where kid = ${kid}`), /written once/);
    const fn = await db.execute(sql`select array_to_string(proconfig, ',') as c from pg_proc where proname = 'regulait_federation_signing_key_guard'`);
    expect(rows<{ c: string }>(fn)[0]!.c).toContain("search_path=pg_catalog, public, pg_temp");
  });

  it("is off by default: nothing can be minted and the status says off", async () => {
    const status = await app.inject({ method: "GET", url: "/v1/discovery/federation", headers: AUTH });
    expect(status.statusCode, status.body).toBe(200);
    expect(status.json()).toMatchObject({ enabled: false, issuer: ISSUER, tokenTtlSeconds: 300 });
    await expect(mintFederationToken(db, { dataKey: DATA_KEY, subject: SUBJECT, audience: "sts.amazonaws.com" })).rejects.toMatchObject({ code: "federation_off" });
    const disc = await app.inject({ method: "GET", url: "/federation/.well-known/openid-configuration" });
    expect(disc.statusCode).toBe(200);
    expect(disc.json()).toMatchObject({ issuer: ISSUER, jwks_uri: `${ISSUER}/.well-known/jwks.json`, id_token_signing_alg_values_supported: ["RS256"] });
  });

  let kidA = "";
  let kidB = "";

  it("generate is free and leaves a pending key; a second pending key is refused", async () => {
    kidA = await generate();
    const again = await app.inject({ method: "POST", url: "/v1/discovery/federation/keys", headers: { ...AUTH, ...CSRF }, payload: {} });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe("federation_key_pending_exists");
    const row = await keyRow(kidA);
    expect(row.privateKeyCiphertext).not.toBeNull();
    expect(row.privateKeyCiphertext).not.toContain("PRIVATE");
    expect((await jwks()).keys.map((k) => k.kid)).not.toContain(kidA);
    expect(await lastAudit("federation-key-generated")).toMatchObject({ objectType: "federation_signing_key", objectId: row.id });
  });

  it("turning federation on is a settings_relax step-up bound to the key; other grants are refused and not spent", async () => {
    const url = `/v1/discovery/federation/keys/${kidA}/activate`;
    await expectRefusedUnspent(url, { kind: "key_management", facts: { op: "federation_enable", keyId: kidA } }, "settings_relax");
    await expectRefusedUnspent(url, { kind: "settings_relax", facts: { op: "federation_enable", keyId: "another" } }, "settings_relax");
    await expectRefusedUnspent(url, { kind: "settings_relax", facts: { op: "federation_key_rotate", keyId: kidA } }, "settings_relax");
    const su = await grantFor({ kind: "settings_relax", facts: { op: "federation_enable", keyId: kidA } });
    const ok = await post(url, su);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({ kid: kidA, previousKid: null, enabled: true });
    expect(await spent(su.grantId)).toBe(true);
    expect((await lastAudit("federation-enabled"))!.detail).toMatchObject({ kid: kidA, stepUp: "totp", stepUpKind: "settings_relax" });
    expect((await jwks()).keys).toEqual([expect.objectContaining({ kid: kidA, kty: "RSA", alg: "RS256", use: "sig" })]);
    expect((await jwks()).keys[0]!.d).toBeUndefined();
  });

  it("a minted token round-trips against the published JWKS, bound to its subject and audience", async () => {
    const token = await mintFederationToken(db, { dataKey: DATA_KEY, subject: SUBJECT, audience: "sts.amazonaws.com" });
    const set = createLocalJWKSet((await jwks()) as Parameters<typeof createLocalJWKSet>[0]);
    const { payload, protectedHeader } = await jwtVerify(token, set, { issuer: ISSUER, audience: "sts.amazonaws.com", algorithms: ["RS256"] });
    expect(protectedHeader.kid).toBe(kidA);
    expect(payload.sub).toBe(SUBJECT);
    expect(payload.exp! - payload.iat!).toBe(300);
    await expect(jwtVerify(token, set, { issuer: ISSUER, audience: "api://AzureADTokenExchange" })).rejects.toThrow();
    // a minter bound to AWS refuses Entra's audience; a wrong data key cannot open the key
    await expect(federationTokenMinter(db, { dataKey: DATA_KEY, subject: SUBJECT, allowedAudiences: ["sts.amazonaws.com"] })("api://AzureADTokenExchange")).rejects.toMatchObject({ code: "federation_audience_refused" });
    await expect(mintFederationToken(db, { dataKey: "1".repeat(64), subject: SUBJECT, audience: "sts.amazonaws.com" })).rejects.toMatchObject({ code: "federation_key_unreadable" });
  });

  it("rotation is a key_management step-up bound to the new key; the old key stays published with its private half destroyed", async () => {
    kidB = await generate();
    const url = `/v1/discovery/federation/keys/${kidB}/activate`;
    await expectRefusedUnspent(url, { kind: "settings_relax", facts: { op: "federation_enable", keyId: kidB } }, "key_management");
    await expectRefusedUnspent(url, { kind: "key_management", facts: { op: "federation_key_rotate", keyId: kidA } }, "key_management");
    const su = await grantFor({ kind: "key_management", facts: { op: "federation_key_rotate", keyId: kidB } });
    const ok = await post(url, su);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({ kid: kidB, previousKid: kidA });
    expect(await spent(su.grantId)).toBe(true);
    const a = await keyRow(kidA);
    expect(a.retiredAt).not.toBeNull();
    expect(a.privateKeyCiphertext).toBeNull();
    expect((await jwks()).keys.map((k) => k.kid)).toEqual([kidB, kidA]);
    expect((await lastAudit("federation-key-rotated"))!.detail).toMatchObject({ kid: kidB, previousKid: kidA, stepUpKind: "key_management" });
  });

  it("revocation is a key_management step-up bound to the key; the key leaves the JWKS at once", async () => {
    const url = `/v1/discovery/federation/keys/${kidA}/revoke`;
    await expectRefusedUnspent(url, { kind: "key_management", facts: { op: "federation_key_rotate", keyId: kidA } }, "key_management");
    await expectRefusedUnspent(url, { kind: "key_management", facts: { op: "federation_key_revoke", keyId: kidB } }, "key_management");
    await expectRefusedUnspent(url, { kind: "identity_manage", facts: { op: "federation_key_revoke", keyId: kidA } }, "key_management");
    const su = await grantFor({ kind: "key_management", facts: { op: "federation_key_revoke", keyId: kidA } });
    const ok = await post(url, su);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({ kid: kidA, wasActive: false, enabled: true });
    expect((await jwks()).keys.map((k) => k.kid)).toEqual([kidB]);
    // revoking again is refused before any step-up
    const again = await app.inject({ method: "POST", url, headers: { ...AUTH, ...CSRF }, payload: {} });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe("federation_key_already_revoked");
  });

  it("turning federation off is free and audited; then nothing can be minted", async () => {
    const off = await app.inject({ method: "POST", url: "/v1/discovery/federation/disable", headers: { ...AUTH, ...CSRF }, payload: {} });
    expect(off.statusCode, off.body).toBe(200);
    expect(off.json()).toMatchObject({ retiredKid: kidB });
    expect(await lastAudit("federation-disabled")).toMatchObject({ objectType: "federation_signing_key" });
    await expect(mintFederationToken(db, { dataKey: DATA_KEY, subject: SUBJECT, audience: "sts.amazonaws.com" })).rejects.toMatchObject({ code: "federation_off" });
    const status = (await app.inject({ method: "GET", url: "/v1/discovery/federation", headers: AUTH })).json();
    expect(status.enabled).toBe(false);
    // a retired key can never be activated again
    const reuse = await app.inject({ method: "POST", url: `/v1/discovery/federation/keys/${kidB}/activate`, headers: { ...AUTH, ...CSRF }, payload: {} });
    expect(reuse.statusCode).toBe(409);
    expect(reuse.json().error).toBe("federation_key_not_pending");
    const row = await db.select().from(auditLog).where(and(eq(auditLog.objectType, "federation_signing_key"), eq(auditLog.ruleId, "federation-disabled")));
    expect(row.length).toBeGreaterThan(0);
  });
});
