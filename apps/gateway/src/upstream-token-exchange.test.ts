/**
 * ADR-0238 — the token-exchange answer check and the per-call holder, without a database:
 *
 *  - a good answer (opaque or JWT) is accepted and its expiry is the earlier of `expires_in` and the JWT's `exp`;
 *  - every negative: a wrong audience, a scope widened by the answer's `scope` or by the JWT's `scope`/`scp`, an expired
 *    JWT, an `expires_in` past the ceiling or missing, a non-Bearer or non-access token, a header-unsafe token, an error
 *    status, a non-JSON body;
 *  - the holder attaches nothing until armed, then only to the registered origin, replaces any Authorization, and
 *    refuses (as our own refusal) a request after the token's expiry or bound elsewhere;
 *  - the admin schema refuses http endpoints, bad scope tokens and unknown keys.
 */
import { describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { SignJWT } from "jose";
import { setUpstreamTokenExchangeSchema, UPSTREAM_EXCHANGE_TTL_CEILING_SECONDS } from "@regulait/shared";
import { classifyUpstreamError } from "./upstream-retry.js";
import { checkExchangeResponse, tokenFingerprint, UpstreamExchangeHolder, UpstreamExchangeRefusedError } from "./upstream-token-exchange.js";

const NOW = 1_800_000_000;
const AUD = "https://api.upstream.example";
const RESOURCE = "https://api.upstream.example/mcp";
const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });

const base = { status: 200, requestedScopes: ["tickets.read"], audience: AUD, resource: RESOURCE, maxTtlSeconds: 300, nowS: NOW };
const answer = (o: Record<string, unknown>) => JSON.stringify({ access_token: "opaque-token-value-0123456789", token_type: "Bearer", issued_token_type: "urn:ietf:params:oauth:token-type:access_token", expires_in: 120, ...o });
const jwt = (claims: Record<string, unknown>) => new SignJWT(claims).setProtectedHeader({ alg: "ES256", typ: "at+jwt" }).sign(privateKey);

describe("ADR-0238 — the answer is held to the request", () => {
  it("accepts an opaque Bearer access token within the ceiling; no scope in the answer means exactly the request", () => {
    const r = checkExchangeResponse({ ...base, body: answer({}) });
    expect(r).toEqual({ ok: true, token: "opaque-token-value-0123456789", expiresAt: NOW + 120, grantedScope: "tickets.read", jwt: false, refreshTokenDiscarded: false });
  });

  it("accepts a narrower scope, and never keeps a refresh token", () => {
    const r = checkExchangeResponse({ ...base, requestedScopes: ["a", "b"], body: answer({ scope: "a", refresh_token: "rt" }) });
    expect(r).toMatchObject({ ok: true, grantedScope: "a", refreshTokenDiscarded: true });
  });

  it("accepts a JWT whose aud, exp and scope stay inside the request, and takes the earlier expiry", async () => {
    const token = await jwt({ aud: [AUD, RESOURCE], exp: NOW + 60, scope: "tickets.read" });
    const r = checkExchangeResponse({ ...base, body: answer({ access_token: token, expires_in: 120 }) });
    expect(r).toMatchObject({ ok: true, jwt: true, expiresAt: NOW + 60 });
  });

  it.each([
    ["a scope widened by the answer", () => answer({ scope: "tickets.read tickets.write" }), "scope_widened"],
    ["a different scope altogether", () => answer({ scope: "admin" }), "scope_widened"],
    ["expires_in past the ceiling", () => answer({ expires_in: 301 }), "expiry_too_long"],
    ["no expires_in", () => JSON.stringify({ access_token: "abc", token_type: "Bearer" }), "expiry_missing"],
    ["a negative expires_in", () => answer({ expires_in: -5 }), "malformed_response"],
    ["a DPoP token", () => answer({ token_type: "DPoP" }), "token_type_unsupported"],
    ["a refresh token issued as the token", () => answer({ issued_token_type: "urn:ietf:params:oauth:token-type:refresh_token" }), "token_type_unsupported"],
    ["a token that would inject a header", () => answer({ access_token: "abc\r\nX-Evil: 1" }), "malformed_response"],
    ["a token past the size bound", () => answer({ access_token: "a".repeat(9000) }), "token_too_large"],
    ["no access token", () => JSON.stringify({ token_type: "Bearer", expires_in: 60 }), "malformed_response"],
    ["a body that is not JSON", () => "<html>", "malformed_response"],
  ])("refuses %s", (_name, body, code) => {
    const r = checkExchangeResponse({ ...base, body: body() });
    expect(r).toMatchObject({ ok: false, code });
  });

  it("refuses an error status without reading the body as a token", () => {
    expect(checkExchangeResponse({ ...base, status: 400, body: answer({}) })).toMatchObject({ ok: false, code: "endpoint_error" });
  });

  it("the ceiling is never above 900 s, whatever the configuration says", () => {
    const r = checkExchangeResponse({ ...base, maxTtlSeconds: 5000, body: answer({ expires_in: UPSTREAM_EXCHANGE_TTL_CEILING_SECONDS + 1 }) });
    expect(r).toMatchObject({ ok: false, code: "expiry_too_long" });
  });

  it("WRONG AUDIENCE: a JWT audienced to another upstream (or to it and another) is refused", async () => {
    for (const aud of ["https://other.example", [AUD, "https://other.example"], undefined]) {
      const token = await jwt({ ...(aud === undefined ? {} : { aud }), exp: NOW + 60 });
      expect(checkExchangeResponse({ ...base, body: answer({ access_token: token }) })).toMatchObject({ ok: false, code: "audience_mismatch" });
    }
  });

  it("SCOPE WIDENING inside the JWT (`scope` or `scp`) is refused even when the answer's scope looks right", async () => {
    for (const claims of [{ scope: "tickets.read tickets.delete" }, { scp: ["tickets.read", "admin"] }, { scp: "admin" }]) {
      const token = await jwt({ aud: AUD, exp: NOW + 60, ...claims });
      expect(checkExchangeResponse({ ...base, body: answer({ access_token: token, scope: "tickets.read" }) })).toMatchObject({ ok: false, code: "scope_widened" });
    }
  });

  it("EXPIRED: a JWT whose exp has passed is refused; one with no exp, or past the ceiling, too", async () => {
    const expired = await jwt({ aud: AUD, exp: NOW - 120 });
    expect(checkExchangeResponse({ ...base, body: answer({ access_token: expired }) })).toMatchObject({ ok: false, code: "expired" });
    const noExp = await jwt({ aud: AUD });
    expect(checkExchangeResponse({ ...base, body: answer({ access_token: noExp }) })).toMatchObject({ ok: false, code: "expiry_missing" });
    const tooLong = await jwt({ aud: AUD, exp: NOW + 3600 });
    expect(checkExchangeResponse({ ...base, body: answer({ access_token: tooLong }) })).toMatchObject({ ok: false, code: "expiry_too_long" });
  });

  it("the fingerprint is 16 hex characters and is not the token", () => {
    const f = tokenFingerprint("opaque-token-value-0123456789");
    expect(f).toMatch(/^[0-9a-f]{16}$/);
    expect("opaque-token-value-0123456789").not.toContain(f);
  });
});

