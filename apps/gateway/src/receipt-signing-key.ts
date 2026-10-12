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
 *   - POSIX: an install-generated key is read only through an O_NOFOLLOW handle and must be a regular
 *     file, 0600 or stricter, owned by the gateway's user, with one link, in a directory with no group
 *     or other access; anything else is `invalid`, not used. A non-POSIX filesystem mounted on Linux
 *     (drvfs, 9p, SMB) reports other bits and owners, so it fails closed: use the default named
 *     volume. Native Windows skips the mode and owner checks (its stat has no such bits).
 *
 * Concurrency: the key is written to a private temporary file (`wx`, mode 0600, fsync) and then
 * published with link(2), which is create-exclusive and atomic. Two first boots racing produce one
 * key; the loser discards its own and reuses the winner's. A reader never sees a partial file.
 *
 * Open source first (ADR-0176): Node's built-in `crypto.generateKeyPairSync("ed25519")`; no library.
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, type KeyObject } from "node:crypto";
import { closeSync, constants as fsConstants, fstatSync, fsyncSync, linkSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync, unlinkSync, writeSync } from "node:fs";
import path from "node:path";

export const RECEIPT_KEY_FILE_ENV = "REGULAIT_RECEIPT_SIGNING_KEY";
export const RECEIPT_KEY_ID_ENV = "REGULAIT_RECEIPT_SIGNING_KEY_ID";
export const INSTALL_SECRETS_DIR_ENV = "REGULAIT_INSTALL_SECRETS_DIR";
export const INSTALL_RECEIPT_KEY_FILE = "receipt-signing-key.pem";
const MAX_KEY_BYTES = 16384;
const KEY_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
/** a receipt key id as `receipt_signing_keys.key_id` accepts it (one anchored character class: linear) */
export function isReceiptKeyId(value: unknown): value is string {
  return typeof value === "string" && KEY_ID_RE.test(value);
}

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

const POSIX = process.platform !== "win32";
const UNUSABLE_INSTALL_KEY =
  "not a regular file owned by the gateway's user with mode 0600 and one link, in a directory with no group or other access, or not a PKCS#8 Ed25519 key";

/** synchronous pause for the short retries below (first boot only) */
function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * null when the file (or its directory) does not exist; ReceiptKeyError when it exists and is unusable.
 * POSIX: the directory must be a real directory owned by this process's user with no group or other
 * access; the file is opened O_NOFOLLOW and checked on the OPEN HANDLE (no check-then-read window): a
 * regular file, mode 0600 or stricter, owned by this user, exactly one link. Windows and other
 * non-POSIX platforms skip the mode and owner checks (their stat reports no meaningful bits).
 */
function loadInstallKey(file: string): ResolvedReceiptKey | null {
  const parsed = loadInstallKeyFile(file);
  return parsed ? { keyId: installReceiptKeyId(parsed.jwk), source: "install_generated", ...parsed } : null;
}

/**
 * ADR-0188 S7: the same strict read for ANY install-generated Ed25519 key in the install secrets
 * directory (the receipt key, and the identity issuer's signing key). null when the file or its
 * directory does not exist; ReceiptKeyError when it exists and is unusable (see `loadInstallKey`).
 */
export function loadInstallKeyFile(file: string): { privateKey: KeyObject; jwk: ReceiptPublicJwk } | null {
  if (POSIX) {
    // checked on an open handle (O_NOFOLLOW|O_DIRECTORY), never by a separate path stat
    let dfd: number;
    try {
      dfd = openSync(path.dirname(file), fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new ReceiptKeyError();
    }
    try {
      const dir = fstatSync(dfd);
      if (!dir.isDirectory() || (dir.mode & 0o077) !== 0 || dir.uid !== process.getuid!()) throw new ReceiptKeyError();
    } finally {
      closeSync(dfd);
    }
  }
  let fd: number;
  try {
    fd = openSync(file, POSIX ? fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW : "r");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new ReceiptKeyError(); // ELOOP: a symlink is never followed
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > MAX_KEY_BYTES) throw new ReceiptKeyError();
    if (POSIX && ((st.mode & 0o077) !== 0 || st.uid !== process.getuid!() || st.nlink !== 1)) throw new ReceiptKeyError();
    const buf = Buffer.alloc(st.size);
    let read = 0;
    while (read < buf.length) {
      const n = readSync(fd, buf, read, buf.length - read, read);
      if (n === 0) break;
      read += n;
    }
    return parseReceiptPem(buf.subarray(0, read));
  } catch {
    throw new ReceiptKeyError();
  } finally {
    closeSync(fd);
  }
}

/**
 * THE ONE RESOLVER every signer uses (receipts, AI BOM snapshots, sign-off checks): the operator key
 * when its variables are set, else the install-generated key, else null. Throws ReceiptKeyError when a
 * configured key is unusable — never falls back from a broken operator key to the install key.
 */
