#!/usr/bin/env bash
# Every module@version the operator binary links must be a row of THIRD_PARTY.md's first table (ADR-0176: listed,
# licence checked, pinned). Fails on an unlisted one. Same rule as agents/endpoint/scripts/check-licences.sh.
set -euo pipefail
here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$here"
listed="$(awk '/^## Linked into the operator binary/{f=1;next} /^## /{f=0} f && /^\| `/' THIRD_PARTY.md | sed -E 's/^\| `([^`]+)` \| `([^`]+)`.*/\1@\2/')"
fail=0
for m in $(GOOS=linux CGO_ENABLED=0 go list -deps -f '{{with .Module}}{{if not .Main}}{{.Path}}@{{.Version}}{{end}}{{end}}' ./cmd/... | sort -u); do
  if ! grep -qxF "$m" <<<"$listed"; then echo "unlisted module linked: $m" >&2; fail=1; fi
done
[ "$fail" = 0 ] && echo "ok: every linked module is listed in THIRD_PARTY.md"
exit "$fail"
