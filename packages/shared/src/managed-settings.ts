/**
 * ADR-0310 (G2) — compile a subject's effective MCP entitlements into vendor-native managed settings.
 *
 * Pure and zero-I/O: the gateway resolves the policy (pillar 1 is the source of truth) and this module only renders it.
 * Every output is DEFAULT-DENY: a subject with no entitled server gets an explicit empty allowlist (`[]`, or an empty
 * `[mcp_servers]` table for Codex), never an absent key, because every vendor reads an absent allowlist as "allow all".
 *
 * Each entitled server is named by its governed gateway URL (`<public url>/mcp/<server id>`), never by its upstream
 * URL: the managed setting admits the gateway, and the gateway's own kernel decides each tool call. That is why the
 * per-tool lists below are informational for vendors that cannot express a tool rule, and why nothing here can widen
 * what the gateway allows.
 *
 * Vendor schemas, checked against each vendor's own documentation on 2026-11-15 (citations in ADR-0310):
 *  - Claude Code `managed-settings.json`: `allowedMcpServers` / `deniedMcpServers` entries `{serverUrl}`,
 *    `allowManagedMcpServersOnly`, `permissions.disableBypassPermissionsMode`, `requiredMinimumVersion`.
 *  - GitHub Copilot `managed-settings.json` (also `.github-private/copilot/managed-settings.json`): the same matcher
 *    shape; no MCP per-tool selector.
 *  - OpenAI Codex `requirements.toml`: `[mcp_servers.<id>] identity = { url = "…" }`; both the id and the identity
 *    must match; an empty `mcp_servers` table disables MCP.
 *  - Cursor: the MCP allowlist is set only in the team dashboard (no file, no Admin API endpoint), so the bundle
 *    carries a worksheet for an admin to apply by hand and says so.
 */
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";

export const MANAGED_SETTINGS_SCHEMA = "regulait.managed-settings/v1";

export const MANAGED_SETTINGS_VENDORS = ["claude-code", "github-copilot", "openai-codex", "cursor"] as const;
export type ManagedSettingsVendor = (typeof MANAGED_SETTINGS_VENDORS)[number];

export interface EffectiveMcpServer {
  /** the registry id (`mcp_servers.id`) */
  serverId: string;
  /** the registry name, as an admin knows it */
  name: string;
  /** the governed gateway endpoint for this server: `<public url>/mcp/<server id>` */
  gatewayUrl: string;
  /** tool names the subject is entitled to see on this server (kernel `visibleTools`), sorted */
  tools: string[];
}

export interface EffectiveMcpPolicy {
  subject: { kind: "user" | "role"; id: string };
  /** sorted by gatewayUrl; empty = the subject is entitled to nothing (default deny) */
  servers: EffectiveMcpServer[];
}

export interface CompileOptions {
  /** Claude Code `requiredMinimumVersion` (managed-only; refuses to start below it). Semver `x.y.z`. */
  claudeCodeMinimumVersion?: string;
}

export interface CompiledFile {
  path: string;
  vendor: ManagedSettingsVendor;
  /** where an admin installs it; `manual` files are instructions, not a file a client reads */
  delivery: "mdm-or-file" | "manual";
  body: string;
}

const SEMVER = /^\d{1,4}\.\d{1,4}\.\d{1,6}$/;

/** The only error the compilers throw: a fixed message naming a registry id, never caller text or a parse error. */
export class ManagedSettingsCompileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManagedSettingsCompileError";
  }
}

/** A Codex `[mcp_servers.<id>]` key and a Claude Code server label: `[A-Za-z0-9_-]`, bounded, never empty. */
export function managedServerKey(name: string, serverId: string): string {
  // input bounded first, then one linear pass; trimming '-' with a loop, never `/-+$/` (CodeQL js/polynomial-redos)
  const mapped = name.slice(0, 256).toLowerCase().replace(/[^a-z0-9_-]/g, "-");
  let start = 0;
  let end = mapped.length;
  while (start < end && mapped.charCodeAt(start) === 45) start++;
  while (end > start && mapped.charCodeAt(end - 1) === 45) end--;
  const slug = mapped.slice(start, end).slice(0, 48);
  // the id suffix keeps two registry names that slug alike (`My Docs`, `my-docs`) from colliding
  return `${slug || "server"}-${serverId.replace(/-/g, "").slice(0, 8)}`;
}

