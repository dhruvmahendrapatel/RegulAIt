/**
 * ADR-0256 — SEEDING THE MCP CATALOGUE: the pure half.
 *
 * ADR-0101 already pulls an upstream MCP registry (`GET /v0.1/servers`) into `mcp_registry_entries` as an inert
 * catalogue. This module adds what seeding needs on top of it, with no network, clock or database:
 *
 *   1. the PRESETS an admin can seed from (the official MCP Registry, and the MIT-licensed community list
 *      `punkpeye/awesome-mcp-servers`), as data an admin acts on, never rows a fresh install gets;
 *   2. the COMMUNITY-LIST PARSER, which turns a markdown list into catalogue-only entries (a community list names a
 *      repository, never an endpoint, so nothing it lists can ever be imported as a server);
 *   3. the DEDUPE KEY that groups the same server listed by several sources, keeping each source's row;
 *   4. the OFFLINE BUNDLE format an air-gapped install imports instead of pulling.
 */
import { z } from "zod";
import {
  MCP_CATALOGUE_REASONS,
  MCP_PAID_SIGNALS,
  MCP_REGISTRY_ENTRY_KINDS,
  MCP_REGISTRY_UPSTREAM_STATUSES,
  MCP_REMOTE_TRANSPORT_TYPES,
  paidSignalFor,
  usableRemoteUrl,
  type NormalizedRegistryEntry,
} from "./mcp-registry.js";

// ---------------------------------------------------------------------------
// sources
// ---------------------------------------------------------------------------

/** what kind of directory a source is. `community` entries are UNVETTED: nobody verified who published them. */
export const MCP_CATALOGUE_LISTING_KINDS = ["registry", "community"] as const;
export type McpCatalogueListingKind = (typeof MCP_CATALOGUE_LISTING_KINDS)[number];

/** how a source reaches the catalogue: an egress-guarded pull, or a signed offline bundle (air-gapped) */
export const MCP_CATALOGUE_DELIVERIES = ["pull", "offline_bundle"] as const;
export type McpCatalogueDelivery = (typeof MCP_CATALOGUE_DELIVERIES)[number];

/**
 * The listing trust a source confers. Neither is admission: every entry is "available, not admitted" until it is
 * imported and passes the MCP admission scan. `registry_listed` says only that the official registry authenticated the
 * publisher's namespace (GitHub or DNS); `unvetted` says nobody did.
 */
export type McpCatalogueVetting = "registry_listed" | "unvetted";
export function vettingFor(listingKind: McpCatalogueListingKind): McpCatalogueVetting {
  return listingKind === "registry" ? "registry_listed" : "unvetted";
}

/** ADR-0256: the presets an admin may seed. Recorded with the licence checked on 2026-11-07. */
export const MCP_CATALOGUE_PRESETS = {
  official: {
    name: "official-mcp-registry",
    listingKind: "registry",
    /** BASE url; the ADR-0101 adapter appends `/v0.1/servers` */
    url: "https://registry.modelcontextprotocol.io",
    /** Registry ToS §10: registry data is dedicated to the public domain under CC0 1.0 */
    dataLicence: "CC0-1.0",
  },
  "awesome-mcp-servers": {
    name: "awesome-mcp-servers",
    listingKind: "community",
    /** the raw README; a community source's url is the document itself */
    url: "https://raw.githubusercontent.com/punkpeye/awesome-mcp-servers/main/README.md",
    dataLicence: "MIT",
  },
} as const satisfies Record<string, { name: string; listingKind: McpCatalogueListingKind; url: string; dataLicence: string }>;
export type McpCataloguePreset = keyof typeof MCP_CATALOGUE_PRESETS;
export const MCP_CATALOGUE_PRESET_IDS = Object.keys(MCP_CATALOGUE_PRESETS) as McpCataloguePreset[];

// ---------------------------------------------------------------------------
// dedupe
// ---------------------------------------------------------------------------

