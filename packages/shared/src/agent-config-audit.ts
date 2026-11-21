/**
 * ADR-0355 (lane E36) — REPOSITORY AGENT-CONFIG AUDIT, the pure half.
 *
 * A repository can carry settings that an AI coding agent obeys the moment it opens the repository: hooks that run
 * shell commands, MCP servers that start processes, auto-approve and permissive permission modes, base-URL and proxy
 * overrides that move model traffic off the governed gateway, credential helpers, and instruction files that can
 * carry injected text. This module turns those settings into read-only POSTURE FINDINGS, each with a rule id, a
 * frequency × severity score (the owner's triage scale, 1–10 each) and a fix hint.
 *
 * Two sources, one finding shape:
 *   1. The ENGINE: agentaudit (manifold-security/agentaudit v0.1.2, Apache-2.0, Go), run by our driver
 *      (engines/agentaudit/driver) in an engine sandbox with no network. It covers `.claude/`, `.cursor/`, `.codex/`,
 *      `.mcp.json`, plugins and skills. Its report (`regulait.agent-config-audit.v1`) carries rule ids and locations,
 *      never a value; `interpretAgentConfigAuditReport` reads it strictly and fails closed.
 *   2. The COMPLEMENT (`auditAgentConfigFiles`): the surfaces agentaudit does not read (`.vscode/`, AGENTS.md,
 *      CLAUDE.md, Copilot instruction files, `.cursorrules`), and value checks the engine's capability model does not
 *      make (an MCP package that is not pinned to a version, a plaintext remote MCP URL, a command that fetches and
 *      runs remote code, a credential literal, prompt-injection text, hidden Unicode). It REUSES the admission
 *      scanner (`scanAdmissionUnits`: the ADR-0042 injection and credential detectors and the hidden-Unicode rules)
 *      rather than re-implementing them.
 *
 * A finding below 5 on F × S is INFORMATIONAL (owner, 2026-11-17): reported, never failing a check. An unknown rule
 * id from the engine is never dropped: it becomes `agentaudit.unmapped` at a medium score, so a new upstream rule is
 * seen before it is catalogued. Every function here is pure and total; nothing reads a file or the network.
 */
import { createHash } from "node:crypto";
import { parse as parseJsonSyntax, type AnyNode, type DocumentNode } from "@humanwhocodes/momoa";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";
import { scanAdmissionUnits } from "./mcp-admission.js";
import { SKILL_SKIPPED_MCP_RULES } from "./skill-admission.js";

// ---------------------------------------------------------------------------
// The engine, the exchange formats and the limits
// ---------------------------------------------------------------------------

export const AGENT_CONFIG_AUDIT_ENGINE = Object.freeze({
  id: "agentaudit",
  /** the pinned upstream release; the driver refuses to run when the linked module is any other */
  version: "0.1.2",
  upstream: "github.com/manifold-security/agentaudit",
  licence: "Apache-2.0",
  /** the one input file the driver reads, at the sandbox input root */
  inputFile: "agent-config.json",
});

export const AGENT_CONFIG_BUNDLE_SCHEMA = "regulait.agent-config-bundle.v1";
export const AGENT_CONFIG_AUDIT_REPORT_SCHEMA = "regulait.agent-config-audit.v1";
/** the catalogue's version: a rule, score or hint change is a reviewed change (agent-config-audit.test.ts pins it) */
export const AGENT_CONFIG_RULES_VERSION = "agent-config-rules/2";

/** the driver's limits, mirrored (engines/agentaudit/driver/main.go; the test keeps them in lockstep) */
export const AGENT_CONFIG_LIMITS = Object.freeze({
  maxFiles: 500,
  maxFileBytes: 512 * 1024,
  maxBundleBytes: 8 * 1024 * 1024,
  maxPathBytes: 512,
  maxKeyBytes: 300,
  maxFindings: 5000,
});

// ---------------------------------------------------------------------------
// Which repository paths are agent configuration
// ---------------------------------------------------------------------------

/** every file under these directories is read (the agents' own config trees, plugins and skills) */
const CONFIG_DIRS = [".claude/", ".cursor/", ".codex/", ".agents/", ".claude-plugin/", ".cursor-plugin/"] as const;
/** exact files anywhere in this list are read */
const CONFIG_FILES = new Set([
  ".mcp.json",
  ".claude.json",
  ".vscode/mcp.json",
  ".vscode/settings.json",
  "AGENTS.md",
  "CLAUDE.md",
  "CLAUDE.local.md",
  ".cursorrules",
  ".github/copilot-instructions.md",
]);
/** instruction files: text addressed to the model (the injection rules apply) */
const INSTRUCTION_RE = /(?:^|\/)(?:AGENTS\.md|CLAUDE(?:\.local)?\.md|SKILL\.md|\.cursorrules|copilot-instructions\.md|[^/]+\.instructions\.md|[^/]+\.prompt\.md|[^/]+\.agent\.md|[^/]+\.mdc)$/;
/** slash-command bodies and subagent system prompts: also text addressed to the model (review R4 [1]) */
const PROMPT_DIR_RE = /^\.(?:claude|cursor)\/(?:commands|agents)\/.+\.md$/;
/** instruction files agents pick up from the directory they work in, at any depth */
const NESTED_INSTRUCTION_RE = /(?:^|\/)(?:AGENTS\.md|CLAUDE(?:\.local)?\.md)$/;

/**
 * The driver's path rule (engines/agentaudit/driver/main.go `cleanBundlePath`), mirrored so a path the driver would
 * refuse is left out of the bundle (and the audit reported incomplete) instead of failing the whole engine run
 * (security review S4 [2]): relative, slash-separated, no empty, `.` or `..` segment, no backslash or control character.
 */
