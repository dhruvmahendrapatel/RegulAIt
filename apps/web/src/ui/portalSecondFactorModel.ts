/**
 * ADR-0240 — the second-factor step of the external portals (the supplier portal and the auditor portal), shared by
 * both pages. A spent sign-in link answers either a session or, while the second factor is required, a challenge:
 * `mfa: "enrol"` (the secret and its otpauth URI, shown once) or `mfa: "verify"`. A six-digit code then opens the
 * session. The challenge itself rides in an HttpOnly cookie this page never sees.
 */
/**
 * What a spent link answers while the second factor is required. The SPA does not depend on `@regulait/shared`, so
 * this mirrors its `ExternalMfaStart` (packages/shared/src/external-mfa.ts); `isMfaStart` checks every field at runtime.
 */
export type ExternalMfaStart =
  | { mfa: "enrol"; secret: string; otpauthUri: string; challengeExpiresAt: string }
  | { mfa: "verify"; challengeExpiresAt: string };

/** does a link exchange's answer ask for the second factor? Anything malformed reads as "no" and fails later, closed. */
export function isMfaStart(body: unknown): body is ExternalMfaStart {
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  if (typeof b.challengeExpiresAt !== "string") return false;
  if (b.mfa === "verify") return true;
  return b.mfa === "enrol" && typeof b.secret === "string" && b.secret !== "" && typeof b.otpauthUri === "string";
}

/** what the page does after a code was sent */
export type MfaOutcome =
  | { kind: "signedIn" }
  /** the same step can take another code (a wrong code, or too many tries for now) */
  | { kind: "retry"; message: string }
  /** the step is over (expired, reset, or locked): only a new link helps */
  | { kind: "ended"; message: string };

export const CODE_FALLBACK = "That code is not valid. Enter the current code from your authenticator app.";
export const ENDED_FALLBACK = "This sign-in step has ended. Open a new sign-in link from your contact.";

/**
 * Read a refused code. A wrong or replayed code (401 `mfa_code_invalid`) and a rate limit (429) keep the step open;
 * every other refusal ends it, because the gateway has cleared the challenge cookie. The server's own sentence wins.
 */
export function mfaRefusal(status: number, body: { error?: unknown; detail?: unknown } | null): MfaOutcome {
  const detail = body && typeof body.detail === "string" && body.detail.trim() ? body.detail : null;
  if (status === 401 && body?.error === "mfa_code_invalid") return { kind: "retry", message: detail ?? CODE_FALLBACK };
  if (status === 429) return { kind: "retry", message: detail ?? "Too many tries. Wait a minute, then enter the current code." };
  return { kind: "ended", message: detail ?? ENDED_FALLBACK };
}

/** keep only digits, at most six: what an authenticator code can be */
export function cleanCode(raw: string): string {
  return raw.replace(/\D/g, "").slice(0, 6);
}
