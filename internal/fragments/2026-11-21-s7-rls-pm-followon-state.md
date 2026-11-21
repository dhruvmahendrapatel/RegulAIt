<!-- fold: state-recap -->
**2026-11-21, S7 RLS PM follow-on (ADR-0234).** Pending migration `rls_pm_tables_followon` layers on
`rls_pm_tables`. Under `pm_sync`, a non-admin now reaches only the links of objects
`regulait_rls_pm_object_visible` admits: the initiator, a pending approver (read only), a decision's maker, and an
alert's owner (read only). `decisions` is ENABLED and FORCED: maker or object-visible reads, and inserts only in the
principal's own name. The app role updates only the sync-state columns of `pm_links`, and can no longer rewrite
`pm_sync_events` or `decisions`; an admin's connection delete still cascades. No new reason. The webhook stays on
`approval_maintenance`, and `pm_inbound` is deferred. `zz-adr0234-rls-pm-followon.test.ts` (19) proves no
cross-principal read or write.
