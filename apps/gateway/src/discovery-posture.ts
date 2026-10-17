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
  type ActiveDiscoverySource,
  type DiscoverySourceKind,
} from "@regulait/shared";

export interface DiscoverySettingsView {
  credentialWarningAgeDays: number;
  endpointRetentionDays: number;
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
      version: 1,
      updatedAt: null,
    };
  }
  return {
    credentialWarningAgeDays: row.credentialWarningAgeDays,
    endpointRetentionDays: row.endpointRetentionDays,
    version: row.version,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** the enabled sources, by name */
export async function activeDiscoverySources(db: Db): Promise<ActiveDiscoverySource[]> {
  return db
    .select({ name: discoverySources.name, kind: discoverySources.kind })
    .from(discoverySources)
    .where(eq(discoverySources.enabled, true))
    .orderBy(asc(discoverySources.name));
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
  statement: string;
}

export async function discoveryPosture(db: Db): Promise<DiscoveryPosture> {
  const settings = await loadDiscoverySettings(db);
  const sources = await db
    .select({ sourceId: discoverySources.id, name: discoverySources.name, kind: discoverySources.kind, enabled: discoverySources.enabled })
    .from(discoverySources)
    .orderBy(asc(discoverySources.name));
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
  const byId = new Map(sources.map((s) => [s.sourceId, s]));
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
  const enabled = sources.filter((s) => s.enabled);
  return {
    sourcesTotal: sources.length,
    sourcesEnabled: enabled,
    staticCredentials,
    staleCredentials,
    writeScopeUnverified,
    credentialsRefused,
    credentialWarningAgeDays: settings.credentialWarningAgeDays,
    endpointRetentionDays: settings.endpointRetentionDays,
    statement: activeDiscoveryPosture(enabled),
  };
}
