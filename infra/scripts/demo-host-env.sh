#!/bin/bash
# demo-host-env.sh — build /opt/app/.env and docker-compose.override.yml on the
# AWS demo host from SSM Parameter Store (ADR-0228, DEMO_RUNBOOK.md §8).
#
# Run as root on the host, inside an SSM session, from the extracted checkout:
#
#   sudo bash infra/scripts/demo-host-env.sh check [--sso]        # validate, write nothing
#   sudo bash infra/scripts/demo-host-env.sh write [--sso]        # write .env + override
#   sudo bash infra/scripts/demo-host-env.sh tunnel-check [--sso] # hosted-config.sh tunnel-check
#   sudo bash infra/scripts/demo-host-env.sh compose <args...>    # docker compose <args...>
#
# Reads every parameter under PREFIX (default /regulait/demo-host) with
# decryption, through the instance role. It never prints a value: tracing is
# off, and the files are created 0600 under umask 077. Fails closed when a name
# is missing or malformed.
#
# The tunnel token is NEVER written to a file (docs/deployment/TUNNEL.md): the
# `tunnel-check` and `compose` forms read it from SSM and hand it to that one
# child process's environment only, the way the laptop keeps it in one shell.
#
# Parameters (the owner creates them by hand, DEMO_RUNBOOK.md §8.5):
#   public-host       String        regulait.<domain> (no scheme)
#   cf-tunnel-token   SecureString  the Cloudflare Tunnel token (the same tunnel as the laptop)
#   data-key          SecureString  64 hex characters (REGULAIT_DATA_KEY)
#   bootstrap-token   SecureString  48 hex characters (REGULAIT_BOOTSTRAP_TOKEN)
#   db-password       SecureString  48 hex characters (REGULAIT_DB_PASSWORD; first initdb only)
set -euo pipefail
set +x

PREFIX="${REGULAIT_SSM_PREFIX:-/regulait/demo-host}"
APP_DIR="${APP_DIR:-$(pwd)}"
usage() { echo "usage: $0 check|write|tunnel-check [--sso]  |  $0 compose <docker compose args...>" >&2; exit 2; }
MODE="${1:-}"; [ -n "$MODE" ] || usage; shift
SSO=false
case "$MODE" in
  check|write|tunnel-check)
    for a in "$@"; do case "$a" in --sso) SSO=true ;; *) usage ;; esac; done ;;
  compose) [ $# -gt 0 ] || usage ;;
  *) usage ;;
esac

fail() { echo "demo-host-env: REFUSED: $*" >&2; exit 1; }
[ "$(id -u)" = 0 ] || fail "run as root (sudo)"
[ -f "$APP_DIR/docker-compose.yml" ] || fail "run from the extracted checkout: $APP_DIR/docker-compose.yml not found"

TOKEN=$(curl -fsS -X PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 60')
REGION=$(curl -fsS -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/placement/region)
unset TOKEN

# One call, JSON kept in a variable only (never on disk, never echoed).
JSON=$(aws ssm get-parameters-by-path --region "$REGION" --path "$PREFIX" --with-decryption \
  --query 'Parameters[].{n:Name,v:Value}' --output json) || fail "cannot read $PREFIX (role, KMS key or names)"

get() { jq -r --arg n "$PREFIX/$1" '.[] | select(.n == $n) | .v' <<<"$JSON"; }

HOST=$(get public-host)
TUN=$(get cf-tunnel-token)
DK=$(get data-key)
BT=$(get bootstrap-token)
DBP=$(get db-password)
unset JSON

missing=()
[ -n "$HOST" ] || missing+=(public-host)
[ -n "$TUN" ]  || missing+=(cf-tunnel-token)
[ -n "$DK" ]   || missing+=(data-key)
[ -n "$BT" ]   || missing+=(bootstrap-token)
[ -n "$DBP" ]  || missing+=(db-password)
[ ${#missing[@]} -eq 0 ] || fail "missing under $PREFIX: ${missing[*]}"

[[ "$HOST" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$ ]] \
  || fail "public-host is not a lowercase DNS name (no scheme, port or path)"
[[ "$DK" =~ ^[0-9a-f]{64}$ ]] || fail "data-key must be 64 lowercase hex characters"
[[ "$BT" =~ ^[0-9a-f]{48,}$ ]] || fail "bootstrap-token must be at least 48 lowercase hex characters"
[[ "$DBP" =~ ^[0-9a-f]{32,}$ ]] || fail "db-password must be at least 32 lowercase hex characters (it goes into a URL)"
[ ${#TUN} -ge 100 ] || fail "cf-tunnel-token looks too short to be a tunnel token"

case "$MODE" in
  check)
    echo "demo-host-env: all five parameters present and well-formed under $PREFIX (region $REGION); public host: $HOST"
    exit 0 ;;
  tunnel-check)
    cd "$APP_DIR"
    args=(tunnel-check .env); [ "$SSO" = true ] && args+=(--sso)
    REGULAIT_CF_TUNNEL_TOKEN="$TUN" exec bash infra/scripts/hosted-config.sh "${args[@]}" ;;
  compose)
    [ -f "$APP_DIR/.env" ] || fail "no .env yet: run '$0 write' first"
    cd "$APP_DIR"
    REGULAIT_CF_TUNNEL_TOKEN="$TUN" exec docker compose "$@" ;;
esac

umask 077
{
  echo "# Written by infra/scripts/demo-host-env.sh from SSM $PREFIX. Never print, copy or commit this file."
  # Fixed, so every release folder drives the SAME containers and volumes:
  # compose otherwise names the project after the folder, and a new folder
  # would start an empty database.
  echo "COMPOSE_PROJECT_NAME=regulait"
  echo "REGULAIT_PUBLIC_HOST=$HOST"
  echo "REGULAIT_PUBLIC_URL=https://$HOST"
  echo "REGULAIT_HSTS=max-age=86400"
  if [ "$SSO" = true ]; then
    echo "REGULAIT_KC_HOSTNAME=https://$HOST/idp"
    echo "REGULAIT_KC_RELATIVE_PATH=/idp"
  fi
  echo "REGULAIT_DATA_KEY=$DK"
  echo "REGULAIT_BOOTSTRAP_TOKEN=$BT"
  echo "REGULAIT_DB_PASSWORD=$DBP"
  echo "REGULAIT_DATABASE_URL=postgres://regulait:$DBP@db:5432/regulait"
} > "$APP_DIR/.env.new"
mv -f "$APP_DIR/.env.new" "$APP_DIR/.env"
chmod 600 "$APP_DIR/.env"

# The export-signing and keyring lines of DEMO_RUNBOOK.md §7.6 step 2; the data
# key and bootstrap token come from .env above, not from this file.
cat > "$APP_DIR/docker-compose.override.yml" <<'YAML'
services:
  gateway:
    environment:
      REGULAIT_EXPORT_SIGNING_KEY: /app/demo-license-keys/export-signing/regulait-demo-export.key
      REGULAIT_EXPORT_SIGNING_KEY_ID: regulait-demo-export
      REGULAIT_LICENSE_KEYRING: /app/demo-license-keys
YAML
chmod 600 "$APP_DIR/docker-compose.override.yml"
unset HOST TUN DK BT DBP

echo "demo-host-env: wrote $APP_DIR/.env and docker-compose.override.yml (0600); values not shown"
