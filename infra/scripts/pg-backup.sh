#!/bin/bash
# regulait pg-backup — take a verified pg_dump of the compose stack's Postgres
# and push it to S3, on a systemd timer that survives a power cycle.
#
# WHY THIS FILE EXISTS
# The dev stack's entire database is a Docker named volume (`pgdata`) on the
# root EBS volume of ONE EC2 instance. No RDS, no replica, no snapshot. Every
# user, credential ciphertext, audit row, project, workflow instance and spend
# record lives there and nowhere else. An audit log with no backup is not an
# audit log.
#
# DESIGN NOTES THAT ARE NOT OBVIOUS
#
#   1. INSTALLATION IS PER-BOOT-SAFE, NOT PER-INSTANCE. `user_data` runs ONCE
#      per instance and never again — that is the trap that froze
#      REGULAIT_TLS_HOST and lost swap across a stop/start (ADR-0032). So this
#      script installs itself the same way boot-resync.sh does: copy to a stable
#      path, write a systemd unit + timer, `systemctl enable`. Those enable
#      symlinks live on the root EBS volume, so the timer comes back on every
#      boot with no human step and no user_data change (and therefore no
#      instance replacement, and no new public IP).
#
#   2. THE DUMP RUNS INSIDE THE db CONTAINER. `pg_dump` refuses to dump a server
#      newer than itself; the host has no PostgreSQL installed at all and would
#      pick up whatever the distro ships if it ever did. Running it inside the
#      container means the client is byte-identical to the server, forever, with
#      no version-pinning discipline required of anyone.
#
#   3. NO SECRET EVER REACHES THIS PROCESS. The password is read from the
#      container's own environment by a shell INSIDE the container
#      (`PGPASSWORD="$POSTGRES_PASSWORD" pg_dump ...` in single quotes — the
#      expansion happens in there, not out here). It never appears in this
#      script's argv, its environment, the host process table, or the log.
#      There is deliberately no DATABASE_URL anywhere in this file.
#
#   4. VERIFICATION HAPPENS BEFORE THE UPLOAD. A silently truncated dump is
#      worse than no dump, because it looks like protection. Three guards run
#      before a single byte goes to S3: a minimum size, a TOC that parses and
#      names at least one TABLE DATA member, and a FULL decompression of every
#      data member. The third is not belt-and-braces — a `--list`-only check
#      passes (exit 0) on a 90%-truncated 8.4 MB archive that restores zero of
#      200,000 rows. See the measurements inline in do_run().
#
#      Deeper still, `--verify-restore` restores a dump into a SCRATCH database
#      and diffs row counts table by table. That is the only check that proves
#      restorability rather than well-formedness, so the runbook schedules it
#      periodically rather than nightly.
#
#   5. FAILURE IS LOUD IN THREE PLACES. Non-zero exit (so `systemctl status` and
#      `systemctl list-timers` show it), a RESULT=FAIL line plus a status file
#      the runbook names, and a CloudWatch datapoint of 0 — with the alarm built
#      to fire on the ABSENCE of a 1, so a box that never runs the job at all is
#      still caught. See infra/modules/backup-target-s3/main.tf.
#
# USAGE (every form is safe to re-run):
#   sudo bash pg-backup.sh --install        # install unit + timer, take no dump
#   sudo bash pg-backup.sh --run            # take one backup now (what the timer runs)
#   sudo bash pg-backup.sh                  # --install then --run
#   sudo bash pg-backup.sh --check          # print timer state, last result, recent objects
#   sudo bash pg-backup.sh --verify-restore # restore the newest local dump into a
#                                           # SCRATCH database and diff row counts
#   sudo bash pg-backup.sh --uninstall      # stop + disable the timer (keeps the script)
#
# Config: /etc/regulait-pg-backup.env  (see CONFIG DEFAULTS below; every value
# there is also settable as an environment variable for a one-off run).
# Log:    /var/log/regulait-pg-backup.log
# Status: /var/lib/regulait/pg-backup.status

set -uo pipefail

# --- config -------------------------------------------------------------------

CONF="${REGULAIT_BACKUP_CONF:-/etc/regulait-pg-backup.env}"
# shellcheck disable=SC1090
[ -f "$CONF" ] && . "$CONF"

