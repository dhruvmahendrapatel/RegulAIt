import { z } from "zod";
// ADR-0068 §5: the attack-class vocabulary is needed IN SCOPE here (not merely
// re-exported below) so the compliance-profile schema validates a framework's
// red-team gating classes against the one authoritative list.
import { RED_TEAM_ATTACK_CLASSES } from "./redteam.js";
// ADR-0097: the admission-mode enum is DEFINED in mcp-admission.ts and used by
// updateOrgSettingsSchema below, so it is imported as well as re-exported.
import { MCP_ADMISSION_MODES } from "./mcp-admission.js";
// ADR-0104: the approval-scope vocabulary is needed IN SCOPE here (not merely
// re-exported below) so `createApprovalRuleSchema` validates against the one
// authoritative list rather than a second copy of the two strings.
import { APPROVAL_SCOPES } from "./approval-binding.js";

export { detectPII, type PiiHit, type PiiCategory } from "./pii.js";

// ADR-0044 — the evaluation harness's pure half: the scorer registry (six
// deterministic kinds plus the model-backed judge's deterministic prompt/parse
// halves), the aggregate math, and the baseline-comparison gate decision that
// the workflow automated-check stage blocks on.
export {
  EVAL_SCORER_KINDS,
  DETERMINISTIC_SCORER_KINDS,
  JUDGE_BACKED_SCORER_KINDS,
  JUDGE_REFUSING_SCORER_KINDS,
  CONTEXT_REQUIRED_SCORER_KINDS,
  SCORING_SEMANTICS_VERSION,
  LEGACY_SCORING_SEMANTICS_VERSION,
  SCORING_SEMANTICS_CHANGELOG,
  scoringSemanticsSummary,
  scoringSemanticsMismatchReason,
  isJudgeBackedScorer,
  refusesWithoutJudge,
  requiresContext,
  judgeAvailabilityFor,
  isDeterministicScorer,
  evalScorerRegistry,
  evalScorerConfigSchema,
  evalScorerKindSchema,
  validateScorerConfig,
  validateAgainstSchema,
  scoreDeterministic,
  buildJudgePrompt,
  parseJudgeVerdict,
  aggregateEvalResults,
  evaluateEvalGate,
  createEvalDatasetSchema,
  createEvalCaseSchema,
  startEvalRunSchema,
  setEvalBaselineSchema,
  type EvalScorerKind,
  type EvalScorerInfo,
  type EvalScorerConfig,
  type EvalScore,
  type EvalScoreDetail,
  type DeterministicScoreInput,
  type EvalJudge,
  type EvalJudgeRequest,
  type EvalJudgeVerdict,
  type EvalAggregate,
  type EvalGateInput,
  type EvalGateDecision,
  type JudgeBackedScorerKind,
  type JudgeAvailability,
} from "./evals.js";

// ADR-0067 — GROUNDEDNESS. The locally-computable claim-support / context-
// precision / context-recall / answer-relevance metrics, plus the deterministic
// prompt-and-parse halves of the two JUDGE-BACKED metrics that refuse rather
// than degrade when no provider is configured.
export {
  splitClaims,
  hasNegation,
  isNoncommittal,
  scoreClaimSupport,
  scoreContextPrecision,
  scoreContextRecall,
  scoreAnswerRelevance,
  buildGroundednessJudgePrompt,
  parseGroundednessVerdict,
  DEFAULT_CLAIM_THRESHOLD,
  MIN_CLAIM_TOKENS,
  CLAIM_SNIPPET_MAX,
  CLAIM_DETAIL_MAX,
  type ClaimSupport,
  type ClaimSupportReport,
  type ClaimSupportOptions,
  type ContextPrecisionReport,
  type ContextRecallReport,
  type AnswerRelevanceReport,
  type GroundednessJudgeRequest,
  type GroundednessJudgeVerdict,
  type JudgedClaimVerdict,
} from "./groundedness.js";

// ADR-0088 — REGISTERED EXTERNAL SCORERS. The operator brings the instrument
// (a Fiddler-class scoring endpoint), the gateway brings the governance, and
// every score is stamped `method: "external:<name>"`. The pure contract
// parser, the pre-flight refusal (the ADR-0067/0072 honesty line extended to
// a third method family), and the admin write shapes.
export {
  externalScorerMethod,
  parseExternalScorerResponse,
  externalScorerAvailabilityFor,
  externalScorerKindSchema,
  createExternalScorerSchema,
  updateExternalScorerSchema,
  setExternalScorerEnabledSchema,
  EXTERNAL_SCORER_DISCLOSURE,
  EXTERNAL_SCORER_MAX_REASONS,
  EXTERNAL_SCORER_MAX_REASON_CHARS,
  type ExternalScorerRequest,
  type ExternalScorerVerdict,
  type ExternalScorerUse,
  type ExternalScorerFacts,
  type ExternalScorerAvailability,
  type CreateExternalScorer,
  type UpdateExternalScorer,
} from "./external-scorer.js";

// THE ONE TOKENIZER (hoisted here from training-provider by ADR-0067 so the
// retrieval index, the classifier and the groundedness metrics cannot disagree
// about what a word is).
export {
  tokenize,
  isNumericToken,
  buildIdf,
  weightedVector,
  cosine,
  STOPWORDS,
} from "./text.js";

// ADR-0045 — the model risk management registry's pure half: the effective
// status computation (which recomputes expiry from validUntil rather than
// trusting the swept status cache), the card-completeness assessment, the
// dispatch-gate decision, and the honest declared-vs-enforced posture label.
export {
  MODEL_CARD_APPROVAL_STATUSES,
  BIAS_FAIRNESS_STATUSES,
  biasFairnessEntrySchema,
  createModelCardSchema,
  updateModelCardSchema,
  requestModelCardSignOffSchema,
  attachModelCardEvidenceSchema,
  revokeModelCardApprovalSchema,
  effectiveApprovalStatus,
  isLiveApproval,
  daysUntilExpiry,
  cardState,
  assessBiasFairness,
  assessCardCompleteness,
  evaluateMrmGate,
  mrmPosture,
  type MrmApprovalStatus,
  type BiasFairnessStatus,
  type BiasFairnessEntryInput,
  type MrmApprovalLike,
  type MrmCardState,
  type BiasFairnessAssessment,
  type CardCompleteness,
  type MrmGateReason,
  type MrmGateDecision,
  type MrmGateCard,
} from "./mrm.js";

// ADR-0046 — the review workbench's pure half: rule matching (total, so two
// equally-specific rules never produce a non-deterministic queue), the DERIVED
// SLA clock that makes lazy breach evaluation honest, and the bulk fences.
export {
  APPROVAL_ASSIGNEE_KINDS,
  APPROVAL_ESCALATE_ACTIONS,
  APPROVAL_SLA_STATES,
  stagePatternMatches,
  ruleMatches,
  selectAssignmentRule,
  slaDeadlines,
  evaluateSla,
  bulkCapRefusal,
  bulkSensitivityFenced,
  createApprovalSlaPolicySchema,
  createApprovalAssignmentRuleSchema,
  bulkDecideApprovalsSchema,
  createApprovalSavedViewSchema,
  type ApprovalAssigneeKind,
  type ApprovalEscalateAction,
  type ApprovalSlaState,
  type ApprovalRoutingContext,
  type AssignmentRuleLike,
  type SlaPolicyLike,
  type SlaEvaluation,
  type BulkRefusalReason,
} from "./workbench.js";

// ADR-0047 — executive & compliance reporting's pure half: the period
// resolution, the ENTITLEMENT decision (which returns the exact project-id set
// a generation may query, so scoping is applied at query construction rather
// than as a post-hoc filter over an already-leaked aggregate), the section
// assembly, the gap-rendering control assessment, and the CSV round trip.
export {
  REPORT_KINDS,
  REPORT_SCOPE_KINDS,
  REPORT_PERIODS,
  REPORT_FORMATS,
  REPORT_ENTITLEMENT_SCOPES,
  REPORT_SECTIONS,
  REPORT_CADENCES,
  REPORT_ESTIMATE_DISCLAIMER,
  BUILT_IN_CONTROLS,
  createReportDefinitionSchema,
  createReportScheduleSchema,
  updateReportScheduleSchema,
  generateReportSchema,
  resolveReportPeriod,
  evaluateReportAccess,
  buildSpendSection,
  buildGovernanceSection,
  buildWorkflowSection,
  assessControls,
  reportCsvRows,
  renderReportCsv,
  parseReportCsv,
  defaultSectionsFor,
  scheduleIsDue,
  round6,
  type ReportKind,
  type ReportScopeKind,
  type ReportPeriod,
  type ReportFormat,
  type ReportEntitlementScope,
  type ReportSection,
  type ReportCadence,
  type ResolvedPeriod,
  type ReportAccessInput,
  type ReportAccessDecision,
  type SpendLine,
  type SpendSection,
  type GovernanceSection,
  type WorkflowSection,
  type ControlAssessment,
  type ComplianceSection,
  type ReportPayload,
  type ReportCsvRow,
} from "./reporting.js";

// ADR-0048 — immutable config versioning / canary / rollback's pure half: the
// DETERMINISTIC bucketing (a pure function of a stable key, so a multi-turn run
// cannot flip mid-conversation and the split is reproducible from a ledger row
// months later), the version resolution, and the eval-gated promotion decision.
export {
  CONFIG_ARTIFACT_TYPES,
  CONFIG_VERSION_STATUSES,
  LIVE_CANARY_ARTIFACT_TYPES,
  SHADOW_CANARY_ARTIFACT_TYPES,
  RESOLVED_ARTIFACT_TYPES,
  canaryIsLive,
  canaryIsShadowEvaluated,
  canaryIsEvaluated,
  canaryModeOf,
  canaryModeNote,
  VERSIONED_RULE_FIELDS,
  RULE_SELECTION_FIELDS,
  RULE_IDENTITY_FIELDS,
  isRuleArtifact,
  validateRuleVersionBody,
  ruleBodyFrom,
  applyRuleBody,
  // ADR-0074 — the pure half of the read-model write choke point
  definedRulePatch,
  partitionRulePatch,
  composeRuleBody,
  effectiveRuleBody,
  ruleBodiesEqual,
  planRuleEdit,
  assessCanaryBaseline,
  evaluateBaselineFreshness,
  resolveForShadow,
  createConfigVersionSchema,
  activateConfigVersionSchema,
  startCanarySchema,
  promoteCanarySchema,
  rollbackConfigSchema,
  fnv1a32,
  canaryBucket,
  resolveVersion,
  promptFromBody,
  evaluatePromotion,
  stableKeyFor,
  type ConfigArtifactType,
  type ConfigVersionStatus,
  type CreateConfigVersion,
  type VersionLike,
  type ResolvedVersion,
  type EvalEvidence,
  type PromotionDecision,
  type CanaryMode,
  type RuleBodyRejection,
  type ShadowResolution,
  type RulePatchPartition,
  type RuleEditPlan,
  type RuleEditPlanKind,
  type BaselineBucket,
  type BaselineAssessment,
  type StaleBaselineDecision,
} from "./config-versions.js";

// ADR-0049 — cost forecasting and spend-anomaly detection's pure half: the two
// documented projectors (run-rate and EWMA) with a real confidence interval and
// an explicit insufficient-data refusal, the Iglewicz–Hoaglin modified-z
// anomaly rule with its cold-start and absolute-floor rails, and the
// enforcement decision that routes through the EXISTING Approvals Queue while
// respecting ADR-0027 §9's compliance cost floor.
export {
  FORECAST_METHODS,
  ANOMALY_SIGNALS,
  ANOMALY_METHODS,
  ANOMALY_ACTIONS,
  ANOMALY_STATUSES,
  ANOMALY_SENSITIVITIES,
  SENSITIVITY_Z,
  ANOMALY_ABSOLUTE_FLOORS,
  MIN_BASELINE_SAMPLES,
  MIN_FORECAST_DAYS,
  MIN_FORECAST_ELAPSED_FRACTION,
  FORECAST_DISCLAIMER,
  ANOMALY_DISCLAIMER,
  spendMonitorPolicySchema,
  scheduledSpendChangeSchema,
  forecastQuerySchema,
  decideAnomalySchema,
  mean,
  median,
  stddev,
  mad,
  modifiedZ,
  ewma,
  bucketDaily,
  activeHours,
  budgetBreachDay,
  forecastSpend,
  detectAnomaly,
  detectUnusualModel,
  decideEnforcement,
  type ForecastMethod,
  type AnomalySignal,
  type AnomalyMethod,
  type AnomalyAction,
  type AnomalyStatus,
  type AnomalySensitivity,
  type SpendMonitorPolicyInput,
  type ForecastInput,
  type ForecastResult,
  type AnomalyInput,
  type AnomalyVerdict,
  type EnforcementInput,
  type EnforcementDecision,
} from "./forecasting.js";

// ADR-0050 — the data-lineage / provenance graph's pure half: the node/edge
// vocabularies, the derived natural key that keeps two captures of the same
// real thing on ONE node, and the bounded, cycle-safe, visibility-filtered
// traversal. `LINEAGE_COMPLETENESS_NOTE` is the scope sentence every answer
// carries: this is SUPPLIED-INPUTS provenance, never intra-model attribution.
export {
  LINEAGE_NODE_KINDS,
  LINEAGE_SUBTYPES,
  LINEAGE_EDGE_KINDS,
  LINEAGE_DIRECTIONS,
  LINEAGE_MAX_DEPTH,
  LINEAGE_DEFAULT_DEPTH,
  LINEAGE_MAX_NODES,
  LINEAGE_COMPLETENESS_NOTE,
  lineageNaturalKey,
  lineageQuerySchema,
  traverseLineage,
  directRunLineage,
  type LineageNodeKind,
  type LineageSubtype,
  type LineageEdgeKind,
  type LineageDirection,
  type LineageEdgeLike,
  type TraversalInput,
  type TraversalResult,
} from "./lineage.js";

// ADR-0051 — metering & billing's pure half: the rate-card vocabulary, the
// exact-beats-wildcard rate lookup, the deterministic ledger→money rating
// function (an unpriced event is UNPRICED, never zero), the statement assembly
// and its re-derivation check, the chargeback/showback CSV, and the
// `BillingProvider` port whose only implementation is the export-only,
// network-free `NoopBilling` (ADR-0051 §6's air-gapped default).
export {
  BILLING_DIMENSIONS,
  RATE_UNITS,
  RATING_MODES,
  STATEMENT_STATUSES,
  BILLING_SCOPE_KINDS,
  BILLING_BACKENDS,
  RATE_WILDCARD,
  BILLING_DISCLAIMER,
  EMPTY_PRICING_SNAPSHOT,
  NoopBilling,
  billingProviders,
  rateFor,
  billingKeyFor,
  rateUsage,
  seatLine,
  buildStatement,
  reconcileStatement,
  statementCsvRows,
  renderStatementCsv,
  parseStatementCsv,
  billingScopeKey,
  rateEntrySchema,
  createRateCardSchema,
  createBillingPeriodSchema,
  generateStatementSchema,
  issueStatementSchema,
  type BillingDimension,
  type RateUnit,
  type RatingMode,
  type StatementStatus,
  type BillingScopeKind,
  type BillingBackend,
  type RateEntry,
  type PricingSnapshot,
  type RatableEvent,
  type UsageLine,
  type RatedUsage,
  type SeatLine,
  type StatementPayload,
  type ReconcileDiff,
  type ReconcileResult,
  type StatementCsvRow,
  type BillingCapabilities,
  type MeteredUsage,
  type PushResult,
  type BillingProvider,
  type CreateRateCard,
  type CreateBillingPeriod,
} from "./billing.js";

// ADR-0052 — licensing & seats' pure half: the offline license document shape,
// the validity-window evaluation, the reviewed ACTION-CLASS inventory and the
// split-posture decision (governance fails OPEN past expiry, commercial
// expansion fails CLOSED), the seat-grant decision over ADR-0022's
// deactivate-never-delete definition, and the default-CLOSED tier feature read.
// No crypto here — verification lives in the gateway half, offline, against a
// pinned keyring.
export {
  LICENSE_SCHEMA_ID,
  LICENSE_DEPLOYMENT_MODES,
  LICENSE_FEATURES,
  LICENSE_STATES,
  LICENSE_ACTION_CLASSES,
  LICENSE_ACTION_INVENTORY,
  LICENSE_POSTURE_NOTE,
  SEAT_DEFINITION_NOTE,
  classifyAction,
  canonicalLicenseBytes,
  licenseDocumentSchema,
  installLicenseSchema,
  evaluateLicenseWindow,
  evaluateLicensedAction,
  evaluateSeatGrant,
  featureEnabled,
  type LicenseDeploymentMode,
  type LicenseFeature,
  type LicenseState,
  type LicenseActionClass,
  type ClassifiedAction,
  type LicenseDocument,
  type WindowEvaluation,
  type LicenseDecision,
  type LicenseDecisionInput,
  type SeatDecision,
  type FeatureDecision,
  type InstallLicense,
} from "./licensing.js";

// ADR-0042 — the guardrail engine's pure half: the detector registry, the
// block|warn|log verbs (piiMode's triad, plus an `off` member), the
// MAX-of-strictness composition that makes the compliance cascade a ceiling,
// and the counts-only evaluation result.
export {
  GUARDRAIL_DETECTOR_IDS,
  GUARDRAIL_MODES,
  GUARDRAIL_DETECTORS,
  GUARDRAIL_DEFAULT_MODES,
  guardrailRegistry,
  evaluateGuardrails,
  composeGuardrailModes,
  composeGuardrailTerms,
  guardrailCategoryList,
  guardrailWithheldMarker,
  strictestMode,
  modeAtLeast,
  type GuardrailDetectorId,
  type GuardrailMode,
  type GuardrailModes,
  type GuardrailTerms,
  type GuardrailHit,
  type GuardrailPhase,
  type GuardrailDetector,
  type GuardrailFinding,
  type GuardrailEvaluation,
} from "./guardrails.js";

