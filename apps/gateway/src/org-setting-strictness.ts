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
 *
 * ADR-0186 decision 26 (PR #198 review round 6, amending B4S-04's "judge
 * against the strict default"): a change is a relaxation when the new value is
 * looser than the strict default OR looser than the value STORED now (the
 * locked row). An org that tightened a control beyond the default (an idle
 * window of 5 minutes, passwords of 30 characters) cannot loosen it back to the
 * default without the step-up. Ordered rules carry `looser(value, base)`; a rule
 * without one is a two-state or unordered setting whose every non-strict value
 * is already looser than the strict default, so the stored value adds nothing.
 *
 * Decision 27 (round 7, finding 39): the stored-value rule applies to the
 * EXEMPTIONS too. An exemption reasoned "the default is already the loosest
 * value" or "it only tightens" holds against the default, not against a stored
 * posture an admin tightened (sso-only on, an IP envelope enforced, a PII
 * category added, a retention override lengthened). Each such key is now a rule
 * with `relaxed` never true (no value is looser than its default) and a
 * `looser(value, stored)` comparator. An exemption that remains has a reason
 * that holds against the stored value as well.
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
  batch5SettingLooser,
  batch5SettingRelaxed,
  BATCH5_SETTING_KEYS,
  BATCH5_STRICT_DEFAULTS,
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
  /** an ordered setting: is `value` looser than `base` (the stored value)? */
  readonly looser?: (value: unknown, base: unknown) => boolean;
}
export interface StrictnessExemption {
  readonly kind: "exempt";
  /** why loosening this key needs no settings_relax step-up */
  readonly reason: string;
}
export type StrictnessEntry = StrictnessRule | StrictnessExemption;

const rule = (
  strict: unknown,
  relaxed: (value: unknown) => boolean,
  looser?: (value: unknown, base: unknown) => boolean,
): StrictnessRule => ({ kind: "rule", strict, relaxed, ...(looser ? { looser } : {}) });

/** ordered comparators: a larger number (null = unbounded) is looser; a smaller number is looser; a lower rank is looser */
const largerLooser = (v: unknown, b: unknown) =>
  v !== b && (v === null || (typeof v === "number" && typeof b === "number" && v > b));
const smallerLooser = (v: unknown, b: unknown) => typeof v === "number" && typeof b === "number" && v < b;
const rankLooser = (rank: Record<string, number>) => (v: unknown, b: unknown) =>
  (rank[String(v)] ?? -1) < (rank[String(b)] ?? -1);
/** a list of PROTECTIONS (each entry adds a check): dropping a stored entry is looser */
const dropsAny = (v: unknown, b: unknown) => {
  const next = new Set(Array.isArray(v) ? v.map(String) : []);
  return Array.isArray(b) && b.some((x) => !next.has(String(x)));
};
/** a list of PERMISSIONS (each entry widens what is allowed): an entry not stored is looser */
const addsAny = (v: unknown, b: unknown) => {
  const before = new Set(Array.isArray(b) ? b.map(String) : []);
  return Array.isArray(v) && v.some((x) => !before.has(String(x)));
};
/** a stored-only rule: nothing is looser than the default, but leaving a stricter stored posture is */
const fromStored = (strict: unknown, looser: (value: unknown, base: unknown) => boolean) => rule(strict, () => false, looser);
const IP_POLICY_RANK: Record<string, number> = { off: 0, enforce_at_login: 1, enforce_continuous: 2 };
/**
 * an IP allowlist: null or [] admits every address (net-policy.ts), so emptying a
 * non-empty list is looser, and any entry not stored (a new or wider CIDR) is
 * looser; dropping entries narrows it
 */
const allowlistLooser = (v: unknown, b: unknown) => {
  const stored = Array.isArray(b) ? b : [];
  const next = Array.isArray(v) ? v : [];
  if (stored.length === 0) return false;
  return next.length === 0 || addsAny(next, stored);
};
const exempt = (reason: string): StrictnessExemption => ({ kind: "exempt", reason });

/** anything other than the strict value is looser (an enum whose strict value is its strictest member) */
const notEqual = (strict: unknown) => rule(strict, (v) => v !== strict);
/** a larger number (or null = unbounded) is looser */
const atMost = (strict: number) => rule(strict, (v) => v === null || (typeof v === "number" && v > strict), largerLooser);
/** a smaller number is looser */
const atLeast = (strict: number) => rule(strict, (v) => typeof v === "number" && v < strict, smallerLooser);

