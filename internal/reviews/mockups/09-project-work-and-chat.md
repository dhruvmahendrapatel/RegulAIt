# Mockup 09 — Project work and conversations without lost context

**Design proposal for Claude, 2026-11-23.** Source baseline: main
`b5f88e79e4a8d25432f4ec70bc0ad811751e492c`.
Use the [shared mockup rules](README.md). This is a proposed experience, not an implemented screen,
a new unified workspace API or evidence of a completed user study.

## User task and reason

A contributor should recognise the project they are working in, inspect its shared context, and send a message
without losing an unfinished draft or confusing a policy refusal with missing history. A reviewer should understand
when a tool is waiting for confirmation or independent approval, and what can happen next.

Keep project context, conversation identity and billing attribution visible at the point of action. Reduce repeated
navigation and input before considering any reduction in security ceremony. A familiar chat layout does not make an
agent's tool permission broader than the caller's.

Traceability: UIW-01/02/03/04/05 and UXP-001/002/003/005/006 in [the review record](../codexreviews.md).
UIW-03 remains assigned to E35; shared-context changes remain E50's work. Reuse the current builder Composer's
acknowledgement-aware draft clearing and IME guard rather than rebuilding them. No finding closes from this mockup.

Existing routes: `/projects/:projectId`, `/projects/:projectId/context`, `/projects/:projectId/context/graph`,
`/builder`, `/builder?thread=…`, `/chat`, `/runs` and `/runs/:runId`. Keep their distinct contracts.

## Desktop wireframe — project overview, approximately 1440 px

```text
+--------------------------------------------------------------------------------+
| < All projects                                                                 |
| Example project                         Your role: contributor                  |
| Classification: [actual project classifications]                               |
+--------------------------------------------------------------------------------+
| [Spend & members]  Shared context  Version graph                                |
+----------------------------------------------------+---------------------------+
| Work with this project                             | Project cost summary      |
| Shared context contains the project's recorded     | Period: current month     |
| references and revisions.                          | Recorded call cost: ...   |
|                                                    | Forecast: ...             |
| [Open shared context]                              | Basis and units shown     |
|                                                    | Budget: ...               |
| Other places to work                               | Effective budget status   |
| Agent chat / Chat / Runs                           | [Download cost CSV]       |
| These open their existing destinations.             |                           |
| Choose or verify project scope there before acting. |                           |
+----------------------------------------------------+---------------------------+
| Members                                                                        |
| Account / Effective project role / Permitted membership actions                 |
| Existing membership controls remain available to the appropriate role.          |
+--------------------------------------------------------------------------------+
```

Retain the existing three project tabs and their destinations. The suggested orientation card adds task language,
not another tab bar or activity database. `Open shared context` is the example primary action; where the user is
already in that tab, its permitted task becomes primary instead. Settings, exports and archive stay secondary.

The example has no actionable approval count, next-run recommendation or universal resume control: the overview
does not currently establish those facts. Link to existing unfiltered destinations honestly. Do not imply `/chat`
inherits this project, append an unsupported `projectId` parameter, or show another project's recent thread.
Any future project-scoped work aggregation needs an assigned, authorised and bounded server contract first.

An archived project shows the current `Archived` explanation and is read-only. Keep permitted historical evidence
available. A convenience link must not start new work against an archived project or bypass existing attribution rules.

## Desktop wireframe — a builder conversation

