# ADR-0213: Governed, Labelled Drafts for the Vendor Assessment Questionnaire

Status: Accepted (implemented)
Date: 2026-10-30
Narrows: ADR-0084 §2 ("nothing is pre-filled by a model") — see Decision 4
Related: ADR-0149 (governed intake assistant, the pattern reused), ADR-0056
(copilot's governed dispatch), ADR-0173 §3 (model policy features), ADR-0180
(secure by default), ADR-0186 A (`settings_relax` step-up)
Driver: backlog P6 (`internal/product/PENDING.md`); owner decision of 2026-10-30
on #453 (wave 1)
Migration: `0258_vendor_draft_assist.sql` (first reserved as 0231; renumbered above main's watermark under M-108 before merge)

## Context

ADR-0084's vendor questionnaire is a blank form: an assessor reads what a
supplier sent and types each answer. ADR-0149 already drafts the use-case
intake through governed dispatch with each section labelled by source. P6 asks
for the same on the vendor side, without a new model path and without letting a
draft become a record or an attestation by itself.

## Decision

`POST /v1/vendors/:vendorId/questionnaire/draft` returns drafts and never
writes a questionnaire artifact, an attestation or a vendor status. In
records-only mode it writes one audit row (counts and outcome, never supplier
text). In model mode the governed dispatch also writes what every governed call
writes: a usage event (the cost), its dispatch audit row and a trace span. The
span's input preview holds the start of the prompt, which can include pasted
supplier text, whenever the org's `tracingCaptureContent` is on — the same rule
as the intake assistant and every other dispatch, governed by that setting.

1. **Off by default.** `org_settings.vendor_draft_assist_enabled` defaults to
   false; the route refuses `409 vendor_draft_disabled` until an admin turns it
   on. The key is a rule in the strictness registry (`notEqual(false)`), so
   turning it on needs a `settings_relax` step-up and is audited as a relaxation
   in the settings write's transaction.
2. **Grounding (deterministic, always).** `suggestVendorAnswers` in
   `@regulait/shared` drafts each of the six sections only from what the
   platform holds: the vendor record, the organisation's own registry linkage
   (agents on the vendor's provider keys, linked custom endpoints), the
   vendor's prior attestations and the latest questionnaire of an earlier
   record of the same vendor. Earlier records are read only where the caller
   may see them (owner or admin). A section nothing grounds is empty and
   labelled `none`; nothing is invented.
3. **Governed model half (optional).** `useModel: true` runs the ADR-0149 path
   unchanged: `agentDecision` with a new model-policy feature `vendor_draft`
   (data class `confidential`), then `executeGovernedDispatch` (entitlement,
   PII, guardrails, budget, metering, attribution, audit). A `projectId` the
   spend is billed to passes `assertProjectAttribution` first, exactly as on the
   invoke route: a caller who is not a member of a project with members is
   refused `403 not_a_project_member` before any read or dispatch. A named
   model connection that does not exist is refused inline and audited. The prompt fences
   supplier documents as data. A model answer is kept only if it cites at least
   one source id it was given; otherwise the record-based draft stands. No model
   connection, an ungranted one, a failure or an unparseable reply is reported
   inline as `refused` / `failed` / `unparseable`, never as a draft.
4. **Labels and human acceptance.** Every section carries `source`
   (`rules`, `model`, `mock`, `none`) and its citations; the composed text
   carries a source line per drafted section, so the submitted artifact keeps
   it. Drafting changes nothing by itself: the assessor uses each drafted
   answer into its own section; "use drafts in unanswered sections" fills only
   sections still at the blank prompt; replacing a section the assessor already
   wrote takes its own, explicitly labelled click. The questionnaire is
   still submitted by a person through the workflow artifact endpoint, and an
   attestation is still recorded by a person through
   `POST /v1/vendors/:vendorId/attestations`. ADR-0084's "nothing is pre-filled
   by a model" is narrowed to "nothing is pre-filled; a drafted answer is
   labelled and counts only once a person submits it", and the blank form says
   so.

Placement (note on #453): Governance → Vendors, inside the vendor detail's
questionnaire card; the switch on Settings → Organization beside the
model-judged recommendations card; one new column on the Model policy matrix.

## Open source first (ADR-0176)

Nothing to adopt: this is policy semantics and evidence labelling on our own
gateway path. The JSON is parsed with the platform `JSON.parse` and validated
with the existing `zod` schemas; no new dependency.

## Verification

- `packages/shared/src/vendor-draft.test.ts`: grounded sections cite their
  sources and ungrounded ones are `none`; prior attestations, registry linkage
  and a filled prior questionnaire are used and cited, an unfilled one is not;
  supplier text is fenced and a forged closing tag stripped; the parser keeps
  only cited answers to known sections; the request defaults to records only and
  refuses unknown keys and oversized input.
- `apps/gateway/src/zz-adr0213-vendor-draft.test.ts` on a fresh database:
  off by default (409, nothing audited); turning it on is audited as relaxed;
  drafts never submit an artifact, record an attestation or change status;
  source labels present; no model connection and an ungranted agent are refused
  inline with nothing dispatched; an entitled mock agent is metered and its
  canned prose is not passed off as a draft; supplier text stays out of the
  audit row; non-owner, identity-less and unknown-key requests refused.
- `apps/web/e2e/zz-vendor-draft.mock.spec.ts`: drafting changes nothing until
  an answer is used, a used answer carries its source line, a typed answer
  survives a draft and is replaced only by its own labelled click, no artifact
  or attestation is posted, and both refusals render inline with a link (the
  model refusal with its reason).
- The gateway suite also pins the billed-project check (a non-member's foreign
  `projectId` is refused 403 with no usage event and no draft audit row) and the
  audited refusal of an unknown model connection.

ADR-0084 carries a dated addendum recording the narrowed rule.

## Honest limits

- The keyless mock replies with prose, so a successful model draft is pinned
  only through the parser tests; draft quality against a real model is
  unmeasured.
- Supplier documents are pasted text; there is no file upload or extraction.
- The UI sends one supplier document; the API accepts up to five.