function normalised(policy: EffectiveMcpPolicy): EffectiveMcpPolicy {
  const servers = [...policy.servers]
    .map((s) => ({ ...s, tools: [...new Set(s.tools)].sort() }))
    .sort((a, b) => (a.gatewayUrl < b.gatewayUrl ? -1 : a.gatewayUrl > b.gatewayUrl ? 1 : 0));
  for (const s of servers) {
    let u: URL;
    try {
      u = new URL(s.gatewayUrl);
    } catch {
      throw new ManagedSettingsCompileError(`managed settings: server ${s.serverId} has an unparseable gateway URL`);
    }
    // a managed allowlist naming a plain-http or credentialed URL would teach clients to send tokens in the clear
    if (u.protocol !== "https:" && !(u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1"))) {
      throw new ManagedSettingsCompileError(`managed settings: gateway URL for server ${s.serverId} must be https`);
    }
    // Claude Code and Copilot read `*` in a serverUrl as a wildcard: an entry must name exactly one endpoint (#850 review)
    if (s.gatewayUrl.includes("*")) {
      throw new ManagedSettingsCompileError(`managed settings: gateway URL for server ${s.serverId} must not contain '*'`);
    }
    if (u.username || u.password || u.search || u.hash) {
      throw new ManagedSettingsCompileError(`managed settings: gateway URL for server ${s.serverId} must not carry credentials, a query or a fragment`);
    }
  }
  return { subject: policy.subject, servers };
}

/** Claude Code `managed-settings.json`. */
export function compileClaudeCode(policy: EffectiveMcpPolicy, opts: CompileOptions = {}): Record<string, unknown> {
  const p = normalised(policy);
  if (opts.claudeCodeMinimumVersion !== undefined && !SEMVER.test(opts.claudeCodeMinimumVersion)) {
    throw new ManagedSettingsCompileError("managed settings: claudeCodeMinimumVersion must be x.y.z");
  }
  return {
    $schema: "https://json.schemastore.org/claude-code-settings.json",
    // the managed list is authoritative: a user or project allowlist cannot widen it
    allowManagedMcpServersOnly: true,
    // default deny: [] admits no configured server; an absent key would admit all
    allowedMcpServers: p.servers.map((s) => ({ serverUrl: s.gatewayUrl })),
    deniedMcpServers: [],
    permissions: { disableBypassPermissionsMode: "disable" },
    ...(opts.claudeCodeMinimumVersion ? { requiredMinimumVersion: opts.claudeCodeMinimumVersion } : {}),
  };
}

/** GitHub Copilot `managed-settings.json` (file, MDM or `.github-private/copilot/managed-settings.json`). */
export function compileCopilot(policy: EffectiveMcpPolicy): Record<string, unknown> {
  const p = normalised(policy);
  return {
    allowedMcpServers: p.servers.map((s) => ({ serverUrl: s.gatewayUrl })),
    deniedMcpServers: [],
    permissions: { disableBypassPermissionsMode: "disable" },
  };
}

/** OpenAI Codex `requirements.toml`. */
export function compileCodex(policy: EffectiveMcpPolicy): string {
  const p = normalised(policy);
  const mcp: Record<string, { identity: { url: string } }> = {};
  for (const s of p.servers) mcp[managedServerKey(s.name, s.serverId)] = { identity: { url: s.gatewayUrl } };
  const header =
    "# RegulAIt managed requirements (ADR-0310). Generated; do not edit by hand.\n" +
    "# An empty [mcp_servers] table disables every MCP server: that is the default-deny case.\n";
  // smol-toml renders an empty table as `[mcp_servers]` (the test pins it); an omitted key would impose no limit
  return header + stringifyToml({ mcp_servers: mcp });
}

/** Cursor: no managed file exists for the MCP allowlist, so this is a worksheet an admin applies in the dashboard. */
export function compileCursorWorksheet(policy: EffectiveMcpPolicy): Record<string, unknown> {
  const p = normalised(policy);
  return {
    delivery: "manual",
    where: "Cursor team dashboard > MCP Configuration (Enterprise plan); no file or Admin API endpoint sets it",
    allowlistActive: true,
    note:
      p.servers.length === 0
        ? "turn the allowlist on with no entries: the subject is entitled to no MCP server"
        : "turn the allowlist on and add exactly these URL entries; per-server Tools lists what the gateway will allow",
    servers: p.servers.map((s) => ({ url: s.gatewayUrl, tools: s.tools })),
  };
}

/** Every vendor file for one policy, in a fixed order with stable bytes (sorted input, 2-space JSON). */
export function compileManagedSettings(policy: EffectiveMcpPolicy, opts: CompileOptions = {}): CompiledFile[] {
  const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;
  return [
    { path: "claude-code/managed-settings.json", vendor: "claude-code", delivery: "mdm-or-file", body: json(compileClaudeCode(policy, opts)) },
    { path: "github-copilot/managed-settings.json", vendor: "github-copilot", delivery: "mdm-or-file", body: json(compileCopilot(policy)) },
    { path: "openai-codex/requirements.toml", vendor: "openai-codex", delivery: "mdm-or-file", body: compileCodex(policy) },
    { path: "cursor/dashboard-worksheet.json", vendor: "cursor", delivery: "manual", body: json(compileCursorWorksheet(policy)) },
  ];
}

/** Canonical JSON of the normalised policy: what the bundle's `policyDigest` is taken over. */
export function canonicalPolicyJson(policy: EffectiveMcpPolicy): string {
  const p = normalised(policy);
  return JSON.stringify({
    subject: { kind: p.subject.kind, id: p.subject.id },
    servers: p.servers.map((s) => ({ serverId: s.serverId, name: s.name, gatewayUrl: s.gatewayUrl, tools: s.tools })),
  });
}

/** Parse a Codex `requirements.toml` (a compiled one, or one read back from a device for comparison). Throws on bad TOML. */
export function parseCodexRequirements(toml: string): Record<string, unknown> {
  return parseToml(toml) as Record<string, unknown>;
}

/**
 * ADR-0310 slice 2 (drift): the MCP config files each managed vendor reads, as paths relative to the ADR-0259
 * collection root (home, %APPDATA% or %LOCALAPPDATA%). A configured server in one of these files is under the
 * vendor's managed allowlist; one in any other host's file (Claude Desktop, Windsurf, Zed, …) is not, so drift is
 * reported only for these. A path matches when it equals the suffix or ends with "/" + the suffix, so the per-OS
 * prefixes (`Library/Application Support/`, `.config/`) need no entry. Data, not detection: the agent's signed
 * manifest decides which files are read.
 */
export const MANAGED_VENDOR_CONFIG_PATHS: Readonly<Record<ManagedSettingsVendor, readonly string[]>> = {
  "claude-code": [".claude.json", ".mcp.json", ".claude/settings.json"],
  "github-copilot": ["Code/User/mcp.json", "Code/User/settings.json", ".vscode/mcp.json"],
  "openai-codex": [".codex/config.toml"],
  cursor: [".cursor/mcp.json"],
};

/** The managed vendor whose MCP config this collection-root-relative path is, or null (drift does not apply). */
export function managedVendorOfConfigPath(configPath: string): ManagedSettingsVendor | null {
  const p = configPath.replace(/\\/g, "/");
  for (const v of MANAGED_SETTINGS_VENDORS) {
    if (MANAGED_VENDOR_CONFIG_PATHS[v].some((s) => p === s || p.endsWith(`/${s}`))) return v;
  }
  return null;
}

/**
 * Whether a remote MCP server host a device reported (ADR-0259: host and optional port, never a path) is this
 * gateway. Both sides are lowercased, and an explicit default port on either side matches its absence.
 */
export function isGatewayHost(reportedHost: string, publicUrl: string): boolean {
  let u: URL;
  try {
    u = new URL(publicUrl);
  } catch {
    return false;
  }
  const dflt = u.protocol === "https:" ? "443" : u.protocol === "http:" ? "80" : "";
  const strip = (h: string) => (dflt && h.endsWith(`:${dflt}`) ? h.slice(0, -(dflt.length + 1)) : h);
  return strip(reportedHost.toLowerCase()) === strip(u.host.toLowerCase());
}
