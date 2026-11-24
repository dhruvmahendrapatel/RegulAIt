<!-- fold: state-recap -->

**2026-11-24 — lane E19, ADR-0338 slice 1c (connecting a delegated vendor control credential, two people).**
- **Flow.** An admin starts a sign-in for one named account and names a second administrator
  (`POST …/control-credential/delegated`, a `settings_relax` step-up bound to source, account, tenant, app, expiry,
  the row replaced and the approver). The answer is an Entra authorization URL with a PKCE S256 challenge, state,
  nonce and login hint. The vendor's redirect (`GET /v1/discovery/control-credential/delegated/callback`) redeems the
  code with the server-side verifier, holds the account's refresh token encrypted on the request and queues an
  approval. Only the named approver's approval (an `approval_decide` step-up bound to the digest) stores it as a
  `delegated` `platform_write` row with its expiry; deny destroys it.
- **Machine.** `VENDOR_CONTROL_DELEGATED_MACHINE` (ADR-0348): awaiting_sign_in → awaiting_approval → connected, or
  failed, denied, cancelled, expired. Pending migration `vendor_control_delegated_requests` enforces the moves with a
  guard trigger and CHECKs, one open request per source, RLS and no TRUNCATE. Rows in STATE_MACHINES.md, with one for
  `vendor_agent_actions` (review of #1120).
- **Use.** The refresh token is redeemed for `CopilotStudio.AdminActions.Invoke` only; the rotated one replaces it in
  the same row. A token for another account is refused.
- **Library.** `@azure/msal-node` 7.1.1, now a direct exact pin, talks only to the tenant's token endpoint through the
  guarded fetch, with static metadata (no discovery call) and a federated client assertion (no stored client secret).
- **Review of #1120 applied.** The read credential refuses the control app; execute and settle check the step-up
  before minting a token.
