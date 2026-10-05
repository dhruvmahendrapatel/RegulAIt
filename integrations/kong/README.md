# Kong — RegulAIt as an authorization decision point (ADR-0127)

> **VERIFIED against `kong:3.6`** — the deny path runs end to end with a
> counting upstream on any change to `integrations/`, to the gateway's source,
> to the shared packages, or to the lockfile — the places that can alter either
> side of this contract. See [`test/verify.mjs`](test/verify.mjs) and
> [`.github/workflows/integrations.yml`](../../.github/workflows/integrations.yml).
> First green run 2026-09-27 (run 36300665525); the last green run of the
> plugin and harness as they were before the AER-026/030/033/034 changes was
> run 36930442969 at `3a91a93`.
>
> **The AER-026/030/033/034 cases are VERIFIED since run 37110038871 at
> `8c0132b` (2026-10-03), their first green run — all 47 assertions passed:**
> the five-name protocol-header refusal
> (with other `x-regulait-*` headers passed through), the truncated-scan
> refusal, the AER-026 identity refusals and ledger identity, the AER-030
> second route and forged server/tool/decision headers, the AER-033 teardown
> and key-location canary, and the AER-034 digest pins (Kong and the
> `postgres:16` behind the PDP, both logged by the job).
>
> **Covered precisely:** Kong 3.6, DB-less, `key-auth`. Other Kong versions,
> DB-backed mode and other auth plugins are NOT covered — and the priority
> ordering this plugin depends on is version-specific, so a different Kong is
> unverified until the harness runs against it.
>
> **Not supported at the Kong edge (ADR-0179):**
> - **Data-scope rules.** The plugin sends no tool arguments, so a data-scope
>   rule on the governed tool **always denies** here. This is not parity with an
>   in-line dispatch, and nothing in this directory claims it is. Because the
>   plugin never sends arguments, every deny is decided without them, and says
>   so: `"decidedWithout": ["args"]` in its body and a warning in Kong's error
>   log. That tag states what the decision ran without, **not** that the
>   arguments caused it; the rule id in `x-regulait-reason` tells you whether a
>   data-scope rule refused.
> - **A derived session origin for OIDC or SAML.** Only `key-auth` (`api_key`)
>   and `basic-auth` (`password`) derive the origin from the credential. For
>   OIDC, SAML, `jwt` and every other auth plugin the origin is the
>   **operator's assertion** (`asserted_session_origin`) or absent.
> - **Checking an assertion on a `jwt` route.** A `jwt` credential derives
>   nothing, so a `jwt` route **accepts whatever is asserted** — `oidc`, `saml`
>   or `password` — and the PDP receives it as `principal.asserted`. Nothing
>   checks that the token's issuer is an OIDC or SAML identity provider. Set the
>   field on a `jwt` route only when you know what issued its tokens.

## Support matrix — what is claimed, and what proves it

| Behaviour | Status | Proved by |
| --- | --- | --- |
| deny path, forged headers, identity refusals, fail-closed PDP failures | supported | `test/verify.mjs` against `kong:3.6` (see the list below) |
| `projectId` sent from per-route config | supported | `verify.mjs` reads `contextApplied` back from the PDP ledger |
| session origin derived for `key-auth` → `api_key` | supported | `verify.mjs` (ledger) and `test/handler_spec.lua` |
| session origin derived for `basic-auth` → `password` | supported in the plugin; **not run in Kong** | `test/handler_spec.lua` only |
| OIDC / SAML / `jwt` origin | **asserted by the operator, never derived**; a `jwt` route accepts any of `oidc`, `saml`, `password` unchecked | `test/handler_spec.lua`; the PDP labels it `principal.asserted` (`apps/gateway/src/aer036-mixed-auth-origin.test.ts`) |
| an asserted origin that contradicts a derived one | refused, `session_origin_contradicts_credential`, PDP never asked | `verify.mjs` (key-auth + `oidc`) and `test/handler_spec.lua` (key-auth and basic-auth) |
| data-scope rules | **not supported: always deny** | `test/handler_spec.lua` (no `args`; every deny tagged `decidedWithout`, and the note never claims the cause); `verify.mjs` asserts `args` is not claimed and (pending its first CI run) the tag; the PDP side in `aer036-mixed-auth-origin.test.ts` |
| `mfaCompleted` | not sent: Kong cannot observe it | `test/handler_spec.lua` (no field in the question) |

