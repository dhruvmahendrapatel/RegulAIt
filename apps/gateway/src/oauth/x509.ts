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
 * Validation: `pkijs` 3.4.1 `CertificateChainValidationEngine` builds the path
 * and checks its signatures and the validity of every certificate on it at
 * `now`, against LOCAL trust anchors only — the mTLS CA set
 * (`REGULAIT_MTLS_CA_BUNDLE`) or the SPIFFE bundle of the ID's trust domain
 * (ADR-0188 S9: the `spiffe_trust_bundles` table, uploaded through the audited
 * admin route in `spiffe-bundles.ts`; the S5 environment variable is ignored).
 * Both default to EMPTY: with no anchors every chain is refused (secure by
 * default, ADR-0180). Nothing is fetched: no AIA, no CRL, no OCSP.
 * The engine does NOT enforce the issuer rules (S5 security review, ADR-0188
 * amendments item 3), and it takes the LAST certificate of `certs` as the
 * end entity, so OUR code passes the leaf last, requires the built path to
 * start at that leaf, and requires every issuer on it (intermediates and the
 * anchor) to be a CA (`basicConstraints.cA`), to carry `keyCertSign`, and to
 * have a `pathLenConstraint`, when present, no smaller than the number of
 * intermediates below it (`issuerRulesFailure`).
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
import { AltName, AuthorityKeyIdentifier, BasicConstraints, Certificate, CertificateChainValidationEngine, ExtKeyUsage, GeneralNames } from "pkijs";
import { constantTimeEqual, SPIFFE_TRUST_DOMAIN_PATTERN } from "@regulait/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { resolveTrustProxy, type TrustProxySetting } from "../trusted-proxy.js";

/** deploy-time configuration (decision 21; every one unset by default) */
export const CLIENT_CERT_HEADER_ENV = "REGULAIT_CLIENT_CERT_HEADER";
export const CLIENT_CERT_PROXY_SECRET_ENV = "REGULAIT_CLIENT_CERT_PROXY_SECRET";
/** the header a proxy proves itself with when it cannot use mTLS to the gateway */
export const CLIENT_CERT_PROXY_SECRET_HEADER = "x-regulait-proxy-auth";
export const MTLS_CA_BUNDLE_ENV = "REGULAIT_MTLS_CA_BUNDLE";

const MAX_CERT_BYTES = 16 * 1024;
const MAX_BUNDLE_CERTS = 64;

// ---------------------------------------------------------------------------
// Parsing (Node's X509Certificate does the PEM/DER work)
// ---------------------------------------------------------------------------

const PEM_END = "-----END CERTIFICATE-----";

/** #389 review L4: a PEM block that is not a certificate (a key, a CRL, a CSR, …) in what must be certificates only */
export class PemNotCertificateError extends Error {
  constructor(readonly label: string) {
    super(`PEM bundle: a "${label}" block where only CERTIFICATE blocks are allowed`);
    this.name = "PemNotCertificateError";
  }
}

const PEM_BEGIN_PREFIX = "-----BEGIN ";
const PEM_BEGIN_CERT = "-----BEGIN CERTIFICATE-----";

/**
 * every certificate of a PEM bundle, as DER. Splitting on the END marker is a plain string scan. Any `-----BEGIN`
 * block other than CERTIFICATE is refused (`PemNotCertificateError`), never silently skipped (#389 review L4).
 */
export function pemBundleToDer(pem: string): Buffer[] {
  for (let at = pem.indexOf(PEM_BEGIN_PREFIX); at !== -1; at = pem.indexOf(PEM_BEGIN_PREFIX, at + PEM_BEGIN_PREFIX.length)) {
    if (!pem.startsWith(PEM_BEGIN_CERT, at)) {
      const end = pem.indexOf("-----", at + PEM_BEGIN_PREFIX.length);
      throw new PemNotCertificateError(end === -1 ? "unterminated" : pem.slice(at + PEM_BEGIN_PREFIX.length, Math.min(end, at + PEM_BEGIN_PREFIX.length + 40)));
    }
  }
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
  /** SPIFFE trust domain → its ACTIVE bundle's authorities (ADR-0188 S9: `spiffe_trust_bundles`) */
  spiffe: Map<string, { bundleId: string; authorities: Buffer[] }>;
}

