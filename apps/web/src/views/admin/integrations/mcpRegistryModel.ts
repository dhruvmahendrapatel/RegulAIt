/**
 * ADR-0101 — federated MCP registries, the browser's model.
 *
 * Mirrors `apps/gateway/src/mcp-registry.ts` (`createMcpRegistrySchema`,
 * `updateMcpRegistrySchema`, `SyncRegistryResult`, `ImportRefusal`) and the
 * `mcp_registries` / `mcp_registry_entries` rows. `mcpRegistryModel.test.ts`
 * reads the gateway source and fails when a refusal code here is no longer one
 * it sends.
 *
 * Strict by default: a new registry is DISABLED unless the admin enables it,
 * and its private-range posture inherits the org default. A sync writes the
 * catalogue and nothing else; an import creates one ungranted server.
 */

export type RegistrySyncOutcome = "ok" | "failed" | "refused" | "skipped";

export interface McpRegistry {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  allowPrivateRanges: boolean | null;
  lastSyncAt: string | null;
  lastSyncOutcome: RegistrySyncOutcome | null;
  lastSyncDetail: unknown;
  createdAt: string;
}

/** `GET /v1/mcp-registries` */
export interface McpRegistryList {
  deployMode: string;
  federationRefused: boolean;
  federationRefusedReason: string | null;
  maxPagesPerSync: number;
  maxRegistriesPerSweep: number;
  registries: McpRegistry[];
}

export interface McpRegistryEntry {
  id: string;
  registryId: string;
  upstreamName: string;
  upstreamVersion: string;
  title: string | null;
  description: string | null;
  repositoryUrl: string | null;
  websiteUrl: string | null;
  kind: "remote" | "catalogue_only";
  remoteUrl: string | null;
  remoteTransport: string | null;
  catalogueReason: string | null;
  upstreamStatus: "active" | "deprecated" | "deleted" | null;
  serverId: string | null;
  importedAt: string | null;
  conflictReason: "name_taken" | "url_taken" | null;
  conflictServerId: string | null;
  remoteUrlDrift: string | null;
  lastSeenAt: string;
  missingSince: string | null;
}

/** `GET /v1/mcp-registries/:registryId/entries` */
export interface McpRegistryEntries {
  registry: { id: string; name: string };
  entries: McpRegistryEntry[];
}

/** `POST /v1/mcp-registries/:registryId/sync` (always 200; the outcome says what happened) */
export interface RegistrySyncResult {
  registryId: string;
  registryName: string;
  outcome: RegistrySyncOutcome;
  reason: string;
  pages: number;
  truncated: boolean;
  entriesSeen: number;
  created: number;
  updated: number;
  remote: number;
  catalogueOnly: number;
  malformed: number;
  markedMissing: number;
  driftDetected: number;
  conflicts: number;
  serversCreated: number;
  grantsCreated: number;
}

/** `POST /v1/mcp-registries/entries/:entryId/import` (201) */
export interface RegistryImportResult {
  serverId: string;
  name: string;
  url: string;
  admissionState: string;
  origin: "federated";
  grantsCreated: number;
  toolsCreated: number;
}

// ---------------------------------------------------------------------------
// the private-range tri-state (ADR-0043), the same wire shape as an MCP server
// ---------------------------------------------------------------------------

export type PrivateRanges = "inherit" | "allow" | "deny";
export const privateRangesOf = (v: boolean | null | undefined): PrivateRanges => (v == null ? "inherit" : v ? "allow" : "deny");
export const privateRangesWire = (v: PrivateRanges): boolean | null => (v === "inherit" ? null : v === "allow");
export const PRIVATE_RANGES_TEXT: Readonly<Record<PrivateRanges, string>> = {
  inherit: "Inherit the org default",
  allow: "Allow private ranges",
  deny: "Deny private ranges",
};

// ---------------------------------------------------------------------------
// forms
// ---------------------------------------------------------------------------

export interface RegistryDraft {
  name: string;
  url: string;
  enabled: boolean;
  privateRanges: PrivateRanges;
}

export const EMPTY_REGISTRY_DRAFT: RegistryDraft = { name: "", url: "", enabled: false, privateRanges: "inherit" };

/** an absolute http(s) URL; the gateway's egress guard decides whether it may be reached */
export function registryUrlProblem(url: string): string | null {
  const trimmed = url.trim();
  if (!trimmed) return "Enter the registry's base URL.";
  if (trimmed.length > 2000) return "The URL must be at most 2000 characters.";
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return "Enter an absolute URL, for example https://registry.example.com.";
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return "The URL must start with https:// or http://.";
  return null;
}

export interface CreateRegistryBody {
  name: string;
  url: string;
  enabled: boolean;
  allowPrivateRanges: boolean | null;
}

export function createRegistryBody(d: RegistryDraft): { error: string } | { body: CreateRegistryBody } {
  const name = d.name.trim();
  if (!name) return { error: "Enter a name for the registry." };
  if (name.length > 200) return { error: "The name must be at most 200 characters." };
  const urlProblem = registryUrlProblem(d.url);
  if (urlProblem) return { error: urlProblem };
  return { body: { name, url: d.url.trim(), enabled: d.enabled, allowPrivateRanges: privateRangesWire(d.privateRanges) } };
}

export interface UpdateRegistryBody {
  url?: string;
  enabled?: boolean;
  allowPrivateRanges?: boolean | null;
}

/**
 * Only the fields that changed (the PATCH is strict and partial). `relaxes`
 * lists the changes that loosen the registry's posture, so the confirmation can
 * say so: enabling it, or allowing private ranges.
 */
