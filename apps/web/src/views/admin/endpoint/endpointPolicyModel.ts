/**
 * ADR-0350 §5 (lane E31): the browser's model of endpoint device groups and per-device command exceptions.
 *
 * The SPA does not import `@regulait/shared` at runtime, so the vocabularies and bounds the gateway enforces are
 * mirrored here and pinned against the shared source by endpointPolicyModel.test.ts. The gateway stays the authority:
 * every check here only says in advance, in words, what the server would refuse.
 *
 * Pure and zero-I/O.
 */

// ---- mirrored vocabularies (packages/shared/src/endpoint-command-exceptions.ts) -------------------------------------

export const ENDPOINT_GROUP_RULE_KINDS = ["exec", "file", "package"] as const;
export type GroupRuleKind = (typeof ENDPOINT_GROUP_RULE_KINDS)[number];
/** a group rule only narrows: ask or deny, never allow */
export const ENDPOINT_GROUP_RULE_VERDICTS = ["deny", "ask"] as const;
export type GroupRuleVerdict = (typeof ENDPOINT_GROUP_RULE_VERDICTS)[number];
/** what an exception may loosen a rule to; deny is never a relaxation */
export const ENDPOINT_EXCEPTION_VERDICTS = ["allow", "ask"] as const;
export type ExceptionVerdict = (typeof ENDPOINT_EXCEPTION_VERDICTS)[number];
export const ENDPOINT_EXCEPTION_DEFAULT_MAX_HOURS = 24;
export const ENDPOINT_EXCEPTION_HARD_MAX_HOURS = 168;
export const ENDPOINT_RULE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const ENDPOINT_EXCEPTION_STATES = ["requested", "approved", "rejected", "cancelled", "revoked", "expired"] as const;
export type ExceptionState = (typeof ENDPOINT_EXCEPTION_STATES)[number];

// ---- mirrored request bounds (apps/gateway/src/endpoint-command-exceptions.ts) -------------------------------------

/** a glob the device accepts: a conservative character set (the gateway's `glob`) */
export const GLOB = /^[A-Za-z0-9._/@:~*+=,%-]+$/;
export const GLOB_MAX = 512;
export const ARGV_MAX = 32;
/** a file rule's path is an absolute path glob */
export const ABSOLUTE_PATH = /^(\/|~\/|\*\*\/|[A-Za-z]:\/)/;
export const FILE_ACCESS = ["read", "write", "any"] as const;
export const PACKAGE_ECOSYSTEMS = ["npm", "pypi", "apt", "dnf", "apk", "brew", "cargo", "go", "gem", "*"] as const;
export const GROUP_NAME_MAX = 120;
export const GROUP_DESCRIPTION_MAX = 1000;
export const REASON_MAX = 500;

// ---- the API's shapes ------------------------------------------------------------------------------------------------

export type GroupRuleBody =
  | { kind: "exec"; rule: { argv: string[] } }
  | { kind: "file"; rule: { access: (typeof FILE_ACCESS)[number]; path: string } }
  | { kind: "package"; rule: { ecosystem: (typeof PACKAGE_ECOSYSTEMS)[number]; name: string } };

export type GroupRule = { id: string; ruleId: string; verdict: GroupRuleVerdict } & GroupRuleBody;

export interface DeviceGroup {
  id: string;
  name: string;
  description: string | null;
  deviceIds: string[];
  rules: GroupRule[];
}

export interface TransitionView {
  event: string;
  to: string;
  allowed: boolean;
  reason?: string;
  by: string[];
  summary: string;
}
export interface Lifecycle {
  machine: string;
  state: string;
  terminal: boolean;
  transitions: TransitionView[];
}
export interface MachineJson {
  id: string;
  states: string[];
  terminal: string[];
  transitions: Record<string, { from: string[]; to: string; by: string[]; summary: string }>;
}