export function resolveReceiptSigningKey(env: NodeJS.ProcessEnv = process.env): ResolvedReceiptKey | null {
  if (operatorReceiptKeyConfigured(env)) return loadOperatorKey(env);
  const file = installReceiptKeyPath(env);
  if (!file) return null;
  try {
    return loadInstallKey(file);
  } catch (err) {
    // #353 follow-up: a generator that crashed between publishing the key (link) and removing its temporary
    // file leaves the key with TWO links, which every reader refuses. The boot path sweeps such a temporary
    // file once it is stale, but a gateway that booted within the stale window would refuse the key until its
    // next restart. So a refusal re-sweeps stale temporaries here (the posture and every signer resolve
    // through this) and retries once when one was removed; a fresh temporary file, which may belong to a
    // generation in flight, is never touched, and any other refusal stands.
    if (removeStaleInstallKeyTemps(path.dirname(file)) === 0) throw err;
    return loadInstallKey(file);
  }
}

export type EnsureInstallReceiptKeyOutcome =
  | { outcome: "operator_managed" }
  | { outcome: "not_configured" }
  | { outcome: "created" | "reused"; keyId: string; fingerprint: string; path: string }
  | { outcome: "failed"; reason: string; path: string | null };

export interface EnsureInstallReceiptKeyDeps {
  /** injected by tests to prove a failed generation fails closed */
  generate?: () => { privateKeyPem: string };
  /** injected by tests: "now" for the stale-temporary-file sweep */
  now?: () => number;
}

const defaultGenerate = () => ({
  privateKeyPem: generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
});

/** `.receipt-signing-key.pem.<pid>.<12 hex>.tmp` — a literal, so no escaping is built at run time (CodeQL js/incomplete-sanitization) */
const TMP_RE = /^\.receipt-signing-key\.pem\.\d+\.[0-9a-f]{12}\.tmp$/;
if (!TMP_RE.test(`.${INSTALL_RECEIPT_KEY_FILE}.1.000000000000.tmp`)) throw new Error("TMP_RE no longer matches INSTALL_RECEIPT_KEY_FILE");
/** a generator's temporary file older than this was left by a crash, never by a generation in flight (milliseconds) */
export const STALE_TMP_MS = 60_000;

/** remove temporary key files a crashed generation left behind; never the key, never a fresh temporary file */
export function removeStaleInstallKeyTemps(dir: string, now: number = Date.now(), tmpRe: RegExp = TMP_RE): number {
  let removed = 0;
  let names: string[];
  try { names = readdirSync(dir); } catch { return 0; }
  for (const name of names) {
    if (!tmpRe.test(name)) continue;
    const p = path.join(dir, name);
    let fd: number | null = null;
    try {
      fd = openSync(p, POSIX ? fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW : "r");
      const st = fstatSync(fd);
      closeSync(fd);
      fd = null;
      if (st.isFile() && now - st.mtimeMs > STALE_TMP_MS) { unlinkSync(p); removed++; }
    } catch { /* gone already, a symlink, or not ours to remove */ }
    finally { if (fd !== null) try { closeSync(fd); } catch { /* closed */ } }
  }
  return removed;
}

/** make the new directory entry durable (POSIX); best effort elsewhere */
function fsyncDir(dir: string): void {
  if (!POSIX) return;
  let dfd: number | null = null;
  try { dfd = openSync(dir, fsConstants.O_RDONLY); fsyncSync(dfd); } catch { /* the key is published; durability is best effort */ }
  finally { if (dfd !== null) try { closeSync(dfd); } catch { /* closed */ } }
}

/**
 * First boot and the installer: create the install key when no key is configured. Idempotent, never
 * overwrites, create-exclusive. Never throws; a failure is an outcome. It does NOT validate an
 * operator key: callers report the resolved state with `checkReceiptSigningKey`.
 */
export function ensureInstallReceiptKey(env: NodeJS.ProcessEnv = process.env, deps: EnsureInstallReceiptKeyDeps = {}): EnsureInstallReceiptKeyOutcome {
  if (operatorReceiptKeyConfigured(env)) return { outcome: "operator_managed" };
  const file = installReceiptKeyPath(env);
  if (!file) return { outcome: "not_configured" };
  const r = ensureInstallKeyFile(file, TMP_RE, deps);
  if (r.outcome === "failed") return r;
  return { outcome: r.outcome, keyId: installReceiptKeyId(r.jwk), fingerprint: receiptPublicKeyFingerprint(r.jwk), path: file };
}

export type EnsureInstallKeyFileOutcome =
  | { outcome: "created" | "reused"; jwk: ReceiptPublicJwk; path: string }
  | { outcome: "failed"; reason: string; path: string };

