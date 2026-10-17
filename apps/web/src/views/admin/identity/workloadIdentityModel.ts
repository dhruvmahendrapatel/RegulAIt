/**
 * ADR-0188 S6 — the workload identities admin page, as the console reads it.
 *
 * MIRRORS `packages/shared/src/identity/contract.ts` (the SPA does not import
 * the shared package). The wire shapes below are the frozen S4/S5 read views
 * and the S6 credential, proposal and picker views;
 * `workloadIdentityModel.test.ts` reads the shared source and the gateway's
 * route file so neither the limits nor the list of routes this page treats as
 * "not built yet" can drift silently.
 *
 * The server is the enforcement. Everything here is either a display rule or
 * a pre-check that gives a sentence before the request is sent; the gateway
 * refuses the same things on its own.
 */

// ---------------------------------------------------------------------------
// mirrored contract constants
// ---------------------------------------------------------------------------

export const WORKLOAD_IDENTITY_KINDS = ["agent", "builder_agent", "engine_runner", "worker_runtime", "pdp"] as const;
export type WorkloadIdentityKind = (typeof WORKLOAD_IDENTITY_KINDS)[number];
export const WORKLOAD_IDENTITY_STATUSES = ["active", "suspended", "revoked"] as const;
export type WorkloadIdentityStatus = (typeof WORKLOAD_IDENTITY_STATUSES)[number];
export const WORKLOAD_IDENTITY_MAX_STEWARDS = 10;
export const WORKLOAD_IDENTITY_MAX_ENVIRONMENTS = 20;
/** an environment or deploy-mode name; the database CHECK holds the same pattern */
export const ENVIRONMENT_NAME_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
export const CONNECTOR_GRANT_MODES = ["read", "readwrite"] as const;
export type ConnectorGrantMode = (typeof CONNECTOR_GRANT_MODES)[number];
export const GRANTS_REVISION_CONFLICT = "grants_revision_conflict";

/** the per-list bounds of `actorEntitlementsSchema` / `putAgentGrantsSchema` */
export const GRANT_SET_LIMITS = {
  tools: 5000,
  servers: 1000,
  agents: 1000,
  connectors: 1000,
  roleIds: 100,
  toolNameLength: 200,
  modes: 20,
  modeNameLength: 64,
  objects: 500,
  objectNameLength: 200,
} as const;

/** a UUID, as the shared schemas' `z.string().uuid()` accepts it (linear, no backtracking) */
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// wire shapes (frozen S4/S5 read views)
// ---------------------------------------------------------------------------

export interface WorkloadIdentityView {
  id: string;
  kind: WorkloadIdentityKind;
  agentId: string | null;
  builderAgentId: string | null;
  engineRunnerId: string | null;
  identifier: string;
  sponsorUserIds: string[];
  environments: string[];
  status: WorkloadIdentityStatus;
  grantsRevision: number;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}
/** `GET /v1/workload-identities` */
export interface WorkloadIdentityListView {
  items: WorkloadIdentityView[];
  nextCursor: string | null;
}
/** `GET /v1/workload-identities/:identityId` */
export interface WorkloadIdentityDetailView extends WorkloadIdentityView {
  activeCredentialCount: number;
  liveDelegationGrantCount: number;
}
export interface IdentityToolGrant { serverId: string; toolName: string }
export interface IdentityServerGrant { serverId: string; readOnlyAll: boolean }
export interface IdentityAgentGrant { agentId: string; allowedModes: string[] }
export interface IdentityConnectorGrant { connectorId: string; mode: ConnectorGrantMode; allowedObjects: string[] }
/** the body of `PUT /v1/workload-identities/:identityId/grants`: the WHOLE set, at the revision read */
export interface PutAgentGrants {
  tools: IdentityToolGrant[];
  servers: IdentityServerGrant[];
  agents: IdentityAgentGrant[];
  connectors: IdentityConnectorGrant[];
  roleIds: string[];
  revision: number;
}
/** `GET /v1/workload-identities/:identityId/grants` */
export interface AgentGrantsView extends PutAgentGrants {
  identityId: string;
}
export interface DelegationGrantView {
  id: string;
  rootGrantId: string;
  parentGrantId: string | null;
  path: string[];
  depth: number;
  sponsorUserId: string;
  actorIdentityId: string;
  runId: string | null;
  projectId: string | null;
  capMicros: number | null;
  settledMicros: number;
  reservedMicros: number;
  environment: string;
  audience: string | null;
  expiresAt: string;
  revokedAt: string | null;
  revokedReason: string | null;
  createdAt: string;
}
export interface DelegationAllocationView {
  id: string;
  parentGrantId: string;
  childGrantId: string;
  amountMicros: number;
  drawnMicros: number;
  releasedMicros: number;
  status: "open" | "closed";
  createdAt: string;
  closedAt: string | null;
}
/** `GET /v1/delegation-grants?runId=` */
export interface DelegationGrantListView {
  items: DelegationGrantView[];
  edges: DelegationAllocationView[];
  nextCursor: string | null;
}

