/**
 * ADR-0188 decision 10 — the identity org settings: strict defaults, bounds,
 * what relaxing each gives up, and the relaxation predicates the gateway's
 * strictness registry (`org-setting-strictness.ts`) reads. Migration 0180
 * writes these values onto the existing org row, as on a first load (ADR-0180,
 * no grandfathering).
 *
 * Every relaxation goes through the audited `PUT /v1/org/settings` and needs a
 * `settings_relax` step-up (ADR-0186 decisions 16 and 26: judged against the
 * strict default AND the stored value).
 *
 * NOT settings, by design (decision 10's invariants): an unbound bearer
 * delegated token, a delegation with no sponsor, a child grant wider than its
 * parent, a DPoP proof older than 60 s, and an over-scope or over-budget
 * delegation being narrowed instead of refused. None of them has a column.
 */
import { z } from "zod";
import { AGENT_ENTITLEMENT_MODES, WORKLOAD_CLIENT_AUTH_METHODS, type WorkloadClientAuthMethod } from "./contract.js";

/** the bounds (zod and the DB CHECKs of migration 0180 hold the same numbers) */
export const IDENTITY_SETTING_LIMITS = {
  /** a delegated access token's lifetime, in seconds (decision 5; OWNER DECISION 7) */
  delegatedTokenTtlSeconds: { min: 60, max: 3600 },
  /** how deep a delegation chain may go (0 = no agent may delegate onwards) */
  delegationMaxDepth: { min: 0, max: 8 },
  /** the longest a registered workload key or certificate is accepted, in days (OWNER DECISION 7: at most 90) */
  workloadKeyMaxAgeDays: { min: 1, max: 90 },
} as const;

/** THE STRICT DEFAULTS. The column defaults of migration 0180 are these values. */
export const IDENTITY_STRICT_DEFAULTS = Object.freeze({
  agentEntitlementMode: "own_grants" as (typeof AGENT_ENTITLEMENT_MODES)[number],
  delegatedTokenTtlSeconds: 300 as number,
  delegationMaxDepth: 3 as number,
  workloadClientAuthMethods: [...WORKLOAD_CLIENT_AUTH_METHODS] as WorkloadClientAuthMethod[],
  dpopNonceRequired: true as boolean,
  workloadKeyMaxAgeDays: 90 as number,
});
export type IdentitySettings = {
  -readonly [K in keyof typeof IDENTITY_STRICT_DEFAULTS]: (typeof IDENTITY_STRICT_DEFAULTS)[K];
};
export type IdentitySettingKey = keyof IdentitySettings;
export const IDENTITY_SETTING_KEYS = Object.keys(IDENTITY_STRICT_DEFAULTS) as IdentitySettingKey[];

/** the snake_case column of each setting (migration 0180) */
export const IDENTITY_SETTING_COLUMNS: Readonly<Record<IdentitySettingKey, string>> = {
  agentEntitlementMode: "agent_entitlement_mode",
  delegatedTokenTtlSeconds: "delegated_token_ttl_seconds",
  delegationMaxDepth: "delegation_max_depth",
  workloadClientAuthMethods: "workload_client_auth_methods",
  dpopNonceRequired: "dpop_nonce_required",
  workloadKeyMaxAgeDays: "workload_key_max_age_days",
};

/** What the strict default does, and what an admin gives up by relaxing it. */
export const IDENTITY_SETTING_COPY: Readonly<Record<IdentitySettingKey, { label: string; strict: string; relaxed: string }>> = {
  agentEntitlementMode: {
    label: "Least privilege for agents",
    strict:
      "On: an agent may do only what its own grants allow AND what the person it works for may do; an agent " +
      "with no grants of its own can do nothing.",
    relaxed:
      "Off (sponsor only): an agent may do anything the person it works for may do. The posture page shows " +
      "\"least privilege for agents: off\".",
  },
  delegatedTokenTtlSeconds: {
    label: "Delegated token lifetime (seconds)",
    strict: "300 seconds: a token an agent holds stops working five minutes after it was issued.",
    relaxed: "A longer lifetime (up to 3600 seconds) keeps a copied or leaked token usable for longer.",
  },
  delegationMaxDepth: {
    label: "Longest delegation chain",
    strict:
      "3: the first agent plus up to three delegations below it, so at most four agents in one chain. A fourth " +
      "delegation is refused.",
    relaxed:
      "A longer chain (up to 8 delegations, nine agents) lets authority travel through more agents before it " +
      "reaches a call.",
  },
  workloadClientAuthMethods: {
    label: "How workloads may sign in",
    strict:
      "Signed assertions from a registered key, client certificates and SPIFFE identities. Shared secrets are " +
      "never offered.",
    relaxed: "Adding back a method you removed lets workloads sign in that way again.",
  },
  dpopNonceRequired: {
    label: "Require a server nonce in proof-of-possession",
    strict: "On: every proof a workload sends must carry a nonce the gateway issued in the last five minutes.",
    relaxed: "Off: a proof made in advance can be used, which widens the window to replay a captured one.",
  },
  workloadKeyMaxAgeDays: {
    label: "Longest workload key lifetime (days)",
    strict: "90 days: a registered workload key or certificate is refused 90 days after it was added.",
    relaxed: "A limit you shortened, set longer again (never past 90 days), keeps keys valid for longer.",
  },
};

