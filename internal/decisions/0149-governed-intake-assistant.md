# ADR-0149: A Governed, Suggestion-Only Intake Assistant

Status: Accepted (implemented)
Date: 2026-10-01
Narrows: ADR-0080 §3 ("no AI pre-fill") — see Decision
Related: ADR-0085 (EU AI Act screening), ADR-0056 (copilot's governed
dispatch), ADR-0147 (risk dimensions); demo task C2 in `AgentCoordination.md`
Migration: none

## Context

ADR-0080 shipped the intake questionnaire as a blank form and refused AI
pre-fill: the deployment held no model credential, and a "pre-filled" form
would have been mechanism without an instrument. The 2026-10-05 demo needs
assisted intake (Credo's GAIA intake), and competitors pre-fill with a model.

The objection in ADR-0080 was to a *fake* assistant, not to assistance.

## Decision

`POST /v1/use-cases/intake/assist` returns suggestions and writes nothing
except one audit row (counts and outcome only — never the proposer's
unsubmitted text).

1. **Deterministic half (always, no model):** `suggestIntake` in
   `@regulait/shared`.
   - Tier: the existing ADR-0085 classifier over the same strict answers the
     server screens on submission, so preview and stored screening agree. The
     fenced answers block is returned ready for §9.
   - Frameworks: rules over EU nexus, data categories, deployment and sector.
   - Risks: one rule per category, each returning *why* it fired, seeded from
     the risk library's declared starting positions (impact raised one step for
     a high/prohibited tier), with mitigating `controlRef`s narrowed to the
     suggested frameworks (every ref test-asserted to exist).
   - A draft of each narrative section composed only from the proposer's
     answers, labelled `source: "rules"`.
   - A prohibited tier is returned as `blocking`.
2. **Model half (optional):** `draftNarrative: true` + `agentId` runs the
   copilot's path — `agentDecision` (the ordinary entitlement check), then
   `executeGovernedDispatch` (PII, guardrails, budget, metering, audit). Only
   the narrative text can change. Each section reports `rules`, `mock` or
   `model`. A refusal, a failure, or a reply that is not the requested JSON is
   reported as such (`refused` / `failed` / `unparseable`) with the rules
   draft intact — canned mock prose is never presented as a draft.
3. ADR-0080 §3 is narrowed, not reversed: the questionnaire is still the
   proposer's submission, the tier is still computed server-side from what is
   submitted, and nothing an assistant suggests reaches the record unless a
   person submits it.

## Verification

- `packages/shared/src/intake-assist.test.ts` 8/8: control refs exist; tier
  equals the server classifier and the block round-trips through the server
  extractor; hero case frameworks/risks with reasons and narrowed controls; a
  quiet internal tool fires no risk rule (negative control); prohibited is
  blocking; draft traces to answers; smuggled tier and unknown context keys
  refused; narrative parser drops unknown sections.
- `apps/gateway/src/zz-adr0149-intake-assist.test.ts` 4/4 on a fresh database:
  nothing written but one audit row without the description; ungranted agent
  refused with no dispatch; entitled agent dispatches (metered) and canned
  prose is not passed off as a draft; identity-less caller and smuggled tier
  refused. `use-cases`, `copilot` and `openapi` suites pass unchanged.

## Not done

No uploaded-document context, no citations/confidence per suggestion, no
learning from reviewer edits — tracked in the parity checklist's assisted-intake
row. Model draft quality is unmeasured; the keyless mock cannot exercise it.
