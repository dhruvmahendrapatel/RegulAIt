# ADR-0332: Endpoint AI add-on inventory (one governed view per version, per endpoint, joined to the scan of that exact content)

- **Status**: Accepted (owner direction 2026-11-15 via lane E14 brief; owner decisions I1 and I2 2026-11-15; slice 1 built)
- **Date**: 2026-11-15
- **Index**: **Endpoint AI add-on inventory: every coding agent, MCP server, skill and plugin on every endpoint, per version and per endpoint, read at call time from the ADR-0195/0259 evidence (nothing copied, nothing to refresh) and joined to the ADR-0242 admission-scan verdict for that exact content digest, decided by the gate's own helper (not yet scanned is never clear); admin-only, RLS on the direct-record tables, and a "flagged at or above severity X" contract for the removal directive and detections.**
- **Built in**: lane E14, branch `builder/e14-endpoint-addon-inventory` (PR #866)
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

1. **Read, never project.** The inventory is one query over the evidence, at call time:
   - **MCP servers:** `endpoint_mcp_servers` joined to `endpoint_devices` (ADR-0259). The identity is the entry's
     identity kind and identity, the version its package version, the sighting id the entry's own id.
   - **Coding agents:** device `shadow_ai_findings` whose `signal_sources` include an endpoint source (ADR-0195),
     with false positives excluded. The source is the endpoint agent, else osquery, else an inventory import. The
     enrolled device is joined by pseudonym when there is one; an osquery-only endpoint has none.
   - **Skills and plugins:** the direct-record tables (decision 2).
   Every fact is read from its one home (ADR-0200 addendum): version, first and last seen, source, pseudonym, risk
   flags and secret types. Nothing lags the evidence, there is no refresh step, and the evidence's retention and pruning
   apply unchanged. An add-on and a version from evidence have no row of their own; their API ids are
   `md5(jsonb_build_array(kind, identity kind, identity[, version, digest]))` as a uuid, stable across calls.
2. **Direct-record tables, in 3NF, only for what no evidence table holds.**
   - `endpoint_addons` holds the kind and identity.
   - `endpoint_addon_versions` holds the version string and content digest, unique with `NULLS NOT DISTINCT`.
   - `endpoint_addon_sightings` holds one version on one enrolled device (an FK to `endpoint_devices`, cascade), with
     its source, host agent, first seen and last seen. The pseudonym is joined from the device, never stored.
   - `endpoint_addon_sighting_secret_types` holds secret types, one row per type.
   These tables are written by `recordEndpointAddonSightings(db, inputs)` (`apps/gateway/src/endpoint-addon-inventory.ts`):
   - Input is strictly validated: the ADR-0259 identity pattern (`ENDPOINT_IDENTITY_RE`), a 64-hex digest, and
     secret types as rule ids only.
   - It takes at most 1000 inputs per call. The batch is all or nothing: every device must be enrolled and
     unrevoked, or `EndpointAddonDeviceError` is raised and nothing is written.
   - First seen is kept, last seen only advances, and only a newer sighting replaces the secret types.
   - The caller audits the request that carried the facts, in the same transaction when it passes its own `tx`.
3. **The scan is joined for the exact digest and decided by the gate's own helper.**
   - The engine for a kind comes from `admissionScanEngineFor` (an MCP server is the `mcp_server` subject, a skill
     the `builder_skill` subject). Coding agents and plugins have no scanner.
   - The latest `admission_engine_scans` row whose `subject_digest` equals the version's `content_digest` and the
     engine's `enabled` flag go to `engineAdmissionHold`, the same helper the admission gate uses. Severity is
     `maxSeverity` of its findings, with `info` dropped.
   - The outcome is mapped as follows:
     - an engine that is `off` reads as `not_yet_scanned` with reason `scanner_off`, so a stale verdict of a disabled
       engine never shows;
     - a `pending` outcome (no scan yet) reads as `not_yet_scanned` with reason `no_content_digest` or
       `no_scan_for_digest`;
     - a kind with no scanner reads as `not_yet_scanned` with reason `no_scanner_for_kind`;
     - otherwise the verdict (`pass | fail | unknown`) is shown.
   - The SQL filters mirror the helper (engine on, latest scan of the digest, severity rank only on a `fail`). The
     suite holds every filter equal to each item's own scan view.
   - A scan of a different digest of the same skill, or the linked registry server's scan, never counts for the
     endpoint's bytes. Today the endpoint agent reports no digest for MCP servers, so they read `not_yet_scanned`
     until it does (endpoint lane).
4. **Content and secrets.** No skill body, config path, argument, env, header or key name is stored or returned. A scan
   is its verdict plus the counts-only findings the scanner already exposes (`rule, severity, tool, count`; `where`
   omitted). Secrets are their type (rule id) only, from ADR-0259's `secret_types` or the join table.
5. **AI-BOM links.** An MCP server identity an admin linked to an approved registry server (ADR-0259
   `endpoint_mcp_server_links`) carries `aiBom: { mcpServerId, bomRef: aiBomRef.mcp(id), snapshots:
   "/v1/ai-bom/install/<AI_BOM_INSTALL_SUBJECT_ID>/snapshots" }`. It is labelled as describing the registry server,
   not the endpoint's bytes.
6. **API: read-only, versioned and keyset-paginated.** `cursor` is the last id, `limit` is 1..200 (default 50), and
   unknown parameters are refused. Each response also carries `scanners: { mcpscanner, skillscanner }` (on or off).
   - `GET /v1/endpoint-addons/versions`: one row per version (add-on, version, digest, scan, AI-BOM, endpoint count,
     first and last seen). Filters: `kind`, `severity` (`low..critical` or `not_yet_scanned`, comma list),
     `atOrAbove`, `scanStatus`, `addonId`, `identity`, `version`.
   - `GET /v1/endpoint-addons/sightings`: one row per version per endpoint per source. The same filters plus `agent`
     (host agent), `deviceId`, `endpointPseudonym` and `source`.
   - `GET /v1/endpoint-addons/flagged`: the contract below.
   No route changes state, so no route writes an audit row. Reads are not audited, as for the other discovery lists.
7. **Visibility: admins only, enforced twice** (owner decision I1, below).
   - None of the routes is in `NON_ADMIN_ROUTES`, so the global gate refuses a non-admin with a 403.
   - Every direct-record table has row-level security ENABLED and FORCED, with one policy that admits
     `regulait_rls_is_admin()` (which also admits the bootstrap token) and the `system_task` and `migration` reasons
     only. A member principal, `credential_request` and `public_ingest` read and write nothing.
   - The evidence tables keep their own ADR-0195/0259 posture.

### Owner decisions (2026-11-15, relayed by the master on #866)

- **I1, visibility:** the inventory narrows to a dedicated security-admin role once that role exists. Until then it is
  active admins only, as built. The follow-up is in PENDING (`2026-11-15-e14-endpoint-addon-inventory-pending.md`).
- **I2, the endpoint agent's own read:** the endpoint agent's device-scoped read of the flagged list is one narrow,
  audited read, limited to that device. Lane E13 decides its exact form in its own ADR. Until then, no path reads the
  flagged list under `credential_request`: the policies above admit no such reason.

### The flagged contract (for the removal directive and the detections)

`endpointAddonsFlagged(db, { atOrAbove, notYetScanned?, cursor?, limit?, kind?, agent?, deviceId?,
endpointPseudonym?, source?, addonId?, identity?, version? })`, also served as
`GET /v1/endpoint-addons/flagged?atOrAbove=<low|medium|high|critical>[&notYetScanned=include|exclude]`.

- Returns the sightings whose version's latest scan of its exact digest, with the engine on, has a finding at or above
  `atOrAbove`. The data is read at call time from the evidence, so a new risky add-on is listed as soon as its evidence
  row exists. It is keyset-paginated on the sighting id and returns `{ atOrAbove, notYetScanned, scanners, items,
  nextCursor }`.
- **Secure default `notYetScanned=include`:** a sighting whose version is `not_yet_scanned` (any reason, including a
  disabled scanner) or whose scan was inconclusive (`unknown`) is also listed, because unscanned is never clear. Each
  item's `scan.status` and `scan.notScannedReason` say which. A consumer that must act only on scanned findings (for
  example an automatic removal) filters on `scan.status === "fail"` or passes `notYetScanned=exclude`.
