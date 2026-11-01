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
#   sudo bash infra/scripts/demo-host-env.sh install-boot [--sso] [--no-harden]  # rebuild .env in tmpfs at every boot, with the SAME flags
#
# Secrets live only in tmpfs: `write` puts the env file at /run/regulait/env
# (tmpfs, cleared at power-off) and makes $APP_DIR/.env a symlink to it, so no
# secret is written to an EBS volume by this script. `install-boot` adds a
# systemd unit that rebuilds it from SSM before Docker starts on every boot.
# (Docker itself keeps each container's environment in its config on the
# encrypted data volume; DEMO_HOST_SECURITY_BRIEF.md lists that residual.)
#
# `write --no-harden` leaves out the container-hardening block of the override
# (fallback if an image refuses to start with it; see DEMO_RUNBOOK.md §8.6).
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
usage() { echo "usage: $0 check|write|tunnel-check [--sso] [--no-harden]  |  $0 compose <docker compose args...>  |  $0 install-boot [--sso] [--no-harden]" >&2; exit 2; }
MODE="${1:-}"; [ -n "$MODE" ] || usage; shift
SSO=false
HARDEN=true
case "$MODE" in
  check|write|tunnel-check|install-boot)
    for a in "$@"; do case "$a" in --sso) SSO=true ;; --no-harden) HARDEN=false ;; *) usage ;; esac; done ;;
  compose) [ $# -gt 0 ] || usage ;;
  *) usage ;;
esac

if [ "$MODE" = install-boot ]; then
  [ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }
  install -m 0700 "$0" /usr/local/sbin/regulait-demo-host-env
  # The boot unit replays the SAME flags as the last manual `write`, so a reboot
  # (patching, power schedule) cannot silently bring back hardening that was
  # turned off with --no-harden, or drop --sso. Re-run install-boot whenever the
  # write flags change.
  BOOT_FLAGS=""
  [ "$SSO" = true ] && BOOT_FLAGS="$BOOT_FLAGS --sso"
  [ "$HARDEN" = false ] && BOOT_FLAGS="$BOOT_FLAGS --no-harden"
  cat > /etc/systemd/system/regulait-env.service <<UNIT
[Unit]
Description=RegulAIt demo host: rebuild the env file in tmpfs from SSM (ADR-0228)
Wants=network-online.target
After=network-online.target
Before=docker.service

[Service]
Type=oneshot
WorkingDirectory=/opt/app
Environment=APP_DIR=/opt/app
ExecStart=/usr/local/sbin/regulait-demo-host-env write${BOOT_FLAGS}
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
UNIT
  systemctl daemon-reload
  systemctl enable regulait-env.service
  echo "demo-host-env: regulait-env.service enabled (runs before docker at every boot; write flags:${BOOT_FLAGS:- none})"
  exit 0
fi

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
# Non-secret anchor wiring that Terraform writes (anchor.tf); optional.
ANCHOR_BUCKET=$(get anchor-bucket)
ANCHOR_DAYS=$(get anchor-retention-days)
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
ENV_DIR=/run/regulait
mkdir -p "$ENV_DIR"; chmod 700 "$ENV_DIR"
[ "$(stat -f -c %T /run)" = tmpfs ] || fail "/run is not tmpfs; refusing to write secrets to disk"
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
} > "$ENV_DIR/env.new"
mv -f "$ENV_DIR/env.new" "$ENV_DIR/env"
chmod 600 "$ENV_DIR/env"
ln -sfn "$ENV_DIR/env" "$APP_DIR/.env"

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
if [ -n "$ANCHOR_BUCKET" ]; then
  [[ "$ANCHOR_BUCKET" =~ ^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$ ]] || fail "anchor-bucket is not a bucket name"
  [[ "$ANCHOR_DAYS" =~ ^[0-9]{1,3}$ ]] || fail "anchor-retention-days is not a number"
  # ADR-0228 addendum 2: anchor the audit chain to the COMPLIANCE-mode bucket,
  # using the existing ADR-0060 variables (apps/gateway/src/audit-chain.ts,
  # resolveS3AnchorConfig). Empty endpoint = real AWS S3; empty keys = the SDK
  # provider chain, here the anchor role's short-lived credentials from
  # demo-host-anchor-creds.sh through credential_process.
  cat >> "$APP_DIR/docker-compose.override.yml" <<YAML
      REGULAIT_AUDIT_ANCHOR_S3_ENDPOINT: ""
      REGULAIT_AUDIT_ANCHOR_S3_BUCKET: "$ANCHOR_BUCKET"
      REGULAIT_AUDIT_ANCHOR_S3_REGION: "$REGION"
      REGULAIT_AUDIT_ANCHOR_S3_PREFIX: "audit-anchors"
      REGULAIT_AUDIT_ANCHOR_S3_RETENTION_DAYS: "$ANCHOR_DAYS"
      REGULAIT_AUDIT_ANCHOR_S3_FORCE_PATH_STYLE: "false"
      REGULAIT_AUDIT_ANCHOR_S3_ACCESS_KEY_ID: ""
      REGULAIT_AUDIT_ANCHOR_S3_SECRET_ACCESS_KEY: ""
      AWS_CONFIG_FILE: /aws-anchor/config
      AWS_SHARED_CREDENTIALS_FILE: /dev/null
    volumes:
      - /run/regulait/anchor:/aws-anchor:ro
YAML
fi
if [ "$HARDEN" = true ]; then
  # Host-only container hardening (ADR-0228) for the services docker-compose.yml
  # does not already harden. The gateway image runs as the non-root `node` user;
  # postgres keeps only the capabilities its entrypoint needs to drop to its own
  # user. Merged by compose into the base file; the laptop stack is unchanged.
  cat >> "$APP_DIR/docker-compose.override.yml" <<'YAML'
    security_opt: ["no-new-privileges:true"]
    cap_drop: [ALL]
  db:
    security_opt: ["no-new-privileges:true"]
    cap_drop: [ALL]
    cap_add: [CHOWN, DAC_OVERRIDE, FOWNER, SETGID, SETUID]
  objectstore:
    security_opt: ["no-new-privileges:true"]
  objectstore-init:
    security_opt: ["no-new-privileges:true"]
YAML
fi
chmod 600 "$APP_DIR/docker-compose.override.yml"
unset HOST TUN DK BT DBP

echo "demo-host-env: wrote $ENV_DIR/env (tmpfs, 0600; $APP_DIR/.env links to it) and docker-compose.override.yml (hardening: $HARDEN; S3 anchor: $([ -n "$ANCHOR_BUCKET" ] && echo on || echo off)); values not shown"