export function isBundlePath(path: string): boolean {
  if (!path || Buffer.byteLength(path, "utf8") > AGENT_CONFIG_LIMITS.maxPathBytes || path.startsWith("/")) return false;
  if (/[\\\u0000-\u001f\u007f]/.test(path)) return false;
  return path.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..");
}

/**
 * True when a repository path is one the audit selects (a nested AGENTS.md or CLAUDE.md counts: agents read the one
 * nearest the directory they work in). A selected path the driver would refuse is still selected, so the bundle builder
 * can report it as skipped (`invalid_path`) and the audit as incomplete.
 */
export function isAgentConfigPath(path: string): boolean {
  if (!path || path.startsWith("/") || path.split("/").includes("..")) return false;
  if (CONFIG_FILES.has(path)) return true;
  if (CONFIG_DIRS.some((d) => path.startsWith(d))) return true;
  if (/^\.github\/(?:instructions|prompts|agents)\/[^/]+\.md$/.test(path)) return true;
  return NESTED_INSTRUCTION_RE.test(path);
}

export function isInstructionPath(path: string): boolean {
  return INSTRUCTION_RE.test(path) || PROMPT_DIR_RE.test(path);
}

export interface AgentConfigFile {
  path: string;
  content: string;
}

export interface AgentConfigBundle {
  /** the exact bytes the gateway places as the engine's input file */
  json: string;
  sha256: string;
  files: number;
  /** paths left out, with why: the scan is INCOMPLETE when any is present (never clean) */
  skipped: { path: string; reason: "not_config" | "invalid_path" | "too_large" | "over_file_limit" | "over_bundle_limit" | "duplicate" | "not_text" }[];
}

/**
 * Build the engine's input bundle from files the scanner read. Selection, deduplication and the driver's limits are
 * applied here so the driver never has to refuse a bundle the gateway built; whatever is left out is listed, and a
 * scan with a skipped config file is incomplete.
 */
export function buildAgentConfigBundle(files: readonly AgentConfigFile[]): AgentConfigBundle {
  const skipped: AgentConfigBundle["skipped"] = [];
  const kept: AgentConfigFile[] = [];
  const seen = new Set<string>();
  let total = 64;
  for (const f of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    if (!isAgentConfigPath(f.path)) {
      skipped.push({ path: f.path.slice(0, AGENT_CONFIG_LIMITS.maxPathBytes), reason: "not_config" });
      continue;
    }
    if (!isBundlePath(f.path)) {
      skipped.push({ path: f.path.slice(0, AGENT_CONFIG_LIMITS.maxPathBytes), reason: "invalid_path" });
      continue;
    }
    if (seen.has(f.path)) {
      skipped.push({ path: f.path, reason: "duplicate" });
      continue;
    }
    seen.add(f.path);
    if (f.content.includes("\u0000")) {
      skipped.push({ path: f.path, reason: "not_text" });
      continue;
    }
    const bytes = Buffer.byteLength(f.content, "utf8");
    if (bytes > AGENT_CONFIG_LIMITS.maxFileBytes) {
      skipped.push({ path: f.path, reason: "too_large" });
      continue;
    }
    if (kept.length >= AGENT_CONFIG_LIMITS.maxFiles) {
      skipped.push({ path: f.path, reason: "over_file_limit" });
      continue;
    }
    // the driver caps UTF-8 bytes of the whole bundle: budget the escaped entry in UTF-8 bytes, not UTF-16 units
    // (reviews R4 [3] / S4 [1]), with headroom for the entry's punctuation
    const escaped = Buffer.byteLength(JSON.stringify(f.content), "utf8") + Buffer.byteLength(JSON.stringify(f.path), "utf8") + 24;
    if (total + escaped > AGENT_CONFIG_LIMITS.maxBundleBytes) {
      skipped.push({ path: f.path, reason: "over_bundle_limit" });
      continue;
    }
    total += escaped;
    kept.push({ path: f.path, content: f.content });
  }
  const json = JSON.stringify({ schema: AGENT_CONFIG_BUNDLE_SCHEMA, files: kept });
  return { json, sha256: createHash("sha256").update(json, "utf8").digest("hex"), files: kept.length, skipped };
}

// ---------------------------------------------------------------------------
// The rule catalogue: every rule id, its F × S, and the fix hint
// ---------------------------------------------------------------------------

export const AGENT_CONFIG_SEVERITIES = ["info", "low", "medium", "high", "critical"] as const;
export type AgentConfigSeverity = (typeof AGENT_CONFIG_SEVERITIES)[number];

export interface AgentConfigRule {
  id: string;
  source: "agentaudit" | "regulait";
  title: string;
  /** how often the setting is abused or goes wrong, 1–10 */
  frequency: number;
  /** how bad it is when it does, 1–10 */
  impact: number;
  fixHint: string;
}

type RuleRow = readonly [id: string, f: number, s: number, title: string, fix: string];

const H = {
  hook: "Review the command. Keep hooks out of shared repository settings unless every contributor should run them; move personal hooks to the user-level settings file.",
  mcp: "Confirm the server is approved, admit it through the gateway's MCP registry, and pin its package to an exact version.",
  autoApprove: "Remove auto-approval so each MCP server is approved by the person opening the repository.",
  mode: "Remove the permissive default mode; let each person choose it in their own settings.",
  sandbox: "Keep the agent sandbox on and admit no extra paths, sockets or network routes from repository settings.",
  socket: "Do not admit the Docker or another privileged socket to the agent sandbox; it is a path to the host.",
  net: "Remove the override so model and tool traffic goes through the governed gateway and the approved egress.",
  cred: "Do not run credential helpers from repository settings; configure credentials per person, outside the repository.",
  env: "Remove the environment override from repository settings.",
  perm: "Narrow the pre-approved command to an exact, read-only invocation, or remove it.",
  script: "Review the bundled script; it runs with the developer's privileges.",
  path: "Narrow the path grant to the workspace, or remove it.",
};

