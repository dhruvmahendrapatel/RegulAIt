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
# one-time sign-in passwords AND demo API keys are printed once, at the end of
# the gateway's first-boot log:
docker compose logs gateway | grep -A20 "demo data"
```

Then open **http://localhost:3000/ui** and sign in with a username (not an email)
plus the one-time password from that log. Each persona is forced to set a real
password on first sign-in.

- **dana** (requester) — start in **Chat**: the mock agents reply instantly with
  streamed output and a full governance/routing/cost trace, no external API keys needed.
  Then check **Runs** (auto-advance the seeded multi-agent run) and **Workflows**.
- **avery** (approver) — the **Inbox** has a real sign-off waiting.
- **admin** — the whole governance console lives in the same shell: **Rules engine**,
  **Approvals queue**, **Audit log**, **Cost dashboard**. Add a model credential under
  **Model credentials** (anthropic/openai/google/xai) and the corresponding seeded agents
  start doing real dispatches. On a self-hosted box you can skip the paste and set the
  provider's API-key env var instead (below) — Chat then defaults to Claude automatically.

> **`/ui` is the whole product surface.** The single-file `/app` and `/admin` shells were
> deleted by [ADR-0033](docs/decisions/0033-delete-legacy-template-literal-uis.md); those paths
> now 404 rather than redirect, deliberately, so a stale bookmark fails loudly.

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

### Tamper-evident audit anchoring (no cloud account needed)

The compose stack brings up **MinIO with a real S3 Object Lock bucket in
COMPLIANCE mode**, created automatically before the gateway starts. Nothing to
configure — `docker compose up --build` gets it. The audit hash chain's head is
anchored there, and for the retention period no principal can delete or alter a
written anchor, so a full-recompute forgery diverges from a head nobody can
rewrite.

```bash
curl -s localhost:3000/v1/audit/verify -H "authorization: Bearer dev-bootstrap" | jq .anchor
# → { "source": "worm_sink", "sinkMode": "compliance", "tamperResistant": true, "disclosure": "…" }
```

`tamperResistant` is read from the bucket at runtime (`GetObjectLockConfiguration`),
never from configuration — a GOVERNANCE-mode bucket, a missing default retention,
or an unreadable lock config all report `false` with a disclosure saying why.
Point it at real S3 (or any S3-compatible endpoint) by setting
`REGULAIT_AUDIT_ANCHOR_S3_BUCKET` and friends; `REGULAIT_AUDIT_ANCHOR=off`
disables anchoring entirely. Decision:
[ADR-0060](docs/decisions/0060-tamper-evident-audit.md).

> Object Lock protects a **version**, not a name: a later write to the same key
> adds a version rather than replacing it, so verification deliberately reads
> the *first* version. It stops edit and forgery — it does not stop the whole
> volume being destroyed, which is a different and much louder attack.
>
> On a dev box those anchors genuinely cannot be deleted for the retention
> period. To reclaim the space, drop the volume: `docker compose down -v`.

### TLS

The deployed dev box serves **HTTPS with a real Let's Encrypt certificate** at
`https://<dashed-public-ip>.sslip.io` — a Caddy reverse proxy inside the same compose stack, at no
added AWS cost (no ALB, no ACM, no domain). It lives behind the `tls` compose profile, so it is off
for the local quickstart above:

```bash
docker compose --profile tls up -d --build                    # real Let's Encrypt (on the box only)
docker compose --profile tls -f docker-compose.yml \
               -f compose.tls-local.yml up --build            # local proof, self-signed local CA
```

Runbook and caveats: [docs/ops/TLS.md](docs/ops/TLS.md). Decision:
[ADR-0029](docs/decisions/0029-zero-cost-tls-caddy-sslip-letsencrypt.md).

### Deploy it into your own environment (BYOC / air-gapped)

The quickstart above is local dev. To stand RegulAIt up in a customer's own cloud account or on an
air-gapped host — [ADR-0041](docs/decisions/0041-byoc-primary-motion.md) makes that the primary
motion — there is one command:

```bash
./scripts/install.sh --mode byoc --domain regulait.acme.example --tls letsencrypt
./scripts/install.sh --check --mode air_gapped --domain x.corp.local --dir /tmp/plan  # dry run
```

