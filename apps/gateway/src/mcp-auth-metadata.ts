/**
 * ADR-0097 PART B — RFC 9728 PROTECTED-RESOURCE METADATA for the MCP proxy.
 *
 * THE GAP. The MCP specification's authorization section points a client at
 * RFC 9728: on a 401 the resource server returns a `WWW-Authenticate: Bearer`
 * challenge carrying `resource_metadata`, and the client fetches that document
 * to learn how to authenticate. This gateway served neither. An off-the-shelf
 * MCP client pointed at `POST /mcp/:serverId` with no credential got a bare
 * `401 {"error":"unauthenticated"}` with no header, and one carrying the
 * bootstrap token got a bare `403 {"error":"bootstrap_cannot_call_tools"}` —
 * neither of which tells a machine anything it can act on.
 *
 * ---------------------------------------------------------------------------
 * THE HONESTY CONSTRAINT, WHICH GOVERNS THIS WHOLE FILE
 * ---------------------------------------------------------------------------
 * NEVER ADVERTISE AN AUTHENTICATION MECHANISM THE GATEWAY DOES NOT ACCEPT.
 * A discovery document is a promise; a promise the enforcement path refuses is
 * worse than no document at all, because it sends every client down a path that
 * cannot work and makes the failure look like the client's fault.
 *
 * So the contents below were derived from what `authenticate()` in `auth.ts`
 * ACTUALLY does, and `mcp-admission-auth.test.ts` re-derives it empirically
 * against a live app on every run:
 *
 *   ACCEPTED on POST /mcp/:serverId
 *     - `Authorization: Bearer <RegulAIt API key>` — the `rgl_`-prefixed token
 *       minted by `POST /v1/users/:userId/keys`. This is the ONLY bearer
 *       credential that reaches a tool call.
 *     - the ADR-0025 session cookie, for a signed-in human in the SPA. Not
 *       advertised in `bearer_methods_supported`, because it is not a bearer
 *       method: RFC 6750 defines exactly three (header / body / query) and a
 *       cookie is none of them. It is named in the human-readable extension
 *       field instead, where it cannot be mistaken for a machine-followable
 *       instruction.
 *
 *   REFUSED
 *     - the deploy-time bootstrap token — authenticates, but has NO user
 *       identity, so it cannot be a tool caller (403, see below).
 *     - an ADR-0066 virtual key — authenticates, but `POST /mcp/:serverId` is
 *       not in `VIRTUAL_KEY_ALLOWED_ROUTES` (403 `virtual_key_scope`).
 *     - ANY token issued by an OIDC or SAML identity provider. This is the one
 *       that decides the document's shape.
 *
 * ---------------------------------------------------------------------------
 * WHY `authorization_servers` IS OMITTED
 * ---------------------------------------------------------------------------
 * `authorization_servers` is OPTIONAL in RFC 9728 §2, and it means: "tokens
 * from these issuers are accepted here". This gateway's OIDC support
 * (ADR-0025/0028/0030/0043) is a BROWSER LOGIN FLOW. It resolves an
 * authorization code into an id_token, maps that to a local user, and mints a
 * RegulAIt SESSION COOKIE. At no point does any code path validate an
 * IdP-issued ACCESS token presented as a bearer credential — `authenticate()`
 * compares a bearer against the bootstrap token, then the `rglv_` virtual-key
 * table, then `api_keys.token_hash`, and returns null for everything else.
 *
 * So even on a deployment with a configured, enabled OIDC provider, listing
 * that provider's issuer under `authorization_servers` would tell a conformant
 * client "go get an access token there and present it" — and the very next
 * request would be a 401. The field is therefore omitted UNCONDITIONALLY,
 * including when a provider is configured, and the reason is stated in the
 * document itself so an operator reading it does not think it is a bug.
 *
 * Accepting IdP-issued access tokens, dynamic client registration (RFC 7591)
 * and standing up an authorization-server surface of our own are all
 * deliberately OUT OF SCOPE — see ADR-0097.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";

/** The MCP proxy route, as Fastify names it. */
export const MCP_PROXY_ROUTE_URL = "/mcp/:serverId";

/** RFC 9728 §3: the default metadata path. */
export const PROTECTED_RESOURCE_METADATA_PATH = "/.well-known/oauth-protected-resource";

/**
 * RFC 9728 §3.1 resource-scoped variant: for a resource identifier with a path
 * component, the metadata lives at `/.well-known/oauth-protected-resource` +
 * that path. Each `/mcp/<serverId>` is its own protected resource (it is what
 * an MCP client is configured with), so serving the scoped document is the
 * conformant thing — and we can serve it HONESTLY because every MCP server on
 * this gateway has identical auth requirements.
 */
export const PROTECTED_RESOURCE_METADATA_MCP_PATH = "/.well-known/oauth-protected-resource/mcp/:serverId";

/** Same derivation `saml.ts` uses for the SP entity id / ACS URL: the request's
 * own scheme and Host, so a BYOC install behind its own hostname produces its
 * own identifiers with nothing to configure. `req.protocol` is Fastify's
 * trusted-proxy-aware scheme — the same value `auth.ts`'s `requestIsSecure`
 * reads; it is inlined here rather than imported so this module can be pulled
 * in by `route-classes.ts` (which the auth hook itself depends on) without
 * creating an import cycle. */
export function baseUrlFor(req: FastifyRequest): string {
  const proto = req.protocol === "https" ? "https" : "http";
  const host = req.headers.host ?? "localhost";
  return `${proto}://${host}`;
}

