-- Migration 0067 (ADR-0060) — TAMPER-EVIDENT `audit_log`.
--
-- WHAT THIS CHANGES, IN ONE SENTENCE
--
--   `audit_log` stops being "a table the application only ever inserts into"
--   and becomes "a table whose alteration is DETECTABLE", by giving every row
--   written from here on a position in a hash chain.
--
-- WHY APPEND-ONLY WAS NOT ENOUGH
--
--   The gateway only inserts. That is a property of the CODE, not of the DATA.
--   A DBA, a stolen app credential, or a restore-and-edit against last night's
--   dump can UPDATE, DELETE or reorder rows, and nothing in the system would
--   notice. ADR-0035's nightly pg_dump to a write-only bucket protects against
--   LOSS: it faithfully captures whatever the database currently says, tampered
--   or not. For a product whose value proposition is a trustworthy audit trail,
--   "trust us, the application only inserts" is not a control.
--
-- THE FOUR NEW COLUMNS, AND WHY EACH ONE EXISTS
--
--   seq          A monotonic bigint. NOT `at`: timestamps collide (two rows in
--                the same millisecond are common under load) and are not
--                guaranteed monotonic (clock skew, NTP steps, a DBA setting the
--                clock back). The chain needs a STRICT TOTAL ORDER, and only a
--                counter gives one. Assigned as max(seq)+1 under an advisory
--                lock rather than by `nextval`, so a rolled-back transaction
--                does not burn a number and leave a gap that verification would
--                have to report as a possible deletion. A false "someone
--                deleted a row" alarm is the fastest way to make an integrity
--                control ignored.
--
--   content_hash SHA-256 over a canonical, deterministic serialization of the
--                row's IMMUTABLE FACTS (id, at, user_id, object_type, object_id,
--                detail, server_id, tool_name, effect, rule_id, rule_chain,
--                reason, deploy_mode). This is what changes when the RECORD is
--                edited. The serialization rules are pinned in
--                `packages/shared/src/audit-chain.ts` and are the single most
--                delicate part of this feature: `detail` and `rule_chain` are
--                jsonb, and jsonb does not preserve key order, so the hash must
--                be taken over a recursively key-SORTED form or every honest row
--                reports as tampered on read-back.
--
--   prev_hash    The PRECEDING row's `row_hash` — not its content_hash. This is
--                a deliberate, reasoned departure from a parenthetical in
--                ADR-0060 §1, and the reason is in the ADR's own worked example:
--                the anchor is supposed to catch an adversary who rewrites a row
--                AND recomputes every hash. That only works if the chain head
--                commits to the WHOLE history. If prev_hash named the
--                predecessor's content_hash, row_hash would depend on exactly
--                two rows, a recomputed forgery deep in history would land on an
--                identical head, and the anchor would catch nothing. See the
--                long comment on `auditRowHash()`.
--
--   row_hash     SHA-256(prev_hash || content_hash) — the linked value, exactly
--                as ADR-0060 §1 writes it. Stored rather than derived so that
--                (a) the next append can link to it without recomputing, and
--                (b) editing it directly is itself detectable.
--
-- WHY THE COLUMNS ARE NULLABLE, AND WHAT THE GENESIS ROW IS FOR
--
--   Rows that already exist cannot be chained. Chaining them would mean
--   REWRITING EVERY ONE OF THEM — which is byte-for-byte indistinguishable from
--   the tampering this migration exists to detect, and would destroy the
--   credibility of the whole control on the very first day.
--
--   So they are left exactly as they are, with NULL in all four columns, and the
--   chain starts at a GENESIS ROW that says so IN THE RECORD ITSELF. An auditor
--   reading the raw table sees a row at seq 1 whose `reason` states that
--   everything before it is un-chained legacy protected only by ADR-0035
--   backups. `GET /v1/audit/verify` repeats that disclosure and counts the
--   un-covered rows. There is no pretence that the pre-existing history is
--   covered — the guarantee starts at genesis and is stated as such.
--
-- WHY THE GENESIS HASHES ARE HARDCODED CONSTANTS
--
--   The genesis row is byte-identical on every install of this product: fixed
--   id, fixed timestamp, fixed detail, and — deliberately — NO install-specific
--   value such as "how many legacy rows preceded me" (which would vary per
--   deployment and destroy the property). Its content_hash and row_hash are
--   therefore compile-time constants, computed in
--   `packages/shared/src/audit-chain.ts`, asserted by that package's tests, and
--   copied here. An auditor can recompute them from the source alone, without
--   access to any deployment, and confirm this migration did not seed a chain
--   from a doctored starting point.
--
--   content_hash = 45ff972f867376ea830bddd89ecd99a3aba4b9f919c53781fef29cef7034e785
--   row_hash     = 08a2dbc4c9b3714264a558ea5523bff203ed272838abe00178a34fabfb7556fe
--                = SHA-256(64 zeros || content_hash)
--
-- FK-FREENESS IS PRESERVED. Not one of these columns references anything. The
-- table's founding rule — "no FKs on purpose: audit records must survive
-- user/server deletion" — is untouched, and the hashes are self-contained: a row
-- can be verified from its own bytes plus its predecessor's row_hash, with every
-- user, server and project it mentions long since deleted.
--
-- WHAT THIS MIGRATION DOES **NOT** DO. It does not PREVENT writes. This is
-- detection and evidence, not a write block; DB-level least-privilege / RLS is
-- the complementary preventive control and is deliberately out of scope. It also
-- provides no confidentiality — a hash is not encryption.

