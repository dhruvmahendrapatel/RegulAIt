#!/usr/bin/env bash
# Master-session merge loop (FS-25). Merges only pull requests that the master
# session has released explicitly, at the exact head commit it reviewed.
#
# Usage: scripts/master/merge-loop.sh <state-dir> [seconds-to-run] [poll-seconds]
#
# <state-dir>/released.txt holds one "<pr-number> <full-40-hex-head-sha>" per line
# ("#" comments and blank lines are ignored). A PR merges only when ALL of these hold:
#   - its number and current head sha are on one line of released.txt;
#   - its title does not start with "HOLD" (any case, optionally after "[");
#   - it is open, not a draft, and GitHub reports it mergeable;
#   - every check run on the head sha has completed as success, neutral or skipped
#     (and there is at least one), and the combined commit status is success or empty;
#   - this loop has seen that (pr, sha) for at least MIN_AGE seconds (default 600),
#     so check suites that register late have time to appear. The clock starts when
#     the loop first sees the pair, never from the commit date, and restarts with the loop.
# It always merges with a merge commit, passing the sha so GitHub refuses the
# merge if the head moved. A pushed fix needs a new released.txt line.
# Any lookup that fails or returns something unexpected skips the PR for this poll.
# Each decision is appended to <state-dir>/loop.log. Nothing else is written.
set -euo pipefail

STATE="${1:?state dir required}"
RUN_FOR="${2:-7000}"
POLL="${3:-120}"
MIN_AGE="${MIN_AGE:-600}"
REPO="${REPO:-dhruvmahendrapatel/RegulAIt}"
RELEASED="$STATE/released.txt"
LOG="$STATE/loop.log"

mkdir -p "$STATE"
touch "$RELEASED"
declare -A first_seen=()
declare -A last_note=()
log() { echo "$(date -u +%H:%M) $*" >> "$LOG"; }
# log a skip reason only when it changes, so a held PR does not fill the log every poll
note() { local key="$1"; shift; if [ "${last_note[$key]:-}" != "$*" ]; then last_note[$key]="$*"; log "$*"; fi; }

# prints green, red, wait or error
checks_state() {
  local sha="$1" runs status
  runs="$(gh api "repos/$REPO/commits/$sha/check-runs?per_page=100" \
    --jq '"total \(.total_count)", (.check_runs[] | "\(.status) \(.conclusion)")' 2>/dev/null)" || { echo error; return; }
  status="$(gh api "repos/$REPO/commits/$sha/status" --jq '"\(.state) \(.total_count)"' 2>/dev/null)" || { echo error; return; }
  printf '%s\nstatus %s\n' "$runs" "$status" | awk '
    $1 == "total" { total = $2; next }
    $1 == "status" { sstate = $2; scount = $3; next }
    { n++ }
    $1 != "completed" { pending++ }
    $1 == "completed" && $2 != "success" && $2 != "neutral" && $2 != "skipped" { bad++ }
    END {
      if (total != n) { print "error"; exit }          # more than one page, or a malformed reply
      if (scount > 0 && sstate == "failure") bad++
      if (scount > 0 && sstate == "error") bad++
      if (scount > 0 && sstate == "pending") pending++
      if (bad > 0) print "red"; else if (n == 0 || pending > 0) print "wait"; else print "green"
    }'
}

try_merge() {
  local pr="$1" want="$2" info head draft state title mergeable now seen checks out
  info="$(gh api "repos/$REPO/pulls/$pr" --jq '[.head.sha, .draft, .state, .title, (.mergeable|tostring)] | @tsv' 2>/dev/null)" \
    || { note "$pr" "skip $pr: PR lookup failed"; return 0; }
  IFS=$'\t' read -r head draft state title mergeable <<< "$info"
  [ "$state" = "open" ] || { note "$pr" "skip $pr: state $state"; return 0; }
  if [ "$head" != "$want" ]; then note "$pr" "skip $pr: head ${head:0:10} is not the released ${want:0:10}"; return 0; fi
  if [[ "${title^^}" =~ ^\[?HOLD ]]; then note "$pr" "skip $pr: title still HOLD"; return 0; fi
  if [ "$draft" = "true" ]; then note "$pr" "skip $pr: still a draft"; return 0; fi
  if [ "$mergeable" != "true" ]; then note "$pr" "skip $pr: mergeable=$mergeable"; return 0; fi
  now="$(date -u +%s)"
  seen="${first_seen[$pr:$head]:-}"
  if [ -z "$seen" ]; then first_seen[$pr:$head]="$now"; seen="$now"; fi
  if [ $(( now - seen )) -lt "$MIN_AGE" ]; then note "$pr" "wait $pr: soaking ${head:0:10}"; return 0; fi
  checks="$(checks_state "$head")"
  case "$checks" in
    green) ;;
    red) note "$pr" "skip $pr: checks red at ${head:0:10}"; return 0;;
    error) note "$pr" "skip $pr: checks unavailable at ${head:0:10}"; return 0;;
    *) note "$pr" "wait $pr: checks running at ${head:0:10}"; return 0;;
  esac
  if out="$(gh api -X PUT "repos/$REPO/pulls/$pr/merge" -f merge_method=merge -f sha="$head" 2>&1)"; then
    log "MERGED $pr at ${head:0:10}"
  else
    log "merge refused for $pr at ${head:0:10}: $(printf '%s' "$out" | tr '\n' ' ' | cut -c1-200)"
  fi
}

end=$(( $(date -u +%s) + RUN_FOR ))
log "loop start (runs ${RUN_FOR}s)"
while [ "$(date -u +%s)" -lt "$end" ]; do
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    case "$line" in ''|\#*) continue;; esac
    read -r pr sha _ <<< "$line"
    if ! [[ "$pr" =~ ^[0-9]+$ && "${sha:-}" =~ ^[0-9a-f]{40}$ ]]; then note "bad:$line" "bad released.txt line: $line"; continue; fi
    try_merge "$pr" "$sha" || log "error while checking $pr"
  done < "$RELEASED"
  sleep "$POLL"
done
log "loop end"
