-- Migration 0068 (ADR-0055) — SHADOW-AI DISCOVERY.
--
-- WHAT IS NOT HERE, AND WHY THAT IS THE HONEST SHAPE
--
--   There is no collector table, no agent-enrollment table, no "scan schedule".
--   RegulAIt ships NO COLLECTOR: this control plane does not sit on a
--   customer's network, does not hold their resolver, and does not run on their
--   endpoints. What ships is the IMPORTER + ANALYZER over evidence the customer
--   already produces — a proxy/DNS/SIEM export, a repo-scan result, a SaaS
--   admin export, or a typed self-report. So the schema models EVIDENCE THAT
--   ARRIVED and CONCLUSIONS DRAWN FROM IT, and nothing that implies we watched
--   anything ourselves.
--
--   The corollary is `shadow_ai_imports`: because every finding traces to a
--   file somebody uploaded, the file has to be a first-class, fingerprinted,
--   auditable record — including the REFUSED ones.
--
-- ------------------------------------------------------------------------
-- ai_endpoint_signatures — THE CATALOGUE, AND IT IS DATA
-- ------------------------------------------------------------------------
--
-- ADR-0055 §1: "It is data, not code — updating detection for a new provider is
-- a catalog row, never a deploy." This table is that sentence. The matcher in
-- `@regulait/shared` contains no provider name at all; delete every row here
-- and discovery matches nothing. `DEFAULT_AI_SIGNATURES` is a SEED an admin
-- installs through `POST /v1/shadow-ai/catalogue/seed` and may then edit or
-- delete like any row they authored.
--
-- HOW IT IS UPDATED. Three ways, all data: (a) the seed, re-runnable and
-- idempotent, refreshing only rows still marked `regulait-seed` so an admin's
-- edits are never clobbered; (b) `POST /v1/shadow-ai/catalogue`, one row at a
-- time, which is also how a customer adds a PRIVATE in-house endpoint we could
-- never know about; (c) `DELETE`. No release is involved in any of them.
--
-- WHY THERE IS NO `pattern` COLUMN. An admin-editable regular expression
-- evaluated against imported strings is a ReDoS primitive with an admin-shaped
-- trigger, and "only an admin can set it" is not a mitigation (ADR-0034 made
-- exactly this argument about `baseUrl`). Detection is therefore modelled as
-- PREFIX + MINIMUM LENGTH for keys and exact-or-dot-boundary-suffix for hosts.
-- Both are linear; neither can be made to backtrack. `min_length` is REQUIRED
-- for a key signature by a CHECK, because a bare prefix with no length bound
-- would flag every string starting with `sk-` — including the test fixtures
-- that make a discovery product unusable.
--
-- `provenance` + `last_updated_at` ARE THE STALENESS DISCLOSURE. ADR-0055 says
-- plainly that the catalogue will lag reality and that a brand-new provider is
-- invisible until its row exists. These two columns make that legible per row
-- instead of hidden behind a version number.
--
-- `replacement_agent_id` IS WHAT MAKES A FINDING ACTIONABLE. A finding that
-- only says "you have ungoverned OpenAI usage" is a complaint. Pointing at the
-- governed agent in the registry that would replace it is the land-and-expand
-- motion the ADR is built around. ON DELETE SET NULL: retiring an agent must
-- never delete the evidence of ungoverned usage.

