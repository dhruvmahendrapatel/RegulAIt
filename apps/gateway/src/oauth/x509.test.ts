/**
 * ADR-0188 decision 21 (S5) — the X.509 path validator, the SPIFFE profile and
 * the forwarded-certificate admission rules, offline (no network, no
 * database). Every refusal is paired with the positive control that the same
 * fixture with only that one fact corrected validates.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Fastify from "fastify";
import { makeCert, type TestCert } from "../testing/x509-fixtures.js";
import {
  certificateThumbprint,
  CLIENT_CERT_HEADER_ENV,
  CLIENT_CERT_PROXY_SECRET_ENV,
  CLIENT_CERT_PROXY_SECRET_HEADER,
  loadTrustConfig,
  MTLS_CA_BUNDLE_ENV,
  pemBundleToDer,
  presentedClientCertificate,
  registerClientCertificateHook,
  selfSignedCertificateFacts,
  spiffeIdParts,
  SPIFFE_TRUST_BUNDLES_ENV,
  validateClientCertificate,
} from "./x509.js";

const TD = "example.org";
const ID = `spiffe://${TD}/regulait/agent/b`;
let root: TestCert;
let inter: TestCert;
let otherRoot: TestCert;
const now = () => new Date();

beforeAll(async () => {
  root = await makeCert({ isCA: true, name: "root" });
  inter = await makeCert({ isCA: true, issuer: root, name: "intermediate" });
  otherRoot = await makeCert({ isCA: true, name: "other-root" });
});

describe("decision 21 — pkijs path validation and the leaf profile", () => {
  it("a genuine chain validates offline (positive control)", async () => {
    const leaf = await makeCert({ issuer: root, uris: [ID] });
    const r = await validateClientCertificate(leaf.der, { anchors: [root.der], now: now() });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.thumbprint).toBe(certificateThumbprint(leaf.der));
  });

  it("an uploaded intermediate completes the path; without it the path is broken", async () => {
    const leaf = await makeCert({ issuer: inter, uris: [ID] });
    expect((await validateClientCertificate(leaf.der, { anchors: [root.der, inter.der], now: now() })).ok).toBe(true);
    expect(await validateClientCertificate(leaf.der, { anchors: [root.der], now: now() })).toEqual({ ok: false, code: "certificate_path" });
  });

  it("the wrong trust root refuses; no anchors at all refuses (the strict default)", async () => {
    const leaf = await makeCert({ issuer: root });
    expect(await validateClientCertificate(leaf.der, { anchors: [otherRoot.der], now: now() })).toEqual({ ok: false, code: "certificate_path" });
    expect(await validateClientCertificate(leaf.der, { anchors: [], now: now() })).toEqual({ ok: false, code: "certificate_no_anchor" });
  });

  it("expired and not-yet-valid leaves refuse", async () => {
    const expired = await makeCert({ issuer: root, notBefore: new Date(Date.now() - 7200_000), notAfter: new Date(Date.now() - 60_000) });
    const future = await makeCert({ issuer: root, notBefore: new Date(Date.now() + 60_000) });
    expect((await validateClientCertificate(expired.der, { anchors: [root.der], now: now() })).ok).toBe(false);
    expect((await validateClientCertificate(future.der, { anchors: [root.der], now: now() })).ok).toBe(false);
  });

  it("a leaf that is a CA, or lacks digitalSignature, or carries keyCertSign, refuses", async () => {
    const ca = await makeCert({ issuer: root, isCA: true, keyUsage: 0x86 });
    expect(await validateClientCertificate(ca.der, { anchors: [root.der], now: now() })).toEqual({ ok: false, code: "certificate_leaf_ca" });
    const noDs = await makeCert({ issuer: root, keyUsage: 0x10 });
    expect(await validateClientCertificate(noDs.der, { anchors: [root.der], now: now() })).toEqual({ ok: false, code: "certificate_key_usage" });
    const signer = await makeCert({ issuer: root, keyUsage: 0x84 });
    expect(await validateClientCertificate(signer.der, { anchors: [root.der], now: now() })).toEqual({ ok: false, code: "certificate_key_usage" });
  });

  // ADR-0188 S5 review item 3: pkijs 3.4.1 does not enforce the issuer rules, and takes the LAST of `certs` as the
  // end entity, so a presented intermediate used to be judged instead of the leaf
  it("a leaf signed by a non-CA leaf (presented as the intermediate) is refused", async () => {
    const notCa = await makeCert({ issuer: root, name: "not-a-ca" });
    const leaf = await makeCert({ issuer: notCa, uris: [ID] });
    expect(await validateClientCertificate(leaf.der, { anchors: [root.der], presentedIntermediates: [notCa.der], now: now() })).toMatchObject({ ok: false });
    // the same, with the non-CA uploaded beside the anchor
    expect(await validateClientCertificate(leaf.der, { anchors: [root.der, notCa.der], now: now() })).toMatchObject({ ok: false });
  });

  it("an intermediate CA without keyCertSign is refused", async () => {
    const noSign = await makeCert({ issuer: root, isCA: true, keyUsage: 0x02, name: "ca-no-keycertsign" });
    const leaf = await makeCert({ issuer: noSign, uris: [ID] });
    expect(await validateClientCertificate(leaf.der, { anchors: [root.der], presentedIntermediates: [noSign.der], now: now() })).toMatchObject({ ok: false });
  });

  it("a pathLenConstraint violation is refused; the same chain within the constraint validates", async () => {
    const tight = await makeCert({ isCA: true, pathLen: 0, name: "root-pathlen-0" });
    const sub = await makeCert({ issuer: tight, isCA: true, name: "sub-under-pathlen-0" });
    const deep = await makeCert({ issuer: sub, uris: [ID] });
    expect(await validateClientCertificate(deep.der, { anchors: [tight.der], presentedIntermediates: [sub.der], now: now() })).toEqual({ ok: false, code: "certificate_issuer" });
    // positive control: a leaf directly under the pathLen-0 root, and the same depth under a pathLen-1 root
    const direct = await makeCert({ issuer: tight, uris: [ID] });
    expect((await validateClientCertificate(direct.der, { anchors: [tight.der], now: now() })).ok).toBe(true);
    const roomy = await makeCert({ isCA: true, pathLen: 1, name: "root-pathlen-1" });
    const sub1 = await makeCert({ issuer: roomy, isCA: true, name: "sub-under-pathlen-1" });
    const deep1 = await makeCert({ issuer: sub1, uris: [ID] });
    expect((await validateClientCertificate(deep1.der, { anchors: [roomy.der], presentedIntermediates: [sub1.der], now: now() })).ok).toBe(true);
  });

  it("a valid chain with a PRESENTED intermediate validates, and judges the leaf (a forged leaf beside a genuine intermediate refuses)", async () => {
    const leaf = await makeCert({ issuer: inter, uris: [ID] });
    expect((await validateClientCertificate(leaf.der, { anchors: [root.der], presentedIntermediates: [inter.der], now: now() })).ok).toBe(true);
    // a leaf that NAMES the intermediate as issuer but is signed by an attacker's key, presented with the real one
    const attacker = await makeCert({ isCA: true, name: "intermediate" });
    const forged = await makeCert({ issuer: attacker, uris: [ID] });
    expect(await validateClientCertificate(forged.der, { anchors: [root.der], presentedIntermediates: [inter.der], now: now() })).toMatchObject({ ok: false });
  });

  it("garbage is refused, never thrown", async () => {
    expect(await validateClientCertificate(Buffer.from("not a certificate"), { anchors: [root.der], now: now() })).toEqual({ ok: false, code: "certificate_malformed" });
  });
});

describe("decision 21 — the SPIFFE X.509-SVID profile", () => {
  it("exactly one spiffe:// URI SAN in THIS trust domain (positive control)", async () => {
    const leaf = await makeCert({ issuer: root, uris: [ID] });
    const r = await validateClientCertificate(leaf.der, { anchors: [root.der], now: now(), spiffeTrustDomain: TD });
    expect(r.ok && r.spiffeId).toBe(ID);
  });

  it("another trust domain, two URI SANs, no URI SAN, or a non-SPIFFE URI refuse", async () => {
    const other = await makeCert({ issuer: root, uris: [`spiffe://evil.example/regulait/agent/b`] });
    expect(await validateClientCertificate(other.der, { anchors: [root.der], now: now(), spiffeTrustDomain: TD })).toEqual({ ok: false, code: "spiffe_trust_domain" });
    const two = await makeCert({ issuer: root, uris: [ID, `${ID}-2`] });
    expect(await validateClientCertificate(two.der, { anchors: [root.der], now: now(), spiffeTrustDomain: TD })).toEqual({ ok: false, code: "spiffe_san" });
    const none = await makeCert({ issuer: root });
    expect(await validateClientCertificate(none.der, { anchors: [root.der], now: now(), spiffeTrustDomain: TD })).toEqual({ ok: false, code: "spiffe_san" });
    const https = await makeCert({ issuer: root, uris: ["https://example.org/agent"] });
    expect(await validateClientCertificate(https.der, { anchors: [root.der], now: now(), spiffeTrustDomain: TD })).toEqual({ ok: false, code: "spiffe_profile" });
  });

  it("SPIFFE IDs are parsed with URL: userinfo, port, query and fragment are refused", () => {
    expect(spiffeIdParts(ID)).toEqual({ trustDomain: TD });
    for (const bad of [`spiffe://u@${TD}/a`, `spiffe://${TD}:8443/a`, `spiffe://${TD}/a?x=1`, `spiffe://${TD}/a#f`, `spiffe://${TD}`, `spiffe://${TD}/`, "spiffe:///a"]) {
      expect(spiffeIdParts(bad), bad).toBeNull();
    }
  });
});

describe("decision 21 — self-signed and bundles", () => {
  it("a self-signed certificate is matched by thumbprint only, inside its window", async () => {
    const self = await makeCert({});
    expect(selfSignedCertificateFacts(self.der, now())).toEqual({ ok: true, thumbprint: certificateThumbprint(self.der) });
    const old = await makeCert({ notBefore: new Date(Date.now() - 7200_000), notAfter: new Date(Date.now() - 60_000) });
    expect(selfSignedCertificateFacts(old.der, now()).ok).toBe(false);
  });

  it("PEM bundles and the SPIFFE bundle map parse; a malformed bundle throws (fail closed)", () => {
    expect(pemBundleToDer(`${root.pem}${inter.pem}`)).toHaveLength(2);
    const cfg = loadTrustConfig({ [MTLS_CA_BUNDLE_ENV]: root.pem, [SPIFFE_TRUST_BUNDLES_ENV]: JSON.stringify({ [TD]: root.pem }) });
    expect(cfg.mtlsCa).toHaveLength(1);
    expect(cfg.spiffe.get(TD)).toHaveLength(1);
    expect(loadTrustConfig({})).toEqual({ mtlsCa: [], spiffe: new Map() });
    expect(() => loadTrustConfig({ [SPIFFE_TRUST_BUNDLES_ENV]: "[1]" })).toThrow();
    expect(() => loadTrustConfig({ [SPIFFE_TRUST_BUNDLES_ENV]: JSON.stringify({ "Bad Domain": root.pem }) })).toThrow();
  });
});

describe("decision 21 — forwarded certificates: trusted peer AND authenticated proxy, else stripped", () => {
  const SECRET = "proxy-secret-".padEnd(48, "x");
  const env: NodeJS.ProcessEnv = {};
  const app = Fastify();
  let leaf: TestCert;
  beforeAll(async () => {
    leaf = await makeCert({ issuer: root });
    registerClientCertificateHook(app, env);
    app.get("/probe", async (req) => {
      const p = presentedClientCertificate(req);
      return { presented: p ? certificateThumbprint(p.der) : null, headerSeen: req.headers["x-client-cert"] ?? null, secretSeen: req.headers[CLIENT_CERT_PROXY_SECRET_HEADER] ?? null };
    });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });
  const probe = (headers: Record<string, string>, remoteAddress = "127.0.0.1") => app.inject({ method: "GET", url: "/probe", headers, remoteAddress }).then((r) => r.json());

  it("off by default: the header is ignored and stripped", async () => {
    for (const k of Object.keys(env)) delete env[k];
    const r = await probe({ "x-client-cert": leaf.der.toString("base64"), [CLIENT_CERT_PROXY_SECRET_HEADER]: SECRET });
    // with no configured header name, nothing is read; the secret header is always stripped
    expect(r).toMatchObject({ presented: null, secretSeen: null });
  });

  it("configured, trusted peer, correct secret → admitted (positive control), and the raw header is still stripped", async () => {
    Object.assign(env, { [CLIENT_CERT_HEADER_ENV]: "x-client-cert", [CLIENT_CERT_PROXY_SECRET_ENV]: SECRET, REGULAIT_TRUSTED_PROXIES: "127.0.0.1" });
    const r = await probe({ "x-client-cert": leaf.der.toString("base64"), [CLIENT_CERT_PROXY_SECRET_HEADER]: SECRET });
    expect(r).toEqual({ presented: certificateThumbprint(leaf.der), headerSeen: null, secretSeen: null });
    const pem = await probe({ "x-client-cert": encodeURIComponent(leaf.pem), [CLIENT_CERT_PROXY_SECRET_HEADER]: SECRET });
    expect(pem.presented).toBe(certificateThumbprint(leaf.der));
  });

  it("a forged header: untrusted peer, missing secret, or wrong secret → not admitted, stripped", async () => {
    Object.assign(env, { [CLIENT_CERT_HEADER_ENV]: "x-client-cert", [CLIENT_CERT_PROXY_SECRET_ENV]: SECRET, REGULAIT_TRUSTED_PROXIES: "127.0.0.1" });
    const cert = leaf.der.toString("base64");
    expect(await probe({ "x-client-cert": cert, [CLIENT_CERT_PROXY_SECRET_HEADER]: SECRET }, "10.9.9.9")).toEqual({ presented: null, headerSeen: null, secretSeen: null });
    expect(await probe({ "x-client-cert": cert })).toEqual({ presented: null, headerSeen: null, secretSeen: null });
    expect(await probe({ "x-client-cert": cert, [CLIENT_CERT_PROXY_SECRET_HEADER]: SECRET.replace("x", "y") })).toEqual({ presented: null, headerSeen: null, secretSeen: null });
    // a trusted-proxies list that does not name the peer
    Object.assign(env, { REGULAIT_TRUSTED_PROXIES: "10.0.0.0/8" });
    expect((await probe({ "x-client-cert": cert, [CLIENT_CERT_PROXY_SECRET_HEADER]: SECRET })).presented).toBeNull();
    // a CIDR that does
    Object.assign(env, { REGULAIT_TRUSTED_PROXIES: "127.0.0.0/8" });
    expect((await probe({ "x-client-cert": cert, [CLIENT_CERT_PROXY_SECRET_HEADER]: SECRET })).presented).toBe(certificateThumbprint(leaf.der));
  });

  it("proxy-to-gateway mTLS: the proxy's own TLS certificate is never the client's; the forwarded one is (S5 review item 4)", async () => {
    // a second app whose socket looks like a TLS connection from the proxy, authenticated by its own certificate
    const proxyCert = await makeCert({ issuer: root, name: "the-proxy" });
    const penv: NodeJS.ProcessEnv = { [CLIENT_CERT_HEADER_ENV]: "x-client-cert", REGULAIT_TRUSTED_PROXIES: "127.0.0.1" };
    const tlsApp = Fastify();
    tlsApp.addHook("onRequest", async (req) => {
      Object.assign(req.raw.socket, {
        encrypted: true,
        authorized: true,
        getPeerCertificate: () => ({ raw: proxyCert.der, fingerprint256: "proxy", issuerCertificate: undefined }),
      });
    });
    registerClientCertificateHook(tlsApp, penv);
    tlsApp.get("/probe", async (req) => {
      const p = presentedClientCertificate(req);
      return { presented: p ? certificateThumbprint(p.der) : null, source: p?.source ?? null };
    });
    await tlsApp.ready();
    try {
      const get = (headers: Record<string, string>, remoteAddress = "127.0.0.1") => tlsApp.inject({ method: "GET", url: "/probe", headers, remoteAddress }).then((r) => r.json());
      // an admitted proxy (trusted address, authenticated by mTLS) forwarding the client's certificate → the client's
      expect(await get({ "x-client-cert": leaf.der.toString("base64") })).toEqual({ presented: certificateThumbprint(leaf.der), source: "proxy" });
      // the same proxy forwarding nothing → no client certificate at all, never the proxy's own
      expect(await get({})).toEqual({ presented: null, source: null });
      // a direct TLS client (not a trusted proxy address): its own peer certificate, and a forged header is ignored
      expect(await get({ "x-client-cert": leaf.der.toString("base64") }, "10.9.9.9")).toEqual({ presented: certificateThumbprint(proxyCert.der), source: "tls" });
    } finally {
      await tlsApp.close();
    }
  });

  it("a short shared secret is not a secret: the proxy cannot authenticate with it", async () => {
    Object.assign(env, { [CLIENT_CERT_HEADER_ENV]: "x-client-cert", [CLIENT_CERT_PROXY_SECRET_ENV]: "short", REGULAIT_TRUSTED_PROXIES: "127.0.0.1" });
    expect((await probe({ "x-client-cert": leaf.der.toString("base64"), [CLIENT_CERT_PROXY_SECRET_HEADER]: "short" })).presented).toBeNull();
  });
});
