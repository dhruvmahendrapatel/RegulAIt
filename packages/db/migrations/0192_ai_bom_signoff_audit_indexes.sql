-- ADR-0189 R25 review fix (Medium 4). Hand-authored (never drizzle-kit generate). Re-runnable: every statement is
-- IF NOT EXISTS. No row is read or written.
--
-- The AI BOM sign-off reads on `audit_log` had no index they could use, so the posture report and drift each scanned
-- the whole trail:
--   * posture, "owed but missing" (item 9): the triggering rows of the window that carry `aiBomSnapshotsDue`, and for
--     each owed subject a NOT EXISTS lookup of the taken / skipped / failed row of that sign-off and subject;
--   * posture, the window's snapshot and gap counts (items 4 and 7);
--   * drift, the subject's gap rows, newest first (item 4).
-- Each index below is PARTIAL, so it holds only the AI BOM rows (a handful per sign-off) and costs nothing on the rest
-- of the trail. The queries spell the same predicates (`apps/gateway/src/posture.ts`, `apps/gateway/src/ai-bom.ts`).
--
-- CREATE INDEX, not CONCURRENTLY: the migrator applies pending files in one transaction (migrations 0154, 0155 and
-- 0167 index `audit_log` the same way). The append-only guards on `audit_log` are row triggers on INSERT, UPDATE,
-- DELETE and TRUNCATE; building an index fires none of them.

-- posture's NOT EXISTS: one sign-off's row for one subject
CREATE INDEX IF NOT EXISTS "audit_log_ai_bom_signoff_subject_idx" ON "audit_log" (
  ("detail" ->> 'aiBomSignoffId'), ("detail" ->> 'subjectKind'), ("detail" ->> 'subjectId')
) WHERE "rule_id" IN ('ai-bom-snapshot-taken', 'ai-bom-snapshot-skipped-no-key', 'ai-bom-snapshot-failed');
--> statement-breakpoint
-- drift: one subject's gap rows, newest first
CREATE INDEX IF NOT EXISTS "audit_log_ai_bom_gap_subject_at_idx" ON "audit_log" (
  ("detail" ->> 'subjectKind'), ("detail" ->> 'subjectId'), "at"
) WHERE "rule_id" IN ('ai-bom-snapshot-skipped-no-key', 'ai-bom-snapshot-failed');
--> statement-breakpoint
-- posture: the window's triggering rows that owe snapshots
CREATE INDEX IF NOT EXISTS "audit_log_ai_bom_due_at_idx" ON "audit_log" ("at") WHERE "detail" ? 'aiBomSnapshotsDue';
--> statement-breakpoint
-- posture: the window's taken and gap counts
CREATE INDEX IF NOT EXISTS "audit_log_ai_bom_snapshot_rows_idx" ON "audit_log" ("rule_id", "at")
  WHERE "rule_id" IN ('ai-bom-snapshot-taken', 'ai-bom-snapshot-skipped-no-key', 'ai-bom-snapshot-failed');