// ADR-0097 — MCP ADMISSION SCANNING: the tool-poisoning gate's pure half. A
// deterministic, local, zero-network scan over one MCP tool manifest, reusing
// ADR-0042's prompt-injection and DLP detectors and adding the four
// manifest-specific classes they lack (tool-ordering directives, sensitive
// local paths, exfiltration-shaped directives, hidden/bidi Unicode).
export {
  MCP_ADMISSION_SEVERITIES,
  MCP_ADMISSION_MODES,
  MCP_ADMISSION_STATES,
  MCP_ADMISSION_HOLD_AT,
  MCP_ADMISSION_SCANNER_VERSION,
  scanMcpManifest,
  scanUnitsForTool,
  manifestDigest,
  nextAdmissionState,
  admissionFindingSummary,
  mcpAdmissionRuleIds,
  strictestSeverity,
  type McpAdmissionSeverity,
  type McpAdmissionMode,
  type McpAdmissionState,
  type McpAdmissionFinding,
  type McpAdmissionScan,
  type ScannableTool,
} from "./mcp-admission.js";

// ADR-0101 — FEDERATED MCP REGISTRY, the pure half: the v0.1 `ServerListResponse`
// wire schema, the remote-vs-package classification that decides what can become
// an `mcp_servers` row at all, and the verbatim name rule.
export {
  MCP_REGISTRY_API_VERSION,
  MCP_REGISTRY_LIST_PATH,
  MCP_REGISTRY_MAX_PAGE_SIZE,
  MCP_REMOTE_TRANSPORT_TYPES,
  MCP_REGISTRY_ENTRY_KINDS,
  MCP_CATALOGUE_REASONS,
  MCP_REGISTRY_UPSTREAM_STATUSES,
  MCP_IMPORT_CONFLICT_REASONS,
  mcpRegistryPageSchema,
  normalizeRegistryPage,
  classifyRegistryEntry,
  usableRemoteUrl,
  pickRemote,
  localServerNameFor,
  type McpRemoteTransportType,
  type McpRegistryEntryKind,
  type McpCatalogueReason,
  type McpRegistryUpstreamStatus,
  type McpImportConflictReason,
  type McpRegistryPagePayload,
  type NormalizedRegistryEntry,
  type NormalizedRegistryPage,
} from "./mcp-registry.js";

/** ADR-0097 — the admin CLEAR action on a held MCP server. A reason is
 * REQUIRED and there is no auto-clear: admitting a manifest a scanner flagged
 * is a decision somebody signs, not a timeout that expires. */
export const clearMcpAdmissionSchema = z
  .object({ reason: z.string().min(1).max(2000) })
  .strict();
export type ClearMcpAdmission = z.infer<typeof clearMcpAdmissionSchema>;

/** ADR-0042 admin write shapes. A mode is one of the four verbs; a partial map
 * lets an admin change one detector without restating the others.
 *
 * `pii` is deliberately NOT writable here. PII's mode is the §8.3 compliance
 * cascade's `piiMode` and nothing else — offering a second place to set it
 * would create two sources of truth for one control, and the weaker one would
 * eventually win an argument it should not be in. */
export const guardrailModeSchema = z.enum(["off", "log", "warn", "block"]);
export const guardrailModeMapSchema = z
  .object({
    prompt_injection: guardrailModeSchema.optional(),
    jailbreak: guardrailModeSchema.optional(),
    toxicity: guardrailModeSchema.optional(),
    semantic_dlp: guardrailModeSchema.optional(),
  })
  .strict();
const guardrailTermListSchema = z.array(z.string().min(1).max(120)).max(200);
export const guardrailTermMapSchema = z
  .object({
    prompt_injection: guardrailTermListSchema.optional(),
    jailbreak: guardrailTermListSchema.optional(),
    toxicity: guardrailTermListSchema.optional(),
    semantic_dlp: guardrailTermListSchema.optional(),
  })
  .strict();
export const putGuardrailConfigSchema = z.object({
  modes: guardrailModeMapSchema.optional(),
  customTerms: guardrailTermMapSchema.optional(),
});
export const guardrailSampleSchema = z.object({
  text: z.string().max(200_000),
  phase: z.enum(["input", "output"]).default("input"),
});

export const toolKindSchema = z.enum(["read", "write"]);
export type ToolKind = z.infer<typeof toolKindSchema>;

export const decisionEffectSchema = z.enum(["allow", "deny"]);
export type DecisionEffect = z.infer<typeof decisionEffectSchema>;

export const evaluateRequestSchema = z.object({
  userId: z.string().uuid(),
  serverId: z.string().uuid(),
  toolName: z.string().min(1),
});
export type EvaluateRequest = z.infer<typeof evaluateRequestSchema>;

export const createUserSchema = z.object({
  email: z.string().email(),
  displayName: z.string().min(1),
  isAdmin: z.boolean().optional(),
});

// ADR-0022 identity lifecycle -------------------------------------------------
/** rename — DISPLAY fields only, deliberately: the email is an identity anchor
 * (unique, credential-adjacent) and changing it is out of scope here. */
export const updateUserSchema = z
  .object({ displayName: z.string().min(1) })
  .strict();
/** promote/demote the admin flag; a demotion of the last active admin is
 * refused server-side (lockout guard). */
export const setUserAdminSchema = z
  .object({ isAdmin: z.boolean(), reason: z.string().min(1).max(2000).optional() })
  .strict();
/** deactivate carries an optional recorded reason; reactivate takes none. */
export const deactivateUserSchema = z
  .object({ reason: z.string().min(1).max(2000).optional() })
  .strict();
/** approver delegation window (admin-managed). */
export const createDelegationSchema = z
  .object({
    fromUserId: z.string().uuid(),
    toUserId: z.string().uuid(),
    startsAt: z.coerce.date(),
    endsAt: z.coerce.date(),
    reason: z.string().min(1).max(2000).optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.fromUserId === v.toUserId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "a delegation to oneself is meaningless",
        path: ["toUserId"],
      });
    }
    if (v.endsAt.getTime() <= v.startsAt.getTime()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "endsAt must be after startsAt",
        path: ["endsAt"],
      });
    }
  });
/** retire a workflow template — the why is required (it is the record). */
export const retireTemplateSchema = z
  .object({ reason: z.string().min(1).max(2000) })
  .strict();
/** delete a role: force is required when the role is still held, and force
 * requires a recorded reason (audited). */
export const deleteRoleSchema = z
  .object({ force: z.boolean().optional(), reason: z.string().min(1).max(2000).optional() })
  .strict();
/** delete a team: same force-with-reason contract when shared context blocks. */
export const deleteTeamSchema = z
  .object({ force: z.boolean().optional(), reason: z.string().min(1).max(2000).optional() })
  .strict();

export const createServerSchema = z.object({
  name: z.string().min(1),
  url: z.string().url(),
  /** ADR-0043: may this server's URL resolve into ordinary private LAN space?
   * null/absent = inherit the org default (mcpPrivateRangesDefault). IMDS /
   * link-local and the other unconditional ranges are never opened by this. */
  allowPrivateRanges: z.boolean().nullable().optional(),
});

/** ADR-0043: PATCH /v1/servers/:serverId — re-runs the egress guard whenever
 * the destination or the private-range posture changes (null restores
 * inheritance of the org default). */
export const updateServerSchema = z
  .object({
    name: z.string().min(1).optional(),
    url: z.string().url().optional(),
    allowPrivateRanges: z.boolean().nullable().optional(),
  })
  .strict();

export const createToolSchema = z.object({
  name: z.string().min(1),
  kind: toolKindSchema,
  description: z.string().optional(),
});

export const createToolGrantSchema = z.object({
  userId: z.string().uuid(),
  serverId: z.string().uuid(),
  toolName: z.string().min(1),
});

export const createServerGrantSchema = z.object({
  userId: z.string().uuid(),
  serverId: z.string().uuid(),
  readOnlyAll: z.boolean(),
});

// PILLAR 1 rule scoping: the shared discriminant every restriction rule carries.
// A rule targets exactly ONE subject dimension (scope) and ONE server dimension
// (serverScope). Defaults keep every legacy caller — userId + serverId with no
// scope — valid and unchanged (scope='user', serverScope='server'). The
// superRefine below mirrors the DB CHECK constraints byte-for-byte, so a bad
// discriminant is rejected loudly at the edge (400) rather than by Postgres (500).
export const ruleScopeSchema = z.enum(["user", "role", "team", "fleet"]);
export const ruleServerScopeSchema = z.enum(["server", "all"]);

const ruleScopeFields = {
  userId: z.string().uuid().nullable().optional(),
  serverId: z.string().uuid().nullable().optional(),
  roleId: z.string().uuid().nullable().optional(),
  teamId: z.string().uuid().nullable().optional(),
  scope: ruleScopeSchema.default("user"),
  serverScope: ruleServerScopeSchema.default("server"),
};

type RuleScopeShape = {
  scope: z.infer<typeof ruleScopeSchema>;
  serverScope: z.infer<typeof ruleServerScopeSchema>;
  userId?: string | null | undefined;
  serverId?: string | null | undefined;
  roleId?: string | null | undefined;
  teamId?: string | null | undefined;
};

function refineRuleScope(body: RuleScopeShape, ctx: z.RefinementCtx) {
  // subject discriminant — exactly the DB scope CHECK
  if (body.scope === "user" && !body.userId)
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "scope 'user' requires a userId", path: ["userId"] });
  if (body.scope === "role" && !body.roleId)
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "scope 'role' requires a roleId", path: ["roleId"] });
  if (body.scope === "team" && !body.teamId)
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "scope 'team' requires a teamId", path: ["teamId"] });
  if (body.scope === "fleet" && (body.userId || body.roleId || body.teamId))
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "scope 'fleet' takes no userId/roleId/teamId",
      path: ["scope"],
    });
  // server discriminant — exactly the DB server_scope CHECK
  if (body.serverScope === "server" && !body.serverId)
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "serverScope 'server' requires a serverId", path: ["serverId"] });
  if (body.serverScope === "all" && body.serverId)
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "serverScope 'all' takes no serverId", path: ["serverId"] });
}

export const createApprovalRuleSchema = z
  .object({
    ...ruleScopeFields,
    toolName: z.string().min(1).nullable().optional(),
    writeOnly: z.boolean().optional(),
    /** ADR-0104 — what a consent granted under this rule is BOUND TO.
     *  ABSENT is the default and the strict reading, 'action': the approval is
     *  bound to the exact arguments the approver signed for. 'tool' is the
     *  deliberate escape hatch, and an operator has to type it — it is the
     *  looser semantics, so it is never what you get by saying nothing. */
    approvalScope: z.enum(APPROVAL_SCOPES).optional(),
    approverUserId: z.string().uuid(),
  })
  .superRefine(refineRuleScope);

export const createRateLimitSchema = z
  .object({
    ...ruleScopeFields,
    toolName: z.string().min(1).nullable().optional(),
    maxCalls: z.number().int().positive(),
    windowSeconds: z.number().int().positive(),
  })
  .superRefine(refineRuleScope);

// The decider is the authenticated caller — never a body field.
export const decideApprovalSchema = z.object({
  decision: z.enum(["approved", "denied"]),
  reason: z.string().optional(),
});

export const createApiKeySchema = z.object({
  name: z.string().min(1),
  /** ADR-0098 — the caller-supplied expiry, ISO-8601. Three distinct inputs:
   *  - ABSENT: the org's `apiKeyDefaultTtlDays` applies, falling back to
   *    `apiKeyMaxTtlDays` when only a ceiling is configured, and to NO expiry
   *    when neither is (the shipped defaults — byte-identical to pre-0098).
   *  - a TIMESTAMP: honoured, unless it exceeds `apiKeyMaxTtlDays`, in which
   *    case issuance is REFUSED BY NAME (422) rather than clamped.
   *  - `null`: an explicit request for a key that never expires. Honoured
   *    when no ceiling is configured; refused by the SAME 422 when one is,
   *    because "no expiry" is the longest lifetime there is and a ceiling a
   *    caller can step over by asking for infinity is not a ceiling. */
  expiresAt: z.string().datetime().nullable().optional(),
});

export const createDataScopeRuleSchema = z
  .object({
    ...ruleScopeFields,
    toolName: z.string().min(1).nullable().optional(),
    argPath: z.string().min(1),
    allowedValues: z.array(z.string()).min(1),
  })
  .superRefine(refineRuleScope);

// ---------------------------------------------------------------------------
// Batch B1 (ADR-0073 residual) — the ordinary CRUD EDIT surface for the three
// restriction-rule kinds. Deliberately ENFORCING FIELDS ONLY, `.strict()`:
// the selection columns (scope/serverScope/userId/roleId/teamId/serverId)
// decide WHICH callers a rule is loaded for, and ADR-0073 §2 pins that
// rebinding a rule to a different subject is a NEW rule, never an edit — the
// route pre-checks those keys and refuses with the reason named, and strict
// parsing catches everything else. Every field optional: a PATCH names only
// what it means to move, and `applyRuleEdit` decides whether that is a policy
// change to version (mint + activate), a plain row write (unversioned rule —
// invariant 4), or a no-op. Value types mirror the version-body schemas in
// config-versions.ts, which re-validate the COMPOSED body before anything is
// stored.
// ---------------------------------------------------------------------------
const ruleDeployModeField = z.enum(["hosted", "byoc", "air_gapped"]).nullable().optional();

export const updateApprovalRuleSchema = z
  .object({
    toolName: z.string().min(1).nullable().optional(),
    writeOnly: z.boolean().optional(),
    approverUserId: z.string().uuid().optional(),
    deployMode: ruleDeployModeField,
  })
  .strict();

export const updateRateLimitSchema = z
  .object({
    toolName: z.string().min(1).nullable().optional(),
    maxCalls: z.number().int().min(0).optional(),
    windowSeconds: z.number().int().positive().optional(),
    deployMode: ruleDeployModeField,
  })
  .strict();

export const updateDataScopeRuleSchema = z
  .object({
    toolName: z.string().min(1).nullable().optional(),
    argPath: z.string().min(1).optional(),
    allowedValues: z.array(z.string()).min(1).optional(),
    deployMode: ruleDeployModeField,
  })
  .strict();

export const createRoleSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
});

export const createRoleToolGrantSchema = z.object({
  serverId: z.string().uuid(),
  toolName: z.string().min(1),
});

export const createRoleServerGrantSchema = z.object({
  serverId: z.string().uuid(),
  readOnlyAll: z.boolean(),
});

// §5 role-bundled AGENT/CONNECTOR grants — shape-identical to the direct
// agent/connector grant bodies so a role grant can never exceed a direct one.
export const createRoleAgentGrantSchema = z.object({
  agentId: z.string().uuid(),
  allowedModes: z.array(z.string().min(1)).nullable().optional(),
});

export const createRoleConnectorGrantSchema = z.object({
  connectorId: z.string().uuid(),
  mode: z.enum(["read", "readwrite"]),
  allowedObjects: z.array(z.string().min(1)).nullable().optional(),
});

export const assignRoleSchema = z.object({
  roleId: z.string().uuid(),
});

export const createRevocationSchema = z.object({
  userId: z.string().uuid(),
  serverId: z.string().uuid(),
  toolName: z.string().min(1).nullable().optional(),
});

/**
 * ADR-0019 per-user AGENT/CONNECTOR revocation — the subtractive override that
 * bounds ADR-0014's additive UNION-MAX role grants. The user is the path
 * parameter (mirroring the per-user model-credential routes), so the body
 * carries only the object and an optional admin justification. A revocation is
 * TOTAL for that (user, object): there is no partial-mode field, because a
 * narrower entitlement is what editing the grant is for, while a revocation
 * must be an unambiguous "not for this user".
 */
export const createAgentRevocationSchema = z.object({
  agentId: z.string().uuid(),
  reason: z.string().min(1).max(500).nullable().optional(),
});

export const createConnectorRevocationSchema = z.object({
  connectorId: z.string().uuid(),
  reason: z.string().min(1).max(500).nullable().optional(),
});

export const createAgentSchema = z.object({
  name: z.string().min(1),
  provider: z.string().min(1),
  tier: z.number().int().min(0),
  modes: z.array(z.string().min(1)).nullable().optional(),
  costPerMTokIn: z.number().nonnegative().nullable().optional(),
  costPerMTokOut: z.number().nonnegative().nullable().optional(),
  /** provider-native model id (e.g. claude-opus-5); null = not dispatchable */
  model: z.string().min(1).nullable().optional(),
  /** ADR-0023: admin-authored BASE system prompt — a governance artifact. When
   * set, every governed dispatch of this agent sends it as the system base; a
   * caller-supplied system is APPENDED after it, never replaces it. */
  systemPrompt: z.string().min(1).max(20_000).nullable().optional(),
  /** ADR-0034: which admin-registered custom endpoint this agent executes
   * against. The mirror of the DB's agents_custom_provider_ck — the pair is a
   * discriminated union, so provider 'custom' demands an id and any other
   * provider forbids one. Validated here too so the 400 says WHY. */
  customProviderId: z.string().uuid().nullable().optional(),
});

/** the discriminated-union rule shared by agent create and agent update */
export function agentCustomProviderPairValid(v: {
  provider?: string | undefined;
  customProviderId?: string | null | undefined;
}): boolean {
  if (v.provider === undefined) return true;
  return (v.provider === "custom") === (v.customProviderId != null);
}

