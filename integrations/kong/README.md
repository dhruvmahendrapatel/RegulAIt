# Kong — RegulAIt as an authorization decision point (ADR-0127)

> **UNVERIFIED. RegulAIt does not currently claim Kong support.**
> No Kong has run this plugin. It is published as the *correct shape* of the
> integration so the next attempt does not start from the wrong one — not as a
> working artifact. See "What has to happen before this is supported" below.

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

## What has to happen before this is supported

Per `mistakes.md` M-043, nothing in `integrations/` is called supported until
its **deny path** is exercised end to end against a **pinned Kong container**
with an **upstream invocation counter**, asserting **zero upstream calls** for:

- a policy `deny`;
- an `approval_required`;
- a PDP that is unreachable;
- a PDP that answers non-200 or unparseable;
- a request with a forged `x-regulait-subject` (and its case variants), which
  must be ignored entirely rather than merely overridden.

That rule exists because the Envoy adapter shipped **failing open** on deny and
was reviewed, not run. Review did not catch it. Running it would have.
