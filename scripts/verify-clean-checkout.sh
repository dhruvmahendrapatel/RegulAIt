#!/usr/bin/env bash
# =============================================================================
# RegulAIt clean-checkout VERIFIER (AER-003 / R2)
#
# ONE command for the sequence README.md's "Verifying a clean checkout" section
# spells out by hand, with the two things a hand-run sequence cannot give:
#
#   * it ASSERTS the result. After the last stage
#     `git status --short --untracked-files=all` must be empty — a build or
#     test that writes into the tree (a rewritten lockfile, a regenerated
#     fixture, a stray artefact) is a FAILURE, exit 1, with the offending paths
#     printed. `--untracked-files=all` because plain `--short` obeys the
#     user's `status.showUntrackedFiles`, and with that set to `no` a stray
#     untracked artefact would pass. The sequence verifies a checkout; it must
#     never be the thing that changes what it is verifying.
#   * it can PROVE its own assertion is not vacuous. `--prove-failure` clones
#     HEAD into a temporary directory and requires the gate to FIRE there, at
#     two levels: the assertion function on a modified tracked file and on an
#     untracked file (with `status.showUntrackedFiles=no` set in the clone),
#     and THIS SCRIPT, run end to end inside the clone, exiting 2 on a tree
#     that was dirty before it started and 1 on a tree a stage dirtied. A gate
#     that has never been seen to fail is a gate nobody can trust (M-033).
#
# The stages, in order (each one aborts the run on a non-zero exit):
#
#   0. the pinned package manager — `packageManager` in package.json via
#      corepack, then `pnpm --version` is checked against the pin regardless
#      of how pnpm got onto PATH (a mismatched pnpm resolves a different tree
#      from the same lockfile; see README).
#   1. `scripts/preflight-ui-affordances.mjs`   CI's B9c pre-flight: every
#      DELETE route reachable from a view. STATIC (route registrations and TSX
#      sources; no install, no build, no database), so it runs first and it
#      runs under --skip-tests.
#   2. `pnpm install --frozen-lockfile`   never rewrites pnpm-lock.yaml
#   3. `pnpm -r build`                    every workspace, SPA included
#   4. `pnpm -r exec tsc --noEmit`        against SOURCE, not a stale dist/
#   5. `pnpm -r test`                     on a database CREATED for this run
#   6. `scripts/preflight-unique-constraints.mjs` on the database step 5 just
#      migrated AND populated (ADR-0110: on an empty database it is trivially
#      zero), then that database is dropped
#   7. `git status --short --untracked-files=all` must be empty
#
# Stages 1, 3, 5 and 6 are the build, test and pre-flight steps of CI's
# `build-and-test` check (.github/workflows/ci.yml), and stage 2 installs the
# way it does. In CI that check aggregates `build-and-test-base` (build, the
# non-gateway tests, stage 1), four `gateway-tests` shards (the gateway suite,
# each shard on its own Postgres and running stage 6 after its tests) and
# `gateway-coverage`; here it all runs serially on one database. The base
# job's AgentCoordination.md lint is deliberately not here: it checks the
# agents' bookkeeping file, not the product a checkout builds.
#
# BUILD-SCRIPT POLICY. pnpm 10 refuses to run dependency lifecycle scripts
# that are not approved in `pnpm.onlyBuiltDependencies`, and a fresh install
# names what it skipped ("Ignored build scripts: ..."). package.json carries
# that policy explicitly: the approved list is EMPTY, because every skipped
# script was assessed and none is needed — esbuild's postinstall only
# validates/caches the platform binary that `@esbuild/<platform>` already
# ships (vite, vitest and drizzle-kit all build and run without it), and
# protobufjs 7's postinstall is a version-scheme warning that returns before
# doing anything. Those two are named in `pnpm.ignoredBuiltDependencies` so
# the install is silent about them and LOUD about any newcomer: a dependency
# that starts wanting a build script shows up as a new warning, which is the
# moment to assess it, not to approve it blind.
#
# Usage:
#   scripts/verify-clean-checkout.sh                   the full sequence (0-7)
#   scripts/verify-clean-checkout.sh --skip-tests      stages 0-4 and 7; no database needed
#   scripts/verify-clean-checkout.sh --prove-failure   the control: the gate must fire in a
#                                                      temporary clone (see above)
#   scripts/verify-clean-checkout.sh --offline         `pnpm install --offline` (store only)
#   scripts/verify-clean-checkout.sh --no-corepack     skip `corepack enable/prepare`; the
#                                                      pnpm on PATH must still match the pin
#
# Environment (stage 5/6 only):
#   VERIFY_PG   base URL without a database   default postgres://regulait:regulait@localhost:5432
#   VERIFY_DB   the disposable database name  default regulait_verify
#
# VERIFY_CONTROL_TREE is --prove-failure's own hook and nothing else: set to
# the absolute path of the tree this script is running in, it skips the
# stages that need pnpm (0, 2-6), so the control never installs or builds;
# past the precondition it adds an untracked file the way a careless build
# would and lets stage 7 judge. Such a run can only end in exit 2 (dirty
# before it started) or 1 — or, if a gate is broken, in a VERIFIED the
# control reports as a failure. It is refused when it names any other tree.
#
# Exit codes: 0 verified (or, under --prove-failure, the gate fired everywhere
# it must). 1 a stage failed, the tree was left dirty, or the control did NOT
# fire. 2 usage or precondition error (not inside a git work tree, tree
# already dirty before the run, pnpm does not match the pin).
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_PATH="$SCRIPT_DIR/$(basename -- "${BASH_SOURCE[0]}")"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"

