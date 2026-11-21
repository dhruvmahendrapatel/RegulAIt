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
| D-2026-11-21-01 | 2026-11-21 | Open more parallel sessions for the next 10 hours | Up to 50 sessions in parallel until about 11:00 UTC. Wake the 28 idle lanes on their oldest open PR (E18, E21-E23, E26-E44, L1, L2, L4, L6, UI-C). Add reviewer pairs R7 + S7 to R10 + S10, for 10 pairs in all (S5 not routed). Start new lanes for the 2026-11-20 governance gaps (#1123): memory-write trust floor, runtime oversight-level enforcement, rogue-agent containment | Lanes told 01:20; new sessions 01:13 onwards |
| D-2026-11-20-01 | 2026-11-20 | Add more builders in parallel | Lift rule 15 for E1, E13, E15, E17, E19, E20 and UI-C. Start new lanes E46 (live context graph, PENDING P2), E47 (privacy-ops limits on connector and MCP calls, ADR-0224), E48 (approval-rule matching on Cedar, P8 / ADR-0239) and E49 (pipeline step catalogue and runs, ADR-0232). Add reviewer pairs R5 + S5 and R6 + S6, for 6 pairs in all. Keep lanes running past the 10-session cap | Lanes told 02:38; new sessions 02:36-02:44 |
| D-2026-11-19-03 | 2026-11-19 | Free-form browsing limits (ADR-0364 §4); session housekeeping | 30-minute maximum run time and a $2 default budget per session (an admin can change it per project, audited). Archive the finished sessions, keep lanes running, and ask the owner questions as popups | E45 told 23:15 |
| D-2026-11-19-02 | 2026-11-19 | Speed up the build | Computed UI-gaps counter (#1067); lift rule 15 for E2, E7, E16 and UI-B; add reviewers R4 and S4; E45 starts S3 (browser runner) | Lanes told 21:45 |
| D-2026-11-19-01 | 2026-11-19 | Start lane E45 (Robots, governed browser automation for agents) now, while rule 15 holds? | Yes, as an exception for E45 only: S2 (backend) starts now and goes through the usual code and security review. Every other lane stays paused | E45 told 06:16 |
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
