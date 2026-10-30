# ADR-0204: A static upstream credential per MCP server

- **Status**: Accepted
- **Date**: 2026-10-29

## Context

The owner decided on 2026-10-29 (#453, comment 6508111468) to make a freeze exception for the 2026-10-31 run-through:
the ABAP MCP server, a separate product, sits behind our MCP proxy, so that a live change in that system runs through
governance.

That server validates incoming calls in one of two ways: an OIDC JWT with pinned algorithms, issuer and audience, or its
own API keys. Our proxy had two limits:

- It could send only the ADR-0188 S8 identity assertion: EdDSA, in the custom header `RegulAIt-Identity-Assertion`,
  checked against `<issuer>/.well-known/jwks.json` with no OIDC discovery. Whether that server's validator accepts an
  EdDSA JWT in a custom header is not known.
- `mcp_servers` stored no static credential for an upstream.

So the guaranteed path is built: a static credential the admin attaches to one server.

## Decision

1. **One credential per network MCP server, off by default.** An admin may attach one secret to an MCP server. The
   gateway sends it on every request to that server, either as `Authorization: Bearer <secret>` (scheme `bearer`) or as
   the raw value of a header the admin names, such as `X-API-Key` (scheme `header`). A server with no credential sends
   nothing (ADR-0180). A stdio server cannot have one (409): it has no HTTP request to carry it.
2. **Stored like every connector secret, and never returned.** The credential lives in its own table,
   `mcp_server_upstream_credentials` (migration 0214, hand-written), one row per server, so no read of `mcp_servers` can
   carry it. The secret is the existing data-key envelope (`encryptSecret`, AES-256-GCM), registered in
   `CIPHERTEXT_COLUMNS` for the custody probe and the re-encryption walk. Reads (`GET /v1/servers/:id/upstream-credential`)
   show only whether one is set, the scheme and header name, the last four characters, and who set it and when. The
   secret is never written to an audit row, an error or a log line, and a malformed write body is refused with a fixed
   sentence rather than the validator's issues, which could echo it.
3. **Writes are admin-only, stepped up and audited.** Set, rotate and clear (`PUT` with `rotate`, and `DELETE` on the
   same path) are admin-only through the default gate. Each needs a `settings_relax` step-up, the class the discovery
   static credential uses, bound to the server, its url and the scheme and header. The grant is checked before anything
   is written and claimed in the write's transaction, after a compare-and-set on the server's url under a row lock. The
   audit row (`mcp-upstream-credential-set`, `-rotated`, `-cleared`) is written in the same transaction. A set never
   overwrites an existing credential, and a rotation never creates one (409).
4. **Reserved headers are refused.** The header name must be a token of letters, digits and hyphens, at most 64
   characters. Hop-by-hop headers and headers the HTTP client, the MCP transport or RegulAIt sets are refused: `Host`,
   `Cookie`, `Connection`, `Keep-Alive`, `TE`, `Trailer`, `Transfer-Encoding`, `Upgrade`, `Expect`, `Accept`,
   `Accept-Encoding`, `Forwarded`, `Via`, `Origin`, `Referer`, `Mcp-Session-Id`, `Mcp-Protocol-Version`,
   `Last-Event-ID`, and the prefixes `Content-`, `Proxy-`, `Sec-`, `X-Forwarded-`, `RegulAIt-` and `X-RegulAIt-`
   (which covers `RegulAIt-Identity-Assertion`). `Authorization` is reached only through the `bearer` scheme. The same
   rules are a CHECK in migration 0214. The secret is 16 to 4096 printable characters with no spaces or line breaks, so
   it can never split or inject a header.
5. **A url move clears it.** `PATCH /v1/servers/:id` with a new url deletes the credential in the same transaction,
   after the row update, and audits it (`mcp-upstream-credential-cleared-url-move`). This matches how identity
   propagation resets on a url move: a secret never follows the url to a new destination.
6. **Sent only by the egress-guarded fetch, only to the registered origin.** `guardedMcpConnect` reads the credential
   fresh on every connect and wraps the guarded fetch in a middleware (the MCP SDK's own `createMiddleware` hook). The
   middleware removes any value already in the credential's header, and sets it only when the request is bound for the
   registered url's origin. The guarded fetch refuses every redirect, so the secret never reaches another origin by one.
   A credential the process cannot open (no data key, or the wrong one) refuses the connect as our own audited refusal
   (`mcp-upstream-credential-unavailable`): never retried, never charged to the breaker, and nothing is sent without it.
7. **It works with the identity assertion.** The credential middleware wraps outside the assertion's middleware, so
   the assertion's holder still receives the exact request the guard sends, and its "issued" row is written as before.
   The two headers never collide (decision 4), and both ride the same request when both are on.

Open source first (ADR-0176): node's AES-256-GCM through the existing envelope, the MCP SDK's fetch middleware, and the
existing step-up, egress and audit helpers. No library decides when a governed secret may leave; that part is ours.

## Consequences

- An admin can authenticate the gateway to an upstream that checks its own API keys or a bearer token, without waiting
  on that upstream's support for the S8 assertion.
- A static secret is a long-lived bearer: anyone holding it can call the upstream as the gateway. That is why it is off
  by default, stepped up, audited, cleared on a url move and sent to one origin only. Rotation is the admin's job; the
  credential inventory (ADR-0175 A7) does not list it yet (follow-up).
- The web card validates the header shape and the secret length next to the field. It does not restate the full
  reserved-header list, to stay inside the all-JS bundle ceiling (ADR-0196); the gateway refuses a reserved name and
  the card shows that refusal inline.
- Follow-ups: list the credential in the credential inventory; once the upstream's validator is known, decide whether
  to send the S8 assertion as an OIDC bearer instead.