export interface CommandException {
  id: string;
  deviceId: string;
  ruleId: string;
  verdict: ExceptionVerdict;
  hours: number;
  reason: string;
  termsDigest: string;
  requestedBy: string;
  approverUserId: string;
  state: ExceptionState;
  lifecycle: Lifecycle;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionReason: string | null;
  notAfter: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export interface ExceptionPage {
  items: CommandException[];
  next: string | null;
  machine?: MachineJson;
}

/** an enrolled device, as the Discovery sources device list describes it */
export interface PolicyDevice {
  id: string;
  devicePseudonym: string;
  os: string;
  arch: string;
  agentVersion: string;
  lastReportAt: string | null;
  revokedAt: string | null;
}

// ---- words -----------------------------------------------------------------------------------------------------------

export const KIND_LABEL: Record<GroupRuleKind, string> = { exec: "Command", file: "File", package: "Package" };
export const VERDICT_LABEL: Record<GroupRuleVerdict | ExceptionVerdict, string> = { deny: "Deny", ask: "Ask first", allow: "Allow" };
export const VERDICT_TONE = { deny: "danger", ask: "warn", allow: "ok" } as const;

/** the rule as a person reads it: the command words, the file access and path, or ecosystem:name */
export function rulePattern(r: GroupRuleBody): string {
  if (r.kind === "exec") return r.rule.argv.join(" ");
  if (r.kind === "file") return `${r.rule.access} ${r.rule.path}`;
  return `${r.rule.ecosystem}:${r.rule.name}`;
}

/** "1 hour", "4 hours", "1 day", "3 days" */
export function hoursText(h: number): string {
  if (h % 24 === 0) return h === 24 ? "1 day" : `${h / 24} days`;
  return h === 1 ? "1 hour" : `${h} hours`;
}

/** the durations the request form offers (all within the hard maximum) */
export const DURATION_CHOICES = [1, 2, 4, 8, 24, 72, 168] as const;

export const devicePlatform = (d: Pick<PolicyDevice, "os" | "arch" | "agentVersion">) => `${d.os}/${d.arch}, agent ${d.agentVersion}`;

// ---- the add-rule form -------------------------------------------------------------------------------------------------

export interface RuleDraft {
  verdict: GroupRuleVerdict;
  kind: GroupRuleKind;
  /** exec: the command words, space separated */
  command: string;
  access: (typeof FILE_ACCESS)[number];
  path: string;
  ecosystem: (typeof PACKAGE_ECOSYSTEMS)[number];
  name: string;
  /** empty: the suggested id is used */
  ruleId: string;
}

export const emptyRuleDraft = (): RuleDraft => ({ verdict: "deny", kind: "exec", command: "", access: "any", path: "", ecosystem: "npm", name: "", ruleId: "" });

const globProblem = (what: string, g: string): string | null => {
  if (!g) return `${what} is required.`;
  if (g.length > GLOB_MAX) return `${what} is longer than ${GLOB_MAX} characters.`;
  if (!GLOB.test(g)) return `${what} may use only letters, digits and . _ / @ : ~ * + = , % - (no spaces, pipes or quotes).`;
  return null;
};

/** a rule id derived from the draft: lower case, the device's rule id shape, at most 64 characters */
export function suggestedRuleId(d: RuleDraft): string {
  const subject = d.kind === "exec" ? d.command : d.kind === "file" ? `${d.access}-${d.path}` : `${d.ecosystem}-${d.name}`;
  const slug = subject.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const id = `${d.verdict}-${d.kind}${slug ? `-${slug}` : ""}`.slice(0, 64).replace(/[-._]+$/, "");
  return ENDPOINT_RULE_ID.test(id) ? id : `${d.verdict}-${d.kind}`;
}

/** the POST body for the draft, or the first problem with it in words */
export function ruleBody(d: RuleDraft): { body: Record<string, unknown> } | { problem: string } {
  const ruleId = d.ruleId.trim() || suggestedRuleId(d);
  if (!ENDPOINT_RULE_ID.test(ruleId)) return { problem: "The rule id must start with a lower-case letter or digit and use only a-z, 0-9, dot, underscore and hyphen, up to 64 characters." };
  if (d.kind === "exec") {
    const argv = d.command.trim().split(/\s+/).filter(Boolean);
    if (argv.length === 0) return { problem: "Enter the command to match, for example: terraform apply *" };
    if (argv.length > ARGV_MAX) return { problem: `A command pattern has at most ${ARGV_MAX} words.` };
    for (const w of argv) {
      const p = globProblem(`The word "${w.slice(0, 40)}"`, w);
      if (p) return { problem: p };
    }
    return { body: { kind: "exec", ruleId, verdict: d.verdict, rule: { argv } } };
  }
  if (d.kind === "file") {
    const path = d.path.trim();
    const p = globProblem("The path", path);
    if (p) return { problem: p };
    if (!ABSOLUTE_PATH.test(path)) return { problem: "The path must be absolute: start it with /, ~/, **/ or a drive letter such as C:/." };
    return { body: { kind: "file", ruleId, verdict: d.verdict, rule: { access: d.access, path } } };
  }
  const name = d.name.trim();
  const p = globProblem("The package name", name);
  if (p) return { problem: p };
  return { body: { kind: "package", ruleId, verdict: d.verdict, rule: { ecosystem: d.ecosystem, name } } };
}

// ---- exceptions: who may do what, said before the server says it ---------------------------------------------------

export function transition(x: CommandException, event: string): TransitionView | undefined {
  return x.lifecycle?.transitions?.find((t) => t.event === event);
}

/** why the lifecycle refuses `event` now, or null when the state allows it */
function stateBlock(x: CommandException, event: string): string | null {
  const t = transition(x, event);
  if (t) return t.allowed ? null : (t.reason ?? `This exception is ${x.state}.`);
  return x.state === "requested" && event !== "revoke" ? null : x.state === "approved" && event === "revoke" ? null : `This exception is ${x.state}.`;
}

/** the reason the viewer cannot approve, or null. Self-approval is never possible. */
export function approveBlock(x: CommandException, me: string | null, approverName: string): string | null {
  const s = stateBlock(x, "approve");
  if (s) return s;
  if (!me) return "Only a signed-in admin can approve.";
  if (me === x.requestedBy) return `You requested this exception, so you can't approve it. ${approverName}, the approver it names, must.`;
  if (me !== x.approverUserId) return `Only the approver this request names, ${approverName}, can approve it.`;
  return null;
}

export function rejectBlock(x: CommandException, me: string | null): string | null {
  const s = stateBlock(x, "reject");
  if (s) return s;
  if (!me || me === x.requestedBy) return "You can't reject your own request; cancel it instead.";
  return null;
}

export function cancelBlock(x: CommandException, me: string | null): string | null {
  const s = stateBlock(x, "cancel");
  if (s) return s;
  if (me !== x.requestedBy) return "Only the admin who requested it can cancel a request.";
  return null;
}

export const revokeBlock = (x: CommandException): string | null => stateBlock(x, "revoke");

/** the step-ups approving `x` asks for: the decision itself, and a settings relaxation past the default maximum */
export const approveStepUps = (x: Pick<CommandException, "hours">): number => (x.hours > ENDPOINT_EXCEPTION_DEFAULT_MAX_HOURS ? 2 : 1);

/** requests waiting on this viewer's decision */
export const awaitingMe = (items: readonly CommandException[], me: string | null): number =>
  me ? items.filter((x) => x.state === "requested" && x.approverUserId === me && x.requestedBy !== me).length : 0;

export const STATE_TONE: Record<ExceptionState, "warn" | "info" | "neutral" | "danger"> = {
  requested: "warn",
  approved: "info",
  expired: "neutral",
  rejected: "neutral",
  cancelled: "neutral",
  revoked: "neutral",
};

export function stateLabel(x: Pick<CommandException, "state" | "requestedBy">, me: string | null): string {
  if (x.state === "requested") return x.requestedBy === me ? "Requested (yours)" : "Requested";
  if (x.state === "approved") return "Active";
  return x.state.charAt(0).toUpperCase() + x.state.slice(1);
}

/** a refusal code from these routes as a sentence a person can act on; null leaves the client's own message */
export const REFUSAL_SENTENCES: Readonly<Record<string, string>> = {
  name_taken: "A device group with this name already exists. Choose another name.",
  rule_id_taken: "This group already has a rule with this id. Change the rule id.",
  caller_cannot_approve: "You can't approve this: only the approver it names, who is not the requester, may.",
  caller_cannot_decide: "You can't reject your own request; cancel it instead.",
  caller_cannot_cancel: "Only the admin who requested it can cancel a request.",
  terms_changed: "The request's terms changed since you opened it, so this approval no longer applies. Reload and review it again.",
  invalid_transition: "This exception has already moved on (decided, expired or revoked). The list has been reloaded.",
  approver_not_admin: "The approver must be an active admin.",
  device_revoked: "That device is revoked; an exception for it would never apply.",
  user_required: "An exception is requested by a person, not by a token.",
  not_found: "It no longer exists. The list has been reloaded.",
};
