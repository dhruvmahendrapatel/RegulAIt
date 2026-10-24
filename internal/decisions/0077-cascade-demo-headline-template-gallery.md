# ADR-0077: The compliance cascade as the demo's headline path + a cascade-annotated workflow-template gallery

- **Status**: Accepted
- **Date**: 2026-08-15
- **Migration**: none — the gallery's built-in shapes are code constants validated by the real
  template-creation path at instantiation time; everything else derives from rows that already
  exist (`compliance_profiles`, `workflow_templates`).
- **Driver**: [MARKET_ANALYSIS_2026-08.md](../product/MARKET_ANALYSIS_2026-08.md) §3 concluded
  the §8.3 compliance-classification cascade (one tag on a project → required workflow stages,
  PII mode, MCP data-scope defaults, audit retention) is the product's single most defensible
  claim — and §4 items 4+7 observed that the seeded demo does not lead with it and that
  workflow templates are not discoverable by cascade profile.
- **Extends**: [ADR-0019](0019-data-sensitivity-dimension.md) /
  [ADR-0073](0073-rules-engine-versioning.md) (the cascade sources this derives from),
  [ADR-0074](0074-rule-read-model-write-choke-point.md) (the profile-edit path the flip test
  exercises), [ADR-0022](0022-workflow-template-retire.md) (templates as immutable-ish rows).

## Context

The cascade was already fully enforced (`requiredTemplateIdsFor` unions a classified project's
required templates into every instance; `projectPiiMode` blocks dispatches; retention floors
compose) — but a fresh `docker compose up` buried it: the seeded HIPAA instance rested at its
*requirements artifact* stage, so the one stage that exists **only because of the tag** never
appeared in anyone's inbox, and nothing in the admin surface showed which profile demands
which stage of which template. The most defensible claim in the product was invisible for the
first ten minutes of every demo.

## Decision

### 1. Seed: the cascade parked exactly at its own stage (item 4)

The seeder now starts one more instance — *"Redact and export the oncology cohort (PHI)"* —
as **dana** on `hipaa-project` with ordinary `changeType: feature`: the assignment rule routes
`standard-change`, the tag cascades `sensitive-data` in on top. The seed submits the
requirements artifact and approves the **standard** sign-off as avery, so the instance comes
to rest at **`compliance-signoff`** — the cascade-forced stage — pending in Avery's inbox on
first open. Idempotent by description, like every other instance seed (proven by the suite
running the seeder twice and asserting exactly one instance, parked at that stage, with
exactly one pending approval row). The printed seed summary and the README quickstart now
lead with the cascade story: Avery's forced gate, Dana's live SSN refusal on the tagged
project (the seeded `pii-blocked` deny already existed), and the 2555-day retention floor.

### 2. A workflow-template gallery mapped to the cascade (item 7)

`GET /v1/workflows/template-gallery` (admin-gated by the default route class) serves:

- **Built-in shapes** (code constants, no migration): `standard-change`, `design-review`,
  `build-and-check`, `hotfix`. Constants are inputs, not truth — instantiation runs them
  through the real `validateDefinition`.
- **Compliance-heavy shapes, one per profile that requires templates** — not constants at
  all: each is `mergeDefinitions([standard, ...requiredTemplates])`, the *same kernel merge*
  an instance on a tagged project gets (second triggers deduped, conflicts surfacing exactly
  as they would at instance start; on a merge conflict the gallery offers the profile's own
  stages rather than silently dropping a gate).
- **Per-stage annotations**: every stage carries `demandedByTags` — the profile tags whose
  cascade forces a stage with that id.

**The one hard rule: annotations are derived, never duplicated.** The derivation reads
`complianceProfilesForTags` (the ADR-0073 version funnel — the exact function the enforcement
cascade reads through) composed by `effectiveCompliancePolicy`, i.e. the same
`requiredTemplateIds` that `requiredTemplateIdsFor` unions into real instances. There is no
stored or hardcoded annotation anywhere. **Proof by attack** (`template-gallery.test.ts`): an
invented profile tag appears in the gallery the moment the profile row is written (a
hardcoded list could not contain a tag invented in the test), and **flipping** the profile's
required template — through the ADR-0074 choke point, minting a version — moves the
annotations, the forced-stage list, and the derived shape on the next read, with controls
asserting the tag's absence before creation and the old stage's absence after the flip. The
suite was shown red against the injected defect (a memoized/stale gallery): 6/9 tests failed,
including all three derivation tests.

`POST /v1/workflows/template-gallery/:galleryId/create` instantiates a shape as a real
template **through the one template-creation path**: the previous inline handler of
`POST /v1/workflows/templates` is extracted verbatim into `createWorkflowTemplateValidated`
and both routes call it, so kernel validation, approver resolution and nested-run-graph
validation apply identically (proven: an unresolvable `approverUserId` gets the path's own
422 `invalid_approver` and no row). The optional `approverUserId`
(`createFromGallerySchema`, packages/shared) replaces the kernel's `requesting_user`
placeholder before validation. Every create writes an audit row
(`workflow-template-gallery-created`) carrying the gallery provenance and the
cascade-demanded stages at creation time.

SPA: a gallery section on the existing WorkflowTemplatesPage — cards with stage chips,
warn-badges on cascade-demanded stages, the per-profile policy line (pii/mcp/retention), an
optional approver select, and one-click create through the POST above.

## Consequences

- The demo opens on the defensible claim instead of hiding it; the gallery makes "which
  profile demands what" a first-class read instead of archaeology.
- Because both the gallery and the enforcement read the same funnel, a profile edit moves
  both or neither — the drift class the market analysis warned about is structurally closed.
- **Honest limits**: the gallery annotates by *stage id equality* against required templates'
  stages — a profile whose required template names a stage `signoff` will mark every shape's
  `signoff` as demanded (same-id-same-meaning is already the kernel's merge assumption);
  compliance shapes whose required templates mutually conflict are omitted rather than
  half-merged; the built-in shapes' approvers default to `requesting_user` (self-approval)
  unless a concrete approver is chosen at create time; the gallery is derived per read — it
  is not cached, deliberately, and at admin-console traffic that is the right trade.
