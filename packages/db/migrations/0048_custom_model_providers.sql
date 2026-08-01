-- Migration 0048 (ADR-0034) — ADMIN-REGISTERED CUSTOM LLM PROVIDERS, plus the
-- egress allow-list that makes an admin-suppliable baseUrl safe to have at all.
--
-- WHAT WAS BLOCKED. BYO *keys* have worked since migration 0017, and `base_url`
-- has existed on both credential tables and been plumbed through all four
-- adapters for just as long. What did not exist was a way to name an endpoint
-- the platform ships no adapter for: `provider` was a closed set of four SaaS
-- vendors, so Ollama, vLLM, LM Studio, LocalAI, Azure OpenAI, a Bedrock proxy
-- and every internal gateway were unreachable. That also made pillar 3's
-- air-gapped deployment mode hollow — every supported provider was an internet
-- SaaS.
--
-- THE SECURITY PREMISE (why egress_allow_hosts exists in the same migration).
-- A baseUrl an admin can type is a Server-Side Request Forgery primitive. The
-- gateway runs on EC2; pointed at http://169.254.169.254/latest/meta-data/iam/
-- security-credentials/ it would fetch and return the instance role's AWS
-- credentials. Everything else routable from the VPC — including the Postgres
-- container on the compose network — is the same one string away. So the
-- capability and its allow-list land together: there is no window in which a
-- custom provider exists without a default-deny egress gate in front of it.
--
-- WHY A FK COLUMN AND NOT AN ENCODED `provider` STRING. `agents.provider` is a
-- CLOSED vocabulary that model_credentials keys on (UNIQUE per provider),
-- usage_events records, the env-fallback allow-list enumerates, and
-- isModelProviderKind() switches over exhaustively. Encoding 'custom:<uuid>'
-- there would silently poison every one of those. Instead: `provider` gains the
-- single new literal 'custom', and WHICH custom endpoint lives in its own FK
-- column. The CHECK below makes the pair a real discriminated union so a row
-- can never be half-migrated in either direction.

CREATE TABLE "custom_model_providers" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "wire_protocol" text NOT NULL,
  "base_url" text NOT NULL,
  -- NULLABLE: a local Ollama / LocalAI endpoint has no API key, and inventing
  -- a placeholder would make "is this authenticated?" unanswerable.
  "key_ciphertext" text,
  "allow_plaintext_http" boolean DEFAULT false NOT NULL,
  -- inert until an admin runs the connection test and enables it
  "enabled" boolean DEFAULT false NOT NULL,
  "last_tested_at" timestamp with time zone,
  "last_test_error" text,
  "created_by" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "custom_model_providers_name_unique" UNIQUE("name"),
  CONSTRAINT "custom_model_providers_wire_protocol_ck"
    CHECK ("wire_protocol" IN ('openai_chat', 'anthropic_messages'))
);
--> statement-breakpoint
-- THE ALLOW-LIST. Default-deny by emptiness: this table starts with zero rows,
-- so on the day 0048 applies, no custom provider can reach anything at all.
-- Exact host match only — deliberately no wildcard column, because a
-- `*.example.com` entry is one dangling subdomain takeover away from being a
-- hole, and an operator who needs three hosts can add three rows.
CREATE TABLE "egress_allow_hosts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "host" text NOT NULL,
  -- the air-gapped escape hatch pillar 3 promises: lets THIS host resolve into
  -- an otherwise-blocked range (RFC1918 / loopback / link-local / CGNAT). Off
  -- by default, scoped to one host, and audited on write — never a blanket
  -- "allow private ranges". Does NOT relax the https requirement.
  "allow_private_ranges" boolean DEFAULT false NOT NULL,
  "allow_plaintext_http" boolean DEFAULT false NOT NULL,
  "note" text,
  "created_by" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "egress_allow_hosts_host_unique" UNIQUE("host"),
  -- storage-level normalization, so 'Metadata.Google.Internal.' and
  -- 'metadata.google.internal' can never become two different rows and the
  -- UNIQUE index above is genuinely case-insensitive uniqueness
  CONSTRAINT "egress_allow_hosts_host_normalized_ck"
    CHECK ("host" = lower("host") AND "host" NOT LIKE '%.' AND "host" !~ '[[:space:]@/]' AND length("host") > 0)
);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "custom_provider_id" uuid;
--> statement-breakpoint
-- RESTRICT, not cascade or set-null: an endpoint an agent still points at must
-- not be deletable out from under it, and a dispatch must never silently fall
-- back to "no endpoint". Deleting a custom provider is an explicit act that
-- fails loudly while any agent still references it.
ALTER TABLE "agents" ADD CONSTRAINT "agents_custom_provider_id_fk"
  FOREIGN KEY ("custom_provider_id") REFERENCES "custom_model_providers"("id") ON DELETE RESTRICT;
--> statement-breakpoint
-- The discriminated union, enforced by the database rather than by hope. Every
-- pre-0048 agent row has provider != 'custom' and custom_provider_id IS NULL,
-- so this validates against existing data with nothing to backfill.
ALTER TABLE "agents" ADD CONSTRAINT "agents_custom_provider_ck"
  CHECK (("provider" = 'custom') = ("custom_provider_id" IS NOT NULL));
--> statement-breakpoint
CREATE INDEX "agents_custom_provider_idx" ON "agents" ("custom_provider_id");
--> statement-breakpoint
-- ADR-0021 convention: a new org-wide functional choice gets an org_settings
-- dial. TRUE by default — the capability underneath it is already default-deny
-- four separate ways (admin-only registration, an empty egress allow-list,
-- enabled=false until a connection test passes, and the ordinary per-user agent
-- grant), so this is the "remove the capability entirely" switch, not the thing
-- standing between an org and an open proxy. An org that never registers a
-- custom provider sees no behaviour change either way.
ALTER TABLE "org_settings" ADD COLUMN "custom_model_providers_enabled" boolean DEFAULT true NOT NULL;
