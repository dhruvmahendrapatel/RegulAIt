/**
 * ADR-0188 decision 5 (slice S3) — THE ISSUER'S SIGNING KEYS: where the
 * private half comes from, which public halves are published, and how a key
 * is activated, rotated and revoked.
 *
 * PRIVATE HALVES ARE A DEPLOY-TIME SECRET, never in the database (decision 5;
 * the receipt-key pattern of `REGULAIT_RECEIPT_SIGNING_KEY`):
 * `REGULAIT_IDENTITY_SIGNING_KEY` names a PEM file holding one or more PKCS#8
 * Ed25519 private keys (the current signer and, during a rotation, the next).
 * A key's `kid` is the RFC 7638 thumbprint of its public JWK, so the same key
 * file gives the same kids on every replica with nothing to coordinate.
 * `identity_signing_keys` keeps the PUBLIC half of every key ever used,
 * forever (migration 0180: never deleted, each lifecycle stamp written once).
 *
 * LIFECYCLE (every change audited, `object_type` `identity_signing_key`):
 *  - activate: the first signature with no active key records the single
 *    configured key that was never recorded, as the active key (a first load).
 *    With none, or more than one, candidate it refuses: which key signs is an
 *    admin's choice, made by rotation.
 *  - rotate (admin, `key_management` step-up bound to the key rotated to): the named configured key
 *    becomes the signer and the previous one is RETIRED. Rotation is not
 *    revocation (decision 12): a retired key stays in the JWKS for
 *    `SIGNING_KEY_OVERLAP_SECONDS` (the longest a token can live), so every
 *    token it signed verifies until it expires; after that the verifier
 *    refuses it ("a key retired past its overlap").
 *  - revoke (admin, `key_management` step-up bound to the key): compromise. Leaves the JWKS
 *    at once, every unexpired token it signed is revoked in `issued_tokens`,
 *    and the verifier refuses its `kid` from then on. Never undone (trigger).
 *
 * INSTALL-GENERATED (ADR-0188 S7, the receipt-key pattern of ADR-0189 R25 item 12): with
 * REGULAIT_IDENTITY_SIGNING_KEY unset and REGULAIT_INSTALL_SECRETS_DIR set, the installer or the first
 * boot creates `<dir>/identity-signing-key.pem` (Ed25519, mode 0600, create-exclusive, never
 * overwritten) with the same generator and the same strict reader as the receipt key. Without an issuer
 * key no workload can take a self token, so an engine runner or a PDP client on a fresh install could
 * never authenticate. The variable always wins: setting it is how an operator takes the key over (and
 * rotates: list the next key beside the current one, then rotate here).
 *
 * Open source first (ADR-0176): the key parsing is Node's own `crypto`
 * (`createPrivateKey`/`createPublicKey`), the thumbprint and every JWS are
 * `jose` 6.2.12 (already exact-pinned). No cryptography is written here.
 */
import { createPrivateKey, createPublicKey, type KeyObject } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { calculateJwkThumbprint } from "jose";
import { and, auditLog, desc, eq, identitySigningKeys, isNull, issuedTokens, sql, type Db, type IdentitySigningKeyRow } from "@regulait/db";
import { databaseNow } from "./delegation.js";
import {
  IDENTITY_SETTING_LIMITS,
  IDENTITY_SIGNING_KEY_ENV,
  IDENTITY_SIGNING_KID_PATTERN,
  type IdentitySigningKeyConfigurationView,
  type IdentitySigningKeyView,
} from "@regulait/shared";
import path from "node:path";
import {
  ensureInstallKeyFile,
  INSTALL_SECRETS_DIR_ENV,
  loadInstallKeyFile,
  type EnsureInstallKeyFileOutcome,
  type EnsureInstallReceiptKeyDeps,
} from "./receipt-signing-key.js";

