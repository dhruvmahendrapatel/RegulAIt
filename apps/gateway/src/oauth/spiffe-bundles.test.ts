/**
 * ADR-0188 S9 — SPIFFE trust bundles and X.509-SVIDs, offline (no network, no
 * database): what a bundle upload is reduced to, every refusal it makes before
 * anything could be stored, and the decision 21 validator judging SVIDs under
 * an uploaded bundle. The routes, their step-up, audit, compare-and-set and
 * revocation cascade, and SVID client authentication end to end through the
 * token endpoint and the gateway, are proved through the real app in
 * `zz-adr0188-s9-spiffe.test.ts`.
 *
 * Two sources of certificates:
 *  - synthetic ones made per run (`makeCert`, in-memory keys);
 *  - a REAL SPIRE 1.13.3 trust bundle and X.509-SVID (`testing/spire-1.13.3/`,
 *    public halves only; the PEM files are named `.crt` because the repository
 *    ignores `*.pem`), produced by `spire-server bundle show -format spiffe`,
 *    `-format pem` and `spire-server x509 mint`, exactly as the BYOC runbook
 *    records. The SVID was valid from 2026-10-16T00:18:43Z to 01:18:53Z, its
 *    CA from 00:18:11Z to 2026-10-23T00:18:21Z, so the test judges them at a
 *    fixed instant inside (and one after) those windows.
 */
import { readFileSync } from "node:fs";
import { generateKeyPairSync, X509Certificate } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { exportJWK } from "jose";
import { makeCert, type TestCert } from "../testing/x509-fixtures.js";
import { IdentityAdminError } from "./identity-admin.js";
import { parseSpiffeBundle, spiffeBundleRevokeStepUp, spiffeBundleSetStepUp, type ParsedSpiffeBundle } from "./spiffe-bundles.js";
import { certificateThumbprint, validateClientCertificate } from "./x509.js";

const fixture = (name: string) => readFileSync(new URL(`../testing/spire-1.13.3/${name}`, import.meta.url), "utf8");
const SPIRE_TD = "byoc.example.org";
const SPIRE_ID = `spiffe://${SPIRE_TD}/worker/runtime-1`;
const SPIRE_VALID_AT = new Date("2026-10-16T00:30:00Z");
const SPIRE_SVID_EXPIRED_AT = new Date("2026-10-16T02:00:00Z");

const ok = (out: ParsedSpiffeBundle | IdentityAdminError): ParsedSpiffeBundle => {
  if (out instanceof IdentityAdminError) throw new Error(`refused ${out.code}: ${out.message}`);
  return out;
};
const code = (out: ParsedSpiffeBundle | IdentityAdminError): string => {
  if (!(out instanceof IdentityAdminError)) throw new Error("accepted, expected a refusal");
  return out.code;
};

/** a SPIFFE bundle document (RFC 7517 JWKS, `x509-svid` keys with one x5c) for these CAs */
async function spiffeJwks(cas: TestCert[], extra: Array<Record<string, unknown>> = []): Promise<string> {
  const keys: Array<Record<string, unknown>> = [];
  for (const ca of cas) {
    const jwk = await exportJWK(new X509Certificate(ca.der).publicKey);
    keys.push({ use: "x509-svid", ...jwk, x5c: [ca.der.toString("base64")] });
  }
  return JSON.stringify({ keys: [...keys, ...extra], spiffe_sequence: 1 });
}

let root: TestCert;
let root2: TestCert;
let leaf: TestCert;
const now = () => new Date();

beforeAll(async () => {
  root = await makeCert({ isCA: true, name: "s9-root" });
  root2 = await makeCert({ isCA: true, name: "s9-root-2" });
  leaf = await makeCert({ issuer: root, uris: ["spiffe://example.org/w"] });
});

