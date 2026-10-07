/** ADR-0186 R: deterministic offline verification; no I/O, clock or key service. */
import { createHash, createPublicKey, verify } from "node:crypto";
import { RECEIPT_GENESIS_PREV, RECEIPT_OBJECT_TYPES, RECEIPT_PAYLOAD_VERSION, receiptCanonicalBytes, type DecisionReceiptPayload } from "../batch4.js";

export interface SignedDecisionReceipt { receiptSeq: number; payload: DecisionReceiptPayload; signature: string; keyId: string }
export interface ReceiptPublicKey { keyId: string; jwk: { kty: "OKP"; crv: "Ed25519"; x: string }; firstUsedAt?: string | null; retiredAt?: string | null }
export interface ReceiptBundle { verifier: typeof RECEIPT_PAYLOAD_VERSION; receipts: SignedDecisionReceipt[]; keys: ReceiptPublicKey[] }
export interface ReceiptVerificationResult { receiptSeq: number | null; status: "valid" | "invalid" | "unverifiable"; reason: string }
export const RECEIPT_CANNOT_PROVE = [
  "Omission after the last receipt or decisions never included in this receipt stream.",
  "Correctness of the underlying decision or completeness of its omitted reason/detail.",
  "Signing time, unless independently verified anchor timestamp evidence covers these bytes.",
  "Identity or trust of the signing key: bundle-supplied keys require independent pinning.",
] as const;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const text = (value: unknown, max = 4096): value is string => typeof value === "string" && value.length > 0 && value.length <= max;
const nullableText = (value: unknown) => value === null || text(value);
const sequence = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 1;
const digest = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
export const receiptPayloadHash = (payload: DecisionReceiptPayload): string => createHash("sha256").update(receiptCanonicalBytes(payload)).digest("hex");

export function isDecisionReceiptPayload(value: unknown): value is DecisionReceiptPayload {
  if (!record(value) || !exact(value, ["v", "receiptSeq", "audit", "decision", "prev", "keyId"])) return false;
  const { audit, decision } = value;
  if (!record(audit) || !exact(audit, ["id", "seq", "rowHash", "contentHash"]) ||
      !record(decision) || !exact(decision, ["at", "userId", "objectType", "objectId", "serverId", "toolName", "effect", "ruleId"])) return false;
  return value.v === RECEIPT_PAYLOAD_VERSION && sequence(value.receiptSeq) && digest(value.prev) && text(value.keyId, 128) &&
    /^[A-Za-z0-9._:-]+$/.test(value.keyId) && text(audit.id, 128) && sequence(audit.seq) && digest(audit.rowHash) && digest(audit.contentHash) &&
    text(decision.at, 32) && Number.isFinite(Date.parse(decision.at)) && new Date(decision.at).toISOString() === decision.at &&
    text(decision.userId, 512) && typeof decision.objectType === "string" && (RECEIPT_OBJECT_TYPES as readonly string[]).includes(decision.objectType) &&
    nullableText(decision.objectId) && nullableText(decision.serverId) && nullableText(decision.toolName) && nullableText(decision.ruleId) &&
    ["allow", "deny", "require_approval"].includes(String(decision.effect));
}

/** Input validation is separate so the HTTP route can return a 400, not an empty success. */
export function isReceiptBundle(value: unknown): value is ReceiptBundle {
  if (!record(value) || value.verifier !== RECEIPT_PAYLOAD_VERSION || !Array.isArray(value.receipts) || !Array.isArray(value.keys) ||
      value.receipts.length > 5000 || value.keys.length > 1000) return false;
  return value.receipts.every((row) => record(row) && sequence(row.receiptSeq) && text(row.keyId, 128) &&
    typeof row.signature === "string" && /^[A-Za-z0-9_-]{86}$/.test(row.signature) && isDecisionReceiptPayload(row.payload)) &&
    value.keys.every((key) => record(key) && text(key.keyId, 128) && record(key.jwk) &&
      exact(key.jwk, ["kty", "crv", "x"]) && key.jwk.kty === "OKP" && key.jwk.crv === "Ed25519" &&
      typeof key.jwk.x === "string" && /^[A-Za-z0-9_-]{43}$/.test(key.jwk.x));
}

export function verifyReceiptBundle(input: unknown): { results: ReceiptVerificationResult[]; cannotProve: readonly string[] } {
  if (!isReceiptBundle(input)) return { results: [{ receiptSeq: null, status: "invalid", reason: "Malformed receipt bundle or non-public signing key." }], cannotProve: RECEIPT_CANNOT_PROVE };
  const keys = new Map<string, ReceiptPublicKey>();
  const duplicates = new Set<string>();
  for (const key of input.keys) { if (keys.has(key.keyId)) duplicates.add(key.keyId); keys.set(key.keyId, key); }
  const results: ReceiptVerificationResult[] = [];
  let previous: SignedDecisionReceipt | undefined;
  let trustedPrefix = true;
  for (const row of input.receipts) {
    const payload = row.payload;
    let status: ReceiptVerificationResult["status"] = "valid";
    let reason = "Signature and supplied receipt-chain prefix verified.";
    const fail = (why: string) => { status = "invalid"; reason = why; };
    if (row.receiptSeq !== payload.receiptSeq || row.keyId !== payload.keyId) fail("Envelope differs from the signed payload.");
    else if (previous && (row.receiptSeq !== previous.receiptSeq + 1 || payload.audit.seq <= previous.payload.audit.seq || payload.prev !== receiptPayloadHash(previous.payload))) fail("Receipt order, audit order or predecessor hash mismatch.");
    else if (!previous && row.receiptSeq === 1 && payload.prev !== RECEIPT_GENESIS_PREV) fail("Genesis predecessor mismatch.");
    else if (duplicates.has(row.keyId)) fail("Duplicate signing key identity.");
    else {
      const key = keys.get(row.keyId);
      if (!key) { status = "unverifiable"; reason = "Signing public key is unavailable."; }
      else {
        try {
          const publicKey = createPublicKey({ key: key.jwk, format: "jwk" });
          if (!verify(null, Buffer.from(receiptCanonicalBytes(payload)), publicKey, Buffer.from(row.signature, "base64url"))) fail("Signature mismatch.");
        } catch { fail("Signing key or signature cannot be decoded."); }
      }
    }
    if (status === "valid" && ((!previous && row.receiptSeq !== 1) || !trustedPrefix)) {
      status = "unverifiable"; reason = "Signature verified; the preceding receipt-chain prefix is absent or failed verification.";
    }
    trustedPrefix = trustedPrefix && status === "valid";
    results.push({ receiptSeq: row.receiptSeq, status, reason });
    previous = row;
  }
  return { results, cannotProve: RECEIPT_CANNOT_PROVE };
}
