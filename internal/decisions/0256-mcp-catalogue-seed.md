# ADR-0256: Seed the MCP catalogue from the official MCP Registry, community lists and signed offline bundles

- **Status**: Proposed
- **Date**: 2026-11-07
- **Backlog**: P32 (owner-approved 2026-11-07, "From the SDK and platform review")
- **Relates to**: ADR-0101 (federated MCP registries: the pull, the inert catalogue, the explicit import), ADR-0097 /
  ADR-0100 (the MCP admission scan, the only way to admission), ADR-0043 / ADR-0034 (the egress guard), ADR-0062
  (air-gapped mode), ADR-0175 A5 (release-age sightings), ADR-0176 (open source first), ADR-0180 (secure by default),
  ADR-0200 (engineering guidelines and the normalized-schema addendum). Coordinates with P23 (MCP and skill scanners,
  `builder/p23-mcp-skill-scanners`) and P27 (tool-change pinning, `builder/p27-mcp-pinning-fixtures`) on #453.
- **Migration**: 0311 (`0311_mcp_catalogue_seed`), `when` 1785238000000; renumbered above main's highest at merge.

## Context

The admin MCP catalogue (`mcp_registry_entries`, ADR-0101) is empty on a fresh install: an admin has to know a
registry URL to configure one. P32 asks that it can be seeded from the official MCP Registry, optionally from community
lists such as `punkpeye/awesome-mcp-servers`, and that air-gapped installs get the same through a signed offline bundle.

### What was checked first (2026-11-07)

**The official MCP Registry** (`https://registry.modelcontextprotocol.io`, source `modelcontextprotocol/registry`):

- **API.** `GET /v0.1/servers`, no authentication to read. The v0.1 API has been frozen since 2025-10-24 (OpenAPI
  document version `2025-12-01`). Query parameters: `cursor` (opaque, from `metadata.nextCursor`), `limit`,
  `search`, `version` (`latest`), `updated_since` and `include_deleted` (forced true whenever `updated_since` is set,
  which is why ADR-0101 sends neither). A response is `{ servers: [{ server, _meta }], metadata: { count,
  nextCursor } }`. A live call returned that shape.
- **Schema.** Each `server` is a `server.json` document (`$schema`
  `https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json`): `name` (reverse-DNS), `description`,
  `version`, `title`, `websiteUrl`, `repository.url`, `packages[]` (npm, PyPI, OCI, NuGet, MCPB; run locally over
  stdio) and `remotes[]` (`{ type: streamable-http | sse, url }`). Registry-managed facts (status, publishedAt,
  updatedAt, isLatest) live under `_meta["io.modelcontextprotocol.registry/official"]`. ADR-0101's parser already reads
  exactly this, permissively.
- **Data licence.** The registry Terms of Service §10: server metadata and other Registry Data "is intended to be
  public, and will be dedicated to the public domain under CC0 1.0 Universal". The registry's code is Apache-2.0
  (MIT for contributions not yet relicensed); we ship none of it.
- **Status.** Launched as a preview (2025-09-08, "breaking changes or data resets may occur"); the v0.1 freeze is the
  stability statement we rely on. The adapter's path is a constant, so a v1 move is one change.
