/**
 * HTTP rate limiting (ADR-0031 item 4).
 *
 * Before this, the gateway had a per-ACCOUNT login lockout (ADR-0025) and
 * nothing else: no bound at all on per-IP or per-key request rates across any
 * of the ~167 endpoints. Credential spraying that touches each account once is
 * invisible to a per-account lockout, and general abuse of the governed
 * dispatch surfaces was unmetered.
 *
 * TWO TIERS, and the split is the security property (ADR-0167, AUTHZ-01 /
 * CFG-01). Every bucket a request is counted against BEFORE it authenticates
 * is keyed on something the caller cannot choose — the REAL client IP:
 *
 *   - `ip:<ip>`    the generous global bucket for anonymous requests, so
 *                  ordinary interactive and CI traffic never notices it;
 *   - `ipk:<ip>`   a larger per-IP bucket for requests CARRYING a bearer. A
 *                  busy service account behind one NAT must not be throttled
 *                  into uselessness by, or throttle, its neighbours, so the
 *                  bearer-carrying ceiling is the api-key ceiling rather than
 *                  the anonymous one. It is still keyed on the IP: a bearer
 *                  the gateway has not verified is just a string the caller
 *                  typed, and a bucket named after it would be a bucket the
 *                  caller mints at will;
 *   - `auth:<ip>`  a much stricter bucket on the three unauthenticated
 *                  credential-accepting endpoints (/auth/login,
 *                  /auth/mfa/verify, /auth/login-with-key), which is what
 *                  actually stops spraying;
 *   - `auth:stepup:<ip>` the same strict tier on the two step-up ceremony
 *                  routes (ADR-0186 A: /v1/auth/step-up/options and /verify).
 *                  They accept a TOTP code or a passkey assertion from a
 *                  session that already exists, so a stolen session could
 *                  otherwise mint a ceremony per guess on the general bucket.
 *                  Its own bucket (never shared with sign-in), and a second,
 *                  per-USER bucket of the same size (`auth:stepup:user:<id>`)
 *                  runs once the session has resolved — see
 *                  `stepUpRateLimitUserKey` and registerStepUpRoutes;
 *   - `sso:<ip>`   a moderate bucket on the two SSO return legs (the SAML ACS
 *                  and the OIDC callback). An ACS failure costs an XML parse, a
 *                  signature check and a hash-chained audit row, so it must not
 *                  ride the anonymous allowance — but a corporate NAT signs
 *                  hundreds of people in at 9am, so it cannot ride the
 *                  10-per-5-minutes spray bucket either (CFG-06).
 *
 * The per-CREDENTIAL buckets (`cred:key:<id>`, `cred:vkey:<id>`,
 * `cred:bootstrap`, `cred:scim:<id>`) are applied in a SECOND limiter call,
 * AFTER the bearer has resolved to a stored row — see `rateLimitCredentialKey`,
 * the auth preHandler in app.ts and the SCIM scope's own token check in
 * scim.ts. The bucket name is the credential's stored id, never anything
 * derived from the presented string. ADR-0037's "limited PER scim_token"
 * lives entirely in that tier: before the token resolves a SCIM request is
 * just a bearer-carrying request from an address, and counts as one.
 *
 * Why the pre-auth tier must be IP-keyed, stated once: the shared store
 * (ADR-0125) writes one Postgres row per NEW bucket. Naming buckets after an
 * unverified header let one address rotate the header and (a) never meet any
 * ceiling and (b) cost the database one INSERT per request — the exact
 * amplifier ADR-0125 says the local pre-filter prevents. With IP-keyed
 * buckets the number of rows is bounded by distinct callers, which is the
 * property the ADR actually claimed.
 *
 * "The real client IP" is only meaningful because of item 3: `req.ip` is the
 * socket peer unless an explicitly named proxy forwarded the request. With a
 * blanket `trustProxy: true` an attacker would simply rotate
 * `x-forwarded-for` and get a fresh bucket per request, which is why these two
 * items ship together and why the rate limiter must never be configured to
 * key on a header the deployment does not trust.
 *
 * ADR-0021 CONVENTION DEBT (stated plainly, not hidden): under the standing
 * admin-configurability mandate these limits belong in `org_settings` next to
 * loginLockoutThreshold. `org_settings` has no rate-limit columns today and
 * this batch deliberately adds no migration, so the values live in the
 * constants below with env overrides.
 */
import type { FastifyRequest } from "fastify";
import type { AuthContext } from "./auth.js";

