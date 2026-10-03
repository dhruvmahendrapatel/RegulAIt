# Kong — RegulAIt as an authorization decision point (ADR-0127)

> **VERIFIED against a pinned `kong:3.6`.** The deny path runs end to end with a
> counting upstream on any change to `integrations/`, to the gateway's source,
> or to the shared packages — the three places that can alter either side of
> this contract. See
> [`test/verify.mjs`](test/verify.mjs) and
> [`.github/workflows/integrations.yml`](../../.github/workflows/integrations.yml).
> First green run 2026-09-27.
>
> **Covered precisely:** Kong 3.6, DB-less, `key-auth`, one governed route. Other
> Kong versions, DB-backed mode and other auth plugins are NOT covered — and the
> priority ordering this plugin depends on is version-specific, so a different
> Kong is unverified until the harness runs against it.

`kong/plugins/regulait-authz/` is a custom Kong plugin: `handler.lua` and
`schema.lua`.

## What replaced what, and why

The first version of this integration was a `pre-function` snippet
(`regulait-authz.lua`, removed in this change). It could not work, in three
independent ways, and none was a bug in its logic:

| | problem | why the plugin fixes it |
| --- | --- | --- |
| 1 | **Ordering.** Pre-Function runs at priority `1000000`, ahead of every auth plugin. The snippet read identity from `kong.client.get_consumer()` and refused when absent — so on any route with ordinary Kong auth it ran *before* the consumer existed and refused all legitimate traffic. | The plugin's `PRIORITY = 900` is below key-auth (1250), basic-auth (1100), jwt (1005), oauth2 (1004), ldap-auth (1002) and ACL (950), so the consumer is set when `access()` runs. |
| 2 | **Sandbox.** `require "resty.http"` is blocked in Kong's serverless-function sandbox by default — it is the exact example in Kong's own support documentation — so the snippet's first executable line could not load. | A real plugin is not sandboxed. |
| 3 | **Configuration.** The snippet read the server and tool from `os.getenv`, which is *node* configuration. One data plane serving several governed routes would ask the same question for all of them. | `config` is attached to the route the plugin is enabled on. |

Failing closed is why (1) was unusable rather than unsafe: it refused
everything. That is the only reason this was a correctness problem and not an
incident.

## Enabling it

```sh
# the plugin must be on the Lua path and declared
export KONG_PLUGINS=bundled,regulait-authz
export KONG_LUA_PACKAGE_PATH=/path/to/integrations/kong/?.lua\;\;
```

Then, per governed route — the per-route part is the point:

```sh
curl -X POST http://localhost:8001/routes/<route>/plugins \
  --data name=regulait-authz \
  --data config.pdp_url=http://regulait-gateway:3000 \
  --data config.pdp_key='{vault://env/regulait-pdp-key}' \
  --data config.server_id=<mcp server uuid> \
  --data config.tool_name=<tool name>
```

The route also needs an authentication plugin, and each Kong consumer needs its
`custom_id` set to the matching **RegulAIt user UUID**. An unmapped consumer is
refused rather than guessed at: a wrong mapping is an authorization decision
about the wrong person.

## What is actually asserted

Per `mistakes.md` M-043, nothing in `integrations/` is called supported until
its **deny path** is exercised end to end against a **pinned Kong container**
with an **upstream invocation counter**, asserting **zero upstream calls** for
each refusal. That now runs on every change, and asserts exactly that for:

- an unauthenticated request (`key-auth` refuses before this plugin runs);
- a policy `deny`;
- an **`approval_required`** — refused with a `403` AND carrying
  `x-regulait-decision: approval_required`, because a caller that treats every
  403 alike loses the distinction the approvals queue exists to make;
- a PDP that is **unreachable** (the gateway is killed);
- a PDP that answers **non-200** (a stub returning 500 on a second governed
  route — a different plugin branch from the unreachable case);
- a PDP whose answer is **unparseable** (a stub returning 200 with a body
  `cjson` cannot decode — the shape most likely to be mistaken for success);
- a request with a forged `x-regulait-subject` (and its case variants), which
  must be ignored entirely rather than merely overridden;
- the **decision context** the plugin claims to send, read back from the PDP's
  own `contextApplied` ledger rather than from the plugin's source — including
  that `args` is NOT claimed.

