/**
 * ADR-0222 (P13(a)) — fairness testing, the screen's types, words and reads. Logic only; the page renders.
 */
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../api/client";

export type FairnessMetric =
  | "demographic_parity_difference"
  | "disparate_impact_ratio"
  | "equal_opportunity_difference"
  | "equalized_odds_difference";
export type FairnessOutcome = "pass" | "flag" | "fail" | "inconclusive";

export interface FairnessThreshold {
  metric: FairnessMetric;
  limit: number;
  action: "fail" | "flag";
}

export interface FairnessSettingsView {
  enabled: boolean;
  blockOnFail: boolean;
  datasetRetentionDays: number;
  limits: {
    maxCsvBytes: number;
    maxRows: number;
    maxAttributes: number;
    maxGroupsPerAttribute: number;
    minGroupSize: { min: number; max: number; default: number };
    retentionDays: { min: number; max: number; default: number };
  };
  defaultThresholds: FairnessThreshold[];
}

export interface FairnessDatasetView {
  id: string;
  name: string;
  description: string | null;
  labelColumn: string;
  predictionColumn: string;
  favourableLabel: string;
  protectedAttributes: string[];
  rowCount: number;
  csvBytes: number;
  csvSha256: string;
  expiresAt: string;
  purgedAt: string | null;
  purgeReason: "retention" | "deleted" | null;
  rowsStored: boolean;
  createdAt: string;
}

export interface FairnessGroupView {
  group: string;
  n: number;
  labelPositives: number;
  predictedPositives: number;
  selectionRate: number;
  truePositiveRate: number | null;
  falsePositiveRate: number | null;
  included: boolean;
}

export interface FairnessEvaluationView {
  attribute: string;
  metric: FairnessMetric;
  value: number | null;
  limit: number;
  direction: "max" | "min";
  action: "fail" | "flag";
  status: "pass" | "breach" | "not_computable";
}

export interface FairnessRunView {
  id: string;
  cardId: string;
  datasetId: string;
  datasetSha256: string;
  minGroupSize: number;
  outcome: FairnessOutcome;
  blocks: boolean;
  createdAt: string;
  result: {
    rowCount: number;
    attributes: Array<{ attribute: string; groups: FairnessGroupView[]; metrics: Record<FairnessMetric, { value: number | null; reason?: string }> }>;
    evaluations: FairnessEvaluationView[];
  };
}

export interface FairnessView {
  settings: FairnessSettingsView;
  datasets: FairnessDatasetView[];
  runs: FairnessRunView[];
  note: string;
}

export const FAIRNESS_QUERY_KEY = ["admin", "mrm-fairness"] as const;

export function useFairness() {
  return useQuery({ queryKey: FAIRNESS_QUERY_KEY, queryFn: () => api.get<FairnessView>("/v1/mrm/fairness") });
}

export const METRIC_WORDS: Readonly<Record<FairnessMetric, { label: string; explain: string }>> = {
  demographic_parity_difference: {
    label: "Demographic parity difference",
    explain: "The gap between the highest and lowest rate of favourable predictions across groups. 0 means equal rates.",
  },
  disparate_impact_ratio: {
    label: "Disparate impact ratio",
    explain: "The lowest group's rate of favourable predictions divided by the highest group's. The four-fifths rule asks for at least 0.8.",
  },
  equal_opportunity_difference: {
    label: "Equal opportunity difference",
    explain: "The gap in true positive rate: of the rows whose true outcome was favourable, how often each group was predicted favourable.",
  },
  equalized_odds_difference: {
    label: "Equalised odds difference",
    explain: "The larger of the gaps in true positive rate and false positive rate across groups.",
  },
};

export const OUTCOME_WORDS: Readonly<Record<FairnessOutcome, { label: string; tone: "ok" | "warn" | "danger" | "neutral" }>> = {
  pass: { label: "Passed", tone: "ok" },
  flag: { label: "Flagged", tone: "warn" },
  fail: { label: "Failed", tone: "danger" },
  inconclusive: { label: "Inconclusive", tone: "warn" },
};

export const CHECK_WORDS: Readonly<Record<FairnessEvaluationView["status"], string>> = {
  pass: "within the threshold",
  breach: "breaches the threshold",
  not_computable: "could not be computed",
};

/** a rate or metric for display: three decimals, or a dash */
export function fmtMetric(v: number | null | undefined): string {
  return typeof v === "number" && Number.isFinite(v) ? v.toFixed(3) : "—";
}

/** the header row of a CSV, for the column pickers (the gateway parses the file properly) */
export function csvHeader(text: string): string[] {
  const first = text.replace(/^﻿/, "").split(/\r?\n/, 1)[0] ?? "";
  return first
    .split(",")
    .map((c) => c.trim().replace(/^"(.*)"$/, "$1"))
    .filter((c) => c.length > 0);
}
