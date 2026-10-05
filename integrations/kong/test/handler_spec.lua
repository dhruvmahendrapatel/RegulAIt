-- Unit spec for the regulait-authz plugin's decision logic (ADR-0179: AER-028, AER-036).
--
-- WHAT THIS IS AND IS NOT. `verify.mjs` runs the plugin inside a pinned Kong
-- container against a live PDP and a counting upstream; that is the support
-- claim. This file runs `handler.lua` in a plain Lua interpreter with `kong`,
-- `resty.http` and `cjson.safe` stubbed, so the two behaviours ADR-0179 narrows
-- the claims to are pinned on every machine, including ones with no docker:
--
--   AER-028  data-scope rules are NOT supported at the Kong edge. The question
--            never carries `args`, and a deny the PDP decided without them is
--            tagged so an operator can tell the limit from a policy refusal.
--   AER-036  the session origin is DERIVED only for key-auth (`api_key`) and
--            basic-auth (`password`). Every other credential, an OIDC or SAML
--            route included, carries the operator's ASSERTION or nothing, and
--            an assertion that contradicts a derived origin is refused before
--            the PDP is asked.
--
-- Run it:  lua integrations/kong/test/handler_spec.lua   (Lua 5.1+ or LuaJIT)
-- It prints one line per case and exits non-zero on any failure.

local here = (arg and arg[0] or ""):match("^(.*)[/\\][^/\\]*$") or "."
package.path = here .. "/../?.lua;" .. here .. "/../?/init.lua;" .. package.path

