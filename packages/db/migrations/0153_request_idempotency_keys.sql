-- ADR-0179 / AER-050 — idempotency keys for the intake's risk and
-- questionnaire-artifact writes.
--
-- POST /v1/use-cases already claims its Idempotency-Key in
-- `use_case_idempotency_keys` (migration 0134). The intake's later writes,
-- POST /v1/risks and POST /v1/workflows/instances/:id/artifacts, had none, so
-- a retry after a lost response wrote a second risk or a second questionnaire
-- version (an unintended review round). They claim their keys here, INSIDE the
-- transaction that writes the record, exactly as the use-case create does:
--   - `scope` names the route and its target (`risk`,
--     `workflow-artifact:<instanceId>`), so a key is never replayed against a
--     different route or instance;
--   - `request_digest` is the SHA-256 of the request the key was first used
--     with: the same key with a different request is refused, never replayed
--     as if it were the first one;
--   - `response` is the original response body, replayed for 30 days (the
--     intake draft's lifetime: the draft carries the key).
-- Keys are per caller (user_id). Additive: no existing row changes meaning.
CREATE TABLE IF NOT EXISTS "request_idempotency_keys" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "scope" text NOT NULL,
  "key" text NOT NULL,
  "request_digest" text NOT NULL,
  "response" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "request_idempotency_keys_key_check" CHECK (length("key") BETWEEN 1 AND 200)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "request_idempotency_keys_user_scope_key_uq" ON "request_idempotency_keys" ("user_id", "scope", "key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "request_idempotency_keys_created_idx" ON "request_idempotency_keys" ("created_at");
