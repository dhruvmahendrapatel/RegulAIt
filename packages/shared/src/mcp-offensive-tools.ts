/**
 * ADR-0246 addendum (owner, 2026-11-07) — OFFENSIVE MCP TOOL SERVERS AS HIGH-RISK: the pure half.
 *
 * Dual-use offensive-security tool servers (port scanning, exploitation, credential attacks, command and control)
 * are something RegulAIt never ships but must govern when a customer runs one. This file owns:
 *   - our own category vocabulary and rule set (written for RegulAIt; no tool list from any offensive project is
 *     copied, and no real tool's name is a rule: the rules match what a tool DOES, in generic words);
 *   - `classifyOffensiveTools`, the deterministic, local classification of a manifest (counts and locations only);
 *   - target extraction from a call's arguments and the check against an authorised-targets list;
 *   - argument redaction for the audit row.
 *
 * Every regex here is linear: anchored on word boundaries, alternations of literals with `\s+` / `\w*` and no nested
 * or overlapping quantifiers, run on text capped at OFFENSIVE_SCAN_TEXT_MAX characters (M-071 rule).
 */
import { BlockList, isIP } from "node:net";
import { z } from "zod";
import { scrubAuditText } from "./audit-scrub.js";

export const OFFENSIVE_TOOL_CATEGORIES = [
  "network_reconnaissance",
  "vulnerability_exploitation",
  "credential_attack",
  "command_and_control",
  "web_application_attack",
  "wireless_attack",
  "social_engineering",
] as const;
export type OffensiveToolCategory = (typeof OFFENSIVE_TOOL_CATEGORIES)[number];

interface OffensiveRule {
  id: string;
  category: OffensiveToolCategory;
  re: RegExp;
}

/** Our own rules. A rule names an activity, never a product. */
export const OFFENSIVE_TOOL_RULES: readonly OffensiveRule[] = [
  { id: "offsec.recon.port_scan", category: "network_reconnaissance", re: /\bport\s*scan(?:s|ner|ning)?\b/i },
  { id: "offsec.recon.host_discovery", category: "network_reconnaissance", re: /\b(?:host|network|ping)\s+(?:discovery|sweep|scan(?:ning)?)\b/i },
  { id: "offsec.recon.service_fingerprint", category: "network_reconnaissance", re: /\b(?:service|os|banner)\s+(?:fingerprint\w*|enumeration|grabbing)\b/i },
  { id: "offsec.recon.subdomain_enum", category: "network_reconnaissance", re: /\bsubdomain\s+(?:enumeration|discovery|brute\w*)\b/i },
  { id: "offsec.exploit.exploit", category: "vulnerability_exploitation", re: /\b(?:run|launch|execute|deliver|generate|search)\w*\s+(?:an?\s+|the\s+)?exploits?\b/i },
  { id: "offsec.exploit.payload", category: "vulnerability_exploitation", re: /\b(?:exploit\s+payload|shellcode|reverse\s+shell|bind\s+shell|meterpreter\w*)\b/i },
  { id: "offsec.exploit.privesc", category: "vulnerability_exploitation", re: /\bprivilege\s+escalation\b/i },
  { id: "offsec.exploit.rce", category: "vulnerability_exploitation", re: /\bremote\s+code\s+execution\b/i },
  { id: "offsec.cred.brute_force", category: "credential_attack", re: /\b(?:brute[\s-]?forc\w*|password\s+spray\w*|credential\s+stuffing)\b/i },
  { id: "offsec.cred.hash_crack", category: "credential_attack", re: /\b(?:hash|password)\s+crack\w*\b|\bcrack\w*\s+(?:password|hash)\w*\b/i },
  { id: "offsec.cred.dump", category: "credential_attack", re: /\bcredential\s+(?:dump\w*|harvest\w*)\b|\bpass[\s-]the[\s-](?:hash|ticket)\b|\bkerberoast\w*\b/i },
  { id: "offsec.c2.command_and_control", category: "command_and_control", re: /\bcommand[\s-](?:and|&)[\s-]control\b|\bc2\s+(?:server|channel|beacon|implant|framework)\b/i },
  { id: "offsec.c2.implant", category: "command_and_control", re: /\b(?:implant|beacon)\s+(?:deploy\w*|callback|check[\s-]?in|task\w*)\b|\blateral\s+movement\b/i },
  { id: "offsec.web.injection_attack", category: "web_application_attack", re: /\b(?:sql\s+injection|sqli|xss)\s+(?:attack|exploit\w*|payload\w*|test\w*|scan\w*)\b/i },
  { id: "offsec.web.dir_brute", category: "web_application_attack", re: /\b(?:directory|path|endpoint)\s+(?:brute\w*|bust\w*|fuzz\w*)\b/i },
  { id: "offsec.web.vuln_scan", category: "web_application_attack", re: /\b(?:web\s+)?vulnerability\s+scan\w*\b/i },
  { id: "offsec.wireless.attack", category: "wireless_attack", re: /\b(?:deauth\w*\s+attack|wpa2?\s+(?:handshake|crack\w*)|evil\s+twin|wi-?fi\s+crack\w*)\b/i },
  { id: "offsec.social.phishing", category: "social_engineering", re: /\b(?:phishing\s+(?:campaign|kit|page|email)\w*|spear[\s-]?phish\w*|credential\s+phishing)\b/i },
];

