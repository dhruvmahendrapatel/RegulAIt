/**
 * ADR-0315 (G7) — the agent credential audience registry, as pure functions for the "Agent credentials" page
 * (`GET/POST /v1/agent-credentials/audiences`, `POST …/:audienceId/disable`).
 *
 * An audience is a third-party enforcement point (an API gateway, a resource server) that accepts RegulAIt's portable
 * agent credential. Default-deny: no audience, no credential. Registering one is a relaxation, so it always asks for a
 * `settings_relax` step-up bound to the whole registration; disabling one is a tightening and does not.
 *
 * The bounds and checks mirror `packages/shared/src/agent-credential.ts` (the web app does not depend on the shared
 * package); the gateway checks again and is the authority.
 */

export const ALGORITHMS = ["ES256", "EdDSA"] as const;
export const BINDINGS = ["dpop", "bearer"] as const;
export type Algorithm = (typeof ALGORITHMS)[number];
export type Binding = (typeof BINDINGS)[number];
export const TTL = Object.freeze({ min: 60, default: 300, max: 900 });
const SCOPE_TOKEN = /^[\x21\x23-\x5B\x5D-\x7E]{1,128}$/;

export type ScopeType = "mcp_tool" | "connector" | "agent";
export type ScopeKind = "read" | "write";

export interface AudienceScope {
  type: ScopeType;
  serverId: string | null;
  toolName: string | null;
  connectorId: string | null;
  agentId: string | null;
  kind: ScopeKind;
  scope: string;
}

export interface Audience {
  id: string;
  audience: string;
  name: string;
  algorithm: Algorithm;
  binding: Binding;
  maxTtlSeconds: number;
  state: "enabled" | "disabled";
  enabled: boolean;
  disabledAt: string | null;
  createdAt: string;
  scopes: AudienceScope[];
}

/** one scope-map row being drafted: `resourceId` is the server, connector or agent, by `type` */
export interface ScopeDraft {
  type: ScopeType;
  resourceId: string;
  toolName: string;
  kind: ScopeKind;
  scope: string;
}

export interface AudienceDraft {
  name: string;
  audience: string;
  algorithm: Algorithm;
  binding: Binding;
  maxTtlSeconds: string;
  scopes: ScopeDraft[];
}

export const EMPTY_SCOPE: ScopeDraft = { type: "mcp_tool", resourceId: "", toolName: "", kind: "read", scope: "" };
export const EMPTY_AUDIENCE: AudienceDraft = { name: "", audience: "", algorithm: "ES256", binding: "dpop", maxTtlSeconds: String(TTL.default), scopes: [EMPTY_SCOPE] };
export const SCOPE_TYPE_LABEL: Readonly<Record<ScopeType, string>> = Object.freeze({ mcp_tool: "MCP tool", connector: "Connector", agent: "Agent" });
export const BINDING_LABEL: Readonly<Record<Binding, string>> = Object.freeze({ dpop: "DPoP (proof of possession)", bearer: "Bearer" });

/** the audience URI, checked like the gateway: https, no credentials, query or fragment, at most 512 characters */
export function audienceProblem(raw: string): string | null {
  const v = raw.trim();
  if (!v) return "Enter the audience URI the receiver checks.";
  if (v.length > 512) return "Keep the audience to 512 characters.";
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return "Enter a full URL, starting with https://.";
  }
  if (u.protocol !== "https:") return "The audience must be an https URL.";
  if (u.username || u.password) return "Leave credentials out of the audience.";
  if (u.search || u.hash) return "Leave the query and #fragment out of the audience.";
  return null;
}

export function scopeProblem(s: ScopeDraft): string | null {
  if (!s.resourceId) return `Choose the ${SCOPE_TYPE_LABEL[s.type].toLowerCase()}.`;
  if (s.type === "mcp_tool" && !s.toolName.trim()) return "Enter the tool name.";
  if (s.type === "mcp_tool" && s.toolName.trim().length > 256) return "Keep the tool name to 256 characters.";
  if (!SCOPE_TOKEN.test(s.scope)) return "Enter the scope string the receiver expects: 1 to 128 characters, no spaces, quotes or backslashes.";
  return null;
}

export interface DraftProblems {
  name?: string;
  audience?: string;
  maxTtlSeconds?: string;
  scopes?: string;
  rows: Array<string | null>;
}

export function draftProblems(d: AudienceDraft): DraftProblems {
  const out: DraftProblems = { rows: d.scopes.map(scopeProblem) };
  const name = d.name.trim();
  if (!name) out.name = "Give the audience a name.";
  else if (name.length > 120) out.name = "Keep the name to 120 characters.";
  const a = audienceProblem(d.audience);
  if (a) out.audience = a;
  const ttl = Number(d.maxTtlSeconds);
  if (!/^\d+$/.test(d.maxTtlSeconds.trim()) || ttl < TTL.min || ttl > TTL.max) out.maxTtlSeconds = `Enter whole seconds from ${TTL.min} to ${TTL.max}.`;
  if (d.scopes.length === 0) out.scopes = "Map at least one grant scope; an audience with no scope map is never issued to.";
  else if (d.scopes.length > 200) out.scopes = "Keep the scope map to 200 rows.";
  return out;
}

export const hasProblems = (p: DraftProblems) => Boolean(p.name || p.audience || p.maxTtlSeconds || p.scopes || p.rows.some(Boolean));

export function createBody(d: AudienceDraft) {
  return {
    name: d.name.trim(),
    audience: d.audience.trim(),
    algorithm: d.algorithm,
    binding: d.binding,
    maxTtlSeconds: Number(d.maxTtlSeconds),
    scopes: d.scopes.map((s) => {
      const base = { kind: s.kind, scope: s.scope };
      if (s.type === "mcp_tool") return { type: s.type, serverId: s.resourceId, toolName: s.toolName.trim(), ...base };
      if (s.type === "connector") return { type: s.type, connectorId: s.resourceId, ...base };
      return { type: s.type, agentId: s.resourceId, ...base };
    }),
  };
}

/** what a registration loosens beyond the defaults, in the words the confirmation shows (the gateway audits the same) */
export function relaxations(d: Pick<AudienceDraft, "binding" | "maxTtlSeconds">): string[] {
  const out: string[] = [];
  if (d.binding === "bearer") out.push("accepts a bearer credential, which anyone holding it can replay (DPoP binds it to the agent's key)");
  if (Number(d.maxTtlSeconds) > TTL.default) out.push(`lets a credential live up to ${d.maxTtlSeconds} seconds (the default is ${TTL.default})`);
  return out;
}

/** a scope row's resource in words, from the name maps (an unknown id is shown as itself) */
export function scopeResource(s: AudienceScope, names: { server: (id: string) => string; connector: (id: string) => string; agent: (id: string) => string }): string {
  if (s.type === "mcp_tool") return `${s.serverId ? names.server(s.serverId) : "?"} · ${s.toolName ?? "?"}`;
  if (s.type === "connector") return s.connectorId ? names.connector(s.connectorId) : "?";
  return s.agentId ? names.agent(s.agentId) : "?";
}

export const AUDIENCE_REFUSALS: Readonly<Record<string, string>> = Object.freeze({
  conflict: "That audience is already registered and on. Disable it first to register it again.",
  unknown_resource: "A scope row names a server, connector or agent that no longer exists. Refresh and choose again.",
  unknown_audience: "That audience is already disabled or no longer exists.",
});
