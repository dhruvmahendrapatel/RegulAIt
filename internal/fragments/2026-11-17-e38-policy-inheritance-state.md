<!-- fold: state-recap -->

**2026-11-17 - lane E38 slice 2: tighten-only policy inheritance ([ADR-0357](../decisions/0357-governance-config-as-code-and-policy-inheritance.md) §4, branch `builder/e38-policy-inheritance`).**
- **New:** `business_units` (and `projects.business_unit_id`) plus `governance_policy_layers`, one layer per org,
  business unit, project or use case (the pending `governance_policy_layers` migration, admin-only RLS).
- **Merge table:** declared once in `@regulait/shared` (`POLICY_RULES`) and tested row by row: allow-lists intersect,
  deny-lists unite, ceilings take the minimum, floors the maximum, required flags OR, and ordered levels take the
  stricter end.
- **Tighten-only:** a child layer that would widen its parent is refused with `400 policy_widens_parent`, which names
  each rule.
- **Relaxation step-up:** a `settings_relax` step-up is needed to loosen a layer against its own previous self, to
  remove a layer, or to move a project to a looser parent.
- **Effective view:** `GET /v1/governance-policy/effective` returns each rule's value and `setBy`, in a stable shape.
- **Not yet enforced at call time:** the decision core does not read the effective policy yet; that is a PENDING item.
