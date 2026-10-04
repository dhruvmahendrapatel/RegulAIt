/** Response shapes of the gateway endpoints the SPA consumes.
 * Derived from apps/gateway/src/{app,auth,setup-status}.ts. Fields the UI does
 * not render are omitted (the client never depends on more than it shows). */

// ---- identity ------------------------------------------------------------

export interface MeResponse {
  userId: string | null;
  isAdmin: boolean;
  user: { id: string; email: string; displayName: string } | null;
  limits?: { maxAttachmentsPerDispatch?: number; maxAttachmentBytes?: number };
}

export interface AuthMeResponse {
  userId: string | null;
  isAdmin: boolean;
  via: "bootstrap" | "api-key" | "session";
  /** ADR-0030: `username` is the second login identifier — null when the
   * account signs in by email only, and absent entirely from a pre-0047
   * gateway (hence optional: an older gateway degrades to "no username"). */
  user: { id: string; email: string; username?: string | null; displayName: string } | null;
  mustChangePassword: boolean;
  totpEnabled: boolean;
  passwordSet: boolean;
  mfaSetupRequired: boolean;
  /** ADR-0028: false = the server will accept a new password from THIS session
   * without the current one (API-key session on an account that is on a
   * one-time password or has none). Server-computed with the exact rule the
   * change-password handler enforces — the UI never derives it. Optional so an
   * older gateway simply reads as "required" (fail closed). */
  passwordChangeRequiresCurrent?: boolean;
  /** how this session was established; null for header-credential requests */
  sessionOrigin?: "password" | "api_key" | "oidc" | "bootstrap" | "unknown" | null;
  /** ADR-0030: may this user write their OWN username? Absent on an older
   * gateway, which reads as "no" — the conservative default and the same
   * posture a fresh org_settings row has. Reading one's username is never
   * gated; this governs the edit affordance only. */
  usernameSelfService?: boolean;
}

/**
 * ADR-0030 — the login body. `identifier` (email OR username) is the current
 * field; `email` is the pre-0047 alias the gateway still accepts, and the one
 * this client keeps sending for email logins so an OLDER gateway (which knows
 * nothing about `identifier` and rejects unknown keys) keeps working.
 */
export interface LoginRequestBody {
  email?: string;
  identifier?: string;
  password: string;
}

export interface LoginResponse {
  ok?: boolean;
  userId?: string;
  isAdmin?: boolean;
  mustChangePassword?: boolean;
  mfaRequired?: boolean;
  pendingToken?: string;
}

export interface OidcProvidersResponse {
  providers: Array<{ id: string; name: string }>;
}

/** ADR-0036 — the SAML login-screen list. Same shape as the OIDC one on
 * purpose: to the person signing in the two federated paths are one concept,
 * and the login page should not make them look like different products. */
export interface SamlProvidersResponse {
  providers: Array<{ id: string; name: string }>;
}

// ---- agents / chat -------------------------------------------------------

export interface GrantedAgent {
  agentId: string;
  name: string;
  provider: string;
  model?: string;
  tier: number;
  revoked?: boolean;
}

export interface MyAgentsResponse {
  agents: GrantedAgent[];
  defaultAgentId?: string | null;
}

export interface ProviderStatusResponse {
  providers: Record<string, { configured: boolean }>;
}

export interface ConversationSummary {
  id: string;
  title: string | null;
  agentId: string;
  agentName?: string | null;
  projectId?: string | null;
  updatedAt: string;
  messageCount?: number;
}

export interface ConversationMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  detail?: {
    denied?: boolean;
    reason?: string;
    modelUsed?: string;
    costUsd?: number;
    refusal?: boolean;
    credentialSource?: "user" | "platform";
    stopReason?: string;
    servedAgentId?: string;
    compaction?: CompactionInfo;
  } | null;
}

export interface ConversationDetail extends ConversationSummary {
  messages: ConversationMessage[];
  summary?: string | null;
  summaryTokens?: number | null;
  summaryThroughMessageId?: string | null;
}

