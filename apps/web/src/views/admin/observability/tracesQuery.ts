/**
 * ADR-0173 batch 2c (T) — the Traces page's filter and bulk-action helpers.
 * Pure, so the query string the page sends and the sentence it shows after a
 * bulk action are unit-tested without a browser.
 *
 * The SPA does not depend on @regulait/shared, so the tag rules below MIRROR
 * `TRACE_TAG_KEY_PATTERN` / `TRACE_TAG_LIMITS` in packages/shared/src/
 * trace-filters.ts. The gateway is the authority (it refuses with a 400 and
 * the page shows that refusal); these only stop an obviously wrong value from
 * being sent.
 */

/** mirrors TRACE_TAG_KEY_PATTERN */
export const TAG_KEY_PATTERN = /^[a-z0-9_.-]{1,64}$/;
/** mirrors TRACE_TAG_LIMITS */
export const TAG_LIMITS = { valueChars: 256, tagsPerTrace: 20, reservedPrefix: "regulait." } as const;

export interface TraceListFilters {
  kind: string;
  sessionId: string;
  deniedOnly: boolean;
  agentId: string;
  model: string;
  minCostUsd: string;
  minLatencyMs: string;
  scoreName: string;
  scoreMin: string;
  scoreMax: string;
  /** "" = any, "true" = flagged by a trace evaluation, "false" = not flagged */
  flagged: "" | "true" | "false";
  tagKey: string;
  tagValue: string;
}

export const EMPTY_TRACE_FILTERS: TraceListFilters = {
  kind: "",
  sessionId: "",
  deniedOnly: false,
  agentId: "",
  model: "",
  minCostUsd: "",
  minLatencyMs: "",
  scoreName: "",
  scoreMin: "",
  scoreMax: "",
  flagged: "",
  tagKey: "",
  tagValue: "",
};

/** why a filter cannot be sent yet, or null when it can */
export function traceFilterProblem(f: TraceListFilters): string | null {
  const numeric: Array<[keyof TraceListFilters, string]> = [
    ["minCostUsd", "Minimum cost"],
    ["minLatencyMs", "Minimum latency"],
    ["scoreMin", "Score from"],
    ["scoreMax", "Score to"],
  ];
  for (const [k, label] of numeric) {
    const v = String(f[k]).trim();
    if (v !== "" && !Number.isFinite(Number(v))) return `${label} must be a number`;
  }
  if ((f.scoreMin.trim() || f.scoreMax.trim()) && !f.scoreName.trim()) return "A score range needs a score name";
  if (f.tagValue.trim() && !f.tagKey.trim()) return "A tag value needs a tag key";
  if (f.tagKey.trim() && !TAG_KEY_PATTERN.test(f.tagKey.trim())) {
    return "A tag key is 1-64 characters of a-z, 0-9, '_', '.' or '-'";
  }
  return null;
}

/** the `/v1/traces` query string; empty fields are left out entirely */
export function traceListQuery(f: TraceListFilters, limit = 100): string {
  const qs = new URLSearchParams();
  const put = (k: string, v: string) => {
    const t = v.trim();
    if (t !== "") qs.set(k, t);
  };
  put("kind", f.kind);
  put("sessionId", f.sessionId);
  if (f.deniedOnly) qs.set("deniedOnly", "true");
  put("agentId", f.agentId);
  put("model", f.model);
  put("minCostUsd", f.minCostUsd);
  put("minLatencyMs", f.minLatencyMs);
  put("scoreName", f.scoreName);
  put("scoreMin", f.scoreMin);
  put("scoreMax", f.scoreMax);
  if (f.flagged) qs.set("flagged", f.flagged);
  put("tagKey", f.tagKey);
  if (f.tagKey.trim()) put("tagValue", f.tagValue);
  qs.set("limit", String(limit));
  return qs.toString();
}

/** how many filters beyond the default are active (for the "Clear filters" label) */
export function activeFilterCount(f: TraceListFilters): number {
  return (Object.keys(EMPTY_TRACE_FILTERS) as Array<keyof TraceListFilters>).filter(
    (k) => f[k] !== EMPTY_TRACE_FILTERS[k] && !(typeof f[k] === "string" && (f[k] as string).trim() === ""),
  ).length;
}

/** why a tag cannot be written, or null */
export function tagProblem(key: string, value: string): string | null {
  const k = key.trim();
  if (!TAG_KEY_PATTERN.test(k)) return "A tag key is 1-64 characters of a-z, 0-9, '_', '.' or '-'";
  if (k.startsWith(TAG_LIMITS.reservedPrefix)) return `Keys starting '${TAG_LIMITS.reservedPrefix}' are reserved`;
  if (value.length > TAG_LIMITS.valueChars) return `A tag value is at most ${TAG_LIMITS.valueChars} characters`;
  return null;
}

/** what every bulk action answers: the dataset, annotation-queue and tag routes alike */
export interface BulkOutcome {
  added: number;
  skipped: Array<{ id: string; reason: string }>;
}

const REASON_WORDS: Record<string, string> = {
  not_found: "no such trace",
  not_found_or_forbidden: "not found, or not yours",
  tag_limit: "already has 20 tags",
};

export function reasonWords(reason: string): string {
  return REASON_WORDS[reason] ?? reason.replace(/_/g, " ");
}

/** the one sentence shown after a bulk action */
export function bulkSentence(action: string, target: string, out: BulkOutcome): string {
  const skipped = out.skipped.length;
  const head = `${action} ${out.added} trace${out.added === 1 ? "" : "s"} ${target}`;
  return skipped === 0 ? `${head}.` : `${head}; ${skipped} skipped.`;
}
