/**
 * ADR-0189 R25 item 12 (owner decision, 2026-10-11) — THE INSTALL-GENERATED RECEIPT SIGNING KEY.
 *
 * Under R25 every sign-off fails closed (409 `bom_signing_unavailable`) while no receipt signing
 * key is usable, and a fresh install had none, so nothing could be approved. The installer and the
 * gateway's first boot now create one, stored with the other install secrets, and the posture read
 * names where the key came from:
 *
 *   operator_managed   REGULAIT_RECEIPT_SIGNING_KEY + REGULAIT_RECEIPT_SIGNING_KEY_ID are set (the
 *                      ADR-0186 mechanism, unchanged). They always win: setting them is how an admin
 *                      switches to a key they manage.
 *   install_generated  neither is set, and `<REGULAIT_INSTALL_SECRETS_DIR>/receipt-signing-key.pem`
 *                      exists. Its key id is derived from its public key, so a key lost with its
 *                      volume is replaced under a NEW id and never conflicts with the recorded one.
 *   missing            no key at all (sign-offs stay refused).
 *   invalid            a key is configured but unusable (sign-offs stay refused, 503).
 *
 * WHAT THIS DELIBERATELY DOES NOT DO (ADR-0180, secure by default):
 *   - It never overwrites a key file, never "repairs" one, and never generates while the operator
 *     variables are set (a test or demo that sets its own key generates nothing).
 *   - It never logs or returns the private key: only the key id and the public-key fingerprint.
 *   - A failed generation leaves the deployment exactly where it was: no key, sign-offs refused.
 *   - An install-generated key file readable by group or others (POSIX) is `invalid`, not used.
 *
 * Concurrency: the key is written to a private temporary file (`wx`, mode 0600, fsync) and then
 * published with link(2), which is create-exclusive and atomic. Two first boots racing produce one
 * key; the loser discards its own and reuses the winner's. A reader never sees a partial file.
 *
 * Open source first (ADR-0176): Node's built-in `crypto.generateKeyPairSync("ed25519")`; no library.
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, type KeyObject } from "node:crypto";
import { closeSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs";
import path from "node:path";

export const RECEIPT_KEY_FILE_ENV = "REGULAIT_RECEIPT_SIGNING_KEY";
export const RECEIPT_KEY_ID_ENV = "REGULAIT_RECEIPT_SIGNING_KEY_ID";
export const INSTALL_SECRETS_DIR_ENV = "REGULAIT_INSTALL_SECRETS_DIR";
export const INSTALL_RECEIPT_KEY_FILE = "receipt-signing-key.pem";
const MAX_KEY_BYTES = 16384;
const KEY_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

export type ReceiptKeySource = "operator_managed" | "install_generated";
export type ReceiptKeyState = ReceiptKeySource | "missing" | "invalid";

export class ReceiptKeyError extends Error {
  constructor() { super("Receipt signing key configuration is invalid or conflicts with its recorded public key."); }
}

export interface ReceiptPublicJwk { kty: "OKP"; crv: "Ed25519"; x: string }
export interface ResolvedReceiptKey { keyId: string; privateKey: KeyObject; jwk: ReceiptPublicJwk; source: ReceiptKeySource }

/** a PKCS#8 Ed25519 PEM -> private key and public JWK, or ReceiptKeyError (never the reason, which could echo bytes) */
function parseReceiptPem(pem: Buffer): { privateKey: KeyObject; jwk: ReceiptPublicJwk } {
  if (pem.length > MAX_KEY_BYTES || !pem.toString("utf8").startsWith("-----BEGIN PRIVATE KEY-----")) throw new ReceiptKeyError();
  const privateKey = createPrivateKey({ key: pem, format: "pem", type: "pkcs8" });
  if (privateKey.asymmetricKeyType !== "ed25519") throw new ReceiptKeyError();
  const publicKey = createPublicKey(pem).export({ format: "jwk" });
  if (publicKey.kty !== "OKP" || publicKey.crv !== "Ed25519" || !publicKey.x || publicKey.d) throw new ReceiptKeyError();
  return { privateKey, jwk: { kty: "OKP", crv: "Ed25519", x: publicKey.x } };
}

/** the key id of an install-generated key: derived from its public key, so a replacement key gets a new id */
export function installReceiptKeyId(jwk: ReceiptPublicJwk): string {
  return `install-ed25519-${createHash("sha256").update(Buffer.from(jwk.x, "base64url")).digest("hex").slice(0, 32)}`;
}

