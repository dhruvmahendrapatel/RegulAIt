<!-- fold: state-recap -->

**2026-11-21 — lane E19, ADR-0338 slice 1c (connecting a delegated vendor control credential).**
- **Flow.** An admin starts a sign-in for one named account (`POST …/control-credential/delegated`, a
  `settings_relax` step-up bound to source, account, tenant, app, expiry and the row replaced). The answer is an
  Entra authorization URL with a PKCE S256 challenge, state, nonce and login hint. The vendor's redirect
  (`GET /v1/discovery/control-credential/delegated/callback`) redeems the code with the server-side verifier and stores
  the account's refresh token as a `delegated` `platform_write` row, encrypted, with its expiry.
- **Storage.** Pending migration `vendor_control_delegated_requests` holds each started sign-in: state, nonce and the
  encrypted verifier, at most 10 minutes, spent once (a guard trigger), with RLS and no TRUNCATE.
- **Use.** The refresh token is redeemed for `CopilotStudio.AdminActions.Invoke` only; the rotated one replaces it in
  the same row. A token for another account is refused.
- **Library.** `@azure/msal-node` 7.1.1, now a direct exact pin, talks only to the tenant's token endpoint through the
  guarded fetch, with static metadata (no discovery call) and a federated client assertion (no stored client secret).
- **Branch only.** Built on `builder/e19-control-1c` with no PR, per the owner's one-open-PR-per-lane rule
  (2026-11-21); its PR opens once #1120 merges.
