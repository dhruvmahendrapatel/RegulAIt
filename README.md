# RegulAIt

![CI](https://github.com/dhruvmahendrapatel/RegulAIt/workflows/CI/badge.svg)

RegulAIt is an AI-native agent/development platform, currently in its infrastructure bootstrap
phase. Long-term vision, architecture decisions, and live project status are tracked in this
repo rather than in any one conversation, so work can be picked up by anyone (or any AI session)
cold.

- **Start here if you're a human:** [project-state/STATE.md](project-state/STATE.md) for current
  status, [docs/product/VISION.md](docs/product/VISION.md) for the long-term product vision.
- **Start here if you're Claude Code:** [CLAUDE.md](CLAUDE.md) — read it first, always.
- **Decisions:** [docs/decisions/](docs/decisions/) — one ADR per architectural/technical
  decision, indexed in `docs/decisions/README.md`.
- **Infrastructure:** [infra/](infra/) — Terraform, organized as reusable `modules/` composed
  into per-project `environments/`.

## Quickstart — run it and click around

The fastest path (Docker):

```bash
docker compose up --build
# demo API keys are printed once in the gateway log:
docker compose logs gateway | grep rgl_
```

Then open **http://localhost:3000/app** and sign in:

- **dana** (requester) — start in the **Playground**: the mock agents reply instantly with
  streamed output and a full governance/routing/cost trace, no external API keys needed.
  Then check **Runs** (auto-advance the seeded multi-agent run) and **Workflows**.
- **avery** (approver) — the **Inbox** has a real sign-off waiting.
- **admin** — **http://localhost:3000/admin** for the governance console and the
  Cost & Projects dashboard. Add a model credential there (anthropic/openai/google/xai)
  and the corresponding seeded agents start doing real dispatches.

Without Docker:

```bash
pnpm install && pnpm -r build
# any Postgres 16 works:
export DATABASE_URL=postgres://user:pass@localhost:5432/regulait
export REGULAIT_DATA_KEY=$(openssl rand -hex 32)
export REGULAIT_BOOTSTRAP_TOKEN=dev-bootstrap
pnpm --filter @regulait/gateway seed    # idempotent demo data, prints keys once
pnpm --filter @regulait/gateway start   # migrations run on boot
```

Tests (`pnpm -r test`) need `DATABASE_URL` pointing at a scratch database.

> Deployment note: the compose file is dev-grade (fixed demo secrets — override them
> anywhere shared). Nothing here deploys to AWS; that step is deliberately gated on an
> explicit decision (see CLAUDE.md's standing guardrail).

## Status

Governance MVP — all eight P0 pillars have working, tested cores; see
[project-state/STATE.md](project-state/STATE.md) for the live picture.
