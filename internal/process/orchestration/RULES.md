# Orchestration rules (owner, 2026-11-18)

These rules bind the master session and every worker session on the RegulAIt build. They come from the owner's portable
"cost-saving and hand-over rules" (2026-11-18), with four conflicts the owner resolved the same day (see DecisionLog.md,
D-2026-11-18-04 to -07). Where these rules and CLAUDE.md conflict, stop and ask the owner.

## 1. One master, cheaper workers

- **Master** is the Opus session the owner works with. It owns:
  - decisions;
  - final pass or fail and quality judgements;
  - releases and merges;
  - the work queue, these files and the rule file;
  - everything outward, apart from the GitHub exception below.

  It starts and archives worker sessions.
- **Workers** are builder and reviewer sessions, or subagents.
  - Code writing runs on Opus at medium effort.
  - Mechanical work runs on Sonnet: scripted steps, cross-checks, report builds, digest refreshes, wide searches,
    drafts and small scripts.
  - Workers write only their own output and make no decisions.
- **GitHub exception (owner, 2026-11-18).** On our own repository:
  - builders may open draft PRs and post `READY at <sha>`;
  - reviewers may post their own `APPROVE`, `SECURITY APPROVE` and `REQUEST CHANGES` verdicts.

  These posts are the review trail. Anything else outward goes through the master: issues, other repositories, any
  external service.
- **Suspended by the owner on 2026-11-20 (D-2026-11-20-01):** lanes keep running past the cap to speed up the build.
  The cap below applies again when the owner reinstates it.
- **At most 10 worker sessions at once** (owner, 2026-11-18), on separate files. The target mix is about 4 reviewers and
  6 builders. The existing long-lived lanes are phased down as they finish under rule 15 of the lane brief: when a lane's
  queue is done it says "LANE DONE" and the master archives it.
- **One batch per new worker session.** The master reviews the output, then archives the session. A new session is
  started for the next batch.
- Use a subagent when the result is needed in the same turn. Use a separate session when the work runs on its own and
  ends in its own output.
- **Worker reports are claims.** The master checks each one directly with one query or command before relying on it. For
  example, before a release it checks the verdict comment at the exact head SHA and the check runs. After a merge, it
  checks that the merge's second parent equals the released SHA.

## 2. Keep the context small

- Reply in a short style. Write code, commit messages, PRs, tickets and safety warnings in normal language. Owner
  recaps stay in plain words, key points first.
- Read summaries before raw sources. Grep large files instead of reading them whole. Save outputs over about 20k
  characters to a file, then grep the parts you need.
- Do not re-read files already read in the session. Append to logs instead of rewriting them.
- Prefer small lookup scripts (about 10 lines of output) over loading big JSON or CSV files. No screenshots in context
  unless the result depends on them.
- Verify a change once, then move on.

## 3. Tool-call economy

- **GitHub:**
  - filter with `--jq` to the fields needed;
  - fetch only the latest comments that carry a verdict;
  - do not re-fetch after a write;
  - batch where the API allows it.
- **Databases:** named columns, small row limits, no `SELECT *` on wide tables. Quote decisive values only from
  single-row or COUNT/GROUP BY queries.
- **Chat and email:** read only what the owner asks for, limited to the named chat and time window.
- **Scheduled tasks (owner, 2026-11-18):**
  - keep the merge loop (the owner approved merging once CI is green);
  - keep a master check-in about every 40-60 minutes while PRs are in flight;
  - keep the merge-loop restarts;
  - no digest tasks, no routine chat or email reads, and nothing else unless the owner asks.

## 4. Running hand-over

Keep AgentHandoff.md, DecisionLog.md and Status.md current after every task or decision, not only at hand-over. Log every
mistake in `internal/memory/mistakes.md` the moment it happens, with its fix and a prevention rule.

To keep CI cost down, batch these updates into one small docs PR every few hours, or sooner after an owner decision.
The batching covers only the files in this folder: ADRs and STATE.md rows are still committed the moment a decision is
made, as CLAUDE.md requires. The
master's working logs (released.txt, lanes.md) stay in its scratchpad. They can be rebuilt from PR comments and merges,
and Status.md records their current content.

**Hand-over trigger.** When the master conversation gets long (after a large review or many file reads, or when replies
slow down):
1. Update AgentHandoff.md and Status.md.
2. Start a fresh master session on the same model, with a brief covering what to read, the pending decisions, the
   current batch and the hard rules.
3. Wait for the new session to confirm it has everything.
4. Tell the owner to archive the old session.

## 5. Compaction

The keep/drop list is in CLAUDE.md under "Compact instructions".