CREATE TABLE "ai_endpoint_signatures" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "provider" text NOT NULL,
  "kind" text NOT NULL,
  -- a hostname, a package name, or a key PREFIX. Never a regular expression.
  "value" text NOT NULL,
  "match_type" text NOT NULL,
  -- key signatures only: the minimum length of the FULL observed key
  "min_length" integer,
  -- the governed thing that would REPLACE this usage
  "replacement_agent_id" uuid REFERENCES "agents"("id") ON DELETE SET NULL,
  "replacement_note" text,
  -- 'regulait-seed', 'admin', or a vendor advisory URL
  "provenance" text DEFAULT 'admin' NOT NULL,
  "enabled" boolean DEFAULT true NOT NULL,
  "last_updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "ai_endpoint_signatures_kind_ck"
    CHECK ("kind" IN ('hostname', 'sdk_package', 'api_key_prefix', 'web_app')),
  CONSTRAINT "ai_endpoint_signatures_match_ck"
    CHECK ("match_type" IN ('exact_host', 'host_suffix', 'package', 'key_prefix')),
  -- kind and match_type cannot disagree: a package signature matched as a host
  -- would silently never fire
  CONSTRAINT "ai_endpoint_signatures_kind_match_ck" CHECK (
    ("kind" = 'sdk_package') = ("match_type" = 'package')
    AND ("kind" = 'api_key_prefix') = ("match_type" = 'key_prefix')
  ),
  -- a key prefix with no length bound is a false-positive generator
  CONSTRAINT "ai_endpoint_signatures_minlen_ck"
    CHECK ("kind" <> 'api_key_prefix' OR "min_length" IS NOT NULL)
);
-- one row per (kind, value): the seed is re-runnable and an admin cannot
-- accidentally register the same host twice with two different verdicts
CREATE UNIQUE INDEX "ai_endpoint_signatures_kind_value_uq"
  ON "ai_endpoint_signatures" ("kind", lower("value"));
CREATE INDEX "ai_endpoint_signatures_provider_idx" ON "ai_endpoint_signatures" ("provider");

-- ------------------------------------------------------------------------
-- shadow_ai_imports — EVERY EVIDENCE FILE, INCLUDING THE REFUSED ONES
-- ------------------------------------------------------------------------
--
-- Same posture as `onboarding_imports` (ADR-0054) and for the same reason: an
-- import is UNTRUSTED INPUT, so the refusals are the rows that matter. A
-- payload that tried to smuggle `grants` or `isAdmin` into a description of
-- network traffic is refused by a pre-parse screen AND by strict row schemas
-- with no such field, and the refusal lands here beside an `audit_log` deny —
-- because "somebody uploaded an evidence file that tried to mint entitlements"
-- must be findable months later.
--
-- WHAT AN IMPORT CAN DO, EXHAUSTIVELY: write rows into `shadow_ai_findings`.
-- That is the entire blast radius. It cannot create a user, a role, a grant, an
-- agent, an approval, or a catalogue row — there is no column in any row schema
-- that names one, and no code path from this table to a governed object.
--
-- `mode` separates the preview from the act. Both run the SAME pure analyzer,
-- so a dry run is not a different computation from the apply it previews.

CREATE TABLE "shadow_ai_imports" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "kind" text NOT NULL,
  "mode" text NOT NULL,
  "status" text NOT NULL,
  -- free text naming where the customer says the export came from
  "source" text,
  -- fingerprint of the exact screened bytes: "which file did this?" answerable
  -- without retaining a proxy log forever
  "payload_sha256" text NOT NULL,
  "row_count" integer DEFAULT 0 NOT NULL,
  -- counts + the findings the analyzer produced; for a refusal, what was wrong
  "summary" jsonb NOT NULL,
  -- the same stable id that names the audit_log row
  "rule_id" text NOT NULL,
  "reason" text NOT NULL,
  "requested_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "applied_at" timestamp with time zone,
  CONSTRAINT "shadow_ai_imports_kind_ck"
    CHECK ("kind" IN ('egress_log', 'code_scan', 'saas_export', 'self_reported')),
  CONSTRAINT "shadow_ai_imports_mode_ck" CHECK ("mode" IN ('dry_run', 'apply')),
  CONSTRAINT "shadow_ai_imports_status_ck"
    CHECK ("status" IN ('planned', 'applied', 'refused')),
  CONSTRAINT "shadow_ai_imports_applied_ck"
    CHECK (("status" = 'applied') = ("applied_at" IS NOT NULL))
);
CREATE INDEX "shadow_ai_imports_created_idx" ON "shadow_ai_imports" ("created_at");
CREATE INDEX "shadow_ai_imports_kind_idx" ON "shadow_ai_imports" ("kind");
CREATE INDEX "shadow_ai_imports_status_idx" ON "shadow_ai_imports" ("status");

