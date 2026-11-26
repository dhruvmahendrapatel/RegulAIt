# Mockup 05 — Connections and credential maintenance

**Design proposal, 2026-11-22.** Based on main `6d81348a543cf923dbd6fb9e45e8f70206c95ce4`.
This brief describes a target experience for Claude; no provider connectivity or external credential operation was tested here.

## User task and recommended change

An administrator needs to connect a service, understand its current state and replace a credential without accidentally
changing the destination or another connection. Keep browse, setup and maintenance clearly separated.

Related feedback: INT-002/003/004/005, CON-001/002/003/004, SSO-003 and UXP-002/003/004/005 in
[the review record](../codexreviews.md). Preserve fixes already implemented on main.

## Desktop wireframe — approximately 1440 px

```text
+--------------------------------------------------------------------------------+
| Integrations / Connections                                  Search              |
| Connections                                                  [Add connection]   |
| Connect services and manage how this workspace accesses them.                    |
+--------------------------------------------------------------------------------+
| Search connections [                         ]   State [All v]   Type [All v]    |
| Connection             Type              Configuration        Last check         |
| Example connection     Repository        Configured           Not checked        |
| Another connection     Work tracking     Needs attention       [recorded time]    |
|                              [Open details] in each row's fixed action slot      |
+--------------------------------------------------------------------------------+
| Example connection                                                        [X]  |
| Repository service     Applies to: this connection                              |
| Configuration: Configured      Provider access: Not checked                     |
| Destination: [safe effective destination]                                       |
| Credential: Stored; value is never returned                                     |
|                                                                                |
| [Replace credential]       Edit destination       View activity                  |
| Advanced: disable connection / remove connection                                |
+--------------------------------------------------------------------------------+
```

This is a shared interaction pattern for existing connection pages, not permission to combine all stores into a new API.
If an aggregate connections index is not supplied, apply the same pattern within the existing Git, PM and connector pages.
Never use “Connected” or “Healthy” merely because configuration was stored successfully.

## Add-connection flow — expand only the required fields

```text
+---------------------------------------------------------------------+
| Add a connection                                                [X] |
| Type [Repository service v]    Provider [choose supported provider v] |
| Connection label [                                                ] |
| Organisation / base URL [provider-required field, when applicable]    |
| Project or repository scope [when supported and required]             |
| Authentication type [supported method v]                              |
| Account identifier [only when required by this method]                |
| Credential [write-only input]                                        |
| Required permissions: [provider-specific minimum guidance]            |
| Advanced settings v   [only settings for the selected provider]       |
| Configuration checks do not contact the provider.                     |
| [Cancel]                                      [Review connection]    |
+---------------------------------------------------------------------+
```

Use actual supported provider labels from the current registry; the wireframe deliberately uses generic labels.
Git/PM setup currently accepts manually supplied credentials. Do not present it as a completed OAuth consent flow.
A provider needing an organisation URL must require it before creation; types with safe vendor defaults keep it optional.
Explain each supported credential shape before input and during replacement. Never ask for broader permissions merely to pass setup.
If the backend expects a composite account/secret format, either clearly explain it or compose separately labelled fields safely.

The review shows provider, destination, project/scope and required consequences, but never repeats the secret value.
Use one primary action per step: Review connection, then Add connection on the reviewed confirmation.
The server still validates configuration, authorisation, egress and encrypted storage.
A live provider test, if later offered, must explicitly say it sends a request and require its own authorised contract.

## Replace credential — keep routing intentional

```text
+---------------------------------------------------------------------+
| Replace credential for Example connection                        [X] |
| Applies to: Example connection only                                  |
| Current destination: [safe effective destination]                     |
| Destination [Keep current destination v]                              |
|   Keep current / Change destination / Clear override                  |
| New credential [write-only input]                                    |
| Current credential will be replaced after a successful save.          |
| Changing the destination may also reset its exchange configuration.   |
| [Cancel]                                      [Review replacement]   |
+---------------------------------------------------------------------+
```

Present only actions with existing or explicitly approved contract support. “Keep current” is not an omitted field if omission
currently means clear: hydrate the non-secret baseline or use an explicit compatible preservation operation.
A destination change requires the intended new-host credential and preserves existing guarded-fetch checks.
Changing the selected connection clears staged secrets. Do not carry a secret from one connection or provider to another.
Do not persist secrets in browser storage to preserve a draft.

## Phone wireframe — 375/390 px

