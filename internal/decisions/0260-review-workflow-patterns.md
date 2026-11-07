# ADR-0260: Review patterns from OneRedOak/claude-code-workflows, for our process and as workflow check templates

- **Status**: Accepted
- **Date**: 2026-11-07
- **Backlog**: P36 (owner-approved 2026-11-07, PENDING.md §2i)
- **Amends**: the workflow engine (pillar 2, [WORKFLOW_ENGINE_SPEC.md](../product/WORKFLOW_ENGINE_SPEC.md) §2 stage 8 and
  §3 "Automated check"); builds on [ADR-0044](0044-agent-evaluation-harness.md) (eval-bound checks) and
  [ADR-0187](0187-batch5-sidecar-engines.md) (engine-bound checks)

## Context

The owner asked (2026-11-07) to take the review patterns of
[OneRedOak/claude-code-workflows](https://github.com/OneRedOak/claude-code-workflows) (MIT, © 2025 Patrick Ellis) — a
two-loop PR code review, a security review, and a browser-based design review with Playwright — and use them in two
places:

- **(a) our own development**, which runs on many parallel Claude sessions with independent reviewer sessions, and
  whose review conventions so far lived in briefs and in AGENT_COORDINATION.md §1;
- **(b) the product**: seed templates for the workflow engine's automated-checks stage that a customer can assign —
  a code review, a security review and a design/UI review — each a governed agent step through the gateway with
  entitlements, cost and audit, producing structured findings, declarative, and off unless assigned.

Open source first (ADR-0176): the source is MIT text, not a library. Its value is the review method (checklist
hierarchies, triage matrix, two loops), which we adapt with attribution. There is no package to depend on.

The engine already has two machine-decided check kinds: an eval-bound check (ADR-0044) and an engine-bound check
(ADR-0187). Both run as the instance initiator, both fail closed, and neither can be reported or auto-passed.

## Decision

### (a) Our process

1. `internal/process/REVIEW_CHECKLISTS.md` is the reviewer's source of truth: the two loops (the builder's inner loop
   before each push, the independent reviewer's outer loop after READY), the code-review hierarchy, the OWASP Top 10
   security review merged with the CLAUDE.md security checklist, the live-first design review, and the briefs the
   master hands out.
2. Our own lessons are written in as rules: every finding gets a number that never restarts within a PR; each has a
   severity (Blocker / High / Medium / Nit); READY lists every finding with its fixing commit; verdict comments start
   with `APPROVE at <sha>`, `SECURITY APPROVE at <sha>` or `REQUEST CHANGES at <sha>` (full 40-character SHA);
   reviewers post without asking; a delta review covers only non-merge commits since the last verdict.
3. The security review does **not** import the source's exclusions (rate limiting, missing audit logs, missing
   hardening, insecure defaults). Under ADR-0180 and our security checklist those are findings.
4. `.claude/skills/regulait-review/SKILL.md` loads the procedure in a Claude session (`/regulait-review <pr> [kind]`).

### (b) The product: a review-bound check

5. **A third machine-decided check kind, not a new stage type.** An `automated_check` stage may carry
   `reviews: [{ check, agent, profile, failOn?, maxTokens? }]`, with `profile` one of `code_review`,
   `security_review`, `design_review`. The kernel validates it like the other bindings: the check is declared on the
   stage, and one check has one decider (an eval, an engine run or a review, never two). A quality gate is an automated
   check; a second failure mechanism beside `check_failed` would give the pipeline two ways to say no (the ADR-0044
   argument).
6. **Governed like any dispatch.** On stage entry the gateway runs each review through `executeGovernedDispatch` as
   the instance initiator on the instance's project: the entitlement decision is the eval runner's decider
   (`buildAgentDecider`, shared rather than re-implemented), the model policy feature is `evals` (a review check is a
   quality gate, ADR-0173 §3), cost is attributed to the project (pillar 5) and the call is audited by the dispatch
   core (pillar 1). The reviewer is pinned (no routing): the optimiser may not swap the instrument mid-review. A deny
   writes an audit row (`phase: review-check-entitlement`).
