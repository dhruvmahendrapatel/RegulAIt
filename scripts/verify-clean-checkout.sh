#!/usr/bin/env bash
# =============================================================================
# RegulAIt clean-checkout VERIFIER (AER-003 / R2)
#
# ONE command for the sequence README.md's "Verifying a clean checkout" section
# spells out by hand, with the two things a hand-run sequence cannot give:
#
#   * it ASSERTS the result. After the last stage `git status --short` must be
#     empty — a build or test that writes into the tree (a rewritten lockfile,
#     a regenerated fixture, a stray artefact) is a FAILURE, exit 1, with the
#     offending paths printed. The sequence verifies a checkout; it must never
#     be the thing that changes what it is verifying.
#   * it can PROVE its own assertion is not vacuous. `--prove-failure` clones
#     HEAD into a temporary directory, modifies one tracked file there, runs
#     the same assertion against that copy and requires it to FIRE. A gate that
#     has never been seen to fail is a gate nobody can trust (M-033).
#
# The stages, in order (each one aborts the run on a non-zero exit):
#
#   0. the pinned package manager — `packageManager` in package.json via
#      corepack, then `pnpm --version` is checked against the pin regardless
#      of how pnpm got onto PATH (a mismatched pnpm resolves a different tree
#      from the same lockfile; see README).
#   1. `pnpm install --frozen-lockfile`   never rewrites pnpm-lock.yaml
#   2. `pnpm -r build`                    every workspace, SPA included
#   3. `pnpm -r exec tsc --noEmit`        against SOURCE, not a stale dist/
#   4. `pnpm -r test`                     on a database CREATED for this run
#   5. `scripts/preflight-unique-constraints.mjs` on the database step 4 just
#      migrated AND populated (ADR-0110: on an empty database it is trivially
#      zero), then that database is dropped
#   6. `git status --short` must be empty
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
#   scripts/verify-clean-checkout.sh                   the full sequence (0-6)
#   scripts/verify-clean-checkout.sh --skip-tests      stages 0-3 and 6; no database needed
#   scripts/verify-clean-checkout.sh --prove-failure   the control: the clean-tree assertion
#                                                      must fire on a dirtied temporary copy
#   scripts/verify-clean-checkout.sh --offline         `pnpm install --offline` (store only)
#   scripts/verify-clean-checkout.sh --no-corepack     skip `corepack enable/prepare`; the
#                                                      pnpm on PATH must still match the pin
#
# Environment (stage 4/5 only):
#   VERIFY_PG   base URL without a database   default postgres://regulait:regulait@localhost:5432
#   VERIFY_DB   the disposable database name  default regulait_verify
#
# Exit codes: 0 verified (or, under --prove-failure, the assertion fired as it
# must). 1 a stage failed, the tree was left dirty, or the control did NOT
# fire. 2 usage or precondition error (not inside a git work tree, tree
# already dirty before the run, pnpm does not match the pin).
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
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

  --skip-tests      Run stages 0-3 and the clean-tree assertion; no database.
  --prove-failure   Control mode: dirty a tracked file in a temporary clone and
                    require the clean-tree assertion to fire there.
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
# Exit 0 when `git status --short` is empty; 1 otherwise, with the paths.
# ----------------------------------------------------------------------------
assert_clean_tree() {
  local tree="$1" dirty
  dirty="$(git -C "$tree" status --short)"
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
  step "Control: the clean-tree assertion must fire on a dirtied temporary copy"
  CONTROL_DIR="$(mktemp -d)"
  trap 'rm -rf "$CONTROL_DIR"' EXIT
  # A local clone of HEAD — committed content only, nothing of this tree's
  # uncommitted state, and nothing here can touch the real checkout.
  # `--shared` borrows the object store instead of copying it: the copy lives
  # for seconds and git never rewrites an existing object file in place.
  git clone -q --shared "$REPO_ROOT" "$CONTROL_DIR/copy"
  COPY="$CONTROL_DIR/copy"
  if ! assert_clean_tree "$COPY" 2>/dev/null; then
    fail "the fresh clone is not clean before the control touched anything — the control cannot be read"
  fi
  pass "fresh clone is clean (git status --short empty)"
  # Append one byte to a tracked file: the smallest change git must report.
  # (`sed -n 1p`, not `head -1`: under pipefail, head closing the pipe early
  # hands git a SIGPIPE and this script a spurious exit 141.)
  TRACKED="$(git -C "$COPY" ls-files | sed -n '1p')"
  [ -n "$TRACKED" ] || die "the clone tracks no files"
  printf '\n' >> "$COPY/$TRACKED"
  printf '  touched tracked file: %s\n' "$TRACKED"
  set +e
  assert_clean_tree "$COPY"
  rc=$?
  set -e
  if [ "$rc" -ne 0 ]; then
    pass "the assertion FIRED (exit $rc) — the gate is not vacuous"
    exit 0
  fi
  fail "the assertion did NOT fire on a dirtied tree — the gate is vacuous; do not trust a green run"
fi

# ----------------------------------------------------------------------------
# Precondition: a clean checkout to verify. A tree that is already dirty would
# fail stage 6 for reasons that have nothing to do with the build, after
# fifteen minutes; say so now instead.
# ----------------------------------------------------------------------------
step "Precondition: the tree is clean before the run"
if ! assert_clean_tree "$REPO_ROOT" 2>/dev/null; then
  git status --short | sed 's/^/    /' >&2
  die "the work tree is already dirty (above). Commit or stash first — this script verifies a checkout, and these paths are not the build's doing"
fi
pass "git status --short is empty at $(git rev-parse --short HEAD)"

# ----------------------------------------------------------------------------
# 0. the pinned package manager
# ----------------------------------------------------------------------------
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

# ----------------------------------------------------------------------------
# 1. install EXACTLY the locked tree
# ----------------------------------------------------------------------------
step "1. pnpm install --frozen-lockfile${OFFLINE:+ --offline}"
if [ "$OFFLINE" = "1" ]; then
  pnpm install --frozen-lockfile --offline
else
  pnpm install --frozen-lockfile
fi
pass "installed from the lockfile without rewriting it"

# ----------------------------------------------------------------------------
# 2. build every workspace
# ----------------------------------------------------------------------------
step "2. pnpm -r build"
pnpm -r build
pass "every workspace built"

# ----------------------------------------------------------------------------
# 3. typecheck against source
# ----------------------------------------------------------------------------
step "3. pnpm -r exec tsc --noEmit"
pnpm -r exec tsc --noEmit
pass "every workspace typechecks against source"

# ----------------------------------------------------------------------------
# 4 + 5. tests on a disposable database, then the pre-flight on what they left
# ----------------------------------------------------------------------------
if [ "$SKIP_TESTS" = "1" ]; then
  step "4-5. Tests and pre-flight SKIPPED (--skip-tests)"
  printf '  the exit code of this run says nothing about the suite\n'
else
  step "4. pnpm -r test on a database created for this run ($VERIFY_DB)"
  case "$VERIFY_DB" in
    [a-z]*) ;;
    *) die "VERIFY_DB '$VERIFY_DB' is not a plain lowercase identifier" ;;
  esac
  case "$VERIFY_DB" in
    *[!a-z0-9_]*) die "VERIFY_DB '$VERIFY_DB' is not a plain lowercase identifier" ;;
  esac
  command -v psql >/dev/null 2>&1 || die "psql is not on PATH; stage 4 needs a reachable Postgres 16 (VERIFY_PG=$VERIFY_PG)"
  # FORCE: a connection left open by a crashed earlier run must not block the
  # drop; the database is disposable by definition.
  psql -v ON_ERROR_STOP=1 -q "$VERIFY_PG/postgres" \
    -c "DROP DATABASE IF EXISTS $VERIFY_DB WITH (FORCE)" \
    -c "CREATE DATABASE $VERIFY_DB"
  export DATABASE_URL="$VERIFY_PG/$VERIFY_DB"
  # 64-hex fixture key, the shape secrets.ts asserts. Not a secret.
  export REGULAIT_DATA_KEY=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
  # The suite asserts the NO-credential posture (409 no_model_credential) and
  # the env-key fallback engages on these; a developer's shell must not be able
  # to turn a verification run into a live-provider run.
  unset ANTHROPIC_API_KEY OPENAI_API_KEY GOOGLE_API_KEY GEMINI_API_KEY XAI_API_KEY
  pnpm -r test
  pass "pnpm -r test exit 0 (read the exit code, not the 'N passed' line — ADR-0106)"

  step "5. Pre-flight the unique constraints on the populated database (ADR-0109/0110)"
  node scripts/preflight-unique-constraints.mjs "$DATABASE_URL"
  pass "no duplicate group would block migration 0108/0109"

  psql -v ON_ERROR_STOP=1 -q "$VERIFY_PG/postgres" -c "DROP DATABASE IF EXISTS $VERIFY_DB WITH (FORCE)"
  printf '  dropped %s\n' "$VERIFY_DB"
fi

# ----------------------------------------------------------------------------
# 6. the tree must be exactly as found
# ----------------------------------------------------------------------------
step "6. git status --short must be empty"
assert_clean_tree "$REPO_ROOT" || fail "verification left the work tree dirty (paths above)"
pass "work tree unchanged at $(git rev-parse --short HEAD)"

printf '\n%sVERIFIED%s — clean checkout at %s%s\n' "$C_GRN" "$C_RST" "$(git rev-parse --short HEAD)" \
  "$([ "$SKIP_TESTS" = "1" ] && printf ' (tests skipped)' || true)"
