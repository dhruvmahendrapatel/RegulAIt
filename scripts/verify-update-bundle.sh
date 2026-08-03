#!/usr/bin/env bash
# =============================================================================
# RegulAIt update-bundle VERIFIER (ADR-0041)
#
# Runs on the CUSTOMER's deployment, offline, before anything is applied.
# Makes no network call of any kind — that is a requirement, not a side effect:
# an air-gapped deployment has no way to reach a revocation endpoint, a
# timestamp authority, or us.
#
# FAILS CLOSED. Every one of these is a refusal, not a warning:
#
#   * the manifest or its signature is missing
#   * the signing key id names a key this deployment has never been given
#   * the signature does not verify under that key
#   * any file listed in the manifest is missing from the payload
#   * any file's SHA-256 differs from the manifest
#   * the payload contains a file the manifest does not list
#   * the bundle version is OLDER than the installed version (downgrade)
#   * the bundle declares a minimum installed version this box is below
#
# There is deliberately no --force. A bundle that does not verify is not an
# update; re-obtaining it is the recovery path.
#
# Usage:
#   scripts/verify-update-bundle.sh regulait-update-0.2.0.tar.gz
#   scripts/verify-update-bundle.sh bundle.tar.gz --keyring /etc/regulait/keys \
#                                   --installed-version 0.1.0
#   scripts/verify-update-bundle.sh bundle.tar.gz --extract-to /opt/regulait-next
#
# Exit codes: 0 verified. 1 refused (reason printed). 2 usage error.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"

KEYRING="$REPO_ROOT/infra/release-keys"
INSTALLED_VERSION=""
INSTALL_DIR="$REPO_ROOT"
EXTRACT_TO=""
BUNDLE=""
QUIET=0

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  C_RED=$'\033[31m'; C_GRN=$'\033[32m'; C_BLD=$'\033[1m'; C_RST=$'\033[0m'
else
  C_RED=''; C_GRN=''; C_BLD=''; C_RST=''
fi

pass() { [ "$QUIET" = "1" ] || printf '  %s[pass]%s %s\n' "$C_GRN" "$C_RST" "$*"; }
note() { [ "$QUIET" = "1" ] || printf '  %s\n' "$*"; }
refuse() {
  printf '\n%s[REFUSED]%s %s\n' "$C_RED" "$C_RST" "$1" >&2
  shift
  for l in "$@"; do printf '           %s\n' "$l" >&2; done
  printf '\n' >&2
  exit 1
}

usage() {
  cat <<'USAGE'
Usage: scripts/verify-update-bundle.sh <bundle.tar.gz> [options]

  --keyring <dir>            Directory of pinned public keys (*.pub).
                             Default: infra/release-keys
  --installed-version <v>    Version currently installed. Default: read from
                             <install-dir>/.regulait-version.
  --install-dir <dir>        Where .regulait-version lives. Default: repo root.
  --extract-to <dir>         On success, extract the VERIFIED payload here.
                             Refused if the directory is non-empty.
  --quiet                    Only print on refusal.
  -h, --help
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --keyring)           KEYRING="${2:-}"; shift 2 ;;
    --installed-version) INSTALLED_VERSION="${2:-}"; shift 2 ;;
    --install-dir)       INSTALL_DIR="${2:-}"; shift 2 ;;
    --extract-to)        EXTRACT_TO="${2:-}"; shift 2 ;;
    --quiet)             QUIET=1; shift ;;
    -h|--help)           usage; exit 0 ;;
    -*)                  usage >&2; exit 2 ;;
    *)                   BUNDLE="$1"; shift ;;
  esac
done

[ -n "$BUNDLE" ] || { usage >&2; exit 2; }
[ -f "$BUNDLE" ] || refuse "bundle not found: $BUNDLE"
command -v openssl >/dev/null 2>&1 || refuse "openssl is not installed" \
  "Verification is the one step that cannot be skipped, so a missing verifier" \
  "is a refusal rather than a warning."

BUNDLE="$(cd -- "$(dirname -- "$BUNDLE")" && pwd)/$(basename -- "$BUNDLE")"

