import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";

/**
 * AES-256-GCM envelope for stored secrets (git tokens). The key is the
 * deploy-time REGULAIT_DATA_KEY (64 hex chars). Format: iv.tag.ciphertext.kf,
 * hex-encoded, where `kf` is the 32-hex body of the encrypting key's
 * fingerprint (see below). Without a key, secret storage is refused rather
 * than degraded to plaintext.
 *
 * WHY THE FINGERPRINT SEGMENT EXISTS (ADR-0063 amendment, batch B4). The
 * re-encryption walk must answer "is this row already under the new key?"
 * WITHOUT decrypting it — a resumed walk that had to trial-decrypt every row
 * it already settled would be quadratic and, worse, could not tell "already
 * re-encrypted" from "was always under the new key" in its accounting. The
 * fingerprint is a PRF output (non-invertible, reveals nothing about the key
 * — the same derivation ADR-0063 prints in every boot log), so embedding it
 * beside the ciphertext costs nothing. LEGACY three-segment values (every
 * write before this change) carry no marker; readers ignore the segment, and
 * the walk handles them by try-old-then-new trial decryption.
 */

/** the fixed domain-separation string. Changing it invalidates every recorded
 * fingerprint on every deployment — hence the `dk1:` version tag beside it. */
export const FINGERPRINT_DOMAIN = "regulait/data-key-fingerprint/v1";
export const FINGERPRINT_PREFIX = "dk1:";
/** 128 bits. Collision-irrelevant here (we compare one value to one value) and
 * short enough that a human can read it off a screen and compare it. */
export const FINGERPRINT_BYTES = 16;

/** Same validation the envelope itself applies, so a key that cannot encrypt
 * can never acquire a fingerprint either. */
function keyBytes(dataKeyHex: string): Buffer {
  const key = Buffer.from(dataKeyHex, "hex");
  if (key.length !== 32) throw new Error("data key must be 32 bytes (64 hex chars)");
  return key;
}

/**
 * The non-secret, non-invertible identifier for a data key: `dk1:` + the first
 * 16 bytes of HMAC-SHA256(key = the raw key, msg = FINGERPRINT_DOMAIN), hex.
 * See ADR-0063 §1 for why publishing it is safe. Lives beside the cipher
 * itself so the envelope and its key-identity can never drift apart.
 */
export function dataKeyFingerprint(dataKeyHex: string): string {
  const digest = createHmac("sha256", keyBytes(dataKeyHex)).update(FINGERPRINT_DOMAIN, "utf8").digest();
  return FINGERPRINT_PREFIX + digest.subarray(0, FINGERPRINT_BYTES).toString("hex");
}

export function encryptSecret(dataKeyHex: string, plaintext: string): string {
  const key = keyBytes(dataKeyHex);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const kf = dataKeyFingerprint(dataKeyHex).slice(FINGERPRINT_PREFIX.length);
  return `${iv.toString("hex")}.${cipher.getAuthTag().toString("hex")}.${enc.toString("hex")}.${kf}`;
}

export function decryptSecret(dataKeyHex: string, stored: string): string {
  const key = keyBytes(dataKeyHex);
  // 4th segment (the key fingerprint) is deliberately ignored here: the GCM
  // tag, not the marker, is what proves the key is right. Legacy values have
  // only three segments.
  const [ivHex, tagHex, encHex] = stored.split(".");
  if (!ivHex || !tagHex || encHex === undefined) throw new Error("malformed ciphertext");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return Buffer.concat([decipher.update(Buffer.from(encHex, "hex")), decipher.final()]).toString(
    "utf8",
  );
}

/**
 * The fingerprint a stored value SAYS it was encrypted under, or null for a
 * legacy three-segment value. A claim, not a proof — the walk still verifies
 * by decrypting; this only lets it skip rows already settled and lets NEW
 * writes be attributed without trial decryption.
 */
export function storedKeyFingerprint(stored: string): string | null {
  const parts = stored.split(".");
  const kf = parts[3];
  if (parts.length !== 4 || !kf || !/^[0-9a-f]{32}$/.test(kf)) return null;
  return FINGERPRINT_PREFIX + kf;
}
