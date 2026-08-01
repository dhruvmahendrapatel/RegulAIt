#!/bin/bash
# regulait boot-resync — make the dev box survive a stop/start with no human step.
#
# WHY THIS FILE EXISTS
# The instance's user-data (infra/modules/app-instance/user-data.sh.tftpl) runs
# ONCE, on first boot, and never again — cloud-init's `scripts-user` module is
# per-instance, not per-boot. Two things it set up therefore do NOT survive a
# power cycle:
#
#   1. Swap. user-data does `fallocate` + `swapon` but writes no /etc/fstab
#      entry, so a 2 GB t3.small comes back with zero swap.
#   2. The TLS hostname. Caddy's REGULAIT_TLS_HOST is baked into the generated
#      docker-compose.override.yml from the public IP that existed at first
#      boot. If the address ever changes, Caddy comes back serving a name that
#      no longer resolves to this box: the site is unreachable AND ACME renewal
#      fails.
#
# With an Elastic IP attached (ADR-0032) case 2 should never trigger again — but
# "should never" is not a mechanism, and this box already lost its address once.
# This script is the mechanism: it is idempotent, it is a no-op when everything
# already matches, and it runs on every boot via the systemd unit it installs.
#
# USAGE (all forms are safe to re-run):
#   sudo bash boot-resync.sh              # install the boot unit, then resync now
#   sudo bash boot-resync.sh --no-install # resync only
#   sudo systemctl start regulait-boot-resync   # after installation
#
# Log: /var/log/regulait-boot-resync.log

set -uo pipefail

APP_DIR="${APP_DIR:-/opt/app}"
OVERRIDE="${APP_DIR}/docker-compose.override.yml"
SELF_PATH="/usr/local/sbin/regulait-boot-resync.sh"
UNIT_PATH="/etc/systemd/system/regulait-boot-resync.service"
LOG="/var/log/regulait-boot-resync.log"

exec > >(tee -a "$LOG") 2>&1
echo "=== $(date -u +%FT%TZ) boot-resync starting ==="

# --- 1. install self + systemd unit ------------------------------------------

install_unit() {
  # Copy self to a stable path so the unit does not depend on where it was run
  # from (an SSM working directory is deleted after the command finishes).
  if [ "$(readlink -f "${BASH_SOURCE[0]}")" != "$SELF_PATH" ]; then
    install -m 0755 "${BASH_SOURCE[0]}" "$SELF_PATH"
    echo "install: copied to $SELF_PATH"
  fi

  cat > "$UNIT_PATH" <<UNIT
[Unit]
Description=RegulAIt boot resync (swap + TLS hostname) — see infra/scripts/boot-resync.sh
After=docker.service network-online.target
Wants=network-online.target
Requires=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=$SELF_PATH --no-install

[Install]
WantedBy=multi-user.target
UNIT

  systemctl daemon-reload
  systemctl enable regulait-boot-resync.service
  echo "install: regulait-boot-resync.service enabled"
}

if [ "${1:-}" != "--no-install" ]; then
  install_unit
fi

# --- 2. swap ------------------------------------------------------------------

if [ -f /swapfile ]; then
  if ! swapon --show=NAME --noheadings 2>/dev/null | grep -qx /swapfile; then
    swapon /swapfile && echo "swap: re-enabled /swapfile"
  else
    echo "swap: /swapfile already active"
  fi
  # Persist it so the next boot does not need this script for the swap half.
  if ! grep -qs '^/swapfile ' /etc/fstab; then
    echo '/swapfile none swap sw 0 0' >> /etc/fstab
    echo "swap: added /etc/fstab entry"
  fi
else
  echo "swap: no /swapfile on this box, nothing to do"
fi

# --- 3. TLS hostname ----------------------------------------------------------

if [ ! -f "$OVERRIDE" ]; then
  echo "tls: $OVERRIDE not found — box not provisioned by user-data? skipping"
  echo "=== done ==="
  exit 0
fi

IMDS_TOKEN=$(curl -sS -m 5 -X PUT "http://169.254.169.254/latest/api/token" \
  -H "X-aws-ec2-metadata-token-ttl-seconds: 300" 2>/dev/null)
PUBLIC_IP=$(curl -sS -m 5 -H "X-aws-ec2-metadata-token: ${IMDS_TOKEN}" \
  "http://169.254.169.254/latest/meta-data/public-ipv4" 2>/dev/null)

if [ -z "${PUBLIC_IP}" ]; then
  # Do NOT tear anything down: a transient IMDS blip must not take the site off
  # the air. Leave the stack exactly as it is and complain in the log.
  echo "tls: WARNING no public IPv4 from IMDS; leaving the stack untouched"
  echo "=== done ==="
  exit 0
fi

WANT_HOST="$(echo "${PUBLIC_IP}" | tr '.' '-').sslip.io"
HAVE_HOST=$(sed -n 's/^[[:space:]]*REGULAIT_TLS_HOST:[[:space:]]*//p' "$OVERRIDE" | tail -1)

if [ "${WANT_HOST}" = "${HAVE_HOST}" ]; then
  echo "tls: already pointed at ${WANT_HOST}, no change"
  echo "=== done ==="
  exit 0
fi

echo "tls: public IP is ${PUBLIC_IP}; hostname ${HAVE_HOST:-<unset>} -> ${WANT_HOST}"
cp -a "$OVERRIDE" "${OVERRIDE}.bak.$(date -u +%Y%m%dT%H%M%SZ)"

if grep -q '^[[:space:]]*caddy:' "$OVERRIDE"; then
  sed -i "s|^\([[:space:]]*\)REGULAIT_TLS_HOST:.*|\1REGULAIT_TLS_HOST: ${WANT_HOST}|" "$OVERRIDE"
else
  cat >> "$OVERRIDE" <<EOF
  caddy:
    environment:
      REGULAIT_TLS_HOST: ${WANT_HOST}
EOF
fi

cd "$APP_DIR" || exit 1
# No --build: the image is already on this disk. `up -d` recreates only the
# containers whose effective config changed, i.e. caddy.
docker compose --profile tls up -d
echo "tls: compose up returned $? — now serving https://${WANT_HOST}"

echo "=== done ==="
