/**
 * ADR-0101 — FEDERATED MCP REGISTRY: the pure half.
 *
 * Everything in this file is deterministic, local, network-free and
 * database-free: parse one `ServerListResponse` page, decide what each entry
 * IS, and derive the one thing RegulAIt actually needs from a directory entry —
 * a callable remote endpoint, or the honest absence of one.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE SHAPE MISMATCH THIS FILE EXISTS TO NAME
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `mcp_servers` in this codebase is a row with a URL. `connectUpstream` opens a
 * `StreamableHTTPClientTransport` at that URL through ADR-0043's guard. There
 * is no stdio transport anywhere in this gateway and adding one would be a
 * different ADR about running third-party processes inside the control plane.
 *
 * A public MCP registry is not a list of URLs. It is a **publication
 * directory**, and the overwhelming majority of what it publishes is a
 * `packages[]` array — an npm/PyPI/OCI coordinate you install and run LOCALLY,
 * over stdio, on the machine that wants the tools. Verified against the
 * official v0.1 OpenAPI document (`GET /v0.1/servers`, no authentication), the
 * required fields of a server entry are `$schema`, `name`, `description` and
 * `version` — `packages` is NOT required, and neither is `remotes`. An entry
 * can legitimately carry both, either, or neither.
 *
 * So the classification below is not a nicety, it is the whole import rule:
 *
 *   `remotes[]` — an array of `Transport` objects `{ type, url?, headers?,
 *                 variables? }`. A `streamable-http` or `sse` entry with an
 *                 absolute http(s) `url` is a REAL ENDPOINT the publisher is
 *                 asking clients to call. That, and only that, can become an
 *                 `mcp_servers` row.
 *
 *   `packages[]` — a distribution. It has no endpoint. Some packages carry a
 *                 `transport` object that itself has a `url`, and that url is
 *                 emphatically NOT importable: it describes how a client talks
 *                 to the process AFTER starting it locally (typically
 *                 `http://localhost:<port>`), so dialling it from this gateway
 *                 would either fail or — far worse on a shared box — reach
 *                 whatever else happens to be listening on that port. A
 *                 package's transport url is deliberately ignored.
 *
 * `NO URL IS EVER INVENTED.` There is no fallback to a repository url, a
 * website url, a package registry base url, or a `variables`-templated remote
 * with unfilled placeholders. An entry with no usable remote is CATALOGUE-ONLY:
 * recorded, visible, provably inert.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT THIS FILE REFUSES TO DECIDE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * It does not decide whether an endpoint is REACHABLE (ADR-0043's egress guard
 * does, at import and on every connect), whether its manifest is ADMISSIBLE
 * (ADR-0097's scanner does, on the first sync), or whether anyone may CALL it
 * (pillar 1's grants do, and a fresh import has none). It decides only what the
 * bytes from the registry say.
 *
 * And it trusts none of those bytes. Every string here is publisher-controlled
 * text from an unauthenticated public directory: a registry is a DIRECTORY, not
 * a trust anchor. `description`/`title` are capped and stored for an operator's
 * screen; nothing in this file is ever handed to a model as authority — the
 * only text a model ever sees from an imported server is its TOOL MANIFEST, and
 * that arrives through ADR-0097's scanner like every other manifest.
 */
import { z } from "zod";

/** the API major this adapter is written against. The upstream contract is
 * frozen at v0.1; a registry serving anything else is a different contract and
 * should be a different adapter, not a silent coercion. */
export const MCP_REGISTRY_API_VERSION = "v0.1";

/** the listing path, appended to the operator-configured base url */
export const MCP_REGISTRY_LIST_PATH = `/${MCP_REGISTRY_API_VERSION}/servers`;

/** upstream's own cap (`limit` maximum: 100). Asking for more is a 400. */
export const MCP_REGISTRY_MAX_PAGE_SIZE = 100;

/** the transport types that describe a callable HTTP endpoint. `stdio` is a
 * local process and is not one. */
export const MCP_REMOTE_TRANSPORT_TYPES = ["streamable-http", "sse"] as const;
export type McpRemoteTransportType = (typeof MCP_REMOTE_TRANSPORT_TYPES)[number];

