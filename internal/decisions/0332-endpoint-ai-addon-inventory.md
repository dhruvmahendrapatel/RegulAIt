# ADR-0332: Endpoint AI add-on inventory (one governed view per version, per endpoint, joined to the scan of that exact content)

- **Status**: Accepted (owner direction 2026-11-15 via lane E14 brief; slice 1 built)
- **Date**: 2026-11-15
- **Index**: **Endpoint AI add-on inventory: every coding agent, MCP server, skill and plugin on every endpoint, per version and per endpoint, joined at read time to the ADR-0242 admission-scan verdict for that exact content digest (not yet scanned is never clear), with first/last seen, detection source, severity and AI-BOM links; admin-only, RLS on every table, and a "flagged at or above severity X" contract for the removal directive and detections.**
- **Built in**: lane E14, branch `builder/e14-endpoint-addon-inventory`
- **Migration**: `pending/endpoint_addon_inventory.sql`, numbered at merge (ADR-0252)
- **Related**: ADR-0195 (shadow-AI active discovery, endpoint agent and osquery pack), ADR-0259 (endpoint MCP config
  discovery), ADR-0242 (mcp-scanner and skill-scanner admission engines), ADR-0189 (AI-BOM), ADR-0234 (row-level
  security), ADR-0252 (merge-time numbering), ADR-0200 (3NF addendum, security checklist), ADR-0180 (secure by default),
  ADR-0176 (open source first)

## Context

Discovery already finds AI tooling on endpoints, in three places that do not join up: device findings in
`shadow_ai_findings` (coding agents seen by the endpoint agent, the osquery pack or an inventory import, ADR-0195),
per-device MCP server entries in `endpoint_mcp_servers` (ADR-0259), and admission-scan verdicts in
`admission_engine_scans`, keyed by content digest (ADR-0242). An admin cannot answer "which add-ons, at which version,
are on which endpoints, and has that exact content been scanned?" in one place, and the endpoint removal directive and
the detections have nothing to query for "everything flagged at or above high".

## Decision

1. **A 3NF read model of four tables (plus one join table), all new.** `endpoint_addon_endpoints` (the ADR-0195
   pseudonym, joined to an enrolled `endpoint_devices` row when there is one), `endpoint_addons` (kind + identity:
   `coding_agent | mcp_server | skill | plugin`; identity kind `provider | package | host | command | name | unknown`),
   `endpoint_addon_versions` (one row per reported version string + content digest, `UNIQUE NULLS NOT DISTINCT`), and
   `endpoint_addon_sightings` (one version on one endpoint from one source: `endpoint_agent | endpoint_osquery |
   endpoint_inventory`, the host agent, first and last seen). Secret types of a directly recorded sighting are rows of
   `endpoint_addon_sighting_secret_types`. No jsonb or array of ids. `host_agent` is the signed report's catalogue
   provider id, commented as the ADR-0200 exception.
2. **Projection, not a copy of evidence.** `projectEndpointAddons` folds `endpoint_mcp_servers` entries (MCP servers)
   and endpoint-sourced device `shadow_ai_findings` (coding agents) in, set-based and idempotent. Each sighting
   references its evidence row with `ON DELETE CASCADE`, so the ADR-0195 endpoint retention and the ADR-0259 pruning
   delete it too; a finding an admin marks `false_positive` leaves the inventory on the next projection. Versions and
   add-ons with no sighting are pruned. The projection runs from the audited admin route
   `POST /v1/endpoint-addons/refresh`; wiring it into the report commit or a scheduler job is a follow-up (PENDING).
3. **Direct record contract** for facts the evidence tables do not hold (a skill or plugin with its content digest):
   `recordEndpointAddonSightings(db, inputs)` in `apps/gateway/src/endpoint-addon-inventory.ts`. Strictly validated
   (identifier shapes, a 64-hex digest, secret types as rule ids only, at most 1000 per call; one bad input refuses the
   batch), first seen kept, last seen monotonic, secret types replaced only by a newer sighting.
4. **The scan is joined, never copied, and only for the exact digest.** At read time each version joins the latest
   `admission_engine_scans` row whose engine owns the kind (`mcpscanner` for an MCP server, `skillscanner` for a skill)
   and whose `subject_digest` equals the version's `content_digest`. Scan status is that row's verdict (`pass | fail |
   unknown`) or `not_yet_scanned` with a reason: `no_content_digest`, `no_scanner_for_kind` (coding agents, plugins)
   or `no_scan_for_digest`. Severity is the highest `low..critical` finding of that scan (`info` dropped). A scan of a
   different digest of the same skill, or the linked registry server's scan, never counts for the endpoint's bytes.
   Today the endpoint agent reports no digest for MCP servers, so they read `not_yet_scanned` until it does.