export interface RateLimitConfig {
  enabled: boolean;
  /** requests per window, per client IP, for anonymous requests */
  globalMax: number;
  globalWindowMs: number;
  /** requests per window, per client IP, on the credential endpoints */
  authMax: number;
  authWindowMs: number;
  /** requests per window for one RESOLVED api key / virtual key / bootstrap
   * token (its own bucket), and the per-IP ceiling for bearer-carrying
   * requests before the bearer resolves */
  apiKeyMax: number;
  /** ADR-0037: requests per window for one SCIM token. A full directory sync
   * is BURSTY by nature, so this bucket is generous — its job is to bound a
   * misconfigured or runaway IdP connector, not to fail legitimate syncs. */
  scimMax: number;
  scimWindowMs: number;
  /** CFG-06: requests per window, per client IP, on the SSO return legs */
  ssoMax: number;
  ssoWindowMs: number;
}

export const RATE_LIMIT_DEFAULTS: Readonly<RateLimitConfig> = Object.freeze({
  enabled: true,
  globalMax: 1200,
  globalWindowMs: 60_000,
  // 10 credential attempts per IP per 5 minutes. The ADR-0025 per-account
  // lockout is 5 failures in 15 minutes; this bounds the OTHER axis — one IP
  // walking many accounts.
  authMax: 10,
  authWindowMs: 300_000,
  apiKeyMax: 6000,
  // ADR-0037: 3000 provisioning calls per minute per token. An Okta/Entra
  // full-sync of a large directory pushes thousands of requests in a burst and
  // must not be throttled into a half-synced state; a connector stuck in a
  // retry loop is bounded well below that. The 429 carries Retry-After, which
  // is the SCIM-correct backpressure signal every connector honours.
  scimMax: 3000,
  scimWindowMs: 60_000,
  // 120 SSO completions per IP per minute: two a second sustained from one
  // office address, far above a login storm, far below the parse budget an
  // attacker would need to matter.
  ssoMax: 120,
  ssoWindowMs: 60_000,
});

/** the unauthenticated, credential-accepting endpoints */
export const AUTH_RATE_LIMIT_ROUTES: ReadonlySet<string> = new Set([
  "/auth/login",
  "/auth/mfa/verify",
  "/auth/login-with-key",
  // ADR-0174: the link proof accepts a password (and TOTP code)
  "/auth/link/confirm",
  // ADR-0174 (finding 11): the broker-hinted start is unauthenticated and its
  // refusals are audited, so it is bounded per IP like the credential routes
  "/auth/oidc/:providerId/login",
]);

/**
 * ADR-0186 A: the step-up ceremony routes — authenticated, but each verify
 * checks a second factor, so they ride the strict credential tier (per IP
 * here, per user after the session resolves).
 */
export const STEP_UP_RATE_LIMIT_ROUTES: ReadonlySet<string> = new Set([
  "/v1/auth/step-up/options",
  "/v1/auth/step-up/verify",
]);

/** the per-USER step-up bucket (same strict tier), applied once the session has resolved */
export function stepUpRateLimitUserKey(userId: string): string {
  return `auth:stepup:user:${userId}`;
}

/** CFG-06: the SSO return legs — unauthenticated, and expensive to refuse */
export const SSO_RATE_LIMIT_ROUTES: ReadonlySet<string> = new Set([
  "/auth/saml/:providerId/acs",
  "/auth/oidc/callback",
]);

function envInt(env: NodeJS.ProcessEnv, name: string, dflt: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return dflt;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : dflt;
}

function envBool(env: NodeJS.ProcessEnv, name: string, dflt: boolean): boolean {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return dflt;
  const v = raw.trim().toLowerCase();
  if (["off", "false", "0", "no", "disabled"].includes(v)) return false;
  if (["on", "true", "1", "yes", "enabled"].includes(v)) return true;
  return dflt;
}

