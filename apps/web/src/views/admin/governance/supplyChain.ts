/**
 * ADR-0216 — a model file's supply-chain check, as the page reads it.
 *
 * The gateway decides (signatures re-verified on every read, the block applied at dispatch and sign-off); this module
 * only names its result in fixed words. A state the page cannot read is shown as not passing, never as passing.
 */
import { fmtDay } from "../../../api/format";
import type { Tone } from "../../../ui/kit";

export type SupplyChainCondition = "unsigned" | "unscanned" | "unsafe_format";
export const SUPPLY_CHAIN_CONDITIONS: readonly SupplyChainCondition[] = ["unsigned", "unscanned", "unsafe_format"];

/** the gateway's SUPPLY_CHAIN_CONDITION_LABELS */
export const CONDITION_LABEL: Record<SupplyChainCondition, string> = {
  unsigned: "No valid signature from a trusted key",
  unscanned: "No completed scan",
  unsafe_format: "A format that can run code, or an unsafe finding",
};

export interface SupplyChainState {
  assessment: { failing: SupplyChainCondition[]; uncovered: SupplyChainCondition[]; passes: boolean; relaxed: boolean; relaxationExpired: boolean };
  signature: {
    status: "verified" | "failed" | "none";
    failure: string | null;
    failureLabel: string | null;
    keyName: string | null;
    signedName: string | null;
    presentedAt: "upload" | "attach" | null;
    createdAt: string | null;
  };
  relaxation: { id: string; conditions: SupplyChainCondition[]; reason: string; expiresAt: string; expired: boolean; createdAt: string } | null;
}

export interface SigningKey {
  id: string;
  name: string;
  algorithm: string;
  keyHint: string;
  createdAt: string;
  revokedAt: string | null;
}

export const conditionLabel = (c: string) => (CONDITION_LABEL as Record<string, string>)[c] ?? "An unknown condition";

/** the one badge for a file's state; anything unreadable is "Not checked", never "Passes" */
export function supplyChainBadge(state: SupplyChainState | undefined | null): { tone: Tone; label: string } {
  const a = state?.assessment;
  if (!a || !Array.isArray(a.uncovered)) return { tone: "neutral", label: "Not checked" };
  if (a.uncovered.length > 0) return { tone: "danger", label: "Blocked" };
  if (a.relaxed && state!.relaxation) return { tone: "warn", label: `Relaxed until ${fmtDay(state!.relaxation.expiresAt, "—")}` };
  return a.passes === true ? { tone: "ok", label: "Passes" } : { tone: "neutral", label: "Not checked" };
}

export function signatureText(sig: SupplyChainState["signature"] | undefined): string {
  if (!sig || sig.status === "none") return "No signature presented";
  if (sig.status === "verified") return `Verified${sig.keyName ? ` against ${sig.keyName}` : ""}${sig.signedName ? ` (signed as ${sig.signedName})` : ""}`;
  return `Not verified: ${sig.failureLabel ?? "the signature did not verify"}`;
}

/** read a bundle the person pasted or picked; null = not a JSON object */
export function parseBundle(text: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** the latest expiry a relaxation may have (30 days), as a date input's value */
export const RELAXATION_MAX_DAYS = 30;
export function dateInputValue(d: Date): string {
  return d.toISOString().slice(0, 10);
}
/** a chosen day ends the relaxation at the end of that day (UTC), capped at the 30-day bound */
export function relaxationExpiry(day: string, now: Date = new Date()): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const end = new Date(`${day}T23:59:59.000Z`);
  const max = new Date(now.getTime() + RELAXATION_MAX_DAYS * 86_400_000);
  if (!Number.isFinite(end.getTime()) || end.getTime() <= now.getTime()) return null;
  return (end.getTime() > max.getTime() ? max : end).toISOString();
}
