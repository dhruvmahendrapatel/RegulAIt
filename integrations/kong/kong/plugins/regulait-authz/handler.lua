-- ADR-0127 / ROADMAP G9 — RegulAIt as Kong's authorization decision point.
--
-- ┌─────────────────────────────────────────────────────────────────────────┐
-- │ VERIFIED against kong:3.6 — deny path exercised end to end, with a      │
-- │ counting upstream, on every change to integrations/.                    │
-- │ .github/workflows/integrations.yml · first green run 2026-09-27         │
-- │ (run 36300665525); the last green run of the code before 0.3.0 (still   │
-- │ numbered 0.1.0-unverified then) was 36930442969 at 3a91a93. That code   │
-- │ IGNORED a forged subject header; 0.3.0 refuses it instead.              │
-- │                                                                          │
-- │ PENDING FIRST CI RUN — written but never yet run against a container,   │
-- │ so NOT verified until a green run id is recorded here: the AER-026       │
-- │ identity refusals (unmapped, non-uuid, unknown, deactivated, anonymous  │
-- │ fallback), duplicate and mixed-case protocol headers, the five-name      │
-- │ refusal with other x-regulait-* headers passed through, the truncated   │
-- │ header-scan refusal, the AER-030 second route and forged server/tool/   │
-- │ decision headers, and the AER-034 digest pin.                            │
-- │                                                                          │
-- │ Covered precisely: Kong 3.6, DB-less, key-auth. The PRIORITY ordering   │
-- │ below is version-specific, so a different Kong is unverified until the  │
-- │ harness runs against it.                                                 │
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
  -- 0.1.0  the plugin that replaced the pre-function (ADR-0127 amendment).
  -- 0.2.0  `session_origin` became `asserted_session_origin` and a
  --        contradiction became a refusal (AER-036). A breaking config change,
  --        and the number should have moved with it.
  -- 0.3.0  an inbound copy of one of the five protocol headers is REFUSED
  --        rather than stripped, as is a request too large for the header
  --        scan; a consumer without a credential is refused; the consumer
  --        mapping must be a user UUID; and the Kong consumer identity travels
  --        with the question so the ledger keeps it beside the subject
  --        (AER-026, AER-030). These cases are PENDING THEIR FIRST CI RUN —
  --        see the box at the top of this file.
  VERSION = "0.3.0",
  -- Below every common auth plugin and below ACL, so `kong.client.get_consumer()`
  -- is populated by the time access() runs. This number IS the fix for (1).
  PRIORITY = 900,
}

--[[
INBOUND PROTOCOL HEADERS ARE A REFUSAL, NOT A STRIP (AER-026 / AER-030).

The protocol is FIVE names. `x-regulait-decision` and `x-regulait-reason` are
headers THIS plugin sets on its own refusals; `x-regulait-subject`,
`x-regulait-server-id` and `x-regulait-tool` were read by the pre-function it
replaced. Nothing reads any of them from a request any more, and a request that
carries one is either a misconfigured chain or an attempt to borrow a decision.

ONLY THOSE FIVE. Other `x-regulait-*` headers are ordinary client traffic and
pass through untouched: docs/product/IDE_INTEGRATION.md tells clients to send
`x-regulait-project-id` and `x-regulait-agent-id` (on the MCP transport too),
and the console sends `x-regulait-csrf`. Refusing the whole prefix refused
every request that carried project attribution and labelled it a forgery.

The previous version cleared the five and carried on. That is only as safe as
every later line of code, it made a forgery attempt invisible to the operator,
and "ignored" cannot be told from "honoured" in an access log. Refusing is the
posture used for every other misconfiguration here, and it is loud: the
response names the reason, so an operator is sent to the client rather than to
a policy screen.

HOW THE SCAN READS. nginx lower-cases header names, and a header sent several
times is ONE key whose value is a list, so one membership test per key covers
every spelling and every copy. Underscores are folded to hyphens before the
test, because an upstream that maps both to one name (CGI-style servers do)
would otherwise read `x_regulait_subject` as the real thing. The scan reads at
most 1000 headers — Kong's ceiling for `get_headers` — and a request with MORE
is REFUSED: a protocol header placed after the 1000th would otherwise never be
looked at, and an unread header is not a header known to be absent. The five
names are still cleared on the allow path as belt and braces.
--]]
local MAX_SCANNED_HEADERS = 1000
local PROTOCOL_HEADERS = {
  "x-regulait-subject", "x-regulait-server-id", "x-regulait-tool",
  "x-regulait-decision", "x-regulait-reason",
}
local IS_PROTOCOL_HEADER = {}
for _, h in ipairs(PROTOCOL_HEADERS) do IS_PROTOCOL_HEADER[h] = true end

