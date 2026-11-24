/** Offline pinned-Ed25519 bundles, extracted from ADR-0256 for ADR-0367. No network or supplied trust roots. */
import { createHash, createPublicKey, verify, type KeyObject } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { z } from "zod";
const keyringSchema = z
  .array(z.object({ keyId: z.string().min(1).max(128), publicKeyPem: z.string().min(1).max(4096) }).strict())
  .max(32);

/**
 * The trusted bundle keys, by id. Public keys only, so not a secret, but still out of code and rotatable: list the new
 * key beside the old, then drop the old. Only Ed25519 is accepted (the algorithm is pinned). An unparseable keyring,
 * a non-Ed25519 key or a key id listed twice refuses the WHOLE keyring, so a typo never half-trusts.
 */
export function loadSignedBundleKeyring(inlineName: string, fileName: string, label: string, env: NodeJS.ProcessEnv = process.env): Map<string, KeyObject> | { error: string } {
  const inline = env[inlineName]?.trim();
  const file = env[fileName]?.trim();
  if (inline && file) return { error: `set one of ${inlineName} and ${fileName}, not both` };
  let raw: unknown = null;
  try {
    if (inline) raw = JSON.parse(inline) as unknown;
    else if (file) {
      const st = statSync(file);
      if (!st.isFile() || st.size > KEYRING_FILE_MAX_BYTES) return { error: `${fileName} is not a readable keyring file` };
      raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
    }
  } catch {
    return { error: `the ${label} keyring is not valid JSON` };
  }
  return parseSignedBundleKeyring(raw, label);
}
const KEYRING_FILE_MAX_BYTES = 256 * 1024;

/** Build a keyring from already-parsed JSON (null = none configured). Same whole-ring refusal rules as above. */
export function parseSignedBundleKeyring(raw: unknown, label: string): Map<string, KeyObject> | { error: string } {
  const out = new Map<string, KeyObject>();
  if (raw === null) return out;
  const parsed = keyringSchema.safeParse(raw);
  if (!parsed.success) return { error: `the ${label} keyring is not a list of { keyId, publicKeyPem }` };
  for (const k of parsed.data) {
    if (out.has(k.keyId)) return { error: `the ${label} keyring lists key '${k.keyId}' twice` };
    let key: KeyObject;
    try {
      key = createPublicKey(k.publicKeyPem);
    } catch {
      return { error: `${label} key '${k.keyId}' is not a public key` };
    }
    if (key.asymmetricKeyType !== "ed25519") return { error: `${label} key '${k.keyId}' is not Ed25519` };
    out.set(k.keyId, key);
  }
  return out;
}

/** A stable identity for a keyring's trust: its sorted key ids and public keys. Any add, removal or swap changes it. */
export function signedBundleKeyringFingerprint(keyring: SignedBundleKeyring): string {
  const h = createHash("sha256");
  if (!(keyring instanceof Map)) return h.update(`error\0${keyring.error}`).digest("hex");
  for (const id of [...keyring.keys()].sort()) h.update(id).update("\0").update(keyring.get(id)!.export({ format: "der", type: "spki" })).update("\0");
  return h.digest("hex");
}

export interface CachedSignedBundleKeyring { keyring: SignedBundleKeyring; fingerprint: string }
/**
 * The keyring for a hot path: parsed once per configuration, never per call. The inline variable is keyed by its
 * value; the file by an asynchronous stat (inode, size, mtime), so the event loop never blocks on file I/O and a
 * rotated file takes effect at the next call. `env` is read on every call, so changing it also takes effect.
 */
export function cachedSignedBundleKeyring(inlineName: string, fileName: string, label: string, env: NodeJS.ProcessEnv = process.env): () => Promise<CachedSignedBundleKeyring> {
  let memo: { source: string; value: CachedSignedBundleKeyring } | undefined;
  const remember = (source: string, keyring: SignedBundleKeyring) => {
    memo = { source, value: { keyring, fingerprint: signedBundleKeyringFingerprint(keyring) } };
    return memo.value;
  };
  return async () => {
    const inline = env[inlineName]?.trim();
    const file = env[fileName]?.trim();
    if (inline && file) return remember("both", { error: `set one of ${inlineName} and ${fileName}, not both` });
    if (!file) {
      const source = `inline\0${inline ?? ""}`;
      if (memo?.source === source) return memo.value;
      let raw: unknown = null;
      try { if (inline) raw = JSON.parse(inline) as unknown; } catch { return remember(source, { error: `the ${label} keyring is not valid JSON` }); }
      return remember(source, parseSignedBundleKeyring(raw, label));
    }
    let source: string;
    try {
      const st = await stat(file);
      if (!st.isFile() || st.size > KEYRING_FILE_MAX_BYTES) return remember(`file\0${file}\0bad`, { error: `${fileName} is not a readable keyring file` });
      source = `file\0${file}\0${st.ino}\0${st.size}\0${st.mtimeMs}`;
    } catch {
      return remember(`file\0${file}\0missing`, { error: `${fileName} is not a readable keyring file` });
    }
    if (memo?.source === source) return memo.value;
    try {
      return remember(source, parseSignedBundleKeyring(JSON.parse(await readFile(file, "utf8")) as unknown, label));
    } catch {
      return remember(source, { error: `the ${label} keyring is not valid JSON` });
    }
  };
}


export type SignedBundleKeyring = Map<string, KeyObject> | { error: string };
export type SignatureVerdict = { ok: true; digest: string } | { ok: false; code: "keyring_invalid" | "no_keyring" | "unknown_key" | "too_large" | "bad_signature" };
/** Verify exact UTF-8 bytes before any payload JSON or detection rule is interpreted. */
export function verifySignedBundle(body: {bundle: string; keyId: string; signature: string}, keyring: SignedBundleKeyring, maxBytes: number): SignatureVerdict {
  if (!(keyring instanceof Map)) return {ok:false,code:"keyring_invalid"};
  if (!keyring.size) return {ok:false,code:"no_keyring"};
  const bytes=Buffer.from(body.bundle,"utf8");
  if(bytes.length>maxBytes) return {ok:false,code:"too_large"};
  const key=keyring.get(body.keyId);
  if(!key) return {ok:false,code:"unknown_key"};
  try { if(!verify(null,bytes,key,Buffer.from(body.signature,"base64"))) return {ok:false,code:"bad_signature"}; }
  catch { return {ok:false,code:"bad_signature"}; }
  return {ok:true,digest:createHash("sha256").update(bytes).digest("hex")};
}
