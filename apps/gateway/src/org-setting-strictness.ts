/**
 * B4S-04 (ADR-0180 / ADR-0181 / ADR-0186 A) — THE ONE STRICTNESS REGISTRY for
 * every setting `PUT /v1/org/settings` can write.
 *
 * `relaxedSettingKeys` (org-settings.ts) used to know only the accountability,
 * batch-3 and batch-4 settings, so relaxing a strict identity default
 * (`mfaRequired`, `sessionIdleMinutes`, `approvalDelegationEnabled`, the API-key
 * lifetimes), `approvalTtlHours`, or any other strict default of ADR-0181 went
 * through with no `settings_relax` step-up and no `detail.relaxed` in its audit
 * row. It now derives from this table, and the table is typed over EVERY
 * writable key: a key added to `updateOrgSettingsSchema` without an entry here
 * does not compile, and `zz-b4s-round2.test.ts` walks the schema at runtime
 * too. Each entry is one of:
 *
 *  - a RULE: the strict default and the predicate that says whether a value is
 *    looser than it (`relaxed`). A relaxation of a rule key is named in the
 *    audit row and needs a `settings_relax` step-up bound to its new value.
 *  - an EXEMPTION, with the reason the key protects nothing an admin could
 *    loosen through it (an optimisation dial, a capacity ceiling whose default
 *    is already its maximum, a setting that only ever tightens, or one whose
 *    loosening another step-up already covers). The reason is part of the
 *    review: an exemption with no honest reason is a finding.
 *
 * Strictness is ordered where the setting is ordered (a shorter session idle
 * window is stricter, so tightening asks for nothing), and a value of `null`
 * that means "never expires" / "no ceiling" is always a relaxation.
 */
import {
  accountabilitySettingRelaxed,
  ACCOUNTABILITY_SETTING_KEYS,
  ACCOUNTABILITY_STRICT_DEFAULTS,
  batch3SettingRelaxed,
  BATCH3_SETTING_KEYS,
  BATCH3_STRICT_DEFAULTS,
  batch4SettingRelaxed,
  BATCH4_SETTING_KEYS,
  BATCH4_STRICT_DEFAULTS,
  STRICT_IDENTITY_DEFAULTS,
  type UpdateOrgSettings,
} from "@regulait/shared";

/** every key `PUT /v1/org/settings` can store (the confirm flag is write-only) */
export type WritableOrgSettingKey = Exclude<keyof UpdateOrgSettings, "confirmIpLockout">;

export interface StrictnessRule {
  readonly kind: "rule";
  /** the strict default a fresh install starts with */
  readonly strict: unknown;
  /** is `value` looser than `strict`? */
  readonly relaxed: (value: unknown) => boolean;
}
export interface StrictnessExemption {
  readonly kind: "exempt";
  /** why loosening this key needs no settings_relax step-up */
  readonly reason: string;
}
export type StrictnessEntry = StrictnessRule | StrictnessExemption;

const rule = (strict: unknown, relaxed: (value: unknown) => boolean): StrictnessRule => ({ kind: "rule", strict, relaxed });
const exempt = (reason: string): StrictnessExemption => ({ kind: "exempt", reason });

/** anything other than the strict value is looser (an enum whose strict value is its strictest member) */
const notEqual = (strict: unknown) => rule(strict, (v) => v !== strict);
/** a larger number (or null = unbounded) is looser */
const atMost = (strict: number) => rule(strict, (v) => v === null || (typeof v === "number" && v > strict));
/** a smaller number is looser */
const atLeast = (strict: number) => rule(strict, (v) => typeof v === "number" && v < strict);

const OPTIMISATION =
  "a pillar-6 optimisation dial: it changes what the gateway spends and how it answers, and refuses nothing";
const CAPACITY =
  "a capacity ceiling held at its schema wall; it bounds work and size, and is not a protection an admin relaxes";

const MFA_RANK: Record<string, number> = { off: 0, admins: 1, all: 2 };

const IDENTITY = STRICT_IDENTITY_DEFAULTS;

