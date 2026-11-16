# ADR-0289: The PM project / work-item importer (ADR-0054 §3)

- **Status**: Accepted (builder lane L6, 2026-11-14; closes ADR-0054 "Deviation 3" in two slices)
- **Date**: 2026-11-14
- **Index**: PM project / work-item importer: dry-run by default, apply-what-was-previewed, linkage only onto an Initiative (ADR-0054 §3)
- **Amends**: [ADR-0054](0054-onboarding-migration.md) §3 by building its third importer, and
  [ADR-0010](0010-pm-inbound-sync-webhooks-plus-read-through.md) by adding an optional adapter read (`listWorkItems`).
- **Migration**: `pending/pm_work_item_import.sql` (numbered at merge).

## Context

ADR-0054 §3 names three importers. Users and group→role mappings shipped. The PM project / work-item importer did not:
its "Deviation 3" says the importer needs a bulk/dry-run/reconcile layer over the ADR-0010 adapters, and that a
half-reconciling importer would be worse than none. Pillar 8 also requires the PM tool to stay the source of truth,
so the task graph lands on the customer's real work items, never a shadow copy.

Open-source check (ADR-0176): the vendor SDKs (jira.js, azure-devops-node-api, @linear/sdk, asana, monday's GraphQL)
list items, but the adapters already talk to each tool through our governed fetch and egress guard, and adding five
SDKs only for a list call would add a second network path beside the guarded one. The reconcile, dry-run and
evidence logic is RegulAIt's own governance surface, so it is the "genuinely RegulAIt" exception.

## Decision

1. **Linkage only.** For each work item in a connection's project the importer records `external_id`, `external_url`
   and `item_type` in `pm_imported_work_items`. It stores no title, state or field: those are read through live, as
   for `pm_links`. The connection's project is mapped to an Initiative in `pm_project_initiatives`, one row per
   connection. Both tables are in third normal form, and a reference is always a foreign key.
2. **Dry run by default** (ADR-0180). `POST /v1/onboarding/imports/pm` with no `mode` previews: it writes only the
   `onboarding_imports` row (kind `pm_work_items`) and an audit row. The plan has counts for `listed`, `add`,
   `update` (url or type changed), `reappeared`, `unchanged`, `missing` and `stillMissing`. It names the initiative
   action (`create`, `map`, `remap` or `unchanged`), lists up to 100 entries per action, and gives a `planSha256`
   over the **whole** plan.
3. **Apply is what was previewed.** `mode: "apply"` requires the dry run's `planSha256`. The plan is recomputed under
   a `FOR UPDATE` lock on the connection row. A different plan is a 409 `plan_changed` that carries the new plan, is
   audited, and writes nothing. A concurrent create of the same Initiative name counts as a changed plan.
4. **Reconcile, never delete.** Re-running adds new items, updates changed url or type, marks an item the tool no
   longer lists with `missing_since`, and clears that mark when the item re-appears. An import never deletes linkage.
5. **All or nothing.** These are refused whole, recorded as a `refused` import, and audited:
   - a listing longer than `maxItems` (default 1,000, at most 10,000), because a partial listing would mark real
     items missing;
   - an item whose id, type or url fails the bounds (url must be http(s), or `mock-pm:` on the mock);
   - a duplicated id or a repeating cursor;
   - an adapter with no `listWorkItems`.
6. **Governed reads.** The listing runs through `providerFor`: the egress guard for a custom base URL, the
   compiled-default posture otherwise, and the external-effects wrapper classifying it as a read. Both routes are
   admin-only through the default gate and tagged `internal` in the OpenAPI document. The items read
   (`GET /v1/onboarding/imports/pm/items`) is keyset-paginated (100 by default, at most 500).
7. **Adapters, in two slices.** Slice 4a adds `listWorkItems` to the mock and to the generic webhook contract
   (`work_item.list` with `{ cursor, limit }` returning `{ items, nextCursor }`, signed like every generic event).
   Slice 4b adds Jira, Azure DevOps, Linear, Asana and monday. Until then those connections get a 422
   `pm_import_unsupported_provider` naming the provider, never an empty import.

## Consequences

- An admin can bring a customer's existing PM project in on day one: preview, then apply exactly that preview.
  Re-running is safe.
- The importer creates no runs and no `pm_links`. Linking a run node to an imported item instead of creating a new
  one is a follow-up on the pm-sync path, recorded in PENDING.
- The two routes are API-only. The screen is requested on #453. `KNOWN_UI_GAPS_MAX` rises by 2 over main's value at
  each merge (52 to 54 at the latest). The master session relayed the owner's answer (2026-11-15, recorded in the
  #828 body) that the cap may rise for API-only routes while the entry is kept.
- **Row-level security (#828 review; owner decision 2026-11-15: RLS on every PM table).** Both new tables are
  ENABLED and FORCED, readable and writable by an admin principal (or the bootstrap token) and the `migration` reason
  only. The same PR brings the existing PM tables under RLS (`pm_connections`, `pm_links`, `pm_sync_events`,
  `pm_webhook_deliveries`), with a new `pm_sync` reason for the mirror and link work done for a non-admin principal.
  ADR-0234 records the batch (`pending/rls_pm_tables.sql`).
- **The audit row commits with its state change** (#828 security review): the dry-run record, every refusal record
  and the applied import each write their audit row in the same transaction.