[ "$QUIET" = "1" ] || printf '\n%s==> Verifying %s%s\n' "$C_BLD" "$BUNDLE" "$C_RST"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# --- 1. extract -------------------------------------------------------------
# Extracted into a throwaway directory: NOTHING from an unverified bundle is
# allowed near the install directory until every check below has passed.
tar -xzf "$BUNDLE" -C "$WORK" 2>/dev/null \
  || refuse "the bundle is not a readable gzip tarball" \
            "Truncated download, or not a RegulAIt update bundle."

ROOT="$(find "$WORK" -mindepth 1 -maxdepth 1 -type d | head -1)"
[ -n "$ROOT" ] || refuse "the bundle has no top-level directory" \
  "Expected regulait-update-<version>/ containing manifest.json and payload/."

MANIFEST="$ROOT/manifest.json"
SIGFILE="$ROOT/manifest.json.sig"
PAYLOAD="$ROOT/payload"

[ -f "$MANIFEST" ] || refuse "manifest.json is missing" \
  "An update bundle without a manifest cannot be verified at all."
[ -f "$SIGFILE" ] || refuse "manifest.json.sig is missing" \
  "The signature is what makes this an update rather than a tarball someone" \
  "sent you. Stripping it is exactly the attack this check exists for."
[ -d "$PAYLOAD" ] || refuse "payload/ is missing"
pass "structure: manifest, signature and payload present"

# --- 2. manifest fields -----------------------------------------------------
# Field extraction is deliberately regex-over-JSON rather than a JSON parser:
# this must run on a bare air-gapped host with nothing but coreutils, and the
# manifest is written by scripts/build-update-bundle.sh in a fixed shape. The
# authority is the SIGNATURE over the exact bytes, not the parse.
jfield() { grep -m1 -oE "\"$1\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" "$MANIFEST" | sed -E 's/.*:[[:space:]]*"([^"]*)"/\1/'; }

SCHEMA="$(jfield schema || true)"
PRODUCT="$(jfield product || true)"
BUNDLE_VERSION="$(jfield version || true)"
KEY_ID="$(jfield signingKeyId || true)"
MIN_INSTALLED="$(jfield minInstalledVersion || true)"

[ "$SCHEMA" = "regulait.update-bundle/1" ] || refuse \
  "unknown manifest schema: '${SCHEMA:-<none>}'" \
  "This verifier understands regulait.update-bundle/1 only."
[ "$PRODUCT" = "regulait" ] || refuse "manifest is not a RegulAIt bundle (product='${PRODUCT:-<none>}')"
[ -n "$BUNDLE_VERSION" ] || refuse "manifest declares no version"
[ -n "$KEY_ID" ] || refuse "manifest declares no signingKeyId"
# The key id is used to build a filesystem path, so it is constrained before it
# is used — a signingKeyId of "../../etc/whatever" must not select a file.
printf '%s' "$KEY_ID" | grep -qE '^[A-Za-z0-9._-]+$' || refuse \
  "signingKeyId contains characters that are not permitted in a key id: '$KEY_ID'" \
  "Key ids name a file in the pinned keyring; only [A-Za-z0-9._-] is allowed."
pass "manifest: regulait $BUNDLE_VERSION, signed by key id '$KEY_ID'"

# --- 3. the key must be one this deployment already trusts -------------------
[ -d "$KEYRING" ] || refuse "keyring directory not found: $KEYRING" \
  "The pinned public key ships with the deployment. Without it there is" \
  "nothing to verify against, and an unverifiable bundle is refused."

PUBKEY="$KEYRING/$KEY_ID.pub"
if [ ! -f "$PUBKEY" ]; then
  known="$(find "$KEYRING" -maxdepth 1 -name '*.pub' -exec basename {} .pub \; 2>/dev/null | LC_ALL=C sort | tr '\n' ' ')"
  refuse "UNKNOWN SIGNING KEY: '$KEY_ID'" \
    "This deployment pins: ${known:-<none>}" \
    "A bundle signed by a key you were never given is refused even if the" \
    "signature is internally valid — that is what pinning means. If a key" \
    "rotation is genuinely in progress, the NEW public key must be delivered" \
    "and installed through the same channel as the old one, out of band."