/**
 * Is `value` a RELAXATION of the strict default for `key`? Sponsor-only mode,
 * a longer token lifetime, a deeper chain and the nonce off are. The auth
 * method list and the key age cannot be looser than their defaults (the
 * default is already the widest list and the longest age); only a change
 * against a stricter STORED value is (see `identitySettingLooser`).
 */
export function identitySettingRelaxed<K extends IdentitySettingKey>(key: K, value: IdentitySettings[K]): boolean {
  switch (key) {
    case "agentEntitlementMode":
      return value !== IDENTITY_STRICT_DEFAULTS.agentEntitlementMode;
    case "dpopNonceRequired":
      return value !== true;
    case "workloadClientAuthMethods":
    case "workloadKeyMaxAgeDays":
      return false;
    default:
      return typeof value === "number" && value > (IDENTITY_STRICT_DEFAULTS[key] as number);
  }
}

/** ordered comparator against the stored value (ADR-0186 decision 26) */
export function identitySettingLooser(key: IdentitySettingKey, value: unknown, stored: unknown): boolean {
  switch (key) {
    case "agentEntitlementMode":
      return stored === "own_grants" && value === "sponsor_only";
    case "dpopNonceRequired":
      return stored === true && value === false;
    case "workloadClientAuthMethods": {
      // a PERMISSION list: any method not stored now is looser
      const before = new Set(Array.isArray(stored) ? stored.map(String) : []);
      return Array.isArray(value) && value.some((m) => !before.has(String(m)));
    }
    default:
      return typeof value === "number" && typeof stored === "number" && value > stored;
  }
}

const boundedInt = (b: { min: number; max: number }) => z.number().int().min(b.min).max(b.max);

/** the identity fields of `PUT /v1/org/settings` (spread into `updateOrgSettingsSchema`) */
export const identityOrgSettingsFields = {
  /** strict `own_grants`; `sponsor_only` relaxes it */
  agentEntitlementMode: z.enum(AGENT_ENTITLEMENT_MODES).optional(),
  /** strict 300; longer, up to 3600, relaxes it */
  delegatedTokenTtlSeconds: boundedInt(IDENTITY_SETTING_LIMITS.delegatedTokenTtlSeconds).optional(),
  /** strict 3; deeper, up to 8, relaxes it */
  delegationMaxDepth: boundedInt(IDENTITY_SETTING_LIMITS.delegationMaxDepth).optional(),
  /** strict = all four; removing one tightens it; `client_secret_*` is not a member and cannot be added */
  workloadClientAuthMethods: z
    .array(z.enum(WORKLOAD_CLIENT_AUTH_METHODS))
    .max(WORKLOAD_CLIENT_AUTH_METHODS.length)
    .refine((a) => new Set(a).size === a.length, { message: "duplicate entries" })
    // stored in the canonical order, so the same set always reads the same
    .transform((a) => WORKLOAD_CLIENT_AUTH_METHODS.filter((m) => a.includes(m)))
    .optional(),
  /** strict true; false relaxes it */
  dpopNonceRequired: z.boolean().optional(),
  /** strict 90 (the ceiling); shorter tightens it */
  workloadKeyMaxAgeDays: boundedInt(IDENTITY_SETTING_LIMITS.workloadKeyMaxAgeDays).optional(),
} as const;