// ---------------------------------------------------------------------------
// S6 wire shapes: credentials, proposals, picker sources
// ---------------------------------------------------------------------------

export const WORKLOAD_CREDENTIAL_KINDS = ["jwk", "x509", "spiffe_id"] as const;
export type WorkloadCredentialKind = (typeof WORKLOAD_CREDENTIAL_KINDS)[number];
/** a registered key lives at most this long (OWNER DECISION 7) */
export const WORKLOAD_CREDENTIAL_MAX_DAYS = 90;
/** the private or symmetric JWK members that must never be sent */
export const PRIVATE_JWK_MEMBERS = ["d", "p", "q", "dp", "dq", "qi", "oth", "k"] as const;
/** a SPIFFE ID, as the shared contract's pattern reads it */
export const SPIFFE_ID_PATTERN = /^spiffe:\/\/[a-z0-9._-]{1,255}(\/[A-Za-z0-9._-]+)+$/;
export const SPIFFE_ID_MAX_LENGTH = 2048;
/** the kinds that may be bound to an exact SPIFFE ID instead of the default identifier */
export const EXTERNAL_IDENTITY_KINDS: ReadonlyArray<WorkloadIdentityKind> = ["worker_runtime", "pdp"];

export interface WorkloadCredentialView {
  id: string;
  identityId: string;
  kind: WorkloadCredentialKind;
  publicJwk: Record<string, string> | null;
  jwkThumbprint: string | null;
  x5tS256: string | null;
  sanUri: string | null;
  subjectDn: string | null;
  spiffeId: string | null;
  selfSigned: boolean;
  notBefore: string;
  notAfter: string;
  revokedAt: string | null;
  createdAt: string;
}
/** `GET /v1/workload-identities/:identityId/credentials` */
export interface WorkloadCredentialListView {
  items: WorkloadCredentialView[];
}

export type IdentityGrantProposalGrant =
  | { kind: "tool"; serverId: string; toolName: string }
  | { kind: "agent"; agentId: string; allowedModes: string[] }
  | { kind: "connector"; connectorId: string; mode: ConnectorGrantMode; allowedObjects: string[] };
export interface IdentityGrantProposal {
  grant: IdentityGrantProposalGrant;
  observedCalls: number;
  refusedCalls: number;
  lastObservedAt: string;
  heldByStewards: boolean;
  /** every observation was a refusal by the agent's own allow-list: never pre-selected, opted into per item */
  refusalOnly: boolean;
}
/** `GET /v1/workload-identities/:identityId/grant-proposals` */
export interface IdentityGrantProposalsView {
  identityId: string;
  windowDays: number;
  since: string;
  revision: number;
  proposals: IdentityGrantProposal[];
  /** the own grant set at `revision`: the base the admin's selection is merged onto */
  currentSet: PutAgentGrants;
  /** the server's default selection (steward-held, allowed at least once) */
  proposedSet: PutAgentGrants;
  unproposable: number;
  truncated: boolean;
}

export interface IdentityPickerOption {
  id: string;
  label: string;
}
/** `GET /v1/identity/picker-sources` */
export interface IdentityPickerSourcesView {
  sponsors: Array<IdentityPickerOption & { email: string }>;
  subjects: { agent: IdentityPickerOption[]; builder_agent: IdentityPickerOption[]; engine_runner: IdentityPickerOption[] };
  environments: string[];
  servers: Array<IdentityPickerOption & { tools: string[] }>;
  agents: IdentityPickerOption[];
  connectors: IdentityPickerOption[];
  roles: IdentityPickerOption[];
  workerIdentities: IdentityPickerOption[];
  truncated: boolean;
  /** which lists were cut (the shared contract's IDENTITY_PICKER_LISTS); absent from an older gateway */
  truncatedLists?: string[];
}

/** what each picker list is called on the form, for "this list was cut" */
export const PICKER_LIST_LABELS: Readonly<Record<string, string>> = {
  sponsors: "stewards",
  "subjects.agent": "agents without an identity",
  "subjects.builder_agent": "builder agents without an identity",
  "subjects.engine_runner": "engine runners without an identity",
  environments: "environments",
  servers: "MCP servers",
  agents: "agents",
  connectors: "connectors",
  roles: "roles",
  workerIdentities: "worker identities",
  tools: "MCP tools",
};

