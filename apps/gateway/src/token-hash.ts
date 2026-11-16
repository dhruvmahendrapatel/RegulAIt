/**
 * THE token-hashing scheme, in one place.
 *
 * Extracted from `auth.ts` by ADR-0066 for one reason: virtual keys must hash
 * exactly the way API keys and session tokens already do, and the honest way to
 * guarantee that is a shared function rather than a second implementation that
 * happens to agree today. `virtual-keys.ts` therefore imports THIS, and
 * `auth.ts` — which imports `virtual-keys.ts` to resolve a presented `rglv_`
 * token — re-exports it unchanged, so every pre-existing `import { hashToken }
 * from "./auth.js"` keeps working and there is no import cycle.
 *
 * The hash is scrypt (owner decision 2026-11-15, ADR-0167 amendment S-02):
 * every value here is a real secret, and CodeQL's js/insufficient-password-hash
 * is fixed in code, never dismissed. The salt is one fixed, versioned domain
 * string, not a per-value salt: the result is the LOOKUP key a presented token
 * is found by, so it must be deterministic, and a per-value salt would need a
 * token-id format for every credential. With 192+ bits of `randomBytes` per
 * token there is no dictionary for a per-value salt to defeat. The work factor
 * is modest (N=2^10, r=8: about 1 MiB and a millisecond), because it runs on
 * every authenticated request. Passwords keep their own per-user-salted scrypt
 * in `auth.ts` (`hashPassword`); the two must not be confused.
 *
 * Changing the scheme invalidates every stored token hash: sessions, API keys,
 * virtual keys, SCIM tokens and handles issued before it no longer resolve and
 * are re-issued. The product is not live, so nothing is grandfathered (ADR-0180).
 *
 * Every caller (each passes 192+ random bits; the list started at the PR #117
 * CodeQL triage):
 *   - API keys `rgl_` (`generateToken`, auth.ts): randomBytes(24), 192 bits;
 *     looked up from `x-api-key` / `Authorization: Bearer`.
 *   - virtual keys `rglv_` (`generateVirtualKeyToken`): randomBytes(24), 192 bits.
 *   - sessions and pending-MFA handles `rgls_` (`generateSessionToken`):
 *     randomBytes(32), 256 bits; looked up from the session cookie, the
 *     pending-MFA cookie or the `pendingToken` body field.
 *   - SCIM bearer tokens `rglscim_` (`generateScimToken`): randomBytes(32), 256 bits.
 *   - federated-link proof tokens (`raiseLinkRequest`): randomBytes(32), 256 bits.
 * A low-entropy secret (a password, a one-time password, a short code someone
 * types) must NEVER be passed here: use `hashPassword` / `verifyPassword`.
 * `token-hash.test.ts` pins the generators' entropy.
 *
 * No server-side pepper (HMAC): it would add nothing against 192+ bits of
 * randomness, and it would tie every stored hash to a key to rotate.
 */
import { scryptSync } from "node:crypto";

/** versioned, so a future scheme change is visible in the code that made it */
export const TOKEN_HASH_SALT = "regulait:token-hash:v2";
/** scrypt cost for a per-request lookup hash of a high-entropy token (see above) */
export const TOKEN_HASH_PARAMS = { N: 1024, r: 8, p: 1 } as const;

export function hashToken(token: string): string {
  return scryptSync(token, TOKEN_HASH_SALT, 32, TOKEN_HASH_PARAMS).toString("hex");
}