export interface PiiInfo {
  mode: string;
  action: "block" | "warn" | "log";
  withheld?: boolean;
  inputHits?: Array<{ category: string }>;
  outputHits?: Array<{ category: string }>;
}

export interface CompactionInfo {
  compacted?: boolean;
  active?: boolean;
  savedTokensEst?: number;
  failOpen?: { error?: string };
}

export interface Decision {
  effect: string;
  ruleId: string;
  ruleChain?: string[];
  reason?: string;
}

export interface InvokeResult {
  decision?: Decision;
  routing?: {
    effect?: string;
    selectedAgentId?: string;
    estimatedCostSavedUsd?: number;
  };
  dispatch?: {
    model?: string;
    costUsd?: number;
    refusal?: boolean;
    outputText?: string;
    credentialSource?: "user" | "platform";
    servedAgentId?: string;
    usage?: { inputTokens: number; outputTokens: number };
    projectBudgetAlerted?: boolean;
    pii?: PiiInfo;
  };
  compaction?: CompactionInfo;
  streamingSuppressed?: boolean;
}

// ---- runs ----------------------------------------------------------------

export interface RunGraphNode {
  id: string;
  title: string;
  instruction?: string;
  dependsOn?: string[];
  ownerAgentId?: string;
  leadNodeId?: string;
  budgetCapUsd?: number;
}

export type NodeStatus = "not_started" | "in_progress" | "blocked" | "in_review" | "done";

export interface RunSummary {
  id: string;
  name: string;
  status: string;
  createdAt: string;
  projectId?: string | null;
  state?: { nodeStatuses?: Record<string, NodeStatus> };
  budget?: { measuredSpentUsd?: number; capUsd?: number };
}

/**
 * PILLAR 7 — POST /v1/runs/decompose. One governed, metered LEAD dispatch
 * drafts a task graph from a plain-language goal and returns a PROPOSAL ONLY:
 * nothing is created until the human submits it through POST /v1/runs. The
 * `substituted` / `dropped*` fields are the §5.1 "a lead can suggest, never
 * grant" record — the lead named something outside the caller's entitlements
 * and the gateway narrowed it. They must always be surfaced, never swallowed.
 */
export interface ProposalNode {
  id: string;
  title: string;
  instruction: string;
  ownerAgentId: string;
  agentName: string;
  mode: string;
  dependsOn: string[];
  substituted?: { requestedAgentName: string; reason: string };
  toolServers?: string[];
  droppedToolServers?: string[];
  maxTurns?: number;
  leadNodeId?: string;
  allowedAgentIds?: string[];
  allowedToolRefs?: string[];
  droppedAllowedAgents?: string[];
  droppedAllowedTools?: string[];
  budgetCapUsd?: number;
}

export interface DecomposeResponse {
  proposal: { name: string; nodes: ProposalNode[] };
  dispatch: {
    /** null = the lead's model is unpriced; cost is never invented */
    costUsd: number | null;
    modelUsed: string;
    servedAgentId: string;
    tokens: { inputTokens: number; outputTokens: number };
  };
  /** the first draft failed validation and the lead corrected it once */
  retried: boolean;
}

/** ADR-0010 §3 — GET /v1/pm/links?runId=|instanceId=. RegulAIt stores only the
 * linkage; the PM tool owns the fields. `drift` = the tool's last reported
 * state disagrees with the state RegulAIt's status maps to (run nodes only) —
 * surfaced, never auto-fixed. */
export interface PmLink {
  id: string;
  connectionId: string;
  connectionName: string | null;
  objectType: "run" | "run_node" | "workflow_instance" | "decision";
  objectId: string;
  nodeId: string | null;
  externalId: string;
  externalUrl: string;
  lastSyncedAt?: string | null;
  inboundState?: string | null;
  inboundAt?: string | null;
  adoptedState?: string | null;
  orphanedAt?: string | null;
  drift?: boolean;
}

/** ADR-0010 §4 — GET/POST /v1/decisions. First-class decision records, always
 * recorded locally; `pmMirror` is present only when the decision materialized
 * as a linked Decision-typed work item (a comment mirror leaves no link row). */