export const OFFENSIVE_SCAN_TEXT_MAX = 8192;
export const OFFENSIVE_CLASSIFIER_VERSION = "mcp-offensive/1";

export interface OffensiveToolFinding {
  tool: string;
  category: OffensiveToolCategory;
  rule: string;
  /** `name` or `description` */
  where: "name" | "description";
}

export interface OffensiveClassification {
  classifierVersion: string;
  highRisk: boolean;
  categories: OffensiveToolCategory[];
  findings: OffensiveToolFinding[];
}

/** `nmap_scan` / `portScan` / `port-scan` → `nmap scan` / `port Scan` / `port scan`: a tool name read as words. */
function nameAsWords(name: string): string {
  return name
    .slice(0, OFFENSIVE_SCAN_TEXT_MAX)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_\-.:/]+/g, " ");
}

/** Classify a manifest's tools. A server is high-risk when any tool matches any rule. */
export function classifyOffensiveTools(tools: readonly unknown[]): OffensiveClassification {
  const findings: OffensiveToolFinding[] = [];
  for (const t of tools) {
    if (t === null || typeof t !== "object") continue;
    const name = typeof (t as { name?: unknown }).name === "string" ? (t as { name: string }).name : "";
    const description = typeof (t as { description?: unknown }).description === "string" ? (t as { description: string }).description : "";
    const units: Array<[OffensiveToolFinding["where"], string]> = [
      ["name", nameAsWords(name)],
      ["description", description.slice(0, OFFENSIVE_SCAN_TEXT_MAX)],
    ];
    for (const rule of OFFENSIVE_TOOL_RULES) {
      for (const [where, text] of units) {
        if (text && rule.re.test(text)) {
          findings.push({ tool: name || "<unnamed>", category: rule.category, rule: rule.id, where });
          break;
        }
      }
    }
  }
  const categories = OFFENSIVE_TOOL_CATEGORIES.filter((c) => findings.some((f) => f.category === c));
  return { classifierVersion: OFFENSIVE_CLASSIFIER_VERSION, highRisk: findings.length > 0, categories, findings };
}

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------

/** Argument names read as the call's target(s), at the top level or one object below it. */
export const TARGET_ARGUMENT_KEYS: ReadonlySet<string> = new Set([
  "target", "targets", "host", "hosts", "hostname", "hostnames", "ip", "ips", "ip_address", "ipaddress", "address",
  "addresses", "domain", "domains", "url", "urls", "uri", "cidr", "network", "networks", "subnet", "range",
  "endpoint", "endpoints", "rhost", "rhosts", "server",
]);

export const AUTHORISED_TARGET_KINDS = ["host", "domain", "cidr"] as const;
export type AuthorisedTargetKind = (typeof AUTHORISED_TARGET_KINDS)[number];
export interface AuthorisedTarget {
  kind: AuthorisedTargetKind;
  /** normalised: a lowercase hostname or IP (`host`), a lowercase domain matching itself and its subdomains
   * (`domain`), or `address/prefix` (`cidr`) */
  value: string;
}

/** The whole argument tree is walked to this many nodes and this deep. Past either bound the scan is incomplete, so
 * `extractTargets` reports `truncated` and the gate refuses the call (fail closed, ADR-0180) rather than trust a
 * partial scan. The bounds are generous: a real offensive-tool call names a handful of targets. */
const MAX_TARGET_NODES = 20_000;
const MAX_TARGET_DEPTH = 16;

export interface ExtractedTargets {
  /** every target the call carries: the values under a target-named key (a non-string there is `<non-string>`, which
   *  `checkTargets` refuses), AND every host-, IP-, CIDR- or URL-shaped string ANYWHERE in the arguments — so a
   *  target hidden in an unrecognised key (`lhost`, `callback`, `dest`, …) or nested below depth 1 is still checked. */
  targets: string[];
  /** the argument tree exceeded the node or depth budget, so a value may be unscanned. The caller refuses. */
  truncated: boolean;
}