/**
 * What one catalogue entry IS, from RegulAIt's point of view.
 *
 *  `remote`         — carries a usable remote endpoint; importable into
 *                     `mcp_servers` (still ungranted, still unscanned).
 *  `catalogue_only` — a real, published server with NO endpoint this gateway
 *                     can dial (package-only, stdio-only, or a remote whose url
 *                     is templated/relative/malformed). Recorded so the
 *                     operator can see what the registry actually contains;
 *                     structurally un-callable, because no `mcp_servers` row
 *                     is ever created for it.
 */
export const MCP_REGISTRY_ENTRY_KINDS = ["remote", "catalogue_only"] as const;
export type McpRegistryEntryKind = (typeof MCP_REGISTRY_ENTRY_KINDS)[number];

/** why a `catalogue_only` entry is catalogue-only — shown verbatim to an
 * operator who asks "why can't I import this one?" */
export const MCP_CATALOGUE_REASONS = [
  "packages_only",
  "stdio_only",
  "remote_url_unusable",
  "no_distribution",
] as const;
export type McpCatalogueReason = (typeof MCP_CATALOGUE_REASONS)[number];

/** the lifecycle status the registry itself reports for an entry */
export const MCP_REGISTRY_UPSTREAM_STATUSES = ["active", "deprecated", "deleted"] as const;
export type McpRegistryUpstreamStatus = (typeof MCP_REGISTRY_UPSTREAM_STATUSES)[number];

// ---------------------------------------------------------------------------
// the wire schema — PERMISSIVE on purpose
// ---------------------------------------------------------------------------

/**
 * `.passthrough()` and near-total optionality throughout, deliberately.
 *
 * This parses a document written by somebody else's server, and the failure
 * mode of a strict schema here is that ONE malformed entry — or one field the
 * registry adds next month — makes an entire sync page throw and the operator
 * sees nothing at all. A directory reader must degrade to "I could not use that
 * row" and keep going, so every per-entry field is optional and the unusable
 * rows are classified rather than fatal. The fields we actually rely on
 * (`name`, `version`) are checked in `normalizeRegistryPage`, which SKIPS a row
 * it cannot identify and reports the count.
 */
const transportSchema = z
  .object({
    type: z.string().optional(),
    url: z.string().optional(),
    variables: z.record(z.unknown()).optional(),
  })
  .passthrough();

const packageSchema = z
  .object({
    registryType: z.string().optional(),
    identifier: z.string().optional(),
    version: z.string().optional(),
    transport: transportSchema.optional(),
  })
  .passthrough();

const serverJsonSchema = z
  .object({
    name: z.string().optional(),
    description: z.string().optional(),
    title: z.string().optional(),
    version: z.string().optional(),
    websiteUrl: z.string().optional(),
    repository: z.object({ url: z.string().optional() }).passthrough().optional(),
    packages: z.array(packageSchema).nullish(),
    remotes: z.array(transportSchema).nullish(),
  })
  .passthrough();

const registryExtensionsSchema = z
  .object({
    status: z.string().optional(),
    publishedAt: z.string().optional(),
    updatedAt: z.string().optional(),
    isLatest: z.boolean().optional(),
  })
  .passthrough();

/**
 * The response entry is `{ server, _meta }`, NOT a bare server object — the
 * registry-managed facts (lifecycle status, publication times, is-this-latest)
 * live under `_meta["io.modelcontextprotocol.registry/official"]` and are the
 * registry's statements, not the publisher's. We keep them apart for exactly
 * that reason.
 */
