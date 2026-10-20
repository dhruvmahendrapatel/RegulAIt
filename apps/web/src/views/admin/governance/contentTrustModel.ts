/**
 * ADR-0193 (I4) P0/P1 — the content trust page's model: the tier vocabulary (mirrored from `@regulait/shared`, which
 * the SPA does not depend on at runtime) and the shapes of `GET /v1/content-trust` and
 * `GET /v1/content-provenance/records`.
 */
export const CONTENT_TRUST_TIERS = ["untrusted", "standard", "trusted"] as const;
export type ContentTrustTier = (typeof CONTENT_TRUST_TIERS)[number];
export const CONTENT_TRUST_WRITE_FLOORS = ["standard", "trusted"] as const;
export type ContentTrustWriteFloor = (typeof CONTENT_TRUST_WRITE_FLOORS)[number];

export interface ContentTrustSource {
  sourceKind: "mcp_server" | "connector";
  sourceId: string;
  name: string;
  tier: ContentTrustTier;
  /** false = no admin has set it, so the strict default (`untrusted`) applies */
  explicit: boolean;
  setByUserId: string | null;
  setAt: string | null;
}

export interface ContentTrustResponse {
  tiers: ContentTrustTier[];
  defaultTier: ContentTrustTier;
  writeFloor: ContentTrustWriteFloor;
  writeFloors: ContentTrustWriteFloor[];
  sources: ContentTrustSource[];
}

export interface ContentProvenanceRecordView {
  id: string;
  auditId: string;
  decisionAuditId: string;
  contextId: string | null;
  sourceKind: "mcp_server" | "connector";
  sourceId: string;
  sourceDetail: string | null;
  trustTier: ContentTrustTier;
  classification: "pii" | "clean" | "unscanned";
  digestAlg: "sha256" | "hmac-sha256" | "unavailable";
  digestKeyId: string | null;
  upstreamDigest: string | null;
  deliveredDigest: string | null;
  createdAt: string;
  anchor: { anchorId: string; anchorSeq: number; tsaStatus: string; tsaGenTime: string | null } | null;
}

export const TIER_COPY: Record<ContentTrustTier, string> = {
  untrusted: "Untrusted: its content can never drive a write",
  standard: "Standard: its content can drive a write only if the write floor is relaxed to standard",
  trusted: "Trusted: its content can drive a write",
};

export const tierTone = (t: ContentTrustTier): "ok" | "warn" | "danger" =>
  t === "trusted" ? "ok" : t === "standard" ? "warn" : "danger";

export const tierRank = (t: ContentTrustTier): number => CONTENT_TRUST_TIERS.indexOf(t);

/** a short, copyable form of a 64-hex digest */
export const shortDigest = (d: string | null): string => (d ? `${d.slice(0, 12)}…` : "none stored");

export const DIGEST_COPY: Record<ContentProvenanceRecordView["digestAlg"], string> = {
  sha256: "SHA-256 (scanned clean)",
  "hmac-sha256": "keyed HMAC (PII or unscanned)",
  unavailable: "none: no data key to key it",
};
