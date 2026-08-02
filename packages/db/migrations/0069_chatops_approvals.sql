-- Migration 0069 (ADR-0061) — CHATOPS APPROVALS.
--
-- WHAT IS NOT HERE, AND THAT IS THE WHOLE POINT
--
--   There is no chat_approvals table, no chat_decisions table, no second
--   status column. A ChatOps decision is written by the SAME
--   `decideOneApproval` the portal calls, into the SAME `approvals` row, with
--   `decided_by` = the mapped RegulAIt human. The chat surface is a COURIER
--   (ADR-0061 §2), never a second authority path, and the schema is what makes
--   that structural rather than a promise: there is nowhere else for a decision
--   to be recorded.
--
--   Everything below is therefore about (a) which workspace we may talk to,
--   (b) WHICH HUMAN a chat identity is, (c) what we posted, and (d) making a
--   double-click a no-op.
--
-- ------------------------------------------------------------------------
-- chatops_connections — the workspace, and the two secrets it needs
-- ------------------------------------------------------------------------
--
-- THE OUTBOUND CREDENTIAL IS NOT STORED HERE. `connector_id` points at an
-- ordinary `connectors` row with its ordinary `connector_credentials` bot
-- token, so the Slack bot token rides the SAME encrypted-at-rest, write-only,
-- never-returned credential store as every other secret in the deployment and
-- the SAME `packages/connector-provider` adapter does the posting. Inventing a
-- second Slack integration would have meant a second credential store to
-- rotate and a second adapter to keep in step with Slack's error envelope.
--
-- WHAT GENUINELY DOES NOT EXIST ANYWHERE ELSE is the INBOUND signing secret:
-- the connector machinery models credentials we PRESENT, and this is a secret
-- we VERIFY WITH. It is encrypted under REGULAIT_DATA_KEY exactly like the
-- others and no endpoint ever returns it — a signing secret that could be read
-- back would let a reader forge callbacks, which is strictly worse than a bot
-- token being read back.
--
-- `allow_fenced_decide` IS THE SENSITIVITY DIAL ADR-0061 ASKS FOR. "A chat tap
-- is a weaker authentication act than an in-app authenticated session … make
-- chat-decide allowed per approval sensitivity, admin-configurable, defaulting
-- the most sensitive classes to in-app-only." DEFAULT FALSE is that default: an
-- approval whose project is in PII mode `block` posts a LINK with no buttons
-- unless an admin has deliberately opted this workspace in.
--
-- AIR-GAPPED (§8.5) NEEDS NO COLUMN. Slack/Teams require outbound egress; an
-- air-gapped install has none, so the ADR-0034 guard refuses the post and the
-- feature degrades to in-app only. That is the correct behaviour arriving for
-- free from the guard, not a mode flag somebody has to remember to set.

CREATE TABLE "chatops_connections" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL UNIQUE,
  "provider" text NOT NULL,
  -- the ordinary connector whose ordinary credential holds the bot token
  "connector_id" uuid NOT NULL REFERENCES "connectors"("id") ON DELETE CASCADE,
  -- the INBOUND secret: what we verify callbacks with. Encrypted under
  -- REGULAIT_DATA_KEY; never returned by any endpoint.
  "signing_secret_ciphertext" text NOT NULL,
  "default_channel" text NOT NULL,
  -- the sensitivity dial; FALSE = fenced approvals are in-app only
  "allow_fenced_decide" boolean DEFAULT false NOT NULL,
  "enabled" boolean DEFAULT true NOT NULL,
  "created_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "chatops_connections_provider_ck" CHECK ("provider" IN ('slack', 'teams'))
);

-- ------------------------------------------------------------------------
-- chat_identity_links — WHICH HUMAN, and the reason this table is the crux
-- ------------------------------------------------------------------------
--
-- ADR-0061 states the hard part up front: a Slack interaction arrives under the
-- BOT's connection carrying a Slack user id. Record that naively and the audit
-- says a bot approved a production change. The Slack user id is an ASSERTION to
-- be MAPPED; this table is the mapping, and it is ADMIN-MANAGED — never
-- self-asserted, because a self-serve "this is me" claim would let anyone in the
-- workspace bind themselves to any approver.
--
-- TWO UNIQUE INDEXES, BOTH LOAD-BEARING:
--   (connection_id, chat_user_id)  one chat identity cannot map to two humans —
--                                  otherwise "who decided?" has two answers.
--   (connection_id, user_id)       one human cannot be reachable through two
--                                  chat identities on one workspace, which
--                                  would make revoking a compromised chat
--                                  account insufficient.
--
-- `email_verified_source` IS AN HONESTY COLUMN. The ADR wants the link bound to
-- an IdP-verified email. When the deployment has SSO and the user carries an
-- external identity, the link records `idp`. When it does not, the link is what
-- an admin asserted and records `admin_asserted` — visibly weaker, rather than
-- claiming a verification that did not happen. The API refuses a link whose
-- email does not match an existing user's email either way: the admin cannot
-- invent a principal, only bind an existing one.

