#!/usr/bin/env bash
# =============================================================================
# RegulAIt RELEASE verifier (ADR-0324): signature + SBOM + build provenance
#
# Runs offline, on the customer's machine or in CI, before a release is used.
# It builds on scripts/verify-update-bundle.sh (ADR-0041), which it calls, and
# adds the three things a signature alone cannot say:
#
#   1. WHO MAY SIGN. The installed keyring statement (infra/release-keys/
#      keyring.json) is signed by offline ROOT keys. A release is accepted only
#      from a signing key that statement authorises, for the purpose
#      "update-bundle", not revoked, and not past its notAfter date. A .pub
#      file dropped into the keyring directory is NOT trust: only the
#      root-signed statement is.
#   2. WHAT IS INSIDE. The payload must carry a CycloneDX SBOM (payload/sbom/),
#      and the signed manifest covers its digest like every other file.
#   3. HOW IT WAS BUILT. provenance.intoto.json is an in-toto v1 statement with
#      an SLSA v1 predicate. Its subject must be this exact manifest, its
#      builder must be the workflow the roots named, and its ref must be the
#      release tag. The release signer signs it with the same key as the
#      manifest; with --online, the CI's keyless Sigstore attestation over the
#      same manifest is checked too.
#
# A bundle that changes the keyring (a new signing key, a revocation, a root
# rotation) must carry a statement signed by THRESHOLD of the roots this
# deployment already trusts, with a serial no lower than the installed one,
# so a stolen signing key cannot install a new root, and an old statement
# cannot be replayed to un-revoke a key.
#
# FAILS CLOSED. There is no --force.
#
# Usage:
#   scripts/verify-release.sh regulait-update-1.0.0.tar.gz
#   scripts/verify-release.sh bundle.tar.gz --trust /opt/regulait/infra/release-keys \
#                             --installed-version 0.9.0
#   scripts/verify-release.sh bundle.tar.gz --online          # also check the CI's Sigstore attestation
#   scripts/verify-release.sh --candidate candidate.tar.gz    # signer's pre-sign check (no signatures yet)
#   scripts/verify-release.sh --keyring-only infra/release-keys [--allow-dev-keyring]
#
# Exit codes: 0 verified. 1 refused (reason printed). 2 usage error.
# =============================================================================
set -euo pipefail

if [ -z "${BASH_VERSINFO:-}" ] || [ "${BASH_VERSINFO[0]}" -lt 4 ] || { [ "${BASH_VERSINFO[0]}" -eq 4 ] && [ "${BASH_VERSINFO[1]}" -lt 4 ]; }; then
  echo "[REFUSED] bash 4.4 or newer is required (this is ${BASH_VERSION:-unknown})" >&2
  exit 1
fi

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=scripts/lib/release-trust.sh
. "$SCRIPT_DIR/lib/release-trust.sh"

# The development key of ADR-0041, whose private half was never kept. Its only
# allowed state is "alone, before the first ceremony"; --allow-dev-keyring is
# for the repository's own CI check and is never accepted for a release.
DEV_KEY_ID="regulait-release-dev-2026-08"
DEV_KEY_FP="f2cbda4b1471e4070f7bd75edb69617a48cf58721f34607011935933fa629ff1"

TRUST=""
BUNDLE=""
MODE="release"
ONLINE=0
ALLOW_DEV=0
INSTALLED_VERSION=""
INSTALL_DIR=""
QUIET=0

pass() { [ "$QUIET" = "1" ] || printf '  [pass] %s\n' "$*"; }
note() { [ "$QUIET" = "1" ] || printf '  %s\n' "$*"; }
refuse() {
  printf '\n[REFUSED] %s\n' "$1" >&2
  shift
  for l in "$@"; do printf '          %s\n' "$l" >&2; done
  printf '\n' >&2
  exit 1
}