/**
 * The notice for cut picker lists, naming each one; null when nothing was cut. A gateway that names no list (an
 * older one) still gets the general notice when it says something was cut.
 */
export function pickerTruncationNotice(v: Pick<IdentityPickerSourcesView, "truncated" | "truncatedLists">): string | null {
  const names = (v.truncatedLists ?? []).map((l) => PICKER_LIST_LABELS[l] ?? l);
  if (names.length > 0) {
    const tools = names.includes(PICKER_LIST_LABELS.tools!);
    const lists = names.filter((n) => n !== PICKER_LIST_LABELS.tools);
    const parts = [
      ...(lists.length ? [`These lists show only their first 1,000 entries: ${lists.join(", ")}.`] : []),
      ...(tools ? ["Some MCP servers show only part of their tool list."] : []),
    ];
    return parts.join(" ");
  }
  return v.truncated ? "Some lists were cut to their first 1,000 entries." : null;
}

/** the body of `POST /v1/workload-identities` */
export interface CreateWorkloadIdentityBody {
  kind: WorkloadIdentityKind;
  agentId?: string;
  builderAgentId?: string;
  engineRunnerId?: string;
  identifier?: string;
  sponsorUserIds: string[];
  environments: string[];
}

/** the body of `POST /v1/workload-identities/:identityId/credentials` */
export type AddWorkloadCredentialBody =
  | { kind: "jwk"; publicJwk: Record<string, string>; notAfter?: string }
  | { kind: "x509"; certificatePem: string; selfSigned: boolean; notAfter?: string }
  | { kind: "spiffe_id"; spiffeId: string; notAfter?: string };

// ---------------------------------------------------------------------------
// routes this gateway has not built yet
// ---------------------------------------------------------------------------

/**
 * The identity routes the gateway still answers 501 `not_built`. S6 built the
 * last of them, so the list is empty. The model test reads
 * `apps/gateway/src/identity-routes.ts` and fails if a stub reappears without
 * a matching entry here (and a disabled control on the page).
 */
export const IDENTITY_ROUTES_NOT_BUILT: ReadonlyArray<{ method: "GET" | "POST" | "DELETE"; path: string }> = [];

// ---------------------------------------------------------------------------
// display rules
// ---------------------------------------------------------------------------

export const workloadKindLabels: Record<WorkloadIdentityKind, string> = {
  agent: "Agent",
  builder_agent: "Builder agent",
  engine_runner: "Engine runner",
  worker_runtime: "External worker",
  pdp: "Policy client",
};

/** micro-dollars as dollars; anything that is not a safe whole number reads "Unmeasured", never $0 */
export function formatMicros(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) return "Unmeasured";
  const sign = value < 0 ? "−" : "";
  const abs = Math.abs(value);
  const whole = Math.floor(abs / 1_000_000);
  const fraction = String(abs % 1_000_000).padStart(6, "0").replace(/0+$/, "").padEnd(2, "0");
  return `${sign}$${whole}.${fraction}`;
}

/** cap − settled − reserved; null for an uncapped grant or an unreadable amount */
export function remainingMicros(g: Pick<DelegationGrantView, "capMicros" | "settledMicros" | "reservedMicros">): number | null {
  const values = [g.capMicros, g.settledMicros, g.reservedMicros];
  if (values.some((v) => typeof v !== "number" || !Number.isSafeInteger(v))) return null;
  return g.capMicros! - g.settledMicros - g.reservedMicros;
}

/**
 * A grant's state for display. The server judges live/expired on the
 * DATABASE clock; this uses the browser's and says so where it is shown.
 */
export function delegationState(g: Pick<DelegationGrantView, "revokedAt" | "expiresAt">, nowMs: number): "revoked" | "expired" | "live" | "unmeasured" {
  if (g.revokedAt !== null) return "revoked";
  const until = Date.parse(g.expiresAt);
  if (!Number.isFinite(until)) return "unmeasured";
  return until <= nowMs ? "expired" : "live";
}

// ---------------------------------------------------------------------------
// stewards and environments (PATCH)
// ---------------------------------------------------------------------------

export function validateStewardsAndEnvironments(stewardIds: readonly string[], environments: readonly string[]): string | null {
  if (stewardIds.length === 0) return "Choose at least one steward. An identity with no person answerable for it can be granted nothing.";
  if (stewardIds.length > WORKLOAD_IDENTITY_MAX_STEWARDS || new Set(stewardIds).size !== stewardIds.length) {
    return `Choose up to ${WORKLOAD_IDENTITY_MAX_STEWARDS} distinct stewards.`;
  }
  if (stewardIds.some((id) => !UUID_PATTERN.test(id))) return "A steward could not be read. Refresh the page before saving.";
  if (environments.length > WORKLOAD_IDENTITY_MAX_ENVIRONMENTS || new Set(environments).size !== environments.length) {
    return `Choose up to ${WORKLOAD_IDENTITY_MAX_ENVIRONMENTS} distinct environments.`;
  }
  const bad = environments.find((e) => !ENVIRONMENT_NAME_PATTERN.test(e));
  if (bad !== undefined) return environmentNameProblem(bad);
  return null;
}

