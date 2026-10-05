-- Unit spec for the regulait-authz plugin's decision logic (ADR-0179: AER-028, AER-036).
--
-- WHAT THIS IS AND IS NOT. `verify.mjs` runs the plugin inside a pinned Kong
-- container against a live PDP and a counting upstream; that is the support
-- claim. This file runs `handler.lua` under busted with `kong`, `resty.http`
-- and `cjson.safe` stubbed, so the two behaviours ADR-0179 narrows the claims
-- to are pinned on every machine, including ones with no docker:
--
--   AER-028  data-scope rules are NOT supported at the Kong edge. The question
--            never carries `args`, and a deny the PDP decided without them is
--            tagged `decidedWithout = ["args"]`. The tag states only that fact:
--            the PDP's answer does not say whether the arguments were needed,
--            so neither does the tag.
--   AER-036  the session origin is DERIVED only for key-auth (`api_key`) and
--            basic-auth (`password`). Every other credential, an OIDC, SAML or
--            jwt route included, carries the operator's ASSERTION or nothing,
--            and an assertion that contradicts a derived origin is refused
--            before the PDP is asked.
--
-- RUNNER. busted (MIT), pinned in .github/workflows/integrations.yml together
-- with every transitive rock (test/regulait-authz-spec-dev-1.rockspec), on
-- LuaJIT — the Lua 5.1 dialect Kong's OpenResty runs. From integrations/kong:
--
--   busted            (reads integrations/kong/.busted)

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
-- fixtures
------------------------------------------------------------------------------
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

local function warned(...)
  local needles = { ... }
  for _, l in ipairs(state.logs) do
    if l.level == "warn" then
      local all = true
      for _, n in ipairs(needles) do
        if not l.msg:find(n, 1, true) then all = false end
      end
      if all then return true end
    end
  end
  return false
end

------------------------------------------------------------------------------
-- AER-028: no args at the edge, and a deny decided without them says exactly that
------------------------------------------------------------------------------
describe("AER-028: data-scope rules at the Kong edge", function()
  local exit, q
  before_each(function()
    exit, q = run(conf({ project_id = "p" }), {
      consumer = CONSUMER, credential = KEY_AUTH,
      pdp_answer = { decision = "deny", reason = "rule-123", contextApplied = { "projectId", "principal", "principal.asserted" } },
    })
  end)

  it("the question never carries args", function()
    assert.is_not_nil(q)
    assert.is_nil(q.args)
  end)

  it("a deny decided without args is refused 403", function()
    assert.are.equal(403, exit.status)
  end)

  it("the reason header still names the PDP's rule id", function()
    assert.are.equal("rule-123", state.headers["x-regulait-reason"])
  end)

  it("the refusal body tags args as decided without", function()
    assert.is_true(has(exit.body.decidedWithout, "args"))
  end)

  -- Finding 5 (ADR-0179 review). The tag used to be `notEvaluated`, with a note
  -- saying a data-scope rule "always denies at the Kong edge" — on EVERY deny,
  -- including a refusal that had nothing to do with arguments. The PDP's answer
  -- carries only what the decision was computed ON (`contextApplied`), never
  -- whether a rule NEEDED something absent, so the tag can be no stronger than
  -- that fact. These pin the exact wording so it cannot drift back.
  it("the old, stronger tag name is gone", function()
    assert.is_nil(exit.body.notEvaluated)
  end)

  it("the note states the fact and disclaims the cause", function()
    local note = exit.body.note
    assert.are.equal("string", type(note))
    assert.is_truthy(note:find("decided without tool arguments", 1, true))
    assert.is_truthy(note:find("never sends", 1, true))
    assert.is_truthy(note:find("does not say whether they were needed", 1, true))
    -- the data-scope consequence is conditional on the rule, never asserted of every deny
    assert.is_truthy(note:find("if the rule in x-regulait-reason is a data-scope rule", 1, true))
  end)

  it("the operator's log names the rule id and the edge limit", function()
    assert.is_true(warned("rule-123", "decided without tool arguments"))
  end)
end)