# CONFIG DEFAULTS. Anything the operator has not set gets a sane value, so a
# missing config file degrades to "wrong bucket", not "silent no-op".
BUCKET="${REGULAIT_BACKUP_BUCKET:-}"
PREFIX="${REGULAIT_BACKUP_PREFIX:-postgres}"
REGION="${REGULAIT_BACKUP_REGION:-us-east-1}"
ENABLED="${REGULAIT_BACKUP_ENABLED:-1}"

# Default schedule: 17:00 UTC, every day, catching up a missed run at boot.
#
# WHY 17:00 UTC AND WHY IT IS SPELT IN UTC. The box is powered off at 20:00 and
# on at 08:00 America/New_York on weekdays (ADR-0032), so a backup scheduled
# after 20:00 local would simply never run. 17:00 UTC lands at 13:00 local under
# EDT and 12:00 local under EST — mid-window in BOTH halves of the year, ~4h
# after the box comes up and ~7h before it goes down. Naming the instant in UTC
# rather than in a local timezone means the timer needs no systemd timezone
# support (`OnCalendar=... UTC` has worked for a decade; the bare-timezone
# suffix is systemd 252+) and cannot drift out of the window twice a year.
#
# WHY DAILY RATHER THAN Mon-Fri. On a weekday-only box the Saturday and Sunday
# elapses are simply missed. Persistent=true then fires ONE catch-up run
# immediately after Monday's 08:00 boot — a free extra restore point at the
# start of the week, and a weekly proof that the timer is still alive. It also
# covers the manual-start case: a box started at 21:00 on a Tuesday takes a
# catch-up backup within a minute or two of boot instead of waiting a day.
ONCALENDAR="${REGULAIT_BACKUP_ONCALENDAR:-*-*-* 17:00:00 UTC}"

APP_DIR="${APP_DIR:-/opt/app}"
DB_SERVICE="${REGULAIT_BACKUP_DB_SERVICE:-db}"

METRIC_NAMESPACE="${REGULAIT_BACKUP_METRIC_NAMESPACE:-Backup}"
METRIC_NAME="${REGULAIT_BACKUP_METRIC_NAME:-BackupSuccess}"
METRIC_TARGET="${REGULAIT_BACKUP_METRIC_TARGET:-regulait-dev-app-db}"

# A dump smaller than this cannot be a real database and is treated as a
# failure even if pg_dump exited 0.
MIN_BYTES="${REGULAIT_BACKUP_MIN_BYTES:-4096}"
# Wait this long for the db container to become usable. Generous on purpose:
# the Monday catch-up run starts seconds after boot, while docker is still
# pulling itself together.
WAIT_SECS="${REGULAIT_BACKUP_WAIT_SECS:-600}"
# Local dumps kept on the box (a fast restore path that does not need S3).
KEEP_LOCAL="${REGULAIT_BACKUP_KEEP_LOCAL:-3}"
WORK_DIR="${REGULAIT_BACKUP_WORK_DIR:-/var/backups/regulait}"

# EXEC MODE. `docker` (default) runs every psql/pg_dump/pg_restore inside the
# compose `db` container — the production path. `local` runs them against a
# PGHOST/PGPORT server with the host's own client binaries, for a BYOC or
# air-gapped install where Postgres is not containerised (and for exercising
# this script against a throwaway server). The two differ ONLY in the exec
# wrapper below; every verification, upload and restore step is shared.
EXEC_MODE="${REGULAIT_BACKUP_EXEC_MODE:-docker}"

# DRY RUN. Everything up to and including verification runs for real; the S3
# upload and the CloudWatch heartbeat are skipped. This is the mode the runbook
# uses to prove the dump/verify half works before pointing it at a bucket, and
# the mode a restore rehearsal on a machine with no AWS credentials needs.
DRY_RUN="${REGULAIT_BACKUP_DRY_RUN:-0}"

SELF_PATH="/usr/local/sbin/regulait-pg-backup.sh"
UNIT_PATH="/etc/systemd/system/regulait-pg-backup.service"
TIMER_PATH="/etc/systemd/system/regulait-pg-backup.timer"
LOGROTATE_PATH="/etc/logrotate.d/regulait-pg-backup"
LOG="${REGULAIT_BACKUP_LOG:-/var/log/regulait-pg-backup.log}"
STATUS_DIR="${REGULAIT_BACKUP_STATUS_DIR:-/var/lib/regulait}"
STATUS_FILE="${STATUS_DIR}/pg-backup.status"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
HOSTTAG="$(hostname -s 2>/dev/null || echo unknown)"