export function environmentNameProblem(name: string): string | null {
  if (ENVIRONMENT_NAME_PATTERN.test(name)) return null;
  return "An environment name is 1 to 64 lowercase letters, digits, dots, dashes or underscores, starting with a letter or digit.";
}

/** the PATCH body: only what changed, so an unchanged field is never rewritten */
export function stewardsAndEnvironmentsChange(
  identity: Pick<WorkloadIdentityView, "sponsorUserIds" | "environments">,
  stewardIds: readonly string[],
  environments: readonly string[],
): { sponsorUserIds?: string[]; environments?: string[] } | null {
  const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
  const out: { sponsorUserIds?: string[]; environments?: string[] } = {};
  if (!same(identity.sponsorUserIds, stewardIds)) out.sponsorUserIds = [...stewardIds];
  if (!same(identity.environments, environments)) out.environments = [...environments];
  return Object.keys(out).length ? out : null;
}

// ---------------------------------------------------------------------------
// own grants (PUT replaces the whole set at the revision read)
// ---------------------------------------------------------------------------

export type GrantKind = "tool" | "server" | "agent" | "connector" | "role";
export const grantKindLabels: Record<GrantKind, string> = {
  tool: "One tool",
  server: "Server (all its tools)",
  agent: "Agent invocation",
  connector: "Connector",
  role: "Role",
};

/** one row of the own-grants table; `key` identifies it within the set */
export interface GrantRow {
  key: string;
  kind: GrantKind;
  targetId: string;
  toolName: string | null;
  access: string;
}

export function grantRows(set: Omit<PutAgentGrants, "revision">): GrantRow[] {
  return [
    ...set.tools.map((g) => ({ key: `tool:${g.serverId}:${g.toolName}`, kind: "tool" as const, targetId: g.serverId, toolName: g.toolName, access: "This named tool only" })),
    ...set.servers.map((g) => ({ key: `server:${g.serverId}`, kind: "server" as const, targetId: g.serverId, toolName: null, access: g.readOnlyAll ? "Every read-only tool" : "Every tool, including writes" })),
    ...set.agents.map((g) => ({
      key: `agent:${g.agentId}`, kind: "agent" as const, targetId: g.agentId, toolName: null,
      access: g.allowedModes.length ? `Modes: ${g.allowedModes.join(", ")}` : "No mode allowed",
    })),
    ...set.connectors.map((g) => ({
      key: `connector:${g.connectorId}`, kind: "connector" as const, targetId: g.connectorId, toolName: null,
      access: `${g.mode === "read" ? "Read" : "Read and write"}; ${g.allowedObjects.length ? `objects: ${g.allowedObjects.join(", ")}` : "no object allowed"}`,
    })),
    ...set.roleIds.map((id) => ({ key: `role:${id}`, kind: "role" as const, targetId: id, toolName: null, access: "Whatever the role grants" })),
  ];
}

function copySet(set: PutAgentGrants): PutAgentGrants {
  return {
    tools: set.tools.map((g) => ({ ...g })),
    servers: set.servers.map((g) => ({ ...g })),
    agents: set.agents.map((g) => ({ ...g, allowedModes: [...g.allowedModes] })),
    connectors: set.connectors.map((g) => ({ ...g, allowedObjects: [...g.allowedObjects] })),
    roleIds: [...set.roleIds],
    revision: set.revision,
  };
}

/** the set as read, without one row, at the same revision; null when the row is no longer there */
export function grantSetWithout(set: PutAgentGrants, key: string): PutAgentGrants | null {
  if (!grantRows(set).some((r) => r.key === key)) return null;
  const next = copySet(set);
  next.tools = next.tools.filter((g) => `tool:${g.serverId}:${g.toolName}` !== key);
  next.servers = next.servers.filter((g) => `server:${g.serverId}` !== key);
  next.agents = next.agents.filter((g) => `agent:${g.agentId}` !== key);
  next.connectors = next.connectors.filter((g) => `connector:${g.connectorId}` !== key);
  next.roleIds = next.roleIds.filter((id) => `role:${id}` !== key);
  return next;
}

