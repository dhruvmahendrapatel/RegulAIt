# Mockup 07 — Sign-in, required setup and account linking

Status: design proposal; use the existing authentication flows and server decisions.
Baseline: main `6d81348a543cf923dbd6fb9e45e8f70206c95ce4`.
See the [shared mockup rules](README.md).

## User task and reason

A person should recognise the permitted sign-in method, complete required setup and understand a blocked
account-link attempt. Keep sensitive operations secure while removing wrong-method dead ends and repeated input.

Related feedback: ACC-001/004/005, SSO-003/004 and UXP-002/003/004/006.
ACC-002 remains owner-deferred as triage-low: this mockup does not request an expansion of federated return targets.
ACC-004 is also deferred to #1188; a consistent error-state sketch does not request its standalone implementation.

## Desktop wireframe — sign-in

```text
+-----------------------------------------------------------------------+
|                            regulAIt                                   |
|                                                                       |
|                     Sign in to your workspace                         |
|                                                                       |
|                 [ Continue with organisation sign-in ]                |
|                 Use the method configured for this workspace.         |
|                                                                       |
|                 Other permitted sign-in methods                  [v]  |
|                 +-------------------------------------------------+   |
|                 | Email or username                               |   |
|                 | [                                             ] |   |
|                 | Password                                        |   |
|                 | [                                 ] [Show]      |   |
|                 | [ Sign in ]                                     |   |
|                 +-------------------------------------------------+   |
|                                                                       |
|                 Need help? Contact your workspace administrator.      |
+-----------------------------------------------------------------------+
```

This is a hierarchy example, not permission to hide the only working method. Render only methods that the
server advertises. A local-only deployment opens the local form directly. Multiple configured identity
providers use their supplied safe labels; do not invent a universal organisation button with no destination.
Administrator sign-in and machine-credential exchange remain separate, accurately labelled disclosures when allowed.

## Phone wireframe — required verification

```text
+-------------------------------+
| regulAIt                      |
| Confirm your sign-in          |
|                               |
| Enter the code from your      |
| authenticator app.            |
|                               |
| Authenticator code            |
| [                           ] |
|                               |
| [ Verify and continue       ] |
|                               |
| [Back to sign-in]             |
|                               |
| This step is required by      |
| your workspace policy.        |
+-------------------------------+
```

Use a single paste-friendly code field with the right input mode and autocomplete.
Do not add a puzzle, prevent paste, split the code into inaccessible boxes or silently turn verification off.
The exact available proof method comes from the server, not from this drawing.

## Required account setup

```text
Finish setting up your account
Required now: change your initial password
Next: set up your authenticator, if required by your policy

New password       [                              ] [Show]
Confirm password   [                              ] [Show]
Password requirements: supplied by the current policy
[ Save password and continue ]
```

Ask for the current password only when the server says that this account/change requires it.
Do not invent a password for a credential-origin recovery user. Show a determinate step count only when the
remaining requirements are actually known. Do not collect the same non-secret account identifier twice.

Enrolment should explain the method, offer the existing QR/manual setup alternatives and verify a code before
claiming completion. QR/manual secret values belong only to the enrolment flow, never to logs, screenshots,
analytics or a mockup document. A failed activation preserves useful context but never reports MFA enabled.

## Linking an existing account

```text
+------------------------------------------------------------------+
| Link your existing account                                       |
|                                                                  |
| Your identity provider confirmed an identity that matches an      |
| existing account. Prove that account to link the two sign-in paths.|
|                                                                  |
| Your current password     [                           ] [Show]    |
| Authenticator code        [                           ]           |
| Show this field/requirement according to the existing proof flow. |
|                                                                  |
| [ Link and continue ]                                            |
|                                                                  |
| Cannot use this proof? An administrator may review the request.   |
| [Back to sign-in]                                                |
+------------------------------------------------------------------+
```

Show only the identity information already permitted by the bound pending-link response.
Never link a password-bearing account merely because email text matches.
The alternative is a documented administrative review, not a new client-only approval route.

### Administrative review variant