usage() {
  cat <<'USAGE'
Usage:
  scripts/verify-release.sh <bundle.tar.gz> [options]
  scripts/verify-release.sh --candidate <candidate.tar.gz> [--trust <dir>] [--online]
  scripts/verify-release.sh --keyring-only <dir> [--allow-dev-keyring]

  --trust <dir>              The keyring this deployment already trusts.
                             Default: <install-dir>/infra/release-keys, else the
                             repository's infra/release-keys.
  --installed-version <v>    Passed to verify-update-bundle.sh (downgrade check).
  --install-dir <dir>        Passed to verify-update-bundle.sh.
  --online                   Also verify the CI's keyless Sigstore attestation
                             (needs cosign and network). Off by default so the
                             verifier works air-gapped.
  --quiet                    Only print on refusal.
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --trust)             TRUST="${2:-}"; shift 2 ;;
    --candidate)         MODE="candidate"; BUNDLE="${2:-}"; shift 2 ;;
    --keyring-only)      MODE="keyring"; TRUST="${2:-}"; shift 2 ;;
    --allow-dev-keyring) ALLOW_DEV=1; shift ;;
    --online)            ONLINE=1; shift ;;
    --installed-version) INSTALLED_VERSION="${2:-}"; shift 2 ;;
    --install-dir)       INSTALL_DIR="${2:-}"; shift 2 ;;
    --quiet)             QUIET=1; shift ;;
    -h|--help)           usage; exit 0 ;;
    -*)                  usage >&2; exit 2 ;;
    *)                   BUNDLE="$1"; shift ;;
  esac
done

command -v openssl >/dev/null 2>&1 || refuse "openssl is not installed"
[ "$ALLOW_DEV" = "0" ] || [ "$MODE" = "keyring" ] || { usage >&2; exit 2; }

if [ -z "$TRUST" ]; then
  if [ -n "$INSTALL_DIR" ] && [ -d "$INSTALL_DIR/infra/release-keys" ]; then TRUST="$INSTALL_DIR/infra/release-keys"
  else TRUST="$REPO_ROOT/infra/release-keys"; fi
fi
[ -d "$TRUST" ] || refuse "trusted keyring directory not found: $TRUST"
TRUST="$(cd -- "$TRUST" && pwd)"

