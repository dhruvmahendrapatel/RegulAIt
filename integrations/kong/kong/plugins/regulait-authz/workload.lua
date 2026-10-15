-- ADR-0188 S7 — THE PDP CLIENT'S OWN KEY, AND THE SELF TOKEN IT TAKES.
--
-- Before S7 this plugin held a `pdp` virtual key: a bearer value that asked
-- `POST /v1/authz/check` for anyone, which anybody who copied it could replay
-- from anywhere. S7 retired it (migration 0195 revokes every one). The plugin
-- is now a `pdp` WORKLOAD IDENTITY: it holds an Ed25519 private key whose
-- public half an admin bound to that identity, and it authenticates the way
-- every RegulAIt workload does:
--
--   1. `POST /oauth/token` with the client_credentials grant (RFC 6749 §4.4),
--      client authentication by `private_key_jwt` (RFC 7523) signed by its key,
--      `resource` = the check route (RFC 8707), and a DPoP proof (RFC 9449).
--      Its client id is its key's RFC 9278 thumbprint URI, so the only
--      configuration is the key and the issuer.
--   2. `POST /v1/authz/check` with `Authorization: DPoP <token>` and a fresh
--      proof bound to that token (`ath`). The token is audience-scoped to the
--      check route, so it reaches nothing else, and it is useless without the
--      key: a copied token cannot make a proof.
--
-- The gateway requires its DPoP nonce (RFC 9449 §8/§9): a `use_dpop_nonce`
-- answer carries a fresh `DPoP-Nonce`, which is kept per worker and the request
-- is retried once. A refused token (revoked, expired) is dropped and the token
-- request retried once. Every other failure is returned to the handler, which
-- FAILS CLOSED.
--
-- OPEN SOURCE FIRST (ADR-0176). The cryptography is `resty.openssl`
-- (lua-resty-openssl, BSD-2-Clause), which Kong bundles; base64url and URI
-- escaping are OpenResty's own `ngx` API, JSON is Kong's bundled cjson, and
-- the transport is `resty.http`, already used here. No Lua library on the
-- ecosystem's shelf does RFC 7523 + RFC 9449 client side with EdDSA, so the
-- two JWS this module assembles (a compact header.payload.signature over
-- those primitives) are the narrow piece written here. No cryptography is.
local http = require "resty.http"
local cjson = require "cjson.safe"
local pkey = require "resty.openssl.pkey"
local digest = require "resty.openssl.digest"
local rand = require "resty.openssl.rand"

local M = {}

