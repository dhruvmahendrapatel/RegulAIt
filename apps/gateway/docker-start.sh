#!/bin/sh
# The gateway image's start command (Dockerfile CMD). Migrations run on boot
# (idempotent). SEED_DEMO=1 loads the demo dataset first — also idempotent;
# one-time passwords and API keys are printed to the container log ONCE.
#
# ADR-0174 amendment (Docker demo licence): REGULAIT_DEMO_LICENSE=1 — the ONE
# opt-in switch, normally a line in the .env next to docker-compose.yml — lets
# the demo seed mint its EPHEMERAL demo licence (the one `demo:set-passwords`
# requires) into /app/demo-license-keys, a named volume, and points the
# gateway at that same keyring so the licence still verifies after a restart.
#
# Anything other than exactly "1" changes NOTHING: neither variable below is
# set, so the gateway reads its default keyring and no licence is minted —
# exactly the behaviour before this switch existed. It is honoured only
# together with SEED_DEMO=1 (the seed is what mints) and never on an installed
# byoc / air_gapped deployment (scripts/install.sh also pins it off).
# A .env written on Windows (PowerShell Add-Content, Notepad) ends its lines with CRLF; strip ONE trailing
# carriage return so "1\r" counts as "1". Nothing else is normalised: " 1", "1 ", "true" still change nothing.
demo_license="${REGULAIT_DEMO_LICENSE:-}"
cr="$(printf '\r')"
case "$demo_license" in *"$cr") demo_license="${demo_license%?}" ;; esac
if [ "$demo_license" = "1" ]; then
  if [ "${SEED_DEMO:-}" != "1" ]; then
    echo "REGULAIT_DEMO_LICENSE=1 ignored: the demo licence is minted by the demo seed, and SEED_DEMO is not 1" >&2
  elif [ -n "${REGULAIT_DEPLOY_MODE:-}" ] && [ "${REGULAIT_DEPLOY_MODE}" != "hosted" ]; then
    echo "REGULAIT_DEMO_LICENSE=1 ignored: REGULAIT_DEPLOY_MODE=${REGULAIT_DEPLOY_MODE} is an installed deployment, and the demo licence is never minted on one" >&2
  else
    export REGULAIT_EPHEMERAL_LICENSE=1
    export REGULAIT_LICENSE_KEYRING=/app/demo-license-keys
    echo "REGULAIT_DEMO_LICENSE=1: demo seed mints (or keeps) an ephemeral demo licence — NOT A PRODUCTION DEPLOYMENT; keyring ${REGULAIT_LICENSE_KEYRING}"
  fi
fi

if [ "${SEED_DEMO:-}" = "1" ]; then node apps/gateway/dist/seed.js; fi
exec node apps/gateway/dist/main.js
