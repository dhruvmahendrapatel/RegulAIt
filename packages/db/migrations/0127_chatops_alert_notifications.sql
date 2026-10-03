-- ADR-0162 — governance-monitor alerts delivered to chat.
--
-- Per ChatOps connection: the minimum alert severity it receives. NULL = off
-- (the default — an existing workspace starts receiving nothing new until an
-- admin opts it in). Alert cards carry no decide buttons; delivery goes
-- through the same guarded courier as approval cards (egress allow-list,
-- bot token in the connector credential store).
ALTER TABLE "chatops_connections" ADD COLUMN IF NOT EXISTS "notify_alert_min_severity" text;
--> statement-breakpoint
ALTER TABLE "chatops_connections" ADD CONSTRAINT "chatops_connections_alert_severity_check"
  CHECK ("notify_alert_min_severity" IS NULL OR "notify_alert_min_severity" IN ('medium', 'high'));
