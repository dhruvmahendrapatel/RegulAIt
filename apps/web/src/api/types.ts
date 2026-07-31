/** Response shapes of the gateway endpoints the phase-1 surface consumes.
 * Derived from apps/gateway/src/{app,auth,app-ui,setup-status}.ts — the same
 * contracts the legacy /app drives. Fields the UI does not render are omitted
 * (the client never depends on more than it shows). */

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
  user: { id: string; email: string; displayName: string } | null;
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
  status: "pending" | "approved" | "denied" | "consumed" | "superseded";
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
  selfReview?: boolean;
  requestedByName?: string | null;
  approverName?: string | null;
  decidedByName?: string | null;
  objectLabel?: string | null;
  delegatedFrom?: string;
  contextConflict?: {
    key: string;
    conflicting: ConflictSide;
    current: ConflictSide | null;
  };
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
  reason?: string | null;
}