/** agentaudit v0.1.2's 59 rules (every id in its embedded rule set; the test checks the vendored list) */
const AGENTAUDIT_RULES: readonly RuleRow[] = [
  ["claude.credential.api-key-helper", 3, 7, "Claude Code runs an API-key helper command", H.cred],
  ["claude.credential.aws-auth-refresh", 3, 7, "Claude Code runs an AWS auth-refresh command", H.cred],
  ["claude.credential.aws-credential-export", 3, 7, "Claude Code runs an AWS credential-export command", H.cred],
  ["claude.env.anthropic-base-url", 4, 9, "Claude Code's model traffic is redirected by ANTHROPIC_BASE_URL", H.net],
  ["claude.env.egress-proxy", 3, 8, "Claude Code's traffic is sent through a proxy set in repository settings", H.net],
  ["claude.env.node-options", 2, 9, "Claude Code starts with NODE_OPTIONS from repository settings", H.env],
  ["claude.env.path", 2, 8, "Claude Code's PATH is changed by repository settings", H.env],
  ["claude.hook.command", 3, 7, "A Claude Code hook runs a shell command", H.hook],
  ["claude.inline-shell.command", 3, 6, "A Claude Code command or skill runs inline shell", H.hook],
  ["claude.mcp.auto-approve", 4, 7, "Claude Code auto-approves project MCP servers", H.autoApprove],
  ["claude.mcp.headers-helper", 3, 6, "A Claude Code MCP server's headers come from a helper command", H.cred],
  ["claude.mcp.server", 2, 5, "Claude Code starts an MCP server declared in the repository", H.mcp],
  ["claude.payload.bundled-script", 2, 4, "A Claude Code plugin or skill bundles a script", H.script],
  ["claude.payload.referenced-script", 2, 4, "Claude Code settings reference a script in the repository", H.script],
  ["claude.permissions.allowed-shell", 4, 6, "Claude Code pre-approves shell commands", H.perm],
  ["claude.permissions.permissive-default-mode", 4, 8, "Claude Code's default permission mode skips approval", H.mode],
  ["claude.plugin.executable", 2, 5, "A Claude Code plugin ships an executable", H.script],
  ["claude.plugin.installed", 1, 3, "A Claude Code plugin is declared", "Informational: confirm the plugin is one your organisation approves."],
  ["claude.plugin.lsp-server", 2, 5, "A Claude Code plugin starts a language server", H.script],
  ["claude.preview.command", 2, 5, "A Claude preview server runs a command", H.hook],
  ["claude.sandbox.dangerous-socket", 4, 9, "Claude Code's sandbox admits a privileged socket", H.socket],
  ["claude.sandbox.unix-socket", 2, 5, "Claude Code's sandbox admits a Unix socket", H.sandbox],
  ["claude.statusline.command", 2, 5, "Claude Code's status line runs a command", H.hook],
  ["codex.approval.never", 4, 8, "Codex never asks before running commands", H.mode],
  ["codex.hook.command", 3, 7, "A Codex hook runs a shell command", H.hook],
  ["codex.hook.mcp-tool", 2, 5, "A Codex hook calls an MCP tool", H.hook],
  ["codex.mcp.env-forward", 3, 6, "A Codex MCP server receives environment variables", H.cred],
  ["codex.mcp.headers-helper", 3, 6, "A Codex MCP server's headers come from a helper command", H.cred],
  ["codex.mcp.server", 2, 5, "Codex starts an MCP server declared in the repository", H.mcp],
  ["codex.network.all-unix-sockets", 3, 8, "Codex's sandbox admits every Unix socket", H.socket],
  ["codex.network.local-binding", 2, 4, "Codex's sandbox may bind local ports", H.sandbox],
  ["codex.network.non-loopback-proxy", 3, 7, "Codex's traffic goes through a non-loopback proxy", H.net],
  ["codex.network.sandbox-network-access", 3, 6, "Codex's sandbox has network access", H.sandbox],
  ["codex.payload.skill-script", 2, 4, "A Codex skill bundles a script", H.script],
  ["codex.permissions.filesystem-read", 2, 4, "Codex is granted read access to a path", H.path],
  ["codex.permissions.filesystem-write", 3, 6, "Codex is granted write access to a path", H.path],
  ["codex.permissions.network-domain", 2, 3, "Codex is allowed to reach a domain", H.sandbox],
  ["codex.permissions.network-enabled", 3, 5, "Codex's permission profile enables the network", H.sandbox],
  ["codex.permissions.profile-full-access", 4, 9, "A Codex permission profile grants full access", H.mode],
  ["codex.permissions.unix-socket", 2, 5, "Codex is granted a Unix socket", H.sandbox],
  ["codex.permissions.workspace-root", 2, 3, "Codex's workspace root is widened", H.path],
  ["codex.sandbox.full-access", 4, 9, "Codex runs with sandbox full access", H.sandbox],
  ["codex.sandbox.writable-root", 3, 5, "Codex's sandbox has an extra writable root", H.path],
  ["cursor.hook.command", 3, 7, "A Cursor hook runs a shell command", H.hook],
  ["cursor.hook.workspace-open", 4, 8, "A Cursor hook runs a command when the workspace opens", H.hook],
  ["cursor.mcp.server", 2, 5, "Cursor starts an MCP server declared in the repository", H.mcp],
  ["cursor.network.egress-allowed-by-default", 3, 6, "Cursor's sandbox allows egress by default", H.sandbox],
  ["cursor.network.egress-allowed-pattern", 2, 3, "Cursor's sandbox allows egress to a pattern", H.sandbox],
  ["cursor.payload.hook-script", 2, 4, "A Cursor hook runs a script in the repository", H.script],
  ["cursor.payload.skill-script", 2, 4, "A Cursor skill bundles a script", H.script],
  ["cursor.permissions.auto-run-instructions", 4, 7, "Cursor auto-runs commands on instruction", H.perm],
  ["cursor.permissions.granted-tool", 3, 4, "Cursor pre-approves a tool or command", H.perm],
  ["cursor.permissions.wildcard-grant", 4, 7, "Cursor pre-approves a wildcard", H.perm],
  ["cursor.provisioner.environment-command", 3, 6, "Cursor's background-agent environment runs a command", H.hook],
  ["cursor.provisioner.environment-image", 2, 4, "Cursor's background-agent environment builds an image", H.script],
  ["cursor.provisioner.worktree-setup", 3, 6, "Cursor runs a setup command for each worktree", H.hook],
  ["cursor.sandbox.disabled", 4, 8, "Cursor's sandbox is turned off", H.sandbox],
  ["cursor.sandbox.readable-path", 2, 3, "Cursor's sandbox can read an extra path", H.path],
  ["cursor.sandbox.writable-path", 3, 5, "Cursor's sandbox can write an extra path", H.path],
];

