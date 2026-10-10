/**
 * ADR-0188 decision 21 (slice S5) — X.509 PATH VALIDATION, THE SPIFFE
 * X.509-SVID PROFILE, AND FORWARDED CLIENT CERTIFICATES.
 *
 * S3's mTLS branch compares a certificate's SHA-256 thumbprint with the token's
 * `cnf.x5t#S256` and nothing else (ADR-0188 "Amendments from the S3 build",
 * item 3). No route may hand a client certificate to that verifier, or to the
 * token endpoint's client authentication, until the certificate has passed
 * THIS module. Two termination modes, one validator:
 *
 *  - DIRECT TLS: the peer chain of a TLS socket the gateway terminated.
 *  - BEHIND A PROXY: one configured header (`REGULAIT_CLIENT_CERT_HEADER`, off
 *    by default), honoured only when the socket peer is a trusted proxy
 *    (`REGULAIT_TRUSTED_PROXIES`, ADR-0031) AND the proxy authenticates itself
 *    to the gateway (mTLS between proxy and gateway, or the shared secret in
 *    `REGULAIT_CLIENT_CERT_PROXY_SECRET`, compared with `constantTimeEqual`).
 *    A request that does not meet all three has the header STRIPPED before any
 *    route sees it (`stripUntrustedClientCertHeader`, an onRequest hook). A
 *    forwarded certificate is then validated here, never trusted as verified.
 *
 * Validation: `pkijs` 3.4.1 `CertificateChainValidationEngine` (signatures,
 * validity of every certificate on the path at `now`, CA flags and
 * `keyCertSign` on issuers) against LOCAL trust anchors only — the mTLS CA set
 * (`REGULAIT_MTLS_CA_BUNDLE`) or the SPIFFE bundle of the ID's trust domain
 * (`REGULAIT_SPIFFE_TRUST_BUNDLES`). Both default to EMPTY: with no anchors
 * every chain is refused (secure by default, ADR-0180; S9 moves bundles into
 * managed, audited storage). Nothing is fetched: no AIA, no CRL, no OCSP.
 * Then OUR profile: the leaf is not a CA, carries `digitalSignature` and
 * neither `keyCertSign` nor `cRLSign`; for SPIFFE exactly one URI SAN, a
 * `spiffe://` ID in the anchor's trust domain with no userinfo, port, query or
 * fragment (parsed with `URL`, never a regular expression on caller input).
 * Revocation is our own tables (`workload_credentials.revoked_at`), checked by
 * the caller against the matched credential row.
 *
 * Open source first (ADR-0176): `pkijs`/`asn1js` (already pinned) and Node's
 * own `X509Certificate`/`BlockList`; what is ours is exactly the SPIFFE profile
 * and the forwarded-header admission rules of decision 21.
 */
import { BlockList, isIP } from "node:net";
import { createHash, X509Certificate } from "node:crypto";
import type { TLSSocket } from "node:tls";
import * as asn1js from "asn1js";
import { BitString } from "asn1js";
import { Certificate, CertificateChainValidationEngine, GeneralNames } from "pkijs";
import { constantTimeEqual, SPIFFE_TRUST_DOMAIN_PATTERN } from "@regulait/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { resolveTrustProxy, type TrustProxySetting } from "../trusted-proxy.js";

/** deploy-time configuration (decision 21; every one unset by default) */
export const CLIENT_CERT_HEADER_ENV = "REGULAIT_CLIENT_CERT_HEADER";
export const CLIENT_CERT_PROXY_SECRET_ENV = "REGULAIT_CLIENT_CERT_PROXY_SECRET";
/** the header a proxy proves itself with when it cannot use mTLS to the gateway */
export const CLIENT_CERT_PROXY_SECRET_HEADER = "x-regulait-proxy-auth";
export const MTLS_CA_BUNDLE_ENV = "REGULAIT_MTLS_CA_BUNDLE";
export const SPIFFE_TRUST_BUNDLES_ENV = "REGULAIT_SPIFFE_TRUST_BUNDLES";

const MAX_CERT_BYTES = 16 * 1024;
const MAX_BUNDLE_CERTS = 64;

// ---------------------------------------------------------------------------
// Parsing (Node's X509Certificate does the PEM/DER work)
// ---------------------------------------------------------------------------

const PEM_END = "-----END CERTIFICATE-----";