# --- logging ------------------------------------------------------------------

log() { echo "$(date -u +%FT%TZ) $*"; }

open_log() {
  mkdir -p "$(dirname "$LOG")" "$STATUS_DIR" "$WORK_DIR"
  chmod 0700 "$WORK_DIR"
  exec > >(tee -a "$LOG") 2>&1
}

# --- postgres exec wrapper ----------------------------------------------------
#
# Every database command goes through here. In docker mode the command string is
# evaluated by a shell INSIDE the container, where $POSTGRES_USER /
# $POSTGRES_DB / $POSTGRES_PASSWORD already exist — which is why the argument is
# single-quoted at every call site.

CONTAINER=""

resolve_container() {
  [ "$EXEC_MODE" = "docker" ] || return 0
  if [ -d "$APP_DIR" ]; then
    CONTAINER="$(cd "$APP_DIR" && docker compose ps -q "$DB_SERVICE" 2>/dev/null | head -1)"
  fi
  if [ -z "$CONTAINER" ]; then
    # Fallback for a box where /opt/app moved or the compose project was
    # renamed. Matches the compose naming convention `<project>-<service>-N`.
    CONTAINER="$(docker ps --filter "name=-${DB_SERVICE}-" --format '{{.ID}}' 2>/dev/null | head -1)"
  fi
  [ -n "$CONTAINER" ]
}

# pg_exec <sh-command-string> — stdin and stdout pass straight through.
pg_exec() {
  if [ "$EXEC_MODE" = "docker" ]; then
    docker exec -i "$CONTAINER" sh -c "$1"
  else
    sh -c "$1"
  fi
}

# The client invocation, as a single-quoted fragment so $POSTGRES_PASSWORD and
# friends expand INSIDE the container, never out here. -qtAX gives bare
# `value|value` rows with no header, no alignment and no ~/.psqlrc.
PSQL_BASE='PGPASSWORD="$POSTGRES_PASSWORD" psql -qtAX -v ON_ERROR_STOP=1 --no-password -h "$PGHOST" -p "$PGPORT" -U "$POSTGRES_USER"'

# psql_file <database> <sql-file-on-host> — the SQL travels on stdin, so no
# query ever has to survive two levels of shell quoting.
psql_file() {
  pg_exec "$PSQL_BASE -d '$1' -f -" < "$2"
}

# Exact row counts for every base table in `public`, one `name|count` per line.
# EXACT, not pg_class.reltuples: the whole point is to compare a restored copy
# against the source, and an estimate that happens to match proves nothing.
# query_to_xml runs the per-table count() inside one statement, so this is a
# single round trip regardless of how many tables there are.
write_count_sql() {
  cat > "$1" <<'SQL'
SELECT t.table_name,
       (xpath('/row/c/text()', x))[1]::text::bigint
FROM (
  SELECT table_name,
         query_to_xml(format('SELECT count(*) AS c FROM %I.%I', table_schema, table_name),
                      false, true, '') AS x
  FROM information_schema.tables
  WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
) t
ORDER BY 1;
SQL
}

# In local mode the same variable names are expected to be exported by the
# caller/config, so the single-quoted command strings work unchanged.
export POSTGRES_USER="${POSTGRES_USER:-regulait}"
export POSTGRES_DB="${POSTGRES_DB:-regulait}"
export POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-}"
export PGHOST="${PGHOST:-127.0.0.1}"
export PGPORT="${PGPORT:-5432}"

wait_for_db() {
  local deadline=$((SECONDS + WAIT_SECS))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if resolve_container && pg_exec 'PGPASSWORD="$POSTGRES_PASSWORD" pg_isready -q -U "$POSTGRES_USER" -d "$POSTGRES_DB"' >/dev/null 2>&1; then
      return 0
    fi
    sleep 5
  done
  return 1
}

# --- status + heartbeat -------------------------------------------------------

RESULT="FAIL"
REASON="did-not-run"
OBJECT_URI=""

