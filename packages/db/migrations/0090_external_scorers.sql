-- Migration 0090 (ADR-0088) — REGISTERED EXTERNAL EVAL SCORERS.
--
-- Gap L14 (docs/product/GAP_ANALYSIS_FOUR_VENDORS_2026-08.md): we do not ship
-- an in-house scoring model and we never fake one — that refusal is
-- REAFFIRMED. What an operator may do is bring their own Fiddler-class
-- scoring endpoint and plug it in as a GOVERNED, DISCLOSED instrument. This
-- table is that registration surface, and nothing more:
--
--   * The baseUrl is admin-typed and therefore an SSRF primitive. It rides
--     the SAME ADR-0034 egress guard as a custom LLM provider: default-deny
--     against egress_allow_hosts, private ranges opt-in per host, DNS-pinned
--     guarded fetch on every request, redirects refused. Air-gapped posture
--     is inherited, not re-implemented: a typed destination is strictly
--     adjudicated in EVERY deploy mode.
--   * register → test → enable, and the gate re-arms when the endpoint
--     moves — the exact custom_model_providers lifecycle.
--   * scorer_kinds is the instrument's CLAIM about which judge-backed metrics
--     it serves. The gateway governs the call and records provenance; it
--     does not validate the instrument.
--   * Every score the instrument produces is stamped
--     method = 'external:<name>' on the eval_results row. It is never
--     blended with 'lexical-idf-overlap' or 'model-judged', and the
--     ADR-0067/0072 refusal semantics carry over verbatim: a named-but-
--     unusable scorer refuses the run with a 422 BEFORE any row is written.
--   * The deterministic (lexical) scorer kinds can never route here — refused
--     at authoring time, and structurally unreachable in the runner.

CREATE TABLE IF NOT EXISTS "external_scorers" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "base_url" text NOT NULL,
  -- AES-256-GCM under REGULAIT_DATA_KEY, write-only, never returned.
  -- NULLABLE: an on-prem scorer authenticating by network position has none.
  "key_ciphertext" text,
  -- which judge-backed scorer kinds this instrument claims to serve
  "scorer_kinds" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "allow_plaintext_http" boolean DEFAULT false NOT NULL,
  -- inert until the connection test passes and an admin enables it
  "enabled" boolean DEFAULT false NOT NULL,
  "last_tested_at" timestamp with time zone,
  "last_test_error" text,
  "created_by" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

DO $$ BEGIN
  ALTER TABLE "external_scorers" ADD CONSTRAINT "external_scorers_name_unique" UNIQUE ("name");
EXCEPTION WHEN duplicate_table THEN NULL; WHEN duplicate_object THEN NULL; END $$;
