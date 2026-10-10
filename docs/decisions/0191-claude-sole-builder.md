# ADR-0191: Claude is the only builder; Codex is retired

- **Status:** Accepted (owner, 2026-10-10)
- **Date:** 2026-10-10
- **Deciders:** owner. Direct instruction in the master session, 2026-10-10: "We will stop using codex and absorb all
  of its work. Claude will be our only builder now." Effective 2026-10-10 18:10 UTC.
- **Amends:** the work splits in ADR-0186 (Batch 4 halves and cross-review), ADR-0187 (Batch 5 web slices and the
  X29/X30 cross-reviews), ADR-0188 (S6 admin UI, the X31/X35/X37/X43/X45 reviews), ADR-0189 (B6 web UI, the review of
  every Claude slice, specification-only verifier vectors) and ADR-0190 (I9 web UI, the review of every Claude slice,
  specification-only escape and attestation vectors); `AgentCoordination.md` ground rule 2 (file ownership).

## Context

Since ADR-0186 the build has run on a two-builder model. Claude built the gateway, database and shared packages. Codex
owned `apps/web/**`, built some full vertical slices (Batch 4 R, S, V and M), cross-reviewed every Claude slice, and
wrote test vectors from ADR text alone so that verifiers were checked against the specification and not against their
own implementation. The coordination board (`AgentCoordination.md`) assigned the work, and Codex recorded findings in
`codexInputs.md`.

On 2026-10-10 Codex held about twenty open draft PRs and around thirty board tasks, many of them stacked on Claude
branches that have not yet merged. The owner has decided to stop using Codex.

## Decision

1. **Claude is the only builder.** Codex is retired from building and from review, as of 2026-10-10 18:10 UTC.
2. **Web UI ownership moves to Claude.** Every slice table row that names Codex now names Claude: ADR-0186 R, S, V and
   M; ADR-0187 X26 to X28 (already reassigned to Claude on 10-10); ADR-0188 S6; ADR-0189 B6; ADR-0190 I9. The
   ADR-0177 navigation and ADR-0180 strict-default rules for the UI are unchanged.
3. **Cross-review is done by independent Claude reviewer agents.** The "independent second reviewer" property of
   ADR-0186's cross-review protocol is kept as follows:
   - a reviewer agent runs with a fresh context and is never the agent that built the slice;
   - it is not given the builder's report, PR body or self-assessment first; it starts from the ADR, the diff and
     the acceptance list, and reads the builder's claims only after recording its own findings;
   - its findings keep the existing per-slice prefixes (for example `I7S4-NN`, `B9D-NN`, `I3R-NN`) and the existing
     format (ID, severity, evidence, acceptance);
   - the builder fixes its own findings and the reviewer, or a further fresh agent, rechecks each fix against the
     original red.
4. **Specification-only vectors are written by a Claude agent that does not read the implementation.** Its brief names
   the ADR sections and forbids reading the slice's source and tests. It writes the vectors before, or independently
   of, the implementation, and records which ADR text each vector comes from.
5. **`codexInputs.md` is frozen as a historical record.** Nothing new is appended to it. New review findings go in the
   PR under review and, if still open at merge, in the slice's ADR as a residual or a follow-up row, as the Claude
   security reviews already do.

### What happens to Codex's in-flight work

- **Open Codex PRs** are adopted (reviewed by Claude and merged), re-done by Claude, or closed. The disposition of each
  PR and task is set by the master session from the inventory taken on 2026-10-10 (ADOPT-MERGE, CLOSE or
  REDO-BY-CLAUDE per item).
  Adopted content is reviewed like any other change: CI green, gitleaks clean and a Claude review. Where a Codex review
  branch is stacked on an unmerged Claude branch, only its own files (its `codexInputs.md` entry and probe files) are
  adopted, after the Claude branch merges.
- **No new Codex PR is merged.** A Codex PR opened after the retirement time is closed unread.
- **Existing Codex findings still count.** A finding Codex raised stays tracked until it is fixed or explicitly
  dispositioned, in the PR that fixes it or in the slice's ADR. Retiring the reviewer does not close its findings.
- Board tasks assigned to Codex that were TODO or IN-PROGRESS are marked cancelled and absorbed by Claude.

## Consequences

- **One owner for every file.** The ground-rule-2 ownership split, the "To Codex" and "To Claude" handoffs for
  one-line changes outside one's own files, and the hot-file negotiation for `App.tsx` and `api/client.ts` no longer
  apply. Parallel Claude sessions still follow `docs/CONTRIBUTING_PARALLEL_SESSIONS.md` (surface ownership, migration
  and ADR number reservations).
- **Independence now depends on process, not on a different vendor.** Two agents of the same model can share blind
  spots. The fresh-context rule, withholding the builder's report and the no-implementation rule for vectors are the
  mitigation; a reviewer brief that breaks them is a review finding. The owner can still ask for an outside review of
  any slice.
- **More work for Claude.** The web UI for Batch 6 (S6, B6, I9, the SPDX fields form and the delegation settings), the
  accessibility audit and the real-stack sweeps join the Claude queue. Batch sequencing in ADR-0188, ADR-0189 and
  ADR-0190 is unchanged; UI slices still merge after the backend slices they depend on.
- **Review throughput.** Review work previously run in parallel by Codex now competes with building for Claude
  sessions. Reviews stay a merge gate for security-sensitive slices.
- **History is kept.** Earlier ADR text that credits Codex reviews and probes stays as written; it records who found
  what at the time. `codexInputs.md` and the board's git history remain the evidence for those findings.
- **The coordination board** keeps its structure for the remaining agents. Codex's live-status row and task blocks stay
  until Claude prunes them as handled.
