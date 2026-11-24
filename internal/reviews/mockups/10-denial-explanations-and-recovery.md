# Mockup 10 — Understand a refusal and find a safe next step

Design proposal, 2026-11-24. Source: main `2d57877b82fbb4c7d9969ffd88ee7ce7805f132e`.
Related proposal: **CXR-BRN-UX-03**; existing proof/outcome cards remain their own implementation work.
Use the [shared rules](README.md). This is a reusable presentation proposal, not a new policy engine,
an implemented gateway contract or evidence of a completed accessibility/user study.

## User task and reason

A person whose call was refused needs to know what happened, whether anything completed and what they can do next.
An approver needs the exact permitted decision context. An administrator needs authorised diagnostic evidence.
Giving every role the raw policy trace leaks information; showing only an internal code strands legitimate work.

Reuse the existing `RefusalNotice`, code-to-sentence mapping, proof dialog and outcome patterns. Keep the same
information order across model, connector, MCP and A2A calls while retaining each protocol's actual response shape.

## Desktop wireframe — member, approximately 1440 px

```text
+--------------------------------------------------------------------------------+
| Existing task / Example operation                                               |
| Project: [authorised project label]                                             |
+--------------------------------------------------------------------------------+
| This operation was not permitted                                                |
| The current policy does not allow this action in the selected scope.              |
|                                                                                |
| What happened: Call refused before execution [only if the outcome proves this]   |
| Your input is kept in this task.                                                |
|                                                                                |
| Next step: [the permitted recovery for this reason]                              |
| [Open the relevant account setting]      Back to the task                        |
|                                                                                |
| Reference: [opaque safe reference, only when supplied]     [Copy reference]       |
| More information [Expand]                                                       |
| Safe reason category and recorded time; no hidden policy source or other people. |
+--------------------------------------------------------------------------------+
| Original form / retained suitable non-secret input                              |
| [Draft remains here]                                                            |
+--------------------------------------------------------------------------------+
```

The primary action is an available recovery, not a universal Retry. For an entitlement denial, replace the account
setting link with an existing authorised request/help route if one exists. Otherwise say “Ask an administrator to
review access for this operation” and offer a safe copyable reference. Do not invent a request form or send a message.
Do not claim no side effects from a generic 403, an execution failure or a timeout.

## Phone wireframe — 375/390 px

```text
+-----------------------------------+
| < Example task                    |
| Example operation                 |
| Project: [authorised label]        |
+-----------------------------------+
| This operation was not permitted  |
| Short safe explanation            |
|                                   |
| Outcome: [known result]            |
| Your input is kept.               |
|                                   |
| [Supported next step]             |
| Back to the task                  |
|                                   |
| Reference: [safe reference]        |
| [Copy reference]                  |
| More information v                |
+-----------------------------------+
```

Keep the outcome, next action and draft visible without sideways scrolling. Do not put required consequences in
hover help. A refusal block is inline in the task; it does not open another modal over a proof/confirmation dialog.

## One pattern, three permission scopes

| Reader | Show | Keep out unless separately authorised |
| --- | --- | --- |
| Caller/member | Own attempted operation's safe label, known outcome, safe reason category, supported recovery and reference. | Other principals, hidden resources, policy source, matched group membership, rule ordering and sensitive payload. |
| Assigned approver | Existing exact-action review: target, scope, consequences, expiry, redacted arguments and signature/quorum requirements. | An assumption that every refusal is approvable; a requester's ability to approve their own protected call. |
| Administrator | Current authorised policy/configuration evidence and audit record; effective source/version where supplied. | Unredacted secrets, cross-tenant evidence or authority inferred merely from the word “administrator”. |

The server checks every detail/evidence/recovery request. A client-side role switch does not reveal more explanation.
An administrator inspecting the current policy must still see that the original refusal used an earlier snapshot,
where version evidence exists. Do not relabel a historical denial using today's rules.

## Reason and recovery mapping