- Consumers may rely on these item fields:
  - `id`;
  - `addon.{id,kind,identity}`;
  - `version.{id,version,contentDigest}`;
  - `scan.{status,severity,notScannedReason,scanner,scannedAt,findings}`;
  - `endpoint.{pseudonym,deviceId}`;
  - `detection.{source,hostAgent,endpointMcpServerId,shadowAiFindingId,risks,secretTypes}`;
  - `firstSeenAt`, `lastSeenAt`.
  Changes are additive only within `/v1`.
- Caller scope: an admin principal or `system_task`. The device-scoped read for the endpoint agent follows I2.

## Consequences

- One query answers "what is on which endpoint, at which version, and is that exact content scanned". Unscanned
  content, or content whose scanner is off, can no longer look clear, and the inventory can no longer lag or contradict
  its evidence.
- Each list call reads all endpoint evidence and does one digest lookup per version on `admission_engine_scans`, which
  has no `(engine_id, subject_digest)` index; that table belongs to ADR-0242. This is fine at current sizes. A
  follow-up adds the index, or a measured read model naming its source of truth, if the inventory grows (PENDING).
- Directly recorded sightings are deleted with their device, but no age-based retention prunes them yet. The endpoint
  lane that writes them adds the ADR-0195 90-day retention for them (PENDING).
- MCP servers stay `not_yet_scanned` until the endpoint agent reports a content digest for them (endpoint lane).
- Open source first (ADR-0176): no library models "an inventory joined to our own scan rows"; this is RegulAIt's own
  governance read model over its own tables. It reuses the ADR-0242 helpers (`admissionScanEngineFor`,
  `engineAdmissionHold`, `maxSeverity`), the ADR-0189 `aiBomRef`, the ADR-0259 identity pattern and the shared severity
  order. It is built on drizzle, zod and PostgreSQL features already in use, with no new dependency.
- Three read-only routes are API-only KNOWN_UI_GAPS entries: the master's lane E14 brief (2026-11-15) assigns their
  screen to the UI builder on #453, which moves the ratchet from 54 to 57. The screen brief is in PR #866.
