<!-- fold: state-decisions -->
**ADR-0331 (builder lane E13, 2026-11-15, Proposed; PENDING P1): governed removal of flagged add-ons.**
- **What:** an admin, with an `endpoint_remediation` step-up, removes one MCP server identity (optionally one version)
  from one device, a selected set, or every device that reported it in the last N days. The endpoint agent applies a
  signed, identity-bound, replay-protected directive at its next sync, removing one entry from one manifest-located
  plain-JSON config and keeping every other byte. It notifies the developer and reports per-endpoint outcomes, each
  written to the audit trail in the same transaction.
- **Defaults:** the org switch is off, and turning it on is a `settings_relax` step-up. Nothing is automatic.
  `blockReinstall` defaults to on. Directives are signed with ADR-0298's policy key path, whose keyring stays empty
  until SD4, so the whole path is inert until then. This is a recorded narrow relaxation of ADR-0195 decision 19.
- **Not covered:** skills and plugins (no discovery kind yet), JSONC and TOML configs (reported as unsupported), and
  on-device enforcement of the reinstall block (waits for SD4 policy delivery). The admin screens are known UI gaps on
  #453.
