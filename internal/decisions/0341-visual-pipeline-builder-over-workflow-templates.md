# ADR-0341: The visual pipeline builder edits the workflow templates themselves

- **Status**: Accepted
- **Date**: 2026-11-16
- **Index**: Visual pipeline builder: a canvas over the existing workflow templates, with drafts, versions, diff and an audited, step-up publish (accepts ADR-0232's canvas design)
- **Driver**: the owner's request of 2026-11-16 to close the gaps found against Camunda
  (`internal/product/GAP_ANALYSIS_CAMUNDA_2026-11.md`, row 1 and recommendation 4: "Visual pipeline builder shared by
  business and IT — ADR-0232's design, built on the existing JSON templates").
- **Accepts and changes**: [ADR-0232](0232-agent-pipeline-builder.md) (Proposed). What changes is recorded in §1; the
  rest of ADR-0232 is left as it is.
- **Migration**: `pending/workflow_template_builder.sql` (numbered at merge): two new tables, no change to an existing
  column.

## Context

ADR-0232 designed a drag-and-drop pipeline builder: a canvas (`@xyflow/react`, MIT, with `@dagrejs/dagre` for layout,
both already shipped in `apps/web/src/ui/runGraph/`), drafts, immutable versions with a content hash, a diff, and a
governed path from draft to something that runs. It also designed a second artifact, a `Pipeline` document with its
own kernel, step catalogue, run tables and monitor, and was left Proposed.

The Camunda comparison found the missing piece is narrower and more urgent: business and IT cannot **edit the same
workflow** together. Pillar 2's workflow templates are already declarative JSON (`packages/workflow-kernel`,
`workflowDefinitionSchema`), already validated, already executed, already governed (the forced plan gate, ADR-0079 and
ADR-0250; sign-off; checks; the governed deploy tail). What they lack is a visual editor and a safe way to change a
live template: today a template is created once and can only be retired (ADR-0022), never edited.

## Decision

### 1. What this ADR takes from ADR-0232, and what it changes

| ADR-0232 | This ADR |
|---|---|
| §1 a new `Pipeline` document and `packages/pipeline-kernel` | **Changed.** The canvas edits the existing workflow template JSON. There is no second format and no new kernel: the template is the document, `workflowDefinitionSchema` is the schema. |
| §1 a `layout` block outside the content hash | **Changed.** Nothing about the canvas is stored. Positions are computed from the stage order by dagre every time, so a definition opened, viewed and saved is the same bytes. |
| §1 content hash over canonical JSON (SHA-256) | **Kept.** The hash is SHA-256 over ADR-0060's `canonicalJson` of the definition. |
| §6 drafts, "save as version", immutable versions | **Kept**, for templates (§3). |
| §6 deployment behind an approvals-queue item | **Changed.** Publishing a template version is admin-only and needs a step-up (§4). A second admin's approval is an owner question below. |
| §9 the editor: palette, canvas, property sheet, Outline view, keyboard, phone, lazy chunk | **Kept** (slices 2 and 3), at an admin route (§7). |
| §11 `@xyflow/react` and `@dagrejs/dagre`; BPMN and bpmn-js rejected | **Kept.** No BPMN, no bpmn-js. |
| §2–§5, §7, §8 the step catalogue, triggers, run tables, monitor, data steps | **Not built here.** They stay as ADR-0232 wrote them, Proposed. The canvas built here is reusable by them. |

ADR-0232's status line now points here; its decision text is unchanged.

### 2. Round trip is exact

- The canvas is a **projection** of the definition. Each node is one stage, holding the stage object exactly as the
  template has it (unknown and opaque fields, such as a nested `run` graph, included). The edges are derived: the stage
  order, plus a dashed edge from an `automated_check` with `onFailure: "rollback"` to its `rollbackStageId`.
- Every canvas edit (add a stage, remove it, move it, change a field, set the rollback target) is a function from one
  definition to the next. The canvas never holds state the definition does not.
- `definition → canvas → definition` is the identity, byte for byte with key order, pinned by the canvas model's tests
  on the built-in gallery shapes and on a definition with every stage type and optional field; an edit followed by
  its inverse returns the original bytes. On the server, a draft opened from a template holds its definition exactly
  and a save stores exactly what was sent.

### 3. Drafts and versions

- **`workflow_template_drafts`**: at most one open draft per template. It holds the definition being edited (a
  configuration document; it may be invalid while someone is mid-edit, and is never executed), the version it was
  opened from, a `revision` for optimistic concurrency, and who created and last changed it.
- **`workflow_template_versions`**: append-only (`regulait_refuse_mutation`, no `TRUNCATE`). One row per published
  version: template, version number, the definition as published (a point-in-time snapshot), its content hash, and
  `origin`: `baseline` (the live definition captured the first time a template is opened in the builder, so history
  never starts from nothing) or `builder` (a publish).
- **Publish** writes the next version and replaces `workflow_templates.definition` in the same transaction. In-flight
  instances are untouched: an instance snapshots its merged definition when it starts (existing behaviour).
- **Creating** a template stays on the existing path (`POST /v1/workflows/templates` or the gallery). A new template
  matches no change until an assignment rule names it, so it is inert until then; the builder then edits it.
- Workflow templates are deployment-wide, not tenant rows (no org or project column), so the new tables follow
  `workflow_templates` and carry no row-level security policy. Access is the admin gate (§4).

### 4. Governance, enforced server side

Every rule here runs in the gateway on validate and again on publish; the UI only shows the answers.

1. **Admin only.** Every builder route is admin-gated (the default for a route outside `NON_ADMIN_ROUTES`).
2. **Schema on every edit.** Saving a draft returns its validation result: the kernel schema plus the same gateway
   checks the create path runs (approvers exist, reviewer agents exist, nested run graphs are valid, no retired eval
   dataset), refactored into one function both paths call. A draft that fails can be saved; it cannot be published.
3. **The forced plan gate (ADR-0079, ADR-0250).** A template with a stage that changes code or infrastructure
   (`automated_build`, `git_operation`, `deployment`, `rollback`) must have a `planning` stage before the first of them.
   Not relaxable from the builder: pillar 2 calls the plan gate forced.
4. **The governed deploy tail (ADR-0161's rule in template form).** Every `deployment` stage needs an earlier
   `human_approval` stage and an earlier `automated_check` stage with named checks. Not relaxable from the builder.
5. **Relaxations are explicit.** The diff (§5) lists what a publish weakens: a removed `planning`, `human_approval` or
   `automated_check` stage, a quorum moved from `all` to `any`, fewer named approvers, `offlineAutoPass` or
   `allowEvidenceOnly` turned on, a review's `failOn` loosened, a retry policy added. A publish with any relaxation is
   refused unless it carries `acceptRelaxations: true` and a reason, which the audit row records.
6. **Step-up.** Publishing needs a fresh step-up: kind `settings_relax`, op `workflow_template_publish`, bound to the
   template, the version it replaces and the content hash being published, so a grant for one publish cannot publish
   anything else. The existing kind is reused, as ADR-0250 did for grant mints, because a new kind would rewrite three
   CHECK constraints every parallel lane also edits; a dedicated kind is an owner question.
7. **Optimistic concurrency.** A draft save names the revision it edited; a publish names the draft revision and is
   refused (409) if the template was published from another draft since this one was opened.
8. **Out of scope for the builder, refused loudly.** A retired template (409) and an `ai-use-case-intake` template or
   variant (409): changing who signs off every new use case goes through the decision-regression gate (ADR-0182),
   which the builder does not yet drive.
9. **Bounds.** A draft definition is at most 256 kB and 200 stages.
10. **Audit.** Opening a draft, publishing (rule `workflow-template-published`: version, content hash, previous hash,
    diff summary, relaxations and the reason, step-up method) and discarding a draft each write an audit row.

### 5. Diff and history

- The diff between a draft (or a version) and the live template is an RFC 6902 patch (`rfc6902`, MIT, already
  pinned in `@regulait/shared`) plus a stage summary: added, removed, changed and moved stage ids, and the relaxations
  in §4.5.
- Version history lists every version with its hash, origin, publisher and time; any version can be compared with the
  live template, and opened as a new draft (restore is a publish like any other).

### 6. API (admin)

| Route | What it does |
|---|---|
| `GET /v1/workflows/builder/templates` | Templates with their latest version and open draft (keyset-paged) |
| `POST /v1/workflows/builder/templates/:templateId/draft` | Open the draft (from the live definition, or from a named version) |
| `GET /v1/workflows/builder/templates/:templateId/draft` | The draft, its validation result and its diff against live |
| `PUT /v1/workflows/builder/templates/:templateId/draft` | Save `{revision, definition}`; returns validation and diff |
| `DELETE /v1/workflows/builder/templates/:templateId/draft` | Discard the draft |
| `POST /v1/workflows/builder/validate` | Validate a definition without saving (the canvas calls it on edit) |
| `POST /v1/workflows/builder/templates/:templateId/publish` | Publish `{revision, acceptRelaxations?, reason?}` under step-up |
| `GET /v1/workflows/builder/templates/:templateId/versions` | Version history |
| `GET /v1/workflows/builder/templates/:templateId/versions/:version` | One version, and its diff against live |

### 7. The screens (slices 2 and 3)

- The editor lives at `/admin/workflow-templates/:templateId/builder`, opened from each row of the Workflow templates
  page; there is no new nav entry. This changes ADR-0232 §9 and §10 (`/builder/pipelines` in the Agent builder suite):
  the builder is admin-only (§4.1), and every Agent builder entry is shown to every user, so a link there would lead
  most people to a refusal. If owner question 2 lets non-admins edit drafts, the entry moves to the Agent builder
  suite then. "Pipeline packages" and "Pipeline runs" belong to ADR-0232's runtime and are not added.
- The editor is one lazy chunk sharing the `RunGraphCanvas` vendor split, with its own size-limit entry; the entry
  bundle does not grow. Palette (the stage types), canvas, property sheet, an Outline view that is the keyboard,
  screen-reader and phone path, loading skeletons, and the shared kit throughout.
- Slice 3 adds the diff view, version history and the publish flow (relaxation acceptance, step-up).

### 8. Open source first (ADR-0176)

- **Repo first.** Reused: `workflowDefinitionSchema` and the template create path's checks; `RunGraphCanvas`'s
  `@xyflow/react` and dagre setup; `canonicalJson` (ADR-0060); `rfc6902` through `@regulait/shared` (ADR-0246 already
  uses it); the step-up helper; the append-only trigger function; the shared UI kit.
- **Open source.** No new dependency. bpmn-js (watermark clause) and BPMN (ADR-0232 §11) stay rejected; FlowGram
  (ADR-0232 addendum) is not needed because the template is a stage sequence `@xyflow/react` already draws.
  JSON Schema form generators (`@rjsf/core`, Apache-2.0) were considered for the property sheet and not used: the
  stage schema has cross-field rules zod enforces server side, and a generated form would pull a large dependency into
  the lazy chunk for about a dozen fields.

### 9. The sub-process catalogue (follow-up, 2026-11-17; Camunda gap row 10)

Owner-approved addition to this lane, recorded here rather than in a new ADR (master brief, 2026-11-17).

1. **Fragments.** A sub-process is a named list of stages (`workflow_fragments`), versioned append-only
   (`workflow_fragment_versions`). A fragment has no trigger, calls no other fragment (one level only) and uses no `.`
   in its stage ids. It is validated by the template schema behind a trigger, so cross-stage rules (a rollback target)
   apply inside it.
2. **Approval before listing.** Every version is filed in the one Approvals Queue as kind `workflow_fragment`, decided
   by a named, active administrator who is not its proposer (`reviewer_is_author`, and
   `cannot_approve_own_fragment_version` in the decide path, even by admin override). One pending version at a time.
3. **State is the approval row (rule 12).** The version stores no state. The kernel's declared `FRAGMENT_VERSION_STATES`
   maps the approval's status: `pending → pending_approval`, `approved → approved`, `denied → rejected`, and anything
   else to rejected (fail closed). Only `approved` is listed and callable.
4. **Calls pin a version.** A draft writes `{ id, type: "call", fragment, version }`. Validate and publish expand it into
   the version's stages with ids `<callId>.<stageId>`, so the plan gate, the deploy tail, the relaxation check and every
   existing reader see the real pipeline. The live definition and every instance snapshot stay plain kernel
   definitions. The pin is a row of `workflow_template_version_fragments` (template version, call stage, fragment
   version), and reopening a draft collapses the expansion back into the call.
5. **A new version never moves a caller.** A template keeps its pinned version until it is republished, and only an
   approved version can be pinned.
6. **Gallery reuse.** `GET /v1/workflows/template-gallery` gains an additive `fragments` list (approved only).
7. **Screen.** `/admin/workflow-templates/sub-processes` (its own lazy chunk, `lazy: SubProcessesPage` 3.5 kB) lists the
   catalogue, proposes a sub-process or its next version, and shows each version's state. Calling a sub-process from
   the canvas palette follows once the canvas (slice 2) is on `main`.
8. **Open source compared (rule 9).** GitHub Actions reusable workflows (`uses: …@ref`), Argo Workflows `templateRef`
   and Camunda call activities with a `versionTag` binding all resolve a reference pinned by version at run time. Here
   it is resolved at publish instead, so the kernel and the instance snapshot need no change. Storing versions as
   ADR-0048 `config_versions` rows was considered and not used: that model keeps one active version per artifact,
   while callers must be able to pin any approved version, and it has no rejected state.

## Consequences

- Business and IT edit the same template, the one that runs; there is no export step and nothing to keep in sync.
- Templates gain history: every change after the first builder edit is a version with a hash.
- ADR-0232's pipeline runtime stays a separate, later decision; when it is built it can reuse this canvas.
- The builder cannot yet edit an intake template; that needs the decision-regression gate wired into publish.

## Owner questions

1. Should a publish need a second admin's approval (ADR-0232 §6's deployment approval), not only the publisher's
   step-up? Built meanwhile: admin-only, step-up, audited.
2. Should non-admins (for example a business role) be able to edit drafts while only admins publish? Built meanwhile:
   admin only.
3. A dedicated step-up kind for template publishes instead of `settings_relax` with an op?
4. Template versions are kept in two places: `workflow_template_versions` here, and E21's `config_versions` rows of type
   `workflow_template` (ADR-0340, #894, not yet merged). Which one is canonical? Built meanwhile: sub-process pins key
   to `workflow_template_versions`.
