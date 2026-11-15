/**
 * ADR-0332 (lane E14) — one governed view of every AI add-on on every endpoint.
 *
 * A read model over the ADR-0195 / ADR-0259 discovery evidence, in four 3NF tables (packages/db schema block
 * "ADR-0332"): endpoints (the pseudonym, joined to an enrolled device), add-ons (kind + identity), versions (version
 * string + content digest) and sightings (one version on one endpoint from one detection source).
 *
 *   - `projectEndpointAddons` folds the evidence in: every `endpoint_mcp_servers` entry (an MCP server in a coding
 *     agent's config, from the endpoint agent) and every device `shadow_ai_findings` row whose signal came from an
 *     endpoint source (a coding agent, from the endpoint agent, the osquery pack or an inventory import). A sighting
 *     points at its evidence row and is deleted with it, so retention and pruning carry over unchanged.
 *   - `recordEndpointAddonSightings` is the direct contract for facts the evidence tables do not hold (a skill or
 *     plugin with its content digest), for the endpoint lanes to call.
 *   - The admission-scan verdict is joined at read time from `admission_engine_scans` by the version's content
 *     digest (ADR-0242: mcpscanner for an MCP server, skillscanner for a skill), never copied. A version with no
 *     digest, no scanner for its kind or no scan of its digest reads `not_yet_scanned`, never clear.
 *   - `endpointAddonsFlagged` is the "assets flagged at or above severity X" query (the ADR-0332 contract consumed by
 *     the removal directive and the detections).
 *
 * Nothing here returns content: a version is its version string and digest, a scan is its verdict and counts-only
 * findings (the same fields the scanner already exposes), and secrets are their TYPE only (rule ids). Every table is
 * under row-level security (admins and `system_task` only), and every route is admin-only (not in NON_ADMIN_ROUTES).
 *
 *   GET  /v1/endpoint-addons/versions     one row per add-on version: scan status, severity, endpoint count
 *   GET  /v1/endpoint-addons/sightings    one row per version per endpoint per source (filters below)
 *   GET  /v1/endpoint-addons/flagged      sightings flagged at or above `atOrAbove` (+ not yet scanned by default)
 *   POST /v1/endpoint-addons/refresh      re-project the discovery evidence (audited)
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import {
  auditLog,
  ENDPOINT_ADDON_IDENTITY_KINDS,
  ENDPOINT_ADDON_KINDS,
  ENDPOINT_ADDON_SOURCES,
  sql,
  type Db,
  type SQL,
} from "@regulait/db";
import { MCP_ADMISSION_SEVERITIES, type McpAdmissionSeverity } from "@regulait/shared";

const NIL_UUID = "00000000-0000-0000-0000-000000000000";
export type EndpointAddonKind = (typeof ENDPOINT_ADDON_KINDS)[number];
export type EndpointAddonSource = (typeof ENDPOINT_ADDON_SOURCES)[number];
/** pass / fail / unknown are the ADR-0242 verdicts of the latest scan of THIS digest; not_yet_scanned is never clear */
export const ENDPOINT_ADDON_SCAN_STATUSES = ["not_yet_scanned", "pass", "fail", "unknown"] as const;
export type EndpointAddonScanStatus = (typeof ENDPOINT_ADDON_SCAN_STATUSES)[number];
export const ENDPOINT_ADDON_NOT_SCANNED_REASONS = ["no_content_digest", "no_scanner_for_kind", "no_scan_for_digest"] as const;

/** the scanner that owns each kind's content digest (ADR-0242); a kind with none is never scanned here */
const SCANNER_FOR_KIND: Record<EndpointAddonKind, "mcpscanner" | "skillscanner" | null> = {
  coding_agent: null,
  mcp_server: "mcpscanner",
  skill: "skillscanner",
  plugin: null,
};
const SEVERITY_RANK: Record<McpAdmissionSeverity, number> = { low: 1, medium: 2, high: 3, critical: 4 };

// ---------------------------------------------------------------------------
// Projection from the discovery evidence
// ---------------------------------------------------------------------------

export interface EndpointAddonProjection {
  mcpServerSightings: number;
  codingAgentSightings: number;
  prunedVersions: number;
  prunedAddons: number;
}

/**
 * Fold the discovery evidence into the read model. Idempotent and set-based: run it after a report commits, on a
 * schedule, or from the admin refresh route. Must run inside a scope the policies admit (an admin principal or
 * `system_task`); under any other scope row-level security makes it a no-op that writes nothing.
 */
