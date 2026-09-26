/**
 * ADR-0098 — API-KEY LIFETIME.
 *
 * THE GAP THIS CLOSES. `api_keys` had `created_at`, `last_used_at` and
 * `revoked_at` and no expiry column at all. An API key is what authenticates
 * the MCP proxy (ADR-0023/0097) and the entire programmatic surface, so the
 * single most privileged credential this product issues was the only one with
 * no lifetime. Sessions expire (ADR-0025/0039). Virtual keys expire (ADR-0066
 * §2). API keys did not.
 *
 * This module is the PURE half — the arithmetic and the vocabulary. The
 * ENFORCEMENT lives in `authenticate()` (`auth.ts`), which is the one place a
 * bearer token becomes an identity, so there is no second path on which expiry
 * could be bypassed; `login-with-key` and every route hook reach it through
 * that same function.
 *
 * THE TWO ORG KNOBS AND THE ONE INVARIANT THEY HOLD.
 *
 *   apiKeyDefaultTtlDays  — the lifetime applied when the caller supplies none
 *   apiKeyMaxTtlDays      — the ceiling on what any issuer may REQUEST
 *
 * Both default to NULL, and with both NULL this whole module answers "no
 * expiry" to every question, so a fresh install issues exactly the
 * never-expiring keys it issued before ADR-0098. That is ADR-0021's "a fresh
 * settings row changes nothing" invariant, and `api-key-expiry.test.ts` pins
 * it rather than trusting it.
 *
 * REFUSE, NEVER CLAMP. A request for a longer lifetime than the ceiling allows
 * is a 422 naming the knob, the ceiling and the longest expiry that WOULD have
 * been accepted. Clamping would hand somebody a credential with a lifetime
 * they did not ask for and were never told about, which they discover when it
 * stops working — the exact "my key stopped working" support ticket this ADR
 * exists to make answerable.
 */

/** How close to expiry a key has to be before the lifecycle read calls it out.
 * A constant rather than a third org knob: the brief for this slice is two
 * dials, and a warning window is a presentation choice, not a policy ceiling —
 * nothing is enforced on it and no behaviour turns on its value. */
export const API_KEY_EXPIRING_WINDOW_DAYS = 14;

const DAY_MS = 24 * 60 * 60 * 1000;

/** What `GET /v1/keys` reports, so an admin can see what is about to break
 * without re-implementing the rule. REVOKED WINS over expired: a key somebody
 * deliberately killed is revoked, whatever its clock says, and reporting it as
 * merely "expired" would suggest reissuing on the same terms. */
export type ApiKeyLifecycleState = "active" | "expiring" | "expired" | "revoked";

export function apiKeyState(
  key: { revokedAt: Date | null; expiresAt: Date | null },
  now: Date = new Date(),
): ApiKeyLifecycleState {
  if (key.revokedAt !== null) return "revoked";
  if (key.expiresAt === null) return "active";
  const remaining = key.expiresAt.getTime() - now.getTime();
  if (remaining <= 0) return "expired";
  if (remaining <= API_KEY_EXPIRING_WINDOW_DAYS * DAY_MS) return "expiring";
  return "active";
}

/** The org's two dials, read off the settings row. */
export interface ApiKeyTtlPolicy {
  defaultTtlDays: number | null;
  maxTtlDays: number | null;
}

export interface ApiKeyExpiryRefusal {
  status: 400 | 422;
  error: string;
  detail: string;
}

export type ApiKeyExpiryResolution =
  | { ok: true; expiresAt: Date | null; source: "caller" | "org_default" | "org_ceiling" | "none" }
  | { ok: false; refusal: ApiKeyExpiryRefusal };

/**
 * Resolve the expiry a new key is issued with.
 *
 * `requested` distinguishes THREE inputs, and they mean three different things:
 *
 *   undefined — "you decide". The org default applies; with no default but a
 *               ceiling in force, the ceiling applies, because "as long as you
 *               allow" is the only coherent reading of an omitted expiry under
 *               a ceiling and refusing every no-argument issuance would break
 *               every existing caller in such an install. The issued value is
 *               returned on the response and written to the audit row, so it
 *               is disclosed rather than silent.
 *   a Date    — an explicit request. Honoured unless it exceeds the ceiling.
 *   null      — an explicit request for a key that NEVER expires. This is the
 *               longest lifetime there is, so under a ceiling it is refused by
 *               the same named 422 as any other over-long request. A ceiling a
 *               caller steps over by asking for infinity is not a ceiling.
 */
export function resolveIssuedExpiry(
  requested: Date | null | undefined,
  policy: ApiKeyTtlPolicy,
  now: Date = new Date(),
): ApiKeyExpiryResolution {
  const ceiling =
    policy.maxTtlDays === null ? null : new Date(now.getTime() + policy.maxTtlDays * DAY_MS);

  if (requested === undefined) {
    if (policy.defaultTtlDays !== null) {
      return {
        ok: true,
        expiresAt: new Date(now.getTime() + policy.defaultTtlDays * DAY_MS),
        source: "org_default",
      };
    }
    if (ceiling !== null) return { ok: true, expiresAt: ceiling, source: "org_ceiling" };
    return { ok: true, expiresAt: null, source: "none" };
  }

  if (requested === null) {
    if (ceiling === null) return { ok: true, expiresAt: null, source: "caller" };
    return {
      ok: false,
      refusal: {
        status: 422,
        error: "api_key_expiry_exceeds_ceiling",
        detail:
          `this organization caps API-key lifetime at ${policy.maxTtlDays} day(s) ` +
          `(org setting 'apiKeyMaxTtlDays'), so a key that never expires cannot be issued. ` +
          `The longest expiry that would be accepted right now is ${ceiling.toISOString()}. ` +
          `Nothing was issued — ask for an expiry at or before that instant, or omit 'expiresAt' to take the maximum.`,
      },
    };
  }

  if (requested.getTime() <= now.getTime()) {
    return {
      ok: false,
      refusal: {
        status: 400,
        error: "expiry_in_the_past",
        detail:
          "an already-expired key would authenticate nothing — pick a future expiry, or omit 'expiresAt' entirely",
      },
    };
  }

  if (ceiling !== null && requested.getTime() > ceiling.getTime()) {
    return {
      ok: false,
      refusal: {
        status: 422,
        error: "api_key_expiry_exceeds_ceiling",
        detail:
          `the requested expiry ${requested.toISOString()} is beyond this organization's ` +
          `${policy.maxTtlDays}-day API-key lifetime cap (org setting 'apiKeyMaxTtlDays'). ` +
          `The longest expiry that would be accepted right now is ${ceiling.toISOString()}. ` +
          `Nothing was issued and the request was NOT silently shortened — reissue with an expiry at or before that instant.`,
      },
    };
  }

  return { ok: true, expiresAt: requested, source: "caller" };
}