/** a retired key verifies for this long after retirement: the longest a delegated token may live */
export const SIGNING_KEY_OVERLAP_SECONDS = IDENTITY_SETTING_LIMITS.delegatedTokenTtlSeconds.max;
/** the JWS `alg` of every issuer signature (Ed25519, RFC 8037) */
export const ISSUER_JWS_ALG = "EdDSA" as const;
/** the system actor of an automatic first activation (no person asked for it) */
const SYSTEM_USER_ID = "00000000-0000-0000-0000-000000000000";
const MAX_KEY_FILE_BYTES = 64 * 1024;
const MAX_CONFIGURED_KEYS = 8;

export interface IssuerPublicJwk {
  kty: "OKP";
  crv: "Ed25519";
  x: string;
}
export interface ConfiguredSigningKey {
  kid: string;
  privateKey: KeyObject;
  publicJwk: IssuerPublicJwk;
}

/** a configuration problem. Its message never contains key material or the file's contents. */
export class IdentitySigningKeyError extends Error {
  constructor(
    readonly code:
      | "signing_key_config_invalid"
      | "signing_key_unavailable"
      | "signing_key_ambiguous"
      | "signing_key_unknown"
      | "signing_key_already_recorded"
      | "signing_key_not_found"
      | "signing_key_already_revoked",
    message: string,
  ) {
    super(message);
  }
}

/**
 * A PKCS#8 PEM block. The armour label is assembled at run time so the source never carries a literal
 * private-key header (a secret scanner reads such a literal as a key; nothing is allowlisted).
 */
const PEM_LABEL = "PRIVATE" + " KEY";
const pkcs8BlockPattern = () => new RegExp(`-----BEGIN ${PEM_LABEL}-----[\\s\\S]*?-----END ${PEM_LABEL}-----`, "g");

let memo: { file: string; mtimeMs: number; size: number; keys: ConfiguredSigningKey[] } | null = null;

/** ADR-0188 S7: the install-generated issuer key's file name in the install secrets directory */
export const INSTALL_IDENTITY_KEY_FILE = "identity-signing-key.pem";
/** `.identity-signing-key.pem.<pid>.<12 hex>.tmp` — a literal, like the receipt key's (CodeQL js/incomplete-sanitization) */
const IDENTITY_TMP_RE = /^\.identity-signing-key\.pem\.\d+\.[0-9a-f]{12}\.tmp$/;

/** `<dir>/identity-signing-key.pem`, or null when no install secrets directory is configured */
export function installIdentityKeyPath(env: NodeJS.ProcessEnv = process.env): string | null {
  const dir = env[INSTALL_SECRETS_DIR_ENV]?.trim();
  return dir ? path.join(path.resolve(dir), INSTALL_IDENTITY_KEY_FILE) : null;
}

/** does the operator variable claim the issuer keys? Then nothing install-generated is read or written. */
export function operatorIdentityKeyConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env[IDENTITY_SIGNING_KEY_ENV]?.trim());
}

async function asConfigured(privateKey: KeyObject, x: string): Promise<ConfiguredSigningKey> {
  const publicJwk: IssuerPublicJwk = { kty: "OKP", crv: "Ed25519", x };
  return { kid: await calculateJwkThumbprint(publicJwk, "sha256"), privateKey, publicJwk };
}

/** the install-generated issuer key, read as strictly as the receipt key (or [] when there is none) */
async function installGeneratedIdentityKeys(env: NodeJS.ProcessEnv): Promise<ConfiguredSigningKey[]> {
  const file = installIdentityKeyPath(env);
  if (!file) return [];
  let parsed;
  try {
    parsed = loadInstallKeyFile(file);
  } catch {
    throw new IdentitySigningKeyError(
      "signing_key_config_invalid",
      `the install-generated issuer key (${INSTALL_IDENTITY_KEY_FILE}) is not a 0600 PKCS#8 Ed25519 key owned by the gateway's user; it is never overwritten`,
    );
  }
  return parsed ? [await asConfigured(parsed.privateKey, parsed.jwk.x)] : [];
}