/** the per-batch registries keep their own predicates (ADR-0182 / 0185 / 0186) */
function fromBatches(): Record<string, StrictnessRule> {
  const out: Record<string, StrictnessRule> = {};
  for (const k of ACCOUNTABILITY_SETTING_KEYS) {
    out[k] = rule(ACCOUNTABILITY_STRICT_DEFAULTS[k], (v) => accountabilitySettingRelaxed(k, v as never));
  }
  for (const k of BATCH3_SETTING_KEYS) out[k] = rule(BATCH3_STRICT_DEFAULTS[k], (v) => batch3SettingRelaxed(k, v as never));
  for (const k of BATCH4_SETTING_KEYS) out[k] = rule(BATCH4_STRICT_DEFAULTS[k], (v) => batch4SettingRelaxed(k, v as never));
  return out;
}

type BatchKey =
  | (typeof ACCOUNTABILITY_SETTING_KEYS)[number]
  | (typeof BATCH3_SETTING_KEYS)[number]
  | (typeof BATCH4_SETTING_KEYS)[number];

/** THE REGISTRY (see the header). Typed over every writable key. */
export const ORG_SETTING_STRICTNESS: { readonly [K in WritableOrgSettingKey]: StrictnessEntry } = {
  ...(fromBatches() as Record<BatchKey, StrictnessRule>),
  // the accountability block's one non-strictness key
  alertTicketConnectionId: exempt(
    "names the one PM connection automatic alert tickets go to; it acts only while alertTicketMode is relaxed, which is a rule",
  ),

  // --- pillar 6 (optimisation) ----------------------------------------------
  routingEnabled: exempt(OPTIMISATION),
  compactionEnabled: exempt(OPTIMISATION),
  promptCachingEnabled: exempt(OPTIMISATION),
  editVsRewriteEnabled: exempt(OPTIMISATION),
  filePreprocessingEnabled: exempt(OPTIMISATION),
  lazyToolLoadingEnabled: exempt(OPTIMISATION),
  defaultRoutingMode: exempt(OPTIMISATION),
  compactionThresholdTokens: exempt(OPTIMISATION),
  compactionRecentWindow: exempt(OPTIMISATION),
  minCacheableTokens: exempt(OPTIMISATION),
  cacheReadDiscount: exempt(OPTIMISATION),
  maxToolsInManifest: exempt(OPTIMISATION),
  minEditableBaselineTokens: exempt(OPTIMISATION),
  batchOverheadTokens: exempt(OPTIMISATION),
  minPreprocessTokens: exempt(OPTIMISATION),
  summarizerSelection: exempt(OPTIMISATION),
  summarizerAgentId: exempt(OPTIMISATION),
  // ADR-0181: the semantic cache stores prompts and answers — off by default
  semanticCachePolicy: notEqual("off"),
  // ADR-0181: a failed compaction refuses the call rather than sending the full context on
  compactionFailureMode: notEqual("fail_closed"),

  // --- governance / data ----------------------------------------------------
  defaultPiiMode: notEqual("block"),
  piiInternationalCategories: exempt(
    "the strict default is the empty list (ADR-0117 leaves the choice to the admin); each entry only ADDS detection",
  ),
  envKeyFallbackEnabled: notEqual(false),
  envFallbackProviders: exempt(
    "acts only while envKeyFallbackEnabled is relaxed (a rule), and its default is already every provider",
  ),
  customModelProvidersEnabled: notEqual(false),
  mcpPrivateRangesDefault: notEqual(false),
  mcpAdmissionMode: notEqual("enforce"),
  minReleaseAgeDays: atLeast(7),
  credentialUnusedDays: atMost(90),
  staleCredentialAlerts: notEqual(true),
  energyRegion: exempt("reporting only: which grid factor the energy estimate uses"),
  egressCompiledDefaultPolicy: notEqual("strict"),
  useCaseGateMode: notEqual("enforce"),
  dispatchAttributionRequired: notEqual(true),
  recommendationJudgeEnabled: exempt("adds a model-judged annotation to the deterministic findings; it refuses and allows nothing"),
  recommendationJudgeAgentId: exempt("names the judge of the annotation above; it refuses and allows nothing"),

  // --- budgets and approvals ------------------------------------------------
  budgetEnforcement: notEqual("block"),
  budgetHardBlockPct: atMost(100),
  approvalQuorum: notEqual("all"),
  checkReportsAllowUnbound: notEqual(false),
  approvalDelegationEnabled: notEqual(IDENTITY.approvalDelegationEnabled),
  // B4S-02 (owner principle): naming a default infra-remediation approver
  // decides who is offered those approvals; strict = nobody named by default
  infraApproverUserId: rule(null, (v) => v !== null),
  approvalTtlHours: atMost(72),

  // --- audit retention ------------------------------------------------------
  autoPruneEnabled: exempt(
    "schedules the prune; WHAT may be pruned is decided by the retention settings, whose shortening is a rule",
  ),
  pruneIntervalHours: exempt("how often the prune runs; what it may delete is decided by the retention settings"),
  // null (the default) keeps every row; a number lets older rows be pruned
  defaultAuditRetentionDays: rule(null, (v) => v !== null),
  modeAuditRetention: exempt("MAX-only overrides of the retention floor: they can only lengthen retention, never shorten it"),
  canaryObservationRetentionDays: atLeast(90),
  backupVerifyEnabled: notEqual(true),
  backupVerifyIntervalHours: atMost(24),

  // --- capacity ceilings ----------------------------------------------------
  defaultWorkerMaxTurns: exempt(CAPACITY),
  maxWorkerTurns: exempt(CAPACITY),
  maxAttachmentsPerDispatch: exempt(CAPACITY),
  maxAttachmentBytes: exempt(CAPACITY),
  imageTokenEstimateTokens: exempt(CAPACITY),
  sharedContextMaxChars: exempt(CAPACITY),
  nodeOutputMaxChars: exempt(CAPACITY),

  // --- RegulAIt-LLM ---------------------------------------------------------
  llmTrainingEnabled: notEqual(false),
  llmTrainingApprovalThresholdUsd: atMost(5),

  // --- tracing --------------------------------------------------------------
  tracingEnabled: exempt("span observability; every decision and refusal is in the audit chain whether or not spans are kept"),
  // ADR-0181: spans keep no prompt or output unless an admin turns this on
  tracingCaptureContent: notEqual(false),
  tracingPreviewMaxChars: exempt("bounds a preview's length; whether content is kept at all is tracingCaptureContent, a rule"),
  tracingOtlpEndpoint: exempt("adjudicated by the egress guard at write time and on every export (ADR-0070)"),
  tracingOtlpHeaders: exempt("the collector's credential, stored enveloped; where it may go is the egress guard's decision"),
  tracingOtlpServiceName: exempt("a label on exported spans"),

  // --- sign-in (ADR-0025 / ADR-0181) ----------------------------------------
  passwordMinLength: atLeast(12),
  passwordRequireClasses: atLeast(IDENTITY.passwordRequireClasses),
  sessionLifetimeHours: atMost(24),
  sessionIdleMinutes: atMost(IDENTITY.sessionIdleMinutes),
  mfaRequired: rule(IDENTITY.mfaRequired, (v) => (MFA_RANK[String(v)] ?? -1) < MFA_RANK[IDENTITY.mfaRequired]!),
  ssoOnly: exempt("the strict default is off; turning it on only narrows how people sign in"),
  localSignIn: exempt("changing it needs its own break_glass step-up (breakGlassChange)"),
  breakGlassUserIds: exempt("changing who holds the break-glass key needs its own break_glass step-up (breakGlassChange)"),
  loginLockoutThreshold: atMost(5),
  loginLockoutWindowMinutes: atLeast(15),
  loginLockoutMinutes: atLeast(15),
  usernameSelfService: notEqual(false),
  sessionIpAllowlist: exempt("the ADR-0039 envelope ships off and is opt-in: no value is looser than the default"),
  sessionIpPolicy: exempt("the ADR-0039 envelope ships off and is opt-in: no value is looser than the default"),
  apiKeyIpPolicy: exempt("the ADR-0039 envelope ships off and is opt-in: no value is looser than the default"),
  apiKeyDefaultTtlDays: atMost(IDENTITY.apiKeyDefaultTtlDays),
  apiKeyMaxTtlDays: atMost(IDENTITY.apiKeyMaxTtlDays),
};

/**
 * Every changed key now looser than its strict default — named in the audit
 * row's `detail.relaxed`, and the facts the `settings_relax` step-up is bound
 * to. Derived from `ORG_SETTING_STRICTNESS` only.
 */
export function relaxedOrgSettingKeys(changed: Record<string, unknown>): WritableOrgSettingKey[] {
  // registry order (the batch registries first, as before), so the audit's list reads the same for the same write
  return (Object.keys(ORG_SETTING_STRICTNESS) as WritableOrgSettingKey[]).filter((k) => {
    const entry = ORG_SETTING_STRICTNESS[k];
    return entry.kind === "rule" && k in changed && changed[k] !== undefined && entry.relaxed(changed[k]);
  });
}