export const createAgentSchemaChecked = createAgentSchema.refine(agentCustomProviderPairValid, {
  message:
    "provider 'custom' requires customProviderId, and customProviderId is only valid with provider 'custom'",
  path: ["customProviderId"],
});

export const setAgentEnabledSchema = z.object({ enabled: z.boolean() });

/** B1.5 — `PATCH /v1/agents/:agentId`: the ordinary admin edit surface for an
 * agent's DISPATCH-EXECUTION config, deliberately the same three fields
 * `VERSIONED_RULE_FIELDS.agent_config` names and nothing else (the ADR-0073
 * scope line at the route edge). The gateway routes the edit through
 * `applyRuleEdit`, so a versioned agent's edit mints + activates an
 * agent_config version and an unversioned agent keeps the plain row write —
 * never a raw column write that the dispatch-time resolver would ignore. */
export const updateAgentConfigSchema = z.object({
  model: z.string().min(1).nullish(),
  costPerMTokIn: z.number().nonnegative().nullish(),
  costPerMTokOut: z.number().nonnegative().nullish(),
});

/** ADR-0089 (gap L20): set/clear an agent's accountable human owner — a
 * governance record, not authentication. null CLEARS (an explicit act, the
 * agent-policy/system-prompt clear idiom); the gateway validates the user
 * exists and is not deactivated. */
export const setAgentOwnerSchema = z.object({ ownerUserId: z.string().uuid().nullable() });

/** ADR-0089: an agent lifecycle transition. `reason` is required for any
 * non-active target (enforced with a named 422 in the gateway so the refusal
 * is self-explaining); retired is terminal — the gateway refuses transitions
 * OUT of it by name. */
export const setAgentLifecycleSchema = z.object({
  status: z.enum(["active", "deprecated", "retired"]),
  reason: z.string().min(1).max(2000).optional(),
});

/** ADR-0023: set/clear an existing agent's admin base system prompt (null
 * clears — an explicit choice, mirroring the agent-policy clear semantics) */
export const setAgentSystemPromptSchema = z.object({
  systemPrompt: z.string().min(1).max(20_000).nullable(),
});

/** ADR-0066 §4: replace an agent's ORDERED provider fallback chain. PUT-the-
 * whole-list on purpose — a partial chain is never a valid intermediate state,
 * and an incremental API would need position renumbering, which is where this
 * kind of feature grows its bugs. An empty array clears the chain, explicitly.
 * The cap is deliberate: a chain longer than this is not a resilience strategy,
 * it is a request that will take minutes to fail. */
export const setAgentFallbacksSchema = z.object({
  fallbackAgentIds: z.array(z.string().uuid()).max(8),
});

export const createAgentGrantSchema = z.object({
  userId: z.string().uuid(),
  agentId: z.string().uuid(),
  allowedModes: z.array(z.string().min(1)).nullable().optional(),
});

export const setAgentPolicySchema = z.object({
  defaultAgentId: z.string().uuid().nullable().optional(),
  ceilingAgentId: z.string().uuid().nullable().optional(),
  routingMode: z.enum(["automatic", "passthrough"]).optional(),
  runBudgetUsd: z.number().positive().nullable().optional(),
  runBudgetBreachAction: z.enum(["approve", "replan"]).optional(),
});

export const invokeAgentSchema = z.object({
  mode: z.string().min(1).max(64),
  /** request text: complexity classification/token estimation input, and the
   * user turn actually sent to the model when dispatch=true */
  input: z.string().max(100_000).optional(),
  /** pillar-6 prompt caching: the stable system-prompt prefix sent as the
   * dispatch's `system`. A large, reused prefix is marked cacheable so repeat
   * dispatches read it from cache instead of re-billing it. Absent = no system
   * prompt (byte-identical to the pre-caching contract). */
  system: z.string().max(100_000).optional(),
  /** pillar-6 edit-vs-rewrite: the existing content the user is asking to
   * modify. When present and the request reads as a targeted edit, the model
   * is instructed to return a compact diff instead of re-emitting the whole
   * thing. Absent = plain generation (byte-identical to the pre-edit contract). */
  baseline: z.string().max(200_000).optional(),
  /** pillar-6 file preprocessing: large reference/file content attached to the
   * dispatch. It is deterministically shrunk (redundant whitespace collapsed,
   * long data blobs elided) before the model sees it. Absent = no reference
   * content (byte-identical to the pre-preprocessing contract). */
  referenceContent: z.string().max(500_000).optional(),
  /** multimodal uploads (mimics Claude's native attach): images the model sees
   * as vision and PDFs it reads as documents, carried base64 on the newest user
   * turn. Bounded in count and per-file size so a dispatch can't be used to
   * smuggle an unbounded payload; only providers with native vision (Claude)
   * see the bytes — others get a short "[attached image: name]" placeholder.
   * Text/code files are NOT attachments — they ride `referenceContent` instead,
   * where the pillar-6 preprocessor can shrink them. Absent = a text-only turn
   * (byte-identical to the pre-attachment contract). */
  attachments: z
    .array(
      z.object({
        kind: z.enum(["image", "document"]),
        name: z.string().min(1).max(256),
        mediaType: z.string().min(1).max(128),
        /** base64 (no data: prefix). ~9M chars ≈ 6.7MB decoded — a per-file
         * ceiling that keeps a single dispatch bounded. */
        dataBase64: z.string().min(1).max(9_000_000),
      }),
    )
    .max(8)
    .optional(),
  /** pillar-6 semantic caching: opt in to the REAL per-(user,agent) exact-match
   * response cache. When true and this dispatch's normalized input matches a
   * fresh stored row for the SAME user+agent, the stored response is served
   * WITHOUT a provider call; on a miss the dispatch runs normally and its result
   * is stored for later re-asks. Absent/false = no cache lookup or store
   * (byte-identical to the pre-caching contract). Never crosses users or agents. */
  semanticCache: z.boolean().optional(),
  costSensitivity: z.enum(["cost-sensitive", "standard", "quality-sensitive"]).optional(),
  /** true = actually execute the routed model (governed dispatch); absent/false
   * keeps the decision-only behavior */
  dispatch: z.boolean().optional(),
  maxTokens: z.number().int().min(1).max(64_000).optional(),
  /** with dispatch: deliver the response as SSE (delta events, then one
   * result event); governance and routing still decide BEFORE the stream opens */
  stream: z.boolean().optional(),
  /** pillar 5: attribute this call's cost to a project */
  projectId: z.string().uuid().optional(),
  /** PILLAR 2 §2 stage 2 (ADR-0079): attribute this call to a workflow
   * INSTANCE — the join point that lets the instance's current stage constrain
   * the call. Validated exactly like `projectId`: an unknown instance, or one
   * the caller may not drive, REFUSES (never silently ignored). While the named
   * instance rests at a `planning` stage, a mutating `mode` is refused
   * (`plan_only_stage`) and a plan/read mode is allowed. Attribution is
   * OPT-IN — an invoke that names no instance is unconstrained, exactly as
   * before. */
  instanceId: z.string().uuid().optional(),
  /** multi-turn: dispatch inside this conversation — the stored history rides
   * the request as the model's messages array, and the user+assistant turns
   * are persisted on completion. Only meaningful with dispatch=true; a
   * decision-only invoke never touches conversation history. */
  conversationId: z.string().uuid().optional(),
});

/** MULTI-TURN CONVERSATIONS: create an empty personal thread. The owner is
 * always the authenticated caller — never a body field. */
export const createConversationSchema = z.object({
  agentId: z.string().uuid(),
  /** pillar 5: default attribution for every turn dispatched in this thread */
  projectId: z.string().uuid().optional(),
});

export const createProjectSchema = z
  .object({
    name: z.string().min(1).max(200),
    costCenter: z.string().min(1).max(100).nullable().optional(),
    budgetUsd: z.number().positive().nullable().optional(),
    budgetApproverUserId: z.string().uuid().nullable().optional(),
    /** pillar-5 budget window: 'none' (lifetime) or 'monthly' (calendar month) */
    budgetPeriod: z.enum(["none", "monthly"]).optional(),
    /** warn (non-blocking) when windowed spend crosses this percent of budget;
     * the hard block stays at 100%, so 1..100 is the meaningful range */
    alertThresholdPct: z.number().int().min(1).max(100).optional(),
    /** §9 named arbiter for shared-context conflicts */
    arbiterUserId: z.string().uuid().nullable().optional(),
    /** §8.3 compliance framework tags, applied directly at creation */
    classifications: z.array(z.string().min(1).max(64)).max(16).optional(),
    /** pillar-5 rollup: parent Initiative id (reporting-only grouping) */
    initiativeId: z.string().uuid().nullable().optional(),
  })
  .refine((p) => p.budgetUsd == null || p.budgetApproverUserId != null, {
    message: "a project budget requires a budgetApproverUserId",
  });

/** Post-creation project edits (admin-only). Classifications are deliberately
 * absent — reclassification has its own diff-then-approve endpoint (§8.3) and
 * must never ride a plain PATCH. The budget-requires-approver invariant is
 * re-checked in the route against the MERGED row, since a patch may supply
 * either half. */
export const updateProjectSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    costCenter: z.string().min(1).max(100).nullable().optional(),
    budgetUsd: z.number().positive().nullable().optional(),
    budgetApproverUserId: z.string().uuid().nullable().optional(),
    budgetPeriod: z.enum(["none", "monthly"]).optional(),
    alertThresholdPct: z.number().int().min(1).max(100).optional(),
    arbiterUserId: z.string().uuid().nullable().optional(),
    /** pillar-5 rollup: parent Initiative id (reporting-only grouping) */
    initiativeId: z.string().uuid().nullable().optional(),
  })
  .refine((p) => Object.values(p).some((v) => v !== undefined), {
    message: "nothing to update — provide at least one field",
  });

/** pillar-5 cross-team rollup: an Initiative is a flat, reporting-only grouping
 * of projects for chargeback/showback above the single-project level. No
 * budget or enforcement in v1 — grouping only. */
export const createInitiativeSchema = z.object({
  name: z.string().min(1).max(200),
  costCenter: z.string().min(1).max(100).nullable().optional(),
});

export const updateInitiativeSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    costCenter: z.string().min(1).max(100).nullable().optional(),
  })
  .refine((p) => Object.values(p).some((v) => v !== undefined), {
    message: "nothing to update — provide at least one field",
  });

export const createModelCredentialSchema = z.object({
  // deliberately still the four SHIPPED vendor adapters. A custom provider's
  // key lives on its own custom_model_providers row (ADR-0034) — one endpoint,
  // one key — not in this per-provider-kind singleton table, which could only
  // ever hold ONE key for all custom endpoints.
  provider: z.enum(["anthropic", "openai", "google", "xai"]),
  apiKey: z.string().min(1),
  baseUrl: z.string().url().nullable().optional(),
});

// ---------------------------------------------------------------------------
// ADR-0034 — admin-registered custom LLM providers + the egress allow-list
// ---------------------------------------------------------------------------

export const customWireProtocolSchema = z.enum(["openai_chat", "anthropic_messages"]);
export type CustomWireProtocolValue = z.infer<typeof customWireProtocolSchema>;

export const createCustomModelProviderSchema = z
  .object({
    name: z.string().min(1).max(120),
    wireProtocol: customWireProtocolSchema,
    baseUrl: z.string().url(),
    /** null/absent = a KEYLESS endpoint (local Ollama, LocalAI, a gateway that
     * authenticates by network position). Explicitly permitted — inventing a
     * placeholder key would make "is this authenticated?" unanswerable. */
    apiKey: z.string().min(1).max(4096).nullable().optional(),
    /** the provider half of the plaintext-http opt-in; the matching
     * egress_allow_hosts row must set it too */
    allowPlaintextHttp: z.boolean().optional(),
  })
  .strict();
export type CreateCustomModelProvider = z.infer<typeof createCustomModelProviderSchema>;

/** PATCH — every field optional; `apiKey: null` CLEARS the stored key (making
 * the endpoint keyless), which is different from omitting it (keep as-is). */
export const updateCustomModelProviderSchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    wireProtocol: customWireProtocolSchema.optional(),
    baseUrl: z.string().url().optional(),
    apiKey: z.string().min(1).max(4096).nullable().optional(),
    allowPlaintextHttp: z.boolean().optional(),
  })
  .strict()
  .refine((p) => Object.values(p).some((v) => v !== undefined), {
    message: "nothing to update — provide at least one field",
  });
export type UpdateCustomModelProvider = z.infer<typeof updateCustomModelProviderSchema>;

export const setCustomModelProviderEnabledSchema = z.object({ enabled: z.boolean() }).strict();

/** An egress allow-list row. `host` is a bare hostname (or IP literal) — NOT a
 * URL, NOT a wildcard: the guard matches it exactly against the normalized
 * destination host, so `*.example.com` is not expressible on purpose. */
export const createEgressAllowHostSchema = z
  .object({
    host: z
      .string()
      .min(1)
      .max(253)
      .refine((h) => !/[\s@/:]/.test(h), {
        message: "host must be a bare hostname or IP literal — no scheme, port, credentials or path",
      }),
    /** the air-gapped escape hatch: lets THIS host resolve into an otherwise-
     * blocked range (RFC1918 / loopback / link-local / CGNAT). Off by default. */
    allowPrivateRanges: z.boolean().optional(),
    allowPlaintextHttp: z.boolean().optional(),
    note: z.string().min(1).max(500).nullable().optional(),
  })
  .strict();
export type CreateEgressAllowHost = z.infer<typeof createEgressAllowHostSchema>;

/** the connector-provider adapter enum (mirrors the CONNECTOR_PROVIDER_KINDS
 * union without importing the package into shared) */
export const connectorProviderKindSchema = z.enum([
  "http",
  "webhook",
  "slack",
  "github",
  "jira",
  "snowflake",
  "generic",
  "mock",
]);

export const createConnectorSchema = z.object({
  name: z.string().min(1),
  /** free-text display CATEGORY (unchanged) — NOT the execution adapter */
  kind: z.string().min(1),
  /** EXECUTION: the adapter that runs the call; absent = governance-only */
  providerKind: connectorProviderKindSchema.optional(),
  baseUrl: z.string().url().optional(),
  /** pillar 5 flat list price per allowed call; absent/null = unpriced */
  pricePerCallUsd: z.number().nonnegative().nullable().optional(),
});

/** platform connector credential (mirrors createModelCredentialSchema).
 * The ceiling fits ADR-0023's structured-JSON convention — a multi-field
 * credential (snowflake: {account, user, privateKey, passphrase?} with a
 * 4096-bit PEM key ≈ 3.4k chars) rides the SAME single token field. */
export const createConnectorCredentialSchema = z.object({
  token: z.string().min(1).max(16_384),
  baseUrl: z.string().url().nullable().optional(),
});

export const createConnectorGrantSchema = z.object({
  userId: z.string().uuid(),
  connectorId: z.string().uuid(),
  mode: z.enum(["read", "readwrite"]),
  allowedObjects: z.array(z.string().min(1)).nullable().optional(),
});

export const invokeConnectorSchema = z.object({
  operation: z.enum(["read", "write"]),
  object: z.string().min(1).max(256).optional(),
  /** EXECUTION: the write body / read parameters handed to the adapter */
  payload: z.record(z.unknown()).optional(),
  /** pillar 5: attribute this call's cost to a project */
  projectId: z.string().uuid().optional(),
});

export const changeDescriptorSchema = z.object({
  description: z.string().min(1),
  paths: z.array(z.string().min(1)),
  changeType: z.string().min(1),
  environment: z.string().min(1),
  /** ADR-0018 §4 dim: the target system this change lands on (a service, repo,
   * or environment name). Client-supplied like the other change attributes. The
   * OTHER new dim — initiatorRole — is deliberately NOT accepted here: it is
   * derived server-side from the authenticated initiator and can never be set by
   * the client. The 6th dim, dataSensitivity, is likewise NOT accepted: it is
   * derived server-side from the attributed project's compliance
   * classifications (ADR-0018 addendum / ADR-0019). */
  targetSystem: z.string().min(1).max(200).optional(),
});

export const createWorkflowTemplateSchema = z.object({
  name: z.string().min(1),
  definition: z.unknown(),
});

export const createAssignmentRuleSchema = z
  .object({
    templateId: z.string().uuid(),
    pathPattern: z.string().min(1).nullable().optional(),
    changeType: z.string().min(1).nullable().optional(),
    environment: z.string().min(1).nullable().optional(),
    /** ADR-0018 §4 dims: target system + initiator role (a role name). Both are
     * plain rule conditions; initiatorRole is matched against the SERVER-derived
     * roles of the initiating user at instance start. */
    targetSystem: z.string().min(1).max(200).nullable().optional(),
    initiatorRole: z.string().min(1).max(200).nullable().optional(),
    /** ADR-0018 addendum §4 dim (the 6th): a compliance classification tag. Like
     * initiatorRole it is a plain rule condition here, but matched against the
     * SERVER-derived classifications of the change's attributed project. */
    dataSensitivity: z.string().min(1).max(200).nullable().optional(),
  })
  .refine(
    (r) =>
      r.pathPattern ||
      r.changeType ||
      r.environment ||
      r.targetSystem ||
      r.initiatorRole ||
      r.dataSensitivity,
    { message: "an assignment rule needs at least one condition" },
  );

export const startInstanceSchema = z.object({
  /** pillar 5: the instance and any nested runs bill to this project */
  projectId: z.string().uuid().optional(),
  change: changeDescriptorSchema,
  /** admin-only explicit template pick, bypassing assignment rules */
  templateId: z.string().uuid().optional(),
});

