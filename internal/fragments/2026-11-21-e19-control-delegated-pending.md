<!-- fold: pending -->

**E19 slice 2 and the owner-gated checks — what remains of governed vendor agent control (ADR-0338, 2026-11-21, lane
E19).** Slice 1c supersedes the "Slice 1c" bullet of the 2026-11-20 item: connecting a delegated credential and its
refresh-token rotation are built (branch `builder/e19-control-1c`, PR after #1120 merges).

Remaining:
- **Slice 2: Agentforce, OpenAI and n8n control members.**
- **Owner-gated, needs a live tenant.** Whether Copilot Studio's quarantine calls accept an app-only token, and the
  delegated sign-in against a real Entra app registration (its redirect URI must name the gateway's
  `/v1/discovery/control-credential/delegated/callback`). Until then every control credential reports
  `controlScope: unverified`.
- **triage-low candidate, not filed.** Spent or expired `vendor_control_delegated_requests` rows are not swept; each is
  a few hundred bytes and holds no secret once spent (the verifier is destroyed with `used_at`). An unspent expired row
  keeps its encrypted verifier until its source is deleted.
- **Screen.** The admin screen is on #453.
