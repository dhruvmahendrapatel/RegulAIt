import { describe, expect, it } from "vitest";
import { CODE_FALLBACK, cleanCode, ENDED_FALLBACK, isMfaStart, mfaRefusal } from "./portalSecondFactor";

const at = "2026-11-19T22:10:00.000Z";

describe("isMfaStart (ADR-0240)", () => {
  it("reads an enrolment answer with its secret and URI", () => {
    expect(isMfaStart({ mfa: "enrol", secret: "JBSWY3DPEHPK3PXP", otpauthUri: "otpauth://totp/x?secret=JBSWY3DPEHPK3PXP", challengeExpiresAt: at })).toBe(true);
  });
  it("reads a verify answer, which never carries a secret", () => {
    expect(isMfaStart({ mfa: "verify", challengeExpiresAt: at })).toBe(true);
  });
  it("treats a session answer (no mfa key) as no second factor", () => {
    expect(isMfaStart({ vendorName: "Acme", framework: "iso27001", sessionExpiresAt: at })).toBe(false);
    expect(isMfaStart({ sessionExpiresAt: at })).toBe(false);
  });
  it("fails closed on a malformed answer", () => {
    expect(isMfaStart(null)).toBe(false);
    expect(isMfaStart("enrol")).toBe(false);
    expect(isMfaStart({ mfa: "enrol", challengeExpiresAt: at })).toBe(false); // no secret
    expect(isMfaStart({ mfa: "enrol", secret: "", otpauthUri: "x", challengeExpiresAt: at })).toBe(false);
    expect(isMfaStart({ mfa: "verify" })).toBe(false); // no expiry
    expect(isMfaStart({ mfa: "other", challengeExpiresAt: at })).toBe(false);
  });
});

describe("mfaRefusal (ADR-0240)", () => {
  it("keeps the step open on a wrong or replayed code, with the server's sentence", () => {
    expect(mfaRefusal(401, { error: "mfa_code_invalid", detail: "That code is not valid." })).toEqual({ kind: "retry", message: "That code is not valid." });
    expect(mfaRefusal(401, { error: "mfa_code_invalid" })).toEqual({ kind: "retry", message: CODE_FALLBACK });
  });
  it("keeps the step open on a rate limit", () => {
    expect(mfaRefusal(429, { error: "rate_limited", detail: "Slow down." }).kind).toBe("retry");
    expect(mfaRefusal(429, null).kind).toBe("retry");
  });
  it("ends the step on an expired challenge, a lock or anything else", () => {
    expect(mfaRefusal(401, { error: "mfa_challenge_not_valid", detail: "This sign-in step has ended." })).toEqual({ kind: "ended", message: "This sign-in step has ended." });
    expect(mfaRefusal(423, { error: "mfa_locked", detail: "Locked." })).toEqual({ kind: "ended", message: "Locked." });
    expect(mfaRefusal(500, null)).toEqual({ kind: "ended", message: ENDED_FALLBACK });
    // a 401 without the code-invalid error is not a wrong code
    expect(mfaRefusal(401, { error: "unauthenticated" }).kind).toBe("ended");
  });
});

describe("cleanCode", () => {
  it("keeps at most six digits", () => {
    expect(cleanCode("12 34-56")).toBe("123456");
    expect(cleanCode("1234567")).toBe("123456");
    expect(cleanCode("abc")).toBe("");
  });
});
