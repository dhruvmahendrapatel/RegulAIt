import { compactVerify, decodeProtectedHeader, importJWK } from "jose";
import { describe, expect, it } from "vitest";
import { BROWSER_PROOF_TYP, browserProofClaimsSchema } from "@regulait/shared/browser-governance";
import { bodyDigest, generateDeviceKey, makeProof, publicJwkOf } from "../src/proof.js";

describe("ADR-0334 device key and proofs", () => {
  it("creates a non-extractable P-256 key whose public half is a strict JWK", async () => {
    const pair = await generateDeviceKey();
    expect(pair.privateKey.extractable).toBe(false);
    await expect(crypto.subtle.exportKey("jwk", pair.privateKey)).rejects.toThrow();
    const jwk = await publicJwkOf(pair);
    expect(Object.keys(jwk).sort()).toEqual(["crv", "kty", "x", "y"]);
  });

  it("signs a proof the registered key verifies, binding path, body and a fresh id", async () => {
    const pair = await generateDeviceKey();
    const body = JSON.stringify({ profileEmail: "" });
    const a = await makeProof(pair.privateKey, "/v1/browser-extension/policy", body, 1_800_000_000);
    const b = await makeProof(pair.privateKey, "/v1/browser-extension/policy", body, 1_800_000_000);
    expect(decodeProtectedHeader(a)).toEqual({ alg: "ES256", typ: BROWSER_PROOF_TYP });
    const { payload } = await compactVerify(a, await importJWK(await publicJwkOf(pair), "ES256"));
    const claims = browserProofClaimsSchema.parse(JSON.parse(new TextDecoder().decode(payload)));
    expect(claims).toMatchObject({ htm: "POST", htu: "/v1/browser-extension/policy", iat: 1_800_000_000, bd: await bodyDigest(body) });
    const other = JSON.parse(new TextDecoder().decode((await compactVerify(b, await importJWK(await publicJwkOf(pair), "ES256"))).payload));
    expect(other.jti).not.toBe(claims.jti);
  });
});
