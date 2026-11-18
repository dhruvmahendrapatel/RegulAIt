-- ADR-0352: neutral queue metadata; decisions and routing authority are untouched.
ALTER TABLE approvals ADD COLUMN priority text NOT NULL DEFAULT 'normal';
ALTER TABLE approvals ADD CONSTRAINT approvals_priority_check CHECK (priority IN ('low', 'normal', 'high', 'urgent'));
CREATE INDEX approvals_status_priority_idx ON approvals (status, priority, requested_at, id);
--> statement-breakpoint
-- ADR-0234 closed column privileges: grant only the added metadata column;
-- existing row policies and protected identity-column grants remain unchanged.
GRANT UPDATE (priority) ON approvals TO regulait_app;
