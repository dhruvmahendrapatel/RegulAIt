/**
 * ADR-0188 S9 — the SPIFFE trust bundles, the browser's model. Mirrors
 * `SpiffeTrustBundleView`, `SpiffeTrustBundleListView`,
 * `SpiffeTrustBundleRevokeResult` and `SPIFFE_TRUST_DOMAIN_PATTERN` in
 * `packages/shared/src/identity/contract.ts`; `spiffeBundleModel.test.ts`
 * pins the refusal codes to `apps/gateway/src/oauth/spiffe-bundles.ts`.
 *
 * A bundle holds PUBLIC X.509 authorities only. SPIFFE client authentication
 * is off until an admin uploads a bundle for a trust domain (the strict
 * default); the old environment variable is ignored.
 */

export type SpiffeBundleStatus = "active" | "superseded" | "revoked";
export type SpiffeBundleFormat = "pem" | "spiffe_jwks";

export interface SpiffeTrustAuthorityView {
  thumbprint: string;
  subject: string;
  notBefore: string;
  notAfter: string;
}

export interface SpiffeTrustBundleView {
  id: string;
  trustDomain: string;
  status: SpiffeBundleStatus;
  format: SpiffeBundleFormat;
  digest: string;
  authorities: SpiffeTrustAuthorityView[];
  jwtAuthoritiesIgnored: number;
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
  active: "Trusted now: X.509-SVIDs of this domain can authenticate their registered SPIFFE IDs.",
  superseded: "Replaced by a newer bundle. Nothing was revoked; tokens already issued lived to their own expiry.",
  revoked: "Revoked: the domain's tokens and grants were ended. Never undone.",
};

/** the earliest expiry of a bundle's authorities, for the list (ISO), or null */
export function earliestAuthorityExpiry(b: Pick<SpiffeTrustBundleView, "authorities">): string | null {
  let out: string | null = null;
  for (const a of b.authorities) if (out === null || Date.parse(a.notAfter) < Date.parse(out)) out = a.notAfter;
  return out;
}

/** the refusal codes, in words (pinned to spiffe-bundles.ts by the test) */
export const SPIFFE_BUNDLE_REFUSALS: Readonly<Record<string, string>> = {
  spiffe_bundle_invalid: "That bundle could not be read. Paste PEM CA certificates or the SPIFFE bundle JSON (for example from `spire-server bundle show -format spiffe`).",
  spiffe_bundle_private_material: "The bundle contains a private key. Nothing was stored. Paste only the public CA certificates.",
  spiffe_bundle_key_mismatch: "A key in the SPIFFE bundle does not match its own certificate. Export the bundle again.",
  spiffe_bundle_authority_not_ca: "One certificate is not a CA with certificate signing. A workload's own certificate is never a trust anchor.",
  spiffe_bundle_authority_time: "One CA certificate is expired or not yet valid. Export a current bundle.",
  spiffe_bundle_duplicate: "The same CA certificate appears twice in the bundle.",
  spiffe_bundle_too_large: "The bundle holds more than 64 CA certificates.",
  spiffe_bundle_conflict: "The trust domain's bundle changed since this page read it. Refresh, then replace the current bundle.",
  spiffe_bundle_unchanged: "The active bundle already holds exactly these certificates. Nothing was changed.",
  spiffe_bundle_not_found: "That bundle no longer exists. Refresh the list.",
  spiffe_bundle_already_revoked: "That bundle is already revoked.",
  spiffe_bundle_not_active: "That bundle was replaced. Revoke the domain's active bundle to end its trust.",
};

export function spiffeBundleRefusal(code: unknown): string | null {
  return typeof code === "string" && Object.hasOwn(SPIFFE_BUNDLE_REFUSALS, code) ? SPIFFE_BUNDLE_REFUSALS[code]! : null;
}