const OPTIMISATION =
  "a pillar-6 optimisation dial: it changes what the gateway spends and how it answers, and refuses nothing";
const CAPACITY =
  "a capacity ceiling held at its schema wall; it bounds work and size, and is not a protection an admin relaxes";

const MFA_RANK: Record<string, number> = { off: 0, admins: 1, all: 2 };

const IDENTITY = STRICT_IDENTITY_DEFAULTS;

/**
 * The ORDERED batch settings' comparators against the stored value (decision
 * 26). Every other batch key is two-state, an enum whose strict value is its
 * strictest member, or a set whose every looser value is already looser than
 * the strict default (a protection list missing a member, a permission list
 * with an extra one) — so the strict-default predicate decides it alone.
 */
const BATCH_LOOSER: Readonly<Record<string, (value: unknown, base: unknown) => boolean>> = {
  // accountability (ADR-0182): longer windows / SLAs are looser
  decisionRegressionMaxAgeMinutes: largerLooser,
  feedbackAckSlaHours: largerLooser,
  feedbackResolveSlaDays: largerLooser,
  literacyDefaultValidityDays: largerLooser,
  // per-severity: any severity's SLA longer than it is now
  alertSlaHours: (v, b) => {
    const nv = v as Record<string, number> | null;
    const nb = b as Record<string, number> | null;
    return !!nv && !!nb && Object.keys(nb).some((s) => typeof nv[s] === "number" && nv[s]! > nb[s]!);
  },
  // batch 3 (ADR-0185): longer lifetimes are looser
  semanticCacheTtlSeconds: largerLooser,
  conversationRetentionDays: largerLooser,
  // batch 4 (ADR-0186)
  stepUpMaxAgeSeconds: largerLooser,
  monitorMcpBaselineDays: largerLooser,
  monitorJailbreakThreshold: largerLooser,
  toolApprovalSensitiveQuorum: smallerLooser,
  monitorJailbreakWindowHours: smallerLooser,
};

/** the per-batch registries keep their own predicates (ADR-0182 / 0185 / 0186) */
function fromBatches(): Record<string, StrictnessRule> {
  const out: Record<string, StrictnessRule> = {};
  for (const k of ACCOUNTABILITY_SETTING_KEYS) {
    out[k] = rule(ACCOUNTABILITY_STRICT_DEFAULTS[k], (v) => accountabilitySettingRelaxed(k, v as never), BATCH_LOOSER[k]);
  }
  for (const k of BATCH3_SETTING_KEYS) {
    out[k] = rule(BATCH3_STRICT_DEFAULTS[k], (v) => batch3SettingRelaxed(k, v as never), BATCH_LOOSER[k]);
  }
  for (const k of BATCH4_SETTING_KEYS) {
    out[k] = rule(BATCH4_STRICT_DEFAULTS[k], (v) => batch4SettingRelaxed(k, v as never), BATCH_LOOSER[k]);
  }
  // batch 5 (ADR-0187): every engine setting is ordered (a larger number, or approval off, is looser)
  for (const k of BATCH5_SETTING_KEYS) {
    out[k] = rule(BATCH5_STRICT_DEFAULTS[k], (v) => batch5SettingRelaxed(k, v as never), (v, b) => batch5SettingLooser(k, v, b));
  }
  return out;
}

