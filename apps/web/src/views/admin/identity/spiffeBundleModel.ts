/**
 * ADR-0188 S9 — the SPIFFE trust bundles, the browser's model. Mirrors
 * `SpiffeTrustBundleView`, `SpiffeTrustBundleListView`,
 * `SpiffeTrustBundleRevokeResult` and `SPIFFE_TRUST_DOMAIN_PATTERN` in
 * `packages/shared/src/identity/contract.ts`; `spiffeBundleModel.test.ts`
 * pins the refusal codes to `apps/gateway/src/oauth/spiffe-bundles.ts`.
 *
 * A bundle holds PUBLIC X.509 authorities and, since the S9 follow-up, its
 * JWT-SVID keys. SPIFFE client authentication is off until an admin uploads a
 * bundle for a trust domain or sets its bundle endpoint (the strict default);
 * the old environment variable is ignored.
 */

export type SpiffeBundleStatus = "active" | "superseded" | "revoked";
export type SpiffeBundleFormat = "pem" | "spiffe_jwks";

export interface SpiffeTrustAuthorityView {
  thumbprint: string;
  subject: string;
  notBefore: string;
  notAfter: string;
}

/** S9 follow-up: one JWT authority (a `jwt-svid` key) of a bundle */
export interface SpiffeJwtAuthorityView {
  kid: string;
  kty: string;
  crv: string | null;
  thumbprint: string;
}

export type SpiffeBundleSource = "upload" | "fetch";

export interface SpiffeTrustBundleView {
  id: string;
  trustDomain: string;
  status: SpiffeBundleStatus;
  format: SpiffeBundleFormat;
  digest: string;
  authorities: SpiffeTrustAuthorityView[];
  /** S9 follow-up: the bundle's JWT-SVID keys (they verify JWT-SVIDs) */
  jwtAuthorities: SpiffeJwtAuthorityView[];
  /** bundles recorded before the S9 follow-up counted their JWT-SVID keys without keeping them */
  jwtAuthoritiesIgnored: number;
  source: SpiffeBundleSource;
  sequence: number | null;
  createdBy: string;
  createdAt: string;
  supersededAt: string | null;
  supersededByBundleId: string | null;
  revokedAt: string | null;
  revokedBy: string | null;
}

export interface SpiffeTrustBundleListView {
  items: SpiffeTrustBundleView[];
  legacyEnvironmentIgnored: boolean;
}

export interface SpiffeTrustBundleRevokeResult {
  bundle: SpiffeTrustBundleView;
  tokensRevoked: number;
  grantsRevoked: string[];
  cascade: "complete" | "incomplete";
  grantsNotRevoked: string[];
}

/** what `POST /v1/identity/spiffe-trust-bundles` takes */
export interface PutSpiffeTrustBundleBody {
  trustDomain: string;
  bundle: string;
  replacesBundleId: string | null;
}

/** the largest bundle text the gateway accepts (`SPIFFE_BUNDLE_MAX_BYTES`) */
export const SPIFFE_BUNDLE_MAX_BYTES = 256 * 1024;

/** `^[a-z0-9._-]{1,255}$`, checked by character (M-074: no regex on caller input) */
export function trustDomainOk(value: string): boolean {
  if (value.length < 1 || value.length > 255) return false;
  for (const c of value) {
    if (!((c >= "a" && c <= "z") || (c >= "0" && c <= "9") || c === "." || c === "_" || c === "-")) return false;
  }
  return true;
}

/** a list response the page can trust: anything else is shown as a failed read, never as "no bundles" */
export function isBundleList(v: unknown): v is SpiffeTrustBundleListView {
  return !!v && typeof v === "object" && Array.isArray((v as { items?: unknown }).items) && typeof (v as { legacyEnvironmentIgnored?: unknown }).legacyEnvironmentIgnored === "boolean";
}

/** the browser's own checks before anything is sent; null = fine */
export function bundleDraftError(draft: { trustDomain: string; bundle: string }): string | null {
  if (!trustDomainOk(draft.trustDomain)) return "A trust domain is 1 to 255 lowercase letters, digits, dots, dashes or underscores (no spiffe:// prefix).";
  const text = draft.bundle.trim();
  if (text === "") return "Paste the bundle: PEM CA certificates, or the SPIFFE bundle JSON.";
  if (draft.bundle.length > SPIFFE_BUNDLE_MAX_BYTES) return "The bundle is larger than 256 KB.";
  // never send a private key anywhere (the gateway refuses it too)
  if (text.includes("PRIVATE KEY")) return "This text contains a private key. Paste only the public CA certificates.";
  if (!text.startsWith("{") && !text.includes("-----BEGIN CERTIFICATE-----")) return "That is neither PEM certificates nor a SPIFFE bundle (JSON).";
  return null;
}

export const SPIFFE_BUNDLE_STATUS_TEXT: Readonly<Record<SpiffeBundleStatus, string>> = {
  active: "Trusted now.",
  superseded: "Replaced; nothing revoked.",
  revoked: "Revoked; tokens and grants ended.",
};

/** the earliest expiry of a bundle's authorities, for the list (ISO), or null */
export function earliestAuthorityExpiry(b: Pick<SpiffeTrustBundleView, "authorities">): string | null {
  let out: string | null = null;
  for (const a of b.authorities) if (out === null || Date.parse(a.notAfter) < Date.parse(out)) out = a.notAfter;
  return out;
}