describe("a bundle upload: PEM or the SPIFFE bundle format, public CAs only", () => {
  it("PEM certificates parse to their public facts; the digest does not depend on order or format", async () => {
    const a = ok(parseSpiffeBundle(`${root.pem}${root2.pem}`, now()));
    expect(a.format).toBe("pem");
    expect(a.views.map((v) => v.thumbprint)).toEqual([certificateThumbprint(root.der), certificateThumbprint(root2.der)]);
    expect(a.digest).toMatch(/^[0-9a-f]{64}$/);
    const b = ok(parseSpiffeBundle(`${root2.pem}${root.pem}`, now()));
    expect(b.digest).toBe(a.digest);
    const c = ok(parseSpiffeBundle(await spiffeJwks([root, root2]), now()));
    expect([c.format, c.digest]).toEqual(["spiffe_jwks", a.digest]);
    // the stored form is PEM again, and nothing but certificates
    expect(c.authoritiesPem.split("-----BEGIN CERTIFICATE-----")).toHaveLength(3);
    expect(c.authoritiesPem).not.toContain("PRIVATE");
  });

  it("jwt-svid keys are counted and not stored (JWT-SVID client authentication is not built)", async () => {
    const jwt = { use: "jwt-svid", kid: "k1", ...(await exportJWK(new X509Certificate(root2.der).publicKey)) };
    const p = ok(parseSpiffeBundle(await spiffeJwks([root], [jwt]), now()));
    expect([p.views.length, p.jwtAuthoritiesIgnored]).toEqual([1, 1]);
    // a bundle of jwt-svid keys only holds no X.509 authority: refused
    expect(code(parseSpiffeBundle(JSON.stringify({ keys: [jwt] }), now()))).toBe("spiffe_bundle_invalid");
  });

  it("a private key anywhere is refused, in PEM or as a JWK member", async () => {
    // a real key made at runtime (no key-shaped literal in the repository)
    const pkcs8 = generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    expect(code(parseSpiffeBundle(`${root.pem}${pkcs8}`, now()))).toBe("spiffe_bundle_private_material");
    const doc = JSON.parse(await spiffeJwks([root])) as { keys: Array<Record<string, unknown>> };
    doc.keys[0]!.d = "AAAA";
    expect(code(parseSpiffeBundle(JSON.stringify(doc), now()))).toBe("spiffe_bundle_private_material");
  });

  it("a leaf is never a trust anchor; a CA without keyCertSign is not one either", async () => {
    expect(code(parseSpiffeBundle(leaf.pem, now()))).toBe("spiffe_bundle_authority_not_ca");
    const noSign = await makeCert({ isCA: true, keyUsage: 0x02 });
    expect(code(parseSpiffeBundle(noSign.pem, now()))).toBe("spiffe_bundle_authority_not_ca");
    // positive control: the same shape with keyCertSign is accepted
    const signs = await makeCert({ isCA: true, keyUsage: 0x06 });
    expect(ok(parseSpiffeBundle(signs.pem, now())).views).toHaveLength(1);
  });

  it("an authority outside its validity window is refused", async () => {
    const expired = await makeCert({ isCA: true, notBefore: new Date(Date.now() - 7200_000), notAfter: new Date(Date.now() - 60_000) });
    const future = await makeCert({ isCA: true, notBefore: new Date(Date.now() + 3600_000), notAfter: new Date(Date.now() + 7200_000) });
    expect(code(parseSpiffeBundle(expired.pem, now()))).toBe("spiffe_bundle_authority_time");
    expect(code(parseSpiffeBundle(future.pem, now()))).toBe("spiffe_bundle_authority_time");
  });

  it("the SPIFFE format's own rules: one x5c per key, key parameters equal to that certificate's key, a known use", async () => {
    const doc = () => JSON.parse(readFileSync(new URL("../testing/spire-1.13.3/bundle.spiffe.json", import.meta.url), "utf8")) as { keys: Array<Record<string, unknown>> };
    const two = doc();
    two.keys[0]!.x5c = [root.der.toString("base64"), root2.der.toString("base64")];
    expect(code(parseSpiffeBundle(JSON.stringify(two), SPIRE_VALID_AT))).toBe("spiffe_bundle_invalid");
    // the x5c swapped for another CA whose key the JWK does not carry
    const swapped = doc();
    swapped.keys[0]!.x5c = [root.der.toString("base64")];
    expect(code(parseSpiffeBundle(JSON.stringify(swapped), now()))).toBe("spiffe_bundle_key_mismatch");
    const use = doc();
    use.keys[0]!.use = "sig";
    expect(code(parseSpiffeBundle(JSON.stringify(use), SPIRE_VALID_AT))).toBe("spiffe_bundle_invalid");
  });

  it("duplicates, garbage, empty and oversized bundles are refused, never thrown", async () => {
    expect(code(parseSpiffeBundle(`${root.pem}${root.pem}`, now()))).toBe("spiffe_bundle_duplicate");
    for (const bad of ["", "   ", "hello", "{", "[]", '{"keys": 3}', "-----BEGIN CERTIFICATE-----\nnope\n-----END CERTIFICATE-----\n"]) {
      expect(code(parseSpiffeBundle(bad, now())), bad).toBe("spiffe_bundle_invalid");
    }
    expect(code(parseSpiffeBundle(root.pem.repeat(65), now()))).toBe("spiffe_bundle_invalid");
  });

  it("the step-up binds the domain, the digest and the bundle replaced; revoke binds the bundle", () => {
    const a = spiffeBundleSetStepUp({ trustDomain: "example.org", bundle: "x", replacesBundleId: null }, "a".repeat(64));
    expect(a).toEqual({ kind: "identity_manage", facts: { op: "spiffe_bundle_set", trustDomain: "example.org", digest: "a".repeat(64), replacesBundleId: null } });
    const id = "00000000-0000-4000-8000-000000000001";
    expect(spiffeBundleRevokeStepUp(id)).toEqual({ kind: "identity_manage", facts: { op: "spiffe_bundle_revoke", bundleId: id } });
  });
});

