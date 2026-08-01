/**
 * HTTP rate limiting (ADR-0031 item 4).
 *
 * Before this, the gateway had a per-ACCOUNT login lockout (ADR-0025) and
 * nothing else: no bound at all on per-IP or per-key request rates across any
 * of the ~167 endpoints. Credential spraying that touches each account once is
 * invisible to a per-account lockout, and general abuse of the governed
 * dispatch surfaces was unmetered.
 *
 * Two buckets, both keyed on the REAL client IP:
 *
 *   - a generous global bucket, so ordinary interactive and CI traffic never
 *     notices it;
 *   - a much stricter bucket on the three unauthenticated credential-accepting
 *     endpoints (/auth/login, /auth/mfa/verify, /auth/login-with-key), which is
 *     what actually stops spraying.
 *
 * "The real client IP" is only meaningful because of item 3: `req.ip` is now
 * the socket peer unless an explicitly named proxy forwarded the request. With
 * a blanket `trustProxy: true` an attacker would simply rotate
 * `x-forwarded-for` and get a fresh bucket per request, which is why these two
 * items ship together and why the rate limiter must never be configured to
 * key on a header the deployment does not trust.
 *
 * Authenticated API-key clients get their own, larger bucket keyed on the key
 * itself rather than sharing one per-IP bucket — a legitimately busy service
 * account behind one NAT must not be throttled into uselessness by, or
 * throttle, its neighbours.
 *
 * ADR-0021 CONVENTION DEBT (stated plainly, not hidden): under the standing
 * admin-configurability mandate these limits belong in `org_settings` next to
 * loginLockoutThreshold. `org_settings` has no rate-limit columns today and
 * this batch deliberately adds no migration, so the values live in the
 * constants below with env overrides. Adding
 * `http_rate_limit_max` / `http_rate_limit_window_seconds` /
 * `auth_rate_limit_max` / `auth_rate_limit_window_seconds` /
 * `api_key_rate_limit_max` to `org_settings` (and reading them through
 * loadOrgSettings) is the natural follow-up.
 */
import type { FastifyRequest } from "fastify";

export interface RateLimitConfig {
  enabled: boolean;
  /** requests per window, per client IP, across everything else */
  globalMax: number;
  globalWindowMs: number;
  /** requests per window, per client IP, on the credential endpoints */
  authMax: number;
  authWindowMs: number;
  /** requests per window for a caller presenting an API key (its own bucket) */
  apiKeyMax: number;
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
});

/** the unauthenticated, credential-accepting endpoints */
export const AUTH_RATE_LIMIT_ROUTES: ReadonlySet<string> = new Set([
  "/auth/login",
  "/auth/mfa/verify",
  "/auth/login-with-key",
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
    ...override,
  };
}

/** true when this request is one of the credential-accepting endpoints */
export function isAuthRateLimited(req: FastifyRequest): boolean {
  const url = req.routeOptions?.url ?? req.url.split("?")[0]!;
  return AUTH_RATE_LIMIT_ROUTES.has(url);
}

/**
 * The bucket a request counts against.
 *
 * `auth:<ip>` for the credential endpoints (a separate, much smaller bucket,
 * so a spray cannot hide inside the generous global allowance and a busy API
 * client cannot exhaust the login allowance for everyone on its IP);
 * `key:<prefix>` for a caller presenting a bearer credential (its own, larger
 * allowance — a legitimate service account is not throttled by its neighbours
 * and cannot exhaust theirs); the client IP otherwise.
 *
 * Only the first 32 chars of the credential are used, and it is never logged;
 * the value exists solely as an in-memory bucket key.
 */
export function rateLimitKey(req: FastifyRequest): string {
  if (isAuthRateLimited(req)) return `auth:${req.ip}`;
  const auth = req.headers.authorization;
  if (typeof auth === "string" && auth.toLowerCase().startsWith("bearer ")) {
    return `key:${auth.slice(7, 39)}`;
  }
  return `ip:${req.ip}`;
}

export function rateLimitMax(cfg: RateLimitConfig, key: string): number {
  if (key.startsWith("auth:")) return cfg.authMax;
  if (key.startsWith("key:")) return cfg.apiKeyMax;
  return cfg.globalMax;
}

export function rateLimitWindowMs(cfg: RateLimitConfig, key: string): number {
  return key.startsWith("auth:") ? cfg.authWindowMs : cfg.globalWindowMs;
}