export function metadataUrlForServer(baseUrl: string, serverId: string): string {
  return `${baseUrl}${PROTECTED_RESOURCE_METADATA_PATH}/mcp/${serverId}`;
}

/**
 * The document. `resource` is the only REQUIRED member; everything else here is
 * present because it is true, and absent because it would not be.
 */
export function protectedResourceMetadata(resource: string, baseUrl: string) {
  return {
    // RFC 9728 §2 — REQUIRED. The resource identifier this document describes.
    resource,
    // RFC 9728 §2 / RFC 6750 §2.1 — we accept the credential in the
    // Authorization header, and ONLY there. No form-body method, no query
    // parameter (a credential in a URL lands in every access log).
    bearer_methods_supported: ["header"],
    resource_name: "RegulAIt governed MCP proxy",
    resource_documentation: `${baseUrl}/docs/api`,
    // ---------------------------------------------------------------------
    // DELIBERATELY ABSENT, and why — stated IN the document, because an
    // operator who notices the omission deserves the reason without having to
    // find an ADR.
    //
    //   `authorization_servers` — omitted UNCONDITIONALLY. This gateway
    //   accepts no IdP-issued access token on any route. Its OIDC/SAML support
    //   is a browser login flow that mints a local session; naming an issuer
    //   here would advertise a mechanism the next request would refuse.
    //
    //   `scopes_supported` — omitted. RegulAIt authorization is not
    //   OAuth-scope-shaped: a tool call is adjudicated per user, per server,
    //   per tool against the pillar-1 entitlement model, with approvals and
    //   rate limits, at call time. There is no scope string a client could ask
    //   for that would mean anything.
    // ---------------------------------------------------------------------
    "x-regulait-accepted-credentials": [
      {
        kind: "regulait_api_key",
        transport: "authorization_header_bearer",
        obtain: `${baseUrl}/v1/users/{userId}/keys`,
        note: "A RegulAIt-minted API key. This is the only bearer credential that can call a tool.",
      },
      {
        kind: "regulait_session_cookie",
        transport: "cookie",
        obtain: `${baseUrl}/auth/login`,
        note:
          "The browser session an interactive login mints. Not a bearer method under RFC 6750, so it is not listed in bearer_methods_supported.",
      },
    ],
    "x-regulait-authorization-servers-omitted-because":
      "this gateway accepts no identity-provider-issued access token on any route; OIDC/SAML are browser login flows that mint a local RegulAIt session, so listing an issuer here would advertise an authentication mechanism that would in fact be rejected",
    "x-regulait-dynamic-client-registration": false,
  };
}

/**
 * THE CHALLENGE, built for one request.
 *
 * RFC 6750 §3: when the request carried NO authentication information, the
 * challenge SHOULD NOT include an error code — there is nothing wrong with a
 * credential that was never presented. When one was presented and rejected,
 * `error="invalid_token"` is the accurate code.
 */
export function wwwAuthenticateFor(req: FastifyRequest, opts: { credentialPresented: boolean }): string {
  const baseUrl = baseUrlFor(req);
  const serverId = (req.params as { serverId?: string } | undefined)?.serverId;
  const metadataUrl =
    typeof serverId === "string" && serverId.length > 0
      ? metadataUrlForServer(baseUrl, serverId)
      : `${baseUrl}${PROTECTED_RESOURCE_METADATA_PATH}`;
  const parts = [`Bearer realm="regulait"`];
  if (opts.credentialPresented) {
    parts.push(`error="invalid_token"`);
    parts.push(
      `error_description="the presented credential is not a valid RegulAIt API key"`,
    );
  }
  parts.push(`resource_metadata="${metadataUrl}"`);
  return parts.join(", ");
}

export function registerMcpAuthMetadata(app: FastifyInstance) {
  /**
   * The gateway-wide document. Unauthenticated by design — a client that has
   * no credential is exactly the client that needs to read this, which is why
   * both routes are in `AUTH_EXEMPT_ROUTES`. It contains no secret and no
   * deployment fact an unauthenticated caller could not already observe.
   */
  app.get(PROTECTED_RESOURCE_METADATA_PATH, async (req, reply) => {
    const baseUrl = baseUrlFor(req);
    return reply
      .header("cache-control", "public, max-age=3600")
      .send(protectedResourceMetadata(baseUrl, baseUrl));
  });

  /**
   * The RFC 9728 §3.1 resource-scoped variant, for the resource identifier an
   * MCP client is actually configured with.
   *
   * IT DOES NOT CHECK WHETHER THE SERVER EXISTS, and that is deliberate. This
   * route is unauthenticated; a 404 for an unknown id would turn it into an
   * oracle that enumerates which MCP servers a deployment has registered. The
   * document describes HOW TO AUTHENTICATE against this gateway, which is
   * uniform across every MCP server on it and is true whether or not a
   * particular id exists — and a client that then calls a non-existent server
   * gets the ordinary authenticated 404. Trading a leak for a slightly
   * over-generous metadata response is the right way round.
   */
  app.get(PROTECTED_RESOURCE_METADATA_MCP_PATH, async (req, reply) => {
    const baseUrl = baseUrlFor(req);
    const { serverId } = req.params as { serverId: string };
    return reply
      .header("cache-control", "public, max-age=3600")
      .send(protectedResourceMetadata(`${baseUrl}/mcp/${serverId}`, baseUrl));
  });
}