/** every certificate of a PEM bundle, as DER. Splitting on the END marker is a plain string scan. */
export function pemBundleToDer(pem: string): Buffer[] {
  const out: Buffer[] = [];
  for (const piece of pem.split(PEM_END)) {
    if (!piece.includes("-----BEGIN CERTIFICATE-----")) continue;
    if (out.length >= MAX_BUNDLE_CERTS) throw new Error("certificate bundle: too many certificates");
    out.push(Buffer.from(new X509Certificate(`${piece.slice(piece.indexOf("-----BEGIN CERTIFICATE-----"))}${PEM_END}\n`).raw));
  }
  return out;
}

export const certificateThumbprint = (der: Uint8Array) => createHash("sha256").update(der).digest("base64url");

function parsePkijs(der: Uint8Array): Certificate {
  const asn = asn1js.fromBER(new Uint8Array(der));
  if (asn.offset === -1) throw new Error("certificate: not DER");
  return new Certificate({ schema: asn.result });
}

// ---------------------------------------------------------------------------
// Trust configuration
// ---------------------------------------------------------------------------

export interface TrustConfig {
  /** anchors (and intermediates) for plain `tls_client_auth` */
  mtlsCa: Buffer[];
  /** SPIFFE trust domain → its bundle (anchors and intermediates) */
  spiffe: Map<string, Buffer[]>;
}

/**
 * Read the anchors from the environment, at the point of use (like the deploy
 * mode). A bundle that is set but unparsable throws: fail closed, the caller
 * refuses the request.
 */
