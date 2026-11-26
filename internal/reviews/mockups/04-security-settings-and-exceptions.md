# Mockup 04 — Security settings and temporary exceptions

**Design proposal, 2026-11-22.** Based on main `6d81348a543cf923dbd6fb9e45e8f70206c95ce4`.
This is an implementation brief for Claude; it is not a shipped screen or a completed usability test.

## User task and recommended change

An administrator should understand the effective policy, change one intentional value and know what was saved.
A permitted relaxation should have a clear scope and consequence. Required protections remain server-enforced.

Replace dense whole-policy submission with the existing per-setting review pattern. Keep the normal view short:
current value, affected scope and one useful action. Put advanced explanation behind optional help; keep consequences visible.

Related feedback: SSO-002/003, ADM-003/004/009, ACC-001/003 and UXP-002/003/004 in
[the review record](../codexreviews.md). Reuse fixes already merged on main.

## Desktop wireframe — approximately 1440 px

```text
+--------------------------------------------------------------------------------+
| Settings / Sign-in policy                                   Search              |
| Sign-in policy                                                                  |
| Manage how people sign in. Changes apply to this organisation.                    |
+--------------------------------------------------------------------------------+
| [Sessions]  Identity providers  Sensitive actions  Temporary exceptions            |
+--------------------------------------------------------------------------------+
| Session timeout                                                                 |
| Applies to: organisation       Current server policy loaded                       |
|                                                                                |
| Idle timeout                 Current: 30 minutes                                 |
| Sign out inactive browser sessions after this time.                              |
| Proposed value [45 minutes v]                                                    |
|                                                                                |
| [Review change]                    Restore current value                         |
+--------------------------------------------------------------------------------+
| Other settings                                                                  |
| Session lifetime       24 hours                     [Change]                     |
| MFA requirement        Required for administrators  [Change]                     |
| Local sign-in          Allowed under current policy [Change]                     |
+--------------------------------------------------------------------------------+
```

Only the selected setting has a primary button. Unchanged rows offer secondary actions.
The values above are synthetic illustrations; load actual values and bounds from the existing setting specification.
Do not prefill a missing value with either a relaxed value or a guessed strict default.

## Review dialog — before any protected mutation

```text
+------------------------------------------------------------+
| Review idle-timeout change                              [X] |
| Applies to: organisation                                    |
| Current                       Proposed                      |
| 30 minutes                    45 minutes                    |
|                                                            |
| Inactive sessions can remain signed in for 15 minutes more.  |
| Other sign-in settings will stay unchanged.                  |
|                                                            |
| You may need to confirm your identity to make this change.   |
| The server decides whether a fresh proof is required.        |
|                                                            |
| [Cancel]                                  [Confirm change]  |
+------------------------------------------------------------+
```

Confirm submits the exact reviewed key/value through the existing proof wrapper. It does not save first and ask later.
Cancel returns to the draft. Proof cancellation leaves the policy unchanged and keeps the suitable non-secret draft.
If current policy changes before confirmation, show the changed baseline and require a fresh review of the intended value.
Do not silently replace a dirty draft or submit every old MFA, SSO and recovery-account field.

## Phone wireframe — 375/390 px

```text
+-----------------------------------+
| < Settings        Sign-in policy   |
| Sessions v                        |
+-----------------------------------+
| Idle timeout                      |
| Applies to: organisation           |
| Current: 30 minutes                |
| Proposed [45 minutes v]            |
|                                   |
| Longer inactivity keeps a session  |
| signed in for longer.              |
|                                   |
| [Review change]                    |
+-----------------------------------+
| Session lifetime: 24 hours         |
| [Change]                          |
+-----------------------------------+
```

Use the existing responsive modal for review. Keep its title, scope and final action reachable above a soft keyboard.
Allow its content to scroll; do not shrink text or hide required warnings to fit the viewport.

## Temporary exception — gated future capability

The owner approved a new bounded administrative exception in DecisionLog D-2026-11-22-01.
It requires a **new row kind**, required bounded expiry, step-up, audited grant and expiry, and automatic reversion.
The existing red-team assurance window is not a general admin-exception API. Do not call it from this UI as a shortcut.