export const submitArtifactSchema = z.object({
  stageId: z.string().min(1),
  content: z.string().min(1),
});

export const advanceStageSchema = z.object({
  stageId: z.string().min(1),
});

/** ADR-0077 — instantiate a workflow-template-gallery shape as a REAL template.
 * The gallery entry id names the shape; `name` names the created template;
 * `approverUserId` (optional) replaces every `requesting_user` approver
 * placeholder in the shape with a concrete user, resolved and validated by the
 * SAME template-creation path an admin-authored definition goes through. */
export const createFromGallerySchema = z.object({
  name: z.string().min(1).max(200),
  approverUserId: z.string().uuid().optional(),
});

/** §2 report per-check outcomes into an automated_check stage. A real CI posts
 * pass/fail (+ optional severity/detail) here; the demo/seed does too. A failing
 * required check parks the instance at blocked_on_check. Only names declared on
 * the stage are honoured (the gateway ignores unknown checks). */
export const reportChecksSchema = z.object({
  stageId: z.string().min(1),
  results: z
    .array(
      z.object({
        check: z.string().min(1),
        status: z.enum(["passed", "failed"]),
        severity: z.enum(["low", "medium", "high", "critical"]).optional(),
        detail: z.string().max(2000).optional(),
      }),
    )
    .min(1),
});

/** §2 re-run a check stage that is parked at blocked_on_check, after the failing
 * checks have been remediated and fresh passing results reported. */
export const recheckSchema = z.object({
  stageId: z.string().min(1),
});

/** Migration 0043: the per-provider-kind slice of a deploy target's config —
 * validated per kind by createDeployTargetSchema's superRefine and stored as
 * the deploy_targets.provider_config jsonb. Keys are flat (the provider column
 * is the discriminant, so no nesting is needed). */
export interface DeployTargetProviderConfig {
  /** aws: the ECS cluster rollbacks act on (was env REGULAIT_DEPLOY_AWS_CLUSTER only) */
  cluster?: string;
  /** azure: the customer subscription — replaces the roleArn-field reuse */
  subscriptionId?: string;
  /** azure: the resource group ARM deployments run in (was env-only) */
  resourceGroup?: string;
  /** azure: the templateLink URI ARM deployments deploy (was env-only) */
  templateUri?: string;
  /** gcp: the customer project — replaces the roleArn-field reuse */
  projectId?: string;
  /** gcp: the gs:// Terraform blueprint Infra Manager deploys (was env-only) */
  blueprintGcs?: string;
  /** kubernetes: the target namespace (environment doubles as it when unset) */
  namespace?: string;
}

/** which providerConfig keys each provider kind may carry — anything else on
 * that kind is rejected loudly (a typo'd or misplaced field must never be
 * silently ignored into a broken deploy) */
export const DEPLOY_TARGET_CONFIG_KEYS: Record<string, ReadonlyArray<keyof DeployTargetProviderConfig>> = {
  mock: [],
  aws: ["cluster"],
  azure: ["subscriptionId", "resourceGroup", "templateUri"],
  gcp: ["projectId", "blueprintGcs"],
  kubernetes: ["namespace"],
};

/** §2/§3 a governed deploy target a deployment/rollback stage acts on.
 * Credentials are optional (a mock/AWS-assume-role target needs none) and, when
 * given, stored encrypted. §3 BYOC: `mode` picks hosted / byoc / air_gapped, and
 * an aws target carries the customer role to assume + region.
 *
 * Migration 0043 (the #64 flagged gap): the AWS ARN grammar now applies to
 * roleArn ONLY when the provider is aws — pre-0043 it applied to every
 * provider, which made a real azure subscription or gcp project id fail
 * validation unless it happened to look like an AWS ARN. azure/gcp grow their
 * own named fields (subscriptionId / projectId — roleArn is still accepted as
 * the legacy account handle), and each kind's extra config
 * (cluster / resourceGroup / templateUri / blueprintGcs / namespace) is
 * validated per kind and stored on the row, so a target is configured where it
 * is defined instead of via gateway-wide env vars. */
export const createDeployTargetSchema = z
  .object({
    name: z.string().min(1).max(120),
    provider: z.enum(["mock", "aws", "azure", "gcp", "kubernetes"]),
    environment: z.string().min(1).max(80).optional(),
    baseUrl: z.string().url().max(2000).optional(),
    credential: z.string().min(1).max(8000).optional(),
    mode: z.enum(["hosted", "byoc", "air_gapped"]).optional(),
    /** aws: the customer IAM role to assume (arn:aws:iam::<acct>:role/<name>).
     * azure/gcp legacy: the account handle (subscription / project) — prefer
     * the named subscriptionId / projectId fields. */
    roleArn: z.string().min(1).max(2048).optional(),
    region: z.string().min(1).max(64).optional(),
    // --- migration 0043 per-kind config (flat; provider is the discriminant) ---
    /** aws: the ECS cluster rollbacks act on */
    cluster: z.string().min(1).max(255).optional(),
    /** azure: the customer subscription id */
    subscriptionId: z.string().min(1).max(128).optional(),
    /** azure: the resource group ARM deployments run in */
    resourceGroup: z.string().min(1).max(90).optional(),
    /** azure: the templateLink URI ARM deployments deploy */
    templateUri: z.string().url().max(2000).optional(),
    /** gcp: the customer project id */
    projectId: z
      .string()
      .regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/, "must be a valid gcp project id")
      .optional(),
    /** gcp: the gs:// Terraform blueprint Infra Manager deploys */
    blueprintGcs: z
      .string()
      .regex(/^gs:\/\/.+/, "must be a gs:// URI")
      .max(2000)
      .optional(),
    /** kubernetes: the target namespace */
    namespace: z
      .string()
      .regex(/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/, "must be a valid kubernetes namespace")
      .optional(),
  })
  .superRefine((v, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
    // per-kind key discipline: a config field on the wrong kind is a loud 400,
    // never silently dropped into a target that then fails at deploy time
    const allowed = new Set(DEPLOY_TARGET_CONFIG_KEYS[v.provider] ?? []);
    const configKeys: ReadonlyArray<keyof DeployTargetProviderConfig> = [
      "cluster", "subscriptionId", "resourceGroup", "templateUri", "projectId", "blueprintGcs", "namespace",
    ];
    for (const key of configKeys) {
      if (v[key] !== undefined && !allowed.has(key)) {
        issue(`'${key}' is not a config field of a ${v.provider} deploy target`);
      }
    }
    if (v.provider === "aws") {
      if (!v.roleArn || !v.region) issue("an aws deploy target needs a roleArn and region");
      // #64: the ARN grammar binds to aws ONLY — azure/gcp reuse roleArn as a
      // plain account handle and must not be forced through AWS's grammar
      if (v.roleArn && !/^arn:aws:iam::\d{12}:role\/.+/.test(v.roleArn)) {
        issue("roleArn must be an arn:aws:iam::<account>:role/<name>");
      }
    }
    if (v.provider === "azure" && (!(v.subscriptionId || v.roleArn) || !v.region)) {
      issue("an azure deploy target needs a subscriptionId (or legacy roleArn) and region");
    }
    if (v.provider === "gcp" && (!(v.projectId || v.roleArn) || !v.region)) {
      issue("a gcp deploy target needs a projectId (or legacy roleArn) and region");
    }
    if (v.provider === "kubernetes" && !v.credential) {
      issue("a kubernetes deploy target needs a kubeconfig credential");
    }
  });

/** assemble the validated flat per-kind fields into the provider_config jsonb
 * (null when none were given — a legacy-shaped row) */
export function deployTargetProviderConfig(
  v: z.infer<typeof createDeployTargetSchema>,
): DeployTargetProviderConfig | null {
  const out: DeployTargetProviderConfig = {};
  for (const key of DEPLOY_TARGET_CONFIG_KEYS[v.provider] ?? []) {
    const value = v[key];
    if (value !== undefined) out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** §2 resolve a deploy stage parked at blocked_on_deploy: the operator confirms
 * they deployed out-of-band (or accepts the condition) and the pipeline advances. */
export const deployOverrideSchema = z.object({
  stageId: z.string().min(1),
  /** Why the parked deploy is being cleared by hand ("deployed out-of-band",
   * "condition accepted"). Optional for an arm's-length operator; REQUIRED
   * when the person clearing the gate is the instance's own initiator, who is
   * otherwise self-attesting that their own change shipped. Same shape and
   * same reasoning as the self-review reason on an approval decision. */
  reason: z.string().min(1).max(2000).optional(),
});

export const createGitConnectionSchema = z.object({
  name: z.string().min(1),
  provider: z.enum(["github", "gitlab", "bitbucket", "azure_devops", "mock"]),
  baseUrl: z.string().url().optional(),
  token: z.string().min(1).max(512),
});

// EPIC-05 orchestration runs. The graph itself is validated by
// @regulait/orchestration-kernel — shared only frames the envelope.
export const createRunSchema = z.object({
  graph: z.unknown(),
  workflowInstanceId: z.string().uuid().optional(),
  /** pillar 5: every node dispatch of this run bills to this project */
  projectId: z.string().uuid().optional(),
});

// PILLAR 7 agent-driven task decomposition: a lead agent DRAFTS a plan; the
// human reviews/edits it and submits through the normal POST /v1/runs — the
// plan gate stays human.
export const decomposeGoalSchema = z.object({
  goal: z.string().min(10).max(4000),
  /** pillar 5: the lead dispatch bills to this project like any other call */
  projectId: z.string().uuid().optional(),
  /** explicit lead pick; defaults to the caller's default agent, then the
   * cheapest granted mock agent */
  leadAgentId: z.string().uuid().optional(),
});

/** The raw plan shape the lead agent must return from a decompose dispatch.
 * Agent references are NAMES from the roster the planning prompt supplied —
 * the gateway resolves them to granted agent ids (falling back, recorded,
 * when a name is unknown or ungranted). */
export const decompositionPlanSchema = z.object({
  name: z.string().min(1).max(200),
  nodes: z
    .array(
      z.object({
        id: z
          .string()
          .min(1)
          .max(64)
          .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "node id must be a kebab-case slug"),
        title: z.string().min(1).max(200),
        instruction: z.string().min(1).max(4000),
        agent: z.string().min(1).max(200),
        dependsOn: z.array(z.string().min(1)).default([]),
        /** pillar 7: MCP server NAMES this task's worker may draw tools from
         * (resolved to ids + entitlement-narrowed by the gateway). Optional —
         * a task with no tools is an ordinary single-turn worker. */
        toolServers: z.array(z.string().min(1).max(200)).optional(),
        /** pillar 7: max tool-using turns for this worker (gateway-bounded) */
        maxTurns: z.number().int().min(1).max(20).optional(),
        /** §5.1 Team-Lead delegation: the id of another node in this plan that
         * acts as this task's LEAD. Optional — a flat plan omits it. The
         * gateway validates the reference and the acyclic chain. */
        leadId: z.string().min(1).max(64).optional(),
        /** §5.1: when this task is itself a LEAD, the agent NAMES (from the
         * roster) a worker under it may be owned by — a ceiling the gateway
         * resolves to ids and NARROWS to the caller's own entitlements
         * (anything outside is dropped and recorded). */
        allowedAgents: z.array(z.string().min(1).max(200)).optional(),
        /** §5.1: when this task is itself a LEAD, the tool NAMES a worker under
         * it may call — a ceiling narrowed to the caller's entitled tools. */
        allowedTools: z.array(z.string().min(1).max(128)).optional(),
        /** §5.2 (B2): a SUGGESTED per-node budget cap in USD the lead proposes
         * for this task. Optional; carried into the submittable graph as the
         * node's budgetCapUsd. It is only ever a suggestion — the run's real
         * authority (the initiator's per-run budget + the transitive ceiling)
         * still enforces downstream, so a suggested cap can never grant spend. */
        budgetCapUsd: z.number().positive().optional(),
      }),
    )
    .min(2)
    .max(8),
});
export type DecompositionPlan = z.infer<typeof decompositionPlanSchema>;

export const autoAdvanceSchema = z.object({
  /** cap on successful dispatches in one pass */
  maxNodes: z.number().int().min(1).max(100).default(20),
  /** explicit opt-in: also accept each submission, letting dependents run.
   * Default false — review stays a human gate. */
  acceptReviews: z.boolean().optional(),
  /** per-node work instructions; a node absent here uses its title */
  inputs: z.record(z.string().max(100_000)).optional(),
  maxTokens: z.number().int().min(1).max(64_000).optional(),
});

export const dispatchNodeSchema = z.object({
  /** work instructions for the node's worker; defaults to the node title */
  input: z.string().max(100_000).optional(),
  maxTokens: z.number().int().min(1).max(64_000).optional(),
  /** pillar 7: override the node's declared tool-loop turn cap for this
   * dispatch (still gateway-bounded) */
  maxTurns: z.number().int().min(1).max(20).optional(),
  /**
   * ADR-0050: shared-context KEYS to supply to this worker as system context.
   * Each resolves to the CURRENT ACCEPTED REVISION of that key in the run's own
   * project — never a cross-project read, and never "the key as it was later".
   * Absent (the default) is byte-identical to the pre-lineage dispatch.
   *
   * This exists so that supplied-input lineage records something that was
   * genuinely supplied: the same list drives BOTH the injection into the
   * worker's system prompt AND the `flowed_into` edges. Recording an input the
   * worker never received would be exactly the fiction ADR-0050 is written
   * against, and deriving both from one list is what makes that impossible.
   */
  contextKeys: z.array(z.string().min(1).max(200)).max(20).optional(),
});

export const runEventSchema = z.object({
  kind: z.enum([
    "start",
    "node_started",
    "node_submitted",
    "node_accepted",
    "node_failed",
    "retry_node",
    "reassign_node",
    "escalate_node",
    "abort",
  ]),
  nodeId: z.string().min(1).max(64).optional(),
  ownerAgentId: z.string().uuid().optional(),
  error: z.string().min(1).max(2000).optional(),
});

// EPIC-06 PM-tool integration. The mapping override is validated by
// @regulait/pm-provider's zod schema in the gateway.
export const createPmConnectionSchema = z
  .object({
    name: z.string().min(1),
    provider: z.enum(["azure_devops", "jira", "linear", "asana", "monday", "generic_webhook", "mock"]),
    baseUrl: z.string().url().optional(),
    project: z.string().min(1),
    token: z.string().min(1).max(512),
    mapping: z.unknown().optional(),
    /** jira only: REST API version — 2 (legacy plain-text, the default) or
     * 3 (ADF rich-text descriptions/comments). Coerced so the admin portal's
     * select can post "3". */
    apiVersion: z.coerce.number().int().optional(),
    /** O7 (ADR-0027): drift policy — 'manual' (default = today's detect-only);
     * 'prefer_regulait' pushes the expected state back to the PM tool;
     * 'prefer_pm' adopts the PM tool's state on the link. */
    driftResolution: z.enum(["manual", "prefer_pm", "prefer_regulait"]).optional(),
  })
  .superRefine((body, ctx) => {
    if (body.apiVersion === undefined) return;
    if (body.apiVersion !== 2 && body.apiVersion !== 3) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "apiVersion must be 2 or 3", path: ["apiVersion"] });
    }
    if (body.provider !== "jira") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "apiVersion only applies to jira connections",
        path: ["apiVersion"],
      });
    }
  });

export const pmSyncSchema = z.object({ connectionName: z.string().min(1) });

// EPIC-06 §4 decision records. The decision maker is the authenticated
// caller — never a body field.
export const createDecisionSchema = z.object({
  objectType: z.enum(["run", "workflow_instance"]),
  objectId: z.string().uuid(),
  decision: z.string().min(1).max(2000),
  rationale: z.string().min(1).max(8000).optional(),
});

// ADR-0010: the normalized inbound webhook shape — provider-specific payload
// translation is a later adapter concern; this shape is the contract.
export const pmWebhookSchema = z.object({
  externalId: z.string().min(1).max(256),
  event: z.enum(["updated", "deleted", "commented"]),
  state: z.string().min(1).max(128).optional(),
  fields: z.record(z.unknown()).optional(),
});

// PILLAR 4 (§9, ADR-0011): teams + Shared-Project membership + context store.
export const createTeamSchema = z.object({
  name: z.string().min(1).max(200),
  /** §9.3 team default classifications (surfaced on conflict, never silently resolved) */
  defaultClassifications: z.array(z.string().min(1).max(64)).max(16).optional(),
});

// §8.3: one cascade profile per framework tag (upsert by tag).
export const upsertComplianceProfileSchema = z.object({
  tag: z.string().min(1).max(64),
  requiredTemplateIds: z.array(z.string().uuid()).max(16).optional(),
  mcpDefaultMode: z.enum(["read_only", "read_write"]).optional(),
  auditRetentionDays: z.number().int().positive().nullable().optional(),
  piiMode: z.enum(["block", "warn", "log"]).optional(),
  /** §8.3 -> §8.2: the backup retention + patch cadence floors this framework
   * forces onto any infra resource carrying its tag (pillar 3). */
  backupRetentionDays: z.number().int().positive().nullable().optional(),
  patchCadenceDays: z.number().int().positive().nullable().optional(),
  /** O2 (ADR-0027): project-budget ceiling (MIN-composed, strictest wins) */
  maxProjectBudgetUsd: z.number().positive().max(100_000_000).nullable().optional(),
  /** O2: enforcement floor — 'block' forces blocking even in a warn_only org */
  budgetEnforcement: z.enum(["block", "warn_only"]).nullable().optional(),
  /** ADR-0042: the guardrail FLOOR this framework forces onto every project
   * carrying its tag. MAX-composed with every other setting, so it can only
   * raise a layer. */
  guardrailModes: guardrailModeMapSchema.nullable().optional(),
  /** ADR-0068 §5: this framework's RED-TEAM opinion, on the same row as its PII
   * mode and guardrail floor rather than in a parallel config. Composed by the
   * cascade's existing rules (union / MAX / strictest-wins) and applied
   * TIGHTEN-ONLY, so a framework can raise a red-team bar and never lower one. */
  redteamGatingClasses: z.array(z.enum(RED_TEAM_ATTACK_CLASSES)).max(16).nullable().optional(),
  redteamMinTrials: z.number().int().min(1).max(25).nullable().optional(),
  redteamFailOnSeverity: z.enum(["low", "medium", "high", "critical"]).nullable().optional(),
});