CREATE TABLE "chat_identity_links" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "connection_id" uuid NOT NULL REFERENCES "chatops_connections"("id") ON DELETE CASCADE,
  -- the chat provider's id for the human (Slack U…, Teams aadObjectId)
  "chat_user_id" text NOT NULL,
  -- the email the binding was made through, kept so an auditor can see WHY
  "chat_user_email" text NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "email_verified_source" text NOT NULL,
  "created_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "chat_identity_links_verified_ck"
    CHECK ("email_verified_source" IN ('idp', 'scim', 'admin_asserted'))
);
CREATE UNIQUE INDEX "chat_identity_links_chat_user_uq"
  ON "chat_identity_links" ("connection_id", "chat_user_id");
CREATE UNIQUE INDEX "chat_identity_links_user_uq"
  ON "chat_identity_links" ("connection_id", "user_id");

-- ------------------------------------------------------------------------
-- chatops_messages — what we posted, and whether it was redacted
-- ------------------------------------------------------------------------
--
-- The mirror record, in the ADR-0010/0027 lineage where an external system is a
-- COURIER for an approval and never its authority. `redacted` records that the
-- sensitivity fence fired and the card carried a link instead of the content —
-- which is exactly the question a compliance reviewer asks about a third-party
-- chat workspace, and it must be answerable without re-reading Slack.

CREATE TABLE "chatops_messages" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "connection_id" uuid NOT NULL REFERENCES "chatops_connections"("id") ON DELETE CASCADE,
  "approval_id" uuid NOT NULL REFERENCES "approvals"("id") ON DELETE CASCADE,
  "channel" text NOT NULL,
  -- the provider's handle for the posted message, so the card can be edited
  -- down to "Approved by Dana" and its buttons retired
  "message_ref" text,
  -- TRUE = the fence fired: a link went to chat, the content did not
  "redacted" boolean DEFAULT false NOT NULL,
  -- FALSE = posted without buttons (fenced + not opted in): in-app only
  "decidable" boolean DEFAULT true NOT NULL,
  "posted_at" timestamp with time zone DEFAULT now() NOT NULL,
  "retired_at" timestamp with time zone
);
CREATE INDEX "chatops_messages_approval_idx" ON "chatops_messages" ("approval_id");

-- ------------------------------------------------------------------------
-- chatops_interactions — the idempotency record
-- ------------------------------------------------------------------------
--
-- WHY A TABLE AND NOT JUST THE STATUS MACHINE. The status machine already makes
-- a double-decide impossible: `decideOneApproval` updates WHERE status =
-- 'pending', so the second click cannot change anything. But "cannot change
-- anything" is not the whole requirement — a second click must also not write a
-- SECOND audit row, or a double-tap on a flaky phone connection becomes two
-- entries in the record of who decided what. The unique index below makes the
-- second callback resolve to the FIRST one's recorded outcome, and the route
-- returns it without touching the approval and without auditing again.
--
-- ONLY SUCCESSFUL DECISIONS ARE RECORDED HERE. A refusal (unmapped chat user,
-- not the named approver) deliberately does NOT get an idempotency row: it must
-- be audited EVERY time, because repeated attempts by an unentitled principal
-- are the signal, and because an admin who then creates the missing identity
-- link must be able to have the person click again.
--
-- `approval_id` CARRIES NO FOREIGN KEY on purpose: the record of "this chat
-- identity decided this approval" outlives the approval row's own retention.

CREATE TABLE "chatops_interactions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "connection_id" uuid NOT NULL REFERENCES "chatops_connections"("id") ON DELETE CASCADE,
  "approval_id" uuid NOT NULL,
  "chat_user_id" text NOT NULL,
  "action" text NOT NULL,
  -- the RegulAIt human the chat identity mapped to — never the bot
  "decided_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "outcome" text NOT NULL,
  "detail" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "chatops_interactions_action_ck" CHECK ("action" IN ('approve', 'reject')),
  CONSTRAINT "chatops_interactions_outcome_ck"
    CHECK ("outcome" IN ('decided', 'already_decided'))
);
-- THE DOUBLE-CLICK GUARD: one recorded interaction per
-- (connection, approval, chat identity, action). The second insert conflicts,
-- and the route answers from the first row.
CREATE UNIQUE INDEX "chatops_interactions_idem_uq"
  ON "chatops_interactions" ("connection_id", "approval_id", "chat_user_id", "action");
CREATE INDEX "chatops_interactions_approval_idx" ON "chatops_interactions" ("approval_id");
