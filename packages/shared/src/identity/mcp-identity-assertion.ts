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
