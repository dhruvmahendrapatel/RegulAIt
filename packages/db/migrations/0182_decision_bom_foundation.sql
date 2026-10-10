-- ADR-0189 (batch 6 item 2) slice B1 — the Decision BOM and AI BOM FOUNDATION.
--
-- Hand-written (never drizzle-kit generate); journal `when` 1785117000000, past
-- 0181's 1785116000000. 0183 (ADR-0190 I1) and 0184 (ADR-0188 S4) are reserved.
--
-- What this migration creates (ADR-0189 §8 and amendments R1-R50, plus the
-- review-round entry conditions and issue #280's B1 items):
--
--  1. `audit_anchors` (R33, R4, R44, #280 4237493038):
--     - `tsa_request_sent_at`, the database-clock send time recorded with the
--       nonce before the request leaves;
--     - the LEGACY-SAFE granted check. A token granted before this column existed
--       has no send time. Such rows are marked `tsa_request_facts_legacy` here,
--       once, and the verifier reports their RFC 3161 check `unverifiable`,
--       `request_facts_not_recorded`. A guard trigger refuses the marker on any
--       new row, refuses changing it, and freezes a legacy row's token fields, so
--       the marker can never be used to skip the request facts of a NEW grant;
--     - the flush-time tamper-resistance observation (`tamper_resistant`, mode,
--       time) and the Object Lock `retain_until`, written by the flush. Existing
--       anchors read `false` / null: never observed, never assumed.
--  2. Eight strict org settings (§7; OWNER DECISION 12), written onto the
--     existing row as on a first load (ADR-0180, no grandfathering).
--  3. `receipt_payload_versions` (R34, R42, R43): the append-only,
--     verifier-trusted receipt v2 boundary (`from_audit_seq`). Not set here. A
--     guard trigger makes `decision_receipts` hold exactly v1 below the boundary
--     and exactly v2 (bound to the decision's capture marker) from it on.
--  4. `decision_capture_status` (round-8 entry condition 4237322635): the
--     receipt-bound capture-status marker every receipt-eligible decision writes
--     in its own transaction (`captured` with the facts hash, or `capture_off`).
--     It is the PER-DECISION LOCK TARGET (4237344247; `lockDecisionForBom`), and
--     it carries the decision's audit time and the ONE `expires_at` that every
--     decision-scoped row shares (4237322627).
--  5. `decision_facts` (§4, R5, R18, R37) with a facts-hash CHECK computed in SQL
--     and a RESTRICT link to the AI BOM snapshot it references (#280 4237493040:
--     a snapshot referenced only from retained facts counts as linked).
--  6. `decision_fact_addenda` (R15, R35) — hash-chained, sequenced, unsigned —
--     and `decision_fact_addendum_signatures` (R15), signed in `n` order.
--  7. `decision_boms` (§8, R40) and `ai_bom_snapshots` (§8, R20, amendment 5):
--     versions allocated contiguously with `supersedes` checked in the database,
--     the v8 serial number derived in SQL, the body hash computed in SQL.
--  8. `bom_renderings` (R36): two real parent keys, exactly one set, ON DELETE
--     CASCADE, deleted only as that cascade.
--  9. Retention through the immutability rules (R16, R38, OWNER DECISION 11):
--     `bom_retention_prunes` (the audited record of a pass), `bom_retention_holds`
--     (evidence holds), and ONE guard function on every BOM table that refuses
--     every UPDATE and admits a DELETE only inside a transaction that wrote a
--     prune row, for a row whose `expires_at` has passed that pass's `as_of`
--     (never when it is null: unbounded retention keeps everything), whose audit
--     row is gone (decision-scoped rows), and that no hold covers.
-- 10. `bom_auditor_grants`: the explicit auditor export grant (§7
--     `bom_export_roles`), revocable, never edited otherwise.
--
-- R16: NO foreign key to `audit_log` anywhere here. Every append-only table uses
-- `regulait_refuse_mutation` (migration 0168) or a guard built on the same
-- refusal, raised with the same ERRCODE.
--
-- SECURE BY DEFAULT, NO GRANDFATHERING (ADR-0180): nothing is back-filled from
-- current state. The only write to existing rows is the legacy marker on anchors
-- that were ALREADY granted (#280 asks for exactly that discriminator), and the
-- strict settings on the org row.

-- ===== 1. audit_anchors ======================================================
ALTER TABLE "audit_anchors" ADD COLUMN "tsa_request_sent_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "audit_anchors" ADD COLUMN "tsa_request_facts_legacy" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
-- every anchor granted before this migration has no recorded send time; it is
-- marked, once, as legacy (the verifier says `request_facts_not_recorded`)
UPDATE "audit_anchors" SET "tsa_request_facts_legacy" = true WHERE "tsa_status" = 'granted';
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "regulait_audit_anchor_request_facts_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW."tsa_request_facts_legacy" THEN
    RAISE EXCEPTION 'audit_anchors: a new anchor cannot be marked as a legacy timestamp'
      USING ERRCODE = 'insufficient_privilege',
            HINT = 'only anchors granted before migration 0182 are legacy (ADR-0189 R33, #280)';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW."tsa_request_facts_legacy" IS DISTINCT FROM OLD."tsa_request_facts_legacy" THEN
      RAISE EXCEPTION 'audit_anchors: the legacy timestamp marker never changes'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF OLD."tsa_request_facts_legacy" AND (
         NEW."tsa_status" IS DISTINCT FROM OLD."tsa_status"
      OR NEW."tsa_token" IS DISTINCT FROM OLD."tsa_token"
      OR NEW."tsa_gen_time" IS DISTINCT FROM OLD."tsa_gen_time"
      OR NEW."tsa_message_imprint" IS DISTINCT FROM OLD."tsa_message_imprint"
      OR NEW."tsa_nonce" IS DISTINCT FROM OLD."tsa_nonce"
      OR NEW."tsa_request_sent_at" IS DISTINCT FROM OLD."tsa_request_sent_at"
      OR NEW."tsa_url" IS DISTINCT FROM OLD."tsa_url") THEN
      RAISE EXCEPTION 'audit_anchors: a legacy granted timestamp is never rewritten'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "audit_anchors_request_facts_guard"
  BEFORE INSERT OR UPDATE ON "audit_anchors"
  FOR EACH ROW EXECUTE FUNCTION "regulait_audit_anchor_request_facts_guard"();
--> statement-breakpoint
ALTER TABLE "audit_anchors" DROP CONSTRAINT "audit_anchors_tsa_granted_check";
--> statement-breakpoint
-- a granted timestamp carries its token, time, imprint and TSA, and (unless it is
-- a legacy grant) the request facts the offline verifier needs: nonce and send time
ALTER TABLE "audit_anchors" ADD CONSTRAINT "audit_anchors_tsa_granted_check" CHECK (
  "tsa_status" <> 'granted'
  OR ("tsa_token" IS NOT NULL AND "tsa_gen_time" IS NOT NULL AND "tsa_message_imprint" IS NOT NULL AND "tsa_url" IS NOT NULL
      AND ("tsa_request_facts_legacy" OR ("tsa_nonce" IS NOT NULL AND "tsa_request_sent_at" IS NOT NULL)))
);
--> statement-breakpoint
ALTER TABLE "audit_anchors" ADD CONSTRAINT "audit_anchors_tsa_legacy_check" CHECK (NOT "tsa_request_facts_legacy" OR "tsa_status" = 'granted');
--> statement-breakpoint
ALTER TABLE "audit_anchors" ADD COLUMN "tamper_resistant" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "audit_anchors" ADD COLUMN "tamper_observation_mode" text;
--> statement-breakpoint
ALTER TABLE "audit_anchors" ADD COLUMN "tamper_observed_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "audit_anchors" ADD COLUMN "retain_until" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "audit_anchors" ADD CONSTRAINT "audit_anchors_tamper_observation_mode_check" CHECK (
  "tamper_observation_mode" IS NULL
  OR "tamper_observation_mode" IN ('compliance', 'governance', 'no_default_retention', 'object_lock_absent', 'unobserved', 'sink_constant')
);
--> statement-breakpoint
-- an observation is a mode AND a time, or neither
ALTER TABLE "audit_anchors" ADD CONSTRAINT "audit_anchors_tamper_observed_check" CHECK (("tamper_observation_mode" IS NULL) = ("tamper_observed_at" IS NULL));
--> statement-breakpoint
-- `true` only for a flushed anchor whose medium was OBSERVED in compliance mode
ALTER TABLE "audit_anchors" ADD CONSTRAINT "audit_anchors_tamper_resistant_check" CHECK (
  NOT "tamper_resistant" OR ("status" = 'flushed' AND "tamper_observation_mode" = 'compliance' AND "tamper_observed_at" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "audit_anchors" ADD CONSTRAINT "audit_anchors_retain_until_check" CHECK ("retain_until" IS NULL OR "status" = 'flushed');
--> statement-breakpoint

-- ===== 2. org settings, all strict (§7) =====================================
ALTER TABLE "org_settings" ADD COLUMN "decision_facts_capture" text DEFAULT 'on' NOT NULL;
--> statement-breakpoint
ALTER TABLE "org_settings" ADD COLUMN "decision_bom_finality" text DEFAULT 'anchored' NOT NULL;
--> statement-breakpoint
ALTER TABLE "org_settings" ADD COLUMN "bom_export_roles" text DEFAULT 'admins_only' NOT NULL;
--> statement-breakpoint
ALTER TABLE "org_settings" ADD COLUMN "bom_person_identifiers" text DEFAULT 'id_only' NOT NULL;
--> statement-breakpoint
ALTER TABLE "org_settings" ADD COLUMN "ai_bom_snapshot_triggers" text DEFAULT 'sign_off_events' NOT NULL;
--> statement-breakpoint
ALTER TABLE "org_settings" ADD COLUMN "ai_bom_snapshot_without_key" text DEFAULT 'refuse' NOT NULL;
--> statement-breakpoint
ALTER TABLE "org_settings" ADD COLUMN "cyclonedx_export_versions" jsonb DEFAULT '["1.7"]'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "org_settings" ADD COLUMN "bom_export_rate_limit_per_minute" integer DEFAULT 30 NOT NULL;
--> statement-breakpoint
ALTER TABLE "org_settings" ADD CONSTRAINT "org_settings_decision_facts_capture_check" CHECK ("decision_facts_capture" IN ('on', 'off'));
--> statement-breakpoint
ALTER TABLE "org_settings" ADD CONSTRAINT "org_settings_decision_bom_finality_check" CHECK ("decision_bom_finality" IN ('anchored', 'anchored_unverified_destination', 'chain_signed'));
--> statement-breakpoint
ALTER TABLE "org_settings" ADD CONSTRAINT "org_settings_bom_export_roles_check" CHECK ("bom_export_roles" IN ('admins_only', 'admins_and_auditors'));
--> statement-breakpoint
ALTER TABLE "org_settings" ADD CONSTRAINT "org_settings_bom_person_identifiers_check" CHECK ("bom_person_identifiers" IN ('id_only', 'display_name'));
--> statement-breakpoint
ALTER TABLE "org_settings" ADD CONSTRAINT "org_settings_ai_bom_snapshot_triggers_check" CHECK ("ai_bom_snapshot_triggers" IN ('sign_off_events', 'on_demand_only'));
--> statement-breakpoint
ALTER TABLE "org_settings" ADD CONSTRAINT "org_settings_ai_bom_snapshot_without_key_check" CHECK ("ai_bom_snapshot_without_key" IN ('refuse', 'skip_and_record'));
--> statement-breakpoint
ALTER TABLE "org_settings" ADD CONSTRAINT "org_settings_cyclonedx_export_versions_check" CHECK (
  jsonb_typeof("cyclonedx_export_versions") = 'array'
  AND "cyclonedx_export_versions" <@ '["1.7", "1.6"]'::jsonb
  AND "cyclonedx_export_versions" @> '["1.7"]'::jsonb
);
--> statement-breakpoint
ALTER TABLE "org_settings" ADD CONSTRAINT "org_settings_bom_export_rate_limit_per_minute_check" CHECK ("bom_export_rate_limit_per_minute" BETWEEN 1 AND 600);
--> statement-breakpoint

-- ===== shared: the retention guard of every BOM table (R16, R38, #280) ======
CREATE TABLE "bom_retention_prunes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  -- the transaction that wrote this row; the guard admits deletes only inside it
  "txid" bigint DEFAULT txid_current() NOT NULL,
  -- rows whose `expires_at` is at or before this moment may go
  "as_of" timestamp with time zone NOT NULL,
  "counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "actor_user_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "bom_retention_prunes_as_of_check" CHECK ("as_of" <= "created_at"),
  CONSTRAINT "bom_retention_prunes_counts_check" CHECK (jsonb_typeof("counts") = 'object')
);
--> statement-breakpoint
CREATE INDEX "bom_retention_prunes_txid_idx" ON "bom_retention_prunes" ("txid");
--> statement-breakpoint
CREATE TRIGGER "bom_retention_prunes_append_only"
  BEFORE UPDATE OR DELETE ON "bom_retention_prunes"
  FOR EACH ROW EXECUTE FUNCTION "regulait_refuse_mutation"();
--> statement-breakpoint
CREATE TABLE "bom_retention_holds" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "scope" text NOT NULL,
  "audit_id" uuid,
  "subject_kind" text,
  "subject_id" uuid,
  "hold_kind" text NOT NULL,
  "created_by" uuid NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "released_at" timestamp with time zone,
  "released_by" uuid,
  CONSTRAINT "bom_retention_holds_scope_check" CHECK ("scope" IN ('decision', 'ai_bom_subject', 'all')),
  CONSTRAINT "bom_retention_holds_kind_check" CHECK ("hold_kind" IN ('legal', 'incident', 'regulator_request', 'audit')),
  CONSTRAINT "bom_retention_holds_shape_check" CHECK (
    ("scope" = 'decision' AND "audit_id" IS NOT NULL AND "subject_kind" IS NULL AND "subject_id" IS NULL)
    OR ("scope" = 'ai_bom_subject' AND "audit_id" IS NULL AND "subject_kind" IN ('use_case', 'agent', 'builder_agent', 'install') AND "subject_id" IS NOT NULL)
    OR ("scope" = 'all' AND "audit_id" IS NULL AND "subject_kind" IS NULL AND "subject_id" IS NULL)
  ),
  CONSTRAINT "bom_retention_holds_release_check" CHECK (("released_at" IS NULL) = ("released_by" IS NULL))
);
--> statement-breakpoint
CREATE INDEX "bom_retention_holds_active_idx" ON "bom_retention_holds" ("audit_id", "subject_kind", "subject_id") WHERE "released_at" IS NULL;
--> statement-breakpoint
-- a hold is never deleted; the only change is its release, once
CREATE OR REPLACE FUNCTION "regulait_bom_retention_hold_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD."released_at" IS NULL AND NEW."released_at" IS NOT NULL
     AND (to_jsonb(NEW) - 'released_at' - 'released_by') = (to_jsonb(OLD) - 'released_at' - 'released_by') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'bom_retention_holds: % refused (a hold is only ever released, once)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "bom_retention_holds_guard"
  BEFORE UPDATE OR DELETE ON "bom_retention_holds"
  FOR EACH ROW EXECUTE FUNCTION "regulait_bom_retention_hold_guard"();
--> statement-breakpoint
-- THE ONE PRUNE GUARD. TG_ARGV[0] = 'decision' (the row has `audit_id`) or
-- 'ai_bom' (the row has `subject_kind`/`subject_id`). UPDATE: always refused.
-- DELETE: admitted only when every test below holds, checked here, in the database.
CREATE OR REPLACE FUNCTION "regulait_bom_prune_guard"() RETURNS trigger AS $$
DECLARE
  o jsonb := to_jsonb(OLD);
  pass_as_of timestamp with time zone;
  expires timestamp with time zone := (o ->> 'expires_at')::timestamp with time zone;
  held boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    SELECT max(p."as_of") INTO pass_as_of FROM "bom_retention_prunes" p WHERE p."txid" = txid_current();
    IF pass_as_of IS NULL THEN
      RAISE EXCEPTION '% is append-only: DELETE refused outside a recorded retention prune', TG_TABLE_NAME
        USING ERRCODE = 'insufficient_privilege',
              HINT = 'BOM evidence is deleted only by the retention prune (ADR-0189 R16)';
    END IF;
    -- unbounded retention (null) keeps everything; otherwise the row must have expired
    IF expires IS NULL OR expires > pass_as_of THEN
      RAISE EXCEPTION '% is append-only: DELETE refused, the row is within its retention', TG_TABLE_NAME
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF TG_ARGV[0] = 'decision' THEN
      -- the 0168 "parent gone" test with audit_log as the parent: the audit row is pruned first
      IF EXISTS (SELECT 1 FROM "audit_log" a WHERE a."id" = (o ->> 'audit_id')::uuid) THEN
        RAISE EXCEPTION '% is append-only: DELETE refused, the decision''s audit row still exists', TG_TABLE_NAME
          USING ERRCODE = 'insufficient_privilege';
      END IF;
      SELECT EXISTS (
        SELECT 1 FROM "bom_retention_holds" h
         WHERE h."released_at" IS NULL AND (h."scope" = 'all' OR (h."scope" = 'decision' AND h."audit_id" = (o ->> 'audit_id')::uuid))
      ) INTO held;
    ELSE
      SELECT EXISTS (
        SELECT 1 FROM "bom_retention_holds" h
         WHERE h."released_at" IS NULL AND (h."scope" = 'all' OR (h."scope" = 'ai_bom_subject'
               AND h."subject_kind" = o ->> 'subject_kind' AND h."subject_id" = (o ->> 'subject_id')::uuid))
      ) INTO held;
    END IF;
    IF held THEN
      RAISE EXCEPTION '% is append-only: DELETE refused, an evidence hold covers the row', TG_TABLE_NAME
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '% is append-only: % refused', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege',
          HINT = 'records here are evidence; write a new version instead (ADR-0189)';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

-- ===== 3. the receipt v2 boundary (R34, R42, R43) ==========================
CREATE TABLE "receipt_payload_versions" (
  "version" smallint PRIMARY KEY NOT NULL,
  "from_audit_seq" bigint NOT NULL,
  "set_at" timestamp with time zone DEFAULT now() NOT NULL,
  "set_by" uuid,
  CONSTRAINT "receipt_payload_versions_from_audit_seq_uq" UNIQUE ("from_audit_seq"),
  CONSTRAINT "receipt_payload_versions_version_check" CHECK ("version" = 2),
  CONSTRAINT "receipt_payload_versions_from_audit_seq_check" CHECK ("from_audit_seq" >= 1)
);
--> statement-breakpoint
CREATE TRIGGER "receipt_payload_versions_append_only"
  BEFORE UPDATE OR DELETE ON "receipt_payload_versions"
  FOR EACH ROW EXECUTE FUNCTION "regulait_refuse_mutation"();
--> statement-breakpoint

-- ===== 4. the capture-status marker (4237322635, 4237344247, 4237322627) ===
CREATE TABLE "decision_capture_status" (
  "audit_id" uuid PRIMARY KEY NOT NULL,
  "audit_seq" bigint NOT NULL,
  "audit_at" timestamp with time zone NOT NULL,
  "status" text NOT NULL,
  "facts_hash" text,
  "expires_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "decision_capture_status_audit_seq_uq" UNIQUE ("audit_seq"),
  CONSTRAINT "decision_capture_status_audit_seq_check" CHECK ("audit_seq" >= 1),
  CONSTRAINT "decision_capture_status_status_check" CHECK ("status" IN ('captured', 'capture_off')),
  CONSTRAINT "decision_capture_status_facts_hash_check" CHECK (
    ("status" = 'captured' AND "facts_hash" ~ '^[0-9a-f]{64}$') OR ("status" = 'capture_off' AND "facts_hash" IS NULL)
  ),
  CONSTRAINT "decision_capture_status_expires_check" CHECK ("expires_at" IS NULL OR "expires_at" > "audit_at")
);
--> statement-breakpoint
CREATE TRIGGER "decision_capture_status_append_only"
  BEFORE UPDATE OR DELETE ON "decision_capture_status"
  FOR EACH ROW EXECUTE FUNCTION "regulait_bom_prune_guard"('decision');
--> statement-breakpoint

-- ===== 7a. AI BOM snapshots (before facts, which reference them) ============
-- amendment 5: the CycloneDX serialNumber, an RFC 9562 v8 UUID from SHA-256 of
-- `regulait:ai-bom:<snapshot id>` (the shared `aiBomSerialNumber` computes the same)
CREATE OR REPLACE FUNCTION "regulait_ai_bom_serial"("snapshot_id" uuid) RETURNS uuid
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT encode(
           set_byte(set_byte(substring(h FROM 1 FOR 16), 6, (get_byte(h, 6) & 15) | 128), 8, (get_byte(h, 8) & 63) | 128),
           'hex')::uuid
    FROM (SELECT sha256(convert_to('regulait:ai-bom:' || "snapshot_id"::text, 'UTF8')) AS h) AS d
$$;
--> statement-breakpoint
CREATE TABLE "ai_bom_snapshots" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "subject_kind" text NOT NULL,
  "subject_id" uuid NOT NULL,
  "version" integer NOT NULL,
  "serial_number" uuid NOT NULL,
  "supersedes_id" uuid REFERENCES "ai_bom_snapshots"("id"),
  "trigger" text NOT NULL,
  "basis" jsonb NOT NULL,
  "body" text NOT NULL,
  "body_sha256" text NOT NULL,
  "signature" text NOT NULL,
  "key_id" text NOT NULL REFERENCES "receipt_signing_keys"("key_id"),
  "expires_at" timestamp with time zone,
  "created_by" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "ai_bom_snapshots_subject_version_uq" UNIQUE ("subject_kind", "subject_id", "version"),
  CONSTRAINT "ai_bom_snapshots_serial_number_uq" UNIQUE ("serial_number"),
  CONSTRAINT "ai_bom_snapshots_subject_kind_check" CHECK ("subject_kind" IN ('use_case', 'agent', 'builder_agent', 'install')),
  -- R20: one database holds one install; its internal key is the nil uuid
  CONSTRAINT "ai_bom_snapshots_install_subject_check" CHECK ("subject_kind" <> 'install' OR "subject_id" = '00000000-0000-0000-0000-000000000000'),
  CONSTRAINT "ai_bom_snapshots_version_check" CHECK ("version" >= 1),
  CONSTRAINT "ai_bom_snapshots_supersedes_check" CHECK (("version" = 1) = ("supersedes_id" IS NULL)),
  CONSTRAINT "ai_bom_snapshots_serial_check" CHECK ("serial_number" = "regulait_ai_bom_serial"("id")),
  CONSTRAINT "ai_bom_snapshots_trigger_check" CHECK ("trigger" IN ('on_demand', 'use_case_approval', 'model_card_approval', 'prompt_promotion', 'evidence_attached', 'config_promotion', 'server_admission', 'skill_admission')),
  CONSTRAINT "ai_bom_snapshots_basis_check" CHECK (jsonb_typeof("basis") = 'object'),
  CONSTRAINT "ai_bom_snapshots_body_sha256_check" CHECK ("body_sha256" = encode(sha256(convert_to("body", 'UTF8')), 'hex')),
  CONSTRAINT "ai_bom_snapshots_body_check" CHECK (
    COALESCE(
      ("body"::jsonb ->> 'v') = 'regulait.ai-bom.v1'
      AND ("body"::jsonb #>> '{snapshot,id}') = "id"::text
      AND ("body"::jsonb #>> '{snapshot,subjectKind}') = "subject_kind"
      AND ("body"::jsonb #>> '{snapshot,subjectId}') = "subject_id"::text
      AND ("body"::jsonb #> '{snapshot,version}') = to_jsonb("version")
      AND ("body"::jsonb ->> 'serialNumber') = 'urn:uuid:' || "serial_number"::text,
      false
    )
  ),
  CONSTRAINT "ai_bom_snapshots_signature_check" CHECK ("signature" ~ '^[A-Za-z0-9_-]{86}$'),
  CONSTRAINT "ai_bom_snapshots_expires_check" CHECK ("expires_at" IS NULL OR "expires_at" > "created_at")
);
--> statement-breakpoint
CREATE INDEX "ai_bom_snapshots_expires_idx" ON "ai_bom_snapshots" ("expires_at");
--> statement-breakpoint
-- versions are allocated contiguously per subject, each superseding the last
-- (the per-subject advisory lock, `lockAiBomSubject`, makes concurrent writers
-- wait rather than collide; this trigger makes a skipped or forked version
-- impossible whatever the writer does)
CREATE OR REPLACE FUNCTION "regulait_ai_bom_snapshot_version_guard"() RETURNS trigger AS $$
DECLARE
  prev_id uuid;
  prev_version integer;
BEGIN
  SELECT s."id", s."version" INTO prev_id, prev_version FROM "ai_bom_snapshots" s
   WHERE s."subject_kind" = NEW."subject_kind" AND s."subject_id" = NEW."subject_id"
   ORDER BY s."version" DESC LIMIT 1;
  IF NEW."version" <> COALESCE(prev_version, 0) + 1 OR NEW."supersedes_id" IS DISTINCT FROM prev_id THEN
    RAISE EXCEPTION 'ai_bom_snapshots: version % of %/% must be % and supersede the previous version', NEW."version", NEW."subject_kind", NEW."subject_id", COALESCE(prev_version, 0) + 1
      USING ERRCODE = 'integrity_constraint_violation',
            HINT = 'allocate the version under the per-subject lock (ADR-0189 round 8, 4237322632)';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "ai_bom_snapshots_version_guard"
  BEFORE INSERT ON "ai_bom_snapshots"
  FOR EACH ROW EXECUTE FUNCTION "regulait_ai_bom_snapshot_version_guard"();
--> statement-breakpoint
CREATE TRIGGER "ai_bom_snapshots_append_only"
  BEFORE UPDATE OR DELETE ON "ai_bom_snapshots"
  FOR EACH ROW EXECUTE FUNCTION "regulait_bom_prune_guard"('ai_bom');
--> statement-breakpoint

-- ===== 5. decision facts (§4, R5, R18, R37) =================================
CREATE TABLE "decision_facts" (
  "audit_id" uuid PRIMARY KEY NOT NULL REFERENCES "decision_capture_status"("audit_id"),
  "audit_seq" bigint NOT NULL,
  "facts_version" text DEFAULT 'regulait.decision-facts.v1' NOT NULL,
  "facts" jsonb NOT NULL,
  "facts_hash" text NOT NULL,
  -- #280 (4237493040): a snapshot referenced only from retained facts is linked;
  -- RESTRICT, so the snapshot cannot be pruned while these facts are retained
  "ai_bom_snapshot_id" uuid REFERENCES "ai_bom_snapshots"("id") ON DELETE RESTRICT,
  "expires_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "decision_facts_version_check" CHECK ("facts_version" = 'regulait.decision-facts.v1'),
  CONSTRAINT "decision_facts_payload_check" CHECK (
    COALESCE(
      jsonb_typeof("facts") = 'object'
      AND "facts" ->> 'v' = "facts_version"
      AND "facts" ->> 'auditId' = "audit_id"::text
      AND "facts" -> 'auditSeq' = to_jsonb("audit_seq")
      AND ("facts" #>> '{model,aiBomSnapshotId}') IS NOT DISTINCT FROM "ai_bom_snapshot_id"::text,
      false
    )
  ),
  -- the hash is over the canonical bytes, computed here (0162's regulait_canonical_json)
  CONSTRAINT "decision_facts_hash_check" CHECK ("facts_hash" = encode(sha256(convert_to("regulait_canonical_json"("facts"), 'UTF8')), 'hex'))
);
--> statement-breakpoint
CREATE INDEX "decision_facts_snapshot_idx" ON "decision_facts" ("ai_bom_snapshot_id") WHERE "ai_bom_snapshot_id" IS NOT NULL;
--> statement-breakpoint
-- facts agree with their marker: captured, same hash, same seq, the same expires_at
CREATE OR REPLACE FUNCTION "regulait_decision_facts_marker_guard"() RETURNS trigger AS $$
DECLARE
  m record;
BEGIN
  SELECT * INTO m FROM "decision_capture_status" WHERE "audit_id" = NEW."audit_id";
  IF m."status" IS DISTINCT FROM 'captured' OR m."facts_hash" IS DISTINCT FROM NEW."facts_hash"
     OR m."audit_seq" IS DISTINCT FROM NEW."audit_seq" OR m."expires_at" IS DISTINCT FROM NEW."expires_at" THEN
    RAISE EXCEPTION 'decision_facts: the facts of % do not match its capture-status marker', NEW."audit_id"
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "decision_facts_marker_guard"
  BEFORE INSERT ON "decision_facts"
  FOR EACH ROW EXECUTE FUNCTION "regulait_decision_facts_marker_guard"();
--> statement-breakpoint
CREATE TRIGGER "decision_facts_append_only"
  BEFORE UPDATE OR DELETE ON "decision_facts"
  FOR EACH ROW EXECUTE FUNCTION "regulait_bom_prune_guard"('decision');
--> statement-breakpoint
-- at COMMIT: a `captured` marker has its facts row; a `capture_off` marker has none
CREATE OR REPLACE FUNCTION "regulait_capture_status_consistent"() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "decision_capture_status" WHERE "audit_id" = NEW."audit_id") THEN
    RETURN NULL; -- pruned in the same transaction
  END IF;
  IF NEW."status" = 'captured' AND NOT EXISTS (SELECT 1 FROM "decision_facts" f WHERE f."audit_id" = NEW."audit_id" AND f."facts_hash" = NEW."facts_hash") THEN
    RAISE EXCEPTION 'decision_capture_status: % is marked captured but its facts were not written in the same transaction', NEW."audit_id"
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."status" = 'capture_off' AND EXISTS (SELECT 1 FROM "decision_facts" f WHERE f."audit_id" = NEW."audit_id") THEN
    RAISE EXCEPTION 'decision_capture_status: % is marked capture_off but has facts', NEW."audit_id"
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "decision_capture_status_consistent"
  AFTER INSERT ON "decision_capture_status"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "regulait_capture_status_consistent"();
--> statement-breakpoint

-- ===== 6. addenda (R15, R35) and their signatures ===========================
CREATE TABLE "decision_fact_addenda" (
  "audit_id" uuid NOT NULL REFERENCES "decision_facts"("audit_id"),
  "n" integer NOT NULL,
  "prev_hash" text NOT NULL,
  "facts" jsonb NOT NULL,
  "facts_hash" text NOT NULL,
  "expires_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "decision_fact_addenda_pk" PRIMARY KEY ("audit_id", "n"),
  CONSTRAINT "decision_fact_addenda_hash_uq" UNIQUE ("audit_id", "n", "facts_hash"),
  CONSTRAINT "decision_fact_addenda_n_check" CHECK ("n" >= 1),
  CONSTRAINT "decision_fact_addenda_prev_hash_check" CHECK ("prev_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "decision_fact_addenda_payload_check" CHECK (
    COALESCE(
      jsonb_typeof("facts") = 'object'
      AND "facts" ->> 'v' = 'regulait.decision-facts-addendum.v1'
      AND "facts" ->> 'auditId' = "audit_id"::text
      AND "facts" -> 'n' = to_jsonb("n")
      AND "facts" ->> 'prev' = "prev_hash",
      false
    )
  ),
  CONSTRAINT "decision_fact_addenda_hash_check" CHECK ("facts_hash" = encode(sha256(convert_to("regulait_canonical_json"("facts"), 'UTF8')), 'hex'))
);
--> statement-breakpoint
-- R35: the chain never forks. n = 1 links to the decision's facts_hash; n > 1 to
-- addendum n - 1, which must exist. The expires_at is the decision's.
CREATE OR REPLACE FUNCTION "regulait_decision_fact_addendum_guard"() RETURNS trigger AS $$
DECLARE
  want_prev text;
  want_expires timestamp with time zone;
BEGIN
  SELECT f."expires_at" INTO want_expires FROM "decision_facts" f WHERE f."audit_id" = NEW."audit_id";
  IF NEW."n" = 1 THEN
    SELECT f."facts_hash" INTO want_prev FROM "decision_facts" f WHERE f."audit_id" = NEW."audit_id";
  ELSE
    SELECT a."facts_hash" INTO want_prev FROM "decision_fact_addenda" a WHERE a."audit_id" = NEW."audit_id" AND a."n" = NEW."n" - 1;
  END IF;
  IF want_prev IS NULL OR NEW."prev_hash" <> want_prev OR NEW."expires_at" IS DISTINCT FROM want_expires THEN
    RAISE EXCEPTION 'decision_fact_addenda: addendum % of % does not extend the chain', NEW."n", NEW."audit_id"
      USING ERRCODE = 'integrity_constraint_violation',
            HINT = 'take the per-decision lock, read the last addendum, write n + 1 (ADR-0189 R35)';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "decision_fact_addenda_chain_guard"
  BEFORE INSERT ON "decision_fact_addenda"
  FOR EACH ROW EXECUTE FUNCTION "regulait_decision_fact_addendum_guard"();
--> statement-breakpoint
CREATE TRIGGER "decision_fact_addenda_append_only"
  BEFORE UPDATE OR DELETE ON "decision_fact_addenda"
  FOR EACH ROW EXECUTE FUNCTION "regulait_bom_prune_guard"('decision');
--> statement-breakpoint
CREATE TABLE "decision_fact_addendum_signatures" (
  "audit_id" uuid NOT NULL,
  "n" integer NOT NULL,
  "facts_hash" text NOT NULL,
  "signature" text NOT NULL,
  "key_id" text NOT NULL REFERENCES "receipt_signing_keys"("key_id"),
  "expires_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "decision_fact_addendum_signatures_pk" PRIMARY KEY ("audit_id", "n"),
  -- the signature names exactly the addendum bytes it covers
  CONSTRAINT "decision_fact_addendum_signatures_addendum_fk" FOREIGN KEY ("audit_id", "n", "facts_hash")
    REFERENCES "decision_fact_addenda"("audit_id", "n", "facts_hash"),
  CONSTRAINT "decision_fact_addendum_signatures_signature_check" CHECK ("signature" ~ '^[A-Za-z0-9_-]{86}$')
);
--> statement-breakpoint
-- R15: signed in n order (nothing past a gap) with the decision's expires_at
CREATE OR REPLACE FUNCTION "regulait_decision_fact_addendum_signature_guard"() RETURNS trigger AS $$
BEGIN
  IF NEW."n" > 1 AND NOT EXISTS (
       SELECT 1 FROM "decision_fact_addendum_signatures" s WHERE s."audit_id" = NEW."audit_id" AND s."n" = NEW."n" - 1) THEN
    RAISE EXCEPTION 'decision_fact_addendum_signatures: addendum % of % is signed before addendum %', NEW."n", NEW."audit_id", NEW."n" - 1
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."expires_at" IS DISTINCT FROM (SELECT a."expires_at" FROM "decision_fact_addenda" a WHERE a."audit_id" = NEW."audit_id" AND a."n" = NEW."n") THEN
    RAISE EXCEPTION 'decision_fact_addendum_signatures: expires_at differs from the decision''s'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "decision_fact_addendum_signatures_order_guard"
  BEFORE INSERT ON "decision_fact_addendum_signatures"
  FOR EACH ROW EXECUTE FUNCTION "regulait_decision_fact_addendum_signature_guard"();
--> statement-breakpoint
CREATE TRIGGER "decision_fact_addendum_signatures_append_only"
  BEFORE UPDATE OR DELETE ON "decision_fact_addendum_signatures"
  FOR EACH ROW EXECUTE FUNCTION "regulait_bom_prune_guard"('decision');
--> statement-breakpoint

-- ===== 7b. Decision BOMs (§8, R40, R44) =====================================
CREATE TABLE "decision_boms" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "audit_id" uuid NOT NULL,
  "version" integer NOT NULL,
  "supersedes_id" uuid REFERENCES "decision_boms"("id"),
  "finality" text NOT NULL,
  "body" text NOT NULL,
  "body_sha256" text NOT NULL,
  "signature" text NOT NULL,
  "key_id" text NOT NULL REFERENCES "receipt_signing_keys"("key_id"),
  "basis" jsonb NOT NULL,
  -- a retained Decision BOM keeps the snapshot it links to (R38)
  "ai_bom_snapshot_id" uuid REFERENCES "ai_bom_snapshots"("id") ON DELETE RESTRICT,
  "expires_at" timestamp with time zone,
  "created_by" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "decision_boms_audit_version_uq" UNIQUE ("audit_id", "version"),
  CONSTRAINT "decision_boms_version_check" CHECK ("version" >= 1),
  CONSTRAINT "decision_boms_supersedes_check" CHECK (("version" = 1) = ("supersedes_id" IS NULL)),
  CONSTRAINT "decision_boms_finality_check" CHECK ("finality" IN ('anchored', 'anchored_finite_lock', 'anchored_unverified_destination', 'chain_signed')),
  CONSTRAINT "decision_boms_body_sha256_check" CHECK ("body_sha256" = encode(sha256(convert_to("body", 'UTF8')), 'hex')),
  CONSTRAINT "decision_boms_body_check" CHECK (
    COALESCE(
      ("body"::jsonb ->> 'v') = 'regulait.decision-bom.v1'
      AND ("body"::jsonb ->> 'id') = "id"::text
      AND ("body"::jsonb ->> 'auditId') = "audit_id"::text
      AND ("body"::jsonb -> 'version') = to_jsonb("version")
      AND ("body"::jsonb ->> 'finality') = "finality",
      false
    )
  ),
  CONSTRAINT "decision_boms_signature_check" CHECK ("signature" ~ '^[A-Za-z0-9_-]{86}$'),
  CONSTRAINT "decision_boms_basis_check" CHECK (jsonb_typeof("basis") = 'object')
);
--> statement-breakpoint
CREATE INDEX "decision_boms_snapshot_idx" ON "decision_boms" ("ai_bom_snapshot_id") WHERE "ai_bom_snapshot_id" IS NOT NULL;
--> statement-breakpoint
-- contiguous versions, each superseding the last; the expires_at is the decision's
-- (its marker's, when one exists; a pre-marker decision's BOM carries its own)
CREATE OR REPLACE FUNCTION "regulait_decision_bom_version_guard"() RETURNS trigger AS $$
DECLARE
  prev_id uuid;
  prev_version integer;
  m record;
BEGIN
  SELECT b."id", b."version" INTO prev_id, prev_version FROM "decision_boms" b
   WHERE b."audit_id" = NEW."audit_id" ORDER BY b."version" DESC LIMIT 1;
  IF NEW."version" <> COALESCE(prev_version, 0) + 1 OR NEW."supersedes_id" IS DISTINCT FROM prev_id THEN
    RAISE EXCEPTION 'decision_boms: version % of % must be % and supersede the previous version', NEW."version", NEW."audit_id", COALESCE(prev_version, 0) + 1
      USING ERRCODE = 'integrity_constraint_violation',
            HINT = 'allocate the version under the per-decision lock (ADR-0189 R40, 4237344247)';
  END IF;
  SELECT * INTO m FROM "decision_capture_status" WHERE "audit_id" = NEW."audit_id";
  IF FOUND AND m."expires_at" IS DISTINCT FROM NEW."expires_at" THEN
    RAISE EXCEPTION 'decision_boms: expires_at differs from the decision''s'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "decision_boms_version_guard"
  BEFORE INSERT ON "decision_boms"
  FOR EACH ROW EXECUTE FUNCTION "regulait_decision_bom_version_guard"();
--> statement-breakpoint
CREATE TRIGGER "decision_boms_append_only"
  BEFORE UPDATE OR DELETE ON "decision_boms"
  FOR EACH ROW EXECUTE FUNCTION "regulait_bom_prune_guard"('decision');
--> statement-breakpoint

-- ===== 8. renderings (R36) ==================================================
CREATE TABLE "bom_renderings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "decision_bom_id" uuid REFERENCES "decision_boms"("id") ON DELETE CASCADE,
  "ai_bom_snapshot_id" uuid REFERENCES "ai_bom_snapshots"("id") ON DELETE CASCADE,
  "format" text NOT NULL,
  "bytes" text NOT NULL,
  "sha256" text NOT NULL,
  "validator" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "bom_renderings_one_parent_check" CHECK (num_nonnulls("decision_bom_id", "ai_bom_snapshot_id") = 1),
  CONSTRAINT "bom_renderings_format_check" CHECK ("format" IN ('cyclonedx-1.7', 'cyclonedx-1.6', 'spdx-3.0.1', 'in-toto')),
  CONSTRAINT "bom_renderings_sha256_check" CHECK ("sha256" = encode(sha256(convert_to("bytes", 'UTF8')), 'hex')),
  CONSTRAINT "bom_renderings_validator_check" CHECK ("validator" ~ '^[A-Za-z0-9._:@/+ -]+$' AND char_length("validator") <= 256)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "bom_renderings_decision_bom_format_uq" ON "bom_renderings" ("decision_bom_id", "format") WHERE "decision_bom_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "bom_renderings_snapshot_format_uq" ON "bom_renderings" ("ai_bom_snapshot_id", "format") WHERE "ai_bom_snapshot_id" IS NOT NULL;
--> statement-breakpoint
-- deleted only as the cascade of whichever parent is set, once that parent is gone
CREATE OR REPLACE FUNCTION "regulait_bom_rendering_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    IF OLD."decision_bom_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "decision_boms" WHERE "id" = OLD."decision_bom_id") THEN
      RETURN OLD;
    END IF;
    IF OLD."ai_bom_snapshot_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "ai_bom_snapshots" WHERE "id" = OLD."ai_bom_snapshot_id") THEN
      RETURN OLD;
    END IF;
  END IF;
  RAISE EXCEPTION '% is append-only: % refused', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege',
          HINT = 'a rendering goes only with its parent (ADR-0189 R36)';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "bom_renderings_append_only"
  BEFORE UPDATE OR DELETE ON "bom_renderings"
  FOR EACH ROW EXECUTE FUNCTION "regulait_bom_rendering_guard"();
--> statement-breakpoint

-- ===== 10. the auditor export grant (§7 bom_export_roles) ===================
CREATE TABLE "bom_auditor_grants" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "granted_by" uuid NOT NULL,
  "granted_at" timestamp with time zone DEFAULT now() NOT NULL,
  "revoked_at" timestamp with time zone,
  "revoked_by" uuid,
  CONSTRAINT "bom_auditor_grants_revoke_check" CHECK (("revoked_at" IS NULL) = ("revoked_by" IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "bom_auditor_grants_active_uq" ON "bom_auditor_grants" ("user_id") WHERE "revoked_at" IS NULL;
--> statement-breakpoint
-- the only change is a revocation, once; a deleted user's grants go with the user
CREATE OR REPLACE FUNCTION "regulait_bom_auditor_grant_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 AND NOT EXISTS (SELECT 1 FROM "users" WHERE "id" = OLD."user_id") THEN
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD."revoked_at" IS NULL AND NEW."revoked_at" IS NOT NULL
     AND (to_jsonb(NEW) - 'revoked_at' - 'revoked_by') = (to_jsonb(OLD) - 'revoked_at' - 'revoked_by') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'bom_auditor_grants: % refused (a grant is only ever revoked, once)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "bom_auditor_grants_guard"
  BEFORE UPDATE OR DELETE ON "bom_auditor_grants"
  FOR EACH ROW EXECUTE FUNCTION "regulait_bom_auditor_grant_guard"();
--> statement-breakpoint

-- ===== 3b. receipts: v1 below the boundary, v2 (bound to its marker) from it on
ALTER TABLE "decision_receipts" DROP CONSTRAINT "decision_receipts_payload_check";
--> statement-breakpoint
ALTER TABLE "decision_receipts" ADD CONSTRAINT "decision_receipts_payload_check" CHECK (
  COALESCE(
    jsonb_typeof("payload") = 'object'
    AND "payload" ->> 'v' IN ('regulait.receipt.v1', 'regulait.receipt.v2')
    AND jsonb_typeof("payload" -> 'receiptSeq') = 'number'
    AND "payload" ->> 'receiptSeq' = "receipt_seq"::text
    AND "payload" ->> 'keyId' = "key_id"
    AND "payload" ->> 'prev' = "prev_hash"
    AND ("payload" ->> 'v' = 'regulait.receipt.v1' OR (
      "payload" ->> 'factsStatus' IN ('captured', 'capture_off')
      AND (("payload" ->> 'factsStatus' = 'captured' AND "payload" ->> 'factsHash' ~ '^[0-9a-f]{64}$')
           OR ("payload" ->> 'factsStatus' = 'capture_off' AND "payload" -> 'factsHash' = 'null'::jsonb))
    )),
    false
  )
);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "regulait_decision_receipt_version_guard"() RETURNS trigger AS $$
DECLARE
  boundary bigint;
  m record;
BEGIN
  SELECT min("from_audit_seq") INTO boundary FROM "receipt_payload_versions";
  IF NEW."payload" ->> 'v' = 'regulait.receipt.v2' THEN
    IF boundary IS NULL OR NEW."audit_seq" < boundary THEN
      RAISE EXCEPTION 'decision_receipts: a v2 receipt below the recorded boundary (audit seq %)', NEW."audit_seq"
        USING ERRCODE = 'integrity_constraint_violation',
              HINT = 'v2 is emitted only from receipt_payload_versions.from_audit_seq on (ADR-0189 R42)';
    END IF;
    SELECT * INTO m FROM "decision_capture_status" WHERE "audit_id" = NEW."audit_id";
    IF NOT FOUND OR m."status" <> NEW."payload" ->> 'factsStatus' OR m."facts_hash" IS DISTINCT FROM NEW."payload" ->> 'factsHash' THEN
      RAISE EXCEPTION 'decision_receipts: the v2 receipt of % does not match its capture-status marker', NEW."audit_id"
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  ELSIF boundary IS NOT NULL AND NEW."audit_seq" >= boundary THEN
    RAISE EXCEPTION 'decision_receipts: a v1 receipt at or above the recorded v2 boundary (audit seq %)', NEW."audit_seq"
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "decision_receipts_version_guard"
  BEFORE INSERT ON "decision_receipts"
  FOR EACH ROW EXECUTE FUNCTION "regulait_decision_receipt_version_guard"();
