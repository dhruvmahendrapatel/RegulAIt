/**
 * Governed MCP bundles (#453): the wire shapes of the bundle routes (apps/gateway/src/mcp-bundles.ts) and the pure
 * helpers the screen uses. Kept here, next to the screen, not in api/types.ts.
 */

export interface BundleItem {
  serverId: string;
  toolName: string;
}

export interface Bundle {
  id: string;
  name: string;
  description: string | null;
  approverUserId: string | null;
  currentVersion: number;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  grantCount?: number;
}

export interface BundleList {
  enabled: boolean;
  bundles: Bundle[];
}

export interface BundleVersionRow {
  version: number;
  createdBy: string | null;
  createdAt: string;
}

export interface BundleDetail extends Bundle {
  items: Array<BundleItem & { serverName: string | null }>;
  versions: BundleVersionRow[];
}

export interface BundleVersion extends BundleVersionRow {
  bundleId: string;
  items: Array<BundleItem & { serverName: string | null }>;
}

export interface BundleGrant {
  id: string;
  userId: string | null;
  userEmail: string | null;
  roleId: string | null;
  roleName: string | null;
  teamId: string | null;
  teamName: string | null;
  maxTier: Tier;
  grantedBy: string | null;
  createdAt: string;
}

/** a row of GET /v1/servers/:serverId/tools, with the scope-tier flag that read returns */
export interface InventoryTool {
  id: string;
  serverId: string;
  name: string;
  kind: "read" | "write";
  dangerous?: boolean;
}

/** the gateway's cap on one version's tools */
export const MAX_ITEMS = 200;

export type Tier = "read" | "write" | "dangerous";
/** read first: it is the default and the one the grant form preselects */
export const TIERS: ReadonlyArray<{ v: Tier; l: string }> = [
  { v: "read", l: "Read tools only" },
  { v: "write", l: "Read and write tools" },
  { v: "dangerous", l: "All tools, dangerous ones with approval" },
];
export const tierLabel = (t: string) => TIERS.find((x) => x.v === t)?.l ?? t;

export type SubjectKind = "user" | "role" | "team";

export const itemKey = (i: BundleItem) => `${i.serverId}:${i.toolName}`;

/** add the item, or take it out if it is already there */
export function toggleItem(items: readonly BundleItem[], item: BundleItem): BundleItem[] {
  const k = itemKey(item);
  return items.some((i) => itemKey(i) === k) ? items.filter((i) => itemKey(i) !== k) : [...items, item];
}

/** what a save would change, as the gateway diffs it */
export function diffItems(before: readonly BundleItem[], after: readonly BundleItem[]) {
  const b = new Set(before.map(itemKey));
  const a = new Set(after.map(itemKey));
  return { added: after.filter((i) => !b.has(itemKey(i))).length, removed: before.filter((i) => !a.has(itemKey(i))).length };
}

/** who holds a grant, in words */
export function holderOf(g: BundleGrant): { kind: SubjectKind; label: string } {
  if (g.userId) return { kind: "user", label: g.userEmail ?? g.userId };
  if (g.roleId) return { kind: "role", label: g.roleName ?? g.roleId };
  return { kind: "team", label: g.teamName ?? g.teamId ?? "" };
}

/** the POST body: exactly one subject, and the tier */
export const grantBody = (kind: SubjectKind, id: string, maxTier: Tier) => ({ [`${kind}Id`]: id, maxTier });

/** the gateway's `error` code on a refused call, or null */
export function refusalCode(e: unknown): string | null {
  const p = (e as { payload?: { error?: unknown } } | null)?.payload;
  return typeof p?.error === "string" ? p.error : null;
}
