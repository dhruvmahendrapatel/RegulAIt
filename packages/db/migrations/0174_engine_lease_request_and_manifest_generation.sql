-- ADR-0187 decisions 94 and 95 (PR #205 review round 13). Hand-authored (never drizzle-kit generate).
--
-- 94: an idempotent lease. The runner sends a request id it generated; the run it leased records it,
--     so a retry with the same id from the SAME runner, while that run is still leased, finds it again
--     (the response of the first attempt was lost). Unique per runner: a request id is that runner's
--     own; another runner presenting it matches nothing of the first runner's.
ALTER TABLE "engine_runs" ADD COLUMN "lease_request_id" uuid;
--> statement-breakpoint
CREATE UNIQUE INDEX "engine_runs_runner_lease_request_unique" ON "engine_runs" ("runner_id", "lease_request_id") WHERE "lease_request_id" IS NOT NULL;
--> statement-breakpoint
-- 95: the manifest generation the engine row was last written from. A gateway replica only ever moves
--     the row forward (its manifest's generation >= the row's), compared under the row lock; a replica
--     whose manifest is older writes nothing and treats the engine as unavailable.
ALTER TABLE "engines" ADD COLUMN "manifest_generation" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "engines" ADD CONSTRAINT "engines_manifest_generation_check" CHECK ("manifest_generation" >= 0);
