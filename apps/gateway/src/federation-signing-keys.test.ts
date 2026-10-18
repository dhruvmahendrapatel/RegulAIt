/**
 * ADR-0195 SD2b — the federation signer without a database: key material, the signer/JWKS round trip, audience and
 * expiry binding, the discovery document, publication overlap, and the refusals that happen before any database
 * read. The lifecycle routes and step-ups run on a real database in `zz-adr0195-sd2b-federation.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { createLocalJWKSet, decodeProtectedHeader, jwtVerify } from "jose";
import type { Db, FederationSigningKeyRow } from "@regulait/db";
import { FEDERATION_KEY_OVERLAP_SECONDS, FEDERATION_TOKEN_TTL_SECONDS, federationSourceSubject } from "@regulait/shared";
import {
  awsPrincipalRoleArn,
  FederationError,
  federationDiscoveryDocument,
  federationErrorStatus,
  federationIssuer,
  federationJwks,
  federationTokenMinter,
  isPublished,
  newFederationKeyMaterial,
  federationKeyAcceptable,
  signFederationToken,
} from "./federation-signing-keys.js";
import { federationAudiences, gcpWifAudience } from "./discovery-cloud-scanners.js";

const ISSUER = "https://regulait.example.test/federation";
const SUB = federationSourceSubject("00000000-0000-4000-8000-000000000001");
const AWS_AUD = "sts.amazonaws.com";
/** a Db that fails the test if touched: refusals must happen before any read */
const untouchable = new Proxy({}, { get: () => { throw new Error("the database was touched"); } }) as unknown as Db;

describe("key material", () => {
  it("is RSA 2048 with e = AQAB, a public-only JWK and an RFC 7638 kid", async () => {
    const k = await newFederationKeyMaterial();
    expect(k.publicJwk.kty).toBe("RSA");
    expect(k.publicJwk.e).toBe("AQAB");
    expect(k.publicJwk.n.length).toBe(342); // 2048 bits, base64url (the migration CHECK allows 342 to 683)
    expect(Object.keys(k.publicJwk).sort()).toEqual(["e", "kty", "n"]);
    expect(k.kid).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(k.pkcs8).toContain("PRIVATE" + " KEY");
    expect((await newFederationKeyMaterial()).kid).not.toBe(k.kid);
  });

  it("the JWKS carries only public members, as RS256 signing keys", async () => {
    const k = await newFederationKeyMaterial();
    const doc = federationJwks([{ kid: k.kid, publicJwk: k.publicJwk }]);
    expect(doc.keys).toEqual([{ kty: "RSA", n: k.publicJwk.n, e: "AQAB", kid: k.kid, alg: "RS256", use: "sig" }]);
    // even a row whose stored JWK carried private members (the CHECK forbids it) publishes none
    const leaky = { kid: k.kid, publicJwk: { ...k.publicJwk, d: "x", p: "y" } as FederationSigningKeyRow["publicJwk"] };
    expect(JSON.stringify(federationJwks([leaky]))).not.toMatch(/"(d|p|q|dp|dq|qi)"/);
  });
});