export function loadTrustConfig(env: NodeJS.ProcessEnv = process.env): TrustConfig {
  const mtls = env[MTLS_CA_BUNDLE_ENV];
  const spiffeRaw = env[SPIFFE_TRUST_BUNDLES_ENV];
  const spiffe = new Map<string, Buffer[]>();
  if (spiffeRaw && spiffeRaw.trim() !== "") {
    const parsed: unknown = JSON.parse(spiffeRaw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${SPIFFE_TRUST_BUNDLES_ENV}: a JSON object of trust domain → PEM`);
    for (const [domain, pem] of Object.entries(parsed as Record<string, unknown>)) {
      if (!SPIFFE_TRUST_DOMAIN_PATTERN.test(domain) || typeof pem !== "string") throw new Error(`${SPIFFE_TRUST_BUNDLES_ENV}: bad entry`);
      spiffe.set(domain, pemBundleToDer(pem));
    }
  }
  return { mtlsCa: mtls && mtls.trim() !== "" ? pemBundleToDer(mtls) : [], spiffe };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export type CertificateFailure =
  | "certificate_malformed"
  | "certificate_no_anchor"
  | "certificate_path"
  | "certificate_time"
  | "certificate_leaf_ca"
  | "certificate_key_usage"
  | "spiffe_san"
  | "spiffe_profile"
  | "spiffe_trust_domain";

export type CertificateCheck =
  | { ok: true; der: Buffer; thumbprint: string; spiffeId: string | null; uriSans: string[]; subjectDn: string }
  | { ok: false; code: CertificateFailure };

const KU_DIGITAL_SIGNATURE = 0x80;
const KU_KEY_CERT_SIGN = 0x04;
const KU_CRL_SIGN = 0x02;

function keyUsageByte(cert: Certificate): number | null {
  const ext = cert.extensions?.find((e) => e.extnID === "2.5.29.15");
  if (!ext) return null;
  const parsed = ext.parsedValue instanceof BitString ? ext.parsedValue : (asn1js.fromBER(ext.extnValue.valueBlock.valueHexView).result as BitString);
  const bytes = parsed?.valueBlock?.valueHexView;
  return bytes && bytes.length > 0 ? bytes[0]! : null;
}

function uriSansOf(cert: Certificate): string[] {
  const ext = cert.extensions?.find((e) => e.extnID === "2.5.29.17");
  if (!ext) return [];
  const names = ext.parsedValue instanceof GeneralNames ? ext.parsedValue : new GeneralNames({ schema: asn1js.fromBER(ext.extnValue.valueBlock.valueHexView).result });
  return names.names.filter((n) => n.type === 6).map((n) => String(n.value));
}

/** a SPIFFE ID, by the X.509-SVID rules, parsed with `URL` */
export function spiffeIdParts(value: string): { trustDomain: string } | null {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return null;
  }
  if (u.protocol !== "spiffe:" || u.username || u.password || u.port || u.search || u.hash || value.includes("?") || value.includes("#")) return null;
  if (!SPIFFE_TRUST_DOMAIN_PATTERN.test(u.hostname) || u.pathname === "" || u.pathname === "/") return null;
  return { trustDomain: u.hostname };
}

/**
 * Validate `leafDer` (plus any `presentedIntermediates`) against `anchors` at
 * `now`, then the leaf profile; with `spiffe`, also the X.509-SVID profile
 * against exactly that trust domain. Never throws; refuses with a code.
 */
export async function validateClientCertificate(
  leafDer: Uint8Array,
  opts: { anchors: readonly Uint8Array[]; presentedIntermediates?: readonly Uint8Array[]; now: Date; spiffeTrustDomain?: string },
): Promise<CertificateCheck> {
  if (!leafDer || leafDer.length === 0 || leafDer.length > MAX_CERT_BYTES) return { ok: false, code: "certificate_malformed" };
  if (opts.anchors.length === 0) return { ok: false, code: "certificate_no_anchor" };
  let leaf: Certificate;
  let anchors: Certificate[];
  let intermediates: Certificate[];
  try {
    leaf = parsePkijs(leafDer);
    anchors = opts.anchors.map(parsePkijs);
    intermediates = (opts.presentedIntermediates ?? []).slice(0, 8).map(parsePkijs);
  } catch {
    return { ok: false, code: "certificate_malformed" };
  }
  // the path, every certificate's validity at `now`, and issuer CA/keyCertSign rules
  try {
    const engine = new CertificateChainValidationEngine({ trustedCerts: anchors, certs: [leaf, ...intermediates, ...anchors], checkDate: opts.now });
    const r = await engine.verify();
    if (!r.result) return { ok: false, code: "certificate_path" };
  } catch {
    return { ok: false, code: "certificate_path" };
  }
  if (leaf.notBefore.value.getTime() > opts.now.getTime() || leaf.notAfter.value.getTime() < opts.now.getTime()) return { ok: false, code: "certificate_time" };
  const basic = leaf.extensions?.find((e) => e.extnID === "2.5.29.19")?.parsedValue as { cA?: boolean } | undefined;
  if (basic?.cA) return { ok: false, code: "certificate_leaf_ca" };
  const ku = keyUsageByte(leaf);
  if (ku === null || !(ku & KU_DIGITAL_SIGNATURE) || ku & KU_KEY_CERT_SIGN || ku & KU_CRL_SIGN) return { ok: false, code: "certificate_key_usage" };
  let uris: string[];
  try {
    uris = uriSansOf(leaf);
  } catch {
    return { ok: false, code: "certificate_malformed" };
  }
  let spiffeId: string | null = null;
  if (opts.spiffeTrustDomain !== undefined) {
    // X.509-SVID: exactly one URI SAN, and it is a SPIFFE ID in THIS trust domain
    if (uris.length !== 1) return { ok: false, code: "spiffe_san" };
    const parts = spiffeIdParts(uris[0]!);
    if (!parts) return { ok: false, code: "spiffe_profile" };
    if (parts.trustDomain !== opts.spiffeTrustDomain) return { ok: false, code: "spiffe_trust_domain" };
    spiffeId = uris[0]!;
  }
  const der = Buffer.from(leafDer);
  return { ok: true, der, thumbprint: certificateThumbprint(der), spiffeId, uriSans: uris, subjectDn: new X509Certificate(der).subject };
}

/** `self_signed_tls_client_auth`: no chain, but a parsable certificate inside its validity window */
export function selfSignedCertificateFacts(leafDer: Uint8Array, now: Date): { ok: true; thumbprint: string } | { ok: false; code: CertificateFailure } {
  try {
    const c = new X509Certificate(Buffer.from(leafDer));
    if (new Date(c.validFrom).getTime() > now.getTime() || new Date(c.validTo).getTime() < now.getTime()) return { ok: false, code: "certificate_time" };
    return { ok: true, thumbprint: certificateThumbprint(leafDer) };
  } catch {
    return { ok: false, code: "certificate_malformed" };
  }
}

// ---------------------------------------------------------------------------
// Where a client certificate may come from (decision 21)
// ---------------------------------------------------------------------------

export interface PresentedCertificate {
  der: Buffer;
  intermediates: Buffer[];
  source: "tls" | "proxy";
}

interface ProxyConfig {
  header: string | null;
  secret: string | null;
  trust: TrustProxySetting;
}

function proxyConfig(env: NodeJS.ProcessEnv): ProxyConfig {
  const h = env[CLIENT_CERT_HEADER_ENV]?.trim().toLowerCase();
  const s = env[CLIENT_CERT_PROXY_SECRET_ENV];
  return { header: h ? h : null, secret: s && s.length >= 32 ? s : null, trust: resolveTrustProxy(env) };
}

function peerIsTrustedProxy(remote: string | undefined, trust: TrustProxySetting): boolean {
  if (!remote || trust === false) return false;
  if (trust === true) return true;
  const list = new BlockList();
  const addr = remote.startsWith("::ffff:") && isIP(remote.slice(7)) === 4 ? remote.slice(7) : remote;
  const family = isIP(addr) === 6 ? "ipv6" : "ipv4";
  for (const entry of trust) {
    const slash = entry.indexOf("/");
    const ip = slash === -1 ? entry : entry.slice(0, slash);
    const kind = isIP(ip);
    if (kind === 0) {
      if (entry === "loopback") {
        list.addSubnet("127.0.0.0", 8, "ipv4");
        list.addAddress("::1", "ipv6");
      }
      continue;
    }
    const fam = kind === 6 ? "ipv6" : "ipv4";
    if (slash === -1) list.addAddress(ip, fam);
    else {
      const prefix = Number(entry.slice(slash + 1));
      if (Number.isInteger(prefix)) list.addSubnet(ip, prefix, fam);
    }
  }
  try {
    return list.check(addr, family);
  } catch {
    return false;
  }
}

const socketOf = (req: FastifyRequest) => req.raw.socket as Partial<TLSSocket> & { remoteAddress?: string };

/** does this request's proxy meet decision 21 (trusted peer AND authenticated)? */
function proxyAdmitted(req: FastifyRequest, cfg: ProxyConfig): boolean {
  if (!cfg.header) return false;
  const sock = socketOf(req);
  if (!peerIsTrustedProxy(sock.remoteAddress, cfg.trust)) return false;
  // the proxy authenticated to us: mTLS between proxy and gateway, or the shared secret (constant time)
  if (sock.encrypted && sock.authorized === true) return true;
  const presented = req.headers[CLIENT_CERT_PROXY_SECRET_HEADER];
  return cfg.secret !== null && typeof presented === "string" && constantTimeEqual(presented, cfg.secret);
}

const forwardedCerts = new WeakMap<object, PresentedCertificate | null>();

/** decode a forwarded certificate value: URL-encoded PEM, or base64 / base64url DER. Node parses it. */
function decodeForwarded(value: string): Buffer | null {
  if (value.length === 0 || value.length > MAX_CERT_BYTES * 2) return null;
  try {
    const text = value.startsWith("-----BEGIN") ? value : value.startsWith("%2D") || value.startsWith("%2d") ? decodeURIComponent(value) : null;
    if (text !== null) return Buffer.from(new X509Certificate(text).raw);
    const der = Buffer.from(value, value.includes("-") || value.includes("_") ? "base64url" : "base64");
    return Buffer.from(new X509Certificate(der).raw);
  } catch {
    return null;
  }
}

/**
 * onRequest: read (and then remove) the forwarded certificate header and the
 * proxy secret header on EVERY request. Only an admitted proxy's value is kept,
 * and only in a private map; no route can read either header afterwards.
 */
export function registerClientCertificateHook(app: FastifyInstance, env: NodeJS.ProcessEnv = process.env): void {
  app.addHook("onRequest", async (req) => {
    const cfg = proxyConfig(env);
    let presented: PresentedCertificate | null = null;
    if (cfg.header) {
      const raw = req.headers[cfg.header];
      if (typeof raw === "string" && proxyAdmitted(req, cfg)) {
        const der = decodeForwarded(raw);
        if (der) presented = { der, intermediates: [], source: "proxy" };
      }
      delete req.headers[cfg.header];
    }
    delete req.headers[CLIENT_CERT_PROXY_SECRET_HEADER];
    forwardedCerts.set(req.raw, presented);
  });
}

/**
 * The client certificate this request presents, from the gateway's own TLS
 * termination or an admitted proxy — NOT yet validated (call
 * `validateClientCertificate`). Null when there is none.
 */
export function presentedClientCertificate(req: FastifyRequest): PresentedCertificate | null {
  const sock = socketOf(req);
  if (sock.encrypted && typeof sock.getPeerCertificate === "function") {
    const peer = sock.getPeerCertificate(true);
    if (peer && peer.raw && peer.raw.length > 0) {
      const intermediates: Buffer[] = [];
      let cur = peer.issuerCertificate;
      const seen = new Set([peer.fingerprint256]);
      while (cur && cur.raw && !seen.has(cur.fingerprint256) && intermediates.length < 8) {
        seen.add(cur.fingerprint256);
        intermediates.push(Buffer.from(cur.raw));
        cur = cur.issuerCertificate;
      }
      return { der: Buffer.from(peer.raw), intermediates, source: "tls" };
    }
  }
  return forwardedCerts.get(req.raw) ?? null;
}
