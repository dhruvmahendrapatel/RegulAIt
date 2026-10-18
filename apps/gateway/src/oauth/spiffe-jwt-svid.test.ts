/**
 * ADR-0188 S9 follow-up — the JWT-SVID verifier, offline (no network, no
 * database): every rule of `verifyJwtSvid` as a refusal with its own code, and
 * its positive controls. Keys are generated per run (EC P-256 and RSA 2048);
 * the authorities a trust domain serves are injected exactly as
 * `loadSpiffeJwtAuthorities` returns them (public JWKs with a `kid`).
 *
 * The token endpoint path (the replay claim, the DPoP binding, the org setting
 * that turns the method on, the bundle lock) is proved through the real app in
 * `zz-adr0188-s9b-spiffe-fetch-jwt-svid.test.ts`.
 */
import { createHmac, generateKeyPairSync, X509Certificate, type KeyObject } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { base64url, exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWTPayload } from "jose";
import { makeCert } from "../testing/x509-fixtures.js";
import { parseSpiffeBundle } from "./spiffe-bundles.js";
import { IdentityAdminError } from "./identity-admin.js";
import { verifyJwtSvid, type JwtAuthoritySource } from "./spiffe-jwt-svid.js";

const TD = "jwt.example.org";
const OTHER_TD = "other.example.org";
const SUB = `spiffe://${TD}/workload/a`;
const AUD = "https://gateway.example.test";
const NOW = new Date("2026-10-18T12:00:00Z");
const nowS = Math.floor(NOW.getTime() / 1000);

type SigningKey = CryptoKey | KeyObject;
let ec: { privateKey: SigningKey; jwk: Record<string, string> };
let rsa: { privateKey: SigningKey; jwk: Record<string, string> };
let otherEc: { privateKey: SigningKey; jwk: Record<string, string> };
let authorities: JwtAuthoritySource;

async function keyPair(alg: "ES256" | "RSA", kid: string, modulusLength = 2048): Promise<{ privateKey: SigningKey; jwk: Record<string, string> }> {
  if (alg === "RSA") {
    // a Node KeyObject signs under RS* and PS* alike (a WebCrypto key is fixed to one)
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength });
    return { privateKey, jwk: { ...((await exportJWK(publicKey)) as Record<string, string>), kid } };
  }
  const { privateKey, publicKey } = await generateKeyPair(alg, { extractable: true });
  const pub = (await exportJWK(publicKey)) as Record<string, string>;
  return { privateKey, jwk: { ...pub, kid } };
}

/** a JWT-SVID: `claims` merged over the valid defaults (an `undefined` value removes the claim) */
async function svid(opts: { key?: SigningKey; alg?: string; header?: Record<string, unknown>; claims?: Record<string, unknown> } = {}): Promise<string> {
  const claims: Record<string, unknown> = { sub: SUB, aud: [AUD], exp: nowS + 120, iat: nowS, jti: "j-1", ...(opts.claims ?? {}) };
  for (const k of Object.keys(claims)) if (claims[k] === undefined) delete claims[k];
  return new SignJWT(claims as JWTPayload)
    .setProtectedHeader({ alg: opts.alg ?? "ES256", kid: "ec-1", ...(opts.header ?? {}) } as never)
    .sign(opts.key ?? ec.privateKey);
}

const verify = (token: string, audience = AUD, src: JwtAuthoritySource = authorities) => verifyJwtSvid(token, { audience, now: NOW, authorities: src });
const code = async (token: string, audience = AUD) => {
  const r = await verify(token, audience);
  return r.ok ? "accepted" : r.code;
};

beforeAll(async () => {
  ec = await keyPair("ES256", "ec-1");
  rsa = await keyPair("RSA", "rsa-1");
  otherEc = await keyPair("ES256", "ec-1"); // the SAME kid, in another trust domain
  authorities = async (td) => {
    if (td === TD) return { bundleId: "b-jwt", keys: [ec.jwk, rsa.jwk] };
    if (td === OTHER_TD) return { bundleId: "b-other", keys: [otherEc.jwk] };
    return null;
  };
});