- **Payment.** The registry has no paid or pricing field. x402 (HTTP 402 payments) servers are listed today and say so
  only in their name, title, description or URLs (for example `ai.firmbrain/x402-services`, "77 pay-per-call x402
  tools").

**`punkpeye/awesome-mcp-servers`**: MIT. A markdown README of about 5,100 lines. An entry is a top-level bullet
`- [owner/repo](https://github.com/owner/repo) <badge> <legend emoji> - description`. The legend marks official
implementations, language, scope (cloud, local, embedded) and OS. There is no endpoint and no paid marker; x402 appears
in descriptions (131 mentions on 2026-11-07).

**Open source first (ADR-0176).** No new dependency:

- the official registry is read by ADR-0101's existing adapter;
- the community list is read with `indexOf` and the WHATWG `URL` parser. A CommonMark parser (`marked`, `micromark`)
  would add a dependency to the gateway to read one line shape, and its tree would still need the same link and URL
  checks, so none fits;
- signatures are Ed25519 through `node:crypto`, the same primitive the BOM verifier (ADR-0116) and the receipt keys
  already use. Sigstore or minisign would add a dependency and a format for a signer we also own; none is needed.

## Decision

Seed the catalogue on top of ADR-0101, without changing its rules: a pull writes only the catalogue, an import is a
separate stepped-up act, an imported server is `unscanned` with no grants, and there is no catalogue branch in the call
path.

1. **Sources have a listing kind and a delivery.** `mcp_registries.listing_kind` is `registry` or `community`;
   `mcp_registries.delivery` is `pull` or `offline_bundle`. Existing rows are registry pulls (the defaults). Vetting is
   derived, never stored per entry: `community` sources are **unvetted**; `registry` sources are **registry-listed**
   (the registry authenticated the publisher's namespace, nothing more).

2. **Presets, not seed rows.** `POST /v1/mcp-catalogue/presets/:preset` (`official`, `awesome-mcp-servers`) creates the
   source **disabled**, through the same write-time egress check as any registry, so the host must already be
   allow-listed. A fresh install still has zero sources. Enabling a source is ADR-0101's stepped-up PATCH.

3. **Imports are snapshots, never request-time fetches.** A source is refreshed only by the scheduled sweep or an
   admin's manual sync (both through ADR-0043's guarded fetch, refused outright when air-gapped), or by a bundle
   import. The catalogue read (`GET /v1/mcp-catalogue`) reads the database only. Each successful refresh writes one
   **append-only** `mcp_catalogue_snapshots` row (count, truncated, sha256 over the sorted release digests, actor, and
   for a bundle the key id, the signed-bytes digest and the bundle's `createdAt`). Every row the refresh asserted gets
   `last_snapshot_id`. UPDATE, DELETE and TRUNCATE on snapshots are refused by triggers (0185's pattern).

4. **Community lists.** A `community` source's URL is the document itself. The parser keeps top-level bullets whose
   first link is a GitHub repository, once per repository, capped at 20,000 entries and 4,000 characters a line. Every
   entry is `catalogue_only` with the new reason `community_listing`, so ADR-0101's import refuses it: a list names a
   repository, and this codebase does not invent an endpoint.

5. **Dedupe with provenance per source.** `mcp_catalogue_items` holds one row per server, keyed
   `repo:github.com/owner/repo` when a source names a GitHub repository, else `name:<upstream name>`. Each source keeps
   its own `mcp_registry_entries` row (`catalogue_item_id`), so the deduped view lists every source with its own
   version, first-seen, last-synced, snapshot and vetting. Sources that agree on neither key stay separate; a wrong
   merge would show one source's provenance on another's server.

6. **Paid and x402 are flagged.** `mcp_registry_entries.paid_signal` is `x402` when `x402` appears in the name, title,
   description, website, a remote URL or a `_meta` key, else `paid` when a whole-word payment token (paid, pricing,
   subscription, pay-per-call, pay-per-use, payment) is in the title or description. It is a flag for the operator, not
   a verdict, and the item shows the strongest flag of its sources.

7. **Signed offline bundles for air-gapped installs.** A connected install exports a source as an unsigned
   `regulait.mcp-catalogue-bundle/v1` document (`GET /v1/mcp-catalogue/bundle?registryId=`). It is signed offline over
   its exact bytes with Ed25519 (`scripts/mcp-catalogue-bundle-sign.mjs`; the gateway never holds the private key) and
   imported with `POST /v1/mcp-catalogue/bundles`. The gateway verifies **before** it parses, against the keyring in
   `REGULAIT_MCP_CATALOGUE_BUNDLE_KEYS` (or `…_FILE`): public Ed25519 keys only, rotatable by listing the new key beside
   the old. A bad keyring is refused whole. **With no keyring, every bundle is refused.** The format is strict, and each
   entry is re-checked (a remote must have a dialable URL, a catalogue-only entry must not claim one). A bundle not
   newer than the last one imported for its source is refused (rollback and replay protection). A bundle never
   overwrites a pulled source of the same name. A bundle source is never dialled: a sync returns `skipped` and the
   sweep does not select it, and its URL is provenance that PATCH refuses to edit. The import is one transaction on the
   database clock.

8. **Nothing is trusted, and nothing here admits anything.** Every entry is "available, not admitted". The deduped
   view reports `available_not_admitted`, `imported_not_admitted` or `imported_admitted` (only `clean` or `cleared`).
   The way to use an entry is ADR-0101's import, which creates an `unscanned` server with no grants that must pass the
   MCP admission scan, including the P23 scanners and the P27 tool-change pinning as they land on that path. This ADR
   adds no bypass and no new admission state.

9. **Admin-only and audited.** None of the four new routes is in `NON_ADMIN_ROUTES`. New audit rule ids:
   `mcp-catalogue-source-seeded`, `mcp-catalogue-bundle-imported`, `mcp-catalogue-bundle-refused` (every refusal,
   including no keyring). Pulls keep `mcp-registry-synced`, whose detail now carries the listing kind and snapshot id.

## Consequences

- A refreshed source can no longer be deleted (its snapshots restrict it). There is no delete route; the ADR-0101 test
  suite now disables its sources instead of deleting them.
- `catalogue_item_id` is NULL for a row synced before 0311 until its source is refreshed again; nothing is backfilled.
  The deduped view only lists linked rows.
- The catalogue tables are org-wide admin tables, like `mcp_registries`, so they are not in an ADR-0234 RLS batch.
- An exported bundle does not carry `packages[]` (the catalogue never stored it), so `packageCount` is 0 in a bundle.
  Classification is carried as-is.
- The dedupe is conservative: an official entry with no `repository.url` does not merge with its community listing.
- The paid flag is a heuristic over text the publisher wrote. It can miss a paid server and can flag a free one that
  mentions pricing.
- The community list is read from `main`, not a pinned commit. Each snapshot's content digest records what it said.

## Not done here (posted to #453)

- The UI: the deduped catalogue page, preset buttons, bundle upload and badges for unvetted, paid, x402 and admission.
- Pinning a community source to a commit, and other community lists beyond the preset (any can be added as a
  `community` source today).
- Using the registry's `updated_since` for incremental pulls, which would need tombstone handling (ADR-0101).
