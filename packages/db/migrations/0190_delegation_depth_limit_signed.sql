-- ADR-0188 S4+S5 follow-up (review of PR #339, item 3): mark the roots whose `depth_limit` came from the person's
-- SIGNED `max_depth`. Hand-authored (never drizzle-kit generate). Re-runnable: every statement is idempotent.
--
-- Before the S4+S5 change a root exchange stored the org's `delegation_max_depth` as the root's `depth_limit`, not the
-- signed `max_depth`, and nothing in the stored row tells the two apart. The token endpoint therefore admits an
-- external child only under a root carrying `depth_limit_signed = true`, which only its own root exchange writes.
-- Existing rows: nothing is grandfathered (ADR-0180). Every row present now gets false, so a chain whose root was
-- minted earlier is refused further children (`delegation_depth_unenforced`); its existing grants are untouched.
-- The column is a root-only marker (the CHECK), and the guard trigger already makes every column but the
-- revocation and spend columns immutable, so it can never be set after the insert.
-- Adding a column with a constant default fires no trigger and rewrites no row.
ALTER TABLE "delegation_grants" ADD COLUMN IF NOT EXISTS "depth_limit_signed" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "delegation_grants" DROP CONSTRAINT IF EXISTS "delegation_grants_depth_limit_signed_check";
--> statement-breakpoint
ALTER TABLE "delegation_grants" ADD CONSTRAINT "delegation_grants_depth_limit_signed_check" CHECK (NOT "depth_limit_signed" OR "depth" = 0);
