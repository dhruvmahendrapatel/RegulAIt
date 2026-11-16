#!/usr/bin/env bash
# =============================================================================
# Add SLSA v1 build provenance to an UNSIGNED release candidate (ADR-0324)
#
# Run by .github/workflows/release.yml on a release tag (and by the ceremony
# dry run). Writes provenance.intoto.json at the bundle root: an in-toto v1
# statement whose single subject is the candidate's manifest.json, saying
# which repository, workflow, tag and commit built it. The release signer
# later signs it with the release signing key, offline; the CI may also
# attest it keylessly with Sigstore (provenance.sigstore.json).
#
# This script signs nothing and holds no key. Provenance from CI is a CLAIM
# by CI; the LiteLLM 2026-10-21 release shows a compromised pipeline can make
# any claim it likes, which is why a human checks it before signing
# (docs/ops/RELEASE_KEY_CEREMONY.md, part 5).
#
# Usage:
#   scripts/release-provenance.sh --candidate dist/regulait-update-1.0.0.unsigned.tar.gz \
#     --repository https://github.com/OWNER/REPO --workflow .github/workflows/release.yml \
#     --ref refs/tags/v1.0.0 --commit <40-hex> --invocation <run URL> [--started <RFC3339>]
# =============================================================================
set -euo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/release-trust.sh
. "$SCRIPT_DIR/lib/release-trust.sh"

die() { printf '\n[FATAL] %s\n\n' "$*" >&2; exit 1; }
CANDIDATE=""
pv_reset
while [ $# -gt 0 ]; do
  case "$1" in
    --candidate)  CANDIDATE="${2:-}"; shift 2 ;;
    --repository) PV_REPO="${2:-}"; shift 2 ;;
    --workflow)   PV_PATH="${2:-}"; shift 2 ;;
    --ref)        PV_REF="${2:-}"; shift 2 ;;
    --commit)     PV_COMMIT="${2:-}"; shift 2 ;;
    --invocation) PV_INVOCATION="${2:-}"; shift 2 ;;
    --started)    PV_STARTED="${2:-}"; shift 2 ;;
    -h|--help)    sed -n '2,22p' "$0"; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
done
[ -f "$CANDIDATE" ] || die "--candidate <unsigned bundle> is required"
PV_STARTED="${PV_STARTED:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"
PV_BUILDER="$PV_REPO/$PV_PATH"

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
tar -xzf "$CANDIDATE" -C "$STAGE" || die "not a readable gzip tarball: $CANDIDATE"
mapfile -t tops < <(find "$STAGE" -mindepth 1 -maxdepth 1)
[ "${#tops[@]}" -eq 1 ] && [ -d "${tops[0]}" ] || die "the candidate must hold exactly one top-level directory"
ROOT="${tops[0]}"
[ -f "$ROOT/manifest.json" ] || die "the candidate has no manifest.json"
[ ! -e "$ROOT/manifest.json.sig" ] || die "the candidate is already signed; provenance is added before signing"
[ ! -e "$ROOT/provenance.intoto.json" ] || die "the candidate already has provenance"

PV_SUBJECT="$(kr_sha256_file "$ROOT/manifest.json")"
pv_check || die "provenance input: $PV_ERR"
pv_render >"$ROOT/provenance.intoto.json"
pv_parse "$ROOT/provenance.intoto.json" || die "self-check failed: $PV_ERR"

tmp="$CANDIDATE.tmp.$$"
tar -C "$STAGE" -czf "$tmp" "$(basename "$ROOT")"
mv -f "$tmp" "$CANDIDATE"
printf '  [ok]   provenance added: subject manifest.json sha256:%s, %s at %s (%s)\n' \
  "$PV_SUBJECT" "$PV_BUILDER" "$PV_REF" "$PV_COMMIT"