describe("a valid JWT-SVID (positive controls)", () => {
  it("ES256 with its kid: accepted, naming the SPIFFE ID, its trust domain, the bundle and a replay key from the jti", async () => {
    const r = await verify(await svid());
    expect(r).toEqual({ ok: true, spiffeId: SUB, trustDomain: TD, bundleId: "b-jwt", replayKey: `jwt-svid ${SUB} jti j-1`, exp: nowS + 120 });
  });

  it("RS256 and PS256 under the RSA authority; aud as a single string; typ JWT; no kid (the domain's keys of that type are tried)", async () => {
    expect(await code(await svid({ key: rsa.privateKey, alg: "RS256", header: { kid: "rsa-1" } }))).toBe("accepted");
    expect(await code(await svid({ key: rsa.privateKey, alg: "PS256", header: { kid: "rsa-1", typ: "JWT" }, claims: { aud: AUD } }))).toBe("accepted");
    const noKid = await new SignJWT({ sub: SUB, aud: AUD, exp: nowS + 60 }).setProtectedHeader({ alg: "ES256" }).sign(ec.privateKey);
    expect(await code(noKid)).toBe("accepted");
  });

  it("with no jti, the replay key is a digest of the token, so the same token is still single-use", async () => {
    const t = await svid({ claims: { jti: undefined } });
    const r = await verify(t);
    if (!r.ok) throw new Error(r.code);
    expect(r.replayKey).toMatch(new RegExp(`^jwt-svid ${SUB} sha256 [A-Za-z0-9_-]{43}$`));
    expect((await verify(t)).ok && (await verify(t)).ok).toBe(true);
    expect(((await verify(t)) as { replayKey: string }).replayKey).toBe(r.replayKey);
  });
});

describe("refusals", () => {
  it("wrong trust domain: a domain with no JWT authorities, and a token signed by another domain's key under the same kid", async () => {
    expect(await code(await svid({ claims: { sub: "spiffe://unknown.example.org/w" } }))).toBe("spiffe_trust_domain_unknown");
    // signed by OTHER_TD's key, claiming a TD identity: TD's ec-1 does not verify it
    expect(await code(await svid({ key: otherEc.privateKey }))).toBe("jwt_svid_signature");
    // and the reverse: a TD key cannot speak for OTHER_TD
    expect(await code(await svid({ claims: { sub: `spiffe://${OTHER_TD}/w` } }))).toBe("jwt_svid_signature");
    // a domain whose bundle holds no JWT authority (X.509 only)
    expect((await verifyJwtSvid(await svid(), { audience: AUD, now: NOW, authorities: async () => ({ bundleId: "x", keys: [] }) })).ok).toBe(false);
  });

  it("sub must be a SPIFFE ID", async () => {
    expect(await code(await svid({ claims: { sub: "https://example.org/w" } }))).toBe("jwt_svid_sub");
    expect(await code(await svid({ claims: { sub: `spiffe://${TD}` } }))).toBe("jwt_svid_sub");
    expect(await code(await svid({ claims: { sub: undefined } }))).toBe("jwt_svid_sub");
  });

  it("aud: required, and exactly this gateway's issuer identifier", async () => {
    expect(await code(await svid({ claims: { aud: undefined } }))).toBe("jwt_svid_aud_missing");
    expect(await code(await svid({ claims: { aud: [] } }))).toBe("jwt_svid_aud_missing");
    expect(await code(await svid({ claims: { aud: ["https://another.example.test"] } }))).toBe("jwt_svid_aud_mismatch");
    // two audiences, ours among them: refused (JWT-SVID §7.2; draft-ietf-oauth-spiffe-client-auth §3.1 step 3)
    expect(await code(await svid({ claims: { aud: [AUD, "https://another.example.test"] } }))).toBe("jwt_svid_aud_mismatch");
    // the same token is accepted by the audience it names (positive control)
    expect(await code(await svid({ claims: { aud: ["https://another.example.test"] } }), "https://another.example.test")).toBe("accepted");
  });

  it("exp: required, not past, and at most five minutes away; nbf and iat not in the future", async () => {
    expect(await code(await svid({ claims: { exp: undefined } }))).toBe("jwt_svid_exp_missing");
    expect(await code(await svid({ claims: { exp: nowS - 30, iat: nowS - 330 } }))).toBe("jwt_svid_expired");
    expect(await code(await svid({ claims: { exp: nowS + 3600 } }))).toBe("jwt_svid_lifetime");
    expect(await code(await svid({ claims: { nbf: nowS + 60 } }))).toBe("jwt_svid_not_yet_valid");
    expect(await code(await svid({ claims: { iat: nowS + 60 } }))).toBe("jwt_svid_not_yet_valid");
    // inside the 5 s leeway: accepted (positive control)
    expect(await code(await svid({ claims: { exp: nowS - 2 } }))).toBe("accepted");
  });

  it("an unknown kid is refused, never looked up anywhere else", async () => {
    expect(await code(await svid({ header: { kid: "rotated-away" } }))).toBe("jwt_svid_kid_unknown");
  });

  it("a tampered payload fails the signature", async () => {
    const [h, , s] = (await svid()).split(".");
    const forged = base64url.encode(JSON.stringify({ sub: `spiffe://${TD}/admin`, aud: [AUD], exp: nowS + 60 }));
    expect(await code(`${h}.${forged}.${s}`)).toBe("jwt_svid_signature");
  });

  it("malformed: not a compact JWS, or a header member JWT-SVID §2 does not allow", async () => {
    expect(await code("a.b")).toBe("jwt_svid_malformed");
    expect(await code("not-a-jwt")).toBe("jwt_svid_malformed");
    expect(await code(JSON.stringify({ payload: "x", signatures: [] }))).toBe("jwt_svid_malformed");
    expect(await code(await svid({ header: { typ: "dpop+jwt" } }))).toBe("jwt_svid_header");
    expect(await code(await svid({ header: { cty: "JWT" } }))).toBe("jwt_svid_header");
  });
});