export type GrantAddition =
  | { kind: "tool"; serverId: string; toolName: string }
  | { kind: "server"; serverId: string; readOnlyAll: boolean }
  | { kind: "agent"; agentId: string; allowedModes: string[] }
  | { kind: "connector"; connectorId: string; mode: ConnectorGrantMode; allowedObjects: string[] }
  | { kind: "role"; roleId: string };

/** comma-separated names, trimmed, empties dropped */
export function nameList(text: string): string[] {
  return text.split(",").map((s) => s.trim()).filter(Boolean);
}

const distinct = (a: readonly string[]) => new Set(a).size === a.length;

/** the set as read plus one grant, at the same revision; a sentence when the addition is refused here */
export function grantSetWith(set: PutAgentGrants, add: GrantAddition): PutAgentGrants | string {
  const L = GRANT_SET_LIMITS;
  const target = add.kind === "tool" || add.kind === "server" ? add.serverId : add.kind === "agent" ? add.agentId : add.kind === "connector" ? add.connectorId : add.roleId;
  if (!UUID_PATTERN.test(target)) return "Choose a target from the list.";
  const next = copySet(set);
  switch (add.kind) {
    case "tool": {
      const name = add.toolName.trim();
      if (!name || name.length > L.toolNameLength) return "Choose one tool of the server.";
      if (next.tools.some((g) => g.serverId === add.serverId && g.toolName === name)) return "That tool is already granted.";
      if (next.tools.length >= L.tools) return `An identity holds at most ${L.tools} tool grants.`;
      next.tools.push({ serverId: add.serverId, toolName: name });
      break;
    }
    case "server":
      if (next.servers.some((g) => g.serverId === add.serverId)) return "That server is already granted. Remove its grant first to change it.";
      if (next.servers.length >= L.servers) return `An identity holds at most ${L.servers} server grants.`;
      next.servers.push({ serverId: add.serverId, readOnlyAll: add.readOnlyAll });
      break;
    case "agent":
      if (add.allowedModes.length > L.modes || add.allowedModes.some((m) => m.length > L.modeNameLength) || !distinct(add.allowedModes)) {
        return `Name at most ${L.modes} distinct modes of up to ${L.modeNameLength} characters.`;
      }
      if (next.agents.some((g) => g.agentId === add.agentId)) return "That agent is already granted. Remove its grant first to change it.";
      if (next.agents.length >= L.agents) return `An identity holds at most ${L.agents} agent grants.`;
      next.agents.push({ agentId: add.agentId, allowedModes: [...add.allowedModes] });
      break;
    case "connector":
      if (add.allowedObjects.length > L.objects || add.allowedObjects.some((o) => o.length > L.objectNameLength) || !distinct(add.allowedObjects)) {
        return `Name at most ${L.objects} distinct objects of up to ${L.objectNameLength} characters.`;
      }
      if (next.connectors.some((g) => g.connectorId === add.connectorId)) return "That connector is already granted. Remove its grant first to change it.";
      if (next.connectors.length >= L.connectors) return `An identity holds at most ${L.connectors} connector grants.`;
      next.connectors.push({ connectorId: add.connectorId, mode: add.mode, allowedObjects: [...add.allowedObjects] });
      break;
    case "role":
      if (next.roleIds.includes(add.roleId)) return "That role is already assigned.";
      if (next.roleIds.length >= L.roleIds) return `An identity holds at most ${L.roleIds} roles.`;
      next.roleIds.push(add.roleId);
      break;
  }
  return next;
}

// ---------------------------------------------------------------------------
// a run's delegation tree
// ---------------------------------------------------------------------------

export const DELEGATION_TREE_MAX_NODES = 1000;
const DELEGATION_TREE_MAX_DEPTH = 64;

export interface DelegationTreeRow {
  grant: DelegationGrantView;
  level: number;
  /** the parent→child edge into this grant; null for a root */
  allocation: DelegationAllocationView | null;
}

/**
 * Depth-first order, roots first. A child whose parent is not in the list, a
 * cycle or a duplicate id means the tree is incomplete: nothing is drawn, so
 * no actor or budget is shown out of context.
 */
