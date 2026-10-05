/**
 * ADR-0181 test fixture: the strict identity defaults, and the two honest ways
 * a suite about something ELSE copes with them.
 *
 * 1. `enrolTotpForTest` — an admin session must enrol TOTP before it reaches
 *    the app (mfaRequired = admins). A suite that drives an admin through a
 *    cookie session enrols, exactly as a person would: enroll, then activate
 *    with a code computed from the returned secret by the gateway's own TOTP
 *    code. Nothing is relaxed.
 * 2. `relaxIdentityForTest` — a suite that pins pre-0181 behaviour (a key with
 *    no expiry, a delegation window, a two-class password) sets the lax value
 *    it needs, explicitly, and gets back a `restore()` that puts the strict
 *    default back. Call it in the file's afterAll (M-068: global state is
 *    removed before the spec ends).
 */
import { eq, orgSettings, ORG_SETTINGS_ID, type Db, type OrgSettingsRow } from "@regulait/db";
import { STRICT_IDENTITY_DEFAULTS } from "@regulait/shared";
import { loadOrgSettings } from "../org-settings.js";
import { totpCode, totpStep } from "../totp.js";

type Inject = (opts: {
  method: "POST";
  url: string;
  headers?: Record<string, string>;
  cookies?: Record<string, string>;
  payload?: unknown;
}) => Promise<{ statusCode: number; json: () => unknown; body: string }>;

/** Enrol and activate TOTP for the user behind `cookie`; returns the secret.
 * The activation code is the PREVIOUS step's, so a sign-in later in the same
 * test can still use the current step (replay protection refuses any step at
 * or before the last one used). */
export async function enrolTotpForTest(app: { inject: Inject }, cookie: string): Promise<string> {
  const csrf = { "x-regulait-csrf": "1" };
  const enrolled = await app.inject({
    method: "POST",
    url: "/auth/totp/enroll",
    headers: csrf,
    cookies: { regulait_session: cookie },
  });
  if (enrolled.statusCode !== 200) throw new Error(`totp enroll -> ${enrolled.statusCode}: ${enrolled.body}`);
  const { secret } = enrolled.json() as { secret: string };
  const activated = await app.inject({
    method: "POST",
    url: "/auth/totp/activate",
    headers: csrf,
    cookies: { regulait_session: cookie },
    payload: { code: totpCode(secret, totpStep() - 1) },
  });
  if (activated.statusCode !== 200) throw new Error(`totp activate -> ${activated.statusCode}: ${activated.body}`);
  return secret;
}

/** the identity dials a suite may relax, and their strict (shipped) values */
export type RelaxableIdentity = Pick<
  OrgSettingsRow,
  | "mfaRequired"
  | "passwordRequireClasses"
  | "sessionIdleMinutes"
  | "apiKeyDefaultTtlDays"
  | "apiKeyMaxTtlDays"
  | "approvalDelegationEnabled"
>;

export const STRICT_IDENTITY: RelaxableIdentity = {
  mfaRequired: STRICT_IDENTITY_DEFAULTS.mfaRequired,
  passwordRequireClasses: STRICT_IDENTITY_DEFAULTS.passwordRequireClasses,
  sessionIdleMinutes: STRICT_IDENTITY_DEFAULTS.sessionIdleMinutes,
  apiKeyDefaultTtlDays: STRICT_IDENTITY_DEFAULTS.apiKeyDefaultTtlDays,
  apiKeyMaxTtlDays: STRICT_IDENTITY_DEFAULTS.apiKeyMaxTtlDays,
  approvalDelegationEnabled: STRICT_IDENTITY_DEFAULTS.approvalDelegationEnabled,
};

/** Set the named identity dials to a lax value for this suite; the returned
 * function restores exactly those dials to their strict default. */
export async function relaxIdentityForTest(
  db: Db,
  patch: Partial<RelaxableIdentity>,
): Promise<() => Promise<void>> {
  await loadOrgSettings(db); // the singleton exists
  await db.update(orgSettings).set(patch).where(eq(orgSettings.id, ORG_SETTINGS_ID));
  const restore = Object.fromEntries(
    Object.keys(patch).map((k) => [k, STRICT_IDENTITY[k as keyof RelaxableIdentity]]),
  ) as Partial<RelaxableIdentity>;
  return async () => {
    await db.update(orgSettings).set(restore).where(eq(orgSettings.id, ORG_SETTINGS_ID));
  };
}
