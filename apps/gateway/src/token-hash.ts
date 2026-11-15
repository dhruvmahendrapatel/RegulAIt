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
 * sha256 with no salt and no work factor is correct HERE and would be wrong for
 * a password: these tokens are 192+ bits of `randomBytes` entropy, so there is
 * no dictionary to attack and no cost parameter worth paying on every request.
 * Passwords go through scrypt in `auth.ts`; the two must not be confused.
 *
 * Every caller, as of the PR #117 CodeQL triage (js/insufficient-password-hash
 * on this function is a false positive for each of them):
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
 * randomness, and it would invalidate every stored hash.
 */
import { createHash } from "node:crypto";

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
