# RegulAIt

![CI](https://github.com/dhruvmahendrapatel/RegulAIt/workflows/CI/badge.svg)

**RegulAIt is AI governance that enforces itself.** The policy pack, the approval, and the
budget are not documents *about* your AI — they are the control plane your AI actually runs
through. One compliance tag cascades into required sign-off stages, PII blocking, and audit
retention; every pack control is evidenced by a **query over real ledgers, never a tick-box**
(ADR-0058); the audit chain anchors to write-once storage whose tamper resistance is
**observed at runtime, never assumed from config** (ADR-0060). Governance platforms review
traces after the fact; gateways proxy calls without a compliance vocabulary; RegulAIt is the
one plane where the control and its enforcement are the same object — vendor-neutral across
models, clouds, git hosts, and PM tools by construction.

Every claim above links to an ADR and the adversarial test that pins it — see
[docs/product/POSITIONING.md](docs/product/POSITIONING.md) and the market/gap analyses beside
it. Long-term vision, architecture decisions, and live project status are tracked in this repo
rather than in any one conversation, so work can be picked up by anyone (or any AI session)
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

**Demo personas with a password you choose** (ADR-0174 §6). For a demo you
would rather not start with the one-time-password dance, set one password for
Ada, Dana and Avery (`admin@` / `dana@` / `avery@regulait.local`) from the
environment or a secret file — never from the command line or the repository:

```bash
# read it without echoing, or point REGULAIT_DEMO_USER_PASSWORD_FILE at a 0600 file
read -rs REGULAIT_DEMO_USER_PASSWORD && export REGULAIT_DEMO_USER_PASSWORD
pnpm --filter @regulait/gateway demo:set-passwords      # (docker: docker compose exec -e REGULAIT_DEMO_USER_PASSWORD gateway node apps/gateway/dist/demo-set-passwords.js)
unset REGULAIT_DEMO_USER_PASSWORD
```

It checks the password against the org password policy, clears the personas'
one-time-password flag, revokes their live sessions, writes one audit row per
persona (`demo-password-set`, naming the source — never the password), and
never prints the password. It **refuses** when a customer (non-demo) licence is
installed, and on a box that looks deployed (`REGULAIT_DEPLOY_MODE` or
`REGULAIT_HSTS` set) unless the demo licence from `demo:prepare` is installed.
Enterprise sign-in (Microsoft / Google / GitHub through the optional Keycloak
broker, with MFA) is in [docs/deployment/SSO_KEYCLOAK.md](docs/deployment/SSO_KEYCLOAK.md).

The headline is the **compliance cascade** (§8.3): one `hipaa` tag on a project forces a
sign-off stage, blocks PII, and floors audit retention — nobody configured any of it per-change.

- **dana** (requester) — start in **Chat** billed to *hipaa-project*: paste a prompt with an
  SSN (e.g. 123-45-6789) and watch it **denied before the model runs** (red "PII blocked"
  badge, zero cost) — that's the tag's `piiMode`. The mock agents need no external API keys.
  Then check **Runs** and **Workflows**.
- **avery** (approver) — the **Inbox** holds the cascade story: *"Redact and export the
  oncology cohort (PHI)"* is parked at **compliance-signoff**, a stage no rule routed — the
  tag cascaded it into an ordinary feature change. Two more sign-offs wait behind it.
- **admin** — the whole governance console lives in the same shell: **Rules engine**,
  **Approvals queue**, **Audit log** (see the seeded `pii-blocked` deny; retention floored
  at the tag's 2555 days), **Cost dashboard**, and under **Workflows** a **template gallery**
  whose stages are annotated live with which compliance profiles demand them. Add a model
  credential under **Model credentials** (anthropic/openai/google/xai) and the corresponding
  seeded agents start doing real dispatches; on a self-hosted box set the provider's API-key
  env var instead (below).

> **`/ui` is the whole product surface.** The single-file `/app` and `/admin` shells were
> deleted by [ADR-0033](docs/decisions/0033-delete-legacy-template-literal-uis.md). *Corrected
> 2026-10-03:* those two paths **302 into `/ui`** (`app.ts`, kept for SSO's `returnTo` whitelist
> and old bookmarks) — an earlier revision of this note said they 404, which they never did. Only
> `/legacy/*` is gone outright.

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
HOST=127.0.0.1 pnpm --filter @regulait/gateway start   # migrations run on boot; HOST unset = every interface
```

Tests (`pnpm -r test`) need `DATABASE_URL` pointing at a scratch database.

### Verifying a clean checkout

**One command** (AER-003 / R2):

```bash
scripts/verify-clean-checkout.sh                 # steps 0-7 below; step 7 asserts
                                                 # `git status --short --untracked-files=all` is empty
scripts/verify-clean-checkout.sh --prove-failure # the control, in a temp clone: the assertion must FIRE on a
                                                 # modified tracked file and on an untracked one, and the script
                                                 # itself must exit 2 on a pre-dirtied tree and 1 on a tree a
                                                 # stage dirtied — a gate nobody has seen fail is a gate nobody
                                                 # can trust
scripts/verify-clean-checkout.sh --skip-tests    # steps 0-4 (the static pre-flight included) + step 7,
                                                 # no database (NOT a verification)
```

It runs exactly the sequence below, refuses to start on a tree that is already
dirty, and exits non-zero if any stage fails **or if the run itself changed the
checkout** — a rewritten lockfile or a regenerated fixture is a failure, not a
side effect. `VERIFY_PG` / `VERIFY_DB` pick the disposable database. The
build-script policy it relies on is explicit in `package.json`:
`pnpm.onlyBuiltDependencies` is empty (every dependency lifecycle script a
fresh install reported — esbuild's binary check, protobufjs's version-scheme
warning — was assessed as unnecessary; vite, vitest, drizzle-kit and the
Google SDKs build and run without them) and those two are named in
`pnpm.ignoredBuiltDependencies`, so an install is silent about them and loud
about any newcomer that starts wanting a build script.

The steps, for reading — run them by hand only if you cannot run the script.
It is the same sequence CI's `build-and-test` job runs (`.github/workflows/ci.yml`)
— build, test, and both pre-flights (the affordance census and the
unique-constraint check) — plus a repo-wide `--noEmit` typecheck and an
explicitly disposable database (the job's remaining step lints
`AgentCoordination.md`, the agents' bookkeeping file, and is not part of
verifying a checkout). It is the only sequence whose result is meaningful:
anything that skips a step below can go green on a tree that does not actually
build.

```bash
# 0. Use the package manager this repo pins. package.json declares
#    "packageManager": "pnpm@10.33.0"; corepack is what makes your shell honour
#    it. Skipping this is the single most common cause of a "broken clone"
#    report that the repo cannot reproduce — a mismatched pnpm resolves a
#    different tree from the same lockfile.
corepack enable
corepack prepare --activate          # activates the pinned pnpm, no version to retype

# 1. CI's affordance census (B9c): every DELETE route the gateway serves must
#    be reachable from a view, or be listed in the script with a reason.
#    STATIC — it reads route registrations and TSX sources; no install, no
#    build, no database — so it needs nothing from the steps below. Exit 0
#    clean, 1 a route no view can reach, 2 could not run.
node scripts/preflight-ui-affordances.mjs

# 2. Install EXACTLY the locked tree. --frozen-lockfile fails rather than
#    silently rewriting pnpm-lock.yaml, so a verification run can never be the
#    thing that changes what it is verifying. (CI installs the same way, via
#    pnpm/action-setup@v4, which reads the packageManager field above.)
pnpm install --frozen-lockfile

# 3. Build every workspace. This also typechecks and bundles the React SPA.
pnpm -r build

# 4. Typecheck every workspace against SOURCE, not dist/. Step 3 can pass on a
#    stale dist/; this cannot.
pnpm -r exec tsc --noEmit

# 5. Tests, against a database created for this run and thrown away after.
#    The suites are NOT re-runnable against a populated database — a run
#    reporting mass SKIPS is a dirty database, not a pass — so the drop is part
#    of the procedure, not cleanup.
export PGDATABASE_VERIFY=regulait_verify
dropdb --if-exists "$PGDATABASE_VERIFY" && createdb "$PGDATABASE_VERIFY"
export DATABASE_URL="postgres://regulait:regulait@localhost:5432/$PGDATABASE_VERIFY"
# 64-hex fixture key, the shape secrets.ts asserts. Not a secret.
export REGULAIT_DATA_KEY=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
pnpm -r test

# 6. Pre-flight the unique constraints, against the database step 5 just
#    migrated AND populated. It reports, per constraint, how many duplicate
#    groups would block migration 0108 or 0109 from applying, with example
#    keys. Exit 0 clean, 1 blocked, 2 could not run.
#
#    Run it HERE and not before: on an empty freshly-migrated database every
#    check is trivially zero, whereas after the suite the tables hold rows the
#    product's own write paths wrote. Migrations 0108/0109 ADD constraints and
#    REFUSE — they never repair, merge or delete — so this is the report that
#    tells an operator what a failed upgrade would have been about, before the
#    upgrade fails. See ADR-0109 and ADR-0110. CI runs this same step.
node scripts/preflight-unique-constraints.mjs "$DATABASE_URL"

dropdb --if-exists "$PGDATABASE_VERIFY"

# 7. The run must leave the checkout exactly as it found it. Empty output is
#    the pass; any path is a build or test writing into the tree.
#    --untracked-files=all because plain --short obeys status.showUntrackedFiles.
git status --short --untracked-files=all
```

**The exit code is the result.** `pnpm -r test` exits non-zero for a failed
assertion *and* for an unhandled error thrown outside any assertion — the
second kind is the one that used to make this suite's exit code
non-deterministic on an all-green run, closed by
[ADR-0106](docs/decisions/0106-mock-socket-net-contract.md). Do not read the
"N passed" line and stop; read `echo $?`.

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
| `HOST` (or `REGULAIT_HOST`) | `0.0.0.0` | The interface the native `pnpm start` binds. Set `127.0.0.1` on a laptop on a shared network — the plaintext gateway and its bootstrap token should not be reachable from the venue Wi-Fi. Compose keeps every interface inside the container and publishes loopback only. The bound address is the first boot line. |
| `REGULAIT_SHUTDOWN_GRACE_MS` | `15000` | On SIGTERM/SIGINT the gateway stops accepting, lets in-flight requests and the scheduler tick finish, ends the pool and exits 0 — within this budget, past which it exits 1. A second signal exits at once. Compose's `stop_grace_period` for the gateway is 30 s so the drain is never SIGKILLed. |
| `REGULAIT_OUTBOUND_TIMEOUT_MS` | `60000` | The deadline a guarded outbound fetch gets when its caller supplied none (OTLP export, OIDC discovery/token, connectors). MCP, scorer and model calls carry their own deadlines, which always win. |
| `REGULAIT_WORKFLOW_CLAIM_TTL_MS` | `900000` | How long a workflow stage's execution claim may go unreleased (a process killed mid-stage) before `/advance` may re-take it. The re-take is audited as `workflow-stage-claim-expired`. |
| `REGULAIT_OFFLINE_CHECKS` | *unset* (refused) | Set to exactly `1` to declare an offline/demo box on which a workflow template's `offlineAutoPass` may pass a named check nobody reported (labelled and audited). Unset, or on a box with `REGULAIT_DEPLOY_MODE` or `REGULAIT_HSTS` set, unreported checks stay pending (ADR-0167 amendment, AER-047). Never set it where real CI should gate a change. |
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