/** the refusal codes, in words (pinned to spiffe-bundles.ts by the test) */
export const SPIFFE_BUNDLE_REFUSALS: Readonly<Record<string, string>> = {
  spiffe_bundle_invalid: "Unreadable bundle: paste PEM CA certificates or SPIFFE bundle JSON.",
  spiffe_bundle_private_material: "Contains a private key; nothing stored.",
  spiffe_bundle_key_mismatch: "A key does not match its certificate.",
  spiffe_bundle_authority_not_ca: "A certificate is not a signing CA.",
  spiffe_bundle_authority_time: "A CA certificate is expired or not yet valid.",
  spiffe_bundle_not_certificate: "A PEM block is not a certificate.",
  spiffe_bundle_duplicate: "A CA certificate appears twice.",
  spiffe_bundle_too_large: "Over 64 CA certificates.",
  spiffe_bundle_conflict: "Changed since read. Refresh and retry.",
  spiffe_bundle_unchanged: "Unchanged; nothing done.",
  spiffe_bundle_not_found: "Gone. Refresh the list.",
  spiffe_bundle_already_revoked: "Already revoked.",
  spiffe_bundle_not_active: "Replaced; revoke the active bundle.",
  spiffe_bundle_jwt_key_unsupported: "Unsupported JWT-SVID key.",
  spiffe_bundle_sequence_rollback: "Fetched bundle is older (sequence went backwards).",
};

export function spiffeBundleRefusal(code: unknown): string | null {
  return typeof code === "string" && Object.hasOwn(SPIFFE_BUNDLE_REFUSALS, code) ? SPIFFE_BUNDLE_REFUSALS[code]! : null;
}

// ---------------------------------------------------------------------------
// S9 follow-up: the SPIFFE bundle endpoint (mirrors `SpiffeBundleEndpointView` and `putSpiffeBundleEndpointSchema`)
// ---------------------------------------------------------------------------

export type SpiffeBundleEndpointProfile = "https_web" | "https_spiffe";

export interface SpiffeBundleEndpointView {
  trustDomain: string;
  url: string;
  profile: SpiffeBundleEndpointProfile;
  endpointSpiffeId: string | null;
  enabled: boolean;
  nextRefreshAt: string | null;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastErrorCode: string | null;
  consecutiveFailures: number;
  trustUntil: string | null;
  updatedBy: string;
  updatedAt: string;
}

export interface SpiffeBundleEndpointListView {
  items: SpiffeBundleEndpointView[];
}

/** what `PUT /v1/identity/spiffe-bundle-endpoints/:trustDomain` takes */
export interface PutSpiffeBundleEndpointBody {
  url: string;
  profile: SpiffeBundleEndpointProfile;
  endpointSpiffeId: string | null;
  enabled: boolean;
}

export function isEndpointList(v: unknown): v is SpiffeBundleEndpointListView {
  return !!v && typeof v === "object" && Array.isArray((v as { items?: unknown }).items);
}

/** `spiffe://<trust-domain>/<path>`, roughly (the gateway checks it exactly) */
export function spiffeIdOk(value: string): boolean {
  const rest = value.startsWith("spiffe://") ? value.slice(9) : "";
  const slash = rest.indexOf("/");
  return value.length <= 2048 && slash > 0 && trustDomainOk(rest.slice(0, slash)) && slash < rest.length - 1;
}

/** the browser's own checks before an endpoint is sent; null = fine */
export function endpointDraftError(draft: { trustDomain: string; url: string; profile: SpiffeBundleEndpointProfile; endpointSpiffeId: string }): string | null {
  if (!trustDomainOk(draft.trustDomain)) return bundleDraftError({ trustDomain: draft.trustDomain, bundle: "" });
  let u: URL | null = null;
  try {
    u = new URL(draft.url);
  } catch {
    // reported below
  }
  if (u?.protocol !== "https:" || u.username || u.password || u.hash) return "Use an https URL with no user name, password or #fragment.";
  if (draft.profile === "https_spiffe" && !spiffeIdOk(draft.endpointSpiffeId)) return "Name the endpoint server's SPIFFE ID.";
  return null;
}

/** the endpoint codes that need more than their own name (pinned to spiffe-bundle-endpoint.ts by the test) */
export const SPIFFE_ENDPOINT_CODES: Readonly<Record<string, string>> = {
  spiffe_endpoint_trust_domain_unknown: "Upload the endpoint ID's domain bundle first.",
  egress_blocked: "Host not on the egress allow-list.",
  spiffe_bundle_fetch_tls: "Certificate not trusted.",
  spiffe_endpoint_id_mismatch: "SVID for another ID.",
  spiffe_bundle_revoked: "Bundle revoked; save the endpoint again.",
};

const ENDPOINT_CODE_PREFIXES = ["spiffe_bundle_fetch_", "spiffe_endpoint_"];

export function spiffeEndpointCode(code: unknown): string | null {
  if (typeof code !== "string") return null;
  if (Object.hasOwn(SPIFFE_ENDPOINT_CODES, code)) return SPIFFE_ENDPOINT_CODES[code]!;
  // the rest read well enough as their own words: spiffe_bundle_fetch_timeout -> "Failed: timeout."
  const prefix = ENDPOINT_CODE_PREFIXES.find((p) => code.startsWith(p));
  if (prefix) return `Failed: ${code.slice(prefix.length).split("_").join(" ")}.`;
  return spiffeBundleRefusal(code);
}
