#!/usr/bin/env bash
# =============================================================================
# RegulAIt update-bundle BUILDER (ADR-0041)
#
# Produces a signed, offline-verifiable update artifact:
#
#   regulait-update-<version>.tar.gz
#     └── regulait-update-<version>/
#           manifest.json        the inventory: version, key id, per-file SHA-256
#           manifest.json.sig    detached Ed25519 signature over manifest.json
#           payload/…            the files themselves
#
# WHY THIS SHAPE
#
#  * SIGN THE MANIFEST, NOT THE TARBALL. A signature over the tarball proves
#    the archive arrived intact and nothing else — you still have to trust the
#    extractor. Signing a manifest that names every file with its digest means
#    the verifier can decide file-by-file, and can also detect a file that was
#    ADDED (present in payload, absent from the manifest), which a whole-archive
#    hash cannot express as anything more useful than "different".
#
#  * NO INVENTED CRYPTO. Ed25519 via `openssl pkeyutl -sign -rawin`. Ed25519
#    hashes internally, so there is no digest-choice footgun and no
#    PSS/PKCS#1-v1.5 decision to get wrong. RSA-PSS would also have been fine;
#    Ed25519 is smaller and has one way to use it.
#
#  * THE PRIVATE KEY IS NEVER IN THIS REPOSITORY, and this script never writes
#    it anywhere. See infra/release-keys/README.md for custody.
#
# Usage:
#   scripts/build-update-bundle.sh --version 0.2.0 --key ~/offline/regulait-release.pem
#   scripts/build-update-bundle.sh --version 0.2.0 --key k.pem --key-id regulait-release-2026
#
# Generating a signing keypair (do this on an offline host, once):
#   openssl genpkey -algorithm ed25519 -out regulait-release.pem
#   openssl pkey -in regulait-release.pem -pubout -out regulait-release.pub
# The .pub goes in infra/release-keys/ and ships with every deployment.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"

die() { printf '\n[FATAL] %s\n\n' "$*" >&2; exit 1; }
info() { printf '  %s\n' "$*"; }
ok()   { printf '  [ok]   %s\n' "$*"; }

VERSION=""
KEY=""
KEY_ID=""
OUT=""
SOURCE="$REPO_ROOT"
MIN_INSTALLED="0.0.0"
INCLUDES=()

usage() {
  cat <<'USAGE'
Usage: scripts/build-update-bundle.sh --version <v> --key <private.pem> [options]

  --version <v>            Bundle version. Verifiers refuse a bundle older than
                           the installed version, so this is load-bearing.
  --key <path>             Ed25519 (or RSA) PRIVATE key, PEM. Never committed.
  --key-id <id>            Key identifier recorded in the manifest and matched
                           against infra/release-keys/<id>.pub at verify time.
                           Default: the key filename without its extension.
  --out <path>             Output tarball. Default:
                           dist/regulait-update-<version>.tar.gz
  --source <dir>           Tree to bundle from. Default: the repo root.
  --min-installed <v>      Refuse to apply onto anything older than this
                           (recorded in the manifest; enforced by the verifier).
  --include <relpath>      Add a path (file or directory). Repeatable. If given
                           at all, it REPLACES the default deployment set.
  -h, --help
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --version)       VERSION="${2:-}"; shift 2 ;;
    --key)           KEY="${2:-}"; shift 2 ;;
    --key-id)        KEY_ID="${2:-}"; shift 2 ;;
    --out)           OUT="${2:-}"; shift 2 ;;
    --source)        SOURCE="${2:-}"; shift 2 ;;
    --min-installed) MIN_INSTALLED="${2:-}"; shift 2 ;;
    --include)       INCLUDES+=("${2:-}"); shift 2 ;;
    -h|--help)       usage; exit 0 ;;
    *) usage >&2; die "unknown option: $1" ;;
  esac
done

[ -n "$VERSION" ] || { usage >&2; die "--version is required"; }
[ -n "$KEY" ] || { usage >&2; die "--key is required — an unsigned bundle is not a bundle, it is a tarball"; }
[ -f "$KEY" ] || die "private key not found: $KEY"
command -v openssl >/dev/null 2>&1 || die "openssl is required"

[ -n "$KEY_ID" ] || { KEY_ID="$(basename "$KEY")"; KEY_ID="${KEY_ID%.*}"; }
OUT="${OUT:-$REPO_ROOT/dist/regulait-update-$VERSION.tar.gz}"
SOURCE="$(cd -- "$SOURCE" && pwd)"

