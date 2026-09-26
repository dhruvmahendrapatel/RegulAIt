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

/** AES-256: 32 bytes, written as 64 hex characters. */
export const DATA_KEY_BYTES = 32;
export const DATA_KEY_HEX_CHARS = DATA_KEY_BYTES * 2;

/**
 * THE ONE AUTHORITY ON WHAT A DATA KEY LOOKS LIKE. Returns an operator-facing
 * sentence naming what is wrong, or `null` when the value is usable.
 *
 * It exists because the format was, for a while, only knowable by reading
 * `Buffer.from(x, "hex")` — and two comments in this repo disagreed about it
 * (one said hex, one said base64). A reader who believed the wrong one
 * configured a base64 key, and the product's answer was a stack trace from
 * three frames down. Callers that need to REFUSE WELL — the ADR-0063 boot gate
 * and the seeder — ask this instead of catching a throw and guessing.
 *
 * `keyBytes` below uses it too, so the validator and the parser cannot drift:
 * anything this function accepts, the cipher accepts.
 *
 * Note `Buffer.from(s, "hex")` silently STOPS at the first non-hex character
 * rather than failing, so a length check on the decoded buffer is necessary but
 * not sufficient for a good message — a 64-character string with one typo
 * decodes short and the operator needs to be told it was not hex, not that it
 * was the wrong length.
 */
export function dataKeyFormatError(raw: string): string | null {
  const key = raw.trim();
  if (key === "") return "it is empty";
  if (!/^[0-9a-fA-F]*$/.test(key)) {
    const looksBase64 = /[^0-9a-fA-F]/.test(key) && /^[A-Za-z0-9+/]+={0,2}$/.test(key);
    return (
      `it contains characters that are not hex digits` +
      (looksBase64
        ? ` — this looks like BASE64. Mint the key with \`openssl rand -hex ${DATA_KEY_BYTES}\`, not \`-base64 ${DATA_KEY_BYTES}\`.`
        : ".")
    );
  }
  if (key.length !== DATA_KEY_HEX_CHARS) {
    return `it is ${key.length} hex characters, and exactly ${DATA_KEY_HEX_CHARS} are required (${DATA_KEY_BYTES} bytes, AES-256).`;
  }
  return null;
}

/** Same validation the envelope itself applies, so a key that cannot encrypt
 * can never acquire a fingerprint either. */
function keyBytes(dataKeyHex: string): Buffer {
  const problem = dataKeyFormatError(dataKeyHex);
  if (problem !== null) throw new Error(`data key is unusable: ${problem}`);
  return Buffer.from(dataKeyHex.trim(), "hex");
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