```text
+--------------------------------------------------------------------------------+
| Agent chat / Example conversation                          New chat             |
| Agent: Example agent    Thread: [safe short reference]                           |
| Billing project: [verified agent project, only when supplied]                    |
+------------------------------------------------------+-------------------------+
| You                                                  | Conversation details    |
| Review this proposed change and explain its impact.   | Agent configuration     |
|                                                      | [Open agent]            |
| Agent                                                |                         |
| A tool request needs a decision before I can continue.| Recorded turn facts     |
|                                                      | [View graph]            |
| Tool request / Waiting for your confirmation          | Cost/source only when   |
| Target, operation, scope and redacted arguments        | present in the payload  |
| are shown here using the existing review content.     |                         |
| [Allow this tool call]  Deny  Cancel request           |                         |
+------------------------------------------------------+-------------------------+
| Message                                                                        |
| [Your unfinished message remains here while the request is resolved.          ] |
| Resolve the tool request above before sending another message.                  |
| Enter to send · Shift+Enter for a new line                       [Send message]  |
+--------------------------------------------------------------------------------+
```

Only the selected tool decision is primary while the thread waits. The composer stays readable but cannot submit
another message. `Allow this tool call` invokes the existing thread-owner confirmation route; it does not count as
an independent approval. For an approval pause, replace that decision row with `Waiting for an authorised reviewer`,
the permitted Inbox navigation, and the existing owner cancellation action. Never substitute a chat confirmation for
the approvals queue's signing, quorum or independent-review requirement.

The existing graph is per turn. Attach `View graph` to that turn's actual identity rather than inventing a
conversation-wide run identifier. Show billing project only from safe authoritative facts; an agent's name is not
proof of project attribution. Do not show stored credentials or raw unredacted tool payloads in the details panel.

## Phone wireframe — 375/390 px

```text
+-----------------------------------+
| < Agent chat   Example conversation|
| Example agent       [Details]     |
+-----------------------------------+
| You                              |
| Review this proposed change...    |
|                                   |
| Waiting for your confirmation     |
| Tool: Example operation           |
| Target and consequences           |
| [Show redacted arguments]         |
|                                   |
| [Allow this tool call]            |
| Deny            Cancel request    |
+-----------------------------------+
| Message                          |
| [Your draft remains readable   ] |
| Resolve the request before send. |
|                      [Send message]|
+-----------------------------------+
```

Use the existing detail/modal and responsive patterns; avoid a second conversation rail competing with the phone
composer. Details open deliberately, keep background content inert when modal and restore focus on close.
Long messages, arguments and file names wrap. Critical target/consequence text stays outside collapsed details.
The software keyboard and any action row must not cover the last input, inline error or pending decision.

## Draft and outcome contract

| Situation | Visible wording and behaviour |
| --- | --- |
| Initial thread read | `Loading this conversation…`; keep its selected identity; no unrelated transcript presented as its contents. |
| Successful empty thread | `No messages in this conversation yet.` Permit a message only when required agent/project facts are ready. |
| Transient history failure | `This conversation could not be loaded. Try again.` Keep the selection and same-session authorised context; do not jump to the newest thread. |
| Forbidden or missing history | Follow the existing non-disclosure contract and provide an authorised back route. Clear inaccessible cached content. |
| Known rejected send | `The message was not accepted.` Retain editable text and explain the actual safe recovery, including a policy refusal where applicable. |
| Sending | `Sending message…`; keep submitted intent/agent/thread fixed and prevent a second submit. Preserve any later draft edits. |
| Response streaming | `Receiving response…`; show received text without repeatedly announcing the entire transcript. |
| Outcome uncertain | `We could not confirm whether this message completed.` Check the supported thread/history record; do not offer blind replay. |
| Output withheld by policy | Explain that output is checked in full before display. Do not render streaming fragments that the server withheld. |
| Tool confirmation pending | Show exact permitted action, redacted arguments and consequences using current review content. |
| Independent approval pending | `Waiting for an authorised reviewer.` Keep the approval path distinct from chat confirmation. |
| Cancellation request pending | `Requesting cancellation…`; block conflicting confirm/send actions until the outcome is known. |
| Confirmed pause cancellation | `Tool request cancelled.` Only use the server-confirmed guarantee for that pending step. |
| Saved result, history refresh failed | Keep the acknowledged outcome and offer read recovery; never resend the turn merely to refresh the view. |

