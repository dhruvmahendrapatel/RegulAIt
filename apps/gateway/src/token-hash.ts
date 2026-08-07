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
 */
import { createHash } from "node:crypto";

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