// PILLAR 3 (§8.2): the governed infrastructure-operations layer.
export const createInfraResourceSchema = z.object({
  kind: z.enum(["control_plane", "agent_runtime", "cert", "backup_target"]),
  name: z.string().min(1).max(200),
  /** infra-provider kind; 'mock' (keyless, deterministic) for the MVP */
  provider: z.enum(["mock", "aws", "azure", "gcp"]).default("mock"),
  config: z.record(z.unknown()).optional(),
  /** §8.3 compliance tags; the cascade derives backup/patch floors */
  classifications: z.array(z.string().min(1).max(64)).max(16).optional(),
});

// An operational policy. A null resourceId is fleet-wide. The auto-remediate
// ceiling EXCLUDES 'critical' by construction — critical findings are always
// approval-gated regardless of policy.
export const createInfraPolicySchema = z.object({
  resourceId: z.string().uuid().nullable().optional(),
  patchCadenceDays: z.number().int().positive().nullable().optional(),
  certRotationDaysBeforeExpiry: z.number().int().positive().nullable().optional(),
  backupSchedule: z.string().min(1).max(200).nullable().optional(),
  backupRetentionDays: z.number().int().positive().nullable().optional(),
  driftBaseline: z.record(z.unknown()).nullable().optional(),
  autoRemediateMaxSeverity: z.enum(["low", "medium", "high"]).nullable().optional(),
});

// Scan on demand — optionally a single resource, else the whole fleet.
export const scanInfraSchema = z
  .object({ resourceId: z.string().uuid().optional() })
  .optional()
  .default({});

// Propose a governed remediation for an OPEN finding: a named approver gates it.
export const proposeInfraRemediationSchema = z.object({
  approverUserId: z.string().uuid(),
});

// ADR-0017 — the three operator verbs. Each is a thin wrapper that funnels a
// ledger row into the SAME governed approval path (objectType infra_operation)
// as proposeInfraRemediation: a named approver gates it, nothing mutates infra
// state until the approval is decided.
export const rotateCertSchema = z.object({
  approverUserId: z.string().uuid(),
});
export const applyPatchSchema = z.object({
  approverUserId: z.string().uuid(),
});
export const restoreBackupSchema = z.object({
  approverUserId: z.string().uuid(),
});

// §8.3 reclassification: a diff-then-approve change to a project's tags.
export const reclassifySchema = z.object({
  classifications: z.array(z.string().min(1).max(64)).max(16),
  /** required when the project already has classifications: the named admin
   * who reviews the cascade diff before it commits */
  reviewerUserId: z.string().uuid().optional(),
});

export const addTeamMemberSchema = z.object({ userId: z.string().uuid() });

export const addProjectMemberSchema = z.object({
  userId: z.string().uuid(),
  role: z.enum(["owner", "contributor", "viewer"]),
  /** the member's contributing team for provenance; must be one of their teams */
  teamId: z.string().uuid().nullable().optional(),
});

/** the owner's per-member role change (PATCH /projects/:id/members/:userId).
 * Membership is otherwise add-only; this and DELETE are the only mutators, and
 * both are guarded by last-owner protection so a project can't be orphaned. */
export const patchProjectMemberSchema = z.object({
  role: z.enum(["owner", "contributor", "viewer"]),
});

export const contributeContextSchema = z.object({
  key: z.string().min(1).max(128),
  content: z.string().min(1).max(200_000),
  /** the accepted revision this write is based on; required once the key exists */
  baseRevision: z.number().int().positive().optional(),
  /** contributing team for provenance; must be one of the writer's teams */
  teamId: z.string().uuid().nullable().optional(),
  /**
   * ADR-0050: the orchestration run + task-graph node that PRODUCED this write.
   * Optional and purely declarative — it is what turns a context write into a
   * `run --produced--> item(vN)` lineage edge, which is in turn what makes
   * lineage chain ACROSS runs (the item is then a source for whichever later
   * dispatch consumes it). Omitted = the write is recorded as an item version
   * with no producing run, which is the honest answer for a human's edit.
   */
  producedByRunId: z.string().uuid().optional(),
  producedByNodeId: z.string().min(1).max(64).optional(),
});

export const promoteContextSchema = z.object({
  /** the team-local workflow artifact to promote into shared context */
  artifactId: z.string().uuid(),
});

// ---------------------------------------------------------------------------
// ADR-0020 (Batch H) — IDE / existing-agent interception posture.
// Every axis is an ADMIN CHOICE. A PUT is a partial update: omitted fields keep
// their stored value, so an admin can flip one toggle without restating the
// whole posture.
// ---------------------------------------------------------------------------

/** How an IDE's `model` string resolves onto a governed agent. */
export const resolutionModeSchema = z.enum(["map_by_model", "require_agent", "router_decides"]);
export type ResolutionModeValue = z.infer<typeof resolutionModeSchema>;

/** The rung of the interception ladder the org DECLARES it is on. Descriptive,
 * not enforcing — it drives the honest warnings the admin UI shows. */
export const enforcementPostureSchema = z.enum([
  "observe",
  "voluntary",
  "managed",
  "key_custody",
  "network",
]);
export type EnforcementPostureValue = z.infer<typeof enforcementPostureSchema>;

export const updateInterceptionSettingsSchema = z
  .object({
    anthropicCompatEnabled: z.boolean().optional(),
    openaiCompatEnabled: z.boolean().optional(),
    mcpInterceptionEnabled: z.boolean().optional(),
    resolutionMode: resolutionModeSchema.optional(),
    enforcementPosture: enforcementPostureSchema.optional(),
    requireProjectAttribution: z.boolean().optional(),
    /** ADR-0024 (O11): the MCP twin of requireProjectAttribution — true
     * rejects an MCP tool call with no x-regulait-project-id pre-dispatch
     * instead of running it into the Unattributed bucket. */
    requireMcpAttribution: z.boolean().optional(),
    /** ADR-0024 (O15): true makes the key_custody rung ENFORCED — per-user
     * BYO credentials 409 on create/update and are skipped at dispatch
     * (org/platform credentials only). Reversible: stored rows are inert,
     * never deleted. */
    keyCustodyEnforced: z.boolean().optional(),
    /** ADR-0021: a stream=true call on a block-mode PII project — 'suppress'
     * (default) buffers and answers JSON with a disclosure; 'reject' 400s. */
    streamingOnBlockMode: z.enum(["suppress", "reject"]).optional(),
    /** ADR-0021: true disables the COMPAT_IGNORED_FIELDS accept-and-disclose
     * tier — an ignorable field (temperature) is a 400 again. */
    strictFieldRejection: z.boolean().optional(),
  })
  .strict();
export type UpdateInterceptionSettings = z.infer<typeof updateInterceptionSettingsSchema>;

// ---------------------------------------------------------------------------
// ADR-0024 (O13) — per-scope interception overrides (migration 0041).
// Precedence: user > project > role > org singleton; first non-NULL per field
// wins; ties within a kind = most recently created rule wins. A rule that
// enables a surface grants NOTHING — evaluateAgent still gates every dispatch.
// ---------------------------------------------------------------------------

export const interceptionScopeKindSchema = z.enum(["user", "project", "role"]);
export type InterceptionScopeKindValue = z.infer<typeof interceptionScopeKindSchema>;

const scopeRuleFields = {
  /** null = inherit from the next precedence level down */
  anthropicCompatEnabled: z.boolean().nullable().optional(),
  openaiCompatEnabled: z.boolean().nullable().optional(),
  resolutionMode: resolutionModeSchema.nullable().optional(),
  note: z.string().max(2000).nullable().optional(),
};

export const createInterceptionScopeRuleSchema = z
  .object({
    scopeKind: interceptionScopeKindSchema,
    scopeId: z.string().uuid(),
    ...scopeRuleFields,
  })
  .strict();
export type CreateInterceptionScopeRule = z.infer<typeof createInterceptionScopeRuleSchema>;

/** PATCH is a partial update of the override fields only — a rule's scope is
 * its identity; retargeting is delete + create. */
export const updateInterceptionScopeRuleSchema = z.object(scopeRuleFields).strict();
export type UpdateInterceptionScopeRule = z.infer<typeof updateInterceptionScopeRuleSchema>;

// ---------------------------------------------------------------------------
// ADR-0021 — ORG SETTINGS: org-wide functional defaults (migration 0038).
// A PUT is a PARTIAL update exactly like the interception posture: omitted
// fields keep their stored value, so an admin can flip one dial without
// restating the whole configuration. Every bound below either mirrors an
// existing zod wall (which stays the absolute maximum — an org setting can
// only narrow BELOW it) or a sane physical range for the dial.
// ---------------------------------------------------------------------------

export const orgRoutingModeSchema = z.enum(["automatic", "passthrough"]);
export const semanticCachePolicySchema = z.enum(["off", "opt_in", "always"]);
export const compactionFailureModeSchema = z.enum(["fail_open", "fail_closed"]);
export const summarizerSelectionSchema = z.enum(["cheapest", "fixed_agent"]);
export const orgPiiModeSchema = z.enum(["none", "log", "warn", "block"]);
export const budgetEnforcementSchema = z.enum(["block", "warn_only"]);
export const approvalQuorumSchema = z.enum(["all", "any"]);
export const mfaRequirementSchema = z.enum(["off", "admins", "all"]);
/** ADR-0039: the shared level set of both IP-policy knobs. */
export const ipPolicySchema = z.enum(["off", "enforce_at_login", "enforce_continuous"]);
/** ADR-0062: tighten-only. See `egressCompiledDefaultPolicy` below. */
export const egressCompiledDefaultPolicySchema = z.enum(["inherit", "strict"]);

export const updateOrgSettingsSchema = z
  .object({
    // pillar-6 technique toggles + org default routing mode
    routingEnabled: z.boolean().optional(),
    compactionEnabled: z.boolean().optional(),
    promptCachingEnabled: z.boolean().optional(),
    editVsRewriteEnabled: z.boolean().optional(),
    filePreprocessingEnabled: z.boolean().optional(),
    lazyToolLoadingEnabled: z.boolean().optional(),
    defaultRoutingMode: orgRoutingModeSchema.optional(),
    // pillar-6 numeric dials
    compactionThresholdTokens: z.number().int().min(100).max(1_000_000).optional(),
    compactionRecentWindow: z.number().int().min(1).max(100).optional(),
    minCacheableTokens: z.number().int().min(1).max(1_000_000).optional(),
    cacheReadDiscount: z.number().min(0).max(1).optional(),
    maxToolsInManifest: z.number().int().min(1).max(500).optional(),
    minEditableBaselineTokens: z.number().int().min(1).max(1_000_000).optional(),
    batchOverheadTokens: z.number().int().min(0).max(100_000).optional(),
    minPreprocessTokens: z.number().int().min(1).max(1_000_000).optional(),
    // semantic cache
    semanticCachePolicy: semanticCachePolicySchema.optional(),
    semanticCacheTtlSeconds: z.number().int().min(1).max(30 * 24 * 3600).optional(),
    // compaction behaviour
    compactionFailureMode: compactionFailureModeSchema.optional(),
    summarizerSelection: summarizerSelectionSchema.optional(),
    summarizerAgentId: z.string().uuid().nullable().optional(),
    // governance / compliance defaults
    defaultPiiMode: orgPiiModeSchema.optional(),
    envKeyFallbackEnabled: z.boolean().optional(),
    envFallbackProviders: z
      .array(z.enum(["anthropic", "openai", "google", "xai"]))
      .max(4)
      .optional(),
    /** ADR-0034: master switch for admin-registered custom LLM providers.
     * false refuses registration/enable and stops every custom dispatch (409). */
    customModelProvidersEnabled: z.boolean().optional(),
    /** ADR-0043: the org default for MCP servers whose allowPrivateRanges is
     * null. true (default) = private-LAN MCP URLs work with zero ceremony;
     * false = strict, requiring an explicit per-server flag or an allow entry.
     * IMDS/link-local stays unconditionally blocked either way. */
    mcpPrivateRangesDefault: z.boolean().optional(),
    /** ADR-0097: the MCP ADMISSION posture. 'off' (default) = no manifest
     * scan runs at all and behaviour is byte-identical to pre-0097. 'log' =
     * every manifest sync is scanned and the verdict/findings are recorded on
     * the server row, but nothing is ever refused. 'enforce' = a server whose
     * scan verdict is `held` is refused BEFORE any upstream connect and
     * contributes no tools to discovery, until an admin clears it with a
     * reason. Recommended production setting: 'enforce'. */
    mcpAdmissionMode: z.enum(MCP_ADMISSION_MODES).optional(),
    /** ADR-0062: the org's TIGHTENING dial over the deployment-wide egress
     * posture. 'inherit' (default) defers to the env-derived deploy mode;
     * 'strict' adjudicates compiled vendor endpoints against the egress
     * allow-list regardless of mode. There is deliberately NO value that
     * loosens an air_gapped deployment — the enum has no such member. */
    egressCompiledDefaultPolicy: egressCompiledDefaultPolicySchema.optional(),
    /** ADR-0080 amendment (migration 0098, batch B3): does an approved AI use
     * case gate dispatch? 'off' (default) = approval registers intent and
     * gates nothing — the shipped honest limit, byte-identical. 'warn'
     * records the refusal-shaped fact (audit row + response annotation)
     * without blocking. 'enforce' refuses a governed dispatch attributed to a
     * use-case-LINKED project (the `ai_use_cases.projectId` join — the only
     * one the schema holds) unless at least one linked use case is approved.
     * A project no use case links is untouched in every mode. */
    useCaseGateMode: z.enum(["off", "warn", "enforce"]).optional(),
    /** ADR-0080 amendment (migration 0101, batch B6b): must a governed
     * dispatch NAME a project? false (default) = today, byte-identical — an
     * unattributed dispatch runs and lands in the explicit "Unattributed" cost
     * bucket. true = a governed dispatch with no `projectId` is refused 409
     * `attribution_required`, audited, before any provider work. Independent
     * of `useCaseGateMode` by construction: this acts only where projectId is
     * null, that one only where it is not. */
    dispatchAttributionRequired: z.boolean().optional(),
    /** ADR-0092 amendment (migration 0100, L6c): may the deterministic
     * access-recommendation findings carry a MODEL-JUDGED annotation? false
     * (default) = the report is the six deterministic rules and nothing else.
     * The agent id names the judge; null clears it. An enabled knob with no
     * dispatchable judge reports `judged: unavailable` and changes nothing. */
    recommendationJudgeEnabled: z.boolean().optional(),
    recommendationJudgeAgentId: z.string().uuid().nullable().optional(),
    // budgets
    budgetEnforcement: budgetEnforcementSchema.optional(),
    budgetHardBlockPct: z.number().int().min(1).max(100).optional(),
    // approvals
    approvalQuorum: approvalQuorumSchema.optional(),
    // ADR-0022: approver-delegation master switch + persisted default
    // infra-remediation approver (null clears it)
    approvalDelegationEnabled: z.boolean().optional(),
    infraApproverUserId: z.string().uuid().nullable().optional(),
    // audit retention
    autoPruneEnabled: z.boolean().optional(),
    pruneIntervalHours: z.number().int().min(1).max(24 * 30).optional(),
    defaultAuditRetentionDays: z.number().int().positive().nullable().optional(),
    /** A4 (migration 0044): MAX-only per-deploy-mode retention overrides —
     * a full replacement map mode -> days ({} clears every override). An
     * override below the global floor is accepted but inert: composition is
     * max(floor, override), so retention can never shorten. */
    modeAuditRetention: z
      .record(z.enum(["hosted", "byoc", "air_gapped"]), z.number().int().positive())
      .optional(),
    /** Batch B7c (ADR-0073 amendment, migration 0102): retention window for
     * `config_canary_observations` — shadow-canary evidence only, acted on by
     * the ADR-0064 prune job (off with the scheduler) and the manual prune
     * endpoint. `config_versions` themselves are NEVER pruned by anything;
     * this knob cannot reach them. */
    canaryObservationRetentionDays: z.number().int().min(1).max(3650).optional(),
    // O5 (migration 0045): scheduled backup verification — OFF by default
    backupVerifyEnabled: z.boolean().optional(),
    backupVerifyIntervalHours: z.number().int().min(1).max(24 * 30).optional(),
    // orchestration worker caps — 20 is the zod wall the kernel/API already hold
    defaultWorkerMaxTurns: z.number().int().min(1).max(20).optional(),
    maxWorkerTurns: z.number().int().min(1).max(20).optional(),
    // size ceilings — each capped at its existing schema/UI wall
    maxAttachmentsPerDispatch: z.number().int().min(1).max(8).optional(),
    maxAttachmentBytes: z
      .number()
      .int()
      .min(1024)
      .max(6_750_000) // ≈ the 9M-base64-char zod wall, decoded
      .optional(),
    imageTokenEstimateTokens: z.number().int().min(1).max(100_000).optional(),
    sharedContextMaxChars: z.number().int().min(100).max(100_000).optional(),
    nodeOutputMaxChars: z.number().int().min(100).max(20_000).optional(),
    // ADR-0065 (migration 0077) — RegulAIt-LLM. Two dials only: the master
    // switch (ADR-0034's `customModelProvidersEnabled` precedent) and the
    // estimated-cost threshold at which a training job stops being something a
    // user starts and becomes something the ONE Approvals Queue decides.
    llmTrainingEnabled: z.boolean().optional(),
    llmTrainingApprovalThresholdUsd: z.number().min(0).max(1_000_000).optional(),
    // ADR-0070 (migration 0082) — trace observability. Three dials and an
    // exporter. `tracingEnabled` is the master switch (ADR-0034's
    // `customModelProvidersEnabled` precedent); `tracingCaptureContent` may
    // only ever NARROW (off keeps the tree, timings, costs and every deny
    // reason, and stores no prompt or output at all); `tracingOtlpEndpoint` is
    // null by default and is adjudicated by the egress guard at write time AND
    // on every export — there is deliberately no default endpoint anywhere.
    tracingEnabled: z.boolean().optional(),
    tracingCaptureContent: z.boolean().optional(),
    tracingPreviewMaxChars: z.number().int().min(0).max(20_000).optional(),
    tracingOtlpEndpoint: z.string().trim().min(1).max(2048).nullable().optional(),
    tracingOtlpHeaders: z.record(z.string(), z.string().max(4096)).nullable().optional(),
    tracingOtlpServiceName: z.string().trim().min(1).max(200).optional(),
    // ADR-0025 sign-in policy dials
    passwordMinLength: z.number().int().min(8).max(128).optional(),
    passwordRequireClasses: z.number().int().min(1).max(4).optional(),
    sessionLifetimeHours: z.number().int().min(1).max(24 * 30).optional(),
    sessionIdleMinutes: z.number().int().min(5).max(24 * 60).optional(),
    mfaRequired: mfaRequirementSchema.optional(),
    ssoOnly: z.boolean().optional(),
    loginLockoutThreshold: z.number().int().min(3).max(100).optional(),
    loginLockoutWindowMinutes: z.number().int().min(1).max(24 * 60).optional(),
    loginLockoutMinutes: z.number().int().min(1).max(24 * 60).optional(),
    /** ADR-0030: may users manage their OWN username? false (default) =
     * admin-managed only. The org is the ceiling exactly as everywhere else —
     * turning it off does not delete anyone's username, it stops self-service
     * writes. */
    usernameSelfService: z.boolean().optional(),
    // ADR-0039 (migration 0050): org network envelope + the two policy knobs.
    // CIDR syntax is validated in the route (400 on any malformed block) —
    // zod holds the shape, the gateway's own parser is the authority.
    sessionIpAllowlist: z.array(z.string().trim().min(1).max(64)).max(256).nullable().optional(),
    sessionIpPolicy: ipPolicySchema.optional(),
    apiKeyIpPolicy: ipPolicySchema.optional(),
    /** ADR-0098 (migration 0104): API-KEY LIFETIME. Two dials, both null by
     * default so the shipped posture is exactly pre-0098 — a newly issued key
     * never expires. `apiKeyDefaultTtlDays` is the lifetime (in days) applied
     * to a key issued with no caller-supplied expiry; `apiKeyMaxTtlDays` is
     * the CEILING on what any issuer may request, and a request over it —
     * including an explicit request for no expiry at all — is refused by name
     * (422 `api_key_expiry_exceeds_ceiling`), never silently clamped. Null
     * clears either. A default above the ceiling is refused (422). Neither
     * knob touches a key that already exists: expiry is set at issuance and
     * this ADR deliberately offers no way to extend it. */
    apiKeyDefaultTtlDays: z.number().int().min(1).max(3650).nullable().optional(),
    apiKeyMaxTtlDays: z.number().int().min(1).max(3650).nullable().optional(),
    /** ADR-0105 (migration 0107): HOW LONG AN APPROVED-BUT-UNSPENT MCP TOOL
     * consent stays spendable, in HOURS from the moment it was queued. Ships
     * at 72 — a deliberate upgrade-day change, because an approval is a human
     * decision about one pending action and indefinite validity is the defect.
     * NULL means "never expires": a legitimate operator choice, recorded as
     * one, that knowingly reopens the gap ADR-0105 closes. Changing the dial
     * never rewrites an approval that already exists — expiry is stamped at
     * queue time, exactly as ADR-0098 stamps a key's at issuance. */
    approvalTtlHours: z.number().int().min(1).max(8760).nullable().optional(),
    /** ADR-0039 self-lockout guard (mirrors the sso_only guard): saving
     * enforce_continuous with an allow-list that excludes the caller's own
     * current IP is refused (409) unless this explicit confirm rides along.
     * Write-only — stripped before the settings row is updated. */
    confirmIpLockout: z.boolean().optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (
      v.defaultWorkerMaxTurns !== undefined &&
      v.maxWorkerTurns !== undefined &&
      v.defaultWorkerMaxTurns > v.maxWorkerTurns
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "defaultWorkerMaxTurns cannot exceed maxWorkerTurns",
        path: ["defaultWorkerMaxTurns"],
      });
    }
    if (v.summarizerSelection === "fixed_agent" && v.summarizerAgentId === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "summarizerSelection 'fixed_agent' needs a summarizerAgentId",
        path: ["summarizerAgentId"],
      });
    }
  });
