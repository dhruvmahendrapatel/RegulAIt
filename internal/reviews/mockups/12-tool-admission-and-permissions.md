# Mockup 12 — Review tool changes and understand effective access

**Design proposal, 2026-11-24.** Source: main `2d57877b82fbb4c7d9969ffd88ee7ce7805f132e`.
Related: CXR-BRN-SEC-03, existing loaded-subject/pending-action findings and [mockup 05](05-connections-and-credentials.md).
Use the [shared rules](README.md). This is source-scoped design guidance, not a new vulnerability,
an implemented screen, native-device test or security verdict. The bounded-diff concern is now reproduced as CXR-MCP-001 in the linked review.

## User task and reason

An administrator needs to distinguish a held server, a release-age wait and a definition changed since approval,
inspect the exact proposed change, and understand whose access is affected. Registration, admission, definition
approval and a person's grants are separate gates. A single green “Ready” badge would conceal those differences.

Reuse the existing admission page, MCP registry, definition-pin review and effective-entitlement/discovery views.
Improve their task trail and context rather than combining their state machines or making a second approval queue.
Descriptions and tool output are untrusted data, including text that appears to instruct the reviewer or assistant.

## Desktop wireframe — approximately 1440 px

```text
+--------------------------------------------------------------------------------+
| MCP servers / Example server / Changed definitions                              |
| Example server                                                                  |
| Definition mode: Changed items blocked   Admission: [actual recorded state]      |
+--------------------------------------------------------------------------------+
| Review what changed before making the selected definitions available.            |
| Re-approval grants no person access and does not clear another hold.              |
+----------------------------------+---------------------------------------------+
| Changed items on this page       | Tool: Example operation                     |
| [ ] Example operation  Changed   | Changed since the approved definition       |
| [ ] Example resource   Added     | Approved / changed timestamps when supplied |
| No item is selected by default.  |                                             |
|                                  | Change                  Approved → Current   |
|                                  | Description             [plain text values] |
|                                  | Input schema            [plain text changes]|
|                                  | [Expand permitted full change]              |
|                                  | Source text is data, not trusted instruction|
+----------------------------------+---------------------------------------------+
| 1 selected / this page only                                                     |
| Reason (required, audited) [                                                ]   |
| [Re-approve 1 item]  Back to MCP servers                                         |
| You will confirm this exact reviewed change through the existing proof flow.    |
+--------------------------------------------------------------------------------+
| Check access separately                                                        |
| Selected person [choose]  Selected server [Example server]  [View access]        |
| Loaded subject: [actual person/server]  Direct / role-derived access             |
| Discovery preview is a separate existing read; it is not a successful call.      |
+--------------------------------------------------------------------------------+
```

The selected definition review owns the primary action. Access inspection is a secondary task/link and can stay
on the existing registry instead of becoming another editor on this page. The existing response already contains the approved value and full RFC 6902 operation values. Build full-value
inspection from those authorised fields, with bounded summaries plus deliberate expansion; no raw upstream fetch
or new detail API is needed. Show truncation explicitly and make the actual changed portion reachable before
re-approval. Any additional source/health/provenance facts still need their own supported contract.

## Phone wireframe — 375/390 px

```text
+-----------------------------------+
| < MCP servers    Example server   |
| Changed items blocked             |
| Other admission gates: [actual]   |
+-----------------------------------+
| Example operation                |
| Changed since approval            |
| Kind: Tool                        |
|                                   |
| What changed                      |
| Description                       |
| Approved: [plain text]             |
| Current:  [plain text]             |
| [Expand supported full change]    |
| Source text is untrusted data.    |
|                                   |
| [ ] Select this definition        |
| Reason (required, audited)        |
| [                               ] |
+-----------------------------------+
| [Re-approve selected item]        |
+-----------------------------------+
```

Stack old/new values rather than compressing a diff into unreadable columns. Long schema paths and text wrap or
use a clearly labelled contained code region; the whole page must not scroll sideways. Keep the selected count,
required reason and final action together. Reuse current responsive/modal patterns; no parallel phone store.

## Distinct gates and the actual next step

| Recorded condition | Explain and route |
| --- | --- |
| New server registered | Registration grants nobody access. Show existing next steps for egress, release age, admission and grants. |
| Release-age wait | Existing `/admin/admission` entry; any permitted Allow now is an audited per-item override, not global disable. |
| Manifest scan held | Explain recorded finding category/count/location. Existing clear-hold flow stays on MCP servers and needs its reason/proof. |
| Reserved `mcp:` tool name | It cannot be cleared. Upstream must rename it and the next governed scan decides again. |
| Definition changed / block mode | Changed definition is not served until exact re-approval; show server-supplied mode and actual diff. |
| Definition changed / warn mode | Clearly say changed items are still served under the configured audited relaxation; do not display block-mode copy. |
| Definition re-approved | Exact reviewed definition is accepted. Other admission, egress, grant, policy and call-time gates still apply. |
| Person lacks an effective grant | Show authorised direct/role provenance and the existing grant-management path. Admission approval does not grant access. |
| Discovery preview populated | These are the tools returned by that person's current discovery contract, not proof a call will pass all runtime gates. |