/** Does this string look like a network target (so a high-risk call carrying it must have it authorised)? A URL, an
 * IP, a CIDR, or a MULTI-label hostname (a dotted name); a bare single word like `module` or `true` is not a target,
 * which is why the whole-tree scan does not refuse every call. */
export function looksLikeNetworkTarget(value: string): boolean {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) return false;
  const t = normaliseTarget(value);
  return !!t && (t.kind !== "host" || t.host.includes("."));
}

/** Every target string in a call's arguments, scanned over the WHOLE tree (ADR-0246 addendum, review findings 1-2). */
export function extractTargets(args: Record<string, unknown> | undefined | null): ExtractedTargets {
  const targets = new Set<string>();
  let truncated = false;
  let budget = MAX_TARGET_NODES;
  const visit = (value: unknown, depth: number, underTargetKey: boolean): void => {
    if (budget-- <= 0) {
      truncated = true;
      return;
    }
    if (typeof value === "string") {
      // under a target-named key: taken verbatim (even a bare word, so a scoped call still names its target);
      // anywhere else: taken only when it is network-shaped, so an unrecognised/nested target cannot ride along
      if (underTargetKey || looksLikeNetworkTarget(value)) targets.add(value);
      return;
    }
    if (value === null || typeof value !== "object") {
      // a non-string leaf under a target key is an unparseable target, refused rather than ignored
      if (underTargetKey) targets.add("<non-string>");
      return;
    }
    if (depth >= MAX_TARGET_DEPTH) {
      truncated = true;
      return;
    }
    if (Array.isArray(value)) {
      for (const x of value) visit(x, depth + 1, underTargetKey);
      return;
    }
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      visit(v, depth + 1, underTargetKey || TARGET_ARGUMENT_KEYS.has(k.toLowerCase()));
    }
  };
  if (args && typeof args === "object") visit(args, 0, false);
  return { targets: [...targets], truncated };
}

type NormalisedTarget = { kind: "ip"; ip: string; family: "ipv4" | "ipv6" } | { kind: "cidr"; ip: string; prefix: number; family: "ipv4" | "ipv6" } | { kind: "host"; host: string };

const HOST_LABEL = /^[a-z0-9_-]{1,63}$/;
/** A hostname, label by label (split, then one flat regex per label: no nested quantifier on caller input). */
function isHostname(s: string): boolean {
  if (s.length === 0 || s.length > 253) return false;
  return s.split(".").every((l) => HOST_LABEL.test(l) && !l.startsWith("-") && !l.endsWith("-"));
}

/** A raw target as an IP, a CIDR or a hostname; null when it is none of them. A URL is read for its host. */
export function normaliseTarget(raw: string): NormalisedTarget | null {
  let s = raw.trim();
  if (!s || s.length > 2048) return null;
  if (/^[a-z][a-z0-9+.-]{0,30}:\/\//i.test(s)) {
    try {
      s = new URL(s).hostname;
    } catch {
      return null;
    }
  }
  s = s.replace(/^\[|\]$/g, "").toLowerCase();
  const slash = s.indexOf("/");
  if (slash > 0) {
    const ip = s.slice(0, slash);
    const prefix = Number(s.slice(slash + 1));
    const family = isIP(ip);
    if (!family || !Number.isInteger(prefix) || prefix < 0 || prefix > (family === 4 ? 32 : 128)) return null;
    return { kind: "cidr", ip, prefix, family: family === 4 ? "ipv4" : "ipv6" };
  }
  const family = isIP(s);
  if (family) return { kind: "ip", ip: s, family: family === 4 ? "ipv4" : "ipv6" };
  const hostPort = s.match(/^([^:]+):\d{1,5}$/);
  if (hostPort) s = hostPort[1]!;
  s = s.replace(/\.$/, "");
  if (!isHostname(s)) return null;
  return { kind: "host", host: s };
}

/** Normalise an admin's authorised-target entry, or null when it is not one. */
export function normaliseAuthorisedTarget(kind: AuthorisedTargetKind, raw: string): AuthorisedTarget | null {
  const t = normaliseTarget(raw);
  if (!t) return null;
  if (kind === "cidr") return t.kind === "cidr" ? { kind, value: `${t.ip}/${t.prefix}` } : null;
  if (kind === "host") return t.kind === "ip" ? { kind, value: t.ip } : t.kind === "host" ? { kind, value: t.host } : null;
  return t.kind === "host" && t.host.includes(".") ? { kind, value: t.host } : null;
}

function ipv4ToInt(ip: string): number {
  return ip.split(".").reduce((n, o) => n * 256 + Number(o), 0);
}
function intToIpv4(n: number): string {
  return [24, 16, 8, 0].map((s) => Math.floor(n / 2 ** s) % 256).join(".");
}