export type EnsureInstallIdentityKeyOutcome =
  | { outcome: "operator_managed" }
  | { outcome: "not_configured" }
  | (EnsureInstallKeyFileOutcome & { kid?: string });

/**
 * First boot and the installer (`identity-key-init.js`): create the install-generated issuer key when
 * none is configured. Idempotent, create-exclusive, never overwrites, never throws (a failure is an
 * outcome, and the token endpoint stays refused: where a deployment with no key already is).
 */
export async function ensureInstallIdentityKey(
  env: NodeJS.ProcessEnv = process.env,
  deps: EnsureInstallReceiptKeyDeps = {},
): Promise<EnsureInstallIdentityKeyOutcome> {
  if (operatorIdentityKeyConfigured(env)) return { outcome: "operator_managed" };
  const file = installIdentityKeyPath(env);
  if (!file) return { outcome: "not_configured" };
  const r = ensureInstallKeyFile(file, IDENTITY_TMP_RE, deps);
  if (r.outcome === "failed") return r;
  return { ...r, kid: await calculateJwkThumbprint(r.jwk, "sha256") };
}

/** where the issuer's private keys come from: the posture read and the signing-keys view say it */
export async function identitySigningKeyConfiguration(env: NodeJS.ProcessEnv = process.env): Promise<IdentitySigningKeyConfigurationView> {
  const operator = operatorIdentityKeyConfigured(env);
  try {
    const keys = await configuredIdentitySigningKeys(env);
    const configuredKids = keys.map((k) => k.kid);
    if (keys.length === 0) {
      return {
        source: "missing",
        configuredKids,
        note:
          "No issuer signing key, so no token can be issued: engine runners and PDP clients cannot authenticate. Set " +
          `${INSTALL_SECRETS_DIR_ENV} for an install-generated key, or ${IDENTITY_SIGNING_KEY_ENV} for keys you manage.`,
      };
    }
    return operator
      ? { source: "operator_managed", configuredKids, note: `Managed by the operator (${IDENTITY_SIGNING_KEY_ENV}). To rotate, list the next key in that file beside the current one and rotate here.` }
      : {
          source: "install_generated",
          configuredKids,
          note:
            `Generated by the installer or first boot and kept with the install secrets (${INSTALL_IDENTITY_KEY_FILE}, mode 0600). ` +
            `To rotate, set ${IDENTITY_SIGNING_KEY_ENV} to a file holding this key and the next one, restart, and rotate here.`,
        };
  } catch (e) {
    return { source: "invalid", configuredKids: [], note: e instanceof IdentitySigningKeyError ? e.message : "the issuer key configuration is unusable" };
  }
}

/**
 * The private keys this deployment holds, parsed from the file named by
 * `REGULAIT_IDENTITY_SIGNING_KEY`. Empty when the variable is unset (then
 * nothing can be signed, and nothing is). Any malformed content refuses the
 * whole file: a half-read key set would make "which key signs" a guess.
 */
