# ADR-0038: Admin-defined IdP-group → RegulAIt-role mapping (default-deny, additive)

- **Status**: Accepted
- **Date**: 2026-08-01
- **Implemented**: 2026-08-02 (migration 0053) — see the amendment at the end.

## Context

Federated identity brings **group** information with it: SAML assertions carry group/role
attributes, OIDC id_tokens can carry a `groups` claim, and SCIM (ADR-0037) syncs `/Groups` and
their membership as first-class records. Enterprises expect their existing directory structure —
"Engineering", "Finance-Readonly", "SOC-Admins" — to drive RegulAIt entitlements so they manage
access in one place (the IdP) rather than re-granting per user inside every SaaS tool.

But an IdP group is an **assertion by an external system**, and RegulAIt's whole thesis (pillar 1)
is default-deny, per-user-precise governance where a role sets a *baseline* and per-user overrides
layer on top. Two forces collide:
- We want directory-driven role assignment at scale (the convenience layer GOVERNANCE_LAYER_SPEC
  §5 explicitly calls for: "groups (synced via SCIM) can drive role assignment at scale").
- We must not let an IdP's group membership silently *become* a grant, nor let it override the
  precise per-user layer, nor grant anything an admin didn't consciously map. An unmapped or
  unknown group must confer exactly nothing.

RegulAIt's entitlement composition is already settled and must be honored, not bypassed:
`role_assignments` sets baselines; ADR-0013/0014's **additive UNION-MAX** semantics mean assigning
a role only ever *adds* reach (a narrow direct grant can never mask a broader role grant); and
ADR-0019's per-user **revocations** are the only subtractive override, consulted strictly on the
allow path so they can only ever turn an allow into a deny. Any group-mapping design has to slot
*into* this model at the `role_assignments` layer — not invent a parallel entitlement path.

## Decision

Add an admin-defined **group → role mapping** layer that turns IdP-asserted group membership into
`role_assignments`, default-deny, purely additive, and subordinate to the existing per-user layer.

**The mapping table.** A new `group_role_mappings` table:
- `id`, `source` (`saml` | `oidc` | `scim`), `external_group` (the group identifier as the IdP
  asserts it — SAML attribute value, OIDC `groups` entry, or `scim_groups` external id),
  `role_id` (FK to `roles`, `ON DELETE CASCADE`), `created_at`.
- Unique on `(source, external_group, role_id)`. One group **may** map to several roles (union of
  their baselines) and several groups may map to one role — a many-to-many an admin curates.
- Admin-CRUD'd under the default admin gate; audited as a new `group_role_mapping` `objectType`.

**Default-deny is the core invariant.** A group that has **no** row in `group_role_mappings`
grants **nothing** — no implicit role, no fallback. This is non-negotiable and mirrors OIDC/SAML
JIT default-deny and the kernel's default-deny: presence in a directory group is not access;
only an admin's explicit mapping is. An IdP can therefore add someone to a group without that
having *any* effect in RegulAIt until an admin decides it should. There is deliberately no
"default role for unmapped groups" setting — that would be a default-allow backdoor.