7. **Evidence is data.** The reviewer gets the change descriptor, the newest requirements artifact and the PR
   reference inside a delimited `<change_evidence>` block that the system brief names as untrusted; a forged closing
   tag is stripped and the block is bounded (60,000 characters, truncation recorded).
8. **Structured findings, numbered by the gateway.** The reviewer must answer with one JSON object
   (`summary`, `findings[]` of `severity`, `category`, `title`, `location`, `detail`, `recommendation`), validated with
   zod. The gateway numbers findings F1, F2, … in filing order and stores them, with the reviewer, model, cost and
   the blocking ids, on the check result (`checks:<stage>[].review`).
9. **Secure by default (ADR-0180).** `failOn` defaults to `medium`: every finding except a nit fails the check. An
   admin may relax it to `high` or `blocker` in the template (versioned and audited like every template change). A
   review that could not run fails: an unknown or unentitled agent, a refused or failed dispatch, a model refusal, and
   an answer outside the contract all produce `failed`. A review-bound check cannot be reported
   (`422 review_check_cannot_be_reported`) and is never auto-passed. A template naming a reviewer that is not in the
   registry is refused at creation (`422 unknown_review_agent`).
10. **Seed templates in the gallery, off unless assigned.** Four built-in gallery shapes (code constants, no
    migration): three add-ons, each a trigger plus one review check stage (`code-review-check`,
    `security-review-check`, `design-review-check`), meant to be added to matching changes by an assignment rule; and
    `build-and-review`, the standard chain plus a scoped build and one stage running a code and a security review
    before the merge sign-off. A gallery shape is not a template until an admin creates one, and a template applies
    only through an assignment rule. Creating a review shape requires `reviewerAgent` (the registry agent);
    the placeholder is never stored (`422 reviewer_agent_required`).
11. The review briefs are per profile and adapt the source: the pragmatic code-review hierarchy; the OWASP Top 10
    (2021) with our checklist items; the design-review phases with WCAG 2.1 AA.
12. **No migration.** Findings live in the instance context like every other check result.

## Consequences

- A customer can require an AI code, security or design review on any change an assignment rule matches, and the
  result is a governed, attributed, audited agent call whose findings are on the instance.
- Our reviewers share one checklist and one verdict format, written down instead of carried in briefs.
- **Not built (PENDING P36 follow-ups):**
  - the reviewer reads the evidence the instance holds, not the PR diff: the git providers have no diff read yet
    (GitHub, GitLab, Bitbucket and Azure DevOps each need one, through the guarded fetch);
  - the design review does not drive a browser: a governed, air-gapped Playwright step in the sandbox executor (the
    source's "live environment first") is a separate slice; until then the brief tells the reviewer to file a finding
    when the evidence is too thin;
  - UI: the stage rail and the approval view show the check's detail today but not the numbered findings list, and the
    gallery's create dialog has no reviewer picker. Posted to #453.
- An add-on shape merged into another template runs after that template's stages (mergeDefinitions appends); a review
  that must gate a merge belongs in the chain before the merge stage, as `build-and-review` shows.

## As built

- Kernel: `packages/workflow-kernel/src/index.ts` (`REVIEW_PROFILES`, `REVIEW_SEVERITIES`, `REVIEW_FAIL_ON`, the
  `reviews` binding and its validation).
- Gateway: `apps/gateway/src/workflow-review-checks.ts` (briefs, prompt, parser, executor), wired into the check
  executor, the claim guard and the report route in `workflows.ts`, and the reviewer-existence check in
  `createWorkflowTemplateValidated`; gallery shapes and `reviewerAgent` in `template-gallery.ts` and
  `@regulait/shared` `createFromGallerySchema`.
- Tests: `packages/workflow-kernel/src/index.test.ts` (ADR-0260 block) and
  `apps/gateway/src/workflow-review-checks.test.ts` (pure contract tests and real-Postgres integration with a
  recording provider).
- Attribution: `apps/gateway/THIRD_PARTY.md` row and `apps/gateway/third-party-notices/oneredoak-claude-code-workflows.md`.
