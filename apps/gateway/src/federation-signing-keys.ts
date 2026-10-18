/**
 * ADR-0195 SD2b — THE CLOUD FEDERATION SIGNER: RegulAIt's RS256 OIDC issuer for cloud workload identity
 * federation (AWS AssumeRoleWithWebIdentity, GCP workload identity federation, Entra federated credentials).
 *
 * ISSUER: `<REGULAIT_PUBLIC_URL>/federation`, separate from the Ed25519 workload identity issuer (ADR-0188), with
 * its own discovery document and JWKS (`FEDERATION_DISCOVERY_PATH`, `FEDERATION_JWKS_PATH`). The clouds fetch both
 * to verify a token. A federation token therefore never verifies at RegulAIt's own delegated-token verifier (other
 * `iss`, other keys, other algorithm), and an Ed25519 issuer token never verifies at a cloud.
 *
 * KEYS (`federation_signing_keys`, migration 0205): generated here (Node `crypto`, RSA 2048, e = 65537), `kid` the
 * RFC 7638 thumbprint (`jose`); the PKCS#8 private half is a data-key envelope listed in CIPHERTEXT_COLUMNS, so the
 * data-key re-encryption walk covers it, and it is destroyed in the same update that retires or revokes the key.
 *
 * LIFECYCLE (every change audited, `object_type` `federation_signing_key`):
 *  - generate (admin, free): a PENDING key. It signs nothing and is not published. At most one pending key.
 *  - activate with no active key = TURNING FEDERATION ON: a `settings_relax` step-up `{op: "federation_enable",
 *    keyId}` (ADR-0180: off by default, enabling is a relaxation).
 *  - activate with an active key = ROTATION: a `key_management` step-up `{op: "federation_key_rotate", keyId}`; the
 *    previous key is retired and stays published for FEDERATION_KEY_OVERLAP_SECONDS so the tokens it signed verify
 *    until they expire.
 *  - revoke (compromise): a `key_management` step-up `{op: "federation_key_revoke", keyId}`; the key leaves the JWKS
 *    at once. Revoking the active key turns federation off.
 *  - disable (free, a tightening): the active key is retired; federation is off until an admin enables it again.
 * The step-up decision is made on an unlocked read and the write re-checks under the table lock (ADR-0186 A): when
 * the active key moved in between, nothing is written (409 `changed_concurrently`).
 *
 * TOKENS: RS256, `iss` the federation issuer, `sub` the source (`regulait:discovery-source:<id>`) or RegulAIt's
 * own AWS principal, `aud` exactly one audience the caller is bound to, `exp` FEDERATION_TOKEN_TTL_SECONDS after
 * `iat`, random `jti`. Minting refuses an audience the credential does not name.
 *
 * Open source first (ADR-0176): key generation and parsing are Node's `crypto`; the thumbprint and the JWS are
 * `jose` 6.2.12 (already exact-pinned). No cryptography is written here.
 */
import { createPrivateKey, generateKeyPairSync, randomUUID } from "node:crypto";
import { calculateJwkThumbprint, SignJWT } from "jose";
import { and, auditLog, desc, eq, federationSigningKeys, isNull, sql, type Db, type FederationSigningKeyRow } from "@regulait/db";
import {
  FEDERATION_AUDIENCES,
  FEDERATION_AWS_PRINCIPAL_SUBJECT,
  FEDERATION_ISSUER_PATH,
  FEDERATION_JWKS_PATH,
  FEDERATION_KEY_OVERLAP_SECONDS,
  FEDERATION_TOKEN_TTL_SECONDS,
  AWS_PRINCIPAL_ROLE_ENV,
  federationKeyState,
  federationSourceSubject,
  type FederationKeyView,
  type FederationStatusView,
} from "@regulait/shared";
import { databaseNow } from "./db-clock.js";
import { identityIssuer } from "./oauth/common.js";
import { decryptSecret, encryptSecret } from "./secrets.js";

