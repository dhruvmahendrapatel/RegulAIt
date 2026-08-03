-- Migration 0053 (ADR-0038) — admin-defined IdP-group → RegulAIt-role mapping.
--
-- This migration is the bridge between "an external directory says this person
-- is in a group" and "this person holds a RegulAIt role". Everything about its
-- shape exists to keep that bridge DEFAULT-DENY and ADDITIVE:
--
--  * a group with no row in `group_role_mappings` confers NOTHING. There is
--    deliberately no "default role for unmapped groups" column anywhere below —
--    that would be a default-allow backdoor into pillar 1.
--  * the only thing a mapping can point at is a `roles` row. There is no path
--    from this table to `users.is_admin`: `isAdmin` is not a role, is not
--    referenced here, and stays an explicit admin-only flag.
--  * mapping enters the model at the `role_assignments` layer the kernel
--    already reads, so ADR-0013/0014 additive UNION-MAX composition and
--    ADR-0019 per-user revocations apply unchanged. A mapping can never mint an
--    entitlement a role does not carry.

-- The admin-curated many-to-many. `external_group` is the identifier as the IdP
-- asserts it: a SAML attribute value, an OIDC `groups` entry, or a synced
-- group's SCIM external id (falling back to its displayName when the connector
-- sent no externalId — RFC 7643 makes it optional, and the display name is then
-- the only stable identifier the IdP actually asserted).
--
-- UNIQUE(source, external_group, role_id) rather than UNIQUE(source,
-- external_group): one group MAY imply several roles (the union of their
-- baselines) and several groups MAY imply one role. `source` is part of the key
-- because "Engineering" asserted by SAML and "Engineering" synced by SCIM are
-- two different assertions from two different trust paths, and an admin must
-- opt into each on its own.
CREATE TABLE "group_role_mappings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "source" text NOT NULL,
  "external_group" text NOT NULL,
  "role_id" uuid NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "group_role_mappings_source_check" CHECK ("source" IN ('saml','oidc','scim'))
);
--> statement-breakpoint
ALTER TABLE "group_role_mappings" ADD CONSTRAINT "group_role_mappings_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "group_role_mappings_source_group_role_uq" ON "group_role_mappings" USING btree ("source","external_group","role_id");
--> statement-breakpoint
CREATE INDEX "group_role_mappings_source_group_idx" ON "group_role_mappings" USING btree ("source","external_group");
--> statement-breakpoint

-- PROVENANCE. `origin` says WHY a user holds a role: an admin assigned it
-- (`direct`) or a currently-mapped, currently-asserted group implies it
-- (`group`). DEFAULT 'direct' backfills every pre-0053 row as admin-direct,
-- which is exactly what they are — no group mapping existed to create them.
ALTER TABLE "role_assignments" ADD COLUMN "origin" text DEFAULT 'direct' NOT NULL;
--> statement-breakpoint
ALTER TABLE "role_assignments" ADD CONSTRAINT "role_assignments_origin_check" CHECK ("origin" IN ('direct','group'));
--> statement-breakpoint

-- THE "HELD BOTH WAYS" DECISION (ADR-0038 implementation amendment).
--
-- Before this migration the uniqueness was (user_id, role_id): a user could
-- hold a role exactly once, with no record of why. That is incompatible with a
-- reconciler, because the reconciler must be able to REMOVE a group-derived
-- assignment without any possibility of removing an admin's direct one — and
-- with a single row per (user, role) the two are literally the same row.
--
-- Two representations were available:
--   (a) widen the unique key to (user_id, role_id, origin) so a direct row and
--       a group row COEXIST as separate rows; or
--   (b) keep one row and "upgrade" its origin to `direct` when an admin also
--       assigns it, never reconciling it away afterwards.
--
-- (a) is chosen. It is the only one of the two in which losing an admin's
-- direct grant is structurally impossible rather than merely avoided by
-- correct code: the reconciler's DELETE is scoped `origin = 'group'`, so even a
-- wrong desired-set computation cannot touch a `direct` row — it is a different
-- row, not a different column value on the same row. (b) collapses the two
-- facts into one and makes "the admin later unassigns it" ambiguous (does it
-- revert to group-derived, or vanish while the group still implies it?);
-- worse, it makes an ordinary UPDATE the thing standing between an admin grant
-- and a sync, which is precisely the failure mode this ADR is guarding.
--
-- The cost of (a) is that a user may have two `role_assignments` rows for the
-- same role. Callers that ask "which roles does this user hold" take the SET of
-- role ids, which is unchanged; the kernel is unaffected because it never sees
-- assignments at all (it receives role-derived GRANTS pre-filtered by role id).
DROP INDEX IF EXISTS "role_assignments_user_role_uq";
--> statement-breakpoint
CREATE UNIQUE INDEX "role_assignments_user_role_origin_uq" ON "role_assignments" USING btree ("user_id","role_id","origin");
--> statement-breakpoint
CREATE INDEX "role_assignments_user_origin_idx" ON "role_assignments" USING btree ("user_id","origin");
--> statement-breakpoint

-- WHICH claim/attribute carries groups, per provider. NULL on both (the
-- default, and every pre-0053 row) means this provider emits NO group signal at
-- all, so a login through it never reconciles anything. Naming the claim is an
-- explicit admin act, exactly like naming the email attribute.
ALTER TABLE "oidc_providers" ADD COLUMN "groups_claim" text;
--> statement-breakpoint
ALTER TABLE "saml_providers" ADD COLUMN "groups_attribute" text;
--> statement-breakpoint

-- The "unmapped asserted groups" report (ADR-0038 honest-risk #3: group-name
-- drift in the IdP silently breaks a mapping — it becomes unmapped, which is
-- the SAFE direction, but access disappears and nobody knows why).
--
-- One row per (source, external_group) ever seen in a sync or a login, with
-- first/last sighting and how many times. It records SIGHTINGS ONLY and grants
-- nothing — it is the sync-status affordance that lets an admin see "your IdP
-- has been asserting 'Engineering-EMEA' 400 times a day and nothing is mapped
-- to it".
CREATE TABLE "asserted_groups" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "source" text NOT NULL,
  "external_group" text NOT NULL,
  "first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
  "seen_count" integer DEFAULT 1 NOT NULL,
  CONSTRAINT "asserted_groups_source_check" CHECK ("source" IN ('saml','oidc','scim')),
  CONSTRAINT "asserted_groups_source_group_uq" UNIQUE("source","external_group")
);
