/**
 * CodeQL triage, PR #117 — pins the two properties the dismissals rest on, so a
 * later change that breaks either one fails here instead of silently turning a
 * false positive into a real finding.
 *
 * 1. js/insufficient-password-hash on `hashToken` (sha256, no work factor): every
 *    credential that reaches it is a server-generated token with at least 192
 *    bits of `randomBytes` entropy. Passwords, including the one-time initial
 *    password, go through scrypt (`hashPassword`), never through `hashToken`.
 * 2. js/clear-text-storage-of-sensitive-data on the pending-MFA cookie: the
 *    cookie carries only an opaque 256-bit handle (no user id, no TOTP state),
 *    with HttpOnly, SameSite, a narrow Path, a minutes-long Max-Age and Secure
 *    over TLS; the server keeps only sha256(handle).
 * 3. The same rule on the ADR-0240 external-portal challenge cookie (PR #709): an
 *    opaque 256-bit handle, HttpOnly, SameSite=Strict, scoped to one verify path,
 *    at most 10 minutes; the server keeps only sha256(handle).
 *
 * Pure: no database.
 */
import { describe, expect, it } from "vitest";
import { generateSessionToken, generateToken, hashPassword, MFA_PENDING_COOKIE, mfaPendingCookie } from "./auth.js";
import { generateFeedbackLinkToken } from "./feedback.js";
import { generateScimToken } from "./scim.js";
import { hashToken } from "./token-hash.js";
import { generateVirtualKeyToken } from "./virtual-keys.js";
import { challengeCookie, newChallengeToken } from "./external-mfa.js";
import { EXTERNAL_MFA_COOKIE } from "@regulait/shared";

/** bits of randomness in a token: the random part after its fixed prefix */
function randomBits(token: string, prefix: string, encoding: "hex" | "base64url"): number {
  expect(token.startsWith(prefix)).toBe(true);
  return Buffer.from(token.slice(prefix.length), encoding).length * 8;
}

describe("hashToken only ever sees high-entropy, server-generated tokens", () => {
  const generators: Array<[string, () => { token: string; tokenHash: string }, string, number]> = [
    ["API key (generateToken)", generateToken, "rgl_", 192],
    ["virtual key (generateVirtualKeyToken)", generateVirtualKeyToken, "rglv_", 192],
    ["session / pending-MFA handle (generateSessionToken)", generateSessionToken, "rgls_", 256],
    ["SCIM token (generateScimToken)", generateScimToken, "rglscim_", 256],
    ["signed feedback link (generateFeedbackLinkToken, ADR-0182 A13)", generateFeedbackLinkToken, "rglf_", 256],
    ["external-portal MFA challenge (newChallengeToken, ADR-0240)", newChallengeToken, "rgxm_", 256],
  ];

  for (const [name, generate, prefix, bits] of generators) {
    it(`${name}: ${bits} random bits, stored as sha256(token) only`, () => {
      const a = generate();
      const b = generate();
      expect(randomBits(a.token, prefix, "hex")).toBeGreaterThanOrEqual(bits);
      expect(a.token).not.toBe(b.token);
      expect(a.tokenHash).toBe(hashToken(a.token));
      expect(a.tokenHash).toMatch(/^[0-9a-f]{64}$/);
      expect(a.tokenHash).not.toContain(a.token.slice(prefix.length));
    });
  }

  it("passwords use scrypt, not hashToken", () => {
    const stored = hashPassword("Rg1-correct horse");
    expect(stored.startsWith("scrypt$")).toBe(true);
    expect(stored).not.toContain(hashToken("Rg1-correct horse"));
  });
});

describe("the pending-MFA cookie carries an opaque handle, never state", () => {
  it("is HttpOnly, SameSite, path-scoped, short-lived and Secure over TLS", () => {
    const { token } = generateSessionToken();
    const cookie = mfaPendingCookie(token, true, 300);
    expect(cookie).toBe(`${MFA_PENDING_COOKIE}=${token}; Path=/auth/mfa; HttpOnly; SameSite=Lax; Max-Age=300; Secure`);
    expect(mfaPendingCookie(token, false, 300)).not.toContain("Secure");
    // the clearing form written after /auth/mfa/verify holds nothing at all
    expect(mfaPendingCookie("", true, 0)).toBe(`${MFA_PENDING_COOKIE}=; Path=/auth/mfa; HttpOnly; SameSite=Lax; Max-Age=0; Secure`);
  });
});

describe("the external-portal MFA challenge cookie carries an opaque handle, never state (ADR-0240)", () => {
  it("is HttpOnly, SameSite=Strict, scoped to the portal's verify path, and clears to an empty value", () => {
    const { token } = newChallengeToken();
    expect(challengeCookie("supplier", token, true, 600)).toBe(
      `${EXTERNAL_MFA_COOKIE}=${token}; Path=/supplier/v1/session/mfa; HttpOnly; SameSite=Strict; Max-Age=600; Secure`,
    );
    expect(challengeCookie("auditor", token, true, 600)).toBe(
      `${EXTERNAL_MFA_COOKIE}=${token}; Path=/v1/auditor/session/mfa; HttpOnly; SameSite=Strict; Max-Age=600; Secure`,
    );
    expect(challengeCookie("auditor", "", true, 0)).toBe(`${EXTERNAL_MFA_COOKIE}=; Path=/v1/auditor/session/mfa; HttpOnly; SameSite=Strict; Max-Age=0; Secure`);
    expect(token).toMatch(/^rgxm_[0-9a-f]{64}$/);
  });
});