/**
 * `github.com/owner/repo` (lower-case, no scheme, no `.git`, no trailing path) for a GitHub repository url, else
 * null. Parsed with `URL`, never a regex (M-074).
 */
export function githubRepoKey(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const host = u.hostname.toLowerCase();
  if (host !== "github.com" && host !== "www.github.com") return null;
  const parts = u.pathname.split("/").filter((p) => p !== "");
  if (parts.length < 2) return null;
  const owner = parts[0]!.toLowerCase();
  let repo = parts[1]!.toLowerCase();
  if (repo.endsWith(".git")) repo = repo.slice(0, -4);
  if (owner === "" || repo === "") return null;
  return `github.com/${owner}/${repo}`;
}

/**
 * The key that says "these source rows describe one server". A GitHub repository is the only identifier the official
 * registry and a community list share, so it wins; otherwise the upstream name, lower-cased. Two sources that agree
 * on neither stay two items: a wrong merge would show one source's provenance on another's server, which is worse
 * than a duplicate an operator can see.
 */
export function catalogueDedupeKey(e: { upstreamName: string; repositoryUrl: string | null }): string {
  const repo = githubRepoKey(e.repositoryUrl);
  return repo ? `repo:${repo}` : `name:${e.upstreamName.toLowerCase()}`;
}

// ---------------------------------------------------------------------------
// the community list
// ---------------------------------------------------------------------------

/** bounds on a community document: what we are willing to read, not what a list is willing to send */
export const MCP_COMMUNITY_LIST_MAX_ENTRIES = 20_000;
const LINE_CAP = 4_000;
const TEXT_CAP = 200;

const clip = (v: string): string | null => {
  const t = v.trim();
  return t === "" ? null : t.slice(0, TEXT_CAP);
};

/**
 * Parse an awesome-list README into catalogue-only entries.
 *
 * An entry is a top-level bullet whose FIRST token is a markdown link to a GitHub repository:
 * `- [owner/repo](https://github.com/owner/repo) <badges and legend emoji> - description`. Anything else (headings,
 * prose, links to other hosts, nested bullets) is skipped and counted. Each line is read with `indexOf` and `URL`, so
 * the cost is linear in the document (M-074). The same repository listed twice keeps its first listing.
 *
 * Every entry is `catalogue_only` / `community_listing`: the list names a repository, and this codebase does not
 * invent an endpoint for it (ADR-0101).
 */
