/**
 * ADR-0195 SD0 — what active discovery is doing right now, for the posture
 * reads: the enabled sources (named in every shadow-AI and MCP-discovery
 * posture sentence, decision 5b) and the enforcement-posture rows (sources
 * enabled, static credentials in use, credentials older than the warning age,
 * credentials whose write scope is unverified). Reads only; imports nothing
 * but the database, so any route module may use it without an import cycle.
 */
import { and, asc, discoveryCredentials, discoverySettings, discoverySources, eq, isNull, sql, type Db } from "@regulait/db";
import {
  activeDiscoveryPosture,
  DISCOVERY_CREDENTIAL_WARNING_DEFAULT_DAYS,
  DISCOVERY_ENDPOINT_RETENTION_DEFAULT_DAYS,
  DISCOVERY_FAMILY_SWITCHES_DEFAULT,
  familySwitchProblem,
  type ActiveDiscoverySource,
  type DiscoveryFamilySwitches,
  type DiscoverySourceKind,
} from "@regulait/shared";

export interface DiscoverySettingsView {
  credentialWarningAgeDays: number;
  endpointRetentionDays: number;
  /** ADR-0235: the wider-source family switches (all off by default) */
  families: DiscoveryFamilySwitches;
  /** ADR-0259: MCP client-config discovery through the endpoint agent (off by default) */
  endpointMcpConfig: boolean;
  /** ADR-0337 §4: Google Workspace sources may use the Directory token listing (off by default) */
  googleDirectoryTokens: boolean;
  /** ADR-0331: governed removal of flagged MCP servers from endpoints (off by default) */
  endpointAddonRemoval: boolean;
  /** ADR-0338: governed vendor agent control (off by default) and its approval window in hours (24 by default) */
  vendorAgentControl: boolean;
  vendorAgentControlApprovalTtlHours: number;
  version: number;
  updatedAt: string | null;
}

