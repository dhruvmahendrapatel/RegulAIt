#!/bin/bash
# demo-host-anchor-creds.sh: short-lived credentials for the gateway's audit-chain
# anchor writer on the AWS demo host (ADR-0228 addendum 2).
#
# The gateway container must not reach the instance role (IMDS hop limit 1 keeps
# it out), so this host-side job assumes the dedicated anchor role, which can only
# write and read its own anchors, and writes the 1-hour credentials into tmpfs.
# The gateway's AWS SDK reads them through `credential_process` and re-reads them
# before they expire. No long-lived access key exists anywhere.
#
#   sudo bash infra/scripts/demo-host-anchor-creds.sh install   # systemd service + 15-minute timer, then one refresh
#   sudo bash infra/scripts/demo-host-anchor-creds.sh refresh   # what the timer runs
#   sudo bash infra/scripts/demo-host-anchor-creds.sh check     # expiry and caller only; never prints a key
#
# Files (tmpfs, owned by the gateway image's `node` user, uid 1000, read-only):
#   /run/regulait/anchor/creds.json   credential_process output (Version 1)
#   /run/regulait/anchor/config       [default] credential_process = cat /aws-anchor/creds.json
# demo-host-env.sh mounts /run/regulait/anchor at /aws-anchor in the gateway.
set -euo pipefail
set +x

PREFIX="${REGULAIT_SSM_PREFIX:-/regulait/demo-host}"
DIR=/run/regulait/anchor
GATEWAY_UID="${GATEWAY_UID:-1000}"

fail() { echo "demo-host-anchor-creds: REFUSED: $*" >&2; exit 1; }
[ "$(id -u)" = 0 ] || fail "run as root (sudo)"

region() {
  local t
  t=$(curl -fsS -X PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 60')
  curl -fsS -H "X-aws-ec2-metadata-token: $t" http://169.254.169.254/latest/meta-data/placement/region
}

refresh() {
  local r arn out
  r=$(region)
  arn=$(aws ssm get-parameter --region "$r" --name "$PREFIX/anchor-role-arn" --query Parameter.Value --output text) \
    || fail "cannot read $PREFIX/anchor-role-arn"
  [ "$(stat -f -c %T /run)" = tmpfs ] || fail "/run is not tmpfs"
  mkdir -p "$DIR"
  chmod 0750 "$DIR"
  chown "root:$GATEWAY_UID" "$DIR"
  umask 077
  out=$(aws sts assume-role --region "$r" --role-arn "$arn" --role-session-name regulait-anchor \
    --duration-seconds 3600 --output json \
    --query '{Version:`1`,AccessKeyId:Credentials.AccessKeyId,SecretAccessKey:Credentials.SecretAccessKey,SessionToken:Credentials.SessionToken,Expiration:Credentials.Expiration}') \
    || fail "assume-role failed"
  printf '%s\n' "$out" > "$DIR/creds.json.new"
  unset out
  printf '[default]\ncredential_process = cat /aws-anchor/creds.json\nregion = %s\n' "$r" > "$DIR/config.new"
  chown "$GATEWAY_UID:$GATEWAY_UID" "$DIR/creds.json.new" "$DIR/config.new"
  chmod 0400 "$DIR/creds.json.new" "$DIR/config.new"
  mv -f "$DIR/creds.json.new" "$DIR/creds.json"
  mv -f "$DIR/config.new" "$DIR/config"
  echo "demo-host-anchor-creds: refreshed (expires $(jq -r .Expiration "$DIR/creds.json"))"
}

case "${1:-}" in
  refresh) refresh ;;
  check)
    [ -f "$DIR/creds.json" ] || fail "no credentials yet: run install"
    echo "expires: $(jq -r .Expiration "$DIR/creds.json")"
    stat -c '%U %a %n' "$DIR/creds.json" "$DIR/config"
    systemctl is-active regulait-anchor-creds.timer
    ;;
  install)
    install -m 0700 "$0" /usr/local/sbin/regulait-demo-host-anchor-creds
    cat > /etc/systemd/system/regulait-anchor-creds.service <<'UNIT'
[Unit]
Description=RegulAIt demo host: refresh the audit-anchor role's short-lived credentials (ADR-0228)
Wants=network-online.target
After=network-online.target
Before=docker.service

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/regulait-demo-host-anchor-creds refresh
Restart=on-failure
RestartSec=30

[Install]
WantedBy=multi-user.target
UNIT
    cat > /etc/systemd/system/regulait-anchor-creds.timer <<'UNIT'
[Unit]
Description=Refresh the audit-anchor credentials every 15 minutes (1-hour sessions)

[Timer]
OnBootSec=1min
OnUnitActiveSec=15min
AccuracySec=30s

[Install]
WantedBy=timers.target
UNIT
    systemctl daemon-reload
    systemctl enable regulait-anchor-creds.service regulait-anchor-creds.timer
    systemctl start regulait-anchor-creds.service regulait-anchor-creds.timer
    echo "demo-host-anchor-creds: installed; next: $(systemctl list-timers regulait-anchor-creds.timer --no-pager --no-legend | awk '{print $1, $2, $3}')"
    ;;
  *) echo "usage: $0 install|refresh|check" >&2; exit 2 ;;
esac