export const FEDERATION_JWS_ALG = "RS256" as const;
const RSA_MODULUS_BITS = 2048;

export type FederationErrorCode =
  | "federation_off"
  | "federation_issuer_unset"
  | "federation_key_not_found"
  | "federation_key_not_pending"
  | "federation_key_pending_exists"
  | "federation_key_already_revoked"
  | "federation_key_unreadable"
  | "federation_audience_refused"
  | "federation_principal_unset"
  | "data_key_unavailable"
  | "changed_concurrently";

/** a federation refusal. Its message never carries key material. */
export class FederationError extends Error {
  constructor(
    readonly code: FederationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "FederationError";
  }
}

/** the HTTP status a refusal maps to */
export function federationErrorStatus(code: FederationErrorCode): number {
  if (code === "federation_key_not_found") return 404;
  if (code === "federation_issuer_unset" || code === "data_key_unavailable" || code === "federation_key_unreadable") return 503;
  return 409;
}

/** `<REGULAIT_PUBLIC_URL>/federation`, or null when the public URL is unset or invalid (fail closed) */
export function federationIssuer(env: NodeJS.ProcessEnv = process.env): string | null {
  const base = identityIssuer(env);
  return base ? `${base.replace(/\/+$/, "")}${FEDERATION_ISSUER_PATH}` : null;
}

/** RegulAIt's own AWS principal (an IAM role trusting the federation issuer for FEDERATION_AWS_PRINCIPAL_SUBJECT) */
export function awsPrincipalRoleArn(env: NodeJS.ProcessEnv = process.env): string | null {
  const v = env[AWS_PRINCIPAL_ROLE_ENV]?.trim();
  if (!v) return null;
  const parts = v.split(":");
  // arn:aws[-partition]:iam::<12 digits>:role/<name>; anything else is treated as unset (fail closed)
  if (parts.length !== 6 || parts[0] !== "arn" || !parts[1]!.startsWith("aws") || parts[2] !== "iam" || parts[3] !== "") return null;
  if (!/^[0-9]{12}$/.test(parts[4]!) || !parts[5]!.startsWith("role/") || parts[5]!.length > 520) return null;
  return v;
}