------------------------------------------------------------------------------
-- stubs
------------------------------------------------------------------------------
local pdp = { calls = {}, answer = nil }
package.preload["resty.http"] = function()
  return {
    new = function()
      return {
        set_timeout = function() end,
        request_uri = function(_, url, opts)
          pdp.calls[#pdp.calls + 1] = { url = url, question = opts.body }
          if pdp.answer == nil then return nil, "connection refused" end
          return { status = 200, body = pdp.answer }
        end,
      }
    end,
  }
end
-- identity codec: the question reaches the stub PDP as the table the plugin
-- built, and the stub's answer reaches the plugin as a table
package.preload["cjson.safe"] = function()
  return {
    encode = function(t) return t end,
    decode = function(s) if s == "" then return nil end return s end,
  }
end
package.preload["kong.db.schema.typedefs"] = function()
  return {
    no_consumer = {}, protocols_http = {},
    url = function(t) return t end,
  }
end

local state
local function reset(req)
  pdp.calls = {}
  pdp.answer = req.pdp_answer
  state = { headers = {}, logs = {}, exit = nil, cleared = {} }
  local function log(level)
    return function(...)
      local parts = {}
      for i = 1, select("#", ...) do parts[#parts + 1] = tostring((select(i, ...))) end
      state.logs[#state.logs + 1] = { level = level, msg = table.concat(parts) }
    end
  end
  _G.kong = {
    request = { get_headers = function() return req.headers or {}, nil end },
    client = {
      get_consumer = function() return req.consumer end,
      get_credential = function() return req.credential end,
    },
    service = { request = { clear_header = function(h) state.cleared[#state.cleared + 1] = h end } },
    response = {
      set_header = function(k, v) state.headers[k] = v end,
      exit = function(status, body)
        state.exit = { status = status, body = body }
        return state.exit
      end,
    },
    log = { warn = log("warn"), err = log("err"), notice = log("notice") },
  }
end

local handler = require "kong.plugins.regulait-authz.handler"
local schema = require "kong.plugins.regulait-authz.schema"

------------------------------------------------------------------------------
-- harness
------------------------------------------------------------------------------
local failures, passed = 0, 0
local function check(name, cond, detail)
  if cond then
    passed = passed + 1
    print("ok   " .. name)
  else
    failures = failures + 1
    print("FAIL " .. name .. (detail and ("  -- " .. detail) or ""))
  end
end

local USER = "11111111-2222-3333-4444-555555555555"
local CONSUMER = { id = "c-1", username = "alice", custom_id = USER }
local KEY_AUTH = { id = "k-1", key = "alice-key" }
local BASIC_AUTH = { id = "b-1", username = "alice", password = "<hashed>" }
-- what Kong's jwt plugin authenticates with: a jwt_secrets row
local JWT = { id = "j-1", key = "https://issuer.example", secret = "<s>", algorithm = "RS256", rsa_public_key = "<pem>" }
-- an OIDC- or SAML-fronted route: the credential names no mechanism Kong can read
local OPAQUE = { id = "o-1" }

local function conf(extra)
  local c = { pdp_url = "http://pdp", pdp_key = "k", server_id = "s", tool_name = "t", timeout_ms = 2000 }
  for k, v in pairs(extra or {}) do c[k] = v end
  return c
end

local function run(c, req)
  reset(req)
  handler:access(c)
  return state.exit, pdp.calls[1] and pdp.calls[1].question or nil
end

local function has(list, name)
  for _, v in ipairs(list or {}) do if v == name then return true end end
  return false
end

------------------------------------------------------------------------------
-- AER-028: no args at the edge, and a deny decided without them says so
------------------------------------------------------------------------------
do
  local exit, q = run(conf({ project_id = "p" }), {
    consumer = CONSUMER, credential = KEY_AUTH,
    pdp_answer = { decision = "deny", reason = "rule-123", contextApplied = { "projectId", "principal", "principal.asserted" } },
  })
  check("AER-028: the question never carries args", q ~= nil and q.args == nil)
  check("AER-028: a deny decided without args is refused 403", exit and exit.status == 403)
  check("AER-028: the reason header still names the PDP's rule id", state.headers["x-regulait-reason"] == "rule-123")
  check("AER-028: the refusal body tags args as not evaluated",
    exit and exit.body and has(exit.body.notEvaluated, "args"))
  check("AER-028: the body says data-scope rules always deny at the Kong edge",
    exit and exit.body and type(exit.body.note) == "string" and exit.body.note:find("data%-scope rule") ~= nil
      and exit.body.note:find("Kong edge") ~= nil)
  local warned = false
  for _, l in ipairs(state.logs) do
    if l.level == "warn" and l.msg:find("rule-123", 1, true) and l.msg:find("Kong edge", 1, true) then warned = true end
  end
  check("AER-028: the operator's log names the rule id and the edge limit", warned)
end

do
  -- the tag is read from the PDP's answer, not assumed: a deny that WAS computed
  -- on arguments is an ordinary policy refusal and must not carry it
  local exit = run(conf(), {
    consumer = CONSUMER, credential = KEY_AUTH,
    pdp_answer = { decision = "deny", reason = "grant-missing", contextApplied = { "args", "principal" } },
  })
  check("AER-028 control: a deny computed WITH args carries no edge tag",
    exit and exit.status == 403 and exit.body.notEvaluated == nil and exit.body.note == nil)
end

do
  local exit = run(conf(), {
    consumer = CONSUMER, credential = KEY_AUTH,
    pdp_answer = { decision = "allow", reason = "grant-1", contextApplied = { "principal" } },
  })
  check("AER-028 control: an allow proxies, untagged", exit == nil and #state.cleared == 5)
end

do
  local exit = run(conf(), {
    consumer = CONSUMER, credential = KEY_AUTH,
    pdp_answer = { decision = "approval_required", reason = "appr-1", contextApplied = { "principal" } },
  })
  check("AER-028 control: approval_required keeps its own decision and no edge tag",
    exit and exit.status == 403 and state.headers["x-regulait-decision"] == "approval_required"
      and exit.body.notEvaluated == nil)
end

------------------------------------------------------------------------------
-- AER-036: mixed authentication
------------------------------------------------------------------------------
do
  -- key-auth plus an asserted origin that contradicts it: refused, PDP never asked
  local exit = run(conf({ asserted_session_origin = "oidc" }), {
    consumer = CONSUMER, credential = KEY_AUTH, pdp_answer = { decision = "allow" },
  })
  check("AER-036: key-auth + asserted oidc is refused",
    exit and exit.status == 403 and state.headers["x-regulait-reason"] == "session_origin_contradicts_credential")
  check("AER-036: ... before the PDP is asked", #pdp.calls == 0)
end

do
  local exit = run(conf({ asserted_session_origin = "password" }), {
    consumer = CONSUMER, credential = KEY_AUTH, pdp_answer = { decision = "allow" },
  })
  check("AER-036: key-auth + asserted password is refused too",
    exit and state.headers["x-regulait-reason"] == "session_origin_contradicts_credential" and #pdp.calls == 0)
end

do
  local exit, q = run(conf(), {
    consumer = CONSUMER, credential = KEY_AUTH, pdp_answer = { decision = "allow", contextApplied = { "principal" } },
  })
  check("AER-036: key-auth with no assertion derives api_key",
    exit == nil and q and q.principal and q.principal.sessionOrigin == "api_key")
  check("no mfaCompleted is ever sent: Kong cannot observe a second factor",
    q and q.principal and q.principal.mfaCompleted == nil)
end

do
  local exit, q = run(conf(), {
    consumer = CONSUMER, credential = BASIC_AUTH, pdp_answer = { decision = "allow", contextApplied = { "principal" } },
  })
  check("AER-036: basic-auth derives password",
    exit == nil and q and q.principal and q.principal.sessionOrigin == "password")
end

do
  local exit = run(conf({ asserted_session_origin = "saml" }), {
    consumer = CONSUMER, credential = BASIC_AUTH, pdp_answer = { decision = "allow" },
  })
  check("AER-036: basic-auth + asserted saml is refused as a contradiction",
    exit and state.headers["x-regulait-reason"] == "session_origin_contradicts_credential" and #pdp.calls == 0)
end

do
  local exit, q = run(conf({ asserted_session_origin = "password" }), {
    consumer = CONSUMER, credential = BASIC_AUTH, pdp_answer = { decision = "allow", contextApplied = { "principal" } },
  })
  check("AER-036: basic-auth + an agreeing assertion is accepted",
    exit == nil and q and q.principal.sessionOrigin == "password")
end

do
  local exit, q = run(conf({ asserted_session_origin = "oidc" }), {
    consumer = CONSUMER, credential = OPAQUE, pdp_answer = { decision = "allow", contextApplied = { "principal", "principal.asserted" } },
  })
  check("AER-036: an OIDC route's asserted origin is accepted and sent as asserted",
    exit == nil and q and q.principal and q.principal.sessionOrigin == "oidc")
end

do
  local exit, q = run(conf({ asserted_session_origin = "saml" }), {
    consumer = CONSUMER, credential = OPAQUE, pdp_answer = { decision = "allow", contextApplied = { "principal" } },
  })
  check("AER-036: a SAML route's asserted origin is accepted",
    exit == nil and q and q.principal.sessionOrigin == "saml")
end

do
  local exit, q = run(conf(), {
    consumer = CONSUMER, credential = OPAQUE, pdp_answer = { decision = "allow", contextApplied = {} },
  })
  check("AER-036: an underivable credential with no assertion sends NO principal (reads as unknown)",
    exit == nil and q and q.principal == nil)
end

do
  -- a jwt credential carries `key` too; it is not key-auth and must not derive api_key
  local exit, q = run(conf({ asserted_session_origin = "oidc" }), {
    consumer = CONSUMER, credential = JWT, pdp_answer = { decision = "allow", contextApplied = { "principal" } },
  })
  check("AER-036: a jwt credential derives nothing, so its asserted oidc is accepted, not refused",
    exit == nil and q and q.principal and q.principal.sessionOrigin == "oidc")
  local _, q2 = run(conf(), {
    consumer = CONSUMER, credential = JWT, pdp_answer = { decision = "allow", contextApplied = {} },
  })
  check("AER-036: a jwt credential with no assertion is never labelled api_key", q2 and q2.principal == nil)
end

do
  local origin_field
  for _, f in ipairs(schema.fields) do
    if f.config then
      for _, cf in ipairs(f.config.fields) do
        if cf.asserted_session_origin then origin_field = cf.asserted_session_origin end
      end
    end
  end
  local allowed = origin_field and table.concat(origin_field.one_of, ",") or nil
  check("AER-036: api_key can never be asserted, only derived (schema)",
    allowed == "password,oidc,saml", "one_of=" .. tostring(allowed))
end

print(string.format("\n%d passed, %d failed", passed, failures))
os.exit(failures == 0 and 0 or 1)