-- Returns the offending header name, or nil plus `true` when the request had
-- more headers than the scan reads (a refusal of its own), or nil when clean.
local function first_client_claim()
  local headers, err = kong.request.get_headers(MAX_SCANNED_HEADERS)
  if err then
    -- "truncated" is the only error nginx reports here, and it means the scan
    -- did not see every header. Any error is treated the same way.
    return nil, true
  end
  for name in pairs(headers or {}) do
    if type(name) == "string" and IS_PROTOCOL_HEADER[(name:lower():gsub("_", "-"))] then
      return name
    end
  end
  return nil
end

local function strip_client_claims()
  for _, h in ipairs(PROTOCOL_HEADERS) do
    kong.service.request.clear_header(h)
  end
end

-- The shape of a RegulAIt user id, which is what `custom_id` must carry. A
-- consumer mapped to anything else (an email, a username, a display name) is
-- not mapped to ONE user by primary key, and the PDP would refuse the question
-- as malformed — which this plugin would then report as a PDP failure. Checked
-- here so a mapping error reads as a mapping error.
local USER_UUID = "^%x%x%x%x%x%x%x%x%-%x%x%x%x%-%x%x%x%x%-%x%x%x%x%-%x%x%x%x%x%x%x%x%x%x%x%x$"

--[[
THE QUESTION THE CALLOUT ASKS (AER-028).

`userId`, `serverId` and `toolName` alone were not the same question a real
dispatch asks. The kernel FAILS CLOSED on a data-scope rule whose argument is
absent, so a deployment with one got `deny` from the PDP for calls that would
really have been allowed — wrong in the safe direction, which is the direction
that gets a PDP switched off.

This builder sends everything this adapter can state TRUTHFULLY and nothing it
cannot:

  * `projectId` — per-route config. A governed route fronts one project context.
  * `principal.sessionOrigin` — DERIVED from the authenticated credential where
    Kong can see one, and only otherwise taken from the operator's declared
    assertion (AER-036: it used to be the declared value unconditionally, and the
    declaration was never checked against anything). There is no `mfaCompleted`:
    Kong cannot observe a second factor, and absent reads as "unknown", which is
    the weakest input an ABAC policy can get. A configured `true` would be an
    unchecked assertion sitting in the trusted path.
  * `proxyConsumer` — the Kong consumer the subject was RESOLVED FROM (AER-026).
    The PDP keeps it on the ledger row beside the subject it resolved to, so
    "which Kong consumer was this?" is answerable when a mapping turns out to
    be wrong. Provenance only: it is never a decision input.
  * `args` — NOT SENT, and this is the honest limit. Mapping an HTTP body to a
    tool's named arguments is a per-route projection, and a WRONG mapping
    evaluates a data-scope rule against the wrong values — which is worse than
    the fail-closed deny that omitting them produces. So a route governed by a
    data-scope rule is refused by this adapter, by design, until that mapping
    exists. The response's `contextApplied` names what the decision really ran
    on, so an operator can tell this from a policy refusal.
--]]
--[[
AER-036 — THE SESSION ORIGIN IS DERIVED WHERE IT CAN BE, AND ASSERTED ONLY WHERE
IT CANNOT.

`kong.client.get_credential()` returns the credential the auth plugin on this
route authenticated with, and its SHAPE names the mechanism: a key-auth
credential carries `key`, a basic-auth credential carries `username` and
`password`. Those two are therefore observable per request, and for them this
adapter sends what it saw rather than what it was told.

Nothing in Kong's community plugin set gives an equally reliable per-request
signal for OIDC or SAML, so for those the configured value remains an ASSERTION —
which is why the field is now named `asserted_session_origin` and why a
contradiction is a refusal rather than a silent substitution. The vocabulary is
the product's own (`SESSION_ORIGINS`): `sso` is gone, because it matched no
policy the gateway can express and satisfied every "not an API key" policy.

Returns the origin plus whether it was derived, or nil when Kong knows nothing —
in which case NO principal is sent and the kernel reads `unknown`, the weakest
input. Absent is always a safe answer here; a wrong one is not.
--]]
local function derive_session_origin(credential)
  if not credential then return nil end
  if credential.key ~= nil and credential.key ~= "" then return "api_key" end
  if credential.username ~= nil and credential.password ~= nil then return "password" end
  return nil
