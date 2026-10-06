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
#   - the export-signing key for the signed export (beat 3E), made once in the
#     demo volume (/app/demo-license-keys/export-signing) and reused; only its
#     path and fingerprint are logged, never the key;
#   - the demo MCP server (demo-mcp-server.js, 127.0.0.1/127.0.0.2:8931) in the
#     background for the life of the container — the demo's tool calls hit it;
#   - after the seed: demo:setup → demo:intake → demo:traffic → demo:check,
#     ONCE per database. demo-docker-prepared.js reads a marker row that lives
#     with the data, so a restart or `down` / `up` skips the steps and
#     `down -v` prepares again.
# A failed step is logged loudly with its name and the gateway STILL starts,
# so the UI and this log stay reachable rather than the container restart-looping.
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
  # stdout is exactly two `export REGULAIT_EXPORT_SIGNING_KEY…` lines (a path and a key id); the fingerprint is on stderr
  if key_env="$(node apps/gateway/dist/demo-export-key.js --env)" && [ -n "$key_env" ]; then
    eval "$key_env"
  else
    echo "*** DEMO PREP FAILED at step demo:export-key: no export-signing key, so the signed export (beat 3E) answers 409" >&2
  fi
  node apps/gateway/dist/demo-mcp-server.js &
  echo "demo: MCP server started in the background (pid $!) on 127.0.0.1 and 127.0.0.2, port ${REGULAIT_DEMO_MCP_PORT:-8931}"
fi

# ADR-0181 FX3: the demo seed runs only on an explicit demo signal (SEED_DEMO=1, or the
# switch above) and is told so with --seed-demo. It still refuses a database that has
# an admin of its own (a real install), and writes nothing then; the gateway starts anyway.
if [ "${SEED_DEMO:-}" = "1" ] || [ "$demo" = "1" ]; then node apps/gateway/dist/seed.js --seed-demo; fi

if [ "$demo" = "1" ]; then
  node apps/gateway/dist/demo-docker-prepared.js
  prepared=$?
  if [ "$prepared" = "3" ]; then
    started="$(date +%s)"
    failed=""
    for step in demo:setup=demo-setup demo:intake=demo-intake-seed demo:traffic=demo-traffic demo:check=demo-check; do
      echo ""
      echo "=== demo prep: ${step%%=*} ==="
      node "apps/gateway/dist/${step#*=}.js"
      rc=$?
      if [ "$rc" != "0" ]; then failed="${step%%=*} (exit $rc)"; break; fi
    done
    if [ -n "$failed" ]; then
      echo "" >&2
      echo "*** DEMO PREP FAILED at step $failed — the demo is NOT fully prepared. Read the step's output above." >&2
      echo "*** The gateway starts anyway, so the UI and this log stay reachable. A failure before demo:traffic is retried on the" >&2
      echo "*** next start (docker compose restart gateway); from demo:traffic on, prepare from scratch: docker compose down -v, then up." >&2
    else
      echo ""
      echo "demo prep: complete in $(( $(date +%s) - started ))s"
    fi
  elif [ "$prepared" != "0" ]; then
    echo "*** DEMO PREP SKIPPED: could not tell whether this database is prepared (exit $prepared) — see the error above" >&2
  fi
fi

exec node apps/gateway/dist/main.js
