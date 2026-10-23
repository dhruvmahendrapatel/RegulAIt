#!/bin/sh
# The gateway image's start command (Dockerfile CMD). Migrations run on boot
# (idempotent). SEED_DEMO=1 loads the demo dataset first — also idempotent;
# one-time passwords and API keys are printed to the container log ONCE.
# ADR-0181 FX3: SEED_DEMO defaults to 0 (compose, installer), and the seed
# refuses a database that has an admin who is not a demo persona.
#
# ADR-0174 amendment (Docker demo licence): REGULAIT_DEMO_LICENSE=1 — the ONE
# opt-in switch, normally a line in the .env next to docker-compose.yml — lets
# the demo seed mint its EPHEMERAL demo licence (the one `demo:set-passwords`
# requires) into /app/demo-license-keys, a named volume, and points the
# gateway at that same keyring so the licence still verifies after a restart.
#
# Anything other than exactly "1" changes NOTHING: neither variable below is
# set, so the gateway reads its default keyring and no licence is minted —
# exactly the behaviour before this switch existed. Honoured, it also runs the
# demo seed (the seed is what mints; ADR-0181 FX3: SEED_DEMO now defaults to 0,
# and the switch is the explicit demo signal). Never honoured on an installed
# byoc / air_gapped deployment (scripts/install.sh also pins it off).
#
# Demo prep (ADR-0174 amendment, "the Docker demo is prepared like the native
# one"): when the switch is honoured, this script also builds the SAME demo
# environment as `pnpm --filter @regulait/gateway demo:prepare`:
#   - REGULAIT_OFFLINE_CHECKS=1 for every step and the gateway (no CI in a demo);
#   - the export-signing key for the signed export (beat 3E), and the receipt
#     signing key (ADR-0189 R25: without it every sign-off is refused), made once
#     in the demo volume (/app/demo-license-keys/export-signing) and reused; only
#     their paths and the fingerprint are logged, never a key;
#   - the demo MCP server (demo-mcp-server.js, 127.0.0.1/127.0.0.2:8931) in the
#     background for the life of the container — the demo's tool calls hit it;
#   - on an EMPTY database (demo-docker-prepared.js, asked BEFORE the seed, exits 3):
#     identity-key-init (the installer's step, as CI runs it before demo:prepare), then
#     EVERY step of `demo:prepare` in its order, read from `demo-prepare.js --steps`
#     (demo-prepare-steps.ts is the one list): demo:shadow --setup → seed
#     --open-assurance-window → demo:setup → demo:intake → demo:shadow → demo:traffic
#     → demo:check. Never the live list. The marker the reader looks for lives with
#     the data, so a restart or `down` / `up` runs only the ordinary seed, and
#     `down -v` prepares again.
# A failed step is logged loudly with its name and the gateway STILL starts,
# so the UI and this log stay reachable rather than the container restart-looping.
# The prep cannot be finished in place once it has started (its first step needs the
# first-admin-setup window the seed closes): recovery is `down -v`, then `up`.
# A .env written on Windows (PowerShell Add-Content, Notepad) ends its lines with CRLF; strip ONE trailing
# carriage return so "1\r" counts as "1". Nothing else is normalised: " 1", "1 ", "true" still change nothing.
demo_license="${REGULAIT_DEMO_LICENSE:-}"
cr="$(printf '\r')"
case "$demo_license" in *"$cr") demo_license="${demo_license%?}" ;; esac
demo=0
if [ "$demo_license" = "1" ]; then
  # ADR-0181 FX3: the switch is itself the explicit demo signal, so it seeds
  # (below) whatever SEED_DEMO says; compose and the installer default SEED_DEMO to 0.
  if [ -n "${REGULAIT_DEPLOY_MODE:-}" ] && [ "${REGULAIT_DEPLOY_MODE}" != "hosted" ]; then
    echo "REGULAIT_DEMO_LICENSE=1 ignored: REGULAIT_DEPLOY_MODE=${REGULAIT_DEPLOY_MODE} is an installed deployment, and the demo licence is never minted on one" >&2
  else
    demo=1
    export REGULAIT_EPHEMERAL_LICENSE=1
    export REGULAIT_LICENSE_KEYRING=/app/demo-license-keys
    echo "REGULAIT_DEMO_LICENSE=1: demo seed mints (or keeps) an ephemeral demo licence — NOT A PRODUCTION DEPLOYMENT; keyring ${REGULAIT_LICENSE_KEYRING}"
  fi