export interface FederationPublicJwk {
  kty: "RSA";
  n: string;
  e: string;
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

/** is this key in the JWKS at `now` (database clock): active, or retired inside the overlap; never revoked */
export function isPublished(row: Pick<FederationSigningKeyRow, "activatedAt" | "retiredAt" | "revokedAt">, now: Date): boolean {
  if (row.revokedAt || !row.activatedAt) return false;
  if (!row.retiredAt) return true;
  return now.getTime() - row.retiredAt.getTime() < FEDERATION_KEY_OVERLAP_SECONDS * 1000;
}

export function federationKeyView(row: FederationSigningKeyRow, now: Date): FederationKeyView {
  return {
    kid: row.kid,
    algorithm: "RS256",
    state: federationKeyState(row),
    published: isPublished(row, now),
    createdAt: row.createdAt.toISOString(),
    activatedAt: iso(row.activatedAt),
    retiredAt: iso(row.retiredAt),
    revokedAt: iso(row.revokedAt),
  };
}

/** the public halves the federation JWKS serves now (database clock) */
export async function publishedFederationKeys(db: Db): Promise<FederationSigningKeyRow[]> {
  return db
    .select()
    .from(federationSigningKeys)
    .where(
      and(
        sql`${federationSigningKeys.activatedAt} IS NOT NULL`,
        isNull(federationSigningKeys.revokedAt),
        sql`(${federationSigningKeys.retiredAt} IS NULL OR ${federationSigningKeys.retiredAt} > now() - make_interval(secs => ${FEDERATION_KEY_OVERLAP_SECONDS}))`,
      ),
    )
    .orderBy(desc(federationSigningKeys.activatedAt));
}

/** the JWKS document: public RSA members only (`kty`, `n`, `e`), never a private member */
export function federationJwks(rows: readonly Pick<FederationSigningKeyRow, "kid" | "publicJwk">[]): {
  keys: Array<FederationPublicJwk & { kid: string; alg: typeof FEDERATION_JWS_ALG; use: "sig" }>;
} {
  return { keys: rows.map((r) => ({ kty: "RSA", n: r.publicJwk.n, e: r.publicJwk.e, kid: r.kid, alg: FEDERATION_JWS_ALG, use: "sig" })) };
}

/** OpenID Connect Discovery 1.0 metadata: what AWS IAM, GCP and Entra read to find the JWKS */
export function federationDiscoveryDocument(issuer: string): Record<string, unknown> {
  const origin = issuer.slice(0, issuer.length - FEDERATION_ISSUER_PATH.length);
  return {
    issuer,
    jwks_uri: `${origin}${FEDERATION_JWKS_PATH}`,
    response_types_supported: ["id_token"],
    subject_types_supported: ["public"],
    id_token_signing_alg_values_supported: [FEDERATION_JWS_ALG],
    claims_supported: ["iss", "sub", "aud", "iat", "nbf", "exp", "jti"],
  };
}

export async function federationStatus(db: Db, env: NodeJS.ProcessEnv = process.env): Promise<FederationStatusView> {
  const now = await databaseNow(db);
  const rows = await db.select().from(federationSigningKeys).orderBy(desc(federationSigningKeys.createdAt));
  const issuer = federationIssuer(env);
  const roleArn = awsPrincipalRoleArn(env);
  return {
    enabled: rows.some((r) => federationKeyState(r) === "active"),
    issuer,
    jwksUri: issuer ? `${issuer.slice(0, issuer.length - FEDERATION_ISSUER_PATH.length)}${FEDERATION_JWKS_PATH}` : null,
    tokenTtlSeconds: FEDERATION_TOKEN_TTL_SECONDS,
    keys: rows.map((r) => federationKeyView(r, now)),
    awsPrincipal: { configured: roleArn !== null, roleArn, subject: FEDERATION_AWS_PRINCIPAL_SUBJECT },
    subjectFormat: federationSourceSubject("<sourceId>"),
    audiences: {
      aws: FEDERATION_AUDIENCES.aws,
      azure: FEDERATION_AUDIENCES.azure,
      gcp: `${FEDERATION_AUDIENCES.gcpPrefix}<projectNumber>/locations/global/workloadIdentityPools/<pool>/providers/<provider>`,
    },
  };
}

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

async function auditFederation(
  db: Db | Tx,
  userId: string,
  objectId: string | null,
  ruleId: string,
  reason: string,
  detail: Record<string, unknown>,
): Promise<void> {
  await db.insert(auditLog).values({
    userId,
    objectType: "federation_signing_key",
    objectId,
    detail,
    effect: "allow",
    ruleId,
    ruleChain: [],
    reason,
  });
}

/** a fresh RSA key: its public JWK, RFC 7638 kid, and the PKCS#8 PEM of its private half */
export async function newFederationKeyMaterial(): Promise<{ kid: string; publicJwk: FederationPublicJwk; pkcs8: string }> {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: RSA_MODULUS_BITS, publicExponent: 0x10001 });
  const jwk = publicKey.export({ format: "jwk" }) as { kty?: string; n?: string; e?: string };
  if (jwk.kty !== "RSA" || !jwk.n || jwk.e !== "AQAB") throw new Error("federation: unexpected RSA public key shape");
  const publicJwk: FederationPublicJwk = { kty: "RSA", n: jwk.n, e: jwk.e };
  return { kid: await calculateJwkThumbprint(publicJwk, "sha256"), publicJwk, pkcs8: privateKey.export({ format: "pem", type: "pkcs8" }).toString() };
}

