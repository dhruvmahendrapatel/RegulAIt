/**
 * Batch U4 — signed decision receipts as rows a person can page through
 * (`GET /v1/receipts`) and open per decision (`GET /v1/receipts/:auditId`).
 *
 * The SPA mirrors the gateway's envelope by hand (the app's convention), so the
 * envelope is read defensively: a field the gateway did not send is shown as
 * missing, never invented. Mirrors `SignedDecisionReceipt` in
 * packages/shared (decision-receipts): `{ receiptSeq, payload, signature, keyId }`.
 */

export const RECEIPT_PAGE_SIZES = [25, 100, 500] as const;
/** the gateway refuses a page larger than this (`invalid_receipt_range`) */
export const RECEIPT_PAGE_MAX = 500;

export interface ReceiptEnvelope {
  receiptSeq: number;
  payload: unknown;
  signature: string;
  keyId: string;
}

export interface ReceiptRow {
  receiptSeq: number;
  /** the payload version (1 or 2), or null when the payload does not say */
  version: number | null;
  auditId: string | null;
  auditSeq: number | null;
  at: string | null;
  effect: string | null;
  objectType: string | null;
  objectId: string | null;
  toolName: string | null;
  ruleId: string | null;
  userId: string | null;
  keyId: string;
  signature: string;
  /** the payload hash this receipt chains from */
  prev: string | null;
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** one envelope as a flat row; tolerant of v1 and v2 payloads */
export function receiptRow(e: ReceiptEnvelope): ReceiptRow {
  const p = obj(e.payload);
  const audit = obj(p.audit);
  const d = obj(p.decision);
  return {
    receiptSeq: e.receiptSeq,
    version: num(p.v),
    auditId: str(audit.id),
    auditSeq: num(audit.seq),
    at: str(d.at),
    effect: str(d.effect),
    objectType: str(d.objectType),
    objectId: str(d.objectId),
    toolName: str(d.toolName) ?? (str(d.toolNameHash) ? `sha256:${str(d.toolNameHash)}` : null),
    ruleId: str(d.ruleId) ?? (str(d.ruleIdHash) ? `sha256:${str(d.ruleIdHash)}` : null),
    userId: str(d.userId),
    keyId: e.keyId,
    signature: e.signature,
    prev: str(p.prev),
  };
}

/** a "first sequence" field as the gateway accepts it (a positive integer), or null */
export function parseFromSeq(text: string): number | null {
  const t = text.trim();
  if (!/^[1-9]\d{0,15}$/.test(t)) return null;
  const n = Number(t);
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * Where the next page starts: one past the last receipt shown, or null when
 * this page came back short (the gateway had no more at that point).
 */
export function nextFromSeq(receipts: readonly ReceiptEnvelope[], limit: number): number | null {
  if (receipts.length < limit) return null;
  const last = receipts[receipts.length - 1];
  return last ? last.receiptSeq + 1 : null;
}

/** the refusal codes of the two reads, as sentences */
export const RECEIPT_REFUSALS: Readonly<Record<string, string>> = {
  invalid_receipt_range: "Choose a first receipt sequence of 1 or more and a page of at most 500 receipts.",
  invalid_audit_id: "That is not an audit row ID (a UUID). A decision's receipt is looked up by its audit row, not its receipt sequence.",
};
