import { z } from "zod";
/** ADR-0186 R: deterministic offline verification; no I/O, clock or key service. */
import { createHash, createPublicKey, verify } from "node:crypto";
import { RECEIPT_GENESIS_PREV, RECEIPT_OBJECT_TYPES, RECEIPT_PAYLOAD_VERSION, RECEIPT_PAYLOAD_VERSION_V2, receiptCanonicalBytes, type AnyDecisionReceiptPayload, type DecisionReceiptPayload } from "../batch4.js";

export interface SignedDecisionReceipt { receiptSeq: number; payload: AnyDecisionReceiptPayload; signature: string; keyId: string }
// Lifecycle metadata describes the signing service, not a trusted timestamp
// on these bytes. Retirement stops new signing; it preserves public evidence
// needed to verify historical receipts. decision.at is the decision's time,
// which can precede the sweep and firstUsedAt by an arbitrary backlog.
export interface ReceiptPublicKey { keyId: string; jwk: { kty: "OKP"; crv: "Ed25519"; x: string }; firstUsedAt?: string | null; retiredAt?: string | null }
/**
 * `receiptV2FromAuditSeq` (ADR-0189 R42): the recorded receipt v2 boundary, the
 * first audit seq v2 governs. Absent or null = no boundary: every receipt must
 * be v1, and a v2 receipt is `invalid` (nothing may emit v2 before the cutover).
 */
export interface ReceiptBundle { verifier: typeof RECEIPT_PAYLOAD_VERSION; receipts: SignedDecisionReceipt[]; keys: ReceiptPublicKey[]; receiptV2FromAuditSeq?: number | null }
export interface ReceiptVerificationResult { receiptSeq: number | null; status: "valid" | "invalid" | "unverifiable"; reason: string }
export const RECEIPT_CANNOT_PROVE = [
  "Omission after the last receipt or decisions never included in this receipt stream.",
  "Correctness of the underlying decision or completeness of its omitted reason/detail.",
  "Signing time, unless independently verified anchor timestamp evidence covers these bytes.",
  "Identity or trust of the signing key: bundle-supplied keys require independent pinning.",
  "Whether these bytes were signed before key retirement, or whether the key was compromised. Retirement preserves historical signature verification; it is not a revocation attestation.",
] as const;
const digestSchema=z.string().regex(/^[0-9a-f]{64}$/);
const sequenceSchema=z.number().int().positive().safe();
const keyIdSchema=z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/);
const dateSchema=z.string().max(32).refine(value=>Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value);
const nullableTextSchema=z.string().max(4096).nullable();
const payloadV1Fields={
 receiptSeq:sequenceSchema,prev:digestSchema,keyId:keyIdSchema,
 audit:z.object({id:z.string().min(1).max(128),seq:sequenceSchema,rowHash:digestSchema,contentHash:digestSchema}).strict(),
 decision:z.object({at:dateSchema,userId:z.string().min(1).max(512),objectType:z.enum(RECEIPT_OBJECT_TYPES),
  objectId:nullableTextSchema,serverId:nullableTextSchema,toolName:nullableTextSchema,ruleId:nullableTextSchema,
  toolNameHash:digestSchema.optional(),ruleIdHash:digestSchema.optional(),effect:z.enum(["allow","deny","require_approval"]),
 }).strict().refine(value=>(!value.toolNameHash||value.toolName===null)&&(!value.ruleIdHash||value.ruleId===null)),
};
const payloadV1Schema=z.object({v:z.literal(RECEIPT_PAYLOAD_VERSION),...payloadV1Fields}).strict();
// ADR-0189 R34: v2 = v1 + ADR-0188 decision 9's actor fields + the facts binding
const identityIdSchema=z.string().min(1).max(128);
const payloadV2Schema=z.object({v:z.literal(RECEIPT_PAYLOAD_VERSION_V2),...payloadV1Fields,
 actor:z.object({identityId:identityIdSchema.nullable(),delegationGrantId:identityIdSchema.nullable(),chain:z.array(identityIdSchema).min(1).max(16).nullable()}).strict(),
 factsStatus:z.enum(["captured","capture_off"]),factsHash:digestSchema.nullable(),
}).strict().refine(value=>(value.factsStatus==="captured")===(value.factsHash!==null),"factsHash is null exactly when capture was off");
const payloadSchema=z.union([payloadV1Schema,payloadV2Schema]);
const publicKeySchema=z.object({keyId:keyIdSchema,jwk:z.object({kty:z.literal("OKP"),crv:z.literal("Ed25519"),x:z.string().regex(/^[A-Za-z0-9_-]{43}$/)}).strict(),firstUsedAt:dateSchema.nullable().optional(),retiredAt:dateSchema.nullable().optional()}).strict();
const envelopeSchema=z.object({receiptSeq:sequenceSchema,payload:payloadSchema,signature:z.string().regex(/^[A-Za-z0-9_-]{86}$/),keyId:keyIdSchema}).strict();
const bundleSchema=z.object({verifier:z.literal(RECEIPT_PAYLOAD_VERSION),receipts:z.array(envelopeSchema).max(5000),keys:z.array(publicKeySchema).max(1000),receiptV2FromAuditSeq:sequenceSchema.nullable().optional()}).strict();
export const receiptPayloadHash = (payload: AnyDecisionReceiptPayload): string => createHash("sha256").update(receiptCanonicalBytes(payload)).digest("hex");
/** a v1 or v2 receipt payload (B1 verifies both) */
export function isDecisionReceiptPayload(value:unknown):value is AnyDecisionReceiptPayload{return payloadSchema.safeParse(value).success;}
/** a v1 receipt payload: the only version this build emits (R34) */
export function isDecisionReceiptPayloadV1(value:unknown):value is DecisionReceiptPayload{return payloadV1Schema.safeParse(value).success;}
/** R42: which payload version an audit seq must carry, given the recorded boundary */
export function receiptVersionForAuditSeq(auditSeq:number,v2FromAuditSeq:number|null|undefined):typeof RECEIPT_PAYLOAD_VERSION|typeof RECEIPT_PAYLOAD_VERSION_V2{
  return v2FromAuditSeq!=null&&auditSeq>=v2FromAuditSeq?RECEIPT_PAYLOAD_VERSION_V2:RECEIPT_PAYLOAD_VERSION;
}
export function isReceiptBundle(value:unknown):value is ReceiptBundle{return bundleSchema.safeParse(value).success;}

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
    else if (payload.v !== receiptVersionForAuditSeq(payload.audit.seq, input.receiptV2FromAuditSeq)) fail("Receipt payload version does not match the recorded v2 boundary.");
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