publish_metric() {
  local value="$1"
  [ "$DRY_RUN" = "1" ] && { log "heartbeat: DRY RUN, not publishing ${METRIC_NAME}=${value}"; return 0; }
  command -v aws >/dev/null 2>&1 || return 0
  aws cloudwatch put-metric-data \
    --region "$REGION" \
    --namespace "$METRIC_NAMESPACE" \
    --metric-name "$METRIC_NAME" \
    --dimensions "Target=${METRIC_TARGET}" \
    --value "$value" \
    --unit Count >/dev/null 2>&1 \
    || log "heartbeat: WARNING could not publish ${METRIC_NAME}=${value} (alarm may fire on absence)"
}

finish() {
  local rc=0
  [ "$RESULT" = "OK" ] || rc=1

  mkdir -p "$STATUS_DIR"
  cat > "$STATUS_FILE" <<EOF
last_attempt_utc=${STAMP}
result=${RESULT}
reason=${REASON}
object=${OBJECT_URI}
host=${HOSTTAG}
EOF

  publish_metric "$([ "$RESULT" = "OK" ] && echo 1 || echo 0)"

  # This exact line is what the runbook greps for. Keep the shape stable.
  log "RESULT=${RESULT} reason=${REASON} object=${OBJECT_URI:-none}"
  log "=== pg-backup done (exit ${rc}) ==="
  exit "$rc"
}

fail() {
  RESULT="FAIL"
  REASON="$1"
  log "ERROR: $1"
  finish
}

# --- install ------------------------------------------------------------------

do_install() {
  if [ "$(readlink -f "${BASH_SOURCE[0]}")" != "$SELF_PATH" ]; then
    install -D -m 0755 "${BASH_SOURCE[0]}" "$SELF_PATH"
    log "install: copied to $SELF_PATH"
  fi

  cat > "$UNIT_PATH" <<UNIT
[Unit]
Description=RegulAIt Postgres backup to S3 — see infra/scripts/pg-backup.sh
After=docker.service network-online.target
Wants=network-online.target
Requires=docker.service

[Service]
Type=oneshot
ExecStart=$SELF_PATH --run
# The dump + verify pass reads the whole archive back. Give it room, but do not
# let a wedged run sit on the timer forever.
TimeoutStartSec=3600
Nice=10
IOSchedulingClass=idle
UNIT

  cat > "$TIMER_PATH" <<TIMER
[Unit]
Description=RegulAIt Postgres backup schedule ($ONCALENDAR)

[Timer]
OnCalendar=$ONCALENDAR
# Run a MISSED elapse as soon as the machine is back. This is what makes a box
# that is powered off overnight and at weekends still get a backup on the first
# morning it returns, and what covers a manual start outside the window.
Persistent=true
AccuracySec=1min
Unit=regulait-pg-backup.service

[Install]
WantedBy=timers.target
TIMER

  cat > "$LOGROTATE_PATH" <<ROTATE
$LOG {
    weekly
    rotate 8
    compress
    missingok
    notifempty
    copytruncate
}
ROTATE

  systemctl daemon-reload

  if [ "$ENABLED" = "1" ]; then
    systemctl enable --now regulait-pg-backup.timer
    log "install: regulait-pg-backup.timer enabled — $ONCALENDAR"
  else
    systemctl disable --now regulait-pg-backup.timer 2>/dev/null
    log "install: REGULAIT_BACKUP_ENABLED=0, timer installed but DISABLED"
  fi
}

do_uninstall() {
  systemctl disable --now regulait-pg-backup.timer 2>/dev/null
  log "uninstall: timer stopped and disabled (script and unit files left in place)"
}

# --- the backup ---------------------------------------------------------------