```text
Account-link request                        Pending: 1 of 2 approvals
Target: Account A                           Request expiry: ...
Your approval is recorded. Another eligible administrator must approve.
[ View request details ]                    [Deny request]

Own-account variant:
You cannot approve a link to your own account here.
Start sign-in with your identity provider again and prove the existing account,
or ask the required independent administrators to review the request.
[Back to sign-in]
```

Do not leave a repeat Approve button enabled after the current principal has voted.
The server must supply/verify caller-specific eligibility; a total of one vote does not identify who voted.
Deny is a separate action governed by its own policy. Do not reduce the required distinct-principal count.

## Error, cancellation and outcome states

| State | Visible result / next action |
| --- | --- |
| Options loading | `Checking available sign-in methods...`; no guessed SSO-off state. |
| Options unavailable | `Sign-in methods could not be loaded.` / `Try again`; use a legacy fallback only when its capability is actually established. |
| Credential refusal | Uniform `The sign-in details could not be verified.`; do not reveal account existence or lockout details. |
| Verification failure | Inline explanation and safe correction; retain the non-secret identifier. |
| Proof options unavailable | Stop inaccurate loading text; `Try again` starts a fresh ceremony for the same action. |
| User cancels proof | `Verification cancelled. Nothing changed.` only when the mutation is known not to have committed. |
| Link expired | `This request expired. Sign in with your identity provider again.`; no reuse of old state/nonce. |
| Partial admin approval | `Your approval is recorded. Waiting for another administrator.`; updated count and eligible controls. |
| Uncertain response | Verify the current session/request state before suggesting another state-changing submit. |

A successful sign-in follows only the existing server-approved continuation. Never accept arbitrary absolute,
protocol-relative or caller-supplied redirects to improve navigation. Preserve callback state, nonce, PKCE,
issuer/audience, expiry and replay checks wherever the implemented protocol requires them.

## Accessibility and security requirements

- Use explicit labels and correct autocomplete (`username`, `current-password`, `new-password`, `one-time-code`).
  If a label changes, update semantic E2E selectors in the same implementation slice.
- Support password managers and paste. A Show control has an accessible pressed/state label and does not log values.
- Focus the relevant heading on a deliberate step change; focus an error summary/field for validation failure.
  Announce status without repeating sensitive input. Do not steal focus on every background read.
- Preserve non-secret progress across safe navigation. Clear password/code/secret drafts on account, provider or
  session boundaries; never put them in URL parameters or browser-wide draft storage.
- At phone width and zoom, the required action and error remain readable above the keyboard or scroll into view.
- Offer already-supported accessible proof alternatives. Trusted IdP MFA configuration is an admin policy decision,
  not an end-user switch that suppresses a mandatory challenge.

## Existing implementation, gaps and pickup

Reuse [LoginPage.tsx](../../../apps/web/src/views/auth/LoginPage.tsx), including its `LinkAccount` flow;
[ForcedPasswordChange.tsx](../../../apps/web/src/views/auth/ForcedPasswordChange.tsx);
[ForcedMfaEnroll.tsx](../../../apps/web/src/views/auth/ForcedMfaEnroll.tsx);
[StepUpDialog.tsx](../../../apps/web/src/stepup/StepUpDialog.tsx);
and [LinkRequestsPage.tsx](../../../apps/web/src/views/admin/identity/LinkRequestsPage.tsx).

Current contracts include `/auth/sign-in-options`, password/MFA session routes, `/auth/link/pending`,
`/auth/link/confirm` and administrative link-request decisions. Do not build another identity store or broker.
Caller-specific link approval capability and safe discovery-recovery handling may need DTO/UI work; show an honest
unavailable state until supported. Some proof recovery fixes are already on main: inspect/reuse them before coding.

Acceptance: local-only, SSO-only, break-glass, initial-password and required-MFA journeys remain usable;
same-admin repeat and own-link approval are not invited; expiry/cancel/retry preserve the correct transaction;
success does not skip a remaining server-required step. Verify keyboard, a real screen reader, password-manager
behaviour and actual IdP/passkey devices separately from mocked protocol responses.
