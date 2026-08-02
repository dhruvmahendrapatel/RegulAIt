#!/usr/bin/env bash
# =============================================================================
# RegulAIt LICENSE SIGNER (ADR-0052)
#
# Produces the installable artifact:
#
#   { "documentBase64": "...", "signature": "...", "signingKeyId": "..." }
#
# which is POSTed to `POST /v1/licenses` on the customer's deployment. The
# deployment verifies it OFFLINE against `infra/license-keys/<keyId>.pub` — no
# network call, because the flagship deployment is air-gapped and there is no
# home to phone.
#
# This is deliberately the twin of scripts/build-update-bundle.sh: same
# algorithm (Ed25519), same `--key <path>` custody posture, same "the signature
# covers the EXACT BYTES, not a re-parse" rule. One signing scheme in this
# product, not two.
#
# THE PRIVATE KEY IS NEVER COPIED, NEVER LOGGED AND NEVER WRITTEN INTO THE
# ARTIFACT. It is read from the path you pass and nothing else.
#
# Usage:
#   scripts/sign-license.sh --key /secure/regulait-license-2026.pem \
#     --key-id regulait-license-2026 \
#     --tenant "Acme Corp" --tier enterprise --seats 250 \
#     --mode airgapped --expires 2027-01-01 \
#     [--grace-days 45] [--features sso_saml,airgapped_mode] \
#     [--not-before 2026-08-01] [--license-id acme-2026-08] \
#     [--hard-stop] [--out license.json]
#
# Exit codes: 0 signed. 1 refused (reason printed). 2 usage error.
# =============================================================================
set -euo pipefail

KEY=""
KEY_ID=""
TENANT=""
TIER=""
SEATS=""
MODE="byoc"
EXPIRES=""
NOT_BEFORE=""
GRACE_DAYS=30
FEATURES=""
LICENSE_ID=""
HARD_STOP="false"
OUT=""

die() { printf '\n[REFUSED] %s\n\n' "$*" >&2; exit 1; }
usage() { sed -n '2,32p' "$0" >&2; }

while [ $# -gt 0 ]; do
  case "$1" in
    --key)         KEY="${2:-}"; shift 2 ;;
    --key-id)      KEY_ID="${2:-}"; shift 2 ;;
    --tenant)      TENANT="${2:-}"; shift 2 ;;
    --tier)        TIER="${2:-}"; shift 2 ;;
    --seats)       SEATS="${2:-}"; shift 2 ;;
    --mode)        MODE="${2:-}"; shift 2 ;;
    --expires)     EXPIRES="${2:-}"; shift 2 ;;
    --not-before)  NOT_BEFORE="${2:-}"; shift 2 ;;
    --grace-days)  GRACE_DAYS="${2:-}"; shift 2 ;;
    --features)    FEATURES="${2:-}"; shift 2 ;;
    --license-id)  LICENSE_ID="${2:-}"; shift 2 ;;
    --hard-stop)   HARD_STOP="true"; shift ;;
    --out)         OUT="${2:-}"; shift 2 ;;
    -h|--help)     usage; exit 0 ;;
    *)             usage; exit 2 ;;
  esac
done

[ -n "$KEY" ] || die "--key is required (path to the Ed25519 private key, never in this repo)"
[ -f "$KEY" ] || die "private key not found: $KEY"
[ -n "$KEY_ID" ] || die "--key-id is required — it must name a .pub the deployment already pins"
printf '%s' "$KEY_ID" | grep -qE '^[A-Za-z0-9._-]+$' \
  || die "--key-id may contain only [A-Za-z0-9._-]: '$KEY_ID'"
[ -n "$TENANT" ] || die "--tenant is required"
[ -n "$TIER" ]   || die "--tier is required"
[ -n "$SEATS" ]  || die "--seats is required"
printf '%s' "$SEATS" | grep -qE '^[1-9][0-9]*$' || die "--seats must be a positive integer"
[ -n "$EXPIRES" ] || die "--expires is required (YYYY-MM-DD or a full RFC3339 timestamp)"
case "$MODE" in hosted|byoc|airgapped) ;; *) die "--mode must be hosted|byoc|airgapped" ;; esac
command -v openssl >/dev/null 2>&1 || die "openssl is not installed"

