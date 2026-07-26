-- PILLAR 6 context compaction (TOKEN_OPTIMIZATION_SPEC §5): one persisted
-- summary per conversation, replaced cumulatively on re-compaction. Stored
-- messages are NEVER deleted or altered — these columns only change what is
-- model-bound (summary + turns after summary_through_message_id).
ALTER TABLE "conversations" ADD COLUMN "summary" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "summary_through_message_id" uuid;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "summary_tokens" integer;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "compacted_at" timestamp with time zone;