M.TOKEN_PATH = "/oauth/token"
M.CHECK_PATH = "/v1/authz/check"
M.THUMBPRINT_URI_PREFIX = "urn:ietf:params:oauth:jwk-thumbprint:sha-256:"
local ASSERTION_TYPE = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer"
-- a cached token is not used in its last 30 seconds (the gateway's clock and ours)
local REFRESH_MARGIN_SECONDS = 30
local ASSERTION_LIFETIME_SECONDS = 60

-- per worker: parsed keys (by the configured PEM), tokens (by key + issuer), nonces (by issuer)
local keys, tokens, nonces = {}, {}, {}

local function b64url(s)
  return (ngx.encode_base64(s, true):gsub("%+", "-"):gsub("/", "_"))
end

local function sha256(s)
  local d = assert(digest.new("sha256"))
  return assert(d:final(s))
end

local function jti()
  return b64url(assert(rand.bytes(18)))
end

-- RFC 7638: the required members of an Ed25519 JWK, lexicographic, no whitespace
local function jwk_thumbprint(x)
  return b64url(sha256('{"crv":"Ed25519","kty":"OKP","x":"' .. x .. '"}'))
end
M.jwk_thumbprint = jwk_thumbprint

-- The configured key: an Ed25519 private key in PEM. Anything else is a
-- configuration error the handler reports, never a key it guesses at.
local function load_key(pem)
  local cached = keys[pem]
  if cached then return cached end
  if type(pem) ~= "string" or pem == "" then return nil, "pdp_client_key is not set" end
  -- PEM, or the same PKCS#8 DER as ONE line of base64/base64url: an env-file or
  -- env vault holds one line, and a PEM is several
  local material = pem
  if not pem:find("-----BEGIN", 1, true) then
    local std = pem:gsub("%s", ""):gsub("%-", "+"):gsub("_", "/")
    std = std .. string.rep("=", (4 - #std % 4) % 4)
    material = ngx.decode_base64(std)
    if not material then return nil, "pdp_client_key is neither PEM nor base64 of a PKCS#8 key" end
  end
  local key, err = pkey.new(material)
  if not key then return nil, "pdp_client_key is not a readable private key: " .. tostring(err) end
  if not key:is_private() then return nil, "pdp_client_key is a public key; the plugin needs the private half" end
  local kind = key:get_key_type()
  if not kind or kind.sn ~= "ED25519" then return nil, "pdp_client_key must be an Ed25519 key" end
  local der = assert(key:tostring("public", "DER"))
  -- an Ed25519 SubjectPublicKeyInfo is a fixed 12-byte prefix and the 32-byte key
  local x = b64url(der:sub(-32))
  local jkt = jwk_thumbprint(x)
  cached = { key = key, jwk = { kty = "OKP", crv = "Ed25519", x = x }, jkt = jkt, client_id = M.THUMBPRINT_URI_PREFIX .. jkt }
  keys[pem] = cached
  return cached
end
M.load_key = load_key

local function sign(k, header, payload)
  local input = b64url(cjson.encode(header)) .. "." .. b64url(cjson.encode(payload))
  local sig = assert(k.key:sign(input))
  return input .. "." .. b64url(sig)
end

-- RFC 9449 §4.2: a proof for one request, bound to the token when there is one
local function proof(k, method, url, nonce, token)
  local claims = { htm = method, htu = url, iat = ngx.time(), jti = jti() }
  if nonce then claims.nonce = nonce end
  if token then claims.ath = b64url(sha256(token)) end
  return sign(k, { alg = "EdDSA", typ = "dpop+jwt", jwk = k.jwk }, claims)
end
M.proof = proof

-- RFC 7523 §3: the client assertion, naming the key by its thumbprint URI
local function assertion(k, token_url)
  local now = ngx.time()
  return sign(k, { alg = "EdDSA", kid = k.jkt }, {
    iss = k.client_id, sub = k.client_id, aud = token_url,
    jti = jti(), iat = now, exp = now + ASSERTION_LIFETIME_SECONDS,
  })
end
M.assertion = assertion

local function header(res, name)
  local h = res.headers or {}
  return h[name] or h[name:lower()]
end

local function form(t)
  local parts = {}
  for _, kv in ipairs(t) do
    parts[#parts + 1] = kv[1] .. "=" .. ngx.escape_uri(kv[2])
  end
  return table.concat(parts, "&")
end

local function new_client(conf)
  local client = http.new()
  client:set_timeout(conf.timeout_ms)
  return client
end

-- the gateway's answer named a fresh nonce: keep it, and say whether to retry
local function took_nonce(conf, res)
  local n = header(res, "DPoP-Nonce")
  if type(n) == "string" and n ~= "" then
    nonces[conf.issuer] = n
    return true
  end
  return false
end

-- A self token for the check route, from the cache or from the token endpoint.
-- Returns the token, or nil plus a short reason (the handler's refusal names it).
local function self_token(conf, k)
  local cache_key = k.jkt .. " " .. conf.issuer
  local cached = tokens[cache_key]
  if cached and cached.exp - ngx.time() > REFRESH_MARGIN_SECONDS then return cached.token end
  tokens[cache_key] = nil
  local token_url = conf.issuer .. M.TOKEN_PATH
  for _ = 1, 2 do
    local res, err = new_client(conf):request_uri(conf.pdp_url .. M.TOKEN_PATH, {
      method = "POST",
      headers = {
        ["content-type"] = "application/x-www-form-urlencoded",
        ["dpop"] = proof(k, "POST", token_url, nonces[conf.issuer]),
      },
      body = form({
        { "grant_type", "client_credentials" },
        { "resource", conf.issuer .. M.CHECK_PATH },
        { "client_assertion_type", ASSERTION_TYPE },
        { "client_assertion", assertion(k, token_url) },
      }),
    })
    if not res then return nil, "pdp_unreachable", err end
    local body = cjson.decode(res.body or "")
    if res.status == 200 then
      if type(body) ~= "table" or type(body.access_token) ~= "string" or type(body.expires_in) ~= "number" then
        return nil, "pdp_token_unparseable"
      end
      tokens[cache_key] = { token = body.access_token, exp = ngx.time() + body.expires_in }
      return body.access_token
    end
    -- RFC 9449 §8: retry once with the nonce the refusal carried
    if not (res.status == 400 and type(body) == "table" and body.error == "use_dpop_nonce" and took_nonce(conf, res)) then
      return nil, "pdp_token_refused", res.status .. " " .. tostring(type(body) == "table" and body.error or "")
    end
  end
  return nil, "pdp_token_refused", "the nonce was refused twice"
end

-- POST `body` (a JSON string) to the check route with this plugin's own
-- credential. Returns the response as `resty.http` does, or nil, a short
-- reason and a detail for the log.
function M.check(conf, body)
  local k, kerr = load_key(conf.pdp_client_key)
  if not k then return nil, "pdp_client_key_invalid", kerr end
  local check_url = conf.issuer .. M.CHECK_PATH
  local retried_token = false
  for _ = 1, 3 do
    local token, reason, detail = self_token(conf, k)
    if not token then return nil, reason, detail end
    local res, err = new_client(conf):request_uri(conf.pdp_url .. M.CHECK_PATH, {
      method = "POST",
      headers = {
        ["content-type"] = "application/json",
        ["authorization"] = "DPoP " .. token,
        ["dpop"] = proof(k, "POST", check_url, nonces[conf.issuer], token),
      },
      body = body,
    })
    if not res then return nil, "pdp_unreachable", err end
    if res.status ~= 401 then return res end
    -- 401: a nonce to retry with, or a token the gateway no longer accepts
    if not took_nonce(conf, res) then
      if retried_token then return res end
      retried_token = true
      tokens[k.jkt .. " " .. conf.issuer] = nil
    end
  end
  return nil, "pdp_token_refused", "the check route refused the plugin's credential"
end

-- tests only: forget every cached key, token and nonce
function M._reset()
  keys, tokens, nonces = {}, {}, {}
end

return M