export async function configuredIdentitySigningKeys(env: NodeJS.ProcessEnv = process.env): Promise<ConfiguredSigningKey[]> {
  const file = env[IDENTITY_SIGNING_KEY_ENV]?.trim();
  // ADR-0188 S7: unset → the install-generated key, when the install secrets directory holds one
  if (!file) return installGeneratedIdentityKeys(env);
  const bad = () => new IdentitySigningKeyError("signing_key_config_invalid", `${IDENTITY_SIGNING_KEY_ENV} does not name a readable file of PKCS#8 Ed25519 private keys`);
  let st;
  try {
    st = statSync(file);
  } catch {
    throw bad();
  }
  if (!st.isFile() || st.size > MAX_KEY_FILE_BYTES) throw bad();
  if (memo && memo.file === file && memo.mtimeMs === st.mtimeMs && memo.size === st.size) return memo.keys;
  const text = readFileSync(file, "utf8");
  const blocks = text.match(pkcs8BlockPattern()) ?? [];
  // anything but PKCS#8 private key blocks and whitespace is refused (a public key, a certificate, an encrypted key)
  if (blocks.length === 0 || blocks.length > MAX_CONFIGURED_KEYS || text.replace(pkcs8BlockPattern(), "").trim() !== "") {
    throw bad();
  }
  const keys: ConfiguredSigningKey[] = [];
  for (const pem of blocks) {
    let privateKey: KeyObject;
    try {
      privateKey = createPrivateKey({ key: pem, format: "pem", type: "pkcs8" });
    } catch {
      throw bad();
    }
    if (privateKey.asymmetricKeyType !== "ed25519") throw bad();
    const jwk = createPublicKey(pem).export({ format: "jwk" });
    if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || typeof jwk.x !== "string" || "d" in jwk) throw bad();
    const publicJwk: IssuerPublicJwk = { kty: "OKP", crv: "Ed25519", x: jwk.x };
    const kid = await calculateJwkThumbprint(publicJwk, "sha256");
    if (!IDENTITY_SIGNING_KID_PATTERN.test(kid)) throw bad();
    if (keys.some((k) => k.kid === kid)) throw bad();
    keys.push({ kid, privateKey, publicJwk });
  }
  memo = { file, mtimeMs: st.mtimeMs, size: st.size, keys };
  return keys;
}

export function signingKeyView(r: IdentitySigningKeyRow): IdentitySigningKeyView {
  return {
    kid: r.kid,
    algorithm: "Ed25519",
    publicJwk: { kty: "OKP", crv: "Ed25519", x: r.publicJwk.x, kid: r.kid },
    createdAt: r.createdAt.toISOString(),
    activatedAt: r.activatedAt?.toISOString() ?? null,
    retiredAt: r.retiredAt?.toISOString() ?? null,
    revokedAt: r.revokedAt?.toISOString() ?? null,
  };
}

export async function listIdentitySigningKeys(db: Db): Promise<IdentitySigningKeyView[]> {
  const rows = await db.select().from(identitySigningKeys).orderBy(desc(identitySigningKeys.createdAt), desc(identitySigningKeys.kid));
  return rows.map(signingKeyView);
}

/**
 * Can this key verify a token issued at `iatSeconds`, at `now`? Activated, not
 * revoked, the token issued while the key was the signer (never before its
 * activation, never after its retirement), and a retired key only within the
 * overlap. Anything else refuses (decision 12's rotation/revocation table).
 */
export function signingKeyAccepts(row: IdentitySigningKeyRow, iatSeconds: number, now: Date): boolean {
  if (row.revokedAt || !row.activatedAt) return false;
  const iatMs = iatSeconds * 1000;
  // one second of slack at BOTH ends of the key's stretch: a JWT `iat` is whole seconds and the stamps are
  // not, and a mint racing a rotation (it read the signer, then the rotation committed) can sit a fraction of
  // a second past the retirement stamp. iat and both stamps are all database-clock values (see mint).
  if (iatMs < row.activatedAt.getTime() - 1000) return false;
  if (row.retiredAt) {
    if (iatMs > row.retiredAt.getTime() + 1000) return false;
    if (now.getTime() >= row.retiredAt.getTime() + SIGNING_KEY_OVERLAP_SECONDS * 1000) return false;
  }
  return true;
}

/** the keys a verifier may use right now (database clock unless pinned): activated, unrevoked, and (if retired) inside the overlap */
export async function publishedSigningKeys(db: Db, nowIn?: Date): Promise<IdentitySigningKeyRow[]> {
  const now = nowIn ?? (await databaseNow(db));
  const rows = await db.select().from(identitySigningKeys).where(isNull(identitySigningKeys.revokedAt));
  return rows.filter(
    (r) => r.activatedAt !== null && (r.retiredAt === null || now.getTime() < r.retiredAt.getTime() + SIGNING_KEY_OVERLAP_SECONDS * 1000),
  );
}

