/**
 * The recorded receipt signing keys (`GET /v1/receipts/keys`) and the retire
 * action (`POST /v1/receipts/keys/:keyId/retire`), as plain functions the
 * posture page's key table uses and its tests pin.
 *
 * Retiring a key stops every writer signing with it again; its public key stays
 * recorded, so the receipts it signed keep verifying. The gateway refuses to
 * retire the key it signs with now, and the last active key; this model offers
 * the button only where the gateway would accept it, and says why otherwise.
 */
import { ApiError } from "../../../api/client";

export interface RecordedReceiptKey {
  keyId: string;
  firstUsedAt: string | null;
  retiredAt: string | null;
}

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

/** the key list as the gateway sent it, or null when the response is not one (never a guessed empty list) */
export function parseReceiptKeys(raw: unknown): RecordedReceiptKey[] | null {
  const keys = raw && typeof raw === "object" ? (raw as { keys?: unknown }).keys : undefined;
  if (!Array.isArray(keys)) return null;
  const out: RecordedReceiptKey[] = [];
  for (const k of keys) {
    const o = k && typeof k === "object" ? (k as Record<string, unknown>) : null;
    const keyId = o ? str(o.keyId) : null;
    if (!o || !keyId) return null;
    out.push({ keyId, firstUsedAt: str(o.firstUsedAt), retiredAt: str(o.retiredAt) });
  }
  return out;
}

export type RetireGate = { ok: true } | { ok: false; reason: string };

/** whether the gateway would accept retiring `key` now, and why not */
export function retireGate(key: RecordedReceiptKey, keys: readonly RecordedReceiptKey[], inUseKeyId: string | null): RetireGate {
  if (key.retiredAt) return { ok: false, reason: "Already retired." };
  if (inUseKeyId !== null && key.keyId === inUseKeyId) {
    return { ok: false, reason: "This gateway signs with this key. Configure its replacement and restart before retiring it." };
  }
  if (!keys.some((k) => k.keyId !== key.keyId && !k.retiredAt)) {
    return { ok: false, reason: "This is the only active key. A replacement is recorded when it first signs; retire this one after that." };
  }
  return { ok: true };
}

/** the gateway's refusal codes for a retire, as sentences */
export const RECEIPT_KEY_REFUSALS: Readonly<Record<string, string>> = {
  receipt_key_in_use: "This gateway signs with that key, so it was not retired. Configure its replacement and restart first.",
  receipt_key_only_active: "That is the only active key, so it was not retired. A replacement is recorded when it first signs.",
  receipt_key_already_retired: "That key is already retired.",
  receipt_key_unknown: "No receipt signing key with that ID is recorded.",
  invalid_receipt_key_id: "That is not a receipt signing key ID.",
};

/** a retire refusal in the page's words, else null (the client's own reading stands) */
export function receiptKeyRefusal(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null;
  const code = error.payload.error;
  return typeof code === "string" && Object.hasOwn(RECEIPT_KEY_REFUSALS, code) ? RECEIPT_KEY_REFUSALS[code]! : null;
}