# --- the trusted keyring -----------------------------------------------------
if [ ! -f "$TRUST/keyring.json" ]; then
  if [ "$MODE" = "keyring" ] && [ "$ALLOW_DEV" = "1" ]; then
    shopt -s nullglob
    pubs=("$TRUST"/*.pub)
    shopt -u nullglob
    [ "${#pubs[@]}" -eq 1 ] && [ "$(basename "${pubs[0]}")" = "$DEV_KEY_ID.pub" ] \
      && [ "$(kr_fingerprint "${pubs[0]}")" = "$DEV_KEY_FP" ] && [ ! -e "$TRUST/root" ] \
      || refuse "the keyring has no root-signed statement, and it is not the untouched development keyring" \
           "Before the first ceremony (ADR-0324) the only allowed key is $DEV_KEY_ID.pub." \
           "Any other key must arrive through a ceremony: keyring.json signed by the roots."
    note "development keyring: no root keys yet; the release-key ceremony (ADR-0324) is pending"
    note "nothing can be released against this keyring, which is the correct failure direction"
    exit 0
  fi
  refuse "NO ROOT-SIGNED KEYRING in $TRUST" \
    "keyring.json is missing, so no signing key is authorised by a root key." \
    "Until the release-key ceremony (ADR-0324, docs/ops/RELEASE_KEY_CEREMONY.md) has" \
    "been run, nothing is a release. This is the correct failure direction."
fi

kr_verify_dir "$TRUST" || refuse "the trusted keyring does not verify: $KR_ERR" "$TRUST/keyring.json"
kr_save_as_trust
T_KEY_IDS=("${KR_KEY_IDS[@]}")
pass "trusted keyring: serial $T_SERIAL, ${#T_ROOT_IDS[@]} root(s), threshold $T_THRESHOLD, ${#T_KEY_IDS[@]} signing key(s)"
for ((i = 0; i < ${#T_ROOT_IDS[@]}; i++)); do
  note "  root ${T_ROOT_IDS[$i]}  sha256:${T_ROOT_FPS[$i]}"
done
note "  compare these root fingerprints with the ones published out of band (release notes, install media)"

if [ "$MODE" = "keyring" ]; then
  [ "$QUIET" = "1" ] || printf '\n[VERIFIED] keyring %s\n\n' "$TRUST"
  exit 0
fi

# --- the bundle --------------------------------------------------------------
[ -n "$BUNDLE" ] || { usage >&2; exit 2; }
[ -f "$BUNDLE" ] || refuse "bundle not found: $BUNDLE"
BUNDLE="$(cd -- "$(dirname -- "$BUNDLE")" && pwd)/$(basename -- "$BUNDLE")"
[ "$QUIET" = "1" ] || printf '\n==> Verifying release %s (%s)\n' "$BUNDLE" "$MODE"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
tar -xzf "$BUNDLE" -C "$WORK" 2>/dev/null || refuse "the bundle is not a readable gzip tarball"
mapfile -t tops < <(find "$WORK" -mindepth 1 -maxdepth 1)
[ "${#tops[@]}" -eq 1 ] && [ -d "${tops[0]}" ] || refuse "the bundle must hold exactly one top-level directory"
ROOT="${tops[0]}"
MANIFEST="$ROOT/manifest.json"
PAYLOAD="$ROOT/payload"
[ -f "$MANIFEST" ] || refuse "manifest.json is missing"
[ -d "$PAYLOAD" ] || refuse "payload/ is missing"

# Nothing at the bundle root that this verifier does not know.
ALLOWED_TOP="manifest.json manifest.json.sig payload provenance.intoto.json provenance.intoto.json.sig provenance.sigstore.json"
while IFS= read -r entry; do
  case " $ALLOWED_TOP " in *" $(basename "$entry") "*) ;; *) refuse "unexpected file at the bundle root: $(basename "$entry")" ;; esac
done < <(find "$ROOT" -mindepth 1 -maxdepth 1)

mfield() { grep -m1 -oE "\"$1\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" "$MANIFEST" | sed -E 's/.*:[[:space:]]*"([^"]*)"/\1/'; }
VERSION="$(mfield version || true)"
KEY_ID="$(mfield signingKeyId || true)"
CREATED="$(mfield createdAt || true)"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || refuse "manifest version '$VERSION' is not a release version (x.y.z)"
[[ "$KEY_ID" =~ $KR_ID_RE ]] || refuse "manifest signingKeyId '$KEY_ID' is not a valid key id"
[[ "$CREATED" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T ]] || refuse "manifest has no createdAt time"
pass "manifest: regulait $VERSION, signing key '$KEY_ID', created $CREATED"

# --- the bundle's own keyring: signed by the roots we ALREADY trust ----------
BKR="$PAYLOAD/infra/release-keys"
[ -f "$BKR/keyring.json" ] || refuse "the bundle ships no keyring statement (payload/infra/release-keys/keyring.json)" \
  "Every release carries the keyring it was signed under, so the deployment's" \
  "trust moves forward only through statements its roots signed."
n="$(kr_count_sigs "$BKR/keyring.json" "$TRUST/root" T_ROOT_IDS T_ROOT_FPS)"
[ "$n" -ge "$T_THRESHOLD" ] || refuse "the bundle's keyring statement is signed by $n of the $T_THRESHOLD required TRUSTED root key(s)" \
  "Only a quorum of the roots this deployment already pins can change who may sign." \
  "A stolen signing key cannot add a key or a root on its own; this is that check."
kr_verify_dir "$BKR" || refuse "the bundle's keyring does not verify: $KR_ERR"
[ "$KR_SERIAL" -ge "$T_SERIAL" ] || refuse "KEYRING ROLLBACK: the bundle's keyring serial $KR_SERIAL is older than the installed $T_SERIAL" \
  "An older statement could un-revoke a key. Refused."
if [ "$KR_SERIAL" -eq "$T_SERIAL" ] && ! cmp -s "$BKR/keyring.json" "$TRUST/keyring.json"; then
  refuse "the bundle's keyring has the installed serial $T_SERIAL but different content" \
    "Each change to the keyring takes a new serial."
fi
pass "bundle keyring: serial $KR_SERIAL, signed by $n trusted root(s) and by its own quorum"

# --- the signing key ----------------------------------------------------------
for r in "${T_REVOKED[@]}" "${KR_REVOKED[@]}"; do
  [ "$r" != "$KEY_ID" ] || refuse "SIGNING KEY REVOKED: $KEY_ID" \
    "The roots revoked this key. A bundle it signed is refused whatever its date."
done
idx=-1
for ((i = 0; i < ${#KR_KEY_IDS[@]}; i++)); do [ "${KR_KEY_IDS[$i]}" = "$KEY_ID" ] && idx=$i; done
[ "$idx" -ge 0 ] || refuse "UNAUTHORISED SIGNING KEY: '$KEY_ID' is not in the root-signed keyring" \
  "Authorised: ${KR_KEY_IDS[*]:-<none>}"
case ",${KR_KEY_PURPOSES[$idx]}," in *,update-bundle,*) ;; *) refuse "$KEY_ID is not authorised to sign update bundles (purposes: ${KR_KEY_PURPOSES[$idx]})" ;; esac
[[ ! "${CREATED:0:10}" > "${KR_KEY_NOTAFTER[$idx]}" ]] || refuse "$KEY_ID expired on ${KR_KEY_NOTAFTER[$idx]}; the manifest is dated ${CREATED:0:10}"
SIGNING_PUB="$BKR/$KEY_ID.pub"
pass "signing key $KEY_ID is authorised (sha256:${KR_KEY_FPS[$idx]}, until ${KR_KEY_NOTAFTER[$idx]})"
TODAY="$(date -u +%Y-%m-%d)"
[[ ! "$TODAY" > "${KR_KEY_NOTAFTER[$idx]}" ]] || note "note: $KEY_ID's notAfter (${KR_KEY_NOTAFTER[$idx]}) is before today ($TODAY); the bundle was signed before then"
BUILDER="$KR_BUILDER"
KEY_PURPOSES="${KR_KEY_PURPOSES[$idx]}"

# --- signature and every file (verify-update-bundle.sh, ADR-0041) -------------
if [ "$MODE" = "release" ]; then
  [ -f "$ROOT/manifest.json.sig" ] || refuse "UNSIGNED: manifest.json.sig is missing" \
    "A release candidate becomes a release only when the release signer signs it" \
    "(docs/ops/RELEASE_KEY_CEREMONY.md, part 5)."
  ONE="$WORK/one-key"
  mkdir -p "$ONE"
  cp "$SIGNING_PUB" "$ONE/$KEY_ID.pub"
  args=("$BUNDLE" --keyring "$ONE" --quiet)
  [ -z "$INSTALLED_VERSION" ] || args+=(--installed-version "$INSTALLED_VERSION")
  [ -z "$INSTALL_DIR" ] || args+=(--install-dir "$INSTALL_DIR")
  bash "$SCRIPT_DIR/verify-update-bundle.sh" "${args[@]}" || refuse "the update bundle did not verify (reason above)"
  pass "manifest signature and every payload file verify (verify-update-bundle.sh)"
else
  [ ! -f "$ROOT/manifest.json.sig" ] || refuse "this is already signed; --candidate is for an unsigned candidate"
  # The candidate's manifest is not signed yet, so check its file list here, the same way.
  listed="$WORK/listed"; actual="$WORK/actual"
  grep -oE '"path"[[:space:]]*:[[:space:]]*"[^"]*"[[:space:]]*,[[:space:]]*"sha256"[[:space:]]*:[[:space:]]*"[0-9a-f]{64}"' "$MANIFEST" \
    | sed -E 's/.*"path"[[:space:]]*:[[:space:]]*"([^"]*)".*"sha256"[[:space:]]*:[[:space:]]*"([0-9a-f]{64})".*/\2  \1/' >"$listed" || true
  [ -s "$listed" ] || refuse "the candidate manifest lists no files"
  while IFS= read -r line; do
    d="${line%%  *}"; p="${line#*  }"
    [ -f "$PAYLOAD/$p" ] || refuse "candidate file missing: $p"
    [ "$(kr_sha256_file "$PAYLOAD/$p")" = "$d" ] || refuse "candidate file does not match the manifest: $p"
  done <"$listed"
  (cd "$PAYLOAD" && find . -type f -print | sed 's|^\./||') | LC_ALL=C sort >"$actual"
  extra="$(comm -23 "$actual" <(sed -E 's/^[0-9a-f]{64}  //' "$listed" | LC_ALL=C sort) || true)"
  [ -z "$extra" ] || refuse "the candidate payload holds files its manifest does not list: $extra"
  pass "candidate: every payload file matches the (unsigned) manifest"
fi

# --- SBOM ----------------------------------------------------------------------
shopt -s nullglob
sboms=("$PAYLOAD"/sbom/*.cdx.json)
shopt -u nullglob
[ "${#sboms[@]}" -ge 1 ] || refuse "NO SBOM: payload/sbom/*.cdx.json is missing" \
  "A release states what it contains. Without an SBOM a customer cannot check" \
  "it against an advisory, so it is not a release."
for s in "${sboms[@]}"; do
  grep -qE '"bomFormat"[[:space:]]*:[[:space:]]*"CycloneDX"' "$s" || refuse "$(basename "$s") is not a CycloneDX SBOM"
done
pass "SBOM: ${#sboms[@]} CycloneDX file(s), each covered by the manifest's digests"

# --- provenance ------------------------------------------------------------------
PROV="$ROOT/provenance.intoto.json"
[ -f "$PROV" ] || refuse "NO PROVENANCE: provenance.intoto.json is missing" \
  "Without it nothing says which workflow, commit and tag built this."
MANIFEST_SHA="$(kr_sha256_file "$MANIFEST")"
pv_parse "$PROV" || refuse "provenance does not parse: $PV_ERR"
[ "$PV_SUBJECT" = "$MANIFEST_SHA" ] || refuse "PROVENANCE MISMATCH: its subject is not this manifest (sha256:$MANIFEST_SHA)" \
  "The provenance describes some other build."
[ "$PV_BUILDER" = "$BUILDER" ] || refuse "PROVENANCE BUILDER MISMATCH: built by $PV_BUILDER, expected $BUILDER" \
  "The roots named the one workflow allowed to build releases; this was built elsewhere."
[ "$PV_REF" = "refs/tags/v$VERSION" ] || refuse "provenance ref $PV_REF is not refs/tags/v$VERSION"
COMMIT="$PV_COMMIT"
pass "provenance: SLSA v1, builder $BUILDER, tag v$VERSION, commit $COMMIT"

if [ "$MODE" = "release" ]; then
  case ",$KEY_PURPOSES," in *,provenance,*) ;; *) refuse "$KEY_ID is not authorised to sign provenance" ;; esac
  kr_verify_sig "$SIGNING_PUB" "$PROV" "$PROV.sig" || refuse "PROVENANCE SIGNATURE does not verify under $KEY_ID" \
    "The release signer signs the provenance they checked; this one was not, or was changed."
  pass "provenance signature verifies under $KEY_ID"
fi

if [ "$ONLINE" = "1" ]; then
  command -v cosign >/dev/null 2>&1 || refuse "--online needs cosign on PATH"
  [ -f "$ROOT/provenance.sigstore.json" ] || refuse "--online: provenance.sigstore.json (the CI's keyless attestation) is missing"
  cosign verify-blob-attestation \
    --bundle "$ROOT/provenance.sigstore.json" \
    --type https://slsa.dev/provenance/v1 \
    --certificate-identity "$BUILDER@refs/tags/v$VERSION" \
    --certificate-oidc-issuer https://token.actions.githubusercontent.com \
    "$MANIFEST" >/dev/null 2>"$WORK/cosign.err" \
    || refuse "the CI's keyless provenance attestation does not verify" "$(head -5 "$WORK/cosign.err")"
  pass "keyless attestation: signed by $BUILDER@refs/tags/v$VERSION (Sigstore)"
else
  note "keyless Sigstore attestation not checked (offline; pass --online on a connected machine)"
fi

if [ "$MODE" = "candidate" ]; then
  [ "$QUIET" = "1" ] || printf '\n[CANDIDATE OK] regulait %s is ready for the release signer (key %s)\n\n' "$VERSION" "$KEY_ID"
else
  [ "$QUIET" = "1" ] || printf '\n[VERIFIED RELEASE] regulait %s, signed by %s, SBOM and provenance checked\n\n' "$VERSION" "$KEY_ID"
fi
exit 0