**Reconciliation, not accumulation.** On each identity event that carries authoritative group
membership — a SAML/OIDC login (from the assertion's groups) and every SCIM group-membership sync
— the gateway computes the set of roles the user's *currently-asserted, currently-mapped* groups
imply, and reconciles the user's **group-derived** role assignments to exactly that set:
- Roles newly implied → insert `role_assignments` (idempotent, `onConflictDoNothing`).
- Roles no longer implied (group removed in the IdP, or mapping deleted) → remove the
  **group-derived** assignment.
This means losing a group in the IdP *loses* the corresponding baseline on the next sync/login —
directory changes propagate in both directions, which is the point of IdP-driven access.

**Provenance: group-derived vs. admin-direct assignments must be distinguishable.** A user can
hold a role because an admin assigned it *or* because a group mapping implied it, and the two must
not clobber each other. `role_assignments` gains an `origin` column (`direct` | `group`, default
`direct` so every existing row is admin-direct). Reconciliation only ever touches `origin='group'`
rows; an admin's `origin='direct'` assignment is **never** removed by a sync, and a group that
stops implying a role an admin *also* assigned directly leaves the direct assignment intact. This
is the precedence rule, stated plainly: **group mappings and admin-direct assignments both add to
the baseline; neither removes the other.**

**Composition with ADR-0013/0014 additive UNION-MAX.** Group-derived roles enter the model at
exactly the `role_assignments` layer the kernel already reads — the policy kernel
(`packages/policy-kernel`) sees no new concept: it still evaluates role-derived grants for the
union of a user's assigned roles, whatever put those assignments there. So:
- Group mapping is **additive-only** — it can grant a baseline via a role, never exceed what that
  role's grants express, and never mint an entitlement a role doesn't carry. Consistent with
  UNION-MAX, adding a group-derived role only ever adds reach.
- The **per-user layer still wins where it is meant to.** ADR-0019 per-user **revocations** are
  consulted on the allow path and beat both direct and role grants — so an admin can carve one
  user out of an entitlement *even if a group mapping keeps re-adding the role*. The revocation is
  the precise, per-user, subtractive override; the group mapping is the coarse, directory-driven,
  additive baseline. They coexist exactly as direct grants and revocations already do.
- **Admin never assertable**: no group maps to admin. `isAdmin` is not a role and not
  group-derivable — it stays an explicit, audited, admin-only flag, same as SSO/SCIM JIT already
  guarantees. A "SOC-Admins" group can be mapped to a *role* with broad grants, but never to the
  platform `isAdmin` bit.

**Audit.** Every reconciliation writes to the single audit log: which identity event triggered it,
the asserted groups, the mappings that fired, and each `role_assignments` insert/remove with its
`origin`. "Why does this user have this role?" resolves to either an admin action or a named
group+mapping — the Simulation/access-preview surface (GOVERNANCE_LAYER_SPEC §5) can then show
provenance, not just the effective set.

## Consequences

- **Easier**: enterprises manage RegulAIt access from their IdP directory at scale — put someone
  in "Finance-Readonly", they get the mapped role's baseline on next login/sync; remove them, it's
  gone. Works uniformly across SAML, OIDC, and SCIM because the mapping keys on `(source,
  external_group)` and all three feed the same reconciliation.
- **Invariants preserved, not weakened**: default-deny (unmapped/unknown group = nothing), additive
  UNION-MAX (a mapping only adds a role's reach), and the per-user override layer (ADR-0019
  revocations still beat a group-implied role) all hold. Group mapping is a *convenience layer over*
  the existing model, exactly as the spec framed it — never a replacement for or an escape from it.
- **Deliberately given up**: attribute-value-based mapping beyond group membership (e.g. mapping on
  an arbitrary `department` SAML attribute, or ABAC-style conditions) is **out of scope** — that is
  ADR-0040's attribute layer, not this coarse group→role bridge. This ADR maps *groups to roles*,
  full stop.
- **Honest risks**: (1) reconciliation that *removes* group-derived roles means an IdP outage or a
  malformed assertion dropping the `groups` claim could transiently strip access — mitigated by
  reconciling **only** from authoritative sources (a login assertion that omits groups entirely is
  treated as "no group signal, don't reconcile" rather than "user is in zero groups", to avoid a
  missing-claim mass-deprovision; the exact rule is a fail-safe-toward-current-state choice that
  must be nailed down per source in implementation); (2) an admin who maps a group to an
  over-broad role has effectively delegated that grant to whoever administers the IdP group —
  surfaced in access-preview so the blast radius of a mapping is visible before it's saved;
  (3) group-name/id drift in the IdP silently breaks a mapping (it becomes unmapped → default-deny,
  the safe direction, but access disappears) — sync status should flag asserted groups that match
  no mapping.
- **Follow-up work**: migration for `group_role_mappings` and the `role_assignments.origin` column;
  the reconciliation routine wired into the SAML/OIDC callbacks and the SCIM group-sync handler;
  the `group_role_mapping` audit objectType; admin-portal mapping CRUD with an "unmapped asserted
  groups" report; and extending Simulation to show role provenance (direct vs. which group mapping).

---

## Implementation amendment — 2026-08-02 (migration 0053)

Landed as decided. Three things the ADR left to implementation are settled here.

### 1. "Held both ways": a composite unique key, not an origin upgrade

`role_assignments` already carried `UNIQUE(user_id, role_id)` — one row per (user, role), with
no record of *why*. That is incompatible with a reconciler, because "remove the group-derived
assignment" and "remove the admin's assignment" would be the same row.

Two representations were available:

- **(a)** widen the unique key to `(user_id, role_id, origin)` so a `direct` row and a `group` row
  **coexist as separate rows**; or
- **(b)** keep one row and *upgrade* its `origin` to `direct` when an admin also assigns it, never
  reconciling it away afterwards.

**(a) is what shipped.** It is the only one of the two in which losing an admin's direct grant is
*structurally impossible* rather than merely avoided by correct code: the reconciler's `DELETE` is
scoped `origin = 'group'`, so even a wrong desired-set computation cannot touch a `direct` row — it
is a **different row**, not a different column value on the same row. (b) collapses two independent
facts into one, makes "the admin later unassigns it" ambiguous (revert to group-derived, or vanish
while the group still implies it?), and puts an ordinary `UPDATE` between an admin's grant and a
sync, which is exactly the failure mode this ADR exists to prevent.

The cost is that a user may hold two `role_assignments` rows for one role. Callers that ask "which
roles does this user hold" take the **set** of role ids (deduplicated in `loadEntitlements`,
`loadScopeMemberships` and the two role-bundled-grant loaders); the policy kernel is unaffected
because it never sees assignments at all — it receives role-derived *grants* pre-filtered by role
id. `DELETE /v1/users/:id/roles/:roleId` now removes the **admin-direct row only** and answers 409
`role_group_derived` when the role is held solely via a mapping, pointing at the two things that
actually work (remove the mapping, or an ADR-0019 revocation) instead of a delete the next sync
would silently undo.

