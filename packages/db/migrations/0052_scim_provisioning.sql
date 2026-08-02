-- Migration 0052 (ADR-0037) — SCIM 2.0 provisioning (Users + Groups) with
-- deactivate-never-delete deprovisioning.
--
-- The load-bearing property of this migration is what it does NOT add: there
-- is no hard-delete path for a user anywhere in it. SCIM's `DELETE /Users/:id`
-- and its `PATCH active:false` both land on the column ADR-0022 already
-- created — `users.disabled_at` — so an IdP offboarding a human keeps every
-- FK, audit row, cost event and provenance record intact and stays reversible.
-- No table below has a foreign key into users with ON DELETE anything other
-- than cascade-from-a-group, because no user row is ever deleted.

-- The per-IdP bearer credential. Deliberately the api_keys shape, field for
-- field: a 256-bit random token whose sha256 is the ONLY thing stored, minted
-- and shown exactly once, revocable, with a last_used_at that makes "is this
-- integration actually running?" answerable. It is a DISTINCT trust path from
-- users: a leaked SCIM token grants provisioning power and no user identity,
-- and rotating it touches no human account.
CREATE TABLE "scim_tokens" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "token_hash" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_used_at" timestamp with time zone,
  "revoked_at" timestamp with time zone,
  CONSTRAINT "scim_tokens_name_unique" UNIQUE("name"),
  CONSTRAINT "scim_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
-- The inbound group sync surface. `external_id` is the IdP's own id for the
-- group and is what a replayed full sync converges on.
--
-- It is NULLABLE-but-UNIQUE rather than NOT NULL: not every connector sends
-- `externalId` on a group create (it is optional in RFC 7643), and inventing
-- one — from the display name, say — would fabricate an identity the IdP never
-- asserted and then silently collide two differently-named-but-same-titled
-- groups. Postgres treats NULLs as distinct in a unique index, so groups
-- without an external id simply live under their RegulAIt id, while every
-- group that HAS one can only exist once.
--
-- A row here grants NOTHING. It records what the IdP says; the mapping of a
-- group onto a RegulAIt role is admin-defined, default-deny, and is ADR-0038.
CREATE TABLE "scim_groups" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "external_id" text,
  "display_name" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "scim_groups_external_id_unique" UNIQUE("external_id")
);
--> statement-breakpoint
-- Membership. UNIQUE(group_id, user_id) is what makes a replayed full-org sync
-- converge instead of duplicating: the reconciler computes deltas, and the
-- index is the backstop if two syncs race.
--
-- ON DELETE cascade on group_id: deleting a synced group removes its
-- membership records (a group is inbound sync state, not an identity).
-- ON DELETE cascade on user_id is structural only — no code path deletes a
-- user row (ADR-0022), and SCIM deprovisioning explicitly does not.
CREATE TABLE "scim_group_members" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "group_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "scim_group_members_group_user_uq" UNIQUE("group_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "scim_group_members" ADD CONSTRAINT "scim_group_members_group_id_scim_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."scim_groups"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "scim_group_members" ADD CONSTRAINT "scim_group_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "scim_group_members_user_idx" ON "scim_group_members" USING btree ("user_id");
--> statement-breakpoint
-- The IdP's own id for the USER. ADR-0037's honest-risk #3: email is the join
-- key, so an IdP that changes someone's primary email would otherwise create a
-- second account. Persisting the external SCIM id lets a connector correlate
-- by id first and re-map the email on the existing row instead.
--
-- Nullable, and unique only among non-null values: every pre-0052 user (and
-- every locally-created one) has none, and none was invented for them.
ALTER TABLE "users" ADD COLUMN "scim_external_id" text;
--> statement-breakpoint
CREATE UNIQUE INDEX "users_scim_external_id_uq" ON "users" USING btree ("scim_external_id");