describe("AER-028 controls", function()
  it("a deny computed WITH args carries no edge tag", function()
    -- the tag is read from the PDP's answer, not assumed: a deny that WAS
    -- computed on arguments must not carry it
    local exit = run(conf(), {
      consumer = CONSUMER, credential = KEY_AUTH,
      pdp_answer = { decision = "deny", reason = "grant-missing", contextApplied = { "args", "principal" } },
    })
    assert.are.equal(403, exit.status)
    assert.is_nil(exit.body.decidedWithout)
    assert.is_nil(exit.body.note)
  end)

  it("an allow proxies, untagged", function()
    local exit = run(conf(), {
      consumer = CONSUMER, credential = KEY_AUTH,
      pdp_answer = { decision = "allow", reason = "grant-1", contextApplied = { "principal" } },
    })
    assert.is_nil(exit)
    assert.are.equal(5, #state.cleared)
  end)

  it("approval_required keeps its own decision and no edge tag", function()
    local exit = run(conf(), {
      consumer = CONSUMER, credential = KEY_AUTH,
      pdp_answer = { decision = "approval_required", reason = "appr-1", contextApplied = { "principal" } },
    })
    assert.are.equal(403, exit.status)
    assert.are.equal("approval_required", state.headers["x-regulait-decision"])
    assert.is_nil(exit.body.decidedWithout)
  end)
end)

------------------------------------------------------------------------------
-- AER-036: mixed authentication
------------------------------------------------------------------------------
describe("AER-036: mixed authentication", function()
  it("key-auth + asserted oidc is refused, before the PDP is asked", function()
    local exit = run(conf({ asserted_session_origin = "oidc" }), {
      consumer = CONSUMER, credential = KEY_AUTH, pdp_answer = { decision = "allow" },
    })
    assert.are.equal(403, exit.status)
    assert.are.equal("session_origin_contradicts_credential", state.headers["x-regulait-reason"])
    assert.are.equal(0, #pdp.calls)
  end)

  it("key-auth + asserted password is refused too", function()
    local exit = run(conf({ asserted_session_origin = "password" }), {
      consumer = CONSUMER, credential = KEY_AUTH, pdp_answer = { decision = "allow" },
    })
    assert.is_not_nil(exit)
    assert.are.equal("session_origin_contradicts_credential", state.headers["x-regulait-reason"])
    assert.are.equal(0, #pdp.calls)
  end)

  it("key-auth with no assertion derives api_key, and never sends mfaCompleted", function()
    local exit, q = run(conf(), {
      consumer = CONSUMER, credential = KEY_AUTH, pdp_answer = { decision = "allow", contextApplied = { "principal" } },
    })
    assert.is_nil(exit)
    assert.are.equal("api_key", q.principal.sessionOrigin)
    -- Kong cannot observe a second factor
    assert.is_nil(q.principal.mfaCompleted)
  end)

  it("basic-auth derives password", function()
    local exit, q = run(conf(), {
      consumer = CONSUMER, credential = BASIC_AUTH, pdp_answer = { decision = "allow", contextApplied = { "principal" } },
    })
    assert.is_nil(exit)
    assert.are.equal("password", q.principal.sessionOrigin)
  end)

  it("basic-auth + asserted saml is refused as a contradiction", function()
    local exit = run(conf({ asserted_session_origin = "saml" }), {
      consumer = CONSUMER, credential = BASIC_AUTH, pdp_answer = { decision = "allow" },
    })
    assert.is_not_nil(exit)
    assert.are.equal("session_origin_contradicts_credential", state.headers["x-regulait-reason"])
    assert.are.equal(0, #pdp.calls)
  end)

  it("basic-auth + an agreeing assertion is accepted", function()
    local exit, q = run(conf({ asserted_session_origin = "password" }), {
      consumer = CONSUMER, credential = BASIC_AUTH, pdp_answer = { decision = "allow", contextApplied = { "principal" } },
    })
    assert.is_nil(exit)
    assert.are.equal("password", q.principal.sessionOrigin)
  end)

  it("an OIDC route's asserted origin is accepted and sent as asserted", function()
    local exit, q = run(conf({ asserted_session_origin = "oidc" }), {
      consumer = CONSUMER, credential = OPAQUE, pdp_answer = { decision = "allow", contextApplied = { "principal", "principal.asserted" } },
    })
    assert.is_nil(exit)
    assert.are.equal("oidc", q.principal.sessionOrigin)
  end)

  it("a SAML route's asserted origin is accepted", function()
    local exit, q = run(conf({ asserted_session_origin = "saml" }), {
      consumer = CONSUMER, credential = OPAQUE, pdp_answer = { decision = "allow", contextApplied = { "principal" } },
    })
    assert.is_nil(exit)
    assert.are.equal("saml", q.principal.sessionOrigin)
  end)

  it("an underivable credential with no assertion sends NO principal (reads as unknown)", function()
    local exit, q = run(conf(), {
      consumer = CONSUMER, credential = OPAQUE, pdp_answer = { decision = "allow", contextApplied = {} },
    })
    assert.is_nil(exit)
    assert.is_nil(q.principal)
  end)

  -- A jwt credential carries `key` too; it is not key-auth and must not derive
  -- api_key. The consequence, documented in the README (finding 7): a jwt route
  -- accepts WHATEVER the operator asserts — oidc, saml or password — unchecked.
  for _, asserted in ipairs({ "oidc", "saml", "password" }) do
    it("a jwt credential derives nothing, so its asserted " .. asserted .. " is accepted, not refused", function()
      local exit, q = run(conf({ asserted_session_origin = asserted }), {
        consumer = CONSUMER, credential = JWT, pdp_answer = { decision = "allow", contextApplied = { "principal" } },
      })
      assert.is_nil(exit)
      assert.are.equal(asserted, q.principal.sessionOrigin)
    end)
  end

  it("a jwt credential with no assertion is never labelled api_key", function()
    local _, q = run(conf(), {
      consumer = CONSUMER, credential = JWT, pdp_answer = { decision = "allow", contextApplied = {} },
    })
    assert.is_not_nil(q)
    assert.is_nil(q.principal)
  end)

  it("api_key can never be asserted, only derived (schema)", function()
    local origin_field
    for _, f in ipairs(schema.fields) do
      if f.config then
        for _, cf in ipairs(f.config.fields) do
          if cf.asserted_session_origin then origin_field = cf.asserted_session_origin end
        end
      end
    end
    assert.is_not_nil(origin_field)
    assert.are.equal("password,oidc,saml", table.concat(origin_field.one_of, ","))
  end)
end)