describe("signer and JWKS round trip", () => {
  it("a token verifies against the published JWKS with its issuer, subject and audience; RS256, kid, 5-minute life", async () => {
    const k = await newFederationKeyMaterial();
    const token = await signFederationToken(k, { issuer: ISSUER, subject: SUB, audience: AWS_AUD });
    const header = decodeProtectedHeader(token);
    expect(header).toMatchObject({ alg: "RS256", kid: k.kid, typ: "JWT" });
    const jwks = createLocalJWKSet(federationJwks([{ kid: k.kid, publicJwk: k.publicJwk }]));
    const { payload } = await jwtVerify(token, jwks, { issuer: ISSUER, audience: AWS_AUD, algorithms: ["RS256"] });
    expect(payload.sub).toBe(SUB);
    expect(payload.exp! - payload.iat!).toBe(FEDERATION_TOKEN_TTL_SECONDS);
    expect(FEDERATION_TOKEN_TTL_SECONDS).toBeLessThanOrEqual(300);
    expect(payload.nbf).toBe(payload.iat);
    expect(typeof payload.jti).toBe("string");
    // a fresh jti per token
    const again = await jwtVerify(await signFederationToken(k, { issuer: ISSUER, subject: SUB, audience: AWS_AUD }), jwks, { issuer: ISSUER, audience: AWS_AUD });
    expect(again.payload.jti).not.toBe(payload.jti);
  });

  it("is bound to its audience: another target's audience refuses it", async () => {
    const k = await newFederationKeyMaterial();
    const jwks = createLocalJWKSet(federationJwks([{ kid: k.kid, publicJwk: k.publicJwk }]));
    const token = await signFederationToken(k, { issuer: ISSUER, subject: SUB, audience: AWS_AUD });
    await expect(jwtVerify(token, jwks, { issuer: ISSUER, audience: "api://AzureADTokenExchange" })).rejects.toThrow(/aud/);
    await expect(jwtVerify(token, jwks, { issuer: "https://regulait.example.test", audience: AWS_AUD })).rejects.toThrow(/iss/);
  });

  it("expires: a verifier past exp refuses it", async () => {
    const k = await newFederationKeyMaterial();
    const now = new Date("2026-10-17T12:00:00Z");
    const token = await signFederationToken(k, { issuer: ISSUER, subject: SUB, audience: AWS_AUD, now });
    const jwks = createLocalJWKSet(federationJwks([{ kid: k.kid, publicJwk: k.publicJwk }]));
    await expect(jwtVerify(token, jwks, { issuer: ISSUER, audience: AWS_AUD, currentDate: new Date(now.getTime() + 299_000) })).resolves.toBeTruthy();
    await expect(jwtVerify(token, jwks, { issuer: ISSUER, audience: AWS_AUD, currentDate: new Date(now.getTime() + 301_000) })).rejects.toThrow(/exp/);
  });

  it("a token from another key is not accepted by this JWKS, and a revoked (unpublished) key verifies nothing", async () => {
    const a = await newFederationKeyMaterial();
    const b = await newFederationKeyMaterial();
    const token = await signFederationToken(b, { issuer: ISSUER, subject: SUB, audience: AWS_AUD });
    await expect(jwtVerify(token, createLocalJWKSet(federationJwks([{ kid: a.kid, publicJwk: a.publicJwk }])), { issuer: ISSUER, audience: AWS_AUD })).rejects.toThrow();
    await expect(jwtVerify(token, createLocalJWKSet(federationJwks([])), { issuer: ISSUER, audience: AWS_AUD })).rejects.toThrow();
  });

  it("refuses a key that is not RSA 2048 or more", async () => {
    const { generateKeyPairSync } = await import("node:crypto");
    const ec = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    await expect(signFederationToken({ kid: "k", pkcs8: ec }, { issuer: ISSUER, subject: SUB, audience: AWS_AUD })).rejects.toMatchObject({ code: "federation_key_unreadable" });
    // RSA, but under 2048 bits: the size check, not the key-type check, refuses it (#420 review finding 2). The key's
    // details stand in for a generated key, since creating an RSA key under 2048 bits is a SAST finding of its own
    const rsa = (modulusLength: number) => ({ asymmetricKeyType: "rsa" as const, asymmetricKeyDetails: { modulusLength } });
    expect(federationKeyAcceptable(rsa(1024))).toBe(false);
    expect(federationKeyAcceptable(rsa(2047))).toBe(false);
    expect(federationKeyAcceptable(rsa(2048))).toBe(true);
    expect(federationKeyAcceptable({ asymmetricKeyType: "ec", asymmetricKeyDetails: { namedCurve: "prime256v1" } })).toBe(false);
    await expect(signFederationToken({ kid: "k", pkcs8: "not a key" }, { issuer: ISSUER, subject: SUB, audience: AWS_AUD })).rejects.toBeInstanceOf(FederationError);
  });
});

