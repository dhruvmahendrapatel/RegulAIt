# ADR-0201: Project memory and internal docs move into `internal/` (owner, 2026-10-24)

- **Status:** Accepted
- **Date:** 2026-10-24
- **Deciders:** owner
- **Relates to:** ADR-0005 (graphify `--code-only`), ADR-0167 (what the runtime image contains), ADR-0196 (enterprise
  UI harness, whose size-limit ADR path the baseline guard reads), ADR-0197 (demo of 2026-11-01)

## Context

Project memory (STATE.md, session records, the mistakes ledger), ADRs, product specs, research, reviews and the
agents' process notes were spread over the repository root, `project-state/` and `docs/`, next to the customer-facing
docs in `docs/api`, `docs/deployment` and `docs/ops`. The owner decided on 2026-10-24 (#453, comment 6389334200) to
move them into one top-level `internal/` folder that never ships with the product.

## Decision

1. **Layout** (moved with `git mv`, so history follows):

   | New path | Was |
   |---|---|
   | `internal/memory/STATE.md` | `project-state/STATE.md` |
   | `internal/memory/sessions/` | `project-state/sessions/` |
   | `internal/memory/mistakes.md` | `mistakes.md` |
   | `internal/decisions/` | `docs/decisions/` |
   | `internal/product/` | `docs/product/` (all but `IDE_INTEGRATION.md`), plus `docs/deployment/DEMO_REAL_ACCOUNTS.md` and `DEMO_TEARDOWN.md` (demo-only) |
   | `internal/research/` | `docs/research/` |
   | `internal/reviews/` | `docs/reviews/` |
   | `internal/process/` | `docs/CONTRIBUTING_PARALLEL_SESSIONS.md`, `AgentCoordination.md`, `PathForward.md`, `codexInputs.md`, `geminiInputs.md` |

   `decisions/` stays a sibling of `product/`, `research/` and `reviews/`, so ADR links such as `../product/X.md` still
   resolve. `internal/README.md` says what lives where.
2. **What stays with the code:** `CLAUDE.md` (at the root, where Claude Code loads it), `README.md`, `SECURITY.md`,
   `LICENSE`, `docs/api`, `docs/deployment` (minus the two demo files), `docs/ops` and
   `docs/product/IDE_INTEGRATION.md`. That last file is a customer recipe (the network rung of IDE interception) that
   the product names in two UI strings (`apps/gateway/src/compat-core.ts`, `ClientAccessPage.tsx`), so it stays with
   the operator docs and those strings stay true without a product change.
3. **Never shipped:** `.dockerignore` lists `internal` (it still excludes `docs` and `*.md`); `.gitattributes` marks
   `internal/ export-ignore`; `scripts/build-update-bundle.sh` packs an explicit path list without `internal/`, and
   `scripts/build-image-bundle.sh` packs only images built from the excluded context.
4. **CI:** every workflow `paths-ignore` that skipped `project-state/**` now skips `internal/**`, so a change only to
   internal docs still skips the heavy jobs.
5. **References:** every reference to a moved path was rewritten repo-wide (markdown links recomputed for each file's
   new depth, code comments, scripts, tests, CI and `CLAUDE.md`). In ADRs and session records only link targets and
   paths changed, never wording.
6. **Left as they were:** migration files (applied migrations are not edited). Bare file names cited in prose (for example "mistakes.md M-040") are unchanged.

## Consequences

- Tooling that reads these paths was updated: `scripts/adr-index.test.mjs`, `scripts/coordination.mjs` (and
  `pnpm checkin`), the ADR-0196 size-limit guard, and the tests and vector checks that read ADR-0189 or the demo scripts.
- Customer docs in `docs/deployment` and `docs/ops` that link to ADRs now point into `internal/`. Those targets were
  never in the update bundle before either; replacing them with self-contained text is a follow-up.
- The two product strings above point to a doc that does not ship. Rewording them is a product change for a later PR.
