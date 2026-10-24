# internal/ — project memory and internal docs

Everything in this folder is for the people and agents building RegulAIt. None of it ships with the product
([ADR-0201](decisions/0201-internal-folder.md)):

- **Images:** `.dockerignore` lists `internal`, so no container image build context contains it.
- **Bundles:** `scripts/build-update-bundle.sh` packs an explicit list of paths and `internal/` is not on it;
  `scripts/build-image-bundle.sh` packs only images built from that context.
- **Source archives:** `.gitattributes` marks `internal/ export-ignore`, so `git archive` leaves it out.

## Where each kind of record lives

| Folder | What it holds |
|---|---|
| [memory/](memory/) | [STATE.md](memory/STATE.md) (the live project state), [sessions/](memory/sessions/) (immutable session records) and [mistakes.md](memory/mistakes.md) (the append-only process-error ledger) |
| [decisions/](decisions/) | ADRs and their index, [decisions/README.md](decisions/README.md) |
| [product/](product/) | Vision, pillar specs, roadmap, demo scripts and runbooks, including the demo-only account setup and teardown |
| [research/](research/) | Research notes and spike write-ups |
| [reviews/](reviews/) | Review records and archives |
| [process/](process/) | How parallel sessions and agents work together: [CONTRIBUTING_PARALLEL_SESSIONS.md](process/CONTRIBUTING_PARALLEL_SESSIONS.md), [AgentCoordination.md](process/AgentCoordination.md), [PathForward.md](process/PathForward.md) and the external-review input ledgers |

`CLAUDE.md` stays at the repository root, where Claude Code loads it. Customer-facing docs stay in `docs/`
(`docs/api`, `docs/deployment`, `docs/ops`), next to the code.