const serverResponseSchema = z
  .object({
    server: serverJsonSchema.optional(),
    _meta: z
      .object({ "io.modelcontextprotocol.registry/official": registryExtensionsSchema.optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();

export const mcpRegistryPageSchema = z
  .object({
    servers: z.array(serverResponseSchema).nullish(),
    metadata: z.object({ count: z.number().optional(), nextCursor: z.string().optional() }).passthrough().optional(),
  })
  .passthrough();

export type McpRegistryPagePayload = z.infer<typeof mcpRegistryPageSchema>;

// ---------------------------------------------------------------------------
// normalization
// ---------------------------------------------------------------------------

/** upstream caps `description`/`title` at 100 chars; we cap again rather than
 * trusting the cap, because this text lands on an admin screen. */
const TEXT_CAP = 200;
const clip = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t === "" ? null : t.slice(0, TEXT_CAP);
};

export interface NormalizedRegistryEntry {
  /** the reverse-DNS publication name, e.g. `io.github.user/weather` */
  upstreamName: string;
  upstreamVersion: string;
  title: string | null;
  description: string | null;
  repositoryUrl: string | null;
  websiteUrl: string | null;
  kind: McpRegistryEntryKind;
  /** set iff kind === 'remote' */
  remoteUrl: string | null;
  remoteTransport: McpRemoteTransportType | null;
  /** set iff kind === 'catalogue_only' */
  catalogueReason: McpCatalogueReason | null;
  /** the registry's own lifecycle statement, `null` when it made none */
  upstreamStatus: McpRegistryUpstreamStatus | null;
  publishedAt: string | null;
  updatedAt: string | null;
  packageCount: number;
  remoteCount: number;
}

/**
 * Is this a url this gateway could conceivably dial?
 *
 * Absolute, http(s), and — the case that matters — carrying NO unfilled
 * `{placeholder}` template segment. The spec's `variables` feature lets a
 * publisher ship `https://{region}.example.com/mcp`; substituting a guess would
 * be inventing a URL, and importing the literal string would put a row in
 * `mcp_servers` pointing at a hostname with a brace in it. Both are worse than
 * saying "this one is catalogue-only".
 */
export function usableRemoteUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (s === "") return null;
  if (s.includes("{") || s.includes("}")) return null;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  // userinfo is refused by the egress guard anyway; refusing it here means a
  // catalogue row never displays `https://user:pass@host` to an operator.
  if (u.username !== "" || u.password !== "") return null;
  return u.toString();
}

function isRemoteTransportType(t: unknown): t is McpRemoteTransportType {
  return typeof t === "string" && (MCP_REMOTE_TRANSPORT_TYPES as readonly string[]).includes(t);
}

/**
 * Choose the endpoint to import, when there are several.
 *
 * `streamable-http` first, because that is the transport `connectUpstream`
 * actually speaks; an `sse`-only remote is recorded with its type so an
 * operator can see what they are getting, and the connect will fail honestly
 * against ADR-0043's guarded transport rather than being hidden here. Ties
 * break on document order — the publisher's own preference — never on
 * something clever.
 */
export function pickRemote(
  remotes: ReadonlyArray<{ type?: string | undefined; url?: string | undefined }> | null | undefined,
): { url: string; transport: McpRemoteTransportType } | null {
  if (!remotes) return null;
  for (const want of MCP_REMOTE_TRANSPORT_TYPES) {
    for (const r of remotes) {
      if (r.type !== want) continue;
      const url = usableRemoteUrl(r.url);
      if (url) return { url, transport: want };
    }
  }
  return null;
}

/** Classify one entry. Pure; no network, no clock, no database. */
export function classifyRegistryEntry(server: {
  packages?: unknown;
  remotes?: unknown;
}): {
  kind: McpRegistryEntryKind;
  remoteUrl: string | null;
  remoteTransport: McpRemoteTransportType | null;
  catalogueReason: McpCatalogueReason | null;
} {
  const remotes = Array.isArray(server.remotes)
    ? (server.remotes as Array<{ type?: string; url?: string }>)
    : [];
  const packages = Array.isArray(server.packages) ? (server.packages as unknown[]) : [];

  const picked = pickRemote(remotes);
  if (picked) {
    return {
      kind: "remote",
      remoteUrl: picked.url,
      remoteTransport: picked.transport,
      catalogueReason: null,
    };
  }

  // there WERE remotes, and not one of them yielded a dialable url — a
  // templated host, a relative path, an unknown transport type. Distinct from
  // "this publisher only ships a package", and the operator sees which.
  const hadRemoteShaped = remotes.some((r) => isRemoteTransportType(r.type) || typeof r.url === "string");
  const reason: McpCatalogueReason = hadRemoteShaped
    ? "remote_url_unusable"
    : remotes.length > 0
      ? "stdio_only"
      : packages.length > 0
        ? "packages_only"
        : "no_distribution";
  return { kind: "catalogue_only", remoteUrl: null, remoteTransport: null, catalogueReason: reason };
}

export interface NormalizedRegistryPage {
  entries: NormalizedRegistryEntry[];
  /** OPAQUE. Passed back verbatim; never parsed, never constructed. */
  nextCursor: string | null;
  /** rows the page contained that carried no usable `name`/`version` and were
   * therefore not identifiable. Counted rather than thrown, and reported. */
  skipped: number;
}

/**
 * Parse and normalize one page. Throws only when the PAGE itself is not a
 * `ServerListResponse`; a single unusable row is skipped and counted.
 */
export function normalizeRegistryPage(payload: unknown): NormalizedRegistryPage {
  const parsed = mcpRegistryPageSchema.parse(payload);
  const entries: NormalizedRegistryEntry[] = [];
  let skipped = 0;
  for (const row of parsed.servers ?? []) {
    const server = row.server;
    const name = clip(server?.name);
    const version = clip(server?.version);
    // identity is the ONE thing we cannot degrade on: without a name there is
    // no idempotency key and without a version there is no provenance.
    if (!server || !name || !version) {
      skipped += 1;
      continue;
    }
    const official = row._meta?.["io.modelcontextprotocol.registry/official"];
    const rawStatus = official?.status;
    const upstreamStatus = (MCP_REGISTRY_UPSTREAM_STATUSES as readonly string[]).includes(
      rawStatus ?? "",
    )
      ? (rawStatus as McpRegistryUpstreamStatus)
      : null;
    const classified = classifyRegistryEntry({
      packages: server.packages ?? undefined,
      remotes: server.remotes ?? undefined,
    });
    entries.push({
      upstreamName: name,
      upstreamVersion: version,
      title: clip(server.title),
      description: clip(server.description),
      repositoryUrl: clip(server.repository?.url),
      websiteUrl: clip(server.websiteUrl),
      ...classified,
      upstreamStatus,
      publishedAt: clip(official?.publishedAt),
      updatedAt: clip(official?.updatedAt),
      packageCount: Array.isArray(server.packages) ? server.packages.length : 0,
      remoteCount: Array.isArray(server.remotes) ? server.remotes.length : 0,
    });
  }
  const nextCursor = typeof parsed.metadata?.nextCursor === "string" && parsed.metadata.nextCursor !== ""
    ? parsed.metadata.nextCursor
    : null;
  return { entries, nextCursor, skipped };
}

// ---------------------------------------------------------------------------
// the name rule
// ---------------------------------------------------------------------------

/**
 * THE LOCAL NAME OF AN IMPORTED SERVER IS THE UPSTREAM NAME, VERBATIM.
 *
 * `mcp_servers.name` is globally unique in this database, and registry names
 * are reverse-DNS by construction (`io.github.user/weather`) — already the most
 * collision-resistant identifier available, and the ONLY string an operator can
 * paste back into the upstream registry to see what they imported. Mangling it
 * (prefixing the registry slug, slugifying the slash) would buy automatic
 * de-collision at the cost of that lookup, and would quietly create TWO local
 * rows for one upstream server when an operator adds a second registry that
 * mirrors the first.
 *
 * So: no mangling, and every collision is a CONFLICT an operator resolves, not
 * a rename this code performs. The idempotency key that makes re-sync safe is
 * `(registry_id, upstream_name)` on the catalogue table — not the server name —
 * so a name already taken never turns into a duplicate row.
 */
export function localServerNameFor(upstreamName: string): string {
  return upstreamName.trim();
}

/** why an entry could not be imported. Recorded on the catalogue row; never
 * resolved by overwriting anything. */
export const MCP_IMPORT_CONFLICT_REASONS = ["name_taken", "url_taken"] as const;
export type McpImportConflictReason = (typeof MCP_IMPORT_CONFLICT_REASONS)[number];
