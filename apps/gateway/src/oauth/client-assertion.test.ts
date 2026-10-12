/**
 * ADR-0188 S7 (review of #380) — which registered key signed a `private_key_jwt` assertion. No database.
 *
 * The regression this pins: a client's Ed25519 JWK carries no `alg` member (so the provider matches it to both
 * labels of its signature), and the key check once read that member: every Ed25519 client was refused
 * `invalid_client` (the Kong harness and the engine suites). The label now comes from the assertion's header.
 */
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { calculateJwkThumbprint, SignJWT, type JWK } from "jose";
import { assertionCredentialOf, clientJwks, type WorkloadClient } from "./clients.js";

async function ed25519Client() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const { kty, crv, x } = publicKey.export({ format: "jwk" }) as { kty: string; crv: string; x: string };
  const publicJwk = { kty, crv, x };
  const jkt = await calculateJwkThumbprint(publicJwk as JWK, "sha256");
  const credentialId = randomUUID();
  const client = {
    identity: { id: randomUUID(), kind: "pdp", status: "active" },
    credentials: [{ id: credentialId, kind: "jwk", publicJwk, jwkThumbprint: jkt }],
    methods: new Set(["private_key_jwt"]),
    alias: true,
  } as unknown as WorkloadClient;
  return { client, privateKey, jkt, credentialId };
}

const sign = (alg: string, kid: string, key: Parameters<SignJWT["sign"]>[0]) =>
  new SignJWT({}).setProtectedHeader({ alg, kid }).setIssuer("c").setSubject("c").setAudience("https://g.example/oauth/token").setJti(randomUUID()).setIssuedAt().setExpirationTime("60s").sign(key);

describe("assertionCredentialOf", () => {
  it("an Ed25519 client's JWK names no alg, so either label of the signature is matched", async () => {
    const { client } = await ed25519Client();
    expect(clientJwks(client)[0]).not.toHaveProperty("alg");
  });

  for (const alg of ["EdDSA", "Ed25519"]) {
    it(`finds the key that signed an assertion labelled ${alg}`, async () => {
      const { client, privateKey, jkt, credentialId } = await ed25519Client();
      const jws = await sign(alg, jkt, privateKey);
      expect(await assertionCredentialOf(client, jws, { alg, kid: jkt }, new Date())).toBe(credentialId);
    });
  }

  it("refuses another key's signature, an unlisted label, and a label that does not fit the key", async () => {
    const { client, jkt } = await ed25519Client();
    const other = generateKeyPairSync("ed25519").privateKey;
    expect(await assertionCredentialOf(client, await sign("EdDSA", jkt, other), { alg: "EdDSA", kid: jkt }, new Date())).toBeNull();
    expect(await assertionCredentialOf(client, "x.y.z", { alg: "HS256", kid: jkt }, new Date())).toBeNull();
    const ec = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey;
    expect(await assertionCredentialOf(client, await sign("ES256", jkt, ec), { alg: "ES256", kid: jkt }, new Date())).toBeNull();
  });
});
