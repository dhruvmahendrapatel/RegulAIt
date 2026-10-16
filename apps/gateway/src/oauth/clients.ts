/**
 * ADR-0188 slice S5 — WORKLOAD CLIENTS: who may authenticate to the token
 * endpoint, and with which credential (decisions 2, 5, 12, 21).
 *
 * A client is a `workload_identities` row; its OAuth `client_id` is the
 * identity's `identifier` (a SPIFFE-shaped URI), the same value the delegated
 * token's `client_id` claim carries (S3 mint). Its keys are its LIVE
 * `workload_credentials` rows only, judged by S3's ONE credential predicate
 * (`credentialLiveAt`) on the DATABASE clock. Clients and keys come only from
 * our tables: there is no client `jwks_uri`, no registration, no metadata
 * document (decision 20).
 *
 * Methods (decision 5; each must also be listed in the org's
 * `workload_client_auth_methods`, strict default: all four):
 *   - `private_key_jwt`               a `jwk` credential (RFC 7523)
 *   - `tls_client_auth`               an `x509` credential, chain-validated
 *                                     against the mTLS CA set, AND its
 *                                     registered `x5t#S256` (and SAN/subject
 *                                     when registered) must match
 *   - `self_signed_tls_client_auth`   an `x509` credential marked self-signed:
 *                                     no chain, the registered `x5t#S256`
 *   - `spiffe_svid`                   a `spiffe_id` credential: an X.509-SVID
 *                                     validated against THAT trust domain's
 *                                     ACTIVE uploaded bundle (S9), URI SAN =
 *                                     the registered ID
 * `client_secret_*` does not exist.
 */
import { and, eq, isNull, workloadCredentials, workloadIdentities, type Db, type WorkloadCredentialRow } from "@regulait/db";
import { JWK_THUMBPRINT_URI_PREFIX, WORKLOAD_SELF_KINDS, type WorkloadClientAuthMethod } from "@regulait/shared";
import { credentialLiveAt } from "../delegation.js";
import { importJWK, jwtVerify, type JWK } from "jose";
import { loadOrgSettings } from "../org-settings.js";
import { loadMtlsCaBundle, selfSignedCertificateFacts, spiffeIdParts, validateClientCertificate, type PresentedCertificate, type TrustConfig } from "./x509.js";
import { loadSpiffeTrustAnchors } from "./spiffe-trust-domains.js";

export interface WorkloadClient {
  identity: typeof workloadIdentities.$inferSelect;
  /** live credentials only */
  credentials: WorkloadCredentialRow[];
  methods: ReadonlySet<WorkloadClientAuthMethod>;
  /**
   * ADR-0188 S7: the client named itself by its key's RFC 9278 JWK thumbprint
   * URI, not its identifier. Only an engine runner or a PDP client may, only
   * for the `client_credentials` grant, and only that ONE key authenticates it.
   */
  alias?: boolean;
}

/** an RFC 7638 SHA-256 thumbprint (43 base64url characters), checked without a regular expression */
const isThumbprint = (v: string) =>
  v.length === 43 && [...v].every((c) => (c >= "A" && c <= "Z") || (c >= "a" && c <= "z") || (c >= "0" && c <= "9") || c === "-" || c === "_");

/** the client a `client_id` names, with its live credentials; null if unknown */
export async function findWorkloadClient(db: Db, clientId: string, now: Date): Promise<WorkloadClient | null> {
  if (typeof clientId !== "string" || clientId.length === 0 || clientId.length > 2048) return null;
  if (clientId.startsWith(JWK_THUMBPRINT_URI_PREFIX)) return findClientByThumbprint(db, clientId.slice(JWK_THUMBPRINT_URI_PREFIX.length), now);
  const [identity] = await db.select().from(workloadIdentities).where(eq(workloadIdentities.identifier, clientId));
  if (!identity) return null;
  const creds = await db
    .select()
    .from(workloadCredentials)
    .where(and(eq(workloadCredentials.identityId, identity.id), isNull(workloadCredentials.revokedAt)));
  const org = await loadOrgSettings(db);
  return {
    identity,
    // a suspended or revoked identity authenticates nothing
    credentials: identity.status === "active" ? creds.filter((c) => credentialLiveAt(c, identity.id, now)) : [],
    methods: new Set(org.workloadClientAuthMethods as WorkloadClientAuthMethod[]),
  };
}

/**
 * ADR-0188 S7: an engine runner or a PDP client named by its key's thumbprint
 * (RFC 9278), so it needs to hold nothing but its key. One key authenticates
 * one identity, ever (S6), so the thumbprint names exactly one identity; the
 * client is that identity with that ONE credential, when it is live.
 */
async function findClientByThumbprint(db: Db, jkt: string, now: Date): Promise<WorkloadClient | null> {
  if (!isThumbprint(jkt)) return null;
  const [cred] = await db.select().from(workloadCredentials).where(and(eq(workloadCredentials.jwkThumbprint, jkt), eq(workloadCredentials.kind, "jwk")));
  if (!cred) return null;
  const [identity] = await db.select().from(workloadIdentities).where(eq(workloadIdentities.id, cred.identityId));
  if (!identity || !(WORKLOAD_SELF_KINDS as readonly string[]).includes(identity.kind)) return null;
  const org = await loadOrgSettings(db);
  return {
    identity,
    credentials: identity.status === "active" && cred.revokedAt === null && credentialLiveAt(cred, identity.id, now) ? [cred] : [],
    methods: new Set(org.workloadClientAuthMethods as WorkloadClientAuthMethod[]),
    alias: true,
  };
}