/** our complementary rules (auditAgentConfigFiles), and the one for an unknown engine rule */
const REGULAIT_RULES: readonly RuleRow[] = [
  ["regulait.mcp.unpinned-package", 5, 6, "An MCP server's package is not pinned to an exact version", "Pin the package to an exact version (for example `pkg@1.2.3`), never `@latest` or a range, so a new release cannot change what runs."],
  ["regulait.mcp.remote-plaintext", 3, 6, "A remote MCP server is reached over plain HTTP", "Use an `https://` URL; plain HTTP exposes tool calls and tokens on the network."],
  ["regulait.hook.remote-code", 4, 9, "A configured command downloads and runs remote code", "Do not pipe a download into a shell. Vendor the script into the repository, pin it by digest, and review it."],
  ["regulait.secret.literal", 6, 9, "A credential is written into agent configuration", "Remove the credential, rotate it now, and reference it from the environment or a secret store instead."],
  ["regulait.instructions.prompt-injection", 3, 8, "Agent instructions contain prompt-injection phrasing", "Review the instruction text; remove directives that override the agent's rules, hide actions from the user or send data out."],
  ["regulait.instructions.hidden-unicode", 3, 10, "Agent configuration contains hidden Unicode", "Remove the invisible characters (zero-width, bidi-control or Unicode-tag); they hide text from reviewers."],
  ["regulait.vscode.auto-approve", 4, 8, "VS Code auto-approves agent tool calls", "Remove `chat.tools.global.autoApprove` (or the older `chat.tools.autoApprove`) from workspace settings."],
  ["regulait.vscode.terminal-auto-approve", 4, 6, "VS Code pre-approves terminal commands", "Remove the `chat.tools.terminal.autoApprove` entries that are `true` from workspace settings; let each person approve commands in their own settings."],
  ["regulait.vscode.url-auto-approve", 3, 6, "VS Code auto-approves agent requests to URLs", "Remove the `chat.tools.urls.autoApprove` entries that are `true` from workspace settings."],
  ["regulait.vscode.mcp.server", 2, 5, "VS Code starts an MCP server declared in the repository", H.mcp],
  ["regulait.instructions.present", 1, 2, "The repository carries agent instruction files", "Informational: instruction files steer every agent that opens the repository; review changes to them like code."],
  ["agentaudit.unmapped", 3, 5, "agentaudit reported a rule this catalogue does not know yet", "Review the finding against agentaudit's rule reference; the catalogue will be updated with its score."],
];

function toRule(source: AgentConfigRule["source"]) {
  return ([id, frequency, impact, title, fixHint]: RuleRow): AgentConfigRule => ({ id, source, title, frequency, impact, fixHint });
}

export const AGENT_CONFIG_RULES: ReadonlyMap<string, AgentConfigRule> = new Map(
  [...AGENTAUDIT_RULES.map(toRule("agentaudit")), ...REGULAIT_RULES.map(toRule("regulait"))].map((r) => [r.id, Object.freeze(r)]),
);

/** the ids agentaudit v0.1.2 can emit (the catalogue's engine half) */
export const AGENTAUDIT_RULE_IDS: readonly string[] = Object.freeze(AGENTAUDIT_RULES.map((r) => r[0]));

/** F × S below this is informational (owner, 2026-11-17) */
export const AGENT_CONFIG_INFORMATIONAL_BELOW = 5;

/** the score bands: below 5 info, then low, medium, high and critical */
export function agentConfigSeverity(score: number): AgentConfigSeverity {
  if (score < AGENT_CONFIG_INFORMATIONAL_BELOW) return "info";
  if (score < 15) return "low";
  if (score < 30) return "medium";
  if (score < 60) return "high";
  return "critical";
}

export function agentConfigSeverityAtLeast(s: AgentConfigSeverity, floor: AgentConfigSeverity): boolean {
  return AGENT_CONFIG_SEVERITIES.indexOf(s) >= AGENT_CONFIG_SEVERITIES.indexOf(floor);
}