fi
pass "signing key is pinned: $PUBKEY"

# --- 4. the signature ------------------------------------------------------
openssl base64 -d -A -in "$SIGFILE" -out "$WORK/sig.bin" 2>/dev/null \
  || refuse "the signature file is not valid base64"

SIG_OK=0
# Ed25519 signs the message itself (-rawin). RSA/EC bundles sign a SHA-256
# digest. Try both; either verifying under the PINNED key is acceptance.
if openssl pkeyutl -verify -pubin -inkey "$PUBKEY" -rawin \
     -in "$MANIFEST" -sigfile "$WORK/sig.bin" >/dev/null 2>&1; then
  SIG_OK=1
elif openssl dgst -sha256 -verify "$PUBKEY" -signature "$WORK/sig.bin" "$MANIFEST" >/dev/null 2>&1; then
  SIG_OK=1
fi
[ "$SIG_OK" = "1" ] || refuse "SIGNATURE DOES NOT VERIFY under $KEY_ID" \
  "Either the manifest was modified after signing, or the bundle was signed" \
  "by a different private key than the one this deployment pins. Both mean" \
  "the same thing operationally: do not apply it, and do not 'just try it'." \
  "Re-obtain the bundle over the channel you trust."
pass "signature verifies under the pinned key"

# --- 5. every listed file, exactly ------------------------------------------
# The manifest is now trusted (it is what the signature covers), so from here
# on the manifest is the authority and the payload is the suspect.
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  else openssl dgst -sha256 "$1" | awk '{print $NF}'; fi
}

LISTED="$WORK/listed.txt"
grep -oE '"path"[[:space:]]*:[[:space:]]*"[^"]*"[[:space:]]*,[[:space:]]*"sha256"[[:space:]]*:[[:space:]]*"[0-9a-f]{64}"' "$MANIFEST" \
  | sed -E 's/.*"path"[[:space:]]*:[[:space:]]*"([^"]*)".*"sha256"[[:space:]]*:[[:space:]]*"([0-9a-f]{64})".*/\2  \1/' \
  >"$LISTED" || true
[ -s "$LISTED" ] || refuse "the manifest lists no files"

MISSING=0; MODIFIED=0
while IFS= read -r line; do
  [ -n "$line" ] || continue
  digest="${line%%  *}"
  relpath="${line#*  }"
  if [ ! -f "$PAYLOAD/$relpath" ]; then
    printf '  %s[missing]%s %s\n' "$C_RED" "$C_RST" "$relpath" >&2
    MISSING=$((MISSING + 1))
    continue
  fi
  actual="$(sha256_of "$PAYLOAD/$relpath")"
  if [ "$actual" != "$digest" ]; then
    printf '  %s[modified]%s %s\n' "$C_RED" "$C_RST" "$relpath" >&2
    printf '             expected %s\n             actual   %s\n' "$digest" "$actual" >&2
    MODIFIED=$((MODIFIED + 1))
  fi
done <"$LISTED"

[ "$MISSING" = "0" ] || refuse "$MISSING file(s) listed in the signed manifest are MISSING from the payload" \
  "A partial bundle is not a smaller update; applying it would leave the" \
  "deployment in a state no one has ever tested."
[ "$MODIFIED" = "0" ] || refuse "$MODIFIED file(s) do not match their signed digest" \
  "The manifest's signature is intact, so the tampering is in the payload." \
  "Refuse and re-obtain."

LISTED_COUNT="$(wc -l <"$LISTED" | tr -d ' ')"
pass "all $LISTED_COUNT files match their signed SHA-256"

# --- 6. nothing EXTRA in the payload ---------------------------------------
# A whole-archive hash cannot express this usefully; a manifest can. An added
# file is how you smuggle a script the manifest never mentioned.
ACTUAL_LIST="$WORK/actual.txt"
(cd "$PAYLOAD" && find . -type f -print | sed 's|^\./||') | LC_ALL=C sort >"$ACTUAL_LIST"
EXPECTED_LIST="$WORK/expected.txt"
sed -E 's/^[0-9a-f]{64}  //' "$LISTED" | LC_ALL=C sort >"$EXPECTED_LIST"
EXTRA="$(comm -23 "$ACTUAL_LIST" "$EXPECTED_LIST" || true)"
if [ -n "$EXTRA" ]; then
  printf '%s\n' "$EXTRA" | while IFS= read -r f; do
    printf '  %s[unlisted]%s %s\n' "$C_RED" "$C_RST" "$f" >&2
  done
  refuse "the payload contains file(s) the signed manifest does not list" \
    "Everything that ships must be named in the manifest, or the signature" \
    "covers less than the bundle does."
