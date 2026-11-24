<!-- fold: state-recap -->

**2026-11-20 — lane E19, ADR-0338 slice 1b (vendor control credentials and Copilot Studio quarantine).**
- **Storage.** A source's control credential is the `platform_write` row of `discovery_credentials`. Pending migration
  `vendor_agent_control_credentials` adds:
  - `purpose`, fixed at insert by a guard trigger;
  - `delegated` mode and `expires_at`, behind an opt-in that is off by default;
  - a live-unique index on `(source_id, purpose)`;
  - `vendor_agent_actions.vendor_locator`.
- **Separation.** The scanner and the read-credential routes load only the read row.
- **Copilot Studio.** Its adapter now declares quarantine and unquarantine. The new `control` member calls the three
  documented Power Platform API endpoints through the guarded fetch.
- **Locator and token.** E17's read path stages each agent's `environmentId`. The token is obtained before any state
  moves, under its own federation subject.
- **Routes.** There are three API-only routes: `GET`, `PUT` and `DELETE …/control-credential`.
