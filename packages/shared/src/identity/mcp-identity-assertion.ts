/**
 * ADR-0188 slice S8 — OUTBOUND MCP IDENTITY (decision 8, OWNER DECISION 6).
 *
 * With `mcp_servers.identity_propagation = 'signed_assertion'`, every governed
 * call the gateway makes to that upstream on someone's behalf carries one
 * short-lived JWT in the `RegulAIt-Identity-Assertion` request header: who the
 * call is for (a pairwise `sub`) and, when an agent is acting, who is doing it
 * (the RFC 8693 `act` chain). The default is `none`: nothing about the caller
 * leaves the gateway. Turning it on discloses identity data to a third party,
 * so it is a relaxation (ADR-0180): a `settings_relax` step-up, audited.
 *
 * THE FORMAT, and why (ADR-0176: standards first, nothing invented that a
 * standard already names):
 *  - an RFC 7519 JWT, JWS EdDSA (RFC 8037) under the gateway issuer's keys,
 *    verifiable against the issuer's existing JWKS (`/.well-known/jwks.json`,
 *    S3) with any JOSE library;
 *  - explicit typing per RFC 8725 §3.11: `typ` is `regulait-mcp-identity+jwt`,
 *    never `at+jwt`, so the assertion can never be mistaken for (or accepted
 *    as) one of our delegated access tokens, and a delegated token can never
 *    pass for an assertion;
 *  - `act` is RFC 8693 §4.1's nested actor claim, built by the same function
 *    as the delegated tokens' (`actClaimFromChain`): outermost = the actor
 *    making the call, nested = the actors before it;
 *  - `aud` is the server's canonical URI in the MCP authorization spec's sense
 *    (RFC 8707 resource indicator: scheme, host, port and path; no query,
 *    fragment or credentials), so a URL that carries a secret in its query
 *    never puts it in a token;
 *  - it is not sent in `Authorization`: under the MCP authorization spec that
 *    header carries the upstream's OWN access token, and this assertion is
 *    provenance, not a credential for the upstream's resources. A dedicated
 *    header (RFC 6648: no `X-` prefix) keeps the two apart.
 *
 * THE CLAIMS (data minimisation, OWNER DECISION 6: "pairwise subjects and no
 * email or name"). Exactly these, and nothing else:
 *   iss  the gateway issuer (REGULAIT_PUBLIC_URL)
 *   aud  the upstream's canonical URI (one string)
 *   sub  the person the call is for, PAIRWISE: an HMAC of (aud, user id) under
 *        the S3 pairwise key. Stable for one server, unlinkable across servers;
 *        never the user id, an email, a name or a role
 *   act  only when an agent acts: the chain (RFC 8693 nesting, acting agent
 *        outermost), each agent named by a PAIRWISE id: an HMAC of (aud,
 *        workload identity id) under the same key, domain-separated from
 *        `sub`. Never the global SPIFFE ID: two upstreams could join on it
 *        (and through it on the person), and an external identifier is
 *        admin-typed text that can carry a name (ADR-0180)
 *   iat, exp  a 60 s lifetime; jti  unique per assertion (the upstream's
 *        replay key)
 * Not sent: the user id, email, display name, roles, project, delegation grant
 * id, environment, tenant, tool arguments, scope or budget.
 */

/** the request header the assertion rides in */
export const IDENTITY_ASSERTION_HEADER = "RegulAIt-Identity-Assertion" as const;
/** the JOSE `typ` of an assertion (RFC 8725 §3.11 explicit typing) */
export const IDENTITY_ASSERTION_TYP = "regulait-mcp-identity+jwt" as const;
/** the lifetime of one assertion (decision 8), seconds */
export const IDENTITY_ASSERTION_TTL_SECONDS = 60;
/** every claim an assertion may carry; `act` only when an agent acts */
export const IDENTITY_ASSERTION_CLAIMS = ["iss", "aud", "sub", "act", "iat", "exp", "jti"] as const;

/** audit rule ids of S8 */
export const IDENTITY_PROPAGATION_CHANGED_RULE_ID = "mcp-server-identity-propagation-changed";
export const IDENTITY_ASSERTION_ISSUED_RULE_ID = "mcp-identity-assertion-issued";
export const IDENTITY_ASSERTION_UNAVAILABLE_RULE_ID = "mcp-identity-assertion-unavailable";
/** the PATCH refusal when another opted-in server has the same canonical audience (an assertion would verify at both) */
export const IDENTITY_AUDIENCE_SHARED = "identity_audience_shared" as const;
/** the PATCH refusal for a stdio server, which has no HTTP request to carry a header */
export const IDENTITY_PROPAGATION_UNSUPPORTED = "identity_propagation_unsupported" as const;
/** the S8 follow-up's audit rule id: every change of a server's "disclose agent workload IDs" opt-in */
export const AGENT_ID_DISCLOSURE_CHANGED_RULE_ID = "mcp-server-agent-id-disclosure-changed";
/** the PATCH refusal when agent workload IDs are asked for on a server that is not sent a signed assertion */
export const AGENT_ID_DISCLOSURE_NEEDS_ASSERTION = "agent_id_disclosure_needs_assertion" as const;

