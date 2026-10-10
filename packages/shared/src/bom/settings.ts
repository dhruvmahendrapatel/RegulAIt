/**
 * ADR-0189 §7 — the BOM org settings: strict defaults, bounds, what relaxing
 * each gives up, and the relaxation predicates the gateway's strictness
 * registry (`org-setting-strictness.ts`) reads. Migration 0182 writes these
 * values onto the existing org row, as on a first load (ADR-0180, no
 * grandfathering).
 *
 * Every relaxation goes through the audited `PUT /v1/org/settings` and needs a
 * `settings_relax` step-up (judged against the strict default AND the stored
 * value).
 *
 * NOT settings, by design (§7's invariants; no column exists): an unsigned BOM,
 * raw content in a BOM, an email address in a BOM, a `complete` composition
 * with an unrecorded member, editing a frozen BOM, a credential-bearing
 * endpoint (R47), and a display name in a Decision BOM (R45).
 */
import { z } from "zod";
import { DECISION_BOM_FINALITY_SETTINGS } from "./finality.js";

export const DECISION_FACTS_CAPTURE_MODES = ["on", "off"] as const;
export const BOM_EXPORT_ROLE_MODES = ["admins_only", "admins_and_auditors"] as const;
/** R45: `display_name` applies to AI BOMs only; a Decision BOM is always id-only */
export const BOM_PERSON_IDENTIFIER_MODES = ["id_only", "display_name"] as const;
export const AI_BOM_SNAPSHOT_TRIGGER_MODES = ["sign_off_events", "on_demand_only"] as const;
/** OWNER DECISION 12 / R25: no queue */
export const AI_BOM_SNAPSHOT_WITHOUT_KEY_MODES = ["refuse", "skip_and_record"] as const;
export const CYCLONEDX_EXPORT_VERSIONS = ["1.7", "1.6"] as const;

/** the bounds (zod and the DB CHECKs of migration 0182 hold the same numbers) */
export const BOM_SETTING_LIMITS = {
  bomExportRateLimitPerMinute: { min: 1, max: 600 },
} as const;

/** THE STRICT DEFAULTS. The column defaults of migration 0182 are these values. */
export const BOM_STRICT_DEFAULTS = Object.freeze({
  decisionFactsCapture: "on" as (typeof DECISION_FACTS_CAPTURE_MODES)[number],
  decisionBomFinality: "anchored" as (typeof DECISION_BOM_FINALITY_SETTINGS)[number],
  bomExportRoles: "admins_only" as (typeof BOM_EXPORT_ROLE_MODES)[number],
  bomPersonIdentifiers: "id_only" as (typeof BOM_PERSON_IDENTIFIER_MODES)[number],
  aiBomSnapshotTriggers: "sign_off_events" as (typeof AI_BOM_SNAPSHOT_TRIGGER_MODES)[number],
  aiBomSnapshotWithoutKey: "refuse" as (typeof AI_BOM_SNAPSHOT_WITHOUT_KEY_MODES)[number],
  cyclonedxExportVersions: ["1.7"] as (typeof CYCLONEDX_EXPORT_VERSIONS)[number][],
  bomExportRateLimitPerMinute: 30 as number,
});
export type BomSettings = { -readonly [K in keyof typeof BOM_STRICT_DEFAULTS]: (typeof BOM_STRICT_DEFAULTS)[K] };
export type BomSettingKey = keyof BomSettings;
export const BOM_SETTING_KEYS = Object.keys(BOM_STRICT_DEFAULTS) as BomSettingKey[];

/** the snake_case column of each setting (migration 0182) */
export const BOM_SETTING_COLUMNS: Readonly<Record<BomSettingKey, string>> = {
  decisionFactsCapture: "decision_facts_capture",
  decisionBomFinality: "decision_bom_finality",
  bomExportRoles: "bom_export_roles",
  bomPersonIdentifiers: "bom_person_identifiers",
  aiBomSnapshotTriggers: "ai_bom_snapshot_triggers",
  aiBomSnapshotWithoutKey: "ai_bom_snapshot_without_key",
  cyclonedxExportVersions: "cyclonedx_export_versions",
  bomExportRateLimitPerMinute: "bom_export_rate_limit_per_minute",
};

