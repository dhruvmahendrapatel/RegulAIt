# Decision log (owner decisions on how the build is run)

Product decisions live in ADRs (`internal/decisions/`). This log records the owner's decisions and open questions about
running the build, plus a pointer to the ADR wherever a decision is a product decision. Newest first, below the open
questions.

## Open questions waiting on the owner

| Since | Question | Blocks |
|---|---|---|
| none | (none open) | |

## Decisions

| ID | Date | Question | Answer | Applied in |
|---|---|---|---|---|
| D-2026-11-18-09 | 2026-11-18 | Apply the dev-account rehearsal role for E10? | Deferred. E10 parks the rehearsal and does no AWS step | E10 told 06:09 |
| D-2026-11-18-08 | 2026-11-18 | Approve S7's git push (its permission layer refused it)? | Approved, push only (no force-push), relayed to S7. If S7's own permission layer still refuses, the owner approves in S7's session | S7 told 06:09 |
| D-2026-11-18-07 | 2026-11-18 | Where do the hand-over files live? | In the repo, under `internal/process/orchestration/`, with nothing identifying | This folder |
| D-2026-11-18-06 | 2026-11-18 | Scheduled tasks: the new rules say none unless asked | Keep the merge loop, a master check-in about every 40-60 min while PRs are in flight, and merge-loop restarts; nothing else | RULES.md §3 |
| D-2026-11-18-05 | 2026-11-18 | Workers posting outward: the new rules say never | Keep the GitHub exception: builders open draft PRs and post READY, and reviewers post their own verdicts; all else goes through the master | RULES.md §1 |
| D-2026-11-18-04 | 2026-11-18 | Worker count and reuse: the new rules cap at 10 and one batch per session | Phase down to 10 (about 4 reviewers and 6 builders) as lanes finish; a new session per batch; Opus medium for code, Sonnet for mechanical work | RULES.md §1 |
| D-2026-11-18-03 | 2026-11-18 | Adopt the master's optimisation plan? | Yes. Rule 15 (finish before starting), no new lanes, UI lanes on screens for merged features, Codex C1 (#936) reviewed first | Lane brief rule 15 |
| D-2026-11-18-02 | 2026-11-18 | RPA: reuse the open-source projects, do not hand-write | A reuse map in the lane-E45 ADR (#1010): use Playwright, @playwright/mcp, codegen and trace as-is, and later Robot Framework and rpaframework; AGPL/MPL projects are ideas only | #1010 (lane E45; its ADR is not merged yet) |
| D-2026-11-18-01 | 2026-11-18 | RPA placement, free-form control, authoring | A Robots library plus a Toolbox Robots tab; free-form browser control offered but high-risk and default-off; authoring by recorder and step editor, code upload, and agent-drafted, all through human approval; governed like every tool call | #1010, lane E45 |
| D-2026-11-17-09 | 2026-11-17 | npm advisory with no patched release (picomatch GHSA-fc5q-39xc-vjpf) blocks every PR | The no-fix rule: reported as NO FIX YET, not gated, never allow-listed, re-checked by 2026-12-17 | ADR-0184 addendum, #1004 |
| D-2026-11-17-08 | 2026-11-17 | CI throttle | At most one open PR per lane in review | Lane brief rule 14 |
| D-2026-11-17-07 | 2026-11-17 | Four build rules: state machines, open source compared first, F×S bug triage, finish/ask/recap | Adopted; security-checklist gaps stay blocking whatever the score; the master may approve dedupe deletes | ADR-0200 addendum, CLAUDE.md |