/**
 * The upstream's canonical URI: `scheme://host[:port]/path`, lower-case scheme
 * and host, default port dropped, no credentials, query or fragment (the MCP
 * authorization spec's canonical server URI). The path is kept exactly as the
 * WHATWG URL parser normalises it: a root URL keeps its single `/`, and a
 * trailing slash on a longer path is kept (`/mcp` and `/mcp/` differ).
 * Null for anything that is not an absolute http(s) URL. Parsed with `URL`,
 * never a regular expression.
 */
export function canonicalMcpAudience(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  return `${u.origin}${u.pathname}`;
}

export interface IdentityPropagationUpdate {
  /** the value to write, or null when the column does not change */
  write: "none" | "signed_assertion" | null;
  /** ADR-0180: the relaxation this update makes (a `settings_relax` step-up), or null */
  relaxed: { identityPropagation: "signed_assertion" } | null;
  /** the url moved and the request said nothing about identity: the opt-in does not follow the url */
  resetByUrlMove: boolean;
}

/**
 * What a `PATCH /v1/servers/:id` does to `identityPropagation`.
 *
 * The opt-in is consent to send identity to ONE destination. So:
 *  - turning it on is a relaxation;
 *  - moving the url of a server that is on is a relaxation too when the
 *    request keeps it on (the identity would now go to a new third party),
 *    and the step-up then binds the new url;
 *  - moving the url without naming `identityPropagation` turns it off: the
 *    strict value, no step-up, audited;
 *  - turning it off, or an unchanged value with no url move, is not a
 *    relaxation.
 */
export function identityPropagationUpdate(
  before: { identityPropagation: string; url: string },
  body: { identityPropagation?: "none" | "signed_assertion" | undefined; url?: string | undefined },
): IdentityPropagationUpdate {
  const urlMoves = body.url !== undefined && body.url !== before.url;
  const requested = body.identityPropagation;
  if (requested === undefined) {
    const reset = urlMoves && before.identityPropagation !== "none";
    return { write: reset ? "none" : null, relaxed: null, resetByUrlMove: reset };
  }
  const relaxes = requested === "signed_assertion" && (before.identityPropagation !== "signed_assertion" || urlMoves);
  return {
    write: requested !== before.identityPropagation ? requested : null,
    relaxed: relaxes ? { identityPropagation: "signed_assertion" } : null,
    resetByUrlMove: false,
  };
}

export interface AgentIdDisclosureUpdate {
  /** the value to write, or null when the column does not change */
  write: boolean | null;
  /** ADR-0180: the relaxation this update makes (part of the request's one `settings_relax` step-up), or null */
  relaxed: { discloseAgentWorkloadIds: true } | null;
  /** it was on and turns off because the url moved, or because identity propagation turns off (the strict value) */
  reset: "url_move" | "propagation_off" | null;
  /** asked for on a server whose next identity propagation is not `signed_assertion`: refused 409, nothing saved */
  refused: boolean;
}

/**
 * ADR-0188 S8 follow-up — what a `PATCH /v1/servers/:id` does to
 * `discloseAgentWorkloadIds`, given what it does to `identityPropagation`
 * (`identity`, from `identityPropagationUpdate`).
 *
 * By default `act.sub` is a pairwise id per audience. Disclosing the agents'
 * workload identifiers (their SPIFFE IDs, global and possibly admin-typed)
 * lets upstreams correlate one agent across servers, so it is a separate,
 * per-server relaxation, and it only means something while the server is
 * sent an assertion. So:
 *  - asking for it while the NEXT propagation is not `signed_assertion` is
 *    refused (the caller answers 409 with a sentence);
 *  - turning it on is a relaxation, and so is keeping it on across a url move
 *    (the IDs would now go to a new third party: the step-up binds the new url);
 *  - a url move that does not name it, or propagation turning off, turns it off
 *    (the strict value, audited, no step-up);
 *  - turning it off, or an unchanged value with no url move, is not a relaxation.
 */