do_run() {
  log "=== pg-backup starting (host=${HOSTTAG} mode=${EXEC_MODE}) ==="

  if [ "$DRY_RUN" = "1" ]; then
    log "MODE: DRY RUN — dump and verification are real, S3 upload and heartbeat are skipped"
  else
    [ -n "$BUCKET" ] || fail "no-bucket-configured: set REGULAIT_BACKUP_BUCKET in $CONF"
  fi

  wait_for_db || fail "db-unavailable-after-${WAIT_SECS}s"
  [ "$EXEC_MODE" = "docker" ] && log "db: container ${CONTAINER:0:12}"

  local dump="${WORK_DIR}/regulait-${STAMP}.dump"

  # -Fc: custom format. Compressed, and the only format pg_restore can filter,
  # reorder or restore selectively from — which is what makes a partial
  # "just get the audit_log table back" restore possible at 3am.
  # --no-password: never sit waiting on a prompt inside a systemd oneshot.
  log "dump: starting pg_dump -Fc"
  pg_exec 'PGPASSWORD="$POSTGRES_PASSWORD" pg_dump --no-password -h "$PGHOST" -p "$PGPORT" -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$dump"
  local dump_rc=${PIPESTATUS[0]}
  [ "$dump_rc" -eq 0 ] || fail "pg_dump-exit-${dump_rc}"

  # --- VERIFY BEFORE UPLOAD ---------------------------------------------------

  local bytes
  bytes=$(stat -c %s "$dump" 2>/dev/null || echo 0)
  log "verify: ${bytes} bytes"
  [ "$bytes" -ge "$MIN_BYTES" ] || fail "dump-too-small-${bytes}b-min-${MIN_BYTES}b"

  # (a) TOC parses, and contains real table data — not a schema-only archive.
  local toc data_entries
  toc=$(pg_exec 'pg_restore --list' < "$dump" 2>&1)
  local toc_rc=$?
  [ "$toc_rc" -eq 0 ] || { log "verify: pg_restore --list said: ${toc}"; fail "toc-unreadable"; }

  data_entries=$(printf '%s\n' "$toc" | grep -c 'TABLE DATA')
  log "verify: TOC lists ${data_entries} TABLE DATA entries"
  [ "$data_entries" -ge 1 ] || fail "toc-has-no-table-data"

  # (b) The WHOLE archive decompresses. THIS IS THE STEP THAT ACTUALLY WORKS,
  #     and (a) on its own is not enough — measured, not assumed:
  #
  #       8.4 MB -Fc dump of a 200,000-row table, truncated to 90%:
  #         pg_restore --list        -> exit 0   (TOC is intact and at the FRONT)
  #         pg_restore -f /dev/null  -> exit 1   "could not read from input file"
  #         actually restoring it    -> 0 of 200,000 rows, pg_restore exit 1
  #
  #     A `--list`-only check would therefore have blessed and uploaded a file
  #     containing none of the data. This streams every member out as SQL and
  #     throws it away, so a short write, a full disk or a killed pg_dump is
  #     caught here, BEFORE anything reaches S3.
  local full_out
  full_out=$(pg_exec 'pg_restore -f /dev/null' < "$dump" 2>&1)
  local full_rc=$?
  [ "$full_rc" -eq 0 ] || { log "verify: full parse said: ${full_out}"; fail "archive-truncated-or-corrupt"; }
  log "verify: full archive parse OK"

  local sha
  sha=$(sha256sum "$dump" | cut -d' ' -f1)

  # (c) A manifest of exact row counts, taken from the SAME server moments after
  #     the dump. This is what a restore is checked against — without it,
  #     "the restore worked" is an opinion.
  local manifest="${WORK_DIR}/regulait-${STAMP}.manifest.json"
  write_manifest "$manifest" "$bytes" "$sha" "$data_entries" || log "manifest: WARNING could not build row-count manifest"

  # --- UPLOAD -----------------------------------------------------------------

  local key="${PREFIX}/${HOSTTAG}/${STAMP}/regulait-${STAMP}.dump"

  if [ "$DRY_RUN" = "1" ]; then
    OBJECT_URI="(dry-run, would have been s3://${BUCKET:-<unset>}/${key})"
    log "upload: skipped — DRY RUN"
  else
    OBJECT_URI="s3://${BUCKET}/${key}"
    log "upload: -> ${OBJECT_URI}"
    # No --sse flag: the bucket's default encryption applies to every PutObject,
    # so encryption is a property of the destination and cannot be forgotten
    # here. --only-show-errors keeps the progress bar out of a systemd log.
    aws s3 cp "$dump" "$OBJECT_URI" \
      --region "$REGION" --only-show-errors \
      --metadata "sha256=${sha},tabledata=${data_entries},srchost=${HOSTTAG}" \
      || fail "s3-upload-failed"

    if [ -f "$manifest" ]; then
      aws s3 cp "$manifest" "s3://${BUCKET}/${PREFIX}/${HOSTTAG}/${STAMP}/manifest.json" \
        --region "$REGION" --only-show-errors \
        || log "upload: WARNING manifest upload failed (the dump itself is safe)"
    fi
  fi

  # Keep a few dumps locally: restoring from /var/backups is far faster than a
  # download, and it is the copy `--verify-restore` exercises.
  ls -1t "${WORK_DIR}"/regulait-*.dump 2>/dev/null | tail -n +"$((KEEP_LOCAL + 1))" | xargs -r rm -f
  ls -1t "${WORK_DIR}"/regulait-*.manifest.json 2>/dev/null | tail -n +"$((KEEP_LOCAL + 1))" | xargs -r rm -f

  RESULT="OK"
  REASON="verified-${bytes}b-${data_entries}-tables"
  finish
}

