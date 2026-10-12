# The RegulAIt identity assertion on upstream MCP calls

ADR-0188 slice S8. For upstream MCP server operators, and for the RegulAIt admin who decides whether to turn it on.

## What it is

RegulAIt can tell an upstream MCP server who each call is for, and which agent is acting. It sends a short-lived
signed JWT in the `RegulAIt-Identity-Assertion` request header. The upstream checks it against the RegulAIt
deployment's public keys.

It is **off by default**. An admin turns it on per server, on the MCP servers page ("Identity to upstream"). Turning it
on sends identity data to a third party, so it is a relaxation under ADR-0180. It needs a fresh step-up
(`settings_relax`), and the change is audited (`mcp-server-identity-propagation-changed`). If the server's URL changes
later, the setting turns itself off, because consent was given for one destination. To keep it on at the new URL, an
admin must step up again for that URL.

When it is on:

- Every governed `tools/call` (and the request of every governed protocol method, such as `resources/read`) carries a
  fresh assertion. Each request gets its own `jti`. Nothing is sent on `initialize`, notifications, the event stream, or
  any connection opened before the call was allowed.
- Every assertion sent is audited (`mcp-identity-assertion-issued`). The audit row holds the `jti`, the signing key id,
  the audience, the pairwise subject and the actor chain, but never the token itself.
- If RegulAIt cannot make an assertion, the call is refused and audited (`mcp-identity-assertion-unavailable`). It is
  never sent without one. This happens when there is no public URL, no data key, no active signing key, or the server
  is a stdio server.

## The format

A JWS (RFC 7515) compact JWT (RFC 7519), signed with EdDSA (Ed25519, RFC 8037).

| Part | Value |
|---|---|
| header `alg` | `EdDSA` |
| header `typ` | `regulait-mcp-identity+jwt` (explicit typing, RFC 8725 §3.11). It is never `at+jwt`, so it cannot be used as a RegulAIt access token, and an access token cannot pass for it. |
| header `kid` | the signing key, as listed in the JWKS |
| `iss` | the RegulAIt deployment's public URL (`REGULAIT_PUBLIC_URL`) |
| `aud` | the server's canonical URI: scheme, host, port and path of its registered URL. There is no query, fragment or credentials, so a secret in a URL query never ends up in a token. |
| `sub` | the person the call is for, as a **pairwise** subject. It is an HMAC of the audience and the person's internal id. It is stable for one server, so the upstream can recognise a returning person, but it cannot be linked across servers. It is never an email, a name or a user id. |
| `act` | only when an agent acts. This is the RFC 8693 §4.1 nested actor claim: `act.sub` is the acting agent's SPIFFE ID, and a nested `act` is the agent that delegated to it, back to the root. |
| `iat`, `exp` | issued-at and expiry; the lifetime is 60 seconds |
| `jti` | unique per assertion; use it as the replay key |

No other claim is sent. In particular, the assertion does not include the person's email, display name, user id,
roles, the project, the delegation grant, the environment, the tool arguments, the scope or the budget.

The `sub` changes for everyone if the server's URL changes (the audience is part of the HMAC), or if the RegulAIt
deployment rotates its data key.

### Why this header and not `Authorization`

Under the MCP authorization specification, `Authorization` carries the upstream's **own** access token, if it uses
one. The assertion is provenance ("this call is for this person, made by this agent"). It is not a credential for the
upstream's resources. Keeping it in its own header means the two never collide. RegulAIt does not exchange the
assertion for a token at the upstream's authorization server. An upstream whose authorization server trusts the
RegulAIt issuer could do that itself, with an RFC 7523 JWT bearer grant.

## Verifying it

The public keys are at `<issuer>/.well-known/jwks.json`, the same JWKS that RegulAIt's delegated access tokens use.
Retired keys stay published for an overlap window, so an assertion signed just before a key rotation still verifies.

The example below uses [`jose`](https://github.com/panva/jose) (MIT). The RegulAIt test suite runs this exact code
against a live JWKS (`apps/gateway/src/mcp-identity-assertion.test.ts`), so it is checked on every build.

<!-- verify-example:start -->
```js
import { createRemoteJWKSet, jwtVerify } from "jose";

/**
 * Verify the RegulAIt-Identity-Assertion header of an incoming MCP request.
 *  issuer:   the RegulAIt deployment's public URL, e.g. "https://regulait.example.com"
 *  audience: this server's URL as registered in RegulAIt, without query or fragment,
 *            e.g. "https://mcp.example.com/mcp"
 */
export function regulaitIdentityVerifier({ issuer, audience }) {
  const jwks = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`));
  const seen = new Map(); // jti -> exp: each assertion is accepted once
  return async function verify(assertion) {
    const { payload } = await jwtVerify(assertion, jwks, {
      issuer,
      audience,
      typ: "regulait-mcp-identity+jwt",
      algorithms: ["EdDSA"],
      maxTokenAge: "60s",
      clockTolerance: 5,
      requiredClaims: ["sub", "jti", "iat", "exp"],
    });
    const now = Math.floor(Date.now() / 1000);
    for (const [jti, exp] of seen) if (exp + 5 < now) seen.delete(jti);
    if (seen.has(payload.jti)) throw new Error("replayed identity assertion");
    seen.set(payload.jti, payload.exp);
    const actors = [];
    for (let a = payload.act; a; a = a.act) actors.unshift(a.sub);
    // subject: the pairwise id of the person; actors: root first, the acting agent last
    return { subject: payload.sub, actors };
  };
}
```
<!-- verify-example:end -->

Use it on each request:

```js
const verify = regulaitIdentityVerifier({ issuer: "https://regulait.example.com", audience: "https://mcp.example.com/mcp" });
const who = await verify(req.headers["regulait-identity-assertion"]);
```

With more than one replica, keep the replay set in shared storage (for example, a cache entry per `jti` that expires
at `exp`).

**Air-gapped or no route back to RegulAIt.** If the upstream cannot reach the RegulAIt deployment, give it the JWKS
document out of band and use `createLocalJWKSet(jwks)` in place of `createRemoteJWKSet`. Refresh the document whenever
a RegulAIt admin rotates the issuer key.

## Standards used

RFC 7519 (JWT), RFC 7515 (JWS), RFC 8037 (EdDSA in JOSE), RFC 7517 (JWKS), RFC 8725 §3.11 (explicit typing),
RFC 8693 §4.1 (the `act` claim), RFC 8707 (the canonical resource URI as audience), and the MCP authorization
specification (canonical server URI, and keeping `Authorization` for the upstream's own token). The WIMSE drafts
(`Workload-Identity-Token` and HTTP message signatures) were considered. ADR-0188 decides not to put them on the wire
until they become RFCs.