export function updateRegistryBody(
  before: McpRegistry,
  d: Omit<RegistryDraft, "name">,
): { error: string } | { body: UpdateRegistryBody; relaxes: string[] } {
  const body: UpdateRegistryBody = {};
  const relaxes: string[] = [];
  const url = d.url.trim();
  if (url !== before.url) {
    const problem = registryUrlProblem(url);
    if (problem) return { error: problem };
    body.url = url;
  }
  if (d.enabled !== before.enabled) {
    body.enabled = d.enabled;
    if (d.enabled) relaxes.push("Enabling it lets the scheduled sweep pull this registry into the catalogue.");
  }
  const flag = privateRangesWire(d.privateRanges);
  if (flag !== (before.allowPrivateRanges ?? null)) {
    body.allowPrivateRanges = flag;
    if (flag === true) relaxes.push("Allowing private ranges lets this registry's URL resolve into private network space.");
  }
  if (Object.keys(body).length === 0) return { error: "Nothing has changed." };
  return { body, relaxes };
}

// ---------------------------------------------------------------------------
// reading results
// ---------------------------------------------------------------------------

export const SYNC_OUTCOME_TONE: Readonly<Record<RegistrySyncOutcome, "ok" | "warn" | "danger" | "neutral">> = {
  ok: "ok",
  skipped: "neutral",
  refused: "danger",
  failed: "danger",
};

/** one sentence on what a sync did: counts of catalogue rows, never "servers added" */
export function syncSummary(r: RegistrySyncResult): string {
  if (r.outcome !== "ok") return r.reason;
  const parts = [
    `${r.entriesSeen} entr${r.entriesSeen === 1 ? "y" : "ies"} seen`,
    `${r.created} new`,
    `${r.updated} refreshed`,
    `${r.remote} importable`,
    `${r.catalogueOnly} catalogue only`,
  ];
  if (r.conflicts) parts.push(`${r.conflicts} colliding with an existing server`);
  if (r.driftDetected) parts.push(`${r.driftDetected} with a moved endpoint (local URL kept)`);
  if (r.markedMissing) parts.push(`${r.markedMissing} no longer listed`);
  if (r.malformed) parts.push(`${r.malformed} malformed`);
  const tail = r.truncated ? " The page limit stopped the listing early; the rest is pulled next time." : "";
  return `${parts.join(", ")}. No server and no grant was created.${tail}`;
}

/**
 * Can this entry be imported? Blocked only where the gateway's refusal is
 * certain from the row itself (already imported, catalogue only). A recorded
 * name/URL collision, a missing or a deleted upstream entry is shown as a
 * warning: the gateway re-checks collisions live at import and decides.
 */
export function entryImportability(
  e: McpRegistryEntry,
): { importable: true; warning: string | null } | { importable: false; reason: string } {
  if (e.serverId) return { importable: false, reason: "Already imported as an MCP server." };
  if (e.kind === "catalogue_only" || !e.remoteUrl)
    return { importable: false, reason: `Catalogue only: ${e.catalogueReason ?? "the registry lists no endpoint this gateway can reach"}. No URL is invented.` };
  if (e.conflictReason)
    return {
      importable: true,
      warning:
        e.conflictReason === "name_taken"
          ? "At the last sync an existing MCP server had this name. The gateway checks again at import; if that changed, Sync now first."
          : "At the last sync an existing MCP server used this URL. The gateway checks again at import; if that changed, Sync now first.",
    };
  if (e.missingSince) return { importable: true, warning: "The registry no longer lists this entry." };
  if (e.upstreamStatus === "deleted") return { importable: true, warning: "The registry marks this entry deleted." };
  return { importable: true, warning: null };
}

export type RefusalScope = "registry" | "import";

/**
 * The refusal codes, in words, per call (pinned to the gateway source by the
 * test). `conflict` means different things: on a registry create or edit it is
 * the unique-name constraint (the gateway's global 23505 handler); on an
 * import it is a colliding MCP server.
 */
export const REFUSAL_SENTENCES: Readonly<Record<RefusalScope, Readonly<Record<string, string>>>> = {
  registry: {
    unknown_registry: "That registry no longer exists. Refresh the list.",
    conflict: "A registry with this name already exists. Choose another name.",
    egress_blocked: "The gateway's egress guard refused this URL. Nothing was saved.",
    changed_concurrently: "Someone changed this registry while you were saving, so nothing was written. Reload and repeat the change.",
  },
  import: {
    unknown_entry: "That catalogue entry no longer exists. Sync the registry again.",
    not_importable: "This entry cannot be imported: the registry lists no endpoint this gateway can reach.",
    already_imported: "This entry has already been imported as an MCP server.",
    conflict: "An existing MCP server already has this entry's name or URL, so nothing was imported.",
    egress_blocked: "The gateway's egress guard refused this URL. Nothing was imported.",
  },
};

/** a refusal as the scope's sentence plus the gateway's own detail, or null to use the client's reading */
export function registryRefusalText(payload: { error?: unknown; detail?: unknown } | null | undefined, scope: RefusalScope): string | null {
  const code = payload?.error;
  const table = REFUSAL_SENTENCES[scope];
  if (typeof code !== "string" || !Object.hasOwn(table, code)) return null;
  const detail = typeof payload?.detail === "string" && payload.detail.trim() ? ` ${payload.detail.trim()}` : "";
  return `${table[code]}${detail}`;
}

/** a sync answers 200 for every outcome; only `ok` is a success */
export const syncSucceeded = (r: Pick<RegistrySyncResult, "outcome">): boolean => r.outcome === "ok";