# write_manifest <path> <bytes> <sha> <table-data-count>
write_manifest() {
  local path="$1" bytes="$2" sha="$3" entries="$4"
  local counts version sql="${WORK_DIR}/.counts.$$.sql"

  version=$(pg_exec "$PSQL_BASE -d \"\$POSTGRES_DB\" -c 'SHOW server_version'" 2>/dev/null | tr -d '\r')

  write_count_sql "$sql"
  counts=$(psql_file "$POSTGRES_DB" "$sql" 2>/dev/null | tr -d '\r')
  rm -f "$sql"

  {
    echo "{"
    echo "  \"stamp\": \"${STAMP}\","
    echo "  \"host\": \"${HOSTTAG}\","
    echo "  \"server_version\": \"${version}\","
    echo "  \"dump_bytes\": ${bytes},"
    echo "  \"dump_sha256\": \"${sha}\","
    echo "  \"table_data_entries\": ${entries},"
    echo "  \"row_counts\": {"
    printf '%s\n' "$counts" | awk -F'|' 'NF==2 {printf "%s    \"%s\": %s", (n++ ? ",\n" : ""), $1, $2} END {print ""}'
    echo "  }"
    echo "}"
  } > "$path"

  local n
  n=$(printf '%s\n' "$counts" | awk -F'|' 'NF==2' | wc -l)
  log "manifest: ${n} tables counted -> $(basename "$path")"
  [ "$n" -ge 1 ]
}

# --- restore rehearsal --------------------------------------------------------
#
# Restores a dump into a SCRATCH database on the same server and diffs its row
# counts against the manifest taken at dump time. NEVER touches the live
# database — the scratch name is generated here and the live name is refused
# explicitly, because "I typed the wrong -d" is the way this goes wrong.

