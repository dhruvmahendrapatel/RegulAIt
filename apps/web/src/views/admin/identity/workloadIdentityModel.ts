/**
 * ADR-0188 S6 — the workload identities admin page, as the console reads it.
 *
 * MIRRORS `packages/shared/src/identity/contract.ts` (the SPA does not import
 * the shared package). The wire shapes below are the frozen S4/S5 read views;
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
// what this gateway has not built yet
// ---------------------------------------------------------------------------

/**
 * The identity routes the gateway still answers 501 `not_built` (ADR-0188 S1
 * stubs awaiting the S6 backend). The page disables the controls behind them
 * with these reasons rather than sending a request it knows will be refused.
 * The model test reads `apps/gateway/src/identity-routes.ts` and fails when
 * this list and the gateway disagree, so a route that goes live forces the
 * control to be switched on here.
 */
export const IDENTITY_ROUTES_NOT_BUILT: ReadonlyArray<{ method: "GET" | "POST" | "DELETE"; path: string }> = [
  { method: "POST", path: "/v1/workload-identities" },
  { method: "POST", path: "/v1/workload-identities/:identityId/revoke" },
  { method: "GET", path: "/v1/workload-identities/:identityId/credentials" },
  { method: "POST", path: "/v1/workload-identities/:identityId/credentials" },
  { method: "DELETE", path: "/v1/workload-identities/:identityId/credentials/:credentialId" },
  { method: "GET", path: "/v1/workload-identities/:identityId/grant-proposals" },
  { method: "GET", path: "/v1/identity/picker-sources" },
];

export const NOT_BUILT_REASON = {
  create:
    "Creating a workload identity is not built on this gateway yet (ADR-0188 S6 backend). An agent's identity is created with the agent; nothing was sent.",
  revoke:
    "Revoking an identity is not built on this gateway yet (ADR-0188 S6 backend). Suspending it refuses every grant naming it at the next use, and can be undone.",
  credentials:
    "Public credentials cannot be listed, added or revoked on this gateway yet (ADR-0188 S6 backend). The count above is the server's own; no key is shown or accepted here.",
} as const;

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
// refusals, in words
// ---------------------------------------------------------------------------

/** delegation refusals the S5 review ruled the UI must explain (ADR-0188 S6 row) */
export const delegationRefusalMessages = {
  delegation_depth_unenforced:
    "External child delegation is unavailable until the parent's signed depth limit is enforced. Retry only after the deployment enables that enforcement.",
  invalid_target:
    "A child's resource must exactly equal its parent's audience. A different audience cannot narrow this delegation.",
} as const;

const REFUSAL_SENTENCES: Readonly<Record<string, string>> = {
  [GRANTS_REVISION_CONFLICT]: "The grant set changed since this page loaded it, so nothing was replaced. It has been reloaded: make the change again.",
  identity_not_active: "This identity is not active, so it cannot be changed this way. Refresh to see its current status.",
  identity_not_found: "This identity no longer exists. Refresh the list.",
  grant_target_not_found: "A grant's target no longer exists. Refresh and choose again.",
  grant_exceeds_stewards: "No steward of this identity holds that permission, and an identity's grants never exceed its stewards'. Grant it to a steward first, or choose a steward who holds it.",
  steward_not_found: "Every steward must be an existing, enabled user. Refresh the people list and choose again.",
  grant_not_found: "That delegation grant no longer exists. Refresh the tree.",
};

/** the page's sentence for a refusal code, or null to use the client's own reading */
export function identityRefusalSentence(code: unknown): string | null {
  return typeof code === "string" && Object.hasOwn(REFUSAL_SENTENCES, code) ? REFUSAL_SENTENCES[code]! : null;
}