# HARD STOP IS OPT-IN AND LOUD. It is never the default, because the default for
# a governance product must be "stay governed" — see ADR-0052 §5.
if [ "$HARD_STOP" = "true" ]; then
  printf '\n[WARNING] --hard-stop bakes a TOTAL SHUTDOWN on expiry into this license.\n' >&2
  printf '          Past the grace window the customer'"'"'s governance layer STOPS, which turns a\n' >&2
  printf '          billing lapse into an AI-governance outage. Only issue this when the\n' >&2
  printf '          customer has explicitly asked for it in writing.\n\n' >&2
fi

iso() { # accepts YYYY-MM-DD or a full timestamp
  case "$1" in
    *T*) printf '%s' "$1" ;;
    *)   printf '%sT00:00:00.000Z' "$1" ;;
  esac
}
NOW="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
NOT_BEFORE_ISO="$(iso "${NOT_BEFORE:-$(date -u +%Y-%m-%d)}")"
EXPIRES_ISO="$(iso "$EXPIRES")"
LICENSE_ID="${LICENSE_ID:-$(printf '%s' "$TENANT" | tr '[:upper:] ' '[:lower:]-')-$(date -u +%Y%m%d)}"

# features -> a JSON array, sorted so the same request always produces the same
# bytes (the document is signed byte-for-byte, so determinism is worth having)
FEATURES_JSON="[]"
if [ -n "$FEATURES" ]; then
  FEATURES_JSON="$(printf '%s' "$FEATURES" | tr ',' '\n' | sed '/^$/d' | LC_ALL=C sort \
    | sed 's/.*/"&"/' | paste -sd, - | sed 's/^/[/; s/$/]/')"
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
DOC="$WORK/license.json"

# KEY ORDER IS ALPHABETICAL, matching `canonicalLicenseBytes` in
# packages/shared/src/licensing.ts. The verifier does NOT re-canonicalise — it
# checks the signature over exactly these bytes — so this ordering is a
# convenience for diffing two licenses, not part of the trust path.
printf '{"deploymentMode":"%s","expiresAt":"%s","features":%s,"graceDays":%s,"hardStopOnExpiry":%s,"issuedAt":"%s","licenseId":"%s","notBefore":"%s","schema":"regulait.license/1","seatCap":%s,"tenant":"%s","tier":"%s"}' \
  "$MODE" "$EXPIRES_ISO" "$FEATURES_JSON" "$GRACE_DAYS" "$HARD_STOP" "$NOW" \
  "$LICENSE_ID" "$NOT_BEFORE_ISO" "$SEATS" "$TENANT" "$TIER" >"$DOC"

# Ed25519 signs the message itself (-rawin): no digest choice, no padding mode.
openssl pkeyutl -sign -inkey "$KEY" -rawin -in "$DOC" -out "$WORK/sig.bin" 2>/dev/null \
  || die "signing failed — is $KEY an Ed25519 private key?"

SIG_B64="$(openssl base64 -A -in "$WORK/sig.bin")"
DOC_B64="$(openssl base64 -A -in "$DOC")"

ARTIFACT="$WORK/artifact.json"
printf '{\n  "documentBase64": "%s",\n  "signature": "%s",\n  "signingKeyId": "%s"\n}\n' \
  "$DOC_B64" "$SIG_B64" "$KEY_ID" >"$ARTIFACT"

if [ -n "$OUT" ]; then
  cp "$ARTIFACT" "$OUT"
  printf '\n[SIGNED] %s\n' "$OUT" >&2
else
  cat "$ARTIFACT"
fi

printf '\n  tenant   %s\n  tier     %s\n  seats    %s\n  mode     %s\n  valid    %s -> %s (+%s day grace)\n  key id   %s\n\n' \
  "$TENANT" "$TIER" "$SEATS" "$MODE" "$NOT_BEFORE_ISO" "$EXPIRES_ISO" "$GRACE_DAYS" "$KEY_ID" >&2
printf '  Install with:  POST /v1/licenses  (admin)  — verified OFFLINE, no phone-home.\n' >&2
printf '  The deployment refuses this unless %s.pub is already in its pinned keyring.\n\n' "$KEY_ID" >&2