```text
+---------------------------------------------------------------------+
| Temporary exception                                                 |
| Scope [select authorised scope]     Control [select supported rule]   |
| Current effective mode: Block       Requested mode [Warn v]           |
| Ends after [20 minutes v]           Maximum: supplied by the server   |
| Reason [                                                          ] |
| This affects only the scope and control shown above.                  |
| Remaining protections: [server-backed explanation]                    |
| [Review exception]                                                   |
+---------------------------------------------------------------------+
| Existing exception                                                  |
| Warn until [server expiry]   Scope: [authorised scope]                 |
| Baseline after expiry: Block               [View audit] [End early]   |
+---------------------------------------------------------------------+
```

Show only scopes, modes, durations and early-end actions supported by the approved backend contract.
Do not invent a project exception if the available API only supports another scope.
Before that contract exists, omit the creation form and show “Temporary exceptions are not available in this version.”
Ordinary baseline policy remains usable. An expired row must say “Expired — baseline policy applies,” even before cleanup.

## Required interaction states

| State | Visible copy and behaviour |
| --- | --- |
| Loading | “Loading current policy…”; announce the region as busy; no guessed values or enabled mutation. |
| Read failed | “Current policy is unavailable.” with Retry; retain safe drafts but lock their review until reconciled. |
| Forbidden | “You can view this policy, but cannot change it.” only if viewing is authorised; omit inaccessible data. |
| Invalid value | Inline field explanation plus linked error summary; retain the intended value. |
| Proof needed | Existing proof dialog names the same setting/scope/change; no duplicate modal or reusable blanket bypass. |
| Proof cancelled | “No change was made.” Restore review focus and preserve the non-secret draft. |
| Saving | “Saving change…”; single-flight guard; lock conflicting save/dismiss actions. |
| Saved, refresh pending | “Change saved. Loading current policy…”; do not resend the mutation. |
| Saved, refresh failed | “Change saved; current policy could not be reloaded.” Retry reload only; further changes stay locked. |
| Outcome uncertain | “We could not confirm whether the change completed.” Read authoritative state before another write. |
| Exception expired | Explicit baseline/effective state and retained audit link; never display an expired relaxation as active. |

## Components and contract boundaries

Reuse [OrgSettingsCard](../../../apps/web/src/views/admin/settings/OrgSettingsCard.tsx), its setting specifications,
`QueryGate`, `StaleAfterWrite`, `useSettleAfterWrite`, `useSingleFlight`, `Field`, `Modal`, `RefusalNotice` and existing tokens.
`PUT /v1/org/settings` already accepts partial updates; `putOrgSettings` owns the conditional step-up journey.
Use [SsoPage](../../../apps/web/src/views/admin/identity/SsoPage.tsx) as the existing destination, not a parallel settings store.

Baseline conflict detection must be honest: a client-side re-read is not an atomic compare-and-set guarantee.
If the product needs a conditional-write version, add and enforce it on the server in an assigned slice before promising it.
Exception capabilities, expiry maxima, effective source and early-end authority need safe server facts; missing facts stay unknown.
Expose provider maintenance through the existing PATCH contracts with explicit unchanged/replace secret semantics.
Never fetch a stored client secret or private key into an editor.

## Keyboard, focus and draft rules

- Visible labels, units and current/proposed values must be available to assistive technology; colour is supplementary.
- Open review at its heading, trap focus using the shared modal and return it to the originating setting on cancel.
- Link errors to inputs; announce a persistent save/refusal result without moving focus into a transient toast.
- Follow the resolved dirty-discard instruction; block dismissing a pending save into uncertainty.
- Clear secret fields on cancellation, resource switch and unmount. Preserve suitable non-secret drafts only for the same authorised scope.
- Keep harmless reads and unchanged settings free of extra proof/confirmation steps.

## Claude build and acceptance checklist

1. Route existing sign-in fields through current-baseline, intentional-key updates; no whole stale-policy overwrite.
2. Exercise changed MFA/break-glass data arriving during an unrelated edit; review the actual new baseline before saving.
3. Test success, refusal, proof cancellation, uncertain timeout and successful-write/failed-refresh separately.
4. Verify one protected write at most per attempt and the exact action-bound retry after valid proof.
5. Gate exception UI on the approved new backend capability; verify grant, effective expiry, automatic reversion and audit.
6. Re-score expiry-display impact for ordinary administrative exceptions instead of carrying over a demo-only low-frequency assumption.
7. Complete the same task at phone/desktop widths, keyboard-only and both themes; record native screen-reader results separately.