**Correction (2026-09-27, AER-034):** the three middle entries above —
`approval_required`, non-200 and unparseable — were listed here before the
harness asserted any of them. They are asserted now, on two extra routes whose
plugin instances point at stub PDPs, which is what made the two answer-shaped
failures expressible at all (a plugin's config is per route). A list of
assertions in a README is a promise; this one had three entries it had not paid
for.

Checking the client's status code would NOT be enough: a 403 rendered after the
upstream already ran is indistinguishable from a refusal, from the client's
side. That is exactly the shape of the Envoy bug, which is why the counter
exists and why "the client got 403" is not the assertion.

That rule exists because the Envoy adapter shipped **failing open** on deny and
was reviewed, not run. Review did not catch it. Running it would have — and on
the first green run the Kong access log independently corroborated the
harness: one `200` in the entire run, five refusals, and the upstream counter
at zero for every one of them.

## The context this plugin sends — and the one thing it does not

`project_id` is **per-route plugin config**, and sent when set. It is static per route and it is
something Kong can state truthfully: a governed route fronts one project context. Set it if any of
your rules are deploy-mode scoped.

### The session origin — DERIVED where it can be, asserted only where it cannot (AER-036)

**This was wrong until 2026-09-28 and the correction is a breaking config change.** The field was
`session_origin`, an operator-set string (`password` | `sso` | `api_key`) copied straight into
`principal.sessionOrigin` and believed by the PDP. The justification given here was that "its
operator knows which auth plugin fronts it" — but nothing checked that, and **this repository's own
harness put `key-auth` on the governed route and configured `sso` on it**, so the shipped example
was the counter-example. An authentication-strength ABAC policy could be satisfied by a configuration
file. Worse, `sso` is not in the product's own vocabulary
(`password` | `api_key` | `oidc` | `saml` | `bootstrap` | `unknown`), so a policy written
`sessionOrigin == "oidc"` could never fire for that traffic while one written
`sessionOrigin != "api_key"` **was** satisfied by it — wrong in both directions.

What it does now:

- **Derived from the credential where Kong can see one.** `kong.client.get_credential()` returns
  what the route's auth plugin authenticated with, and its shape names the mechanism: a key-auth
  credential carries `key` (→ `api_key`), a basic-auth credential carries `username` and `password`
  (→ `password`). For those, the adapter sends what it observed, not what it was told.
- **`asserted_session_origin`** replaces `session_origin`, accepts only `password` | `oidc` | `saml`
  — the values Kong cannot derive — and its name says what it is. `api_key` is deliberately not
  accepted: it is observable, so it is never an assertion.
- **A contradiction is a refusal.** If the credential says `api_key` and the config declares `oidc`,
  the request is refused with `x-regulait-reason: session_origin_contradicts_credential` and the
  upstream is never reached. Sending either value would be wrong — the declared one is false, and
  silently substituting the derived one overrides a policy intent nobody revisited.
- **The PDP refuses an out-of-vocabulary origin outright** (400), so a value no policy can match can
  no longer be accepted in silence, and the ledger records the exact value under
  `assertedPrincipal.sessionOrigin` with `principal.asserted` in `contextApplied`.

**The honest residue.** For OIDC and SAML the configured value is still an assertion this adapter
cannot verify, because nothing in Kong's community plugin set gives an equally reliable per-request
signal. Scope such a route to one auth mechanism and treat the field as the trusted assertion it is
named after. Omitting it entirely is always safe: absent reads as `unknown`, the weakest input.

There is deliberately **no `mfa_completed`**. Kong cannot observe whether a second factor was
completed, and a configured `true` would be an assertion nobody checked sitting in the trusted path.
Absent reads as "unknown", which is the weakest input a policy can get — the safe direction.

### Known limitation — this plugin sends no `args`

The plugin sends `userId`, `serverId`, `toolName` and the two fields above, and **not the call's
arguments**. Kong would have to buffer and parse the request body to supply them, and then map that
body onto the tool's named arguments — a per-route projection whose *wrong* version would evaluate a
data-scope rule against the wrong values. That is worse than the fail-closed deny you get by
omitting them, which is why this is a gap rather than a guess.

The consequence is specific and worth knowing before you deploy: **if a data-scope rule applies to
the governed tool, this plugin will get `deny`** — the kernel fails closed on a rule whose argument
is absent (AER-028). That is correct, and it is not a bug you should work around by removing the
rule. Either govern a route whose tool carries no data-scope rule, or extend the plugin to send
`args` and accept the buffering cost.

`contextApplied` in the response tells you which dimensions were actually used, so this shows up as
`["projectId","principal"]` — with `args` conspicuously absent — rather than as a mystery. The
harness asserts exactly that against the PDP's own ledger, including that `args` is NOT claimed: a
disclosure in a README is a promise, and this one is now measured.