/** the RFC 7517 JWKS document of the issuer (decision 5): public halves only */
export function jwksDocument(rows: readonly IdentitySigningKeyRow[]): { keys: Array<IssuerPublicJwk & { kid: string; alg: string; use: "sig" }> } {
  return {
    keys: [...rows]
      .sort((a, b) => (b.activatedAt?.getTime() ?? 0) - (a.activatedAt?.getTime() ?? 0))
      .map((r) => ({ kty: "OKP", crv: "Ed25519", x: r.publicJwk.x, kid: r.kid, alg: ISSUER_JWS_ALG, use: "sig" })),
  };
}

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type DbOrTx = Db | Tx;

async function auditSigningKey(
  db: DbOrTx,
  userId: string,
  detail: {
    phase: "activate" | "rotate" | "revoke";
    kid: string;
    previousKid?: string | null;
    tokensRevoked?: number;
    /** migration 0203: the step-up an admin gave for a rotate or revoke (its kind is always `key_management`) */
    stepUp?: string;
    stepUpKind?: "key_management";
  },
  reason: string,
): Promise<void> {
  await db.insert(auditLog).values({
    userId,
    objectType: "identity_signing_key",
    objectId: null,
    detail,
    effect: "allow",
    ruleId: `identity-signing-key-${detail.phase}`,
    ruleChain: [],
    reason,
  });
}

const stepUpDetail = (method: string | undefined) => (method === undefined ? {} : { stepUp: method, stepUpKind: "key_management" as const });

const isUniqueViolation = (err: unknown): boolean => {
  const e = err as { code?: string; cause?: { code?: string } };
  return e?.code === "23505" || e?.cause?.code === "23505";
};

/** the signer of a new token: its private half and when (database clock) it became the signer */
export interface ActiveIssuerSigner extends ConfiguredSigningKey {
  activatedAt: Date;
}

/**
 * The key that signs now: the active row, whose private half must be
 * configured. With no active row, a FIRST LOAD records and activates the
 * single configured key that was never recorded (audited, system actor);
 * concurrent replicas converge on one (the one-active unique index).
 * `activatedAt` is returned so a minting replica never stamps a token as
 * issued before its key's activation (see `mintDelegatedToken`).
 */
export async function currentIssuerSigner(db: Db, env: NodeJS.ProcessEnv = process.env): Promise<ActiveIssuerSigner> {
  const configured = await configuredIdentitySigningKeys(env);
  const active = async () =>
    (
      await db
        .select()
        .from(identitySigningKeys)
        .where(and(sql`${identitySigningKeys.activatedAt} IS NOT NULL`, isNull(identitySigningKeys.retiredAt), isNull(identitySigningKeys.revokedAt)))
    )[0];
  let row = await active();
  if (!row) {
    const recorded = new Set((await db.select({ kid: identitySigningKeys.kid }).from(identitySigningKeys)).map((r) => r.kid));
    // ONLY a true first load (no key ever recorded) activates automatically. Once any key has been
    // recorded — retired or revoked — choosing the next signer is an admin act (rotate, with a step-up),
    // never a silent SYSTEM activation on the next mint (security review, PR #279).
    if (recorded.size > 0) {
      throw new IdentitySigningKeyError("signing_key_unavailable", "no active issuer signing key: an admin must rotate to a configured key");
    }
    const fresh = configured.filter((k) => !recorded.has(k.kid));
    if (fresh.length === 0) throw new IdentitySigningKeyError("signing_key_unavailable", "no issuer signing key is configured that has not already been used or revoked");
    if (fresh.length > 1) {
      throw new IdentitySigningKeyError("signing_key_ambiguous", "more than one unrecorded issuer key is configured: choose one with POST /v1/identity/signing-keys/rotate");
    }
    const k = fresh[0]!;
    try {
      await db.transaction(async (tx) => {
        // database clock (one `now()` per transaction), like every other lifecycle stamp of this table
        await tx.insert(identitySigningKeys).values({ kid: k.kid, publicJwk: k.publicJwk, createdAt: sql`now()`, activatedAt: sql`now()` });
        await auditSigningKey(tx, SYSTEM_USER_ID, { phase: "activate", kid: k.kid, previousKid: null }, "first issuer signing key activated on first use (ADR-0188 decision 5)");
      });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      // another replica activated a key first: use that one
    }
    row = await active();
    if (!row) throw new IdentitySigningKeyError("signing_key_unavailable", "no active issuer signing key");
  }
  const key = configured.find((k) => k.kid === row!.kid);
  if (!key) throw new IdentitySigningKeyError("signing_key_unavailable", "the active issuer signing key's private half is not configured on this replica");
  return { ...key, activatedAt: row.activatedAt! };
}