/** generate a PENDING key (signs nothing, unpublished). Free: it turns nothing on. At most one pending key. */
export async function generateFederationKey(db: Db, opts: { dataKey: string | undefined; actorUserId: string }): Promise<FederationKeyView> {
  if (!opts.dataKey) throw new FederationError("data_key_unavailable", "the data key is not configured, so a federation private key cannot be stored");
  const material = await newFederationKeyMaterial();
  const ciphertext = encryptSecret(opts.dataKey, material.pkcs8);
  const row = await db.transaction(async (tx) => {
    await tx.execute(sql`LOCK TABLE ${federationSigningKeys} IN SHARE ROW EXCLUSIVE MODE`);
    const [pending] = await tx
      .select({ kid: federationSigningKeys.kid })
      .from(federationSigningKeys)
      .where(and(isNull(federationSigningKeys.activatedAt), isNull(federationSigningKeys.revokedAt)));
    if (pending) throw new FederationError("federation_key_pending_exists", "a generated key is already waiting to be activated; activate or revoke it first");
    const [inserted] = await tx
      .insert(federationSigningKeys)
      .values({ kid: material.kid, publicJwk: material.publicJwk, privateKeyCiphertext: ciphertext, createdBy: opts.actorUserId, createdAt: sql`now()` })
      .returning();
    await auditFederation(tx, opts.actorUserId, inserted!.id, "federation-key-generated", "federation signing key generated (pending: it signs nothing until activated)", {
      kid: material.kid,
      algorithm: FEDERATION_JWS_ALG,
    });
    return inserted!;
  });
  return federationKeyView(row, row.createdAt);
}

/** the step-up an activation needs, decided on an unlocked read (no grant is spent for a refused activation) */
export async function activationStepUp(
  db: Db,
  kid: string,
): Promise<{ args: { kind: "settings_relax" | "key_management"; facts: { op: string; keyId: string } }; previousKid: string | null }> {
  const rows = await db.select().from(federationSigningKeys);
  const target = rows.find((r) => r.kid === kid);
  if (!target) throw new FederationError("federation_key_not_found", "no such federation signing key");
  if (federationKeyState(target) !== "pending") throw new FederationError("federation_key_not_pending", "only a generated, never-activated key can be activated");
  const active = rows.find((r) => federationKeyState(r) === "active") ?? null;
  return active
    ? { args: { kind: "key_management", facts: { op: "federation_key_rotate", keyId: kid } }, previousKid: active.kid }
    : { args: { kind: "settings_relax", facts: { op: "federation_enable", keyId: kid } }, previousKid: null };
}

/** the step-up a revocation needs, after the unlocked checks */
export async function revocationStepUp(db: Db, kid: string): Promise<{ kind: "key_management"; facts: { op: string; keyId: string } }> {
  const [row] = await db.select().from(federationSigningKeys).where(eq(federationSigningKeys.kid, kid));
  if (!row) throw new FederationError("federation_key_not_found", "no such federation signing key");
  if (row.revokedAt) throw new FederationError("federation_key_already_revoked", "that federation signing key is already revoked");
  return { kind: "key_management", facts: { op: "federation_key_revoke", keyId: kid } };
}

/**
 * Activate `kid`: turn federation on (no active key) or rotate (an active key, retired here with its private half
 * destroyed). `expectPreviousKid` is the active key the step-up decision saw; if it moved, nothing is written.
 */