/**
 * The generator behind every install-generated key (ADR-0189 R25 item 12; ADR-0188 S7 reuses it for the
 * identity issuer's key): idempotent, never overwrites, create-exclusive (link(2)), never throws. `tmpRe`
 * must match `.<basename>.<pid>.<12 hex>.tmp` for `file` exactly: it is how a crashed generation's
 * temporary file is recognised, and it is a literal at each caller (CodeQL js/incomplete-sanitization).
 */
export function ensureInstallKeyFile(file: string, tmpRe: RegExp, deps: EnsureInstallReceiptKeyDeps = {}): EnsureInstallKeyFileOutcome {
  const dir = path.dirname(file);
  if (!tmpRe.test(`.${path.basename(file)}.1.000000000000.tmp`)) throw new Error("the temporary-file pattern does not match the key file");
  removeStaleInstallKeyTemps(dir, (deps.now ?? Date.now)(), tmpRe);
  const reused = (): EnsureInstallKeyFileOutcome => {
    // a concurrent creator holds a second link for an instant (its temporary file) before removing it,
    // so a refusal is retried briefly before it is reported
    for (let attempt = 0; ; attempt++) {
      try {
        const key = loadInstallKeyFile(file);
        if (!key) return { outcome: "failed", reason: "the key file disappeared after it was created", path: file };
        return { outcome: "reused", jwk: key.jwk, path: file };
      } catch {
        if (attempt >= 20) return { outcome: "failed", reason: `an existing key file is unusable (${UNUSABLE_INSTALL_KEY}); it was left untouched`, path: file };
        pause(50);
      }
    }
  };
  // one load attempt, no separate existence check: null means there is no key file yet
  let present = true;
  try { present = loadInstallKeyFile(file) !== null; } catch { /* present but refused: reused() retries, then reports it */ }
  if (present) return reused();
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  let fd: number | null = null;
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
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
      if ((err as NodeJS.ErrnoException).code === "EEXIST") { try { unlinkSync(tmp); } catch { /* finally retries */ } return reused(); }
      throw err;
    }
    unlinkSync(tmp); // back to one link at once: a reader refuses a key file with two
    fsyncDir(dir);
    return { outcome: "created", jwk: parsed.jwk, path: file };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return { outcome: "failed", reason: code ? `could not write the key (${code})` : "could not generate a valid Ed25519 key", path: file };
  } finally {
    if (fd !== null) try { closeSync(fd); } catch { /* already closed */ }
    try { unlinkSync(tmp); } catch { /* never created, or already removed */ }
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
        : `The install-generated receipt key file is unusable (${UNUSABLE_INSTALL_KEY}). It is never overwritten; sign-offs are refused until it is fixed or an operator key is set.`,
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

export interface ReceiptSigningKeyCheck {
  ensure: EnsureInstallReceiptKeyOutcome;
  posture: ReceiptSigningKeyPosture;
  /** 0 a usable key; 1 invalid, or generation failed; 2 nowhere to keep a key (not configured) */
  exitCode: 0 | 1 | 2;
  /** one line, key id and fingerprint only, never key material */
  line: string;
}

/**
 * Ensure, then RESOLVE: what the boot log and the installer report. An operator key is loaded exactly
 * as a signer loads it, so a key the gateway cannot read (a root-owned 0600 file, a missing path, only
 * one of the two variables) is reported `invalid` here, not at the first sign-off.
 */
export function checkReceiptSigningKey(env: NodeJS.ProcessEnv = process.env, deps: EnsureInstallReceiptKeyDeps = {}): ReceiptSigningKeyCheck {
  const ensure = ensureInstallReceiptKey(env, deps);
  const posture = receiptSigningKeyPosture(env);
  const id = `${posture.keyId} (${posture.publicKeyFingerprint})`;
  const why = ensure.outcome === "failed" ? ` (${ensure.reason}${ensure.path ? `, ${ensure.path}` : ""})` : "";
  switch (posture.state) {
    case "operator_managed":
      return { ensure, posture, exitCode: 0, line: `operator-managed: ${id}` };
    case "install_generated":
      return { ensure, posture, exitCode: 0, line: ensure.outcome === "created" ? `install-generated on this boot: ${id} at ${ensure.path}` : `install-generated: ${id}` };
    case "invalid":
      return { ensure, posture, exitCode: 1, line: `invalid${why} — ${posture.note}` };
    case "missing":
      return ensure.outcome === "not_configured"
        ? { ensure, posture, exitCode: 2, line: "missing — none configured and REGULAIT_INSTALL_SECRETS_DIR is unset; sign-offs are refused until a key exists" }
        : { ensure, posture, exitCode: 1, line: `missing — INSTALL KEY GENERATION FAILED${why}; sign-offs stay refused` };
  }
}