export function parseCommunityList(markdown: string): { entries: NormalizedRegistryEntry[]; skipped: number; capped: boolean } {
  const entries: NormalizedRegistryEntry[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  let capped = false;
  for (const rawLine of markdown.split("\n")) {
    const line = rawLine.length > LINE_CAP ? rawLine.slice(0, LINE_CAP) : rawLine;
    if (!(line.startsWith("- [") || line.startsWith("* ["))) continue;
    const textEnd = line.indexOf("](", 3);
    if (textEnd < 0) {
      skipped += 1;
      continue;
    }
    const urlEnd = line.indexOf(")", textEnd + 2);
    if (urlEnd < 0) {
      skipped += 1;
      continue;
    }
    const href = line.slice(textEnd + 2, urlEnd);
    const repo = githubRepoKey(href);
    if (!repo) {
      skipped += 1;
      continue;
    }
    if (seen.has(repo)) continue;
    if (entries.length >= MCP_COMMUNITY_LIST_MAX_ENTRIES) {
      capped = true;
      break;
    }
    seen.add(repo);
    const label = clip(line.slice(3, textEnd));
    const rest = line.slice(urlEnd + 1);
    const dash = rest.indexOf(" - ");
    const description = dash >= 0 ? clip(rest.slice(dash + 3)) : null;
    entries.push({
      upstreamName: repo,
      // a list has no versions; the snapshot digest is the version of what it said
      upstreamVersion: "listed",
      title: label,
      description,
      repositoryUrl: `https://${repo}`,
      websiteUrl: null,
      kind: "catalogue_only",
      remoteUrl: null,
      remoteTransport: null,
      catalogueReason: "community_listing",
      upstreamStatus: null,
      publishedAt: null,
      updatedAt: null,
      packageCount: 0,
      remoteCount: 0,
      paidSignal: paidSignalFor({ texts: [repo, label, description], describing: [label, description] }),
    });
  }
  return { entries, skipped, capped };
}

// ---------------------------------------------------------------------------
// the offline bundle
// ---------------------------------------------------------------------------

export const MCP_CATALOGUE_BUNDLE_FORMAT = "regulait.mcp-catalogue-bundle/v1";
export const MCP_CATALOGUE_BUNDLE_MAX_ENTRIES = 20_000;
/** the bundle text's byte cap, checked before it is parsed */
export const MCP_CATALOGUE_BUNDLE_MAX_BYTES = 8 * 1024 * 1024;

const capped = (n: number) => z.string().max(n);
const optText = z.string().max(TEXT_CAP).nullable();
const isoish = z.string().max(64).nullable();

/** one entry, in the normalized shape a connected install already holds. STRICT: an exact format, not a feed. */
export const mcpCatalogueBundleEntrySchema = z
  .object({
    upstreamName: z.string().min(1).max(TEXT_CAP),
    upstreamVersion: z.string().min(1).max(TEXT_CAP),
    title: optText,
    description: optText,
    repositoryUrl: optText,
    websiteUrl: optText,
    kind: z.enum(MCP_REGISTRY_ENTRY_KINDS),
    remoteUrl: capped(2000).nullable(),
    remoteTransport: z.enum(MCP_REMOTE_TRANSPORT_TYPES).nullable(),
    catalogueReason: z.enum(MCP_CATALOGUE_REASONS).nullable(),
    upstreamStatus: z.enum(MCP_REGISTRY_UPSTREAM_STATUSES).nullable(),
    publishedAt: isoish,
    updatedAt: isoish,
    packageCount: z.number().int().min(0).max(1000),
    remoteCount: z.number().int().min(0).max(1000),
    paidSignal: z.enum(MCP_PAID_SIGNALS).nullable(),
  })
  .strict();

export const mcpCatalogueBundleSchema = z
  .object({
    format: z.literal(MCP_CATALOGUE_BUNDLE_FORMAT),
    /** when the exporting install built it; a bundle older than the last one imported for the source is refused */
    createdAt: z.string().datetime({ offset: true }),
    source: z
      .object({
        name: z.string().min(1).max(200),
        listingKind: z.enum(MCP_CATALOGUE_LISTING_KINDS),
        /** where the exporting install pulled it from: provenance only, NEVER dialled */
        origin: z.string().min(1).max(2000),
        dataLicence: z.string().min(1).max(64),
      })
      .strict(),
    /** true when the exporting install's own catalogue was truncated; then nothing is marked missing */
    truncated: z.boolean(),
    entries: z.array(mcpCatalogueBundleEntrySchema).max(MCP_CATALOGUE_BUNDLE_MAX_ENTRIES),
  })
  .strict();
export type McpCatalogueBundle = z.infer<typeof mcpCatalogueBundleSchema>;

/**
 * Re-check what the format cannot: a `remote` entry must carry a url this gateway could dial and a transport, and a
 * `catalogue_only` entry must carry neither. A row that fails is dropped and counted, exactly as a pull would.
 */
export function bundleEntriesUsable(entries: McpCatalogueBundle["entries"]): { entries: NormalizedRegistryEntry[]; skipped: number } {
  const out: NormalizedRegistryEntry[] = [];
  let skipped = 0;
  for (const e of entries) {
    if (e.kind === "remote") {
      const url = usableRemoteUrl(e.remoteUrl);
      if (!url || !e.remoteTransport || e.catalogueReason !== null) {
        skipped += 1;
        continue;
      }
      out.push({ ...e, remoteUrl: url });
    } else {
      if (e.remoteUrl !== null || e.remoteTransport !== null || e.catalogueReason === null) {
        skipped += 1;
        continue;
      }
      out.push({ ...e });
    }
  }
  return { entries: out, skipped };
}