export async function activateFederationKey(
  db: Db,
  opts: { kid: string; expectPreviousKid: string | null; actorUserId: string; stepUp: string; stepUpKind: "settings_relax" | "key_management" },
): Promise<{ kid: string; previousKid: string | null; enabled: true }> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`LOCK TABLE ${federationSigningKeys} IN SHARE ROW EXCLUSIVE MODE`);
    const rows = await tx.select().from(federationSigningKeys);
    const target = rows.find((r) => r.kid === opts.kid);
    if (!target) throw new FederationError("federation_key_not_found", "no such federation signing key");
    if (federationKeyState(target) !== "pending") throw new FederationError("federation_key_not_pending", "only a generated, never-activated key can be activated");
    const active = rows.find((r) => federationKeyState(r) === "active") ?? null;
    if ((active?.kid ?? null) !== opts.expectPreviousKid) {
      throw new FederationError("changed_concurrently", "the active federation key changed while the request was checked; nothing was written");
    }
    if (active) {
      await tx
        .update(federationSigningKeys)
        .set({ retiredAt: sql`GREATEST(now(), ${federationSigningKeys.activatedAt})`, privateKeyCiphertext: null })
        .where(eq(federationSigningKeys.id, active.id));
    }
    await tx
      .update(federationSigningKeys)
      .set({ activatedAt: sql`GREATEST(now(), ${federationSigningKeys.createdAt})` })
      .where(eq(federationSigningKeys.id, target.id));
    const enabling = active === null;
    await auditFederation(
      tx,
      opts.actorUserId,
      target.id,
      enabling ? "federation-enabled" : "federation-key-rotated",
      enabling
        ? "cloud workload identity federation turned on: federated discovery credentials can now mint tokens (ADR-0195 SD2b)"
        : `federation signing key rotated; the previous key stays published for ${FEDERATION_KEY_OVERLAP_SECONDS} s so the tokens it signed live to their expiry`,
      { kid: opts.kid, previousKid: active?.kid ?? null, stepUp: opts.stepUp, stepUpKind: opts.stepUpKind },
    );
    return { kid: opts.kid, previousKid: active?.kid ?? null, enabled: true as const };
  });
}

/** compromise: the key leaves the JWKS at once and its private half is destroyed. Revoking the active key turns federation off. */
export async function revokeFederationKey(db: Db, opts: { kid: string; actorUserId: string; stepUp: string }): Promise<{ kid: string; wasActive: boolean; enabled: boolean }> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`LOCK TABLE ${federationSigningKeys} IN SHARE ROW EXCLUSIVE MODE`);
    const [row] = await tx.select().from(federationSigningKeys).where(eq(federationSigningKeys.kid, opts.kid));
    if (!row) throw new FederationError("federation_key_not_found", "no such federation signing key");
    if (row.revokedAt) throw new FederationError("federation_key_already_revoked", "that federation signing key is already revoked");
    const wasActive = federationKeyState(row) === "active";
    await tx
      .update(federationSigningKeys)
      .set({ revokedAt: sql`GREATEST(now(), ${federationSigningKeys.createdAt})`, privateKeyCiphertext: null })
      .where(eq(federationSigningKeys.id, row.id));
    await auditFederation(
      tx,
      opts.actorUserId,
      row.id,
      "federation-key-revoked",
      wasActive
        ? "federation signing key revoked (compromise): it left the JWKS at once and federation is off until an admin enables it with a new key"
        : "federation signing key revoked: it left the JWKS at once",
      { kid: opts.kid, wasActive, stepUp: opts.stepUp, stepUpKind: "key_management" },
    );
    const [still] = await tx
      .select({ kid: federationSigningKeys.kid })
      .from(federationSigningKeys)
      .where(and(sql`${federationSigningKeys.activatedAt} IS NOT NULL`, isNull(federationSigningKeys.retiredAt), isNull(federationSigningKeys.revokedAt)));
    return { kid: opts.kid, wasActive, enabled: still !== undefined };
  });
}

/** turn federation off (a tightening, free): the active key is retired and its private half destroyed */
export async function disableFederation(db: Db, opts: { actorUserId: string }): Promise<{ retiredKid: string }> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`LOCK TABLE ${federationSigningKeys} IN SHARE ROW EXCLUSIVE MODE`);
    const [active] = await tx
      .select()
      .from(federationSigningKeys)
      .where(and(sql`${federationSigningKeys.activatedAt} IS NOT NULL`, isNull(federationSigningKeys.retiredAt), isNull(federationSigningKeys.revokedAt)));
    if (!active) throw new FederationError("federation_off", "federation is already off");
    await tx
      .update(federationSigningKeys)
      .set({ retiredAt: sql`GREATEST(now(), ${federationSigningKeys.activatedAt})`, privateKeyCiphertext: null })
      .where(eq(federationSigningKeys.id, active.id));
    await auditFederation(tx, opts.actorUserId, active.id, "federation-disabled", "cloud workload identity federation turned off: federated discovery credentials cannot mint tokens", {
      kid: active.kid,
    });
    return { retiredKid: active.kid };
  });
}

