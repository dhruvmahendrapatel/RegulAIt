#!/bin/sh
# Stop starting the agent for new sessions. The ticket, status file and group are left for the admin (MDM) to
# remove, so a reinstall does not redeem another device slot.
set -u
if command -v systemctl >/dev/null 2>&1; then
  systemctl --global disable regulait-agent.service >/dev/null 2>&1 || true
fi
exit 0