ALTER TABLE "audit_log" ADD COLUMN "seq" bigint;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "content_hash" text;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "prev_hash" text;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "row_hash" text;--> statement-breakpoint

-- The chain's total order. UNIQUE so two rows can never claim the same
-- position; Postgres treats NULLs as distinct, so every legacy row keeps its
-- NULL without colliding. This index is also what makes "find the chain tip"
-- a single index lookup rather than a scan of a table that grows a row per
-- governed call.
CREATE UNIQUE INDEX "audit_log_seq_uq" ON "audit_log" USING btree ("seq");--> statement-breakpoint

-- ALL FOUR OR NONE. A row is either fully chained or fully legacy; there is no
-- half-chained state. This catches the honest failure — code that inserts
-- around the chaining path — loudly and immediately, instead of leaving a row
-- that verification would have to report as tampering months later.
--
-- Stated honestly: a constraint is not a defence against the adversary this ADR
-- is about. Anyone with DDL can drop it. It is here to stop US shipping a bug.
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_chain_all_or_none" CHECK (
  ("seq" IS NULL AND "content_hash" IS NULL AND "prev_hash" IS NULL AND "row_hash" IS NULL)
  OR ("seq" IS NOT NULL AND "content_hash" IS NOT NULL AND "prev_hash" IS NOT NULL AND "row_hash" IS NOT NULL)
);--> statement-breakpoint

-- THE GENESIS ROW. Fixed in every field, so its hashes are constants (above).
-- `seq` = 1: the guarantee starts here.
INSERT INTO "audit_log" (
  "id", "at", "user_id", "object_type", "object_id", "detail",
  "server_id", "tool_name", "effect", "rule_id", "rule_chain", "reason",
  "deploy_mode", "seq", "content_hash", "prev_hash", "row_hash"
) VALUES (
  '00000000-0000-0000-0000-000000000060',
  '2026-08-01T00:00:00.000Z',
  '00000000-0000-0000-0000-000000000000',
  'audit_chain',
  NULL,
  '{"adr":"ADR-0060","algorithm":"sha256","boundary":"genesis","guaranteeStartsAtSeq":1,"legacyProtection":"ADR-0035 backups only — not tamper-evident","legacyRowsAreUnchained":true,"payloadVersion":"regulait.audit.v1"}'::jsonb,
  NULL,
  NULL,
  'allow',
  'audit-chain-genesis',
  '["audit-chain-genesis"]'::jsonb,
  'audit-chain genesis: the tamper-evident hash chain starts here. Every audit_log row written before this one is un-chained legacy and is NOT covered by it.',
  NULL,
  1,
  '45ff972f867376ea830bddd89ecd99a3aba4b9f919c53781fef29cef7034e785',
  '0000000000000000000000000000000000000000000000000000000000000000',
  '08a2dbc4c9b3714264a558ea5523bff203ed272838abe00178a34fabfb7556fe'
);--> statement-breakpoint