export function orderedDelegationTree(view: Pick<DelegationGrantListView, "items" | "edges">): { rows: DelegationTreeRow[]; problem: string | null } {
  const { items, edges } = view;
  if (items.length > DELEGATION_TREE_MAX_NODES) return { rows: [], problem: "The delegation tree is too large to display here." };
  const byId = new Map(items.map((g) => [g.id, g]));
  if (byId.size !== items.length || items.some((g) => g.parentGrantId !== null && !byId.has(g.parentGrantId))) {
    return { rows: [], problem: "The delegation tree is incomplete. Refresh before acting on it." };
  }
  const edgeInto = new Map(edges.map((e) => [e.childGrantId, e]));
  const children = new Map<string, DelegationGrantView[]>();
  for (const g of items) if (g.parentGrantId !== null) children.set(g.parentGrantId, [...(children.get(g.parentGrantId) ?? []), g]);
  const rows: DelegationTreeRow[] = [];
  const seen = new Set<string>();
  const visit = (g: DelegationGrantView, level: number) => {
    if (seen.has(g.id) || level > DELEGATION_TREE_MAX_DEPTH) return;
    seen.add(g.id);
    rows.push({ grant: g, level, allocation: edgeInto.get(g.id) ?? null });
    for (const c of children.get(g.id) ?? []) visit(c, level + 1);
  };
  for (const root of items.filter((g) => g.parentGrantId === null)) visit(root, 0);
  if (seen.size !== items.length) return { rows: [], problem: "The delegation tree has a cycle or is deeper than can be displayed. Refresh before acting on it." };
  return { rows, problem: null };
}

// ---------------------------------------------------------------------------
// create an identity
// ---------------------------------------------------------------------------

export const SUBJECT_COLUMN: Record<WorkloadIdentityKind, "agentId" | "builderAgentId" | "engineRunnerId" | null> = {
  agent: "agentId",
  builder_agent: "builderAgentId",
  engine_runner: "engineRunnerId",
  worker_runtime: null,
  pdp: null,
};

export function isSpiffeId(value: string): boolean {
  if (value.length > SPIFFE_ID_MAX_LENGTH || !SPIFFE_ID_PATTERN.test(value)) return false;
  return value.slice("spiffe://".length).split("/").slice(1).every((seg) => seg !== "." && seg !== "..");
}

export interface CreateIdentityDraft {
  kind: WorkloadIdentityKind;
  subjectId: string;
  identifier: string;
  stewardIds: string[];
  environments: string[];
}

/** the create body, or a sentence; the gateway refuses the same things on its own */
export function createIdentityBody(d: CreateIdentityDraft): { body: CreateWorkloadIdentityBody } | { error: string } {
  const column = SUBJECT_COLUMN[d.kind];
  if (column && !UUID_PATTERN.test(d.subjectId)) return { error: "Choose what this identity is for from the list." };
  const problem = validateStewardsAndEnvironments(d.stewardIds, d.environments);
  if (problem) return { error: problem };
  const identifier = d.identifier.trim();
  if (identifier) {
    if (!EXTERNAL_IDENTITY_KINDS.includes(d.kind)) return { error: "Only an external worker or a policy client can be bound to its own SPIFFE ID." };
    if (!isSpiffeId(identifier)) return { error: "Enter an exact SPIFFE ID, such as spiffe://example.org/worker/one." };
  }
  const body: CreateWorkloadIdentityBody = { kind: d.kind, sponsorUserIds: [...d.stewardIds], environments: [...d.environments] };
  if (column) body[column] = d.subjectId;
  if (identifier) body.identifier = identifier;
  return { body };
}

// ---------------------------------------------------------------------------
// public credentials
// ---------------------------------------------------------------------------

export const credentialKindLabels: Record<WorkloadCredentialKind, string> = {
  jwk: "Public key (JWK)",
  x509: "Client certificate",
  spiffe_id: "SPIFFE ID",
};

export interface CredentialDraft {
  kind: WorkloadCredentialKind;
  jwkText: string;
  certificatePem: string;
  selfSigned: boolean;
  spiffeId: string;
  /** a calendar date (yyyy-mm-dd), or empty for the longest the gateway allows */
  notAfterDate: string;
}

const PRIVATE_PEM = /PRIVATE KEY-----/;
const DAY_MS = 86_400_000;

/**
 * The credential body, or a sentence. A private key is refused HERE, before
 * anything is sent: only a public half ever leaves the browser.
 */