/** a digest over the whole catalogue, so a stored finding names the exact scoring it was made under */
export function agentConfigRulesDigest(): string {
  const rows = [...AGENT_CONFIG_RULES.values()].map((r) => [r.id, r.source, r.frequency, r.impact, r.title, r.fixHint]);
  return createHash("sha256").update(JSON.stringify([AGENT_CONFIG_RULES_VERSION, rows]), "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// The finding
// ---------------------------------------------------------------------------

export interface AgentConfigFinding {
  rule: string;
  source: AgentConfigRule["source"];
  /** the agent the setting is for (claude-code, codex, cursor, vscode) or "any" */
  agent: string;
  categories: string[];
  file: string;
  /** the key path inside the file (engine findings), when known */
  key: string | null;
  /** the 1-based line (complementary findings), when known */
  line: number | null;
  frequency: number;
  impact: number;
  score: number;
  severity: AgentConfigSeverity;
  informational: boolean;
  title: string;
  fixHint: string;
  /** how many times the rule matched at this location */
  count: number;
  /** for agentaudit.unmapped: the engine's rule id */
  engineRule?: string;
}

function makeFinding(
  ruleId: string,
  at: { agent: string; categories: readonly string[]; file: string; key?: string | null; line?: number | null; count?: number; engineRule?: string },
): AgentConfigFinding {
  const rule = AGENT_CONFIG_RULES.get(ruleId) ?? AGENT_CONFIG_RULES.get("agentaudit.unmapped")!;
  const score = rule.frequency * rule.impact;
  const severity = agentConfigSeverity(score);
  return {
    rule: rule.id,
    source: rule.source,
    agent: at.agent,
    categories: [...at.categories].sort(),
    file: at.file,
    key: at.key ?? null,
    line: at.line ?? null,
    frequency: rule.frequency,
    impact: rule.impact,
    score,
    severity,
    informational: severity === "info",
    title: rule.title,
    fixHint: rule.fixHint,
    count: at.count ?? 1,
    ...(at.engineRule ? { engineRule: at.engineRule } : {}),
  };
}

// ---------------------------------------------------------------------------
// The engine's report, read strictly (fail closed)
// ---------------------------------------------------------------------------

const ruleIdText = z.string().min(1).max(128).regex(/^[a-z0-9][a-z0-9.-]*$/);
const shortText = z.string().max(64).regex(/^[a-z0-9-]*$/);
const pathText = z.string().max(AGENT_CONFIG_LIMITS.maxPathBytes);

export const agentConfigAuditReportSchema = z.discriminatedUnion("status", [
  z
    .object({
      schema: z.literal(AGENT_CONFIG_AUDIT_REPORT_SCHEMA),
      status: z.literal("completed"),
      engine: z.literal("agentaudit"),
      engineVersion: z.string().max(64),
      inputSha256: z.string().regex(/^[0-9a-f]{64}$/),
      filesScanned: z.number().int().min(0).max(AGENT_CONFIG_LIMITS.maxFiles),
      scannedAgents: z.array(shortText).max(16),
      unreadableSources: z.number().int().min(0),
      unparsedSources: z.number().int().min(0),
      omittedFindings: z.number().int().min(0),
      warnings: z.number().int().min(0),
      findings: z
        .array(
          z
            .object({
              rule: ruleIdText,
              agent: shortText,
              categories: z.array(shortText).max(16),
              file: pathText,
              key: z.string().max(AGENT_CONFIG_LIMITS.maxKeyBytes),
            })
            .strict(),
        )
        .max(AGENT_CONFIG_LIMITS.maxFindings),
      durationMs: z.number().int().min(0),
    })
    .strict(),
  z
    .object({
      schema: z.literal(AGENT_CONFIG_AUDIT_REPORT_SCHEMA),
      status: z.literal("failed"),
      error: z.string().min(1).max(64),
      engine: z.literal("agentaudit"),
      engineVersion: z.string().max(64),
      filesScanned: z.number().int().min(0),
      scannedAgents: z.array(shortText).max(16),
      unreadableSources: z.number().int().min(0),
      unparsedSources: z.number().int().min(0),
      omittedFindings: z.number().int().min(0),
      warnings: z.number().int().min(0),
      findings: z.array(z.unknown()).max(0),
      durationMs: z.number().int().min(0),
    })
    .strict(),
]);
export type AgentConfigAuditReport = z.infer<typeof agentConfigAuditReportSchema>;

/** completed: every source read; incomplete: findings stand but the scan missed something; unknown: no usable report */
export const AGENT_CONFIG_SCAN_STATUSES = ["completed", "incomplete", "unknown"] as const;
export type AgentConfigScanStatus = (typeof AGENT_CONFIG_SCAN_STATUSES)[number];

export interface AgentConfigEngineResult {
  status: AgentConfigScanStatus;
  /** why the result is not `completed`, as a short code */
  reason: string | null;
  findings: AgentConfigFinding[];
  scannedAgents: string[];
}

/**
 * Read the driver's report. A report that does not parse, names another engine version, or is about another input
 * is `unknown` with no findings. One that could not read or parse a source, or omitted findings, is `incomplete`:
 * its findings stand, and the scan is never treated as clean.
 */
export function interpretAgentConfigAuditReport(raw: unknown, expect: { inputSha256: string }): AgentConfigEngineResult {
  const unknown = (reason: string): AgentConfigEngineResult => ({ status: "unknown", reason, findings: [], scannedAgents: [] });
  let doc = raw;
  if (typeof raw === "string" || raw instanceof Uint8Array) {
    try {
      doc = JSON.parse(typeof raw === "string" ? raw : Buffer.from(raw).toString("utf8"));
    } catch {
      return unknown("report_invalid");
    }
  }
  const parsed = agentConfigAuditReportSchema.safeParse(doc);
  if (!parsed.success) return unknown("report_invalid");
  const r = parsed.data;
  if (r.engineVersion !== AGENT_CONFIG_AUDIT_ENGINE.version) return unknown("engine_version_mismatch");
  if (r.status === "failed") return unknown(r.error);
  if (r.inputSha256 !== expect.inputSha256) return unknown("report_input_mismatch");
  const merged = new Map<string, AgentConfigFinding>();
  for (const f of r.findings) {
    const known = AGENT_CONFIG_RULES.get(f.rule);
    const id = known && known.source === "agentaudit" ? f.rule : "agentaudit.unmapped";
    const key = JSON.stringify([id, f.rule, f.agent, f.file, f.key]);
    const prev = merged.get(key);
    if (prev) prev.count += 1;
    else
      merged.set(
        key,
        makeFinding(id, { agent: f.agent, categories: f.categories, file: f.file, key: f.key || null, ...(id === f.rule ? {} : { engineRule: f.rule }) }),
      );
  }
  const reason =
    r.unreadableSources > 0 ? "source_unreadable" : r.unparsedSources > 0 ? "source_unparsed" : r.omittedFindings > 0 ? "findings_omitted" : null;
  return { status: reason ? "incomplete" : "completed", reason, findings: sortFindings([...merged.values()]), scannedAgents: r.scannedAgents };
}

// ---------------------------------------------------------------------------
// The complementary rules (in process, pure)
// ---------------------------------------------------------------------------

/** a JSON or JSONC document with node locations (momoa, MIT: already a dependency), or null */
function parseJsonDoc(text: string): DocumentNode | null {
  try {
    return parseJsonSyntax(text, { mode: "jsonc", allowTrailingCommas: true });
  } catch {
    return null;
  }
}

type JsonNode = AnyNode;

function member(node: JsonNode | undefined, name: string): JsonNode | undefined {
  if (!node || node.type !== "Object") return undefined;
  for (const m of node.members) {
    const k = m.name.type === "String" ? m.name.value : m.name.name;
    if (k === name) return m.value;
  }
  return undefined;
}

function entries(node: JsonNode | undefined): { name: string; value: JsonNode; line: number }[] {
  if (!node || node.type !== "Object") return [];
  return node.members.map((m) => ({ name: m.name.type === "String" ? m.name.value : m.name.name, value: m.value, line: m.loc.start.line }));
}

function str(node: JsonNode | undefined): string | null {
  return node && node.type === "String" ? node.value : null;
}

function strings(node: JsonNode | undefined): string[] {
  return node && node.type === "Array" ? node.elements.map((e) => str(e.value)).filter((s): s is string => s !== null) : [];
}

/** package runners whose first package argument is fetched from a registry at start */
const RUNNERS: Readonly<Record<string, "npm" | "pypi">> = { npx: "npm", bunx: "npm", pnpx: "npm", uvx: "pypi", pipx: "pypi" };

/** the package an MCP launcher fetches, when the command is a package runner; null otherwise */
export function launchedPackage(command: string, args: readonly string[]): { ecosystem: "npm" | "pypi"; spec: string } | null {
  const tokens = [...command.trim().split(/\s+/), ...args].filter((t) => t.length > 0);
  if (tokens.length === 0) return null;
  const prog = (tokens[0]!.split(/[\\/]/).pop() ?? "").replace(/\.(?:cmd|exe)$/i, "");
  let rest = tokens.slice(1);
  let ecosystem = RUNNERS[prog];
  if (!ecosystem && (prog === "pnpm" || prog === "yarn" || prog === "bun") && (rest[0] === "dlx" || rest[0] === "x")) {
    ecosystem = "npm";
    rest = rest.slice(1);
  }
  if (!ecosystem) return null;
  if (prog === "pipx" && rest[0] === "run") rest = rest.slice(1);
  if (prog === "uvx" || prog === "pipx") {
    // `uvx --from pkg==1.2 tool`: the --from spec is the package
    const from = rest.indexOf("--from");
    if (from >= 0 && rest[from + 1]) return { ecosystem, spec: rest[from + 1]! };
  }
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i]!;
    if (t === "--package" || t === "-p") return rest[i + 1] ? { ecosystem, spec: rest[i + 1]! } : null;
    if (t.startsWith("--package=")) return { ecosystem, spec: t.slice("--package=".length) };
    if (t.startsWith("-")) continue;
    return { ecosystem, spec: t };
  }
  return null;
}