SKIP_TESTS=0
PROVE_FAILURE=0
OFFLINE=0
USE_COREPACK=1
VERIFY_PG="${VERIFY_PG:-postgres://regulait:regulait@localhost:5432}"
VERIFY_DB="${VERIFY_DB:-regulait_verify}"

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  C_RED=$'\033[31m'; C_GRN=$'\033[32m'; C_BLD=$'\033[1m'; C_RST=$'\033[0m'
else
  C_RED=''; C_GRN=''; C_BLD=''; C_RST=''
fi

step() { printf '\n%s==> %s%s\n' "$C_BLD" "$*" "$C_RST"; }
pass() { printf '  %s[pass]%s %s\n' "$C_GRN" "$C_RST" "$*"; }
fail() {
  printf '\n%s[FAILED]%s %s\n' "$C_RED" "$C_RST" "$1" >&2
  shift
  for l in "$@"; do printf '         %s\n' "$l" >&2; done
  printf '\n' >&2
  exit 1
}
die() { printf '%s[error]%s %s\n' "$C_RED" "$C_RST" "$*" >&2; exit 2; }

usage() {
  cat <<'USAGE'
Usage: scripts/verify-clean-checkout.sh [options]

  --skip-tests      Run stages 0-4 and the clean-tree assertion; no database.
  --prove-failure   Control mode: in a temporary clone, require the clean-tree
                    assertion to fire on a modified tracked file and on an
                    untracked file, and require this script to exit 2 on a
                    pre-dirtied tree and 1 on a tree a stage dirtied.
  --offline         pnpm install --offline (resolve from the store only).
  --no-corepack     Do not run corepack; pnpm on PATH must match the pin.
  -h, --help
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --skip-tests)    SKIP_TESTS=1; shift ;;
    --prove-failure) PROVE_FAILURE=1; shift ;;
    --offline)       OFFLINE=1; shift ;;
    --no-corepack)   USE_COREPACK=0; shift ;;
    -h|--help)       usage; exit 0 ;;
    *)               usage >&2; die "unknown option: $1" ;;
  esac
done

# ----------------------------------------------------------------------------
# THE ASSERTION. One function, used by the real run and by the control, so the
# control proves the very check the run relies on and not a look-alike.
#   $1 = the work tree to inspect
# Exit 0 when the status is empty; 1 otherwise, with the paths.
# ----------------------------------------------------------------------------
tree_status() { git -C "$1" status --short --untracked-files=all; }

assert_clean_tree() {
  local tree="$1" dirty
  dirty="$(tree_status "$tree")"
  if [ -n "$dirty" ]; then
    printf '%s[clean-tree assertion]%s the work tree is NOT clean after verification:\n' "$C_RED" "$C_RST" >&2
    printf '%s\n' "$dirty" | sed 's/^/    /' >&2
    printf '  A verification run must leave the checkout exactly as it found it. Something\n' >&2
    printf '  above wrote into tracked or untracked paths (a rewritten lockfile, a regenerated\n' >&2
    printf '  fixture, an artefact outside .gitignore). Find it before trusting the result.\n' >&2
    return 1
  fi
  return 0
}

