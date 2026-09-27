-- ADR-0127 — per-ROUTE configuration for the RegulAIt authorization callout.
--
-- This file is the reason the plugin exists at all. The previous artifact was a
-- `pre-function` snippet that read its server and tool from `os.getenv`, and an
-- environment variable is node configuration: on one data plane serving several
-- governed routes, every copy reads the same pair, so every route asks the same
-- question no matter what it actually fronts. A plugin's `config` is attached
-- to the route (or service) the plugin is enabled on, which is the only place
-- this can correctly live.
local typedefs = require "kong.db.schema.typedefs"

return {
  name = "regulait-authz",
  fields = {
    { consumer = typedefs.no_consumer },
    { protocols = typedefs.protocols_http },
    {
      config = {
        type = "record",
        fields = {
          { pdp_url = typedefs.url({ required = true, default = "http://regulait-gateway:3000" }) },
          -- The PDP credential. Use a Kong vault reference ({vault://...}) in
          -- anything real; see GATEWAY_TOPOLOGY.md on why this key is sensitive.
          { pdp_key = { type = "string", required = true, referenceable = true, encrypted = true } },
          -- WHAT THIS ROUTE FRONTS. Required, because a route that cannot say
          -- what it fronts cannot be governed, and guessing would authorize an
          -- unnamed thing.
          { server_id = { type = "string", required = true } },
          { tool_name = { type = "string", required = true } },
          -- AER-028's PROJECT half. Optional, and honest either way: a governed
          -- route fronts a tool inside ONE project context, so this is static
          -- per route and the operator is the only component that knows it.
          -- Omitting it means a deploy-mode-scoped rule sees no project and
          -- matches nothing — the fail-closed direction, and the reason this
          -- field exists rather than a guess.
          { project_id = { type = "string" } },
          -- ADR-0040 session facts, for an ABAC policy that reads them.
          -- DELIBERATELY per-route static, because that is the only thing Kong
          -- can state truthfully: it knows which auth plugin fronts this route,
          -- so an operator whose route sits behind OIDC can say `sso` once.
          -- There is NO mfa field: Kong cannot observe whether a second factor
          -- was completed, and a configured `true` would be an assertion nobody
          -- checked, sitting in the trusted path. Absent is the honest value —
          -- it reads as "unknown", which is the weakest input a policy can get.
          { session_origin = { type = "string", one_of = { "password", "sso", "api_key" } } },
          -- The PDP does real database work per decision (GATEWAY_TOPOLOGY.md
          -- §4) and this runs on every request, so the deadline is deliberate.
          { timeout_ms = { type = "integer", default = 2000, between = { 100, 10000 } } },
        },
      },
    },
  },
}
