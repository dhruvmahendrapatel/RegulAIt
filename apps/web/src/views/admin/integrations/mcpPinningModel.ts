/**
 * The shapes of the MCP definition-pin and high-risk routes (apps/gateway/src/mcp-definition-pins.ts and
 * mcp-high-risk.ts), and the pure helpers their screens use. Kept beside the screens, not in api/types.ts.
 */
import { humanize } from "../../../api/format";

export type DefinitionPinMode = "block" | "warn";

/** one RFC 6902 operation, as `definitionDiff` returns it */
export interface PatchOp {
  op: "add" | "remove" | "replace" | "move" | "copy" | "test";
  path: string;
  value?: unknown;
  from?: string;
}

/** GET /v1/mcp/definition-pins */
export interface DefinitionPinQueue {
  mode: DefinitionPinMode;
  servers: Array<{ serverId: string; serverName: string; pending: number; lastChangedAt: string | null }>;
  hasMore: boolean;
}

export interface DefinitionPin {
  kind: "tool" | "prompt" | "resource" | "resource_template";
  name: string;
  status: "approved" | "changed" | "added" | "removed";
  observedDigest: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  changedAt: string | null;
  approved: Record<string, unknown> | null;
  diff: PatchOp[];
}

/** GET /v1/servers/:serverId/definition-pins */
export interface ServerDefinitionPins {
  serverName: string;
  mode: DefinitionPinMode;
  pendingCount: number;
  pins: DefinitionPin[];
  hasMore: boolean;
}

/** the 409 `definition_pin_stale` body's items */
export interface StalePinItem {
  kind: string;
  name: string;
  why: string;
}

export const PAGE = 50;

export const pinKey = (p: { kind: string; name: string }) => `${p.kind}\u0000${p.name}`;

/** "Tool search_docs", "Resource template file:///{p}" */
export const pinLabel = (p: { kind: string; name: string }) => `${humanize(p.kind)} ${p.name}`;

export const pinStatusLabel = (s: DefinitionPin["status"]) => (s === "approved" ? "Approved" : `${humanize(s)} since approval`);

/** what one re-approval item sends: the digest the admin reviewed (null for a removed item) */
export const approvalItem = (p: DefinitionPin) => ({ kind: p.kind, name: p.name, observedDigest: p.observedDigest });

/** a value as plain text, bounded; never markup */
export function showValue(v: unknown, max = 400): string {
  if (v === undefined) return "nothing";
  const text = JSON.stringify(v, null, 1) ?? String(v);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** the object holding the pointer's last segment, and that segment (RFC 6901) */
function locate(doc: unknown, path: string): [Record<string, unknown>, string] | null {
  const segs = path.split("/").slice(1).map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
  const key = segs.pop();
  let at = doc;
  for (const s of segs) at = at && typeof at === "object" ? (at as Record<string, unknown>)[s] : undefined;
  return key !== undefined && at && typeof at === "object" ? [at as Record<string, unknown>, key] : null;
}

export interface DiffLine {
  action: string;
  path: string;
  before: string | null;
  after: string | null;
}

/**
 * The patch as readable lines: what changed, where, and the value before and after, as text. The operations apply
 * in order, so each "before" is read from the approved definition with the earlier operations already applied.
 */
export function describeDiff(approved: Record<string, unknown> | null, diff: readonly PatchOp[]): DiffLine[] {
  let doc: unknown = JSON.parse(JSON.stringify(approved ?? {}));
  const out: DiffLine[] = [];
  for (const op of diff) {
    if (op.op === "test") continue;
    const path = op.path || "(whole definition)";
    if (op.op === "move" || op.op === "copy") {
      out.push({ action: humanize(op.op), path, before: op.from ?? null, after: op.path });
      continue;
    }
    const at = locate(doc, op.path);
    const arr = at && Array.isArray(at[0]);
    const i = arr ? (at[1] === "-" ? (at[0] as unknown as unknown[]).length : Number(at[1])) : 0;
    const current = op.path === "" ? doc : at ? at[0][at[1]] : undefined;
    out.push({
      action: op.op === "add" ? "Added" : op.op === "remove" ? "Removed" : "Changed",
      path,
      before: op.op === "add" ? null : showValue(current),
      after: op.op === "remove" ? null : showValue(op.value),
    });
    if (op.path === "") doc = op.value;
    else if (at && arr) (at[0] as unknown as unknown[]).splice(i, op.op === "add" ? 0 : 1, ...(op.op === "remove" ? [] : [op.value]));
    else if (at && op.op === "remove") delete at[0][at[1]];
    else if (at) at[0][at[1]] = op.value;
  }
  return out;
}

/** the 409 stale items as one sentence */
export const staleSentence = (items: readonly StalePinItem[]) =>
  `Nothing was approved. ${items.map((i) => `${pinLabel(i)}: ${i.why}`).join("; ")}. Reload and review again.`;

// ---------------------------------------------------------------------------
// High-risk (offensive) tooling
// ---------------------------------------------------------------------------

/** GET /v1/servers/:serverId/high-risk-policy */
export interface HighRiskPolicyView {
  riskClass: "standard" | "high";
  riskClassifiedAt: string | null;
  riskFindings: { categories?: string[] } | null;
  mode: "enforce" | "off";
  policyApplied: boolean;
  approvalRuleId: string | null;
  rateLimitId: string | null;
}

export type AuthorisedTargetKind = "host" | "domain" | "cidr";

/** a row of GET /v1/mcp/authorised-targets */
export interface AuthorisedTarget {
  id: string;
  kind: AuthorisedTargetKind;
  value: string;
  note: string;
  createdBy: string | null;
  createdAt: string;
}

export const TARGET_KIND_LABEL: Record<AuthorisedTargetKind, string> = {
  host: "Host or IP address",
  domain: "Domain and its subdomains",
  cidr: "Network range (CIDR)",
};

/** the classifier's categories as words, once each; none for a server an admin marked by hand */
export const findingWords = (v: HighRiskPolicyView) => [...new Set(v.riskFindings?.categories ?? [])].map((c) => humanize(c).toLowerCase());
