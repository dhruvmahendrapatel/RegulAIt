/**
 * G8 (f), owner decision on #453: the audit log's evidence panels fold, and each folded summary carries the panel's
 * current state so a warning (unsigned, not timestamped, unreadable) is never hidden behind the fold (ADR-0180).
 * Each function reads the same response its panel reads; anything it cannot read is said to be not reported.
 */
import type { Tone } from "../../../ui/kit";
import { plural } from "../../../api/format";

export interface EvidenceStatus { label: string; tone: Tone }

const NOT_REPORTED: EvidenceStatus = { label: "State not reported", tone: "warn" };
const CHECKING: EvidenceStatus = { label: "Checking…", tone: "neutral" };

export function receiptsStatus(q: { data?: { state?: string } | undefined; isError: boolean; isLoading: boolean }): EvidenceStatus {
  if (q.isLoading) return CHECKING;
  if (q.isError || !q.data) return NOT_REPORTED;
  switch (q.data.state) {
    case "signing": return { label: "Signing configured", tone: "ok" };
    case "no_key": return { label: "Unsigned: no signing key", tone: "warn" };
    case "off": return { label: "Signing is off", tone: "warn" };
    case "stalled": return { label: "Signing stalled", tone: "danger" };
    default: return NOT_REPORTED;
  }
}

export function anchorsStatus(q: {
  data?: { anchors?: Array<{ status?: string; timestamp?: { status?: string; verified?: boolean } }> } | undefined;
  isError: boolean;
  isLoading: boolean;
}): EvidenceStatus {
  if (q.isLoading) return CHECKING;
  const rows = q.data?.anchors;
  if (q.isError || !Array.isArray(rows)) return NOT_REPORTED;
  if (rows.length === 0) return { label: "No anchors yet", tone: "neutral" };
  // L5: an anchor whose write-out failed is a failure, not merely "not timestamped"
  const writeFailed = rows.filter((r) => r.status === "failed").length;
  const failed = rows.filter((r) => r.status !== "failed" && r.timestamp?.status === "failed").length;
  const unverified = rows.filter((r) => !(r.timestamp?.status === "granted" && r.timestamp.verified)).length;
  if (writeFailed || failed) {
    const parts = [writeFailed && `${plural(writeFailed, "anchor")} failed to write out`, failed && `${plural(failed, "timestamp")} failed`];
    return { label: parts.filter(Boolean).join(" · "), tone: "danger" };
  }
  if (unverified) return { label: `${unverified} of ${rows.length} not timestamped`, tone: "warn" };
  return { label: `All ${plural(rows.length, "anchor")} timestamped`, tone: "ok" };
}

export function retentionStatus(ret: { retainedDays: number | null; prunable: number } | undefined | null, isError = false): EvidenceStatus {
  if (isError) return NOT_REPORTED;
  if (!ret) return CHECKING;
  if (ret.retainedDays == null) return { label: "No retention set: all rows kept", tone: "neutral" };
  return { label: `${ret.retainedDays}-day floor · ${plural(ret.prunable, "row")} prunable`, tone: ret.prunable ? "info" : "neutral" };
}