export function agentIdDisclosureUpdate(
  before: { identityPropagation: string; discloseAgentWorkloadIds: boolean; url: string },
  body: { discloseAgentWorkloadIds?: boolean | undefined; url?: string | undefined },
  identity: IdentityPropagationUpdate,
): AgentIdDisclosureUpdate {
  const urlMoves = body.url !== undefined && body.url !== before.url;
  const nextPropagation = identity.write ?? before.identityPropagation;
  const requested = body.discloseAgentWorkloadIds;
  if (requested === true && nextPropagation !== "signed_assertion") {
    return { write: null, relaxed: null, reset: null, refused: true };
  }
  if (requested === undefined) {
    if (!before.discloseAgentWorkloadIds) return { write: null, relaxed: null, reset: null, refused: false };
    if (urlMoves) return { write: false, relaxed: null, reset: "url_move", refused: false };
    if (nextPropagation !== "signed_assertion") return { write: false, relaxed: null, reset: "propagation_off", refused: false };
    return { write: null, relaxed: null, reset: null, refused: false };
  }
  if (requested === false) {
    return { write: before.discloseAgentWorkloadIds ? false : null, relaxed: null, reset: null, refused: false };
  }
  const relaxes = !before.discloseAgentWorkloadIds || urlMoves;
  return {
    write: before.discloseAgentWorkloadIds ? null : true,
    relaxed: relaxes ? { discloseAgentWorkloadIds: true } : null,
    reset: null,
    refused: false,
  };
}

// ---------------------------------------------------------------------------
// ADR-0210 — the OIDC-compatible profile (per server, opt-in)
// ---------------------------------------------------------------------------

/**
 * How an opted-in server receives its assertion. `regulait_header` (the default) is the S8 format above, unchanged.
 * `oidc_bearer` is for an upstream that validates a standard OIDC JWT: the assertion is signed ES256 under its own
 * issuer (`<REGULAIT_PUBLIC_URL>/mcp-identity`, with an OIDC discovery document), carries an admin-set `scope`, and
 * rides in `Authorization: Bearer` on every request of the governed call's connection.
 */
export const IDENTITY_ASSERTION_PROFILES = ["regulait_header", "oidc_bearer"] as const;
export type IdentityAssertionProfile = (typeof IDENTITY_ASSERTION_PROFILES)[number];
/** the issuer path of the OIDC profile. Distinct from the workload identity issuer (the base URL) and `/federation`. */
export const MCP_IDENTITY_OIDC_ISSUER_PATH = "/mcp-identity" as const;
/** its OpenID Connect Discovery 1.0 document (`{issuer}/.well-known/openid-configuration`) */
export const MCP_IDENTITY_OIDC_DISCOVERY_PATH = "/mcp-identity/.well-known/openid-configuration" as const;
/** its JWKS: the ES256 public halves only */
export const MCP_IDENTITY_OIDC_JWKS_PATH = "/mcp-identity/.well-known/jwks.json" as const;
/** the JWS `alg` of the OIDC profile (one of the algorithms standard OIDC validators pin) */
export const MCP_IDENTITY_OIDC_JWS_ALG = "ES256" as const;
/** every claim an OIDC-profile assertion may carry; `act` only when an agent acts */
export const MCP_IDENTITY_OIDC_CLAIMS = ["iss", "aud", "sub", "scope", "act", "iat", "exp", "jti"] as const;
/** the longest scope an admin may set */
export const IDENTITY_ASSERTION_SCOPE_MAX = 512;
/**
 * RFC 6749 §3.3: space-delimited scope tokens, each of `%x21 / %x23-5B / %x5D-7E` (no quote, no backslash, no
 * control character). One space between tokens, none at either end. Checked by length first, and the token class
 * has no overlap with the separator, so the match is linear.
 */
const SCOPE_PATTERN = /^[\x21\x23-\x5B\x5D-\x7E]+(?: [\x21\x23-\x5B\x5D-\x7E]+)*$/;
export function identityAssertionScopeProblem(scope: string): string | null {
  if (scope.length === 0 || scope.length > IDENTITY_ASSERTION_SCOPE_MAX) return `the scope must be 1 to ${IDENTITY_ASSERTION_SCOPE_MAX} characters`;
  if (!SCOPE_PATTERN.test(scope)) return "the scope must be space-separated RFC 6749 scope tokens (printable ASCII, no quote or backslash)";
  return null;
}

/** the audit rule id of every change of a server's assertion profile or scope */
export const IDENTITY_ASSERTION_PROFILE_CHANGED_RULE_ID = "mcp-server-identity-assertion-profile-changed";
/** PATCH refusals (409 or 400, nothing saved) */
export const IDENTITY_ASSERTION_PROFILE_NEEDS_ASSERTION = "identity_assertion_profile_needs_assertion" as const;
export const IDENTITY_ASSERTION_SCOPE_INVALID = "identity_assertion_scope_invalid" as const;
/** the OIDC profile's bearer and an ADR-0204 Bearer credential would both claim `Authorization` (409, nothing saved) */
export const IDENTITY_ASSERTION_BEARER_CONFLICT = "identity_assertion_bearer_conflict" as const;

