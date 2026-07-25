import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * AES-256-GCM envelope for stored secrets (git tokens). The key is the
 * deploy-time REGULAIT_DATA_KEY (64 hex chars). Format: iv.tag.ciphertext,
 * hex-encoded. Without a key, secret storage is refused rather than
 * degraded to plaintext.
 */
export function encryptSecret(dataKeyHex: string, plaintext: string): string {
  const key = Buffer.from(dataKeyHex, "hex");
  if (key.length !== 32) throw new Error("data key must be 32 bytes (64 hex chars)");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return `${iv.toString("hex")}.${cipher.getAuthTag().toString("hex")}.${enc.toString("hex")}`;
}

export function decryptSecret(dataKeyHex: string, stored: string): string {
  const key = Buffer.from(dataKeyHex, "hex");
  const [ivHex, tagHex, encHex] = stored.split(".");
  if (!ivHex || !tagHex || !encHex) throw new Error("malformed ciphertext");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return Buffer.concat([decipher.update(Buffer.from(encHex, "hex")), decipher.final()]).toString(
    "utf8",
  );
}
