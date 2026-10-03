-- ADR-0157 — the governance monitor's alerts.
--
-- One row per (rule, subject) CONDITION EPISODE. While the condition holds the
-- sweep refreshes the row (last_detected_at, title, detail); when it clears the
-- row is resolved and a later recurrence opens a NEW row, so the history of
-- "how long was this true, and who looked at it" is never overwritten.
CREATE TABLE IF NOT EXISTS "governance_alerts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "rule_id" text NOT NULL,
  "subject_key" text NOT NULL,
  "severity" text NOT NULL,
  "title" text NOT NULL,
  "detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "status" text DEFAULT 'open' NOT NULL,
  "first_detected_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_detected_at" timestamp with time zone DEFAULT now() NOT NULL,
  "acknowledged_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "acknowledged_at" timestamp with time zone,
  "ack_note" text,
  "resolved_at" timestamp with time zone,
  CONSTRAINT "governance_alerts_severity_check" CHECK ("severity" IN ('low', 'medium', 'high')),
  CONSTRAINT "governance_alerts_status_check" CHECK ("status" IN ('open', 'acknowledged', 'resolved')),
  CONSTRAINT "governance_alerts_resolved_check" CHECK (("status" = 'resolved') = ("resolved_at" IS NOT NULL)),
  CONSTRAINT "governance_alerts_ack_check"
    CHECK (("acknowledged_at" IS NULL) = ("ack_note" IS NULL)
       AND ("status" <> 'acknowledged' OR "acknowledged_at" IS NOT NULL))
);
--> statement-breakpoint
-- at most one ACTIVE episode per condition — the sweep's dedupe key
CREATE UNIQUE INDEX IF NOT EXISTS "governance_alerts_active_uq"
  ON "governance_alerts" ("rule_id", "subject_key") WHERE "status" <> 'resolved';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "governance_alerts_status_idx" ON "governance_alerts" ("status", "last_detected_at");