### 2. The missing-claim fail-safe, as implemented

The ADR flagged this as "must be nailed down per source". The rule, implemented once in
`normalizeAssertedGroups` so all three sources cannot drift apart:

| what the identity event carries | interpretation | effect |
| --- | --- | --- |
| provider has no `groups_claim` / `groups_attribute` configured | no group signal | **no reconciliation** |
| the configured claim/attribute is **absent** from this assertion | no group signal | **no reconciliation** — existing group-derived roles survive |
| an unparseable value (a number, an object) | malformed assertion | **no reconciliation** (fail toward current state) |
| an **empty array** (OIDC), or an attribute present with an empty value (SAML) | authoritative "member of nothing" | **reconciles to zero** group-derived roles |
| a non-empty array / string / delimited string | authoritative membership | **reconciles to exactly that set** |
| SCIM group membership | always authoritative (it is stored state written by a sync, not a per-event assertion) | **reconciles**, including to zero |

The null-vs-empty distinction is a type at the boundary (`string[] | null`), not an empty-array
coincidence, and both branches are asserted by test. An IdP that drops the claim during an incident
cannot strip an organisation's access; an IdP that genuinely says "member of nothing" is believed.

One honest SAML limitation, documented rather than papered over: an `<Attribute>` element with
*zero* `<AttributeValue>` children does not survive XML→object parsing as an empty value and is
indistinguishable from an absent attribute, so it falls to the fail-safe (no signal). The shape a
real IdP emits for "member of nothing" — an attribute present with an empty value — **is**
distinguished, via a `hasOwnProperty` check rather than a `!== undefined` check.

### 3. What shipped

- **Migration 0053** (`0053_group_role_mapping`): `group_role_mappings` (source/external_group/
  role_id → `roles` `ON DELETE CASCADE`, `UNIQUE(source, external_group, role_id)`);
  `role_assignments.origin` (`direct` | `group`, **DEFAULT `direct`** so every pre-0053 row is
  admin-direct) with the unique index widened to `(user_id, role_id, origin)`;
  `oidc_providers.groups_claim` and `saml_providers.groups_attribute` (both nullable, NULL = no
  group signal); `asserted_groups`, a sightings log backing the "unmapped asserted groups" report.
- **The reconciler** (`apps/gateway/src/group-roles.ts`) — one routine, used by the SCIM
  membership handler, the OIDC callback and the SAML ACS. It reads `group_role_mappings` and
  writes `role_assignments` and `audit_log`, and nothing else; it never writes a `users` row and
  never names `isAdmin`, which a test asserts **structurally** (comments stripped) so the claim is
  "there is no code path" rather than "the path is never taken". The admin CRUD deliberately lives
  in a separate file for exactly that reason.
- **Admin surface**: `GET/POST/DELETE /v1/group-role-mappings`,
  `GET /v1/group-role-mappings/asserted-groups` (the unmapped-group report), and
  `GET /v1/users/:id/role-provenance` (`direct` | `group` | `both`, naming the mapping);
  `origin` added to `GET /v1/roles/:id/assignments`; the SPA gains an admin
  *Group → role mapping* screen with the unmapped-groups report, and the SSO screen gains the
  claim/attribute fields. `/v1/scim/status` replaces the now-misleading
  `groupsGrantEntitlement: false` with `unmappedGroupsGrantEntitlement: false`,
  `isAdminGroupDerivable: false` and a `mappedGroups` count.
- **Audit**: one `group_role_mapping` row per reconciliation naming the triggering identity event,
  the asserted groups, the unmapped ones, the mappings that fired, and every insert/remove with its
  origin — plus rows for admin create/delete of a mapping.
- **The policy kernel needed no change**, as the ADR predicted: it reads role-derived grants
  pre-filtered by role id and has never known where an assignment came from.
- **29 e2e tests** (`group-role-mapping.test.ts`) covering all three sources, both fail-safe
  branches, the never-remove-a-direct-assignment invariant, revocation-beats-mapping, the
  additive-only ceiling, mapping deletion, and the two isAdmin proofs.
