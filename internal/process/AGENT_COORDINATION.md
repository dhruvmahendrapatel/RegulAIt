# Agent coordination board

> **Live board for every agent on RegulAIt: Claude (master and its cloud sessions) and Codex.** Set up by
> [ADR-0227](../decisions/0227-codex-gemini-rejoin.md) on 2026-10-31 and amended the same day: Gemini is not used, only Codex joins. The old three-agent board,
> [`AgentCoordination.md`](../archive/2026-10/AgentCoordination.md), is archived as a record.
>
> Read this whole file at the start of every session and again before every push. It holds **current state only**;
> the history is in `git log -p internal/process/AGENT_COORDINATION.md`.

## 0. Before you act

1. Read [CLAUDE.md](../../CLAUDE.md). Its rules bind every agent, not only Claude: the suite rules, the production
   guardrail, secure by default, open source first, the engineering guidelines and the security checklist.
2. Read [internal/memory/STATE.md](../memory/STATE.md) and [internal/memory/mistakes.md](../memory/mistakes.md).
3. Read [CONTRIBUTING_PARALLEL_SESSIONS.md](CONTRIBUTING_PARALLEL_SESSIONS.md) §3–§4. These are the collisions git
   merges without a conflict: migration watermarks, same-number files, journal appends and lost ADR index rows.
4. Find your lane on its PR (§2). If you have none, ask in "To Claude" (§5). Do not start unclaimed work.

## 1. Who does what

| Agent | Role | May edit | Never |
|---|---|---|---|
| **Claude master** | Dispatches lanes, enqueues PRs for merge (and the assign-at-merge PRs) on an independent APPROVE plus green CI, audits merges, relays with the laptop and the suite agent on #453 | Everything, including STATE.md, the ADR index and this board | Merge without an independent APPROVE at the exact head |
| **Claude cloud sessions** | Builders, reviewers and fixers, dispatched by the master | Their own lane's branch | Merge, release, change titles or draft state |
| **Codex** | Builder (own lanes) and independent reviewer (Claude lanes) | Its own `codex/<lane>` branches; its "To Codex" inbox; its review comments | Merge, mark ready, change titles or draft state; number a migration by hand; edit STATE.md, the ADR index or this board |

**Review independence (ADR-0191, kept by ADR-0227):**
- Never review your own lane.
- Start from the ADR, the diff and the acceptance list.
- Read the builder's report only after you have recorded your own findings.
- A Codex review of a Claude lane counts as independent, and so does a Claude review of a Codex lane.
- An external sign-in surface needs a separate security review ("SECURITY APPROVE at <sha>").

**Verdict format:** one PR issue comment starting `APPROVE at <full 40-char sha>` or `REQUEST CHANGES at <full sha>`.
List blocking findings with file:line and a concrete fix. End with the Claude Code footer if you are Claude, or your own
attribution line otherwise. Post without waiting for anyone's confirmation.

## 2. Lane state lives on the pull request

There is no live-status table any more (#738). A lane's state is what GitHub shows on its PR:

| Signal | Meaning |
|---|---|
| Draft flag | Work in progress. Drafts run the fast checks only. |
| `hold` label (or a legacy `HOLD ` title prefix) | Not to be merged until the owner or the master lifts it. |
| Checks on the head sha | Green or not, on exactly that commit. |
| `READY at <full 40-char sha>` comment | The builder's claim that the head is ready for an independent review (§4). |
| `APPROVE at <sha>` / `REQUEST CHANGES at <sha>` | The reviewer's verdict on exactly that head (§1). |

To see every lane at once, list the open PRs. Ask the master in "To Claude" (§5) for a lane before starting work.

## 3. Numbers and lanes

**Numbers are assigned at merge time** (ADR-0252, `CONTRIBUTING_PARALLEL_SESSIONS.md` §4.1 and §8). Nobody reserves or
renumbers by hand:
- **Migrations:** add `packages/db/migrations/pending/<slug>.sql` and never edit the journal. The assign-at-merge step
  numbers it after the merge. An open PR that still adds a numbered migration converts it with the steps in §4.1
  "Converting an open PR". Never run `drizzle-kit generate` (the script is gone).
- **ADRs:** take the next free number in `internal/decisions/` when you write the file, and add only the file; the index
  row is folded in at merge.
- **STATE.md and PENDING.md:** add a fragment under `internal/fragments/` (`CONTRIBUTING_PARALLEL_SESSIONS.md` §4.5).

**Lanes.** The master dispatches lanes and records each one on its PR (branch prefix, draft flag, labels), not here.
Process work approved on 2026-11-07 runs as three staged lanes, tracked on #738: A (CI), B (process and local gate) and
C (knowledge management).

## 4. Working rules for every builder (Claude or Codex)

- **Branch and PR.** One lane per branch from `main`, as a draft PR titled `HOLD …`. Use merge commits only: never
  rebase, squash or force-push, and never `git add -A`.
- **Open-PR cap: at most 5 open PRs per lane** (#738). Finish or close one before opening a sixth; a parked prototype
  becomes a draft issue, not an open PR.
- **No sibling-branch merges.** Never merge one lane's branch into another. CI enforces it
  (`scripts/preflight-branch-merges.mjs`, in the `ci / scope` job): every merge in the PR may bring in only commits
  already on `main`.
- **Stacked PRs.** A PR that needs another open PR's work targets that PR's branch as its base, and carries the
  `stacked` label. Only the master adds `stacked`: ask in "To Claude" with both PR numbers.
  - The check reads the labels when it runs, so after the label is added, re-run the failed `ci / scope` job (or push).
  - When the parent merges, retarget the stacked PR to `main`, merge `main` into it and push (a base change alone
    starts no CI run). The master then removes the label.
  - **The label is a convention, not an access control.** Every agent here acts as the owner's account and can add the
    label itself; a PR can also edit `ci.yml` or the script to skip the step; and on a fork PR, adding a label needs
    triage permission. The backstops are the independent review (which reads every workflow diff) and the master's
    merge audit.
- **Before you push:**
  - build the whole workspace;
  - run the tests for what you touched;
  - run `node scripts/migration-watermark-guard.mjs origin/main`;
  - run `pnpm exec vitest run --dir scripts adr-index` if you touched an ADR.
- **Merge conflicts in code** are yours to resolve by hand with a full build. A conflict that keeps neighbouring blocks
  from both sides can interleave them silently (M-109, M-111). A real logic clash goes to "To Claude"; do not guess.
- **Bundle budgets.**
  - The all-JS ceiling is 1,150 kB.
  - The entry JS ceiling is 139.5 kB during the freeze window.
  - Never edit `.size-limit.json` or `CEILING_EXCEPTIONS`; a raise needs the owner.
- **No secrets anywhere.** Keep secrets, keys, the demo password, model identifiers, real domains, customer
  identifiers, competitor names and personal host names out of code, PRs, comments and commits.
- **Banned words in product copy and docs:** "immutable", "Observed", "live oversight", "agents monitored". Say
  "tamper-evident" instead.
- **When CI is green,** post a BUILDER REPORT comment covering:
  - what changed;
  - each acceptance item, with file:line;
  - the tests and their results;
  - the bundle bytes;
  - the head sha.
- **Production and infrastructure.** Nothing is designated or deployed as production, and no `terraform apply` runs,
  without the owner's explicit yes in that session.

## 5. Inboxes — at most 8 messages each; the recipient deletes a message once handled

### To Claude
- (empty)

### To Codex
- Read §0, then ask in "To Claude" for a lane or a review task.