Bind drafts to the loaded conversation/agent and current principal; preserve suitable non-secret work only within its
authorised scope. Switching agent, thread, project or account must not silently submit an old draft in the new context.
Use the owner's dirty-discard prompt when leaving edited work. This proposal does not require persisting prompts or
attachments in browser storage; avoid creating a new sensitive cross-session draft store.

Generic `/chat` is a separate streaming path. Its current Stop control aborts the client stream; it is not proof that
server dispatch or metering stopped. Label it `Stop receiving` with the supported consequence, and reconcile history.
Do not claim an active operation was cancelled because an `AbortController` fired. A true server-cancel action requires
its own supported end-to-end contract and declared lifecycle; this mockup adds none.

## Existing components and contract gates

| Reuse now | Integration or missing facts to verify |
| --- | --- |
| `ProjectChrome`, `useProjectChrome`, project cost/member queries | Preserve actual project classification, role, archive state and data provenance. A failed membership read is not a confirmed role or empty directory. |
| `BuilderChatPage`, `Composer`, `MessageList`, current `chatRefusal` | Keep acknowledgement-aware clearing, IME handling and thread identity; add a visible shortcut hint without a second composer engine. |
| `BuilderPendingStep` and current confirm/cancel routes | Respect pause kind, ownership, exact step ID and authoritative final response. No arbitrary run-cancel button. |
| Existing per-turn `RunGraph` and `/runs/:runId` page | Use an actual matching identity. A builder turn, conversation and orchestration run are not interchangeable records. |
| `ChatPage`, `RefusalNotice`, `RecordError`, `ErrorState`, shared dialogs | E35 owns history recovery. Reuse its final contract rather than patching a parallel local history cache. |
| Existing attachment validation and list/metadata APIs | Show actual limits, failures and attribution readiness. A saved credential/configuration does not prove provider health. |

Source entry points:
[ProjectDetailPage](../../../apps/web/src/views/projects/ProjectDetailPage.tsx),
[projectChrome](../../../apps/web/src/views/projects/projectChrome.tsx),
[BuilderChatPage](../../../apps/web/src/views/builder/BuilderChatPage.tsx),
[BuilderUi](../../../apps/web/src/views/builder/BuilderUi.tsx),
[builderApi](../../../apps/web/src/views/builder/builderApi.ts),
[ChatPage](../../../apps/web/src/views/chat/ChatPage.tsx) and
[RunDetailPage](../../../apps/web/src/views/runs/RunDetailPage.tsx).
All state tables above map existing facts into copy; they do not define another product transition engine.

## Keyboard, accessibility and Claude acceptance

1. Complete project → shared context and conversation → tool decision using native links/buttons and existing focus rules.
2. Refuse a builder send, then accept it: the rejected draft remains editable, acknowledged text clears, and later edits survive.
3. Test composing Enter, ordinary Enter and Shift+Enter. Retain the current IME guard; record real OS/IME results separately.
4. Restore conversation A with a 503 while B exists: selection stays A with actionable error. Compare actual 403/404 behaviour without leaking inaccessible content.
5. Switch A→B with a delayed response: A's history, draft, pending request and approval controls never become B's.
6. Test ordinary response, buffered policy-checked response, tool confirmation, independent approval, cancellation refusal and uncertain timeout separately.
7. Check that a generic stream interruption never claims server cancellation or unmetered execution; no automatic repeat write occurs.
8. Verify project archive and denied membership/attribution states without granting new access or guessing an available agent.
9. Keep message/attachment labels, visible focus, status text, target minimums and accessible errors; announce concise status rather than every token.
10. Exercise 375/768/1440 px, both themes, 200%/400% zoom, reduced motion and a real screen reader. Compare completion, lost drafts, wrong-context attempts and recovery success with the current UI.

These are proposed acceptance checks. Synthetic fixtures do not establish native assistive-technology behaviour,
real provider execution, user confidence or a measured usability improvement.
