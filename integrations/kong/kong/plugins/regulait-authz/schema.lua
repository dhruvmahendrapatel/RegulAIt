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
          -- The PDP does real database work per decision (GATEWAY_TOPOLOGY.md
          -- §4) and this runs on every request, so the deadline is deliberate.
          { timeout_ms = { type = "integer", default = 2000, between = { 100, 10000 } } },
        },
      },
    },
  },
}