export interface DecisionRecord {
  id: string;
  objectType: "run" | "workflow_instance";
  objectId: string;
  decision: string;
  rationale: string | null;
  decisionMakerUserId: string;
  decisionMakerName?: string | null;
  createdAt: string;
  pmMirror?: { externalId: string; externalUrl: string } | null;
}

export interface RunEvent {
  at: string;
  event?: {
    kind?: string;
    nodeId?: string;
    outputText?: string;
    costUsd?: number;
    model?: string;
    turns?: number;
    toolCalls?: number;
    toolApprovalPending?: boolean;
  };
}

export interface RunDetailResponse {
  run: {
    id: string;
    name: string;
    status: string;
    createdAt: string;
    projectId?: string | null;
    initiatingUserId?: string | null;
    graph: { nodes: RunGraphNode[] };
    state: {
      nodeStatuses: Record<string, NodeStatus>;
      owners: Record<string, string>;
      lastError?: Record<string, string>;
    };
    budget?: {
      capUsd?: number | null;
      measuredSpentUsd?: number;
      overageApproved?: boolean;
      perNodeUsd?: Record<string, number>;
      measuredPerNodeUsd?: Record<string, number>;
    };
  };
  events: RunEvent[];
  pendingApprovals?: Array<{
    id: string;
    stageId: string | null;
    status: string;
    approverName?: string | null;
  }>;
}

// ---- workflows -----------------------------------------------------------

export interface WorkflowInstanceSummary {
  id: string;
  status: string;
  createdAt: string;
  projectId?: string | null;
  change?: { description?: string; changeType?: string; environment?: string };
}

export interface WorkflowStage {
  id: string;
  type: string;
  output?: string;
}

export interface CheckResult {
  check: string;
  status: string;
  severity?: string;
  detail?: string;
  /** ADR-0167 (AUTHZ-06): true when the change's own initiator posted this
   * result — the badge every approver should see before trusting the colour */
  selfReported?: boolean;
  reportedByUserId?: string | null;
  reason?: string | null;
  /** AER-047: true when NOTHING reported this check and the template's
   * offlineAutoPass opt-in passed it anyway — never CI's green. A check with no
   * report and no opt-in has status "pending" and holds the stage. */
  autoPassed?: boolean;
}

export interface WorkflowDetailResponse {
  instance: {
    id: string;
    status: string;
    createdAt: string;
    projectId?: string | null;
    initiatorUserId?: string | null;
    /** AER-048: the workflow round (bumped by every re-open) a check report
     * binds to */
    round?: number;
    change?: { description?: string; changeType?: string; environment?: string };
    definition: { stages: WorkflowStage[] };
    state: { currentStageIndex: number; stageStatuses: Record<number, string> };
    context?: Record<string, unknown> & {
      branch?: string;
      prUrl?: string;
      prId?: string | number;
      mergeSha?: string;
      lastError?: string;
    };
  };
  artifacts?: Array<{ id: string; output: string; version: number; content: string }>;
  pendingApprovals?: Array<{ id: string; approverName?: string | null; status: string }>;
}

export interface WorkflowListResponse {
  instances: WorkflowInstanceSummary[];
  changeTypes?: string[];
  routes?: Array<{ changeType: string; templates?: string[] }>;
}

// ---- approvals -----------------------------------------------------------

