-- ADR-0202 decision 4 (lane L): the per-beat simulated fallback for the hosted demo.
-- Hand-authored (never drizzle-kit generate). Re-runnable: every statement is idempotent.
--
-- 1. One row per demo beat an admin has switched. A beat with NO row is live, which is the default (ADR-0180):
--    nothing is backfilled, so a fresh or upgraded database runs every beat live.
-- 2. Written only by `PUT /v1/demo/beats/:beatId` (admin-only), in the same transaction as its audit row. The beat
--    ids are validated against the gateway's fixed list; the CHECK below only bounds the shape.

CREATE TABLE IF NOT EXISTS "demo_beat_fallbacks" (
  "beat_id" text PRIMARY KEY NOT NULL,
  "simulated" boolean DEFAULT false NOT NULL,
  "reason" text NOT NULL,
  "updated_by" uuid,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "demo_beat_fallbacks_beat_id_check" CHECK ("beat_id" ~ '^[a-z][a-z0-9-]{1,63}$')
);
