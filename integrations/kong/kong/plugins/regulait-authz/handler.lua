-- ADR-0127 / ROADMAP G9 — RegulAIt as Kong's authorization decision point.
--
-- ┌─────────────────────────────────────────────────────────────────────────┐
-- │ VERIFIED against a pinned kong:3.6 — deny path exercised end to end,    │
-- │ with a counting upstream, on every change to integrations/.             │
-- │ .github/workflows/integrations.yml · first green run 2026-09-27.        │
-- │                                                                          │
-- │ Covered precisely: Kong 3.6, DB-less, key-auth, one governed route.      │
-- │ The PRIORITY ordering below is version-specific, so a different Kong is  │
-- │ unverified until the harness runs against it.                            │
-- └─────────────────────────────────────────────────────────────────────────┘
--
-- WHY A PLUGIN AND NOT THE `pre-function` THIS REPLACES. The snippet it
-- replaces could not work, in three independent ways, and none of them was a
-- bug in its logic:
--
--  1. ORDERING. Pre-Function runs at priority 1000000 — ahead of every
--     authentication plugin. It read identity from `kong.client.get_consumer()`
--     and refused when absent, so on any route with ordinary Kong auth it ran
--     BEFORE the consumer existed and refused all legitimate traffic. Failing
--     closed, so not a security hole; simply unusable. This plugin's PRIORITY
--     is below every common auth plugin (key-auth 1250, basic-auth 1100, jwt
--     1005, oauth2 1004, ldap-auth 1002) and below ACL (950), so the consumer
--     is already set when it runs.
--  2. SANDBOX. `require "resty.http"` is blocked in Kong's serverless-function
--     sandbox by default — it is the exact example in Kong's own support
--     documentation. The first executable line of the snippet could not load.
--     A real plugin is not sandboxed.
--  3. CONFIGURATION. The snippet took the server and tool from `os.getenv`,
--     which is NODE configuration. One data plane serving several governed
--     routes would ask the same question for all of them. `conf` is attached to
--     the route the plugin is enabled on, which is the only correct home for it.
--
-- READ docs/deployment/GATEWAY_TOPOLOGY.md FIRST: the credential is a
-- subject-impersonation key, each decision costs real database work, and a PDP
-- decides without enforcing.

local http = require "resty.http"
local cjson = require "cjson.safe"

local RegulaitAuthz = {
  VERSION = "0.1.0-unverified",
  -- Below every common auth plugin and below ACL, so `kong.client.get_consumer()`
  -- is populated by the time access() runs. This number IS the fix for (1).
  PRIORITY = 900,
}

-- Inbound copies of our own protocol headers are forged until proven otherwise,
-- and nothing here can prove otherwise. Cleared on every path — including allow
-- — so no later hop can read a client's claim as a decision of ours.
local FORGEABLE = {
  "x-regulait-subject", "X-Regulait-Subject", "X-REGULAIT-SUBJECT",
  "x-regulait-server-id", "x-regulait-tool",
  "x-regulait-decision", "x-regulait-reason",
}

local function strip_client_claims()
  for _, h in ipairs(FORGEABLE) do
    kong.service.request.clear_header(h)
  end
end

local function refuse(status, decision, reason)
  strip_client_claims()
  kong.response.set_header("x-regulait-decision", decision)
  if reason then kong.response.set_header("x-regulait-reason", reason) end
  return kong.response.exit(status, { message = "forbidden by policy", decision = decision })
end

function RegulaitAuthz:access(conf)
  strip_client_claims()

  -- THE SUBJECT, from the authenticated consumer and from nowhere else. There
  -- is no header path to it and no fallback, because a fallback IS the bypass:
  -- the first version of this integration preferred a client-sent
  -- `x-regulait-subject` over the consumer, so anyone who could reach the route
  -- could be authorized as anyone.
  local consumer = kong.client.get_consumer()
  if not consumer then
    -- No authenticated consumer: this route has no auth plugin, or this plugin
    -- has been re-prioritized above it. Either way there is nobody to decide
    -- about, and inventing one is not an option.
    return refuse(403, "deny", "unauthenticated")
  end
  -- `custom_id` carries the RegulAIt user UUID. Kong's own consumer id is a
  -- Kong fact; the PDP answers about a RegulAIt user. An unmapped consumer is a
  -- refusal, because guessing would decide about the wrong person.
  local subject = consumer.custom_id
  if not subject or subject == "" then
    return refuse(403, "deny", "consumer_not_mapped")
  end

  local client = http.new()
  client:set_timeout(conf.timeout_ms)

  local res, err = client:request_uri(conf.pdp_url .. "/v1/authz/check", {
    method = "POST",
    headers = {
      ["content-type"] = "application/json",
      ["authorization"] = "Bearer " .. conf.pdp_key,
    },
    body = cjson.encode({
      userId = subject,
      serverId = conf.server_id,
      toolName = conf.tool_name,
    }),
  })

  -- FAIL CLOSED, and say which failure it was. An outage that silently becomes
  -- an open door is the worst shape this can take, because the ledger would
  -- show that nothing was ever asked.
  if not res then
    kong.log.err("regulait pdp unreachable: ", err)
    return refuse(503, "deny", "pdp_unreachable")
  end
  if res.status ~= 200 then
    kong.log.err("regulait pdp returned ", res.status)
    return refuse(503, "deny", "pdp_error")
  end

  local body = cjson.decode(res.body or "")
  if not body or not body.decision then
    return refuse(503, "deny", "pdp_unparseable")
  end

  if body.decision == "allow" then
    return -- Kong proceeds to the upstream
  end

  -- `approval_required` is a DENY — the request must not proceed — but it is
  -- not the same fact as a policy refusal, and a caller that treats every 403
  -- alike loses the distinction the approvals queue exists to make.
  if body.decision == "approval_required" then
    return refuse(403, "approval_required", body.reason)
  end

  return refuse(403, "deny", body.reason)
end

return RegulaitAuthz