export interface Approval {
  id: string;
  /** `returned` = sent back for information (an intake sign-off only, ADR-0168) */
  status: "pending" | "approved" | "denied" | "returned" | "consumed" | "superseded";
  objectType: string;
  stageId: string | null;
  requestedAt: string;
  decidedAt?: string | null;
  decisionReason?: string | null;
  userId: string;
  approverUserId: string;
  instanceId?: string | null;
  runId?: string | null;
  projectId?: string | null;
  toolName?: string | null;
  serverId?: string | null;
  serverName?: string | null;
  projectName?: string | null;
  argumentsDigest?: string | null;
  argumentsPreview?: unknown;
  argumentsPreviewKind?: "arguments_v1" | "mcp_redacted_v1" | null;
  approvalScope?: "action" | "tool" | null;
  contextDigest?: string | null;
  expiresAt?: string | null;
  /** AER-039: the MCP target this consent is bound to, as recorded at queue
   * time — host only (a URL can carry credentials). null = not recorded. */
  boundTarget?: ApprovalBoundTarget | null;
  selfReview?: boolean;
  requestedByName?: string | null;
  approverName?: string | null;
  decidedByName?: string | null;
  objectLabel?: string | null;
  delegatedFrom?: string;
  /** the AI use case an intake sign-off decides, when the gateway names it (not yet in the ADR-0168
   * contract — the review panel falls back to matching the use-case list by workflow instance) */
  useCaseId?: string | null;
  /** ADR-0168 amendment: the reviewer role this intake review is for (one review per role the
   * review policy requires for the tier); absent on the single named-approver path */
  reviewRole?: { id: string; name: string } | null;
  /** ADR-0046 routing + SLA sidecar — absent when no routing rule is enabled */
  assignment?: {
    assigneeKind?: string;
    slaState?: string | null;
    dueAt?: string | null;
    [key: string]: unknown;
  };
  contextConflict?: {
    key: string;
    conflicting: ConflictSide;
    current: ConflictSide | null;
  };
}

export interface ApprovalBoundTarget {
  host: string | null;
  allowPrivateRanges: boolean | null;
  admissionManifestDigest: string | null;
}

export interface ConflictSide {
  revision: number;
  baseRevision?: number | null;
  content: string;
  byName?: string | null;
  at?: string;
}

// ---- projects ------------------------------------------------------------

export interface Project {
  id: string;
  name: string;
  budgetUsd?: number | null;
  spentUsd?: number;
  classifications?: string[];
}

export interface ProjectMember {
  userId: string;
  userName?: string | null;
  role: "owner" | "contributor" | "viewer";
  teamName?: string | null;
  createdAt: string;
}

export interface ProjectCosts {
  project?: { name?: string };
  initiative?: { name: string } | null;
  measured?: { costUsd?: number; events?: number };
  forecast?: { projectedEomUsd?: number; basis?: string };
  budget?: {
    spentUsd?: number;
    budgetUsd?: number | null;
    overageApproved?: boolean;
    period?: string;
    periodKey?: string;
    alertThresholdPct?: number;
    thresholdUsd?: number;
    thresholdCrossed?: boolean;
  };
  byUser?: Array<{ userId: string; costUsd: number }>;
  byTeam?: Array<{ name?: string | null; costUsd: number }>;
  byAgent?: Array<{ agentId?: string; model?: string; costUsd: number }>;
  byConnector?: Array<{ name?: string; operation?: string; costUsd: number }>;
  byMcpTool?: Array<{ toolName?: string; costUsd: number }>;
  estimatedSavings?: Array<{ technique: string; estimatedCostSavedUsd: number }>;
}

// ---- pillar 4: the shared context store (§9.2 / ADR-0011) ----------------
// Mirrors the gateway contracts in projects.ts exactly:
//   GET  /v1/projects/:id/context                 -> ContextResponse
//   GET  /v1/projects/:id/context?key=&history=1  -> ContextHistoryResponse
//   POST /v1/projects/:id/context                 -> ContextWriteOutcome (201)
//        409 { error: "base_revision_required", latestAccepted }
//        422 { error: "no_arbiter", detail }
//   POST /v1/projects/:id/context/promote         -> ContextWriteOutcome (201)
//        403 { error: "not_the_artifact_owner" } / 404 unknown_artifact
//   GET  /v1/projects/:id/context/graph           -> ContextGraphResponse

export interface ContextProvenance {
  userId?: string | null;
  userName?: string | null;
  teamId?: string | null;
  teamName?: string | null;
  sourceArtifactId?: string | null;
  at?: string | null;
}

