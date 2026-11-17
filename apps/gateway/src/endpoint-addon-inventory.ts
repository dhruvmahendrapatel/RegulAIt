/**
 * ADR-0332 (lane E14) — one governed view of every AI add-on on every endpoint.
 *
 * The inventory is READ, never projected, so it cannot lag or copy the evidence:
 *
 *   - MCP servers: `endpoint_mcp_servers` (ADR-0259), one row per server entry per enrolled device;
 *   - coding agents: device `shadow_ai_findings` whose signal came from an endpoint source (ADR-0195: the endpoint
 *     agent, the osquery pack or an inventory import), a false positive excluded;
 *   - skills and plugins: the direct-record tables (`endpoint_addons` / `_versions` / `_sightings`), written through
 *     `recordEndpointAddonSightings` by the endpoint lanes, because no evidence table holds them.
 *
 * Every fact is joined from its one home (first/last seen, version, source, device pseudonym, risk flags, secret
 * types), so retention and pruning of the evidence apply unchanged. The admission-scan verdict is joined from
 * `admission_engine_scans` by the version's content digest (ADR-0242) and decided by the gate's own helper
 * (`engineAdmissionHold`): a disabled engine, no digest, no scanner for the kind or no scan of that digest reads
 * `not_yet_scanned`, never clear. `endpointAddonsFlagged` is the "assets flagged at or above severity X" contract.
 *
 * Nothing here returns content: a version is its version string and digest, a scan is its verdict and counts-only
 * findings (the fields the scanner already exposes), and secrets are their TYPE only (rule ids). The direct-record
 * tables are under row-level security (admins and `system_task` only), and every route is admin-only (not in
 * NON_ADMIN_ROUTES). Read-only routes: nothing here changes state on a request.
 *
 *   GET /v1/endpoint-addons/versions     one row per add-on version: scan status, severity, endpoint count
 *   GET /v1/endpoint-addons/sightings    one row per version per endpoint per source (filters below)
 *   GET /v1/endpoint-addons/flagged      sightings flagged at or above `atOrAbove` (+ not yet scanned by default)
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import {
  and,
  endpointDevices,
  engines,
  ENDPOINT_ADDON_IDENTITY_KINDS,
  ENDPOINT_ADDON_KINDS,
  ENDPOINT_ADDON_SOURCES,
  inArray,
  isNull,
  sql,
  type Db,
  type SQL,
} from "@regulait/db";
import {
  ADMISSION_SCAN_ENGINE_IDS,
  AI_BOM_INSTALL_SUBJECT_ID,
  admissionScanEngineFor,
  aiBomRef,
  engineAdmissionHold,
  MCP_ADMISSION_SEVERITIES,
  maxSeverity,
  type AdmissionScanEngineId,
  type AdmissionScanSubjectKind,
  type AdmissionScanVerdict,
  type McpAdmissionFinding,
  type McpAdmissionSeverity,
} from "@regulait/shared";
import { ENDPOINT_IDENTITY_RE } from "./endpoint-mcp-config.js";

export type EndpointAddonKind = (typeof ENDPOINT_ADDON_KINDS)[number];
export type EndpointAddonSource = (typeof ENDPOINT_ADDON_SOURCES)[number];
/** pass / fail / unknown are the ADR-0242 verdicts of the latest scan of THIS digest; not_yet_scanned is never clear */
export const ENDPOINT_ADDON_SCAN_STATUSES = ["not_yet_scanned", "pass", "fail", "unknown"] as const;
export type EndpointAddonScanStatus = (typeof ENDPOINT_ADDON_SCAN_STATUSES)[number];
export const ENDPOINT_ADDON_NOT_SCANNED_REASONS = ["no_scanner_for_kind", "scanner_off", "no_content_digest", "no_scan_for_digest"] as const;
export type EndpointAddonNotScannedReason = (typeof ENDPOINT_ADDON_NOT_SCANNED_REASONS)[number];

