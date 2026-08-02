/**
 * ADR-0040 — the SERVER-DERIVED half of the ABAC principal bag.
 *
 * Deliberately its own tiny module, for two reasons:
 *
 *  1. It is the single place a request turns into principal attributes, so
 *     "could a client fake this?" is answerable by reading one function. The
 *     answer is no: everything below comes from the resolved session row that
 *     `app.ts`'s auth hook wrote, never from a header, query parameter or body
 *     field. There is no code path here that reads `req.headers`.
 *  2. It keeps `mcp-proxy.ts` from importing the Cedar-carrying `abac.ts` just
 *     to name a type.
 */

/**
 * ADR-0028 session origin + authentication strength, as the routes know them.
 * Absent fields degrade to the honest 'unknown'/false — a call with no session
 * behind it (a worker loop, an internal dispatch) must never read as
 * "strongly authenticated" just because nobody said otherwise.
 */
export interface AbacPrincipalContext {
  sessionOrigin?: string | null;
  mfaCompleted?: boolean | null;
}

/** the minimum shape this derivation needs — kept structural so tests and
 * non-Fastify callers can supply it without a full request object */
export interface AbacPrincipalSource {
  authCtx: { via?: string | null };
  sessionAuth?: { origin?: string | null; totpEnabled?: boolean | null } | undefined;
}

/**
 * Derive the principal's session facts from the authenticated request.
 *
 * `sessionOrigin` is the ADR-0028 origin recorded on the session row at login
 * ('password' | 'oidc' | 'saml' | 'api_key' | 'bootstrap' | 'unknown'); a
 * header API-key request has no session at all and reports 'api_key', the
 * bootstrap header reports 'bootstrap'.
 *
 * `mfaCompleted` is TRUE only for a cookie session belonging to an account with
 * TOTP active — which, given the two-step login gate, is exactly the set of
 * sessions that presented a second factor to come into existence. A header
 * API-key or bootstrap request presents one credential and is FALSE, which is
 * the honest answer rather than a flattering one.
 */
export function abacPrincipalFromRequest(req: AbacPrincipalSource): AbacPrincipalContext {
  const via = req.authCtx?.via ?? null;
  if (via === "session") {
    return {
      sessionOrigin: req.sessionAuth?.origin ?? "unknown",
      mfaCompleted: req.sessionAuth?.totpEnabled === true,
    };
  }
  return {
    sessionOrigin: via === "api-key" ? "api_key" : via === "bootstrap" ? "bootstrap" : "unknown",
    mfaCompleted: false,
  };
}