fi
pass "payload contains nothing the manifest does not list"

# --- 7. downgrade ----------------------------------------------------------
# Downgrades are refused because an older bundle is a signed, genuine artifact:
# a signature check alone cannot tell "the current release" from "last year's
# release, which we know how to exploit". Rollback is a deliberate, operator-
# driven restore (docs/deployment/BACKUP_RESTORE.md), not an update.
version_cmp() { # echoes -1, 0 or 1 for $1 vs $2
  local a="${1%%-*}" b="${2%%-*}" i av bv
  local -a A B
  IFS='.' read -r -a A <<<"$a"
  IFS='.' read -r -a B <<<"$b"
  for i in 0 1 2 3; do
    av="${A[$i]:-0}"; bv="${B[$i]:-0}"
    av="${av//[!0-9]/}"; bv="${bv//[!0-9]/}"
    av="${av:-0}"; bv="${bv:-0}"
    if [ "$av" -gt "$bv" ]; then printf '%s\n' 1; return; fi
    if [ "$av" -lt "$bv" ]; then printf '%s\n' -1; return; fi
  done
  printf '%s\n' 0
}

if [ -z "$INSTALLED_VERSION" ] && [ -f "$INSTALL_DIR/.regulait-version" ]; then
  INSTALLED_VERSION="$(tr -d ' \n' <"$INSTALL_DIR/.regulait-version")"
fi

if [ -n "$INSTALLED_VERSION" ]; then
  case "$(version_cmp "$BUNDLE_VERSION" "$INSTALLED_VERSION")" in
    -1) refuse "DOWNGRADE REFUSED: bundle $BUNDLE_VERSION is older than the installed $INSTALLED_VERSION" \
          "A correctly signed older release is still a downgrade, and a" \
          "downgrade re-opens whatever the newer release closed. If you truly" \
          "intend to go back, that is a restore: stop the stack, restore the" \
          "matching database backup, and install the older version" \
          "deliberately — see docs/deployment/BACKUP_RESTORE.md." ;;
    0)  pass "version $BUNDLE_VERSION == installed (re-apply, allowed)" ;;
    1)  pass "version $BUNDLE_VERSION > installed $INSTALLED_VERSION" ;;
  esac
  if [ -n "$MIN_INSTALLED" ] && [ "$(version_cmp "$INSTALLED_VERSION" "$MIN_INSTALLED")" = "-1" ]; then
    refuse "this bundle requires at least version $MIN_INSTALLED installed (you have $INSTALLED_VERSION)" \
      "Apply the intermediate release first; skipping it would skip its migrations."
  fi
else
  note "no installed version recorded — downgrade check SKIPPED (this is a first install)"
fi

# --- 8. optional: place the verified payload -------------------------------
if [ -n "$EXTRACT_TO" ]; then
  if [ -e "$EXTRACT_TO" ] && [ -n "$(ls -A "$EXTRACT_TO" 2>/dev/null || true)" ]; then
    refuse "--extract-to $EXTRACT_TO is not empty" \
      "Refusing to overlay a verified payload onto an unknown tree."
  fi
  mkdir -p "$EXTRACT_TO"
  (cd "$PAYLOAD" && tar -cf - .) | (cd "$EXTRACT_TO" && tar -xf -)
  pass "verified payload extracted to $EXTRACT_TO"
fi

[ "$QUIET" = "1" ] || printf '\n%s[VERIFIED]%s regulait %s — %s files, signed by %s\n\n' \
  "$C_GRN" "$C_RST" "$BUNDLE_VERSION" "$LISTED_COUNT" "$KEY_ID"
exit 0