```text
+-----------------------------------+
| < Integrations      Connections    |
| [Add connection]                  |
| Search [                         ] |
| State [All v]  Type [All v]        |
+-----------------------------------+
| Example connection                |
| Repository service                |
| Configured / Not checked          |
| [Open details]                    |
+-----------------------------------+
| Detail opens in shared drawer     |
| Example connection                |
| Scope: this connection            |
| Destination: [safe destination]    |
| [Replace credential]              |
| Edit destination                  |
| View activity                     |
+-----------------------------------+
```

Use existing folded values and responsive detail controls; dense expert lists can remain tables on desktop.
Keep name, state, scope and next action visible on phone. Do not hide consequences under a hover-only label.
For multi-step setup/review, keep one active action row reachable when the keyboard is open.

## One-time webhook setup and partial outcomes

After a supported PM create, preserve the existing one-time reveal control and explain the authentication method actually used.
Show the correctly encoded webhook destination separately from its secret; use the existing reveal/copy component for the latter.
Do not put a credential into a generic copyable address unless that provider's actual supported mechanism requires it.
Encode the connection name as one URL path segment when constructing generated addresses.

```text
Connection saved. Webhook setup is still required.
Destination: [correctly encoded address from supported route]
Verification method: [the selected provider's supported method]
[Copy destination]   [Open one-time secret control]
Next: configure the external service using the instructions above.
```

A copied value is not proof the external service accepted it. Only show a delivery/check result supplied by the server.
After the reveal is dismissed, explain that the secret cannot be shown again and link to the authorised replacement/rotation path.
Do not invent a second plaintext-secret retrieval endpoint.

## Required states and recovery

| State | Visible copy and action |
| --- | --- |
| Metadata loading | “Loading connection details…”; replacement/removal locked until baseline is known. |
| Metadata failed | “Connection details are unavailable.” Retry; never assert no credential. |
| Confirmed empty list | “No connections yet.” Add connection only for an authorised administrator. |
| Forbidden | Explain available read-only access; omit unavailable secrets/actions and keep server checks. |
| Invalid dependent field | Clear guidance beside the compatible field; a hidden provider-specific value must not be submitted. |
| Configuration saved | “Connection saved. Provider access has not been checked.” Do not claim live connectivity. |
| Proof cancelled/refused | No change made; preserve suitable non-secret context; safely clear secrets when leaving. |
| Saving | Freeze the submitted connection/operation; one in-flight mutation, with no conflicting rotate/move/remove action. |
| Save outcome uncertain | Refresh metadata before another write; do not automatically repeat a credential replacement. |
| Saved, refresh failed | State that save succeeded and metadata reload failed; lock further writes until reconciled. |
| External delivery failed | Preserve saved configuration and identify the failed delivery separately, with an authorised recovery route. |

## Reuse and explicit backend gaps

Reuse [GitConnectionsPage](../../../apps/web/src/views/admin/integrations/GitConnectionsPage.tsx),
[PmConnectionsPage](../../../apps/web/src/views/admin/integrations/PmConnectionsPage.tsx),
[ConnectorsPage](../../../apps/web/src/views/admin/integrations/ConnectorsPage.tsx),
[IntegrationEditDialogs](../../../apps/web/src/views/admin/integrations/IntegrationEditDialogs.tsx),
`DataList` where the route supports its contract, `DetailDrawer`, `DrawerActions`, `RowActions`, `RevealCard`, `RecordError`
and the current step-up/destination-change helpers. Do not force a paged contract onto an unpaged endpoint.

Provider health, verification timestamps, effective authentication source and aggregate index data must come from safe server fields.
Absent fields show “Not checked” or “Unavailable”; they do not justify a simulated Test connection button or health badge.
Provider-specific URL/version requirements need server validation as well as correct UI controls.
Use existing schemas/resolvers; do not implement a second provider registry or lifecycle.

## Keyboard, safety and acceptance

1. Label every secret/account field and method-specific instruction; errors link to inputs and announce a focused summary.
2. Test connection A → B → A, and provider changes, with no secret resurrected or wrong-resource submission.
3. Verify token-only replacement keeps the effective destination; explicit clear/change explains its real consequence.
4. Check missing required URL, hidden incompatible version, metadata failure and server refusal before successful setup.
5. Verify generated addresses identify every accepted connection name through the existing route, including delimiter cases.
6. Keep dirty non-secret drafts scoped; ask before discarding and block dismissal during a pending save.
7. Complete phone/desktop and keyboard journeys; focus returns to the same connection after a dialog closes.
8. Record mocked configuration tests separately from real provider access, webhook delivery and native secret-copy/device checks.