/** the admission-scan subject an add-on kind is (ADR-0242); the engine comes from `admissionScanEngineFor` */
const SCAN_SUBJECT_FOR_KIND: Record<EndpointAddonKind, AdmissionScanSubjectKind | null> = {
  coding_agent: null,
  mcp_server: "mcp_server",
  skill: "builder_skill",
  plugin: null,
};
const scannerFor = (kind: EndpointAddonKind): AdmissionScanEngineId | null => {
  const subject = SCAN_SUBJECT_FOR_KIND[kind];
  return subject ? admissionScanEngineFor(subject) : null;
};
/** rank 1..4 in the shared severity order (low → critical), for SQL comparisons */
const SEVERITY_RANK = Object.fromEntries(MCP_ADMISSION_SEVERITIES.map((s, i) => [s, i + 1])) as Record<McpAdmissionSeverity, number>;
const ENDPOINT_SIGNALS = sql.raw(`ARRAY['endpoint_agent', 'endpoint_osquery', 'endpoint_inventory']`);

// ---------------------------------------------------------------------------
// Direct record contract (skills, plugins: facts no evidence table holds)
// ---------------------------------------------------------------------------

export const endpointAddonSightingInput = z
  .object({
    kind: z.enum(ENDPOINT_ADDON_KINDS),
    identityKind: z.enum(ENDPOINT_ADDON_IDENTITY_KINDS),
    identity: z.string().regex(ENDPOINT_IDENTITY_RE),
    version: z.string().max(128).regex(/^[A-Za-z0-9._+~:-]*$/).default(""),
    contentDigest: z.string().regex(/^[0-9a-f]{64}$/).nullable().default(null),
    /** the enrolled device (ADR-0195 SD4b) that reported it; its pseudonym is joined, never taken from the caller */
    deviceId: z.string().uuid(),
    source: z.enum(ENDPOINT_ADDON_SOURCES),
    hostAgent: z.string().max(255).regex(/^[A-Za-z0-9._:-]*$/).default(""),
    // secret TYPES only (rule ids); a name or value cannot match this shape
    secretTypes: z.array(z.string().regex(/^[a-z][a-z0-9_.]{0,63}$/)).max(32).default([]),
    seenAt: z.coerce.date(),
  })
  .strict();
export type EndpointAddonSightingInput = z.input<typeof endpointAddonSightingInput>;

export class EndpointAddonDeviceError extends Error {
  constructor(readonly deviceIds: string[]) {
    super(`endpoint add-on sightings refused: no active enrolled device ${deviceIds.join(", ")}`);
  }
}

/**
 * Record sightings an endpoint lane reports directly (ADR-0332 contract), all or nothing. Every input is validated,
 * every device must be an enrolled, unrevoked `endpoint_devices` row (else `EndpointAddonDeviceError`, nothing
 * written), first seen is kept, last seen only advances, and the secret types are replaced only by a newer sighting.
 * Runs under the caller's scope; the policies admit an admin principal or `system_task`. The caller audits the
 * request that carried the facts, in this same transaction when it passes its own `tx`.
 */