/**
 * Rotate: make the configured key `kid` (or the single unrecorded configured
 * key) the signer and retire the current one, in one transaction, audited.
 * A recorded key (retired, revoked, or the current signer) is never
 * re-activated: a key is used for one stretch only.
 */
/** the configured key a rotation activates: `kid`, or the single configured key never recorded */
function pickRotationTarget(configured: readonly ConfiguredSigningKey[], recorded: ReadonlySet<string>, kid: string | undefined): ConfiguredSigningKey {
  if (kid !== undefined) {
    const target = configured.find((k) => k.kid === kid);
    if (!target) throw new IdentitySigningKeyError("signing_key_unknown", "that key id is not among the configured issuer keys");
    if (recorded.has(target.kid)) {
      throw new IdentitySigningKeyError("signing_key_already_recorded", "that key has already been used (or revoked); configure a new key to rotate to");
    }
    return target;
  }
  const fresh = configured.filter((k) => !recorded.has(k.kid));
  if (fresh.length === 0) throw new IdentitySigningKeyError("signing_key_unavailable", "no configured issuer key is available to rotate to");
  if (fresh.length > 1) throw new IdentitySigningKeyError("signing_key_ambiguous", "more than one configured key is available: name one with `kid`");
  return fresh[0]!;
}

/**
 * The key a rotation would activate, decided unlocked BEFORE the step-up: the
 * `key_management` grant is bound to that exact kid, and a rotation that
 * would be refused is refused without spending one. `rotateIdentitySigningKey`
 * decides again under its lock.
 */
export async function resolveRotationTarget(db: Db, kid: string | undefined, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const configured = await configuredIdentitySigningKeys(env);
  const recorded = new Set((await db.select({ kid: identitySigningKeys.kid }).from(identitySigningKeys)).map((r) => r.kid));
  return pickRotationTarget(configured, recorded, kid).kid;
}

/**
 * Revoking `kid` would be refused (unknown, or already revoked): decided
 * unlocked before the step-up, so such a revoke never spends a grant.
 */
export async function revokeRefusal(db: Db, kid: string): Promise<IdentitySigningKeyError | null> {
  const [row] = await db.select({ revokedAt: identitySigningKeys.revokedAt }).from(identitySigningKeys).where(eq(identitySigningKeys.kid, kid));
  if (!row) return new IdentitySigningKeyError("signing_key_not_found", "no such issuer signing key");
  if (row.revokedAt) return new IdentitySigningKeyError("signing_key_already_revoked", "that issuer signing key is already revoked");
  return null;
}

/** migration 0203: an issuer-key rotation is a `key_management` step-up bound to the key rotated TO */
export const signingKeyRotateStepUp = (kid: string) => ({ kind: "key_management" as const, facts: { op: "signing_key_rotate", keyId: kid } });
/** migration 0203: an issuer-key revocation is a `key_management` step-up bound to the key revoked */
export const signingKeyRevokeStepUp = (kid: string) => ({ kind: "key_management" as const, facts: { op: "signing_key_revoke", keyId: kid } });

