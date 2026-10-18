/**
 * ADR-0193 (I4, first slice): content provenance P0 and P1. Pure constants and functions, no database, no network;
 * shared by the migration's CHECKs (through `packages/db/src/schema.ts`), the gateway and the web app.
 *
 * P0, the native provenance label and digest. At a governed return path the gateway digests BOTH byte sets
 * (decision 3): what upstream returned and what it delivered after redaction, masking or withholding. When the
 * content's classification is `pii`, the digest is keyed (HMAC-SHA-256 under the per-tenant content digest key),
 * so a low-entropy output cannot be correlated by digest; otherwise it is a plain SHA-256. A content that was
 * never scanned for PII is treated as `pii` (ADR-0180: the strict reading). The label is bound into the audit
 * chain (it rides the provenance audit row's `detail`, which the row's content hash covers) and the covering
 * anchor's RFC 3161 token is the timestamp evidence (decision 4); no new cryptography.
 *
 * P1, the trust-tier policy (decision 7). Every source is `untrusted` until an admin sets its tier (a step-up,
 * audited). A WRITE action whose causal context (an orchestration run, a builder thread) holds content from a
 * source below the write floor is refused: low-trust content cannot carry high action authority. The floor
 * defaults to `trusted`; relaxing it to `standard` is a step-up too.
 *
 * Nothing here is, or claims to be, a machine-readable AI-content marking under any law (ADR-0193 Open).
 */
import { createHash, createHmac } from "node:crypto";
import { canonicalJson } from "../audit-chain.js";

/** the three tiers, lowest first (migration 0206 `content_trust_*_tier_check`) */
export const CONTENT_TRUST_TIERS = ["untrusted", "standard", "trusted"] as const;
export type ContentTrustTier = (typeof CONTENT_TRUST_TIERS)[number];

/** ADR-0180: a source nobody has classified is untrusted */
export const DEFAULT_CONTENT_TRUST_TIER: ContentTrustTier = "untrusted";

/** the lowest tier whose content may drive a write; `untrusted` is never a floor (the policy cannot be turned off) */
export const CONTENT_TRUST_WRITE_FLOORS = ["standard", "trusted"] as const;
export type ContentTrustWriteFloor = (typeof CONTENT_TRUST_WRITE_FLOORS)[number];
export const DEFAULT_CONTENT_TRUST_WRITE_FLOOR: ContentTrustWriteFloor = "trusted";

/** the sources a tier can be set on (migration 0206 `content_trust_tiers_source_kind_check`) */
export const CONTENT_SOURCE_KINDS = ["mcp_server", "connector"] as const;
export type ContentSourceKind = (typeof CONTENT_SOURCE_KINDS)[number];

/** `pii`: the scan found PII; `clean`: a scan ran and found none; `unscanned`: no scan ran (keyed, as `pii`) */
export const CONTENT_CLASSIFICATIONS = ["pii", "clean", "unscanned"] as const;
export type ContentClassification = (typeof CONTENT_CLASSIFICATIONS)[number];

/**
 * `sha256` plain; `hmac-sha256` keyed with the per-tenant key; `unavailable` when a keyed digest was owed but no
 * data key is configured, so no digest is stored at all (never an unkeyed digest of content that may be PII).
 */
export const CONTENT_DIGEST_ALGS = ["sha256", "hmac-sha256", "unavailable"] as const;
export type ContentDigestAlg = (typeof CONTENT_DIGEST_ALGS)[number];

export const CONTENT_PROVENANCE_LABEL_V = "regulait.content-provenance-label.v1";

/** the refusal a write gets when its causal context holds content below the floor */
export const CONTENT_TRUST_RULE_ID = "content-trust-floor";
export const CONTENT_TRUST_REFUSAL_CODE = "content_trust_refused";

export function isContentTrustTier(v: unknown): v is ContentTrustTier {
  return typeof v === "string" && (CONTENT_TRUST_TIERS as readonly string[]).includes(v);
}
export function isContentTrustWriteFloor(v: unknown): v is ContentTrustWriteFloor {
  return typeof v === "string" && (CONTENT_TRUST_WRITE_FLOORS as readonly string[]).includes(v);
}
export function isContentSourceKind(v: unknown): v is ContentSourceKind {
  return typeof v === "string" && (CONTENT_SOURCE_KINDS as readonly string[]).includes(v);
}

export function contentTrustRank(tier: ContentTrustTier): number {
  return CONTENT_TRUST_TIERS.indexOf(tier);
}

/** the lowest of the tiers given; null for none */
export function lowestContentTrustTier(tiers: readonly ContentTrustTier[]): ContentTrustTier | null {
  let low: ContentTrustTier | null = null;
  for (const t of tiers) if (low === null || contentTrustRank(t) < contentTrustRank(low)) low = t;
  return low;
}

/**
 * The exact bytes a content digest covers. A string is its UTF-8 bytes. Anything else (an MCP CallToolResult, a
 * connector's JSON body) is the audit chain's canonical JSON (sorted keys, the receipts' serialisation), so the
 * digest does not depend on key order. `undefined` is digested as JSON `null`.
 */
export function contentDigestBytes(value: unknown): Buffer {
  if (typeof value === "string") return Buffer.from(value, "utf8");
  return Buffer.from(canonicalJson(value === undefined ? null : value), "utf8");
}

/** a plain or keyed digest is owed: keyed unless a scan ran and found no PII (ADR-0193 decision 3) */
export function contentDigestKeyed(classification: ContentClassification): boolean {
  return classification !== "clean";
}

export interface ContentDigests {
  alg: ContentDigestAlg;
  /** the per-tenant key's row id; set exactly when `alg` is `hmac-sha256` */
  keyId: string | null;
  /** what upstream returned; null exactly when `alg` is `unavailable` */
  upstream: string | null;
  /** what the gateway delivered; null exactly when `alg` is `unavailable` */
  delivered: string | null;
}

