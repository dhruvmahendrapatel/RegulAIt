-- ADR-0101 — FEDERATED MCP REGISTRY: a governed catalogue, and an import that
-- grants nobody anything.
--
-- THE PROBLEM. `mcp_servers` is a row with a URL, dialled over streamable HTTP
-- through ADR-0043's egress guard. A public MCP registry is a PUBLICATION
-- DIRECTORY, and most of what it publishes is a `packages[]` coordinate you
-- install and run locally over stdio. There is no URL in those entries, and
-- inventing one would be the worst possible outcome of this feature. So the
-- catalogue table below is deliberately NOT a staging area for `mcp_servers`:
-- it is a record of what a registry says exists, of which only the subset
-- carrying a real `remotes[]` endpoint can ever become a callable server row.
--
-- THE GOVERNANCE POSITION, which is the point of the whole migration. The
-- reference implementation we reviewed (agentic-community/mcp-gateway-registry)
-- gives a federated entry THE SAME ACCESS as a locally-registered one, with no
-- approval step. That is a default-allow federation bolted onto a default-deny
-- product, and this schema is shaped so it cannot happen here:
--
--   * `mcp_registry_entries` is the ONLY thing a sync writes. A sync NEVER
--     creates an `mcp_servers` row. Import is a separate, audited, explicit
--     operator act, and a catalogue row with `server_id IS NULL` is inert by
--     construction — no server row means no `/mcp/:serverId` route, no tool
--     inventory, and no grant that could name it.
--   * An imported row lands with `admission_state = 'unscanned'` (written
--     EXPLICITLY, never inheriting 0103's `grandfathered` default — federation
--     is exactly the population that must not be grandfathered) and with zero
--     `tool_grants` / `server_grants`. Importing grants NOBODY anything.
--   * `mcp_servers.origin` DEFAULT 'local' means every row that exists when
--     this migration runs is, and stays, the operator's own decision. Nothing
--     federated can ever silently take over one: the import path refuses on a
--     name or url collision and records the conflict on the catalogue row.
--
-- PROVENANCE ON THE SERVER ROW ITSELF. `registry_id`, `registry_entry_name`,
-- `registry_version`, `registry_first_seen_at`, `registry_last_synced_at` live
-- on `mcp_servers` and not only on the catalogue table, because the operator
-- question is "where did THIS server come from" asked while looking at the
-- server. `ON DELETE SET NULL` on the registry reference: deleting a registry
-- configuration must never cascade into deleting servers an operator is relying
-- on — it demotes them to provenance-orphaned, which the row still shows.
--
-- DELETIONS. `upstream_status` and `missing_since` record what the registry
-- says (or stops saying) about an entry. Neither ever deletes, disables or
-- un-grants a local server row. A directory losing an entry is not authority to
-- remove a governed object from someone's estate; it is information an operator
-- acts on.
--
-- NOTHING IS ENABLED BY THIS MIGRATION. `mcp_registries.enabled` DEFAULT false,
-- and a fresh install has zero rows in it — so federation is off because there
-- is nothing to federate, not because a flag says so. Combined with ADR-0064's
-- scheduler being off by default, the sweep added here is doubly opt-in.

CREATE TABLE IF NOT EXISTS "mcp_registries" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- operator's own label for this registry, unique so a second configuration of
  -- the same upstream is a deliberate act with a distinct name
  "name" text NOT NULL UNIQUE,
  -- BASE url. The `/v0.1/servers` path is appended by the adapter, so an
  -- operator cannot half-configure a listing endpoint, and the guarded fetch
  -- adjudicates the base exactly like every other admin-typed destination.
  "url" text NOT NULL,
  -- OFF until an operator says otherwise. A configured-but-disabled registry is
  -- a useful state: it keeps the catalogue and the provenance without pulling.
  "enabled" boolean NOT NULL DEFAULT false,
  -- ADR-0043's per-destination private-range posture, same tri-state as
  -- `mcp_servers.allow_private_ranges` (NULL inherits the org default). An
  -- internal registry mirror on the LAN is an ordinary deployment.
  "allow_private_ranges" boolean,
  "last_sync_at" timestamp with time zone,
  "last_sync_outcome" text,
  "last_sync_detail" jsonb,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "mcp_registries"
  DROP CONSTRAINT IF EXISTS "mcp_registries_last_sync_outcome_check";