type BatchKey =
  | (typeof ACCOUNTABILITY_SETTING_KEYS)[number]
  | (typeof BATCH3_SETTING_KEYS)[number]
  | (typeof BATCH4_SETTING_KEYS)[number]
  | (typeof BATCH5_SETTING_KEYS)[number];

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
  // decision 27: each entry ADDS detection; the default is the empty list (ADR-0117), so only removing a
  // category the org turned on loosens it
  piiInternationalCategories: fromStored([], dropsAny),
  envKeyFallbackEnabled: notEqual(false),
  // decision 27: acts while envKeyFallbackEnabled is relaxed (a rule); the default is every provider, so only
  // adding back a provider the org had removed loosens it
  envFallbackProviders: fromStored(["anthropic", "openai", "google", "xai"], addsAny),
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
  // decision 27: MAX-only overrides lengthen retention past the floor; removing or lowering a stored
  // override shortens it again
  modeAuditRetention: fromStored({}, (v, b) => {
    const next = (v ?? {}) as Record<string, number>;
    const stored = (b ?? {}) as Record<string, number>;
    return Object.entries(stored).some(([mode, days]) => !(mode in next) || next[mode]! < days);
  }),
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
  // decision 27: while content capture is on (a rule), a longer preview exports more prompt and output text
  tracingPreviewMaxChars: fromStored(4000, largerLooser),
  tracingOtlpEndpoint: exempt("adjudicated by the egress guard at write time and on every export (ADR-0070)"),
  tracingOtlpHeaders: exempt("the collector's credential, stored enveloped; where it may go is the egress guard's decision"),
  tracingOtlpServiceName: exempt("a label on exported spans"),

  // --- sign-in (ADR-0025 / ADR-0181) ----------------------------------------
  passwordMinLength: atLeast(12),
  passwordRequireClasses: atLeast(IDENTITY.passwordRequireClasses),
  sessionLifetimeHours: atMost(24),
  sessionIdleMinutes: atMost(IDENTITY.sessionIdleMinutes),
  mfaRequired: rule(IDENTITY.mfaRequired, (v) => (MFA_RANK[String(v)] ?? -1) < MFA_RANK[IDENTITY.mfaRequired]!, rankLooser(MFA_RANK)),
  // decision 27: off by default; turning a stored sso-only OFF re-opens password sign-in
  ssoOnly: fromStored(false, (v, b) => b === true && v === false),
  localSignIn: exempt("ANY change from the stored value needs its own break_glass step-up (breakGlassChange)"),
  breakGlassUserIds: exempt(
    "ANY change from the stored list (compared as a set) needs its own break_glass step-up (breakGlassChange)",
  ),
  loginLockoutThreshold: atMost(5),
  loginLockoutWindowMinutes: atLeast(15),
  loginLockoutMinutes: atLeast(15),
  usernameSelfService: notEqual(false),
  // decision 27: the ADR-0039 envelope ships off (nothing is looser than the default), but leaving a stored
  // envelope is: a policy turned down, a list emptied or given a new or wider entry
  sessionIpAllowlist: fromStored(null, allowlistLooser),
  sessionIpPolicy: fromStored("off", rankLooser(IP_POLICY_RANK)),
  apiKeyIpPolicy: fromStored("off", rankLooser(IP_POLICY_RANK)),
  apiKeyDefaultTtlDays: atMost(IDENTITY.apiKeyDefaultTtlDays),
  apiKeyMaxTtlDays: atMost(IDENTITY.apiKeyMaxTtlDays),
};

/** facts about the rest of the database a relaxation can depend on (read on the writer's transaction) */
export interface RelaxationFacts {
  /**
   * ADR-0186 decision 26 (PR #198 round 6, finding 37): a delegation is live
   * now. Turning delegation OFF then splits each delegator and delegate back
   * into two principals — the same approver-pool widening as ending the link
   * (finding 31) — so it is a relaxation while any delegation is live.
   */
  liveDelegation?: boolean;
}

/**
 * Every changed key now looser than its strict default OR than the value
 * stored now (`stored`, the locked row; decision 26) — named in the audit
 * row's `detail.relaxed`, and the facts the `settings_relax` step-up is bound
 * to. Derived from `ORG_SETTING_STRICTNESS` (plus `facts`) only.
 */
export function relaxedOrgSettingKeys(
  changed: Record<string, unknown>,
  stored?: Record<string, unknown>,
  facts: RelaxationFacts = {},
): WritableOrgSettingKey[] {
  // registry order (the batch registries first, as before), so the audit's list reads the same for the same write
  return (Object.keys(ORG_SETTING_STRICTNESS) as WritableOrgSettingKey[]).filter((k) => {
    const entry = ORG_SETTING_STRICTNESS[k];
    if (entry.kind !== "rule" || !(k in changed) || changed[k] === undefined) return false;
    const v = changed[k];
    if (entry.relaxed(v)) return true;
    if (stored && k in stored && entry.looser && entry.looser(v, stored[k])) return true;
    if (k === "approvalDelegationEnabled" && v === false && facts.liveDelegation && stored?.approvalDelegationEnabled !== false) return true;
    return false;
  });
}
