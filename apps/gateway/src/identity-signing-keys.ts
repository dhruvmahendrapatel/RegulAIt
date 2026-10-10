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
 *  - rotate (admin, `identity_manage` step-up): the named configured key
 *    becomes the signer and the previous one is RETIRED. Rotation is not
 *    revocation (decision 12): a retired key stays in the JWKS for
 *    `SIGNING_KEY_OVERLAP_SECONDS` (the longest a token can live), so every
 *    token it signed verifies until it expires; after that the verifier
 *    refuses it ("a key retired past its overlap").
 *  - revoke (admin, `identity_manage` step-up): compromise. Leaves the JWKS
 *    at once, every unexpired token it signed is revoked in `issued_tokens`,
 *    and the verifier refuses its `kid` from then on. Never undone (trigger).
 *
 * Open source first (ADR-0176): the key parsing is Node's own `crypto`
 * (`createPrivateKey`/`createPublicKey`), the thumbprint and every JWS are
 * `jose` 6.2.12 (already exact-pinned). No cryptography is written here.
 */
import { createPrivateKey, createPublicKey, type KeyObject } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { calculateJwkThumbprint } from "jose";
import { and, auditLog, desc, eq, gt, identitySigningKeys, isNull, issuedTokens, sql, type Db, type IdentitySigningKeyRow } from "@regulait/db";
import {
  IDENTITY_SETTING_LIMITS,
  IDENTITY_SIGNING_KEY_ENV,
  IDENTITY_SIGNING_KID_PATTERN,
  type IdentitySigningKeyView,
} from "@regulait/shared";

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

let memo: { file: string; mtimeMs: number; size: number; keys: ConfiguredSigningKey[] } | null = null;

/**
 * The private keys this deployment holds, parsed from the file named by
 * `REGULAIT_IDENTITY_SIGNING_KEY`. Empty when the variable is unset (then
 * nothing can be signed, and nothing is). Any malformed content refuses the
 * whole file: a half-read key set would make "which key signs" a guess.
 */
