<!-- fold: state-decisions -->
**ADR-0331 (builder lane E13, 2026-11-15, Proposed; PENDING P1): governed removal of flagged add-ons.**
- **What:** an admin, with an `endpoint_remediation` step-up, removes one MCP server identity (optionally one version)
  from one device, a selected set, or every device that reported it in the last N days. The endpoint agent applies a
  signed, identity-bound, replay-protected directive at its next sync, removing one entry from one manifest-located
  plain-JSON config and keeping every other byte. It notifies the developer and reports per-endpoint outcomes, each
  written to the audit trail in the same transaction.
- **Defaults:** the org switch is off, and turning it on is a `settings_relax` step-up. Nothing is automatic.
  `blockReinstall` defaults to on. Directives are signed by the shared ADR-0334 device-policy key (slice 3), under
  their own signature domain, and an agent applies one only under a key its admin pinned. This is a recorded narrow relaxation of ADR-0195 decision 19.
- **Not covered:** skills and plugins (no discovery kind yet), JSONC and TOML configs (reported as unsupported), and
  on-device enforcement of the reinstall block (waits for SD4 policy delivery). The admin screens are known UI gaps on
  #453.
- **Review of #871 (2026-11-18):** a removal is now sent to no device until a second administrator approves it
  (ADR-0186, `approval_decide` step-up bound to the approval's arguments digest, which covers the resolved target set);
  signing a directive is the external write `device_policy.sign_payload` behind the execution-mode barrier; the three
  tables are under forced RLS; both lifecycles are ADR-0348 machines; cancel stops only undelivered targets.
- **Slice 3 (2026-11-20):** directives are signed by the shared device-policy key (owner decision B4), resolved per
  read; each signature carries the directive domain, so it never passes as a policy; the removal request accepts an
  `Idempotency-Key` (#1033).
