# ADR-0294: NIST AI 600-1 suggested actions, AI RMF Playbook actions and a GAI-risk pack

- **Status**: Accepted (P18 lanes A3, A4 and B5, master brief 2026-11-14; built by builder lane L8)
- **Date**: 2026-11-14
- **Index**: NIST AI 600-1 actions and pack, and AI RMF Playbook actions on the AI RMF import (P18 A3, A4, B5)
- **Backlog**: [PENDING, P18](../product/PENDING.md); audit [2026-11-07 P18 coverage](../reviews/2026-11-07-p18-framework-coverage.md) lanes A3, A4, B5
- **Migration**: none

## Context

The P18 audit rated the NIST Generative AI Profile (AI 600-1) "partial (feed item only)" and listed the AI RMF
Playbook's suggested actions as the ADR-0215 "not done" item. Both are US government works, public domain, so their
text may be stored (ADR-0215 decision 2). Open source first: NIST publishes the Playbook as JSON on the AI Resource
Center, but publishes AI 600-1 only as a PDF; `usnistgov/oscal-content` has no AI 600-1 catalog (checked at the pinned
commit and at HEAD), and no maintained open-source machine-readable copy was found.

## Decision

1. **AI 600-1 as an import source, `nist-ai-600-1`.** The refresh script downloads the PDF (pinned by sha256, since
   the URL carries no revision), runs poppler's `pdftotext -raw` (a developer tool, never a product dependency), and
   the pure normaliser `normaliseNistAi600Text` parses the action tables into 212 entries: id, action text, the GAI
   risk tags (spelling variants normalised to the §2 names; one tag, "Civil Rights violations", is kept as written) and
   the AI RMF subcategory. It refuses an action with no tag or a repeated id, so a changed layout fails the refresh.
   One extraction defect (`GV4.3--001`) is repaired by name.
2. **The Playbook's suggested actions on the existing `nist-ai-rmf-oscal` source.** `withPlaybookActions` sets each
   subcategory's description to its suggested actions; references (third-party works) are not stored. The source
   schema gains optional `supplements` (title, licence, URL, revision, sha256, retrieval date), each refused unless its
   licence allows text, and the import's provenance note names them. Keeping one source avoids two sources writing the
   same framework, whose per-source baselines would mark every control as edited. An accepted AI RMF import whose text
   was not edited takes the new descriptions as `text_updated`; edited text is kept, as always.
3. **`nist-ai-600-1@1`, an authored pack of the twelve GAI risks.** Names and descriptions are NIST's text; coverage
   and collectors are our self-assessment on existing collectors (no new collector): eval runs (confabulation), the
   toxicity and prompt-injection detectors, the PII cascade, energy estimates, model-card fairness, approvals and model
   card approvals. CBRN, information integrity and intellectual property are unaddressed and attestation-required;
   obscene content is partial and attested (text screened, images not). Importing the actions onto it gives a draft
   v2 holding the twelve risks plus every action unmapped.

## Consequences

- AI 600-1 moves from feed-only to a seeded pack plus importable actions; the AI RMF pack's 72 subcategories can
  carry NIST's suggested actions.
- Refreshing AI 600-1 needs poppler on the developer's machine; the PDF parser is checked by counts and tags, not by
  NIST, so the import's admin review remains the gate.
- The trust radar gains a bias control from a v1 pack (risk 6); the ADR-0148 test now names it.
- Not done: the Playbook's transparency/documentation questions and references; an AI 600-1 crosswalk onto the
  evaluator catalog; console labels for the new framework (UI, #453).
