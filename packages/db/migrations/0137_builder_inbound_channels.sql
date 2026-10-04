-- ADR-0173 §2 — inbound channels: a Slack or Teams message reaches a builder agent.
--
-- Nothing here grants authority. A message arrives under the BOT's connection
-- carrying a chat user id (an assertion); it becomes a RegulAIt human only
-- through the admin-made `chat_identity_links` row, and the turn then runs as
-- that human through the ordinary governed builder runtime.
--
--   builder_agent_channels.external_channel_id
--                             the platform channel an ADMIN routes to this
--                             agent (Slack channel id / Teams conversation id).
--                             NULL = connection-wide: it answers mentions and
--                             direct messages anywhere on the connection, but
--                             only while it is the ONLY connection-wide binding
--                             there (ambiguity is refused politely at run time).
--                             At most one agent per connection + channel.
--   builder_channel_threads   (connection, channel, platform thread, person) ->
--                             builder thread. Per PERSON: a builder thread is
--                             personal, so two people in one Slack thread each
--                             converse with the agent as themselves.
--                             reply_target / reply_thread_ref / link_origin:
--                             where a LATER reply goes (a paused turn resumed
--                             from the web app or by an approval decision) and
--                             the public origin its links are built on — from
--                             the newest message of the conversation.
--   builder_channel_events    the de-duplication record: one row per platform
--                             delivery (Slack event_id / Teams activity id) and
--                             per message, so a retry, a replay inside the
--                             window, or Slack's paired message + app_mention
--                             events run one turn, not several. Pruned after a
--                             day (platform retries stop within the hour).
ALTER TABLE "builder_agent_channels" ADD COLUMN IF NOT EXISTS "external_channel_id" text;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "builder_agent_channels_route_uq"
  ON "builder_agent_channels" ("chatops_connection_id", "external_channel_id")
  WHERE "chatops_connection_id" IS NOT NULL AND "external_channel_id" IS NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "builder_channel_threads" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "connection_id" uuid NOT NULL REFERENCES "chatops_connections"("id") ON DELETE CASCADE,
  "external_channel_id" text NOT NULL,
  "external_thread_id" text NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "agent_id" uuid NOT NULL REFERENCES "builder_agents"("id") ON DELETE CASCADE,
  "builder_thread_id" uuid NOT NULL REFERENCES "builder_threads"("id") ON DELETE CASCADE,
  "reply_target" text,
  "reply_thread_ref" text,
  "link_origin" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "builder_channel_threads_uq"
  ON "builder_channel_threads" ("connection_id", "external_channel_id", "external_thread_id", "user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "builder_channel_threads_thread_idx" ON "builder_channel_threads" ("builder_thread_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "builder_channel_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "connection_id" uuid NOT NULL REFERENCES "chatops_connections"("id") ON DELETE CASCADE,
  "external_event_id" text NOT NULL,
  "message_key" text NOT NULL,
  "retry_num" integer,
  "received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "builder_channel_events_event_uq" ON "builder_channel_events" ("connection_id", "external_event_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "builder_channel_events_message_uq" ON "builder_channel_events" ("connection_id", "message_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "builder_channel_events_received_idx" ON "builder_channel_events" ("received_at");