do_verify_restore() {
  log "=== pg-backup restore rehearsal (host=${HOSTTAG} mode=${EXEC_MODE}) ==="

  local dump="${1:-}"
  if [ -z "$dump" ]; then
    dump=$(ls -1t "${WORK_DIR}"/regulait-*.dump 2>/dev/null | head -1)
  fi
  [ -n "$dump" ] && [ -f "$dump" ] || fail "no-dump-to-verify (pass a path, or run --run first)"
  log "rehearsal: dump = ${dump}"

  local manifest="${dump%.dump}.manifest.json"

  wait_for_db || fail "db-unavailable-after-${WAIT_SECS}s"

  local scratch="regulait_restore_check_$(date -u +%Y%m%d%H%M%S)_$$"
  if [ "$scratch" = "$POSTGRES_DB" ]; then
    fail "refusing-to-restore-over-live-database"
  fi
  log "rehearsal: scratch database = ${scratch}"

  pg_exec "PGPASSWORD=\"\$POSTGRES_PASSWORD\" createdb --no-password -h \"\$PGHOST\" -p \"\$PGPORT\" -U \"\$POSTGRES_USER\" '${scratch}'" \
    || fail "scratch-createdb-failed"

  # --exit-on-error so a partially-restored database is a loud failure rather
  # than a quietly wrong row count. Ownership/role GRANTs from a different
  # cluster are the usual noise; --no-owner keeps them out of the way.
  local out rc
  out=$(pg_exec "PGPASSWORD=\"\$POSTGRES_PASSWORD\" pg_restore --no-password -h \"\$PGHOST\" -p \"\$PGPORT\" -U \"\$POSTGRES_USER\" -d '${scratch}' --no-owner --no-privileges --exit-on-error" < "$dump" 2>&1)
  rc=$?
  if [ "$rc" -ne 0 ]; then
    log "rehearsal: pg_restore said: ${out}"
    pg_exec "PGPASSWORD=\"\$POSTGRES_PASSWORD\" dropdb --no-password -h \"\$PGHOST\" -p \"\$PGPORT\" -U \"\$POSTGRES_USER\" --if-exists '${scratch}'" >/dev/null 2>&1
    fail "pg_restore-exit-${rc}"
  fi
  log "rehearsal: pg_restore completed clean"

  # Count every public table in the RESTORED database, with the same SQL the
  # manifest used on the source.
  local restored sql="${WORK_DIR}/.counts.$$.sql"
  write_count_sql "$sql"
  restored=$(psql_file "$scratch" "$sql" 2>/dev/null | tr -d '\r')
  rm -f "$sql"

  local restored_file="${WORK_DIR}/.restored-counts.$$"
  printf '%s\n' "$restored" | awk -F'|' 'NF==2 {print $1"\t"$2}' | sort > "$restored_file"

  local mismatches=0 compared=0
  if [ -f "$manifest" ]; then
    local source_file="${WORK_DIR}/.source-counts.$$"
    # Pull name/count pairs back out of the manifest without needing jq.
    sed -n '/"row_counts"/,/^  }/p' "$manifest" \
      | grep -oE '"[a-zA-Z0-9_]+": [0-9]+' \
      | sed 's/"//g; s/: /\t/' | sort > "$source_file"

    log "rehearsal: table | source rows | restored rows"
    while IFS=$'\t' read -r t n; do
      local r
      r=$(awk -F'\t' -v k="$t" '$1==k {print $2}' "$restored_file")
      compared=$((compared + 1))
      if [ "${r:-missing}" = "$n" ]; then
        log "  OK   ${t} | ${n} | ${r}"
      else
        log "  DIFF ${t} | ${n} | ${r:-<table absent>}"
        mismatches=$((mismatches + 1))
      fi
    done < "$source_file"
    rm -f "$source_file"
  else
    log "rehearsal: WARNING no manifest beside the dump — reporting restored counts only"
    while IFS=$'\t' read -r t n; do log "  restored ${t} = ${n}"; done < "$restored_file"
  fi

  rm -f "$restored_file"

  pg_exec "PGPASSWORD=\"\$POSTGRES_PASSWORD\" dropdb --no-password -h \"\$PGHOST\" -p \"\$PGPORT\" -U \"\$POSTGRES_USER\" '${scratch}'" \
    || log "rehearsal: WARNING could not drop scratch database ${scratch} — drop it by hand"
  log "rehearsal: scratch database dropped"

  if [ "$compared" -eq 0 ]; then
    RESULT="FAIL"; REASON="rehearsal-compared-nothing"
  elif [ "$mismatches" -eq 0 ]; then
    RESULT="OK"; REASON="rehearsal-${compared}-tables-matched"
  else
    RESULT="FAIL"; REASON="rehearsal-${mismatches}-of-${compared}-tables-differ"
  fi
  # A rehearsal must not overwrite the real backup's heartbeat.
  publish_metric() { :; }
  finish
}

# --- check --------------------------------------------------------------------

do_check() {
  echo "--- timer ---"
  systemctl is-enabled regulait-pg-backup.timer 2>&1
  systemctl list-timers regulait-pg-backup.timer --all --no-pager 2>&1 | head -3
  echo
  echo "--- last service run ---"
  systemctl status regulait-pg-backup.service --no-pager 2>&1 | head -8
  echo
  echo "--- last result ---"
  cat "$STATUS_FILE" 2>/dev/null || echo "no status file at $STATUS_FILE — the job has never completed"
  echo
  echo "--- last RESULT lines in the log ---"
  grep 'RESULT=' "$LOG" 2>/dev/null | tail -5 || echo "no RESULT lines in $LOG"
  echo
  echo "--- newest objects in s3://${BUCKET}/${PREFIX}/ ---"
  if [ -n "$BUCKET" ]; then
    aws s3 ls "s3://${BUCKET}/${PREFIX}/" --recursive --region "$REGION" 2>&1 | tail -6
  else
    echo "REGULAIT_BACKUP_BUCKET is not set in $CONF"
  fi
}

# --- dispatch -----------------------------------------------------------------

case "${1:-}" in
  --install)
    open_log; do_install ;;
  --uninstall)
    open_log; do_uninstall ;;
  --run)
    open_log; do_run ;;
  --verify-restore)
    open_log; do_verify_restore "${2:-}" ;;
  --check)
    do_check ;;
  "")
    open_log; do_install; do_run ;;
  *)
    echo "usage: $0 [--install|--uninstall|--run|--verify-restore [dump]|--check]" >&2
    exit 2 ;;
esac
