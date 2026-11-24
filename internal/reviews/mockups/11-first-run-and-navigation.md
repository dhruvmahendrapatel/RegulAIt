# Mockup 11 — First-run orientation and task navigation

**Design proposal for Claude, 2026-11-24.** Source baseline:
`2d57877b82fbb4c7d9969ffd88ee7ce7805f132e`.
See the [shared mockup rules](README.md). This is a proposed presentation of existing pages and facts,
not a replacement onboarding service, a completed user study or a promise that setup takes ten minutes.

Traceability: **CXR-BRN-UX-01** (information architecture) and **CXR-BRN-UX-02** (first run).
These are design proposals, not newly reproduced bug cards. Start with the owner-approved Home attention-first
order. User studies are deferred; participant targets remain unmet, and native device checks remain untested.

## The user task and the smallest change

A new administrator should distinguish “start configuring this installation” from “inspect its current readiness”,
then reach the next useful page without learning the suite taxonomy. An experienced administrator should retain
direct access to security and operational work.

The product already has two intentional setup surfaces:

- `/admin/first-run`: an ordered, resumable workflow that can mutate setup records, seed roles, apply a pack and import users.
- `/admin/setup`: a read-only readiness checklist computed from current objects, with links to existing configuration pages.

Keep those contracts separate. The smallest change is one Home entry card with two clearly different links, better
task aliases in existing search, and explicit return links from the configuration pages. Reuse `/v1/onboarding`
(`resumeAt`, recorded status, `satisfied`, drift, prerequisites) and `/v1/setup/status`; do not store another progress model.
Do not duplicate credentials or offer a new wizard field that bypasses the existing protected editor.

## Desktop wireframe — Home orientation, approximately 1440 px

```text
+--------------------------------------------------------------------------------+
| Existing suite rail | Home                                     Search           |
|                     |                                                          |
|                     | Needs attention                                          |
|                     | Existing permitted work and truthful counts              |
|                     | [Review decisions]                                       |
|                     +----------------------------------------------------------+
|                     | Set up this installation                                 |
|                     | Start with sign-in and access, then configure a model.    |
|                     |                                                          |
|                     | Resume: Connect a model provider                         |
|                     | Recorded: In progress   Current configuration: Not met    |
|                     | [Continue setup]                                         |
|                     | Review current readiness                                 |
|                     |                                                          |
|                     | Configuration is not proof of a successful external call.|
|                     +----------------------------------------------------------+
|                     | Recent work / Existing suite launcher                    |
+--------------------------------------------------------------------------------+
```

`Continue setup` links to the existing first-run route, whose own `resumeAt` selects the step. It does not append an
unsupported step parameter. `Review current readiness` links to the existing read-only checklist. When no workflow is
in progress, say `Start setup`; when the setup read fails, omit the guessed resume title and show an appropriate Retry.

The attention area is the primary active view when work needs attention; the setup card's continuation is then a
secondary link. When setup is the selected task, its continuation becomes primary. Do not introduce two competing
page-level primary buttons merely because both appear in this reference layout.

## Phone wireframe — 375/390 px

```text
+-----------------------------------+
| Menu  Home                Search |
+-----------------------------------+
| Needs attention                  |
| Current permitted work           |
| [Review decisions]               |
+-----------------------------------+
| Set up this installation         |
| Resume: Connect a model provider |
| Recorded: In progress            |
| Current configuration: Not met   |
| Continue setup                   |
| Review current readiness         |
+-----------------------------------+
| Recent work                      |
| Explore tools                  v |
+-----------------------------------+
```

Use the current suite drawer and shared cards. Keep Home attention-first; do not shrink every suite into an extra
phone tab bar. In the first-run page, use the existing stepper's responsive treatment and show one selected step with
its prerequisites, actual evidence and next action. A long step name wraps; its status is text, not only colour.

## The first ten minutes — orientation sequence, not a completion guarantee

