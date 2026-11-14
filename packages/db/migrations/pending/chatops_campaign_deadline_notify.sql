-- ADR-0090 amendment (lane L11): certification-campaign deadline notices through ChatOps. Hand-authored (never
-- drizzle-kit generate). Re-runnable.
--
-- `chatops_connections.notify_campaign_deadlines`: opt-in per workspace, OFF by default (ADR-0180), like
-- `notify_alert_min_severity`. A resend workspace mails each campaign item's named reviewer; every other provider posts
-- to its default channel. Changing it is admin-only and audited by the existing connection PATCH.
ALTER TABLE "chatops_connections" ADD COLUMN IF NOT EXISTS "notify_campaign_deadlines" boolean DEFAULT false NOT NULL;

-- The deadline sweep reads its delivery markers by campaign on every run, and expired-incomplete campaigns stay open,
-- so the lookup is indexed to the marker rows alone (review of #825), like `audit_log_alert_escalated_idx`.
CREATE INDEX IF NOT EXISTS "audit_log_campaign_deadline_marker_idx" ON "audit_log" USING btree ("object_id")
  WHERE "rule_id" = 'campaign-deadline-notified';
