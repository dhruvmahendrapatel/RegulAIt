import { z } from "zod";

export { detectPII, type PiiHit, type PiiCategory } from "./pii.js";

// ADR-0044 — the evaluation harness's pure half: the scorer registry (six
// deterministic kinds plus the model-backed judge's deterministic prompt/parse
// halves), the aggregate math, and the baseline-comparison gate decision that
// the workflow automated-check stage blocks on.
export {
  EVAL_SCORER_KINDS,
  DETERMINISTIC_SCORER_KINDS,
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
} from "./evals.js";

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
  canaryIsLive,
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
} from "./config-versions.js";

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
});

export const createDataScopeRuleSchema = z
  .object({
    ...ruleScopeFields,
    toolName: z.string().min(1).nullable().optional(),
    argPath: z.string().min(1),
    allowedValues: z.array(z.string()).min(1),
  })
  .superRefine(refineRuleScope);

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

/** ADR-0023: set/clear an existing agent's admin base system prompt (null
 * clears — an explicit choice, mirroring the agent-policy clear semantics) */
export const setAgentSystemPromptSchema = z.object({
  systemPrompt: z.string().min(1).max(20_000).nullable(),
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