/** the current (highest ACCEPTED) revision of one key */
export interface ContextItem {
  key: string;
  revision: number;
  content: string;
  provenance?: ContextProvenance;
}

/** a retained (accepted=false) revision whose conflict still sits with the arbiter */
export interface ContextPendingItem {
  itemId: string;
  key: string;
  revision: number;
  baseRevision: number | null;
  content: string;
  byName?: string | null;
  teamName?: string | null;
  at: string;
  approvalId: string;
}

export interface ContextResponse {
  context?: ContextItem[];
  pending?: ContextPendingItem[];
  arbiter?: { userId: string; name?: string | null } | null;
}

/** every retained side of every conflict for one key, oldest revision first */
export interface ContextHistoryRow {
  id: string;
  key: string;
  revision: number;
  baseRevision: number | null;
  content: string;
  accepted: boolean;
  sourceArtifactId?: string | null;
  createdAt: string;
  byName?: string | null;
  teamName?: string | null;
  pendingApprovalId?: string | null;
}

export interface ContextHistoryResponse {
  history?: ContextHistoryRow[];
}

/**
 * The write answer is an OUTCOME OBJECT, never a success boolean: a 201 with
 * `accepted: false` / `conflict: true` means the revision was RETAINED but is
 * NOT the current value — it was routed to the project's named arbiter. Every
 * caller must branch on it rather than treat the response as truthy.
 */
export interface ContextWriteOutcome {
  id: string;
  key: string;
  revision: number;
  accepted: boolean;
  conflict?: boolean;
  approvalId?: string | null;
}

export interface ContextGraphNode {
  id: string;
  key: string;
  revision: number;
  baseRevision: number | null;
  accepted: boolean;
  /** retained AND still awaiting the arbiter's decision */
  pending: boolean;
  /** truncated to 240 chars server-side — a preview, never the full text */
  content: string;
  contributor?: { userId?: string | null; name?: string | null; teamId?: string | null; teamName?: string | null };
  at: string;
}

export interface ContextGraphResponse {
  project: { id: string; name: string };
  nodes?: ContextGraphNode[];
  /** accepted head per key — everything else accepted is superseded */
  keys?: Array<{ key: string; currentRevision: number }>;
}

// ---- spend / dashboard ---------------------------------------------------

export interface UsageEventsResponse {
  events?: Array<{
    at: string;
    agentId?: string;
    connectorId?: string;
    objectType?: string;
    operation?: string;
    model?: string;
    inputTokens?: number;
    outputTokens?: number;
    costUsd?: number;
    measuredCostSavedUsd?: number;
    refusal?: boolean;
    projectId?: string | null;
    /** agent rows carry which credential actually served the call (ADR-0024):
     * "user" (a BYO key), "platform" (the org's), or "none" (mock). */
    detail?: { credentialSource?: string } | null;
  }>;
  totals?: {
    costUsd?: number;
    events?: number;
    inputTokens?: number;
    outputTokens?: number;
    measuredCostSavedUsd?: number;
  };
}

export interface SetupStep {
  key: string;
  title: string;
  done: boolean;
  evidence?: Record<string, unknown>;
  blockedBy?: string[];
}

export interface SetupStatusResponse {
  complete: boolean;
  doneCount: number;
  totalCount: number;
  steps: SetupStep[];
}

export interface AuditEntry {
  id?: string;
  at: string;
  userId: string;
  objectType?: string | null;
  toolName?: string | null;
  effect: string;
  ruleId: string;
  /** A4 (ADR-0027): the deploy mode a deploy-mode-scoped action acted on.
   * null/absent = UNKNOWN — either the row predates migration 0044 (honestly
   * un-backfillable) or the action was never deploy-scoped. Never render this
   * as a mode; render it as "unknown". */
  deployMode?: "hosted" | "byoc" | "air_gapped" | null;
  reason?: string | null;
}

// ---- AI use-case lifecycle (ADR-0168) ------------------------------------

export type UseCaseStatus = "proposed" | "under_review" | "needs_info" | "approved" | "rejected" | "retired";