export async function recordEndpointAddonSightings(db: Db, inputs: readonly EndpointAddonSightingInput[]): Promise<{ recorded: number }> {
  const parsed = z.array(endpointAddonSightingInput).max(1000).parse(inputs);
  if (!parsed.length) return { recorded: 0 };
  return db.transaction(async (tx) => {
    const t = tx as unknown as Db;
    const ids = [...new Set(parsed.map((o) => o.deviceId))];
    const live = await t
      .select({ id: endpointDevices.id })
      .from(endpointDevices)
      .where(and(inArray(endpointDevices.id, ids), isNull(endpointDevices.revokedAt)))
      .for("share");
    const known = new Set(live.map((d) => d.id));
    const missing = ids.filter((id) => !known.has(id));
    if (missing.length) throw new EndpointAddonDeviceError(missing);
    for (const o of parsed) {
      const ad = await t.execute<{ id: string }>(sql`
        INSERT INTO endpoint_addons (kind, identity_kind, identity) VALUES (${o.kind}, ${o.identityKind}, ${o.identity})
        ON CONFLICT (kind, identity_kind, identity) DO UPDATE SET identity = EXCLUDED.identity
        RETURNING id`);
      const ve = await t.execute<{ id: string }>(sql`
        INSERT INTO endpoint_addon_versions (addon_id, version, content_digest) VALUES (${ad.rows[0]!.id}, ${o.version}, ${o.contentDigest})
        ON CONFLICT ON CONSTRAINT endpoint_addon_versions_uq DO UPDATE SET version = EXCLUDED.version
        RETURNING id`);
      const si = await t.execute<{ id: string; newer: boolean }>(sql`
        INSERT INTO endpoint_addon_sightings (version_id, device_id, source, host_agent, first_seen_at, last_seen_at)
        VALUES (${ve.rows[0]!.id}, ${o.deviceId}, ${o.source}, ${o.hostAgent}, ${o.seenAt}, ${o.seenAt})
        ON CONFLICT ON CONSTRAINT endpoint_addon_sightings_uq
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
// The read: every sighting from its home, each version joined to the scan of its exact digest
// ---------------------------------------------------------------------------

/** a stable id for a derived key (the evidence tables have no add-on or version row): md5 of its JSON encoding */
const keyId = (...parts: SQL[]) => sql`md5(jsonb_build_array(${sql.join(parts, sql`, `)})::text)::uuid`;

const SCANNER_CASE = (kindCol: SQL) =>
  sql`(CASE ${kindCol} ${sql.raw(
    ENDPOINT_ADDON_KINDS.map((k) => {
      const e = scannerFor(k);
      return `WHEN '${k}' THEN ${e ? `'${e}'` : "NULL"}`;
    }).join(" "),
  )} END)`;

/**
 * Every sighting, one row each, from the table that owns it. The sighting id is the evidence row's own id (random
 * uuids across three tables), which is the keyset.
 */
const SIGHTINGS_CTE = sql`
  ev AS (
    SELECT m.id AS sighting_id, 'mcp_server'::text AS kind, m.identity_kind::text AS identity_kind, m.identity,
           COALESCE(m.package_version, '') AS version, NULL::text AS content_digest,
           d.id AS device_id, d.device_pseudonym AS pseudonym, 'endpoint_agent'::text AS source, m.provider AS host_agent,
           m.id AS endpoint_mcp_server_id, NULL::uuid AS shadow_ai_finding_id, NULL::text AS discovery_severity,
           m.risks, m.secret_types, m.first_seen_at, m.last_seen_at
      FROM endpoint_mcp_servers m
      JOIN endpoint_devices d ON d.id = m.device_id
    UNION ALL
    SELECT f.id, 'coding_agent', 'provider', f.provider, '', NULL, dv.id, f.subject,
           CASE WHEN f.signal_sources ? 'endpoint_agent' THEN 'endpoint_agent'
                WHEN f.signal_sources ? 'endpoint_osquery' THEN 'endpoint_osquery'
                ELSE 'endpoint_inventory' END,
           f.provider, NULL, f.id, f.severity, NULL::text[], NULL::text[], LEAST(f.first_seen_at, f.last_seen_at), f.last_seen_at
      FROM shadow_ai_findings f
      LEFT JOIN LATERAL (
        SELECT d.id FROM endpoint_devices d WHERE d.device_pseudonym = f.subject
         ORDER BY (d.revoked_at IS NULL) DESC, d.created_at DESC LIMIT 1) dv ON true
     WHERE f.subject_kind = 'device' AND f.disposition <> 'false_positive' AND f.signal_sources ?| ${ENDPOINT_SIGNALS}
    UNION ALL
    SELECT s.id, a.kind, a.identity_kind, a.identity, v.version, v.content_digest, d.id, d.device_pseudonym, s.source,
           s.host_agent, NULL, NULL, NULL, NULL::text[],
           (SELECT array_agg(st.secret_type ORDER BY st.secret_type) FROM endpoint_addon_sighting_secret_types st WHERE st.sighting_id = s.id),
           s.first_seen_at, s.last_seen_at
      FROM endpoint_addon_sightings s
      JOIN endpoint_addon_versions v ON v.id = s.version_id
      JOIN endpoint_addons a ON a.id = v.addon_id
      JOIN endpoint_devices d ON d.id = s.device_id
  ),
  sx AS (
    SELECT ev.*,
           ${keyId(sql`ev.kind`, sql`ev.identity_kind`, sql`ev.identity`)} AS addon_id,
           ${keyId(sql`ev.kind`, sql`ev.identity_kind`, sql`ev.identity`, sql`ev.version`, sql`COALESCE(ev.content_digest, '')`)} AS version_id
      FROM ev
  )`;

/**
 * The scan ingredients for one version, exactly what `engineAdmissionHold` takes: is the kind's engine enabled, and
 * the latest scan of this digest. `eff_status` and `severity_rank` mirror that helper for SQL filtering (the item's
 * own view is built by the helper itself; the suite holds the two equal).
 */
const SCAN_LATERAL = (alias: string) => sql`
  LEFT JOIN LATERAL (
    SELECT ${SCANNER_CASE(sql.raw(`${alias}.kind`))} AS scanner) sk ON true
  LEFT JOIN engines eg ON eg.id = sk.scanner
  LEFT JOIN LATERAL (
    SELECT s.id, s.verdict, s.findings, s.created_at, s.engine_version, s.rules_sha256 FROM admission_engine_scans s
     WHERE ${sql.raw(alias)}.content_digest IS NOT NULL AND s.engine_id = sk.scanner AND s.subject_digest = ${sql.raw(alias)}.content_digest
     ORDER BY s.created_at DESC, s.id DESC LIMIT 1) sc ON true
  LEFT JOIN LATERAL (
    SELECT CASE WHEN sk.scanner IS NULL OR NOT COALESCE(eg.enabled, false) OR sc.id IS NULL THEN 'not_yet_scanned' ELSE sc.verdict END AS eff_status,
           CASE WHEN sc.verdict = 'fail' AND COALESCE(eg.enabled, false)
                THEN (SELECT max(CASE f->>'severity' ${sql.raw(
                  MCP_ADMISSION_SEVERITIES.map((s) => `WHEN '${s}' THEN ${SEVERITY_RANK[s]}`).join(" "),
                )} END) FROM jsonb_array_elements(sc.findings) f) END AS severity_rank) st ON true
  LEFT JOIN endpoint_mcp_server_links l
    ON ${sql.raw(alias)}.kind = 'mcp_server' AND l.identity_kind = ${sql.raw(alias)}.identity_kind AND l.identity = ${sql.raw(alias)}.identity`;

const SCAN_COLUMNS = sql`sk.scanner, COALESCE(eg.enabled, false) AS engine_enabled, sc.id AS scan_id, sc.verdict, sc.findings,
  sc.created_at AS scanned_at, sc.engine_version, sc.rules_sha256, st.eff_status, st.severity_rank,
  l.mcp_server_id AS registry_mcp_server_id`;

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
  identity: z.string().regex(ENDPOINT_IDENTITY_RE).optional(),
  version: z.string().max(128).optional(),
};
const versionsQuery = z.object(filterShape).strict();
const sightingsQuery = z
  .object({
    ...filterShape,
    agent: z.string().max(255).regex(/^[A-Za-z0-9._:-]+$/).optional(),
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

const list = (xs: readonly (string | number)[]) => sql.join(xs.map((x) => sql`${x}`), sql`, `);

/** the version-level filters, over the alias `x` (a version row joined to its scan) */
function versionConds(f: z.output<typeof versionsQuery>): SQL[] {
  const c: SQL[] = [];
  if (f.kind) c.push(sql`x.kind IN (${list(f.kind)})`);
  if (f.addonId) c.push(sql`x.addon_id = ${f.addonId}`);
  if (f.identity) c.push(sql`x.identity = ${f.identity}`);
  if (f.version !== undefined) c.push(sql`x.version = ${f.version}`);
  if (f.scanStatus) c.push(sql`st.eff_status IN (${list(f.scanStatus)})`);
  if (f.atOrAbove) c.push(sql`st.severity_rank >= ${SEVERITY_RANK[f.atOrAbove]}`);
  if (f.severity) {
    const ranks = f.severity.filter((s): s is McpAdmissionSeverity => s !== "not_yet_scanned").map((s) => SEVERITY_RANK[s]);
    const parts: SQL[] = [];
    if (ranks.length) parts.push(sql`st.severity_rank IN (${list(ranks)})`);
    if (f.severity.includes("not_yet_scanned")) parts.push(sql`st.eff_status = 'not_yet_scanned'`);
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
  scanner: AdmissionScanEngineId | null;
  engine_enabled: boolean;
  scan_id: string | null;
  verdict: AdmissionScanVerdict | null;
  findings: McpAdmissionFinding[] | null;
  scanned_at: string | Date | null;
  engine_version: string | null;
  rules_sha256: string | null;
  eff_status: EndpointAddonScanStatus;
  severity_rank: number | null;
  registry_mcp_server_id: string | null;
};

const iso = (d: string | Date | null): string | null => (d === null ? null : new Date(d).toISOString());
const REASON_TEXT: Record<EndpointAddonNotScannedReason, (kind: string) => string> = {
  no_scanner_for_kind: (k) => `NOT YET SCANNED: no admission scanner covers a ${k.replace("_", " ")}; treat it as unreviewed, not clear.`,
  scanner_off: () => "NOT YET SCANNED: the admission scanner for this kind is off, so no verdict counts; treat it as unreviewed, not clear.",
  no_content_digest: () =>
    "NOT YET SCANNED: the endpoint reported no content digest, so no scan can be tied to this exact content; treat it as unreviewed, not clear.",
  no_scan_for_digest: () => "NOT YET SCANNED: no admission scan exists for this exact content digest; treat it as unreviewed, not clear.",
};

/** the version's scan, decided by the admission gate's own helper (ADR-0242 `engineAdmissionHold`) */
export function scanView(r: VersionRowDb) {
  const base = { scanner: r.scanner, scannedAt: null as string | null, engineVersion: null as string | null, rulesSha256: null as string | null };
  const notScanned = (reason: EndpointAddonNotScannedReason) => ({
    ...base,
    status: "not_yet_scanned" as const,
    severity: null,
    notScannedReason: reason,
    summary: REASON_TEXT[reason](r.kind),
    findings: [] as Array<{ rule: string; severity: McpAdmissionSeverity; tool: string; count: number }>,
  });
  if (r.scanner === null) return notScanned("no_scanner_for_kind");
  const outcome = engineAdmissionHold({
    engineEnabled: r.engine_enabled,
    scan: r.scan_id ? { verdict: r.verdict!, findings: (r.findings ?? []).filter((f) => f.severity in SEVERITY_RANK) } : null,
  });
  if (outcome.status === "off") return notScanned("scanner_off");
  if (outcome.status === "pending") return notScanned(r.content_digest === null ? "no_content_digest" : "no_scan_for_digest");
  const severity = maxSeverity(outcome.findings);
  return {
    ...base,
    status: outcome.status,
    severity,
    notScannedReason: null,
    summary:
      outcome.status === "pass"
        ? `Scanned by ${r.scanner}: pass.`
        : outcome.status === "fail"
          ? `Scanned by ${r.scanner}: FAIL${severity ? ` (top finding ${severity})` : ""}.`
          : `Scanned by ${r.scanner}: inconclusive; treat it as unreviewed, not clear.`,
    scannedAt: iso(r.scanned_at),
    engineVersion: r.engine_version,
    rulesSha256: r.rules_sha256,
    // counts-only findings, exactly the fields the scanner already exposes (ADR-0242); `where` is engine-internal
    findings: outcome.findings.map((x) => ({ rule: x.rule, severity: x.severity, tool: x.tool, count: x.count })),
  };
}

/** the registry link and AI-BOM pointers: an MCP server identity an admin linked to an approved server (ADR-0259) */
function aiBomView(r: VersionRowDb) {
  if (!r.registry_mcp_server_id) return null;
  return {
    mcpServerId: r.registry_mcp_server_id,
    // the server's component in the install AI-BOM (ADR-0189)
    bomRef: aiBomRef.mcp(r.registry_mcp_server_id),
    snapshots: `/v1/ai-bom/install/${AI_BOM_INSTALL_SUBJECT_ID}/snapshots`,
    note: "The AI-BOM entry describes the approved registry server, not the bytes on this endpoint.",
  };
}

function versionView(r: VersionRowDb) {
  return {
    addon: { id: r.addon_id, kind: r.kind, identity: { kind: r.identity_kind, value: r.identity } },
    version: { id: r.version_id, version: r.version === "" ? null : r.version, contentDigest: r.content_digest },
    scan: scanView(r),
    aiBom: aiBomView(r),
  };
}

const whereOf = (conds: SQL[]) => (conds.length ? sql`WHERE ${sql.join(conds, sql` AND `)}` : sql``);

export async function listEndpointAddonVersions(db: Db, query: EndpointAddonVersionsQuery) {
  const f = versionsQuery.parse(query);
  const conds = versionConds(f);
  if (f.cursor) conds.push(sql`x.version_id > ${f.cursor}`);
  const rows = (
    await db.execute<VersionRowDb & { endpoints: number; first_seen_at: string; last_seen_at: string }>(sql`
      WITH ${SIGHTINGS_CTE},
      x AS (
        SELECT version_id, addon_id, kind, identity_kind, identity, version, content_digest,
               count(DISTINCT pseudonym)::int AS endpoints, min(first_seen_at) AS first_seen_at, max(last_seen_at) AS last_seen_at
          FROM sx GROUP BY version_id, addon_id, kind, identity_kind, identity, version, content_digest
      )
      SELECT x.*, ${SCAN_COLUMNS}
        FROM x ${SCAN_LATERAL("x")}
       ${whereOf(conds)}
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
  pseudonym: string;
  device_id: string | null;
  source: EndpointAddonSource;
  host_agent: string;
  endpoint_mcp_server_id: string | null;
  shadow_ai_finding_id: string | null;
  discovery_severity: string | null;
  risks: string[] | null;
  secret_types: string[] | null;
  first_seen_at: string;
  last_seen_at: string;
};

async function querySightings(db: Db, f: z.output<typeof sightingsQuery>, extra: SQL[]) {
  const conds = [...versionConds(f), ...extra];
  if (f.cursor) conds.push(sql`x.sighting_id > ${f.cursor}`);
  if (f.agent) conds.push(sql`x.host_agent = ${f.agent}`);
  if (f.deviceId) conds.push(sql`x.device_id = ${f.deviceId}`);
  if (f.endpointPseudonym) conds.push(sql`x.pseudonym = ${f.endpointPseudonym}`);
  if (f.source) conds.push(sql`x.source IN (${list(f.source)})`);
  const rows = (
    await db.execute<SightingRowDb>(sql`
      WITH ${SIGHTINGS_CTE}
      SELECT x.*, ${SCAN_COLUMNS}
        FROM sx x ${SCAN_LATERAL("x")}
       ${whereOf(conds)}
       ORDER BY x.sighting_id ASC
       LIMIT ${f.limit + 1}`)
  ).rows;
  const page = rows.slice(0, f.limit);
  return {
    items: page.map((r) => ({
      id: r.sighting_id,
      ...versionView(r),
      endpoint: { pseudonym: r.pseudonym, deviceId: r.device_id },
      detection: {
        source: r.source,
        hostAgent: r.host_agent === "" ? null : r.host_agent,
        endpointMcpServerId: r.endpoint_mcp_server_id,
        shadowAiFindingId: r.shadow_ai_finding_id,
        discoverySeverity: r.discovery_severity,
        // risk flag names and secret TYPES only (ADR-0259), never a key name or value
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
 * ADR-0332 contract: the sightings whose version's latest scan of its exact digest (engine on) has a finding at or
 * above `atOrAbove`, plus (default `notYetScanned: "include"`) every sighting not yet scanned or scanned
 * inconclusively, because unscanned is never clear. Read at call time from the evidence, so nothing lags. Keyset
 * paginated on the sighting id; the consumer decides what to do per row.
 */
export async function endpointAddonsFlagged(db: Db, query: EndpointAddonFlaggedQuery) {
  const f = flaggedQuery.parse(query);
  const rank = SEVERITY_RANK[f.atOrAbove];
  const flagged =
    f.notYetScanned === "include"
      ? sql`(st.severity_rank >= ${rank} OR st.eff_status IN ('not_yet_scanned', 'unknown'))`
      : sql`(st.severity_rank >= ${rank})`;
  const out = await querySightings(db, { ...f, atOrAbove: undefined, severity: undefined, scanStatus: undefined }, [flagged]);
  return { atOrAbove: f.atOrAbove, notYetScanned: f.notYetScanned, ...out };
}

/** the engines' on/off state, for callers that want it alongside the list (the admission gate's own source) */
export async function admissionScannerStates(db: Db): Promise<Record<AdmissionScanEngineId, boolean>> {
  const rows = await db.select({ id: engines.id, enabled: engines.enabled }).from(engines).where(inArray(engines.id, ADMISSION_SCAN_ENGINE_IDS));
  const on = new Map(rows.map((r) => [r.id, r.enabled]));
  return Object.fromEntries(ADMISSION_SCAN_ENGINE_IDS.map((id) => [id, on.get(id) === true])) as Record<AdmissionScanEngineId, boolean>;
}

// ---------------------------------------------------------------------------
// Routes (admin-only: none is in NON_ADMIN_ROUTES; read-only)
// ---------------------------------------------------------------------------

const refuse = (reply: FastifyReply, status: number, error: string, detail: string) => reply.status(status).send({ error, detail });
const issues = (e: z.ZodError) => e.issues.map((i) => `${i.path.join(".") || "query"}: ${i.message}`).join("; ");

export function registerEndpointAddonInventoryRoutes(app: FastifyInstance, db: Db): void {
  app.get("/v1/endpoint-addons/versions", async (req, reply) => {
    const q = versionsQuery.safeParse(req.query ?? {});
    if (!q.success) return refuse(reply, 400, "invalid_query", issues(q.error));
    return { scanners: await admissionScannerStates(db), ...(await listEndpointAddonVersions(db, q.data)) };
  });

  app.get("/v1/endpoint-addons/sightings", async (req, reply) => {
    const q = sightingsQuery.safeParse(req.query ?? {});
    if (!q.success) return refuse(reply, 400, "invalid_query", issues(q.error));
    return { scanners: await admissionScannerStates(db), ...(await listEndpointAddonSightings(db, q.data)) };
  });

  app.get("/v1/endpoint-addons/flagged", async (req, reply) => {
    const q = flaggedQuery.safeParse(req.query ?? {});
    if (!q.success) return refuse(reply, 400, "invalid_query", issues(q.error));
    return { scanners: await admissionScannerStates(db), ...(await endpointAddonsFlagged(db, q.data)) };
  });
}