/**
 * The mTLS CA set from the environment, at the point of use (like the deploy
 * mode). A bundle that is set but unparsable throws: fail closed, the caller
 * refuses the request. SPIFFE bundles are NOT read from the environment any
 * more (ADR-0188 S9): `loadSpiffeTrustAnchors` in `spiffe-bundles.ts` reads
 * the active rows of `spiffe_trust_bundles`.
 */
export function loadMtlsCaBundle(env: NodeJS.ProcessEnv = process.env): Buffer[] {
  const mtls = env[MTLS_CA_BUNDLE_ENV];
  return mtls && mtls.trim() !== "" ? pemBundleToDer(mtls) : [];
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export type CertificateFailure =
  | "certificate_malformed"
  | "certificate_no_anchor"
  | "certificate_path"
  | "certificate_issuer"
  | "certificate_extension"
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

/** S6 (credential registration): a certificate's URI SANs, read with the same parser the validator uses; throws on bad DER */
export function certificateUriSans(der: Uint8Array): string[] {
  return uriSansOf(parsePkijs(der));
}

/**
 * ADR-0188 S9 (bundle upload): may this certificate be a trust anchor? It must
 * be a CA (`basicConstraints.cA`) carrying `keyCertSign`: the rule
 * `issuerRulesFailure` applies to every anchor at validation, checked at upload
 * too so a bundle that could never validate anything is refused. Throws on bad DER.
 */
export function certificateIsAuthority(der: Uint8Array): boolean {
  const cert = parsePkijs(der);
  const bc = cert.extensions?.find((e) => e.extnID === "2.5.29.19")?.parsedValue as { cA?: boolean } | undefined;
  const ku = keyUsageByte(cert);
  return bc?.cA === true && ku !== null && (ku & KU_KEY_CERT_SIGN) !== 0;
}

const sameCertificate = (a: Certificate, b: Certificate) => Buffer.from(a.tbsView).equals(Buffer.from(b.tbsView));

/**
 * The issuer rules `pkijs` does not enforce (ADR-0188 S5 review item 3), over
 * the path the engine built: `path[0]` is the end entity, the last entry the
 * anchor. Every issuer (index ≥ 1) is a CA, carries `keyCertSign`, and its
 * `pathLenConstraint`, when present, allows the intermediates below it
 * (index − 1 of them: the leaf is not counted). Null when the path holds.
 */
export function issuerRulesFailure(path: readonly Certificate[]): string | null {
  for (let i = 1; i < path.length; i++) {
    const cert = path[i]!;
    const bcExt = cert.extensions?.find((e) => e.extnID === "2.5.29.19");
    const bc = bcExt?.parsedValue as { cA?: boolean; pathLenConstraint?: unknown } | undefined;
    if (!bc || bc.cA !== true) return `issuer ${i} is not a CA`;
    const ku = keyUsageByte(cert);
    if (ku === null || !(ku & KU_KEY_CERT_SIGN)) return `issuer ${i} lacks keyCertSign`;
    if ("pathLenConstraint" in bc && bc.pathLenConstraint !== undefined) {
      // a hex-only (huge or malformed) INTEGER is not a number we can trust: refuse
      if (typeof bc.pathLenConstraint !== "number" || !Number.isInteger(bc.pathLenConstraint) || bc.pathLenConstraint < 0) return `issuer ${i} has an unreadable pathLenConstraint`;
      if (i - 1 > bc.pathLenConstraint) return `issuer ${i} allows ${bc.pathLenConstraint} intermediates below it, the path has ${i - 1}`;
    }
  }
  return null;
}

/**
 * The critical extensions a client certificate (the leaf) may carry: the ones this validator, or the TLS profile it
 * stands on, processes. Anything else marked critical is refused (RFC 5280 §4.2), and so is an allowed one that pkijs
 * could not parse.
 */
export const LEAF_CRITICAL_EXTENSIONS_ALLOWED: ReadonlySet<string> = new Set([
  "2.5.29.19", // basicConstraints
  "2.5.29.15", // keyUsage
  "2.5.29.37", // extKeyUsage
  "2.5.29.17", // subjectAltName
  "2.5.29.14", // subjectKeyIdentifier
  "2.5.29.35", // authorityKeyIdentifier
]);

/**
 * Does this allowed extension's value parse as its own ASN.1 type, consuming every byte? pkijs's lazy `parsedValue`
 * swallows a schema mismatch and hands back an empty default object, so it cannot answer this; the type constructors
 * called directly with `{ schema }` throw on a mismatch.
 */
function allowedExtensionParses(oid: string, value: Uint8Array): boolean {
  const asn = asn1js.fromBER(value);
  if (asn.offset === -1 || asn.offset !== value.byteLength) return false;
  try {
    switch (oid) {
      case "2.5.29.19":
        new BasicConstraints({ schema: asn.result });
        return true;
      case "2.5.29.37":
        new ExtKeyUsage({ schema: asn.result });
        return true;
      case "2.5.29.17":
        new AltName({ schema: asn.result });
        return true;
      case "2.5.29.35":
        new AuthorityKeyIdentifier({ schema: asn.result });
        return true;
      case "2.5.29.15":
        return asn.result instanceof BitString;
      case "2.5.29.14":
        return asn.result instanceof asn1js.OctetString;
      default:
        return false;
    }
  } catch {
    return false;
  }
}

/** true when the leaf carries a critical extension outside the allow-list, or an allowed one that does not parse */
export function leafCriticalExtensionFailure(leaf: Certificate): boolean {
  for (const e of leaf.extensions ?? []) {
    if (e.critical !== true) continue;
    if (!LEAF_CRITICAL_EXTENSIONS_ALLOWED.has(e.extnID)) return true;
    if (!allowedExtensionParses(e.extnID, e.extnValue.valueBlock.valueHexView)) return true;
  }
  return false;
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
  // the engine: the path, its signatures and every certificate's validity at `now`. It treats the LAST of `certs`
  // as the end entity, so the leaf goes last (the anchors are already its `trustedCerts`)
  let path: Certificate[];
  try {
    const engine = new CertificateChainValidationEngine({ trustedCerts: anchors, certs: [...intermediates, leaf], checkDate: opts.now });
    const r = await engine.verify();
    if (!r.result || !r.certificatePath || r.certificatePath.length < 2) return { ok: false, code: "certificate_path" };
    path = r.certificatePath;
  } catch {
    return { ok: false, code: "certificate_path" };
  }
  // the path the engine judged must be THIS leaf's, and every issuer on it must be a CA (pkijs does not enforce it)
  if (!sameCertificate(path[0]!, leaf)) return { ok: false, code: "certificate_path" };
  if (issuerRulesFailure(path) !== null) return { ok: false, code: "certificate_issuer" };
  // #389 review M2: pkijs does not judge the end entity's critical extensions (it skips path index 0). RFC 5280
  // §4.2: a certificate with a critical extension the relying party does not process must be rejected
  if (leafCriticalExtensionFailure(leaf)) return { ok: false, code: "certificate_extension" };
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

/** per request: was the socket peer an ADMITTED proxy, and what client certificate did it forward (if any) */
const forwardedCerts = new WeakMap<object, { viaProxy: boolean; presented: PresentedCertificate | null }>();

/** decode a forwarded certificate value: URL-encoded PEM, or base64 / base64url DER. Node parses it. */
function decodeForwarded(value: string): Buffer | null {
  if (value.length === 0 || value.length > MAX_CERT_BYTES * 2) return null;
  try {
    // URL-encoded PEM (nginx `$ssl_client_escaped_cert`): "-" is unreserved, so it may or may not be escaped
    const decoded = value.includes("%") ? decodeURIComponent(value) : value;
    const text = decoded.startsWith("-----BEGIN") ? decoded : null;
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
    // judged before the headers are stripped: the shared secret is one of them
    const viaProxy = proxyAdmitted(req, cfg);
    if (cfg.header) {
      const raw = req.headers[cfg.header];
      if (typeof raw === "string" && viaProxy) {
        const der = decodeForwarded(raw);
        if (der) presented = { der, intermediates: [], source: "proxy" };
      }
      delete req.headers[cfg.header];
    }
    delete req.headers[CLIENT_CERT_PROXY_SECRET_HEADER];
    forwardedCerts.set(req.raw, { viaProxy, presented });
  });
}

/**
 * The client certificate this request presents, from the gateway's own TLS
 * termination or an admitted proxy — NOT yet validated (call
 * `validateClientCertificate`). Null when there is none.
 *
 * When the socket peer is an ADMITTED proxy (ADR-0188 S5 review item 4), the
 * client certificate is the one it forwarded, or none: the TLS peer
 * certificate is then the PROXY's own (proxy-to-gateway mTLS), which
 * authenticates the proxy and never the client behind it.
 */
export function presentedClientCertificate(req: FastifyRequest): PresentedCertificate | null {
  const forwarded = forwardedCerts.get(req.raw);
  if (forwarded?.viaProxy) return forwarded.presented;
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
  return forwarded?.presented ?? null;
}