describe("alg confusion: a token never chooses how a key is used", () => {
  const unsigned = (header: Record<string, unknown>, claims: Record<string, unknown>) =>
    `${base64url.encode(JSON.stringify(header))}.${base64url.encode(JSON.stringify(claims))}.`;
  const claims = () => ({ sub: SUB, aud: [AUD], exp: nowS + 60 });

  it("alg none is refused", async () => {
    expect(await code(unsigned({ alg: "none", kid: "ec-1" }, claims()))).toBe("jwt_svid_alg");
  });

  it("HS256 keyed with the authority's PUBLIC key is refused (the classic RSA/HMAC confusion)", async () => {
    const h = base64url.encode(JSON.stringify({ alg: "HS256", kid: "rsa-1" }));
    const p = base64url.encode(JSON.stringify(claims()));
    // the attacker knows the public key: they MAC with it
    const pubPem = new X509Certificate((await makeCert({ isCA: true })).der).publicKey.export({ type: "spki", format: "pem" }).toString();
    const mac = createHmac("sha256", pubPem).update(`${h}.${p}`).digest("base64url");
    expect(await code(`${h}.${p}.${mac}`)).toBe("jwt_svid_alg");
  });

  it("EdDSA, and every alg outside JWT-SVID §2.1, is refused", async () => {
    const ed = await generateKeyPair("EdDSA", { extractable: true });
    const t = await new SignJWT(claims()).setProtectedHeader({ alg: "EdDSA", kid: "ec-1" }).sign(ed.privateKey);
    expect(await code(t)).toBe("jwt_svid_alg");
  });

  it("an alg of another key type or curve than the kid's key is refused before any verification", async () => {
    // RS256 named against the EC key's kid
    expect(await code(await svid({ key: rsa.privateKey, alg: "RS256", header: { kid: "ec-1" } }))).toBe("jwt_svid_alg_key_mismatch");
    // ES256 named against the RSA key's kid
    expect(await code(await svid({ header: { kid: "rsa-1" } }))).toBe("jwt_svid_alg_key_mismatch");
    // ES384 against a P-256 key
    const p384 = await generateKeyPair("ES384", { extractable: true });
    expect(await code(await svid({ key: p384.privateKey, alg: "ES384", header: { kid: "ec-1" } }))).toBe("jwt_svid_alg_key_mismatch");
  });

  it("an authority that names its own alg serves only that alg", async () => {
    const pinned: JwtAuthoritySource = async () => ({ bundleId: "b", keys: [{ ...rsa.jwk, alg: "PS256" }] });
    const rs = await svid({ key: rsa.privateKey, alg: "RS256", header: { kid: "rsa-1" } });
    expect(await verify(rs, AUD, pinned)).toEqual({ ok: false, code: "jwt_svid_alg_key_mismatch" });
    const ps = await svid({ key: rsa.privateKey, alg: "PS256", header: { kid: "rsa-1" } });
    expect((await verify(ps, AUD, pinned)).ok).toBe(true);
  });

  it("a key embedded in the header (jwk, jku, x5c) is never used: refused as a header member", async () => {
    const attacker = await generateKeyPair("ES256", { extractable: true });
    const jwk = await exportJWK(attacker.publicKey);
    const t = await new SignJWT(claims()).setProtectedHeader({ alg: "ES256", kid: "ec-1", jwk }).sign(attacker.privateKey);
    expect(await code(t)).toBe("jwt_svid_header");
    const jku = await new SignJWT(claims()).setProtectedHeader({ alg: "ES256", jku: "https://attacker.example.test/jwks" }).sign(attacker.privateKey);
    expect(await code(jku)).toBe("jwt_svid_header");
  });
});

