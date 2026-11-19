/**
 * The two Discovery sources sub-pages' shapes and pure helpers, following the gateway routes exactly:
 *  - D1, SaaS app links (ADR-0337 §6): GET /v1/discovery/entitlements/apps, PUT/DELETE …/apps/:appId/agent-link,
 *    GET/POST /v1/discovery/agent-identifiers, DELETE …/agent-identifiers/:identifierId
 *    (apps/gateway/src/saas-entitlement-routes.ts);
 *  - D2, MCP server removals (ADR-0331): POST/GET /v1/discovery/endpoint-addon-removals, GET …/:id, POST …/:id/cancel
 *    (apps/gateway/src/endpoint-addon-removal.ts).
 * Nothing here is invented: a field the gateway does not return is not shown.
 */
import type { EndpointMcpLinkKind } from "./endpointMcpModel";

// ---- D1: SaaS app links ----------------------------------------------------

/** the platforms an identifier is declared on (SAAS_ENTITLEMENT_PLATFORMS in @regulait/shared, same order) */
export const SAAS_PLATFORMS = ["m365", "google_workspace", "salesforce", "slack"] as const;
export type SaasPlatform = (typeof SAAS_PLATFORMS)[number];
export const SAAS_PLATFORM_LABEL: Readonly<Record<SaasPlatform, string>> = {
  m365: "Microsoft 365",
  google_workspace: "Google Workspace",
  salesforce: "Salesforce",
  slack: "Slack",
};
/** the discovery source kind that reads each platform (SAAS_ENTITLEMENT_SOURCE_PLATFORM in @regulait/shared) */
const SOURCE_PLATFORM: Readonly<Record<string, SaasPlatform>> = {
  entitlement_m365: "m365",
  entitlement_google_workspace: "google_workspace",
  entitlement_salesforce: "salesforce",
  entitlement_slack: "slack",
};
/** the platform an entitlement source kind reads, or null when the kind is not an entitlement reader */
export const entitlementPlatformOf = (kind: string): SaasPlatform | null => (Object.hasOwn(SOURCE_PLATFORM, kind) ? SOURCE_PLATFORM[kind]! : null);

export type AgentLinkState = "none" | "auto" | "admin" | "unlinked";
export type AgentLinkEvent = "auto_link" | "link" | "unlink";
export const LINK_STATE_LABEL: Readonly<Record<AgentLinkState, string>> = {
  none: "No agent yet",
  auto: "Linked automatically",
  admin: "Linked by an admin",
  unlinked: "Unlinked by an admin",
};
export const LINK_STATE_TONE = { none: "warn", auto: "ok", admin: "info", unlinked: "neutral" } as const;

/** the declared machine's view of one state (`describe()`): every event, whether it is allowed now, and why not */
export interface LifecycleView<E extends string = string> {
  machine: string;
  state: string;
  terminal: boolean;
  transitions: Array<{ event: E; to: string; by: string[]; summary: string; allowed: boolean; reason?: string }>;
}

export interface EntitlementAppView {
  id: string;
  sourceId: string;
  externalId: string;
  appKind: string;
  displayName: string | null;
  publisher: string | null;
  publisherVerified: boolean | null;
  agentId: string | null;
  agentLinkState: AgentLinkState;
  firstSeenAt: string;
  lastSeenAt: string;
  /** how many scopes the app holds, each one way (`saas_entitlement_grants` rows) */
  grants: number;
  lifecycle: LifecycleView<AgentLinkEvent>;
}
export interface EntitlementAppsPage {
  items: EntitlementAppView[];
  nextAfter: string | null;
}

export interface AgentIdentifierView {
  id: string;
  agentId: string;
  platform: SaasPlatform;
  externalId: string;
  createdByUserId: string | null;
  createdAt: string;
}
export interface AgentIdentifiersPage {
  items: AgentIdentifierView[];
  nextAfter: string | null;
}
export interface DeclaredIdentifier {
  identifier: AgentIdentifierView;
  autoLinked: string[];
  autoLinkedSources: string[];
}