cd "$REPO_ROOT"
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || die "$REPO_ROOT is not inside a git work tree"

# ----------------------------------------------------------------------------
# --prove-failure: the deliberately failing control.
# ----------------------------------------------------------------------------
if [ "$PROVE_FAILURE" = "1" ]; then
  step "Control: the gate must fire in a temporary clone"
  CONTROL_DIR="$(mktemp -d)"
  trap 'rm -rf "$CONTROL_DIR"' EXIT
  # A local clone of HEAD — committed content only, nothing of this tree's
  # uncommitted state, and nothing here can touch the real checkout.
  # `--shared` borrows the object store instead of copying it: the copy lives
  # for seconds and git never rewrites an existing object file in place.
  git clone -q --shared "$REPO_ROOT" "$CONTROL_DIR/copy"
  COPY="$(cd -- "$CONTROL_DIR/copy" && pwd -P)"
  # The control judges THE SCRIPT BEING RUN, not HEAD's copy of it: an
  # uncommitted edit that breaks stage 7 must make this control fail, so the
  # running file is committed into the clone when it differs.
  if ! cmp -s "$SCRIPT_PATH" "$COPY/scripts/verify-clean-checkout.sh"; then
    cp "$SCRIPT_PATH" "$COPY/scripts/verify-clean-checkout.sh"
    git -C "$COPY" -c user.name=verify-control -c user.email=verify-control@localhost \
      -c commit.gpgsign=false commit -q --no-verify -am "control: the script being run"
    pass "the clone carries the script being run (it differs from HEAD's)"
  fi
  # The strictest setting a developer can have: plain `git status --short`
  # would hide every untracked file from the assertion under it.
  git -C "$COPY" config status.showUntrackedFiles no
  if ! assert_clean_tree "$COPY" 2>/dev/null; then
    fail "the fresh clone is not clean before the control touched anything — the control cannot be read"
  fi
  pass "fresh clone is clean (git status --short --untracked-files=all empty)"

  # (a) A modified tracked file: append one byte, the smallest change git must
  # report. (`sed -n 1p`, not `head -1`: under pipefail, head closing the pipe
  # early hands git a SIGPIPE and this script a spurious exit 141.)
  TRACKED="$(git -C "$COPY" ls-files | sed -n '1p')"
  [ -n "$TRACKED" ] || die "the clone tracks no files"
  printf '\n' >> "$COPY/$TRACKED"
  if assert_clean_tree "$COPY" 2>/dev/null; then
    fail "the assertion did NOT fire on a modified tracked file ($TRACKED) — the gate is vacuous; do not trust a green run"
  fi
  pass "(a) the assertion FIRED on a modified tracked file: $TRACKED"
  git -C "$COPY" checkout -q -- "$TRACKED"

  # (b) An untracked file in a new directory, with showUntrackedFiles=no.
  mkdir -p "$COPY/verify-control-untracked"
  printf 'artefact\n' > "$COPY/verify-control-untracked/artefact.txt"
  if assert_clean_tree "$COPY" 2>/dev/null; then
    fail "the assertion did NOT fire on an untracked file under status.showUntrackedFiles=no — a stray artefact would pass the gate"
  fi
  pass "(b) the assertion FIRED on an untracked file (status.showUntrackedFiles=no in the clone)"
  rm -rf "$COPY/verify-control-untracked"
  assert_clean_tree "$COPY" 2>/dev/null || fail "the control could not restore the clone to clean"

  CHILD_LOG="$CONTROL_DIR/child.log"
  run_child() {
    set +e
    env -u VERIFY_CONTROL_TREE NO_COLOR=1 "$@" \
      bash "$COPY/scripts/verify-clean-checkout.sh" --skip-tests --offline --no-corepack \
      >"$CHILD_LOG" 2>&1
    child_rc=$?
    set -e
  }
  show_child() { sed 's/^/    | /' "$CHILD_LOG" >&2; }

  # (c) This script, end to end, on a tree that is dirty before it starts:
  # the precondition must refuse it with exit 2. The hook is set here too, so
  # a broken precondition costs a second, not an install and a build in the
  # clone: past the precondition the hook run can only end in exit 1 (or 0).
  printf '\n' >> "$COPY/$TRACKED"
  run_child VERIFY_CONTROL_TREE="$COPY"
  if [ "$child_rc" -ne 2 ]; then
    show_child
    fail "(c) the script exited $child_rc on a pre-dirtied clone; the precondition must refuse it with exit 2"
  fi
  pass "(c) the script exited 2 on a pre-dirtied clone (the precondition refused it)"
  git -C "$COPY" checkout -q -- "$TRACKED"

  # (d) This script, end to end, on a clean clone, with a stage that leaves an
  # artefact behind (the VERIFY_CONTROL_TREE hook): stage 7 must fail the run
  # with exit 1 and name the artefact. Delete stage 7, or append `|| true` to
  # it, and this run ends in VERIFIED, exit 0 — and the control fails.
  run_child VERIFY_CONTROL_TREE="$COPY"
  if [ "$child_rc" -ne 1 ] \
     || ! grep -qF '[clean-tree assertion]' "$CHILD_LOG" \
     || ! grep -qF '?? verify-control-artefact.txt' "$CHILD_LOG"; then
    show_child
    fail "(d) the script exited $child_rc on a tree a stage dirtied; stage 7 must fail it with exit 1 and name the artefact — the gate is vacuous; do not trust a green run"
  fi
  pass "(d) the script exited 1 on a tree a stage dirtied (stage 7 named the artefact)"
  printf '\n  the gate is not vacuous\n'
  exit 0
