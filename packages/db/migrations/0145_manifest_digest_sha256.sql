-- ADR-0176 security fix 1 — the MCP manifest digest moves from FNV-1a 64 to
-- SHA-256, with a ONE-TIME RE-PIN so cleared servers stay cleared and the
-- release-age cooldown keeps every first-seen time.
--
-- WHY THE RE-PIN IS NOT IN THIS FILE. The new digest is SHA-256 over the
-- manifest's canonical JSON as JavaScript's JSON.stringify writes it (tools
-- sorted by name, schema keys sorted at every depth, JS string escaping and
-- number formatting). Postgres has sha256(), but it cannot reproduce that
-- exact text from jsonb (its key order, spacing, escaping and number
-- rendering all differ), and a digest computed over different bytes would
-- re-hold every cleared server — the outcome the re-pin exists to prevent.
-- Re-pinning also has to PROVE each row first: the stored manifest
-- (`mcp_tools`) is only trusted for a server when it reproduces that server's
-- stored FNV digest exactly. That check needs the same canonical form.
--
-- So the re-pin runs once at gateway boot, after migrations and before
-- listen (`repinManifestDigests`, apps/gateway/src/manifest-digest-repin.ts),
-- under a transaction-scoped advisory lock, and records its completion in the
-- marker table created here. Per server it:
--   - recomputes the legacy FNV digest of the stored manifest; when it equals
--     `admission_manifest_digest` / `release_digest`, rewrites that column to
--     the SHA-256 digest of the same manifest (clearance and release kept);
--   - copies the `release_sightings` row (mcp_manifest, nil subject) for the
--     FNV digest to the SHA-256 digest WITH ITS first_seen_at (the earlier
--     time wins if both exist), and copies a `release_overrides` row for
--     (mcp_server, server, FNV digest) to the SHA-256 digest;
--   - leaves a row it cannot prove (the stored tools were never synced, were
--     refused, or include a tool the server no longer serves) on its FNV
--     digest. Its next sync then fails closed: a cleared server is
--     re-adjudicated (re-held if its manifest still scans dirty) and its
--     cooldown clock starts at that sync. The marker's `detail` lists them.
-- Old FNV sighting rows are kept (history); nothing compares with them again.
-- A PENDING MCP consent (AER-039) commits to the admission digest inside its
-- context digest, which cannot be recomputed here without the full policy
-- context it was signed under. A consent pending on a re-pinned server
-- therefore goes stale and is re-queued once, exactly as when an admin edits
-- the server (fail closed; the approval TTL bounds how many exist).
--
-- Additive and idempotent.
CREATE TABLE IF NOT EXISTS "data_backfills" (
  "name" text PRIMARY KEY NOT NULL,
  "completed_at" timestamp with time zone DEFAULT now() NOT NULL,
  "detail" jsonb
);
