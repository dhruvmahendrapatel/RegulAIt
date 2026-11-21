import { calculateJwkThumbprint, decodeJwt, decodeProtectedHeader, jwtVerify, importJWK, type JWK } from "jose";
import { describe, expect, it } from "vitest";
import { clientAssertion, dpopProof, GatewayClient, type DeviceCredential } from "../src/oauth.js";
import { generateDeviceKey, publicJwkOf } from "../src/proof.js";

const ORIGIN = "https://gw.example.org";
const NOW = 1_800_000_000;

async function credential(): Promise<DeviceCredential> {
  const pair = await generateDeviceKey();
  const publicJwk = await publicJwkOf(pair);
  return { privateKey: pair.privateKey, publicJwk, clientId: `urn:ietf:params:oauth:jwk-thumbprint:sha-256:${await calculateJwkThumbprint(publicJwk as JWK, "sha256")}` };
}

describe("ADR-0334 device key", () => {
  it("is a non-extractable P-256 key whose public half is a strict JWK", async () => {
    const pair = await generateDeviceKey();
    expect(pair.privateKey.extractable).toBe(false);
    await expect(crypto.subtle.exportKey("jwk", pair.privateKey)).rejects.toThrow();
    expect(Object.keys(await publicJwkOf(pair)).sort()).toEqual(["crv", "kty", "x", "y"]);
  });
});

describe("ADR-0334 the S7 client: private_key_jwt and DPoP", () => {
  it("signs a one-minute client assertion for the token endpoint, by the device key", async () => {
    const c = await credential();
    const jwt = await clientAssertion(c, `${ORIGIN}/oauth/token`, NOW);
    const { payload, protectedHeader } = await jwtVerify(jwt, await importJWK(c.publicJwk as JWK, "ES256"), { currentDate: new Date(NOW * 1000) });
    expect(protectedHeader.alg).toBe("ES256");
    expect(protectedHeader.kid).toBe(c.clientId.split(":").pop());
    expect(payload).toMatchObject({ iss: c.clientId, sub: c.clientId, aud: `${ORIGIN}/oauth/token`, iat: NOW, exp: NOW + 60 });
  });

  it("signs DPoP proofs with the public key embedded, a fresh jti, the nonce and ath", async () => {
    const c = await credential();
    const a = await dpopProof(c, "POST", `${ORIGIN}/v1/browser-extension/policy`, NOW, { nonce: "n1", accessToken: "tok" });
    const b = await dpopProof(c, "POST", `${ORIGIN}/v1/browser-extension/policy`, NOW);
    expect(decodeProtectedHeader(a)).toMatchObject({ alg: "ES256", typ: "dpop+jwt", jwk: c.publicJwk });
    const ca = decodeJwt(a);
    expect(ca).toMatchObject({ htm: "POST", htu: `${ORIGIN}/v1/browser-extension/policy`, iat: NOW, nonce: "n1" });
    expect(ca.ath).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(decodeJwt(b).jti).not.toBe(ca.jti);
    expect(decodeJwt(b).nonce).toBeUndefined();
  });

  it("learns the gateway's nonce, re-mints a refused token once, and never retries a revoked device", async () => {
    const c = await credential();
    const calls: { url: string; dpop: string }[] = [];
    let tokens = 0;
    let resource = 0;
    const fake = async (url: string, init: RequestInit): Promise<Response> => {
      const h = init.headers as Record<string, string>;
      calls.push({ url, dpop: h.dpop! });
      const nonce = decodeJwt(h.dpop!).nonce;
      if (url.endsWith("/oauth/token")) {
        if (nonce !== "n1") return new Response(JSON.stringify({ error: "use_dpop_nonce" }), { status: 400, headers: { "dpop-nonce": "n1" } });
        tokens++;
        return new Response(JSON.stringify({ access_token: `t${tokens}` }), { status: 200 });
      }
      resource++;
      if (resource === 1) return new Response(JSON.stringify({ error: "invalid_token" }), { status: 401 });
      return new Response(JSON.stringify({ ok: h.authorization }), { status: 200 });
    };
    const client = new GatewayClient(ORIGIN, c, fake, () => NOW);
    const res = await client.post("/v1/browser-extension/policy", { profileEmail: "" });
    expect(res?.status).toBe(200);
    expect(await res!.json()).toEqual({ ok: "DPoP t2" });
    expect(tokens).toBe(2);

    let n = 0;
    const counting = new GatewayClient(ORIGIN, c, async (url) => {
      if (url.endsWith("/oauth/token")) return new Response(JSON.stringify({ access_token: "t" }), { status: 200 });
      n++;
      return new Response(JSON.stringify({ error: "device_revoked" }), { status: 401 });
    }, () => NOW);
    expect((await counting.post("/v1/browser-extension/policy", {}))?.status).toBe(401);
    expect(n).toBe(1);
  });

  it("answers null (the caller fails closed) when no token can be minted", async () => {
    const c = await credential();
    const client = new GatewayClient(ORIGIN, c, async () => new Response(JSON.stringify({ error: "invalid_client" }), { status: 401 }), () => NOW);
    expect(await client.post("/v1/browser-extension/policy", {})).toBeNull();
  });
});