/** the largest page the routes take (MAX_PAGE in saas-entitlement-routes.ts) */
export const SAAS_PAGE_LIMIT = 200;
export const appsUrl = (sourceId: string, after: string | null): string => {
  const q = new URLSearchParams({ sourceId, limit: String(SAAS_PAGE_LIMIT) });
  if (after) q.set("after", after);
  return `/v1/discovery/entitlements/apps?${q.toString()}`;
};
export const identifiersUrl = (after: string | null): string => {
  const q = new URLSearchParams({ limit: String(SAAS_PAGE_LIMIT) });
  if (after) q.set("after", after);
  return `/v1/discovery/agent-identifiers?${q.toString()}`;
};

/** is `event` allowed next from this app's state? (the gateway's machine says, never a guess) */
export const canDo = (app: Pick<EntitlementAppView, "lifecycle">, event: AgentLinkEvent): boolean =>
  app.lifecycle.transitions.some((t) => t.event === event && t.allowed);

/** an app's name, falling back to its vendor id */
export const appName = (a: Pick<EntitlementAppView, "displayName" | "externalId">): string => a.displayName?.trim() || a.externalId;

/** the declared identifier pattern (AGENT_VENDOR_IDENTIFIER_PATTERN): 1 to 255 printable characters, no spaces */
export const IDENTIFIER_PATTERN = /^[\x21-\x7e]{1,255}$/;

export interface LinkCounts {
  total: number;
  auto: number;
  admin: number;
  none: number;
  unlinked: number;
}
export function linkCounts(apps: readonly Pick<EntitlementAppView, "agentLinkState">[]): LinkCounts {
  const c: LinkCounts = { total: apps.length, auto: 0, admin: 0, none: 0, unlinked: 0 };
  for (const a of apps) c[a.agentLinkState] += 1;
  return c;
}

// ---- D2: MCP server removals -------------------------------------------------

export type RemovalStatus = "awaiting_approval" | "active" | "denied" | "stale" | "cancelled";
/** the shown state: the stored one, or `expired` when an open removal is past its window */
export type RemovalState = RemovalStatus | "expired";
export type TargetStatus = "pending" | "delivered" | "removed" | "nothing_to_remove" | "failed" | "cancelled";
export const TARGET_STATUSES: readonly TargetStatus[] = ["removed", "nothing_to_remove", "failed", "delivered", "pending", "cancelled"];
export type TargetCounts = Record<TargetStatus, number> & { total: number };

export const REMOVAL_STATE_LABEL: Readonly<Record<RemovalState, string>> = {
  awaiting_approval: "Awaiting approval",
  active: "Running",
  denied: "Denied",
  stale: "Stale: endpoints changed",
  cancelled: "Cancelled",
  expired: "Expired",
};
export const REMOVAL_STATE_TONE = { awaiting_approval: "warn", active: "info", denied: "danger", stale: "neutral", cancelled: "neutral", expired: "neutral" } as const;
export const TARGET_LABEL: Readonly<Record<TargetStatus, string>> = {
  pending: "pending",
  delivered: "delivered, awaiting outcome",
  removed: "removed",
  nothing_to_remove: "nothing to remove",
  failed: "failed",
  cancelled: "stopped",
};
export const TARGET_TONE = { pending: "neutral", delivered: "info", removed: "ok", nothing_to_remove: "neutral", failed: "danger", cancelled: "neutral" } as const;

export interface RemovalView {
  id: string;
  createdBy: string;
  createdAt: string;
  action: string;
  identityKind: EndpointMcpLinkKind;
  identity: string;
  packageVersion: string | null;
  serverName: string | null;
  scope: { kind: "device" | "devices" | "recent"; days?: number | null };
  blockReinstall: boolean;
  /** recorded and audited; nothing on the device enforces it yet (ADR-0331 §6) */
  blockEnforced: boolean;
  reason: string;
  expiresAt: string;
  cancelledAt: string | null;
  cancelledBy: string | null;
  approvalId: string;
  status: RemovalStatus;
  state: RemovalState;
  lifecycle: LifecycleView;
  targets: TargetCounts;
}
export interface RemovalsPage {
  items: RemovalView[];
  nextCursor: string | null;
  nextOffset: number | null;
  total: number | null;
  /** the org switch (`discovery_settings.endpoint_addon_removal_enabled`) the gateway checks */
  enabled: boolean;
  /** whether any directive could be signed yet (ADR-0195 SD4 key ceremony) */
  signerConfigured: boolean;
}
export interface RemovalTargetView {
  id: string;
  deviceId: string;
  devicePseudonym: string;
  identityId: string;
  deviceUserPseudonym: string;
  provider: string;
  config: { root: string; path: string };
  serverName: string;
  status: TargetStatus;
  code: string | null;
  notified: boolean | null;
  deliveredAt: string | null;
  reportedAt: string | null;
}
export interface RemovalDetail {
  removal: RemovalView;
  targets: { items: RemovalTargetView[]; nextCursor: string | null; nextOffset: number | null };
}
export interface CreatedRemoval {
  removal: RemovalView;
  /** the config entries it resolved to, which the approver is asked to approve */
  resolved: number;
  devices: number;
}

