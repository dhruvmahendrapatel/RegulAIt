<!-- fold: state-recap -->

**2026-11-20 — lane E19, ADR-0338 slice 1 (governed vendor agent control, framework).** `VENDOR_ACTION_MACHINE` and the
generic `killSwitchNarrowingOnly` guard in `@regulait/shared` (exported for lane E15), the `vendor_agent_actions`
table (pending migration `vendor_agent_control`, RLS forced), the org switch and approval window on
`discovery_settings` (off and 24 hours by default), the `vendor_agent_control` approval kind with its named-approver
precheck and `approval_decide` step-up, six admin routes, and one declared dial exemption
(`NARROWING_WRITE_OPERATIONS`) pinned by the external-effects barrier matrix. No vendor is controllable until slice 1b.
