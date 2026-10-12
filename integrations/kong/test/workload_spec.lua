-- Unit spec for the regulait-authz plugin's PDP client (ADR-0188 S7, workload.lua).
--
-- WHAT THIS PINS. The plugin no longer holds a bearer `pdp_key`; it holds an
-- Ed25519 key and takes a DPoP-bound self token. This file runs workload.lua
-- with the REAL cryptography (lua-resty-openssl, the library Kong bundles,
-- pinned in test/regulait-authz-spec-dev-1.rockspec) and a scripted stand-in
-- for the gateway, and checks every byte the gateway checks:
--
--   * the key's RFC 7638 thumbprint against RFC 8037 Appendix A.3's published
--     vector, so the client id the plugin names is the one the gateway derives;
--   * the client assertion (RFC 7523): signature, iss = sub = the thumbprint
--     URI, aud = the issuer's token endpoint, kid, a short exp;
--   * each DPoP proof (RFC 9449): signature by the same key, typ, the embedded
--     public JWK, htm/htu under the ISSUER (not pdp_url), the nonce, and `ath`
--     bound to the token on the check call;
--   * the nonce retry, the token cache, a refused token dropped and re-taken
--     once, and every failure returned to the handler (which fails closed).
--
-- `verify.mjs` runs the same client against the live gateway in CI.
--
-- RUNNER: busted on LuaJIT (FFI), as in CI. lua-resty-openssl calls libcrypto
-- through the FFI and, under OpenResty, finds it already linked; under plain
-- LuaJIT it is loaded globally here first.

local ffi = require "ffi"
for _, name in ipairs({ "crypto", "libcrypto.so.3" }) do
  if pcall(ffi.load, name, true) then break end
end
local bit = require "bit"
local json = require "dkjson"
-- loaded BEFORE the `ngx` stand-in below exists: lua-resty-openssl adapts to
-- OpenResty when it sees `ngx` at load time, and plain LuaJIT is not OpenResty
local pkey = require "resty.openssl.pkey"
local digest = require "resty.openssl.digest"
require "resty.openssl.rand"

