/**
 * ADR-0190 decision 11 — the isolation org settings: strict defaults, bounds,
 * what relaxing each gives up, and the predicates the gateway's strictness
 * registry (`org-setting-strictness.ts`) reads. Migration 0183 writes these
 * values onto the existing org row (first load, ADR-0180: no grandfathering).
 *
 * Every relaxation goes through the audited `PUT /v1/org/settings` and needs a
 * `settings_relax` step-up, judged against the strict default AND the stored
 * value (ADR-0186 decisions 16 and 26).
 *
 * NOT settings, by design (decision 11's invariants, none has a column):
 * third-party code in the gateway's process or host namespaces, a fallback to a
 * class below the required one, calling L0 or L1 a sandbox, a child grant below
 * its parent's class, and a secret in a sandbox's environment, arguments or
 * image. A floor never goes below L1 (the schema has no L0 value).
 *
 * Where a setting lives elsewhere: the profile fields (network, secrets,
 * persistence, resources, runsc directfs) are relaxed per profile
 * (`executionProfileRelaxations`); the `customer_declared` mapping is per BYOC
 * executor (`executors.declared_class`, null = maps to nothing).
 */
import { z } from "zod";
import { isolationClassRank, REQUIRABLE_ISOLATION_CLASSES, type RequirableIsolationClass } from "./contract.js";

export const ISOLATION_ENFORCEMENT_MODES = ["enforce", "warn"] as const;
export type IsolationEnforcementMode = (typeof ISOLATION_ENFORCEMENT_MODES)[number];

/** the bounds (zod and the DB CHECKs of migration 0183 hold the same numbers) */
export const ISOLATION_SETTING_LIMITS = {
  /** the executor self-test runs hourly, so a limit under an hour would leave every executor stale */
  executorAttestationMaxAgeMinutes: { min: 60, max: 1440 },
} as const;

/** THE STRICT DEFAULTS (decision 11, OWNER DECISIONS 3, 4 and 9). The column defaults of migration 0183. */
export const ISOLATION_STRICT_DEFAULTS = Object.freeze({
  isolationEnforcement: "enforce" as IsolationEnforcementMode,
  isolationFloorPublic: "user_space_kernel" as RequirableIsolationClass,
  isolationFloorInternal: "user_space_kernel" as RequirableIsolationClass,
  isolationFloorConfidential: "user_space_kernel" as RequirableIsolationClass,
  isolationFloorRegulated: "microvm" as RequirableIsolationClass,
  isolationFloorMcpStdio: "user_space_kernel" as RequirableIsolationClass,
  isolationFloorEngineWorker: "user_space_kernel" as RequirableIsolationClass,
  executorAttestationMaxAgeMinutes: 120 as number,
});
export type IsolationSettings = {
  -readonly [K in keyof typeof ISOLATION_STRICT_DEFAULTS]: (typeof ISOLATION_STRICT_DEFAULTS)[K];
};
export type IsolationSettingKey = keyof IsolationSettings;
export const ISOLATION_SETTING_KEYS = Object.keys(ISOLATION_STRICT_DEFAULTS) as IsolationSettingKey[];

/** the class-valued settings */
export const ISOLATION_FLOOR_KEYS = [
  "isolationFloorPublic",
  "isolationFloorInternal",
  "isolationFloorConfidential",
  "isolationFloorRegulated",
  "isolationFloorMcpStdio",
  "isolationFloorEngineWorker",
] as const satisfies readonly IsolationSettingKey[];
type FloorKey = (typeof ISOLATION_FLOOR_KEYS)[number];
const isFloorKey = (k: IsolationSettingKey): k is FloorKey => (ISOLATION_FLOOR_KEYS as readonly string[]).includes(k);

/** a project's data sensitivity -> the floor setting that holds it (decision 7 item 2) */
export const SENSITIVITY_FLOOR_KEYS = {
  public: "isolationFloorPublic",
  internal: "isolationFloorInternal",
  confidential: "isolationFloorConfidential",
  regulated: "isolationFloorRegulated",
} as const satisfies Record<string, FloorKey>;

/** the snake_case column of each setting (migration 0183) */
export const ISOLATION_SETTING_COLUMNS: Readonly<Record<IsolationSettingKey, string>> = {
  isolationEnforcement: "isolation_enforcement",
  isolationFloorPublic: "isolation_floor_public",
  isolationFloorInternal: "isolation_floor_internal",
  isolationFloorConfidential: "isolation_floor_confidential",
  isolationFloorRegulated: "isolation_floor_regulated",
  isolationFloorMcpStdio: "isolation_floor_mcp_stdio",
  isolationFloorEngineWorker: "isolation_floor_engine_worker",
  executorAttestationMaxAgeMinutes: "executor_attestation_max_age_minutes",
};