/**
 * Mint one federation token. Refuses when federation is off, the issuer is unset or the data key cannot open the
 * active key. The caller has already bound `audience` (see `federationTokenMinter`).
 */
export async function mintFederationToken(
  db: Db,
  opts: { dataKey: string | undefined; subject: string; audience: string; env?: NodeJS.ProcessEnv; now?: Date },
): Promise<string> {
  const issuer = federationIssuer(opts.env ?? process.env);
  if (!issuer) throw new FederationError("federation_issuer_unset", "the federation issuer needs REGULAIT_PUBLIC_URL (this deployment's https origin)");
  const [active] = await db
    .select()
    .from(federationSigningKeys)
    .where(and(sql`${federationSigningKeys.activatedAt} IS NOT NULL`, isNull(federationSigningKeys.retiredAt), isNull(federationSigningKeys.revokedAt)));
  if (!active || !active.privateKeyCiphertext) throw new FederationError("federation_off", "cloud workload identity federation is off: an admin must enable it (ADR-0195 SD2b)");
  if (!opts.dataKey) throw new FederationError("data_key_unavailable", "the data key is not configured, so the federation key cannot be opened");
  let pkcs8: string;
  try {
    pkcs8 = decryptSecret(opts.dataKey, active.privateKeyCiphertext);
  } catch {
    throw new FederationError("federation_key_unreadable", "the active federation key does not open under the current data key");
  }
  return signFederationToken({ kid: active.kid, pkcs8 }, { issuer, subject: opts.subject, audience: opts.audience, ...(opts.now ? { now: opts.now } : {}) });
}

/** sign one federation token with a key's PKCS#8 private half (no database): RS256, at most FEDERATION_TOKEN_TTL_SECONDS */
export async function signFederationToken(
  key: { kid: string; pkcs8: string },
  claims: { issuer: string; subject: string; audience: string; now?: Date },
): Promise<string> {
  let privateKey;
  try {
    privateKey = createPrivateKey(key.pkcs8);
  } catch {
    throw new FederationError("federation_key_unreadable", "the federation key is not a readable private key");
  }
  if (privateKey.asymmetricKeyType !== "rsa" || (privateKey.asymmetricKeyDetails?.modulusLength ?? 0) < RSA_MODULUS_BITS) {
    throw new FederationError("federation_key_unreadable", "the federation key is not an RSA key of at least 2048 bits");
  }
  const iat = Math.floor((claims.now ?? new Date()).getTime() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: FEDERATION_JWS_ALG, kid: key.kid, typ: "JWT" })
    .setIssuer(claims.issuer)
    .setSubject(claims.subject)
    .setAudience(claims.audience)
    .setIssuedAt(iat)
    .setNotBefore(iat)
    .setExpirationTime(iat + FEDERATION_TOKEN_TTL_SECONDS)
    .setJti(randomUUID())
    .sign(privateKey);
}

/** a token supplier bound to one subject and the audiences its credential names; anything else is refused */
export function federationTokenMinter(
  db: Db,
  opts: { dataKey: string | undefined; subject: string; allowedAudiences: readonly string[]; env?: NodeJS.ProcessEnv },
): (audience: string) => Promise<string> {
  const allowed = new Set(opts.allowedAudiences);
  return async (audience: string) => {
    if (!allowed.has(audience)) {
      throw new FederationError("federation_audience_refused", "a federation token was asked for an audience this credential does not name");
    }
    return mintFederationToken(db, { dataKey: opts.dataKey, subject: opts.subject, audience, ...(opts.env ? { env: opts.env } : {}) });
  };
}