describe("a REAL SPIRE 1.13.3 bundle and X.509-SVID (testing/spire-1.13.3)", () => {
  it("the SPIFFE-format and PEM exports of the same SPIRE CA are the same bundle, with its jwt-svid key ignored", () => {
    const jwks = ok(parseSpiffeBundle(fixture("bundle.spiffe.json"), SPIRE_VALID_AT));
    const pem = ok(parseSpiffeBundle(fixture("bundle.crt"), SPIRE_VALID_AT));
    expect([jwks.format, jwks.jwtAuthoritiesIgnored, jwks.views.length]).toEqual(["spiffe_jwks", 1, 1]);
    expect(jwks.digest).toBe(pem.digest);
  });

  it("the SVID validates offline under the uploaded bundle, inside its window (positive control)", async () => {
    const anchors = ok(parseSpiffeBundle(fixture("bundle.spiffe.json"), SPIRE_VALID_AT)).authorities;
    const svid = Buffer.from(new X509Certificate(fixture("svid.crt")).raw);
    const r = await validateClientCertificate(svid, { anchors, now: SPIRE_VALID_AT, spiffeTrustDomain: SPIRE_TD });
    expect(r.ok && r.spiffeId).toBe(SPIRE_ID);
  });

  it("the same SVID, an hour after it expired, is refused (the CA is still valid then)", async () => {
    const anchors = ok(parseSpiffeBundle(fixture("bundle.crt"), SPIRE_VALID_AT)).authorities;
    const svid = Buffer.from(new X509Certificate(fixture("svid.crt")).raw);
    const r = await validateClientCertificate(svid, { anchors, now: SPIRE_SVID_EXPIRED_AT, spiffeTrustDomain: SPIRE_TD });
    // pkijs judges every certificate's validity while it builds the path, so an expired leaf has no valid path; only
    // the instant differs from the positive control above
    expect(r).toEqual({ ok: false, code: "certificate_path" });
  });

  it("judged for another trust domain, the genuine SVID is refused", async () => {
    const anchors = ok(parseSpiffeBundle(fixture("bundle.crt"), SPIRE_VALID_AT)).authorities;
    const svid = Buffer.from(new X509Certificate(fixture("svid.crt")).raw);
    expect(await validateClientCertificate(svid, { anchors, now: SPIRE_VALID_AT, spiffeTrustDomain: "other.example.org" })).toEqual({ ok: false, code: "spiffe_trust_domain" });
  });

  it("under another domain's bundle (our synthetic CA), the genuine SVID has no path", async () => {
    const svid = Buffer.from(new X509Certificate(fixture("svid.crt")).raw);
    expect(await validateClientCertificate(svid, { anchors: [root.der], now: SPIRE_VALID_AT, spiffeTrustDomain: SPIRE_TD })).toEqual({ ok: false, code: "certificate_path" });
  });

  it("the SPIRE CA itself, presented as a client certificate, is refused as a leaf", async () => {
    const anchors = ok(parseSpiffeBundle(fixture("bundle.crt"), SPIRE_VALID_AT)).authorities;
    const r = await validateClientCertificate(anchors[0]!, { anchors, now: SPIRE_VALID_AT, spiffeTrustDomain: SPIRE_TD });
    expect(r.ok).toBe(false);
  });
});