export function credentialBody(d: CredentialDraft, nowMs: number): { body: AddWorkloadCredentialBody } | { error: string } {
  let notAfter: string | undefined;
  if (d.notAfterDate) {
    const at = /^\d{4}-\d{2}-\d{2}$/.test(d.notAfterDate) ? Date.parse(`${d.notAfterDate}T00:00:00Z`) : Number.NaN;
    if (!Number.isFinite(at) || at <= nowMs) return { error: "The end date must be in the future." };
    if (at > nowMs + WORKLOAD_CREDENTIAL_MAX_DAYS * DAY_MS) return { error: `A credential lives at most ${WORKLOAD_CREDENTIAL_MAX_DAYS} days.` };
    notAfter = new Date(at).toISOString();
  }
  const tail = notAfter ? { notAfter } : {};
  if (d.kind === "jwk") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(d.jwkText);
    } catch {
      return { error: "Paste the public key as a JSON Web Key." };
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { error: "Paste the public key as a JSON Web Key." };
    const jwk = parsed as Record<string, unknown>;
    if (PRIVATE_JWK_MEMBERS.some((m) => Object.hasOwn(jwk, m))) return { error: "That is a private key. Paste only the public key; nothing was sent." };
    const okp = jwk.kty === "OKP" && jwk.crv === "Ed25519" && typeof jwk.x === "string";
    const ec = jwk.kty === "EC" && jwk.crv === "P-256" && typeof jwk.x === "string" && typeof jwk.y === "string";
    if (!okp && !ec) return { error: "Only an Ed25519 (OKP) or P-256 (EC) public key is accepted." };
    const publicJwk: Record<string, string> = okp
      ? { kty: "OKP", crv: "Ed25519", x: jwk.x as string }
      : { kty: "EC", crv: "P-256", x: jwk.x as string, y: jwk.y as string };
    return { body: { kind: "jwk", publicJwk, ...tail } };
  }
  if (d.kind === "x509") {
    const pem = d.certificatePem.trim();
    if (PRIVATE_PEM.test(pem)) return { error: "That text contains a private key. Paste only the certificate; nothing was sent." };
    if (!pem.includes("-----BEGIN CERTIFICATE-----") || pem.length > 16_384) return { error: "Paste one certificate in PEM form." };
    return { body: { kind: "x509", certificatePem: pem, selfSigned: d.selfSigned, ...tail } };
  }
  const spiffeId = d.spiffeId.trim();
  if (!isSpiffeId(spiffeId)) return { error: "Enter an exact SPIFFE ID, such as spiffe://example.org/worker/one." };
  return { body: { kind: "spiffe_id", spiffeId, ...tail } };
}

/** what a credential row shows as its public fact */
export function credentialFact(c: WorkloadCredentialView): string {
  if (c.kind === "jwk") return c.jwkThumbprint ? `Thumbprint ${c.jwkThumbprint}` : "Unmeasured";
  if (c.kind === "x509") return c.x5tS256 ? `${c.selfSigned ? "Self-signed; " : ""}SHA-256 ${c.x5tS256}` : "Unmeasured";
  return c.spiffeId ?? "Unmeasured";
}

/** revoked wins; otherwise by this browser's clock inside [notBefore, notAfter) */
export function credentialState(
  c: Pick<WorkloadCredentialView, "revokedAt" | "notBefore" | "notAfter">,
  nowMs: number,
): "revoked" | "expired" | "pending" | "live" | "unmeasured" {
  if (c.revokedAt !== null) return "revoked";
  const from = Date.parse(c.notBefore);
  const to = Date.parse(c.notAfter);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return "unmeasured";
  if (to <= nowMs) return "expired";
  return from > nowMs ? "pending" : "live";
}

// ---------------------------------------------------------------------------
// grant proposals
// ---------------------------------------------------------------------------

export function proposalLabel(g: IdentityGrantProposalGrant): string {
  if (g.kind === "tool") return `Tool ${g.toolName}`;
  if (g.kind === "agent") return `Agent invocation; modes: ${g.allowedModes.join(", ")}`;
  return `Connector ${g.mode === "read" ? "read" : "read and write"}; objects: ${g.allowedObjects.join(", ")}`;
}

/** a proposal's key within one view */
export const proposalKey = (p: IdentityGrantProposal) => JSON.stringify(p.grant);

/**
 * The proposals selected by default: a steward holds it AND it was allowed at least once. A refusal-only proposal
 * (it never ran) is never pre-selected; the admin opts into it item by item. One no steward holds is never
 * selectable (the replace would refuse it).
 */
export function defaultProposalSelection(proposals: readonly IdentityGrantProposal[]): Set<string> {
  return new Set(proposals.filter((p) => p.heldByStewards && !p.refusalOnly).map(proposalKey));
}