fi

if [ "$demo" = "1" ]; then
  export REGULAIT_OFFLINE_CHECKS=1
  export REGULAIT_DEMO_KEY_DIR="${REGULAIT_LICENSE_KEYRING}/export-signing"
  # stdout is exactly four `export` lines (the export and receipt keys: a path and a key id each); the fingerprint is on stderr
  if key_env="$(node apps/gateway/dist/demo-export-key.js --env)" && [ -n "$key_env" ]; then
    eval "$key_env"
  else
    echo "*** DEMO PREP FAILED at step demo:export-key: no export-signing or receipt key, so the signed export (beat 3E) answers 409 and every sign-off is refused" >&2
  fi
  node apps/gateway/dist/demo-mcp-server.js &
  echo "demo: MCP server started in the background (pid $!) on 127.0.0.1 and 127.0.0.2, port ${REGULAIT_DEMO_MCP_PORT:-8931}"
fi

# ADR-0181 FX3: the demo seed runs only on an explicit demo signal (SEED_DEMO=1, or the
# switch above) and is told so with --seed-demo. It still refuses a database that has
# an admin of its own (a real install), and writes nothing then; the gateway starts anyway.
# With the switch honoured, an EMPTY database is seeded by the prep below instead
# (demo:prepare's seed step, which also opens the assurance window).
prepared=""
if [ "$demo" = "1" ]; then
  node apps/gateway/dist/demo-docker-prepared.js </dev/null
  prepared=$?
fi

if [ "$prepared" = "3" ]; then
  started="$(date +%s)"
  failed=""
  seeded=0
  echo ""
  echo "=== demo prep: identity-key:init ==="
  node apps/gateway/dist/identity-key-init.js </dev/null
  rc=$?
  if [ "$rc" != "0" ]; then failed="identity-key:init (exit $rc)"; fi
  if [ -z "$failed" ]; then
    if ! steps="$(node apps/gateway/dist/demo-prepare.js --steps </dev/null)" || [ -z "$steps" ]; then
      failed="demo:prepare --steps (no step list)"
    fi
  fi
  if [ -z "$failed" ]; then
    tab="$(printf '\t')"
    # each line: <name> TAB <file> TAB <args>; args never hold whitespace, so they split on spaces
    while IFS="$tab" read -r name file args; do
      [ -n "$file" ] || continue
      echo ""
      echo "=== demo prep: $name ==="
      # shellcheck disable=SC2086
      node "apps/gateway/dist/$file" $args </dev/null
      rc=$?
      if [ "$file" = "seed.js" ]; then seeded=1; fi
      if [ "$rc" != "0" ]; then failed="$name (exit $rc)"; break; fi
    done <<STEPS
$steps
STEPS
  fi
  if [ -n "$failed" ]; then
    echo "" >&2
    echo "*** DEMO PREP FAILED at step $failed — the demo is NOT fully prepared. Read the step's output above." >&2
    echo "*** The gateway starts anyway, so the UI and this log stay reachable. The prep cannot be finished in place:" >&2
    echo "*** prepare from scratch with docker compose down -v, then up." >&2
    # stopped before its seed: seed as an ordinary demo boot does, so the demo licence and the personas exist
    if [ "$seeded" = "0" ]; then node apps/gateway/dist/seed.js --seed-demo; fi
  else
    echo ""
    echo "demo prep: complete in $(( $(date +%s) - started ))s"
  fi
else
  if [ "${SEED_DEMO:-}" = "1" ] || [ "$demo" = "1" ]; then node apps/gateway/dist/seed.js --seed-demo; fi
  if [ "$prepared" = "4" ]; then
    echo "*** DEMO PREP SKIPPED: this database was started but never fully prepared, and the prep needs an empty one —" >&2
    echo "*** prepare from scratch with docker compose down -v, then up." >&2
  elif [ -n "$prepared" ] && [ "$prepared" != "0" ]; then
    echo "*** DEMO PREP SKIPPED: could not tell whether this database is prepared (exit $prepared) — see the error above" >&2
  fi
fi

exec node apps/gateway/dist/main.js