/** a condition attached to an intake approval — `blocking` = before go-live (the deploy gate refuses while open) */
export interface UseCaseCondition {
  id: string;
  approvalId: string;
  text: string;
  ownerUserId: string | null;
  ownerName: string | null;
  dueAt: string;
  blocking: boolean;
  status: "open" | "met" | "waived";
  metAt: string | null;
  metByName: string | null;
  overdue: boolean;
  /** whether the signed-in viewer may mark it met (the server's rule, computed
   * for them; absent from an older gateway — treated as "no") */
  canMarkMet?: boolean;
}

/** the fields GET /v1/use-cases/:id adds for the approval lifetime and its conditions */
export interface UseCaseLifecycleDetail {
  useCase: {
    id: string;
    status: UseCaseStatus;
    approvedAt?: string | null;
    approvedUntil?: string | null;
    approvalExpired?: boolean;
    /** an expired approval moved back into review by the recertification sweep */
    recertification?: boolean;
    /** the approval's end (= approvedUntil) that started the re-review */
    recertificationDueAt?: string | null;
    [key: string]: unknown;
  };
  conditions?: UseCaseCondition[];
  /** one per required review in the current round; [] on the single named-approver path */
  reviews?: UseCaseReview[];
  /** risk rows with their acceptance, when a risk acceptor accepted residual risk */
  risks?: UseCaseRiskAcceptance[];
  /** what the registration screen needs to update and resubmit a use case sent back for information */
  resubmission?: UseCaseResubmission;
  /** ADR-0171: the owner's own words for why each accepted framework applies ({} when none) */
  frameworkRationales?: Record<string, string>;
  /** ADR-0171: the yes/no screening answers the owner was not sure about (each counted as yes) */
  screeningUnsure?: string[];
}

export interface ApprovalConditionInput {
  text: string;
  ownerUserId?: string;
  dueAt: string;
  blocking: boolean;
}

/** POST /v1/approvals/:id/decide — `returned` needs a reason; conditions ride only on an approved intake sign-off */
export interface DecideApprovalBody {
  decision: "approved" | "denied" | "returned";
  reason?: string;
  conditions?: ApprovalConditionInput[];
  /** only with `approved`, only from a risk acceptor named in the review policy */
  acceptRisks?: AcceptRisksInput;
}

export interface AcceptRisksInput {
  riskIds: string[];
  /** 10..2000 characters */
  rationale: string;
}

// ---- review policy and the review round (ADR-0168 amendment, afternoon) ----

export type ReviewTier = "minimal" | "limited" | "high" | "prohibited" | "unscreened";

/** a reviewer role: any member may decide that role's review */
export interface ReviewerRole {
  /** slug, [a-z0-9-]{2,40} */
  id: string;
  name: string;
  memberUserIds: string[];
}

export interface ReviewTierPolicy {
  /** each role listed is ONE required review */
  roleIds: string[];
  /** 1..36 — overrides the default approval lifetime for the tier */
  validityMonths: number;
}

/** GET /v1/governance/review-policy (any signed-in user) */
export interface ReviewPolicy {
  roles: ReviewerRole[];
  tiers: Partial<Record<ReviewTier, ReviewTierPolicy>>;
  riskAcceptorUserIds: string[];
  updatedAt: string | null;
  updatedByName: string | null;
}

/** PUT /v1/governance/review-policy (admin) */
export interface ReviewPolicyInput {
  roles: ReviewerRole[];
  tiers: Partial<Record<ReviewTier, ReviewTierPolicy>>;
  riskAcceptorUserIds: string[];
}

/** `superseded`: the round was closed by another role's denial or send-back
 * before this review was decided */
export type UseCaseReviewStatus = "pending" | "approved" | "returned" | "denied" | "superseded";

export interface UseCaseReview {
  roleId: string;
  roleName: string;
  status: UseCaseReviewStatus;
  deciderName: string | null;
  decidedAt: string | null;
  approvalId: string;
}

export interface UseCaseRiskAcceptance {
  id: string;
  title?: string;
  status?: string;
  acceptedByName?: string | null;
  acceptedAt?: string | null;
  acceptanceRationale?: string | null;
}

