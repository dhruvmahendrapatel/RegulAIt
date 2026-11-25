-- ADR-0342 slice 2 (lane E23): human-task priority and an explicit due date on the ADR-0046 approval assignment.
-- Hand-authored (never drizzle-kit generate), additive and idempotent. No row of an RLS table is read or written.
--
-- `priority` orders the queue and is advisory: nothing approves, denies or escalates on it. `due_source` says where
-- `warn_at`/`due_at` came from: the SLA policy (the ADR-0046 derivation, unchanged), an admin (`explicit`) or a workflow
-- stage timer (`stage_timer`). The ADR-0046 SLA sweep stays the one escalation mechanism for every source.
-- The warn/due check holds for every row the ADR-0046 derivation writes (warn = requested + warn minutes <= due).

ALTER TABLE "approval_assignments" ADD COLUMN IF NOT EXISTS "priority" text DEFAULT 'normal' NOT NULL;
--> statement-breakpoint
ALTER TABLE "approval_assignments" ADD COLUMN IF NOT EXISTS "due_source" text DEFAULT 'policy' NOT NULL;
--> statement-breakpoint
ALTER TABLE "approval_assignments" DROP CONSTRAINT IF EXISTS "approval_assignments_priority_check";
--> statement-breakpoint
ALTER TABLE "approval_assignments" ADD CONSTRAINT "approval_assignments_priority_check" CHECK ("priority" IN ('low', 'normal', 'high', 'urgent'));
--> statement-breakpoint
ALTER TABLE "approval_assignments" DROP CONSTRAINT IF EXISTS "approval_assignments_due_source_check";
--> statement-breakpoint
ALTER TABLE "approval_assignments" ADD CONSTRAINT "approval_assignments_due_source_check" CHECK ("due_source" IN ('policy', 'explicit', 'stage_timer'));
--> statement-breakpoint
ALTER TABLE "approval_assignments" DROP CONSTRAINT IF EXISTS "approval_assignments_warn_due_check";
--> statement-breakpoint
ALTER TABLE "approval_assignments" ADD CONSTRAINT "approval_assignments_warn_due_check" CHECK ("warn_at" IS NULL OR ("due_at" IS NOT NULL AND "warn_at" <= "due_at"));
