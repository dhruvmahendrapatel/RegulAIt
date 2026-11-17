/**
 * ADR-0350 §9 — one policy, every route. A declared catalogue of actions an agent can reach by more than one route
 * (an MCP tool, a CLI on the device, a direct HTTP call), and the compiler that turns a subject's gateway entitlements
 * into the device's action rules. The gateway decides the MCP route from the same entitlements (kernel
 * `visibleTools`, `EffectiveMcpPolicy`), so the two cannot disagree: an action is allowed on the device exactly when
 * the subject is entitled to its MCP tool at the gateway, and an admin override may only tighten it.
 *
 * Pure and zero-I/O. The Go agent embeds `ENDPOINT_ACTIONS` as `internal/enforce/actions.json`; CI
 * (`agents/endpoint/scripts/check-actions.mjs`) fails when the two differ. `endpoint-actions-conformance.json` is the
 * shared conformance fixture both the TypeScript and the Go suites run in full.
 */
import type { EffectiveMcpPolicy } from "./managed-settings.js";

export type ActionVerdict = "allow" | "ask" | "deny";

export interface EndpointActionHttp {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** exact host, lower case */
  host: string;
  /** a doublestar path glob, without query string */
  path: string;
}

export interface EndpointAction {
  /** canonical action id: `<system>.<object>.<verb>` */
  id: string;
  title: string;
  /** the MCP route: an upstream server identified by host, and the tools that perform the action */
  mcp: { upstreamHosts: string[]; tools: string[] };
  /** the CLI route: argv glob lists, as ADR-0350 §2 exec rules */
  cli: string[][];
  /** the direct API route */
  http: EndpointActionHttp[];
}

/** The catalogue. Order is fixed; ids never change meaning (add a new id instead). */
export const ENDPOINT_ACTIONS: readonly EndpointAction[] = [
  {
    id: "github.gist.create",
    title: "Create a GitHub gist",
    mcp: { upstreamHosts: ["api.githubcopilot.com"], tools: ["create_gist"] },
    cli: [["gh", "gist", "create", "**"], ["gh", "gist", "new", "**"]],
    http: [{ method: "POST", host: "api.github.com", path: "/gists" }],
  },
  {
    id: "github.pull.merge",
    title: "Merge a GitHub pull request",
    mcp: { upstreamHosts: ["api.githubcopilot.com"], tools: ["merge_pull_request"] },
    cli: [["gh", "pr", "merge", "**"]],
    http: [{ method: "PUT", host: "api.github.com", path: "/repos/*/*/pulls/*/merge" }],
  },
  {
    id: "github.issue.create",
    title: "Create a GitHub issue",
    mcp: { upstreamHosts: ["api.githubcopilot.com"], tools: ["create_issue", "issue_write"] },
    cli: [["gh", "issue", "create", "**"], ["gh", "issue", "new", "**"]],
    http: [{ method: "POST", host: "api.github.com", path: "/repos/*/*/issues" }],
  },
];

/** One compiled action rule, as the device policy carries it (`commands.actions`). */
export interface DeviceActionRule {
  id: string;
  action: string;
  verdict: ActionVerdict;
  /** the subject's MCP server names whose upstream is the action's upstream, sorted */
  mcpServers: string[];
}

export interface ActionOverride {
  action: string;
  verdict: ActionVerdict;
}

const STRICTNESS: Record<ActionVerdict, number> = { allow: 1, ask: 2, deny: 3 };

function stricter(a: ActionVerdict, b: ActionVerdict): ActionVerdict {
  return STRICTNESS[a] >= STRICTNESS[b] ? a : b;
}

/**
 * The gateway's decision for an MCP tool call, from the subject's effective entitlements: allowed exactly when the
 * kernel lists the tool as visible on that server, else denied (default deny).
 */
export function gatewayMcpVerdict(effective: EffectiveMcpPolicy, serverName: string, tool: string): ActionVerdict {
  const server = effective.servers.find((s) => s.name === serverName);
  return server?.tools.includes(tool) ? "allow" : "deny";
}

/**
 * Compile the device's action rules from the same entitlements the gateway enforces.
 *
 * @param upstreamHostOf the upstream host of a registry server (by server id), or null when unknown
 * @param overrides admin overrides; an override can only make an action stricter than the entitlement gives
 */
export function compileActionRules(
  effective: EffectiveMcpPolicy,
  upstreamHostOf: (serverId: string) => string | null,
  overrides: readonly ActionOverride[] = [],
): DeviceActionRule[] {
  for (const o of overrides) {
    if (!ENDPOINT_ACTIONS.some((a) => a.id === o.action)) throw new Error(`unknown endpoint action ${o.action}`);
  }
  return ENDPOINT_ACTIONS.map((a) => {
    const servers = effective.servers.filter((s) => {
      const host = upstreamHostOf(s.serverId);
      return host !== null && a.mcp.upstreamHosts.includes(host.toLowerCase());
    });
    // entitled when any matching server shows any of the action's tools: the same answer the gateway gives
    const entitled = servers.some((s) => a.mcp.tools.some((t) => gatewayMcpVerdict(effective, s.name, t) === "allow"));
    let verdict: ActionVerdict = entitled ? "allow" : "deny";
    for (const o of overrides) if (o.action === a.id) verdict = stricter(verdict, o.verdict);
    return { id: a.id, action: a.id, verdict, mcpServers: servers.map((s) => s.name).sort() };
  });
}

/**
 * The gateway's decision for an MCP tool call under the one policy: the entitlement, then any compiled action rule
 * for that tool on that server, the strictest winning. The device applies the same rules to the same call.
 */
export function gatewayMcpActionVerdict(
  effective: EffectiveMcpPolicy,
  rules: readonly DeviceActionRule[],
  serverName: string,
  tool: string,
): ActionVerdict {
  let v = gatewayMcpVerdict(effective, serverName, tool);
  for (const r of rules) {
    const a = ENDPOINT_ACTIONS.find((x) => x.id === r.action);
    if (a && r.mcpServers.includes(serverName) && a.mcp.tools.includes(tool)) v = stricter(v, r.verdict);
  }
  return v;
}

/** The action an HTTP request performs, if the catalogue lists it. */
export function httpAction(method: string, url: string): EndpointAction | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const host = u.hostname.toLowerCase();
  const path = u.pathname.replace(/\/+$/, "") || "/";
  for (const a of ENDPOINT_ACTIONS) {
    for (const h of a.http) {
      if (h.method === method.toUpperCase() && h.host === host && pathGlob(h.path, path)) return a;
    }
  }
  return null;
}

/** The gateway's decision for a direct API call through a governed connector, from the compiled rules. */
export function gatewayHttpVerdict(rules: readonly DeviceActionRule[], method: string, url: string): ActionVerdict | null {
  const a = httpAction(method, url);
  if (!a) return null;
  return rules.find((r) => r.action === a.id)?.verdict ?? "deny";
}

/** `*` is one path segment; the catalogue uses no other glob syntax (held by the shared test). */
function pathGlob(pattern: string, path: string): boolean {
  const p = pattern.split("/");
  const s = path.split("/");
  return p.length === s.length && p.every((seg, i) => seg === "*" ? s[i] !== "" : seg === s[i]);
}
