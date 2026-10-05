/**
 * ADR-0181 SA — the demo's identity posture, configured truthfully.
 *
 * The demo runs on the strict identity defaults; nothing here relaxes one:
 *  - MFA is required for admins, so Ada (the one admin persona) enrols TOTP at
 *    her first browser sign-in. Dana and Avery are not admins.
 *  - Passwords need three character classes; the one-time passwords the seed
 *    prints already have four, and `demo:set-passwords` checks the presenter's
 *    own password against the same policy.
 *  - API keys expire. Each key the demo tooling mints asks for a lifetime that
 *    suits its use, inside the org's 365-day ceiling: the persona keys the seed
 *    prints for the presenter last the demo period, and a key a prep script
 *    mints for itself lasts a day.
 */
const DAY_MS = 24 * 60 * 60 * 1000;

/** the persona keys `seed` prints for the presenter (programmatic / IDE use) */
export const SEED_PERSONA_KEY_TTL_DAYS = 30;
/** a key a prep or gate script mints for its own run and then discards */
export const DEMO_SCRIPT_KEY_TTL_DAYS = 1;

/** the `expiresAt` a demo key request carries */
export function demoKeyExpiresAt(days: number, now: Date = new Date()): string {
  return new Date(now.getTime() + days * DAY_MS).toISOString();
}

type Call = (method: string, url: string) => Promise<Record<string, unknown>>;

/** Prints the identity posture the demo runs under. It reads the live
 * settings rather than restating the defaults, so a relaxed dial shows. */
export async function seedStrictIdentity(call: Call): Promise<void> {
  const settings = ((await call("GET", "/v1/org/settings")).settings ?? {}) as Record<string, unknown>;
  const ttl = (v: unknown) => (v === null || v === undefined ? "none" : `${String(v)} days`);
  console.log(
    [
      "",
      "  Identity posture (ADR-0181 strict defaults):",
      `    MFA required for: ${String(settings.mfaRequired)}` +
        (settings.mfaRequired === "off" ? "" : " — admin enrols TOTP at first sign-in (Ada)"),
      `    password character classes: ${String(settings.passwordRequireClasses)}; idle sign-out: ${String(settings.sessionIdleMinutes)} min`,
      `    API keys: default ${ttl(settings.apiKeyDefaultTtlDays)}, ceiling ${ttl(settings.apiKeyMaxTtlDays)}; ` +
        `seeded persona keys ${SEED_PERSONA_KEY_TTL_DAYS} days, prep-script keys ${DEMO_SCRIPT_KEY_TTL_DAYS} day`,
      `    approver delegation: ${settings.approvalDelegationEnabled === true ? "on" : "off"}`,
    ].join("\n"),
  );
}
