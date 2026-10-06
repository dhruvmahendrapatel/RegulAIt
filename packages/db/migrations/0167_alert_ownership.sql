-- ADR-0182 (ADR-0175 batch D4) S5 — PF-14: alert ownership, SLA and tickets.
--
-- 1. `org_settings.alert_ticket_connection_id`: the ONE PM connection
--    `alert_ticket_mode = auto_high` files on. Nothing goes to an outside tool
--    by an implicit choice (ADR-0180): there is no "oldest connection"
--    fallback, so `auto_high` is refused (422, PUT /v1/org/settings) unless a
--    connection is named. NULL (the strict default) = none named. If the named
--    connection is deleted, ON DELETE SET NULL leaves the mode as it was and
--    automatic filing STOPS (the alert-SLA sweep records it); it never moves to
--    another connection. The existing row takes NULL, as for a first load.
--    No CHECK ties it to the mode, because a CHECK would make deleting the
--    connection fail instead of stopping the filing.
--
-- 2. `audit_log_alert_escalated_idx`: `runAlertSlaSweep` escalates an unowned
--    episode to the admins ONCE; the marker is the escalation's own audit row
--    (`rule_id = 'governance-alert-escalated'`, `object_id` = the episode).
--    The trail has no index on `object_id`, so this partial index holds only
--    those rows (as 0154 does for the prune markers).
ALTER TABLE "org_settings" ADD COLUMN "alert_ticket_connection_id" uuid;
--> statement-breakpoint
ALTER TABLE "org_settings" ADD CONSTRAINT "org_settings_alert_ticket_connection_id_fk" FOREIGN KEY ("alert_ticket_connection_id") REFERENCES "pm_connections"("id") ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_log_alert_escalated_idx" ON "audit_log" ("object_id") WHERE "rule_id" = 'governance-alert-escalated';