--> statement-breakpoint
ALTER TABLE "mcp_registries"
  ADD CONSTRAINT "mcp_registries_last_sync_outcome_check"
  CHECK ("last_sync_outcome" IS NULL
         OR "last_sync_outcome" IN ('ok', 'failed', 'refused', 'skipped'));
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mcp_registry_entries" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "registry_id" uuid NOT NULL REFERENCES "mcp_registries"("id") ON DELETE CASCADE,
  -- the reverse-DNS publication name, VERBATIM. It is the idempotency key
  -- (with registry_id) and the only string that can be pasted back upstream.
  "upstream_name" text NOT NULL,
  "upstream_version" text NOT NULL,
  "title" text,
  "description" text,
  "repository_url" text,
  "website_url" text,
  -- 'remote' (a dialable endpoint) | 'catalogue_only' (a package/stdio/
  -- templated entry that can never become a server row)
  "kind" text NOT NULL,
  "remote_url" text,
  "remote_transport" text,
  "catalogue_reason" text,
  -- the registry's OWN lifecycle statement about the entry
  "upstream_status" text,
  "upstream_published_at" timestamp with time zone,
  "upstream_updated_at" timestamp with time zone,
  -- the imported server, when an operator imported it. ON DELETE SET NULL:
  -- deleting the server keeps the catalogue record and its provenance.
  "server_id" uuid REFERENCES "mcp_servers"("id") ON DELETE SET NULL,
  "imported_at" timestamp with time zone,
  "imported_by" uuid,
  -- a collision with a row this registry does not own. RECORDED, never resolved
  -- by overwriting: 'name_taken' | 'url_taken'.
  "conflict_reason" text,
  "conflict_server_id" uuid REFERENCES "mcp_servers"("id") ON DELETE SET NULL,
  -- the upstream endpoint moved AFTER an import. The local `mcp_servers.url` is
  -- NOT rewritten — a registry silently redirecting a server an operator
  -- already trusts is the federation attack, not a convenience.
  "remote_url_drift" text,
  -- provenance clock
  "first_seen_at" timestamp with time zone NOT NULL DEFAULT now(),
  "last_seen_at" timestamp with time zone NOT NULL DEFAULT now(),
  "last_synced_at" timestamp with time zone NOT NULL DEFAULT now(),
  -- set when a COMPLETE (untruncated) listing no longer contained this entry.
  -- Never set from a capped pass, because "beyond the page cap" and "gone" are
  -- different facts and must not be confused.
  "missing_since" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "mcp_registry_entries_registry_name_uq"
  ON "mcp_registry_entries" ("registry_id", "upstream_name");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mcp_registry_entries_kind_idx"
  ON "mcp_registry_entries" ("registry_id", "kind");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mcp_registry_entries_server_idx"
  ON "mcp_registry_entries" ("server_id");
--> statement-breakpoint
ALTER TABLE "mcp_registry_entries"
  DROP CONSTRAINT IF EXISTS "mcp_registry_entries_kind_check";
--> statement-breakpoint
ALTER TABLE "mcp_registry_entries"
  ADD CONSTRAINT "mcp_registry_entries_kind_check"
  CHECK ("kind" IN ('remote', 'catalogue_only'));
--> statement-breakpoint
ALTER TABLE "mcp_registry_entries"
  DROP CONSTRAINT IF EXISTS "mcp_registry_entries_conflict_reason_check";
--> statement-breakpoint
ALTER TABLE "mcp_registry_entries"
  ADD CONSTRAINT "mcp_registry_entries_conflict_reason_check"
  CHECK ("conflict_reason" IS NULL OR "conflict_reason" IN ('name_taken', 'url_taken'));
--> statement-breakpoint
ALTER TABLE "mcp_registry_entries"
  DROP CONSTRAINT IF EXISTS "mcp_registry_entries_upstream_status_check";
--> statement-breakpoint
ALTER TABLE "mcp_registry_entries"
  ADD CONSTRAINT "mcp_registry_entries_upstream_status_check"
  CHECK ("upstream_status" IS NULL
         OR "upstream_status" IN ('active', 'deprecated', 'deleted'));
--> statement-breakpoint
ALTER TABLE "mcp_servers"
  ADD COLUMN IF NOT EXISTS "origin" text NOT NULL DEFAULT 'local';
--> statement-breakpoint
ALTER TABLE "mcp_servers"
  ADD COLUMN IF NOT EXISTS "registry_id" uuid;
--> statement-breakpoint
ALTER TABLE "mcp_servers"
  ADD COLUMN IF NOT EXISTS "registry_entry_name" text;
--> statement-breakpoint
ALTER TABLE "mcp_servers"
  ADD COLUMN IF NOT EXISTS "registry_version" text;
--> statement-breakpoint
ALTER TABLE "mcp_servers"
  ADD COLUMN IF NOT EXISTS "registry_first_seen_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "mcp_servers"
  ADD COLUMN IF NOT EXISTS "registry_last_synced_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "mcp_servers"
  DROP CONSTRAINT IF EXISTS "mcp_servers_origin_check";
--> statement-breakpoint
ALTER TABLE "mcp_servers"
  ADD CONSTRAINT "mcp_servers_origin_check"
  CHECK ("origin" IN ('local', 'federated'));
--> statement-breakpoint
ALTER TABLE "mcp_servers"
  DROP CONSTRAINT IF EXISTS "mcp_servers_registry_id_fk";
--> statement-breakpoint
ALTER TABLE "mcp_servers"
  ADD CONSTRAINT "mcp_servers_registry_id_fk"
  FOREIGN KEY ("registry_id") REFERENCES "mcp_registries"("id") ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mcp_servers_origin_idx" ON "mcp_servers" ("origin");
