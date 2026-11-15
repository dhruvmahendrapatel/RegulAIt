---
name: regulait-review
description: "Independent PR review for RegulAIt: code review, OWASP Top 10 security review, or browser-based design review, with numbered findings and an 'APPROVE at <sha>' / 'SECURITY APPROVE at <sha>' / 'REQUEST CHANGES at <sha>' verdict. Use when a session is dispatched as a reviewer or delta reviewer on a RegulAIt PR, or asked to review a RegulAIt branch. Not for building or fixing."
---

# /regulait-review

Adapted from OneRedOak/claude-code-workflows (MIT, © 2025 Patrick Ellis); see ADR-0260 and
`internal/process/REVIEW_CHECKLISTS.md`, which is the source of truth. This skill is the procedure; the checklist file
holds the criteria.

Arguments: `<pr-number> [code|security|design|delta] [<last-verdict-sha>]` (default `code`).

## Procedure

1. **You are a reviewer, not the master.** You post review comments only. Never merge, mark ready, retitle, push to the
   builder's branch or edit STATE.md.
2. Read `CLAUDE.md`, `internal/memory/STATE.md` (top recap), `internal/memory/mistakes.md` (the rules),
   `internal/process/CONTRIBUTING_PARALLEL_SESSIONS.md` §4 and `internal/process/REVIEW_CHECKLISTS.md` in full.
3. Fetch the PR head and record its **full 40-character SHA**. Read the PR's ADR and acceptance list. Do **not** read
   the builder's report or READY comment until your own findings are written down (ADR-0191).
4. Diff:
   - full review: `git diff origin/main...<sha>`;
   - delta review: `git log --no-merges <last-verdict-sha>..<sha>` and the diff of those commits, plus files a merge
     from main changed that the PR also changes. Continue the finding numbers from the last verdict.
5. Review against the checklist sections for the kind asked:
   - `code`: §3 (and §4/§5 where the diff touches security or `apps/web`);
   - `security`: §4, the OWASP Top 10 table and the CLAUDE.md security checklist line by line;
   - `design`: §5, live first: run the app (the `run` skill or the web Playwright setup), exercise the change at
     1440/768/375px, keyboard-only, and check the console, before reading the code.
6. Verify before filing: read the surrounding code; for a correctness or security claim, reproduce it with a test or
   a concrete input where you can. Run the touched tests as CI does (real Postgres for gateway tests).
7. File findings as `[n] <Blocker|High|Medium|Nit> file:line — problem, why (rule/principle), fix` (security:
   add the exploit path). Number in filing order; never reuse a number.
8. Then read the builder's READY comment: every earlier finding must be listed with its fixing commit (or an agreed
   PENDING row). A missing one is still open.
9. Post **one** PR issue comment, without asking anyone first. First line exactly:
   `APPROVE at <sha>`, `SECURITY APPROVE at <sha>` or `REQUEST CHANGES at <sha>`. An approval never carries an open
   Blocker or High. End with the Claude Code attribution footer.
10. Stop.