describe("audience binding at mint", () => {
  it("refuses an audience the credential does not name, before reading the database", async () => {
    const mint = federationTokenMinter(untouchable, { dataKey: "0".repeat(64), subject: SUB, allowedAudiences: federationAudiences("cloud_aws", {}), env: { REGULAIT_PUBLIC_URL: "https://regulait.example.test" } as NodeJS.ProcessEnv });
    await expect(mint("api://AzureADTokenExchange")).rejects.toMatchObject({ code: "federation_audience_refused" });
    await expect(mint("https://attacker.example.test")).rejects.toMatchObject({ code: "federation_audience_refused" });
    // the allowed one reaches the database (here: the untouchable proxy)
    await expect(mint(AWS_AUD)).rejects.toThrow(/database was touched/);
  });

  it("each cloud kind names exactly one audience; GCP's is its own pool provider", () => {
    expect(federationAudiences("cloud_aws", {})).toEqual(["sts.amazonaws.com"]);
    expect(federationAudiences("cloud_azure", { tenantId: "t", clientId: "c" })).toEqual(["api://AzureADTokenExchange"]);
    const cfg = { projectNumber: "123", workloadIdentityPool: "regulait", workloadIdentityProvider: "oidc", serviceAccountEmail: "s@p.iam.gserviceaccount.com" };
    expect(federationAudiences("cloud_gcp", cfg)).toEqual([`https:${gcpWifAudience("123", "regulait", "oidc")}`]);
    expect(federationAudiences("cloud_gcp", { projectNumber: "123" })).toEqual([]);
    expect(federationAudiences("repo_github", {})).toEqual([]);
  });
});

describe("issuer, discovery document, publication", () => {
  it("the issuer is the public URL plus /federation, and unset is null (fail closed)", () => {
    expect(federationIssuer({ REGULAIT_PUBLIC_URL: "https://regulait.example.test" } as NodeJS.ProcessEnv)).toBe(ISSUER);
    expect(federationIssuer({} as NodeJS.ProcessEnv)).toBeNull();
  });

  it("the discovery document names the issuer, its JWKS and RS256 only", () => {
    expect(federationDiscoveryDocument(ISSUER)).toMatchObject({
      issuer: ISSUER,
      jwks_uri: "https://regulait.example.test/federation/.well-known/jwks.json",
      id_token_signing_alg_values_supported: ["RS256"],
    });
  });

  it("publishes the active key and a retired key inside the overlap; never a pending or revoked key", () => {
    const now = new Date("2026-10-17T12:00:00Z");
    const t = (s: number) => new Date(now.getTime() - s * 1000);
    expect(isPublished({ activatedAt: t(100), retiredAt: null, revokedAt: null }, now)).toBe(true);
    expect(isPublished({ activatedAt: null, retiredAt: null, revokedAt: null }, now)).toBe(false);
    expect(isPublished({ activatedAt: t(1000), retiredAt: t(FEDERATION_KEY_OVERLAP_SECONDS - 1), revokedAt: null }, now)).toBe(true);
    expect(isPublished({ activatedAt: t(1000), retiredAt: t(FEDERATION_KEY_OVERLAP_SECONDS + 1), revokedAt: null }, now)).toBe(false);
    expect(isPublished({ activatedAt: t(100), retiredAt: null, revokedAt: t(1) }, now)).toBe(false);
    // the overlap covers a token's whole life
    expect(FEDERATION_KEY_OVERLAP_SECONDS).toBeGreaterThanOrEqual(FEDERATION_TOKEN_TTL_SECONDS);
  });

  it("RegulAIt's own AWS principal is an IAM role ARN, else unset", () => {
    const env = (v: string) => ({ REGULAIT_AWS_PRINCIPAL_ROLE_ARN: v }) as NodeJS.ProcessEnv;
    expect(awsPrincipalRoleArn(env("arn:aws:iam::000000000000:role/regulait-principal"))).toBe("arn:aws:iam::000000000000:role/regulait-principal");
    expect(awsPrincipalRoleArn(env("arn:aws:iam::000000000000:user/someone"))).toBeNull();
    expect(awsPrincipalRoleArn(env("arn:aws:iam::12:role/x"))).toBeNull();
    expect(awsPrincipalRoleArn({} as NodeJS.ProcessEnv)).toBeNull();
  });

  it("maps refusals to statuses", () => {
    expect(federationErrorStatus("federation_key_not_found")).toBe(404);
    expect(federationErrorStatus("federation_issuer_unset")).toBe(503);
    expect(federationErrorStatus("federation_off")).toBe(409);
  });
});
