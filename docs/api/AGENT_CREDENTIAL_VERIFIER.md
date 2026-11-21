# Verifying a RegulAIt agent credential

ADR-0315. For the operator of an API gateway, an MCP server or any other enforcement point outside RegulAIt that
decides whether an agent's call goes through.

## What it is

When an agent calls your service, it can present a RegulAIt **agent credential**: a short-lived signed JWT. It tells
you:

- which person the agent works for (`sub`, a pairwise identifier for your audience);
- which agent is acting (`client_id`) and which agents delegated to it (`act`);
- what it may do at your service (`scope`);
- the run's remaining budget (`regulait_budget`), which you may check but RegulAIt still settles.

It never carries more than the person and the agent are allowed. You check it **offline**, with RegulAIt's public keys
and a short signed list of revoked and suspended credentials. Nothing secret is shared, and you hold no RegulAIt
account.

An admin must first register your service as an **audience** (Admin, Agent credentials). The registration fixes the
audience URI, the signing algorithm (ES256 by default, or EdDSA) and how the token is bound to the agent (DPoP by
default, or bearer). It also maps the agent's grants to your scope strings. A credential is only ever issued for a
registered, enabled audience.

## Where things are

`<issuer>` is `<RegulAIt public URL>/agent-credentials`.

| What | Where |
| --- | --- |
| Discovery document | `<issuer>/.well-known/openid-configuration` |
| Public keys (JWKS) | `<issuer>/.well-known/jwks.json`, served with `max-age=60` |
| Status lists | `<issuer>/status/<list id>`, served as `application/statuslist+jwt` with `max-age=10` |

All three are public and need no credential.

## What to check, every call

Refuse the call if any check fails.

1. **The header.** `typ` is `at+jwt`. `alg` equals the algorithm your audience was registered with. Pin it in your
   configuration. Never take it from the token, and never accept `none`.
2. **The signature** verifies with the JWKS key that `kid` names.
3. **`iss`** equals `<issuer>` exactly, and **`aud`** equals your registered audience URI exactly.
4. **The times.** `exp`, `nbf` and `iat` hold, allowing at most 30 seconds of clock difference. A credential lives
   300 seconds by default and never more than 900.
5. **The holder.** For a DPoP audience, the request carries a DPoP proof (RFC 9449) for this request, and its key's
   RFC 7638 thumbprint equals `cnf.jkt`. Skip this only for an audience registered as bearer.
6. **The status.** `status.status_list` gives a list URI and an index (`idx`):
   - fetch that list (or use your copy if it is younger than the list's `ttl`, 60 seconds);
   - verify it like the credential: `typ` is `statuslist+jwt`, `alg` is ES256, the signature checks with the same JWKS,
     `iss` is `<issuer>`, `sub` equals the list URI, and it is not past its `exp`;
   - read entry `idx`. Admit the call only when it is **0 (VALID)**. **1 (INVALID)** is permanent. **2 (SUSPENDED)**
     means the agent or the organisation is halted for now. Refuse both.

   If you cannot fetch a list you may still use, **fail closed**: refuse the call.

You may also enforce `scope` and `regulait_budget` yourself.

## What makes a credential stop working

RegulAIt computes each list fresh from its own records. A credential's entry changes when:

| Event | Entry |
| --- | --- |
| An admin revokes the credential (by `jti`) | INVALID |
| Its grant, or any grant it was delegated from, is revoked or expires | INVALID |
| A workload identity in its chain is revoked | INVALID |
| An agent in its chain is halted | SUSPENDED, VALID again when the halt is lifted |
| The organisation's kill switch is set to `halted` | SUSPENDED, VALID again when it is lifted |
| A workload identity in the chain is suspended, or the person is disabled | SUSPENDED |

You learn of a change within about 80 seconds at worst, if you refetch at the list's `ttl`. That is up to 60 seconds of
your own caching (the `ttl`), up to 10 seconds of HTTP caching (`max-age=10`), and up to 10 seconds in which a RegulAIt
server keeps a list it already signed. A revocation by `jti` clears that copy on the server that handled it, but
another server can still answer with its copy for those 10 seconds. A list is never usable after its `exp` (120
seconds after it was signed). The credential's short lifetime limits the window if you cannot fetch the list at all.
The kill switch also stops new credentials at once.

## Gateway configuration

Most gateways check steps 1 to 4 for you. Few read a status list, and some do not check `aud`. Where yours does not,
your upstream service must do the remaining checks. The reference verifier in RegulAIt's source
(`verifyAgentCredential` in `apps/gateway/src/agent-credential.ts`) does all six, and its tests show each refusal.

### agentgateway

A `jwtAuthentication` provider covers the issuer, the audience, the signature and the times:

```yaml
traffic:
  jwtAuthentication:
    mode: Strict
    providers:
      - issuer: "https://regulait.example.com/agent-credentials"
        audiences: ["https://mcp.example.com/"]
        jwks:
          remote:
            url: "https://regulait.example.com/agent-credentials/.well-known/jwks.json"
            cacheDuration: "1m"
```

It does not check the status list or DPoP. Do steps 5 and 6 in the MCP server or a policy behind it.

### Kong (the open-source `jwt` plugin)

The plugin matches a consumer credential on a claim and checks the times:

- plugin: `key_claim_name: iss`, `claims_to_verify: [exp, nbf]`, `maximum_expiration: 900`;
- consumer credential: `key` = `<issuer>`, `algorithm: ES256`, `rsa_public_key` = the PEM of the JWKS key (the
  plugin takes ES256 keys in that field too).

The plugin does not check `aud`, `typ`, DPoP or the status list. It also holds one key per credential, so add the new
key before RegulAIt rotates to it. Do steps 1, 3 (`aud`), 5 and 6 in the upstream.

## Keys

The JWKS lists active keys and retired keys still inside their overlap window. A revoked key is removed. Cache the
JWKS for at most a few minutes, and refetch it when a `kid` is unknown.
