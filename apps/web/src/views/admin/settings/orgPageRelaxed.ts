/**
 * I-2 (review of #699): which settings on the Organisation page are relaxed, for the status row and the tab labels.
 *
 * The gateway's strictness registry (`apps/gateway/src/org-setting-strictness.ts`, ADR-0186 decision 26) is the one
 * source of what "relaxed" means. The SPA cannot import it at run time, so this module states the rule for each key the
 * page edits, and `orgPageRelaxed.test.ts` loads the registry and fails when:
 *  - a registry key the page edits is in none of the lists below (a new key forces a decision here);
 *  - a rule here disagrees with the registry's `relaxed` on any sample value, or names a key the registry exempts;
 *  - a key listed as exempt or stored-only is judged differently by the registry.
 *
 * A missing value reads as its default, as the page's forms do, so it is never counted as relaxed.
 */

export type OrgTab = "costs" | "data" | "network" | "gates" | "assist" | "themes";

export interface PageRelaxRule {
  tab: OrgTab;
  key: string;
  /** what the status row says while the setting is relaxed */
  label: string;
  relaxed: (val: unknown) => boolean;
  /** values the drift test checks against the registry, besides its strict default */
  samples: readonly unknown[];
}

const isOn = (val: unknown) => val === true || val === "true";
export const isOff = (val: unknown) => val === false || val === "false";
const isOneOf =
  (...vals: string[]) =>
  (val: unknown) =>
    typeof val === "string" && vals.includes(val);
const BOOL = [true, false] as const;

/** settings stored through PUT /v1/org/settings whose looser values the registry names (`kind: "rule"`) */
export const ORG_PAGE_RELAXED: readonly PageRelaxRule[] = [
  { tab: "costs", key: "semanticCachePolicy", label: "Semantic cache: on", relaxed: (v) => typeof v === "string" && v !== "off", samples: ["off", "opt_in", "always"] },
  { tab: "costs", key: "semanticCacheTtlSeconds", label: "Semantic cache entries kept over an hour", relaxed: (v) => typeof v === "number" && v > 3600, samples: [60, 3600, 3601, 86_400] },
  { tab: "costs", key: "compactionFailureMode", label: "Compaction failure: fail open", relaxed: isOneOf("fail_open"), samples: ["fail_closed", "fail_open"] },
  { tab: "costs", key: "budgetEnforcement", label: "Project budgets: warn only", relaxed: isOneOf("warn_only"), samples: ["block", "warn_only"] },
  { tab: "costs", key: "budgetHardBlockPct", label: "Budget hard block: above 100% or never", relaxed: (v) => v === null || (typeof v === "number" && v > 100), samples: [50, 100, 101, 200, null] },
  { tab: "data", key: "defaultPiiMode", label: "Default PII mode below block", relaxed: isOneOf("none", "log", "warn"), samples: ["block", "warn", "log", "none"] },
  { tab: "data", key: "envKeyFallbackEnabled", label: "Env-var key fallback: enabled", relaxed: isOn, samples: BOOL },
  { tab: "data", key: "contentCredentialGuard", label: "Credential guard for content: off", relaxed: isOff, samples: BOOL },
  { tab: "data", key: "defaultAuditRetentionDays", label: "Default audit retention: time-limited", relaxed: (v) => typeof v === "number", samples: [null, 30, 3650] },
  { tab: "network", key: "customModelProvidersEnabled", label: "Custom LLM providers: enabled", relaxed: isOn, samples: BOOL },
  { tab: "network", key: "mcpPrivateRangesDefault", label: "MCP private ranges: open", relaxed: isOn, samples: BOOL },
  { tab: "network", key: "a2aEnabled", label: "Calls to remote agents: on", relaxed: isOn, samples: BOOL },
  { tab: "network", key: "egressCompiledDefaultPolicy", label: "Compiled vendor endpoints: inherit", relaxed: isOneOf("inherit"), samples: ["strict", "inherit"] },
  { tab: "gates", key: "approvalQuorum", label: "Human-approval quorum: any one approver", relaxed: isOneOf("any"), samples: ["all", "any"] },
  { tab: "gates", key: "approvalDelegationEnabled", label: "Approver delegation: enabled", relaxed: isOn, samples: BOOL },
  { tab: "gates", key: "useCaseGateMode", label: "Use-case dispatch gate not enforcing", relaxed: isOneOf("warn", "off"), samples: ["enforce", "warn", "off"] },
  { tab: "gates", key: "dispatchAttributionRequired", label: "Project attribution: optional", relaxed: isOff, samples: BOOL },
  { tab: "gates", key: "checkReportsAllowUnbound", label: "Check reports without a round: allowed", relaxed: isOn, samples: BOOL },
  { tab: "assist", key: "frameworkImportsEnabled", label: "Framework imports: on", relaxed: isOn, samples: BOOL },
  { tab: "assist", key: "vendorDraftAssistEnabled", label: "Vendor questionnaire drafts: on", relaxed: isOn, samples: BOOL },
];

