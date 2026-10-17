-- ADR-0190 I4 follow-up: stdio sessions on a multi-replica gateway (the frames table).
-- Hand-authored (never drizzle-kit generate). Re-runnable: every statement is idempotent.
-- Journal entry: idx 204 (`0204_isolation_stdio_relay`), right after 0203; the number was assigned by the master.
--
-- A stdio session is held by the gateway replica that placed it (its MCP client lives there), but the executor's
-- window (`GET /v1/executor-channel/offers/:id/stdio`) and its stdout POSTs may reach ANY replica. Every replica
-- therefore serves those routes from these two tables, and the holder relays between them and its in-process
-- session. No replica-to-replica endpoint exists: the database is the only path between replicas.
--
--   stdio_relay_sessions   one row per placed session: which replica holds it (a lease the holder renews), the
--                          sealed `start` line, the sequence counters, one open window at a time, and how it ended.
--   stdio_relay_frames     the frames in flight, each direction. A frame is deleted once it is acknowledged (stdin)
--                          or delivered to the holder (stdout); a session's frames go when it ends.
--
-- Bounds: one frame is at most 768 KiB (STDIO_FRAME_MAX_BYTES); the holder refuses stdin past 4 MiB per session and
-- the routes refuse stdout past 4 MiB buffered (`out_buffered_bytes`), so one session holds at most 8 MiB. Ended
-- rows are kept 5 minutes (a late window is answered `offer_unavailable`), then deleted with any stragglers; a row
-- whose lease lapsed more than an hour ago is deleted whatever its state.
--
-- Ownership is fixed: the offer, the executor and the holding replica never change (no takeover; a holder that is
-- gone means the session is lost, fail closed). Frames are never rewritten.
CREATE TABLE IF NOT EXISTS "stdio_relay_sessions" (
  "offer_id" uuid PRIMARY KEY REFERENCES "execution_offers"("id") ON DELETE RESTRICT,
  "executor_id" uuid NOT NULL REFERENCES "executors"("id") ON DELETE RESTRICT,
  "owner_replica" uuid NOT NULL,
  "lease_expires_at" timestamptz NOT NULL,
  "start_sealed" text,
  "in_next_seq" bigint NOT NULL DEFAULT 0,
  "in_acked_to" bigint NOT NULL DEFAULT 0,
  "out_next_seq" bigint NOT NULL DEFAULT 0,
  "out_buffered_bytes" integer NOT NULL DEFAULT 0,
  "window_token" uuid,
  "window_until" timestamptz,
  "closed_at" timestamptz,
  "eof_at" timestamptz,
  "ended_at" timestamptz,
  "end_code" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "stdio_relay_sessions_seq_check" CHECK ("in_acked_to" >= 0 AND "in_acked_to" <= "in_next_seq" AND "out_next_seq" >= 0),
  CONSTRAINT "stdio_relay_sessions_out_buffer_check" CHECK ("out_buffered_bytes" >= 0 AND "out_buffered_bytes" <= 4194304),
  CONSTRAINT "stdio_relay_sessions_window_check" CHECK (("window_token" IS NULL) = ("window_until" IS NULL)),
  CONSTRAINT "stdio_relay_sessions_start_check" CHECK ("start_sealed" IS NULL OR char_length("start_sealed") <= 1200000),
  CONSTRAINT "stdio_relay_sessions_end_check" CHECK (
    ("ended_at" IS NULL AND "end_code" IS NULL)
    OR ("ended_at" IS NOT NULL AND "end_code" IN ('ended', 'sequence', 'lease_expired', 'buffer_full'))
  )
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stdio_relay_sessions_owner_idx" ON "stdio_relay_sessions" ("owner_replica") WHERE "ended_at" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stdio_relay_sessions_retention_idx" ON "stdio_relay_sessions" ("ended_at", "lease_expires_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "stdio_relay_frames" (
  "offer_id" uuid NOT NULL REFERENCES "stdio_relay_sessions"("offer_id") ON DELETE CASCADE,
  "direction" text NOT NULL,
  "seq" bigint NOT NULL,
  "data" text NOT NULL,
  "bytes" integer NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("offer_id", "direction", "seq"),
  CONSTRAINT "stdio_relay_frames_direction_check" CHECK ("direction" IN ('in', 'out')),
  CONSTRAINT "stdio_relay_frames_seq_check" CHECK ("seq" >= 0),
  CONSTRAINT "stdio_relay_frames_bytes_check" CHECK ("bytes" >= 0 AND "bytes" <= 786432 AND octet_length("data") = "bytes")
);
--> statement-breakpoint
-- ownership is fixed and an ended session stays ended (no takeover, no revival); frames are never rewritten
-- (migration 0185's invariants: each function pins its search_path, and each table it guards refuses TRUNCATE)
CREATE OR REPLACE FUNCTION "stdio_relay_sessions_guard"() RETURNS trigger LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW."offer_id" IS DISTINCT FROM OLD."offer_id" OR NEW."executor_id" IS DISTINCT FROM OLD."executor_id"
     OR NEW."owner_replica" IS DISTINCT FROM OLD."owner_replica" THEN
    RAISE EXCEPTION 'stdio_relay_sessions: the offer, executor and holding replica never change (ADR-0190 I4)' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."ended_at" IS NOT NULL AND (NEW."ended_at" IS DISTINCT FROM OLD."ended_at" OR NEW."end_code" IS DISTINCT FROM OLD."end_code") THEN
    RAISE EXCEPTION 'stdio_relay_sessions: an ended session stays ended (ADR-0190 I4)' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "stdio_relay_sessions_guard" ON "stdio_relay_sessions";
--> statement-breakpoint
CREATE TRIGGER "stdio_relay_sessions_guard" BEFORE UPDATE ON "stdio_relay_sessions"
  FOR EACH ROW EXECUTE FUNCTION "stdio_relay_sessions_guard"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "stdio_relay_sessions_no_truncate" ON public."stdio_relay_sessions";
--> statement-breakpoint
CREATE TRIGGER "stdio_relay_sessions_no_truncate" BEFORE TRUNCATE ON public."stdio_relay_sessions"
  FOR EACH STATEMENT EXECUTE FUNCTION public.regulait_refuse_truncate();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "stdio_relay_frames_immutable"() RETURNS trigger LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'stdio_relay_frames: a frame is never rewritten (ADR-0190 I4)' USING ERRCODE = 'check_violation';
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "stdio_relay_frames_immutable" ON "stdio_relay_frames";
--> statement-breakpoint
CREATE TRIGGER "stdio_relay_frames_immutable" BEFORE UPDATE ON "stdio_relay_frames"
  FOR EACH ROW EXECUTE FUNCTION "stdio_relay_frames_immutable"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "stdio_relay_frames_no_truncate" ON public."stdio_relay_frames";
--> statement-breakpoint
CREATE TRIGGER "stdio_relay_frames_no_truncate" BEFORE TRUNCATE ON public."stdio_relay_frames"
  FOR EACH STATEMENT EXECUTE FUNCTION public.regulait_refuse_truncate();