-- --- ADR-0060 §4: THE ANCHOR RECORD ------------------------------------------
--
-- WHY THIS TABLE EXISTS AT ALL, given that the chain is already self-checking.
--
--   Hash-chaining alone is easy to over-sell. It detects any edit by someone who
--   cannot recompute the whole chain. It does NOT detect the strongest
--   adversary: a DB admin who rewrites every row can ALSO recompute every hash,
--   producing an internally consistent forged chain that local verification
--   blesses. What closes that gap is pinning the chain HEAD somewhere the admin
--   cannot rewrite — an S3 bucket with Object Lock in compliance mode, and/or an
--   independent external transparency log. A full recompute then diverges from
--   the anchored head and is caught.
--
--   This table is the LOCAL LEDGER of those anchors: what was anchored, at which
--   seq, with which row_hash, where it was sent and whether it actually got
--   there. It is deliberately NOT the trust root — a row here is as rewritable
--   as any other row. The trust root is the externalized copy, and `status` /
--   `external_ref` are what tell an auditor whether one exists.
--
-- BUFFER-AND-FLUSH (ADR-0060's deployment-mode section, §8.5).
--
--   An air-gapped install has no outbound connection. The chain is computed
--   locally and needs none, so integrity holds; only ANCHORING degrades. Anchors
--   are written here with status 'pending' and flushed when connectivity
--   resumes — the same buffer-and-sync posture §8.5 already defines for audit
--   events. Until an anchor is externalized the undetectable recent window is
--   larger. That is disclosed in the verify response, not hidden.
--
-- ANCHOR CADENCE IS A TUNING KNOB, NOT A GUARANTEE. Tampering confined to rows
-- written after the last anchor can be made internally consistent and is not
-- caught until those rows are themselves anchored. Anchor frequency BOUNDS the
-- undetectable window; it does not eliminate it.
--
-- FK-free, like `audit_log` itself and for the same reason.
CREATE TABLE "audit_anchors" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,

  -- THE ANCHORED HEAD: the two values that, together, pin the chain.
  "seq" bigint NOT NULL,
  "row_hash" text NOT NULL,
  -- `at` of the row at `seq` — so an auditor can say "the trail was intact as
  -- of this instant" without a second lookup into a table that may have been
  -- tampered with since.
  "head_at" timestamp with time zone NOT NULL,
  "algorithm" text DEFAULT 'sha256' NOT NULL,

  -- WHERE IT WENT, AND WHETHER IT ARRIVED.
  --   local_worm     — a local write-once medium (the air-gapped buffer)
  --   s3_object_lock — an Object-Lock (compliance mode) bucket
  --   external_log   — an independent transparency / notarization log
  --   none           — no sink configured: the anchor exists ONLY in this table
  --                    and is therefore NOT tamper-resistant. Recorded honestly
  --                    rather than silently pretending coverage.
  "destination" text NOT NULL,
  -- pending = buffered, not yet externalized (the air-gapped steady state)
  -- flushed = the sink acknowledged it; `external_ref` names the object
  -- failed  = the sink refused; `last_error` says why. NOT retried silently.
  "status" text DEFAULT 'pending' NOT NULL,
  "external_ref" text,
  "flushed_at" timestamp with time zone,
  "last_error" text,
  "deploy_mode" text,

  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX "audit_anchors_seq_idx" ON "audit_anchors" USING btree ("seq");--> statement-breakpoint
CREATE INDEX "audit_anchors_status_idx" ON "audit_anchors" USING btree ("status","seq");
