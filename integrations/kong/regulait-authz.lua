-- ADR-0127 / ROADMAP G9 — RegulAIt as Kong's authorization decision point.
--
-- Kong stays the data plane. RegulAIt decides. Drop this in a `pre-function`
-- (or wrap it as a custom plugin) on the routes you want governed.
--
-- READ docs/deployment/GATEWAY_TOPOLOGY.md FIRST. Three things make this safe
-- or unsafe and none is visible from this file: the credential is a
-- subject-impersonation key, each decision costs real database work, and a PDP
-- decides without enforcing.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- THE FIRST CUT OF THIS FILE TOOK ALL THREE DECISION INPUTS FROM CLIENT-SENT
-- HEADERS. That is recorded here rather than quietly corrected, because the
-- shape of the mistake is the thing worth not repeating.
--
--   local subject = kong.request.get_header("x-regulait-subject")
--     or (kong.client.get_consumer() or {}).custom_id
--
-- The authenticated consumer was the FALLBACK. Any caller could send
-- `x-regulait-subject: <any uuid>` and be authorized as that person — a
-- complete authorization bypass, reachable by anyone who can reach the route.
-- `serverId` and `toolName` came from `x-regulait-server-id` and
-- `x-regulait-tool` the same way, so a caller could also choose WHICH QUESTION
-- was asked: name a tool they hold, then invoke a different one. The decision
-- would be truthfully computed, correctly audited, and about something else.
--
-- The comment directly above that line said the consumer must be mapped to a
-- RegulAIt user first. The code then preferred the header over the consumer.
-- A comment stating the safe rule does not implement it.
--
-- Rules this file now keeps:
--   1. Identity comes ONLY from what Kong itself authenticated. There is no
--      header path to it and no fallback, because a fallback IS the bypass.
--   2. The question (server + tool) comes from ROUTE CONFIGURATION, not from
--      the request. A governed route knows what it fronts.
--   3. Every `x-regulait-*` header on the way in is cleared before the request
--      continues, so nothing downstream can mistake a client's claim for ours.
-- ─────────────────────────────────────────────────────────────────────────────

local http = require "resty.http"
local cjson = require "cjson.safe"

local PDP_URL = os.getenv("REGULAIT_PDP_URL") or "http://regulait-gateway:3000"
local PDP_KEY = os.getenv("REGULAIT_PDP_KEY")

-- WHAT THIS ROUTE FRONTS. Set per route, beside the plugin — never read from
-- the request. If one Kong route can front several tools, it needs several
-- routes, or a mapping here from something Kong itself decided (the matched
-- route name, the service id), never from something the caller sent.
local SERVER_ID = os.getenv("REGULAIT_SERVER_ID")
local TOOL_NAME = os.getenv("REGULAIT_TOOL_NAME")

-- Deliberate, not a default. The PDP does around twenty database round trips
-- per decision and this runs on every request.
local TIMEOUT_MS = 2000

-- Inbound copies of our own protocol headers are forged until proven
-- otherwise, and nothing here can prove otherwise. Clear them on entry so a
-- later hop cannot read a client's claim as a decision of ours. Cleared for
-- EVERY outcome, including allow, and including the case-variant spellings a
-- bypass attempt would reach for first.
local function strip_client_claims()
  for _, h in ipairs({
    "x-regulait-subject", "X-Regulait-Subject", "X-REGULAIT-SUBJECT",
    "x-regulait-server-id", "x-regulait-tool",
    "x-regulait-decision", "x-regulait-reason",
  }) do
    kong.service.request.clear_header(h)
  end
end

local function refuse(status, decision, reason)
  strip_client_claims()
  kong.response.set_header("x-regulait-decision", decision)
  if reason then kong.response.set_header("x-regulait-reason", reason) end
  return kong.response.exit(status, { message = "forbidden by policy", decision = decision })
end

strip_client_claims()

-- THE SUBJECT, from the authenticated consumer and from nowhere else.
--
-- `custom_id` is where the RegulAIt user UUID belongs: Kong's own consumer id
-- is a Kong fact, and the PDP answers about a RegulAIt user. A consumer with
-- no custom_id has not been mapped, and an unmapped consumer is a refusal —
-- guessing would mean deciding about the wrong person.
local consumer = kong.client.get_consumer()
if not consumer then
  -- No authenticated consumer at all: this route is missing its auth plugin,
  -- or it runs before one. Either way there is nobody to decide about.
  return refuse(403, "deny", "unauthenticated")
end
local subject = consumer.custom_id
if not subject or subject == "" then
  return refuse(403, "deny", "consumer_not_mapped")
end

if not SERVER_ID or not TOOL_NAME then
  -- A route that cannot say what it fronts cannot be governed. Refusing is the
  -- only honest answer; proceeding would authorize an unnamed thing.
  kong.log.err("regulait: REGULAIT_SERVER_ID / REGULAIT_TOOL_NAME not set on this route")
  return refuse(503, "deny", "route_not_configured")
end

local client = http.new()
client:set_timeout(TIMEOUT_MS)

local res, err = client:request_uri(PDP_URL .. "/v1/authz/check", {
  method = "POST",
  headers = {
    ["content-type"] = "application/json",
    -- A secret read from the environment is the floor, not the pattern. Use
    -- Kong's vault references in anything real.
    ["authorization"] = "Bearer " .. (PDP_KEY or ""),
  },
  body = cjson.encode({
    userId = subject,
    serverId = SERVER_ID,
    toolName = TOOL_NAME,
  }),
})

-- FAIL CLOSED, and say which failure it was. If RegulAIt is unreachable, a
-- governance deployment must not admit the request: an outage that silently
-- becomes an open door is the worst shape this can take, because the ledger
-- will show that nothing was ever asked.
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

-- `approval_required` is a DENY — the request must not proceed — but it is not
-- the same fact as a policy refusal, and a caller that treats every 403 alike
-- loses the distinction the approvals queue exists to make. Hence its own
-- header rather than a flattened message.
if body.decision == "approval_required" then
  return refuse(403, "approval_required", body.reason)
end

return refuse(403, "deny", body.reason)