| Known reason | Safe next step and boundary |
| --- | --- |
| Required MFA setup | Existing Account destination and correct subject wording: your account versus an API key's owner. |
| Fresh proof required | Existing action-bound proof wrapper. Same submitted action after successful proof; cancellation sends no retry. |
| Literacy acknowledgement required | Existing applicable policy acknowledgement route; do not silently acknowledge it. |
| Entitlement/policy denial | Explain the permitted scope safely. A request or policy-review route appears only if actually supported. |
| Approval required | Distinguish waiting for a recorded request from a refusal with no request created. Link to the existing Inbox when permitted. |
| Budget exhausted | State the server's effective current-period result. Use only its supported approval/review path; do not bypass accounting. |
| Provider disabled | Explain that configuration is unavailable and name the authorised maintenance path; saved configuration is not health. |
| Policy cannot be resolved | “We could not verify the policy needed for this operation.” No execution; authorised operator recovery. Do not show it as allowed or empty policy. |
| Unknown refusal code | Safe generic refusal plus supplied reference, without raw upstream error/stack/source. Preserve the machine code internally. |
| Timeout / connection lost | “We could not confirm the result.” Read supported authoritative state before another write; this is not a denial. |
| Decision committed, execution failed | Keep the recorded decision; offer the existing execution-recovery route. Never replay approval to repair execution. |

Do not collapse a temporary system failure into a personal permission denial, or a known denied operation into a
successful empty response. An allowed relaxation is an admin policy operation with its own proof/audit and approved
bounds, not a “Continue anyway” button. The new administrative exception row remains gated by its assigned slice.

## Minimal contract and reuse

Existing implementation:

- [RefusalNotice](../../../apps/web/src/ui/RefusalNotice.tsx) supplies a persistent inline alert and recovery link.
- [refusals.ts](../../../apps/web/src/api/refusals.ts) maps known codes to sentences and destinations; extend its
  current conventions before creating another mapping registry.
- [client.ts](../../../apps/web/src/api/client.ts) retains typed errors and proof requirements.
- [stepUp.ts](../../../apps/web/src/stepup/stepUp.ts) owns exact-action proof and retry.
- [governed-evaluate.ts](../../../apps/gateway/src/governed-evaluate.ts) and existing protocol adapters own decision
  and audit facts; display them rather than evaluating policy in the browser.

The target UI needs safe facts, not full diagnostic disclosure: machine reason, known execution/decision outcome,
an authorised resource label, optional opaque reference and supported next actions. First inventory which existing
responses already provide them. Missing facts remain unknown; DTO additions require assigned server work and
per-reader visibility tests. Do not add another error service, notification system or explanation engine.

The current `RefusalNotice` assumes one link. Optional reference and action-free denial are small compositional
extensions only if real consumers need them. Navigation destinations come from the existing route registry or safe
allow-listed local mapping, never an arbitrary upstream URL or untrusted error text.

## Standards and comparison

Research checked on 2026-11-24: [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457.html), especially its security
considerations: problem details are not a debugging interface and must avoid exposing implementation information.
The earlier review's OWASP authorisation and GOV.UK error-guidance research continues to apply. A fresh OWASP
error-handling page fetch was blocked; no newly retrieved content from that page is claimed.

Two approaches considered:

1. **Keep current typed gateway errors and `RefusalGuidance`.** Smallest compatible step; reuse pinned Fastify/React
   and existing tests. Fits current APIs and offline operation, but requires a deliberate audit of missing codes and
   per-role data before adding richer context.
2. **Adopt RFC 9457 at the HTTP boundary.** A standard envelope can stabilise types/references across HTTP clients,
   but migrating all protocol adapters would expand scope and does not itself solve redaction or authority. MCP/A2A
   application results are not made identical merely by changing an HTTP error body.

Recommendation: improve the existing presentation/DTOs first; evaluate a compatible standards envelope in the
assigned contract lane if needed. Neither option justifies a new dependency or hand-written policy diagnostics.

## Claude acceptance and accessibility

1. Run one caller refusal for each call family, plus approver/admin views of permitted matching records.
2. Unknown code, inaccessible resource and another tenant's reference reveal no hidden existence or policy details.
3. Proof success retries exactly once; cancellation preserves suitable input and sends no second write.
4. Policy/configuration lookup failure stays fail-closed; a deliberately absent layer is distinguished from a failed read.
5. Partial execution and uncertain timeout never claim “nothing happened” or offer blind replay.
6. Recovery controls are real links/buttons with descriptive names; keyboard focus stays in the task or returns from
   the shared proof dialog. Announce one concise outcome, not every retry/render. Copy status is accessible.
7. Check 375/768/1440 px, both themes, zoom, long text and pending/recovery states. Native screen reader, real proof
   devices and provider journeys remain untested unless separately recorded. User studies are deferred by the owner;
   report automated/mock/keyboard evidence and no measured usability gain.

This proposal is not a finding that all current refusals leak data or that all call families lack guidance. Existing
guidance is useful counterevidence; each added consumer must be traced and tested before claiming a defect.
