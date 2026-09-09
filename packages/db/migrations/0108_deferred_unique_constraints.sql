-- ADR-0109 — THE ELEVEN DEFERRED SITES GET A CONSTRAINT, NOT AN ORDER.
--
-- WHAT THIS IS. ADR-0107 swept 142 production single-row reads that ask the
-- database for one row without asking for an order. It FIXED 19 with a
-- deterministic `ORDER BY` and DEFERRED 11, and it said exactly why:
--
--     Ordering them would encode the wrong claim: it would say "several of
--     these are expected and here is the tiebreak", when the truth is "a
--     second one is a bug the database should have refused".
--
-- An `ORDER BY` ACCOMMODATES a duplicate. A constraint STATES AND ENFORCES that
-- there should not be one. These sites are reverse lookups by the id of a
-- structurally 1:1 partner record, and insert-if-absent idempotency guards that
-- already self-enforce except under a race. They want the constraint. This
-- migration is it.
--
-- ============================================================================
-- THIS MIGRATION ADDS AND REFUSES. IT NEVER REPAIRS, MERGES OR DELETES.
-- ============================================================================
-- A unique constraint is a CLAIM ABOUT DATA THAT ALREADY EXISTS. On a
-- deployment already holding a pair of rows one of these forbids, the
-- `CREATE UNIQUE INDEX` below FAILS and the upgrade STOPS. That is the correct
-- behaviour for this product and it is deliberately not softened:
--
--   * The rows in question are governance records. Two `grant_certification_
--     items` against one approval are two recorded human access-review
--     decisions; two `sod_override_requests` are two answers to "may this
--     person hold both of these". Merging or deleting one so an upgrade can
--     report success destroys evidence to make a script's exit code nicer.
--   * It is the same argument ADR-0104 made when it refused to backfill a
--     consent digest, and ADR-0105 when it refused to invent an expiry for a
--     legacy approval: AN INVENTED VALUE IS A MANUFACTURED RECORD. Choosing
--     which of two conflicting rows is the real one is a product question with
--     a human in it, not a mechanical one a migration may answer.
--
-- So there is no `DELETE`, no `ON CONFLICT` and no `DISTINCT ON` rewrite. The
-- `IF NOT EXISTS` on each statement below guards the index NAME, never the
-- CLAIM: it makes a re-run of an already-applied migration a no-op, and it does
-- nothing whatsoever to a duplicate — a name that does not yet exist is still
-- created against the live data, and still fails with SQLSTATE 23505 if the
-- data contradicts it.
--
-- WHAT AN OPERATOR DOES INSTEAD. Run the pre-flight BEFORE upgrading:
--
--     node scripts/preflight-unique-constraints.mjs "$DATABASE_URL"
--
-- (`runDeferredUniquePreflight` in packages/db/src/deferred-unique-preflight.ts
-- — a plain exported function; the script is a thin wrapper.) It reports, per
-- constraint, how many duplicate groups exist, how many rows they cover and
-- example keys. Resolve each pair by hand — decide which row is the real one
-- and remove or re-key the other, through the product's own surfaces where one
-- exists — then upgrade. A clean pre-flight means this migration applies.
--
-- ============================================================================
-- PARTIAL WHERE PARTIAL IS TRUE.
-- ============================================================================
-- ADR-0107 found 16 partial unique indexes already in this schema and recorded
-- that MISREADING ONE CAUSED A REAL BUG (`guardrail_configs_org_uq ON (scope)
-- WHERE scope_id IS NULL` does not cover a bare `eq(scope,'org')`). Every index
-- below is written to cover EXACTLY the predicate its read site uses, no more:
--
--   * `approval_id` and `workflow_instance_id` are NULLABLE, and NULL is the
--     normal case — a training job under the cost threshold never had an
--     approval; a use case may be registered before any workflow instance
--     exists. Postgres already treats NULLs as distinct in a unique index, so
--     `WHERE ... IS NOT NULL` does not change WHICH rows conflict. It is
--     written anyway because it states the claim ("a row that HAS an approval
--     has its own") instead of leaving the reader to recall a NULL-handling
--     rule, and it keeps the index off the majority of rows that can never
--     participate in it.
--   * `trace_spans` is constrained only `WHERE kind = 'run'`. Spans of every
--     other kind share a run id by design — that is what a run's span tree IS.
--
-- ============================================================================
-- TWO OF ADR-0107's ELEVEN GET NO CONSTRAINT HERE, AND BOTH REASONS ARE
-- MEASURED RATHER THAN ASSUMED.
-- ============================================================================
--
-- `data_key_state` — ALREADY ENFORCED; ADR-0107's entry is simply wrong.
--   It records the table as "a singleton by convention only". Migration 0075
--   created it with `id text PRIMARY KEY DEFAULT 'singleton'` AND
--   `CONSTRAINT data_key_state_singleton CHECK (id = 'singleton')`. A primary
--   key over a column a CHECK pins to one value admits AT MOST ONE ROW, and
--   `pg_constraint` on a migrated database confirms both are present. That is
--   the identical shape `org_settings` and `interception_settings` use, which
--   is the shape ADR-0109 was asked to follow — it is already followed. There
--   is nothing to add, and adding a second one-row index would be noise
--   claiming a fix for a hole that does not exist.
--
-- `backup_runs` — REFUSED, because the constraint would break a governed
--   DENY. The proposed claim is one `missed` row per finding, and infra.ts's
--   own comment states it ("backup by (finding, missed)"). The lifecycle
--   contradicts it:
--     1. a scan raises finding F and inserts a (F, kind='backup',
--        status='missed') row — guarded by a read filtered to status='missed';
--     2. an operator proposes a restore; THE SAME ROW is UPDATEd to
--        status='restore_proposed' (infra.ts, "restore_proposed");
--     3. a re-scan of F now finds no status='missed' row and inserts a SECOND
--        one — legal, because the first is no longer 'missed';
--     4. the operator DENIES the restore, and the deny path UPDATEs row 1 back
--        to status='missed'.
--   With the constraint in place step 4 raises 23505 and the denial
--   transaction rolls back: the operator cannot refuse a restore. A constraint
--   that blocks a governance decision is worse than the duplicate it prevents.
--   The real fix is in the writing code — widen the step-1 idempotency read to
--   `status IN ('missed','restore_proposed')` so step 3 cannot happen — and
--   that is a behaviour change (does a re-scan re-open a miss while a restore
--   is pending?), which is its own decision. The pre-flight ships the
--   `backup_runs` check as ADVISORY so the number stays visible.
--
-- ============================================================================
-- `users (lower(email))` — THE ONE THAT CHANGES BEHAVIOUR. READ THIS.
-- ============================================================================
-- `users_email_unique` is UNIQUE on `email` EXACTLY. Every identity path in
-- this codebase looks the address up CASE-FOLDED (`lower(email) = lower($1)`),
-- so 'Ada@x' and 'ada@x' are two legal rows that BOTH match one login. ADR-0107
-- could only make the answer stable — `asc(createdAt), asc(id)`, "first
-- registration owns the address" — and called that A STOPGAP, NOT THE FIX,
-- because the right answer is that the second row should never have existed.
-- This index is the fix.
--
-- WHICH PATHS CAN CREATE A CASE-VARIANT (each one read, not assumed):
--   * SCIM create (scim.ts)         — pre-checked with the case-folding
--                                     `loadUserByEmail`; answers 409. SAFE.
--   * SCIM replace/patch of email   — same case-folding clash check. SAFE.
--   * OIDC JIT (auth.ts)            — the claim is lower-cased before the
--                                     lookup and before the insert. SAFE.
--   * SAML JIT (saml.ts)            — the asserted address is lower-cased on
--                                     extraction. SAFE.
--   * bulk user import (onboarding) — the row schema is
--                                     `.trim().toLowerCase().email()`, so a
--                                     variant is planned as an UPDATE of the
--                                     existing user, never a create. SAFE.
--   * POST /v1/users (app.ts)       — `createUserSchema.email` is a bare
--                                     `z.string().email()`. NO case-folding
--                                     guard. THIS IS THE ONE.
--
-- CONSEQUENCE, STATED RATHER THAN DISCOVERED: after this migration, an admin
-- POSTing /v1/users with a case-variant of an existing address gets 409
-- conflict instead of a second account. The 409 is not new plumbing — app.ts's
-- error handler already maps SQLSTATE 23505 to `{"error":"conflict"}`, which
-- is exactly what an exact-duplicate email has always returned. So the change
-- is that the two cases now agree, and a silent duplicate becomes a hard,
-- honest failure at the one path that could produce it. That is the intent.
--
-- `users_email_unique` is KEPT. It is strictly implied by this index, but it is
-- the target of `onConflictDoNothing({ target: users.email })` in the bulk
-- importer and named in ADR-0030's username/email reasoning; dropping an index
-- other code names is a separate change with nothing to gain.
--
-- ============================================================================
-- `trace_spans` — RECONCILED WITH ADR-0107's OWN FIX #10.
-- ============================================================================
-- `trace_spans` appears in BOTH of ADR-0107's tables, which looks like a
-- contradiction and is not: the two sites have DIFFERENT predicates.
--   * FIX #10, `closeRunSpan` (orchestration.ts) reads
--     `(trace_id = t, kind = 'run')` — NO run id. A trace can legitimately
--     carry more than one run span (a sub-run opened under the same trace), so
--     that read is genuinely multi-row and its `asc(seq), asc(id)` — "the
--     lowest seq in a trace is the span that opened it" — is correct and
--     stands.
--   * THE DEFERRED SITE, `ensureRunSpan` (orchestration.ts) reads
--     `(trace_id = t, kind = 'run', run_id = r)` — an insert-if-absent
--     idempotency guard naming ONE run. THAT is 1:1, and this index says so.
-- The index therefore constrains a strictly narrower thing than fix #10 reads.
-- Nothing is contradicted; fix #10 is left exactly as it is.
--
-- NO DATA IS WRITTEN, NO COLUMN IS ADDED, NOTHING IS DROPPED. Nine indexes.

-- ---------------------------------------------------------------------------
-- 1-4. `approval_id` — ONE queue row, ONE thing it decides.
--
-- All four ride the ONE Approvals Queue (ADR-0045 §3): the queue row is the
-- consent, and the domain row is the thing being consented to. The read at each
-- decide path is `WHERE approval_id = <the row being decided>` and it then acts
-- on the result — revokes a grant, flips a model card to approved, cancels a
-- training job, mints an SoD-conflicting grant. A second match would mean one
-- human decision executing against a record they were not shown.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS "grant_cert_items_approval_uq"
  ON "grant_certification_items" ("approval_id")
  WHERE "approval_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "model_card_approvals_approval_uq"
  ON "model_card_approvals" ("approval_id")
  WHERE "approval_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "training_jobs_approval_uq"
  ON "training_jobs" ("approval_id")
  WHERE "approval_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "sod_override_approval_uq"
  ON "sod_override_requests" ("approval_id")
  WHERE "approval_id" IS NOT NULL;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 5-6. `workflow_instance_id` — ONE pillar-2 instance, ONE registry object.
--
-- `syncUseCaseForInstance` / `syncVendorForInstance` are called from the
-- workflow engine with an instance id and MIRROR that instance's status onto
-- the registry object. Two objects on one instance would mean a single
-- sign-off silently approving one of two things. NULL is normal and stays
-- unconstrained: an object may exist before any instance governs it.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS "ai_use_cases_instance_uq"
  ON "ai_use_cases" ("workflow_instance_id")
  WHERE "workflow_instance_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ai_vendors_instance_uq"
  ON "ai_vendors" ("workflow_instance_id")
  WHERE "workflow_instance_id" IS NOT NULL;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 7. `cert_inventory (resource_id, common_name)` — TOTAL, not partial.
--
-- Both columns are NOT NULL, so there is no subset to exclude. This is the
-- natural key `syncFindingLedger` already upserts on by hand ("cert by
-- (resource,commonName)") — a re-scan finds the existing row and refreshes its
-- observed expiry rather than adding a second one. `patch_records` got the
-- matching index (`patch_records_resource_cve_uq`) when it was written; this
-- one was left to convention.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS "cert_inventory_resource_cn_uq"
  ON "cert_inventory" ("resource_id", "common_name");
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 8. `trace_spans (trace_id, run_id) WHERE kind = 'run'` — see the
-- reconciliation above. `run_id` is nullable and is excluded explicitly: a
-- run-kind span with no run id carries no identity to be unique on.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS "trace_spans_run_uq"
  ON "trace_spans" ("trace_id", "run_id")
  WHERE "kind" = 'run' AND "run_id" IS NOT NULL;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 9. `users (lower(email))` — the FUNCTIONAL index. Consequences above.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS "users_email_lower_uq"
  ON "users" (lower("email"));
