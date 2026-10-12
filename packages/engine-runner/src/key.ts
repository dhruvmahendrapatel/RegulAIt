/**
 * ADR-0188 slice S7 (OWNER DECISION 8) — THE RUNNER'S KEY, which replaced the
 * `rge_` bearer token.
 *
 * The runner generates an Ed25519 key pair itself (Node's own `crypto`), keeps
 * the PRIVATE half only on its own state volume (`FileRunnerKeyStore`: 0600,
 * written durably, never logged) in one string form (`rgek_` + base64url of the
 * PKCS#8 DER), and registers only the PUBLIC half. The key signs the
 * `private_key_jwt` client assertion and every DPoP proof (both through
 * `oauth4webapi`), a re-enrolment's supersede proof and a rotation proof (both
 * through `jose`). Nothing secret ever leaves the runner, and nothing the
 * gateway stores could authenticate as it.
 *
 * Open source first (ADR-0176): Node's `crypto` (key generation, WebCrypto
 * import), `jose` 6.2.12 (JWS, RFC 7638 thumbprints) and `oauth4webapi` 3.8.8
 * (the OAuth client side), the versions the gateway already pins. No
 * cryptography is written here.
 */
import { createPrivateKey, generateKeyPairSync, webcrypto, type KeyObject } from "node:crypto";
import { calculateJwkThumbprint, SignJWT, type JWK } from "jose";
import type { CryptoKeyPair } from "oauth4webapi";
import { ENGINE_RUNNER_KEY_PREFIX, JWK_THUMBPRINT_URI_PREFIX, KEY_ROTATION_PROOF_TYP, RUNNER_SUPERSEDE_PROOF_TYP } from "@regulait/shared";

/** a runner key secret: `rgek_` + base64url (no padding) of an Ed25519 PKCS#8 DER (48 bytes = 64 characters) */
export function isRunnerKeySecret(v: unknown): v is string {
  if (typeof v !== "string" || !v.startsWith(ENGINE_RUNNER_KEY_PREFIX)) return false;
  const body = v.slice(ENGINE_RUNNER_KEY_PREFIX.length);
  return body.length >= 60 && body.length <= 200 && [...body].every((c) => (c >= "A" && c <= "Z") || (c >= "a" && c <= "z") || (c >= "0" && c <= "9") || c === "-" || c === "_");
}

/** a NEW runner key (Ed25519), as the one string the runner keeps on its own volume */
export function generateRunnerSecret(): string {
  const der = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "der" });
  return ENGINE_RUNNER_KEY_PREFIX + Buffer.from(der).toString("base64url");
}

export interface RunnerKeyMaterial {
  /** Node's key object (jose signs with it) */
  privateKey: KeyObject;
  /** the PUBLIC half as registered (RFC 7638 members only) */
  publicJwk: { kty: "OKP"; crv: "Ed25519"; x: string };
  /** its RFC 7638 SHA-256 thumbprint */
  jkt: string;
  /** the RFC 9278 client id the runner authenticates as (it needs to hold nothing but this key) */
  clientId: string;
  /** the WebCrypto pair `oauth4webapi` signs DPoP proofs and client assertions with */
  cryptoKeyPair: CryptoKeyPair;
}

const cache = new Map<string, Promise<RunnerKeyMaterial>>();

/** the key material of a runner key secret (throws on anything that is not one) */
export function runnerKeyMaterial(secret: string): Promise<RunnerKeyMaterial> {
  let m = cache.get(secret);
  if (!m) {
    m = load(secret);
    cache.set(secret, m);
    m.catch(() => cache.delete(secret));
  }
  return m;
}

async function load(secret: string): Promise<RunnerKeyMaterial> {
  if (!isRunnerKeySecret(secret)) throw new Error("not a runner key");
  const der = Buffer.from(secret.slice(ENGINE_RUNNER_KEY_PREFIX.length), "base64url");
  const privateKey = createPrivateKey({ key: der, format: "der", type: "pkcs8" });
  if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("a runner key is Ed25519");
  // the PUBLIC members only (the private export also carries `d`, which is never kept or sent)
  const pub = privateKey.export({ format: "jwk" });
  if (pub.kty !== "OKP" || pub.crv !== "Ed25519" || typeof pub.x !== "string") throw new Error("a runner key is Ed25519");
  const publicJwk = { kty: "OKP" as const, crv: "Ed25519" as const, x: pub.x };
  const jkt = await calculateJwkThumbprint(publicJwk, "sha256");
  const cryptoKeyPair: CryptoKeyPair = {
    privateKey: (await webcrypto.subtle.importKey("pkcs8", der, { name: "Ed25519" }, false, ["sign"])) as unknown as CryptoKeyPair["privateKey"],
    // oauth4webapi embeds the public key in each DPoP proof, so it must be extractable (a public key is not secret)
    publicKey: (await webcrypto.subtle.importKey("jwk", publicJwk, { name: "Ed25519" }, true, ["verify"])) as unknown as CryptoKeyPair["publicKey"],
  };
  return { privateKey, publicJwk, jkt, clientId: `${JWK_THUMBPRINT_URI_PREFIX}${jkt}`, cryptoKeyPair };
}

/** the RFC 7638 thumbprint of a runner key's public half (what the gateway records it by) */
export async function runnerKeyThumbprint(secret: string): Promise<string> {
  return (await runnerKeyMaterial(secret)).jkt;
}

/**
 * ADR-0187 round 5 [67], S7: the proof a re-enrolling runner gives that it held the registration it
 * supersedes — a compact JWS by the OLD key (`kid` = its thumbprint) naming the NEW key (`jkt`).
 */
export async function supersedeProof(oldSecret: string, newSecret: string): Promise<string> {
  const old = await runnerKeyMaterial(oldSecret);
  const next = await runnerKeyMaterial(newSecret);
  return new SignJWT({ jkt: next.jkt })
    .setProtectedHeader({ alg: "EdDSA", typ: RUNNER_SUPERSEDE_PROOF_TYP, kid: old.jkt })
    .setIssuedAt()
    .sign(old.privateKey);
}

/**
 * ADR-0188 decision 12, S7: the proof a runner gives that it holds the NEW key it rotates to — a
 * compact JWS by the new key, its public half in the `jwk` header, `aud` = the rotation route.
 */
export async function rotationProof(newSecret: string, rotationUrl: string): Promise<string> {
  const next = await runnerKeyMaterial(newSecret);
  return new SignJWT({})
    .setProtectedHeader({ alg: "EdDSA", typ: KEY_ROTATION_PROOF_TYP, jwk: next.publicJwk as JWK })
    .setAudience(rotationUrl)
    .setIssuedAt()
    .sign(next.privateKey);
}