It preflights docker/compose/ports/disk, **refuses a missing or weak `REGULAIT_DATA_KEY`**, renders
`.env` + a compose override deterministically (re-running converges; it never destroys data), and
brings the stack up. The air-gapped path pulls and builds nothing — it runs pre-seeded images
loaded from a file and refuses Let's Encrypt, whose ACME challenge is an outbound call by
construction.

Updates are **signed bundles verified offline against a pinned public key**
(`scripts/build-update-bundle.sh` / `verify-update-bundle.sh` / `apply-update-bundle.sh`); the
verifier fails closed on a bad or missing signature, an unknown key, a modified/missing/unlisted
file, and a downgrade.

| | |
|---|---|
| Install, TLS choices, air-gapped image bundle | [docs/deployment/INSTALL.md](docs/deployment/INSTALL.md) |
| Signed updates, key custody and rotation | [docs/deployment/UPGRADE.md](docs/deployment/UPGRADE.md) |
| Backup / restore, and the `REGULAIT_DATA_KEY` custody warning | [docs/deployment/BACKUP_RESTORE.md](docs/deployment/BACKUP_RESTORE.md) |
| **What crosses the boundary, per mode, verified against source** | [docs/deployment/DATA_BOUNDARY.md](docs/deployment/DATA_BOUNDARY.md) |

### Hardening knobs (ADR-0031) — safe defaults, no configuration required

| Variable | Default | What it does |
|---|---|---|
| `REGULAIT_TRUSTED_PROXIES` | `172.28.0.2` in compose (Caddy); *unset = trust nothing* elsewhere | Which peers may set `X-Forwarded-*`. Comma-separated IPs, CIDRs, or `loopback`/`linklocal`/`uniquelocal`; `none`/`off` for nothing, `all` to trust every peer (discouraged). This decides both the client IP recorded in `auth_sessions.ip` / the audit trail **and** whether the session cookie gets its `Secure` flag. **If you front the gateway with your own proxy you must set this**, or client IPs collapse to the proxy's address and `Secure` turns off. The effective posture is printed at boot. |
| `REGULAIT_RATE_LIMIT` | `on` | `off` disables HTTP rate limiting entirely. |
| `REGULAIT_RATE_LIMIT_MAX` / `REGULAIT_RATE_LIMIT_WINDOW_MS` | `1200` / `60000` | The general per-client-IP bucket. |
| `REGULAIT_AUTH_RATE_LIMIT_MAX` / `REGULAIT_AUTH_RATE_LIMIT_WINDOW_MS` | `10` / `300000` | The stricter bucket on `/auth/login`, `/auth/mfa/verify` and `/auth/login-with-key`. |
| `REGULAIT_API_KEY_RATE_LIMIT_MAX` | `6000` | Per-API-key allowance, so a busy service account is neither throttled by nor able to exhaust its neighbours'. |
| `REGULAIT_CSV_WINDOW_DAYS` | `90` | Default date window on a CSV export when the caller names no `from`/`to`. `0` disables the window. |
| `REGULAIT_CSV_MAX_ROWS` | `500000` | Hard per-export row ceiling. |
| `REGULAIT_CSV_BATCH_ROWS` | `2000` | Rows fetched and written per streaming batch. |

CSV exports stream and are bounded; whenever a file is not the complete answer, the
response headers (`x-regulait-export-*`) and a trailing comment row in the file itself
say so. That row is a single quoted field starting `# REGULAIT EXPORT` — a parser that
reads column N from every line should skip it (`isCsvNoticeRow()` in
`apps/gateway/src/csv-export.ts`). `GET /v1/health/schedulers` (admin-only) reports
whether the audit-prune and backup-verification schedulers are failing.

> Deployment note: the compose file is dev-grade (fixed demo secrets — override them
> anywhere shared). The AWS dev stack is still **not production** — TLS closes the cleartext
> session-cookie hole, it does not change that status (see CLAUDE.md's standing guardrail).

## Status

Governance MVP — all eight P0 pillars have working, tested cores; see
[project-state/STATE.md](project-state/STATE.md) for the live picture.