export function resolveRateLimitConfig(
  env: NodeJS.ProcessEnv = process.env,
  override: Partial<RateLimitConfig> = {},
): RateLimitConfig {
  return {
    enabled: envBool(env, "REGULAIT_RATE_LIMIT", RATE_LIMIT_DEFAULTS.enabled),
    globalMax: envInt(env, "REGULAIT_RATE_LIMIT_MAX", RATE_LIMIT_DEFAULTS.globalMax),
    globalWindowMs: envInt(
      env,
      "REGULAIT_RATE_LIMIT_WINDOW_MS",
      RATE_LIMIT_DEFAULTS.globalWindowMs,
    ),
    authMax: envInt(env, "REGULAIT_AUTH_RATE_LIMIT_MAX", RATE_LIMIT_DEFAULTS.authMax),
    authWindowMs: envInt(
      env,
      "REGULAIT_AUTH_RATE_LIMIT_WINDOW_MS",
      RATE_LIMIT_DEFAULTS.authWindowMs,
    ),
    apiKeyMax: envInt(env, "REGULAIT_API_KEY_RATE_LIMIT_MAX", RATE_LIMIT_DEFAULTS.apiKeyMax),
    scimMax: envInt(env, "REGULAIT_SCIM_RATE_LIMIT_MAX", RATE_LIMIT_DEFAULTS.scimMax),
    scimWindowMs: envInt(
      env,
      "REGULAIT_SCIM_RATE_LIMIT_WINDOW_MS",
      RATE_LIMIT_DEFAULTS.scimWindowMs,
    ),
    ssoMax: envInt(env, "REGULAIT_SSO_RATE_LIMIT_MAX", RATE_LIMIT_DEFAULTS.ssoMax),
    ssoWindowMs: envInt(env, "REGULAIT_SSO_RATE_LIMIT_WINDOW_MS", RATE_LIMIT_DEFAULTS.ssoWindowMs),
    ...override,
  };
}

/** true when this request is one of the credential-accepting endpoints */
export function isAuthRateLimited(req: FastifyRequest): boolean {
  const url = req.routeOptions?.url ?? req.url.split("?")[0]!;
  return AUTH_RATE_LIMIT_ROUTES.has(url);
}

/** true when this request is a step-up ceremony route (ADR-0186 A) */
export function isStepUpRateLimited(req: FastifyRequest): boolean {
  const url = req.routeOptions?.url ?? req.url.split("?")[0]!;
  return STEP_UP_RATE_LIMIT_ROUTES.has(url);
}

/** true when this request is an SSO return leg (CFG-06) */
export function isSsoRateLimited(req: FastifyRequest): boolean {
  const url = req.routeOptions?.url ?? req.url.split("?")[0]!;
  return SSO_RATE_LIMIT_ROUTES.has(url);
}

/** does the request carry a bearer credential at all? Presence only — the
 * value is never read here, because nothing about it has been verified. */
export function carriesBearer(req: FastifyRequest): boolean {
  const auth = req.headers.authorization;
  return typeof auth === "string" && auth.toLowerCase().startsWith("bearer ");
}

/**
 * The PRE-AUTH bucket a request counts against. Every branch is keyed on
 * `req.ip`; the only thing the Authorization header decides is WHICH per-IP
 * ceiling applies (anonymous vs bearer-carrying), never the bucket's name.
 */
export function rateLimitKey(req: FastifyRequest): string {
  if (isAuthRateLimited(req)) return `auth:${req.ip}`;
  if (isStepUpRateLimited(req)) return `auth:stepup:${req.ip}`;
  if (isSsoRateLimited(req)) return `sso:${req.ip}`;
  return carriesBearer(req) ? `ipk:${req.ip}` : `ip:${req.ip}`;
}

/**
 * The POST-AUTH bucket for a RESOLVED bearer credential, or null when the
 * request authenticated some other way (a session cookie rides the per-IP
 * tier like every browser request). Named by the stored row's id — the one
 * thing an attacker rotating strings cannot produce.
 */
export function rateLimitCredentialKey(ctx: AuthContext): string | null {
  switch (ctx.via) {
    case "bootstrap":
      return "cred:bootstrap";
    case "api-key":
      return ctx.apiKeyId ? `cred:key:${ctx.apiKeyId}` : null;
    case "virtual-key":
      return ctx.virtualKeyId ? `cred:vkey:${ctx.virtualKeyId}` : null;
    default:
      return null;
  }
}

export function rateLimitMax(cfg: RateLimitConfig, key: string): number {
  if (key.startsWith("auth:")) return cfg.authMax;
  if (key.startsWith("sso:")) return cfg.ssoMax;
  if (key.startsWith("cred:scim:")) return cfg.scimMax;
  if (key.startsWith("ipk:") || key.startsWith("cred:")) return cfg.apiKeyMax;
  return cfg.globalMax;
}

export function rateLimitWindowMs(cfg: RateLimitConfig, key: string): number {
  if (key.startsWith("auth:")) return cfg.authWindowMs;
  if (key.startsWith("sso:")) return cfg.ssoWindowMs;
  if (key.startsWith("cred:scim:")) return cfg.scimWindowMs;
  return cfg.globalWindowMs;
}
