# ADR-0171: Intake drafts, idempotent submission, kept edits and "not sure" answers

- **Status**: Accepted (owner, 2026-10-03: "fix AER-050 to AER-055")
- **Date**: 2026-10-03
- **Relates to**: ADR-0168 (governance flow), AER-046 (same-mount retry binding — not reopened)

## Context

An end-to-end review of the AI use-case intake (codexInputs.md, AER-050..055) found a coherent happy
path that a first-time business user can still lose work in, or be misled by:
work lives only in page memory (050); re-drafting silently replaces edits (051); an editable framework
rationale is never saved (052); the screening questions assume regulatory vocabulary and the only
incomplete-state help is a disabled button (053); the final review shows counts, not the proposal (054);
and a failed detail read can render "approved without conditions" (055).

## Decision

1. **Server-side drafts, one per user.** `GET/PUT/DELETE /v1/use-cases/draft` store the wizard's state
   for the signed-in user only (never another user's, never in browser storage, because questionnaire
   text can be sensitive). The wizard saves as you go and offers to resume; a resubmission keeps its own
   draft keyed by the use case. Leaving a form with unsaved changes asks first; Cancel and Back are
   disabled while a submission is in flight. Copy promises only what is true.
2. **Idempotent creation.** `POST /v1/use-cases` accepts an `Idempotency-Key`; a retry with the same key
   by the same user returns the already-created use case instead of a second one, so a lost response
   cannot duplicate a proposal or its risks.
3. **Edits are never silently replaced.** Returning to Classify and continuing without changes keeps
   every questionnaire edit and decision. Changing the classification shows which sections are affected
   and regenerates only with explicit consent.
4. **A framework rationale the user edits is saved and shown to reviewers** (per-framework rationale on
   the use case), rather than a control that discards its input.
5. **"Not sure" is a governed answer, never a silent No.** Each screening question has plain-language
   help and a "Not sure" option. For classification a "Not sure" counts as **Yes** (the conservative
   reading), and the use case records which answers were unsure so reviewers see them. An incomplete
   step lists what is missing and links to the first unanswered question.
6. **Review shows the proposal itself**: accepted framework and risk text, questionnaire sections
   (including rejected ones), the linked stack, who receives it and where to follow it, with
   "Edit this section" returning to Review.
7. **Unknown is not none.** If lifecycle detail fails to load, the record says so with a retry; it never
   renders "approved without conditions" or a completed lifecycle from missing detail.

## Consequences

- Migration 0134 adds the draft store, the idempotency key and per-framework rationale / unsure flags.
- The Monday demo's click path is unchanged; the final review page shows more.
- Not done here: validating comprehension with representative business users (053's last criterion) —
  that needs people, not code.

## Implementation (2026-10-03, night)

Built on two file-disjoint branches (backend: `use-case-drafts.ts`, `use-cases.ts`, shared screening schemas,
migration 0134; web: the intake wizard, resubmission, record page and review drawer) against one API contract,
then a wiring pass and an independent review.

- **Drafts**: one row per (user, scope); a use-case scope needs owner or admin; identity-less tokens are refused;
  256 KiB cap; drafts untouched for 30 days are pruned. The web guards leaving with `beforeunload` plus an in-app
  link interceptor — the app uses `<BrowserRouter>`, not a data router, so `useBlocker` is unavailable.
- **Idempotent create**: the key is claimed first inside the create transaction behind a unique (user, key) index,
  so a concurrent duplicate waits, conflicts and replays; a refused create releases the claim. The replay window
  equals the draft lifetime (30 days) — the review found that a 24-hour window let a resumed draft create a second
  use case after a lost response.
- **Not sure**: accepted on create and PATCH `screeningAnswers` (all ten yes/no keys) and inside the questionnaire's
  answers block (its seven EU keys); every listed key must be answered yes (422 `unsure_answer_must_count_as_yes`).
- **Review findings fixed before merge**: the review-policy demo journey's exact-match expectation, the replay
  window, a leave dialog that promised a save while the resume offer was pending, and the review drawer silently
  dropping the owner's notes when its detail read failed.
- **Robustness found on the way**: the app had no error boundary, so one malformed response blanked the home page;
  each home card now renders inside `CardBoundary`.

**Limits**: the browser's own Back button inside the app is not intercepted (the draft keeps the work); resume was
tested across a reload, not across sign-out and sign-in; resubmission keeps its retry-without-second-PATCH logic and
has no idempotency key; the create transaction now also starts the workflow instance, holding the audit-chain lock a
little longer (not measured); business-user comprehension of the screening help is untested.
