/**
 * Classical model drift and explainability (P13b) — the logic behind the "Drift and explainability" tab on a model
 * card. Pure: types, file parsing and the words the tab shows. The gateway validates everything again; this only
 * catches a wrong file before it is sent and keeps the copy in one place.
 */
import type { Tone } from "../../../ui/kit";

export type DriftStatus = "within" | "warn" | "drift" | "insufficient";

export interface DriftSettings {
  enabled: boolean;
  maxReportsPerHour: number;
  minSamples: number;
  updatedAt: string | null;
}

export interface DriftThresholds {
  psiWarn: number;
  psiAlert: number;
  ksAlert: number;
  jsAlert: number;
}

export interface FeatureResult {
  feature: string;
  kind: "numeric" | "categorical";
  referenceSamples: number;
  samples: number;
  psi: number;
  js: number;
  ksD: number | null;
  ksP: number | null;
  status: DriftStatus;
  breached: Array<"psi" | "js" | "ks">;
}

export interface DriftReport {
  id: string;
  monitorId: string;
  source: "push" | "upload";
  windowStart: string;
  windowEnd: string;
  sampleCount: number;
  summarySha256: string;
  status: DriftStatus;
  driftedFeatures: number;
  results: FeatureResult[];
  createdAt: string;
}

export interface DriftMonitor {
  id: string;
  cardId: string;
  name: string;
  thresholds: DriftThresholds;
  referenceSha256: string;
  referenceSamples: number;
  features: Array<{ name: string; kind: "numeric" | "categorical"; bins?: number; categories?: number }>;
  createdAt: string;
  updatedAt: string;
  latestReport: DriftReport | null;
}

export interface ExplainabilityArtefact {
  id: string;
  kind: "global_importance" | "shap_summary";
  method: string;
  importances: Array<{ feature: string; value: number }>;
  featureCount: number;
  payloadSha256: string;
  note: string | null;
  createdAt: string;
}

export interface DriftView {
  settings: DriftSettings;
  strictThresholds: DriftThresholds;
  monitors: DriftMonitor[];
  artefacts: ExplainabilityArtefact[];
}

/** the gateway's body limit; a larger file is refused here before it is sent */
export const MAX_UPLOAD_BYTES = 512 * 1024;

export const STATUS_LABEL: Record<DriftStatus, string> = {
  within: "Within thresholds",
  warn: "Warning",
  drift: "Drift",
  insufficient: "Too few samples",
};

export function statusTone(status: DriftStatus): Tone {
  return status === "drift" ? "danger" : status === "warn" ? "warn" : status === "insufficient" ? "info" : "ok";
}

export const KIND_LABEL: Record<ExplainabilityArtefact["kind"], string> = {
  global_importance: "Global feature importance",
  shap_summary: "SHAP summary",
};

const STAT_LABEL = { psi: "PSI", js: "Jensen–Shannon", ks: "KS distance" } as const;

export function breachedText(breached: FeatureResult["breached"]): string {
  return breached.length === 0 ? "" : `past ${breached.map((b) => STAT_LABEL[b]).join(", ")}`;
}

/** three decimals, or "—" for a statistic that does not apply (KS on a categorical feature) */
export function stat(n: number | null): string {
  return n === null ? "—" : n.toFixed(3);
}

export const THRESHOLD_FIELDS: Array<{ key: keyof DriftThresholds; label: string }> = [
  { key: "psiWarn", label: "PSI warning" },
  { key: "psiAlert", label: "PSI alert" },
  { key: "ksAlert", label: "KS distance alert" },
  { key: "jsAlert", label: "Jensen–Shannon alert" },
];

/** the thresholds set above their strict default: each alerts later, so saving needs a step-up */
export function loosenedThresholds(next: DriftThresholds, strict: DriftThresholds): string[] {
  return THRESHOLD_FIELDS.filter((f) => next[f.key] > strict[f.key]).map((f) => f.label);
}

export function thresholdsText(t: DriftThresholds): string {
  return `PSI ${t.psiWarn} / ${t.psiAlert} · KS ${t.ksAlert} · JS ${t.jsAlert}`;
}

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

function parseJson(text: string): Parsed<unknown> {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, error: "The file is not valid JSON." };
  }
}

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

/**
 * A feature file: either a list of features or an object with a `features` list (a summary file may also carry
 * `windowStart` and `windowEnd`). Each feature is a histogram (`edges`, `counts`) or a category table
 * (`categories`, `counts`).
 */
export function parseFeatureFile(text: string): Parsed<{ features: unknown[]; windowStart?: string; windowEnd?: string }> {
  const json = parseJson(text);
  if (!json.ok) return json;
  const v = json.value;
  const features = Array.isArray(v) ? v : isObject(v) && Array.isArray(v.features) ? v.features : null;
  if (!features || features.length === 0) return { ok: false, error: "The file must hold a non-empty list of features." };
  for (const f of features) {
    if (!isObject(f) || typeof f.name !== "string" || (f.kind !== "numeric" && f.kind !== "categorical") || !Array.isArray(f.counts)) {
      return { ok: false, error: "Each feature needs a name, a kind (numeric or categorical) and counts." };
    }
  }
  const out: { features: unknown[]; windowStart?: string; windowEnd?: string } = { features };
  if (isObject(v) && typeof v.windowStart === "string") out.windowStart = v.windowStart;
  if (isObject(v) && typeof v.windowEnd === "string") out.windowEnd = v.windowEnd;
  return { ok: true, value: out };
}

/** an importance file: a list of `{ feature, value }`, or an object with an `importances` list */
export function parseImportanceFile(text: string): Parsed<Array<{ feature: string; value: number }>> {
  const json = parseJson(text);
  if (!json.ok) return json;
  const v = json.value;
  const list = Array.isArray(v) ? v : isObject(v) && Array.isArray(v.importances) ? v.importances : null;
  if (!list || list.length === 0) return { ok: false, error: "The file must hold a non-empty list of feature importances." };
  const out: Array<{ feature: string; value: number }> = [];
  for (const x of list) {
    if (!isObject(x) || typeof x.feature !== "string" || typeof x.value !== "number" || !Number.isFinite(x.value)) {
      return { ok: false, error: "Each entry needs a feature name and a numeric value." };
    }
    out.push({ feature: x.feature, value: x.value });
  }
  return { ok: true, value: out };
}

/** the largest contributions first, by magnitude */
export function topImportances(importances: ExplainabilityArtefact["importances"], n = 5): ExplainabilityArtefact["importances"] {
  return [...importances].sort((a, b) => Math.abs(b.value) - Math.abs(a.value)).slice(0, n);
}

export function fileTooLarge(file: { size: number }): string | null {
  return file.size > MAX_UPLOAD_BYTES ? `The file is larger than ${MAX_UPLOAD_BYTES / 1024} KB. Send aggregates only.` : null;
}
