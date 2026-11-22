-- ADR-0366 slice 2 (lane E52): rogue-agent containment of a virtual key.
-- Hand-authored (never drizzle-kit generate). Re-runnable: every statement is idempotent. Sorts after
-- `rogue_agent_containment.sql` (byte order: '.' < '_'), which creates `agent_containments`.
--
-- 1. `virtual_keys` gets ADR-0124's halt columns. `revoked_at` is permanent; a containment must be reversible by an
--    approved release (owner decision 2026-11-21), so it halts the key instead. A halted key authenticates nothing.
-- 2. `agent_containments` gains `virtual_key_id` and its subject CHECKs admit `virtual_key`. Row-level security is
--    unchanged (slice 1: admin, `system_task`, `migration`).
-- No new functions or refusal triggers.

ALTER TABLE "virtual_keys" ADD COLUMN IF NOT EXISTS "halted_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "virtual_keys" ADD COLUMN IF NOT EXISTS "halted_reason" text;
--> statement-breakpoint
ALTER TABLE "virtual_keys" ADD COLUMN IF NOT EXISTS "halted_by_user_id" uuid;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "virtual_keys" ADD CONSTRAINT "virtual_keys_halted_by_user_id_users_id_fk"
    FOREIGN KEY ("halted_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "virtual_keys" ADD CONSTRAINT "virtual_keys_halt_reason_ck" CHECK (
    ("halted_at" IS NULL AND "halted_reason" IS NULL)
    OR ("halted_at" IS NOT NULL AND "halted_reason" IS NOT NULL AND length(btrim("halted_reason")) > 0)
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "virtual_keys_halted_idx" ON "virtual_keys" ("id") WHERE "halted_at" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "agent_containments" ADD COLUMN IF NOT EXISTS "virtual_key_id" uuid;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "agent_containments" ADD CONSTRAINT "agent_containments_virtual_key_id_virtual_keys_id_fk"
    FOREIGN KEY ("virtual_key_id") REFERENCES "public"."virtual_keys"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
ALTER TABLE "agent_containments" DROP CONSTRAINT IF EXISTS "agent_containments_subject_kind_check";
--> statement-breakpoint
ALTER TABLE "agent_containments" ADD CONSTRAINT "agent_containments_subject_kind_check"
  CHECK ("subject_kind" IN ('agent', 'builder_agent', 'virtual_key'));
--> statement-breakpoint
ALTER TABLE "agent_containments" DROP CONSTRAINT IF EXISTS "agent_containments_subject_check";
--> statement-breakpoint
ALTER TABLE "agent_containments" ADD CONSTRAINT "agent_containments_subject_check" CHECK (
  ("subject_kind" = 'agent' AND "agent_id" IS NOT NULL AND "builder_agent_id" IS NULL AND "virtual_key_id" IS NULL)
  OR ("subject_kind" = 'builder_agent' AND "builder_agent_id" IS NOT NULL AND "agent_id" IS NULL AND "virtual_key_id" IS NULL)
  OR ("subject_kind" = 'virtual_key' AND "virtual_key_id" IS NOT NULL AND "agent_id" IS NULL AND "builder_agent_id" IS NULL)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_containments_virtual_key_idx" ON "agent_containments" ("virtual_key_id", "status");