| Task | Existing destination and honest next step | Why this helps / boundary |
| --- | --- | --- |
| 1. Understand where to begin | Home → `Continue setup` → `/admin/first-run` | One clear configuration entry. Keep recorded progress distinct from current satisfaction and drift. Do not display skipped work as technically verified. |
| 2. Establish sign-in and user access | Existing first-run identity step → `/admin/sso`, then `/admin/users`, `/admin/roles` and `/admin/group-mappings` as applicable | Explain the relationship: identity authenticates; a mapping assigns an ordinary role; a role must still grant access. Starter roles have no grants and cannot confer platform administration. Preserve current local recovery, proof and last-provider protections. |
| 3. Configure a model endpoint | Existing model step → `/admin/model-credentials`; use `/admin/custom-providers` when the supported self-hosted/provider contract requires it | Saving a write-only credential is configuration, not connectivity, entitlement or successful dispatch. Explain existing next destinations for an agent and model policy; never invent a “Test connection” action. |
| 4. Establish scope and policy | Existing role/grant pages, `/projects`, `/admin/compliance`, `/admin/rules`, `/admin/model-policy` as the task requires | Keep project attribution, required policy and compliance consequences visible. A checklist tick grants nothing. Do not preselect broad grants or weaken a required floor to make the demo succeed. |
| 5. Add a connector only if the intended task uses one | Readiness checklist → `/admin/connectors`, or its existing catalogue link; git/PM tasks use their own existing connection pages | Connector registration, stored credential and per-user mode/data-scope grant are distinct. A first model call does not require configuring every integration. Do not add a mandatory connector step to the six-step onboarding lifecycle without an assigned contract change. |
| 6. Attempt one governed call deliberately | Existing first-call step → `/chat`; choose the actual permitted agent and billing project there | A call may cost money or contact an external endpoint. Require deliberate user activation and retain existing gates. A refusal is useful evidence with a safe explanation, not a reason to disable governance. |
| 7. Check what happened | Existing run/history, permitted audit and cost views; re-check setup | Only actual non-mock dispatch evidence satisfies the existing readiness signal. It does not prove every connector, policy inheritance path or external integration works. |

The wizard's existing dependency order remains authoritative. These links explain the task, not a parallel set of
transitions. An administrator can already skip an onboarding step when it does not apply; this records workflow
intent only and does not disable sign-in requirements, authorisation, classification or other server enforcement.

For air-gapped or self-hosted deployments, use supported local/self-hosted destinations and existing operational
instructions. Do not require public IdP consent, public model calls, external fonts or online registry downloads.
Do not infer deployment mode from a failed request. Any mode-specific badge needs authoritative deployment facts.

## Ranked cut, merge, keep — navigation only

“Cut” below means reduce default first-run presentation. No route, file, control or policy is deleted.
“Merge” means group task entry links while retaining each page and its authority/semantics.

| Rank | Decision and current destinations | Smallest proposed change and reason |
| --- | --- | --- |
| 1 | **Keep prominent:** Home, Inbox, setup continuation, sign-in/access and execution control | Preserve the current secure operational destinations and searchable links. Emergency execution control must remain directly findable; a first-run simplification must not bury an incident response action. |
| 2 | **Merge entry, keep contracts:** First-run setup + Getting started | One Home setup card offers `Continue setup` and `Review current readiness`. Never combine the mutable onboarding workflow with the read-only readiness response or equate their progress counts. |
| 3 | **Merge entry, keep contracts:** Approvals queue + Review workbench + ChatOps approvals | Search/task entry `Review decisions` opens the permitted queue; advanced routing/bulk/SLA work links to the workbench, while courier configuration remains separate. Do not create a second queue or route ordinary approval through admin-only pages. |
| 4 | **Merge task trail, keep controls:** SSO + provisioning + group mapping + roles | Add a short “Sign-in → membership → access” orientation trail. These are different trust boundaries; combining all editors would increase accidental privilege changes. |
| 5 | **Merge entry, keep provenance:** Model credentials + custom providers + Agents + Model policy | Explain `Configure endpoint → configure permitted agent → grant/use under policy`. Keep write-only secret editors separate from permission and policy editors. Do not equate a present credential with provider health. |
| 6 | **Cut from default first-run view:** specialist model training, advanced tracing/lineage, simulation and specialist scanning configuration | Retain the current suites and full search; show these after an explicit `Explore tools` action or within their existing specialist task. They are valuable later, but listing them as day-one requirements creates false setup work. No runtime capability is disabled. |
| 7 | **Keep distinct:** Posture, Enforcement posture, Reports, Audit log, Scheduled jobs | Improve task aliases (`review current controls`, `change enforcement`, `find recorded report`, `inspect audit`, `check scheduled work`). They answer different read/write/historical/installation questions; merging their data would obscure authority and provenance. |
| 8 | **Keep distinct:** Chat vs Agent chat; user Models vs admin model configuration | Add destination subtitles that name the task and audience. Different conversation/runtime contracts should not be collapsed because both contain a text box or model name. |

This is a design-priority ranking, not a defect-severity/F×S claim. No first-time administrator was studied or timed
in this pass. Reuse the single suite registry and current permission filtering; do not maintain another hand-written
route catalogue. Search aliases must refer to existing destinations and remain absent from non-admin results when
their destination is admin-only. Optional first-run grouping/collapse metadata would need an explicit registry change;
it is not claimed to exist today.

