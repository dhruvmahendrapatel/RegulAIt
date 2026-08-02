# ADR-0038: Admin-defined IdP-group → RegulAIt-role mapping (default-deny, additive)

- **Status**: Proposed
- **Date**: 2026-08-01

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
