<!-- fold: pending -->

**E19 slice 2 and the owner-gated checks — what remains of governed vendor agent control (ADR-0338, 2026-11-21, lane
E19).** Slice 1c supersedes the "Slice 1c" bullet of the 2026-11-20 item: connecting a delegated credential and its
refresh-token rotation are built, with a second administrator's approval before the credential is stored.

Remaining:
- **Slice 2: Agentforce, OpenAI and n8n control members.**
- **Owner-gated, needs a live tenant.** Whether Copilot Studio's quarantine calls accept an app-only token, and the
  delegated sign-in against a real Entra app registration (its redirect URI must name the gateway's
  `/v1/discovery/control-credential/delegated/callback`). Until then every control credential reports
  `controlScope: unverified`.
- **#1160 (triage-low): final rows are kept.** Final `vendor_control_delegated_requests` rows are not deleted; each is
  a few hundred bytes, holds no secret (CHECKs tie the verifier and the held token to the open states) and is the
  two-person evidence. Open rows past their window are expired by the `vendor-control-delegated-expiry-sweep` job.
- **Screen.** The admin screen is on #453.