export async function rotateIdentitySigningKey(
  db: Db,
  opts: { kid?: string | undefined; actorUserId: string; env?: NodeJS.ProcessEnv; stepUp?: string },
): Promise<{ kid: string; previousKid: string | null }> {
  const configured = await configuredIdentitySigningKeys(opts.env ?? process.env);
  return db.transaction(async (tx) => {
    // serialise rotations: the current signer row is locked (and the table, when there is none)
    await tx.execute(sql`LOCK TABLE ${identitySigningKeys} IN SHARE ROW EXCLUSIVE MODE`);
    const recorded = new Set((await tx.select({ kid: identitySigningKeys.kid }).from(identitySigningKeys)).map((r) => r.kid));
    const target = pickRotationTarget(configured, recorded, opts.kid);
    const [previous] = await tx
      .update(identitySigningKeys)
      // database clock, never earlier than activation: a replica whose clock trails
      // the one that activated the key must not trip the lifecycle check
      .set({ retiredAt: sql`GREATEST(now(), ${identitySigningKeys.activatedAt})` })
      .where(and(sql`${identitySigningKeys.activatedAt} IS NOT NULL`, isNull(identitySigningKeys.retiredAt), isNull(identitySigningKeys.revokedAt)))
      .returning({ kid: identitySigningKeys.kid });
    // the new key's stamps are the database's too, the same `now()` the previous key was retired at
    await tx.insert(identitySigningKeys).values({ kid: target.kid, publicJwk: target.publicJwk, createdAt: sql`now()`, activatedAt: sql`now()` });
    await auditSigningKey(
      tx,
      opts.actorUserId,
      { phase: "rotate", kid: target.kid, previousKid: previous?.kid ?? null, ...stepUpDetail(opts.stepUp) },
      previous
        ? `issuer signing key rotated; the previous key stays published for ${SIGNING_KEY_OVERLAP_SECONDS} s so the tokens it signed live to their expiry`
        : "issuer signing key activated by rotation (there was no active key)",
    );
    return { kid: target.kid, previousKid: previous?.kid ?? null };
  });
}

/**
 * Revoke (compromise): the key leaves the JWKS, every unexpired token it
 * signed is revoked, and the verifier refuses its kid. Never undone. A revoked
 * signer leaves no signer: the next signature fails until a rotation.
 */
export async function revokeIdentitySigningKey(db: Db, opts: { kid: string; actorUserId: string; stepUp?: string }): Promise<{ tokensRevoked: number }> {
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(identitySigningKeys).where(eq(identitySigningKeys.kid, opts.kid)).for("update");
    if (!row) throw new IdentitySigningKeyError("signing_key_not_found", "no such issuer signing key");
    if (row.revokedAt) throw new IdentitySigningKeyError("signing_key_already_revoked", "that issuer signing key is already revoked");
    // Timestamps come from the database clock, clamped to each row's own start, so
    // a replica whose clock trails the one that made the key or minted a token can
    // never trip the lifecycle checks and roll the revocation back.
    await tx
      .update(identitySigningKeys)
      .set({ revokedAt: sql`GREATEST(now(), ${identitySigningKeys.createdAt})` })
      .where(eq(identitySigningKeys.kid, opts.kid));
    const revoked = await tx
      .update(issuedTokens)
      .set({ revokedAt: sql`GREATEST(now(), ${issuedTokens.issuedAt})` })
      .where(and(eq(issuedTokens.signingKid, opts.kid), isNull(issuedTokens.revokedAt), sql`${issuedTokens.expiresAt} > now()`))
      .returning({ jti: issuedTokens.jti });
    await auditSigningKey(
      tx,
      opts.actorUserId,
      { phase: "revoke", kid: opts.kid, tokensRevoked: revoked.length, ...stepUpDetail(opts.stepUp) },
      "issuer signing key revoked: every token it signed is refused from now on (ADR-0188 decision 12)",
    );
    return { tokensRevoked: revoked.length };
  });
}