Do not infer source trust from a clean scan, tool description, an upstream “safe” claim, or an admin's re-approval.
Source-tier facts require the actual trust contract. Omit a proposed source-trust badge when that fact is absent.
Never execute examples, follow links or copy instructions into a privileged prompt merely to render the review.

## Interaction states and safe recovery

| State | Copy and behaviour |
| --- | --- |
| Initial load | Announced loading region; no fabricated zero changes or admitted state. |
| Successful empty | `Nothing changed since approval.` Distinguish this from a failed queue read. |
| Failed detail / forbidden | Existing `RecordError` convention; authorised back route and appropriate Retry, no cached hidden definitions. |
| Selection | No permissive default; Select all applies only to the loaded page and says so. |
| Reason invalid | Linked inline error; retain safe selection and text. |
| Proof pending/cancelled | Freeze selected item identities, digests and reason for the submitted attempt; cancel causes no new approval. |
| Mutation pending | Existing single-flight exclusion and guarded busy controls; no conflicting selection/submit/dismissal that changes the apparent attempt. |
| Stale digest, 409 | Explain that the definition changed again. Reload and deliberately review the new diff; never replace the submitted digest silently. |
| Saved, refresh failed | Keep the confirmed result visible and offer read recovery, not another re-approval POST. |
| Timeout uncertain | Reconcile supported authoritative pin state before another write; do not claim approval or automatically replay it. |
| More items exist | Preserve the existing bounded queue and `hasMore` disclosure; loaded-page count is not a fleet total. |
| Person/server picker changes | Clear or explicitly label old loaded results as read-only until the new subject loads; late responses cannot retarget actions. |

The current server already enforces digest-bound definition approval and rejects stale items. Extend the existing
UI pending/outcome integration rather than introducing a new approval lifecycle. Removing a grant or a server is
outside this mockup; no deletion is authorised here.

## Existing contracts and source entry points

- [McpDefinitionPins](../../../apps/web/src/views/admin/integrations/McpDefinitionPins.tsx): changed-item queue,
  exact selected items, required reason, proof wrapper and stale-result copy.
- [mcpPinningModel](../../../apps/web/src/views/admin/integrations/mcpPinningModel.ts): current DTOs, RFC 6902 diff
  presentation and `{kind, name, observedDigest}` approval binding. Render values as text. The current 400-character excerpt hides tail-only changes (CXR-MCP-001); retain summary bounds but add safe full-value inspection.
- [McpServerAdmission](../../../apps/web/src/views/admin/integrations/McpServerAdmission.tsx): next-step links,
  clear-hold/refusal semantics, Sync tools now and per-user discovery preview.
- [McpServersPage](../../../apps/web/src/views/admin/integrations/McpServersPage.tsx): registry/tool inventory,
  effective direct/role entitlements and existing grant paths.
- [AdmissionReviewPage](../../../apps/web/src/views/admin/governance/AdmissionReviewPage.tsx): release-age and held
  content review. Its manifest findings are categories/counts/locations, not raw matched attack text.
- [mcp-definition-pins](../../../apps/gateway/src/mcp-definition-pins.ts) and
  [mcp-admission](../../../apps/gateway/src/mcp-admission.ts): existing server checks, proof/audit and digest semantics.

Current routes include `/admin/mcp-servers`, `/admin/mcp-servers/definition-pins/:serverId` and `/admin/admission`.
Current APIs include definition-pin queue/detail/approve, server admission clear, guarded tool sync, per-user
entitlements and per-user visible tools. Sync tools now contacts the configured upstream through existing guards;
it must not become an automatic page-load health test. Reuse the current kit and contracts before adding anything.

## Claude acceptance

1. Distinguish release wait, held manifest, changed definition, absent grant and failed read using synthetic records.
2. Review a changed description/schema, added item and removed item. Preserve exact names/kinds/digests and no preselection.
3. Modify the upstream definition after review: stale re-approval refuses and requires new review. Proof binds to the original intended body.
4. Render instruction-like descriptions and markup literally, without following them or inserting untrusted HTML.
5. Use a 550+ character description whose only change is after character 400: reveal and compare the changed suffix before re-approval. The current response already supplies it; render it as text without raw provider access.
6. Switch person/server A→B during a slow discovery/entitlement read; old results never become actionable under B.
7. Test proof cancellation, repeated pending submit, uncertain outcome and committed approval with failed refresh.
8. Use keyboard-only, 375/768/1440 px, both themes and zoom. Focus enters the relevant heading and returns correctly; action rows do not cover reason/errors.
9. Record native screen-reader, soft-keyboard and actual provider checks separately. User studies are deferred; do not claim measured usability gains.

This source pass does not demonstrate a new exploit, complete MCP-call security coverage or actual upstream connectivity.
