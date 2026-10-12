/**
 * ADR-0188 S6 — credential registration, without a database: what
 * `prepareCredential` keeps of a public credential, and every refusal it
 * makes before anything could be stored. The routes, their step-up, audit and
 * revocation cascades are proved through the real app in
 * `zz-adr0188-s6-identity-admin.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { makeCert } from "../testing/x509-fixtures.js";
import { certificateThumbprint, SPIFFE_TRUST_BUNDLES_ENV } from "./x509.js";
import { IdentityAdminError, identityCreateStepUp, credentialAddStepUp, prepareCredential, type PreparedCredential } from "./identity-admin.js";

const NOW = new Date();
const NO_ENV: NodeJS.ProcessEnv = {};

async function ok(p: Promise<PreparedCredential | IdentityAdminError>): Promise<PreparedCredential> {
  const out = await p;
  if (out instanceof IdentityAdminError) throw new Error(`refused ${out.code}: ${out.message}`);
  return out;
}
async function refused(p: Promise<PreparedCredential | IdentityAdminError>): Promise<string> {
  const out = await p;
  if (!(out instanceof IdentityAdminError)) throw new Error("accepted, expected a refusal");
  return out.code;
}

describe("a JWK credential", () => {
  it("keeps only the RFC 7638 members, with the RFC 7638 thumbprint (RFC 8037 A.3 vector)", async () => {
    const x = "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo";
    const out = await ok(prepareCredential({ kind: "jwk", publicJwk: { kty: "OKP", crv: "Ed25519", x, kid: "caller-kid", use: "sig" } as never }, NOW, NO_ENV));
    expect(out.publicJwk).toEqual({ kty: "OKP", crv: "Ed25519", x });
    expect(out.jwkThumbprint).toBe("kPrK_qmxVWaYVA9wwBF6Iuo3vVzz7TxHCTwXBygrS4k");
    expect(out).toMatchObject({ kind: "jwk", x5tS256: null, spiffeId: null, selfSigned: false, certificateNotAfter: null });
  });

  it("accepts a real P-256 public key", async () => {
    const jwk = generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey.export({ format: "jwk" }) as Record<string, string>;
    const out = await ok(prepareCredential({ kind: "jwk", publicJwk: { kty: "EC", crv: "P-256", x: jwk.x!, y: jwk.y! } }, NOW, NO_ENV));
    expect(out.publicJwk).toEqual({ kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y });
    expect(out.jwkThumbprint).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("refuses a P-256 point that is not on the curve (jose builds the key; nothing invalid is stored)", async () => {
    const jwk = generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey.export({ format: "jwk" }) as Record<string, string>;
    const y = jwk.y!.slice(0, 42) + (jwk.y!.endsWith("A") ? "B" : "A");
    expect(await refused(prepareCredential({ kind: "jwk", publicJwk: { kty: "EC", crv: "P-256", x: jwk.x!, y } }, NOW, NO_ENV))).toBe("credential_invalid");
  });
});

describe("a certificate credential", () => {
  it("keeps the thumbprint, the one URI SAN and the subject; never outlives the certificate", async () => {
    const ca = await makeCert({ isCA: true, name: "s6-ca" });
    const leaf = await makeCert({ issuer: ca, name: "s6-leaf", uris: ["spiffe://example.org/worker/one"] });
    const out = await ok(prepareCredential({ kind: "x509", certificatePem: leaf.pem, selfSigned: false }, NOW, NO_ENV));
    expect(out.x5tS256).toBe(certificateThumbprint(leaf.der));
    expect(out.sanUri).toBe("spiffe://example.org/worker/one");
    expect(out.subjectDn).toContain("s6-leaf");
    expect(out.certificateNotAfter!.getTime()).toBe(leaf.cert.notAfter.value.getTime() - (leaf.cert.notAfter.value.getTime() % 1000));
    expect(out).toMatchObject({ kind: "x509", publicJwk: null, jwkThumbprint: null, selfSigned: false });
  });

  it("accepts a self-signed certificate only when it really is signed by its own key", async () => {
    const self = await makeCert({ name: "s6-self" });
    expect((await ok(prepareCredential({ kind: "x509", certificatePem: self.pem, selfSigned: true }, NOW, NO_ENV))).selfSigned).toBe(true);
    const ca = await makeCert({ isCA: true });
    const issued = await makeCert({ issuer: ca });
    expect(await refused(prepareCredential({ kind: "x509", certificatePem: issued.pem, selfSigned: true }, NOW, NO_ENV))).toBe("certificate_not_self_signed");
  });

  it("refuses a PEM carrying a private key, before parsing anything", async () => {
    const self = await makeCert();
    const priv = generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    expect(await refused(prepareCredential({ kind: "x509", certificatePem: self.pem + priv, selfSigned: true }, NOW, NO_ENV))).toBe("credential_private_material");
    const ecPriv = "-----BEGIN EC PRIVATE KEY-----\nAAAA\n-----END EC PRIVATE KEY-----\n";
    expect(await refused(prepareCredential({ kind: "x509", certificatePem: ecPriv + self.pem, selfSigned: true }, NOW, NO_ENV))).toBe("credential_private_material");
  });

  it("refuses two certificates, garbage, a CA as a client certificate, and one outside its validity", async () => {
    const a = await makeCert();
    const b = await makeCert();
    expect(await refused(prepareCredential({ kind: "x509", certificatePem: a.pem + b.pem, selfSigned: true }, NOW, NO_ENV))).toBe("credential_invalid");
    expect(await refused(prepareCredential({ kind: "x509", certificatePem: "-----BEGIN CERTIFICATE-----\nnope\n-----END CERTIFICATE-----\n", selfSigned: false }, NOW, NO_ENV))).toBe("credential_invalid");
    const ca = await makeCert({ isCA: true });
    expect(await refused(prepareCredential({ kind: "x509", certificatePem: ca.pem, selfSigned: false }, NOW, NO_ENV))).toBe("certificate_leaf_ca");
    const old = await makeCert({ notBefore: new Date(Date.now() - 3 * 86_400_000), notAfter: new Date(Date.now() - 86_400_000) });
    expect(await refused(prepareCredential({ kind: "x509", certificatePem: old.pem, selfSigned: true }, NOW, NO_ENV))).toBe("certificate_time");
    const future = await makeCert({ notBefore: new Date(Date.now() + 86_400_000), notAfter: new Date(Date.now() + 2 * 86_400_000) });
    expect(await refused(prepareCredential({ kind: "x509", certificatePem: future.pem, selfSigned: true }, NOW, NO_ENV))).toBe("certificate_time");
  });
});

describe("a SPIFFE ID credential", () => {
  it("needs a configured trust bundle for its trust domain (SPIFFE is off by default)", async () => {
    const body = { kind: "spiffe_id" as const, spiffeId: "spiffe://example.org/worker/one" };
    expect(await refused(prepareCredential(body, NOW, NO_ENV))).toBe("spiffe_trust_domain_unknown");
    const ca = await makeCert({ isCA: true });
    const env = { [SPIFFE_TRUST_BUNDLES_ENV]: JSON.stringify({ "example.org": ca.pem }) };
    expect((await ok(prepareCredential(body, NOW, env))).spiffeId).toBe(body.spiffeId);
    expect(await refused(prepareCredential({ ...body, spiffeId: "spiffe://other.org/worker/one" }, NOW, env))).toBe("spiffe_trust_domain_unknown");
    expect(await refused(prepareCredential(body, NOW, { [SPIFFE_TRUST_BUNDLES_ENV]: "{not json" }))).toBe("trust_config_invalid");
  });
});

describe("step-up facts bind exactly the write", () => {
  it("a different create body or credential is a different digest", () => {
    const a = identityCreateStepUp({ kind: "worker_runtime", sponsorUserIds: ["00000000-0000-4000-8000-000000000001"], environments: ["dev"] });
    const b = identityCreateStepUp({ kind: "worker_runtime", sponsorUserIds: ["00000000-0000-4000-8000-000000000001"], environments: ["prod"] });
    expect(a.kind).toBe("identity_manage");
    expect(a.facts.bodyDigest).not.toBe(b.facts.bodyDigest);
    const id = "00000000-0000-4000-8000-000000000009";
    const c1 = credentialAddStepUp(id, { kind: "spiffe_id", spiffeId: "spiffe://example.org/a" });
    const c2 = credentialAddStepUp(id, { kind: "spiffe_id", spiffeId: "spiffe://example.org/b" });
    expect(c1.facts).toMatchObject({ op: "credential_add", identityId: id });
    expect(c1.facts.credentialDigest).not.toBe(c2.facts.credentialDigest);
  });
});