5. **Content and secrets.** No skill body, config path, argument, env, header or key name is stored or returned. A scan
   is its verdict plus the counts-only findings the scanner already exposes (`rule, severity, tool, count`; `where`
   omitted). Secrets are their type (rule id) only, from ADR-0259's `secret_types` or the join table.
6. **AI-BOM links.** An MCP server identity an admin linked to an approved registry server (ADR-0259
   `endpoint_mcp_server_links`) carries `aiBom: { mcpServerId, bomRef: "service:mcp:<id>", snapshots:
   "/v1/ai-bom/install/<nil uuid>/snapshots" }`, labelled as describing the registry server, not the endpoint's bytes.
7. **API, versioned and keyset-paginated** (`cursor` = last id, `limit` 1..200, default 50; unknown parameters refused):
   - `GET /v1/endpoint-addons/versions`: one row per version (add-on, version, digest, scan, AI-BOM, endpoint count,
     first/last seen). Filters `kind`, `severity` (`low..critical` or `not_yet_scanned`, comma list), `atOrAbove`,
     `scanStatus`, `addonId`, `identity`, `version`.
   - `GET /v1/endpoint-addons/sightings`: one row per version per endpoint per source; the same filters plus `agent`
     (host agent), `endpointId`, `deviceId`, `endpointPseudonym`, `source`.
   - `GET /v1/endpoint-addons/flagged`: the contract below.
   - `POST /v1/endpoint-addons/refresh`: re-project (audited `endpoint-addon-inventory-refreshed`).
8. **Default visibility: admins only, twice.** None of the routes is in `NON_ADMIN_ROUTES`, so the global gate refuses
   a non-admin with 403. Every table has row-level security ENABLED and FORCED with one policy admitting
   `regulait_rls_is_admin()` (which also admits the bootstrap token) and the `system_task` and `migration` reasons only;
   a member principal, `credential_request` and `public_ingest` read and write nothing. Owner question open: should a
   narrower "security admin" role (once one exists) be the default instead of every admin?

### The flagged contract (for the removal directive and the detections)

`endpointAddonsFlagged(db, { atOrAbove, notYetScanned?, cursor?, limit?, kind?, agent?, endpointId?, deviceId?,
endpointPseudonym?, source?, addonId?, identity?, version? })`, also served as
`GET /v1/endpoint-addons/flagged?atOrAbove=<low|medium|high|critical>[&notYetScanned=include|exclude]`.

- Returns sightings (same item shape as `/sightings`) whose version's latest scan of its exact digest has a finding at
  or above `atOrAbove`, keyset-paginated on the sighting id: `{ atOrAbove, notYetScanned, items, nextCursor }`.
- **Secure default `notYetScanned=include`:** a sighting whose version is `not_yet_scanned`, or whose scan was
  inconclusive (`unknown`), is also listed, because unscanned is never clear. Each item's `scan.status` says which, so
  a consumer that must act only on scanned findings (for example an automatic removal) filters on
  `scan.status === "fail"` or passes `notYetScanned=exclude`.
- The item fields consumers may rely on: `id`, `addon.{id,kind,identity}`, `version.{id,version,contentDigest}`,
  `scan.{status,severity,notScannedReason,scanner,scannedAt,findings}`, `endpoint.{id,pseudonym,deviceId}`,
  `detection.{source,hostAgent,endpointMcpServerId,shadowAiFindingId,risks,secretTypes}`, `firstSeenAt`, `lastSeenAt`.
  Additive changes only within `/v1`.
- Caller scope: an admin principal or `system_task` (row-level security). An endpoint-agent-facing directive route
  (under `credential_request`, scoped to the calling device) is the endpoint lane's to add; it needs either a new
  system reason or a narrow `SECURITY DEFINER` read, decided in that lane's ADR. Until then it reads nothing here.

## Consequences

- One query answers "what is on which endpoint, at which version, and is that exact content scanned"; unscanned
  content can no longer look clear.
- The read model can lag the evidence until a refresh; the follow-up wires the projection into the report commit and a
  scheduler job (PENDING). The digest lookup on `admission_engine_scans` has no `(engine_id, subject_digest)` index
  (that table belongs to ADR-0242); fine at current sizes, a follow-up adds one if the inventory grows.
- MCP servers stay `not_yet_scanned` until the endpoint agent reports a content digest for them (endpoint lane).
- Open source first (ADR-0176): no library models "an inventory joined to our own scan rows"; this is RegulAIt's own
  governance read model over its own tables, built on drizzle, zod and PostgreSQL (`NULLS NOT DISTINCT`, RLS) already
  in use. No new dependency.
- Four API-only routes are KNOWN_UI_GAPS entries tracked on #453 (ratchet 54 → 58); the screen brief is in the PR.