/** the structured EU AI Act screening answers (the shared euAiActAnswersSchema) */
export interface EuAiActScreeningAnswers {
  purposeDomain: string;
  affectedPersons: string[];
  decisionAutonomy: string;
  biometricUse: string;
  emotionRecognition: boolean;
  socialScoring: boolean;
  manipulativeTechniques: boolean;
  profilesNaturalPersons: boolean;
  safetyComponent: boolean;
  interactsWithHumans: boolean;
  generatesSyntheticContent: boolean;
}

/** the registration Classify step's context answers beyond the EU AI Act set
 * (the shared intakeContextSchema) */
export interface IntakeContextAnswers {
  sectors: string[];
  dataCategories: string[];
  deployment: string;
  euNexus: boolean;
  usesExternalVendor: boolean;
  generative: boolean;
  autonomousActions: boolean;
  toolsUsed: string[];
}

/** EVERY Classify-step answer, flat — `screeningAnswers` on POST /v1/use-cases
 * and on the resubmission PATCH (the shared intakeScreeningAnswersSchema) */
export type IntakeScreeningAnswers = EuAiActScreeningAnswers & IntakeContextAnswers;

export interface UseCaseResubmission {
  allowed: boolean;
  /** the stored Classify answers; a use case registered before they were
   * stored carries the EU answers of its questionnaire only */
  screeningAnswers: (EuAiActScreeningAnswers & Partial<IntakeContextAnswers> & { unsure?: string[] }) | null;
  questionnaire: { version: number; content: string } | null;
  returnReason: string | null;
  returnedByName: string | null;
}

/** GET /v1/users/directory — ids, names and teams only; readable by every signed-in user */
export interface DirectoryUser {
  id: string;
  name: string | null;
  teams?: Array<{ id: string; name: string }>;
}

// ---- ADR-0172: the agent builder (/v1/builder/*) ---------------------------

export type BuilderSharing = "private" | "workspace" | "people";
export type BuilderConnectionFormat = "shared" | "per_user";
export type BuilderCadence = "hourly" | "daily" | "weekdays" | "weekly";
export type BuilderThreadStatus = "active" | "needs_attention" | "completed";
export type BuilderChannelProvider = "slack" | "teams" | "outlook" | "email";

export interface BuilderModelRef {
  id: string;
  name: string;
  provider: string;
  model: string | null;
}

export interface BuilderAgentSummary {
  id: string;
  name: string;
  description: string;
  color: string;
  ownerUserId: string;
  ownerName: string | null;
  sharing: BuilderSharing;
  modelAgent: BuilderModelRef | null;
  templateId: string | null;
  monthlyLimitUsd: number | null;
  spentThisMonthUsd: number;
  toolCount: number;
  skillCount: number;
  scheduleCount: number;
  updatedAt: string;
  canEdit: boolean;
}

export interface BuilderTool {
  kind: "connector" | "mcp_tool";
  refId: string;
  name: string;
  /** connector kind or MCP server name, for a logo */
  provider: string | null;
  requiresApproval: boolean;
  entitledForYou: boolean;
}

export interface BuilderSubagent {
  childId: string;
  name: string;
  description: string;
  childName: string;
}

export interface BuilderMemoryItem {
  id: string;
  content: string;
  createdByName: string | null;
  createdAt: string;
}

export interface BuilderSchedule {
  id: string;
  name: string;
  cadence: BuilderCadence;
  timeUtc: string;
  prompt: string;
  enabled: boolean;
  /** written or changed by someone other than the owner: off until the OWNER
   * turns it on (it runs, and spends, as them) */
  awaitingOwner: boolean;
  lastEditedByName: string | null;
  nextRunAt: string | null;
  lastRunAt: string | null;
}

export interface BuilderChannel {
  id: string;
  provider: BuilderChannelProvider;
  status: "connected" | "needs_setup";
  connectionName: string | null;
}