/**
 * settings the page writes through their own endpoints, outside PUT /v1/org/settings and so outside the registry; each
 * endpoint is a settings_relax step-up of its own
 */
export const ORG_PAGE_OWN_ENDPOINT: readonly PageRelaxRule[] = [
  { tab: "gates", key: "assuranceGateMode", label: "Continuous-assurance gate not enforcing", relaxed: isOneOf("warn", "off"), samples: ["enforce", "warn", "off"] },
  { tab: "gates", key: "riskTreatmentsEnabled", label: "Transferred and avoided treatments: on", relaxed: isOn, samples: BOOL },
];

/** settings the page shows through their `orgSettingSpecs` rows (the same strict/relaxed pill each row shows) */
export const ORG_PAGE_SPEC_TABS: ReadonlyArray<{ tab: OrgTab; keys: readonly string[] }> = [
  { tab: "data", keys: ["piiInternationalCategories"] },
  { tab: "gates", keys: ["approvalSignatureMode", "toolApprovalSensitiveQuorum", "approvalTtlHours", "approvalBulkMaxItems", "approvalBulkSensitiveBlocked"] },
];

/**
 * registry rules that no value can relax: they are judged only against the stored value (a tightening is kept, a
 * loosening of it needs the step-up), so the default itself is the loosest value and they never count here
 */
export const ORG_PAGE_STORED_ONLY: readonly string[] = ["sessionIpPolicy", "apiKeyIpPolicy", "sessionIpAllowlist", "envFallbackProviders"];

/** keys the registry exempts (functional tuning, no protection given up): never counted */
export const ORG_PAGE_EXEMPT: readonly string[] = [
  "routingEnabled",
  "compactionEnabled",
  "promptCachingEnabled",
  "editVsRewriteEnabled",
  "filePreprocessingEnabled",
  "lazyToolLoadingEnabled",
  "defaultRoutingMode",
  "summarizerSelection",
  "summarizerAgentId",
  "compactionThresholdTokens",
  "compactionRecentWindow",
  "minCacheableTokens",
  "cacheReadDiscount",
  "maxToolsInManifest",
  "minEditableBaselineTokens",
  "batchOverheadTokens",
  "minPreprocessTokens",
  "defaultWorkerMaxTurns",
  "maxWorkerTurns",
  "maxAttachmentsPerDispatch",
  "maxAttachmentBytes",
  "imageTokenEstimateTokens",
  "sharedContextMaxChars",
  "nodeOutputMaxChars",
  "autoPruneEnabled",
  "pruneIntervalHours",
  "recommendationJudgeEnabled",
  "recommendationJudgeAgentId",
  "themeDefaultPalette",
  "themeLocked",
];

/** every rule the status row evaluates directly (the spec-backed keys are judged by their specs) */
export const ORG_PAGE_RULES: readonly PageRelaxRule[] = [...ORG_PAGE_RELAXED, ...ORG_PAGE_OWN_ENDPOINT];