/** the public JWKs a `private_key_jwt` client may sign assertions with (kid = the RFC 7638 thumbprint) */
export function clientJwks(client: WorkloadClient): Array<Record<string, string>> {
  if (!client.methods.has("private_key_jwt")) return [];
  return client.credentials
    .filter((c) => c.kind === "jwk" && c.publicJwk && c.jwkThumbprint)
    .map((c): Record<string, string> => {
      const j = c.publicJwk as unknown as Record<string, string>;
      return j.kty === "OKP"
        ? // no `alg` member: the provider then matches an Ed25519 key to BOTH labels of its signature (`EdDSA`,
          // RFC 8037, and `Ed25519`, RFC 9864); a key that names one alg is refused for the other
          { kty: "OKP", crv: "Ed25519", x: j.x!, kid: c.jwkThumbprint!, use: "sig" }
        : { kty: "EC", crv: "P-256", x: j.x!, y: j.y!, kid: c.jwkThumbprint!, alg: "ES256", use: "sig" };
    });
}

export type CertificateMatch =
  | { ok: true; credentialId: string; method: WorkloadClientAuthMethod; thumbprint: string }
  | { ok: false; code: string };

/**
 * Which LIVE credential of `client` this presented certificate proves, after
 * decision 21's validation. Every credential is tried; the first that fully
 * matches wins. No match is a refusal with the most specific reason seen.
 * The anchors are read at the point of use: the mTLS CA set from the
 * environment, the SPIFFE bundles from `spiffe_trust_bundles` (ADR-0188 S9),
 * so an upload or a revocation applies to the very next request on every replica.
 */
export async function matchCertificateCredential(
  db: Db,
  client: WorkloadClient,
  presented: PresentedCertificate,
  now: Date,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CertificateMatch> {
  let trust: TrustConfig;
  try {
    trust = { mtlsCa: loadMtlsCaBundle(env), spiffe: await loadSpiffeTrustAnchors(db) };
  } catch {
    return { ok: false, code: "trust_config_invalid" };
  }
  let last = "no_certificate_credential";
  for (const c of client.credentials) {
    if (c.kind === "x509" && c.selfSigned) {
      if (!client.methods.has("self_signed_tls_client_auth")) {
        last = "method_not_allowed";
        continue;
      }
      const f = selfSignedCertificateFacts(presented.der, now);
      if (!f.ok) {
        last = f.code;
        continue;
      }
      if (f.thumbprint === c.x5tS256) return { ok: true, credentialId: c.id, method: "self_signed_tls_client_auth", thumbprint: f.thumbprint };
      last = "certificate_not_registered";
    } else if (c.kind === "x509") {
      if (!client.methods.has("tls_client_auth")) {
        last = "method_not_allowed";
        continue;
      }
      const v = await validateClientCertificate(presented.der, { anchors: trust.mtlsCa, presentedIntermediates: presented.intermediates, now });
      if (!v.ok) {
        last = v.code;
        continue;
      }
      const subjectOk = (c.sanUri === null || v.uriSans.includes(c.sanUri)) && (c.subjectDn === null || v.subjectDn === c.subjectDn);
      if (v.thumbprint === c.x5tS256 && subjectOk) return { ok: true, credentialId: c.id, method: "tls_client_auth", thumbprint: v.thumbprint };
      last = "certificate_not_registered";
    } else if (c.kind === "spiffe_id" && c.spiffeId) {
      if (!client.methods.has("spiffe_svid")) {
        last = "method_not_allowed";
        continue;
      }
      const parts = spiffeIdParts(c.spiffeId);
      const anchors = parts ? trust.spiffe.get(parts.trustDomain) : undefined;
      if (!parts || !anchors) {
        last = "spiffe_trust_domain_unknown";
        continue;
      }
      const v = await validateClientCertificate(presented.der, { anchors, presentedIntermediates: presented.intermediates, now, spiffeTrustDomain: parts.trustDomain });
      if (!v.ok) {
        last = v.code;
        continue;
      }
      if (v.spiffeId === c.spiffeId) return { ok: true, credentialId: c.id, method: "spiffe_svid", thumbprint: v.thumbprint };
      last = "spiffe_id_mismatch";
    }
  }
  return { ok: false, code: last };
}

/** the JWS labels of a workload key's signature: an Ed25519 key signs under both, a P-256 key under ES256 */
const ED25519_ALGS: ReadonlySet<string> = new Set(["EdDSA", "Ed25519"]);
const WORKLOAD_ASSERTION_ALGS: ReadonlySet<string> = new Set([...ED25519_ALGS, "ES256"]);

/**
 * WHICH of the client's live keys signed this `private_key_jwt` assertion (decision 12), or null. The label is the
 * assertion's own `alg` (an Ed25519 key carries no `alg` member: `EdDSA`, RFC 8037, and `Ed25519`, RFC 9864, label
 * the same signature), and it must fit the key's type. ADR-0188 S7 (review of #380): the key's `alg` was once read
 * here, and dropping it from the JWKS refused every Ed25519 client; this is the one place the label is chosen.
 */
export async function assertionCredentialOf(
  client: WorkloadClient,
  assertion: string,
  header: { kid?: string; alg?: string },
  now: Date,
): Promise<string | null> {
  const alg = typeof header.alg === "string" && WORKLOAD_ASSERTION_ALGS.has(header.alg) ? header.alg : null;
  if (!alg) return null;
  for (const k of clientJwks(client)) {
    if (header.kid !== undefined && header.kid !== k.kid) continue;
    if ((k.kty === "OKP") !== ED25519_ALGS.has(alg)) continue;
    try {
      await jwtVerify(assertion, await importJWK(k as JWK, alg), { algorithms: [alg], currentDate: now });
      return client.credentials.find((c) => c.jwkThumbprint === k.kid)?.id ?? null;
    } catch {
      // another key of the same client
    }
  }
  return null;
}