describe("a bundle's JWT authorities (`parseSpiffeBundle`)", () => {
  const caJwk = async () => {
    const ca = await makeCert({ isCA: true });
    return { ca, x509: { use: "x509-svid", ...(await exportJWK(new X509Certificate(ca.der).publicKey)), x5c: [ca.der.toString("base64")] } };
  };
  const refusal = (out: unknown) => (out instanceof IdentityAdminError ? out.code : "accepted");

  it("EC and RSA jwt-svid keys are kept with their kid and RFC 7638 thumbprint", async () => {
    const { x509 } = await caJwk();
    const p = parseSpiffeBundle(JSON.stringify({ keys: [x509, { use: "jwt-svid", ...ec.jwk }, { use: "jwt-svid", ...rsa.jwk }] }), new Date());
    if (p instanceof IdentityAdminError) throw p;
    expect(p.jwtViews.map((v) => [v.kid, v.kty])).toEqual([
      ["ec-1", "EC"],
      ["rsa-1", "RSA"],
    ]);
    expect(p.jwtViews.every((v) => /^[A-Za-z0-9_-]{43}$/.test(v.thumbprint))).toBe(true);
  });

  it("refused: no kid, a duplicate kid, an Ed25519 key, an RSA key under 2048 bits, an alg the key cannot serve", async () => {
    const { x509 } = await caJwk();
    const bundle = (...jwt: Array<Record<string, unknown>>) => JSON.stringify({ keys: [x509, ...jwt.map((j) => ({ use: "jwt-svid", ...j }))] });
    const { kid: _kid, ...noKid } = ec.jwk;
    expect(refusal(parseSpiffeBundle(bundle(noKid), new Date()))).toBe("spiffe_bundle_invalid");
    expect(refusal(parseSpiffeBundle(bundle(ec.jwk, { ...rsa.jwk, kid: "ec-1" }), new Date()))).toBe("spiffe_bundle_duplicate");
    const ed = await exportJWK((await generateKeyPair("EdDSA", { extractable: true })).publicKey);
    expect(refusal(parseSpiffeBundle(bundle({ ...ed, kid: "ed" }), new Date()))).toBe("spiffe_bundle_jwt_key_unsupported");
    const small = (await keyPair("RSA", "small", 1024)).jwk;
    expect(refusal(parseSpiffeBundle(bundle(small), new Date()))).toBe("spiffe_bundle_jwt_key_unsupported");
    expect(refusal(parseSpiffeBundle(bundle({ ...ec.jwk, alg: "ES384" }), new Date()))).toBe("spiffe_bundle_jwt_key_unsupported");
    expect(refusal(parseSpiffeBundle(bundle({ ...rsa.jwk, alg: "HS256" }), new Date()))).toBe("spiffe_bundle_jwt_key_unsupported");
    // positive control: the same keys, well formed
    expect(refusal(parseSpiffeBundle(bundle(ec.jwk, rsa.jwk), new Date()))).toBe("accepted");
  });
});