export type UpdateOrgSettings = z.infer<typeof updateOrgSettingsSchema>;

/** A4 (ADR-0027): set/clear the deploy-mode scope on one pillar-1 restriction
 * rule (approval / rate-limit / data-scope). null clears the scope back to
 * mode-unscoped (= today's semantics for that rule). */
export const setRuleDeployModeSchema = z.object({
  deployMode: z.enum(["hosted", "byoc", "air_gapped"]).nullable(),
});
export const ruleKindParamSchema = z.enum(["approvals", "rate-limits", "data-scopes"]);

/** O9 (ADR-0027): set the scope of an existing MCP/connector revocation.
 * 'full' = the ADR-0019 total semantics (default for every new revocation);
 * 'read_only' = write-classified tools/ops denied, reads still allowed.
 * Scope is an EDIT of an existing subtractive override — creation always
 * defaults to full, so a revocation starts as the unambiguous total ADR-0019
 * argued for and is narrowed only by an explicit, audited second act. Agent
 * revocations carry no scope (no read/write op classification to scope by). */
export const setRevocationScopeSchema = z.object({
  scope: z.enum(["full", "read_only"]),
});
export const revocationKindParamSchema = z.enum(["mcp", "connectors"]);

/** O10 (ADR-0027): set/clear the per-tool price override on an MCP tool.
 * null clears it back to the server's flat price (today's behaviour). */
export const setToolPriceSchema = z.object({
  pricePerCallUsd: z.number().min(0).max(10_000).nullable(),
});

// ---------------------------------------------------------------------------
// ADR-0025 — REAL HUMAN AUTHENTICATION (migration 0042): password + session
// login, TOTP MFA, OIDC SSO. Request shapes only — hashing/verification live
// in the gateway; nothing here ever carries a hash.
// ---------------------------------------------------------------------------

/**
 * ADR-0030 — the login identifier accepted in ONE field.
 *
 * `identifier` is the new, namespace-agnostic name; `email` is kept as the
 * BACKWARD-COMPATIBLE alias every shipped client (the legacy /app and /admin
 * shells, the SPA's older builds, anyone's script) already posts. Exactly one
 * of them must be present; the parse normalizes to `identifier` so the handler
 * has a single thing to resolve.
 *
 * The old `z.string().email()` on `email` is deliberately RELAXED to a plain
 * bounded string: a client that has only ever known the `email` field must be
 * able to post a username in it (that is precisely the owner's case — typing
 * `dhruv` into the legacy sign-in form). Nothing is weakened by this: the
 * server never treats the value as an email address on its own say-so, it
 * applies the ADR-0030 resolution rule ('@' ⇒ email namespace, otherwise
 * username namespace), and the failure answer is the same uniform 401 either
 * way. Relaxing it moves a 400-before-auth into that uniform 401, which is
 * strictly less of an oracle than it was.
 */
export const loginSchema = z
  .object({
    email: z.string().min(1).max(320).optional(),
    identifier: z.string().min(1).max(320).optional(),
    password: z.string().min(1).max(512),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.identifier === undefined && v.email === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "an identifier (email or username) is required",
        path: ["identifier"],
      });
    }
  })
  .transform((v) => ({
    identifier: (v.identifier ?? v.email ?? "").trim(),
    password: v.password,
  }));
export type LoginRequest = z.input<typeof loginSchema>;

/**
 * ADR-0030 — the username shape, held identically by zod and by the migration
 * 0047 CHECK: 2..63 chars, starts alphanumeric, then letters/digits/dot/
 * underscore/hyphen. Deliberately NO '@': that single exclusion is what keeps
 * the username namespace disjoint from the email namespace, so a username can
 * never resolve to — or impersonate — another user's email address.
 */
export const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{1,62}$/;

/** Case folding is NORMALIZE-ON-WRITE (ADR-0030): trim + lowercase, then the
 * shape check. `Dhruv` and `dhruv` are the same username by construction —
 * only the lowercase form is ever stored or compared, and migration 0047's
 * CHECK refuses anything else at the storage layer too. */
export const usernameSchema = z
  .string()
  .min(1)
  .max(64)
  .transform((v) => v.trim().toLowerCase())
  .refine((v) => USERNAME_PATTERN.test(v), {
    message:
      "a username is 2–63 characters, starts with a letter or digit, and may contain letters, digits, '.', '_' and '-' — no '@', no spaces",
  });

/** set/change (string) or CLEAR (null) a username. Used by both the admin
 * route and the self-service route — one shape, one validator, one meaning. */
export const setUsernameSchema = z
  .object({ username: usernameSchema.nullable() })
  .strict();
export type SetUsernameRequest = z.infer<typeof setUsernameSchema>;

/** step 2 of a TOTP-enabled login: the pending token from step 1 + a code */
export const mfaVerifySchema = z
  .object({
    pendingToken: z.string().min(1).max(512),
    code: z.string().regex(/^\d{6}$/, "a TOTP code is 6 digits"),
  })
  .strict();
export type MfaVerifyRequest = z.infer<typeof mfaVerifySchema>;

/** browser fallback during the transition: exchange an API key (or the
 * bootstrap token) for a session cookie, so cookies rule the browser either
 * way and the key never has to live in web storage. */
export const loginWithKeySchema = z
  .object({ apiKey: z.string().min(1).max(512) })
  .strict();
export type LoginWithKeyRequest = z.infer<typeof loginWithKeySchema>;

/** ADR-0028: `currentPassword` is OPTIONAL in the SHAPE only. The server
 * decides whether it is REQUIRED, from the session's recorded origin plus the
 * account's state — a request that omits it outside the narrow recovery case
 * is refused with 401 `current_password_required`. Making it optional here is
 * what lets an api_key-origin session on a must-change / passwordless account
 * set a password it was never told. */
export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1).max(512).optional(),
    newPassword: z.string().min(1).max(512),
  })
  .strict();
export type ChangePasswordRequest = z.infer<typeof changePasswordSchema>;

export const totpActivateSchema = z
  .object({ code: z.string().regex(/^\d{6}$/, "a TOTP code is 6 digits") })
  .strict();
export type TotpActivateRequest = z.infer<typeof totpActivateSchema>;

/** disabling MFA is a sensitive act: it re-proves BOTH factors */
export const totpDisableSchema = z
  .object({
    password: z.string().min(1).max(512),
    code: z.string().regex(/^\d{6}$/, "a TOTP code is 6 digits"),
  })
  .strict();
export type TotpDisableRequest = z.infer<typeof totpDisableSchema>;

/** admin sets/rotates a user's initial ONE-TIME password (generated
 * server-side, returned exactly once, must_change on first use). force is
 * required to overwrite a password the user already set — audited either way. */
export const setInitialPasswordSchema = z
  .object({ force: z.boolean().optional() })
  .strict();
export type SetInitialPasswordRequest = z.infer<typeof setInitialPasswordSchema>;

/** admin recovery for a locked-out user: clears their MFA. Reason required. */
export const clearMfaSchema = z
  .object({ reason: z.string().trim().min(1).max(2000) })
  .strict();
export type ClearMfaRequest = z.infer<typeof clearMfaSchema>;

const oidcDomainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9.-]+\.[a-z]{2,}$/, "not a domain");

/** ADR-0038: the name of the claim/attribute carrying groups. Nullable, and
 * NULL is the meaningful default: no name configured = no group signal at all
 * from this provider = nothing ever reconciled from its logins. */
const groupsClaimSchema = z.string().trim().min(1).max(512).nullable();

export const createOidcProviderSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    issuerUrl: z.string().url(),
    clientId: z.string().min(1).max(512),
    clientSecret: z.string().min(1).max(2048),
    enabled: z.boolean().optional(),
    allowedEmailDomains: z.array(oidcDomainSchema).min(1).max(50).nullable().optional(),
    defaultRoleId: z.string().uuid().nullable().optional(),
    jitProvisioning: z.boolean().optional(),
    /** ADR-0038: which id_token claim carries group membership. null/absent =
     * this provider emits NO group signal, so a login through it never
     * reconciles group-derived roles. Naming it grants nothing on its own — an
     * asserted group confers nothing until an admin maps it to a role. */
    groupsClaim: groupsClaimSchema.optional(),
  })
  .strict();
export type CreateOidcProvider = z.infer<typeof createOidcProviderSchema>;

/** partial update; clientSecret is WRITE-ONLY (rotate by writing, never read) */
export const updateOidcProviderSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    issuerUrl: z.string().url().optional(),
    clientId: z.string().min(1).max(512).optional(),
    clientSecret: z.string().min(1).max(2048).optional(),
    enabled: z.boolean().optional(),
    allowedEmailDomains: z.array(oidcDomainSchema).min(1).max(50).nullable().optional(),
    defaultRoleId: z.string().uuid().nullable().optional(),
    jitProvisioning: z.boolean().optional(),
    groupsClaim: groupsClaimSchema.optional(),
  })
  .strict();
export type UpdateOidcProvider = z.infer<typeof updateOidcProviderSchema>;

// --- ADR-0036: SAML 2.0 providers (the OIDC twin) ---------------------------

/** an IdP signing certificate, PEM. Pinned OUT OF BAND — assertions verify
 * against these and never against a certificate embedded in the document,
 * which is what defeats signature-wrapping. */
const samlCertSchema = z
  .string()
  .trim()
  .regex(
    /^-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----$/,
    "not a PEM certificate (-----BEGIN CERTIFICATE----- … -----END CERTIFICATE-----)",
  );

/** the shared field set. `idpSigningCerts` is a LIST so a certificate ROLLOVER
 * can stage the incoming cert next to the outgoing one — SAML has no
 * `.well-known` auto-refresh, so an expired pinned cert fails CLOSED (logins
 * stop, the safe direction) and staging is the only way to avoid an outage. */
const samlProviderFields = {
  name: z.string().trim().min(1).max(200),
  /** the IdP's entity id / Issuer; an assertion's <Issuer> is pinned to it */
  entityId: z.string().trim().min(1).max(1024),
  idpSsoUrl: z.string().url(),
  idpSigningCerts: z.array(samlCertSchema).min(1).max(5),
  enabled: z.boolean(),
  allowedEmailDomains: z.array(oidcDomainSchema).min(1).max(50).nullable(),
  defaultRoleId: z.string().uuid().nullable(),
  jitProvisioning: z.boolean(),
  wantAssertionsSigned: z.boolean(),
  wantAuthnResponseSigned: z.boolean(),
  allowIdpInitiated: z.boolean(),
  /** SAML attribute name carrying the email when the NameID is not an
   * emailAddress. NEVER a username: ADR-0030's second identifier is
   * locally-editable and must never be an SSO mapping target. */
  emailAttribute: z.string().trim().min(1).max(512).nullable(),
  /** ADR-0038: the SAML attribute carrying group membership (`groups`,
   * `memberOf`, …). null = no group signal from this provider. */
  groupsAttribute: groupsClaimSchema,
  /** OPTIONAL SP private key (PEM) for request signing / encrypted assertions.
   * WRITE-ONLY: stored AES-256-GCM under REGULAIT_DATA_KEY and never returned. */
  spPrivateKey: z.string().min(1).max(16384),
  spCertificate: z
    .string()
    .trim()
    .regex(
      /^-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----$/,
      "not a PEM certificate",
    ),
};

/**
 * The one posture rule both schemas share: a provider may NOT be configured so
 * that an UNSIGNED assertion could be accepted. Turning wantAssertionsSigned
 * off is only coherent when the whole authn response is signed instead — so
 * the pair (false, false) is refused at the API rather than quietly handed to
 * the library. `undefined` on a PATCH means "unchanged"; the effective pair is
 * re-checked against the stored row in the route.
 */
const signaturePostureOk = (v: {
  wantAssertionsSigned?: boolean | undefined;
  wantAuthnResponseSigned?: boolean | undefined;
}) => !(v.wantAssertionsSigned === false && v.wantAuthnResponseSigned !== true);
export const SAML_SIGNATURE_POSTURE_MESSAGE =
  "wantAssertionsSigned may only be turned off when wantAuthnResponseSigned is on — otherwise an unsigned assertion could be accepted";