/** the non-secret fingerprint an auditor pins: sha256 over the SPKI DER (the export-bundle format) */
export function receiptPublicKeyFingerprint(jwk: ReceiptPublicJwk): string {
  const der = createPublicKey({ key: { ...jwk }, format: "jwk" }).export({ type: "spki", format: "der" });
  return `sha256:${createHash("sha256").update(der).digest("hex")}`;
}

/** `<dir>/receipt-signing-key.pem`, or null when no install secrets directory is configured */
export function installReceiptKeyPath(env: NodeJS.ProcessEnv = process.env): string | null {
  const dir = env[INSTALL_SECRETS_DIR_ENV]?.trim();
  return dir ? path.join(path.resolve(dir), INSTALL_RECEIPT_KEY_FILE) : null;
}

/** do the operator variables claim the key (either one set)? Then nothing install-generated is read or written. */
export function operatorReceiptKeyConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env[RECEIPT_KEY_FILE_ENV]?.trim() || env[RECEIPT_KEY_ID_ENV]?.trim());
}

function loadOperatorKey(env: NodeJS.ProcessEnv): ResolvedReceiptKey {
  const file = env[RECEIPT_KEY_FILE_ENV]?.trim();
  const keyId = env[RECEIPT_KEY_ID_ENV]?.trim();
  if (!file || !keyId) throw new ReceiptKeyError();
  try {
    // ADR-0186's checks, unchanged (a mounted secret is often a symlink, so this one follows it)
    if (!KEY_ID_RE.test(keyId) || !statSync(file).isFile() || statSync(file).size > MAX_KEY_BYTES) throw new ReceiptKeyError();
    return { keyId, source: "operator_managed", ...parseReceiptPem(readFileSync(file)) };
  } catch { throw new ReceiptKeyError(); }
}

/** null when the file does not exist; ReceiptKeyError when it exists and is unusable */
function loadInstallKey(file: string): ResolvedReceiptKey | null {
  let st;
  try { st = lstatSync(file); } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new ReceiptKeyError();
  }
  try {
    // never a symlink or a directory, and (POSIX) never readable by group or others
    if (!st.isFile() || st.size > MAX_KEY_BYTES) throw new ReceiptKeyError();
    if (process.platform !== "win32" && (st.mode & 0o077) !== 0) throw new ReceiptKeyError();
    const parsed = parseReceiptPem(readFileSync(file));
    return { keyId: installReceiptKeyId(parsed.jwk), source: "install_generated", ...parsed };
  } catch { throw new ReceiptKeyError(); }
}

/**
 * THE ONE RESOLVER every signer uses (receipts, AI BOM snapshots, sign-off checks): the operator key
 * when its variables are set, else the install-generated key, else null. Throws ReceiptKeyError when a
 * configured key is unusable — never falls back from a broken operator key to the install key.
 */
export function resolveReceiptSigningKey(env: NodeJS.ProcessEnv = process.env): ResolvedReceiptKey | null {
  if (operatorReceiptKeyConfigured(env)) return loadOperatorKey(env);
  const file = installReceiptKeyPath(env);
  return file ? loadInstallKey(file) : null;
}

export type EnsureInstallReceiptKeyOutcome =
  | { outcome: "operator_managed" }
  | { outcome: "not_configured" }
  | { outcome: "created" | "reused"; keyId: string; fingerprint: string; path: string }
  | { outcome: "failed"; reason: string; path: string | null };

export interface EnsureInstallReceiptKeyDeps {
  /** injected by tests to prove a failed generation fails closed */
  generate?: () => { privateKeyPem: string };
}

const defaultGenerate = () => ({
  privateKeyPem: generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
});

/**
 * First boot and the installer: create the install key when no key is configured. Idempotent, never
 * overwrites, create-exclusive. Never throws; a failure is an outcome, and the caller only logs it,
 * because without a key the sign-offs already fail closed.
 */