export async function projectEndpointAddons(db: Db): Promise<EndpointAddonProjection> {
  return db.transaction(async (tx) => {
    const t = tx as unknown as Db;
    const one = async (q: SQL): Promise<number> => Number(((await t.execute<{ n: number }>(q)).rows[0]?.n ?? 0));

    // endpoints: every enrolled device with evidence, and every device pseudonym a finding names
    await t.execute(sql`
      INSERT INTO endpoint_addon_endpoints (pseudonym, device_id)
      SELECT d.device_pseudonym, d.id FROM endpoint_devices d
       WHERE EXISTS (SELECT 1 FROM endpoint_mcp_servers m WHERE m.device_id = d.id)
          OR EXISTS (SELECT 1 FROM shadow_ai_findings f WHERE f.subject_kind = 'device' AND f.subject = d.device_pseudonym)
      ON CONFLICT (pseudonym) DO UPDATE SET device_id = COALESCE(endpoint_addon_endpoints.device_id, EXCLUDED.device_id)`);
    await t.execute(sql`
      INSERT INTO endpoint_addon_endpoints (pseudonym)
      SELECT DISTINCT f.subject FROM shadow_ai_findings f
       WHERE f.subject_kind = 'device' AND f.subject ~ '^psn:[0-9a-f]{24}$'
         AND f.signal_sources ?| ARRAY['endpoint_agent', 'endpoint_osquery', 'endpoint_inventory']
      ON CONFLICT (pseudonym) DO NOTHING`);

    // MCP servers: identity as ADR-0259 keys it, version = the reported package version; no digest is reported
    await t.execute(sql`
      INSERT INTO endpoint_addons (kind, identity_kind, identity)
      SELECT DISTINCT 'mcp_server', m.identity_kind, left(m.identity, 255) FROM endpoint_mcp_servers m
      ON CONFLICT (kind, identity_kind, identity) DO NOTHING`);
    await t.execute(sql`
      INSERT INTO endpoint_addon_versions (addon_id, version, content_digest)
      SELECT DISTINCT a.id, left(COALESCE(m.package_version, ''), 128), NULL::text
        FROM endpoint_mcp_servers m
        JOIN endpoint_addons a ON a.kind = 'mcp_server' AND a.identity_kind = m.identity_kind AND a.identity = left(m.identity, 255)
      ON CONFLICT ON CONSTRAINT endpoint_addon_versions_uq DO NOTHING`);
    const mcpServerSightings = await one(sql`
      WITH up AS (
        INSERT INTO endpoint_addon_sightings (version_id, endpoint_id, source, host_agent, endpoint_mcp_server_id, first_seen_at, last_seen_at)
        SELECT v.id, e.id, 'endpoint_agent', m.provider, m.id, m.first_seen_at, m.last_seen_at
          FROM endpoint_mcp_servers m
          JOIN endpoint_devices d ON d.id = m.device_id
          JOIN endpoint_addon_endpoints e ON e.pseudonym = d.device_pseudonym
          JOIN endpoint_addons a ON a.kind = 'mcp_server' AND a.identity_kind = m.identity_kind AND a.identity = left(m.identity, 255)
          JOIN endpoint_addon_versions v ON v.addon_id = a.id AND v.version = left(COALESCE(m.package_version, ''), 128) AND v.content_digest IS NULL
        ON CONFLICT (endpoint_mcp_server_id) WHERE endpoint_mcp_server_id IS NOT NULL DO UPDATE SET
          version_id = EXCLUDED.version_id, endpoint_id = EXCLUDED.endpoint_id, host_agent = EXCLUDED.host_agent,
          first_seen_at = EXCLUDED.first_seen_at, last_seen_at = EXCLUDED.last_seen_at
        RETURNING 1)
      SELECT count(*)::int AS n FROM up`);

    // coding agents: one per device finding from an endpoint source (false positives are an admin's dismissal)
    await t.execute(sql`
      INSERT INTO endpoint_addons (kind, identity_kind, identity)
      SELECT DISTINCT 'coding_agent', 'provider', left(f.provider, 255) FROM shadow_ai_findings f
       WHERE f.subject_kind = 'device' AND f.disposition <> 'false_positive'
         AND f.signal_sources ?| ARRAY['endpoint_agent', 'endpoint_osquery', 'endpoint_inventory']
      ON CONFLICT (kind, identity_kind, identity) DO NOTHING`);
    await t.execute(sql`
      INSERT INTO endpoint_addon_versions (addon_id, version, content_digest)
      SELECT a.id, '', NULL::text FROM endpoint_addons a WHERE a.kind = 'coding_agent'
      ON CONFLICT ON CONSTRAINT endpoint_addon_versions_uq DO NOTHING`);
    const codingAgentSightings = await one(sql`
      WITH up AS (
        INSERT INTO endpoint_addon_sightings (version_id, endpoint_id, source, host_agent, shadow_ai_finding_id, first_seen_at, last_seen_at)
        SELECT v.id, e.id,
               CASE WHEN f.signal_sources ? 'endpoint_agent' THEN 'endpoint_agent'
                    WHEN f.signal_sources ? 'endpoint_osquery' THEN 'endpoint_osquery'
                    ELSE 'endpoint_inventory' END,
               left(f.provider, 255), f.id, LEAST(f.first_seen_at, f.last_seen_at), f.last_seen_at
          FROM shadow_ai_findings f
          JOIN endpoint_addon_endpoints e ON e.pseudonym = f.subject
          JOIN endpoint_addons a ON a.kind = 'coding_agent' AND a.identity_kind = 'provider' AND a.identity = left(f.provider, 255)
          JOIN endpoint_addon_versions v ON v.addon_id = a.id AND v.version = '' AND v.content_digest IS NULL
         WHERE f.subject_kind = 'device' AND f.disposition <> 'false_positive'
           AND f.signal_sources ?| ARRAY['endpoint_agent', 'endpoint_osquery', 'endpoint_inventory']
        ON CONFLICT (shadow_ai_finding_id) WHERE shadow_ai_finding_id IS NOT NULL DO UPDATE SET
          version_id = EXCLUDED.version_id, endpoint_id = EXCLUDED.endpoint_id, source = EXCLUDED.source,
          host_agent = EXCLUDED.host_agent, first_seen_at = EXCLUDED.first_seen_at, last_seen_at = EXCLUDED.last_seen_at
        RETURNING 1)
      SELECT count(*)::int AS n FROM up`);
    // a finding an admin later marked a false positive leaves the inventory
    await t.execute(sql`
      DELETE FROM endpoint_addon_sightings s USING shadow_ai_findings f
       WHERE s.shadow_ai_finding_id = f.id AND f.disposition = 'false_positive'`);

    // versions and add-ons nothing is seen with any more
    const prunedVersions = await one(sql`
      WITH d AS (DELETE FROM endpoint_addon_versions v WHERE NOT EXISTS (SELECT 1 FROM endpoint_addon_sightings s WHERE s.version_id = v.id) RETURNING 1)
      SELECT count(*)::int AS n FROM d`);
    const prunedAddons = await one(sql`
      WITH d AS (DELETE FROM endpoint_addons a WHERE NOT EXISTS (SELECT 1 FROM endpoint_addon_versions v WHERE v.addon_id = a.id) RETURNING 1)
      SELECT count(*)::int AS n FROM d`);
    return { mcpServerSightings, codingAgentSightings, prunedVersions, prunedAddons };
  });
}