/**
 * Digest both byte sets. `key` is the per-tenant HMAC key and is required for a keyed digest; without it the digest
 * is `unavailable` rather than a plain SHA-256 (which a low-entropy PII value could be guessed back from).
 */
export function digestContent(
  upstream: unknown,
  delivered: unknown,
  classification: ContentClassification,
  key: { id: string; bytes: Buffer } | null,
): ContentDigests {
  if (!contentDigestKeyed(classification)) {
    return {
      alg: "sha256",
      keyId: null,
      upstream: createHash("sha256").update(contentDigestBytes(upstream)).digest("hex"),
      delivered: createHash("sha256").update(contentDigestBytes(delivered)).digest("hex"),
    };
  }
  if (!key) return { alg: "unavailable", keyId: null, upstream: null, delivered: null };
  return {
    alg: "hmac-sha256",
    keyId: key.id,
    upstream: createHmac("sha256", key.bytes).update(contentDigestBytes(upstream)).digest("hex"),
    delivered: createHmac("sha256", key.bytes).update(contentDigestBytes(delivered)).digest("hex"),
  };
}

/** check a holder's bytes against a recorded digest (the keyed case needs the tenant key, inside the control plane) */
export function contentMatchesDigest(
  value: unknown,
  digest: string,
  alg: Exclude<ContentDigestAlg, "unavailable">,
  keyBytes?: Buffer,
): boolean {
  if (alg === "hmac-sha256") {
    if (!keyBytes) throw new Error("a keyed content digest needs the tenant key to check");
    return createHmac("sha256", keyBytes).update(contentDigestBytes(value)).digest("hex") === digest;
  }
  return createHash("sha256").update(contentDigestBytes(value)).digest("hex") === digest;
}

export type ContentProvenanceSource =
  | { kind: "mcp_tool"; serverId: string; toolName: string }
  | { kind: "connector"; connectorId: string; operation: "read" | "write"; object: string | null };

/** the source a tier is looked up under */
export function tierSourceOf(source: ContentProvenanceSource): { kind: ContentSourceKind; id: string } {
  return source.kind === "mcp_tool" ? { kind: "mcp_server", id: source.serverId } : { kind: "connector", id: source.connectorId };
}

export interface ContentProvenanceLabel {
  v: typeof CONTENT_PROVENANCE_LABEL_V;
  source: ContentProvenanceSource;
  /** the source's tier when the content was observed */
  trustTier: ContentTrustTier;
  classification: ContentClassification;
  /** `utf8` for a string, `canonical-json` otherwise (see contentDigestBytes) */
  bytes: { upstream: "utf8" | "canonical-json"; delivered: "utf8" | "canonical-json" };
  digest: ContentDigests;
  /** the delivered bytes differ from upstream's (redaction, masking, withholding); null when no digest is stored */
  transformed: boolean | null;
  /** the decision audit row that allowed the call (its receipt covers the decision) */
  decisionAuditId: string;
  /** the causal context the content flowed into (`run:<id>`, `builder_thread:<id>`), or null */
  contextId: string | null;
}

export function buildContentProvenanceLabel(input: {
  source: ContentProvenanceSource;
  trustTier: ContentTrustTier;
  classification: ContentClassification;
  upstream: unknown;
  delivered: unknown;
  key: { id: string; bytes: Buffer } | null;
  decisionAuditId: string;
  contextId: string | null;
}): ContentProvenanceLabel {
  const digest = digestContent(input.upstream, input.delivered, input.classification, input.key);
  return {
    v: CONTENT_PROVENANCE_LABEL_V,
    source: input.source,
    trustTier: input.trustTier,
    classification: input.classification,
    bytes: {
      upstream: typeof input.upstream === "string" ? "utf8" : "canonical-json",
      delivered: typeof input.delivered === "string" ? "utf8" : "canonical-json",
    },
    digest,
    transformed: digest.alg === "unavailable" ? null : digest.upstream !== digest.delivered,
    decisionAuditId: input.decisionAuditId,
    contextId: input.contextId,
  };
}

/** the causal context ids this slice tracks */
export function runContextId(runId: string): string {
  return `run:${runId}`;
}
export function builderThreadContextId(threadId: string): string {
  return `builder_thread:${threadId}`;
}
export const CONTENT_CONTEXT_ID_PATTERN = /^(run|builder_thread):[0-9a-f-]{36}$/;

export type ContentTrustVerdict =
  | { ok: true; lowest: ContentTrustTier | null }
  | { ok: false; lowest: ContentTrustTier; floor: ContentTrustWriteFloor };

/**
 * P1, the kernel rule. A read is never refused by provenance. A write is refused when the lowest tier of the
 * content already in its causal context is below the floor. No causal context, or no content in it, refuses nothing.
 */
export function evaluateContentTrust(
  action: "read" | "write",
  contextTiers: readonly ContentTrustTier[],
  floor: ContentTrustWriteFloor,
): ContentTrustVerdict {
  const lowest = lowestContentTrustTier(contextTiers);
  if (action === "read" || lowest === null) return { ok: true, lowest };
  if (contentTrustRank(lowest) < contentTrustRank(floor)) return { ok: false, lowest, floor };
  return { ok: true, lowest };
}

export function contentTrustRefusalReason(lowest: ContentTrustTier, floor: ContentTrustWriteFloor, target: string): string {
  return (
    `write '${target}' refused (${CONTENT_TRUST_REFUSAL_CODE}): its causal context holds ${lowest} content, ` +
    `and a write needs every source in its context at '${floor}' or above (ADR-0193 P1)`
  );
}
