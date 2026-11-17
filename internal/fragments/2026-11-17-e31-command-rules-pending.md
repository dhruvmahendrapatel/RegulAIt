<!-- fold: pending -->

**E31 — on-device command, file and package rules ([ADR-0350](../decisions/0350-endpoint-command-file-package-rules.md)).**
Slice 1 (device engine, four adapters, matrix) built. Open: slice 2, the policy compiler from per-user entitlements,
signed by the B4 device-policy signer (#867), with delivery of the device id beside the policy; slice 3, device
groups and expiring exceptions (step-up approval, lifecycle table, audit). Owner questions open: the compiled default
for unmatched commands (ask) and the maximum exception length (24 hours, raisable to seven days). Vendor follow-ups:
Cursor pre-write paths, Copilot CLI `toolArgs` and file-tool fields, Codex ask and read hooks, once documented.