export const createSamlProviderSchema = z
  .object({
    name: samlProviderFields.name,
    entityId: samlProviderFields.entityId,
    idpSsoUrl: samlProviderFields.idpSsoUrl,
    idpSigningCerts: samlProviderFields.idpSigningCerts,
    enabled: samlProviderFields.enabled.optional(),
    allowedEmailDomains: samlProviderFields.allowedEmailDomains.optional(),
    defaultRoleId: samlProviderFields.defaultRoleId.optional(),
    jitProvisioning: samlProviderFields.jitProvisioning.optional(),
    wantAssertionsSigned: samlProviderFields.wantAssertionsSigned.optional(),
    wantAuthnResponseSigned: samlProviderFields.wantAuthnResponseSigned.optional(),
    allowIdpInitiated: samlProviderFields.allowIdpInitiated.optional(),
    emailAttribute: samlProviderFields.emailAttribute.optional(),
    groupsAttribute: samlProviderFields.groupsAttribute.optional(),
    spPrivateKey: samlProviderFields.spPrivateKey.optional(),
    spCertificate: samlProviderFields.spCertificate.optional(),
  })
  .strict()
  .refine(signaturePostureOk, { message: SAML_SIGNATURE_POSTURE_MESSAGE });
export type CreateSamlProvider = z.infer<typeof createSamlProviderSchema>;

/** partial update; spPrivateKey is WRITE-ONLY (rotate by writing, never read) */
export const updateSamlProviderSchema = z
  .object({
    name: samlProviderFields.name.optional(),
    entityId: samlProviderFields.entityId.optional(),
    idpSsoUrl: samlProviderFields.idpSsoUrl.optional(),
    idpSigningCerts: samlProviderFields.idpSigningCerts.optional(),
    enabled: samlProviderFields.enabled.optional(),
    allowedEmailDomains: samlProviderFields.allowedEmailDomains.optional(),
    defaultRoleId: samlProviderFields.defaultRoleId.optional(),
    jitProvisioning: samlProviderFields.jitProvisioning.optional(),
    wantAssertionsSigned: samlProviderFields.wantAssertionsSigned.optional(),
    wantAuthnResponseSigned: samlProviderFields.wantAuthnResponseSigned.optional(),
    allowIdpInitiated: samlProviderFields.allowIdpInitiated.optional(),
    emailAttribute: samlProviderFields.emailAttribute.optional(),
    groupsAttribute: samlProviderFields.groupsAttribute.optional(),
    spPrivateKey: samlProviderFields.spPrivateKey.optional(),
    spCertificate: samlProviderFields.spCertificate.optional(),
  })
  .strict();
export type UpdateSamlProvider = z.infer<typeof updateSamlProviderSchema>;

// ADR-0054 — the first-run wizard and the migration/import tooling's PURE half:
// the step graph and its transition rule, the starter role templates, the
// compliance packs (which are cascade seeds, not a second configuration path),
// and the import planners. The planners are shared by dry-run and apply, so a
// preview is never computed differently from the thing it previews; the row
// schemas are `.strict()` so an import payload has nowhere to put a privilege
// it was not granted.
export {
  ONBOARDING_STEPS,
  ONBOARDING_STEP_KEYS,
  ONBOARDING_STEP_STATUSES,
  STARTER_ROLE_TEMPLATES,
  COMPLIANCE_PACKS,
  COMPLIANCE_PACK_TAGS,
  onboardingStepKeySchema,
  updateOnboardingStepSchema,
  applyCompliancePackSchema,
  userImportRowSchema,
  userImportSchema,
  groupRoleImportRowSchema,
  groupRoleImportSchema,
  blockedBy,
  transitionRefusal,
  screenForEscalation,
  planUserImport,
  planGroupRoleImport,
  parseCsv,
  parseCsvRecords,
  csvToUserRows,
  type OnboardingStepDef,
  type OnboardingStepStatus,
  type StarterRoleTemplate,
  type CompliancePack,
  type EscalationFinding,
  type ExistingUser,
  type UserImportRow,
  type UserImportPlan,
  type UserImportPlanEntry,
  type GroupRolePlan,
  type GroupRolePlanEntry,
} from "./onboarding.js";

// ADR-0060 — the tamper-evident `audit_log` hash chain's PURE half: the
// canonical, deterministic serialization every row's `content_hash` is taken
// over, the linked `row_hash`, the fixed genesis row, and the resumable
// batch verifier. It lives here because two independent pieces of the system —
// the WRITER in `@regulait/db` and the VERIFIER behind `GET /v1/audit/verify` —
// must agree on it byte for byte; a one-byte disagreement reports tampering on
// untouched data. No database, no clock, no I/O.
export {
  AUDIT_CHAIN_ALGORITHM,
  AUDIT_GENESIS_CONTENT_HASH,
  AUDIT_GENESIS_OBJECT_TYPE,
  AUDIT_GENESIS_PREV_HASH,
  AUDIT_GENESIS_ROW,
  AUDIT_GENESIS_ROW_HASH,
  AUDIT_GENESIS_RULE_ID,
  AUDIT_GENESIS_SEQ,
  AUDIT_LEGACY_DISCLOSURE,
  AUDIT_PAYLOAD_VERSION,
  auditContentHash,
  auditRowHash,
  canonicalAuditPayload,
  canonicalJson,
  sha256Hex,
  verifyChainBatch,
  type AuditChainFields,
  type ChainBreak,
  type ChainBreakKind,
  type ChainedAuditRow,
} from "./audit-chain.js";

// ADR-0099 — the audit-log CREDENTIAL SCRUB. Pure, and called from
// `@regulait/db`'s single chained-insert path immediately BEFORE the row is
// hashed, so every call site — helper, raw insert, and the next one written —
// is covered without knowing it exists. Exported here so the scrub rule can be
// tested, and so a reader of a redacted ledger can find the marker's grammar.
export {
  AUDIT_SCRUB_FINGERPRINT_HEX,
  AUDIT_SCRUB_MARKER_PREFIX,
  scrubAuditDetail,
  scrubAuditRow,
  scrubAuditText,
  type ScrubbableAuditRow,
} from "./audit-scrub.js";

// ADR-0104 — APPROVAL PAYLOAD BINDING. The consent fingerprint an Approvals-
// Queue row is bound to, and the approver-facing preview beside it. Pure: it
// reuses ADR-0060's `canonicalJson` for the serialization and ADR-0099's
// `scrubAuditDetail` for the preview rather than adding a second of either, so
// the queue writer and the evaluation-time matcher hash the identical bytes.
export {
  APPROVAL_CONTEXT_DIGEST_VERSION,
  APPROVAL_DIGEST_VERSION,
  APPROVAL_SCOPES,
  CONSENT_RETIREMENT_REASONS,
  DEFAULT_APPROVAL_SCOPE,
  DEFAULT_APPROVAL_TTL_HOURS,
  approvalArgumentsDigest,
  approvalArgumentsPreview,
  approvalContextDigest,
  effectiveApprovalScope,
  normalizeApprovalArguments,
  sortApprovalRuleVersions,
  type ApprovalContextRef,
  type ApprovalPayloadRef,
  type ApprovalRuleVersionRef,
  type ApprovalScope,
  type ConsentRetirementReason,
} from "./approval-binding.js";

// ADR-0099 — the credential-material subset of ADR-0042's DLP rules, shared
// with the scrubber so detection has exactly one definition.
export { CREDENTIAL_MATERIAL_RULES } from "./guardrails.js";

// ADR-0055 — SHADOW-AI DISCOVERY, the pure half: the untrusted-evidence
// envelope (bounds + the pre-parse escalation screen), the catalogue shape and
// its shipped seed, the linear matchers (no regex ever comes from data), the
// severity/confidence model and the correlation/dedup. No database, no network,
// no collector — see the module header for exactly what a customer must feed it.
export {
  AI_MATCH_TYPES,
  AI_SIGNATURE_KINDS,
  DEFAULT_AI_SIGNATURES,
  EVIDENCE_KINDS,
  EVIDENCE_MAX_BYTES,
  EVIDENCE_MAX_ROWS,
  HOST_MAX,
  KEY_FRAGMENT_KEPT,
  KEY_FRAGMENT_MAX,
  SHADOW_AI_CONFIDENCES,
  SHADOW_AI_DISPOSITIONS,
  SHADOW_AI_FORBIDDEN_KEYS,
  SHADOW_AI_SEVERITIES,
  analyzeImport,
  catalogueSignatureSchema,
  classifyObservation,
  codeScanRowSchema,
  confidenceFor,
  correlateObservations,
  correlationKey,
  coverageScorecard,
  egressLogRowSchema,
  evidenceImportSchema,
  hostMatchesSignature,
  keyMatchesSignature,
  normalizeEvidenceHost,
  observationsFromImport,
  packageMatchesSignature,
  redactKeyFragment,
  saasExportRowSchema,
  screenEvidencePayload,
  selfReportedRowSchema,
  type AiMatchType,
  type AiSignature,
  type AiSignatureKind,
  type CatalogueSignatureInput,
  type Classification,
  type CorrelatedFinding,
  type CoverageInput,
  type CoverageScorecard,
  type EvidenceImport,
  type EvidenceKind,
  type EvidenceScreenFinding,
  type Observation,
  type ShadowAiConfidence,
  type ShadowAiDisposition,
  type ShadowAiSeverity,
  type ShadowAiSubjectKind,
} from "./shadow-ai.js";

// ADR-0071 — SHADOW-AI EVIDENCE FORMAT ADAPTERS, the pure half: the layer BELOW
// ADR-0055 that turns a raw CEF/LEEF/W3C/Squid/NCSA log or a mapped CSV/JSON
// export into the evidence rows ADR-0055 already accepts. An adapter layer, not
// a second pipeline: every adapter validates its output against ADR-0055's OWN
// row schemas, so a row shape cannot drift from the pipeline that consumes it.
// Not one regular expression is evaluated over file content anywhere in it, and
// every unparseable line refuses with its FILE LINE NUMBER.
export {
  AttributeBag,
  EVIDENCE_ADAPTERS,
  EVIDENCE_ADAPTER_IDS,
  EVIDENCE_ADAPTER_POSTURE,
  EVIDENCE_FORMAT_BASES,
  EVIDENCE_KIND_FIELDS,
  EVIDENCE_SOURCE_FORMATS,
  EvidenceFormatError,
  PROXY_LAYOUTS,
  RAW_EVIDENCE_MALFORMED_POLICIES,
  cefAdapter,
  describeEvidenceAdapters,
  genericEvidenceConfigSchema,
  genericMappedEvidenceAdapter,
  getEvidenceAdapter,
  inferEvidenceMapping,
  leefAdapter,
  leefConfigSchema,
  numberedLines,
  parseCefExtension,
  parseCefLine,
  parseClfTimestamp,
  parseCountCell,
  parseEvidenceTimestamp,
  parseLeefLine,
  proxyCommonAdapter,
  proxyCommonConfigSchema,
  rawEvidenceImportRequestSchema,
  resolveLeefDelimiter,
  splitUnescaped,
  tokenizeClf,
  tokenizeW3c,
  unescapeLogValue,
  w3cExtendedAdapter,
  type CefRecord,
  type EvidenceAdapter,
  type EvidenceAdapterCapabilities,
  type EvidenceAdapterInput,
  type EvidenceFormatBasis,
  type EvidenceParseResult,
  type EvidenceRowRefusal,
  type EvidenceSourceFormat,
  type ProxyLayout,
  type RawEvidenceImportRequest,
  type RawEvidenceMalformedPolicy,
} from "./evidence-adapters.js";

// ADR-0083 — FIRST-PARTY SHADOW-AI DISCOVERY, the pure half: a versioned,
// FROZEN, compiled-in signature catalogue (the ADR-0068 corpus pattern) and a
// classifier that triages operator-supplied text — generic DNS/proxy log lines
// and dependency manifests — into shadow / governed_via_gateway / unmatched.
// No collector, no scraper, no network call, no regex over input; a compiled
// hit triages and suggests, it can never mint a finding — findings still come
// from ADR-0055's pipeline and the deployment's own admin catalogue.
export {
  DISCOVERY_MAX_BYTES,
  DiscoveryParseError,
  SHADOW_AI_CATALOG_V1,
  SHADOW_AI_CATALOG_VERSION,
  SHADOW_CATALOG_KINDS,
  SHADOW_DISCOVERY_CLASSES,
  SHADOW_DISCOVERY_POSTURE,
  SHADOW_DISCOVERY_SOURCE_KINDS,
  classifyDiscoveryContent,
  endpointEntryMatches,
  extractHostCandidatesFromLine,
  matchCatalogEndpoint,
  matchCatalogPackage,
  normalizePackageName,
  parseGoModManifest,
  parsePackageJsonManifest,
  parseRequirementsManifest,
  sdkEntryMatches,
  shadowCatalogEntrySchema,
  type DiscoveryCandidate,
  type DiscoveryClassification,
  type ManifestEntry,
  type ShadowCatalogEntry,
  type ShadowCatalogKind,
  type ShadowDiscoveryClass,
  type ShadowDiscoverySourceKind,
} from "./shadow-discovery.js";

// ADR-0069 — CROSS-VENDOR COST CONSOLIDATION, the pure half: the adapter
// registry (a new vendor is a new adapter, not a new code path), the
// character-scanned amount/date parsers that refuse rather than guess, the
// vendor-account -> RegulAIt-user resolution rules, and the consolidation math
// whose output type has NO field for a metered+imported total.
export {
  ACCOUNT_RESOLUTION_METHODS,
  ANY_VENDOR,
  COST_BASES,
  COST_BILLING_KINDS,
  COST_IMPORT_ADAPTERS,
  COST_IMPORT_ADAPTER_IDS,
  COST_IMPORT_MAX_BYTES,
  COST_IMPORT_MAX_COLUMNS,
  COST_IMPORT_MAX_LINE_USD,
  COST_IMPORT_MAX_ROWS,
  COST_IMPORT_TEXT_MAX,
  CostImportFormatError,
  IMPORTED_BASIS_STATEMENT,
  anthropicConsoleAdapter,
  awsCurAdapter,
  consolidate,
  costColumnMappingSchema,
  costImportDefaultsSchema,
  costImportRequestSchema,
  describeCostImportAdapters,
  genericCsvConfigSchema,
  genericMappedAdapter,
  getCostImportAdapter,
  inferMapping,
  normalizeAccountKey,
  openAiConsoleAdapter,
  parseAmountCell,
  parseDateCell,
  readSourceTable,
  renderConsolidatedCsv,
  resolveVendorAccount,
  seatRosterAdapter,
  seatRosterConfigSchema,
  vendorAliasRequestSchema,
  vendorDomainRuleRequestSchema,
  type AccountResolution,
  type AccountResolutionMethod,
  type ConsolidatedSubject,
  type CostBasis,
  type CostBillingKind,
  type CostColumnMapping,
  type CostImportAdapter,
  type CostImportAdapterCapabilities,
  type CostImportAdapterInput,
  type CostImportDefaults,
  type CostImportParseResult,
  type CostRowRefusal,
  type ImportedInput,
  type ImportedSide,
  type MeteredInput,
  type MeteredSide,
  type ParsedCostLine,
  type VendorAliasRow,
  type VendorDomainRuleRow,
} from "./cost-import.js";

// ADR-0076 — COST RECONCILIATION, the pure half: the planner that decides
// which imported lines are cross-batch restatements of the same vendor fact
// (marked, never deleted), refuses ambiguous multiplicities, and reports
// overlapping-but-not-identical windows instead of guessing at them.
export {
  RECONCILIATION_MAX_WARNINGS,
  planCostReconciliation,
  type DuplicateGroupPlan,
  type ReconciliationLineInput,
  type ReconciliationPlan,
  type ReconciliationWarning,
  type SupersessionPlanItem,
} from "./cost-reconciliation.js";

// ADR-0076 — ROSTER INGEST, the pure half: parse a SCIM-style user export or
// a CSV roster into normalised entries the gateway feeds through the EXISTING
// alias/cost-centre write paths. Identity columns are join keys (PII-exempt by
// the same construction ADR-0069 discloses); every unmapped column is
// discarded at parse.
export {
  ROSTER_MAX_ROWS,
  ROSTER_TEXT_MAX,
  inferRosterMapping,
  parseRosterExport,
  rosterColumnMappingSchema,
  rosterIngestRequestSchema,
  type RosterColumnMapping,
  type RosterEntry,
  type RosterIngestRequest,
  type RosterParseResult,
  type RosterRowRefusal,
} from "./roster-import.js";