export interface BuilderAgentDetail extends BuilderAgentSummary {
  instructions: string;
  connectionFormat: BuilderConnectionFormat;
  computerUse: boolean;
  /** the project this agent's spend bills to */
  project: { id: string; name: string } | null;
  sharedUserIds: string[];
  sharedUsers: Array<{ id: string; name: string | null }>;
  tools: BuilderTool[];
  subagents: BuilderSubagent[];
  /** skills are PINNED at attach: `updateAvailable` = the library copy changed
   * since (re-attach to take it); `unavailable` = the owner can no longer see
   * it, so it is left out of the agent's prompt */
  skills: Array<{ id: string; name: string; description: string; updateAvailable: boolean; unavailable: boolean }>;
  memory: BuilderMemoryItem[];
  schedules: BuilderSchedule[];
  channels: BuilderChannel[];
}

export interface BuilderThreadSummary {
  id: string;
  agentId: string;
  agentName: string;
  agentColor: string;
  title: string;
  status: BuilderThreadStatus;
  source: "chat" | "schedule" | "channel";
  lastMessagePreview: string;
  updatedAt: string;
}

export interface BuilderMessage {
  id: string;
  role: "user" | "agent" | "system";
  content: string;
  model: string | null;
  costUsd: number | null;
  latencyMs: number | null;
  createdAt: string;
}

export interface BuilderSkillSummary {
  id: string;
  name: string;
  description: string;
  visibility: "private" | "workspace";
  ownerName: string | null;
  usedBy: number;
  updatedAt: string;
  canEdit: boolean;
}
export interface BuilderSkillDetail extends BuilderSkillSummary {
  body: string;
}

export interface BuilderTemplate {
  id: string;
  name: string;
  tagline: string;
  description: string;
  category: string;
  /** logo keys */
  integrations: string[];
  instructions: string;
  skills: Array<{ name: string; description: string; body: string }>;
  subagents: Array<{ name: string; description: string }>;
  schedules: Array<{ name: string; cadence: BuilderCadence; timeUtc: string; prompt: string }>;
  steps: string[];
}

export type BuilderIntegrationCategory = "productivity" | "developer" | "communication" | "data" | "security" | "ai";
export interface BuilderIntegrationItem {
  /** a logo key */
  key: string;
  name: string;
  description: string;
  category: BuilderIntegrationCategory;
  status: "connected" | "available";
  /** the admin page that connects it */
  connectHref: string;
  kind: "connector" | "mcp" | "chatops";
}
export interface BuilderIntegrationsResponse {
  groups: Array<{ name: string; items: BuilderIntegrationItem[] }>;
  custom: { mcpServers: Array<{ id: string; name: string; toolCount: number }> };
}

export interface BuilderUsage {
  totals: { spendUsd: number; messages: number; agents: number; activeUsers: number };
  byAgent: Array<{ agentId: string; name: string; spendUsd: number; messages: number; limitUsd: number | null }>;
  byUser: Array<{ userId: string; name: string; spendUsd: number; messages: number }>;
  byModel: Array<{ provider: string; model: string; spendUsd: number; messages: number }>;
  daily: Array<{ date: string; spendUsd: number; messages: number }>;
}

/** GET /builder/toolbox-options — something the caller may add to a toolbox */
export interface BuilderToolboxOption {
  kind: "connector" | "mcp_tool";
  /** the id PUT …/tools takes: a connector id, or the MCP tool's own id */
  refId: string;
  name: string;
  /** connector provider kind, or MCP server name (for a logo) */
  provider: string | null;
  description?: string;
  /** MCP tools only */
  access?: "read" | "write";
}

/** POST /builder/agents/import — a bundled tool the importer did not get */
export interface BuilderImportDropped {
  kind: "connector" | "mcp_tool";
  /** connector name, or "server/tool" */
  name: string;
  reason: "not_found" | "not_entitled";
}

/** GET /builder/agents/:id/export — portable: no ids, no owners */
export interface BuilderBundle {
  version: 1;
  agent: { name: string; [k: string]: unknown };
  skills: Array<Record<string, unknown>>;
}