const floorCopy = (what: string, strict: string) => ({
  label: `Isolation floor: ${what}`,
  strict,
  relaxed:
    "A lower floor (never below a hardened container) lets these calls run with weaker isolation; the evidence " +
    "records the class each call actually ran under.",
});

/** What the strict default does, and what an admin gives up by relaxing it. */
export const ISOLATION_SETTING_COPY: Readonly<Record<IsolationSettingKey, { label: string; strict: string; relaxed: string }>> = {
  isolationEnforcement: {
    label: "Enforce isolation",
    strict:
      "On: a call whose required isolation no executor can provide is refused before anything reaches the " +
      "upstream. There is never a fallback to weaker isolation.",
    relaxed:
      "Warn: the call is placed on the best isolation available and the shortfall is recorded as a gate warning. " +
      "The posture page shows \"Isolation: not enforced\". Third-party code still never runs in the gateway.",
  },
  isolationFloorPublic: floorCopy("public projects", "A user-space kernel sandbox (L2)."),
  isolationFloorInternal: floorCopy("internal projects", "A user-space kernel sandbox (L2)."),
  isolationFloorConfidential: floorCopy("confidential projects", "A user-space kernel sandbox (L2)."),
  isolationFloorRegulated: floorCopy("regulated projects", "A microVM sandbox with its own guest kernel (L3)."),
  isolationFloorMcpStdio: floorCopy("local (stdio) MCP servers", "A user-space kernel sandbox (L2)."),
  isolationFloorEngineWorker: floorCopy("engine workers", "A user-space kernel sandbox (L2)."),
  executorAttestationMaxAgeMinutes: {
    label: "Executor attestation lifetime (minutes)",
    strict: "120 minutes: an executor whose last passing self-test is older than two hours places nothing.",
    relaxed: "A longer lifetime (up to 24 hours) lets a host that drifted keep serving for longer before it is caught.",
  },
};

/**
 * Is `value` a RELAXATION of the strict default for `key`? A lower floor,
 * `warn`, and a longer attestation lifetime are.
 */
export function isolationSettingRelaxed<K extends IsolationSettingKey>(key: K, value: IsolationSettings[K]): boolean {
  if (key === "isolationEnforcement") return value !== ISOLATION_STRICT_DEFAULTS.isolationEnforcement;
  if (key === "executorAttestationMaxAgeMinutes") {
    return typeof value === "number" && value > ISOLATION_STRICT_DEFAULTS.executorAttestationMaxAgeMinutes;
  }
  if (isFloorKey(key)) {
    return (
      typeof value === "string" &&
      isolationClassRank(value as RequirableIsolationClass) < isolationClassRank(ISOLATION_STRICT_DEFAULTS[key])
    );
  }
  return false;
}

/** ordered comparator against the stored value (ADR-0186 decision 26): a floor raised by an admin is lowered back only with a step-up */
export function isolationSettingLooser(key: IsolationSettingKey, value: unknown, stored: unknown): boolean {
  if (key === "isolationEnforcement") return stored === "enforce" && value === "warn";
  if (key === "executorAttestationMaxAgeMinutes") {
    return typeof value === "number" && typeof stored === "number" && value > stored;
  }
  const rank = (c: unknown) => (REQUIRABLE_ISOLATION_CLASSES as readonly unknown[]).includes(c) ? isolationClassRank(c as RequirableIsolationClass) : -1;
  return typeof value === "string" && typeof stored === "string" && rank(value) < rank(stored);
}

const floor = z.enum(REQUIRABLE_ISOLATION_CLASSES).optional();

/** the isolation fields of `PUT /v1/org/settings` (spread into `updateOrgSettingsSchema`) */
export const isolationOrgSettingsFields = {
  /** strict `enforce`; `warn` relaxes it */
  isolationEnforcement: z.enum(ISOLATION_ENFORCEMENT_MODES).optional(),
  /** strict L2 / L2 / L2 / L3 by data sensitivity; lower (never below L1) relaxes it */
  isolationFloorPublic: floor,
  isolationFloorInternal: floor,
  isolationFloorConfidential: floor,
  isolationFloorRegulated: floor,
  /** strict L2; L1 relaxes it */
  isolationFloorMcpStdio: floor,
  /** strict L2 (OWNER DECISION 4); L1 relaxes it */
  isolationFloorEngineWorker: floor,
  /** strict 120; longer, up to 1440, relaxes it */
  executorAttestationMaxAgeMinutes: z
    .number()
    .int()
    .min(ISOLATION_SETTING_LIMITS.executorAttestationMaxAgeMinutes.min)
    .max(ISOLATION_SETTING_LIMITS.executorAttestationMaxAgeMinutes.max)
    .optional(),
} as const;
