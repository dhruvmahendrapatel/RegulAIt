/**
 * The MCP servers that enrolled devices' MCP host configs name (GET /v1/discovery/endpoint-mcp-servers), and the
 * admin link from a configured identity to an approved registry server (POST …-links, POST …-links/remove).
 * Shapes follow the gateway route exactly; nothing here is invented.
 */
export type EndpointMcpStatus = "unregistered" | "registered" | "linked";
export type EndpointMcpLinkKind = "package" | "host" | "command";

export interface EndpointMcpServerView {
  id: string;
  deviceId: string;
  devicePseudonym: string;
  hostApp: { signatureId: string; provider: string };
  serverName: string;
  transport: "stdio" | "http" | "sse" | "unknown";
  command: string | null;
  package: string | null;
  packageVersion: string | null;
  host: string | null;
  identity: { kind: EndpointMcpLinkKind | "unknown"; value: string | null };
  disabled: boolean;
  risks: string[];
  riskyTools: string[];
  secretTypes: string[];
  registry: { status: EndpointMcpStatus; mcpServerId: string | null; mcpServerName: string | null };
  verdict: string;
  findingId: string | null;
  lastSeenAt: string;
}

export interface EndpointMcpServersPage {
  enabled: boolean;
  posture: string;
  items: EndpointMcpServerView[];
  nextCursor: string | null;
}

export interface EndpointMcpFilters {
  status: "" | EndpointMcpStatus;
  risky: boolean;
  secrets: boolean;
  deviceId: string | null;
}

export const ENDPOINT_MCP_PAGE_SIZE = 25;
export const NO_FILTERS: EndpointMcpFilters = { status: "", risky: false, secrets: false, deviceId: null };
export const REGISTRY_TONE = { unregistered: "danger", registered: "ok", linked: "info" } as const;

/** the list URL for one page: the bounded page size, the filters set, and the keyset cursor */
export function endpointMcpUrl(f: EndpointMcpFilters, cursor: string | null): string {
  const q = new URLSearchParams({ limit: String(ENDPOINT_MCP_PAGE_SIZE) });
  if (f.status) q.set("status", f.status);
  if (f.risky) q.set("risky", "true");
  if (f.secrets) q.set("secrets", "true");
  if (f.deviceId) q.set("deviceId", f.deviceId);
  if (cursor) q.set("cursor", cursor);
  return `/v1/discovery/endpoint-mcp-servers?${q.toString()}`;
}

/** what the entry runs or reaches: the package (with its version), the remote host, or the command's base name */
export function launches(r: Pick<EndpointMcpServerView, "package" | "packageVersion" | "host" | "command">): string {
  if (r.package) return r.packageVersion ? `${r.package}@${r.packageVersion}` : r.package;
  return r.host ?? r.command ?? "—";
}

/** the identity a link would key on, or null when the row has none the gateway accepts */
export function linkIdentity(r: Pick<EndpointMcpServerView, "identity">): { identityKind: EndpointMcpLinkKind; identity: string } | null {
  const { kind, value } = r.identity;
  return kind === "unknown" || !value ? null : { identityKind: kind, identity: value };
}

/** the sentence a link or unlink confirmation carries about how wide the identity is */
export function linkScope(kind: EndpointMcpLinkKind, identity: string): string {
  return kind === "command"
    ? `This links by command: every server any device launches with '${identity}' is approved by this one link, whatever it runs.`
    : `Every device whose config names the ${kind} '${identity}' is covered by this link.`;
}