The unit spec runs on [busted](https://lunarmodules.github.io/busted/) (MIT) under LuaJIT, the Lua
5.1 dialect Kong's OpenResty embeds. CI pins all of it in `.github/workflows/integrations.yml`
(job `kong-plugin-spec`): LuaJIT and LuaRocks by exact Debian version on `ubuntu-24.04`, and busted
with every rock it pulls in by `==` in `test/regulait-authz-spec-dev-1.rockspec`, then fails if the
installed tree holds anything that file does not name. Locally, from `integrations/kong` (the
rock tree lives outside the repository):

```sh
T=/tmp/regulait-kong-rocks
luarocks --lua-version=5.1 --tree "$T" --only-server https://luarocks.org \
  build --only-deps test/regulait-authz-spec-dev-1.rockspec LUA_INCDIR=/usr/include/luajit-2.1
eval "$(luarocks --lua-version=5.1 --tree "$T" path)"
luajit "$T/lib/luarocks/rocks-5.1/busted/2.3.0-1/bin/busted"    # reads ./.busted
```

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
about the wrong person. So is a consumer whose `custom_id` is anything other
than a user UUID (an email, a username) — that is not a mapping to *one* user —
and so is a consumer Kong set **without a credential**, which is what an
`anonymous` fallback on the auth plugin produces when authentication failed:
nobody presented anything, so nobody is decided about, whatever that consumer
is mapped to (AER-026).

Two refusals come from the PDP rather than the plugin, because only it can
know: a `custom_id` that is a well-formed UUID **nobody has** (`unknown_subject`),
and a **deactivated** user whose grants survive deactivation by design
(`subject_disabled`, ADR-0022). Offboarding that stops sign-in but not the
gateway in front of the tools would not be offboarding.

Every decision row the PDP writes for this plugin carries the **Kong consumer
identity** (`detail.proxyConsumer`: the consumer's `id` and `username`) beside
the RegulAIt subject it resolved to, so "which consumer was this?" is
answerable from the ledger when a mapping turns out to be wrong.

**The five protocol headers are refused on a request**, not stripped (`403`,
`x-regulait-reason: forged_protocol_header`): `x-regulait-subject`,
`x-regulait-server-id`, `x-regulait-tool`, `x-regulait-decision` and
`x-regulait-reason`. The plugin sets the last two on its own refusals and reads
none of them from a request; the previous behaviour of clearing them and
carrying on made a forgery attempt invisible and was only as safe as every
later line of code. Duplicates, case variants and underscore spellings are one
check. **Only those five:** other `x-regulait-*` headers are client traffic and
pass through untouched — `docs/product/IDE_INTEGRATION.md` tells clients to
send `x-regulait-project-id` and `x-regulait-agent-id`, and the console sends
`x-regulait-csrf`. A request with **more than 1000 headers** (Kong's ceiling
for the plugin's header scan) is refused as `too_many_headers`, because a
protocol header past the 1000th would never have been looked at.

## What is actually asserted

Per `mistakes.md` M-043, nothing in `integrations/` is called supported until
its **deny path** is exercised end to end against a **pinned Kong container**
with an **upstream invocation counter**, asserting **zero upstream calls** for
each refusal. That now runs on every change, and asserts exactly that for the
list below (every entry green since run 37110038871 — see the box at the top):

- an unauthenticated request (`key-auth` refuses before this plugin runs);
- a policy `deny`;
- an allowed request carrying the documented client headers
  (`x-regulait-project-id`, `x-regulait-agent-id`): it reaches the upstream,
  those headers arrive unchanged, and none of the five protocol headers does;
- a forged subject hidden after 1000 padding headers: refused as
  `too_many_headers`, nothing proxied;
- **two routes bound to distinct server/tool pairs** with crossed entitlements
  (AER-030): the consumer entitled to tool A is allowed on route A and refused
  on route B, a second consumer the reverse — and the ledger shows each route
  asked about its own binding, which a plugin asking one question for every
  route could not produce;
- forged `x-regulait-server-id` / `x-regulait-tool` / `x-regulait-decision` /
  `x-regulait-reason` headers, each sent by the consumer the claim would have
  helped, each refused as `forged_protocol_header` with nothing proxied;
- an **`approval_required`** — refused with a `403` AND carrying
  `x-regulait-decision: approval_required`, because a caller that treats every
  403 alike loses the distinction the approvals queue exists to make;
- a PDP that is **unreachable** (the gateway is killed);
- a PDP that answers **non-200** (a stub returning 500 on a second governed
  route — a different plugin branch from the unreachable case);
- a PDP whose answer is **unparseable** (a stub returning 200 with a body
  `cjson` cannot decode — the shape most likely to be mistaken for success);
- *(pending — the green runs asserted the earlier IGNORE behaviour)* a request
  with a forged `x-regulait-subject` (each case variant, the header
  twice in two spellings on one request, and from the very consumer it names),
  each refused as `forged_protocol_header`;
- the identities refused **before** anyone is asked (AER-026): a consumer with
  no `custom_id` and one whose `custom_id` is an email (`consumer_not_mapped`);
  a consumer mapped to a UUID nobody has (`unknown_subject`); a consumer mapped
  to a **deactivated** user with a live grant (`subject_disabled`) — with the
  control that reactivation lets the same consumer through;
- a subject header on a request with **no credential**, on the
  governed route (key-auth refuses first) and on a route whose key-auth has an
  `anonymous` fallback mapped to a user of its own whom the PDP allows on the
  tool (Kong requires `custom_id` to be unique across consumers, so it cannot
  share the entitled user's) — the plugin refuses `unauthenticated`, which can
  only be the credential check; the control shows a real credential proxies on
  that route;
- the **decision context** the plugin claims to send, read back from the PDP's
  own `contextApplied` ledger rather than from the plugin's source — including
  that `args` is NOT claimed — and the **Kong consumer identity**
  on the same rows, beside the subject, for the allow and for the deactivated
  refusal.

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

### Running it, and what it leaves behind (AER-033)

Every run names what it creates after a **run id** (`KONG_E2E_RUN_ID`, else
random): the database `regulait_kong_e2e_<id>`, the container
`regulait-kong-e2e-<id>`, the three ports (derived from the id, then checked
free; `GATEWAY_PORT` / `UPSTREAM_PORT` / `KONG_PROXY_PORT` pin them) and the
gateway's bootstrap token. **Nothing is dropped or removed at start**: a
database or container that already carries the name belongs to another run
and the harness stops rather than destroying it. Teardown — from the normal
exit, from a failure, and from `SIGINT`/`SIGTERM`, one shared teardown however
many of those fire — first revokes the scratch PDP key while the gateway can
still do it, then removes the container **by id and only if it carries this
run's label** (plus any container carrying that label whose id was never
recorded because `docker run` was interrupted),
and drops the database **only if it still carries this run's comment**;
anything else is refused aloud. Once teardown has begun, every creation step
refuses to run, so a run interrupted mid-setup cannot start a container or a
database after teardown has gone past it. Before Kong starts, the generated
declarative config is checked for the values Kong requires to be unique
(consumer `username`/`id`/`custom_id`, key-auth `key`, route names, one plugin
instance per route), so a config Kong would refuse is named rather than
surfacing as a container that never came up. The PDP key lives in a `0600` file in a
`0700` directory handed to the container through `--env-file`, and the run
proves it: a read as a non-runner user (`nobody`) must fail while the runner's
own read succeeds, and the world-readable declarative config is checked to
hold the vault reference and never the key. So two runs on one machine, or a
cancelled job, no longer leave a live key or a stray database behind.

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

**The honest residue: for OIDC and SAML the origin is operator-asserted (ADR-0179).** Only
`key-auth` and `basic-auth` derive the origin. For OIDC and SAML the configured value is an
assertion this adapter cannot verify, because nothing in Kong's community plugin set gives an
equally reliable per-request signal. The same holds for `jwt`, `oauth2`, `hmac-auth`, `ldap-auth`
and any other plugin: their credentials derive nothing. (A `jwt` credential also carries a `key`
field; until plugin 0.4.0 that was misread as key-auth and labelled `api_key`, so an `oidc`
assertion on a JWT route was refused. Only a credential with `key` and none of `secret`,
`algorithm` or `rsa_public_key` is key-auth now.) The PDP cannot tell a derived origin from an
asserted one either: on `/v1/authz/check` every origin is the caller's claim, which is why the
response labels it `principal.asserted`. Scope such a route to one auth mechanism and treat the
field as the trusted assertion it is named after. Omitting it entirely is always safe: absent reads
as `unknown`, the weakest input.

**What that means for a `jwt` route, concretely.** Since 0.4.0 a `jwt` route is no longer refused
for asserting `oidc`, and it is not refused for asserting anything else either: `oidc`, `saml` and
`password` are all accepted and forwarded as the operator's claim. The plugin does not look at the
token's issuer, so it cannot tell a token minted by an OIDC identity provider from one minted by a
service with a shared secret. If an ABAC policy distinguishes `oidc` from weaker origins, an
assertion on a `jwt` route satisfies it on the operator's word alone. Assert on a `jwt` route only
when every issuer configured for its consumers really is the identity provider you name, or leave
the field unset.

The mixed-auth cases are pinned by `test/handler_spec.lua`:

| credential on the route | `asserted_session_origin` | result |
| --- | --- | --- |
| key-auth | none | `api_key` derived and sent |
| key-auth | `oidc`, `saml` or `password` | **refused**, `session_origin_contradicts_credential`, PDP never asked |
| basic-auth | none, or `password` | `password` derived and sent |
| basic-auth | `oidc` or `saml` | **refused**, as above |
| OIDC / SAML (credential names no mechanism) | `oidc` / `saml` | the assertion is sent; the PDP labels it `principal.asserted` |
| `jwt` | `oidc`, `saml` or `password` | **any of them is accepted and sent unchecked** (a `jwt` credential is not key-auth, so nothing contradicts it); the PDP labels it `principal.asserted` |
| anything underivable | none | no principal is sent; the PDP reads `unknown` |

There is deliberately **no `mfa_completed`**. Kong cannot observe whether a second factor was
completed, and a configured `true` would be an assertion nobody checked sitting in the trusted path.
Absent reads as "unknown", which is the weakest input a policy can get — the safe direction.

### Not supported — data-scope rules at the Kong edge (this plugin sends no `args`)

**Data-scope rules are not supported at the Kong edge.** This is a narrowed claim (ADR-0179), not
a bug awaiting a fix: forwarding a projection of the arguments from Kong is future work.

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

**What a refusal says, exactly (plugin 0.4.0).** The plugin cannot know in advance whether a
data-scope rule applies — rules live in the PDP and change at runtime — so it does not pre-empt the
PDP. It **tags** the answer instead: whenever the PDP returns `deny` and its `contextApplied` does
not name `args`, the `403` body carries

```json
{ "message": "forbidden by policy", "decision": "deny",
  "decidedWithout": ["args"],
  "note": "decided without tool arguments, which this Kong adapter never sends; this does not say whether they were needed. Only if the rule in x-regulait-reason is a data-scope rule did their absence cause the deny, and such a rule always denies at the Kong edge" }
```

and Kong's error log gets a warning naming the rule id from `x-regulait-reason`.

**The tag is a fact about the input, not a diagnosis.** Because this plugin never sends arguments,
*every* deny it receives was decided without them — including one refused simply because the
subject has no grant. The PDP's answer names what the decision was computed **on**
(`contextApplied`); it does not say whether a rule **needed** something that was absent, so the tag
cannot say that either. Before ADR-0179's review the field was named `notEvaluated` and its note
asserted the data-scope consequence on every deny; both overstated it. To tell this limit from an
ordinary refusal, look up the rule id from `x-regulait-reason` in the ledger: a data-scope rule
there means this limit, anything else is an ordinary refusal. Tagging only the denies whose rule
needed arguments would take a PDP response field that does not exist today. The tag is not a header,
because the five protocol header names are a closed set refused on inbound requests.
`approval_required` and `allow` are never tagged.
