-- ADR-0127 / ROADMAP G9 — RegulAIt as Kong's authorization decision point.
--
-- Kong stays the data plane. RegulAIt decides. Drop this in a `pre-function`
-- (or wrap it as a custom plugin) on the routes you want governed.
--
-- READ docs/deployment/GATEWAY_TOPOLOGY.md FIRST. Three things make this safe
-- or unsafe and none is visible from this file: the credential is a
-- subject-impersonation key, each decision costs real database work, and a PDP
-- decides without enforcing.

local http = require "resty.http"
local cjson = require "cjson.safe"

local PDP_URL = os.getenv("REGULAIT_PDP_URL") or "http://regulait-gateway:3000"
local PDP_KEY = os.getenv("REGULAIT_PDP_KEY")

-- Deliberate, not a default. The PDP does around twenty database round trips
-- per decision and this runs on every request.
local TIMEOUT_MS = 2000

local function refuse(status, decision, reason)
  kong.response.set_header("x-regulait-decision", decision)
  if reason then kong.response.set_header("x-regulait-reason", reason) end
  return kong.response.exit(status, { message = "forbidden by policy", decision = decision })
end

-- The SUBJECT. Kong must map its own authenticated consumer to a RegulAIt user
-- UUID before here; the raw consumer id will not do. See §3 of the topology doc.
local subject = kong.request.get_header("x-regulait-subject")
  or (kong.client.get_consumer() or {}).custom_id
if not subject then
  -- FAIL CLOSED. No subject means no decision can be made about anyone, which
  -- is a refusal and not a reason to wave the request through.
  return refuse(403, "deny", "no_subject")
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
    serverId = kong.request.get_header("x-regulait-server-id"),
    toolName = kong.request.get_header("x-regulait-tool"),
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
