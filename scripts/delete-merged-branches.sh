#!/usr/bin/env bash
#
# Delete the merged `claude/*` branches from origin.
#
# WHY THIS FILE EXISTS. A cleanup on 2026-09-26 audited all 69 remote branches
# and found 66 safe to delete. The session that did the audit could not carry it
# out: its git credential is scoped to allow pushes but NOT ref deletions, and
# every `git push --delete` came back `HTTP 403` while an ordinary push to the
# same remote succeeded seconds later. So the list is committed here for someone
# whose credential can.
#
# ── HOW THE LIST WAS DERIVED, AND WHY NOT THE OBVIOUS WAY ───────────────────
# NOT by `git branch --merged`. That reports 67 of 68 branches as UNMERGED,
# because their pull requests were SQUASH-merged and git cannot see through a
# squash. Deleting on that signal would have been exactly backwards.
#
# The list comes from the pull requests instead: a branch is included only if a
# PR whose head it was carries a `merged_at` timestamp. Note for anyone
# re-running the audit — the API's `merged` boolean reads `false` for every PR
# in this repository under field projection, INCLUDING ones merged minutes
# earlier. `merged_at` is the truthful field; `merged` is not.
#
# ── THREE BRANCHES ARE DELIBERATELY EXCLUDED ────────────────────────────────
#   main                          the default branch.
#   claude/status-check-2gbrwf    the active working branch.
#   claude/authorized-foundation  THE ONE BRANCH WHOSE PR WAS CLOSED WITHOUT
#                                 MERGING (#82). It holds ~2,751 insertions that
#                                 exist nowhere else, including 508 lines of SAP
#                                 schema. Deleting it destroys the only copy.
#                                 See PENDING.md D03 before you touch it.
#
# ── USAGE ───────────────────────────────────────────────────────────────────
#   scripts/delete-merged-branches.sh          # dry run: prints, deletes nothing
#   scripts/delete-merged-branches.sh --yes    # actually deletes
#
# Deleting a branch is not quite irreversible — a ref can be restored from its
# SHA while GitHub still has the objects — but it is not something to do by
# accident, so the default does nothing.
#
# This file is disposable. Delete it once the cleanup is done.

set -euo pipefail

REMOTE="${REMOTE:-origin}"
APPLY=false
[ "${1:-}" = "--yes" ] && APPLY=true

BRANCHES=(
  claude/async-deploy
  claude/auth-account-labels
  claude/auth-keysession-fix
  claude/aws-power-schedule
  claude/backend-orphans
  claude/backup-env-quoting
  claude/baseurl-egress-guard
  claude/ci-budget
  claude/compat-longtail
  claude/compat-temperature
  claude/connector-adapters
  claude/connector-egress-guard
  claude/custom-llm-providers
  claude/custom-llm-ui
  claude/deferrals-cleanup
  claude/enterprise-plan-adrs
  claude/enterprise-ux
  claude/fix-caddy-ip
  claude/fix-seed-teardown
  claude/ghcr-publish-workflow
  claude/git-adapters
  claude/gitignore-worktrees
  claude/governance-gaps
  claude/housekeeping-docs
  claude/hsts-decision
  claude/ide-interception
  claude/ide-interception-plan
  claude/infra-aws
  claude/infra-breadth
  claude/infra-deploy-wiring
  claude/infra-live-wiring
  claude/interception-depth
  claude/legacy-ui-removal
  claude/model-depth
  claude/org-settings
  claude/p0-hardening
  claude/pillar3-infra-ops
  claude/pinned-egress-dispatcher
  claude/postgres-backup
  claude/scheduler-boot-fix
  claude/scheduler-trust-fix
  claude/schema-depth
  claude/secure-auth
  claude/setup-journey
  claude/spa-context-store
  claude/spa-debts
  claude/spa-enduser-gaps
  claude/spa-parity-gaps
  claude/spa-phase1
  claude/spa-phase2
  claude/state-catchup
  claude/state-deploy-done
  claude/state-legacy-removed
  claude/state-recap-0730
  claude/state-wave-recap
  claude/state-wave10-11
  claude/state-wave3
  claude/state-wave4
  claude/state-wave56
  claude/state-wave78
  claude/state-wave9
  claude/tf-safety
  claude/tls
  claude/username-login
  claude/ux-a11y-pass
  claude/worker-streaming
)

# Refuse to touch anything outside the audited set, however this file is edited
# later. A typo that turned a name into `main` should fail, not run.
PROTECTED=("main" "claude/status-check-2gbrwf" "claude/authorized-foundation")
for b in "${BRANCHES[@]}"; do
  for p in "${PROTECTED[@]}"; do
    if [ "$b" = "$p" ]; then
      echo "REFUSING: '$b' is protected and must not be in this list." >&2
      exit 1
    fi
  done
done

echo "${#BRANCHES[@]} branches, remote '$REMOTE'."
if ! $APPLY; then
  printf '%s\n' "${BRANCHES[@]}"
  echo
  echo "Dry run — nothing deleted. Re-run with --yes to apply."
  exit 0
fi

failed=0
for b in "${BRANCHES[@]}"; do
  if git push "$REMOTE" --delete "$b"; then
    echo "deleted $b"
  else
    echo "FAILED  $b" >&2
    failed=$((failed + 1))
  fi
done

echo
if [ "$failed" -gt 0 ]; then
  echo "$failed of ${#BRANCHES[@]} could not be deleted."
  echo "An HTTP 403 here means the credential cannot delete refs, which is the"
  echo "exact reason this script exists rather than the deletions having been done."
  exit 1
fi
echo "All ${#BRANCHES[@]} deleted."
