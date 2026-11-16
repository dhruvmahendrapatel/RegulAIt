<!-- fold: state-decisions -->
**ADR-0240 (builder, 2026-11-07): one second factor for the external portals (supplier ADR-0221, auditor ADR-0225).**
A spent single-use link opens a 10-minute challenge (cookie scoped to the portal's `…/session/mfa` path), not a
session. The first use of a grant enrols TOTP through the existing `totp.ts` (`otpauth`), and later links only verify.
A wrong or replayed code counts; 5 consecutive failures lock the factor (audited). Recovery is only the inviting
admin's reset (`identity_manage` step-up, audited), which ends live sessions; the next link enrols again. Required by
default: `supplier_portal_mfa_required` (relaxed via `PUT /v1/supplier-portal/settings`) and
`trust_auditor_mfa_required` (via `PUT /v1/org/settings`), each a `settings_relax` step-up when turned off. With no data
key, a link is refused before it is spent. Pending migration `external_portal_mfa` (`external_mfa_factors`, `external_mfa_challenges`). Open:
the portal screens (Governed Designer, #453), a passkey option, and trust on first use of the first link.
