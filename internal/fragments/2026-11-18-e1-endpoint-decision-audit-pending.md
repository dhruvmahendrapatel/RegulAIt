<!-- fold: pending -->
- **Endpoint decision screens (ADR-0310 addendum, lane E1).** `GET /v1/endpoint-decisions/sessions` (permission-bypass
  sessions) and `GET /v1/endpoint-decisions/tamper` (managed-file changes and hook status) are API-only. The screens
  are requested on #453 (Governed Designer).
- **Restore of a changed managed file (ADR-0310 addendum (c)).** Not built. Restoring needs admin approval through the
  Approvals Queue, and an agent-side write of a root-owned file. It is a later step, with its own review.
- **Hook registration in the managed bundle (ADR-0310 addendum, limit).** Bundles do not compile the ADR-0330 hook
  registration, so an admin merges it by hand, and the tamper view's bundle match then reads `none`. Emitting the
  registration in the Claude Code and Codex bundle files would make the bundle hash the tamper baseline. This is a
  bundle-format change and needs a new version.
- **Spool deletion by the device user (ADR-0310 addendum, limit).** The spool lives in the user's state directory, so
  the user can delete unsent events. Counting gaps needs a per-device sequence that the gateway checks, or a
  root-owned spool written by a privileged helper.
- **Lane E31 emits through `decisionlog.Emitter` (ADR-0350 §7).** Command, file and package decisions use emitter
  `command-rules` and the action kinds `command`, `file_read`, `file_write` and `package`. No second audit path.
