/**
 * ADR-0334 owner decision B4 (2026-11-15): ONE ROTATABLE DEVICE-POLICY SIGNER for every on-device enforcement point:
 * the managed browser extension now, the endpoint agent's ADR-0298 enforcement policy when lane E13 adopts it.
 *
 * It signs the endpoint agent's envelope `{keyId, payload, signature}` (Ed25519 over the exact payload bytes,
 * standard base64), so both devices verify the same way. The key is a key of its own (one key per purpose, ADR-0195):
 * never the issuer's, the receipt key or a release key.
 *
 * WHERE THE KEY COMES FROM
 *  - operator-managed: `REGULAIT_DEVICE_POLICY_SIGNING_KEY` names a file of 1 to 8 PKCS#8 Ed25519 keys, parsed by the
 *    same reader as the issuer's key file (`readSigningKeyFile`). With one key it signs. With more,
 *    `REGULAIT_DEVICE_POLICY_ACTIVE_KEY_ID` names the signer; a missing or unknown id is `invalid` (never a guess).
 *  - install-generated: neither is set and `REGULAIT_INSTALL_SECRETS_DIR` is: `<dir>/device-policy-signing-key.pem`,
 *    created on first enable by the shared install-key generator and read by its strict reader.
 *  - no key: `missing`, and no policy is issued (every device stays closed).
 *
 * ROTATION (no window in which devices refuse every policy): add the next key to the file; every key in the file is
 * PUBLISHED (the admin's managed config lists them all, at most 4 in a device's managed storage), so devices pin it
 * before it signs; then set the active key id to it; then drop the old key from the file and from managed storage.
 * The active key id and every published key id are on the admin settings read.
 *
 * The key id is `device-policy-` + 24 hex of SHA-256 over the raw public key: the envelope's key-id shape, the same
 * for a key wherever it is configured, and a replaced key always gets a new id.
 */
import { createHash, sign, type KeyObject } from "node:crypto";
import path from "node:path";
import { DEVICE_POLICY_KEY_ID_RE, type DevicePolicyEnvelope } from "@regulait/shared";
import { readSigningKeyFile } from "./identity-signing-keys.js";
import { ensureInstallKeyFile, INSTALL_SECRETS_DIR_ENV, loadInstallKeyFile } from "./receipt-signing-key.js";

export const DEVICE_POLICY_KEY_FILE_ENV = "REGULAIT_DEVICE_POLICY_SIGNING_KEY";
export const DEVICE_POLICY_ACTIVE_KEY_ENV = "REGULAIT_DEVICE_POLICY_ACTIVE_KEY_ID";
export const INSTALL_DEVICE_POLICY_KEY_FILE = "device-policy-signing-key.pem";
/** `.device-policy-signing-key.pem.<pid>.<12 hex>.tmp`, a literal like the other install keys' (CodeQL) */
const DEVICE_POLICY_TMP_RE = /^\.device-policy-signing-key\.pem\.\d+\.[0-9a-f]{12}\.tmp$/;

export interface DevicePolicyPublicKey {
  keyId: string;
  /** the Ed25519 public key as a JWK `x`: what a device's managed storage pins */
  x: string;
}

export interface DevicePolicySigner {
  source: "operator_managed" | "install_generated";
  active: DevicePolicyPublicKey & { privateKey: KeyObject };
  /** every configured key, the active one first: the set a device should pin */
  published: DevicePolicyPublicKey[];
}

export type DevicePolicySignerState = { state: "ok"; signer: DevicePolicySigner } | { state: "missing" | "invalid" };

export function devicePolicyKeyId(x: string): string {
  return `device-policy-${createHash("sha256").update(Buffer.from(x, "base64url")).digest("hex").slice(0, 24)}`;
}

/** the signer, or why there is none. `create` makes the install-generated key when nothing else is configured. */
export async function resolveDevicePolicySigner(env: NodeJS.ProcessEnv = process.env, opts: { create?: boolean } = {}): Promise<DevicePolicySignerState> {
  const file = env[DEVICE_POLICY_KEY_FILE_ENV]?.trim();
  const activeId = env[DEVICE_POLICY_ACTIVE_KEY_ENV]?.trim();
  if (file) {
    let keys;
    try {
      keys = await readSigningKeyFile(file, () => new Error("device policy key file unusable"), ["Ed25519"]);
    } catch {
      return { state: "invalid" };
    }
    const all = keys.map((k) => ({ keyId: devicePolicyKeyId(k.publicJwk.x), x: k.publicJwk.x, privateKey: k.privateKey }));
    if (!all.every((k) => DEVICE_POLICY_KEY_ID_RE.test(k.keyId))) return { state: "invalid" };
    const active = activeId ? all.find((k) => k.keyId === activeId) : all.length === 1 ? all[0] : undefined;
    if (!active) return { state: "invalid" };
    return {
      state: "ok",
      signer: {
        source: "operator_managed",
        active,
        published: [active, ...all.filter((k) => k !== active)].map(({ keyId, x }) => ({ keyId, x })),
      },
    };
  }
  if (activeId) return { state: "invalid" };
  const dir = env[INSTALL_SECRETS_DIR_ENV]?.trim();
  if (!dir) return { state: "missing" };
  const keyFile = path.join(path.resolve(dir), INSTALL_DEVICE_POLICY_KEY_FILE);
  try {
    if (opts.create && ensureInstallKeyFile(keyFile, DEVICE_POLICY_TMP_RE).outcome === "failed") return { state: "invalid" };
    const loaded = loadInstallKeyFile(keyFile);
    if (!loaded) return { state: "missing" };
    const pub = { keyId: devicePolicyKeyId(loaded.jwk.x), x: loaded.jwk.x };
    return { state: "ok", signer: { source: "install_generated", active: { ...pub, privateKey: loaded.privateKey }, published: [pub] } };
  } catch {
    return { state: "invalid" };
  }
}

/** sign a device policy into the endpoint agent's envelope: Ed25519 over the exact JSON bytes (Node's crypto) */
export function signDevicePolicy(policy: object, signer: DevicePolicySigner): DevicePolicyEnvelope {
  const payload = Buffer.from(JSON.stringify(policy), "utf8");
  return { keyId: signer.active.keyId, payload: payload.toString("base64"), signature: sign(null, payload, signer.active.privateKey).toString("base64") };
}
