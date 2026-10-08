/**
 * ADR-0181 SA — the demo's identity posture, configured truthfully.
 *
 * The demo runs on the strict identity defaults; nothing here relaxes one:
 *  - MFA is required for admins, and an admin's API key answers to it too
 *    (FX2). The prep tooling acts as Ada through keys, so the seed enrols her
 *    TOTP through the real routes before minting one, and prints the
 *    authenticator secret ONCE beside her one-time password (`enrolAdminTotp`
 *    below). Dana and Avery are not admins.
 *  - Passwords need three character classes; the one-time passwords the seed
 *    prints already have four, and `demo:set-passwords` checks the presenter's
 *    own password against the same policy.
 *  - API keys expire. Each key the demo tooling mints asks for a lifetime that
 *    suits its use, inside the org's 365-day ceiling: the persona keys the seed
 *    prints for the presenter last the demo period, and a key a prep script
 *    mints for itself lasts a day.
 */
import { totpCode, totpStep } from "./totp.js";

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

/** the one method of a Fastify app the revocation below needs */
type Injector = {
  inject(opts: { method: "POST"; url: string; headers: Record<string, string> }): PromiseLike<{ statusCode: number }>;
};

/**
 * ADR-0181 (integration): a prep script's own key is revoked at the END of its
 * own run, through the real admin route. An admin-owned API key carries
 * administrator power on every admin route, so the stale-credential monitor
 * flags each one as over-scoped — a TRUE finding about the demo's own hygiene
 * if a script left one behind. The one-day expiry above stays as the backstop
 * when a run dies before it gets here. Returns one note per key that could not
 * be revoked (the id only, never a token).
 */
export async function revokeScriptKeys(
  app: Injector,
  bootstrapToken: string,
  keyIds: ReadonlyArray<string | undefined>,
): Promise<string[]> {
  const notes: string[] = [];
  for (const id of keyIds) {
    if (!id) continue;
    const r = await app.inject({
      method: "POST",
      url: `/v1/keys/${id}/revoke`,
      headers: { authorization: `Bearer ${bootstrapToken}` },
    });
    // 404 = already revoked, which is the state this wants
    if (r.statusCode !== 200 && r.statusCode !== 404) notes.push(`could not revoke script key ${id}: ${r.statusCode}`);
  }
  return notes;
}

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
        (settings.mfaRequired === "off"
          ? ""
          : " — API keys included; Ada's TOTP is enrolled by the seed, her authenticator secret shown once below"),
      `    password character classes: ${String(settings.passwordRequireClasses)}; idle sign-out: ${String(settings.sessionIdleMinutes)} min`,
      `    API keys: default ${ttl(settings.apiKeyDefaultTtlDays)}, ceiling ${ttl(settings.apiKeyMaxTtlDays)}; ` +
        `seeded persona keys ${SEED_PERSONA_KEY_TTL_DAYS} days, prep-script keys ${DEMO_SCRIPT_KEY_TTL_DAYS} day`,
      `    approver delegation: ${settings.approvalDelegationEnabled === true ? "on" : "off"}`,
    ].join("\n"),
  );
}

// ---------------------------------------------------------------------------
// ADR-0181 (FX2, review finding 3): an admin's API key answers to the org MFA
// requirement, so an admin persona the demo tooling acts as through a key must
// have TOTP enrolled FIRST — the key is refused (and none is issued) otherwise.
// This enrols it the way a person does, through the real routes, and nothing
// is relaxed: an admin issues a one-time password (audited), the person signs
// in with it, enrols and activates TOTP with a code from the new secret
// (audited `mfa-enabled`), and signs out. The one-time password still has to
// be changed at the first browser sign-in.

/** the one method of a Fastify app the enrolment needs (any verb) */
type AnyInjector = {
  inject(opts: {
    method: "GET" | "POST";
    url: string;
    headers?: Record<string, string>;
    payload?: object;
  }): PromiseLike<{ statusCode: number; body: string; headers: Record<string, unknown>; json(): unknown }>;
};

export type AdminTotpEnrolment =
  | { status: "already" }
  | { status: "enrolled"; password: string; secret: string; otpauthUri: string }
  | { status: "refused"; reason: string };

/**
 * Enrol TOTP for `userId` through the real routes (see above). Only an account
 * that has NO password yet is enrolled this way — a password somebody set is
 * theirs, and this never overwrites it; such an account enrols at its own next
 * sign-in. Returns the one-time password and the TOTP secret exactly once, for
 * the caller to show exactly once (never to a file, never in an audit row).
 */
export async function enrolAdminTotp(
  app: AnyInjector,
  bootstrapToken: string,
  userId: string,
): Promise<AdminTotpEnrolment> {
  const boot = { authorization: `Bearer ${bootstrapToken}` };
  const csrf = { "x-regulait-csrf": "1" };
  const list = await app.inject({ method: "GET", url: "/v1/users", headers: boot });
  const user = ((list.json() as { users?: Array<Record<string, unknown>> }).users ?? []).find((u) => u.id === userId);
  if (!user) return { status: "refused", reason: `user ${userId} not found` };
  if (user.totpEnabled === true) return { status: "already" };
  const email = String(user.email);
  if (user.hasPassword === true) {
    return {
      status: "refused",
      reason: `${email} already has a password but no TOTP: sign in as ${email} once (the app enrols TOTP at that sign-in), then re-run`,
    };
  }
  const issued = await app.inject({ method: "POST", url: `/v1/users/${userId}/set-initial-password`, headers: boot, payload: {} });
  if (issued.statusCode !== 200) return { status: "refused", reason: `one-time password: ${issued.statusCode}` };
  const password = (issued.json() as { password: string }).password;
  const login = await app.inject({ method: "POST", url: "/auth/login", headers: csrf, payload: { identifier: email, password } });
  const setCookie = ([] as unknown[]).concat(login.headers["set-cookie"] ?? []).map(String);
  const session = setCookie.map((c) => /^regulait_session=([^;]+)/.exec(c)?.[1]).find(Boolean);
  if (login.statusCode !== 200 || !session) return { status: "refused", reason: `sign-in: ${login.statusCode}` };
  const asPerson = { ...csrf, cookie: `regulait_session=${session}` };
  try {
    const enrolled = await app.inject({ method: "POST", url: "/auth/totp/enroll", headers: asPerson, payload: {} });
    if (enrolled.statusCode !== 200) return { status: "refused", reason: `TOTP enrol: ${enrolled.statusCode}` };
    const { secret, otpauthUri } = enrolled.json() as { secret: string; otpauthUri: string };
    // the PREVIOUS step's code, so a sign-in later in the same 30 s window can
    // still use the current one (the gateway refuses a step it already accepted).
    // If a 30 s boundary passes between computing the code and the gateway
    // checking it, that code is two steps old and outside the ±1 window: a
    // refused activation consumes nothing, so try once more with a fresh step.
    const activate = () =>
      app.inject({
        method: "POST",
        url: "/auth/totp/activate",
        headers: asPerson,
        payload: { code: totpCode(secret, totpStep() - 1) },
      });
    let activated = await activate();
    if (activated.statusCode === 401) activated = await activate();
    if (activated.statusCode !== 200) return { status: "refused", reason: `TOTP activate: ${activated.statusCode}` };
    return { status: "enrolled", password, secret, otpauthUri };
  } finally {
    await app.inject({ method: "POST", url: "/auth/logout", headers: asPerson });
  }
}