------------------------------------------------------------------------------
-- the OpenResty API workload.lua uses, in plain Lua
------------------------------------------------------------------------------
local B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
local function b64encode(s, no_padding)
  local out = {}
  for i = 1, #s, 3 do
    local a, b, c = s:byte(i, i + 2)
    local n = bit.bor(bit.lshift(a, 16), bit.lshift(b or 0, 8), c or 0)
    local chunk = {}
    for j = 3, 0, -1 do
      local idx = bit.band(bit.rshift(n, j * 6), 63) + 1
      chunk[#chunk + 1] = B64:sub(idx, idx)
    end
    if not b then chunk[3], chunk[4] = "=", "=" elseif not c then chunk[4] = "=" end
    out[#out + 1] = table.concat(chunk)
  end
  local r = table.concat(out)
  if no_padding then r = r:gsub("=", "") end
  return r
end
local function b64url_decode(s)
  s = s:gsub("-", "+"):gsub("_", "/")
  local out, n, bits = {}, 0, 0
  for ch in s:gmatch("[^=]") do
    n = bit.bor(bit.lshift(n, 6), B64:find(ch, 1, true) - 1)
    bits = bits + 6
    if bits >= 8 then
      bits = bits - 8
      out[#out + 1] = string.char(bit.band(bit.rshift(n, bits), 255))
    end
  end
  return table.concat(out)
end
local clock = 1800000000
_G.ngx = {
  time = function() return clock end,
  encode_base64 = b64encode,
  decode_base64 = function(s)
    if s:find("[^%w%+/=]") then return nil end
    return b64url_decode(s)
  end,
  escape_uri = function(s)
    return (s:gsub("[^%w%-%._~]", function(c) return string.format("%%%02X", c:byte()) end))
  end,
}
package.preload["cjson.safe"] = function()
  return {
    encode = function(t) return json.encode(t) end,
    decode = function(s) local v = json.decode(s) return v end,
  }
end

------------------------------------------------------------------------------
-- the scripted gateway: every request is recorded; each answer is taken from a queue
------------------------------------------------------------------------------
local calls, answers = {}, {}
package.preload["resty.http"] = function()
  return {
    new = function()
      return {
        set_timeout = function() end,
        request_uri = function(_, url, opts)
          calls[#calls + 1] = { url = url, opts = opts }
          local a = table.remove(answers, 1)
          if a == nil or a == "down" then return nil, "connection refused" end
          return a
        end,
      }
    end,
  }
end

-- the REAL client: busted insulates package.loaded between files but not
-- package.preload, where handler_spec.lua stubs this module and its codec
for _, m in ipairs({ "kong.plugins.regulait-authz.workload" }) do
  package.preload[m], package.loaded[m] = nil, nil
end
package.loaded["cjson.safe"], package.loaded["resty.http"] = nil, nil
local workload = require "kong.plugins.regulait-authz.workload"

------------------------------------------------------------------------------
-- fixtures
------------------------------------------------------------------------------
-- RFC 8037 Appendix A.1 / A.3: a published Ed25519 test key and its thumbprint
-- (a test vector, not a secret). The PEM armour label is assembled at run time
-- so the source carries no literal private-key header.
local RFC8037_D = "nWGxne_9WmC6hEr0kuwsxERJxWl7MmkZcDusAxyuf2A"
local RFC8037_X = "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo"
local RFC8037_JKT = "kPrK_qmxVWaYVA9wwBF6Iuo3vVzz7TxHCTwXBygrS4k"
local LABEL = "PRIVATE" .. " KEY"
local function pem_of(der, label)
  local body = b64encode(der):gsub(("."):rep(64), "%0\n"):gsub("\n$", "")
  return "-----BEGIN " .. label .. "-----\n" .. body .. "\n-----END " .. label .. "-----\n"
end
-- PKCS#8 for Ed25519: a fixed 16-byte prefix and the 32-byte seed (RFC 8410 §7)
local PKCS8_ED25519_PREFIX = string.char(0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20)
local RFC_PEM = pem_of(PKCS8_ED25519_PREFIX .. b64url_decode(RFC8037_D), LABEL)

local ISSUER = "https://regulait.example"
local PDP_URL = "http://regulait-gateway:3000"
local function conf(extra)
  local c = { pdp_url = PDP_URL, issuer = ISSUER, pdp_client_key = RFC_PEM, timeout_ms = 2000 }
  for k, v in pairs(extra or {}) do c[k] = v end
  return c
end

local VERIFIER = assert(pkey.new(RFC_PEM))
local function sha256_b64url(s)
  return b64encode(assert(assert(digest.new("sha256")):final(s)), true):gsub("%+", "-"):gsub("/", "_")
end

-- a compact JWS: its parts decoded, and whether the RFC key signed it
local function jws(compact)
  local h, p, s = compact:match("^([%w_-]+)%.([%w_-]+)%.([%w_-]+)$")
  assert(h, "not a compact JWS: " .. tostring(compact))
  return {
    header = json.decode(b64url_decode(h)),
    claims = json.decode(b64url_decode(p)),
    signed = VERIFIER:verify(b64url_decode(s), h .. "." .. p) == true,
  }
end

local function form(body)
  local t = {}
  for k, v in body:gmatch("([^&=]+)=([^&]*)") do
    t[k] = v:gsub("%%(%x%x)", function(x) return string.char(tonumber(x, 16)) end)
  end
  return t
end

local NONCE = "slot-1.nonce"
local function token_ok(token, ttl)
  return { status = 200, headers = {}, body = json.encode({ access_token = token, token_type = "DPoP", expires_in = ttl or 300 }) }
end
local function need_nonce(status, nonce)
  return {
    status = status, headers = { ["DPoP-Nonce"] = nonce or NONCE },
    body = json.encode({ error = "use_dpop_nonce" }),
  }
end
local function allow() return { status = 200, headers = {}, body = '{"decision":"allow"}' } end

before_each(function()
  workload._reset()
  calls, answers = {}, {}
end)

------------------------------------------------------------------------------
describe("ADR-0188 S7: the PDP client's key", function()
  it("names itself by the RFC 7638 thumbprint the gateway derives (RFC 8037 A.3 vector)", function()
    local k = assert(workload.load_key(RFC_PEM))
    assert.are.equal(RFC8037_X, k.jwk.x)
    assert.are.equal(RFC8037_JKT, k.jkt)
    assert.are.equal("urn:ietf:params:oauth:jwk-thumbprint:sha-256:" .. RFC8037_JKT, k.client_id)
  end)

  it("takes the same key as one line of base64url PKCS#8 DER (an env vault holds one line)", function()
    local one_line = (b64encode(PKCS8_ED25519_PREFIX .. b64url_decode(RFC8037_D), true):gsub("%+", "-"):gsub("/", "_"))
    local k = assert(workload.load_key(one_line))
    assert.are.equal(RFC8037_JKT, k.jkt)
  end)

  it("refuses a public key, a key of another type, and garbage", function()
    local pub = VERIFIER:tostring("public", "PEM")
    local ec = assert(pkey.new({ type = "EC", curve = "prime256v1" })):tostring("private", "PEM")
    for _, bad in ipairs({ pub, ec, "not a key", "" }) do
      local k, err = workload.load_key(bad)
      assert.is_nil(k)
      assert.are.equal("string", type(err))
    end
  end)

  it("an unusable key fails the check before anything is sent", function()
    local res, reason = workload.check(conf({ pdp_client_key = "not a key" }), "{}")
    assert.is_nil(res)
    assert.are.equal("pdp_client_key_invalid", reason)
    assert.are.equal(0, #calls)
  end)
end)

describe("ADR-0188 S7: the self token and the check", function()
  local res
  before_each(function()
    answers = { need_nonce(400), token_ok("tok-1"), allow() }
    res = workload.check(conf(), '{"userId":"u"}')
  end)

  it("asks the token endpoint, retries once with the nonce, then asks the check route", function()
    assert.are.equal(200, res.status)
    assert.are.equal(3, #calls)
    assert.are.equal(PDP_URL .. "/oauth/token", calls[1].url)
    assert.are.equal(PDP_URL .. "/oauth/token", calls[2].url)
    assert.are.equal(PDP_URL .. "/v1/authz/check", calls[3].url)
  end)

  it("the token request is client_credentials for the check route, by private_key_jwt", function()
    local f = form(calls[2].opts.body)
    assert.are.equal("client_credentials", f.grant_type)
    assert.are.equal(ISSUER .. "/v1/authz/check", f.resource)
    assert.are.equal("urn:ietf:params:oauth:client-assertion-type:jwt-bearer", f.client_assertion_type)
    assert.is_nil(f.client_secret)
    local a = jws(f.client_assertion)
    assert.is_true(a.signed)
    assert.are.equal("EdDSA", a.header.alg)
    assert.are.equal(RFC8037_JKT, a.header.kid)
    local id = "urn:ietf:params:oauth:jwk-thumbprint:sha-256:" .. RFC8037_JKT
    assert.are.equal(id, a.claims.iss)
    assert.are.equal(id, a.claims.sub)
    assert.are.equal(ISSUER .. "/oauth/token", a.claims.aud)
    assert.is_true(a.claims.exp > a.claims.iat and a.claims.exp - a.claims.iat <= 60)
    assert.are.equal("string", type(a.claims.jti))
  end)

  it("each token request carries a DPoP proof under the ISSUER, the second with the nonce", function()
    local first = jws(calls[1].opts.headers.dpop)
    local second = jws(calls[2].opts.headers.dpop)
    for _, p in ipairs({ first, second }) do
      assert.is_true(p.signed)
      assert.are.equal("dpop+jwt", p.header.typ)
      assert.are.same({ kty = "OKP", crv = "Ed25519", x = RFC8037_X }, p.header.jwk)
      assert.are.equal("POST", p.claims.htm)
      assert.are.equal(ISSUER .. "/oauth/token", p.claims.htu)
      assert.is_nil(p.claims.ath)
    end
    assert.is_nil(first.claims.nonce)
    assert.are.equal(NONCE, second.claims.nonce)
    assert.are_not.equal(first.claims.jti, second.claims.jti)
  end)

  it("the check carries the token as DPoP and a proof bound to it", function()
    local h = calls[3].opts.headers
    assert.are.equal("DPoP tok-1", h.authorization)
    assert.is_nil(h.authorization:find("Bearer", 1, true))
    local p = jws(h.dpop)
    assert.is_true(p.signed)
    assert.are.equal("POST", p.claims.htm)
    assert.are.equal(ISSUER .. "/v1/authz/check", p.claims.htu)
    assert.are.equal(NONCE, p.claims.nonce)
    assert.are.equal(sha256_b64url("tok-1"), p.claims.ath)
    assert.are.equal('{"userId":"u"}', calls[3].opts.body)
  end)

  it("the token is cached: the next check makes one request, with a fresh proof", function()
    answers = { allow() }
    local again = workload.check(conf(), "{}")
    assert.are.equal(200, again.status)
    assert.are.equal(4, #calls)
    assert.are.equal("DPoP tok-1", calls[4].opts.headers.authorization)
    assert.are_not.equal(jws(calls[3].opts.headers.dpop).claims.jti, jws(calls[4].opts.headers.dpop).claims.jti)
  end)

  it("a token about to expire is not used", function()
    clock = clock + 300 - 10
    answers = { token_ok("tok-2"), allow() }
    local again = workload.check(conf(), "{}")
    clock = 1800000000
    assert.are.equal(200, again.status)
    assert.are.equal("DPoP tok-2", calls[5].opts.headers.authorization)
  end)
end)

describe("ADR-0188 S7: refusals and retries", function()
  it("a check refused for its nonce is retried once with the new one", function()
    answers = { token_ok("tok-1"), need_nonce(401, "slot-2.n"), allow() }
    local res = workload.check(conf(), "{}")
    assert.are.equal(200, res.status)
    assert.are.equal("slot-2.n", jws(calls[3].opts.headers.dpop).claims.nonce)
  end)

  it("a refused token is dropped and taken again once; a second refusal reaches the handler", function()
    local refused = { status = 401, headers = {}, body = '{"error":"invalid_token"}' }
    answers = { token_ok("tok-1"), refused, token_ok("tok-2"), refused }
    local res = workload.check(conf(), "{}")
    assert.are.equal(401, res.status)
    assert.are.equal(4, #calls)
    assert.are.equal("DPoP tok-2", calls[4].opts.headers.authorization)
  end)

  it("a token endpoint refusal is a named failure, never a request without a token", function()
    answers = { { status = 401, headers = {}, body = '{"error":"invalid_client"}' } }
    local res, reason = workload.check(conf(), "{}")
    assert.is_nil(res)
    assert.are.equal("pdp_token_refused", reason)
    assert.are.equal(1, #calls)
  end)

  it("a nonce refused twice stops", function()
    answers = { need_nonce(400), need_nonce(400, "slot-3.n") }
    local res, reason = workload.check(conf(), "{}")
    assert.is_nil(res)
    assert.are.equal("pdp_token_refused", reason)
    assert.are.equal(2, #calls)
  end)

  it("an unparseable token answer is a named failure", function()
    answers = { { status = 200, headers = {}, body = "this is not json {{{" } }
    local res, reason = workload.check(conf(), "{}")
    assert.is_nil(res)
    assert.are.equal("pdp_token_unparseable", reason)
  end)

  it("an unreachable gateway is pdp_unreachable", function()
    answers = { "down" }
    local res, reason = workload.check(conf(), "{}")
    assert.is_nil(res)
    assert.are.equal("pdp_unreachable", reason)
  end)
end)
