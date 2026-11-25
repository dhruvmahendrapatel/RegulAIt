-- ADR-0367: one signed policy-content stream. The signed document is a verbatim external/configuration snapshot,
-- intentionally retained byte-exact for re-verification, not denormalized references. No customer telemetry.
-- feed_id, version, digest and issued_at are also derived from the signed bundle. They are a deliberate ADR-0200
-- exception: the rollback/freeze watermark must be compared under a row lock without re-verifying the document, and
-- every read cross-checks them against the signed bytes (stored_metadata_mismatch refuses any drift).
CREATE TABLE IF NOT EXISTS detection_feed (
  id boolean PRIMARY KEY DEFAULT true CONSTRAINT detection_feed_id_check CHECK (id),
  enabled boolean NOT NULL DEFAULT false,
  version bigint NOT NULL DEFAULT 0 CONSTRAINT detection_feed_version_check CHECK (version BETWEEN 0 AND 9007199254740991),
  feed_id text,
  bundle text,
  signature text,
  key_id text,
  digest text,
  issued_at timestamptz,
  installed_at timestamptz,
  installed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT detection_feed_document_check CHECK ((version=0 AND feed_id IS NULL AND bundle IS NULL AND signature IS NULL AND key_id IS NULL AND digest IS NULL AND issued_at IS NULL AND installed_at IS NULL AND NOT enabled)
    OR (version>0 AND feed_id IS NOT NULL AND bundle IS NOT NULL AND signature IS NOT NULL AND key_id IS NOT NULL AND digest IS NOT NULL AND digest ~ '^[0-9a-f]{64}$' AND issued_at IS NOT NULL AND installed_at IS NOT NULL)),
  CONSTRAINT detection_feed_size_check CHECK (octet_length(bundle)<=262144),
  CONSTRAINT detection_feed_fields_check CHECK (length(signature)<=256 AND length(key_id)<=80 AND length(feed_id)<=80)
);
--> statement-breakpoint
INSERT INTO detection_feed (id) VALUES (true) ON CONFLICT DO NOTHING;
--> statement-breakpoint
ALTER TABLE detection_feed ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE detection_feed FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Read-only policy data must be visible in every governed call; writes remain admin/migration-only.
DROP POLICY IF EXISTS detection_feed_read ON detection_feed;
--> statement-breakpoint
CREATE POLICY detection_feed_read ON detection_feed FOR SELECT USING (true);
--> statement-breakpoint
DROP POLICY IF EXISTS detection_feed_write ON detection_feed;
--> statement-breakpoint
CREATE POLICY detection_feed_write ON detection_feed FOR ALL
  USING ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason())='migration')
  WITH CHECK ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason())='migration');
