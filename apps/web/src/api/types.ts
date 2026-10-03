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
}

/** the fields GET /v1/use-cases/:id adds for the approval lifetime and its conditions */
export interface UseCaseLifecycleDetail {
  useCase: {
    id: string;
    status: UseCaseStatus;
    approvedAt?: string | null;
    approvedUntil?: string | null;
    approvalExpired?: boolean;
    [key: string]: unknown;
  };
  conditions?: UseCaseCondition[];
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
}

/** GET /v1/users/directory — ids, names and teams only; readable by every signed-in user */
export interface DirectoryUser {
  id: string;
  name: string | null;
  teams?: Array<{ id: string; name: string }>;
}
