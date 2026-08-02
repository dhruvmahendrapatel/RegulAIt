/** Response shapes of the admin-only gateway endpoints (phase 2). Derived from
 * apps/gateway/src/{app,auth,agents-connectors,projects,infra,workflows,pm,
 * optimization,org-settings}.ts — the same contracts the legacy /admin drives.
 * Fields the UI does not render are omitted. */

// ---- identity ------------------------------------------------------------

export interface AdminUser {
  id: string;
  email: string;
  displayName: string;
  isAdmin: boolean;
  disabledAt: string | null;
  createdAt: string;
  totpEnabled: boolean;
  hasPassword: boolean;
  mustChangePassword: boolean;
}

export interface ApiKey {
  id: string;
  name: string;
  userId: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface UserSession {
  id: string;
  createdAt: string;
  expiresAt: string;
  idleExpiresAt: string | null;
  lastSeenAt: string | null;
  ip: string | null;
  /** ADR-0039: where the session was LAST used (ip = where it started) */
  lastSeenIp: string | null;
  userAgent: string | null;
  /** ADR-0039: derived browser+OS family — display only, never a control */
  deviceLabel: string;
  origin: string;
  revokedAt: string | null;
}

/** ADR-0039: the caller's own live sessions (GET /auth/sessions) */
export interface OwnSession {
  id: string;
  createdAt: string;
  expiresAt: string;
  lastSeenAt: string | null;
  ip: string | null;
  lastSeenIp: string | null;
  origin: string;
  deviceLabel: string;
  current: boolean;
}

export interface OidcProvider {
  id: string;
  name: string;
  issuerUrl: string;
  clientId: string;
  allowedEmailDomains: string[] | null;
  defaultRoleId: string | null;
  jitProvisioning: boolean;
  enabled: boolean;
}

export interface Role {
  id: string;
  name: string;
  description: string | null;
  createdAt?: string;
}

export interface RoleAssignment {
  userId: string;
  email: string;
  displayName: string | null;
  disabledAt: string | null;
  assignedAt: string;
}

export interface RoleGrants {
  agents?: Array<{ grantId: string; agentId: string; agentName?: string; allowedModes?: string[] | null }>;
  connectors?: Array<{
    grantId: string;
    connectorId: string;
    connectorName?: string;
    mode: string;
    allowedObjects?: string[] | null;
  }>;
  servers?: Array<{ grantId: string; serverId: string; serverName?: string; readOnlyAll: boolean }>;
  tools?: Array<{ grantId: string; serverId: string; serverName?: string; toolName: string }>;
}

export interface Team {
  id: string;
  name: string;
  defaultClassifications?: string[] | null;
  members?: Array<{ userId: string; name: string }>;
}

/** O9 (ADR-0027): a revocation is CREATED 'full' (the ADR-0019 total). An
 * explicit, audited second act can narrow it to 'read_only' — writes stay
 * denied, reads are allowed again. Agent revocations carry no scope: agents
 * have no read/write operation classification to scope by. */
export type RevocationScope = "full" | "read_only";
/** the two revocation kinds the scope endpoint accepts (path discriminant) */
export type RevocationScopeKind = "mcp" | "connectors";

export interface McpRevocation {
  id: string;
  userId: string;
  serverId: string;
  toolName: string | null;
  scope?: RevocationScope;
  createdAt: string;
}

export interface ObjectRevocation {
  id: string;
  agentName?: string;
  connectorName?: string;
  reason: string | null;
  /** connector revocations only — agent revocations have no scope */
  scope?: RevocationScope;
  createdAt: string;
}

// ---- catalogs ------------------------------------------------------------

export interface AdminAgent {
  id: string;
  name: string;
  provider: string;
  tier: number;
  model: string | null;
  enabled: boolean;
  costPerMTokIn: number | null;
  costPerMTokOut: number | null;
  systemPrompt: string | null;
  /** ADR-0034: set iff provider === 'custom' — the DB enforces the pair as a
   * discriminated union, so these two fields are never independently valid. */
  customProviderId?: string | null;
}

// ---- ADR-0034: custom LLM providers + the egress allow-list ---------------

export type CustomWireProtocol = "openai_chat" | "anthropic_messages";

/**
 * The read projection of a `custom_model_providers` row. `keyCiphertext` is
 * structurally absent from every response — the stored key is NEVER returned,
 * only `hasApiKey`, so this type has no field that could hold it.
 */
export interface CustomModelProvider {
  id: string;
  name: string;
  wireProtocol: CustomWireProtocol;
  baseUrl: string;
  /** the PROVIDER half of the two-flag plaintext-http opt-in */
  allowPlaintextHttp: boolean;
  enabled: boolean;
  /** written only by a PASSING connection test — it is what the enable gate reads */
  lastTestedAt: string | null;
  lastTestError: string | null;
  hasApiKey?: boolean;
  createdBy: string | null;
  createdAt: string;
}

/** One granted egress destination. A bare host — no scheme, port, path or
 * wildcard: the guard matches it exactly against the normalized destination. */
export interface EgressAllowHost {
  id: string;
  host: string;
  allowPrivateRanges: boolean;
  allowPlaintextHttp: boolean;
  note: string | null;
  createdBy: string | null;
  createdAt: string;
}

/** A passing POST /v1/custom-model-providers/:id/test. */
export interface ConnectionTestResult {
  ok: true;
  host: string;
  port: number;
  protocol: string;
  model: string;
  stopReason?: string | null;
}

export interface UserAgentPolicyView {
  agents: Array<{ agentId: string; name: string; provider: string; tier: number; revoked?: boolean }>;
  defaultAgentId: string | null;
  ceilingAgentId: string | null;
  routingMode: string | null;
  runBudgetUsd: number | null;
  runBudgetBreachAction: string | null;
}

export interface ModelCredential {
  id: string;
  provider: string;
  baseUrl: string | null;
  createdAt: string;
}

export interface Connector {
  id: string;
  name: string;
  kind: string;
  providerKind?: string | null;
  baseUrl?: string | null;
  pricePerCallUsd?: number | null;
  createdAt?: string;
}

export interface ConnectorCredentialInfo {
  credential: { id: string; connectorId: string; baseUrl: string | null; createdAt: string } | null;
}

export interface McpServer {
  id: string;
  name: string;
  url: string;
  /** PILLAR 5: the server's FLAT list price per allowed tool call. Null =
   * unpriced (cost stays an honest null, never invented). */
  pricePerCallUsd?: number | null;
  /** ADR-0043: may this server's URL resolve into ordinary private LAN space?
   * null = inherit the org default (mcpPrivateRangesDefault). IMDS/link-local
   * is never opened by this flag. */
  allowPrivateRanges?: boolean | null;
  createdAt?: string;
}

export interface McpTool {
  id?: string;
  serverId: string;
  name: string;
  kind: "read" | "write";
  description?: string | null;
  /** O10 (ADR-0027): the optional PER-TOOL price override on this inventory
   * row. Resolution at metering time is tool-first, server-flat fallback.
   * Null = no override = this tool inherits the server's flat price. */
  pricePerCallUsd?: number | null;
}

export interface GitConnection {
  id?: string;
  name: string;
  provider: string;
  baseUrl: string | null;
  createdAt: string;
}

export interface PmConnection {
  id?: string;
  name: string;
  provider: string;
  project: string;
  baseUrl: string | null;
  apiVersion?: number | null;
  createdAt: string;
}

export interface DeployTarget {
  id: string;
  name: string;
  provider: string;
  environment: string | null;
  baseUrl: string | null;
  mode: string;
  roleArn: string | null;
  region: string | null;
  createdAt: string;
}

// ---- governance ----------------------------------------------------------

/** A4 (ADR-0027): the deploy-mode a restriction rule is scoped to. null (the
 * default, and every pre-0044 rule) means mode-unscoped — it applies to every
 * call. The context is derived SERVER-side, never client-asserted. */
export type RuleDeployMode = "hosted" | "byoc" | "air_gapped";
/** the three rule kinds the deploy-mode endpoint accepts (path discriminant) */
export type RuleKind = "approvals" | "data-scopes" | "rate-limits";

export interface RuleBase {
  id: string;
  scope: "user" | "role" | "team" | "fleet";
  userId?: string | null;
  roleId?: string | null;
  teamId?: string | null;
  serverScope: "server" | "all";
  serverId?: string | null;
  toolName?: string | null;
  deployMode?: RuleDeployMode | null;
  createdAt: string;
}

export interface ApprovalRule extends RuleBase {
  approverUserId: string;
}
export interface DataScopeRule extends RuleBase {
  argPath: string;
  allowedValues: string[];
}
export interface RateLimitRule extends RuleBase {
  maxCalls: number;
  windowSeconds: number;
}

export interface RuleTrace {
  rule: string;
  outcome: "allow" | "deny" | "no-match" | "revoked" | "require-approval" | "satisfied-by-approval";
  grantId?: string;
}

export interface EvaluateDecision {
  effect: "allow" | "deny" | "require_approval";
  ruleId: string | null;
  ruleChain: RuleTrace[];
  reason?: string | null;
  approverUserId?: string | null;
  approverName?: string | null;
}

export interface Delegation {
  id: string;
  fromUserId: string;
  toUserId: string;
  fromName?: string | null;
  toName?: string | null;
  startsAt: string;
  endsAt: string;
  active?: boolean;
  reason?: string | null;
}

export interface AuditRetention {
  retainedDays: number | null;
  floorSource: string[] | null;
  cutoff?: string | null;
  prunable: number;
}

// ---- client access -------------------------------------------------------

export interface InterceptionSettings {
  anthropicCompatEnabled: boolean;
  openaiCompatEnabled: boolean;
  mcpInterceptionEnabled: boolean;
  resolutionMode: "map_by_model" | "require_agent" | "router_decides";
  enforcementPosture: "observe" | "voluntary" | "managed" | "key_custody" | "network";
  requireProjectAttribution: boolean;
  requireMcpAttribution: boolean;
  keyCustodyEnforced: boolean;
  streamingOnBlockMode: "suppress" | "reject";
  strictFieldRejection: boolean;
}

export interface InterceptionSettingsResponse {
  settings: InterceptionSettings;
  posture?: {
    status: "honor_system" | "policy" | "declared_not_enforced" | "enforced" | "external_infrastructure";
    label?: string;
    detail?: string;
  };
}

export interface ScopeRule {
  id: string;
  scopeKind: "user" | "project" | "role";
  scopeId: string;
  scopeName?: string | null;
  anthropicCompatEnabled: boolean | null;
  openaiCompatEnabled: boolean | null;
  resolutionMode: string | null;
  note: string | null;
  createdAt: string;
}

export interface EffectiveInterception {
  effective: { anthropicCompatEnabled: boolean; openaiCompatEnabled: boolean; resolutionMode: string };
  sources: Record<string, { level: string; ruleId: string }>;
  org: { anthropicCompatEnabled: boolean; openaiCompatEnabled: boolean; resolutionMode: string };
}

// ---- cost / optimization -------------------------------------------------

export interface AdminProject {
  id: string;
  name: string;
  costCenter: string | null;
  initiativeId?: string | null;
  budgetUsd: number | null;
  spentUsd: number;
  budgetPeriod?: string | null;
  alertThresholdPct?: number | null;
  budgetApproverUserId?: string | null;
  arbiterUserId?: string | null;
  classifications?: string[] | null;
}

export interface Initiative {
  id: string;
  name: string;
  costCenter: string | null;
  projectCount?: number;
  spentUsd?: number;
}

export interface UnattributedCosts {
  measured: {
    events: number;
    costUsd: number;
    inputTokens?: number;
    outputTokens?: number;
  } | null;
  byUser?: Array<{ userId: string; costUsd: number }>;
  byMcpTool?: Array<{ toolName?: string; costUsd: number }>;
}

export interface CostEvent {
  id?: string;
  at: string;
  userId?: string;
  technique: string;
  estimatedTokensSaved?: number | null;
  estimatedCostSavedUsd?: number | null;
  detail?: Record<string, unknown> | null;
}

export interface CostEventsResponse {
  events: CostEvent[];
  totals: Array<{
    technique: string;
    events: number;
    estimatedCostSavedUsd: number;
    estimatedTokensSaved: number;
  }>;
}

// ---- compliance / infra --------------------------------------------------

export interface ComplianceProfile {
  id?: string;
  tag: string;
  requiredTemplateIds: string[] | null;
  mcpDefaultMode: "read_only" | "read_write";
  auditRetentionDays: number | null;
  piiMode: "block" | "warn" | "log";
  backupRetentionDays: number | null;
  patchCadenceDays: number | null;
}

export interface ProjectCompliance {
  classifications: string[];
  pendingClassifications: string[] | null;
  profiles?: ComplianceProfile[];
  effective: {
    requiredTemplateIds?: string[] | null;
    mcpDefaultMode?: string;
    auditRetentionDays?: number | null;
    piiMode?: string;
    backupRetentionDays?: number | null;
    patchCadenceDays?: number | null;
  };
  enforcement: Record<string, string>;
}

export interface InfraResource {
  id: string;
  name: string;
  kind: string;
  provider: string;
  classifications?: string[] | null;
  effectivePolicy?: {
    autoRemediateMaxSeverity?: string | null;
    backupRetentionDaysFloor?: number | null;
    patchCadenceDaysCeiling?: number | null;
  };
}

export interface InfraPolicy {
  id?: string;
  resourceId: string | null;
  patchCadenceDays: number | null;
  certRotationDaysBeforeExpiry: number | null;
  backupSchedule: string | null;
  backupRetentionDays: number | null;
  autoRemediateMaxSeverity: string | null;
}

export interface InfraFinding {
  id: string;
  resourceName?: string | null;
  kind: string;
  severity: "critical" | "high" | "medium" | "low";
  status: string;
  detail?: { summary?: string } | null;
  detectedAt: string;
}

export interface InfraPosture {
  resources?: number;
  findings?: number;
  open?: number;
  bySeverity?: Record<string, number>;
  byKind?: Record<string, number>;
  byStatus?: Record<string, number>;
  backup?: { missed?: number; targets?: number };
}

export interface InfraCert {
  id: string;
  resourceName?: string | null;
  commonName: string;
  notAfter: string;
  status: string;
  serial?: string | null;
}

export interface InfraPatch {
  id: string;
  resourceName?: string | null;
  cve: string;
  severity: "critical" | "high" | "medium" | "low";
  package?: string | null;
  fixedVersion?: string | null;
  status: string;
}

export interface InfraBackup {
  id: string;
  resourceName?: string | null;
  kind: string;
  status: string;
  retentionUntil?: string | null;
}

// ---- workflows (admin) ---------------------------------------------------

export interface WorkflowTemplate {
  id: string;
  name: string;
  retiredAt?: string | null;
  retiredReason?: string | null;
  definition: {
    workflow?: string;
    costSensitivity?: string;
    stages?: Array<{ id: string; type: string }>;
  };
}

export interface AssignmentRule {
  id: string;
  templateId: string;
  pathPattern?: string | null;
  changeType?: string | null;
  environment?: string | null;
  targetSystem?: string | null;
  initiatorRole?: string | null;
  dataSensitivity?: string | null;
  createdAt: string;
}

// ---- org settings --------------------------------------------------------

export interface OrgSettings {
  [key: string]: unknown;
  infraApproverUserId?: string | null;
  envFallbackProviders?: string[];
  /** ADR-0034 master switch. Off refuses registration/enablement and stops
   * every custom-provider dispatch with a 409 before anything leaves the box. */
  customModelProvidersEnabled?: boolean;
  /** ADR-0043: the org default for MCP servers whose allowPrivateRanges is
   * null. true (default) = private-LAN MCP URLs work with zero ceremony;
   * false = strict. IMDS/link-local stays blocked either way. */
  mcpPrivateRangesDefault?: boolean;
  /** ADR-0039: org network envelope (CIDR blocks; null/empty = unrestricted) */
  sessionIpAllowlist?: string[] | null;
  /** ADR-0039: human-session knob — off | enforce_at_login | enforce_continuous */
  sessionIpPolicy?: "off" | "enforce_at_login" | "enforce_continuous";
  /** ADR-0039: the separate automation knob, same levels over the same list */
  apiKeyIpPolicy?: "off" | "enforce_at_login" | "enforce_continuous";
}

export interface OrgSettingsResponse {
  settings: OrgSettings;
  envKeys?: Array<{ provider: string; envVar: string; present: boolean }>;
}
