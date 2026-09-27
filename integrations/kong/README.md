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

- a policy `deny`;
- an `approval_required`;
- a PDP that is unreachable;
- a PDP that answers non-200 or unparseable;
- a request with a forged `x-regulait-subject` (and its case variants), which
  must be ignored entirely rather than merely overridden.

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

`project_id` and `session_origin` are **per-route plugin config**, and sent when set. Both are
static per route and both are things Kong can state truthfully: a governed route fronts one project
context, and its operator knows which auth plugin fronts it. Set `project_id` if any of your rules
are deploy-mode scoped; set `session_origin` (`password` | `sso` | `api_key`) if an ABAC policy
reads it.

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
