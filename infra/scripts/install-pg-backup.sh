#!/bin/bash
# Install (or re-install, or reconfigure) the on-box Postgres backup timer.
#
# Run this from the REPO ROOT on an operator machine with the SSO profile
# active. It is idempotent: running it again is how a schedule or retention
# change is applied, and it is the correct response to "is the timer still
# installed?" — just run it.
#
# What it does, in order:
#   1. reads the bucket/prefix/schedule out of terraform outputs (terraform is
#      the source of truth for all of them — nothing is retyped here),
#   2. uploads pg-backup.sh to the stack's existing source bucket, because SSM
#      SendCommand has a hard limit on parameter size and a shell script pasted
#      into JSON is a quoting minefield,
#   3. sends one SSM command that pulls the script down, writes
#      /etc/regulait-pg-backup.env, and runs `pg-backup.sh --install`.
#
# It deliberately does NOT take a backup. Run `--run` afterwards (the last line
# prints the command) once you want to prove the whole path end to end.
#
# See docs/ops/DB_BACKUP.md.

set -euo pipefail

ENV_DIR="${ENV_DIR:-infra/environments/regulait-dev-app}"
SCRIPT="${SCRIPT:-infra/scripts/pg-backup.sh}"

[ -f "$SCRIPT" ] || { echo "run me from the repo root: $SCRIPT not found" >&2; exit 1; }

tf() { terraform -chdir="$ENV_DIR" output -raw "$1"; }

REGION="${AWS_REGION:-us-east-1}"
PROFILE="${AWS_PROFILE:-regulait-admin}"
INSTANCE="$(tf instance_id)"
SRC_BUCKET="$(tf source_bucket)"
ENV_BODY="$(tf backup_env_file)"

echo "instance : $INSTANCE"
echo "region   : $REGION"
echo "dest     : $(tf backup_destination)"
echo

echo "==> uploading $SCRIPT to s3://$SRC_BUCKET/pg-backup.sh"
aws s3 cp "$SCRIPT" "s3://$SRC_BUCKET/pg-backup.sh" \
  --region "$REGION" --profile "$PROFILE" --only-show-errors

# The env file goes over as base64 so that no quoting, newline or shell
# metacharacter in it has to survive JSON + SSM + bash.
ENV_B64="$(printf '%s\n' "$ENV_BODY" | base64 -w0)"

echo "==> sending SSM install command"
CMD_ID="$(aws ssm send-command \
  --region "$REGION" --profile "$PROFILE" \
  --instance-ids "$INSTANCE" \
  --document-name AWS-RunShellScript \
  --comment "install regulait pg-backup timer (ADR-0035)" \
  --parameters "commands=[\
\"set -e\",\
\"aws s3 cp s3://$SRC_BUCKET/pg-backup.sh /tmp/pg-backup.sh\",\
\"echo $ENV_B64 | base64 -d > /etc/regulait-pg-backup.env\",\
\"chmod 0600 /etc/regulait-pg-backup.env\",\
\"bash /tmp/pg-backup.sh --install\",\
\"systemctl list-timers regulait-pg-backup.timer --all --no-pager\"\
]" \
  --query 'Command.CommandId' --output text)"

echo "command id: $CMD_ID"
echo "==> waiting"
aws ssm wait command-executed \
  --region "$REGION" --profile "$PROFILE" \
  --command-id "$CMD_ID" --instance-id "$INSTANCE" 2>/dev/null || true

aws ssm get-command-invocation \
  --region "$REGION" --profile "$PROFILE" \
  --command-id "$CMD_ID" --instance-id "$INSTANCE" \
  --query '{status:Status,out:StandardOutputContent,err:StandardErrorContent}' \
  --output text

cat <<NEXT

Installed. The timer will fire on its own schedule. To prove the whole path now:

  aws ssm send-command --region $REGION --profile $PROFILE \\
    --instance-ids $INSTANCE --document-name AWS-RunShellScript \\
    --parameters 'commands=["/usr/local/sbin/regulait-pg-backup.sh --run","/usr/local/sbin/regulait-pg-backup.sh --check"]'

NEXT