export interface TargetCheck {
  /** every target in the arguments, as given */
  targets: string[];
  /** the ones that are not authorised (or not parseable) */
  refused: string[];
}

/** Every target must be authorised: an IP inside an authorised CIDR or listed as a host; a hostname listed as a
 * host or under an authorised domain; a CIDR identical to an authorised one or (IPv4) inside one. */
export function checkTargets(rawTargets: readonly string[], authorised: readonly AuthorisedTarget[]): TargetCheck {
  const list = new BlockList();
  const cidrs = new Set<string>();
  for (const a of authorised) {
    if (a.kind !== "cidr") continue;
    const [ip, prefix] = a.value.split("/");
    const family = isIP(ip!);
    if (!family) continue;
    list.addSubnet(ip!, Number(prefix), family === 4 ? "ipv4" : "ipv6");
    cidrs.add(a.value);
  }
  const hosts = new Set(authorised.filter((a) => a.kind === "host").map((a) => a.value));
  const domains = authorised.filter((a) => a.kind === "domain").map((a) => a.value);
  const ok = (raw: string): boolean => {
    const t = normaliseTarget(raw);
    if (!t) return false;
    if (t.kind === "ip") return hosts.has(t.ip) || list.check(t.ip, t.family);
    if (t.kind === "host") return hosts.has(t.host) || domains.some((d) => t.host === d || t.host.endsWith(`.${d}`));
    if (cidrs.has(`${t.ip}/${t.prefix}`)) return true;
    if (t.family !== "ipv4") return false;
    const size = 2 ** (32 - t.prefix);
    const first = Math.floor(ipv4ToInt(t.ip) / size) * size;
    return list.check(intToIpv4(first), "ipv4") && list.check(intToIpv4(first + size - 1), "ipv4");
  };
  return { targets: [...rawTargets], refused: rawTargets.filter((r) => !ok(r)) };
}

// ---------------------------------------------------------------------------
// The audit copy of the arguments
// ---------------------------------------------------------------------------

const SECRET_KEY = /(?:pass(?:word|wd|phrase)?|secret|token|api[_-]?key|authori[sz]ation|credential|private[_-]?key|cookie|session)/i;

/** A bounded copy of a call's arguments for the audit row: string leaves through ADR-0099's `scrubAuditText`,
 * values under secret-looking keys replaced, long strings cut, depth and size capped. */
export function redactArgumentsForAudit(value: unknown, depth = 0, budget = { leaves: 200 }): unknown {
  if (budget.leaves <= 0) return "[truncated]";
  if (typeof value === "string") {
    budget.leaves--;
    const cut = value.length > 2000 ? `${value.slice(0, 2000)}…` : value;
    return scrubAuditText(cut);
  }
  if (value === null || typeof value !== "object") {
    budget.leaves--;
    return value;
  }
  if (depth >= 6) return "[truncated]";
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redactArgumentsForAudit(v, depth + 1, budget));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>).slice(0, 50)) {
    out[k] = SECRET_KEY.test(k) ? "[REDACTED]" : redactArgumentsForAudit(v, depth + 1, budget);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Request bodies
// ---------------------------------------------------------------------------

export const MCP_HIGH_RISK_MODES = ["enforce", "off"] as const;
export type McpHighRiskMode = (typeof MCP_HIGH_RISK_MODES)[number];

/** POST /v1/servers/:serverId/high-risk-policy — the policy template. */
export const applyHighRiskPolicySchema = z
  .object({
    approverUserId: z.string().uuid(),
    approverRoleId: z.string().uuid().nullable().optional(),
    quorum: z.number().int().min(2).max(5).default(2),
    maxCalls: z.number().int().min(1).max(1000).default(20),
    windowSeconds: z.number().int().min(60).max(86_400).default(3600),
  })
  .strict();

/** POST /v1/mcp/authorised-targets */
export const createAuthorisedTargetSchema = z
  .object({
    kind: z.enum(AUTHORISED_TARGET_KINDS),
    value: z.string().trim().min(1).max(2048),
    note: z.string().trim().min(1).max(500),
  })
  .strict();

/** POST /v1/servers/:serverId/risk-class — an admin marks a server high-risk by hand, because the automatic
 * classifier reads names and descriptions and a server can name its offensive tools neutrally (review finding 3). It
 * only ever tightens: a server is never lowered to `standard` here, as the automatic path never lowers it either. */
export const markServerHighRiskSchema = z
  .object({
    reason: z.string().trim().min(1).max(2000),
  })
  .strict();
