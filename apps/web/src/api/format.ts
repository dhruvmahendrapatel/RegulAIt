/** Small display formatters shared across views (parity with the legacy UI). */

export function fmtUsd(v: number | null | undefined): string {
  if (v == null || Number.isNaN(Number(v))) return "—";
  return "$" + Number(v).toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
}

export function ago(iso: string | null | undefined): string {
  if (!iso) return "—";
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  return Math.floor(s / 86400) + "d ago";
}

export function fmtDur(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "—";
  const s = ms / 1000;
  if (s < 10) return s.toFixed(1) + "s";
  if (s < 60) return Math.round(s) + "s";
  if (s < 3600) return Math.floor(s / 60) + "m " + Math.round(s % 60) + "s";
  return Math.floor(s / 3600) + "h " + Math.round((s % 3600) / 60) + "m";
}

export function fmtBytes(n: number): string {
  return n < 1024
    ? n + " B"
    : n < 1048576
      ? Math.round(n / 1024) + " KB"
      : (n / 1048576).toFixed(1) + " MB";
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const shortId = (id: string) => id.slice(0, 8) + "…";

/** Approvals Queue sentinel stages → human labels. This was originally kept in
 * step with the same mapping in the deleted ui-theme.ts (ADR-0033); it is now
 * the single definition. Returns null when the stage is not a sentinel. */
export function approvalStageLabel(a: {
  stageId?: string | null;
  contextConflict?: { key?: string } | undefined;
}): string | null {
  const s = a.stageId ?? "";
  if (s === "__project_budget__") return "Budget overage";
  if (s === "__reclassification__") return "Reclassification";
  if (s.startsWith("__context_conflict__"))
    return "Context conflict" + (a.contextConflict?.key ? " · " + a.contextConflict.key : "");
  if (s.startsWith("__budget__")) return "Run budget";
  if (s.startsWith("__infra_remediation__")) return "Infra remediation";
  return null;
}