/** `set` plus the selected, steward-held proposals, merged per target; `set` is not changed (mirrors the gateway) */
export function setWithProposals(set: PutAgentGrants, proposals: readonly IdentityGrantProposal[], selected: ReadonlySet<string>): PutAgentGrants {
  const out = copySet(set);
  for (const p of proposals) {
    if (!p.heldByStewards || !selected.has(proposalKey(p))) continue;
    const g = p.grant;
    if (g.kind === "tool") {
      if (!out.tools.some((x) => x.serverId === g.serverId && x.toolName === g.toolName)) out.tools.push({ serverId: g.serverId, toolName: g.toolName });
    } else if (g.kind === "agent") {
      const existing = out.agents.find((x) => x.agentId === g.agentId);
      if (existing) existing.allowedModes = [...new Set([...existing.allowedModes, ...g.allowedModes])].slice(0, GRANT_SET_LIMITS.modes);
      else out.agents.push({ agentId: g.agentId, allowedModes: [...g.allowedModes] });
    } else {
      const existing = out.connectors.find((x) => x.connectorId === g.connectorId);
      if (existing) {
        existing.mode = existing.mode === "readwrite" || g.mode === "readwrite" ? "readwrite" : "read";
        existing.allowedObjects = [...new Set([...existing.allowedObjects, ...g.allowedObjects])].slice(0, GRANT_SET_LIMITS.objects);
      } else {
        out.connectors.push({ connectorId: g.connectorId, mode: g.mode, allowedObjects: [...g.allowedObjects] });
      }
    }
  }
  return out;
}

export function proposalTargetId(g: IdentityGrantProposalGrant): string {
  return g.kind === "tool" ? g.serverId : g.kind === "agent" ? g.agentId : g.connectorId;
}

// ---------------------------------------------------------------------------
// refusals, in words
// ---------------------------------------------------------------------------

/** delegation refusals the S5 review ruled the UI must explain (ADR-0188 S6 row) */
export const delegationRefusalMessages = {
  delegation_depth_unenforced:
    "External child delegation is unavailable until the parent's signed depth limit is enforced. Retry only after the deployment enables that enforcement.",
  invalid_target:
    "A child's resource must exactly equal its parent's audience. A different audience cannot narrow this delegation.",
} as const;

/** the refusal codes of the routes this page calls, in words (pinned to the gateway source by the model test) */
export const REFUSAL_SENTENCES: Readonly<Record<string, string>> = {
  [GRANTS_REVISION_CONFLICT]: "The grant set changed since this page loaded it, so nothing was replaced. It has been reloaded: make the change again.",
  identity_not_active: "This identity is not active, so it cannot be changed this way. Refresh to see its current status.",
  identity_not_found: "This identity no longer exists. Refresh the list.",
  grant_target_not_found: "A grant's target no longer exists. Refresh and choose again.",
  grant_exceeds_stewards: "No steward of this identity holds that permission, and an identity's grants never exceed its stewards'. Grant it to a steward first, or choose a steward who holds it.",
  steward_not_found: "Every steward must be an existing, enabled user. Refresh the people list and choose again.",
  grant_not_found: "That delegation grant no longer exists. Refresh the tree.",
  // S6: create, revoke and credentials
  identity_exists: "That subject already has its identity. One identity per subject, ever: a revoked one is not replaced.",
  identifier_taken: "Another identity already uses that identifier. Choose a different SPIFFE ID.",
  identifier_reserved: "That SPIFFE ID is in the namespace the gateway assigns. Use the default identifier, or an ID your own SPIRE issues.",
  identifier_not_allowed: "Only an external worker or a policy client can be bound to its own SPIFFE ID.",
  subject_not_found: "What this identity was for no longer exists. Refresh and choose again.",
  subject_not_in_service: "What this identity was for is retired, archived or revoked, so it cannot get an identity.",
  identity_already_revoked: "This identity is already revoked. Revocation is terminal.",
  credential_invalid: "The gateway could not read that as a valid public key or certificate. Nothing was stored.",
  credential_private_material: "That contained a private key, so nothing was stored. Paste only the public half.",
  certificate_time: "That certificate is not valid right now. Nothing was stored.",
  certificate_not_self_signed: "That certificate is not signed by its own key. Clear “Self-signed” if a CA issued it.",
  certificate_leaf_ca: "That is a CA certificate. Register the workload's own client certificate.",
  credential_not_after: "That end date is past what is allowed: at most the longest workload key lifetime, and never after the certificate expires.",
  credential_already_registered: "That key, certificate or SPIFFE ID is already registered, and a key is never registered twice. Generate a new key.",
  spiffe_trust_domain_unknown: "No trust bundle is configured for that SPIFFE trust domain, so the ID could never sign in. Nothing was stored.",
  trust_config_invalid: "The gateway's SPIFFE trust configuration could not be read. Nothing was stored; ask the operator to check it.",
  credential_not_found: "That credential no longer exists on this identity. Refresh the list.",
  credential_already_revoked: "That credential is already revoked. A revoked credential is never revived.",
};

/** the page's sentence for a refusal code, or null to use the client's own reading */
export function identityRefusalSentence(code: unknown): string | null {
  return typeof code === "string" && Object.hasOwn(REFUSAL_SENTENCES, code) ? REFUSAL_SENTENCES[code]! : null;
}
