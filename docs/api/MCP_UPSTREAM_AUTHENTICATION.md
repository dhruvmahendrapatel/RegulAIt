# Authenticating RegulAIt to an upstream MCP server

ADR-0204. For the RegulAIt admin who registers an MCP server that checks credentials, and for that server's operator.

RegulAIt can authenticate itself to an upstream MCP server in two ways. Both are off by default, both are per server,
and both can be on at once.

| | Static credential (this page) | Identity assertion |
|---|---|---|
| What is sent | One secret the admin set, on every request | A 60-second signed JWT per governed call |
| Header | `Authorization: Bearer <secret>`, or a header the admin names | `RegulAIt-Identity-Assertion` |
| Says who the call is for | No: it authenticates the gateway | Yes: a pairwise subject and the acting agents |
| Upstream verifies it | Against the key or token it issued | Against `<RegulAIt public URL>/.well-known/jwks.json` (EdDSA) |
| Document | this page | [MCP_IDENTITY_ASSERTION.md](MCP_IDENTITY_ASSERTION.md) |

Use the static credential when the upstream checks its own API keys or a bearer token it issued. Add the identity
assertion when the upstream can also verify who each call is for.

## The static credential

An admin attaches one secret to one network MCP server, on the MCP servers page (select the server, then the
**Upstream credential** card), or through the API below. The gateway then sends it on every request to that server:
`initialize`, `tools/list`, `tools/call`, the event stream and the session's `DELETE`.

- **Bearer** (`scheme: "bearer"`): sent as `Authorization: Bearer <secret>`.
- **Named header** (`scheme: "header"`): sent as the raw value of the header the admin names, for example
  `X-API-Key: <secret>`.

A stdio server cannot have a credential: it has no HTTP request to carry one.

### Where it goes, and where it never goes

- Only through the gateway's egress-guarded fetch, which checks the destination on every request.
- Only to the origin (scheme, host and port) of the server's registered URL. A request bound anywhere else never
  carries it, and any value already in that header is removed first.
- Never on a redirect: the guarded fetch refuses every redirect, so nothing reaches a redirect's target at all.
- If the server's URL changes, the credential is cleared (audited). Set it again for the new URL.
- If the gateway cannot open a stored credential (the data key is missing or different), every connect to that server
  is refused and audited (`mcp-upstream-credential-unavailable`). It is never sent without it.

### Rules for the header and the secret

- The header name is letters, digits and hyphens, at most 64 characters, starting with a letter or digit.
- These are refused, because the HTTP client, the MCP transport or RegulAIt sets them: `Host`, `Cookie`, `Connection`,
  `Keep-Alive`, `Proxy-Connection`, `TE`, `Trailer`, `Transfer-Encoding`, `Upgrade`, `Expect`, `Accept`,
  `Accept-Encoding`, `Forwarded`, `Via`, `Origin`, `Referer`, `Mcp-Session-Id`, `Mcp-Protocol-Version`,
  `Last-Event-ID`, and any header starting `Content-`, `Proxy-`, `Sec-`, `X-Forwarded-`, `RegulAIt-` or `X-RegulAIt-`
  (which includes `RegulAIt-Identity-Assertion`). To use `Authorization`, choose the bearer scheme.
- The secret is 16 to 4096 printable characters, with no spaces or line breaks.

### What a read shows

Never the secret. A read returns:

```json
{
  "credential": {
    "set": true,
    "scheme": "header",
    "headerName": "x-api-key",
    "last4": "a1b2",
    "setBy": "<user id>",
    "setAt": "2026-10-29T12:00:00.000Z"
  }
}
```

The secret is not in any other read, in the server list, in any audit row, in any error or in any log line.

### The API (admin only)

| Route | What it does |
|---|---|
| `GET /v1/servers/:serverId/upstream-credential` | The read above. |
| `PUT /v1/servers/:serverId/upstream-credential` | Set (`rotate` absent or `false`; 409 if one is set) or rotate (`rotate: true`; 409 if none is set). Body: `{ "scheme": "bearer" \| "header", "headerName"?: string, "secret": string, "rotate"?: boolean }`. |
| `DELETE /v1/servers/:serverId/upstream-credential` | Clear: the stored secret is destroyed. |

Each write needs a fresh step-up (`settings_relax`). The first request is refused `403 step_up_required` with the
action to confirm; confirm it (`POST /v1/auth/step-up/options`, then `/verify`) and send the same request again with
the `x-regulait-step-up` header. An API key cannot confirm who is acting, so these writes are made in a browser
session. A refused header or secret is `400 mcp_upstream_credential_refused` with a `code` (`header_refused`,
`secret_refused`, `header_with_bearer`) and a sentence saying what to change; the refusal is audited and nothing is
saved.

Every write is audited in the same transaction: `mcp-upstream-credential-set`, `mcp-upstream-credential-rotated`,
`mcp-upstream-credential-cleared`, and `mcp-upstream-credential-cleared-url-move` for a url move. Each row names the
scheme and header, never the secret.