/** true when a package spec names one exact version (npm `name@1.2.3`, PyPI `name==1.2.3`) */
export function isPinnedPackageSpec(ecosystem: "npm" | "pypi", spec: string): boolean {
  if (ecosystem === "pypi") {
    // `name==1.2.3` (pip, pipx, `uvx --from`) or uv's own `name@1.2.3` (review R4 [2]); a PEP 440 version, never
    // `@latest` or a range
    return /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\[[^\]]*\])?(?:==|@)(?:\d+!)?\d+(?:\.\d+)*(?:(?:a|b|rc)\d+)?(?:\.post\d+)?(?:\.dev\d+)?(?:\+[0-9A-Za-z.]+)?$/.test(spec);
  }
  // a local path or URL is not a registry fetch; a tarball URL is still remote and unpinned
  if (spec.startsWith(".") || spec.startsWith("/")) return true;
  const at = spec.startsWith("@") ? spec.indexOf("@", 1) : spec.indexOf("@");
  if (at <= 0) return false;
  const version = spec.slice(at + 1);
  return /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version);
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1", "0.0.0.0"]);

/** a command that downloads and runs code in one step */
const REMOTE_CODE_RE: readonly RegExp[] = [
  /\b(?:curl|wget|fetch)\b[^\n|;&]{0,400}\|\s*(?:sudo\s+)?(?:ba|z|da|k)?sh\b/i,
  /\b(?:curl|wget)\b[^\n|;&]{0,400}\|\s*(?:sudo\s+)?(?:python3?|node|perl|ruby|php)\b/i,
  /\b(?:ba|z)?sh\s+(?:-c\s+)?["']?\$?\(\s*(?:curl|wget)\b/i,
  /\b(?:ba|z)?sh\s+<\(\s*(?:curl|wget)\b/i,
  /\b(?:iex|invoke-expression)\b[^\n]{0,80}\b(?:iwr|irm|invoke-webrequest|invoke-restmethod|downloadstring|net\.webclient)\b/i,
  /\b(?:iwr|irm|invoke-webrequest|invoke-restmethod)\b[^\n]{0,400}\|\s*(?:iex|invoke-expression)\b/i,
];

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

/** the first line on which a pattern matches, or null */
function firstLine(text: string, re: RegExp): number | null {
  const flags = re.flags.includes("g") ? re.flags : `${re.flags}g`;
  const g = new RegExp(re.source, flags);
  const m = g.exec(text);
  return m ? lineOf(text, m.index) : null;
}

function agentOfPath(path: string): string {
  if (path.startsWith(".claude") || path === ".mcp.json" || /(?:^|\/)CLAUDE(?:\.local)?\.md$/.test(path)) return "claude-code";
  if (path.startsWith(".cursor")) return "cursor";
  if (path.startsWith(".codex")) return "codex";
  if (path.startsWith(".vscode/") || path.startsWith(".github/")) return "vscode";
  return "any";
}

/** each MCP server table in a JSON config: `mcpServers` (Claude, Cursor) or `servers` (VS Code) */
function mcpServerEntries(doc: DocumentNode): { name: string; line: number; command: string | null; args: string[]; url: string | null }[] {
  const root = doc.body;
  const table = member(root, "mcpServers") ?? member(root, "servers");
  return entries(table).map((e) => ({
    name: e.name,
    line: e.line,
    command: str(member(e.value, "command")),
    args: strings(member(e.value, "args")),
    url: str(member(e.value, "url")) ?? str(member(e.value, "serverUrl")),
  }));
}

/** each MCP server in Codex's TOML (`[mcp_servers.<name>]`) */
function codexMcpEntries(text: string): { name: string; line: number; command: string | null; args: string[]; url: string | null }[] {
  let doc: Record<string, unknown>;
  try {
    doc = parseToml(text) as Record<string, unknown>;
  } catch {
    return [];
  }
  const table = doc["mcp_servers"];
  if (!table || typeof table !== "object" || Array.isArray(table)) return [];
  return Object.entries(table as Record<string, unknown>).map(([name, raw]) => {
    const s = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
    const line = firstLine(text, new RegExp(`^\\s*\\[\\s*mcp_servers\\.(?:"${escapeRe(name)}"|${escapeRe(name)})\\s*\\]`, "m"));
    return {
      name,
      line: line ?? 1,
      command: typeof s.command === "string" ? s.command : null,
      args: Array.isArray(s.args) ? s.args.filter((a): a is string => typeof a === "string") : [],
      url: typeof s.url === "string" ? s.url : null,
    };
  });
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** the hidden-Unicode, injection and credential rules of the admission scanner, mapped to ours */
function admissionRuleToOurs(rule: string, instruction: boolean): string | null {
  if (rule.startsWith("mcp.hidden_unicode.")) return "regulait.instructions.hidden-unicode";
  if (rule === "guardrail.semantic_dlp.credential_material") return "regulait.secret.literal";
  if (rule.startsWith("guardrail.semantic_dlp.")) return null;
  // injection phrasing is a finding in text addressed to the model; in a JSON value it is the MCP rules' job
  if (rule.startsWith("guardrail.prompt_injection.") || rule.startsWith("mcp.")) return instruction ? "regulait.instructions.prompt-injection" : null;
  return null;
}

/**
 * The complementary audit over the selected files. Line numbers are found by re-reading a flagged file line by
 * line, so a location is always the first line that matched.
 */
export function auditAgentConfigFiles(files: readonly AgentConfigFile[]): AgentConfigFinding[] {
  const out: AgentConfigFinding[] = [];
  const add = (rule: string, file: string, line: number | null, categories: readonly string[], count = 1) =>
    out.push(makeFinding(rule, { agent: agentOfPath(file), categories, file, line, count }));
  let instructionFiles = 0;
  for (const f of files) {
    if (!isAgentConfigPath(f.path) || f.content.length === 0 || Buffer.byteLength(f.content, "utf8") > AGENT_CONFIG_LIMITS.maxFileBytes) continue;
    const instruction = isInstructionPath(f.path);
    if (instruction) instructionFiles++;

    // 1. text rules on every file: hidden Unicode, credentials, injection phrasing (instruction files only)
    const byRule = new Map<string, number>();
    for (const hit of scanAdmissionUnits(f.path, [{ where: f.path, text: f.content }], { skipRules: SKILL_SKIPPED_MCP_RULES })) {
      const ours = admissionRuleToOurs(hit.rule, instruction);
      if (ours) byRule.set(ours, (byRule.get(ours) ?? 0) + hit.count);
    }
    for (const [rule, count] of byRule) {
      add(rule, f.path, firstFlaggedLine(f.content, rule, instruction), rule === "regulait.secret.literal" ? ["credential-access"] : ["prompt-injection"], count);
    }

    // 2. remote code: a download piped into an interpreter, in any config or instruction file
    for (const re of REMOTE_CODE_RE) {
      const line = firstLine(f.content, re);
      if (line !== null) {
        add("regulait.hook.remote-code", f.path, line, ["code-execution"]);
        break;
      }
    }

    // 3. MCP servers in JSON configs (and Codex TOML): pinning and plaintext transport
    const servers = f.path.endsWith(".toml")
      ? f.path.startsWith(".codex/")
        ? codexMcpEntries(f.content)
        : []
      : f.path.endsWith(".json")
        ? (() => {
            const doc = parseJsonDoc(f.content);
            return doc ? mcpServerEntries(doc) : [];
          })()
        : [];
    for (const s of servers) {
      if (f.path === ".vscode/mcp.json") add("regulait.vscode.mcp.server", f.path, s.line, ["code-execution"]);
      if (s.command) {
        const pkg = launchedPackage(s.command, s.args);
        if (pkg && !isPinnedPackageSpec(pkg.ecosystem, pkg.spec)) add("regulait.mcp.unpinned-package", f.path, s.line, ["code-execution"]);
      }
      if (s.url) {
        try {
          const u = new URL(s.url);
          if (u.protocol === "http:" && !LOOPBACK.has(u.hostname)) add("regulait.mcp.remote-plaintext", f.path, s.line, ["network-access"]);
        } catch {
          // an unparseable URL is the engine's or the client's problem; it starts nothing
        }
      }
    }

    // 4. VS Code workspace auto-approval (names verified against code.visualstudio.com, 2026-11-17)
    if (f.path === ".vscode/settings.json") {
      const doc = parseJsonDoc(f.content);
      for (const e of entries(doc?.body)) {
        if ((e.name === "chat.tools.global.autoApprove" || e.name === "chat.tools.autoApprove") && e.value.type === "Boolean" && e.value.value) {
          add("regulait.vscode.auto-approve", f.path, e.line, ["permissions"]);
        }
        if (e.name === "chat.tools.terminal.autoApprove") {
          // a rule approves when its value is `true` or `{ approve: true }` (code.visualstudio.com, checked 2026-11-21)
          const approved = entries(e.value).filter(
            (u) => (u.value.type === "Boolean" && u.value.value) || (u.value.type === "Object" && entries(u.value).some((x) => x.name === "approve" && x.value.type === "Boolean" && x.value.value)),
          );
          if (approved.length > 0) add("regulait.vscode.terminal-auto-approve", f.path, approved[0]!.line, ["permissions"], approved.length);
        }
        if (e.name === "chat.tools.urls.autoApprove") {
          const approved = entries(e.value).filter(
            (u) => (u.value.type === "Boolean" && u.value.value) || (u.value.type === "Object" && entries(u.value).some((x) => x.value.type === "Boolean" && x.value.value)),
          );
          if (approved.length > 0) add("regulait.vscode.url-auto-approve", f.path, approved[0]!.line, ["permissions"], approved.length);
        }
      }
    }
  }
  if (instructionFiles > 0) {
    const first = files.filter((f) => isAgentConfigPath(f.path) && isInstructionPath(f.path)).map((f) => f.path).sort()[0]!;
    add("regulait.instructions.present", first, null, ["instructions"], instructionFiles);
  }
  return sortFindings(out);
}

/** the first line of a file whose text alone raises the rule (null when only the whole file does) */
function firstFlaggedLine(text: string, rule: string, instruction: boolean): number | null {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim()) continue;
    for (const hit of scanAdmissionUnits("line", [{ where: "line", text: line }], { skipRules: SKILL_SKIPPED_MCP_RULES })) {
      if (admissionRuleToOurs(hit.rule, instruction) === rule) return i + 1;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Merging, and the PR check's verdict
// ---------------------------------------------------------------------------

const SEVERITY_RANK = (s: AgentConfigSeverity) => AGENT_CONFIG_SEVERITIES.indexOf(s);

export function sortFindings(findings: AgentConfigFinding[]): AgentConfigFinding[] {
  return findings.sort(
    (a, b) =>
      SEVERITY_RANK(b.severity) - SEVERITY_RANK(a.severity) ||
      b.score - a.score ||
      (a.file < b.file ? -1 : a.file > b.file ? 1 : 0) ||
      (a.line ?? 0) - (b.line ?? 0) ||
      (a.key ?? "").localeCompare(b.key ?? "") ||
      a.rule.localeCompare(b.rule),
  );
}

export interface AgentConfigAudit {
  status: AgentConfigScanStatus;
  reason: string | null;
  findings: AgentConfigFinding[];
  rulesVersion: string;
  rulesDigest: string;
  engineVersion: string;
}

/**
 * One audit from the engine's result and the complementary findings. A bundle that left a config file out makes the
 * audit incomplete; an engine result that is unknown makes the whole audit unknown (its findings are not a scan).
 */
export function composeAgentConfigAudit(args: {
  engine: AgentConfigEngineResult;
  complementary: readonly AgentConfigFinding[];
  skipped: AgentConfigBundle["skipped"];
}): AgentConfigAudit {
  const base = { rulesVersion: AGENT_CONFIG_RULES_VERSION, rulesDigest: agentConfigRulesDigest(), engineVersion: AGENT_CONFIG_AUDIT_ENGINE.version };
  const findings = sortFindings([...args.engine.findings, ...args.complementary]);
  if (args.engine.status === "unknown") return { status: "unknown", reason: args.engine.reason, findings: sortFindings([...args.complementary]), ...base };
  const configSkipped = args.skipped.some((s) => s.reason !== "not_config" && s.reason !== "duplicate");
  if (configSkipped) return { status: "incomplete", reason: "bundle_incomplete", findings, ...base };
  return { status: args.engine.status, reason: args.engine.reason, findings, ...base };
}

export const AGENT_CONFIG_FAIL_ON = ["low", "medium", "high", "critical"] as const;
export type AgentConfigFailOn = (typeof AGENT_CONFIG_FAIL_ON)[number];
/** ADR-0180: the strict default. Any finding that is not informational fails the check; an admin may relax it. */
export const AGENT_CONFIG_DEFAULT_FAIL_ON: AgentConfigFailOn = "low";

export interface AgentConfigCheckVerdict {
  outcome: "passed" | "failed";
  reason: string;
  failing: number;
  informational: number;
}

/**
 * The PR check's verdict: it FAILS on any finding at or above `failOn`, and when the audit is incomplete or unknown
 * (a scan that missed something never passes). Informational findings never fail it.
 */
export function agentConfigCheckVerdict(audit: Pick<AgentConfigAudit, "status" | "reason" | "findings">, failOn: AgentConfigFailOn = AGENT_CONFIG_DEFAULT_FAIL_ON): AgentConfigCheckVerdict {
  const informational = audit.findings.filter((f) => f.informational).length;
  const failing = audit.findings.filter((f) => !f.informational && agentConfigSeverityAtLeast(f.severity, failOn)).length;
  if (audit.status !== "completed") {
    return { outcome: "failed", reason: `agent-config audit ${audit.status}${audit.reason ? ` (${audit.reason})` : ""}`, failing, informational };
  }
  if (failing > 0) return { outcome: "failed", reason: `${failing} agent-config finding(s) at or above ${failOn}`, failing, informational };
  return { outcome: "passed", reason: informational > 0 ? `no finding at or above ${failOn} (${informational} informational)` : "no agent-config findings", failing, informational };
}
