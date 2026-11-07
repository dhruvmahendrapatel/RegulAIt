/**
 * ADR-0240 — the one second factor of the external portals (the supplier portal of ADR-0221 and the auditor portal
 * of ADR-0225): limits, token and cookie shapes, and the bodies both portals send. The gateway's
 * `external-mfa.ts` enforces every limit here; migration 0296's CHECKs repeat the ones a row must never break.
 *
 * The flow, for either portal, while its `…MfaRequired` setting is on (the shipped default):
 *   1. the single-use link is redeemed as before and is SPENT; no session is opened yet;
 *   2. the answer is `mfa: "enrol"` (first use for this grant: the TOTP secret and its otpauth URI, shown once) or
 *      `mfa: "verify"`, plus a challenge cookie scoped to the portal's `…/session/mfa` path;
 *   3. a POST of a six-digit code to `…/session/mfa` opens the session (and, on enrolment, activates the factor).
 * Wrong or replayed codes count; at `failuresBeforeLock` the factor locks and only the inviting admin can reset it.
 */
import { z } from "zod";

export const EXTERNAL_MFA_LIMITS = Object.freeze({
  /** a challenge (the step between a spent link and a session) lives this long (database CHECK: 15 minutes) */
  challengeMinutes: 10,
  /** consecutive wrong or replayed codes before the factor locks (audited); only an admin reset unlocks it */
  failuresBeforeLock: 5,
  /** code attempts per challenge per 15 minutes, on top of each portal's address limit */
  perChallenge: { max: 10, windowMs: 15 * 60_000 },
});

export const EXTERNAL_MFA_PORTALS = ["supplier", "auditor"] as const;
export type ExternalMfaPortal = (typeof EXTERNAL_MFA_PORTALS)[number];

/** the challenge cookie; one name, scoped per portal to its `…/session/mfa` path */
export const EXTERNAL_MFA_COOKIE = "regulait_ext_mfa";
export const EXTERNAL_MFA_PATHS: Readonly<Record<ExternalMfaPortal, string>> = Object.freeze({
  supplier: "/supplier/v1/session/mfa",
  auditor: "/v1/auditor/session/mfa",
});
export const EXTERNAL_MFA_TOKEN_PREFIX = "rgxm_";
/** prefix + 64 hex (32 random bytes); linear, no nested quantifiers */
export const EXTERNAL_MFA_TOKEN_RE = /^rgxm_[0-9a-f]{64}$/;

export const externalMfaVerifySchema = z.object({ code: z.string().regex(/^[0-9]{6}$/) }).strict();
export type ExternalMfaVerifyInput = z.infer<typeof externalMfaVerifySchema>;

/** what a spent link answers while the second factor is required */
export type ExternalMfaStart =
  | { mfa: "enrol"; secret: string; otpauthUri: string; challengeExpiresAt: string }
  | { mfa: "verify"; challengeExpiresAt: string };

/** a wrong or replayed code (the same body for both, so a replay is not distinguishable from a typo) */
export const EXTERNAL_MFA_CODE_REFUSAL = Object.freeze({
  error: "mfa_code_invalid",
  detail: "That code is not valid. Enter the current code from your authenticator app.",
});
/** no live challenge: none, expired, spent, revoked, or the factor was reset */
export const EXTERNAL_MFA_CHALLENGE_REFUSAL = Object.freeze({
  error: "mfa_challenge_not_valid",
  detail: "This sign-in step has ended. Open a new sign-in link from your contact.",
});
/** the factor is locked; recovery is never self-service */
export const EXTERNAL_MFA_LOCKED = Object.freeze({
  error: "mfa_locked",
  detail:
    "Sign-in is locked after too many wrong codes. Ask the person who invited you to reset your second factor and " +
    "send you a new link.",
});
/** the second factor is required but this deployment has no data key to keep its secret */
export const EXTERNAL_MFA_UNAVAILABLE = Object.freeze({
  error: "mfa_unavailable",
  detail: "Sign-in needs a second factor, and this deployment cannot store one yet. Tell your contact.",
});
