/**
 * ADR-0181 (strict defaults everywhere) — identity and sessions.
 *
 * The strict values a fresh install starts with. The database column defaults
 * (migration 0156) are the authority; these constants exist so the UI and the
 * tests can name the same values without re-typing them. An admin may relax
 * each one through its existing audited write route.
 */
export const STRICT_IDENTITY_DEFAULTS = {
  /** an admin enrols TOTP before reaching the app; other users are not forced */
  mfaRequired: "admins",
  passwordRequireClasses: 3,
  sessionIdleMinutes: 30,
  /** days; applied to a key issued with no expiry */
  apiKeyDefaultTtlDays: 90,
  /** days; the ceiling on any requested expiry (including "never") */
  apiKeyMaxTtlDays: 365,
  approvalDelegationEnabled: false,
  /** SAML: the Response envelope must be signed as well as the assertion */
  samlWantAuthnResponseSigned: true,
} as const;

/** the error code an OIDC provider write gets when JIT is on with no domains */
export const OIDC_JIT_DOMAINS_REQUIRED = "jit_requires_allowed_domains";

/**
 * ADR-0181: JIT provisioning creates an account from whatever email the IdP
 * asserts, so an OIDC provider with JIT on must name the email domains it
 * accepts. Evaluate it over the EFFECTIVE values (stored row + patch), so a
 * two-step PATCH cannot reach the refused combination.
 */
export function oidcJitDomainsMissing(v: {
  jitProvisioning?: boolean | null;
  allowedEmailDomains?: readonly string[] | null;
}): boolean {
  return v.jitProvisioning === true && !(v.allowedEmailDomains && v.allowedEmailDomains.length > 0);
}