fi

# ----------------------------------------------------------------------------
# --prove-failure's hook (see the header). Refused unless it names THIS tree.
# ----------------------------------------------------------------------------
CONTROL_HOOK=0
if [ -n "${VERIFY_CONTROL_TREE:-}" ]; then
  [ -d "$VERIFY_CONTROL_TREE" ] && [ "$(cd -- "$VERIFY_CONTROL_TREE" && pwd -P)" = "$(pwd -P)" ] \
    || die "VERIFY_CONTROL_TREE is --prove-failure's own hook and names another tree; unset it"
  CONTROL_HOOK=1
fi

# ----------------------------------------------------------------------------
# Precondition: a clean checkout to verify. A tree that is already dirty would
# fail stage 7 for reasons that have nothing to do with the build, after
# fifteen minutes; say so now instead.
# ----------------------------------------------------------------------------
step "Precondition: the tree is clean before the run"
if ! assert_clean_tree "$REPO_ROOT" 2>/dev/null; then
  tree_status "$REPO_ROOT" | sed 's/^/    /' >&2
  die "the work tree is already dirty (above). Commit or stash first — this script verifies a checkout, and these paths are not the build's doing"
fi
pass "git status --short --untracked-files=all is empty at $(git rev-parse --short HEAD)"

if [ "$CONTROL_HOOK" = "1" ]; then
  step "CONTROL HOOK (--prove-failure): stages 0 and 2-6 skipped; this run cannot verify anything"
fi

# ----------------------------------------------------------------------------
# 0. the pinned package manager
# ----------------------------------------------------------------------------
if [ "$CONTROL_HOOK" = "0" ]; then
  step "0. Package manager — the pin in package.json"
  PIN="$(node -p "require('./package.json').packageManager")"
  case "$PIN" in
    pnpm@*) ;;
    *) die "package.json#packageManager is '$PIN', not a pnpm pin" ;;
  esac
  PINNED_VERSION="${PIN#pnpm@}"
  if [ "$USE_COREPACK" = "1" ]; then
    command -v corepack >/dev/null 2>&1 || die "corepack is not on PATH (ships with Node >= 16.9); pass --no-corepack if the pinned pnpm is already installed"
    corepack enable
    corepack prepare --activate
  fi
  ACTUAL_VERSION="$(pnpm --version)"
  [ "$ACTUAL_VERSION" = "$PINNED_VERSION" ] \
    || die "pnpm on PATH is $ACTUAL_VERSION, package.json pins $PINNED_VERSION — a mismatched pnpm resolves a different tree from the same lockfile"
  pass "pnpm $ACTUAL_VERSION == $PIN"
fi

# ----------------------------------------------------------------------------
# 1. CI's B9c pre-flight — static, so before anything is installed
# ----------------------------------------------------------------------------
step "1. UI affordance census (scripts/preflight-ui-affordances.mjs, CI's B9c pre-flight)"
node scripts/preflight-ui-affordances.mjs
pass "every DELETE route the gateway serves is reachable from a view, or listed with a reason"