end

local function build_question(conf, consumer, subject, session_origin)
  local body = {
    userId = subject,
    serverId = conf.server_id,
    toolName = conf.tool_name,
    proxyConsumer = { id = consumer.id, username = consumer.username },
  }
  if conf.project_id and conf.project_id ~= "" then
    body.projectId = conf.project_id
  end
  if session_origin then
    body.principal = { sessionOrigin = session_origin }
  end
  return body
end

local function refuse(status, decision, reason)
  kong.response.set_header("x-regulait-decision", decision)
  if reason then kong.response.set_header("x-regulait-reason", reason) end
  return kong.response.exit(status, { message = "forbidden by policy", decision = decision })
end

function RegulaitAuthz:access(conf)
  local claim, truncated = first_client_claim()
  if truncated then
    kong.log.warn("regulait: refused a request with more than ", MAX_SCANNED_HEADERS,
      " headers — the protocol-header scan could not read them all")
    return refuse(403, "deny", "too_many_headers")
  end
  if claim then
    kong.log.warn("regulait: refused a request carrying protocol header '", claim, "'")
    return refuse(403, "deny", "forged_protocol_header")
  end

  -- THE SUBJECT, from the authenticated consumer and from nowhere else. There
  -- is no header path to it and no fallback, because a fallback IS the bypass:
  -- the first version of this integration preferred a client-sent
  -- `x-regulait-subject` over the consumer, so anyone who could reach the route
  -- could be authorized as anyone.
  local consumer = kong.client.get_consumer()
  local credential = kong.client.get_credential()
  if not consumer then
    -- No authenticated consumer: this route has no auth plugin, or this plugin
    -- has been re-prioritized above it. Either way there is nobody to decide
    -- about, and inventing one is not an option.
    return refuse(403, "deny", "unauthenticated")
  end
  if not credential then
    -- A consumer WITHOUT a credential is what Kong's `anonymous` fallback
    -- produces when authentication failed on a route that configured one. The
    -- consumer is real, the request is not authenticated, and if an operator
    -- mapped that consumer's `custom_id` to a real user — the anonymous
    -- consumer is a consumer like any other — every unauthenticated request
    -- would be decided as that user. Nobody presented anything, so nobody is
    -- decided about (AER-026).
    return refuse(403, "deny", "unauthenticated")
  end
  -- `custom_id` carries the RegulAIt user UUID. Kong's own consumer id is a
  -- Kong fact; the PDP answers about a RegulAIt user. An unmapped consumer is a
  -- refusal, because guessing would decide about the wrong person — and so is
  -- a consumer mapped to something that is not a user id, because that is not
  -- a mapping to ONE person.
  local subject = consumer.custom_id
  if type(subject) ~= "string" or not subject:match(USER_UUID) then
    kong.log.warn("regulait: consumer '", consumer.username or consumer.id,
      "' has ", subject == nil and "no custom_id" or "a custom_id that is not a user uuid")
    return refuse(403, "deny", "consumer_not_mapped")
  end

  -- AER-036 — DERIVE, THEN REFUSE A CONTRADICTION.
  --
  -- A route whose credential Kong can read has an observable origin, so the
  -- observation wins over the declaration. If the operator declared a DIFFERENT
  -- one, this deployment's ABAC expectations are not the ones being evaluated:
  -- sending either value would be wrong (the declared one is false, the derived
  -- one silently overrides a policy intent nobody revisited), so the request is
  -- refused with its own reason, before the upstream is reached.
  --
  -- Fail-closed on a misconfiguration is the posture everywhere else in this
  -- integration — an unmapped consumer and an unreachable PDP are both refusals
  -- — and it is what makes "configuring SSO on a key-auth route is impossible"
  -- true in the deployment rather than only in the documentation.
  local derived = derive_session_origin(credential)
  local asserted = conf.asserted_session_origin
  if asserted == "" then asserted = nil end
  if derived and asserted and derived ~= asserted then
    return refuse(403, "deny", "session_origin_contradicts_credential")
  end
  local session_origin = derived or asserted

  local client = http.new()
  client:set_timeout(conf.timeout_ms)

  local res, err = client:request_uri(conf.pdp_url .. "/v1/authz/check", {
    method = "POST",
    headers = {
      ["content-type"] = "application/json",
      ["authorization"] = "Bearer " .. conf.pdp_key,
    },
    body = cjson.encode(build_question(conf, consumer, subject, session_origin)),
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
    strip_client_claims()
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
