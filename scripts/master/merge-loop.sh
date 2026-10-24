#!/usr/bin/env bash
# Master-session merge loop (FS-25). Merges only pull requests that the master
# session has released explicitly, at the exact head commit it reviewed.
#
# Usage: scripts/master/merge-loop.sh <state-dir> [seconds-to-run] [poll-seconds]
#
# <state-dir>/released.txt holds one "<pr-number> <full-head-sha>" per line.
# A PR merges only when ALL of these hold:
#   - its number and current head sha are on one line of released.txt;
#   - its title does not start with "HOLD";
#   - it is open, not a draft, and GitHub reports it mergeable;
#   - every check run on the head sha has completed as success, neutral or skipped
#     (and there is at least one);
#   - the head commit is at least MIN_AGE seconds old (default 600), so late
#     check suites have time to register.
# It always merges with a merge commit, passing the sha so GitHub refuses the
# merge if the head moved. A pushed fix needs a new released.txt line.
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
log() { echo "$(date -u +%H:%M) $*" >> "$LOG"; }

checks_green() {
  local sha="$1" verdict
  verdict="$(gh api "repos/$REPO/commits/$sha/check-runs?per_page=100" --paginate \
    --jq '.check_runs[] | "\(.status) \(.conclusion)"' | awk '
      { n++ }
      $1 != "completed" { pending++ }
      $1 == "completed" && $2 != "success" && $2 != "neutral" && $2 != "skipped" { bad++ }
      END { if (n == 0 || pending > 0) print "wait"; else if (bad > 0) print "red"; else print "green" }')"
  echo "$verdict"
}

try_merge() {
  local pr="$1" want="$2" info head draft state title mergeable when age checks
  info="$(gh api "repos/$REPO/pulls/$pr" --jq '[.head.sha, .draft, .state, .title, (.mergeable|tostring)] | @tsv')" || return 0
  IFS=$'\t' read -r head draft state title mergeable <<< "$info"
  [ "$state" = "open" ] || return 0
  if [ "$head" != "$want" ]; then log "skip $pr: head ${head:0:10} is not the released ${want:0:10}"; return 0; fi
  case "$title" in HOLD*) log "skip $pr: title still HOLD"; return 0;; esac
  if [ "$draft" = "true" ]; then log "skip $pr: still a draft"; return 0; fi
  if [ "$mergeable" != "true" ]; then log "skip $pr: mergeable=$mergeable"; return 0; fi
  when="$(gh api "repos/$REPO/commits/$head" --jq '.commit.committer.date')"
  age=$(( $(date -u +%s) - $(date -u -d "$when" +%s) ))
  if [ "$age" -lt "$MIN_AGE" ]; then return 0; fi
  checks="$(checks_green "$head")"
  if [ "$checks" != "green" ]; then
    [ "$checks" = "red" ] && log "skip $pr: checks red at ${head:0:10}"
    return 0
  fi
  if gh api -X PUT "repos/$REPO/pulls/$pr/merge" -f merge_method=merge -f sha="$head" >/dev/null 2>&1; then
    log "MERGED $pr at ${head:0:10}"
  else
    log "merge refused for $pr at ${head:0:10}"
  fi
}

end=$(( $(date -u +%s) + RUN_FOR ))
log "loop start (runs ${RUN_FOR}s)"
while [ "$(date -u +%s)" -lt "$end" ]; do
  while read -r pr sha _; do
    [ -n "${pr:-}" ] && [ -n "${sha:-}" ] || continue
    case "$pr" in \#*) continue;; esac
    try_merge "$pr" "$sha" || log "error while checking $pr"
  done < "$RELEASED"
  sleep "$POLL"
done
log "loop end"
