<!-- fold: pending -->

**E19 slice 1c and slice 2 — what remains of governed vendor agent control (ADR-0338, 2026-11-20, lane E19).**
Slice 1b supersedes the "E19 slice 1b" item above: the control credential and the Copilot Studio member are built.

Remaining:
- **Slice 1c: connecting a delegated control credential.** The authorization-code flow with PKCE through
  `@azure/msal-node`, signed in as the named admin, with a `settings_relax` step-up bound to
  `{op: "vendor_control_delegated", sourceId, account}`. The refresh token rotates on use in the same row.
- **Slice 2: Agentforce, OpenAI and n8n control members.**
- **Owner-gated.** Whether Copilot Studio accepts an app-only token needs a live tenant. Until then every control
  credential reports `controlScope: unverified`.
- **Screen.** The admin screen is on #453.