## Loading, error, partial and return states

| State | Visible wording and behaviour |
| --- | --- |
| Loading setup | `Checking setup…`; announced busy, no invented progress or resume target. |
| Onboarding read failed | `Setup progress could not be loaded.` Retry only that read; readiness and attention remain independently usable. |
| Readiness failed | `Current readiness is unavailable.` Do not show a successful zero or all-complete state. |
| Recorded done, current condition no longer met | `Recorded complete; current configuration needs attention.` Keep the specific existing drift evidence and repair destination. |
| Prerequisite incomplete | Name the required step and its actual destination. Explain whether starting is allowed versus recording completion; preserve the current server distinction. |
| Required proof cancelled | No protected change submitted; keep suitable non-secret work and return focus to its triggering action. |
| Save pending or outcome uncertain | Use the existing guarded mutation/proof flow; preserve target/context, prevent repeats, reconcile state before a new write. |
| Credentials saved, no successful dispatch | `Credential configured. A successful governed call has not been recorded.` Never say `Connected` merely from storage. |
| Returning from a configuration page | Re-read the existing authoritative setup queries and restore the relevant current step; do not increment progress in the browser. |
| Non-admin follows an admin setup link | Keep the normal access refusal and member navigation; no admin catalogue or private configuration details. |

## Existing source and implementation gates

- [suites.tsx](../../../apps/web/src/shell/suites.tsx): workspace links `:34–54`, sign-in/access `:252–276`, integrations
  `:280–306`, two setup destinations `:396–397`, suite filtering `:578–596`. Keep bookmarks and route paths intact.
- [HomePage.tsx](../../../apps/web/src/views/home/HomePage.tsx): setup query and summary `:260–308`.
- [FirstRunPage.tsx](../../../apps/web/src/views/admin/settings/FirstRunPage.tsx): actual step links `:67–74`,
  query/mutations `:94–132`, resume selection `:134–139`, recorded/current status and drift `:155–214`,
  starter roles and compliance consequences `:252–284`.
- [GettingStartedPage.tsx](../../../apps/web/src/views/admin/settings/GettingStartedPage.tsx): readiness task destinations
  `:19–65`, evidence rendering `:67–131`, status query and presentation `:139–231`.
- [onboarding.ts](../../../apps/gateway/src/onboarding.ts): current-object satisfaction `:164–213`, recorded/current
  separation, resume and `checklistGrantsNothing` `:275–325`.
- [onboarding step definitions](../../../packages/shared/src/onboarding.ts): existing dependency/skip semantics `:61–110`.
- [CommandPalette.tsx](../../../apps/web/src/shell/CommandPalette.tsx): scoped page/entity search, including admin-only use cases.
- [ModelCredentialsPage.tsx](../../../apps/web/src/views/admin/integrations/ModelCredentialsPage.tsx) and
  [ConnectorsPage.tsx](../../../apps/web/src/views/admin/integrations/ConnectorsPage.tsx): reuse existing credential and
  grant editors. Do not place secrets in Home, progress storage, search results or the new orientation card.

An exact “next eligible task”, setup relevance ranking or mode-specific completion policy needs actual safe server
facts; the first slice uses only existing `resumeAt` and readiness links. Search aliases need no new authority API.
Protected writes still require their existing server-side validation, step-up, authorisation, audit and declared lifecycle.

## Claude acceptance

1. New admin and resumed admin reach the existing selected step with recorded/current facts unchanged.
2. Repeat from a self-hosted/air-gapped fixture: irrelevant external integrations can remain skipped, with no new public call.
3. Save a credential but record no dispatch: configuration is not labelled provider health or completed first-call proof.
4. Remove a previously configured fixture, return to setup and verify drift rather than a sticky green record.
5. Fail onboarding and readiness independently; preserve unrelated successful attention/navigation regions.
6. Check task aliases, bookmarks, browser Back and existing route highlighting; no route or server store is deleted.
7. Check a non-admin search and typed admin URL: destinations/data stay permission-scoped and server-protected.
8. At 375/768/1440, both themes, keyboard and zoom: headings, selected step, prerequisites, errors and primary action
   remain readable; native links are used without nested interactive controls; focus returns after a proof/dialog.
9. Keep user-study targets deferred and native screen-reader/IME/password-manager/IdP/passkey checks listed as untested.

Research basis: the main review's existing NN/g task recognition/status principles, GOV.UK task-list/progressive
disclosure guidance and WCAG accessible navigation/authentication requirements. Existing setup components are the
implementation approach; no dependency or vendor code is proposed and no measured usability gain is claimed.
