#!/usr/bin/env bash
# =============================================================================
# security-cosign-verify.sh — the ONE verify command for our image signatures
# (ADR-0184). security.yml runs it twice, with opposite expectations:
#
#   push to main:  `signed`    the image security.yml just signed keylessly must
#                              verify against THIS workflow on refs/heads/main.
#   pull request:  `unsigned`  the same command on an unsigned image must be
#                              REFUSED, and refused for the right reason ("no
#                              signatures found" / "no matching signatures"),
#                              so every PR re-proves that verify is not a no-op.
#
# A signature made anywhere else (another workflow, a branch, a PR merge ref, a
# developer's key) does not match the pinned identity and is refused too. CI
# exercises only the unsigned case on every PR; the foreign-key case was proven
# locally (ADR-0184 red-proof table), not by CI.
#
# usage: security-cosign-verify.sh <registry/repo@sha256:digest> <signed|unsigned>
# env:   COSIGN (path to the verified cosign binary; default `cosign`)
#        GITHUB_REPOSITORY (owner/repo; set by Actions)
#        COSIGN_IDENTITY (override the expected identity; only for local red proofs)
# exit:  0 expectation met; 1 expectation not met; 2 usage error
# =============================================================================
set -euo pipefail

ref="${1:-}"
expect="${2:-}"
cosign_bin="${COSIGN:-cosign}"
issuer="https://token.actions.githubusercontent.com"

if [ -z "$ref" ] || { [ "$expect" != "signed" ] && [ "$expect" != "unsigned" ]; }; then
  echo "usage: $0 <image@sha256:digest> <signed|unsigned>" >&2
  exit 2
fi
# Verify by digest only: a tag can be moved between verify and use.
case "$ref" in
  *@sha256:*) ;;
  *) echo "::error::verify needs an image reference by digest (repo@sha256:...), got: $ref" >&2; exit 2 ;;
esac
identity="${COSIGN_IDENTITY:-https://github.com/${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is not set}/.github/workflows/security.yml@refs/heads/main}"

echo "cosign verify ${ref}"
echo "  expected identity: ${identity}"
echo "  expected issuer:   ${issuer}"
set +e
out="$("$cosign_bin" verify \
  --certificate-identity "$identity" \
  --certificate-oidc-issuer "$issuer" \
  --allow-http-registry \
  "$ref" 2>&1)"
code=$?
set -e
printf '%s\n' "$out"

if [ "$expect" = "signed" ]; then
  if [ "$code" -ne 0 ]; then
    echo "::error::cosign verify REFUSED ${ref} (exit ${code}); the image is not signed by ${identity}" >&2
    exit 1
  fi
  echo "verified: ${ref} is signed by ${identity}"
  exit 0
fi

if [ "$code" -eq 0 ]; then
  echo "::error::cosign verify ACCEPTED ${ref}, which was expected to be unsigned: the verify step proves nothing" >&2
  exit 1
fi
if ! printf '%s' "$out" | grep -qE 'no signatures found|no matching (signatures|attestations)'; then
  echo "::error::cosign verify failed (exit ${code}) for a reason other than a missing or foreign signature; the negative proof is inconclusive" >&2
  exit 1
fi
echo "refused as required: ${ref} carries no signature from ${identity}"