-- ------------------------------------------------------------------------
-- shadow_ai_findings — THE CORRELATED INVENTORY
-- ------------------------------------------------------------------------
--
-- THE UNIQUE INDEX IS THE DEDUP STORY. ADR-0055 §3: one real usage can produce
-- an egress hit AND a code hit, and the inventory must CORRELATE them rather
-- than double-count. The key is (subject_kind, subject, provider), so a second
-- import re-observing the same usage widens `signal_sources`, extends
-- `last_seen_at`, adds to `observation_count` and RAISES CONFIDENCE — it never
-- creates a second row.
--
-- SEVERITY AND CONFIDENCE ARE DIFFERENT AXES AND ARE STORED SEPARATELY.
-- Severity is what the signal IMPLIES (a hard-coded key is a live credential
-- exposure; an SDK dependency is a capability). Confidence is how many
-- INDEPENDENT collectors corroborate it. Collapsing them into one "score" is
-- exactly the flat alert stream §6 refuses: a customer works the `critical`
-- rows first regardless of how many sources saw them.
--
-- `disposition` EXISTS BECAUSE DETECTION IS SIGNAL, NOT PROOF. A vendored SDK
-- that is never called and a sanctioned integration are both expected, so the
-- inventory carries `sanctioned` / `false_positive` / `remediated` as real
-- answers rather than a binary alarm an operator can only silence.
--
-- WHAT IS DELIBERATELY NOT STORED: the key. `evidence` holds at most a
-- redacted prefix (8 characters, enforced in the analyzer) plus the observed
-- LENGTH — enough to prove the finding, never enough to be a credential. The
-- ADR asks for the shortest retention the compliance cascade permits; the first
-- half of that is not writing the secret down at all.

CREATE TABLE "shadow_ai_findings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "subject_kind" text NOT NULL,
  -- the thing that would be remediated: the repo, the calling host, the app
  "subject" text NOT NULL,
  "provider" text NOT NULL,
  -- which collectors corroborate this row (a string array)
  "signal_sources" jsonb NOT NULL,
  "signature_kinds" jsonb NOT NULL,
  "first_seen_at" timestamp with time zone NOT NULL,
  "last_seen_at" timestamp with time zone NOT NULL,
  "observation_count" integer DEFAULT 0 NOT NULL,
  "severity" text NOT NULL,
  "confidence" text NOT NULL,
  "disposition" text DEFAULT 'open' NOT NULL,
  -- the governed replacement, carried through from the catalogue — NEVER from
  -- the imported file
  "replacement_agent_id" uuid REFERENCES "agents"("id") ON DELETE SET NULL,
  "replacement_note" text,
  -- bounded: the leads, not a log store. Redacted key fragments only.
  "evidence" jsonb NOT NULL,
  "last_import_id" uuid REFERENCES "shadow_ai_imports"("id") ON DELETE SET NULL,
  "disposition_reason" text,
  "disposition_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "disposition_at" timestamp with time zone,
  "remediation_instance_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "shadow_ai_findings_subject_kind_ck"
    CHECK ("subject_kind" IN ('host', 'repo', 'saas_app', 'system')),
  CONSTRAINT "shadow_ai_findings_severity_ck"
    CHECK ("severity" IN ('low', 'medium', 'high', 'critical')),
  CONSTRAINT "shadow_ai_findings_confidence_ck"
    CHECK ("confidence" IN ('low', 'medium', 'high')),
  CONSTRAINT "shadow_ai_findings_disposition_ck"
    CHECK ("disposition" IN ('open', 'confirmed', 'sanctioned', 'false_positive', 'remediated')),
  -- a disposition that moved off 'open' records WHO and WHEN, or it did not
  -- happen
  CONSTRAINT "shadow_ai_findings_disposition_at_ck"
    CHECK (("disposition" = 'open') OR ("disposition_at" IS NOT NULL)),
  CONSTRAINT "shadow_ai_findings_seen_order_ck"
    CHECK ("first_seen_at" <= "last_seen_at")
);
CREATE UNIQUE INDEX "shadow_ai_findings_correlation_uq"
  ON "shadow_ai_findings" ("subject_kind", lower("subject"), lower("provider"));
CREATE INDEX "shadow_ai_findings_severity_idx" ON "shadow_ai_findings" ("severity");
CREATE INDEX "shadow_ai_findings_disposition_idx" ON "shadow_ai_findings" ("disposition");
CREATE INDEX "shadow_ai_findings_last_seen_idx" ON "shadow_ai_findings" ("last_seen_at");