export async function configuredIdentitySigningKeys(env: NodeJS.ProcessEnv = process.env): Promise<ConfiguredSigningKey[]> {
  const file = env[IDENTITY_SIGNING_KEY_ENV]?.trim();
  if (!file) return [];
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
  const blocks = text.match(/-----BEGIN PRIVATE KEY-----[\s\S]*?-----END PRIVATE KEY-----/g) ?? [];
  // anything but PKCS#8 private key blocks and whitespace is refused (a public key, a certificate, an encrypted key)
  if (blocks.length === 0 || blocks.length > MAX_CONFIGURED_KEYS || text.replace(/-----BEGIN PRIVATE KEY-----[\s\S]*?-----END PRIVATE KEY-----/g, "").trim() !== "") {
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
  // one second of slack: a JWT `iat` is whole seconds and the activation stamp is not
  if (iatMs < row.activatedAt.getTime() - 1000) return false;
  if (row.retiredAt) {
    if (iatMs > row.retiredAt.getTime()) return false;
    if (now.getTime() >= row.retiredAt.getTime() + SIGNING_KEY_OVERLAP_SECONDS * 1000) return false;
  }
  return true;
}

/** the keys a verifier may use right now: activated, unrevoked, and (if retired) inside the overlap */
export async function publishedSigningKeys(db: Db, now: Date = new Date()): Promise<IdentitySigningKeyRow[]> {
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
  detail: { phase: "activate" | "rotate" | "revoke"; kid: string; previousKid?: string | null; tokensRevoked?: number },
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

const isUniqueViolation = (err: unknown): boolean => {
  const e = err as { code?: string; cause?: { code?: string } };
  return e?.code === "23505" || e?.cause?.code === "23505";
};

/**
 * The key that signs now: the active row, whose private half must be
 * configured. With no active row, a FIRST LOAD records and activates the
 * single configured key that was never recorded (audited, system actor);
 * concurrent replicas converge on one (the one-active unique index).
 */
export async function currentIssuerSigner(db: Db, env: NodeJS.ProcessEnv = process.env): Promise<ConfiguredSigningKey> {
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
    const fresh = configured.filter((k) => !recorded.has(k.kid));
    if (fresh.length === 0) throw new IdentitySigningKeyError("signing_key_unavailable", "no issuer signing key is configured that has not already been used or revoked");
    if (fresh.length > 1) {
      throw new IdentitySigningKeyError("signing_key_ambiguous", "more than one unrecorded issuer key is configured: choose one with POST /v1/identity/signing-keys/rotate");
    }
    const k = fresh[0]!;
    try {
      await db.transaction(async (tx) => {
        const now = new Date();
        await tx.insert(identitySigningKeys).values({ kid: k.kid, publicJwk: k.publicJwk, createdAt: now, activatedAt: now });
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
  return key;
}

/**
 * Rotate: make the configured key `kid` (or the single unrecorded configured
 * key) the signer and retire the current one, in one transaction, audited.
 * A recorded key (retired, revoked, or the current signer) is never
 * re-activated: a key is used for one stretch only.
 */
export async function rotateIdentitySigningKey(
  db: Db,
  opts: { kid?: string | undefined; actorUserId: string; env?: NodeJS.ProcessEnv },
): Promise<{ kid: string; previousKid: string | null }> {
  const configured = await configuredIdentitySigningKeys(opts.env ?? process.env);
  return db.transaction(async (tx) => {
    // serialise rotations: the current signer row is locked (and the table, when there is none)
    await tx.execute(sql`LOCK TABLE ${identitySigningKeys} IN SHARE ROW EXCLUSIVE MODE`);
    const recorded = new Set((await tx.select({ kid: identitySigningKeys.kid }).from(identitySigningKeys)).map((r) => r.kid));
    let target: ConfiguredSigningKey | undefined;
    if (opts.kid !== undefined) {
      target = configured.find((k) => k.kid === opts.kid);
      if (!target) throw new IdentitySigningKeyError("signing_key_unknown", "that key id is not among the configured issuer keys");
      if (recorded.has(target.kid)) {
        throw new IdentitySigningKeyError("signing_key_already_recorded", "that key has already been used (or revoked); configure a new key to rotate to");
      }
    } else {
      const fresh = configured.filter((k) => !recorded.has(k.kid));
      if (fresh.length === 0) throw new IdentitySigningKeyError("signing_key_unavailable", "no configured issuer key is available to rotate to");
      if (fresh.length > 1) throw new IdentitySigningKeyError("signing_key_ambiguous", "more than one configured key is available: name one with `kid`");
      target = fresh[0]!;
    }
    const now = new Date();
    const [previous] = await tx
      .update(identitySigningKeys)
      .set({ retiredAt: now })
      .where(and(sql`${identitySigningKeys.activatedAt} IS NOT NULL`, isNull(identitySigningKeys.retiredAt), isNull(identitySigningKeys.revokedAt)))
      .returning({ kid: identitySigningKeys.kid });
    await tx.insert(identitySigningKeys).values({ kid: target.kid, publicJwk: target.publicJwk, createdAt: now, activatedAt: now });
    await auditSigningKey(
      tx,
      opts.actorUserId,
      { phase: "rotate", kid: target.kid, previousKid: previous?.kid ?? null },
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
export async function revokeIdentitySigningKey(db: Db, opts: { kid: string; actorUserId: string }): Promise<{ tokensRevoked: number }> {
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(identitySigningKeys).where(eq(identitySigningKeys.kid, opts.kid)).for("update");
    if (!row) throw new IdentitySigningKeyError("signing_key_not_found", "no such issuer signing key");
    if (row.revokedAt) throw new IdentitySigningKeyError("signing_key_already_revoked", "that issuer signing key is already revoked");
    const now = new Date();
    await tx.update(identitySigningKeys).set({ revokedAt: now }).where(eq(identitySigningKeys.kid, opts.kid));
    const revoked = await tx
      .update(issuedTokens)
      .set({ revokedAt: now })
      .where(and(eq(issuedTokens.signingKid, opts.kid), isNull(issuedTokens.revokedAt), gt(issuedTokens.expiresAt, now)))
      .returning({ jti: issuedTokens.jti });
    await auditSigningKey(
      tx,
      opts.actorUserId,
      { phase: "revoke", kid: opts.kid, tokensRevoked: revoked.length },
      "issuer signing key revoked: every token it signed is refused from now on (ADR-0188 decision 12)",
    );
    return { tokensRevoked: revoked.length };
  });
}