export interface AssertionProfileUpdate {
  /** the values to write, or null when neither column changes */
  write: { identityAssertionProfile: IdentityAssertionProfile; identityAssertionScope: string | null } | null;
  /** ADR-0180: the relaxation this update makes (part of the request's one `settings_relax` step-up), or null */
  relaxed: { identityAssertionProfile: "oidc_bearer"; identityAssertionScope: string } | null;
  /** it was on and returns to the default because the url moved, or because identity propagation turns off */
  reset: "url_move" | "propagation_off" | null;
  /** the request cannot be applied: the PATCH answers with this code, nothing saved */
  refused: { code: typeof IDENTITY_ASSERTION_PROFILE_NEEDS_ASSERTION | typeof IDENTITY_ASSERTION_SCOPE_INVALID; detail: string } | null;
}

/**
 * ADR-0210 — what a `PATCH /v1/servers/:id` does to `identityAssertionProfile` and `identityAssertionScope`, given
 * what it does to `identityPropagation` (`identity`). The same shape as `agentIdDisclosureUpdate`:
 *  - `oidc_bearer` only while the NEXT propagation is `signed_assertion`, and only with an explicit scope (the
 *    request's, or the one already set); a scope only with `oidc_bearer`;
 *  - turning it on, changing the scope, or keeping it on across a url move is a relaxation (the step-up binds the
 *    values and the url);
 *  - a url move that does not name the profile, or propagation turning off, returns to the default (audited, no
 *    step-up), so neither the bearer placement nor the scope ever follows the url to a new destination;
 *  - returning to `regulait_header` is not a relaxation.
 */
export function assertionProfileUpdate(
  before: { identityPropagation: string; identityAssertionProfile: string; identityAssertionScope: string | null; url: string },
  body: { identityAssertionProfile?: IdentityAssertionProfile | undefined; identityAssertionScope?: string | null | undefined; url?: string | undefined },
  identity: IdentityPropagationUpdate,
): AssertionProfileUpdate {
  const none = { write: null, relaxed: null, reset: null, refused: null } as const;
  const urlMoves = body.url !== undefined && body.url !== before.url;
  const nextPropagation = identity.write ?? before.identityPropagation;
  const wasBearer = before.identityAssertionProfile === "oidc_bearer";
  const nextProfile = body.identityAssertionProfile ?? (wasBearer && !urlMoves && nextPropagation === "signed_assertion" ? "oidc_bearer" : "regulait_header");
  const toDefault = { identityAssertionProfile: "regulait_header" as const, identityAssertionScope: null };
  if (body.identityAssertionProfile === undefined && body.identityAssertionScope === undefined) {
    if (!wasBearer) return none;
    if (urlMoves) return { ...none, write: toDefault, reset: "url_move" };
    if (nextPropagation !== "signed_assertion") return { ...none, write: toDefault, reset: "propagation_off" };
    return none;
  }
  if (nextProfile === "regulait_header") {
    if (body.identityAssertionScope !== undefined && body.identityAssertionScope !== null) {
      return { ...none, refused: { code: IDENTITY_ASSERTION_SCOPE_INVALID, detail: "a scope is sent only with the oidc_bearer profile" } };
    }
    if (!wasBearer) return none;
    return { ...none, write: toDefault, ...(body.identityAssertionProfile === undefined ? { reset: urlMoves ? "url_move" : "propagation_off" } : {}) };
  }
  if (nextPropagation !== "signed_assertion") {
    return {
      ...none,
      refused: {
        code: IDENTITY_ASSERTION_PROFILE_NEEDS_ASSERTION,
        detail: "the oidc_bearer profile shapes a signed identity assertion, and this server is not set to receive one (identity propagation must be signed_assertion, already or in this request)",
      },
    };
  }
  const scope = body.identityAssertionScope === undefined ? (wasBearer ? before.identityAssertionScope : null) : body.identityAssertionScope;
  if (scope === null) {
    return { ...none, refused: { code: IDENTITY_ASSERTION_SCOPE_INVALID, detail: "the oidc_bearer profile needs an explicit scope (for example \"read\")" } };
  }
  const problem = identityAssertionScopeProblem(scope);
  if (problem) return { ...none, refused: { code: IDENTITY_ASSERTION_SCOPE_INVALID, detail: problem } };
  const changes = !wasBearer || scope !== before.identityAssertionScope;
  return {
    write: changes ? { identityAssertionProfile: "oidc_bearer", identityAssertionScope: scope } : null,
    relaxed: changes || urlMoves ? { identityAssertionProfile: "oidc_bearer", identityAssertionScope: scope } : null,
    reset: null,
    refused: null,
  };
}
