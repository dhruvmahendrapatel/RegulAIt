<!-- fold: state-recap -->
**2026-11-21 - lane E26, jurisdiction admin APIs, slice 3b ([ADR-0345](../decisions/0345-agent-risk-control-proof-registry.md) §9).**
Admins can now edit the geography data:
- jurisdictions;
- their obligations, each citing a live ADR-0158 feed entry for that jurisdiction;
- a use case's declared jurisdictions.

Every narrowing needs a `settings_relax` step-up and is audited. That covers removing a jurisdiction or an obligation,
lowering a tier floor, dropping a parent or the global flag, and any declaration change that drops scope. A use case's
first declaration counts too, because an undeclared use case is in every jurisdiction. This closes #1036 (`code`
immutable) and #1037 (feed key validated). No new tables or migrations.