export async function loadDiscoverySettings(db: Db): Promise<DiscoverySettingsView> {
  const [row] = await db.select().from(discoverySettings).where(eq(discoverySettings.id, 1));
  // the migration inserts the row; its absence reads as the strict defaults, never as "no limit"
  if (!row) {
    return {
      credentialWarningAgeDays: DISCOVERY_CREDENTIAL_WARNING_DEFAULT_DAYS,
      endpointRetentionDays: DISCOVERY_ENDPOINT_RETENTION_DEFAULT_DAYS,
      families: DISCOVERY_FAMILY_SWITCHES_DEFAULT,
      endpointMcpConfig: false,
      googleDirectoryTokens: false,
      endpointAddonRemoval: false,
      vendorAgentControl: false,
      vendorAgentControlApprovalTtlHours: 24,
      version: 1,
      updatedAt: null,
    };
  }
  return {
    credentialWarningAgeDays: row.credentialWarningAgeDays,
    endpointRetentionDays: row.endpointRetentionDays,
    families: { saas: row.saasSourcesEnabled, identity: row.identitySourcesEnabled, ml_platform: row.mlPlatformSourcesEnabled, agent_registry: row.agentRegistrySourcesEnabled },
    endpointMcpConfig: row.endpointMcpConfigEnabled,
    googleDirectoryTokens: row.googleDirectoryTokensEnabled,
    endpointAddonRemoval: row.endpointAddonRemovalEnabled,
    vendorAgentControl: row.vendorAgentControlEnabled,
    vendorAgentControlApprovalTtlHours: row.vendorAgentControlApprovalTtlHours,
    version: row.version,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** the enabled sources, by name; a source whose family is switched off is not scanned, so it is not named (ADR-0235) */
export async function activeDiscoverySources(db: Db): Promise<ActiveDiscoverySource[]> {
  const { families } = await loadDiscoverySettings(db);
  const rows = await db
    .select({ name: discoverySources.name, kind: discoverySources.kind })
    .from(discoverySources)
    .where(eq(discoverySources.enabled, true))
    .orderBy(asc(discoverySources.name));
  return rows.filter((r) => familySwitchProblem(r.kind, families) === null);
}

/** the posture sentence naming the enabled sources (decision 5b) */
export async function activeDiscoveryStatement(db: Db): Promise<string> {
  return activeDiscoveryPosture(await activeDiscoverySources(db));
}

interface SourceRef {
  sourceId: string;
  name: string;
  kind: DiscoverySourceKind;
  enabled: boolean;
}

export interface DiscoveryPosture {
  sourcesTotal: number;
  sourcesEnabled: SourceRef[];
  /** sources whose live credential is a stored static secret (an admin relaxation) */
  staticCredentials: Array<SourceRef & { ageDays: number }>;
  /** static credentials older than the warning age */
  staleCredentials: Array<SourceRef & { ageDays: number }>;
  /** live credentials no scanner has verified as read-only (decision 7: "write scope unverified") */
  writeScopeUnverified: SourceRef[];
  /** credentials a scanner found to grant write access: refused, the source blocked until replaced */
  credentialsRefused: SourceRef[];
  credentialWarningAgeDays: number;
  endpointRetentionDays: number;
  /** ADR-0235: the wider-source family switches */
  families: DiscoveryFamilySwitches;
  /** ADR-0337 §4: whether Google Workspace sources may use the Directory token listing (its scope could revoke) */
  googleDirectoryTokens: boolean;
  /** ADR-0337 §4: the Google Workspace sources configured to read every user's OAuth token grants */
  directoryTokenSources: SourceRef[];
  statement: string;
}

export async function discoveryPosture(db: Db): Promise<DiscoveryPosture> {
  const settings = await loadDiscoverySettings(db);
  const sources = await db
    .select({ sourceId: discoverySources.id, name: discoverySources.name, kind: discoverySources.kind, enabled: discoverySources.enabled, target: discoverySources.target })
    .from(discoverySources)
    .orderBy(asc(discoverySources.name))
    .then((rows) => rows.map(({ target, ...ref }) => ({ ...ref, directoryTokens: directoryTokensRequested(ref.kind, target) })));
  const creds = await db
    .select({
      sourceId: discoveryCredentials.sourceId,
      mode: discoveryCredentials.credentialMode,
      writeScope: discoveryCredentials.writeScope,
      // the database clock (M-075)
      ageDays: sql<number>`floor(extract(epoch from (now() - ${discoveryCredentials.createdAt})) / 86400)::int`,
    })
    .from(discoveryCredentials)
    .where(and(isNull(discoveryCredentials.revokedAt)));
  const byId = new Map(sources.map(({ directoryTokens: _d, ...s }) => [s.sourceId, s]));
  const staticCredentials: DiscoveryPosture["staticCredentials"] = [];
  const writeScopeUnverified: SourceRef[] = [];
  const credentialsRefused: SourceRef[] = [];
  for (const c of creds) {
    const s = byId.get(c.sourceId);
    if (!s) continue;
    if (c.mode === "static") staticCredentials.push({ ...s, ageDays: Number(c.ageDays) });
    if (c.writeScope === "unverified") writeScopeUnverified.push(s);
    if (c.writeScope === "refused") credentialsRefused.push(s);
  }
  const staleCredentials = staticCredentials.filter((c) => c.ageDays >= settings.credentialWarningAgeDays);
  // a source whose family is switched off is never run, so it is not counted as scanning (ADR-0235)
  const enabled = sources.filter((s) => s.enabled && familySwitchProblem(s.kind, settings.families) === null).map(({ directoryTokens: _d, ...s }) => s);
  const directoryTokenSources = sources.filter((s) => s.directoryTokens).map(({ directoryTokens: _d, ...s }) => s);
  return {
    sourcesTotal: sources.length,
    sourcesEnabled: enabled,
    staticCredentials,
    staleCredentials,
    writeScopeUnverified,
    credentialsRefused,
    credentialWarningAgeDays: settings.credentialWarningAgeDays,
    endpointRetentionDays: settings.endpointRetentionDays,
    families: settings.families,
    googleDirectoryTokens: settings.googleDirectoryTokens,
    directoryTokenSources,
    statement: activeDiscoveryPosture(enabled),
  };
}

/** ADR-0337 §4: a Google Workspace source whose target asks for the Directory token listing */
export function directoryTokensRequested(kind: DiscoverySourceKind, target: Readonly<Record<string, unknown>>): boolean {
  return kind === "entitlement_google_workspace" && target.directoryTokens === "on";
}

/**
 * ADR-0337 §4: why a source may not use the Directory token listing, or null. The listing's scope could also revoke
 * tokens, so the org switch (`googleDirectoryTokens`, off by default, its own `settings_relax` step-up) must be on
 * before any source is created, widened, enabled or run with it.
 */
export function directoryTokensProblem(kind: DiscoverySourceKind, target: Readonly<Record<string, unknown>>, settings: Pick<DiscoverySettingsView, "googleDirectoryTokens">): string | null {
  if (!directoryTokensRequested(kind, target) || settings.googleDirectoryTokens) return null;
  return "the Google Directory token listing is not allowed: an admin must first turn on 'googleDirectoryTokens' in the discovery settings (a step-up); its scope could also revoke tokens";
}
