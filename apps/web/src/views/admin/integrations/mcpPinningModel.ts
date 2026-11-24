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

/** how much of a value the one-line summary shows before it says the rest is in the full view */
export const SUMMARY_MAX = 400;

/** a value as plain text, in full; never markup */
export function valueText(v: unknown): string {
  if (v === undefined) return "nothing";
  return JSON.stringify(v, null, 1) ?? String(v);
}

const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff;
const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff;

/** the start of a text for the summary line, whether it was cut, and the full length; never splits a surrogate pair */
export function clip(text: string, max = SUMMARY_MAX): { shown: string; cut: boolean; total: number } {
  if (text.length <= max) return { shown: text, cut: false, total: text.length };
  const end = isHigh(text.charCodeAt(max - 1)) ? max - 1 : max;
  return { shown: text.slice(0, end), cut: true, total: text.length };
}

/** a value as plain text, bounded; never markup */
export function showValue(v: unknown, max = SUMMARY_MAX): string {
  const c = clip(valueText(v), max);
  return c.cut ? `${c.shown}…` : c.shown;
}

/**
 * Where two texts differ: the common start (`head`), the differing middle of each, and the common end (`tail`).
 * Every changed character lies in `before` or `after`, so marking them hides nothing; a change in two places marks
 * the span between them. `at` is the 1-based position of the first differing character, null when the texts match.
 * Never splits a surrogate pair.
 */
export interface DifferenceSplit {
  head: string;
  before: string;
  after: string;
  tail: string;
  at: number | null;
}

export function splitDifference(a: string, b: string): DifferenceSplit {
  if (a === b) return { head: a, before: "", after: "", tail: "", at: null };
  const n = Math.min(a.length, b.length);
  let p = 0;
  while (p < n && a.charCodeAt(p) === b.charCodeAt(p)) p++;
  if (p > 0 && isHigh(a.charCodeAt(p - 1))) p--;
  let s = 0;
  while (s < n - p && a.charCodeAt(a.length - 1 - s) === b.charCodeAt(b.length - 1 - s)) s++;
  if (s > 0 && isLow(a.charCodeAt(a.length - s))) s--;
  return { head: a.slice(0, p), before: a.slice(p, a.length - s), after: b.slice(p, b.length - s), tail: a.slice(a.length - s), at: p + 1 };
}

/** the object holding the pointer's last segment, and that segment (RFC 6901) */
function locate(doc: unknown, path: string): [Record<string, unknown>, string] | null {
  const segs = path.split("/").slice(1).map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
  const key = segs.pop();
  let at = doc;
  for (const s of segs) at = at && typeof at === "object" ? (at as Record<string, unknown>)[s] : undefined;
  return key !== undefined && at && typeof at === "object" ? [at as Record<string, unknown>, key] : null;
}

/** one operation as text: `before` and `after` are the full values (the screen bounds its summary with `clip`) */
export interface DiffLine {
  action: string;
  path: string;
  before: string | null;
  after: string | null;
}

/**
 * The patch as readable lines: what changed, where, and the value before and after, in full, as text. The operations apply
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
      before: op.op === "add" ? null : valueText(current),
      after: op.op === "remove" ? null : valueText(op.value),
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