describe("the decision 21 SVID profile under an uploaded bundle (synthetic SVIDs)", () => {
  const TD = "example.org";
  const ID = `spiffe://${TD}/worker/one`;
  const anchors = () => ok(parseSpiffeBundle(root.pem, now())).authorities;

  it("a genuine SVID validates (positive control for every refusal below)", async () => {
    const svid = await makeCert({ issuer: root, uris: [ID] });
    const r = await validateClientCertificate(svid.der, { anchors: anchors(), now: now(), spiffeTrustDomain: TD });
    expect(r.ok && r.spiffeId).toBe(ID);
  });

  it("a wrong trust domain is refused", async () => {
    const svid = await makeCert({ issuer: root, uris: [`spiffe://evil.example/worker/one`] });
    expect(await validateClientCertificate(svid.der, { anchors: anchors(), now: now(), spiffeTrustDomain: TD })).toEqual({ ok: false, code: "spiffe_trust_domain" });
  });

  it("an expired SVID is refused, and one not yet valid", async () => {
    const expired = await makeCert({ issuer: root, uris: [ID], notBefore: new Date(Date.now() - 7200_000), notAfter: new Date(Date.now() - 60_000) });
    const early = await makeCert({ issuer: root, uris: [ID], notBefore: new Date(Date.now() + 3600_000), notAfter: new Date(Date.now() + 7200_000) });
    for (const c of [expired, early]) {
      const r = await validateClientCertificate(c.der, { anchors: anchors(), now: now(), spiffeTrustDomain: TD });
      // the engine checks every certificate's validity on the path; either code means refused for time or path
      expect(r.ok).toBe(false);
      expect(["certificate_time", "certificate_path"]).toContain((r as { code: string }).code);
    }
  });

  it("a URI SAN that is not SPIFFE is refused", async () => {
    const https = await makeCert({ issuer: root, uris: ["https://example.org/worker/one"] });
    expect(await validateClientCertificate(https.der, { anchors: anchors(), now: now(), spiffeTrustDomain: TD })).toEqual({ ok: false, code: "spiffe_profile" });
  });

  it("multiple URI SANs are refused, even when both are SPIFFE IDs of the domain", async () => {
    const two = await makeCert({ issuer: root, uris: [ID, `${ID}-2`] });
    expect(await validateClientCertificate(two.der, { anchors: anchors(), now: now(), spiffeTrustDomain: TD })).toEqual({ ok: false, code: "spiffe_san" });
  });

  it("a CA SVID used as a leaf is refused, even with a SPIFFE ID SAN and a valid path", async () => {
    const caSvid = await makeCert({ issuer: root, isCA: true, uris: [ID] });
    expect(await validateClientCertificate(caSvid.der, { anchors: anchors(), now: now(), spiffeTrustDomain: TD })).toEqual({ ok: false, code: "certificate_leaf_ca" });
  });
});