/** What the strict default does, and what an admin gives up by relaxing it. */
export const BOM_SETTING_COPY: Readonly<Record<BomSettingKey, { label: string; strict: string; relaxed: string }>> = {
  decisionFactsCapture: {
    label: "Decision BOM facts",
    strict: "On: every governed decision records the versions, digests and classifications behind it, in its own transaction.",
    relaxed:
      "Off: decisions made while off have no recorded facts, and their Decision BOM sections say not recorded forever. " +
      "The posture page shows \"Decision BOM: not captured\".",
  },
  decisionBomFinality: {
    label: "When a Decision BOM is final",
    strict:
      "Anchored: only once the decision is covered by an audit anchor written to storage observed as tamper-resistant, " +
      "timestamped when timestamps are required, with a lock that covers the retention period.",
    relaxed:
      "Unverified destination freezes on any flushed anchor (the BOM says the destination was not observed " +
      "tamper-resistant); chain signed freezes before any anchor exists.",
  },
  bomExportRoles: {
    label: "Who may export BOMs",
    strict: "Admins only.",
    relaxed: "Admins and people an admin has given an explicit auditor grant; every grant and export is audited.",
  },
  bomPersonIdentifiers: {
    label: "People in AI BOMs",
    strict: "Ids only. A Decision BOM is always ids only.",
    relaxed: "AI BOMs may carry the display names read when the snapshot was taken. Email addresses are never included.",
  },
  aiBomSnapshotTriggers: {
    label: "Automatic AI BOM snapshots",
    strict: "A signed snapshot is taken at every sign-off event (approvals, promotions, admissions, evidence).",
    relaxed: "Snapshots are taken only on demand, so a sign-off can pass with no record of what was signed off.",
  },
  aiBomSnapshotWithoutKey: {
    label: "Sign-off with no signing key",
    strict: "Refuse: an approval or promotion that would take a snapshot is refused while no receipt signing key is configured.",
    relaxed: "Skip and record: it proceeds, and an audited gap records that no snapshot was taken. No snapshot is taken later.",
  },
  cyclonedxExportVersions: {
    label: "CycloneDX export versions",
    strict: "1.7 only.",
    relaxed: "Adding 1.6 also renders the previous version for consumers that do not read 1.7 yet.",
  },
  bomExportRateLimitPerMinute: {
    label: "BOM exports per minute, per person",
    strict: "30 a minute.",
    relaxed: "A higher limit (up to 600) lets one person pull evidence in bulk faster.",
  },
};

/** Is `value` a RELAXATION of the strict default for `key`? */
export function bomSettingRelaxed<K extends BomSettingKey>(key: K, value: BomSettings[K]): boolean {
  switch (key) {
    case "cyclonedxExportVersions":
      return Array.isArray(value) && (value as string[]).some((v) => v !== "1.7");
    case "bomExportRateLimitPerMinute":
      return typeof value === "number" && value > BOM_STRICT_DEFAULTS.bomExportRateLimitPerMinute;
    default:
      return value !== BOM_STRICT_DEFAULTS[key];
  }
}

const FINALITY_RANK: Record<string, number> = { anchored: 3, anchored_unverified_destination: 2, chain_signed: 1 };

/** ordered comparator against the stored value (ADR-0186 decision 26) */
export function bomSettingLooser(key: BomSettingKey, value: unknown, stored: unknown): boolean {
  switch (key) {
    case "decisionBomFinality":
      return (FINALITY_RANK[String(value)] ?? 0) < (FINALITY_RANK[String(stored)] ?? 0);
    case "cyclonedxExportVersions": {
      const before = new Set(Array.isArray(stored) ? stored.map(String) : []);
      return Array.isArray(value) && value.some((v) => !before.has(String(v)));
    }
    case "bomExportRateLimitPerMinute":
      return typeof value === "number" && typeof stored === "number" && value > stored;
    default:
      return value !== stored && value !== BOM_STRICT_DEFAULTS[key];
  }
}

/** the BOM fields of `PUT /v1/org/settings` (spread into `updateOrgSettingsSchema`) */
export const bomOrgSettingsFields = {
  decisionFactsCapture: z.enum(DECISION_FACTS_CAPTURE_MODES).optional(),
  decisionBomFinality: z.enum(DECISION_BOM_FINALITY_SETTINGS).optional(),
  bomExportRoles: z.enum(BOM_EXPORT_ROLE_MODES).optional(),
  bomPersonIdentifiers: z.enum(BOM_PERSON_IDENTIFIER_MODES).optional(),
  aiBomSnapshotTriggers: z.enum(AI_BOM_SNAPSHOT_TRIGGER_MODES).optional(),
  aiBomSnapshotWithoutKey: z.enum(AI_BOM_SNAPSHOT_WITHOUT_KEY_MODES).optional(),
  /** 1.7 is always rendered; 1.6 may be added */
  cyclonedxExportVersions: z
    .array(z.enum(CYCLONEDX_EXPORT_VERSIONS))
    .min(1)
    .max(CYCLONEDX_EXPORT_VERSIONS.length)
    .refine((a) => new Set(a).size === a.length && a.includes("1.7"), "1.7 at most once and always present")
    .transform((a) => CYCLONEDX_EXPORT_VERSIONS.filter((v) => a.includes(v)))
    .optional(),
  bomExportRateLimitPerMinute: z
    .number()
    .int()
    .min(BOM_SETTING_LIMITS.bomExportRateLimitPerMinute.min)
    .max(BOM_SETTING_LIMITS.bomExportRateLimitPerMinute.max)
    .optional(),
};
