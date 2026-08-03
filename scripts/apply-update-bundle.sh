#!/usr/bin/env bash
# =============================================================================
# RegulAIt update-bundle APPLIER (ADR-0041)
#
# Verify → stage → swap → re-converge. The ONLY entry point that should ever
# put bundle content into an install directory.
#
#   scripts/apply-update-bundle.sh regulait-update-0.2.0.tar.gz
#   scripts/apply-update-bundle.sh bundle.tar.gz --install-dir /opt/regulait \
#          --image-bundle /media/usb/regulait-images-0.2.0.tar
#
# WHAT IT DOES NOT DO, ON PURPOSE
#
#  * It does not verify-and-apply in one pass over the same extracted tree
#    twice. Verification happens in a throwaway directory; only after every
#    check passes is the payload written anywhere near the install directory.
#
#  * It does not touch the database. Migrations run on gateway boot and are
#    idempotent (apps/gateway/src/main.ts). What this script insists on is that
#    you have a CURRENT BACKUP FIRST, because migrations are the one part of an
#    update that a file-level rollback cannot undo.
#
#  * It does not delete anything. The previous tree is moved aside to
#    <install-dir>.prev-<version>, not removed, so a failed start is a `mv`
#    away from the state you had five minutes ago.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"

die()  { printf '\n[FATAL] %s\n\n' "$*" >&2; exit 1; }
info() { printf '  %s\n' "$*"; }
step() { printf '\n==> %s\n' "$*"; }
ok()   { printf '  [ok]   %s\n' "$*"; }

BUNDLE=""
INSTALL_DIR="$REPO_ROOT"
KEYRING=""
IMAGE_BUNDLE=""
ASSUME_YES=0

usage() {
  cat <<'USAGE'
Usage: scripts/apply-update-bundle.sh <bundle.tar.gz> [options]

  --install-dir <dir>    Deployment root to update. Default: this repo root.
  --keyring <dir>        Pinned public keys. Default: <install-dir>/infra/release-keys
  --image-bundle <tar>   Air-gapped: `docker load` these images before restart.
  --yes, -y              Do not prompt.
  -h, --help
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --install-dir)  INSTALL_DIR="${2:-}"; shift 2 ;;
    --keyring)      KEYRING="${2:-}"; shift 2 ;;
    --image-bundle) IMAGE_BUNDLE="${2:-}"; shift 2 ;;
    --yes|-y)       ASSUME_YES=1; shift ;;
    -h|--help)      usage; exit 0 ;;
    -*)             usage >&2; die "unknown option: $1" ;;
    *)              BUNDLE="$1"; shift ;;
  esac
done

[ -n "$BUNDLE" ] || { usage >&2; exit 2; }
[ -d "$INSTALL_DIR" ] || die "install dir not found: $INSTALL_DIR"
INSTALL_DIR="$(cd -- "$INSTALL_DIR" && pwd)"
KEYRING="${KEYRING:-$INSTALL_DIR/infra/release-keys}"
[ -f "$INSTALL_DIR/.env" ] || die "$INSTALL_DIR/.env not found — this does not look like an installed deployment. Run scripts/install.sh first."

step "Verifying the bundle (offline, against the pinned keyring)"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
"$SCRIPT_DIR/verify-update-bundle.sh" "$BUNDLE" \
  --keyring "$KEYRING" \
  --install-dir "$INSTALL_DIR" \
  --extract-to "$STAGE/payload" \
  || die "the bundle did not verify — nothing was changed. See the refusal above."

NEW_VERSION="$(grep -m1 -oE '"version"[[:space:]]*:[[:space:]]*"[^"]*"' "$STAGE/payload/package.json" 2>/dev/null | sed -E 's/.*"([^"]*)"$/\1/' || true)"
OLD_VERSION="$(tr -d ' \n' <"$INSTALL_DIR/.regulait-version" 2>/dev/null || echo unknown)"

step "Pre-flight: backup"
cat <<'WARN'
  Migrations run on gateway boot and are idempotent, but they are FORWARD-only.
  A file-level rollback of this update will NOT un-migrate the database. Take a
  verified dump BEFORE continuing:

      infra/scripts/pg-backup.sh          # ADR-0035, verifies before uploading
      # or, minimally:
      docker compose -p regulait exec -T db pg_dump -U regulait -Fc regulait > pre-update.dump

WARN
if [ "$ASSUME_YES" != "1" ] && [ -t 0 ]; then
  ans=""
  read -r -p "  Type 'backed up' to continue: " ans || die "aborted"
  [ "$ans" = "backed up" ] || die "aborted — nothing was changed"
fi

step "Staging the verified payload into $INSTALL_DIR"
PREV="$INSTALL_DIR.prev-$OLD_VERSION"
rm -rf "$PREV"
# Copy rather than move: .env, .regulait-version and the docker volumes must
# survive, and the payload deliberately does not contain them.
cp -a "$INSTALL_DIR" "$PREV"
ok "previous tree preserved at $PREV"

(cd "$STAGE/payload" && tar -cf - .) | (cd "$INSTALL_DIR" && tar -xf -)
ok "payload applied"

if [ -n "$IMAGE_BUNDLE" ]; then
  step "Loading pre-seeded images (air-gapped path)"
  [ -f "$IMAGE_BUNDLE" ] || die "--image-bundle not found: $IMAGE_BUNDLE"
  docker load -i "$IMAGE_BUNDLE"
  ok "images loaded"
fi

step "Re-converging the stack"
info "install.sh reads the existing .env, preserves every secret in it, and brings the stack back up."
"$INSTALL_DIR/scripts/install.sh" --dir "$INSTALL_DIR" --yes \
  ${NEW_VERSION:+--version "$NEW_VERSION"}

cat <<DONE

  Updated: $OLD_VERSION -> ${NEW_VERSION:-<unknown>}
  Rollback (files only — the database is NOT rolled back):
      docker compose -p regulait down
      rm -rf "$INSTALL_DIR" && mv "$PREV" "$INSTALL_DIR"
      "$INSTALL_DIR/scripts/install.sh" --dir "$INSTALL_DIR" --yes
  If the update ran a migration, restore the dump you took above as well.

DONE