export const REMOVALS_PAGE_SIZE = 25;
export const TARGETS_PAGE_SIZE = 50;
export const removalsUrl = (cursor: string | null): string => {
  const q = new URLSearchParams({ limit: String(REMOVALS_PAGE_SIZE) });
  // the first page carries the exact total for the heading; later pages follow the keyset cursor
  if (cursor) q.set("cursor", cursor);
  else q.set("count", "exact");
  return `/v1/discovery/endpoint-addon-removals?${q.toString()}`;
};
export const removalUrl = (id: string, offset: number): string => {
  const q = new URLSearchParams({ limit: String(TARGETS_PAGE_SIZE) });
  if (offset > 0) q.set("offset", String(offset));
  return `/v1/discovery/endpoint-addon-removals/${encodeURIComponent(id)}?${q.toString()}`;
};

/** may this removal still be cancelled? (the declared machine's `cancel`, as the gateway described it) */
export const cancellable = (r: Pick<RemovalView, "lifecycle" | "state">): boolean =>
  r.state !== "expired" && r.lifecycle.transitions.some((t) => t.event === "cancel" && t.allowed);

/** the counts worth showing, in a fixed order, zeros left out */
export const shownCounts = (c: TargetCounts): Array<[TargetStatus, number]> => TARGET_STATUSES.filter((s) => c[s] > 0).map((s) => [s, c[s]]);

/** the server a removal names, as one line */
export const removalSubject = (r: Pick<RemovalView, "identity" | "packageVersion" | "serverName">): string =>
  `${r.serverName ?? r.identity}${r.serverName ? ` · ${r.identity}` : ""}${r.packageVersion ? `@${r.packageVersion}` : ""}`;

export const REMOVAL_MAX_DAYS = 90;
export const REMOVAL_REASON_MAX = 500;
/** the server entry names a removal can address (SERVER_NAME_SHAPE in endpoint-addon-removal.ts) */
export const SERVER_NAME_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface RemovalDraft {
  identityKind: EndpointMcpLinkKind;
  identity: string;
  packageVersion: string | null;
  serverName: string | null;
  scope: { kind: "device"; deviceId: string } | { kind: "recent"; days: number };
  blockReinstall: boolean;
  approverUserId: string;
  reason: string;
}
/** the request body, exactly as `createRemovalSchema` takes it (optional members left out, never null) */
export function removalBody(d: RemovalDraft): Record<string, unknown> {
  return {
    identityKind: d.identityKind,
    identity: d.identity,
    ...(d.packageVersion ? { packageVersion: d.packageVersion } : {}),
    ...(d.serverName && SERVER_NAME_SHAPE.test(d.serverName) ? { serverName: d.serverName } : {}),
    scope: d.scope,
    blockReinstall: d.blockReinstall,
    approverUserId: d.approverUserId,
    reason: d.reason.trim(),
  };
}

/** the outcome codes a device reports (ENDPOINT_DIRECTIVE_OUTCOME_CODES), in words */
export const OUTCOME_CODE_TEXT: Readonly<Record<string, string>> = {
  removed: "removed from the config",
  not_present: "the entry was not in the config",
  identity_differs: "the entry now runs something else, so it was left",
  not_in_manifest: "the config file is not one the agent may edit",
  path_refused: "the config path was refused",
  unsupported_format: "the config format is not supported",
  parse_failed: "the config could not be read",
  write_failed: "the config could not be written",
  expired: "the directive had expired",
  wrong_identity: "the directive was for another device user",
};
