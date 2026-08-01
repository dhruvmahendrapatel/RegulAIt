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
  and the corresponding seeded agents start doing real dispatches. On a self-hosted box
  you can skip the paste and set the provider's API-key env var instead (below) — the
  Playground then defaults to Claude automatically.

Without Docker:

```bash
pnpm install && pnpm -r build
# any Postgres 16 works:
export DATABASE_URL=postgres://user:pass@localhost:5432/regulait
export REGULAIT_DATA_KEY=$(openssl rand -hex 32)
export REGULAIT_BOOTSTRAP_TOKEN=dev-bootstrap
# Optional — activate a real model provider platform-wide with no admin-UI paste
# and no key stored in the DB (read at dispatch time only). Any of:
export ANTHROPIC_API_KEY=sk-ant-...   # (optional ANTHROPIC_BASE_URL) → Claude goes live
#   OPENAI_API_KEY / OPENAI_BASE_URL, GOOGLE_API_KEY (or GEMINI_API_KEY), XAI_API_KEY
# A stored per-user or platform credential still takes precedence over the env var.
pnpm --filter @regulait/gateway seed    # idempotent demo data, prints keys once
pnpm --filter @regulait/gateway start   # migrations run on boot
```

Tests (`pnpm -r test`) need `DATABASE_URL` pointing at a scratch database.

### Hardening knobs (ADR-0031) — safe defaults, no configuration required

| Variable | Default | What it does |
|---|---|---|
| `REGULAIT_TRUSTED_PROXIES` | *(unset — trust nothing)* | Which peers may set `X-Forwarded-*`. Comma-separated IPs, CIDRs, or `loopback`/`linklocal`/`uniquelocal`; `none`/`off` for nothing, `all` to trust every peer (discouraged). **If you put Caddy/nginx/an ALB in front of the gateway you must set this**, or every request is attributed to the proxy's address in `auth_sessions.ip` and the audit trail. The effective posture is printed at boot. |
| `REGULAIT_RATE_LIMIT` | `on` | `off` disables HTTP rate limiting entirely. |
| `REGULAIT_RATE_LIMIT_MAX` / `REGULAIT_RATE_LIMIT_WINDOW_MS` | `1200` / `60000` | The general per-client-IP bucket. |
| `REGULAIT_AUTH_RATE_LIMIT_MAX` / `REGULAIT_AUTH_RATE_LIMIT_WINDOW_MS` | `10` / `300000` | The stricter bucket on `/auth/login`, `/auth/mfa/verify` and `/auth/login-with-key`. |
| `REGULAIT_API_KEY_RATE_LIMIT_MAX` | `6000` | Per-API-key allowance, so a busy service account is neither throttled by nor able to exhaust its neighbours'. |
| `REGULAIT_CSV_WINDOW_DAYS` | `90` | Default date window on a CSV export when the caller names no `from`/`to`. `0` disables the window. |
| `REGULAIT_CSV_MAX_ROWS` | `500000` | Hard per-export row ceiling. |
| `REGULAIT_CSV_BATCH_ROWS` | `2000` | Rows fetched and written per streaming batch. |

CSV exports stream and are bounded; whenever a file is not the complete answer, the
response headers (`x-regulait-export-*`) and a trailing comment row in the file itself
say so. `GET /v1/health/schedulers` (admin-only) reports whether the audit-prune and
backup-verification schedulers are failing.

> Deployment note: the compose file is dev-grade (fixed demo secrets — override them
> anywhere shared). Nothing here deploys to AWS; that step is deliberately gated on an
> explicit decision (see CLAUDE.md's standing guardrail).

## Status

Governance MVP — all eight P0 pillars have working, tested cores; see
[project-state/STATE.md](project-state/STATE.md) for the live picture.