// ---------------------------------------------------------------------------
// Direct record contract (skills, plugins: facts the evidence tables do not hold)
// ---------------------------------------------------------------------------

const IDENTITY_RE = /^[A-Za-z0-9@[][A-Za-z0-9@._~/:+[\] -]{0,254}$/;
export const endpointAddonSightingInput = z
  .object({
    kind: z.enum(ENDPOINT_ADDON_KINDS),
    identityKind: z.enum(ENDPOINT_ADDON_IDENTITY_KINDS),
    identity: z.string().regex(IDENTITY_RE),
    version: z.string().max(128).regex(/^[A-Za-z0-9._+~:-]*$/).default(""),
    contentDigest: z.string().regex(/^[0-9a-f]{64}$/).nullable().default(null),
    endpointPseudonym: z.string().regex(/^psn:[0-9a-f]{24}$/),
    deviceId: z.string().uuid().nullable().default(null),
    source: z.enum(ENDPOINT_ADDON_SOURCES),
    hostAgent: z.string().max(255).regex(/^[A-Za-z0-9._:-]*$/).default(""),
    // secret TYPES only (rule ids); a name or value cannot match this shape
    secretTypes: z.array(z.string().regex(/^[a-z][a-z0-9_.]{0,63}$/)).max(32).default([]),
    seenAt: z.coerce.date(),
  })
  .strict();
export type EndpointAddonSightingInput = z.input<typeof endpointAddonSightingInput>;

/**
 * Record sightings the endpoint lanes report directly (ADR-0332 contract). Validates every input (a bad one refuses
 * the whole batch), keeps first_seen and advances last_seen monotonically, and replaces the secret types on each
 * newer sighting. Same scope rule as the projection.
 */
export async function recordEndpointAddonSightings(db: Db, inputs: readonly EndpointAddonSightingInput[]): Promise<{ recorded: number }> {
  const parsed = z.array(endpointAddonSightingInput).max(1000).parse(inputs);
  if (!parsed.length) return { recorded: 0 };
  return db.transaction(async (tx) => {
    const t = tx as unknown as Db;
    for (const o of parsed) {
      const ep = await t.execute<{ id: string }>(sql`
        INSERT INTO endpoint_addon_endpoints (pseudonym, device_id) VALUES (${o.endpointPseudonym}, ${o.deviceId})
        ON CONFLICT (pseudonym) DO UPDATE SET device_id = COALESCE(endpoint_addon_endpoints.device_id, EXCLUDED.device_id)
        RETURNING id`);
      const ad = await t.execute<{ id: string }>(sql`
        INSERT INTO endpoint_addons (kind, identity_kind, identity) VALUES (${o.kind}, ${o.identityKind}, ${o.identity})
        ON CONFLICT (kind, identity_kind, identity) DO UPDATE SET identity = EXCLUDED.identity
        RETURNING id`);
      const ve = await t.execute<{ id: string }>(sql`
        INSERT INTO endpoint_addon_versions (addon_id, version, content_digest) VALUES (${ad.rows[0]!.id}, ${o.version}, ${o.contentDigest})
        ON CONFLICT ON CONSTRAINT endpoint_addon_versions_uq DO UPDATE SET version = EXCLUDED.version
        RETURNING id`);
      const si = await t.execute<{ id: string; newer: boolean }>(sql`
        INSERT INTO endpoint_addon_sightings (version_id, endpoint_id, source, host_agent, first_seen_at, last_seen_at)
        VALUES (${ve.rows[0]!.id}, ${ep.rows[0]!.id}, ${o.source}, ${o.hostAgent}, ${o.seenAt}, ${o.seenAt})
        ON CONFLICT (version_id, endpoint_id, source, host_agent) WHERE endpoint_mcp_server_id IS NULL AND shadow_ai_finding_id IS NULL
        DO UPDATE SET first_seen_at = LEAST(endpoint_addon_sightings.first_seen_at, EXCLUDED.first_seen_at),
                      last_seen_at = GREATEST(endpoint_addon_sightings.last_seen_at, EXCLUDED.last_seen_at)
        RETURNING id, (last_seen_at = ${o.seenAt}) AS newer`);
      const row = si.rows[0]!;
      if (row.newer) {
        await t.execute(sql`DELETE FROM endpoint_addon_sighting_secret_types WHERE sighting_id = ${row.id}`);
        for (const st of [...new Set(o.secretTypes)]) {
          await t.execute(sql`INSERT INTO endpoint_addon_sighting_secret_types (sighting_id, secret_type) VALUES (${row.id}, ${st}) ON CONFLICT DO NOTHING`);
        }
      }
    }
    return { recorded: parsed.length };
  });
}

// ---------------------------------------------------------------------------
// Read model: versions joined to the latest scan of their exact digest
// ---------------------------------------------------------------------------

const SCANNER_CASE = sql.raw(
  `CASE a.kind ${Object.entries(SCANNER_FOR_KIND)
    .map(([k, e]) => `WHEN '${k}' THEN ${e ? `'${e}'` : "NULL"}`)
    .join(" ")} END`,
);
const RANK_CASE = sql.raw(
  `CASE f->>'severity' ${Object.entries(SEVERITY_RANK)
    .map(([s, r]) => `WHEN '${s}' THEN ${r}`)
    .join(" ")} END`,
);

/** one row per version, with its add-on, its latest scan for its exact digest and the scan's top severity rank */
const VERSIONS_CTE = sql`
  scanned AS (
    SELECT v.id AS version_id, v.version, v.content_digest, a.id AS addon_id, a.kind, a.identity_kind, a.identity,
           ${SCANNER_CASE} AS scanner, sc.id AS scan_id, sc.verdict, sc.findings, sc.created_at AS scanned_at,
           sc.engine_version, sc.rules_sha256,
           (SELECT max(${RANK_CASE}) FROM jsonb_array_elements(COALESCE(sc.findings, '[]'::jsonb)) f) AS severity_rank
      FROM endpoint_addon_versions v
      JOIN endpoint_addons a ON a.id = v.addon_id
      LEFT JOIN LATERAL (
        SELECT s.id, s.verdict, s.findings, s.created_at, s.engine_version, s.rules_sha256 FROM admission_engine_scans s
         WHERE v.content_digest IS NOT NULL AND s.engine_id = ${SCANNER_CASE} AND s.subject_digest = v.content_digest
         ORDER BY s.created_at DESC, s.id DESC LIMIT 1) sc ON true
  )`;

const SEVERITY_FILTERS = [...MCP_ADMISSION_SEVERITIES, "not_yet_scanned"] as const;
/** a comma-separated (or repeated) query parameter of closed values */
const csv = <const T extends readonly [string, ...string[]]>(values: T) =>
  z
    .union([z.string(), z.array(z.string())])
    .transform((v) => (Array.isArray(v) ? v : v.split(",")).map((s) => s.trim()).filter(Boolean))
    .pipe(z.array(z.enum(values)).min(1).max(8));

const filterShape = {
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  kind: csv(ENDPOINT_ADDON_KINDS).optional(),
  severity: csv(SEVERITY_FILTERS).optional(),
  atOrAbove: z.enum(MCP_ADMISSION_SEVERITIES).optional(),
  scanStatus: csv(ENDPOINT_ADDON_SCAN_STATUSES).optional(),
  addonId: z.string().uuid().optional(),
  identity: z.string().regex(IDENTITY_RE).optional(),
  version: z.string().max(128).optional(),
};
const versionsQuery = z.object(filterShape).strict();
const sightingsQuery = z
  .object({
    ...filterShape,
    agent: z.string().max(255).regex(/^[A-Za-z0-9._:-]+$/).optional(),
    endpointId: z.string().uuid().optional(),
    deviceId: z.string().uuid().optional(),
    endpointPseudonym: z.string().regex(/^psn:[0-9a-f]{24}$/).optional(),
    source: csv(ENDPOINT_ADDON_SOURCES).optional(),
  })
  .strict();
const flaggedQuery = sightingsQuery
  .omit({ atOrAbove: true, severity: true, scanStatus: true })
  .extend({
    atOrAbove: z.enum(MCP_ADMISSION_SEVERITIES),
    // secure default: an add-on nobody has scanned is not clear, so it is listed unless a consumer opts out
    notYetScanned: z.enum(["include", "exclude"]).default("include"),
  })
  .strict();
export type EndpointAddonVersionsQuery = z.input<typeof versionsQuery>;
export type EndpointAddonSightingsQuery = z.input<typeof sightingsQuery>;
export type EndpointAddonFlaggedQuery = z.input<typeof flaggedQuery>;

const SCAN_STATUS_SQL = sql`(CASE WHEN x.scan_id IS NULL THEN 'not_yet_scanned' ELSE x.verdict END)`;

function versionConds(f: z.output<typeof versionsQuery>): SQL[] {
  const c: SQL[] = [];
  if (f.kind) c.push(sql`x.kind IN (${sql.join(f.kind.map((k) => sql`${k}`), sql`, `)})`);
  if (f.addonId) c.push(sql`x.addon_id = ${f.addonId}`);
  if (f.identity) c.push(sql`x.identity = ${f.identity}`);
  if (f.version !== undefined) c.push(sql`x.version = ${f.version}`);
  if (f.scanStatus) c.push(sql`${SCAN_STATUS_SQL} IN (${sql.join(f.scanStatus.map((s) => sql`${s}`), sql`, `)})`);
  if (f.atOrAbove) c.push(sql`x.severity_rank >= ${SEVERITY_RANK[f.atOrAbove]}`);
  if (f.severity) {
    const ranks = f.severity.filter((s): s is McpAdmissionSeverity => s !== "not_yet_scanned").map((s) => SEVERITY_RANK[s]);
    const parts: SQL[] = [];
    if (ranks.length) parts.push(sql`x.severity_rank IN (${sql.join(ranks.map((r) => sql`${r}`), sql`, `)})`);
    if (f.severity.includes("not_yet_scanned")) parts.push(sql`x.scan_id IS NULL`);
    c.push(sql`(${sql.join(parts, sql` OR `)})`);
  }
  return c;
}

type VersionRowDb = {
  version_id: string;
  version: string;
  content_digest: string | null;
  addon_id: string;
  kind: EndpointAddonKind;
  identity_kind: string;
  identity: string;
  scanner: string | null;
  scan_id: string | null;
  verdict: "pass" | "fail" | "unknown" | null;
  findings: Array<{ rule: string; severity: string; tool: string; count: number }> | null;
  scanned_at: string | Date | null;
  engine_version: string | null;
  rules_sha256: string | null;
  severity_rank: number | null;
  registry_mcp_server_id: string | null;
};

const RANK_TO_SEVERITY = Object.fromEntries(Object.entries(SEVERITY_RANK).map(([s, r]) => [r, s])) as Record<number, McpAdmissionSeverity>;
const iso = (d: string | Date | null): string | null => (d === null ? null : new Date(d).toISOString());

function scanView(r: VersionRowDb) {
  if (!r.scan_id) {
    const reason = r.scanner === null ? "no_scanner_for_kind" : r.content_digest === null ? "no_content_digest" : "no_scan_for_digest";
    return {
      status: "not_yet_scanned" as const,
      severity: null,
      notScannedReason: reason,
      summary:
        reason === "no_scanner_for_kind"
          ? `NOT YET SCANNED: no admission scanner covers a ${r.kind.replace("_", " ")}; treat it as unreviewed, not clear.`
          : reason === "no_content_digest"
            ? "NOT YET SCANNED: the endpoint reported no content digest, so no scan can be tied to this exact content; treat it as unreviewed, not clear."
            : "NOT YET SCANNED: no admission scan exists for this exact content digest; treat it as unreviewed, not clear.",
      scanner: r.scanner,
      scannedAt: null,
      engineVersion: null,
      rulesSha256: null,
      findings: [] as Array<{ rule: string; severity: string; tool: string; count: number }>,
    };
  }
  const severity = r.severity_rank ? (RANK_TO_SEVERITY[r.severity_rank] ?? null) : null;
  return {
    status: r.verdict as "pass" | "fail" | "unknown",
    severity,
    notScannedReason: null,
    summary:
      r.verdict === "pass"
        ? `Scanned by ${r.scanner}: pass${severity ? ` (top finding ${severity})` : ""}.`
        : r.verdict === "fail"
          ? `Scanned by ${r.scanner}: FAIL${severity ? ` (top finding ${severity})` : ""}.`
          : `Scanned by ${r.scanner}: inconclusive; treat it as unreviewed, not clear.`,
    scanner: r.scanner,
    scannedAt: iso(r.scanned_at),
    engineVersion: r.engine_version,
    rulesSha256: r.rules_sha256,
    // counts-only findings, exactly the fields the scanner already exposes (ADR-0242); `where` is engine-internal
    findings: (r.findings ?? [])
      .filter((x) => x.severity in SEVERITY_RANK)
      .map((x) => ({ rule: x.rule, severity: x.severity, tool: x.tool, count: x.count })),
  };
}

/** the registry link and AI-BOM pointers: an MCP server identity an admin linked to an approved server (ADR-0259) */
function aiBomView(r: VersionRowDb) {
  if (!r.registry_mcp_server_id) return null;
  return {
    mcpServerId: r.registry_mcp_server_id,
    // aiBomRef.mcp (packages/shared bom/ai-bom-cyclonedx.ts): the server's component in the install AI-BOM
    bomRef: `service:mcp:${r.registry_mcp_server_id}`,
    snapshots: `/v1/ai-bom/install/${NIL_UUID}/snapshots`,
    note: "The AI-BOM entry describes the approved registry server, not the bytes on this endpoint.",
  };
}

const REGISTRY_JOIN = sql`LEFT JOIN endpoint_mcp_server_links l
  ON x.kind = 'mcp_server' AND l.identity_kind = x.identity_kind AND l.identity = x.identity`;

function versionView(r: VersionRowDb) {
  return {
    addon: { id: r.addon_id, kind: r.kind, identity: { kind: r.identity_kind, value: r.identity } },
    version: { id: r.version_id, version: r.version === "" ? null : r.version, contentDigest: r.content_digest },
    scan: scanView(r),
    aiBom: aiBomView(r),
  };
}

export async function listEndpointAddonVersions(db: Db, query: EndpointAddonVersionsQuery) {
  const f = versionsQuery.parse(query);
  const conds = versionConds(f);
  if (f.cursor) conds.push(sql`x.version_id > ${f.cursor}`);
  const rows = (
    await db.execute<VersionRowDb & { endpoints: number; first_seen_at: string; last_seen_at: string }>(sql`
      WITH ${VERSIONS_CTE}
      SELECT x.*, l.mcp_server_id AS registry_mcp_server_id,
             (SELECT count(DISTINCT s.endpoint_id)::int FROM endpoint_addon_sightings s WHERE s.version_id = x.version_id) AS endpoints,
             (SELECT min(s.first_seen_at) FROM endpoint_addon_sightings s WHERE s.version_id = x.version_id) AS first_seen_at,
             (SELECT max(s.last_seen_at) FROM endpoint_addon_sightings s WHERE s.version_id = x.version_id) AS last_seen_at
        FROM scanned x ${REGISTRY_JOIN}
       ${conds.length ? sql`WHERE ${sql.join(conds, sql` AND `)}` : sql``}
       ORDER BY x.version_id ASC
       LIMIT ${f.limit + 1}`)
  ).rows;
  const page = rows.slice(0, f.limit);
  return {
    items: page.map((r) => ({ ...versionView(r), endpoints: r.endpoints, firstSeenAt: iso(r.first_seen_at), lastSeenAt: iso(r.last_seen_at) })),
    nextCursor: rows.length > f.limit ? page[page.length - 1]!.version_id : null,
  };
}

type SightingRowDb = VersionRowDb & {
  sighting_id: string;
  endpoint_id: string;
  pseudonym: string;
  device_id: string | null;
  source: EndpointAddonSource;
  host_agent: string;
  endpoint_mcp_server_id: string | null;
  shadow_ai_finding_id: string | null;
  first_seen_at: string;
  last_seen_at: string;
  secret_types: string[] | null;
  risks: string[] | null;
  finding_severity: string | null;
};

async function querySightings(db: Db, f: z.output<typeof sightingsQuery>, extra: SQL[]) {
  const conds = [...versionConds(f), ...extra];
  if (f.cursor) conds.push(sql`s.id > ${f.cursor}`);
  if (f.agent) conds.push(sql`s.host_agent = ${f.agent}`);
  if (f.endpointId) conds.push(sql`s.endpoint_id = ${f.endpointId}`);
  if (f.deviceId) conds.push(sql`e.device_id = ${f.deviceId}`);
  if (f.endpointPseudonym) conds.push(sql`e.pseudonym = ${f.endpointPseudonym}`);
  if (f.source) conds.push(sql`s.source IN (${sql.join(f.source.map((x) => sql`${x}`), sql`, `)})`);
  const rows = (
    await db.execute<SightingRowDb>(sql`
      WITH ${VERSIONS_CTE}
      SELECT x.*, l.mcp_server_id AS registry_mcp_server_id,
             s.id AS sighting_id, s.endpoint_id, e.pseudonym, e.device_id, s.source, s.host_agent,
             s.endpoint_mcp_server_id, s.shadow_ai_finding_id, s.first_seen_at, s.last_seen_at,
             -- secret TYPES and risk flag names only (ADR-0259), never a key name or value
             COALESCE(m.secret_types, (SELECT array_agg(st.secret_type ORDER BY st.secret_type) FROM endpoint_addon_sighting_secret_types st
                                        WHERE st.sighting_id = s.id)) AS secret_types,
             m.risks, fd.severity AS finding_severity
        FROM endpoint_addon_sightings s
        JOIN scanned x ON x.version_id = s.version_id
        JOIN endpoint_addon_endpoints e ON e.id = s.endpoint_id
        LEFT JOIN endpoint_mcp_servers m ON m.id = s.endpoint_mcp_server_id
        LEFT JOIN shadow_ai_findings fd ON fd.id = s.shadow_ai_finding_id
        ${REGISTRY_JOIN}
       ${conds.length ? sql`WHERE ${sql.join(conds, sql` AND `)}` : sql``}
       ORDER BY s.id ASC
       LIMIT ${f.limit + 1}`)
  ).rows;
  const page = rows.slice(0, f.limit);
  return {
    items: page.map((r) => ({
      id: r.sighting_id,
      ...versionView(r),
      endpoint: { id: r.endpoint_id, pseudonym: r.pseudonym, deviceId: r.device_id },
      detection: {
        source: r.source,
        hostAgent: r.host_agent === "" ? null : r.host_agent,
        endpointMcpServerId: r.endpoint_mcp_server_id,
        shadowAiFindingId: r.shadow_ai_finding_id,
        discoverySeverity: r.finding_severity,
        risks: r.risks ?? [],
        secretTypes: r.secret_types ?? [],
      },
      firstSeenAt: iso(r.first_seen_at),
      lastSeenAt: iso(r.last_seen_at),
    })),
    nextCursor: rows.length > f.limit ? page[page.length - 1]!.sighting_id : null,
  };
}

export async function listEndpointAddonSightings(db: Db, query: EndpointAddonSightingsQuery) {
  return querySightings(db, sightingsQuery.parse(query), []);
}

/**
 * ADR-0332 contract: the sightings whose add-on version's latest scan of its exact digest has a finding at or above
 * `atOrAbove`, plus (default `notYetScanned: "include"`) every sighting not yet scanned or scanned inconclusively,
 * because unscanned is never clear. Keyset paginated on the sighting id; the consumer decides what to do per row.
 */
export async function endpointAddonsFlagged(db: Db, query: EndpointAddonFlaggedQuery) {
  const f = flaggedQuery.parse(query);
  const rank = SEVERITY_RANK[f.atOrAbove];
  const flagged =
    f.notYetScanned === "include"
      ? sql`(x.severity_rank >= ${rank} OR x.scan_id IS NULL OR x.verdict = 'unknown')`
      : sql`(x.severity_rank >= ${rank})`;
  const out = await querySightings(db, { ...f, atOrAbove: undefined, severity: undefined, scanStatus: undefined }, [flagged]);
  return { atOrAbove: f.atOrAbove, notYetScanned: f.notYetScanned, ...out };
}

// ---------------------------------------------------------------------------
// Routes (admin-only: none is in NON_ADMIN_ROUTES)
// ---------------------------------------------------------------------------

const refuse = (reply: FastifyReply, status: number, error: string, detail: string) => reply.status(status).send({ error, detail });
const issues = (e: z.ZodError) => e.issues.map((i) => `${i.path.join(".") || "query"}: ${i.message}`).join("; ");

export function registerEndpointAddonInventoryRoutes(app: FastifyInstance, db: Db): void {
  app.get("/v1/endpoint-addons/versions", async (req, reply) => {
    const q = versionsQuery.safeParse(req.query ?? {});
    if (!q.success) return refuse(reply, 400, "invalid_query", issues(q.error));
    return listEndpointAddonVersions(db, q.data);
  });

  app.get("/v1/endpoint-addons/sightings", async (req, reply) => {
    const q = sightingsQuery.safeParse(req.query ?? {});
    if (!q.success) return refuse(reply, 400, "invalid_query", issues(q.error));
    return listEndpointAddonSightings(db, q.data);
  });

  app.get("/v1/endpoint-addons/flagged", async (req, reply) => {
    const q = flaggedQuery.safeParse(req.query ?? {});
    if (!q.success) return refuse(reply, 400, "invalid_query", issues(q.error));
    return endpointAddonsFlagged(db, q.data);
  });

  app.post("/v1/endpoint-addons/refresh", async (req, reply) => {
    if (req.body !== undefined && req.body !== null && (typeof req.body !== "object" || Object.keys(req.body as object).length)) {
      return refuse(reply, 400, "invalid_body", "this route takes no body");
    }
    const result = await projectEndpointAddons(db);
    await db.insert(auditLog).values({
      userId: req.authCtx.userId ?? NIL_UUID,
      // the projection reads every endpoint discovery source's evidence; no single object
      objectType: "discovery_source",
      objectId: null,
      detail: { subsystem: "endpoint-addon-inventory", adr: "0332", ...result },
      effect: "allow",
      ruleId: "endpoint-addon-inventory-refreshed",
      ruleChain: [],
      reason: `endpoint AI add-on inventory re-projected from discovery evidence (ADR-0332): ${result.mcpServerSightings} MCP server and ${result.codingAgentSightings} coding agent sightings`,
    });
    return reply.status(200).send(result);
  });
}