if [ "$CONTROL_HOOK" = "0" ]; then
  # --------------------------------------------------------------------------
  # 2. install EXACTLY the locked tree
  # --------------------------------------------------------------------------
  step "2. pnpm install --frozen-lockfile$([ "$OFFLINE" = "1" ] && printf ' --offline' || true)"
  if [ "$OFFLINE" = "1" ]; then
    pnpm install --frozen-lockfile --offline
  else
    pnpm install --frozen-lockfile
  fi
  pass "installed from the lockfile without rewriting it"

  # --------------------------------------------------------------------------
  # 3. build every workspace
  # --------------------------------------------------------------------------
  step "3. pnpm -r build"
  pnpm -r build
  pass "every workspace built"

  # --------------------------------------------------------------------------
  # 4. typecheck against source
  # --------------------------------------------------------------------------
  step "4. pnpm -r exec tsc --noEmit"
  pnpm -r exec tsc --noEmit
  pass "every workspace typechecks against source"

  # --------------------------------------------------------------------------
  # 5 + 6. tests on a disposable database, then the pre-flight on what they left
  # --------------------------------------------------------------------------
  if [ "$SKIP_TESTS" = "1" ]; then
    step "5-6. Tests and the database pre-flight SKIPPED (--skip-tests)"
    printf '  the exit code of this run says nothing about the suite\n'
  else
    step "5. pnpm -r test on a database created for this run ($VERIFY_DB)"
    case "$VERIFY_DB" in
      [a-z]*) ;;
      *) die "VERIFY_DB '$VERIFY_DB' is not a plain lowercase identifier" ;;
    esac
    case "$VERIFY_DB" in
      *[!a-z0-9_]*) die "VERIFY_DB '$VERIFY_DB' is not a plain lowercase identifier" ;;
    esac
    command -v psql >/dev/null 2>&1 || die "psql is not on PATH; stage 5 needs a reachable Postgres 16 (VERIFY_PG=$VERIFY_PG)"
    # FORCE: a connection left open by a crashed earlier run must not block the
    # drop; the database is disposable by definition.
    psql -v ON_ERROR_STOP=1 -q "$VERIFY_PG/postgres" \
      -c "DROP DATABASE IF EXISTS $VERIFY_DB WITH (FORCE)" \
      -c "CREATE DATABASE $VERIFY_DB"
    export DATABASE_URL="$VERIFY_PG/$VERIFY_DB"
    # 64-hex fixture key, the shape secrets.ts asserts. Not a secret.
    export REGULAIT_DATA_KEY=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
    # The suite asserts the NO-credential posture (409 no_model_credential) and
    # the env-key fallback engages on these; a developer's shell must not be
    # able to turn a verification run into a live-provider run.
    unset ANTHROPIC_API_KEY OPENAI_API_KEY GOOGLE_API_KEY GEMINI_API_KEY XAI_API_KEY
    pnpm -r test
    pass "pnpm -r test exit 0 (read the exit code, not the 'N passed' line — ADR-0106)"

    step "6. Pre-flight the unique constraints on the populated database (ADR-0109/0110)"
    node scripts/preflight-unique-constraints.mjs "$DATABASE_URL"
    pass "no duplicate group would block migration 0108/0109"

    psql -v ON_ERROR_STOP=1 -q "$VERIFY_PG/postgres" -c "DROP DATABASE IF EXISTS $VERIFY_DB WITH (FORCE)"
    printf '  dropped %s\n' "$VERIFY_DB"
  fi
else
  # What a careless build or test does: leave an artefact outside .gitignore.
  printf 'left behind by the control hook\n' > "$REPO_ROOT/verify-control-artefact.txt"
  printf '  control hook: wrote verify-control-artefact.txt (untracked)\n'
fi

# ----------------------------------------------------------------------------
# 7. the tree must be exactly as found
# ----------------------------------------------------------------------------
step "7. git status --short --untracked-files=all must be empty"
assert_clean_tree "$REPO_ROOT" || fail "verification left the work tree dirty (paths above)"
pass "work tree unchanged at $(git rev-parse --short HEAD)"

printf '\n%sVERIFIED%s — clean checkout at %s%s\n' "$C_GRN" "$C_RST" "$(git rev-parse --short HEAD)" \
  "$([ "$SKIP_TESTS" = "1" ] && printf ' (tests skipped)' || true)"
