/**
 * ADR-0183 batch 2.1 — TOTP on `otpauth`. Pure: no database.
 *
 * 1. RFC 6238 Appendix B (SHA-1 rows): the 6-digit code is the low six digits
 *    of the RFC's 8-digit value, because both are `bin mod 10^digits`.
 * 2. Byte-compatibility with the hand-written implementation this replaced:
 *    `previousTotpCode` below is that code, kept as a TEST ORACLE only, so a
 *    secret enrolled before the swap provably yields the same codes after it.
 * 3. The window (previous, current, next step) and the replay rule (a step at
 *    or before the last accepted one is refused) are RegulAIt's, not the
 *    library's, and are pinned here.
 * 4. The enrolment URI keeps its exact bytes.
 */
import { createHmac, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  generateTotpSecret,
  otpauthUri,
  TOTP_DIGITS,
  TOTP_PERIOD_SECONDS,
  totpCode,
  totpStep,
  verifyTotp,
} from "./totp.js";

// ASCII "12345678901234567890", the RFC 6238 Appendix B SHA-1 seed, in base32
const RFC_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
const RFC_VECTORS: Array<[timeSeconds: number, eightDigit: string]> = [
  [59, "94287082"],
  [1111111109, "07081804"],
  [1111111111, "14050471"],
  [1234567890, "89005924"],
  [2000000000, "69279037"],
  [20000000000, "65353130"],
];

/** The pre-`otpauth` implementation (base32 + RFC 4226 truncation), oracle only. */
function previousTotpCode(secretBase32: string, step: number): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  const key: number[] = [];
  for (const ch of secretBase32.toUpperCase().replace(/=+$/, "")) {
    value = (value << 5) | alphabet.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      key.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const d = createHmac("sha1", Buffer.from(key)).update(counter).digest();
  const o = d[d.length - 1]! & 0x0f;
  const bin = ((d[o]! & 0x7f) << 24) | (d[o + 1]! << 16) | (d[o + 2]! << 8) | d[o + 3]!;
  return String(bin % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, "0");
}

function previousBase32(buf: Buffer): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += alphabet[(value << (5 - bits)) & 31];
  return out;
}

const at = (step: number) => step * TOTP_PERIOD_SECONDS * 1000 + 1234;

describe("RFC 6238 Appendix B test vectors (SHA-1)", () => {
  for (const [t, eight] of RFC_VECTORS) {
    it(`T=${t}s → ${eight.slice(-TOTP_DIGITS)}`, () => {
      const step = totpStep(t * 1000);
      expect(step).toBe(Math.floor(t / 30));
      expect(totpCode(RFC_SECRET, step)).toBe(eight.slice(-TOTP_DIGITS));
      expect(verifyTotp(RFC_SECRET, eight.slice(-TOTP_DIGITS), null, t * 1000)).toBe(step);
    });
  }
});

describe("secrets enrolled before the swap keep working", () => {
  it("a fresh secret is 32 upper-case base32 characters (20 bytes), the stored format", () => {
    for (let i = 0; i < 20; i++) expect(generateTotpSecret()).toMatch(/^[A-Z2-7]{32}$/);
  });

  it("codes equal the previous implementation's for random secrets and steps", () => {
    for (let i = 0; i < 200; i++) {
      const secret = previousBase32(randomBytes(20));
      const step = Math.floor(Math.random() * 2 ** 34);
      expect(totpCode(secret, step)).toBe(previousTotpCode(secret, step));
    }
  });

  it("a lower-case or '='-padded secret decodes as before", () => {
    expect(totpCode(RFC_SECRET.toLowerCase(), 1)).toBe(totpCode(RFC_SECRET, 1));
    expect(totpCode(`${RFC_SECRET}====`, 1)).toBe(totpCode(RFC_SECRET, 1));
  });

  it("the enrolment URI keeps its exact bytes", () => {
    expect(otpauthUri("ann+mfa@example.test", "JBSWY3DPEHPK3PXP")).toBe(
      "otpauth://totp/RegulAIt%3Aann%2Bmfa%40example.test?secret=JBSWY3DPEHPK3PXP&issuer=RegulAIt&algorithm=SHA1&digits=6&period=30",
    );
  });
});

describe("window and replay protection", () => {
  const secret = previousBase32(Buffer.from("regulait-synthetic-totp-seed"));
  const now = 60_000_000;

  it("accepts the previous, current and next step, returning the step consumed", () => {
    for (const d of [-1, 0, 1]) expect(verifyTotp(secret, totpCode(secret, now + d), null, at(now))).toBe(now + d);
  });

  it("refuses a code from outside the window (two steps away either side)", () => {
    expect(verifyTotp(secret, totpCode(secret, now - 2), null, at(now))).toBeNull();
    expect(verifyTotp(secret, totpCode(secret, now + 2), null, at(now))).toBeNull();
  });

  it("refuses a replayed code: the same step again, inside its validity window", () => {
    const code = totpCode(secret, now);
    const used = verifyTotp(secret, code, null, at(now));
    expect(used).toBe(now);
    expect(verifyTotp(secret, code, used, at(now))).toBeNull();
    // still refused a step later, when that code is the 'previous' one
    expect(verifyTotp(secret, code, used, at(now + 1))).toBeNull();
  });

  it("refuses any step at or before the last accepted one, even an older valid one", () => {
    expect(verifyTotp(secret, totpCode(secret, now - 1), now, at(now))).toBeNull();
    expect(verifyTotp(secret, totpCode(secret, now + 1), now, at(now))).toBe(now + 1);
  });

  it("refuses malformed codes without throwing", () => {
    for (const bad of ["", "12345", "1234567", "12345a", "１２３４５６", "12345é", " 12345"]) {
      expect(verifyTotp(secret, bad, null, at(now))).toBeNull();
    }
  });
});
