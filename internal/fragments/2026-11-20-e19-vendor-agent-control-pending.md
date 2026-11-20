<!-- fold: pending -->

**E19 slice 1b — vendor agent control credentials and the first vendor member (ADR-0338, 2026-11-20, lane E19).**
Slice 1 ships the vendor-neutral framework only: the `vendor_agent_actions` lifecycle, the request, approval, execute,
settle and cancel routes, the kill-switch guard and the `vendor_agent_control.apply` dial exemption. In production no
registry offers a control and no control credential resolves, so every request answers `409 control_not_offered`.
Slice 1b, after lane E17's adapter code lands: the `discovery_credentials.purpose` column (`discovery_read` |
`platform_write`, fixed at insert) with the live-unique index on `(source_id, purpose)`, the delegated mode behind its
admin opt-in and mandatory expiry (owner decision 1), the control-credential loader wired as `credentialFor`, and the
Copilot Studio `control` member (`VendorAgentControl` in apps/gateway/src/vendor-agent-control-contract.ts). Slice 2:
Agentforce, OpenAI and n8n members. The admin screen is requested on #453 (KNOWN_UI_GAPS
`adr-0338-e19-vendor-agent-control.json`).
