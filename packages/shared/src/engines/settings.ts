/**
 * ADR-0187 (batch 5) — the engine org settings: strict defaults, bounds, what
 * relaxing each gives up, and the relaxation predicate the strictness registry
 * (`org-setting-strictness.ts`) reads. Migration 0173 writes these values onto
 * the existing org row, as on a first load (ADR-0180, no grandfathering).
 *
 * Every relaxation goes through the audited `PUT /v1/org/settings` and needs a
 * `settings_relax` step-up (ADR-0186 decision 16: the registry is typed over
 * every writable key; decision 26: judged against the strict default AND the
 * stored value).
 */
import { z } from "zod";

/** the bounds (zod and the DB CHECKs of migration 0173 hold the same numbers) */
export const BATCH5_SETTING_LIMITS = {
  /** the longest any engine run may last, in minutes (2 hours is the ceiling) */
  engineMaxRunTimeoutMinutes: { min: 1, max: 120 },
  /** the budget a run gets when it names none, in USD */
  engineDefaultRunBudgetUsd: { min: 0.01, max: 1000 },
  /** a run whose budget is above this goes to the approvals queue first, in USD */
  engineRunApprovalThresholdUsd: { min: 0, max: 10_000 },
  /** how long an engine's raw report is kept (encrypted), in days */
  engineRawReportRetentionDays: { min: 1, max: 3650 },
  /** B5-M (migration 0175): the largest model artifact an upload may carry, in MiB */
  modelArtifactMaxMegabytes: { min: 1, max: 8192 },
} as const;

/** THE STRICT DEFAULTS. The column defaults of migration 0173 are these values. */
export const BATCH5_STRICT_DEFAULTS = Object.freeze({
  engineMaxRunTimeoutMinutes: 30 as number,
  engineDefaultRunBudgetUsd: 2 as number,
  engineRunApprovalThresholdUsd: 10 as number,
  engineRawReportRetentionDays: 90 as number,
  engineSensitiveSetApproval: true as boolean,
  modelArtifactMaxMegabytes: 512 as number,
});
export type Batch5Settings = {
  -readonly [K in keyof typeof BATCH5_STRICT_DEFAULTS]: (typeof BATCH5_STRICT_DEFAULTS)[K];
};
export type Batch5SettingKey = keyof Batch5Settings;
export const BATCH5_SETTING_KEYS = Object.keys(BATCH5_STRICT_DEFAULTS) as Batch5SettingKey[];

/** the snake_case column of each setting (migration 0173) */
export const BATCH5_SETTING_COLUMNS: Readonly<Record<Batch5SettingKey, string>> = {
  engineMaxRunTimeoutMinutes: "engine_max_run_timeout_minutes",
  engineDefaultRunBudgetUsd: "engine_default_run_budget_usd",
  engineRunApprovalThresholdUsd: "engine_run_approval_threshold_usd",
  engineRawReportRetentionDays: "engine_raw_report_retention_days",
  engineSensitiveSetApproval: "engine_sensitive_set_approval",
  modelArtifactMaxMegabytes: "model_artifact_max_megabytes",
};

/** What the strict default does, and what an admin gives up by relaxing it. */
export const BATCH5_SETTING_COPY: Readonly<Record<Batch5SettingKey, { label: string; strict: string; relaxed: string }>> = {
  engineMaxRunTimeoutMinutes: {
    label: "Longest engine run (minutes)",
    strict: "30 minutes: a run still going after that is stopped, its key revoked, and it reads as timed out.",
    relaxed: "A longer limit (up to 120 minutes) lets a run, and its key, stay live for longer.",
  },
  engineDefaultRunBudgetUsd: {
    label: "Default engine run budget (USD)",
    strict: "$2: a run that names no budget can spend at most this through the gateway before its key stops working.",
    relaxed: "A higher default lets every run that names no budget spend more before it is cut off.",
  },
  engineRunApprovalThresholdUsd: {
    label: "Engine run budget that needs approval (USD)",
    strict: "$10: a run with a larger budget waits in the approvals queue until someone approves it.",
    relaxed: "A higher threshold lets larger runs start without anyone approving them.",
  },
  engineRawReportRetentionDays: {
    label: "Raw engine report retention (days)",
    strict:
      "90 days: an engine's raw report is kept encrypted for 90 days, then deleted; its sha256 stays with the " +
      "normalised result.",
    relaxed: "A longer period keeps raw engine output, which can quote model text, for longer.",
  },
  engineSensitiveSetApproval: {
    label: "Approval for agentic and offensive engine sets",
    strict: "On: a run that uses an agentic or offensive set, or a set this build does not classify, needs approval first.",
    relaxed: "Off: such runs start without anyone approving them.",
  },
  modelArtifactMaxMegabytes: {
    label: "Largest model artifact upload (MiB)",
    strict: "512 MiB: a larger upload is refused before it is stored, and nothing of it is kept.",
    relaxed: "A larger limit (up to 8192 MiB) lets bigger hostile files into the artifact store and the scanner.",
  },
};

/**
 * Is `value` a RELAXATION of the strict default for `key`? A longer maximum
 * timeout, a higher default budget, a higher approval threshold, a longer raw
 * report retention and sensitive-set approval off are relaxations.
 */
export function batch5SettingRelaxed<K extends Batch5SettingKey>(key: K, value: Batch5Settings[K]): boolean {
  switch (key) {
    case "engineSensitiveSetApproval":
      return value !== true;
    default:
      return typeof value === "number" && value > (BATCH5_STRICT_DEFAULTS[key] as number);
  }
}

/** ordered comparator against the stored value (ADR-0186 decision 26): every batch-5 number is looser when larger */
export function batch5SettingLooser(key: Batch5SettingKey, value: unknown, stored: unknown): boolean {
  if (key === "engineSensitiveSetApproval") return stored === true && value === false;
  return typeof value === "number" && typeof stored === "number" && value > stored;
}

const bounded = (b: { min: number; max: number }) => z.number().min(b.min).max(b.max);
const boundedInt = (b: { min: number; max: number }) => z.number().int().min(b.min).max(b.max);

/** the batch-5 fields of `PUT /v1/org/settings` (spread into `updateOrgSettingsSchema`) */
export const batch5OrgSettingsFields = {
  /** strict 30; longer, up to 120, relaxes it */
  engineMaxRunTimeoutMinutes: boundedInt(BATCH5_SETTING_LIMITS.engineMaxRunTimeoutMinutes).optional(),
  /** strict 2; higher relaxes it */
  engineDefaultRunBudgetUsd: bounded(BATCH5_SETTING_LIMITS.engineDefaultRunBudgetUsd).optional(),
  /** strict 10; higher relaxes it */
  engineRunApprovalThresholdUsd: bounded(BATCH5_SETTING_LIMITS.engineRunApprovalThresholdUsd).optional(),
  /** strict 90; longer relaxes it */
  engineRawReportRetentionDays: boundedInt(BATCH5_SETTING_LIMITS.engineRawReportRetentionDays).optional(),
  /** strict true; false relaxes it */
  engineSensitiveSetApproval: z.boolean().optional(),
  /** strict 512; larger relaxes it (B5-M) */
  modelArtifactMaxMegabytes: boundedInt(BATCH5_SETTING_LIMITS.modelArtifactMaxMegabytes).optional(),
} as const;
