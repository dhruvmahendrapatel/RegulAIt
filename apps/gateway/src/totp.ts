/**
 * TOTP (RFC 6238 via HMAC-SHA1) — the gateway's one implementation.
 *
 * Moved out of `auth.ts` (which re-exports every name, so existing imports
 * are unchanged) for ADR-0181: with MFA required for admins by default, the
 * Playwright journeys must answer enrolment and sign-in challenges by
 * computing codes from the enrolment secret, and they do it with THIS code
 * (`apps/gateway/dist/totp.js`), not a second implementation. This module
 * imports only node:crypto and the shared constant-time compare, so loading
 * it never opens a database or reads configuration.
 */
import { createHmac, randomBytes } from "node:crypto";
import { constantTimeEqual } from "@regulait/shared";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/=+$/, "").replace(/\s+/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error("invalid base32");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;

export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20)); // 160-bit secret per RFC 4226
}

export function totpStep(atMs: number = Date.now()): number {
  return Math.floor(atMs / 1000 / TOTP_PERIOD_SECONDS);
}

export function totpCode(secretBase32: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = createHmac("sha1", base32Decode(secretBase32)).update(counter).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const bin =
    ((digest[offset]! & 0x7f) << 24) |
    (digest[offset + 1]! << 16) |
    (digest[offset + 2]! << 8) |
    digest[offset + 3]!;
  return String(bin % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, "0");
}

/**
 * Verify a code within ±1 time-step (clock skew tolerance) with REPLAY
 * PROTECTION: any step <= lastUsedStep is refused, so a consumed code can
 * never be replayed inside its validity window. Returns the consumed step
 * (to persist as the new lastUsedStep) or null.
 */
export function verifyTotp(
  secretBase32: string,
  code: string,
  lastUsedStep: number | null,
  atMs: number = Date.now(),
): number | null {
  const now = totpStep(atMs);
  for (const step of [now, now - 1, now + 1]) {
    if (lastUsedStep !== null && step <= lastUsedStep) continue;
    if (constantTimeEqual(totpCode(secretBase32, step), code)) return step;
  }
  return null;
}

export function otpauthUri(email: string, secretBase32: string): string {
  const label = encodeURIComponent(`RegulAIt:${email}`);
  return `otpauth://totp/${label}?secret=${secretBase32}&issuer=RegulAIt&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_PERIOD_SECONDS}`;
}
