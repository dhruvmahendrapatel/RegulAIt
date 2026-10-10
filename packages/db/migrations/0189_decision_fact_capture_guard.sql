-- ADR-0189 (batch 6 item 2) slice B2 — decision fact capture: the commit-time guard.
--
-- Hand-written (never drizzle-kit generate); journal `when` 1785124000000. 0186,
-- 0187 and 0188 are held by pending PRs.
--
-- B2 writes every receipt-eligible decision's capture-status marker (and, with
-- capture on, its `decision_facts` row) in the decision's own transaction,
-- through ONE shared writer: the audit chain writer every `insert(auditLog)`
-- passes through (`packages/db/src/audit-chain.ts` -> `decision-facts.ts`;
-- round-10 entry condition 4237346656). This migration makes that writer
-- unbypassable at the database: a receipt-eligible audit row (a receipt object
-- type with `detail.receiptClass = 'decision'`, the predicate the receipt sweep
-- uses) cannot COMMIT without a marker for the same audit id, seq and time. A
-- raw `psql` insert, a pool that does not go through `createDb`, or a future
-- writer that skips the chain fails at commit instead of leaving a decision
-- whose facts the receipt would have to infer later (4237322635).
--
-- NO GRANDFATHERING, NO BACK-FILL (ADR-0180): the trigger fires on new rows
-- only. Decisions written before B2 have no marker and their Decision BOM says
-- `pre_facts`; nothing is derived for them from current state.
--
-- The guard is DEFERRABLE INITIALLY DEFERRED because the writer inserts the
-- audit row first (its seq is decided under the chain lock) and the marker
-- after it, in the same transaction. It names `public.` tables and pins its
-- search path, so a TEMP table cannot shadow the marker it reads.

CREATE OR REPLACE FUNCTION "regulait_audit_decision_capture_required"() RETURNS trigger AS $$
BEGIN
  IF NEW."object_type" IN ('mcp_tool', 'agent', 'connector', 'approval')
     AND NEW."detail" ->> 'receiptClass' = 'decision' THEN
    IF NOT EXISTS (SELECT 1 FROM public."audit_log" a WHERE a."id" = NEW."id") THEN
      RETURN NULL; -- the row did not survive to commit (deleted in the same transaction)
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public."decision_capture_status" m
       WHERE m."audit_id" = NEW."id"
         AND m."audit_seq" IS NOT DISTINCT FROM NEW."seq"
         AND m."audit_at" = NEW."at"
    ) THEN
      RAISE EXCEPTION 'audit_log: decision % (seq %) was written without its capture-status marker', NEW."id", NEW."seq"
        USING ERRCODE = 'integrity_constraint_violation',
              HINT = 'every receipt-eligible decision is written through the shared audit writer (createDb), which records its facts in the same transaction (ADR-0189 B2)';
    END IF;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "audit_log_decision_capture_required"
  AFTER INSERT ON "audit_log"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "regulait_audit_decision_capture_required"();