export function ensureInstallReceiptKey(env: NodeJS.ProcessEnv = process.env, deps: EnsureInstallReceiptKeyDeps = {}): EnsureInstallReceiptKeyOutcome {
  if (operatorReceiptKeyConfigured(env)) return { outcome: "operator_managed" };
  const file = installReceiptKeyPath(env);
  if (!file) return { outcome: "not_configured" };
  const reused = (): EnsureInstallReceiptKeyOutcome => {
    try {
      const key = loadInstallKey(file);
      if (!key) return { outcome: "failed", reason: "the key file disappeared after it was created", path: file };
      return { outcome: "reused", keyId: key.keyId, fingerprint: receiptPublicKeyFingerprint(key.jwk), path: file };
    } catch {
      return { outcome: "failed", reason: "an existing key file is unusable (not a regular file, readable by group or others, or not a PKCS#8 Ed25519 key); it was left untouched", path: file };
    }
  };
  try {
    lstatSync(file);
    return reused();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") return { outcome: "failed", reason: `cannot inspect the key file (${(err as NodeJS.ErrnoException).code ?? "error"})`, path: file };
  }
  const tmp = path.join(path.dirname(file), `.${INSTALL_RECEIPT_KEY_FILE}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  let fd: number | null = null;
  try {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const { privateKeyPem } = (deps.generate ?? defaultGenerate)();
    const parsed = parseReceiptPem(Buffer.from(privateKeyPem, "utf8"));
    fd = openSync(tmp, "wx", 0o600);
    writeSync(fd, privateKeyPem);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    try {
      linkSync(tmp, file);
    } catch (err) {
      // another boot won the race: its key stands, ours is discarded
      if ((err as NodeJS.ErrnoException).code === "EEXIST") return reused();
      throw err;
    }
    return { outcome: "created", keyId: installReceiptKeyId(parsed.jwk), fingerprint: receiptPublicKeyFingerprint(parsed.jwk), path: file };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return { outcome: "failed", reason: code ? `could not write the key (${code})` : "could not generate a valid Ed25519 key", path: file };
  } finally {
    if (fd !== null) try { closeSync(fd); } catch { /* already closed */ }
    try { unlinkSync(tmp); } catch { /* never created, or already linked and now removed */ }
  }
}

export interface ReceiptSigningKeyPosture {
  state: ReceiptKeyState;
  /** the key id receipts carry; null when missing or invalid */
  keyId: string | null;
  /** sha256 over the SPKI DER of the public key; never the private key */
  publicKeyFingerprint: string | null;
  /** where verifiers fetch the public keys */
  publicKeys: "/v1/receipts/keys";
  note: string;
}

/** what GET /v1/org/posture and GET /v1/receipts/status say about the key. Informational: it blocks nothing. */
export function receiptSigningKeyPosture(env: NodeJS.ProcessEnv = process.env): ReceiptSigningKeyPosture {
  const publicKeys = "/v1/receipts/keys" as const;
  let key: ResolvedReceiptKey | null;
  try { key = resolveReceiptSigningKey(env); } catch {
    return {
      state: "invalid", keyId: null, publicKeyFingerprint: null, publicKeys,
      note: operatorReceiptKeyConfigured(env)
        ? "The operator-managed receipt key is unusable (REGULAIT_RECEIPT_SIGNING_KEY and REGULAIT_RECEIPT_SIGNING_KEY_ID must both be set, to a PKCS#8 Ed25519 PEM and a key id). Sign-offs are refused until it is fixed."
        : "The install-generated receipt key file is unusable (not a regular file, readable by group or others, or not a PKCS#8 Ed25519 key). It is never overwritten; sign-offs are refused until it is fixed or an operator key is set.",
    };
  }
  if (!key) {
    return {
      state: "missing", keyId: null, publicKeyFingerprint: null, publicKeys,
      note: "No receipt signing key, so sign-offs are refused (409 bom_signing_unavailable). Set REGULAIT_INSTALL_SECRETS_DIR for an install-generated key, or REGULAIT_RECEIPT_SIGNING_KEY and REGULAIT_RECEIPT_SIGNING_KEY_ID for a key you manage.",
    };
  }
  return {
    state: key.source, keyId: key.keyId, publicKeyFingerprint: receiptPublicKeyFingerprint(key.jwk), publicKeys,
    note: key.source === "install_generated"
      ? "Generated by the installer or first boot and kept with the install secrets. To use a key you manage, set REGULAIT_RECEIPT_SIGNING_KEY and REGULAIT_RECEIPT_SIGNING_KEY_ID and restart; receipts already signed stay verifiable under the recorded public key."
      : "Managed by the operator (REGULAIT_RECEIPT_SIGNING_KEY and REGULAIT_RECEIPT_SIGNING_KEY_ID).",
  };
}

/** the boot-log line for an ensure outcome; key id and fingerprint only, never key material */
export function describeInstallReceiptKey(result: EnsureInstallReceiptKeyOutcome): string {
  switch (result.outcome) {
    case "operator_managed": return "operator-managed (REGULAIT_RECEIPT_SIGNING_KEY)";
    case "not_configured": return "none configured and REGULAIT_INSTALL_SECRETS_DIR is unset — sign-offs are refused until a key exists";
    case "created": return `install-generated on this boot: ${result.keyId} (${result.fingerprint}) at ${result.path}`;
    case "reused": return `install-generated: ${result.keyId} (${result.fingerprint})`;
    case "failed": return `INSTALL KEY GENERATION FAILED (${result.reason}${result.path ? `, ${result.path}` : ""}) — sign-offs stay refused`;
  }
}
