#!/bin/sh
# RegulAIt endpoint agent install step (R15 §3.2), run once as root by the package manager under MDM.
# It must never fail an install or an upgrade: every step tolerates failure and the script exits 0. The outcome
# of the ticket redemption is in /var/lib/regulait-agent/redeem-status.json.
set -u
GROUP=regulait-agent
if ! getent group "$GROUP" >/dev/null 2>&1; then
  groupadd --system "$GROUP" 2>/dev/null || addgroup --system "$GROUP" 2>/dev/null || true
fi
# the console users present now join the group that may read the device ticket
if command -v loginctl >/dev/null 2>&1; then
  for u in $(loginctl list-sessions --no-legend 2>/dev/null | awk '$4 ~ /^seat/ {print $3}' | sort -u); do
    case "$u" in *[!A-Za-z0-9._-]*|'') continue ;; esac
    usermod -a -G "$GROUP" "$u" 2>/dev/null || true
  done
fi
GID="$(getent group "$GROUP" 2>/dev/null | cut -d: -f3)"
case "$GID" in ''|*[!0-9]*) GID=-1 ;; esac
/usr/bin/regulait-agent redeem-ticket -ticket-gid "$GID" || true
# ADR-0360 §4: the self-update spool. The per-user agents (group regulait-agent) write into it; the sticky bit keeps one
# user from replacing another's files; the root updater verifies everything it reads there and trusts none of it.
if [ "$GID" != "-1" ]; then
  install -d -m 1770 -o root -g "$GID" /var/lib/regulait-agent/update 2>/dev/null || true
fi
if command -v systemctl >/dev/null 2>&1; then
  systemctl --global enable regulait-agent.service >/dev/null 2>&1 || true
  # the timer runs `regulait-agent update` as root; it installs nothing unless the gateway signs a directive (ADR-0360)
  systemctl daemon-reload >/dev/null 2>&1 || true
  systemctl enable --now regulait-agent-update.timer >/dev/null 2>&1 || true
fi
exit 0