describe("ADR-0238 — the per-call holder", () => {
  const SERVER = "https://mcp.upstream.example/mcp";

  it("unarmed, it changes nothing (a manifest sync before the decision carries no token)", () => {
    const h = new UpstreamExchangeHolder(SERVER);
    const init = { method: "POST", headers: { authorization: "Bearer static" } };
    expect(h.prepare(SERVER, init)).toBe(init);
  });

  it("armed, it replaces any Authorization with the exchanged token on the registered origin", () => {
    const h = new UpstreamExchangeHolder(SERVER);
    h.arm("exchanged-token", NOW + 60);
    const out = h.prepare(`${SERVER}?x=1`, { method: "POST", headers: { authorization: "Bearer static", "x-other": "1" } }, (NOW + 1) * 1000);
    const headers = new Headers(out.headers);
    expect(headers.get("authorization")).toBe("Bearer exchanged-token");
    expect(headers.get("x-other")).toBe("1");
  });

  it("refuses a request bound for another origin, as our own (never retried) refusal", () => {
    const h = new UpstreamExchangeHolder(SERVER);
    h.arm("exchanged-token", NOW + 60);
    let err: unknown;
    try {
      h.prepare("https://elsewhere.example/mcp", { method: "POST" }, NOW * 1000);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(UpstreamExchangeRefusedError);
    expect((err as UpstreamExchangeRefusedError).code).toBe("destination_mismatch");
    expect(classifyUpstreamError(err).why).toBe("our_own_refusal");
  });

  it("EXPIRED in flight: a request after the token's expiry is refused and the holder disarms", () => {
    const h = new UpstreamExchangeHolder(SERVER);
    h.arm("exchanged-token", NOW + 60);
    expect(() => h.prepare(SERVER, { method: "POST" }, (NOW + 61) * 1000)).toThrow(UpstreamExchangeRefusedError);
    expect(h.isArmed).toBe(false);
  });
});

describe("ADR-0238 — the admin schema", () => {
  const ok = {
    enabled: true,
    tokenEndpoint: "https://as.example/oauth2/token",
    subjectTokenAudience: "https://as.example",
    audience: AUD,
    clientId: "regulait-gateway",
    clientSecret: "placeholder-secret-0123456789",
    scopes: { search_tickets: ["tickets.read"] },
  };
  it("accepts a well-formed configuration", () => {
    expect(setUpstreamTokenExchangeSchema.safeParse(ok).success).toBe(true);
  });
  it.each([
    ["an http token endpoint", { tokenEndpoint: "http://as.example/token" }],
    ["credentials in the endpoint", { tokenEndpoint: "https://u:p@as.example/token" }],
    ["a scope token with a space", { scopes: { t: ["a b"] } }],
    ["a scope token with a quote", { scopes: { t: ['a"'] } }],
    ["an empty scope list", { scopes: { t: [] } }],
    ["a TTL past the ceiling", { maxTokenTtlSeconds: 901 }],
    ["an unknown key", { grantType: "jwt-bearer" }],
    ["a short client secret", { clientSecret: "short" }],
  ])("refuses %s", (_n, patch) => {
    expect(setUpstreamTokenExchangeSchema.safeParse({ ...ok, ...patch }).success).toBe(false);
  });
});
