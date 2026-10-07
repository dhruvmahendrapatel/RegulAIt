/**
 * TOTP (RFC 6238, HMAC-SHA1, 6 digits, 30-second step) — the gateway's one
 * implementation, built on the `otpauth` library (MIT, ADR-0176; batch 2.1 of
 * ADR-0183 replaced the hand-written HOTP and base32 code that lived here).
 *
 * What stays RegulAIt's own, and why:
 *  - the WINDOW and the REPLAY rule in `verifyTotp`: the previous, current and
 *    next step are tried, and any step at or before the last one accepted is
 *    refused. `otpauth`'s validator answers "which delta matched" but knows
 *    nothing of a consumed step, so each candidate step is checked on its own
 *    with `HOTP.validate({ window: 0 })` (its constant-time compare);
 *  - the enrolment URI in `otpauthUri`: its exact bytes (`RegulAIt%3A<email>`,
 *    `secret` before `issuer`) are what every enrolled authenticator was given
 *    and what the docs show. `otpauth`'s own `TOTP#toString()` orders and
 *    escapes them differently (`RegulAIt:<email>?issuer=…`); both parse to the
 *    same account, but the URI is kept byte-for-byte rather than changed under
 *    existing enrolments.
 *
 * Secrets are stored as unpadded upper-case base32 of 20 random bytes, exactly
 * as before, so every enrolled secret keeps working (proved in `totp.test.ts`
 * against the RFC 6238 Appendix B vectors and the previous implementation).
 *
 * Moved out of `auth.ts` (which re-exports every name) for ADR-0181: the
 * Playwright journeys compute codes with THIS module
 * (`apps/gateway/dist/totp.js`), so it imports only `otpauth`, never a
 * database or configuration.
 */
import { HOTP, Secret, TOTP } from "otpauth";

export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;
const ALGORITHM = "SHA1";
const CODE_SHAPE = new RegExp(`^[0-9]{${TOTP_DIGITS}}$`);

export function generateTotpSecret(): string {
  return new Secret({ size: 20 }).base32; // 160-bit secret per RFC 4226
}

export function totpStep(atMs: number = Date.now()): number {
  return TOTP.counter({ period: TOTP_PERIOD_SECONDS, timestamp: atMs });
}

export function totpCode(secretBase32: string, step: number): string {
  return HOTP.generate({
    secret: Secret.fromBase32(secretBase32),
    algorithm: ALGORITHM,
    digits: TOTP_DIGITS,
    counter: step,
  });
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
  // anything but six ASCII digits can never match, and refusing it here keeps a
  // multi-byte string away from the library's byte-length compare
  if (!CODE_SHAPE.test(code)) return null;
  const secret = Secret.fromBase32(secretBase32);
  const now = totpStep(atMs);
  for (const step of [now, now - 1, now + 1]) {
    if (lastUsedStep !== null && step <= lastUsedStep) continue;
    if (HOTP.validate({ token: code, secret, algorithm: ALGORITHM, digits: TOTP_DIGITS, counter: step, window: 0 }) === 0) {
      return step;
    }
  }
  return null;
}

export function otpauthUri(email: string, secretBase32: string): string {
  const label = encodeURIComponent(`RegulAIt:${email}`);
  return `otpauth://totp/${label}?secret=${secretBase32}&issuer=RegulAIt&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_PERIOD_SECONDS}`;
}