// ADR-0061 — CHATOPS APPROVALS, the pure half: signature verification and the
// replay window (the FIRST wall — a forged callback must be cheap to reject,
// before mapping, entitlement or any DB work), strict interaction parsing (the
// payload is an ASSERTION, never authorization), the ADR-0046 sensitivity fence
// applied to a courier, and card composition. Nothing here decides anything.
export {
  CHATOPS_ACTIONS,
  CHATOPS_MAX_BODY_BYTES,
  CHATOPS_PROVIDERS,
  CHATOPS_REPLAY_WINDOW_SECONDS,
  SLACK_SIGNATURE_HEADER,
  SLACK_TIMESTAMP_HEADER,
  TEAMS_AUTHORIZATION_HEADER,
  chatContentFenced,
  chatDecidable,
  composeApprovalCard,
  composeDecidedCard,
  parseChatInteraction,
  parseSlackInteraction,
  parseTeamsInteraction,
  slackSignature,
  slackSignatureBaseString,
  teamsSignature,
  verifyChatSignature,
  type ApprovalCard,
  type ApprovalCardInput,
  type ChatInteraction,
  type ChatOpsAction,
  type ChatOpsProvider,
  type ChatSignatureFailure,
  type ChatSignatureInput,
  type ChatSignatureResult,
} from "./chatops.js";
// ADR-0057 — continuous red-teaming's pure half: the attack-class registry
// (each class next to what it CANNOT tell you), the versioned built-in probe
// corpus, the oracle validator that refuses a probe which can never report a
// defeat, the per-class aggregate math, and the per-class regression gate —
// itself a thin composition over ADR-0044's `evaluateEvalGate`, because a
// red-team suite IS an eval suite with adversarial cases and inverted polarity.
export {
  RED_TEAM_AGENTIC_ATTACK_CLASSES,
  RED_TEAM_AGENTIC_VECTORS,
  RED_TEAM_ATTACK_CLASSES,
  RED_TEAM_CANARY,
  RED_TEAM_CORE_ATTACK_CLASSES,
  RED_TEAM_CORPUS_VERSIONS,
  RED_TEAM_COVERAGE_DISCLOSURE,
  RED_TEAM_LATEST_CORPUS_VERSION,
  RED_TEAM_ORIGIN_TAG,
  RED_TEAM_SEVERITIES,
  RED_TEAM_SEVERITY_WEIGHT,
  aggregateRedTeamByClass,
  applyRedTeamPreset,
  attachRedTeamEvidenceSchema,
  builtinRedTeamCorpus,
  builtinRedTeamLibrary,
  builtinRedTeamLibraryV2,
  composeRedTeamPreset,
  createRedTeamLibrarySchema,
  createRedTeamProbeSchema,
  evaluateRedTeamGate,
  isSequenceProbe,
  redTeamAgenticVectorSchema,
  redTeamAttackClassRegistry,
  redTeamAttackClassSchema,
  redTeamOverallAggregate,
  redTeamProbeToolSchema,
  redTeamSeveritySchema,
  seedRedTeamCorpusSchema,
  severityRank,
  startRedTeamRunSchema,
  validateRedTeamAgentic,
  validateRedTeamProbe,
  type RedTeamAgenticVector,
  type RedTeamAgenticVectorKind,
  type RedTeamAttackClass,
  type RedTeamAttackClassInfo,
  type RedTeamClassAggregate,
  type RedTeamClassVerdict,
  type RedTeamCompliancePreset,
  type RedTeamEffectivePreset,
  type RedTeamGateDecision,
  type RedTeamGateInput,
  type RedTeamProbeOutcome,
  type RedTeamProbeSeed,
  type RedTeamProbeTool,
  type RedTeamRunSettings,
  type RedTeamSeverity,
} from "./redteam.js";
// ADR-0068 — attack-success-rate statistics. Pure: the Wilson score interval,
// the per-probe trial roll-up whose denominator is never separable from its
// rate, the pooled per-class ASR, and the `not_run` status that keeps an unrun
// probe out of every aggregate rather than letting it read as resisted.
export {
  RED_TEAM_ASR_DISCLOSURE,
  RED_TEAM_DEFAULT_TRIALS,
  RED_TEAM_DEFAULT_Z,
  RED_TEAM_MAX_TRIALS,
  RED_TEAM_TRANSPORT_FAILURE_CODES,
  RED_TEAM_GOVERNANCE_STOP_CODES,
  RED_TEAM_PLATFORM_HELD_SCORE,
  classifyDispatchFailure,
  aggregateAsrByClass,
  describeAsr,
  measurementQuality,
  summarizeProbeAsr,
  trialCostNote,
  wilsonInterval,
  type RedTeamClassAsr,
  type RedTeamMeasurementQuality,
  type RedTeamProbeAsr,
  type RedTeamProbeStatus,
  type RedTeamTrialOutcome,
  type DispatchFailureKind,
  type WilsonInterval,
} from "./redteam-stats.js";
// ADR-0059 — policy simulation / blast-radius preview's pure half: the replay
// classifier (total over recorded × candidate effect), the fidelity analysis
// derived from the candidate's OWN source, the ADR-0047-shaped entitlement
// scope decision, and the NAMED blast-radius summary — users, projects, tools
// and specific calls, because a percentage without a name is not a preview.
export {
  ABAC_CANNOT_GRANT_NOTE,
  POLICY_SIMULATION_BUCKETS,
  POLICY_SIMULATION_DEFAULT_ROW_CAP,
  POLICY_SIMULATION_DEFAULT_WINDOW_DAYS,
  POLICY_SIMULATION_MAX_ROWS,
  POLICY_SIMULATION_MAX_WINDOW_DAYS,
  REPLAY_FIDELITY_DISCLOSURE,
  UNREPLAYABLE_ATTRIBUTES,
  analyzeReplayFidelity,
  buildHeadline,
  classifyReplay,
  isFlip,
  policySimulationSettingsSchema,
  resolvePolicySimulationScope,
  startPolicySimulationSchema,
  summarizeBlastRadius,
  type BlastRadius,
  type CandidateEffect,
  type PolicySimulationBucket,
  type PolicySimulationScopeDecision,
  type PolicySimulationScopeInput,
  type RecordedEffect,
  type ReplayFidelity,
  type ReplayedDecision,
} from "./policy-simulation.js";

// ADR-0058 — REGULATORY COMPLIANCE PACKS, the pure half: the pack/control and
// collector vocabularies, the satisfaction rule (an attestation-required
// control returns BEFORE any count is consulted, so it can never reach
// 'satisfied'), the verdict-free scorecard, and the six launch packs as SEED
// DATA the gateway inserts as ordinary rows.
export {
  COMPLIANCE_PACK_DISCLAIMER,
  COMPLIANCE_PACK_FRAMEWORKS,
  COMPLIANCE_PACK_UPDATE_POLICY,
  CONTROL_COVERAGE_CLASSES,
  CONTROL_EVALUATION_STATUSES,
  DEFAULT_COMPLIANCE_PACKS,
  EVIDENCE_COLLECTORS,
  PACK_STATUSES,
  assessPackControl,
  buildPackScorecard,
  collectorParamsSchema,
  createCompliancePackSchema,
  evaluatePackSchema,
  packAttestationSchema,
  packControlSchema,
  type CollectorParams,
  type CompliancePackFramework,
  type ControlCoverageClass,
  type ControlEvaluationStatus,
  type CreateCompliancePackInput,
  type EvaluatePackInput,
  type EvidenceCollectorId,
  type PackAttestationInput,
  type PackControlAssessment,
  type PackControlInput,
  type PackControlSpec,
  type PackScorecard,
  type PackStatus,
} from "./compliance-packs.js";

// ADR-0087 — the compliance-pack VERSION DIFF, the pure half: a
// deterministic, order-independent structured diff of two pack versions
// (controls added/removed/changed with per-field before/after, pack-level
// changes, the HIGH-consequence cascadeTag flag), so a framework revision is
// reviewable before it activates. Claims-vs-claims only — the measured half
// is the gateway's impact preview over the live ledgers.
export {
  PACK_CONTROL_DIFF_FIELDS,
  PACK_LEVEL_DIFF_FIELDS,
  compliancePackDiffSchema,
  diffCompliancePacks,
  type ChangedControl,
  type CompliancePackDiff,
  type ControlDiffSummary,
  type ControlFieldChange,
  type PackControlDiffField,
  type PackLevelChange,
  type PackLevelDiffField,
  type PackVersionSnapshot,
} from "./compliance-pack-diff.js";

// ADR-0056 — THE AI GOVERNANCE COPILOT, the pure half: the read-only tool
// vocabulary (four tools, no mutating one), the deterministic NL -> structured
// query step (testable without a provider, and unsteerable by the data it
// reads), the grounded answer renderer (composed from COUNTS, so it cannot
// hallucinate a figure), the narrator INTERFACE + prompt/parse/cross-check
// following ADR-0044's judge pattern, and the proposal record builder.
export {
  COPILOT_APPLICABLE_PROPOSAL_KINDS,
  COPILOT_BUDGET_ADJUSTMENT_FIELDS,
  COPILOT_DECISION_SUPPORT_NOTICE,
  COPILOT_ENTITY_FILTER_MATRIX,
  COPILOT_ENTITY_KINDS,
  COPILOT_ENTITY_KIND_LABELS,
  COPILOT_GRANT_KINDS,
  COPILOT_GROUNDED_REFUSAL,
  COPILOT_MAX_ENTITY_CANDIDATES,
  COPILOT_OBJECT_KINDS,
  COPILOT_PROPOSAL_KINDS,
  COPILOT_RULE_TO_APPROVAL_SOURCE_KINDS,
  COPILOT_SCOPE_CAVEAT,
  COPILOT_TIMEFRAMES,
  COPILOT_TOOLS,
  COPILOT_TOOL_SPECS,
  COPILOT_UNAPPLICABLE_PROPOSAL_KINDS,
  buildNarrationPrompt,
  buildProposalRecord,
  copilotAskSchema,
  copilotEntityAmbiguousRefusal,
  copilotEntityNotFilterableRefusal,
  copilotEntityUnresolvedRefusal,
  copilotBudgetAdjustmentDiffSchema,
  copilotGrantRevocationDiffSchema,
  copilotPolicyTighteningDiffSchema,
  copilotPlanFiltered,
  copilotRuleToApprovalDiffSchema,
  copilotProposalKindIsApplicable,
  copilotProposalSchema,
  copilotToolSupportsEntityKind,
  copilotToolsFilteringEntityKind,
  copilotUnfilteredSubjectCaveat,
  describeCopilotFilters,
  extractEntityCandidates,
  narrationIsGrounded,
  parseNarration,
  planCopilotQuery,
  renderGroundedAnswer,
  retrievalFoundNothing,
  type CopilotApplicableProposalKind,
  type CopilotAskInput,
  type CopilotCitableObject,
  type CopilotEntityKind,
  type CopilotEntityMatch,
  type CopilotEntityRef,
  type CopilotEvidence,
  type CopilotNarration,
  type CopilotNarrationRequest,
  type CopilotNarrator,
  type CopilotObjectKind,
  type CopilotProposalInput,
  type CopilotProposalKind,
  type CopilotQueryPlan,
  type CopilotTimeframe,
  type CopilotTool,
  type CopilotToolSpec,
  type GroundedAnswer,
} from "./copilot.js";

// ADR-0070 — TRACE / SPAN OBSERVABILITY, the pure half: the cycle-safe,
// order-deterministic tree builder (the ONE place parentage is decided), the
// preview truncation that adds a length limit and makes no second PII decision,
// the OTel GenAI semantic-convention attribute mapping, and a hand-rolled
// OTLP/HTTP JSON encoder (no OTel SDK — see the ADR).
export {
  OTEL_STATUS_ERROR,
  OTEL_STATUS_OK,
  OTEL_STATUS_UNSET,
  OTLP_EXPORT_LIMITS,
  TRACE_TRUNCATION_MARKER,
  buildOtlpPayload,
  buildSpanTree,
  flattenSpanTree,
  otelAttributesForSpan,
  otelStatus,
  otlpSpanId,
  otlpTraceId,
  summariseSpanTree,
  toolPayloadPreview,
  tracePreview,
  type OtelAttrContext,
  type OtlpBuildInput,
  type SpanNode,
  type SpanRecord,
  type TraceRecord,
  type TreeTotals,
} from "./tracing.js";

// ---------------------------------------------------------------------------
// ADR-0080 — the AI use-case registry's request shapes. `status` is
// conspicuously absent from every one of them: approved/rejected are reached
// only through the linked intake instance's decision on the one approvals
// queue, and retirement has its own audited endpoint.
// ---------------------------------------------------------------------------

export const AI_USE_CASE_DATA_SENSITIVITIES = [
  "public",
  "internal",
  "confidential",
  "regulated",
] as const;

export const createUseCaseSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().min(1).max(4000),
  businessContext: z.string().min(1).max(4000),
  dataSensitivity: z.enum(AI_USE_CASE_DATA_SENSITIVITIES),
  /** the SAME tags the §8.3 cascade enforces (compliance_profiles.tag) */
  complianceTags: z.array(z.string().min(1).max(200)).max(20).default([]),
  /** agent REFERENCES the proposer intends to use — validated server-side */
  intendedAgentIds: z.array(z.string().uuid()).max(20).default([]),
  projectId: z.string().uuid().optional(),
});

/** editable while the intake is in flight; `status` is NOT here on purpose —
 * the gateway refuses a body naming it with a 422 that points at the decide
 * path, rather than silently dropping the key */
export const updateUseCaseSchema = z.object({
  description: z.string().min(1).max(4000).optional(),
  businessContext: z.string().min(1).max(4000).optional(),
  intendedAgentIds: z.array(z.string().uuid()).max(20).optional(),
  projectId: z.string().uuid().nullable().optional(),
});

export const retireUseCaseSchema = z.object({
  reason: z.string().min(1).max(2000),
});

// ---------------------------------------------------------------------------
// ADR-0081 — the AI risk register: the category/resolver vocabulary, the
// fixed category → evidence mapping, the request shapes, the seed library,
// and the disclaimer. Evidence itself lives in the gateway as real SELECTs.
// ---------------------------------------------------------------------------
export {
  AI_RISK_CATEGORIES,
  AI_RISK_LEVELS,
  AI_RISK_REGISTER_DISCLAIMER,
  AI_RISK_STATUSES,
  DEFAULT_RISK_LIBRARY,
  RISK_CATEGORY_EVIDENCE,
  RISK_EVIDENCE_RESOLVERS,
  acceptRiskSchema,
  createRiskSchema,
  riskLibraryEntrySchema,
  transitionRiskSchema,
  updateRiskSchema,
  type AcceptRiskInput,
  type AiRiskCategory,
  type AiRiskLevel,
  type AiRiskStatus,
  type CreateRiskInput,
  type RiskEvidenceResolverId,
  type RiskLibraryEntry,
  type TransitionRiskInput,
  type UpdateRiskInput,
} from "./risks.js";

// ---------------------------------------------------------------------------
// ADR-0084 — the AI vendor registry (third-party AI risk): the vocabulary,
// the request shapes, and the attested-never-measured disclaimer. `status` is
// conspicuously absent from every schema: approved/rejected are reached only
// through the linked assessment instance's decision on the one approvals
// queue, and retirement has its own audited endpoint.
// ---------------------------------------------------------------------------
export {
  AI_VENDOR_ATTESTATION_DISCLAIMER,
  AI_VENDOR_CATEGORIES,
  AI_VENDOR_STATUSES,
  createVendorSchema,
  recordVendorAttestationSchema,
  retireVendorSchema,
  updateVendorSchema,
  type AiVendorCategory,
  type AiVendorStatus,
  type CreateVendorInput,
  type RecordVendorAttestationInput,
  type UpdateVendorInput,
} from "./vendors.js";

// ---------------------------------------------------------------------------
// ADR-0085 — EU AI Act risk-tier screening (gap L10): the questionnaire
// vocabulary, the frozen v1 rule set, the deterministic classifier, the
// answers-block parser, and the screening-not-legal-advice disclaimer. The
// tier is computed SERVER-SIDE from the answers — never accepted from any
// payload — and it informs the human sign-off; nothing is auto-blocked.
// ---------------------------------------------------------------------------
export {
  classifyEuAiActTier,
  euAiActAnswersSchema,
  extractEuAiActAnswers,
  renderEuAiActAnswersBlock,
  EU_AI_ACT_ANNEX_III_DOMAINS,
  EU_AI_ACT_ANSWERS_FENCE,
  EU_AI_ACT_AFFECTED_PERSONS,
  EU_AI_ACT_BIOMETRIC_USES,
  EU_AI_ACT_DECISION_AUTONOMY,
  EU_AI_ACT_PURPOSE_DOMAINS,
  EU_AI_ACT_RULESET_V1,
  EU_AI_ACT_RULESET_VERSION,
  EU_AI_ACT_SCREENING_DISCLAIMER,
  EU_AI_ACT_TIER_RANK,
  EU_AI_ACT_TIERS,
  type EuAiActAnswers,
  type EuAiActClassification,
  type EuAiActExtraction,
  type EuAiActReason,
  type EuAiActRule,
  type EuAiActTier,
} from "./eu-ai-act.js";

// ---------------------------------------------------------------------------
// ADR-0092 — access recommendations, the deterministic half (gap L24): the
// frozen v1 rule set (queries with reasons — id, plain-language rationale
// template, severity CLASS), the strict rationale renderer, and the
// `from_recommendations` campaign-scope parser. No scores, no ranking, no
// auto-execution; the model-judged half stays credential-blocked (L6).
// ---------------------------------------------------------------------------
export {
  ACCESS_RECOMMENDATION_RULES_V1,
  ACCESS_RECOMMENDATION_RULES_VERSION,
  ACCESS_RECOMMENDATION_RULE_IDS,
  ACCESS_RECOMMENDATION_SEVERITIES,
  RECOMMENDATION_JUDGE_LIMITS,
  RECOMMENDATION_JUDGE_METHOD,
  RECOMMENDATION_JUDGE_OFF_NOTE,
  RECOMMENDATION_JUDGE_UNAVAILABLE_NOTE,
  RECOMMENDATION_JUDGE_VERDICTS,
  UNUSED_GRANT_DEFAULT_WINDOW_DAYS,
  accessRecommendationRuleById,
  annotationsForFindings,
  buildRecommendationJudgePrompt,
  parseRecommendationJudgeReplies,
  parseRecommendationRuleIds,
  renderRecommendationRationale,
  type AccessRecommendationRule,
  type AccessRecommendationRuleId,
  type AccessRecommendationSeverity,
  type RecommendationJudge,
  type RecommendationJudgeAnnotation,
  type RecommendationJudgeReply,
  type RecommendationJudgeRequest,
  type RecommendationJudgeVerdict,
  type RecommendationJudgedState,
} from "./access-recommendations.js";
