# Master hand-over

Read this first if you are taking over as the master session of the RegulAIt build. The rules are in
[RULES.md](RULES.md), the open owner questions in [DecisionLog.md](DecisionLog.md), and the live state in
[Status.md](Status.md).

## Onboarding

1. Follow the CLAUDE.md bootstrap: CLAUDE.md, `internal/memory/STATE.md`, `internal/memory/mistakes.md`, and
   `internal/process/CONTRIBUTING_PARALLEL_SESSIONS.md`. Then read this folder.
2. **Your job:**
   - Dispatch builder and reviewer sessions.
   - Send each PR that posts `READY at <sha>` to one code reviewer and a *different* security reviewer.
   - Release a PR when it has `APPROVE at <sha>` and `SECURITY APPROVE at <sha>` at its current full head SHA and every
     check run is success, neutral or skipped. Releasing means appending `<pr> <sha>` to `released.txt` and marking
     the PR ready (`gh api -X POST repos/<repo>/pulls/<n>/ccr/ready_for_review`).
   - Let the merge loop merge it.
   - Audit every merge: its second parent must equal the released SHA.
   - Fast-forward `dhruv/active` to `main`.
3. **Scripts:** these are in `scripts/master/` at the repo root. Keep `released.txt` and the loop log in your scratchpad.
   - `scripts/master/status.sh`: one line per open PR, with head, draft flag, failing and pending checks, and the verdicts
     at the head.
   - `scripts/master/merge-loop.sh <state-dir> 7000 90` (FS-25): run with `MIN_AGE=120` in the background, with a 2-hour
     timeout. Restart it about every 1h55m and after every container restart (`pgrep -fa merge-loop.sh`). It merges only
     PRs listed in `released.txt`, at that exact head, with a merge commit.
4. **Lane briefs:** every builder brief ends with the common rules 1-15 (rule 15: finish before starting). The text is
   in Status.md, under "Common lane rules".
5. **Messaging another session:** use a one-shot scheduled task bound to that session, set a few minutes ahead. The
   limit is about 7 per minute, and a time in the past fails.
6. **Hard rules:**
   - Nothing gets a production designation or a production deploy without the owner's explicit sign-off.
   - No terraform apply and no AWS write, apart from the logged, torn-down dev rehearsal.
   - Merge commits only: never rebase, never force-push others' branches, never merge one lane into another.
   - Never cancel CI runs without the owner's yes; the owner gave it on 2026-11-18 for superseded runs only.
   - Ask the owner before deleting anything.
   - Security-checklist gaps block, whatever their score.
   - The repo is public: post nothing identifying.

## Where we left off (current master)

- **2026-11-18, about 08:54 UTC:** master hand-over. The previous master stopped its merge loop and its scheduled tasks,
  and its session is to be archived. The new master runs the merge loop from its own scratchpad, seeded with the same
  released.txt.
- **Merged and audited today:** #1004, #880, #1011, #973, #941 (merge 82142059, second parent 3b86b4e0 = released).
- **Released, not merged (dirty after other merges):** #904 (E26), #903 (E12), #902 (E1), #883 (E20). Each builder was
  told to merge main and post a new READY. Then delta reviews: #904 R3 + Xtyd8; #903 R2 + a3BYi; #902 WaRPg + a3BYi;
  #883 WaRPg + Xtyd8.
- **Request changes, waiting on the builder:** #1010 (E45, RPA ADR only), #884 (E18, security RC on the directory opt-in
  and auto-link).
- **Older lanes:** E24 and E25 were done with no open PR and are archived. E2 (#848), E3 (#855), E7 (#861), E13 (#871),
  E15 (#865), E16 (#867) and E27 (#996) had been idle since 2026-11-17. Each was told to merge main once (the picomatch
  no-fix gate, #1004, clears their audit failure), fix any real failure, and post READY.
- **Next steps:**
  1. Route #936 (Codex C1, CI build-once) first when it posts READY.
  2. Delta-review the four dirty PRs as their READYs arrive; release on both approvals at the head.
  3. Archive lanes as they say "LANE DONE".
  4. Lift rule 15 a few lanes at a time once the open PR count is under 50, with E45's code first.