# The default deployment set: what a customer's box actually needs in order to
# rebuild and run the stack. Deliberately NOT "everything" — .git, node_modules,
# dist/ and Terraform state are either enormous, machine-specific, or secret.
if [ "${#INCLUDES[@]}" -eq 0 ]; then
  INCLUDES=(
    docker-compose.yml
    compose.tls-local.yml
    Dockerfile
    package.json
    pnpm-lock.yaml
    pnpm-workspace.yaml
    tsconfig.base.json
    apps
    packages
    infra/caddy
    infra/scripts
    infra/release-keys
    scripts
    docs/deployment
  )
fi

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    openssl dgst -sha256 "$1" | awk '{print $NF}'
  fi
}

json_escape() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
BUNDLE_DIR="$STAGE/regulait-update-$VERSION"
PAYLOAD="$BUNDLE_DIR/payload"
mkdir -p "$PAYLOAD"

printf '==> Staging payload from %s\n' "$SOURCE"
for rel in "${INCLUDES[@]}"; do
  src="$SOURCE/$rel"
  if [ ! -e "$src" ]; then
    info "skip (absent): $rel"
    continue
  fi
  mkdir -p "$PAYLOAD/$(dirname "$rel")"
  if [ -d "$src" ]; then
    # Prune the things that must never ship: build output, dependency trees,
    # Terraform state/plans, private keys of any kind, and rendered .env files.
    (cd "$SOURCE" && find "$rel" \
        \( -name node_modules -o -name dist -o -name .terraform -o -name .git \) -prune -o \
        -type f \
        ! -name '*.tsbuildinfo' ! -name 'tfplan*' ! -name '*.tfstate*' \
        ! -name '*.pem' ! -name '*.key' ! -name '.env' ! -name '.env.*' \
        -print) \
      | LC_ALL=C sort \
      | while IFS= read -r f; do
          mkdir -p "$PAYLOAD/$(dirname "$f")"
          cp -p "$SOURCE/$f" "$PAYLOAD/$f"
        done
  else
    cp -p "$src" "$PAYLOAD/$rel"
  fi
done

printf '==> Building manifest\n'
FILE_LIST="$(cd "$PAYLOAD" && find . -type f -print | sed 's|^\./||' | LC_ALL=C sort)"
[ -n "$FILE_LIST" ] || die "payload is empty — nothing to sign"

MANIFEST="$BUNDLE_DIR/manifest.json"
{
  printf '{\n'
  printf '  "schema": "regulait.update-bundle/1",\n'
  printf '  "product": "regulait",\n'
  printf '  "version": "%s",\n' "$(json_escape "$VERSION")"
  printf '  "minInstalledVersion": "%s",\n' "$(json_escape "$MIN_INSTALLED")"
  printf '  "signingKeyId": "%s",\n' "$(json_escape "$KEY_ID")"
  printf '  "createdAt": "%s",\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf '  "files": [\n'
  first=1
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    digest="$(sha256_of "$PAYLOAD/$f")"
    bytes="$(wc -c <"$PAYLOAD/$f" | tr -d ' ')"
    if [ "$first" = "1" ]; then first=0; else printf ',\n'; fi
    printf '    { "path": "%s", "sha256": "%s", "bytes": %s }' \
      "$(json_escape "$f")" "$digest" "$bytes"
  done <<<"$FILE_LIST"
  printf '\n  ]\n}\n'
} >"$MANIFEST"

COUNT="$(printf '%s\n' "$FILE_LIST" | wc -l | tr -d ' ')"
ok "manifest lists $COUNT files"

printf '==> Signing manifest with %s (key id: %s)\n' "$KEY" "$KEY_ID"
# Ed25519 signs the message directly (-rawin); for RSA/EC keys openssl falls
# back to a digest, so -rawin is attempted first and the digest form second.
if ! openssl pkeyutl -sign -inkey "$KEY" -rawin -in "$MANIFEST" -out "$MANIFEST.sig.bin" 2>/dev/null; then
  openssl dgst -sha256 -sign "$KEY" -out "$MANIFEST.sig.bin" "$MANIFEST" \
    || die "signing failed — is $KEY a private key?"
  info "key is not Ed25519; signed as SHA-256 digest (the verifier tries both forms)"
fi
openssl base64 -A -in "$MANIFEST.sig.bin" -out "$MANIFEST.sig"
rm -f "$MANIFEST.sig.bin"
ok "signature written ($(wc -c <"$MANIFEST.sig" | tr -d ' ') base64 bytes)"

mkdir -p "$(dirname "$OUT")"
tar -C "$STAGE" -czf "$OUT" "regulait-update-$VERSION"
ok "bundle: $OUT ($(du -h "$OUT" | cut -f1))"

cat <<NEXT

  Verify it the way a customer will (offline, against the pinned keyring):

    scripts/verify-update-bundle.sh $OUT

  Ship the bundle and NOT the private key. The public half must already be in
  the customer's infra/release-keys/ as $KEY_ID.pub — a key the deployment has
  never seen is refused, which is the point.

NEXT
